//! Design Mode's Rust half: which page may be embedded, what may be put inside
//! it, how a picture of part of it is taken, and the comments left on what was
//! picked.
//!
//! The first three methods are each here because they could not be a component.
//! `design/target` decides what may be loaded at all — a security boundary
//! rather than a convenience, and the one part of this feature that most needs
//! a careful read. `design/arm` installs the probe through
//! `devtools::install_script`, because same-origin policy means nothing in the
//! shell can reach into a frame showing somebody else's origin.
//! `design/capture` crops a screenshot out of the window.
//!
//! **Nothing about a *frame* is remembered here**, like `files::call`: a second
//! Design Mode in a second cluster is a second frame with its own probe. The
//! `design/comment/*` methods are the other side of that rule rather than an
//! exception to it — see `docs/design-notes/design-comments.md`.
//!
//! `docs/design-notes/design-mode.md` is the long form — what each rule in
//! [`normalize`] is defending against, and exactly what a hostile page in that
//! frame can and cannot reach.

use crate::apps::CallContext;
use crate::design_comments::{Author, Comment, Comments, Draft, Element, Page, Rect, Status};
use crate::devtools;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager, Url};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The probe, as browser code. See `design_probe.js` for why it is a file.
const PROBE: &str = include_str!("design_probe.js");

/// The largest screenshot worth sending back, in base64 characters.
///
/// A cropped element is normally a few kilobytes; this is the ceiling for one
/// that is the whole page. Refusing beyond it rather than downscaling, because
/// the caller can retry against a smaller element and a silently resampled
/// image is a wrong answer that looks like a right one.
const SCREENSHOT_LIMIT: usize = 6 * 1024 * 1024;

/// A URL the app is cleared to load, and the origin it resolved to.
///
/// The origin is returned separately because the app needs it for the address
/// bar and, more importantly, because nothing in the frontend should be
/// re-parsing a URL to find one. Rust decided; the frontend displays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub url: String,
    pub origin: String,
}

/// Why a typed address was refused.
///
/// An enum rather than a string so the reasons can be tested one at a time —
/// [`normalize`] is the only thing standing between an arbitrary string and an
/// iframe, and "it refuses bad input" is not a claim worth making without
/// naming which bad input.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Refusal {
    Empty,
    Unreadable,
    Scheme(String),
    NoHost,
    ReservedHost(String),
    OwnOrigin(String),
}

impl Refusal {
    fn message(&self) -> String {
        match self {
            Refusal::Empty => "type the address of a page to inspect".to_string(),
            Refusal::Unreadable => "that is not an address a browser could open".to_string(),
            Refusal::Scheme(scheme) => {
                format!("Design Mode opens http and https pages; `{scheme}:` is not one of them")
            }
            Refusal::NoHost => "that address names no host to fetch it from".to_string(),
            Refusal::ReservedHost(host) => format!(
                "`{host}` is reserved — a name under `.localhost` can be mistaken for this \
                 application's own origin, which would hand the page Veistra's own permissions. \
                 Use `localhost` with a port instead."
            ),
            Refusal::OwnOrigin(origin) => format!(
                "`{origin}` is where this application is served from. A page on that origin is \
                 same-origin with the shell and could reach everything it can, so Design Mode \
                 will not embed one."
            ),
        }
    }
}

/// Whether the text already names a scheme, as opposed to opening with a host
/// and a port.
///
/// This exists because the two are ambiguous and the ambiguity is dangerous in
/// one direction. `localhost:5173` parses perfectly well as a URL whose *scheme*
/// is `localhost`, which is how a person typing the most ordinary address this
/// feature has would get told their scheme is not supported. Prepending
/// `http://` whenever `://` is absent fixes that and breaks the other way:
/// `data:text/html,…` and `javascript:…` have no `//` either, and become
/// `http://data:…`, which fails to parse and is reported as a typo rather than
/// as the two schemes that would run script with this app frame's own origin.
///
/// The character straight after the colon settles it. A port is digits; no
/// scheme's body begins with one, because `//`, a path or a payload is what
/// follows a colon in every URL that has a real scheme.
fn states_a_scheme(typed: &str) -> bool {
    let Some((prefix, rest)) = typed.split_once(':') else {
        return false;
    };

    let starts_like_a_scheme = prefix
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');

    starts_like_a_scheme && !rest.starts_with(|c: char| c.is_ascii_digit())
}

