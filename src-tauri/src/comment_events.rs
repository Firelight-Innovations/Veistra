//! What the rest of Veistra hears when a comment changes: a `comments:changed`
//! push to every window, and the two play-note usage events.
//!
//! The comment store calls [`announce`] after every write (`comments::observe`),
//! whoever made it: a viewer's own panel, the person's verdict, Send filing its
//! notes, an agent's `start_play_note` or `resolve_play_note` over MCP. That is
//! why an agent's fix reaches an open pane at all: the agent's call happens in
//! Rust, far from any frame, and before this a pane only learned of it by
//! listing again. Each window's shell relays the event into the app frames of
//! the cluster it names (`src/shell/toolwindow/commentFrames.ts`), and the
//! apps re-list (`apps/shared/commentEvents.ts`).
//!
//! The payload says which comment and which status, never what it says: it
//! is a cue to re-list, read by every frame in those clusters.

use crate::comments::{Anchor, Author, Change, Status};
use crate::shell_state::ShellState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// Mirrored by `COMMENTS_CHANGED_EVENT` in `src/bindings.ts` and
/// `COMMENTS_CHANGED` in `apps/shared/commentEvents.ts`.
pub const CHANGED_EVENT: &str = "comments:changed";

/// The telemetry feature the play-note events belong to
/// (`src/shell/telemetry/features/godot.ts`).
const FEATURE: &str = "godot";

/// Start announcing comment writes. Called once, from `lib.rs`'s setup.
pub fn install(app: &AppHandle) {
    let app = app.clone();
    crate::comments::observe(Box::new(move |change| announce(&app, change)));
}

fn announce(app: &AppHandle, change: &Change) {
    let clusters = clusters_for(app, change);
    if let Err(e) = app.emit(CHANGED_EVENT, payload(change, &clusters)) {
        crate::veistra_log!("could not announce comment {}: {e}", change.comment.id);
    }
    if let Some((event, props)) = usage(change) {
        crate::telemetry::track(app, FEATURE, event, props);
    }
}

/// Every cluster working in the environment the comment was written to.
fn clusters_for(app: &AppHandle, change: &Change) -> Vec<String> {
    let snapshot = app.state::<ShellState>().snapshot();
    let all = snapshot
        .windows
        .iter()
        .flat_map(|w| &w.clusters)
        .map(|c| (c.id.clone(), crate::project::cluster_path(app, &c.id)));
    on_root(
        all,
        change.context.project.as_deref(),
        change.context.cluster_id.as_deref(),
    )
}

/// The clusters whose root is `root`, and always the one the call came from.
/// Two clusters can share a checkout, and a note an agent fixes from one must
/// reach a Play pane open in the other.
fn on_root(
    clusters: impl Iterator<Item = (String, Option<PathBuf>)>,
    root: Option<&Path>,
    own: Option<&str>,
) -> Vec<String> {
    let mut ids: Vec<String> = clusters
        .filter(|(_, path)| root.is_some() && path.as_deref() == root)
        .map(|(id, _)| id)
        .collect();
    if let Some(own) = own.filter(|own| !ids.iter().any(|id| id == own)) {
        ids.push(own.to_string());
    }
    ids
}

/// The `comments:changed` payload.
fn payload(change: &Change, clusters: &[String]) -> Value {
    let take = match &change.comment.anchor {
        Anchor::Take { take, .. } => Some(take.as_str()),
        _ => None,
    };
    json!({
        "clusterId": change.context.cluster_id,
        "clusters": clusters,
        "id": change.comment.id,
        "kind": kind(&change.comment.anchor),
        "take": take,
        "status": change.comment.status,
        "from": change.before,
    })
}

fn kind(anchor: &Anchor) -> &'static str {
    match anchor {
        Anchor::Node { .. } => "node",
        Anchor::Mesh { .. } => "mesh",
        Anchor::Scene { .. } => "scene",
        Anchor::Take { .. } => "take",
    }
}

