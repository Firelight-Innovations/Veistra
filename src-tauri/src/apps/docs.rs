//! The Docs app's Rust half: Veistra's documentation, read from the website.
//!
//! None of the pages are in this build. They live under `<web>/docs`, where
//! `<web>` is the `account.webUrl` setting (the production site unless it is
//! pointed at a staging one), and the site lists every page in `<web>/llms.txt`
//! with a plain-Markdown copy of each beside its HTML. This module fetches those
//! two kinds of file and nothing else, so a change to the site reaches Veistra
//! without a release. `docs/docs-app.md` is the whole account.
//!
//! Fetched here rather than by the frame: the site sends no CORS headers, and it
//! sends `X-Frame-Options: DENY`, so the page can neither be read by a webview
//! `fetch` nor framed. A request from Rust needs neither.
//!
//! Offline is an answer, not an error. Every reply carries a [`Status`], and a
//! page this process read earlier is served again as `stale` when the site
//! cannot be reached, so a reader who loses the network mid-session keeps what
//! they had open.

use crate::apps::CallContext;
use crate::settings::{self, keys};
use crate::sync::MutexExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The site, when the setting is blank: the setting's own default.
const DEFAULT_WEB: &str = settings::DEFAULT_ACCOUNT_WEB;

/// How long a fetched file is used without asking again. The site's own CDN
/// caches for five minutes (`s-maxage=300`), so asking sooner gets the same
/// bytes back.
const FRESH_FOR: Duration = Duration::from_secs(300);

/// The most of one file this reads. A docs page is a few kilobytes; anything
/// near this is not a page.
const BODY_LIMIT: u64 = 2 * 1024 * 1024;

/// Files kept for the stale fallback. Far more than the site has pages.
const CACHE_ENTRIES: usize = 64;

/// How many cards Home draws: the first pages in the site's own order, which
/// is what fits beside the Recent list without scrolling.
pub const FEATURED: usize = 3;

/// How an answer was come by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Read from the site just now, or within [`FRESH_FOR`].
    Live,
    /// The site could not be reached, so this is what it said earlier in this
    /// session.
    Stale,
    /// The site could not be reached and nothing was kept.
    Offline,
    /// The site answered, and has no such page.
    Missing,
}

/// One page, as the index lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Below `/docs/`, without `.md`: `get-started/install`. The id the app,
    /// Home and `veistra/open` payloads name a page by.
    pub path: String,
    pub title: String,
    pub description: String,
    /// The HTML page, for "Open in browser".
    pub url: String,
}

/// A `##` heading in the index and the pages under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    pub pages: Vec<Page>,
}

/// What `llms.txt` says, parsed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub title: String,
    pub summary: String,
    pub sections: Vec<Section>,
}

/// The reply to `docs/index`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexAnswer {
    /// `<web>/docs`, which every offline message names.
    pub home: String,
    pub status: Status,
    /// Why the site could not be reached, when it could not.
    pub detail: Option<String>,
    #[serde(flatten)]
    pub listing: Listing,
}

/// The reply to `docs/page`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageAnswer {
    pub path: String,
    pub url: String,
    pub status: Status,
    pub detail: Option<String>,
    /// `None` when the status is `offline` or `missing`.
    pub markdown: Option<String>,
}

pub fn call(
    app: &AppHandle,
    _context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "docs/index" => encode(&index(app)),
        "docs/page" => {
            let path = page_param(params.as_ref())?;
            encode(&page(app, &path))
        }
        "docs/open" => open(app, params.as_ref()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

fn encode<T: Serialize>(answer: &T) -> Result<Value, RpcError> {
    serde_json::to_value(answer)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not encode the docs: {e}")))
}

/// `docs/index`. Every section and page the site lists, in its order.
pub fn index(app: &AppHandle) -> IndexAnswer {
    let web = web(app);
    let (status, detail, body) = fetch(&format!("{web}/llms.txt"));
    IndexAnswer {
        home: format!("{web}/docs"),
        status,
        detail,
        listing: body.map(|b| parse_index(&b, &web)).unwrap_or_default(),
    }
}

/// `docs/page`. One page's Markdown, by `path`.
pub fn page(app: &AppHandle, path: &str) -> PageAnswer {
    let web = web(app);
    let url = format!("{web}/docs/{path}");
    let (status, detail, markdown) = fetch(&format!("{url}.md"));
    PageAnswer {
        path: path.to_string(),
        url,
        status,
        detail,
        markdown,
    }
}

/// `docs/open`. Hand a docs page (`path`), the docs home (no params) or a link
/// out of a page (`url`, `https:` only) to the system browser.
fn open(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    use tauri_plugin_opener::OpenerExt;
    let web = web(app);
    let url = match (string_param(params, "path"), string_param(params, "url")) {
        (Some(path), _) if is_page_path(&path) => format!("{web}/docs/{path}"),
        (Some(path), _) => return Err(bad_path(&path)),
        (None, Some(url)) => url,
        (None, None) => format!("{web}/docs"),
    };
    if !crate::account::methods::safe_to_open(&url) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{url} is not a web address this app will open"),
        ));
    }
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not open {url}: {e}")))?;
    Ok(Value::Null)
}

