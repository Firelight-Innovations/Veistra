//! What a cluster's work runs against: a local worktree, a cloud session, the
//! main checkout, or the one standing Design worktree.
//!
//! Before this module, a cluster's only notion of "where" was
//! [`crate::shell_state::WorktreeRef`] — a worktree, or nothing, with
//! "nothing" silently meaning "the project folder itself". That collapsed two
//! different cases (a cluster with no checkout concept at all, and a cluster
//! deliberately browsing the main checkout) into one, and had no way to name
//! a cloud session at all. [`Environment`] replaces the collapse with four
//! named cases — see the variant docs — while [`crate::shell_state::Cluster`]
//! keeps `worktree` for backward compatibility; [`migrate_environment`] is
//! the bridge between the two.

use crate::error::{AppError, Result};
use crate::git;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Where a cluster's work runs.
///
/// Tagged on the wire as `{ "kind": "localWorktree" | "cloud" | "main" | "design", ... }`
/// (camelCase, per this codebase's convention for anything crossing into
/// JSON) so the frontend can switch on `kind` without also having to know
/// which fields go with which — see `src/shell/environment.ts`'s
/// `environmentOf`, the TypeScript-side reader of this same shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Environment {
    /// A second checkout of the project's repository, on its own branch,
    /// created and owned by Veistra under `.veistra/worktrees/<name>`.
    ///
    /// The ordinary case for real work: a cluster on a `LocalWorktree` reads
    /// and writes files nowhere near the project folder, so two clusters can
    /// hold two branches open — and two agents editing — at once without
    /// either one's changes showing up in the other's file tree.
    #[serde(rename_all = "camelCase")]
    LocalWorktree {
        /// The worktree's own name — `feat-x`, not `wt/feat-x` — used as both
        /// its folder name under `.veistra/worktrees/` and, prefixed, its
        /// branch. Kept separate from `branch` because the dialog that
        /// creates one shows this alone; the `wt/` prefix is this module's
        /// convention, not something a user types.
        name: String,
        /// Absolute path to the worktree's checkout.
        path: String,
        /// The branch checked out there — `wt/<name>`.
        branch: String,
        /// The branch this one was forked from, recorded at creation for the
        /// same reason [`crate::shell_state::WorktreeRef::base`] records it:
        /// nothing in git remembers a branch's fork point, and the obvious
        /// guess (whatever the main checkout is on right now) goes stale the
        /// moment somebody switches it.
        base: String,
    },
    /// A session running on a remote VM rather than on this machine at all.
    ///
    /// Deliberately the one variant [`Environment::root`] cannot answer for —
    /// there is no local path, and claiming one (the project's, say) would
    /// have a terminal opened against it silently run commands nowhere near
    /// where the session's agent is actually working. See `root`'s doc for
    /// how callers are expected to handle the `None`.
    #[serde(rename_all = "camelCase")]
    Cloud {
        session_id: String,
        vm: String,
        branch: Option<String>,
    },
    /// The project's own primary checkout, worked in directly.
    ///
    /// The one variant with no payload: "main" names a place — the project
    /// root every cluster already knows how to find — not a resource this
    /// module created and has to remember. It used to be read-only; it is
    /// writable now like every other variant (see [`Environment::is_read_only`]).
    Main,
    /// The standing worktree that hosts the pinned Design canvas cluster —
    /// see `ShellState::add_design_cluster`.
    ///
    /// Structurally identical to `LocalWorktree` and deliberately a separate
    /// variant anyway: "is this cluster the Design canvas" has to be
    /// answerable without comparing a branch name against the string
    /// literal `"wt/design"` everywhere that question comes up, and a cluster
    /// either carries `pinned: true` and a `Design` environment together or
    /// it carries neither — see `Cluster::pinned`'s doc for why that
    /// invariant lives on a separate field instead of being derived from this
    /// one.
    #[serde(rename_all = "camelCase")]
    Design { path: String, branch: String },
}