/// Turn what somebody typed into a URL that is safe to put in a frame, or say
/// why it is not.
///
/// Four rules, none of them cosmetic, and the reasoning for each is in
/// `docs/design-notes/design-mode.md`:
///
/// - a missing scheme is filled in, because nobody types `http://`;
/// - only `http` and `https` are loadable, so that `file:`, `data:` and
///   `javascript:` cannot run with this app frame's own origin;
/// - **no host under `.localhost`**, because Tauri reads the first label of one
///   as a custom protocol name and would treat the page as *local*;
/// - **not the shell's own origin**, `shell`, which `allow-same-origin` on the
///   frame would otherwise let a page use to remove its own sandbox. `None`
///   means it could not be read, and that rule alone is skipped.
fn normalize(raw: &str, shell: Option<&str>) -> Result<Target, Refusal> {
    let typed = raw.trim();
    if typed.is_empty() {
        return Err(Refusal::Empty);
    }

    let with_scheme = if states_a_scheme(typed) {
        typed.to_string()
    } else {
        format!("http://{typed}")
    };

    let url = Url::parse(&with_scheme).map_err(|_| Refusal::Unreadable)?;

    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(Refusal::Scheme(url.scheme().to_string()));
    }

    let host = url.host_str().ok_or(Refusal::NoHost)?.to_ascii_lowercase();
    if host.ends_with(".localhost") {
        return Err(Refusal::ReservedHost(host));
    }

    let origin = url.origin().ascii_serialization();
    if shell.is_some_and(|own| own.eq_ignore_ascii_case(&origin)) {
        return Err(Refusal::OwnOrigin(origin));
    }

    Ok(Target {
        origin,
        url: url.to_string(),
    })
}

/// Where the shell itself is served from, as an origin.
///
/// Read off a live window rather than reconstructed from `tauri.conf.json`,
/// because the two disagree: the config names a dev URL and a `frontendDist`,
/// and which of them is in force — and under which scheme Tauri decided to
/// serve it — is a fact about the running process. The splash is skipped for
/// the reason `devtools::pick` skips it.
fn shell_origin(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label != "splash")
        .find_map(|(_, window)| window.url().ok())
        .map(|url| url.origin().ascii_serialization())
}

/// A rectangle to cut out of the window, in the top-level document's own CSS
/// pixels — which is not where the element was measured. The app walks the
/// frames between the two and hands over the result; see `useCapture`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Clip {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Read a clip out of a call's params, refusing anything that is not a real
/// rectangle.
///
/// `NaN` and infinities are checked for by name rather than trusted to compare
/// falsely: they arrive from JavaScript, where a subtraction between two rects
/// one of which was never laid out produces one, and the DevTools Protocol's
/// answer to a `NaN` in a clip is not one this code should have to know.
fn read_clip(params: Option<&Value>) -> Result<Clip, RpcError> {
    let number = |name: &str| -> Result<f64, RpcError> {
        params
            .and_then(|p| p.get(name))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                RpcError::new(
                    INVALID_PARAMS,
                    format!("design/capture needs a finite `{name}`"),
                )
            })
    };

    let clip = Clip {
        x: number("x")?.max(0.0),
        y: number("y")?.max(0.0),
        width: number("width")?,
        height: number("height")?,
    };

    if clip.width < 1.0 || clip.height < 1.0 {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "that element has no area on screen to photograph",
        ));
    }

    Ok(clip)
}

