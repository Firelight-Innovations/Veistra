//! Whether an agent is working in an environment, for the banner the Godot
//! editor shows (#316): an agent reads files from disk, so what the person has
//! not saved in Godot is not what the agent sees.
//!
//! Two kinds of session count, each only in a cluster whose environment root
//! is this one, since a cluster on another worktree is not working here:
//!
//! - an agent tab's, while it starts, runs a turn or waits on an approval;
//! - a terminal whose foreground program is an agent CLI, for as long as it
//!   runs. A terminal cannot say whether its agent is mid-turn, so an idle
//!   one counts too; the banner is advice, and saying it too often is the
//!   cheaper mistake.
//!
//! Finding a terminal's program walks its process tree, so an answer is kept
//! for [`FRESH`] per root and the pane's half-second poll mostly reads that.

use crate::shell_state::ShellState;
use crate::sync::MutexExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How long one answer stands.
const FRESH: Duration = Duration::from_secs(2);

/// One session somewhere in the shell: where it works, and whether it is busy.
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub root: Option<PathBuf>,
    pub working: bool,
}

/// The same folder, however it was written: separators and a trailing slash
/// do not matter, and on Windows neither does case.
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy().to_string();
                if cfg!(windows) {
                    s.to_lowercase()
                } else {
                    s
                }
            })
            .collect()
    };
    norm(a) == norm(b)
}

/// Whether any busy session in `seen` works in `here`.
pub fn working(here: &Path, seen: &[Seen]) -> bool {
    seen.iter()
        .any(|s| s.working && s.root.as_deref().is_some_and(|r| same_dir(r, here)))
}

/// Every session the shell has now: agent tabs, then agent terminals.
fn seen(app: &AppHandle) -> Vec<Seen> {
    let mut all = app.state::<crate::apps::agent_tab::Sessions>().activity();
    let shell = app.state::<ShellState>();
    let pty = app.state::<crate::pty::PtySessions>();
    let clusters: Vec<String> = shell
        .snapshot()
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter().map(|c| c.id.clone()))
        .collect();
    for cluster in clusters {
        let root = shell.cluster_root(&cluster).map(PathBuf::from);
        for terminal in shell.terminals_in_cluster(&cluster) {
            let agent = pty.target(&terminal).is_some_and(|t| t.harness.is_agent());
            all.push(Seen {
                root: root.clone(),
                working: agent,
            });
        }
    }
    all
}

fn cache() -> &'static Mutex<HashMap<PathBuf, (Instant, bool)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Instant, bool)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Whether an agent session works in the environment at `root`.
pub fn working_in(app: &AppHandle, root: &Path) -> bool {
    if let Some((at, answer)) = cache().lock_or_panic().get(root) {
        if at.elapsed() < FRESH {
            return *answer;
        }
    }
    let answer = working(root, &seen(app));
    cache()
        .lock_or_panic()
        .insert(root.to_path_buf(), (Instant::now(), answer));
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(root: &str, working: bool) -> Seen {
        Seen {
            root: Some(PathBuf::from(root)),
            working,
        }
    }

    #[test]
    fn only_a_busy_session_in_this_environment_counts() {
        let here = Path::new("/w/feature");
        assert!(!working(here, &[]));
        assert!(!working(here, &[at("/w/feature", false)]), "idle");
        assert!(!working(here, &[at("/w/other", true)]), "another worktree");
        let nowhere = Seen {
            root: None,
            working: true,
        };
        assert!(
            !working(here, std::slice::from_ref(&nowhere)),
            "a session with no folder"
        );
        assert!(working(here, &[nowhere, at("/w/feature/", true)]));
    }

    #[test]
    fn a_folder_is_the_same_however_it_is_written() {
        assert!(same_dir(Path::new("/w/a/"), Path::new("/w/a")));
        assert!(!same_dir(Path::new("/w/a"), Path::new("/w/ab")));
        if cfg!(windows) {
            assert!(same_dir(Path::new(r"C:\W\A"), Path::new("c:/w/a")));
        }
    }
}
