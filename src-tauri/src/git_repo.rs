//! What kind of git repository a project folder is in, which branch is its default, and
//! how to give a folder one.
//!
//! Worktree clusters need a repository **with at least one commit**: `git worktree add -b`
//! forks from a commit, and an unborn branch has none. A project made from a plain folder
//! had neither, and the first sign was a raw `git` error from the New Cluster dialog. This
//! module answers the question up front ([`repo_state`]) and fixes it on request
//! ([`init_repository`]).
//!
//! The default branch is resolved here once ([`default_branch`]) and nowhere else. The
//! shell used to write `"main"` at the point of use, which worked until a repository whose
//! only branch was `master`.

use crate::error::{AppError, Result};
use crate::git::{repo_root, run_git_env};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Whether a folder can have worktree clusters made from it, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RepoState {
    /// Not inside any git repository.
    NotARepo,
    /// A repository exists but has no commits, so there is nothing to fork a worktree from.
    /// `root` is the repository's top, which is the folder itself unless it is a parent.
    #[serde(rename_all = "camelCase")]
    NoCommits { root: String, nested: bool },
    /// A repository with at least one commit.
    Ready,
}

/// How `dir` stands, asked of the repository `git` finds from it.
pub fn repo_state(dir: &Path) -> RepoState {
    repo_state_with(dir, &[])
}

fn repo_state_with(dir: &Path, env: &[(&str, &str)]) -> RepoState {
    let Some(top) = repo_root(dir) else {
        return RepoState::NotARepo;
    };
    if has_commits(&top, env) {
        return RepoState::Ready;
    }
    RepoState::NoCommits {
        nested: !same_folder(&top, dir),
        root: top.display().to_string(),
    }
}

/// Whether the repository at `repo` has a commit to fork from.
pub fn has_commits_in(repo: &Path) -> bool {
    has_commits(repo, &[])
}

fn has_commits(repo: &Path, env: &[(&str, &str)]) -> bool {
    run_git_env(
        repo,
        "rev-parse",
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        env,
    )
    .is_ok()
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    let reference = format!("refs/heads/{branch}");
    run_git_env(
        repo,
        "show-ref",
        &["show-ref", "--verify", "--quiet", &reference],
        &[],
    )
    .is_ok()
}

/// The repository's default branch, resolved in this order:
///
/// 1. the remote's `HEAD` (`refs/remotes/origin/HEAD`), as the local branch of that name
///    when there is one and `origin/<name>` otherwise (either is a valid fork point);
/// 2. `main`, if that local branch exists;
/// 3. `master`, if that local branch exists;
/// 4. whatever branch is checked out, the only honest answer for a repository that has
///    neither.
///
/// `None` only when even that is unknown (a detached `HEAD` with no conventional branch).
/// A repository with no commits still answers with its unborn branch's name; callers that
/// need a commit check [`repo_state`] first.
pub fn default_branch(repo: &Path) -> Option<String> {
    if let Ok(out) = run_git_env(
        repo,
        "symbolic-ref",
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        &[],
    ) {
        if let Some(name) = out.trim().strip_prefix("origin/") {
            if !name.is_empty() {
                return Some(if branch_exists(repo, name) {
                    name.to_string()
                } else {
                    format!("origin/{name}")
                });
            }
        }
    }
    for candidate in ["main", "master"] {
        if branch_exists(repo, candidate) {
            return Some(candidate.to_string());
        }
    }
    current_branch(repo, &[])
}

/// What [`init_repository`] did, for the sentence shown afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitOutcome {
    /// The branch the first commit landed on, as `init.defaultBranch` named it.
    pub branch: Option<String>,
    /// `false` when the folder was too large to commit blindly and only the manifest and
    /// `.gitignore` went into the first commit.
    pub committed_everything: bool,
}

/// More than this many untracked files, or any one over [`MAX_FILE_BYTES`], or this many
/// bytes in all, and the first commit takes only the project's own files.
const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

/// The lines a freshly written `.gitignore` starts with. `.veistra/worktrees/` is the one
/// that matters: worktree clusters live inside the project, and committing a checkout into
/// the repository it belongs to would nest one inside the other.
const IGNORE_LINES: &[&str] = &["node_modules/", "target/", ".veistra/worktrees/"];

