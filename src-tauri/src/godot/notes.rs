//! Play notes for agents: the comments Send files with a `take` anchor, read
//! and moved through the fix loop by the workspace MCP server's
//! `list_play_notes`, `start_play_note` and `resolve_play_note` (design §9.3).
//!
//! Kept apart from the server so the rules are tested without a running app:
//! which notes an agent is shown, that it can only start an open note, and
//! that its resolve marks a note fixed for the person to check rather than
//! closing it (see `comments::Status`).

use super::feedback::clock;
use crate::apps::CallContext;
use crate::comments::{self, Anchor, Author, Comment, Status};
use serde_json::{json, Value};

/// Longest summary `resolve_play_note` keeps, in characters.
pub const MAX_SUMMARY: usize = 4_000;

/// Which notes a listing wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wanted {
    /// Open or being worked on: the agent's work.
    Open,
    /// Fixed, waiting for the person.
    Fixed,
    All,
}

impl Wanted {
    pub fn parse(word: Option<&str>) -> Result<Self, String> {
        match word.unwrap_or("open") {
            "open" => Ok(Wanted::Open),
            "fixed" => Ok(Wanted::Fixed),
            "all" => Ok(Wanted::All),
            other => Err(format!("`{other}` is not a status; use open, fixed or all")),
        }
    }

    fn takes(self, status: Status) -> bool {
        match self {
            Wanted::Open => status.is_active(),
            Wanted::Fixed => status == Status::Fixed,
            Wanted::All => true,
        }
    }
}

fn when(at_ms: u64, in_ms: Option<u64>, out_ms: Option<u64>) -> String {
    match (in_ms, out_ms) {
        (Some(i), Some(o)) if o > i => format!("{} → {}", clock(i), clock(o)),
        _ => clock(at_ms),
    }
}

/// One note for an agent. `packet` and `packetMd` are the newest take's: a
/// Still broken take's packet lists the earlier ones, and `takes` has them
/// all, oldest first.
fn row(ctx: &CallContext, c: &Comment) -> Option<Value> {
    let Anchor::Take {
        take,
        n,
        at_ms,
        in_ms,
        out_ms,
        scene,
        node_path,
        ..
    } = &c.anchor
    else {
        return None;
    };
    let history = c.takes();
    let newest = history.last()?;
    let packet_md = ctx.project.as_ref().map(|root| {
        root.join(&newest.packet)
            .join("packet.md")
            .display()
            .to_string()
    });
    let takes: Vec<Value> = history
        .iter()
        .map(|t| {
            json!({
                "take": t.take,
                "number": t.number,
                "n": t.n,
                "when": when(t.at_ms, t.in_ms, t.out_ms),
                "packet": t.packet,
            })
        })
        .collect();
    Some(json!({
        "id": c.id,
        "cluster": ctx.cluster_id,
        "n": n,
        "take": take,
        "status": c.status,
        "body": c.body,
        "when": when(*at_ms, *in_ms, *out_ms),
        "scene": scene,
        "nodePath": node_path,
        "packet": newest.packet,
        "packetMd": packet_md,
        "takes": takes,
        "fix": c.resolution,
        "replies": c.replies,
    }))
}

/// The environment's play notes, oldest first.
pub fn list(ctx: &CallContext, wanted: Wanted) -> Result<Value, String> {
    let all = comments::list(ctx).map_err(|e| e.message)?;
    let rows: Vec<Value> = all
        .iter()
        .filter(|c| wanted.takes(c.status))
        .filter_map(|c| row(ctx, c))
        .collect();
    Ok(json!({
        "total": rows.len(),
        "notes": rows,
        "covers": "Notes the person wrote on recorded Play takes in this environment. Read each \
                   note's packet.md first; a note with replies was tried before and is still \
                   broken, and one with more than one take has a newer recording of it. An \
                   empty list means no note is waiting, not that the game is fine.",
    }))
}

fn take_note(ctx: &CallContext, id: &str) -> Result<Comment, String> {
    let c = comments::get(ctx, id).map_err(|e| e.message)?;
    if !matches!(c.anchor, Anchor::Take { .. }) {
        return Err(format!(
            "`{id}` is not a play note; `list_play_notes` has the ones to work on"
        ));
    }
    Ok(c)
}

/// Agent working.
pub fn start(ctx: &CallContext, id: &str) -> Result<Value, String> {
    take_note(ctx, id)?;
    let c = comments::start(ctx, id).map_err(|e| e.message)?;
    Ok(json!({ "id": c.id, "status": c.status }))
}

