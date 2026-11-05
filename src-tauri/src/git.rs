//! Source control: what `git` says about a cluster's checkout.
//!
//! This shells out to the system `git` binary rather than linking a library (`git2`). A deliberate
//! trade: the user's credential helper, SSH agent, `.gitconfig`, hooks and aliases are all things
//! `git` already knows about and a linked library would have to be taught. The cost is that every
//! answer arrives as text that has to be parsed.
//!
//! Everything here is one-shot request→reply. There is no watcher and no subscription — the panel
//! re-asks after every mutation and when the shown cluster changes. Long-running,
//! progress-reporting operations (push, pull, clone) would want the pty machinery instead; none of
//! them live here.
//!
//! Commands take a cluster *id*, never a path. Resolving the id to a checkout happens on this side,
//! through `project::cluster_path`, so the frontend never gets to name a directory for the backend
//! to run `git` in. They used to take a *tool* id, resolved against the `[[tool]]` pins in
//! `veistra.toml`. That was not merely the wrong scope: `discovery.rs` filters those pins through
//! `ENABLED_TOOLS`, which is `&[]`, so the list is empty for every project and the lookup could
//! only ever fail. See the note on `git_cluster_status` for what that cost.

use crate::error::{AppError, Result};
use crate::shell_state::WorktreeRef;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

/// Which of the six things happened to a path.
///
/// Serialized lowercase so it lands in TypeScript as the string union
/// `"modified" | "added" | ...` rather than as capitalized Rust variant names.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// One path, in one of the two lists.
///
/// `file`/`dir` are the split of `path` rather than something the frontend
/// derives, because the panel draws the directory as its own dimmer column and
/// splitting a path is not work worth doing twice.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// Repo-relative, forward slashes. The identity: what the other commands
    /// take back as an argument.
    pub path: String,
    pub file: String,
    pub dir: String,
    pub kind: GitChangeKind,
    pub staged: bool,
    /// Only ever set when `kind` is `Renamed`. Skipped entirely when absent so
    /// the field is genuinely optional on the TypeScript side rather than
    /// arriving as an explicit `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    /// How many lines this one change adds and removes, on its own side of the
    /// index — `GitStatus`'s totals answer the same question for the whole
    /// checkout at once and are not a sum of these (see the note on those
    /// fields for why the two cannot be derived from each other).
    ///
    /// `None` on both, together, for a change that has no line count to give:
    /// a binary file, an untracked file over [`UNTRACKED_LINE_COUNT_CAP`], or
    /// a conflicted path. Deliberately not `0` — a row showing `+0 −0` claims
    /// a file was staged unchanged, which is a different fact from "this is
    /// not a thing lines can be counted in". Serialized as an explicit `null`
    /// rather than skipped, because absence here is the value the panel draws.
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// Line-change totals since `HEAD` (or, for a repository with no commits
    /// yet, since the empty tree) — what the status bar's compact
    /// `+N -N · M files` readout is built from. See `status_in` for exactly
    /// what is and is not counted; "files touched" is not a third field here
    /// because it is already `staged.len() + unstaged.len()`, deduped by
    /// path since a file can appear in both.
    pub insertions: u32,
    pub deletions: u32,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
}

/// The two sides of a diff, as whole file contents.
///
/// Not a unified patch: the frontend hands these straight to Monaco's diff
/// editor, which computes its own hunks and wants the full text of each side.
#[derive(Debug, Clone, Serialize)]
pub struct GitDiff {
    pub original: String,
    pub modified: String,
}

/// The changed-file lists, the branch, and how far it has drifted from its upstream — for whatever
/// the cluster is working in.
///
/// There is no tool-scoped twin of this any more. A `git_status(id)` taking a *tool* id used to sit
/// beside it, called by the source-control view and the status bar, and it could not work: it
/// resolved through a `repo()` helper that looked its id up in `StackSnapshot.tools` — the
/// `[[tool]]` pins from `veistra.toml` — a different id space from the shell's own apps, and one
/// `discovery.rs`'s `ENABLED_TOOLS = &[]` leaves empty for every project regardless. The lookup
/// could only ever return `UnknownTool`. It read as a scoping subtlety and was a dead path, which
/// is why it is gone rather than fixed: a command that has never returned a value to anyone is not
/// a fallback worth keeping beside one that works.
///
/// A cluster resolves through `cluster_path`, which follows the worktree when the cluster has one
/// and the project folder when it does not — the same precedence the terminals and the file
/// explorer already use, so all three agree about what "here" means.
///
/// `None` for a cluster with no project or one that is not a repository, which is the state the
/// explorer draws by simply not decorating anything.
#[tauri::command]
pub fn git_cluster_status(app: AppHandle, cluster_id: String) -> Result<Option<GitStatus>> {
    let Some(working) = crate::project::cluster_path(&app, &cluster_id) else {
        return Ok(None);
    };

    // The **repository root**, for `cluster_checkout`'s reason: every path in a
    // `GitStatus` is repo-relative, and `status_in` joins some of them against
    // this directory to read a file. A project that is a subdirectory of a
    // larger repository resolved those against the wrong base — silently, since
    // an unreadable untracked file is counted as zero lines rather than as an
    // error. `repo_root` also subsumes the `is_repo` check that used to stand
    // here: it is `None` for exactly the directories that one rejected.
    let Some(root) = repo_root(&working) else {
        return Ok(None);
    };

    status_in(&root).map(Some)
}

/// The body both status commands share, once their id has become a directory.
/// `cwd` is the repository root — see the note in `git_cluster_status`.
fn status_in(cwd: &Path) -> Result<GitStatus> {
    let porcelain = run_git(cwd, "status", &["status", "--porcelain=v1", "-z"])?;
    let (mut staged, mut unstaged) = parse_porcelain(&porcelain);
    attach_line_counts(cwd, &mut staged, &mut unstaged);

    // A repository with no commits yet has no resolvable HEAD, and one with no
    // upstream has nothing to count against. Both are ordinary states of a
    // fresh checkout, so neither failure is allowed to sink the whole status.
    let branch = run_git(cwd, "rev-parse", &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|out| out.trim().to_string())
        .unwrap_or_default();

    let (ahead, behind) = run_git(
        cwd,
        "rev-list",
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    )
    .ok()
    .and_then(|out| parse_ahead_behind(&out))
    .unwrap_or((0, 0));

    let (insertions, deletions) = line_change_counts(cwd, &unstaged);

    Ok(GitStatus {
        branch,
        ahead,
        behind,
        insertions,
        deletions,
        staged,
        unstaged,
    })
}

/// Every path git is ignoring in this checkout, repo-relative, for the file explorer to grey out
/// the way VS Code's does.
///
/// **Deliberately a second `git status` rather than a flag on the one `status_in` runs.**
/// `--ignored` folds these entries into the same list the changes come back in, so every caller of
/// `GitStatus` — the panel, the status bar's counts — would report `node_modules` as work in
/// progress. The explorer is the only surface that wants this, so it is the only one that pays, and
/// it is a real cost: in this repository plain `git status` answers in 53ms and the same call with
/// `--ignored` takes 989ms, because the ignored walk is the walk over `node_modules` and `target`
/// everything else in git avoids. That ratio is why `files.rs` makes this its own RPC, fetched once
/// per project rather than folded into the status refresh, which runs on every tree change.
///
/// `--ignored` bare means `--ignored=traditional`, the cheap *shape* too: a directory with nothing
/// tracked inside comes back as one entry with a trailing slash — `node_modules/` — not every file
/// beneath it. This repo answers with 15 entries instead of tens of thousands, and the frontend
/// greys a subtree per entry. The collapsing is tied to the untracked mode, so it is named here
/// rather than left to `status.showUntrackedFiles`, which a user may have set to `no`.
///
/// Failure returns an empty list rather than an error. A checkout whose ignore rules cannot be read
/// should still get its modified files decorated.
pub fn ignored_roots(cwd: &Path) -> Vec<String> {
    let Ok(out) = run_git(
        cwd,
        "status",
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--ignored",
            "--untracked-files=normal",
        ],
    ) else {
        return Vec::new();
    };

    out.split('\0')
        .filter_map(|entry| entry.strip_prefix("!! "))
        .map(str::to_string)
        .collect()
}

/// The empty tree's well-known object id — every git repository has this
/// object, whether or not it has ever been written to disk, because it needs
/// no content to exist. Diffing against it is how a repository with no commits
/// yet gets an answer out of `line_change_counts` below: there is no `HEAD` to
/// name, but "everything staged or on disk, compared with nothing" is exactly
/// the comparison an empty tree gives for free.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Untracked files larger than this are not read for a line count — they
/// still show up in `unstaged` and count toward "files touched" the same as
/// any other entry there, they just contribute nothing to `insertions`.
///
/// Reading a file just to count its lines is cheap for source; it is not cheap
/// for the odd stray build artifact or log dump sitting untracked in a
/// checkout, and this runs on every status refresh.
const UNTRACKED_LINE_COUNT_CAP: u64 = 5 * 1024 * 1024;

