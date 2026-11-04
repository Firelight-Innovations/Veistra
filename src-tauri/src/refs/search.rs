//! Finding things to reference by what they are called: files and folders,
//! canvases and frames, comments and context items.
//!
//! Names, not contents. An agent greps file contents with its own tools, and a
//! person typing after `@` types what they remember a thing is called. Every
//! hit is a reference that resolves under the same rules as any other, and a
//! path a reference would withhold as a secret is never listed.

use super::live::{self, Actor};
use super::policy;
use super::resolve::{self, first_line};
use super::uri::{CanvasPart, Ref};
use crate::apps::CallContext;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Hits returned when the caller names no limit, and the most it may ask for.
pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 50;
/// Most entries the file walk visits before it stops looking.
const MAX_WALKED: usize = 20_000;
/// Longest query, in characters and in words.
const MAX_QUERY_CHARS: usize = 256;
const MAX_QUERY_WORDS: usize = 16;

/// The kinds a search can be narrowed to.
pub const KINDS: &[&str] = &[
    "file",
    "folder",
    "canvas",
    "frame",
    "comment",
    "canvas-comment",
    "design-comment",
    "context",
    "selection",
];

/// One thing found: a reference and the words to show beside it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub uri: String,
    pub kind: &'static str,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip)]
    score: u32,
    /// A file whose first bytes are read before the hit is listed, to keep
    /// out a secret its name does not give away. Read only for hits that
    /// would be returned, so a broad query does not open every match.
    #[serde(skip)]
    screen: Option<PathBuf>,
}

/// What was asked: the words, the kinds and how many hits.
#[derive(Debug, Clone)]
pub struct Query {
    words: Vec<String>,
    kinds: Option<Vec<String>>,
    pub limit: usize,
}

impl Query {
    pub fn new(
        text: &str,
        kinds: Option<Vec<String>>,
        limit: Option<usize>,
    ) -> Result<Self, String> {
        if let Some(bad) = kinds
            .iter()
            .flatten()
            .find(|k| !KINDS.contains(&k.as_str()))
        {
            return Err(format!(
                "`{bad}` is not a kind; use one of {}",
                KINDS.join(", ")
            ));
        }
        if kinds.as_ref().is_some_and(Vec::is_empty) {
            return Err("`kinds` is empty; leave it out to search every kind".into());
        }
        let words: Vec<String> = text.split_whitespace().map(str::to_lowercase).collect();
        if text.chars().count() > MAX_QUERY_CHARS || words.len() > MAX_QUERY_WORDS {
            return Err(format!(
                "a query is at most {MAX_QUERY_CHARS} characters and {MAX_QUERY_WORDS} words: \
                 search by name, not by pasting text"
            ));
        }
        Ok(Query {
            words,
            kinds,
            limit: limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        })
    }

    /// True only when the caller named `kind`, so a search over everything does
    /// not list every frame of every canvas.
    fn asks_for(&self, kind: &str) -> bool {
        self.kinds
            .as_ref()
            .is_some_and(|k| k.iter().any(|w| w == kind))
    }

    fn wants(&self, kind: &str) -> bool {
        self.kinds
            .as_ref()
            .is_none_or(|k| k.iter().any(|w| w == kind))
    }

    /// How well a thing called `name`, found at `path`, matches; `None` when a
    /// word is in neither. An exact name beats a prefix, a prefix beats a
    /// match anywhere in the name, and that beats one only in the path. A
    /// shorter path wins a tie. With no words everything matches equally.
    fn score(&self, name: &str, path: &str) -> Option<u32> {
        let (name, path) = (name.to_lowercase(), path.to_lowercase());
        let found = |w: &String| name.contains(w.as_str()) || path.contains(w.as_str());
        if !self.words.iter().all(found) {
            return None;
        }
        let phrase = self.words.join(" ");
        let tier = if self.words.is_empty() {
            1
        } else if name == phrase {
            4
        } else if name.starts_with(&phrase) {
            3
        } else if self.words.iter().all(|w| name.contains(w.as_str())) {
            2
        } else {
            1
        };
        Some(tier * 1000 - path.chars().count().min(999) as u32)
    }
}