/// Fixed, check it: the agent's summary and commit, for the person to try.
pub fn resolve(
    ctx: &CallContext,
    id: &str,
    summary: &str,
    commit: Option<&str>,
) -> Result<Value, String> {
    let summary = summary.trim();
    if summary.is_empty() {
        return Err("say what you changed in `summary`".into());
    }
    if summary.chars().count() > MAX_SUMMARY {
        return Err(format!(
            "a summary is at most {MAX_SUMMARY} characters; say what you changed in a sentence or two"
        ));
    }
    let now = take_note(ctx, id)?;
    if !now.status.is_active() {
        return Err(format!(
            "`{id}` is already {}; the person decides what happens next",
            now.status.name()
        ));
    }
    let commit = commit.map(str::trim).filter(|c| !c.is_empty());
    let c = comments::resolve_with_commit(
        ctx,
        id,
        summary.to_string(),
        commit.map(str::to_string),
        Author::Agent,
    )
    .map_err(|e| e.message)?;
    Ok(json!({ "id": c.id, "status": c.status, "summary": summary, "commit": commit }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::Draft;
    use tempfile::TempDir;

    fn note(ctx: &CallContext, n: u32) -> String {
        comments::create(
            ctx,
            Draft {
                anchor: Anchor::Take {
                    take: "2026-10-30-1402-0f3a".into(),
                    number: None,
                    n,
                    at_ms: 102_180,
                    in_ms: Some(98_000),
                    out_ms: Some(106_000),
                    packet: ".veistra/feedback/2026-10-30-1402-0f3a-1".into(),
                    scene: Some("res://levels/hallway.tscn".into()),
                    node_path: Some("Hallway/Enemy_02".into()),
                },
                body: "walks into the wall".into(),
                screenshot_png: None,
            },
        )
        .unwrap()
        .id
    }

    fn ctx(dir: &TempDir) -> CallContext {
        CallContext {
            cluster_id: Some("c1".into()),
            project: Some(dir.path().to_path_buf()),
        }
    }

    #[test]
    fn the_loop_runs_open_working_fixed_and_lists_follow_it() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let id = note(&ctx, 2);
        comments::create(
            &ctx,
            Draft {
                anchor: Anchor::Node {
                    path: "Hallway".into(),
                    scene: None,
                },
                body: "not a play note".into(),
                screenshot_png: None,
            },
        )
        .unwrap();

        let open = list(&ctx, Wanted::Open).unwrap();
        assert_eq!(open["total"], 1, "only play notes are listed");
        assert_eq!(open["notes"][0]["when"], "1:38 → 1:46");
        assert!(open["notes"][0]["packetMd"]
            .as_str()
            .unwrap()
            .ends_with("packet.md"));

        assert_eq!(start(&ctx, &id).unwrap()["status"], "working");
        assert_eq!(
            list(&ctx, Wanted::Open).unwrap()["total"],
            1,
            "working is still open work"
        );

        let done = resolve(&ctx, &id, "Rebaked the nav mesh", Some("3f2a1c9")).unwrap();
        assert_eq!(done["status"], "fixed");
        assert_eq!(list(&ctx, Wanted::Open).unwrap()["total"], 0);
        let fixed = list(&ctx, Wanted::Fixed).unwrap();
        assert_eq!(fixed["notes"][0]["fix"]["commit"], "3f2a1c9");

        let again = resolve(&ctx, &id, "again", None).unwrap_err();
        assert!(again.contains("already fixed"));
        assert!(
            start(&ctx, &id).is_err(),
            "a fixed note is the person's now"
        );
    }

    #[test]
    fn a_resolve_needs_words_and_a_play_note() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let id = note(&ctx, 1);
        assert!(resolve(&ctx, &id, "   ", None).is_err());
        assert!(resolve(&ctx, &id, &"x".repeat(MAX_SUMMARY + 1), None).is_err());
        let other = comments::create(
            &ctx,
            Draft {
                anchor: Anchor::Mesh {
                    part: "p".into(),
                    material: "m".into(),
                    blend: None,
                    version: None,
                },
                body: "b".into(),
                screenshot_png: None,
            },
        )
        .unwrap();
        assert!(resolve(&ctx, &other.id, "done", None)
            .unwrap_err()
            .contains("not a play note"));
        assert!(start(&ctx, "nope").is_err());
        assert_eq!(Wanted::parse(None), Ok(Wanted::Open));
        assert!(Wanted::parse(Some("closed")).is_err());
    }

    /// An agent handed a Still broken note reads the newest take's packet,
    /// which lists the earlier one, and sees both takes in `takes`.
    #[test]
    fn a_still_broken_note_points_the_agent_at_its_newest_take() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let id = note(&ctx, 2);
        resolve(&ctx, &id, "Rebaked the nav mesh", None).unwrap();
        comments::verdict(&ctx, &id, comments::Verdict::Broken, None).unwrap();
        let five = comments::TakeRef {
            take: "2026-10-30-1440-9b1c".into(),
            number: Some(5),
            packet: ".veistra/feedback/2026-10-30-1440-9b1c-1".into(),
            n: 1,
            at_ms: 12_000,
            in_ms: None,
            out_ms: None,
        };
        comments::add_take(&ctx, &id, five, "Still broken.".into(), None).unwrap();

        let open = list(&ctx, Wanted::Open).unwrap();
        let row = &open["notes"][0];
        assert_eq!(open["total"], 1);
        assert_eq!(row["take"], "2026-10-30-1402-0f3a", "the note it began as");
        assert_eq!(row["packet"], ".veistra/feedback/2026-10-30-1440-9b1c-1");
        assert!(row["packetMd"]
            .as_str()
            .unwrap()
            .contains("2026-10-30-1440-9b1c-1"));
        let takes: Vec<_> = row["takes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| (t["number"].clone(), t["when"].clone()))
            .collect();
        assert_eq!(
            takes,
            vec![
                (json!(null), json!("1:38 → 1:46")),
                (json!(5), json!("0:12"))
            ]
        );
    }
}
