//! Review comments — what a person wrote on a line of a diff, so an agent can read it back.
//!
//! A comment is a note anchored to a line range of one file, in one of the three diffs the
//! source-control surfaces draw: the unstaged view, the staged view, or a worktree's divergence
//! from where it forked. `.veistra/` inside the checkout is where they live, and [`store`] is the
//! whole of that.
//!
//! It carries **no author and no thread**. There are exactly two parties — the person at the
//! keyboard and whatever agent they hand the note to — so a name on every note would say the same
//! thing every time, and a reply from the agent arrives as a new diff rather than as a message.
//! That is the one place this departs from the review-host shape it is modelled on, and it is
//! deliberate rather than unfinished.
//!
//! [`ReviewComment`] is modelled on `src/shared/diff-comment-types.ts` in `stablyai/orca`, which is
//! MIT-licensed, © Stably AI — the line anchoring and what each timestamp means are that file's.
//! `NOTICE` carries the attribution in full.
//!
//! The argument for anchoring to line numbers, and for what happens when the file moves underneath
//! one, is in `docs/design-notes/backend-core.md`.

mod store;

pub use store::{load, save};

use crate::error::{AppError, Result};
use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// Serializes the read-modify-write in [`edit`].
///
/// One lock for the whole process rather than one per checkout. Veistra is single-instance but not
/// single-*window*, so two windows can have the same project open and two commands can land on the
/// same file at once — and the loser of that race would silently drop whichever note the winner
/// had just added. A map keyed by path would be the precise answer; a single lock is the same
/// answer for the load this sees, which is one file write per sentence a person types.
///
/// It guards the file, not a value, so there is nothing inside it.
static WRITING: Mutex<()> = Mutex::new(());

/// Which of the three diffs a comment was written against.
///
/// Part of a comment's identity rather than a filter applied afterwards: the same path at the same
/// line is different code in the staged view than in the unstaged one, so a note written against
/// one must not surface against the other.
///
/// Serialized lowercase, so it lands in TypeScript as `"unstaged" | "staged" | "branch"` rather
/// than as capitalized Rust variant names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewScope {
    /// The working tree against the index — the `Changes` list.
    Unstaged,
    /// The index against `HEAD` — the `Staged Changes` list.
    Staged,
    /// Everything this cluster's worktree has changed since it forked. The agent-produced diff,
    /// and the reason this scope exists at all.
    Branch,
}

/// One note, as it is stored and as the frontend sees it.
///
/// Line numbers are 1-based and inclusive at both ends, and both name the **modified** side of the
/// diff — the side being reviewed. A single-line note has `start_line == end_line` rather than an
/// absent end, so no consumer has to special-case the common shape.
///
/// There is deliberately no `side` field. A note on the original side would be about code that is
/// already gone, which is something to put in a commit message rather than to hand an agent as
/// work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    /// Repo-relative, forward slashes — the same string `git status` produced and the same one
    /// [`crate::git`] takes back, so a note and a diff always name a file the same way.
    pub path: String,
    pub scope: ReviewScope,
    pub start_line: u32,
    pub end_line: u32,
    pub body: String,
    /// Milliseconds since the Unix epoch, matching every other timestamp the orchestrator writes.
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    /// When this note was last handed to an agent. Editing the body clears it: the agent was given
    /// different words, so it has not seen these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<u64>,
    /// The person's own mark that a note is dealt with. Nothing sets it automatically — handing a
    /// note to an agent is not evidence the agent did anything about it.
    #[serde(default)]
    pub resolved: bool,
}

/// A note before it has an id or a clock reading: everything the caller actually chose.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDraft {
    pub path: String,
    pub scope: ReviewScope,
    pub start_line: u32,
    pub end_line: u32,
    pub body: String,
}

/// Add a note, validated.
///
/// Hands back the stored comment rather than nothing, so the caller renders what was actually
/// written rather than a hopeful local copy of it.
pub fn add(
    comments: &mut Vec<ReviewComment>,
    draft: ReviewDraft,
    now: u64,
) -> Result<ReviewComment> {
    let body = draft.body.trim().to_string();
    if body.is_empty() {
        return Err(empty_body());
    }
    if draft.start_line == 0 || draft.end_line < draft.start_line {
        return Err(AppError::Review(format!(
            "lines {}-{} are not a range in a file: line numbers start at 1, and the end cannot come before the start",
            draft.start_line, draft.end_line
        )));
    }

    let comment = ReviewComment {
        id: mint_id(&draft.path, draft.start_line),
        path: draft.path,
        scope: draft.scope,
        start_line: draft.start_line,
        end_line: draft.end_line,
        body,
        created_at: now,
        updated_at: None,
        sent_at: None,
        resolved: false,
    };

    comments.push(comment.clone());
    sort(comments);
    Ok(comment)
}