/// Everything that matches, best first, at most `q.limit`.
pub fn run(app: &AppHandle, ctx: &CallContext, actor: Actor, q: &Query) -> Vec<Hit> {
    let Some(root) = ctx.project.as_deref() else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    hits.extend(selection(q));
    hits.extend(context_items(root, q));
    hits.extend(viewer_comments(ctx, q));
    hits.extend(canvases(app, ctx, actor, root, q));
    if q.wants("canvas-comment") {
        let rows = super::comments::open_canvas_rows(app, ctx, actor);
        hits.extend(canvas_comment_hits(&rows, q));
    }
    hits.extend(design_comments(app, q));
    hits.extend(files(root, q));
    rank(hits, q.limit)
}

/// Best first, at most `limit`, leaving out any hit whose file turns out to
/// hold a secret.
fn rank(mut hits: Vec<Hit>, limit: usize) -> Vec<Hit> {
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.cmp(&b.title)));
    let shown = |h: &Hit| {
        h.screen
            .as_deref()
            .is_none_or(|p| resolve::secret_head(p).is_none())
    };
    hits.into_iter().filter(shown).take(limit).collect()
}

fn hit(r: &Ref, kind: &'static str, title: String, detail: Option<String>, score: u32) -> Hit {
    Hit {
        uri: r.to_string(),
        kind,
        title,
        detail,
        score,
        screen: None,
    }
}

fn selection(q: &Query) -> Option<Hit> {
    let score = q
        .wants("selection")
        .then(|| q.score("selection", "selection"))
        .flatten()?;
    Some(hit(
        &Ref::Selection,
        "selection",
        "Selection".into(),
        Some("what is selected in this cluster's panes".into()),
        score,
    ))
}