/// Photograph one rectangle of the focused shell window.
///
/// **The focused window, not a named one.** `app_call` carries the cluster a
/// call came from but nothing maps a cluster to an operating system window, and
/// inventing that mapping is a change to the shell's own model rather than to
/// this app. The frontend closes the gap from its side instead: it refuses to
/// ask while `document.hasFocus()` is false, so the window being photographed
/// is the window the click happened in. A second Veistra window holding a second
/// Design Mode while this one has focus is the case that would otherwise be
/// answered with a picture of the wrong screen.
fn capture(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let clip = read_clip(params)?;

    let shot = devtools::call(
        app,
        None,
        "Page.captureScreenshot",
        &json!({
            "format": "png",
            "captureBeyondViewport": false,
            "fromSurface": true,
            "clip": {
                "x": clip.x,
                "y": clip.y,
                "width": clip.width,
                "height": clip.height,
                "scale": 1.0,
            },
        }),
    )
    .map_err(|e| RpcError::new(INTERNAL_ERROR, e.message()))?;

    let data = shot
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INTERNAL_ERROR, "the window returned no image"))?;

    if data.len() > SCREENSHOT_LIMIT {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "that element is too large to photograph — pick something smaller inside it",
        ));
    }

    Ok(json!({
        "dataUrl": format!("data:image/png;base64,{data}"),
        "width": clip.width,
        "height": clip.height,
    }))
}

/// Put the probe in front of every document the window loads from here on, and
/// hand back what removes it again.
///
/// `replaces` is the id of a previous install, dropped first. The app passes
/// its own last one, so re-arming after a navigation does not leave a second
/// copy of the probe behind — which would be harmless (the probe is idempotent)
/// but would accumulate for as long as the window lives.
fn arm(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    if let Some(previous) = params
        .and_then(|p| p.get("replaces"))
        .and_then(Value::as_str)
    {
        // A removal that fails is not worth failing the arm over: the id may be
        // from a window that has since closed, and the outcome either way is
        // that the caller gets a working probe.
        let _ = devtools::remove_script(app, None, previous);
    }

    let id = devtools::install_script(app, None, PROBE)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.message()))?;

    Ok(json!({ "scriptId": id }))
}

fn disarm(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let id = params
        .and_then(|p| p.get("scriptId"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "design/disarm needs the scriptId to drop"))?;

    devtools::remove_script(app, None, id)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.message()))?;
    Ok(Value::Null)
}

fn target(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let raw = params
        .and_then(|p| p.get("url"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "design/target needs a url"))?;

    let resolved = normalize(raw, shell_origin(app).as_deref())
        .map_err(|why| RpcError::new(INVALID_PARAMS, why.message()))?;

    serde_json::to_value(&resolved)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not answer: {e}")))
}

/// The most text one comment may carry.
///
/// Generous — this is a paragraph or two, not a tweet — and bounded, because the
/// store is rewritten in full on every reply and a textarea will take whatever
/// somebody pastes into it. Refused rather than truncated: a request silently
/// cut off halfway is a request an agent answers wrongly.
const MAX_TEXT: usize = 4000;

/// A string parameter that has to say something.
fn said(params: Option<&Value>, field: &str, method: &str) -> Result<String, RpcError> {
    let text = params
        .and_then(|p| p.get(field))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();

    if text.is_empty() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{method} needs a `{field}`"),
        ));
    }

    if text.chars().count() > MAX_TEXT {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("that is longer than a comment can be ({MAX_TEXT} characters)"),
        ));
    }

    Ok(text.to_string())
}

/// A comment id, as every `design/comment/*` method but `add` takes one.
fn comment_id(params: Option<&Value>, method: &str) -> Result<String, RpcError> {
    params
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("{method} needs a comment id")))
}