/// Rewrite a note's body.
///
/// Clears `sent_at` for the reason given on that field, and does so even when the new body is
/// identical to the old one: a caller that submits an unchanged edit has still asked for this note
/// to count as unsent, and deciding otherwise would make the outcome depend on invisible string
/// equality.
pub fn update(
    comments: &mut [ReviewComment],
    id: &str,
    body: &str,
    now: u64,
) -> Result<ReviewComment> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(empty_body());
    }

    let comment = find_mut(comments, id)?;
    comment.body = trimmed.to_string();
    comment.updated_at = Some(now);
    comment.sent_at = None;
    Ok(comment.clone())
}

/// Mark a note dealt with, or put it back.
pub fn set_resolved(
    comments: &mut [ReviewComment],
    id: &str,
    resolved: bool,
    now: u64,
) -> Result<ReviewComment> {
    let comment = find_mut(comments, id)?;
    comment.resolved = resolved;
    comment.updated_at = Some(now);
    Ok(comment.clone())
}

/// Drop a note. An unknown id is an error rather than a silent success: the caller drew a button
/// from a list, and a list that disagrees with the file is worth saying out loud.
pub fn remove(comments: &mut Vec<ReviewComment>, id: &str) -> Result<()> {
    let before = comments.len();
    comments.retain(|c| c.id != id);
    if comments.len() == before {
        return Err(unknown(id));
    }
    Ok(())
}

/// Stamp notes as handed to an agent, and say how many were.
///
/// Ids naming nothing are skipped rather than fatal, and this is the one mutation here that
/// forgives one. It runs *after* the text has already reached the terminal or the clipboard, so
/// failing would report a send that did happen as one that did not.
pub fn mark_sent(comments: &mut [ReviewComment], ids: &[String], now: u64) -> usize {
    let mut stamped = 0;
    for comment in comments.iter_mut() {
        if ids.iter().any(|id| id == &comment.id) {
            comment.sent_at = Some(now);
            stamped += 1;
        }
    }
    stamped
}

/// File, then position in it, then age. Applied on every mutation so the stored document is
/// stable: `.veistra/` sits inside the checkout, and a file that reshuffles itself on every write is
/// a file nobody can keep in version control.
pub fn sort(comments: &mut [ReviewComment]) {
    comments.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
}

/// The repository root a cluster's notes belong to.
///
/// `None` when the cluster has no project open, or has one that is not a repository. Both are
/// ordinary states rather than failures — the same two `git_cluster_status` answers `None` for —
/// so reading notes for such a cluster is an empty list and not an error.
///
/// The *repository* root, not the cluster's working root, and the difference is the one
/// `git::cluster_checkout` documents: `git status` reports repo-relative paths whatever directory
/// it ran in, and those are the paths that end up inside a note. Resolving anywhere else would
/// file notes against a base their paths were never measured from.
pub fn checkout(app: &AppHandle, cluster_id: &str) -> Option<PathBuf> {
    let working = crate::project::cluster_path(app, cluster_id)?;
    crate::git::repo_root(&working)
}

/// Load a cluster's notes, change them, and write them back — the shape of every mutation here.
///
/// Read-modify-write under [`WRITING`] rather than an in-memory cache flushed later. The file is
/// small, a person writes one note at a time, and a cache would need an owner, an invalidation
/// rule for the other window, and somewhere to flush from on quit. Re-reading costs a few
/// microseconds and removes all three.
///
/// The change runs before the save, so a refused mutation — an unknown id, an empty body — leaves
/// the file untouched.
pub fn edit<T>(
    app: &AppHandle,
    cluster_id: &str,
    change: impl FnOnce(&mut Vec<ReviewComment>) -> Result<T>,
) -> Result<T> {
    // Every note mutation goes through here, and the notes live in the checkout's
    // own `.veistra/`, so a read-only environment is refused once for all five
    // commands. Main is not one.
    crate::environments::guard_cluster_write(app, cluster_id, "review comment")?;
    let root = checkout(app, cluster_id).ok_or_else(|| {
        AppError::Review(
            "This cluster has no project open, or its project is not a git repository.".to_string(),
        )
    })?;

    let _guard = WRITING.lock_or_panic();

    let mut comments = load(&root);
    let outcome = change(&mut comments)?;
    sort(&mut comments);
    save(&root, &comments)?;
    Ok(outcome)
}