/// Files and folders under `root`, by name. Gitignored entries, hidden ones,
/// links and secrets are not walked into or listed. An empty query lists
/// none: a project has too many files for a list of them to help.
fn files(root: &Path, q: &Query) -> Vec<Hit> {
    let (want_files, want_folders) = (q.wants("file"), q.wants("folder"));
    if q.words.is_empty() || !(want_files || want_folders) {
        return Vec::new();
    }
    let walk = ignore::WalkBuilder::new(root)
        .hidden(true)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .build();
    let mut hits = Vec::new();
    for entry in walk.flatten().skip(1).take(MAX_WALKED) {
        if entry.path_is_symlink() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if (is_dir && !want_folders) || (!is_dir && !want_files) {
            continue;
        }
        if policy::secret_rule(&rel).is_some() || policy::check_relative(&rel).is_err() {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        if let Some(score) = q.score(&name, &rel) {
            let r = Ref::File {
                path: rel.clone(),
                lines: None,
            };
            let kind = if is_dir { "folder" } else { "file" };
            let mut found = hit(&r, kind, name, Some(rel), score);
            found.screen = (!is_dir).then(|| entry.path().to_path_buf());
            hits.push(found);
        }
    }
    hits
}

/// Items in the context store, by title. One that reading would withhold as
/// a secret is left out, by any name it goes by or by what its file holds.
fn context_items(root: &Path, q: &Query) -> Vec<Hit> {
    if !q.wants("context") {
        return Vec::new();
    }
    crate::context::list(root)
        .into_iter()
        .filter(|i| !i.missing)
        .filter(|i| resolve::item_secret_name(root, i).is_none())
        .filter_map(|i| {
            let score = q.score(&i.title, &i.title)?;
            let from = i.source.label.clone().unwrap_or(i.source.app_id.clone());
            let screen = policy::contain(root, &i.rel_path).ok().map(|f| f.abs);
            let r = Ref::Context { id: i.id };
            let detail = Some(format!("context · {from}"));
            let mut found = hit(&r, "context", i.title, detail, score);
            found.screen = screen;
            Some(found)
        })
        .collect()
}

/// Viewer comments, by what they say and where they are pinned.
fn viewer_comments(ctx: &CallContext, q: &Query) -> Vec<Hit> {
    if !q.wants("comment") {
        return Vec::new();
    }
    let Ok(all) = crate::comments::list(ctx) else {
        return Vec::new();
    };
    all.into_iter()
        .filter_map(|c| {
            let at = anchor_label(&c.anchor);
            let title = first_line(&c.body);
            let score = q.score(&title, &format!("{at} {}", c.body))?;
            let status = c.status.name();
            let r = Ref::Comment { id: c.id };
            Some(hit(
                &r,
                "comment",
                title,
                Some(format!("{status} · {at}")),
                score,
            ))
        })
        .collect()
}

pub(super) fn anchor_label(anchor: &crate::comments::Anchor) -> String {
    use crate::comments::Anchor;
    match anchor {
        Anchor::Node { path } => format!("node {path}"),
        Anchor::Mesh { part, material, .. } => format!("mesh {part} ({material})"),
        Anchor::Scene { scene, time, .. } => format!("{scene} at {time:.1}s"),
        Anchor::Take { take, n, .. } => format!("take {take} note {n}"),
    }
}

/// Canvases by title or id, and frames by what the Canvas app's own frame
/// search finds. Comments on canvases are [`canvas_comment_hits`]. A
/// canvas whose file is outside the project once links are followed is not
/// listed, nor are its frames, as resolving it would be refused.
fn canvases(app: &AppHandle, ctx: &CallContext, actor: Actor, root: &Path, q: &Query) -> Vec<Hit> {
    let call = |method: &str, mut params: Value| {
        params["actor"] = json!(actor.name());
        crate::apps::call(app, ctx, "canvas", method, Some(params)).unwrap_or_default()
    };
    let inside = |id: &str| live::canvas_inside(root, id, None).is_ok();
    let mut hits = Vec::new();
    if q.wants("canvas") {
        hits.extend(canvas_hits(&call("canvas/frames", json!({})), q, &inside));
    }
    if q.wants("frame") && !q.words.is_empty() {
        let asked = json!({ "query": q.words.join(" "), "limit": q.limit });
        hits.extend(frame_hits(&call("canvas/search-frames", asked), q, &inside));
    } else if q.asks_for("frame") {
        // Frames named as the only kind with nothing typed: list them, so a
        // person can browse what is on a canvas instead of having to guess a name.
        let listed = call("canvas/frames", json!({}));
        let as_matches = json!({ "matches": listed["frames"] });
        hits.extend(frame_hits(&as_matches, q, &inside));
    }
    hits
}

/// Canvases from a `canvas/frames` answer's `canvases`, those `inside` allows.
fn canvas_hits(listed: &Value, q: &Query, inside: &dyn Fn(&str) -> bool) -> Vec<Hit> {
    let rows = listed["canvases"].as_array().into_iter().flatten();
    rows.filter_map(|c| {
        let id = c["id"].as_str().filter(|id| inside(id))?;
        let title = c["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(id);
        let score = q.score(title, id)?;
        let r = Ref::Canvas {
            id: id.into(),
            part: None,
        };
        Some(hit(
            &r,
            "canvas",
            title.into(),
            Some(format!("canvas {id}")),
            score,
        ))
    })
    .collect()
}

/// Frames from a `canvas/search-frames` answer's `matches`, on canvases
/// `inside` allows. One matched on a property rather than its name ranks
/// below every name or path match.
fn frame_hits(found: &Value, q: &Query, inside: &dyn Fn(&str) -> bool) -> Vec<Hit> {
    let rows = found["matches"].as_array().into_iter().flatten();
    rows.filter_map(|f| {
        let canvas = f["canvas"].as_str().filter(|c| inside(c))?;
        let id = f["id"].as_str()?;
        let name = f["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id);
        let score = q.score(name, name).unwrap_or(0);
        let r = Ref::Canvas {
            id: canvas.into(),
            part: Some(CanvasPart::Frame(id.into())),
        };
        let what = f["typeName"].as_str().unwrap_or("frame");
        let detail = format!("{what} on canvas {canvas}");
        Some(hit(&r, "frame", name.into(), Some(detail), score))
    })
    .collect()
}

/// Comments left on canvases, from the rows the comment listing makes of
/// `canvas/list-comments`, by what they say and where they are pinned. An
/// empty query lists them all: a canvas holds few, and each asks for work.
/// Neither `comment` nor `design-comment` ever reached these, so the
/// @-menu's Design comments listed nothing while a canvas held open ones.
fn canvas_comment_hits(rows: &[Value], q: &Query) -> Vec<Hit> {
    rows.iter()
        .filter_map(|c| {
            let r = super::uri::parse(c["uri"].as_str()?).ok()?;
            let (text, at) = (c["text"].as_str()?, c["where"].as_str().unwrap_or(""));
            let score = q.score(text, &format!("{at} {text}"))?;
            let status = c["status"].as_str().unwrap_or("open");
            let detail = format!("{status} · {at}");
            Some(hit(&r, "canvas-comment", text.into(), Some(detail), score))
        })
        .collect()
}

#[cfg(feature = "design-mode")]
fn design_comments(app: &AppHandle, q: &Query) -> Vec<Hit> {
    use tauri::Manager;
    if !q.wants("design-comment") {
        return Vec::new();
    }
    let all = app.state::<crate::design_comments::Comments>().all();
    all.into_iter()
        .filter_map(|c| {
            let title = first_line(&c.request);
            let score = q.score(&title, &format!("{} {}", c.page.title, c.request))?;
            let detail = format!("Design Mode · {}", c.page.title);
            let r = Ref::DesignComment { id: c.id };
            Some(hit(&r, "design-comment", title, Some(detail), score))
        })
        .collect()
}

#[cfg(not(feature = "design-mode"))]
fn design_comments(_app: &AppHandle, _q: &Query) -> Vec<Hit> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn q(text: &str) -> Query {
        Query::new(text, None, None).unwrap()
    }

    #[test]
    fn frames_are_listed_only_when_asked_for_by_name() {
        let everything = Query::new("", None, None).unwrap();
        assert!(everything.wants("frame") && !everything.asks_for("frame"));
        let frames = Query::new("", Some(vec!["frame".into()]), None).unwrap();
        assert!(frames.asks_for("frame"));
    }

    #[test]
    fn a_kind_outside_the_list_is_refused_and_the_limit_is_clamped() {
        let err = Query::new("x", Some(vec!["files".into()]), None).unwrap_err();
        assert!(err.contains("`files` is not a kind"), "{err}");
        assert_eq!(Query::new("x", None, Some(500)).unwrap().limit, MAX_LIMIT);
        assert_eq!(Query::new("x", None, Some(0)).unwrap().limit, 1);
        assert_eq!(q("x").limit, DEFAULT_LIMIT);
        let err = Query::new("x", Some(Vec::new()), None).unwrap_err();
        assert!(err.contains("`kinds` is empty"), "{err}");
    }

    #[test]
    fn a_query_is_a_name_not_a_pasted_page() {
        assert!(Query::new(&"a".repeat(MAX_QUERY_CHARS), None, None).is_ok());
        assert!(Query::new(&"a".repeat(MAX_QUERY_CHARS + 1), None, None).is_err());
        let many = vec!["w"; MAX_QUERY_WORDS + 1].join(" ");
        assert!(Query::new(&many, None, None).is_err());
    }

    #[test]
    fn an_exact_name_beats_a_prefix_beats_a_part_beats_the_path() {
        let q = q("player");
        let exact = q.score("player", "a/player").unwrap();
        let prefix = q.score("player.gd", "a/player.gd").unwrap();
        let inside = q.score("the_player.gd", "a/the_player.gd").unwrap();
        let path = q.score("main.gd", "player/main.gd").unwrap();
        assert!(exact > prefix && prefix > inside && inside > path);
        assert_eq!(q.score("main.gd", "src/main.gd"), None);
    }

    #[test]
    fn every_word_has_to_match_somewhere() {
        let q = q("Hero SHEET");
        assert!(q.score("hero_sheet.png", "art/hero_sheet.png").is_some());
        assert!(q.score("sheet.png", "hero/sheet.png").is_some());
        assert_eq!(q.score("hero.png", "art/hero.png"), None);
    }

    #[test]
    fn hits_rank_best_first_up_to_the_limit() {
        let mk = |t: &str, s| hit(&Ref::Selection, "file", t.into(), None, s);
        let out = rank(vec![mk("b", 1), mk("c", 3), mk("a", 3)], 2);
        let titles: Vec<_> = out.iter().map(|h| h.title.as_str()).collect();
        assert_eq!(titles, ["a", "c"]);
    }

    #[test]
    fn a_file_whose_first_bytes_hold_a_key_is_never_listed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n";
        fs::write(root.join("notes/deploy.txt"), key).unwrap();
        fs::write(
            root.join("notes/deploy_steps.txt"),
            "ssh in, pull, restart\n",
        )
        .unwrap();
        let out = rank(files(root, &q("deploy")), 1);
        let uris: Vec<_> = out.iter().map(|h| h.uri.as_str()).collect();
        assert_eq!(
            uris,
            ["veistra://file/notes/deploy_steps.txt"],
            "the key is left out and does not use up the limit"
        );
    }

    #[test]
    fn files_are_found_by_name_but_never_secrets_ignored_or_hidden_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("scripts/config")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        for f in [
            "scripts/config/config.gd",
            "build/config.gd",
            "config.env",
            "config.pem",
            ".config",
        ] {
            fs::write(root.join(f), "x").unwrap();
        }
        fs::write(root.join(".gitignore"), "build/\n").unwrap();

        let uris: Vec<String> = files(root, &q("config"))
            .into_iter()
            .map(|h| h.uri)
            .collect();
        assert!(uris.contains(&"veistra://file/scripts/config/config.gd".to_string()));
        assert!(uris.contains(&"veistra://file/scripts/config".to_string()));
        for absent in ["build/config.gd", "config.env", "config.pem", ".config"] {
            assert!(
                !uris.iter().any(|u| u.ends_with(absent)),
                "{absent}: {uris:?}"
            );
        }
        assert!(files(root, &q("")).is_empty());
        let only = Query::new("config", Some(vec!["folder".into()]), None).unwrap();
        let kinds: Vec<_> = files(root, &only).into_iter().map(|h| h.kind).collect();
        assert_eq!(kinds, ["folder"]);
    }

    #[test]
    fn canvases_and_frames_come_from_the_canvas_apps_answers() {
        let listed = json!({ "canvases": [
            { "id": "levels/hospital", "title": "Hospital" },
            { "id": "world", "title": "" },
        ]});
        let all = |_: &str| true;
        let hits = canvas_hits(&listed, &q("hosp"), &all);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].uri, "veistra://canvas/levels/hospital");
        assert_eq!(canvas_hits(&listed, &q("world"), &all)[0].title, "world");

        let found = json!({ "matches": [
            { "canvas": "world", "id": "f_1", "name": "Main Menu", "typeName": "Screen" },
            { "canvas": "world", "id": "f_2", "name": null },
        ]});
        let hits = frame_hits(&found, &q("menu"), &all);
        assert_eq!(hits[0].uri, "veistra://canvas/world#frame=f_1");
        assert_eq!(hits[0].detail.as_deref(), Some("Screen on canvas world"));
        assert_eq!(hits[1].title, "f_2");
        assert_eq!(
            hits[1].score, 0,
            "a property match ranks below any path match"
        );
        assert!(q("menu").score("main.gd", "menu/main.gd") > Some(0));
    }

    #[test]
    fn canvas_comments_are_their_own_kind_listed_with_nothing_typed() {
        assert!(Query::new("", Some(vec!["canvas-comment".into()]), None).is_ok());
        let design = Query::new("", Some(vec!["design-comment".into()]), None).unwrap();
        assert!(
            !design.wants("canvas-comment"),
            "a Design Mode search does not reach canvases"
        );
        let rows = [
            json!({ "uri": "veistra://canvas/hammer#comment=c-1", "status": "open",
                    "text": "Opinion on this?", "where": "canvas hammer, frame f_1" }),
            json!({ "uri": "veistra://canvas/hammer#comment=c-2", "status": "open",
                    "text": "What the fahh is this?", "where": "canvas hammer, frame f_2" }),
            json!({ "uri": "not a reference", "text": "dropped" }),
        ];
        let all = canvas_comment_hits(&rows, &q(""));
        let uris: Vec<_> = all.iter().map(|h| h.uri.as_str()).collect();
        assert_eq!(
            uris,
            [
                "veistra://canvas/hammer#comment=c-1",
                "veistra://canvas/hammer#comment=c-2"
            ]
        );
        assert_eq!(all[0].kind, "canvas-comment");
        assert_eq!(
            all[0].detail.as_deref(),
            Some("open · canvas hammer, frame f_1")
        );
        let typed = canvas_comment_hits(&rows, &q("opinion"));
        assert_eq!(typed.len(), 1);
        assert_eq!(typed[0].title, "Opinion on this?");
        assert_eq!(canvas_comment_hits(&rows, &q("hammer")).len(), 2);
    }

    #[test]
    fn a_context_copy_of_a_secret_is_not_listed_whatever_it_is_titled() {
        // Stored past ingest's own screen, as a store written before it would
        // hold them: a clean copy under a secret's key, and one whose stored
        // bytes were swapped for a private key afterwards.
        let (dir, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        // Each from its own file: copies of one file share what is stored.
        let copy = |key: &str, name: &str| {
            let from = outside.path().join(name);
            fs::write(&from, format!("{name}\n")).unwrap();
            let asked = crate::context::PutRequest {
                key: Some(key.into()),
                kind: None,
                title: Some("Build notes".into()),
                payload: crate::context::Payload::Path(from),
                app_id: "terminal".into(),
                label: None,
                method: crate::context::Method::Drop,
                reference_in_place: true,
            };
            crate::context::put(dir.path(), asked).unwrap()
        };
        copy("file/prod.env", "a.txt");
        let by_content = copy("notes/handoff", "b.txt");
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n";
        fs::write(&by_content.path, key).unwrap();
        let fine = copy("notes/build", "c.txt");
        let out = rank(context_items(dir.path(), &q("build")), 10);
        let uris: Vec<_> = out.iter().map(|h| h.uri.clone()).collect();
        assert_eq!(uris, [format!("veistra://context/{}", fine.id)]);
    }

    #[test]
    fn a_canvas_outside_the_project_is_not_listed_nor_are_its_frames() {
        let not_world = |id: &str| id != "world";
        let listed = json!({ "canvases": [{ "id": "world", "title": "World" }] });
        assert!(canvas_hits(&listed, &q("world"), &not_world).is_empty());
        let found = json!({ "matches": [{ "canvas": "world", "id": "f_1", "name": "World" }] });
        assert!(frame_hits(&found, &q("world"), &not_world).is_empty());
    }

    #[test]
    fn the_selection_is_one_hit_when_its_name_is_asked_for() {
        assert_eq!(selection(&q("sel")).unwrap().uri, "veistra://selection");
        assert!(selection(&q("door")).is_none());
        let other = Query::new("sel", Some(vec!["file".into()]), None).unwrap();
        assert!(selection(&other).is_none());
    }
}