/// The shape Home draws its Docs column from.
pub fn summary(app: &AppHandle) -> Value {
    let answer = index(app);
    let pages: Vec<&Page> = answer
        .listing
        .sections
        .iter()
        .flat_map(|s| &s.pages)
        .collect();
    json!({
        "home": answer.home,
        "status": answer.status,
        "detail": answer.detail,
        "cards": pages.iter().take(FEATURED).collect::<Vec<_>>(),
        "total": pages.len(),
    })
}

/// The site's address, without a trailing slash.
fn web(app: &AppHandle) -> String {
    let web = settings::text(app, keys::ACCOUNT_WEB_URL);
    let web = web.trim().trim_end_matches('/');
    if web.is_empty() {
        DEFAULT_WEB.to_string()
    } else {
        web.to_string()
    }
}

fn string_param(params: Option<&Value>, key: &str) -> Option<String> {
    params
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn page_param(params: Option<&Value>) -> Result<String, RpcError> {
    let path = string_param(params, "path")
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "docs/page needs a path"))?;
    if is_page_path(&path) {
        Ok(path)
    } else {
        Err(bad_path(&path))
    }
}

fn bad_path(path: &str) -> RpcError {
    RpcError::new(
        INVALID_PARAMS,
        format!("{path:?} is not a docs page path, such as get-started/install"),
    )
}

/// Lowercase segments of letters, digits, `-` and `_`. What keeps a `path`
/// from naming anything but a page under `/docs/`: no `..`, no query, no host.
pub fn is_page_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 200
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        })
}

// --- reading llms.txt -------------------------------------------------------

/// Parse the index: `# Title`, a `> summary`, then `## Section` headings over
/// `- [Title](url): description` lines, the llmstxt.org shape.
///
/// Lenient on purpose, because the site is edited on its own schedule: a line
/// this does not understand is skipped rather than failing the whole list, and
/// a link that is not a page under `/docs/` is left out.
pub fn parse_index(text: &str, web: &str) -> Listing {
    let mut listing = Listing::default();
    let mut seen = BTreeSet::new();
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(title) = line.strip_prefix("## ") {
            listing.sections.push(Section {
                title: title.trim().to_string(),
                pages: Vec::new(),
            });
        } else if let Some(title) = line.strip_prefix("# ") {
            if listing.title.is_empty() {
                listing.title = title.trim().to_string();
            }
        } else if let Some(summary) = line.strip_prefix('>') {
            if listing.summary.is_empty() && listing.sections.is_empty() {
                listing.summary = summary.trim().to_string();
            }
        } else if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            let Some(page) = parse_entry(item, web) else {
                continue;
            };
            if !seen.insert(page.path.clone()) {
                continue;
            }
            if listing.sections.is_empty() {
                listing.sections.push(Section {
                    title: String::new(),
                    pages: Vec::new(),
                });
            }
            if let Some(section) = listing.sections.last_mut() {
                section.pages.push(page);
            }
        }
    }
    listing.sections.retain(|s| !s.pages.is_empty());
    listing
}

/// `[Title](url): description`, without the bullet.
fn parse_entry(item: &str, web: &str) -> Option<Page> {
    let rest = item.strip_prefix('[')?;
    let close = rest.find("](")?;
    let title = rest[..close].trim();
    let after = &rest[close + 2..];
    let end = after.find(')')?;
    let description = after[end + 1..]
        .trim_start()
        .strip_prefix(':')
        .unwrap_or("")
        .trim();
    let path = path_of(after[..end].trim(), web)?;
    Some(Page {
        url: format!("{web}/docs/{path}"),
        path,
        title: title.to_string(),
        description: description.to_string(),
    })
}