/// `insertions`/`deletions` for `GitStatus` — see the doc comment on those fields for the summary;
/// this is where the rule is actually implemented.
///
/// What this counts, in full:
///   - Every tracked file's change from `HEAD` (or the empty tree, for a repository with no commits
///     yet — see [`EMPTY_TREE`]) to the working tree, staged and unstaged combined. `git diff <ref>
///     --numstat` reports that net difference regardless of how much of it is in the index, which
///     is the right question here — "how much has this cluster changed" — and is what keeps a file
///     that is staged *and* further edited from being counted twice. The same number `git diff
///     --stat HEAD` would report, split into the two counts instead of one line per file.
///   - Every untracked file in `unstaged` (`kind` is `Untracked`), as a pure addition of its own
///     line count. Untracked files are invisible to `git diff` whatever it is diffed against, so
///     without this the totals would ignore new files — on a feature branch, most of the change.
///
/// Left out rather than silently reported as zero: line counts for binary files (see
/// [`parse_numstat_line`]), untracked files over [`UNTRACKED_LINE_COUNT_CAP`], and anything
/// `.gitignore` excludes. Each is still in `staged`/`unstaged`, so only its line total is missing.
///
/// Best-effort like the `ahead`/`behind` lookup just above it in `status_in`: a `git diff` that
/// fails for any reason leaves both counts at `0` rather than sinking the whole status.
fn line_change_counts(cwd: &Path, unstaged: &[GitFileChange]) -> (u32, u32) {
    let has_head = run_git(cwd, "rev-parse", &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let base = if has_head { "HEAD" } else { EMPTY_TREE };

    let mut insertions = 0u32;
    let mut deletions = 0u32;

    if let Ok(numstat) = run_git(cwd, "diff", &["diff", "--find-renames", "--numstat", base]) {
        for line in numstat.lines() {
            if let Some((added, removed)) = parse_numstat_line(line) {
                insertions += added.unwrap_or(0);
                deletions += removed.unwrap_or(0);
            }
        }
    }

    for file in unstaged
        .iter()
        .filter(|f| matches!(f.kind, GitChangeKind::Untracked))
    {
        insertions += untracked_line_count(&cwd.join(&file.path));
    }

    (insertions, deletions)
}

/// One `--numstat` record's two numbers, in the order git prints them: added,
/// then removed. Either is `None` for a binary file, and git marks both when it
/// marks one, so the pair travels together everywhere below.
type LineCounts = (Option<u32>, Option<u32>);

/// Fill in `insertions`/`deletions` on every row of a status, in place.
///
/// **Two more `git diff` runs, and neither is the one `line_change_counts` already does.** That
/// looks like waste and is not. The totals on `GitStatus` are the net change from `HEAD` to the
/// working tree, which is the right answer to "how much has this cluster changed" precisely because
/// it refuses to count a staged-then-further-edited file twice — and that refusal is what makes it
/// useless per row, since it cannot say how much of a file's change is in the index.
///
/// A row needs its own side: `--cached` compares `HEAD` to the index, bare `diff` compares the
/// index to disk, and a file in both lists gets a different number in each. The totals are
/// therefore *not* a sum of these, and both fields say so.
///
/// `--find-renames` on both, matching `parse_porcelain`: status already reports a rename as one row
/// under the new path, and a numstat without it would name two paths no row has.
///
/// Best-effort throughout: a `git diff` that fails leaves every row's counts at `None`, which the
/// panel draws as no count rather than as a failure.
fn attach_line_counts(cwd: &Path, staged: &mut [GitFileChange], unstaged: &mut [GitFileChange]) {
    let cached = numstat_by_path(
        cwd,
        &["diff", "--cached", "--find-renames", "--numstat", "-z"],
    );
    for change in staged.iter_mut() {
        if let Some(&(added, removed)) = cached.get(&change.path) {
            change.insertions = added;
            change.deletions = removed;
        }
    }

    let worktree = numstat_by_path(cwd, &["diff", "--find-renames", "--numstat", "-z"]);
    for change in unstaged.iter_mut() {
        if matches!(change.kind, GitChangeKind::Untracked) {
            let path = cwd.join(&change.path);
            // The cap and the binary check are inside `untracked_line_count`,
            // which reports both as `0`. Re-deriving "was it counted at all"
            // from a zero would misread a genuinely empty new file, so the two
            // reasons to decline are asked here instead.
            if countable_untracked(&path) {
                change.insertions = Some(untracked_line_count(&path));
                change.deletions = Some(0);
            }
            continue;
        }
        if let Some(&(added, removed)) = worktree.get(&change.path) {
            change.insertions = added;
            change.deletions = removed;
        }
    }
}

/// Whether `untracked_line_count` will give a real answer for this path, as
/// opposed to the `0` it returns for every way it can decline. Kept beside it
/// rather than folded into it because the totals in `line_change_counts` want
/// the `0` and the per-row counts want the distinction.
fn countable_untracked(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() > UNTRACKED_LINE_COUNT_CAP {
        return false;
    }
    match std::fs::read(path) {
        Ok(bytes) => !looks_binary(&bytes),
        Err(_) => false,
    }
}

/// `git diff --numstat -z` for one comparison, as a map from repo-relative path
/// to its two counts. Empty for a diff that fails, which is how a caller ends up
/// leaving every row uncounted rather than reporting an error.
fn numstat_by_path(cwd: &Path, args: &[&str]) -> HashMap<String, LineCounts> {
    run_git(cwd, "diff", args)
        .map(|out| parse_numstat_z(&out).into_iter().collect())
        .unwrap_or_default()
}

/// `git diff --numstat -z` into one record per changed path, newest-git-first.
///
/// **`-z` rather than the plain form, because the plain form is ambiguous and this needs the
/// path.** Without it a path containing a tab, a newline or a non-ASCII byte comes back quoted and
/// C-escaped, and a rename is printed as the composite `src/{a.txt => b.txt}` — neither of which is
/// a string that can be handed back to `git show`. `parse_numstat_line` above gets away with
/// ignoring all of this because it only ever wanted the two numbers.
///
/// The `-z` grammar is two shapes sharing one prefix. An ordinary change is a single NUL-terminated
/// field, `<added>\t<removed>\t<path>`. A rename ends its field at the second tab and follows it
/// with two more fields, source then destination — so an empty third column is the marker that two
/// more reads are owed, and the destination is the path the status list holds. A trailing NUL after
/// the last record leaves one empty field, which is why an empty field is skipped rather than
/// treated as a malformed record.
///
/// Either count is `None` for a binary file, which `--numstat` marks with a bare `-` where the
/// number would be. Both are `None` together in that case, since git marks both.
fn parse_numstat_z(out: &str) -> Vec<(String, LineCounts)> {
    let mut records = Vec::new();
    let mut fields = out.split('\0');

    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }

        let mut columns = field.splitn(3, '\t');
        let (Some(added), Some(removed), Some(rest)) =
            (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };

        let path = if rest.is_empty() {
            let _source = fields.next();
            // An empty destination is the trailing field a final NUL leaves,
            // not a path — a truncated rename record ends the walk rather than
            // recording counts against `""`, which no row could ever match.
            match fields.next() {
                Some(destination) if !destination.is_empty() => destination.to_string(),
                _ => break,
            }
        } else {
            rest.to_string()
        };

        records.push((path, (added.parse().ok(), removed.parse().ok())));
    }

    records
}

/// One line of `git diff --numstat` — `<added>\t<removed>\t<path>` — into its
/// two counts. `None` for a line that does not parse as one of these records at
/// all (the format has no other kind of line, but a future git printing one
/// this has never seen should not panic).
///
/// Each count is itself `None` for a binary file, which `--numstat` marks with a bare `-` in place
/// of a number rather than omitting the line. `line_change_counts` treats that `None` as "nothing
/// to add", not "zero lines changed" — the file is still in `staged`/`unstaged`, it just cannot
/// contribute a line count that does not exist. The path is not extracted — nothing here displays
/// file names, only totals — which is also what keeps this ignorant of the `old => new` shape
/// `--find-renames` prints in the third column.
fn parse_numstat_line(line: &str) -> Option<(Option<u32>, Option<u32>)> {
    let mut fields = line.splitn(3, '\t');
    let added = fields.next()?;
    let removed = fields.next()?;
    fields.next()?; // the path, unused here
    Some((added.parse().ok(), removed.parse().ok()))
}

/// How many lines to count an untracked file as adding, honouring
/// [`UNTRACKED_LINE_COUNT_CAP`] and skipping anything that reads as binary.
///
/// `0` for every way this can decline to count: the file vanishing between
/// being listed and being read, a size over the cap, and binary content all
/// mean "no line count for this one" — the file itself is still in `unstaged`
/// regardless, `line_change_counts` never removes an entry for failing to
/// read it.
fn untracked_line_count(path: &Path) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if meta.len() > UNTRACKED_LINE_COUNT_CAP {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return 0;
    };
    if looks_binary(&bytes) {
        return 0;
    }

    // Lossy, matching `run_git`'s own reasoning: a text file is not guaranteed
    // to be valid UTF-8, and a line count a few characters off from replacement
    // characters is still a far better answer than refusing to count it.
    String::from_utf8_lossy(&bytes).lines().count() as u32
}

/// The same heuristic `git` itself uses to decide whether to diff a file as
/// text: the presence of a NUL byte anywhere in a leading slice of it. Checking
/// the whole file would cost a full read of exactly the files this is trying
/// to avoid reading in full; the first 8000 bytes is git's own threshold
/// (`core.bigFileThreshold` aside) and is enough to catch the ordinary case of
/// a compiled asset or an image.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// Both sides of one file's diff.
///
/// `staged` picks which pair of revisions to compare: the staged view is
/// HEAD against the index, the unstaged view is the index against the file on
/// disk. A side that does not exist — HEAD for a newly added file, the index
/// for an untracked one — is empty text, which is exactly how the diff editor
/// wants an addition expressed.
#[tauri::command]
pub fn git_cluster_diff(
    app: AppHandle,
    cluster_id: String,
    path: String,
    staged: bool,
) -> Result<GitDiff> {
    let cwd = cluster_checkout(&app, &cluster_id, "diff")?;

    if staged {
        // A staged rename is the one row in this list whose `HEAD` side is not
        // under its own path: `parse_porcelain` names the row for the
        // destination, which is exactly the path `HEAD` does not have. Asking
        // for it and taking the miss as "no left-hand side" drew every renamed
        // file as though its whole contents had just been written — a moved
        // file with a one-line edit showed as a thousand added lines and no
        // removed ones. The source is asked for only on that miss, so an
        // ordinary modification still costs one `git show` and a genuinely new
        // file still costs the miss it was always going to take.
        let original = show(&cwd, &format!("HEAD:{path}")).or_else(|| {
            let source = staged_rename_source(&cwd, &path)?;
            show(&cwd, &format!("HEAD:{source}"))
        });

        return Ok(GitDiff {
            original: original.unwrap_or_default(),
            modified: show(&cwd, &format!(":{path}")).unwrap_or_default(),
        });
    }

    // The index is the left-hand side whenever the file is tracked at all; HEAD
    // is the fallback for the narrow case of a file git knows about but that
    // has no index entry, and empty text covers untracked files.
    let original = show(&cwd, &format!(":{path}"))
        .or_else(|| show(&cwd, &format!("HEAD:{path}")))
        .unwrap_or_default();

    Ok(GitDiff {
        original,
        // A deleted file reads as an error here, which is the same thing as an
        // empty right-hand side as far as the diff is concerned.
        modified: std::fs::read_to_string(cwd.join(&path)).unwrap_or_default(),
    })
}

/// Where a staged rename's destination came from, or `None` when `path` is not
/// the destination of one.
///
/// `--diff-filter=R` so git does the selecting: everything else in the index is
/// filtered out before the output is parsed, which keeps this from having to
/// tell a rename from a copy or a modification by reading status letters.
fn staged_rename_source(cwd: &Path, path: &str) -> Option<String> {
    let out = run_git(
        cwd,
        "diff",
        &[
            "diff",
            "--cached",
            "--find-renames",
            "--name-status",
            "-z",
            "--diff-filter=R",
        ],
    )
    .ok()?;

    parse_rename_pairs(&out)
        .into_iter()
        .find(|(_, destination)| destination == path)
        .map(|(source, _)| source)
}

/// `git diff --name-status -z --diff-filter=R` into `(source, destination)` pairs.
///
/// Three NUL-terminated fields per record: the status letter with its similarity score (`R100`),
/// then the two paths, source first. `-z` for [`parse_numstat_z`]'s reason — the plain form quotes
/// and escapes any path that is not plain ASCII, and these strings are handed straight back to
/// `git show`. A trailing NUL leaves one empty field, so an empty status field ends the walk rather
/// than producing a record with two `None` paths.
fn parse_rename_pairs(out: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut fields = out.split('\0');

    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        // Neither path is ever legitimately empty, so an empty one is the
        // trailing field a final NUL leaves after a record that was cut short.
        // Recording it would hand `git show` a `HEAD:` with nothing after it.
        let (Some(source), Some(destination)) = (fields.next(), fields.next()) else {
            break;
        };
        if source.is_empty() || destination.is_empty() {
            break;
        }
        pairs.push((source.to_string(), destination.to_string()));
    }

    pairs
}