/// The one worktree name and branch the Design canvas always uses.
const DESIGN_NAME: &str = "design";
const DESIGN_BRANCH: &str = "wt/design";

impl Environment {
    /// Where this environment's files actually are, or `None` for the one
    /// case that honestly has no local answer.
    ///
    /// `project` is the cluster's project folder, needed only for `Main` —
    /// every other variant already carries its own absolute path. Passing it
    /// through rather than having `Main` carry a copy keeps the project's
    /// path the one place it is recorded, per `Cluster::project`'s own doc.
    pub fn root(&self, project: Option<&Path>) -> Option<PathBuf> {
        match self {
            Environment::LocalWorktree { path, .. } => Some(PathBuf::from(path)),
            Environment::Design { path, .. } => Some(PathBuf::from(path)),
            Environment::Main => project.map(Path::to_path_buf),
            // No local path exists to hand back — see the variant's own doc.
            // A caller that needs a terminal's cwd (`project::cluster_path`)
            // has to fall back honestly rather than lying with the project's
            // path, which would run commands nowhere near the cloud session.
            Environment::Cloud { .. } => None,
        }
    }

    pub fn is_main(&self) -> bool {
        matches!(self, Environment::Main)
    }

    /// Whether writes are refused here: the one switch every write guard
    /// ([`refuse_read_only_write`], `apps::write_refusal`), the shell marker
    /// ([`read_only_env`]) and each app's `readOnly` (Files, Canvas, Godot,
    /// Blender) reads.
    ///
    /// No environment is read-only. Main was, until the owner lifted that so
    /// the main checkout is worked in like a worktree. The guards are kept,
    /// keyed on this, so an environment that cannot be written (a remote one,
    /// say) has one place to say so; `is_main` is no longer that question.
    pub fn is_read_only(&self) -> bool {
        false
    }

    /// The wire tag alone (`"localWorktree"`, `"cloud"`, `"main"`, `"design"`),
    /// for an answer that names the kind without the paths that go with it.
    pub fn kind(&self) -> &'static str {
        match self {
            Environment::LocalWorktree { .. } => "localWorktree",
            Environment::Cloud { .. } => "cloud",
            Environment::Main => "main",
            Environment::Design { .. } => "design",
        }
    }

    /// A stable key naming *this* environment, not just its kind — what
    /// `ShellState::project_live_counts` dedups on to turn "N clusters" into
    /// "N environments" when two clusters happen to point at the same one
    /// (two panes on one worktree is one environment, not two). `Main` has
    /// no per-instance identity of its own, so every `Main` cluster in a
    /// project collapses to the same key, which is the right answer: a
    /// project has exactly one main checkout.
    pub fn identity(&self) -> String {
        match self {
            Environment::LocalWorktree { path, .. } => format!("worktree:{path}"),
            Environment::Design { path, .. } => format!("design:{path}"),
            Environment::Cloud { session_id, .. } => format!("cloud:{session_id}"),
            Environment::Main => "main".to_string(),
        }
    }

    /// The branch this environment is on, where that concept applies.
    /// `Main`'s is not this module's to name — the main checkout can be on
    /// any branch, changed from outside Veistra at any time, so answering
    /// would mean shelling out to `git` from a getter with no error path.
    /// Callers that want it already have `git::git_cluster_status` for that.
    pub fn branch(&self) -> Option<&str> {
        match self {
            Environment::LocalWorktree { branch, .. } => Some(branch),
            Environment::Design { branch, .. } => Some(branch),
            Environment::Cloud { branch, .. } => branch.as_deref(),
            Environment::Main => None,
        }
    }
}