/// `https://veistra.com/docs/get-started/install.md` (or `/docs/…`, or the
/// HTML address) to `get-started/install`. The host is not compared: the page
/// is always fetched from `web`, so a listing that says `www.` still works.
fn path_of(href: &str, web: &str) -> Option<String> {
    let base = url::Url::parse(&format!("{web}/")).ok()?;
    let resolved = base.join(href).ok()?;
    let rest = resolved.path().strip_prefix("/docs/")?;
    let rest = rest
        .strip_suffix(".md")
        .unwrap_or(rest)
        .trim_end_matches('/');
    is_page_path(rest).then(|| rest.to_string())
}

// --- fetching, and what is kept ---------------------------------------------

enum Failure {
    Missing,
    Unreachable(String),
}

/// One file, from the cache when fresh, from the site otherwise, and from the
/// cache again — marked stale — when the site cannot be reached.
fn fetch(url: &str) -> (Status, Option<String>, Option<String>) {
    if let Some(body) = cached(url, true) {
        return (Status::Live, None, Some(body));
    }
    match get(url) {
        Ok(body) => {
            remember(url, &body);
            (Status::Live, None, Some(body))
        }
        Err(Failure::Missing) => (Status::Missing, None, None),
        Err(Failure::Unreachable(why)) => match cached(url, false) {
            Some(body) => (Status::Stale, Some(why), Some(body)),
            None => (Status::Offline, Some(why), None),
        },
    }
}

fn get(url: &str) -> Result<String, Failure> {
    let mut response = crate::cloud::http::agent()
        .get(url)
        .call()
        .map_err(|e| Failure::Unreachable(e.to_string()))?;
    let status = response.status().as_u16();
    if status == 404 || status == 410 {
        return Err(Failure::Missing);
    }
    if !(200..300).contains(&status) {
        return Err(Failure::Unreachable(format!(
            "the site answered HTTP {status}"
        )));
    }
    // A host that answers every path with its HTML shell would otherwise have
    // that shell drawn as a page of Markdown.
    let html = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().starts_with("text/html"));
    if html {
        return Err(Failure::Missing);
    }
    response
        .body_mut()
        .with_config()
        .limit(BODY_LIMIT)
        .read_to_string()
        .map_err(|e| Failure::Unreachable(e.to_string()))
}

type Cache = Mutex<HashMap<String, (Instant, String)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What was kept for `url`; only if younger than [`FRESH_FOR`] when `fresh`.
fn cached(url: &str, fresh: bool) -> Option<String> {
    let map = cache().lock_or_panic();
    let (at, body) = map.get(url)?;
    (!fresh || at.elapsed() < FRESH_FOR).then(|| body.clone())
}