/// Staging changes writes to a cluster's index — on a `Main` cluster, the
/// project's real one, which is allowed like any other. Every mutating command
/// in this module opens with `guard_cluster_write` (see
/// `environments::refuse_read_only_write`);
/// `every_git_command_is_classified` fails if one is added without a decision.
#[tauri::command]
pub fn git_cluster_stage(app: AppHandle, cluster_id: String, paths: Vec<String>) -> Result<()> {
    crate::environments::guard_cluster_write(&app, &cluster_id, "add")?;
    let cwd = cluster_checkout(&app, &cluster_id, "add")?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&cwd, "add", &args)?;
    Ok(())
}

#[tauri::command]
pub fn git_cluster_unstage(app: AppHandle, cluster_id: String, paths: Vec<String>) -> Result<()> {
    crate::environments::guard_cluster_write(&app, &cluster_id, "restore")?;
    let cwd = cluster_checkout(&app, &cluster_id, "restore")?;
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&cwd, "restore", &args)?;
    Ok(())
}

/// Commit whatever is staged.
///
/// Nothing staged, an empty message, a failing hook: all of those come back
/// from `git` on stderr with a better explanation than this could invent, so
/// they surface as `AppError::Git` carrying git's own words.
///
/// A `Main` cluster commits to the branch its checkout is on, like any other.
/// Only a read-only environment is refused, before any of that; see
/// `environments::refuse_read_only_write`.
#[tauri::command]
pub fn git_cluster_commit(app: AppHandle, cluster_id: String, message: String) -> Result<()> {
    crate::environments::guard_cluster_write(&app, &cluster_id, "commit")?;
    let cwd = cluster_checkout(&app, &cluster_id, "commit")?;
    run_git(&cwd, "commit", &["commit", "-m", &message])?;
    Ok(())
}

// --- resolution --------------------------------------------------------------

/// The directory to run `git` in for a cluster's own source control.
///
/// The **repository root**, not the cluster's working root, and that difference
/// is load-bearing rather than tidiness. `git status --porcelain` reports paths
/// relative to the repository root whatever directory it was run from, and
/// those are the paths the frontend hands straight back to the commands here.
/// A cluster whose project is a subdirectory of a larger repository would
/// otherwise resolve `cwd.join(&path)` against the wrong base and read the
/// wrong file — silently, since every one of these treats an unreadable side of
/// a diff as legitimately empty. `apps/files.rs` had this exact bug and needed
/// the same fix.
///
/// An error rather than an `Option`, because these are the commands that have
/// nothing sensible to do without a repository: a stage or a commit aimed at a
/// directory that is not one is a call that should never have been made.
/// `git_cluster_status` and `git_cluster_diffstat` are the two that answer
/// "there is no repository here" as a value, and neither goes through this.
fn cluster_checkout(app: &AppHandle, cluster_id: &str, op: &str) -> Result<PathBuf> {
    let working = crate::project::cluster_path(app, cluster_id).ok_or_else(|| AppError::Git {
        op: op.to_string(),
        reason: "This cluster has no project open.".to_string(),
    })?;

    repo_root(&working).ok_or_else(|| AppError::Git {
        op: op.to_string(),
        reason: format!("`{}` is not inside a git repository.", working.display()),
    })
}

// --- running git -------------------------------------------------------------

/// Run `git` in `cwd` and hand back its stdout.
///
/// `op` is the label that ends up in the error message — passed separately from
/// `args` because the arguments can contain a whole commit message, and an
/// error reading `git commit -m <the user's three paragraphs> failed` helps
/// nobody. Failing to spawn and exiting non-zero collapse to the same error:
/// from the caller's side both mean "git did not answer".
pub(crate) fn run_git(cwd: &Path, op: &str, args: &[&str]) -> Result<String> {
    run_git_env(cwd, op, args, &[])
}