/// The usage event a write is, if any. Only play notes (take anchors) count.
///
/// - `note_fixed`: an agent reported an open or working note fixed. `attempt`
///   is which fix this is (2 after one Still broken); `commit` whether it
///   named one.
/// - `note_resolved`: the note became resolved. `attempt` counts the agent's
///   fixes, the one just checked included; `checked` is whether the person
///   closed it from Completed (Resolve) rather than outright.
///
/// A new note is `note_created`, which the page reports; Still broken and
/// Agent working are not launch events (spec §13).
fn usage(change: &Change) -> Option<(&'static str, Value)> {
    let comment = change.comment;
    if !matches!(comment.anchor, Anchor::Take { .. }) {
        return None;
    }
    let before = change.before?;
    // The fix on the comment now, or the one a person's own resolve of a fixed
    // note has just written over: only an agent ever leaves a note fixed.
    let unchecked = before == Status::Fixed
        || comment
            .resolution
            .as_ref()
            .is_some_and(|r| r.by == Author::Agent);
    let fixes = comment
        .replies
        .iter()
        .filter(|r| r.by == Author::Agent)
        .count()
        + usize::from(unchecked);
    match comment.status {
        Status::Fixed if before.is_active() => {
            let commit = comment
                .resolution
                .as_ref()
                .is_some_and(|r| r.commit.is_some());
            Some(("note_fixed", json!({ "attempt": fixes, "commit": commit })))
        }
        Status::Resolved if before != Status::Resolved => Some((
            "note_resolved",
            json!({ "attempt": fixes, "checked": before == Status::Fixed }),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::CallContext;
    use crate::comments::{Comment, Reply, Resolution};

    fn ctx() -> CallContext {
        CallContext {
            cluster_id: Some("c1".into()),
            project: Some(PathBuf::from("/work/game")),
        }
    }

    fn note(status: Status) -> Comment {
        Comment {
            id: "0001-ab".into(),
            anchor: Anchor::Take {
                take: "2026-10-30-1402-0f3a".into(),
                number: None,
                n: 2,
                at_ms: 1_000,
                in_ms: None,
                out_ms: None,
                packet: ".veistra/feedback/2026-10-30-1402-0f3a-1".into(),
                scene: Some("res://levels/hallway.tscn".into()),
                node_path: Some("Hallway/Enemy_02".into()),
            },
            author: Author::User,
            body: "walks into the wall".into(),
            status,
            resolution: None,
            replies: Vec::new(),
            sent_to: None,
            created: 1,
            updated: 1,
        }
    }

    fn fix(by: Author, commit: Option<&str>) -> Option<Resolution> {
        Some(Resolution {
            note: "rebaked".into(),
            by,
            at: 2,
            commit: commit.map(str::to_string),
        })
    }

    fn heard(before: Option<Status>, comment: &Comment) -> Option<(&'static str, Value)> {
        usage(&Change {
            context: &ctx(),
            before,
            comment,
        })
    }

    #[test]
    fn an_agent_fixing_an_open_or_working_note_is_note_fixed() {
        let mut c = note(Status::Fixed);
        c.resolution = fix(Author::Agent, Some("3f2a1c9"));
        let expected = Some(("note_fixed", json!({ "attempt": 1, "commit": true })));
        assert_eq!(heard(Some(Status::Working), &c), expected);
        assert_eq!(heard(Some(Status::Open), &c), expected);

        c.resolution = fix(Author::Agent, None);
        c.replies = vec![Reply {
            by: Author::Agent,
            body: "first try".into(),
            at: 1,
            commit: None,
            take: None,
        }];
        assert_eq!(
            heard(Some(Status::Open), &c),
            Some(("note_fixed", json!({ "attempt": 2, "commit": false }))),
            "the second fix, after one Still broken"
        );
    }

    #[test]
    fn a_note_becoming_resolved_is_note_resolved_and_says_whether_it_was_checked() {
        let mut c = note(Status::Resolved);
        c.resolution = fix(Author::Agent, None);
        assert_eq!(
            heard(Some(Status::Fixed), &c),
            Some(("note_resolved", json!({ "attempt": 1, "checked": true })))
        );
        c.resolution = fix(Author::User, None);
        assert_eq!(
            heard(Some(Status::Open), &c),
            Some(("note_resolved", json!({ "attempt": 0, "checked": false })))
        );
        assert_eq!(
            heard(Some(Status::Fixed), &c),
            Some(("note_resolved", json!({ "attempt": 1, "checked": true }))),
            "a person's own note over the agent's fix still counts that fix"
        );
    }

    #[test]
    fn other_writes_and_other_anchors_are_no_usage_event() {
        assert_eq!(heard(None, &note(Status::Open)), None, "a new note");
        assert_eq!(heard(Some(Status::Open), &note(Status::Working)), None);
        assert_eq!(heard(Some(Status::Fixed), &note(Status::Open)), None);
        assert_eq!(heard(Some(Status::Working), &note(Status::Working)), None);
        let mut fixed = note(Status::Fixed);
        fixed.resolution = fix(Author::Agent, None);
        assert_eq!(heard(Some(Status::Fixed), &fixed), None, "no second count");

        let mut node = note(Status::Fixed);
        node.anchor = Anchor::Node {
            path: "Hallway".into(),
            scene: None,
        };
        node.resolution = fix(Author::Agent, None);
        assert_eq!(heard(Some(Status::Open), &node), None, "not a play note");
    }

    #[test]
    fn the_payload_names_the_comment_and_its_move_but_not_its_words() {
        let mut c = note(Status::Fixed);
        c.resolution = fix(Author::Agent, None);
        let sent = payload(
            &Change {
                context: &ctx(),
                before: Some(Status::Working),
                comment: &c,
            },
            &["c1".to_string(), "c3".to_string()],
        );
        assert_eq!(
            sent,
            json!({
                "clusterId": "c1",
                "clusters": ["c1", "c3"],
                "id": "0001-ab",
                "kind": "take",
                "take": "2026-10-30-1402-0f3a",
                "status": "fixed",
                "from": "working",
            })
        );
        assert!(!sent.to_string().contains("walks into the wall"));
    }

    #[test]
    fn every_cluster_on_the_environment_hears_and_the_caller_always_does() {
        let root = PathBuf::from("/work/game");
        let clusters = || {
            vec![
                ("c1".to_string(), Some(root.clone())),
                ("c2".to_string(), Some(PathBuf::from("/work/other"))),
                ("c3".to_string(), Some(root.clone())),
                ("c4".to_string(), None),
            ]
            .into_iter()
        };
        assert_eq!(on_root(clusters(), Some(&root), Some("c1")), ["c1", "c3"]);
        assert_eq!(
            on_root(clusters(), Some(&root), Some("c9")),
            ["c1", "c3", "c9"],
            "a cluster closed since the call still names itself"
        );
        assert_eq!(on_root(clusters(), None, Some("c4")), ["c4"]);
        assert!(on_root(clusters(), None, None).is_empty());
    }

    /// Every name this module sends is one the webview listens for or
    /// declares. A typo on either side fails nowhere at run time: the push
    /// reaches no pane, or the shell refuses the event with a console line.
    #[test]
    fn the_names_sent_are_the_ones_the_webview_knows() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let read = |rel: &str| std::fs::read_to_string(repo.join(rel)).expect(rel);

        let feature = read("src/shell/telemetry/features/godot.ts");
        assert!(feature.contains(&format!("id: \"{FEATURE}\"")));
        for event in ["note_fixed", "note_resolved"] {
            assert!(feature.contains(&format!("\"{event}\",")), "{event}");
        }

        let bindings = read("src/bindings.ts");
        assert!(bindings.contains(&format!("COMMENTS_CHANGED_EVENT = \"{CHANGED_EVENT}\"")));
        assert!(bindings.contains(&format!(
            "BACKEND_USAGE_EVENT = \"{}\"",
            crate::telemetry::BACKEND_EVENT
        )));
        let apps = read("apps/shared/commentEvents.ts");
        assert!(apps.contains(&format!("COMMENTS_CHANGED = \"{CHANGED_EVENT}\"")));
    }
}