/// Bridge from the legacy field to the new one, for a `layout.json` written
/// before `Environment` existed.
///
/// A cluster with a `worktree` migrates to `LocalWorktree` — `name` is
/// recovered from the worktree's folder name, since the legacy shape never
/// recorded one separately, and `branch`/`base` fall back to the worktree's
/// path-derived name when git never told it a branch (a detached checkout,
/// which `WorktreeRef::branch` already allows for).
///
/// A cluster with **no** worktree is left `None`, deliberately not inferred
/// as `Main`: it is a project worked in directly, with no worktree concept at
/// all, in a build old enough to predate this field. `None` here defers to the
/// legacy fields exactly as before; see `Cluster::environment`'s own doc for
/// the fuller version of this reasoning.
pub fn migrate_environment(
    worktree: Option<&crate::shell_state::WorktreeRef>,
) -> Option<Environment> {
    let wt = worktree?;
    let name = Path::new(&wt.path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&wt.path)
        .to_string();
    let branch = wt.branch.clone().unwrap_or_else(|| name.clone());
    // A legacy layout never recorded the fork point; empty, as `detect_environment` does,
    // rather than a guessed "main" that is wrong for a `master` repository.
    let base = wt.base.clone().unwrap_or_default();
    Some(Environment::LocalWorktree {
        name,
        path: wt.path.clone(),
        branch,
        base,
    })
}

/// Refuse a write aimed at a read-only environment.
///
/// Anything that would change a file, the index or `HEAD` is judged here,
/// once, rather than by every command that could reach it. Every write path
/// funnels through this function or through `apps::write_refusal`, which
/// wraps it for app methods. Since no environment is read-only (see
/// [`Environment::is_read_only`]), nothing is refused today, main included.
///
/// `env` is the *effective* environment. Callers with a cluster go through
/// [`effective_environment`] or [`guard_cluster_write`], so a cluster whose
/// stored environment is `None` is judged by what its folder is.
///
/// `op` names the action for the error message (`"commit"`, `"stage"`) —
/// see `git::run_git`'s own `op` parameter for the same reasoning about why
/// this is a separate argument rather than folded into a single string.
pub fn refuse_read_only_write(env: Option<&Environment>, op: &str) -> Result<()> {
    if env.is_some_and(Environment::is_read_only) {
        return Err(AppError::ReadOnly { op: op.to_string() });
    }
    Ok(())
}

/// What kind of checkout `path` is, or `None` when it is not in a git
/// repository at all (a plain folder has no "main" to protect).
///
/// The one place a path becomes an [`Environment`]: `Main` when `path` sits in
/// the repository's primary working tree, `LocalWorktree` when it sits in a
/// linked one. Every cluster-creation path that only knows a folder
/// (`ShellState::set_cluster_project`, the agent server's `set_project`, Home,
/// launch seeding, restoring an old layout) funnels through here, so none of
/// them can leave a cluster with a null environment pointing at a repo.
pub fn detect_environment(path: &Path) -> Option<Environment> {
    let top = git::repo_root(path)?;
    let main = git::main_repo_root(path)?;
    if same_path(&top, &main) {
        return Some(Environment::Main);
    }
    let name = top
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let branch = git::worktrees(&main)
        .ok()
        .and_then(|list| {
            list.into_iter()
                .find(|w| same_path(Path::new(&w.path), &top))
                .and_then(|w| w.branch)
        })
        .unwrap_or_else(|| name.clone());
    Some(Environment::LocalWorktree {
        name,
        path: top.to_string_lossy().to_string(),
        branch,
        base: String::new(),
    })
}

/// The environment a write guard should judge a cluster by: the stored one, or
/// — when none is stored — the one its project folder implies.
///
/// A null environment pointing at the repository's main checkout is `Main`; a
/// null environment on a plain folder stays `None`. Both are writable.
pub fn effective_environment(
    stored: Option<Environment>,
    project: Option<&Path>,
) -> Option<Environment> {
    stored.or_else(|| project.and_then(detect_environment))
}

/// Whether two paths name the same folder, ignoring verbatim (`\\?\`) prefixes, slash
/// direction and (on Windows) case — what git prints and what the layout
/// stored are rarely spelled the same.
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        canon
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// [`refuse_read_only_write`] for a caller that has a cluster id and an app
/// handle rather than an environment in hand — the shape of every command.
///
/// An id naming no cluster reads as "no environment", so is allowed: the
/// command's own resolution step reports the missing cluster better than this
/// could.
pub fn guard_cluster_write(app: &tauri::AppHandle, cluster_id: &str, op: &str) -> Result<()> {
    use tauri::Manager;
    let env = app
        .state::<crate::shell_state::ShellState>()
        .cluster_write_environment(cluster_id);
    refuse_read_only_write(env.as_ref(), op)
}