/// [`run_git`] with extra environment variables for the one child. A test uses
/// it to point git at an empty global config without touching this process's
/// own environment, which every other test shares.
pub(crate) fn run_git_env(
    cwd: &Path,
    op: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<String> {
    let mut command = git_command();
    command
        .current_dir(cwd)
        .args(args)
        .envs(env.iter().copied());

    let output = command.output().map_err(|err| AppError::Git {
        op: op.to_string(),
        reason: err.to_string(),
    })?;

    if !output.status.success() {
        return Err(AppError::Git {
            op: op.to_string(),
            reason: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    // Lossy rather than strict: a path or a file's contents can be arbitrary
    // bytes, and a diff of a mostly-text file is worth showing with a few
    // replacement characters in it rather than refusing outright.
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// What `git rev-parse --local-env-vars` lists, plus one name older gits add,
/// less the two that carry `-c` settings. Each ties git to one repository:
/// which one, or its index, object store, config file or replacement refs,
/// ahead of the working directory. A parent running under git exports them (a
/// hook, or `git rebase --exec`), and a child that keeps them acts on the
/// parent's repository. One test run under `rebase --exec` did exactly that: a
/// fixture's `git init` in a temp folder set `core.bare` on the developer's
/// own repository, and every checkout of it stopped working.
///
/// `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT` stay, as git keeps them when
/// it runs a command in another repository, such as a submodule. They name no
/// repository, and a user may set one to pass a setting such as a CA bundle.
pub(crate) const REPOSITORY_ENV: [&str; 14] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
    "GIT_INTERNAL_SUPER_PREFIX",
];

/// A `git` that finds its repository from its working directory alone.
///
/// Every `git` this crate spawns starts here, test fixtures included, and a
/// test reads the source to hold it to that. It also keeps each spawn from
/// flashing a console window on Windows, which matters because the panel
/// re-runs `status` after every single mutation.
pub(crate) fn git_command() -> Command {
    let mut command = Command::new("git");
    forget_parent_repository(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Removes each of [`REPOSITORY_ENV`] from what `command` would inherit.
fn forget_parent_repository(command: &mut Command) -> &mut Command {
    for name in REPOSITORY_ENV {
        command.env_remove(name);
    }
    command
}

/// One blob out of the object database, or `None` if that revision has no such
/// path. The `None` is load-bearing — it is how `git_diff` recognises a side of
/// the comparison that simply doesn't exist.
fn show(cwd: &Path, spec: &str) -> Option<String> {
    run_git(cwd, "show", &["show", spec]).ok()
}

// --- worktrees -----------------------------------------------------------------

/// One entry out of `git worktree list --porcelain`.
///
/// Unlike the rest of this module, the functions here take a checkout path
/// directly rather than a tool id — id-to-path resolution is the command
/// layer's job, and worktree listing in particular has to be pointed at the
/// *main* checkout (see `main_repo_root`) regardless of which tool's id asked
/// for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    /// Absolute, exactly as git prints it — forward slashes even on Windows.
    /// Normalizing would make this string useless as an argument back to git.
    pub path: String,
    /// Short name (`feat/x`, not `refs/heads/feat/x`). `None` for a detached
    /// HEAD, which is the only case `git worktree list` omits a `branch` line
    /// for.
    pub branch: Option<String>,
    pub head: String,
    /// True for the primary working tree. `git worktree list` always prints
    /// it first, so this is set from position in the output, not from
    /// anything in the porcelain fields themselves.
    pub is_main: bool,
    pub locked: bool,
}

/// Every worktree attached to `repo`'s repository, main checkout included.
///
/// `--porcelain` prints one blank-line-separated record per worktree, each a
/// few whitespace-free `key value` lines (`worktree <path>`, `HEAD <sha>`,
/// `branch refs/heads/<name>`) plus bare markers (`detached`, `locked`,
/// `locked <reason>`, `prunable <reason>`) with no value on the same shape.
/// Parsing goes line by line and only acts on prefixes it recognises — a
/// future git adding a new marker line must not make this function fail,
/// just silently not surface that marker.
pub fn worktrees(repo: &Path) -> Result<Vec<GitWorktree>> {
    let porcelain = run_git(repo, "worktree list", &["worktree", "list", "--porcelain"])?;

    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Option<String> = None;
    let mut locked = false;

    let flush = |path: &mut Option<String>,
                 head: &mut String,
                 branch: &mut Option<String>,
                 locked: &mut bool,
                 result: &mut Vec<GitWorktree>| {
        if let Some(p) = path.take() {
            result.push(GitWorktree {
                path: p,
                branch: branch.take(),
                head: std::mem::take(head),
                // The main worktree is always the first record `git worktree
                // list` prints, so "nothing pushed yet" is exactly "this is
                // it".
                is_main: result.is_empty(),
                locked: *locked,
            });
        }
        *locked = false;
    };

    for line in porcelain.lines() {
        if line.is_empty() {
            flush(&mut path, &mut head, &mut branch, &mut locked, &mut result);
            continue;
        }

        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
        } else if line == "locked" || line.starts_with("locked ") {
            locked = true;
        }
        // `detached`, `bare`, `prunable <reason>`, and anything else porcelain
        // ever adds fall through here unrecognized and are skipped on
        // purpose: `detached` is already implied by `branch` staying `None`,
        // and an unknown marker is not reason to lose the whole record.
    }
    // The last record has no trailing blank line to flush it, since git's
    // output does not end with one.
    flush(&mut path, &mut head, &mut branch, &mut locked, &mut result);

    Ok(result)
}

/// Create a new worktree at `path`, checked out on a new branch `branch`
/// forked from `repo`'s current HEAD.
///
/// `git worktree add -b <branch> <path>` creates the directory itself — it
/// must not already exist — so this is also how Veistra creates the branch,
/// not a separate step.
pub fn add_worktree(repo: &Path, path: &Path, branch: &str) -> Result<()> {
    let path = path.to_string_lossy();
    run_git(
        repo,
        "worktree add",
        &["worktree", "add", "-b", branch, path.as_ref()],
    )?;
    Ok(())
}

/// Like `add_worktree`, but forks `branch` from `start_point` instead of
/// implicitly from HEAD.
///
/// The environment model (`environments.rs`) needs this: a New Cluster
/// dialog's "new local worktree" step lets the base be any branch, not just
/// whatever the main checkout happens to have checked out at the moment —
/// and `git worktree add -b <branch> <path> <start-point>` is the one-command
/// way to do that without a separate `checkout`/`branch` step that would
/// leave a half-created worktree behind on failure.
pub fn add_worktree_from(repo: &Path, path: &Path, branch: &str, start_point: &str) -> Result<()> {
    let path = path.to_string_lossy();
    run_git(
        repo,
        "worktree add",
        &["worktree", "add", "-b", branch, path.as_ref(), start_point],
    )?;
    Ok(())
}

/// Remove the worktree at `path`.
///
/// Plain `git worktree remove` refuses a worktree that has uncommitted
/// changes or untracked files, and that refusal is the correct default — it
/// is the only thing standing between a stray click and losing work that
/// exists nowhere else. `force` is `--force`, for the caller that has already
/// confirmed with the user that discarding it is intended.
pub fn remove_worktree(repo: &Path, path: &Path, force: bool) -> Result<()> {
    let path = path.to_string_lossy();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path.as_ref());
    run_git(repo, "worktree remove", &args)?;
    Ok(())
}

/// Forget worktrees whose directories no longer exist.
///
/// A worktree Veistra created is only ever removed through `remove_worktree`
/// above, but a worktree's directory can also just be deleted from outside
/// Veistra — in Explorer, by `rm -rf`, by cleaning a CI checkout. Git does not
/// notice that on its own; `git worktree list` keeps reporting the dead entry
/// until something runs `prune`. This is that something.
pub fn prune_worktrees(repo: &Path) -> Result<()> {
    run_git(repo, "worktree prune", &["worktree", "prune"])?;
    Ok(())
}

/// The root of the working tree containing `path`, or `None` if it is not
/// inside one.
///
/// This is also how the module answers "is this a repository at all", now that
/// its last caller wanted the root anyway. An `is_repo` sat here doing that
/// with `rev-parse --is-inside-work-tree`, and this returns `None` for exactly
/// the directories that returned `false` for — so asking both was one `git`
/// spawn spent proving what the next one was about to say.
///
/// Run from inside a linked worktree, this is *that worktree's* root, not the
/// main checkout's — the two only coincide when `path` is already inside the
/// main checkout. Worktree listing and creation want the main checkout
/// specifically, which is what `main_repo_root` is for.
pub fn repo_root(path: &Path) -> Option<PathBuf> {
    run_git(path, "rev-parse", &["rev-parse", "--show-toplevel"])
        .ok()
        .map(|out| PathBuf::from(out.trim()))
}

/// The root of the *primary* working tree, even when `path` is inside a
/// linked worktree.
///
/// `--git-common-dir` is the one git-dir query that both worktrees agree on:
/// a linked worktree has its own private git-dir
/// (`<main>/.git/worktrees/<name>`) but shares one common dir with the main
/// checkout, and that shared dir lives directly under the main checkout's
/// working tree — so its parent is the answer. `worktrees` and
/// `add_worktree` should be pointed at this rather than at `repo_root`: Veistra
/// shows one worktree list per project regardless of which worktree happens
/// to be the active tool, and resolving through the main checkout every time
/// is what keeps that list from depending on which one asked.
///
/// `--path-format=absolute` is a recent enough flag that an old git rejects
/// it outright rather than ignoring it, so on any failure — unsupported flag
/// included — this falls back to `repo_root`, which is right whenever `path`
/// is already the main checkout and merely imprecise (not wrong) otherwise.
pub fn main_repo_root(path: &Path) -> Option<PathBuf> {
    match run_git(
        path,
        "rev-parse",
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) {
        Ok(out) => PathBuf::from(out.trim()).parent().map(Path::to_path_buf),
        Err(_) => repo_root(path),
    }
}

/// The push URL of a remote, as configured — `None` when no such remote exists.
///
/// `remote get-url` rather than reading `.git/config`, so that `insteadOf`
/// rewrites and a worktree's shared config are applied by the thing that owns
/// those rules. The string comes back in whatever form the user cloned with,
/// SSH or HTTPS, and interpreting it is the caller's job: this module knows
/// about git and deliberately nothing about any particular host.
///
/// Whitespace-trimmed but otherwise verbatim, and **not** stripped of a
/// userinfo component. A remote can be spelled
/// `https://<token>@github.com/owner/name`, so a caller that puts this in an
/// error message or a log is quoting a credential — `github.rs` parses it to
/// an owner and a name and never carries the URL any further.
pub fn remote_url(cwd: &Path, remote: &str) -> Option<String> {
    run_git(cwd, "remote get-url", &["remote", "get-url", remote])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|url| !url.is_empty())
}

// --- worktrees, per cluster ---------------------------------------------------
//
// The commands above take a tool id, because source control follows whichever tool's checkout is
// on screen. These take a *cluster* id instead, and the difference is the whole point of the
// feature: a cluster is one thing being worked on, and giving it a checkout of its own is what lets
// two of them hold two branches of one repository open at once without either one's edits appearing
// in the other's file tree. The frontend still never names a directory — a cluster id resolves to a
// project here, exactly as a tool id resolves to a checkout above.

/// Where a project's worktrees live: `<project>/../.worktrees/<project-name>/`.
///
/// Beside the project rather than inside it, and that placement is load-bearing rather than
/// tidiness. A worktree is a complete second copy of the codebase, so one nested inside the project
/// would sit in the tree that every file walker descends — the Files app, the search index, and
/// Vite's watcher would each find one more copy of `src/` for every cluster. Outside, nothing has
/// to be taught to ignore it, and the parent repository never reports it as untracked content.
///
/// Namespaced by the project's folder name so that two projects sharing a parent directory — the
/// normal shape of a `code/` folder — do not pool their worktrees where the names could collide.
fn worktree_home(project: &Path) -> Result<PathBuf> {
    let parent = project.parent().ok_or_else(|| AppError::Git {
        op: "worktree add".to_string(),
        reason: format!(
            "`{}` is a filesystem root and has no directory beside it to hold worktrees",
            project.display()
        ),
    })?;

    let name = project
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Git {
            op: "worktree add".to_string(),
            reason: format!("`{}` has no usable folder name", project.display()),
        })?;

    Ok(parent.join(".worktrees").join(name))
}

/// Reject a name that cannot be both a folder and a git branch.
///
/// One name serves as both, so it has to clear both bars, and the union is
/// stricter than either alone: git refuses `~ ^ : ? * [ \` and whitespace in a
/// ref name, Windows refuses `< > : " / \ | ? *` in a path component, and a
/// handful of names (`CON`, `NUL`, `COM1`…) are reserved by Windows no matter
/// what extension follows them.
///
/// Checked here rather than left to git because git's own rejection arrives as
/// a message about `refs/heads/`, which tells a user who typed "my branch" that
/// something is wrong with a ref they never mentioned. This says what they can
/// type instead.
///
/// Visible to the crate rather than private so `github.rs` can check the names
/// it generates against the real rule instead of against a copy of it. A name
/// assembled from an issue title has no human to correct it, so a test that the
/// generator agrees with this function is the only thing standing between a
/// colon in somebody's issue title and a `worktree add` that fails.
pub(crate) fn validate_worktree_name(name: &str) -> Result<()> {
    let bad = |reason: &str| AppError::Git {
        op: "worktree add".to_string(),
        reason: reason.to_string(),
    };

    if name.trim() != name {
        return Err(bad("A worktree name cannot start or end with a space."));
    }
    if name.is_empty() {
        return Err(bad("A worktree needs a name."));
    }
    if name.len() > 100 {
        return Err(bad(
            "A worktree name has to be shorter than 100 characters.",
        ));
    }

    // `.` and `-` are legal *inside* a name and troublesome at the edges: a
    // leading dot hides the folder on Unix and is refused in a ref component, a
    // leading dash reads as a flag to every command line this name is ever
    // passed to, and git refuses both a trailing `.` and a `.lock` suffix.
    if name.starts_with('.') || name.starts_with('-') {
        return Err(bad("A worktree name cannot start with a dot or a dash."));
    }
    if name.ends_with('.') || name.ends_with(".lock") {
        return Err(bad(
            "A worktree name cannot end with a dot or with `.lock`.",
        ));
    }
    if name.contains("..") {
        return Err(bad("A worktree name cannot contain two dots in a row."));
    }

    if let Some(bad_char) = name
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        return Err(bad(&format!(
            "`{bad_char}` cannot be used in a worktree name — letters, digits, dots, dashes and underscores only."
        )));
    }

    // Reserved on Windows in every directory, with or without an extension, and
    // a `git worktree add` that lands on one fails with an IO error rather than
    // anything a user could act on.
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(bad(&format!(
            "`{name}` is a name Windows reserves — pick another."
        )));
    }

    Ok(())
}

/// A cluster's project directory and the main checkout that governs it.
///
/// Two paths rather than one because they answer different questions and are
/// only usually the same. The project is where worktrees are placed *beside*;
/// the main checkout is where `git worktree` has to be run, and it differs
/// whenever the project is a subdirectory of a larger repository.
///
/// Resolved from `cluster_pointer` — the project — and deliberately not from
/// `cluster_path`, which follows the worktree. Asking a cluster that is already
/// on a worktree to list its worktrees must not resolve through the worktree it
/// is sitting in, or the answer would depend on where the question was asked
/// from.
fn cluster_repo(app: &AppHandle, cluster_id: &str, op: &str) -> Result<(PathBuf, PathBuf)> {
    let project =
        crate::project::cluster_pointer(app, cluster_id).ok_or_else(|| AppError::Git {
            op: op.to_string(),
            reason: "This cluster has no project open.".to_string(),
        })?;

    if !project.is_dir() {
        return Err(AppError::Git {
            op: op.to_string(),
            reason: format!("`{}` is not there any more.", project.display()),
        });
    }

    let root = main_repo_root(&project).ok_or_else(|| AppError::Git {
        op: op.to_string(),
        reason: format!("`{}` is not inside a git repository.", project.display()),
    })?;

    Ok((project, root))
}

/// Every worktree of this cluster's repository, main checkout included.
///
/// An empty list rather than an error for a cluster with no project, or one
/// whose project is not a repository. Both are ordinary states the panel draws
/// as its empty state — the same judgement `git_status` makes in returning
/// `None` instead of failing.
///
/// Prunes first. A worktree directory deleted outside Veistra stays in `git
/// worktree list` until something runs `prune`, and a list that still names a
/// folder nobody can open is worse than one that is a moment out of date.
#[tauri::command]
pub fn git_worktrees(app: AppHandle, cluster_id: String) -> Result<Vec<GitWorktree>> {
    let Ok((_, root)) = cluster_repo(&app, &cluster_id, "worktree list") else {
        return Ok(Vec::new());
    };

    // Best-effort: a prune that fails is not a reason to refuse to list, and the
    // list is still correct apart from entries git has not caught up with.
    let _ = prune_worktrees(&root);

    worktrees(&root)
}