/// The string entries of a JSON object, and nothing else.
///
/// Anything that is not a string is dropped rather than refused, on the same
/// reasoning `probe.ts` gives for its own version: a page that put a nested
/// object in its attribute map is a page whose payload is wrong, not a comment
/// worth losing.
fn strings(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, entry)| Some((key.clone(), entry.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn finite(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or_default()
}

/// Turn the `PickedElement` the app already holds into what the store keeps.
///
/// The app sends the probe's payload through unchanged rather than
/// restructuring it, so this is the one place the two shapes are mapped onto
/// each other and the one place to look when they disagree.
fn read_picked(picked: Option<&Value>) -> Result<(Page, Element), RpcError> {
    let page = picked.and_then(|p| p.get("page"));
    let target = picked.and_then(|p| p.get("target"));

    let tag = target
        .and_then(|t| t.get("tagName"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    if tag.is_empty() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "a comment needs the element it is about — nothing was picked",
        ));
    }

    let text = |owner: Option<&Value>, field: &str| {
        owner
            .and_then(|o| o.get(field))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let rect = target.and_then(|t| t.get("rect"));

    Ok((
        Page {
            url: text(page, "url"),
            title: text(page, "title"),
        },
        Element {
            tag: tag.to_string(),
            selector: text(target, "selector"),
            ancestors: text(target, "ancestors"),
            text: text(target, "text"),
            html: text(target, "html"),
            attributes: strings(target.and_then(|t| t.get("attributes"))),
            styles: strings(target.and_then(|t| t.get("styles"))),
            rect: Rect {
                x: finite(rect.and_then(|r| r.get("x"))),
                y: finite(rect.and_then(|r| r.get("y"))),
                width: finite(rect.and_then(|r| r.get("width"))),
                height: finite(rect.and_then(|r| r.get("height"))),
            },
        },
    ))
}

/// The bytes behind a `data:image/png;base64,…`, or `None` for anything else.
///
/// Strict about the prefix rather than permissive: this string is about to
/// become a file on disk under a name this code chose, and the one thing worth
/// checking is that it really is the PNG `design/capture` produced.
///
/// Held to the same [`SCREENSHOT_LIMIT`] that call is, and for a second reason
/// beyond the one there. This one *writes*, so an oversized payload is a file
/// somebody is stuck with rather than an answer they can ignore, and the check
/// has to be here rather than trusted to the call that produced it — the
/// frontend is the only thing between the two, and this method may be reached
/// without ever having called it.
fn png_bytes(data_url: Option<&Value>) -> Option<Vec<u8>> {
    let raw = data_url.and_then(Value::as_str)?;
    let payload = raw.strip_prefix("data:image/png;base64,")?;
    if payload.len() > SCREENSHOT_LIMIT {
        return None;
    }
    BASE64.decode(payload).ok()
}

/// Every comment on this machine, for the app's own list.
///
/// Unfiltered: the app knows which page it is showing and which comments belong
/// to it, and a filter here would be a second answer to a question the frontend
/// already has to be able to answer while it draws them.
fn comment_list(app: &AppHandle) -> Result<Value, RpcError> {
    let comments = app.state::<Comments>().all();

    serde_json::to_value(comments).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the comments would not serialize: {e}"),
        )
    })
}

/// Write down what somebody asked for, and keep the picture beside it.
///
/// A screenshot that will not decode or will not write is recorded as a comment
/// *without* one rather than as a failure. The sentence is the part an agent
/// acts on; losing it because a PNG did not land would be the wrong trade, and
/// `has_shot` already tells every reader which happened.
fn comment_add(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let request = said(params, "request", "design/comment/add")?;
    let (page, element) = read_picked(params.and_then(|p| p.get("picked")))?;
    let png = png_bytes(params.and_then(|p| p.get("shot")));

    let comment = app.state::<Comments>().add(
        app,
        Draft {
            page,
            element,
            request,
        },
        png.as_deref(),
    );

    answer(comment)
}

/// The user's own turn on a comment: replying to a question, or resolving it.
fn comment_say(
    app: &AppHandle,
    params: Option<&Value>,
    method: &str,
    status: Status,
) -> Result<Value, RpcError> {
    let id = comment_id(params, method)?;
    let text = said(params, "text", method)?;

    let comment = app
        .state::<Comments>()
        .say(app, &id, Author::User, &text, status)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no comment with id `{id}`")))?;

    answer(comment)
}

fn comment_delete(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let id = comment_id(params, "design/comment/delete")?;

    if !app.state::<Comments>().remove(app, &id) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("no comment with id `{id}`"),
        ));
    }

    Ok(Value::Null)
}