fn find_mut<'a>(comments: &'a mut [ReviewComment], id: &str) -> Result<&'a mut ReviewComment> {
    comments
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| unknown(id))
}

fn empty_body() -> AppError {
    AppError::Review("A review comment needs something written in it.".to_string())
}

fn unknown(id: &str) -> AppError {
    AppError::Review(format!(
        "no review comment with id `{id}` — it may have been removed in another window"
    ))
}

/// Milliseconds since the Unix epoch. `0` if the clock is set before 1970, which is not a state
/// worth refusing to save a comment over.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A note's id: the write time in nanoseconds, then a hash of that, the path and the line.
///
/// The same trade `project::marker` makes for project ids — a dependency for one value is a poor
/// deal, and a collision would have to be minted in the same nanosecond against the same line of
/// the same file. The leading timestamp sorts chronologically, which costs nothing.
fn mint_id(path: &str, line: u32) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    line.hash(&mut hasher);
    nanos.hash(&mut hasher);

    format!("{nanos:016x}{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `edit` needs an app handle, which a unit test cannot build, so the two
    /// facts that make the read-only guard hold here are checked in the source: the
    /// guard runs before the checkout is resolved, and every note-writing
    /// command reaches the store through `edit` and nothing else.
    #[test]
    fn review_writes_are_guarded_at_the_single_entry_point() {
        let source = include_str!("mod.rs");
        let edit = &source[source.find("pub fn edit<T>(").unwrap()..];
        let guard = edit.find("guard_cluster_write(").expect("edit guards");
        assert!(guard < edit.find("checkout(app").unwrap());

        let commands = include_str!("../commands.rs");
        for name in [
            "review_comment_add",
            "review_comment_update",
            "review_comment_resolve",
            "review_comment_remove",
            "review_comments_mark_sent",
        ] {
            let body = &commands[commands.find(&format!("pub fn {name}(")).unwrap()..];
            let body = &body[..body.find("#[tauri::command]").unwrap_or(body.len())];
            assert!(body.contains("review::edit("), "{name} bypasses edit");
        }
    }

    /// Main used to refuse review notes; it takes them like a worktree now.
    #[test]
    fn a_review_write_is_allowed_on_main_and_elsewhere() {
        use crate::environments::{refuse_read_only_write, Environment};
        assert!(refuse_read_only_write(Some(&Environment::Main), "review comment").is_ok());
        assert!(refuse_read_only_write(None, "review comment").is_ok());
    }

    fn draft(path: &str, start: u32, end: u32, body: &str) -> ReviewDraft {
        ReviewDraft {
            path: path.to_string(),
            scope: ReviewScope::Unstaged,
            start_line: start,
            end_line: end,
            body: body.to_string(),
        }
    }

    fn added(comments: &mut Vec<ReviewComment>, path: &str, line: u32, body: &str) -> String {
        add(comments, draft(path, line, line, body), 1)
            .expect("a valid draft")
            .id
    }

    #[test]
    fn a_draft_becomes_a_note_with_an_id_and_a_clock_reading() {
        let mut comments = Vec::new();
        let stored = add(
            &mut comments,
            draft("src/a.rs", 3, 5, "  tighten this  "),
            42,
        )
        .expect("a valid draft");

        assert!(!stored.id.is_empty());
        assert_eq!(stored.body, "tighten this", "the body is trimmed");
        assert_eq!(stored.created_at, 42);
        assert_eq!(stored.sent_at, None);
        assert!(!stored.resolved);
        assert_eq!(comments.len(), 1);
    }

    #[test]
    fn an_empty_body_is_refused() {
        let mut comments = Vec::new();
        assert!(add(&mut comments, draft("a", 1, 1, "   \n  "), 0).is_err());
        assert!(comments.is_empty(), "a refused add stores nothing");
    }

    #[test]
    fn a_range_that_is_not_one_is_refused() {
        let mut comments = Vec::new();
        assert!(
            add(&mut comments, draft("a", 0, 0, "x"), 0).is_err(),
            "line numbers start at 1"
        );
        assert!(
            add(&mut comments, draft("a", 9, 4, "x"), 0).is_err(),
            "the end cannot come before the start"
        );
    }

    #[test]
    fn two_notes_minted_for_the_same_line_do_not_share_an_id() {
        let mut comments = Vec::new();
        let first = added(&mut comments, "src/a.rs", 7, "one");
        let second = added(&mut comments, "src/a.rs", 7, "two");
        assert_ne!(first, second);
    }

    #[test]
    fn editing_a_body_clears_the_sent_stamp() {
        let mut comments = Vec::new();
        let id = added(&mut comments, "src/a.rs", 1, "first");
        mark_sent(&mut comments, std::slice::from_ref(&id), 10);
        assert_eq!(comments[0].sent_at, Some(10));

        let edited = update(&mut comments, &id, "second", 20).expect("a known id");

        assert_eq!(edited.body, "second");
        assert_eq!(edited.updated_at, Some(20));
        assert_eq!(edited.sent_at, None, "the agent has not seen these words");
    }

    /// The invisible-string-equality case called out on [`update`].
    #[test]
    fn re_submitting_the_same_body_still_clears_the_sent_stamp() {
        let mut comments = Vec::new();
        let id = added(&mut comments, "src/a.rs", 1, "same");
        mark_sent(&mut comments, std::slice::from_ref(&id), 10);

        update(&mut comments, &id, "same", 20).expect("a known id");

        assert_eq!(comments[0].sent_at, None);
    }

    #[test]
    fn an_empty_edit_is_refused_and_leaves_the_note_alone() {
        let mut comments = Vec::new();
        let id = added(&mut comments, "src/a.rs", 1, "kept");

        assert!(update(&mut comments, &id, "  ", 20).is_err());
        assert_eq!(comments[0].body, "kept");
    }

    #[test]
    fn resolving_is_the_persons_mark_and_sending_does_not_set_it() {
        let mut comments = Vec::new();
        let id = added(&mut comments, "src/a.rs", 1, "note");

        mark_sent(&mut comments, std::slice::from_ref(&id), 10);
        assert!(!comments[0].resolved, "sending is not resolving");

        set_resolved(&mut comments, &id, true, 20).expect("a known id");
        assert!(comments[0].resolved);

        set_resolved(&mut comments, &id, false, 30).expect("a known id");
        assert!(!comments[0].resolved, "and it can be put back");
    }

    #[test]
    fn removing_takes_only_that_note() {
        let mut comments = Vec::new();
        let first = added(&mut comments, "src/a.rs", 1, "one");
        added(&mut comments, "src/a.rs", 2, "two");

        remove(&mut comments, &first).expect("a known id");

        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].body, "two");
    }

    #[test]
    fn an_unknown_id_is_an_error_for_every_mutation_that_names_one() {
        let mut comments = Vec::new();
        added(&mut comments, "src/a.rs", 1, "one");

        assert!(update(&mut comments, "nope", "x", 0).is_err());
        assert!(set_resolved(&mut comments, "nope", true, 0).is_err());
        assert!(remove(&mut comments, "nope").is_err());
    }

    /// [`mark_sent`] is the one mutation that forgives an unknown id — see its doc comment.
    #[test]
    fn marking_an_unknown_id_as_sent_is_not_an_error() {
        let mut comments = Vec::new();
        let id = added(&mut comments, "src/a.rs", 1, "one");

        let stamped = mark_sent(&mut comments, &[id, "gone".to_string()], 10);

        assert_eq!(stamped, 1, "only the note that exists is stamped");
        assert_eq!(comments[0].sent_at, Some(10));
    }

    #[test]
    fn storage_order_is_file_then_line_then_age() {
        let mut comments = Vec::new();
        add(&mut comments, draft("src/b.rs", 1, 1, "b1"), 1).expect("valid");
        add(&mut comments, draft("src/a.rs", 9, 9, "a9"), 2).expect("valid");
        add(&mut comments, draft("src/a.rs", 2, 2, "a2"), 3).expect("valid");

        let order: Vec<&str> = comments.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(order, vec!["a2", "a9", "b1"]);
    }
}