/// Cut a branch named `name` from the current HEAD, check it out into a new
/// worktree beside the project, and point the cluster at it.
///
/// One name for the branch and the folder both, because the user is naming a
/// piece of work rather than a directory, and two names for one thing is two
/// things to keep in agreement.
///
/// The cluster is only repointed once git has actually created the checkout. A
/// cluster pointed at a directory that failed to appear would resolve its
/// working root to somewhere that does not exist, and every terminal opened in
/// it afterwards would fail on a path the user never typed.
#[tauri::command]
pub fn git_worktree_create(
    app: AppHandle,
    cluster_id: String,
    name: String,
) -> Result<WorktreeRef> {
    validate_worktree_name(&name)?;
    let (project, root) = cluster_repo(&app, &cluster_id, "worktree add")?;

    let path = worktree_home(&project)?.join(&name);
    if path.exists() {
        return Err(AppError::Git {
            op: "worktree add".to_string(),
            reason: format!("`{name}` already exists — pick another name."),
        });
    }

    // `git worktree add` creates the leaf itself and refuses if it is already
    // there, but it will not create the two levels above it on first use.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| AppError::Io {
            path: parent.display().to_string(),
            source,
        })?;
    }

    // Read before the branch is cut, not after: `git worktree add -b` forks from
    // whatever the main checkout is on *now*, and once the new branch exists
    // there is nothing left in the repository that records which one that was.
    let base = run_git(&root, "rev-parse", &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|b| !b.is_empty() && b != "HEAD");

    add_worktree(&root, &path, &name)?;

    let reference = WorktreeRef {
        path: path.display().to_string(),
        branch: Some(name),
        base,
    };

    app.state::<crate::shell_state::ShellState>()
        .set_cluster_worktree(&app, &cluster_id, Some(reference.clone()));

    Ok(reference)
}

/// Discard this cluster's worktree and return it to working in its project.
///
/// The branch survives — the commits on it are the reason it was made, and a
/// worktree is only ever the window onto them. What goes is the checkout on
/// disk.
///
/// `force` is git's `--force`, and the default refusal it overrides is the
/// correct one: a worktree with uncommitted changes holds the only copy of
/// them. The caller is expected to have asked the user first.
#[tauri::command]
pub fn git_worktree_remove(app: AppHandle, cluster_id: String, force: bool) -> Result<()> {
    crate::environments::guard_cluster_write(&app, &cluster_id, "worktree remove")?;
    let shell = app.state::<crate::shell_state::ShellState>();

    let Some(reference) = shell.cluster_worktree(&cluster_id) else {
        // Nothing to remove is not a failure — two clicks on the same button,
        // or a worktree already reconciled away, both land here.
        return Ok(());
    };

    let (_, root) = cluster_repo(&app, &cluster_id, "worktree remove")?;
    remove_worktree(&root, Path::new(&reference.path), force)?;

    // Only after git has agreed. A cluster unpointed from a worktree that is
    // still on disk is a worktree nothing can reach to remove later.
    shell.set_cluster_worktree(&app, &cluster_id, None);

    Ok(())
}

/// Drop the cluster's worktree binding if the checkout behind it is gone.
///
/// `git worktree list` is the authority on which worktrees exist, and Veistra is
/// not the only thing that can delete one — Explorer, `rm -rf`, and another
/// clone of the same repository all can. Without this, such a cluster keeps a
/// working root pointing at nothing: its terminals fail to spawn, its file tree
/// draws empty, and nothing on screen explains why.
///
/// Returns what the cluster is bound to afterwards, so a caller can tell "still
/// fine" from "that is gone now" without asking a second time.
#[tauri::command]
pub fn git_worktree_reconcile(app: AppHandle, cluster_id: String) -> Result<Option<WorktreeRef>> {
    let shell = app.state::<crate::shell_state::ShellState>();

    let Some(reference) = shell.cluster_worktree(&cluster_id) else {
        return Ok(None);
    };

    // The directory being present is the cheap half of the question and the one
    // that catches every case that matters. Asking git as well would cost a
    // process spawn on every cluster switch to catch only the exotic case of a
    // directory that survived while its metadata did not.
    if Path::new(&reference.path).is_dir() {
        return Ok(Some(reference));
    }

    shell.set_cluster_worktree(&app, &cluster_id, None);

    // Best-effort, and after the binding is already dropped: the user's cluster
    // is usable again either way, and a prune that fails only means git's own
    // list stays stale a little longer.
    if let Ok((_, root)) = cluster_repo(&app, &cluster_id, "worktree prune") {
        let _ = prune_worktrees(&root);
    }

    Ok(None)
}

// --- hunks --------------------------------------------------------------------
//
// What the editor draws in its gutter: one bar per changed region of the open
// file, against the version in HEAD. VS Code calls this the dirty diff, and the
// comparison it makes is with HEAD rather than with the index — so staging a
// change does not clear the bar, because the line really is still different
// from the last committed version and a bar that vanished on `git add` would be
// telling the reader the file matches HEAD when it does not.
//
// Line-based, not character-based. Monaco's decorations attach to line ranges,
// and computing anything finer here would be work thrown away at the boundary.

/// Which of the three things happened to a region of the file.
///
/// A deletion has no lines in the working file to cover, which is why the
/// editor draws it as a wedge *between* two lines rather than as a bar beside
/// one — and why `lines` is `0` for it rather than the number of lines that
/// went away. Those live in `originalLines`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitHunkKind {
    Added,
    Modified,
    Deleted,
}

/// One changed region of a file, in line numbers the editor can decorate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    pub kind: GitHunkKind,
    /// First line of the region in the file **as it is now**, 1-based to match
    /// what both the diff format and Monaco count in. For a deletion this is
    /// the line the removed text used to sit after.
    pub start: u32,
    /// How many current lines the region covers. `0` for a deletion.
    pub lines: u32,
    /// The same region in HEAD's version — what the reader is shown when they
    /// click the bar open.
    pub original_start: u32,
    pub original_lines: u32,
}

/// Every changed region of one file, against HEAD.
///
/// An empty list for an unchanged file, and equally for an untracked one: a
/// file git has never seen has no committed version to differ from, and marking
/// every line of it as added would bury the actual edits under a wall of green
/// the moment somebody opens a new file.
///
/// `path` is repo-relative with forward slashes, the same identity every other
/// command here takes.
#[tauri::command]
pub fn git_hunks(app: AppHandle, cluster_id: String, path: String) -> Result<Vec<GitHunk>> {
    let Some(cwd) = crate::project::cluster_path(&app, &cluster_id) else {
        return Ok(Vec::new());
    };

    // `--unified=0` because context lines are exactly what this must not have:
    // the gutter marks changed lines, and three lines of unchanged context on
    // each side would widen every bar into its neighbours until two edits four
    // lines apart drew as one.
    //
    // A failure here is an ordinary answer, not an error. An untracked file, a
    // path outside the repository, and a repository with no HEAD yet all land
    // here, and none of them is worth interrupting someone's editing session
    // with a dialog.
    let Ok(out) = run_git(
        &cwd,
        "diff",
        &["diff", "--unified=0", "--no-color", "HEAD", "--", &path],
    ) else {
        return Ok(Vec::new());
    };

    Ok(parse_hunks(&out))
}

/// One file as HEAD has it, for the editor to show beside what is on disk.
///
/// Empty text — not an error — when HEAD has no such path. A file added since
/// the last commit genuinely has no committed version, and "" is exactly how a
/// diff view wants a pure addition expressed, so the caller needs no special
/// case for it.
///
/// Whole text rather than a patch, matching `git_diff`: the editor computes its
/// own hunks for display and wants both sides in full.
#[tauri::command]
pub fn git_head_text(app: AppHandle, cluster_id: String, path: String) -> Result<String> {
    let Some(cwd) = crate::project::cluster_path(&app, &cluster_id) else {
        return Ok(String::new());
    };

    Ok(show(&cwd, &format!("HEAD:{path}")).unwrap_or_default())
}

/// The `@@ -a,b +c,d @@` headers of a unified diff into hunks.
///
/// Only the headers are read; the body is skipped entirely, which is what makes
/// this cheap enough to run on every keystroke-triggered refresh. The counts are
/// what classify the hunk: nothing removed is an addition, nothing added is a
/// deletion, and both is a modification.
///
/// The `,n` half of each side is **optional** in the format and means `,1` when
/// absent — a single-line hunk is written `@@ -5 +5 @@`. Assuming it is always
/// present is the standard way to get this wrong, and it fails only on
/// one-line edits, which are the most common kind.
fn parse_hunks(diff: &str) -> Vec<GitHunk> {
    let mut hunks = Vec::new();

    for line in diff.lines() {
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        let Some((ranges, _)) = rest.split_once(" @@") else {
            continue;
        };

        let mut sides = ranges.split_whitespace();
        let Some((original_start, original_lines)) = sides.next().and_then(parse_range) else {
            continue;
        };
        let Some((start, lines)) = sides.next().and_then(parse_range) else {
            continue;
        };

        let kind = match (original_lines, lines) {
            (0, _) => GitHunkKind::Added,
            (_, 0) => GitHunkKind::Deleted,
            _ => GitHunkKind::Modified,
        };

        hunks.push(GitHunk {
            kind,
            // A pure deletion reports `+c,0`, where `c` is the line *before* the
            // gap. Monaco cannot decorate line zero, so a deletion at the very
            // top of the file is clamped to line 1 — the wedge is drawn above
            // the first line either way.
            start: start.max(1),
            lines,
            original_start,
            original_lines,
        });
    }

    hunks
}

/// One side of a hunk header — `-12,3`, `+40`, or `-0,0` — as (start, count).
fn parse_range(side: &str) -> Option<(u32, u32)> {
    let body = side.strip_prefix('-').or_else(|| side.strip_prefix('+'))?;

    match body.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        // No comma means exactly one line. See the note on `parse_hunks`.
        None => Some((body.parse().ok()?, 1)),
    }
}

// --- divergence ---------------------------------------------------------------
//
// What the bottom half of the panel draws: everything this cluster has changed
// since its branch left the one it was cut from — the commits it has made *and*
// the work still uncommitted, as one list.
//
// That union is not two questions stitched together. `git diff <merge-base>`
// compares the fork point directly against the working tree, so committing a
// file does not make it leave this list and does not change the diff shown for
// it. Which is the point: the question is "what has this cluster done", and the
// answer must not depend on how often the user happened to commit along the way.

/// The changed-file list for a cluster's worktree, against its fork point.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDivergence {
    /// The branch this worktree was cut from, as far as we can tell.
    pub base: String,
    /// The fork point itself. Every diff in this view is taken against it, so
    /// the frontend can cache on it — a merge-base that has not moved means
    /// none of these diffs can have changed except through the working tree.
    pub merge_base: String,
    /// Commits made on this branch since the fork. Zero is an ordinary state:
    /// a worktree with uncommitted work and no commits yet.
    pub commits: u32,
    /// Committed and uncommitted alike, in one list. `staged` is meaningless
    /// here and always false — this view is not about the index.
    pub files: Vec<GitFileChange>,
}