/// Give `dir` a git repository with a first commit, so a worktree can be cut from it.
pub fn init_repository(dir: &Path) -> Result<InitOutcome> {
    init_repository_with(dir, &[])
}

/// [`init_repository`] with extra environment for every `git` it runs; the tests' way of
/// choosing the identity and the global config without touching the process's own.
pub(crate) fn init_repository_with(dir: &Path, env: &[(&str, &str)]) -> Result<InitOutcome> {
    match repo_state_with(dir, env) {
        RepoState::Ready => {
            return Ok(InitOutcome {
                branch: current_branch(dir, env),
                committed_everything: true,
            });
        }
        RepoState::NoCommits { root, nested: true } => {
            return Err(AppError::Repo(format!(
                "This folder is inside the git repository at {root}, which has no commits yet. \
                 Make its first commit there rather than starting a second repository here."
            )));
        }
        RepoState::NoCommits { .. } | RepoState::NotARepo => {}
    }
    // `NotARepo` means no parent is a repository either, which is the refusal to init
    // inside one: `git init` would happily nest a second repository.

    if let Some(missing) = identity_problem(dir, env) {
        return Err(AppError::Repo(format!(
            "Git does not know {missing}, so it cannot make the first commit. Set it once \
             with `git config --global user.name \"Your Name\"` and \
             `git config --global user.email \"you@example.com\"`, then try again."
        )));
    }

    if repo_root(dir).is_none() {
        run_git_env(dir, "init", &["init", "--quiet"], env)?;
    }
    write_gitignore(dir)?;

    let everything = small_enough(dir, env);
    if everything {
        run_git_env(dir, "add", &["add", "-A"], env)?;
    } else {
        let mut names = vec![".gitignore".to_string()];
        names.extend(manifest_names(dir));
        let mut args = vec!["add", "--"];
        args.extend(names.iter().map(String::as_str));
        run_git_env(dir, "add", &args, env)?;
    }
    run_git_env(
        dir,
        "commit",
        &["commit", "--quiet", "--allow-empty", "-m", "Initial commit"],
        env,
    )?;

    Ok(InitOutcome {
        branch: current_branch(dir, env),
        committed_everything: everything,
    })
}

fn current_branch(dir: &Path, env: &[(&str, &str)]) -> Option<String> {
    run_git_env(
        dir,
        "symbolic-ref",
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        env,
    )
    .ok()
    .map(|out| out.trim().to_string())
    .filter(|name| !name.is_empty())
}

/// The first of `user.name` / `user.email` git would refuse to commit without, as a phrase.
/// Environment overrides count, as they do for git itself; no identity is ever invented.
fn identity_problem(dir: &Path, env: &[(&str, &str)]) -> Option<&'static str> {
    let from_env = |name: &str| {
        env.iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| !v.is_empty())
            .unwrap_or_else(|| std::env::var(name).is_ok_and(|v| !v.is_empty()))
    };
    let has = |key: &str, vars: &[&str]| {
        vars.iter().any(|v| from_env(v))
            || run_git_env(dir, "config", &["config", "--get", key], env)
                .is_ok_and(|out| !out.trim().is_empty())
    };
    if !has("user.name", &["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) {
        return Some("your name");
    }
    if !has("user.email", &["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) {
        return Some("your email address");
    }
    None
}

/// Create `.gitignore` with [`IGNORE_LINES`], or add whichever of them an existing one lacks.
fn write_gitignore(dir: &Path) -> Result<()> {
    let path = dir.join(".gitignore");
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(source) => {
            return Err(AppError::Io {
                path: path.display().to_string(),
                source,
            })
        }
    };
    let have: Vec<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = IGNORE_LINES
        .iter()
        .copied()
        .filter(|line| !have.contains(line))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for line in missing {
        text.push_str(line);
        text.push('\n');
    }
    std::fs::write(&path, text).map_err(|source| AppError::Io {
        path: path.display().to_string(),
        source,
    })
}