fn answer(comment: Comment) -> Result<Value, RpcError> {
    serde_json::to_value(comment).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the comment would not serialize: {e}"),
        )
    })
}

/// Route one `invoke` from the Design Mode app.
///
/// The `CallContext` is ignored, as Docs' is: what is on screen here is a
/// URL somebody typed, not anything about the project a cluster is pointed at.
pub fn call(
    app: &AppHandle,
    _context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "design/target" => target(app, params.as_ref()),
        "design/arm" => arm(app, params.as_ref()),
        "design/disarm" => disarm(app, params.as_ref()),
        "design/capture" => capture(app, params.as_ref()),
        "design/comment/list" => comment_list(app),
        "design/comment/add" => comment_add(app, params.as_ref()),
        "design/comment/reply" => {
            comment_say(app, params.as_ref(), "design/comment/reply", Status::Open)
        }
        "design/comment/resolve" => comment_say(
            app,
            params.as_ref(),
            "design/comment/resolve",
            Status::Resolved,
        ),
        "design/comment/delete" => comment_delete(app, params.as_ref()),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CARGO_MANIFEST_DIR`, preferring the value Cargo puts in the
    /// environment of a test binary it launches over the one baked in at
    /// compile time.
    ///
    /// Several worktrees sharing one `CARGO_TARGET_DIR` (a deliberate
    /// convention for agents working this repo) hold identical sources, so
    /// Cargo can reuse a test binary compiled in a worktree that has since
    /// been removed, carrying that worktree's absolute path. Reading the
    /// environment first avoids resolving fixtures against a directory that
    /// no longer exists; the check below catches the rarer case where a
    /// stale binary somehow still ran, and names the problem instead of
    /// leaving a bare `NotFound` for the next agent to puzzle over.
    fn manifest_dir() -> std::path::PathBuf {
        let dir = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR")
                .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string()),
        );
        assert!(
            dir.is_dir(),
            "CARGO_MANIFEST_DIR resolved to {}, which does not exist -- this looks like a \
             stale cross-worktree build (a test binary compiled in a worktree that has \
             since been removed and reused from a shared CARGO_TARGET_DIR); rerun \
             `cargo test` from this worktree to force a rebuild",
            dir.display()
        );
        dir
    }

    #[test]
    fn a_bare_host_and_port_gets_a_scheme() {
        let target =
            normalize("localhost:5173", None).expect("a dev server address is ordinary input");
        assert_eq!(target.url, "http://localhost:5173/");
        assert_eq!(target.origin, "http://localhost:5173");
    }

    #[test]
    fn surrounding_whitespace_is_not_the_users_problem() {
        assert_eq!(
            normalize("  http://127.0.0.1:3000/  ", None).map(|t| t.url),
            Ok("http://127.0.0.1:3000/".to_string())
        );
    }

    #[test]
    fn https_is_kept_rather_than_downgraded() {
        let target = normalize("https://example.com/path", None).expect("https is allowed");
        assert_eq!(target.origin, "https://example.com");
    }

    /// The three schemes that would each be a different way of running code
    /// with the shell's own privileges, and one that is merely not a page.
    #[test]
    fn only_http_schemes_are_loadable() {
        for raw in [
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript://x/%0aalert(1)",
            "data:text/html,<h1>hi</h1>",
            "veistra-tool://home/index.html",
        ] {
            assert!(
                matches!(normalize(raw, None), Err(Refusal::Scheme(_))),
                "{raw} should have been refused for its scheme"
            );
        }
    }

    /// The whole reason [`normalize`] exists. Tauri reads the first label of a
    /// `*.localhost` host as a custom protocol name and treats the page as
    /// local if it matches one — so this must never resolve, whatever the port.
    #[test]
    fn a_host_under_localhost_is_refused() {
        for raw in [
            "http://veistra-tool.localhost:5173",
            "http://tauri.localhost",
            "https://ipc.localhost/anything",
            "http://SOMETHING.LocalHost:1234",
        ] {
            assert!(
                matches!(normalize(raw, None), Err(Refusal::ReservedHost(_))),
                "{raw} should have been refused as a reserved host"
            );
        }
    }

    /// Plain `localhost` is the address this feature exists to point at, and
    /// the rule above must not have taken it with the rest.
    #[test]
    fn plain_localhost_still_works() {
        assert!(normalize("http://localhost:1234", None).is_ok());
    }

    /// The bug this function was written for, kept as a test because both
    /// halves of it are one-character decisions: `localhost:5173` must not read
    /// as a scheme, and `data:` must.
    #[test]
    fn a_port_is_not_a_scheme_and_a_scheme_is_not_a_port() {
        assert!(!states_a_scheme("localhost:5173"));
        assert!(!states_a_scheme("127.0.0.1:3000"));
        assert!(!states_a_scheme("example.com"));
        assert!(states_a_scheme("http://localhost:5173"));
        assert!(states_a_scheme("data:text/html,x"));
        assert!(states_a_scheme("javascript:alert(1)"));
        assert!(states_a_scheme("file:///c:/x"));
    }

    /// A page on the shell's own origin can take its own sandbox off, because
    /// `allow-same-origin` means what it says. In a release build the
    /// `.localhost` rule already covers it; in development nothing else does.
    #[test]
    fn the_shell_will_not_embed_itself() {
        let own = Some("http://localhost:1420");
        assert!(matches!(
            normalize("localhost:1420", own),
            Err(Refusal::OwnOrigin(_))
        ));
        assert!(matches!(
            normalize("http://localhost:1420/apps/home/ui/index.html", own),
            Err(Refusal::OwnOrigin(_))
        ));
        // A neighbouring port is a different origin and an ordinary target.
        assert!(normalize("localhost:1430", own).is_ok());
    }

    /// The origin cannot always be read — a window may be mid-navigation. The
    /// rule is skipped rather than guessed at, and the others still apply.
    #[test]
    fn an_unknown_shell_origin_does_not_refuse_everything() {
        assert!(normalize("localhost:1420", None).is_ok());
        assert!(matches!(
            normalize("http://x.localhost", None),
            Err(Refusal::ReservedHost(_))
        ));
    }

    #[test]
    fn nothing_typed_says_so_rather_than_failing_to_parse() {
        assert_eq!(normalize("   ", None), Err(Refusal::Empty));
    }

    /// Every refusal is read by somebody who has just typed something and been
    /// told no, so each has to say a different thing about what to do next.
    #[test]
    fn every_refusal_explains_itself_differently() {
        let messages = [
            Refusal::Empty.message(),
            Refusal::Unreadable.message(),
            Refusal::Scheme("file".to_string()).message(),
            Refusal::NoHost.message(),
            Refusal::ReservedHost("x.localhost".to_string()).message(),
            Refusal::OwnOrigin("http://localhost:1420".to_string()).message(),
        ];
        let unique: std::collections::HashSet<&String> = messages.iter().collect();
        assert_eq!(unique.len(), messages.len(), "two refusals read the same");
        for message in &messages {
            assert!(!message.trim().is_empty());
        }
    }

    #[test]
    fn a_clip_needs_four_finite_numbers() {
        let ok = read_clip(Some(
            &json!({"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}),
        ));
        assert!(ok.is_ok());

        for missing in ["x", "y", "width", "height"] {
            let mut params = json!({"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0});
            if let Some(object) = params.as_object_mut() {
                object.remove(missing);
            }
            assert!(
                read_clip(Some(&params)).is_err(),
                "a clip without `{missing}` should be refused"
            );
        }
    }

    /// A zero-area element is a real thing to click — a collapsed wrapper, a
    /// hidden input — and the DevTools Protocol's answer to a zero-width clip
    /// is not one this code should be discovering at runtime.
    #[test]
    fn a_clip_with_no_area_is_refused() {
        let flat = read_clip(Some(
            &json!({"x": 0.0, "y": 0.0, "width": 0.0, "height": 10.0}),
        ));
        assert!(flat.is_err());
    }

    #[test]
    fn a_negative_origin_is_clamped_rather_than_refused() {
        // An element scrolled above the viewport reports a negative `y`, and
        // the useful answer is the part of it that is on screen.
        let clip = read_clip(Some(
            &json!({"x": -30.0, "y": -8.0, "width": 20.0, "height": 20.0}),
        ))
        .expect("a partly offscreen element is still worth photographing");
        assert_eq!(clip.x, 0.0);
        assert_eq!(clip.y, 0.0);
    }

    /// **The one property this whole feature rests on**, checked rather than
    /// remembered.
    ///
    /// An embedded page *does* get `window.ipc.postMessage`: wry installs it
    /// with the same all-frames call [`devtools::install_script`] uses, and its
    /// own documentation notes that Windows ignores the main-frame-only flag
    /// Tauri asks for. What stops that page reaching a command is Tauri's ACL,
    /// which requires an explicit `remote` grant for any origin that is not the
    /// app's own — so the defence is exactly "no capability declares one".
    ///
    /// That is true today and this feature does not change it. It is also the
    /// kind of thing a future capability edit would undo silently, hence a test
    /// that reads the files. See `docs/design-notes/design-mode.md`.
    #[test]
    fn no_capability_grants_a_remote_origin_access() {
        let dir = manifest_dir().join("capabilities");
        let entries = std::fs::read_dir(&dir).expect("the capabilities directory is checked in");

        let mut seen = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("a capability file must be readable");
            let parsed: Value = serde_json::from_str(&text).expect("a capability file is JSON");
            assert!(
                parsed.get("remote").is_none(),
                "{} declares `remote`, which lets a page Design Mode embedded reach Veistra's \
                 commands. If this is deliberate, Design Mode needs a different defence and \
                 docs/design-notes/design-mode.md needs rewriting.",
                path.display()
            );
            seen += 1;
        }

        assert!(seen >= 2, "expected the default and splash capabilities");
    }

    /// The probe is compiled in, and an empty one would arm a frame with
    /// nothing in it and report success.
    #[test]
    fn the_probe_is_present_and_guards_its_sender() {
        assert!(
            PROBE.len() > 1000,
            "the probe did not make it into the binary"
        );
        assert!(
            PROBE.contains("event.source !== window.parent"),
            "the probe must only obey the frame that embedded it"
        );
        assert!(
            PROBE.contains("if (window.parent === window) return;"),
            "the probe must never arm in the shell's own top frame"
        );
    }

    fn picked() -> Value {
        json!({
            "page": { "url": "http://localhost:5173/", "title": "Home" },
            "target": {
                "tagName": "button",
                "selector": ".cta",
                "ancestors": "main > form",
                "text": "Save",
                "html": "<button class=\"cta\">Save</button>",
                "attributes": { "class": "cta", "disabled": false },
                "styles": { "padding": "8px", "color": "rgb(0, 0, 0)" },
                "rect": { "x": 10.0, "y": 20.0, "width": 30.0, "height": 40.0 },
            },
        })
    }

    #[test]
    fn a_picked_element_maps_onto_what_the_store_keeps() {
        let (page, element) = read_picked(Some(&picked())).expect("an ordinary capture");

        assert_eq!(page.url, "http://localhost:5173/");
        assert_eq!(page.title, "Home");
        assert_eq!(element.tag, "button");
        assert_eq!(element.selector, ".cta");
        assert_eq!(element.ancestors, "main > form");
        assert_eq!(
            element.attributes.get("class").map(String::as_str),
            Some("cta")
        );
        assert_eq!(element.styles.len(), 2);
        assert_eq!(element.rect.width, 30.0);
    }

    /// The probe budgets what it sends and a page can post junk on purpose, so
    /// a non-string entry is dropped rather than taking the comment with it.
    #[test]
    fn a_non_string_attribute_is_dropped_rather_than_refused() {
        let (_, element) = read_picked(Some(&picked())).expect("an ordinary capture");
        assert!(!element.attributes.contains_key("disabled"));
    }

    /// A comment with no element is a comment nothing can act on, and the only
    /// way to get one is a bug in the app rather than a page misbehaving.
    #[test]
    fn a_comment_needs_an_element() {
        for missing in [json!({}), json!({ "target": {} }), json!(null)] {
            assert!(
                read_picked(Some(&missing)).is_err(),
                "{missing} should not become a comment"
            );
        }
        assert!(read_picked(None).is_err());
    }

    /// Every field but the tag defaults rather than refusing. A page that would
    /// not report its own title is not a reason to lose the sentence somebody
    /// typed about it.
    #[test]
    fn everything_but_the_tag_survives_being_absent() {
        let bare = json!({ "target": { "tagName": "div" } });
        let (page, element) = read_picked(Some(&bare)).expect("a tag is enough");

        assert_eq!(element.tag, "div");
        assert!(page.url.is_empty());
        assert!(element.styles.is_empty());
        assert_eq!(element.rect.width, 0.0);
    }

    /// `NaN` and infinities arrive from JavaScript, where a subtraction between
    /// two rects one of which was never laid out produces one.
    #[test]
    fn a_rect_that_is_not_a_number_reads_as_zero() {
        let odd = json!({
            "target": { "tagName": "div", "rect": { "x": "left", "width": null } },
        });
        let (_, element) = read_picked(Some(&odd)).expect("a tag is enough");
        assert_eq!(element.rect.x, 0.0);
        assert_eq!(element.rect.width, 0.0);
    }

    /// The file this decodes into is named by this code and written under the
    /// config directory, so the one thing worth checking is that it really is
    /// the PNG `design/capture` produced.
    #[test]
    fn only_a_png_data_url_becomes_a_screenshot() {
        let png = json!("data:image/png;base64,aGk=");
        assert_eq!(png_bytes(Some(&png)), Some(b"hi".to_vec()));

        for wrong in [
            json!("data:image/svg+xml;base64,aGk="),
            json!("data:text/html;base64,aGk="),
            json!("data:image/png;base64,not base64"),
            json!("http://example.com/x.png"),
            json!(null),
        ] {
            assert!(png_bytes(Some(&wrong)).is_none(), "{wrong} is not a shot");
        }
        assert!(png_bytes(None).is_none());
    }

    /// This method writes, so an oversized payload is a file somebody is stuck
    /// with rather than an answer they can ignore. `design/capture` refuses the
    /// same size, and this may be reached without having called it.
    #[test]
    fn a_screenshot_over_the_limit_is_not_written_at_all() {
        let huge = json!(format!(
            "data:image/png;base64,{}",
            "A".repeat(SCREENSHOT_LIMIT + 4)
        ));
        assert!(png_bytes(Some(&huge)).is_none());
    }

    /// A comment is somebody's sentence, and the box it is typed into will take
    /// whatever is pasted. Refused rather than truncated: a request silently cut
    /// in half is a request an agent answers wrongly.
    #[test]
    fn a_comment_has_to_say_something_and_may_not_say_everything() {
        let method = "design/comment/add";
        assert!(said(Some(&json!({ "request": "" })), "request", method).is_err());
        assert!(said(Some(&json!({ "request": "   " })), "request", method).is_err());
        assert!(said(None, "request", method).is_err());

        let huge = json!({ "request": "x".repeat(MAX_TEXT + 1) });
        assert!(said(Some(&huge), "request", method).is_err());

        assert_eq!(
            said(Some(&json!({ "request": "  bigger  " })), "request", method).ok(),
            Some("bigger".to_string())
        );
    }

    #[test]
    fn every_comment_method_needs_an_id() {
        assert!(comment_id(None, "design/comment/reply").is_err());
        assert!(comment_id(Some(&json!({ "id": "" })), "design/comment/reply").is_err());
        assert_eq!(
            comment_id(Some(&json!({ "id": "c7" })), "design/comment/reply").ok(),
            Some("c7".to_string())
        );
    }
}