/// Everything the cluster's worktree has changed since it forked.
///
/// `None` — not an error — for a cluster that is not on a worktree at all.
/// Working in the project folder means there is no fork point to measure from,
/// and the panel draws its ordinary source-control view for that case rather
/// than an empty divergence.
#[tauri::command]
pub fn git_divergence(app: AppHandle, cluster_id: String) -> Result<Option<GitDivergence>> {
    let shell = app.state::<crate::shell_state::ShellState>();
    let Some(reference) = shell.cluster_worktree(&cluster_id) else {
        return Ok(None);
    };

    let cwd = PathBuf::from(&reference.path);
    if !cwd.is_dir() {
        return Ok(None);
    }

    // The recorded base, or the main checkout's current branch for a worktree
    // created before that field existed. The fallback is the guess the doc on
    // `WorktreeRef::base` calls out as imperfect — it is still better than
    // refusing to draw the view at all.
    let base = match reference.base {
        Some(base) => base,
        None => main_repo_root(&cwd)
            .and_then(|root| worktrees(&root).ok())
            .and_then(|list| list.into_iter().find(|w| w.is_main))
            .and_then(|main| main.branch)
            .ok_or_else(|| AppError::Git {
                op: "merge-base".to_string(),
                reason: "cannot tell which branch this worktree was cut from".to_string(),
            })?,
    };

    let merge_base = run_git(&cwd, "merge-base", &["merge-base", &base, "HEAD"])?
        .trim()
        .to_string();

    let commits = run_git(
        &cwd,
        "rev-list",
        &["rev-list", "--count", &format!("{merge_base}..HEAD")],
    )
    .ok()
    .and_then(|out| out.trim().parse().ok())
    .unwrap_or(0);

    // `-z` for the same reason `git_status` uses it: a path can contain any
    // byte a filesystem allows, newlines included, and the NUL-separated form
    // is the only one that survives them.
    let named = run_git(
        &cwd,
        "diff",
        &["diff", "--name-status", "-z", "--find-renames", &merge_base],
    )?;

    let mut files = parse_name_status(&named);

    // Untracked files are invisible to `git diff` — it compares tracked content
    // — but a file this cluster created and has not yet added is unmistakably
    // something it changed, and leaving it out would make the view quietly
    // incomplete in exactly the case a new feature branch spends most of its
    // life in.
    if let Ok(others) = run_git(
        &cwd,
        "ls-files",
        &["ls-files", "--others", "--exclude-standard", "-z"],
    ) {
        for path in others.split('\0').filter(|p| !p.is_empty()) {
            files.push(change(path, GitChangeKind::Untracked, false, None));
        }
    }

    Ok(Some(GitDivergence {
        base,
        merge_base,
        commits,
        files,
    }))
}

/// One file's whole divergence, as two texts for the diff editor.
///
/// The fork point's version against what is on disk now — deliberately not
/// against HEAD. A file changed in a commit and then changed again in the
/// working tree shows as one diff covering both, because that is what "what has
/// this cluster done to this file" means.
///
/// An absent side is empty text: a file added since the fork has nothing at the
/// merge base, and a file deleted has nothing on disk. That is exactly how the
/// diff editor wants an addition and a deletion expressed.
#[tauri::command]
pub fn git_divergence_diff(
    app: AppHandle,
    cluster_id: String,
    path: String,
    merge_base: String,
) -> Result<GitDiff> {
    let shell = app.state::<crate::shell_state::ShellState>();
    let reference = shell
        .cluster_worktree(&cluster_id)
        .ok_or_else(|| AppError::Git {
            op: "diff".to_string(),
            reason: "this cluster is not working in a worktree".to_string(),
        })?;

    let cwd = PathBuf::from(&reference.path);

    let original = show(&cwd, &format!("{merge_base}:{path}")).unwrap_or_default();
    let modified = std::fs::read_to_string(cwd.join(&path)).unwrap_or_default();

    Ok(GitDiff { original, modified })
}

/// `--name-status -z` into changes.
///
/// The `-z` form is not simply the newline form with a different separator: a
/// rename record spends *three* fields on one entry (`R100`, the old path, the
/// new path) while every other record spends two, so this walks the stream
/// rather than chunking it into pairs.
fn parse_name_status(out: &str) -> Vec<GitFileChange> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();

    while let Some(status) = fields.next() {
        let code = match status.chars().next() {
            Some(code) => code,
            None => continue,
        };

        let Some(kind) = kind_for(code) else { continue };

        let Some(first) = fields.next() else { break };

        // A rename's record carries both paths; the second is the one that
        // exists now and therefore the one every other command takes back.
        if is_rename(code) {
            let Some(to) = fields.next() else { break };
            files.push(change(to, kind, false, Some(first.to_string())));
        } else {
            files.push(change(first, kind, false, None));
        }
    }

    files
}

// --- history ------------------------------------------------------------------
//
// What the top half of the panel draws: the repository's local branches as one
// graph, newest first. The *shape* of that graph — which column a commit sits
// in, where a line bends to meet its parent — is worked out in the frontend,
// because it is a layout question and answering it here would mean shipping a
// rendering decision through an IPC boundary every time a lane changed.
//
// This side supplies only what git knows: the commits, their parents, and the
// refs pointing at them. Parents are the whole reason the frontend can draw
// anything at all — a list of commits in date order is not a graph until you
// know which ones descend from which.

/// One commit, as the graph needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    /// Git's own abbreviation, which is length-adjusted per repository to stay
    /// unambiguous. Taking the first seven characters here instead would be
    /// wrong in exactly the large repositories where it matters.
    pub short: String,
    pub summary: String,
    pub author: String,
    /// Author time, Unix seconds. The frontend formats it; a preformatted
    /// string would have baked this process's locale into the payload.
    pub when: i64,
    /// Every parent, in git's order. Empty for a root commit, one for an
    /// ordinary commit, two or more for a merge — and the second entry is what
    /// tells the graph a line has to fork.
    pub parents: Vec<String>,
    /// Branch and tag names pointing here, already stripped of `refs/heads/`.
    /// Empty for the great majority of commits.
    pub refs: Vec<String>,
}

/// The unit separator, as the field delimiter inside one log record.
///
/// A commit summary can contain anything a person can type, including tabs,
/// pipes, and whatever else would otherwise look like a delimiter. `0x1f` is
/// the one byte a commit message effectively cannot contain, which is why git's
/// own porcelain-consuming examples reach for it.
const FIELD: char = '\u{1f}';

/// The local branches of this cluster's repository as one graph, newest first.
///
/// `--branches` rather than `--all`: remote-tracking refs and tags would triple
/// the row count to draw history nobody in this window is working on, and the
/// drift that does matter is already reported as ahead/behind on the status.
///
/// `--date-order` rather than the default: it keeps a commit's children above
/// it while still interleaving parallel branches by time, which is what makes
/// the column layout stable as new commits land. Topological order would jump
/// whole branches around on every fetch.
///
/// An empty list — never an error — for a cluster with no project, a project
/// that is not a repository, and a repository with no commits yet. All three
/// draw the same empty state.
#[tauri::command]
pub fn git_graph(app: AppHandle, cluster_id: String, limit: u32) -> Result<Vec<GitCommit>> {
    // Resolved the way `git_cluster_status` and `git_branches` resolve, through
    // the cluster's working root, so the graph reads the repository the rest of
    // the panel is showing. `main_repo_root` then steps to the checkout that
    // owns the object database, which is the same repository for every
    // worktree.
    let Some(working) = crate::project::cluster_path(&app, &cluster_id) else {
        return Ok(Vec::new());
    };
    let Some(root) = main_repo_root(&working) else {
        return Ok(Vec::new());
    };

    graph_in(&root, limit)
}

/// The body of `git_graph`, once its cluster has become a directory.
///
/// A failing `git log` is an error the panel shows, not an empty list. It was
/// swallowed into `Vec::new()` before, which drew a repository with thousands
/// of commits as "No commits" and gave nobody a reason to look for the cause.
/// The one failure that is an honest empty is a repository with no commits.
fn graph_in(root: &Path, limit: u32) -> Result<Vec<GitCommit>> {
    // Built here because `run_git` borrows its arguments and a temporary
    // formatted inside the call would not outlive it.
    let format = format!("--format=%H{FIELD}%h{FIELD}%s{FIELD}%an{FIELD}%at{FIELD}%P{FIELD}%D");
    let max = format!("--max-count={limit}");

    // `--decorate-refs` is doing real work, not tidying. `--branches` limits
    // which commits are *walked*, but `%D` decorates whatever it reaches with
    // every ref pointing at it, so without this `origin/main` appears as a
    // badge on a graph that is supposed to be local branches only. Filtering by
    // name afterwards is impossible: a local branch may be called `origin/main`.
    let result = run_git(
        root,
        "log",
        &[
            "log",
            "--branches",
            "--date-order",
            "--decorate-refs=refs/heads/",
            &max,
            &format,
        ],
    );

    let out = match result {
        Ok(out) => out,
        // A repository someone just ran `git init` in has no history to draw.
        Err(AppError::Git { reason, .. }) if reason.contains("does not have any commits") => {
            return Ok(Vec::new())
        }
        Err(err) => return Err(err),
    };

    Ok(out.lines().filter_map(parse_commit).collect())
}

/// One `--format` line into a commit, or `None` if it is not one.
///
/// Skipping a malformed line rather than failing the whole call, for the reason
/// the worktree parser gives: one unreadable record is not a reason to draw no
/// history at all.
fn parse_commit(line: &str) -> Option<GitCommit> {
    let mut fields = line.split(FIELD);

    let sha = fields.next()?.to_string();
    let short = fields.next()?.to_string();
    let summary = fields.next()?.to_string();
    let author = fields.next()?.to_string();
    let when = fields.next()?.parse().ok()?;
    let parents = fields.next()?;
    let refs = fields.next().unwrap_or_default();

    if sha.is_empty() {
        return None;
    }

    Some(GitCommit {
        sha,
        short,
        summary,
        author,
        when,
        // `split_whitespace` rather than `split(' ')`: `%P` is empty for a root
        // commit, and splitting an empty string on a space yields one empty
        // entry rather than none.
        parents: parents.split_whitespace().map(str::to_string).collect(),
        refs: parse_refs(refs),
    })
}

/// `%D`'s comma-separated decoration list into plain ref names.
///
/// Remote refs and tags are already excluded by `--decorate-refs` at the call
/// site, so what arrives here is local branch names — but git writes this field
/// for human eyes and two shapes still survive that filter in some versions:
/// `HEAD -> main` for the checked-out branch, and a bare `HEAD`. The arrow form
/// is unwrapped to the branch it names, and a bare `HEAD` is dropped entirely:
/// which branch is checked out is a *per-worktree* fact and this graph spans
/// several worktrees at once, so one `HEAD` badge would silently be reporting
/// whichever of them happened to answer.
///
/// The `tag:` strip is kept as belt and braces. It cannot fire under the
/// current call site, and costs one `strip_prefix` if that filter is ever
/// loosened.
fn parse_refs(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|r| !r.is_empty() && *r != "HEAD")
        .map(|r| {
            let named = r.split_once("HEAD -> ").map(|(_, b)| b).unwrap_or(r);
            named.strip_prefix("tag: ").unwrap_or(named).to_string()
        })
        .collect()
}