/// Whether everything git would add is small enough to commit without asking, counted from
/// `git ls-files --others --exclude-standard`, which already honours the `.gitignore` just
/// written. Unreadable sizes count as fine; the limits guard against a mistake, not a quota.
fn small_enough(dir: &Path, env: &[(&str, &str)]) -> bool {
    let Ok(listing) = run_git_env(
        dir,
        "ls-files",
        &["ls-files", "--others", "--exclude-standard", "-z"],
        env,
    ) else {
        return true;
    };
    let mut files = 0usize;
    let mut total = 0u64;
    for name in listing.split('\0').filter(|n| !n.is_empty()) {
        files += 1;
        let size = std::fs::metadata(dir.join(name)).map_or(0, |m| m.len());
        total += size;
        if files > MAX_FILES || size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
            return false;
        }
    }
    true
}

/// The project's own manifest files at the folder's top: `<name>.veistra`.
fn manifest_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".veistra"))
        .collect()
}

fn same_folder(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| -> PathBuf { p.canonicalize().unwrap_or_else(|_| p.to_path_buf()) };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: &[(&str, &str)] = &[
        ("GIT_AUTHOR_NAME", "t"),
        ("GIT_AUTHOR_EMAIL", "t@example.com"),
        ("GIT_COMMITTER_NAME", "t"),
        ("GIT_COMMITTER_EMAIL", "t@example.com"),
    ];

    /// Environment with no identity and no user configuration at all, plus
    /// `init.defaultBranch` set to `branch` through a config file of its own.
    fn blank_config(dir: &Path, branch: &str) -> Vec<(String, String)> {
        let file = dir.join("gitconfig");
        std::fs::write(&file, format!("[init]\n\tdefaultBranch = {branch}\n")).unwrap();
        vec![
            ("GIT_CONFIG_GLOBAL".into(), file.display().to_string()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ]
    }

    fn as_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::git::git_command()
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}");
    }

    /// A repository whose only branch is `master`, with one commit.
    fn master_only() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "master"]);
        git(
            dir.path(),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        dir
    }

    #[test]
    fn the_default_branch_of_a_master_only_repository_is_master() {
        let dir = master_only();
        assert_eq!(default_branch(dir.path()).as_deref(), Some("master"));
    }

    #[test]
    fn main_wins_over_master_when_both_exist() {
        let dir = master_only();
        git(dir.path(), &["branch", "main"]);
        assert_eq!(default_branch(dir.path()).as_deref(), Some("main"));
    }

    #[test]
    fn a_branch_that_is_neither_falls_back_to_the_checked_out_one() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "trunk"]);
        git(
            dir.path(),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        assert_eq!(default_branch(dir.path()).as_deref(), Some("trunk"));
    }

    #[test]
    fn the_remote_head_is_preferred_over_a_local_main() {
        let dir = master_only();
        git(dir.path(), &["branch", "main"]);
        git(dir.path(), &["branch", "develop"]);
        git(
            dir.path(),
            &["remote", "add", "origin", "https://example.invalid/x.git"],
        );
        git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/develop", "master"],
        );
        git(
            dir.path(),
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/develop",
            ],
        );
        assert_eq!(default_branch(dir.path()).as_deref(), Some("develop"));
    }

    #[test]
    fn a_worktree_can_be_cut_from_the_resolved_default_of_a_master_repository() {
        let dir = master_only();
        let base = default_branch(dir.path()).unwrap();
        let env = crate::environments::create_local_worktree(dir.path(), "feat-x", &base)
            .expect("master is a valid fork point");
        assert_eq!(env.branch(), Some("wt/feat-x"));
        assert_eq!(repo_state(dir.path()), RepoState::Ready);
    }

    /// It used to be read-only, like every main checkout; it is writable now.
    #[test]
    fn the_checkout_of_a_master_only_repository_is_main_and_writable() {
        let dir = master_only();
        let env = crate::environments::effective_environment(None, Some(dir.path()));
        assert_eq!(env, Some(crate::environments::Environment::Main));
        assert!(crate::environments::refuse_read_only_write(env.as_ref(), "write").is_ok());
    }

    #[test]
    fn state_tells_a_plain_folder_an_empty_repository_and_a_ready_one_apart() {
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(repo_state(plain.path()), RepoState::NotARepo);

        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "-q"]);
        assert!(matches!(
            repo_state(empty.path()),
            RepoState::NoCommits { nested: false, .. }
        ));

        assert_eq!(repo_state(master_only().path()), RepoState::Ready);
    }

    #[test]
    fn init_makes_a_repository_with_a_first_commit_a_worktree_can_fork_from() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let outcome = init_repository_with(dir.path(), IDENTITY).unwrap();
        assert!(outcome.committed_everything);
        assert_eq!(repo_state(dir.path()), RepoState::Ready);
        let base = default_branch(dir.path()).unwrap();
        crate::environments::create_local_worktree(dir.path(), "feat", &base).unwrap();
    }

    #[test]
    fn init_uses_the_users_default_branch_name() {
        let dir = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let mut env = blank_config(config.path(), "master");
        env.extend(IDENTITY.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let outcome = init_repository_with(dir.path(), &as_refs(&env)).unwrap();
        assert_eq!(outcome.branch.as_deref(), Some("master"));
        assert_eq!(default_branch(dir.path()).as_deref(), Some("master"));
    }

    #[test]
    fn init_writes_a_gitignore_that_keeps_worktrees_out_of_the_commit() {
        let dir = tempfile::tempdir().unwrap();
        init_repository_with(dir.path(), IDENTITY).unwrap();
        let text = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(text.contains(".veistra/worktrees/"));
        assert!(text.contains("node_modules/"));
    }

    #[test]
    fn init_adds_to_an_existing_gitignore_instead_of_replacing_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "secret.txt").unwrap();
        init_repository_with(dir.path(), IDENTITY).unwrap();
        let text = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(text.starts_with("secret.txt\n"));
        assert!(text.contains(".veistra/worktrees/"));
    }

    #[test]
    fn init_inside_an_existing_repository_makes_no_second_one() {
        let parent = master_only();
        let child = parent.path().join("sub");
        std::fs::create_dir(&child).unwrap();
        init_repository_with(&child, IDENTITY).unwrap();
        assert!(!child.join(".git").exists());
    }

    #[test]
    fn init_refuses_to_commit_in_a_parent_repository_that_has_no_commits() {
        let parent = tempfile::tempdir().unwrap();
        git(parent.path(), &["init", "-q"]);
        let child = parent.path().join("sub");
        std::fs::create_dir(&child).unwrap();
        let err = init_repository_with(&child, IDENTITY)
            .unwrap_err()
            .to_string();
        assert!(err.contains("inside the git repository"), "{err}");
        assert!(!child.join(".git").exists());
    }

    #[test]
    fn a_missing_identity_is_a_message_not_a_git_error_and_nothing_is_made() {
        let dir = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let env = blank_config(config.path(), "main");
        let mut refs = as_refs(&env);
        // Blank out any identity the machine's own environment supplies.
        refs.extend([
            ("GIT_AUTHOR_NAME", ""),
            ("GIT_COMMITTER_NAME", ""),
            ("GIT_AUTHOR_EMAIL", ""),
            ("GIT_COMMITTER_EMAIL", ""),
        ]);
        let err = init_repository_with(dir.path(), &refs)
            .unwrap_err()
            .to_string();
        assert!(err.contains("git config --global user.name"), "{err}");
        assert!(!err.contains("failed"), "{err}");
        assert!(!dir.path().join(".git").exists());
    }

    #[test]
    fn an_existing_empty_repository_gets_its_first_commit_without_a_second_init() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        init_repository_with(dir.path(), IDENTITY).unwrap();
        assert_eq!(repo_state(dir.path()), RepoState::Ready);
    }

    #[test]
    fn a_huge_file_keeps_the_first_commit_to_the_projects_own_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("demo.veistra"), "name = \"demo\"").unwrap();
        let big = std::fs::File::create(dir.path().join("big.bin")).unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();
        let outcome = init_repository_with(dir.path(), IDENTITY).unwrap();
        assert!(!outcome.committed_everything);
        let tracked = run_git_env(dir.path(), "ls-files", &["ls-files"], IDENTITY).unwrap();
        assert!(tracked.contains("demo.veistra"));
        assert!(!tracked.contains("big.bin"));
    }
}