fn remember(url: &str, body: &str) {
    let mut map = cache().lock_or_panic();
    if map.len() >= CACHE_ENTRIES && !map.contains_key(url) {
        map.clear();
    }
    map.insert(url.to_string(), (Instant::now(), body.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEB: &str = "https://veistra.com";

    /// The index as the site published it on 2026-11-04, verbatim.
    const LIVE: &str = "# Veistra

> Documentation for Veistra, a design canvas for prototyping games with your own agent. Each link is the page as plain Markdown.

## Get started

- [Install Veistra](https://veistra.com/docs/get-started/install.md): Download the Windows app and open it for the first time.
- [Sign in and accounts](https://veistra.com/docs/get-started/sign-in.md): Sign in on the website and in the app, and what to check before you approve a computer.

## Context

- [Connect Blender](https://veistra.com/docs/context/blender.md): Give agents a live view of your Blender scene. They read it, write scripts that change it, and check the result before they hand it back.

## Account

- [Usage and limits](https://veistra.com/docs/account/usage.md): What Veistra bills, where to see it, and how the monthly limit works.
- [API keys](https://veistra.com/docs/account/api-keys.md): Create, store and revoke the keys that call Veistra's API from your own scripts.
- [Devices](https://veistra.com/docs/account/devices.md): See which computers are signed in to your account, and sign one out.
";

    #[test]
    fn the_published_index_parses_into_its_sections_and_pages() {
        let listing = parse_index(LIVE, WEB);
        assert_eq!(listing.title, "Veistra");
        assert!(listing.summary.starts_with("Documentation for Veistra"));
        let titles: Vec<&str> = listing.sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["Get started", "Context", "Account"]);

        let install = &listing.sections[0].pages[0];
        assert_eq!(install.path, "get-started/install");
        assert_eq!(install.title, "Install Veistra");
        assert_eq!(install.url, "https://veistra.com/docs/get-started/install");
        assert_eq!(
            install.description,
            "Download the Windows app and open it for the first time."
        );
        let count: usize = listing.sections.iter().map(|s| s.pages.len()).sum();
        assert_eq!(count, 6);
    }

    #[test]
    fn a_line_that_is_not_a_docs_page_is_left_out_rather_than_failing_the_list() {
        let text = "# Docs\n\n## Mixed\n\n\
            - [Elsewhere](https://example.com/thing.md): not ours\n\
            - [Pricing](https://veistra.com/pricing): not under /docs\n\
            - [Sneaky](https://veistra.com/docs/../secrets.md): climbs out\n\
            - not a link at all\n\
            - [Relative](/docs/guides/first-run.md): resolved against the site\n\
            - [Relative](/docs/guides/first-run.md): listed twice\n\
            - [No description](https://veistra.com/docs/guides/quiet.md)\n\
            ## Empty\n";
        let listing = parse_index(text, WEB);
        assert_eq!(listing.sections.len(), 1, "an empty section is dropped");
        let paths: Vec<&str> = listing.sections[0]
            .pages
            .iter()
            .map(|p| p.path.as_str())
            .collect();
        assert_eq!(paths, ["guides/first-run", "guides/quiet"]);
        assert_eq!(listing.sections[0].pages[1].description, "");
    }

    #[test]
    fn pages_before_any_heading_still_land_somewhere() {
        let listing = parse_index("- [Install](https://veistra.com/docs/install.md)", WEB);
        assert_eq!(listing.sections.len(), 1);
        assert_eq!(listing.sections[0].title, "");
        assert_eq!(listing.sections[0].pages[0].path, "install");
    }

    /// A staging site's index names the staging host; a listing that says
    /// `www.` while the setting does not is still read as this site's pages.
    #[test]
    fn page_urls_are_built_from_the_configured_site_not_the_listing() {
        let listing = parse_index(
            "## A\n- [Install](https://www.veistra.com/docs/get-started/install.md): x",
            "https://staging.veistra.com",
        );
        assert_eq!(
            listing.sections[0].pages[0].url,
            "https://staging.veistra.com/docs/get-started/install"
        );
    }

    #[test]
    fn a_page_path_cannot_leave_the_docs() {
        for good in ["get-started/install", "account/api-keys", "faq", "v2/a_b"] {
            assert!(is_page_path(good), "{good}");
        }
        for bad in [
            "",
            "../secrets",
            "a//b",
            "/abs",
            "trailing/",
            "Upper/Case",
            "a?b=c",
            "a#b",
            "https://example.com",
            "a b",
        ] {
            assert!(!is_page_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn page_params_are_checked_before_anything_is_fetched() {
        assert!(page_param(Some(&json!({ "path": "context/blender" }))).is_ok());
        assert_eq!(
            page_param(Some(&json!({ "path": "../../etc/passwd" })))
                .unwrap_err()
                .code,
            INVALID_PARAMS
        );
        assert_eq!(page_param(None).unwrap_err().code, INVALID_PARAMS);
    }

    #[test]
    fn statuses_reach_the_frontend_in_camel_case() {
        let answer = PageAnswer {
            path: "faq".into(),
            url: "https://veistra.com/docs/faq".into(),
            status: Status::Offline,
            detail: Some("dns error".into()),
            markdown: None,
        };
        let value = serde_json::to_value(answer).unwrap();
        assert_eq!(value["status"], "offline");
        assert_eq!(value["markdown"], Value::Null);
    }

    /// The live site, end to end: its index parses into pages and the first
    /// of them is Markdown. Needs a network, so it runs only when asked:
    /// `cargo test -- --ignored the_live_site`.
    #[test]
    #[ignore]
    fn the_live_site_lists_pages_and_serves_them_as_markdown() {
        let (status, detail, body) = fetch(&format!("{DEFAULT_WEB}/llms.txt"));
        assert_eq!(status, Status::Live, "{detail:?}");
        let listing = parse_index(&body.unwrap_or_default(), DEFAULT_WEB);
        let first = listing
            .sections
            .iter()
            .flat_map(|s| &s.pages)
            .next()
            .expect("the index lists at least one page");
        let (status, detail, page) = fetch(&format!("{}.md", first.url));
        assert_eq!(status, Status::Live, "{detail:?}");
        assert!(page.unwrap_or_default().trim_start().starts_with('#'));
    }

    /// What `fetch` falls back to: a file read once is kept, and is there to
    /// serve as stale however old it is.
    #[test]
    fn a_remembered_file_is_fresh_and_also_kept_for_the_fallback() {
        let url = "https://veistra.invalid/docs/cached-test.md";
        assert_eq!(cached(url, false), None);
        remember(url, "# Cached");
        assert_eq!(cached(url, true).as_deref(), Some("# Cached"));
        assert_eq!(cached(url, false).as_deref(), Some("# Cached"));
    }
}