// --- moving the checkout -------------------------------------------------------
//
// The two commands a person needs to leave the branch they are on: what the
// branches are, and go to one. Both are about the *checkout* rather than the
// index, which is why the frontend reaches them through `WorktreeControl` and
// not through `GitControl` — see the split documented on those two interfaces.
//
// Nothing here creates a branch. `git_worktree_create` is the one command in
// this module that does, and it does it by cutting a worktree; a second way to
// arrive at a branch that does not also give it somewhere to live would be a
// second answer to a question the shell has already settled.

/// One local branch, for the picker in the source-control panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// Short name — `feat/x`, not `refs/heads/feat/x`.
    pub name: String,
    /// The commit it points at, full length, so it can be matched against
    /// `GitCommit.sha` without either side abbreviating first.
    pub head: String,
    /// Checked out by the worktree the asking cluster is working in.
    pub current: bool,
    /// The path of *another* worktree holding this branch, when one does.
    ///
    /// Present because git refuses to check a branch out twice, and a picker
    /// that only found that out by trying would report the refusal as an error
    /// after the click. Absent for the branch that is `current`: a branch is
    /// not "held elsewhere" by the checkout doing the asking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
}

/// Every local branch of this cluster's repository, most recently committed to first.
///
/// Ordered by `committerdate` rather than by name, because the answer to "which branch do I want"
/// is nearly always one of the handful most recently touched, and an alphabetical list buries those
/// among every branch ever created.
///
/// Local only, matching `git_graph` — the picker offers what can be checked out, and checking out a
/// remote-tracking ref detaches HEAD rather than putting you on a branch.
///
/// An empty list rather than an error for a cluster with no project, a project that is not a
/// repository, and a repository with no commits yet. The picker draws the same thing for all three.
#[tauri::command]
pub fn git_branches(app: AppHandle, cluster_id: String) -> Result<Vec<GitBranch>> {
    let Some(working) = crate::project::cluster_path(&app, &cluster_id) else {
        return Ok(Vec::new());
    };
    let Some(root) = repo_root(&working) else {
        return Ok(Vec::new());
    };

    let format = format!("--format=%(refname:short){FIELD}%(objectname){FIELD}%(HEAD)");
    let Ok(out) = run_git(
        &root,
        "for-each-ref",
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format,
            "refs/heads",
        ],
    ) else {
        return Ok(Vec::new());
    };

    // Which branch each *other* worktree holds. `worktrees` is pointed at the
    // main checkout on purpose (see `main_repo_root`), so this covers every
    // checkout of the repository and not only the one asking.
    let held = worktrees(&root).unwrap_or_default();
    let root_text = root.to_string_lossy().replace('\\', "/");

    Ok(out
        .lines()
        .filter_map(parse_branch_line)
        .map(|mut branch| {
            branch.worktree = held
                .iter()
                .find(|w| w.branch.as_deref() == Some(&branch.name) && w.path != root_text)
                .map(|w| w.path.clone());
            branch
        })
        .collect())
}

/// One `for-each-ref` record into a branch, or `None` if it is not one.
///
/// `%(HEAD)` is git's own marker for the checked-out branch: `*` for it and a
/// single space for every other. Compared trimmed, because the space is what
/// distinguishes them and trimming leaves the empty string.
fn parse_branch_line(line: &str) -> Option<GitBranch> {
    let mut fields = line.split(FIELD);
    let name = fields.next()?.to_string();
    let head = fields.next()?.to_string();
    let current = fields.next().unwrap_or_default().trim() == "*";

    if name.is_empty() {
        return None;
    }

    Some(GitBranch {
        name,
        head,
        current,
        worktree: None,
    })
}

/// Move this cluster's checkout onto `target` — a local branch, or any commit-ish when `detach`.
///
/// **Nothing here second-guesses git's refusals, and that is the whole safety model.** A checkout
/// that would overwrite uncommitted work, a branch another worktree already holds, a target that
/// does not resolve: git declines each with a message written for whoever typed it, and
/// `AppError::Git` carries those words through unaltered. Pre-checking any of them here would mean
/// maintaining a second, worse copy of git's rules and would still race the filesystem between the
/// check and the command.
///
/// `--detach` is passed rather than inferred from the shape of `target`, because a forty-character
/// hex string is a legal branch name and guessing wrong would silently detach a person who asked
/// for a branch. The caller knows which of the two it is offering: a name out of `git_branches`, or
/// a sha out of the commit graph.
///
/// Deliberately not `git switch`. `checkout` is the verb every version of git in circulation
/// understands, and this module's contract with the user's own `git` is that it uses commands their
/// installation already has.
#[tauri::command]
pub fn git_checkout(
    app: AppHandle,
    cluster_id: String,
    target: String,
    detach: bool,
) -> Result<()> {
    crate::environments::guard_cluster_write(&app, &cluster_id, "checkout")?;
    let cwd = cluster_checkout(&app, &cluster_id, "checkout")?;

    let mut args = vec!["checkout"];
    if detach {
        args.push("--detach");
    }
    // A *trailing* `--`, which is the form that means "everything before this
    // was a revision" — the leading form means the opposite, that everything
    // after it is a pathspec, and `git checkout -- main` restores a file called
    // `main` rather than switching to the branch. Without either, a repository
    // holding both a `README` file and a `README` branch leaves git to guess.
    args.extend([target.as_str(), "--"]);
    run_git(&cwd, "checkout", &args)?;
    Ok(())
}

// --- parsing -----------------------------------------------------------------