/// The environment variables a shell opened in this environment is given so a
/// program inside it can tell it is somewhere read-only.
///
/// Advisory only: a shell cannot be sandboxed from here, so this is a marker
/// an agent harness or a hook can honour, not a wall. Empty for every
/// environment that is not [`Environment::is_read_only`], which today is all
/// of them: a shell on main is an ordinary, writable shell.
pub fn read_only_env(env: Option<&Environment>) -> Vec<(String, String)> {
    match env.filter(|e| e.is_read_only()) {
        Some(read_only) => vec![
            ("VEISTRA_READ_ONLY".to_string(), "1".to_string()),
            (
                "VEISTRA_ENVIRONMENT".to_string(),
                read_only.kind().to_string(),
            ),
        ],
        None => Vec::new(),
    }
}

/// Create a new local worktree under `.veistra/worktrees/<name>`, on branch
/// `wt/<name>` forked from `base`.
///
/// `main_repo` must already be the *primary* checkout — see
/// `git::main_repo_root` — since that is where `.veistra/worktrees` lives and
/// where `git worktree add` has to run. This deliberately does not share
/// `git.rs`'s existing `git_worktree_create` command: that one serves the
/// older per-tool worktree convention (`<project>/../.worktrees/<project
/// name>/<name>`, branch named bare) which a different, already-shipped
/// feature depends on, and changing its layout out from under it is a
/// separate, unwanted migration. This is the New Cluster dialog's own
/// convention, kept inside the project so a cluster's worktrees travel with
/// the project instead of living beside it.
pub fn create_local_worktree(main_repo: &Path, name: &str, base: &str) -> Result<Environment> {
    git::validate_worktree_name(name)?;

    let path = main_repo.join(".veistra").join("worktrees").join(name);
    let branch = format!("wt/{name}");
    git::add_worktree_from(main_repo, &path, &branch, base)?;

    Ok(Environment::LocalWorktree {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        branch,
        base: base.to_string(),
    })
}

/// Every local worktree of `main_repo` the New Cluster dialog can offer as
/// an existing environment.
///
/// The primary checkout and the standing Design worktree are both left out
/// — not because they are not worktrees, but because the dialog already
/// offers each through its own entry ("work on main" and the
/// pinned Design cluster), and listing them again here would be the same
/// choice twice under two different names.
pub fn list_local_worktrees(main_repo: &Path) -> Result<Vec<Environment>> {
    let worktrees = git::worktrees(main_repo)?;
    Ok(worktrees
        .into_iter()
        .filter(|w| !w.is_main && w.branch.as_deref() != Some(DESIGN_BRANCH))
        .map(|w| Environment::LocalWorktree {
            name: Path::new(&w.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&w.path)
                .to_string(),
            path: w.path,
            branch: w.branch.unwrap_or_default(),
            // Git does not remember a worktree's fork point once it exists —
            // see `crate::shell_state::WorktreeRef::base`'s doc for the
            // fuller version of why. Empty rather than a guess: nothing here
            // treats an *existing* worktree's `base` as meaningful, only a
            // freshly created one's, where this module is the one recording it.
            base: String::new(),
        })
        .collect())
}

/// The Design canvas's environment, if `wt/design` already exists as a
/// worktree of `main_repo` — checked, not assumed, since the canvas is only
/// auto-created for a project that already has one (see
/// `ShellState::add_design_cluster`'s caller in `project::open`).
pub fn detect_design_environment(main_repo: &Path) -> Option<Environment> {
    let worktrees = git::worktrees(main_repo).ok()?;
    let wt = worktrees
        .iter()
        .find(|w| w.branch.as_deref() == Some(DESIGN_BRANCH))?;
    Some(Environment::Design {
        path: wt.path.clone(),
        branch: DESIGN_BRANCH.to_string(),
    })
}