/// `git rev-list --left-right --count HEAD...@{u}` prints two counts separated
/// by a tab: commits only on the left side (ahead) and only on the right
/// (behind).
fn parse_ahead_behind(out: &str) -> Option<(u32, u32)> {
    let mut counts = out.split_whitespace();
    let ahead = counts.next()?.parse().ok()?;
    let behind = counts.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Split `git status --porcelain=v1 -z` into the staged and unstaged lists.
///
/// Each entry is `XY<space>PATH\0`, where `X` is what the index says and `Y` is
/// what the working tree says. Renames and copies carry a second
/// NUL-terminated field with the *old* path, immediately after the new one —
/// with `-z` there is no literal `->` separator, which is the whole reason for
/// using `-z` over the human-readable form (that, and paths never being quoted
/// or escaped).
///
/// A path can be changed in the index *and* changed again on disk, in which
/// case both `X` and `Y` are set and the path is emitted into both lists. They
/// are two different diffs and the user has to be able to click either.
fn parse_porcelain(out: &str) -> (Vec<GitFileChange>, Vec<GitFileChange>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    // A plain iterator rather than a `for` loop over the split: a rename entry
    // has to reach forward and consume the following field itself.
    let mut fields = out.split('\0').filter(|field| !field.is_empty());

    while let Some(entry) = fields.next() {
        let mut codes = entry.chars();
        let (Some(x), Some(y)) = (codes.next(), codes.next()) else {
            continue;
        };
        // Byte-indexed past `XY<space>`, which is safe because all three are
        // ASCII whatever the path turns out to be.
        let Some(path) = entry.get(3..) else { continue };

        let renamed_from = if is_rename(x) || is_rename(y) {
            fields.next().map(str::to_string)
        } else {
            None
        };

        // `??` is untracked, and untracked is a working-tree fact only — the
        // leading `?` is not a claim about the index, so it must not produce a
        // staged row.
        if x == '?' {
            unstaged.push(change(path, GitChangeKind::Untracked, false, None));
            continue;
        }

        if let Some(kind) = kind_for(x) {
            let from = rename_source(kind, &renamed_from);
            staged.push(change(path, kind, true, from));
        }
        if let Some(kind) = kind_for(y) {
            let from = rename_source(kind, &renamed_from);
            unstaged.push(change(path, kind, false, from));
        }
    }

    (staged, unstaged)
}

fn is_rename(code: char) -> bool {
    code == 'R' || code == 'C'
}

fn rename_source(kind: GitChangeKind, renamed_from: &Option<String>) -> Option<String> {
    matches!(kind, GitChangeKind::Renamed)
        .then(|| renamed_from.clone())
        .flatten()
}

/// One status letter to one kind. `' '` (unchanged on that side) and `'!'`
/// (ignored, which only appears with `--ignored`) map to nothing, which is how
/// the caller decides a side has no row to emit.
fn kind_for(code: char) -> Option<GitChangeKind> {
    match code {
        'M' | 'T' => Some(GitChangeKind::Modified),
        'A' => Some(GitChangeKind::Added),
        'D' => Some(GitChangeKind::Deleted),
        'R' | 'C' => Some(GitChangeKind::Renamed),
        '?' => Some(GitChangeKind::Untracked),
        'U' => Some(GitChangeKind::Conflicted),
        _ => None,
    }
}

fn change(
    path: &str,
    kind: GitChangeKind,
    staged: bool,
    renamed_from: Option<String>,
) -> GitFileChange {
    let (dir, file) = match path.rsplit_once('/') {
        Some((dir, file)) => (dir.to_string(), file.to_string()),
        None => (String::new(), path.to_string()),
    };

    GitFileChange {
        path: path.to_string(),
        file,
        dir,
        kind,
        staged,
        renamed_from,
        // Filled in afterwards by `attach_line_counts`, which needs a `git
        // diff` this function has no directory to run. `None` is the honest
        // value until then and the permanent one for anything that diff does
        // not report.
        insertions: None,
        deletions: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Commands that change the repository, the index or `HEAD`, and so must
    /// open with `guard_cluster_write`. Deliberately excluded from this list
    /// and named in the next: `git_worktree_create`, which makes a new
    /// checkout rather than writing to the cluster's own.
    const GUARDED: &[&str] = &[
        "git_cluster_stage",
        "git_cluster_unstage",
        "git_cluster_commit",
        "git_checkout",
        "git_worktree_remove",
    ];

    /// Commands that only read, or whose write is the escape hatch.
    const UNGUARDED: &[&str] = &[
        "git_cluster_status",
        "git_cluster_diff",
        "git_worktrees",
        "git_worktree_create",
        "git_worktree_reconcile",
        "git_hunks",
        "git_head_text",
        "git_divergence",
        "git_divergence_diff",
        "git_graph",
        "git_branches",
    ];

    /// The body of a `#[tauri::command] pub fn <name>` in this file's own
    /// source, up to the next command. `app` is not constructible in a unit
    /// test (there is no mock runtime for `Wry`), so the guard is checked in
    /// the source instead of by calling the command.
    fn command_body(name: &str) -> &'static str {
        let source = include_str!("git.rs");
        let head = format!("pub fn {name}(");
        let start = source.find(&head).unwrap_or_else(|| panic!("no {name}"));
        let rest = &source[start..];
        let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
        &rest[..end]
    }

    /// Runs `git` in `dir` for a fixture, panicking with git's own message.
    fn fixture_git(dir: &Path, args: &[&str]) {
        let out = git_command()
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn graph_lists_local_branch_commits_newest_first_with_refs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        fixture_git(p, &["init", "-q", "-b", "trunk"]);
        fixture_git(p, &["commit", "-q", "--allow-empty", "-m", "first"]);
        fixture_git(p, &["checkout", "-q", "-b", "feature"]);
        fixture_git(
            p,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "second

body line",
            ],
        );

        let commits = graph_in(p, 50).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].summary, "second");
        assert_eq!(commits[0].parents, vec![commits[1].sha.clone()]);
        assert!(commits[0].refs.iter().any(|r| r.contains("feature")));
        assert!(commits[1].refs.contains(&"trunk".to_string()));
    }

    #[test]
    fn graph_of_a_repository_with_no_commits_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        fixture_git(dir.path(), &["init", "-q"]);
        assert!(graph_in(dir.path(), 50).unwrap().is_empty());
    }

    #[test]
    fn graph_reports_a_git_failure_instead_of_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        // Not a repository: git log fails, and that must surface.
        assert!(graph_in(dir.path(), 50).is_err());
    }

    #[test]
    fn every_guarded_git_command_refuses_main_first() {
        for name in GUARDED {
            let body = command_body(name);
            let guard = body
                .find("guard_cluster_write(")
                .unwrap_or_else(|| panic!("{name} does not call guard_cluster_write"));
            let first_git = body.find("cluster_checkout(").unwrap_or(body.len());
            assert!(guard < first_git, "{name} touches git before its guard");
        }
    }

    /// Where [`git_init_where_it_was_asked`] runs `git init`, set by the test
    /// that starts it.
    const INIT_HERE: &str = "VEISTRA_TEST_GIT_INIT_HERE";

    /// The bug: run under `git rebase --exec`, this crate's tests inherited
    /// `GIT_DIR`, and a fixture's `git init` in a temp folder set `core.bare`
    /// on the developer's own repository instead. Here a copy of this test
    /// binary inherits `GIT_DIR` naming a decoy, as those tests did, and runs
    /// `git init` through [`git_command`]. `GIT_DIR` goes on that copy rather
    /// than on this process, which every other test running beside it shares.
    #[test]
    fn a_git_child_ignores_the_repository_its_parent_names() {
        let decoy = tempfile::tempdir().unwrap();
        fixture_git(decoy.path(), &["init", "-q"]);
        let here = tempfile::tempdir().unwrap();

        let test = "git::tests::git_init_where_it_was_asked";
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--ignored", "--test-threads=1"])
            .env("GIT_DIR", decoy.path().join(".git"))
            .env(INIT_HERE, here.path())
            .output()
            .unwrap();
        let report = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{report}");
        assert!(report.contains("1 passed"), "{report}");

        assert!(here.path().join(".git").is_dir(), "git init went elsewhere");
        let bare = git_command()
            .current_dir(decoy.path())
            .args(["config", "core.bare"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&bare.stdout).trim(), "false");
    }

    /// Run only by [`a_git_child_ignores_the_repository_its_parent_names`], in
    /// a process of its own; on its own it does nothing.
    #[test]
    #[ignore = "started by a_git_child_ignores_the_repository_its_parent_names"]
    fn git_init_where_it_was_asked() {
        let Some(here) = std::env::var_os(INIT_HERE) else {
            return;
        };
        let out = git_command()
            .current_dir(here)
            .args(["init", "-q"])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "{stderr}");
    }

    /// [`REPOSITORY_ENV`] is copied from git, so a git that names a new one
    /// fails here rather than quietly passing it on. The two `-c` names are
    /// kept on purpose; see [`REPOSITORY_ENV`].
    #[test]
    fn git_command_clears_every_variable_git_names() {
        let out = git_command()
            .args(["rev-parse", "--local-env-vars"])
            .output()
            .expect("git runs");
        assert!(out.status.success());
        let kept = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];
        for name in String::from_utf8_lossy(&out.stdout).lines() {
            assert!(
                REPOSITORY_ENV.contains(&name) || kept.contains(&name),
                "REPOSITORY_ENV lacks {name}"
            );
        }
        let command = git_command();
        let cleared: Vec<_> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        for name in REPOSITORY_ENV {
            assert!(
                cleared.iter().any(|k| k == name),
                "git_command keeps {name}"
            );
        }
    }

    /// Every `git` this crate spawns takes the cleared environment, so a new
    /// spawn written the old way, in a test fixture or not, fails here.
    #[test]
    fn every_git_spawn_starts_from_git_command() {
        let spawn = ["Command::new(", "\"git\")"].concat();
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets it");
        let src = PathBuf::from(manifest).join("src");
        let mut dirs = vec![src.clone()];
        let mut found = Vec::new();
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let lines = text.lines().enumerate();
                    for (n, _) in lines.filter(|(_, l)| l.contains(&spawn)) {
                        found.push((path.clone(), n + 1));
                    }
                }
            }
        }
        assert_eq!(
            found.len(),
            1,
            "spawn git through git_command(): {found:#?}"
        );
        assert_eq!(found[0].0, src.join("git.rs"), "{found:#?}");
    }

    /// A new `git_*` command has to be put in one of the two lists above, which
    /// is the moment someone decides whether it writes.
    #[test]
    fn every_git_command_is_classified() {
        let source = include_str!("git.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        for line in production.lines() {
            if let Some(rest) = line.strip_prefix("pub fn git_") {
                let name = format!("git_{}", rest.split('(').next().unwrap());
                assert!(
                    GUARDED.contains(&name.as_str()) || UNGUARDED.contains(&name.as_str()),
                    "{name} is not classified as guarded or read-only in git.rs tests"
                );
            }
        }
    }

    /// The decision the guard makes, for the family: main used to refuse
    /// every op name these commands use; now main, a worktree and an unset
    /// environment all allow it, so staging and committing work on main.
    #[test]
    fn git_write_ops_run_on_main_as_on_a_worktree() {
        use crate::environments::{refuse_read_only_write, Environment};
        let worktree = Environment::LocalWorktree {
            name: "x".to_string(),
            path: "C:/wt/x".to_string(),
            branch: "wt/x".to_string(),
            base: "main".to_string(),
        };
        for op in ["add", "restore", "commit", "checkout", "worktree remove"] {
            assert!(refuse_read_only_write(Some(&Environment::Main), op).is_ok());
            assert!(refuse_read_only_write(Some(&worktree), op).is_ok());
            assert!(refuse_read_only_write(None, op).is_ok());
        }
    }

    /// The shapes below are copied from real `git` output rather than written
    /// by hand: every one was produced by running the command in the doc
    /// comment against a scratch repository, with `\0` written out.
    #[test]
    fn numstat_z_reads_an_ordinary_change() {
        let records = parse_numstat_z("12\t3\tsrc/a.rs\0");
        assert_eq!(records, vec![("src/a.rs".to_string(), (Some(12), Some(3)))]);
    }

    /// The bug this guards: `--numstat -z` spends the third column on nothing
    /// for a rename and follows the record with the two paths, source first.
    /// Reading the empty column as the path attributed every renamed file's
    /// counts to `""`, so no row in the panel ever matched one.
    #[test]
    fn numstat_z_reads_a_rename_under_its_destination() {
        let records = parse_numstat_z("0\t0\t\0src/a.txt\0src/renamed.txt\0");
        assert_eq!(
            records,
            vec![("src/renamed.txt".to_string(), (Some(0), Some(0)))]
        );
    }

    /// A binary file is marked with a bare `-` in each count rather than being
    /// left out, so the path is known and the numbers are not.
    #[test]
    fn numstat_z_reads_a_binary_file_as_no_counts() {
        let records = parse_numstat_z("-\t-\tassets/logo.png\0");
        assert_eq!(records, vec![("assets/logo.png".to_string(), (None, None))]);
    }

    #[test]
    fn numstat_z_reads_a_mixed_stream() {
        // Assembled from one literal per NUL-terminated field rather than
        // written as a single string, so that a `\0` followed by a digit is
        // unambiguously a separator and a digit.
        let stream = [
            "-\t-\tbin.dat\0",
            "0\t0\t\0",
            "src/a.txt\0",
            "src/b.txt\0",
            "9\t1\tsrc/c.rs\0",
        ]
        .concat();
        let records = parse_numstat_z(&stream);
        assert_eq!(
            records,
            vec![
                ("bin.dat".to_string(), (None, None)),
                ("src/b.txt".to_string(), (Some(0), Some(0))),
                ("src/c.rs".to_string(), (Some(9), Some(1))),
            ]
        );
    }

    #[test]
    fn numstat_z_of_an_empty_diff_is_empty() {
        assert!(parse_numstat_z("").is_empty());
    }

    /// The trailing NUL after the last record leaves an empty field, and a
    /// rename record reaches forward for two more. Reading that empty field as
    /// the destination filed a change under `""`, which no row can match.
    #[test]
    fn numstat_z_drops_a_rename_missing_its_destination() {
        let truncated = ["0\t0\t\0", "src/a.txt\0"].concat();
        assert!(parse_numstat_z(&truncated).is_empty());
    }

    /// The regression behind the staged-rename diff: `parse_porcelain` names a
    /// renamed row for its destination, which is the one path `HEAD` does not
    /// have, so `git_cluster_diff` drew the whole file as added. Finding the
    /// source is what gives that diff a left-hand side.
    #[test]
    fn rename_pairs_read_source_then_destination() {
        let pairs = parse_rename_pairs("R100\0src/a.txt\0src/renamed.txt\0");
        assert_eq!(
            pairs,
            vec![("src/a.txt".to_string(), "src/renamed.txt".to_string())]
        );
    }

    #[test]
    fn rename_pairs_read_several_records() {
        let pairs = parse_rename_pairs("R100\0a\0b\0R087\0c/d\0c/e\0");
        assert_eq!(
            pairs,
            vec![
                ("a".to_string(), "b".to_string()),
                ("c/d".to_string(), "c/e".to_string()),
            ]
        );
    }

    /// A truncated record is dropped rather than panicking or inventing a path,
    /// matching every other parser in this module.
    #[test]
    fn rename_pairs_drop_a_record_missing_its_destination() {
        assert!(parse_rename_pairs("R100\0src/a.txt\0").is_empty());
    }

    #[test]
    fn branch_line_reads_the_checked_out_marker() {
        let line = format!("main{FIELD}c3dc7dc{FIELD}*");
        let branch = parse_branch_line(&line).expect("a well-formed record parses");
        assert_eq!(branch.name, "main");
        assert_eq!(branch.head, "c3dc7dc");
        assert!(branch.current);
        assert_eq!(branch.worktree, None);
    }

    /// `%(HEAD)` is a single space for a branch that is not checked out, which
    /// is why the comparison trims rather than testing for emptiness.
    #[test]
    fn branch_line_reads_an_unchecked_out_branch() {
        let line = format!("feat/x{FIELD}9f1e2d3{FIELD} ");
        let branch = parse_branch_line(&line).expect("a well-formed record parses");
        assert_eq!(branch.name, "feat/x");
        assert!(!branch.current);
    }

    #[test]
    fn branch_line_rejects_a_nameless_record() {
        assert!(parse_branch_line("").is_none());
        assert!(parse_branch_line(&format!("{FIELD}abc{FIELD}*")).is_none());
    }
}