/// Create `wt/design` fresh, for a project that does not have one yet and
/// asked for the canvas anyway (the "offered but not auto-created" half of
/// the Design canvas's behaviour — see `VEISTRA-UX-REWORK.md` §5).
pub fn create_design_environment(main_repo: &Path, base: &str) -> Result<Environment> {
    let path = main_repo
        .join(".veistra")
        .join("worktrees")
        .join(DESIGN_NAME);
    git::add_worktree_from(main_repo, &path, DESIGN_BRANCH, base)?;
    Ok(Environment::Design {
        path: path.to_string_lossy().to_string(),
        branch: DESIGN_BRANCH.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_state::WorktreeRef;

    fn wt(path: &str, branch: Option<&str>, base: Option<&str>) -> WorktreeRef {
        WorktreeRef {
            path: path.to_string(),
            branch: branch.map(str::to_string),
            base: base.map(str::to_string),
        }
    }

    // --- serde back-compat ---------------------------------------------------

    /// A `layout.json` written before `environment` existed has no such key —
    /// it must still deserialize, with the field defaulting to `None` rather
    /// than failing the whole file.
    #[test]
    fn cluster_json_without_environment_field_still_parses() {
        let json = r#"{
            "id": "cluster-1",
            "name": "cluster-1",
            "tree": { "kind": "leaf", "id": "pane-1", "tabs": [], "activeTab": null },
            "project": null,
            "worktree": null
        }"#;
        let cluster: crate::shell_state::Cluster = serde_json::from_str(json).unwrap();
        assert_eq!(cluster.environment, None);
        assert!(!cluster.pinned);
    }

    /// An `Environment` round-trips through JSON with a camelCase `kind` tag,
    /// matching the convention every other tagged enum on the wire uses.
    #[test]
    fn local_worktree_serializes_with_camel_case_kind() {
        let env = Environment::LocalWorktree {
            name: "feat-x".to_string(),
            path: "C:/proj/.veistra/worktrees/feat-x".to_string(),
            branch: "wt/feat-x".to_string(),
            base: "main".to_string(),
        };
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["kind"], "localWorktree");
        assert_eq!(json["name"], "feat-x");

        let back: Environment = serde_json::from_value(json).unwrap();
        assert_eq!(back, env);
    }

    #[test]
    fn main_serializes_as_bare_kind() {
        let json = serde_json::to_value(Environment::Main).unwrap();
        assert_eq!(json["kind"], "main");
        let back: Environment = serde_json::from_value(json).unwrap();
        assert_eq!(back, Environment::Main);
    }

    #[test]
    fn kind_is_the_wire_tag() {
        let all = [
            Environment::LocalWorktree {
                name: "x".into(),
                path: "/x".into(),
                branch: "wt/x".into(),
                base: "main".into(),
            },
            Environment::Cloud {
                session_id: "s".into(),
                vm: "vm".into(),
                branch: None,
            },
            Environment::Main,
            Environment::Design {
                path: "/d".into(),
                branch: "wt/design".into(),
            },
        ];
        for env in all {
            assert_eq!(serde_json::to_value(&env).unwrap()["kind"], env.kind());
        }
    }

    // --- environment resolution -----------------------------------------------

    #[test]
    fn root_prefers_the_environments_own_path_over_the_project() {
        let env = Environment::LocalWorktree {
            name: "x".to_string(),
            path: "C:/wt/x".to_string(),
            branch: "wt/x".to_string(),
            base: "main".to_string(),
        };
        assert_eq!(
            env.root(Some(Path::new("C:/proj"))),
            Some(PathBuf::from("C:/wt/x"))
        );
    }

    #[test]
    fn main_root_falls_back_to_the_project_path() {
        assert_eq!(
            Environment::Main.root(Some(Path::new("C:/proj"))),
            Some(PathBuf::from("C:/proj"))
        );
        assert_eq!(Environment::Main.root(None), None);
    }

    /// The one case with no honest local answer — see the variant's doc.
    /// A caller must not paper over this with the project's path.
    #[test]
    fn cloud_root_is_none_even_with_a_project_to_fall_back_to() {
        let env = Environment::Cloud {
            session_id: "s1".to_string(),
            vm: "vm1".to_string(),
            branch: None,
        };
        assert_eq!(env.root(Some(Path::new("C:/proj"))), None);
    }

    #[test]
    fn is_main_is_true_only_for_main() {
        assert!(Environment::Main.is_main());
        assert!(!Environment::Design {
            path: "C:/wt/design".to_string(),
            branch: "wt/design".to_string()
        }
        .is_main());
    }

    // --- migration --------------------------------------------------------

    #[test]
    fn migrate_environment_of_none_is_none() {
        assert_eq!(migrate_environment(None), None);
    }

    #[test]
    fn migrate_environment_recovers_name_from_the_worktree_path() {
        let legacy = wt(
            "C:/proj/../.worktrees/proj/feat-x",
            Some("feat-x"),
            Some("main"),
        );
        let migrated = migrate_environment(Some(&legacy)).unwrap();
        assert_eq!(
            migrated,
            Environment::LocalWorktree {
                name: "feat-x".to_string(),
                path: legacy.path.clone(),
                branch: "feat-x".to_string(),
                base: "main".to_string(),
            }
        );
    }

    /// A worktree with no recorded branch (older `layout.json`, before
    /// `WorktreeRef::branch` was populated for every cluster) still migrates
    /// — the folder name stands in, same as it does for `name`.
    #[test]
    fn migrate_environment_falls_back_when_branch_and_base_are_missing() {
        let legacy = wt("C:/proj/../.worktrees/proj/feat-x", None, None);
        let migrated = migrate_environment(Some(&legacy)).unwrap();
        assert_eq!(
            migrated,
            Environment::LocalWorktree {
                name: "feat-x".to_string(),
                path: legacy.path.clone(),
                branch: "feat-x".to_string(),
                base: String::new(),
            }
        );
    }

    // --- the read-only guard -----------------------------------------------

    /// One of each variant, main among them.
    fn every_kind() -> [Environment; 4] {
        [
            Environment::LocalWorktree {
                name: "x".to_string(),
                path: "C:/wt/x".to_string(),
                branch: "wt/x".to_string(),
                base: "main".to_string(),
            },
            Environment::Cloud {
                session_id: "s".to_string(),
                vm: "v".to_string(),
                branch: None,
            },
            Environment::Main,
            Environment::Design {
                path: "C:/wt/design".to_string(),
                branch: "wt/design".to_string(),
            },
        ]
    }

    /// Main is worked in like a worktree: it is not read-only, and neither is
    /// anything else, so being main no longer decides whether a write runs.
    #[test]
    fn no_environment_is_read_only_main_included() {
        assert!(Environment::Main.is_main());
        assert!(!Environment::Main.is_read_only());
        for env in every_kind() {
            assert!(!env.is_read_only(), "{env:?}");
        }
    }

    /// The bug this guards against is the restriction coming back: a commit,
    /// a canvas save or a file write on main refused as read-only.
    #[test]
    fn refuse_read_only_write_allows_main_and_everything_else() {
        assert!(refuse_read_only_write(None, "commit").is_ok());
        for env in every_kind() {
            for op in ["commit", "canvas/save", "files/write"] {
                assert!(
                    refuse_read_only_write(Some(&env), op).is_ok(),
                    "{env:?} {op}"
                );
            }
        }
    }

    /// No read-only marker on any shell, main's included: an agent or hook
    /// that reads `VEISTRA_READ_ONLY` sees an ordinary, writable shell.
    #[test]
    fn read_only_env_marks_no_shell_main_included() {
        assert!(read_only_env(None).is_empty());
        for env in every_kind() {
            assert!(read_only_env(Some(&env)).is_empty(), "{env:?}");
        }
    }

    // --- worktree naming / branch validation ---------------------------------

    /// `create_local_worktree` validates the name before ever shelling out to
    /// git — a bad name fails with the friendly message from
    /// `git::validate_worktree_name`, not a raw git error about `refs/heads/`.
    #[test]
    fn create_local_worktree_rejects_a_bad_name_before_touching_git() {
        let dir = std::env::temp_dir().join("veistra-env-test-does-not-exist");
        let err = create_local_worktree(&dir, "../escape", "main").unwrap_err();
        match err {
            AppError::Git { op, .. } => assert_eq!(op, "worktree add"),
            other => panic!("expected AppError::Git, got {other:?}"),
        }
    }

    // --- detecting an environment from a bare folder --------------------------

    /// Runs `git` in `dir` for a fixture, panicking with git's own message.
    fn fixture_git(dir: &Path, args: &[&str]) {
        let out = crate::git::git_command()
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

    /// The bug: a cluster created from a bare folder (the agent server's
    /// `set_project`) carried a null environment, so the guard saw nothing to
    /// refuse. Detection must name the main checkout `Main`.
    #[test]
    fn a_main_checkout_is_detected_as_main_and_a_subfolder_too() {
        let dir = tempfile::tempdir().unwrap();
        fixture_git(dir.path(), &["init", "-q", "-b", "trunk"]);
        fixture_git(
            dir.path(),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        assert_eq!(detect_environment(dir.path()), Some(Environment::Main));

        let sub = dir.path().join("canvas");
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(detect_environment(&sub), Some(Environment::Main));
    }

    #[test]
    fn a_linked_worktree_is_detected_as_a_worktree_not_main() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir(&main).unwrap();
        fixture_git(&main, &["init", "-q", "-b", "trunk"]);
        fixture_git(&main, &["commit", "-q", "--allow-empty", "-m", "first"]);
        let linked = dir.path().join("feat-x");
        fixture_git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "wt/feat-x",
                linked.to_str().unwrap(),
            ],
        );

        match detect_environment(&linked) {
            Some(Environment::LocalWorktree { name, branch, .. }) => {
                assert_eq!(name, "feat-x");
                assert_eq!(branch, "wt/feat-x");
            }
            other => panic!("expected a LocalWorktree, got {other:?}"),
        }
    }

    #[test]
    fn a_folder_outside_any_repository_has_no_environment() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(detect_environment(dir.path()), None);
    }

    /// No stored environment and a project that is a real main checkout: it
    /// is still detected as `Main`, and the write goes through. This used to
    /// assert the refusal; main is writable now.
    #[test]
    fn a_null_environment_on_a_main_checkout_is_main_and_writable() {
        let dir = tempfile::tempdir().unwrap();
        fixture_git(dir.path(), &["init", "-q", "-b", "trunk"]);
        fixture_git(
            dir.path(),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        let effective = effective_environment(None, Some(dir.path()));
        assert_eq!(effective, Some(Environment::Main));
        assert!(refuse_read_only_write(effective.as_ref(), "canvas/save").is_ok());
        assert!(read_only_env(effective.as_ref()).is_empty());
    }

    #[test]
    fn a_null_environment_on_a_plain_folder_stays_writable() {
        let dir = tempfile::tempdir().unwrap();
        let effective = effective_environment(None, Some(dir.path()));
        assert!(refuse_read_only_write(effective.as_ref(), "canvas/save").is_ok());
    }

    #[test]
    fn a_stored_environment_is_never_overridden_by_detection() {
        let dir = tempfile::tempdir().unwrap();
        fixture_git(dir.path(), &["init", "-q", "-b", "trunk"]);
        let design = Environment::Design {
            path: "C:/wt/design".to_string(),
            branch: "wt/design".to_string(),
        };
        assert_eq!(
            effective_environment(Some(design.clone()), Some(dir.path())),
            Some(design)
        );
    }
}
