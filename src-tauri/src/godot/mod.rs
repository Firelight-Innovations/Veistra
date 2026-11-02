//! Godot integration: finding the engine, running a project, capturing a frame,
//! recording a run, and reading a scene's tree.
//!
//! Godot always runs as its own native process: the game when someone plays
//! it, a windowless `--headless` process when the viewer reads a scene, and
//! the editor. Play places the game's window over its pane through
//! [`crate::embed`], the way Godot's own editor shows a running game, and the
//! editor joins it there (owner decision 6 of the v0.2 design, replacing
//! `docs/VEISTRA-UX-REWORK.md` §3.1's "never embedded"). Placed is not drawn:
//! the process is still its own, and Veistra holds the handles, the logs and
//! the results.

/// The opt-in capture script and its file channel.
pub mod addon;
/// The executable and the projects inside an environment.
pub mod detect;
/// Send's packet: `packet.md`, pictures, context, comments.
pub mod feedback;
/// Play's methods for the pane, Record, takes and Send.
pub mod live;
/// Play notes as the workspace MCP server shows them to agents.
pub mod notes;
/// A scene exported to glTF for the viewer's interactive 3D view.
pub mod preview;
/// A run recorded to `take.mp4` (Windows).
pub mod record;
/// The methods `play` and `godot-viewer` answer.
pub mod rpc;
/// A game run as a child process, with a bounded classified log.
pub mod runner;
/// The viewer's headless tree read, render and cache.
pub mod scene;
/// One run's window, take, marks and keys.
pub mod session;
/// Recorded runs on disk, their summary, drafts and retention.
pub mod takes;
/// What capture addon v2 writes while a game runs.
pub mod telemetry;
#[cfg(test)]
mod testing;

use crate::sync::MutexExt;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

/// The settings section, registered from `apps::settings_groups`.
pub static SETTINGS: crate::settings::Group = crate::settings::Group {
    id: "godot",
    title: "Godot",
    description: "The engine Play and the Godot Viewer run, and how to reach it.",
    order: 111,
    settings: SETTINGS_ROWS,
};

pub const KEY_EXECUTABLE_PATH: &str = "godot.executablePath";

static SETTINGS_ROWS: &[crate::settings::Setting] = &[crate::settings::Setting {
    key: KEY_EXECUTABLE_PATH,
    title: "Godot 4 executable",
    description: "Leave empty to look for it: GODOT4 and GODOT environment variables, PATH, \
                      common install folders and Steam. A path set here is used as it is and is \
                      never replaced by another install. A folder works too.",
    control: crate::settings::Control::Text {
        default: "",
        placeholder: "C:\\Tools\\Godot\\Godot_v4.3-stable_win64.exe",
    },
    applies: crate::settings::Applies::Next {
        what: "the next time Play or the Godot Viewer looks for it",
    },
}];

/// Everything Godot-related this process holds: the runs, the viewer's jobs,
/// and the last executable that was found.
#[derive(Default)]
pub struct Godot {
    pub runner: runner::Runner,
    pub jobs: scene::Jobs,
    resolved: Mutex<Option<(String, detect::Found)>>,
    next_command: AtomicU64,
    /// Each cluster's latest run's session: its window, take and marks. The
    /// pane's box is the embedder's ([`crate::embed::host::Hosts`]).
    sessions: Mutex<HashMap<String, Arc<session::Session>>>,
}

impl Godot {
    /// The executable for `setting`, probing only when nothing usable is cached.
    ///
    /// A found path is remembered against the setting text that produced it and
    /// dropped if the file disappears or `refresh` asks; a failed search is not
    /// remembered, so installing Godot and pressing Play again just works.
    pub fn executable(
        &self,
        probe: &detect::Probe,
        refresh: bool,
        check: &dyn Fn(&std::path::Path) -> Result<String, String>,
    ) -> detect::Resolution {
        if !refresh {
            let cached = self.resolved.lock_or_panic().clone();
            if let Some((setting, found)) = cached {
                if setting == probe.setting && found.path.is_file() {
                    return detect::Resolution {
                        found: Some(found),
                        problems: Vec::new(),
                    };
                }
            }
        }
        let resolution = detect::resolve(probe, check);
        *self.resolved.lock_or_panic() = resolution
            .found
            .clone()
            .map(|found| (probe.setting.clone(), found));
        resolution
    }

    pub fn session(&self, key: &str) -> Option<Arc<session::Session>> {
        self.sessions.lock_or_panic().get(key).cloned()
    }

    pub fn set_session(&self, key: &str, session: Arc<session::Session>) {
        self.sessions
            .lock_or_panic()
            .insert(key.to_string(), session);
    }

    pub fn sessions(&self) -> Vec<(String, Arc<session::Session>)> {
        self.sessions
            .lock_or_panic()
            .iter()
            .map(|(k, s)| (k.clone(), s.clone()))
            .collect()
    }

    /// The engine version a take records: the last executable found.
    pub fn version_for_takes(&self) -> String {
        self.resolved
            .lock_or_panic()
            .as_ref()
            .map(|(_, f)| f.version.clone())
            .unwrap_or_default()
    }

    pub fn next_command_id(&self) -> u64 {
        self.next_command.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Called at application exit: no game outlives the window that started
    /// it, and a take being recorded is saved first.
    pub fn shutdown(&self) {
        for (key, session) in self.sessions() {
            if let Some(run) = self.runner.get(&key).filter(|r| r.id == session.run_id) {
                session.finish_take(&run);
            }
        }
        self.runner.stop_all();
    }
}

/// The folder run channels and scratch files live in. The OS temp directory,
/// never the project: a channel is throwaway, and writing it into a checkout
/// would be a change to a repository nobody asked for.
pub fn scratch_root() -> PathBuf {
    std::env::temp_dir().join("veistra-godot")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_found_executable_is_remembered_until_the_setting_changes_or_refresh_asks() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe = dir.path().join("godot-x");
        std::fs::write(&exe, "x").unwrap();
        let godot = Godot::default();
        let calls = std::cell::Cell::new(0);
        let check = |_: &std::path::Path| {
            calls.set(calls.get() + 1);
            Ok("4.3.stable".to_string())
        };
        let mut probe = detect::Probe {
            setting: exe.display().to_string(),
            ..detect::Probe::default()
        };

        assert!(godot.executable(&probe, false, &check).found.is_some());
        assert!(godot.executable(&probe, false, &check).found.is_some());
        assert_eq!(calls.get(), 1, "the second call is answered from memory");

        godot.executable(&probe, true, &check);
        assert_eq!(calls.get(), 2, "refresh probes again");

        probe.setting = String::new();
        assert!(godot.executable(&probe, false, &check).found.is_none());
        assert_eq!(calls.get(), 2, "nothing to try, so nothing is asked");
    }

    #[test]
    fn a_failed_search_is_not_cached() {
        let godot = Godot::default();
        let probe = detect::Probe::default();
        assert!(godot
            .executable(&probe, false, &|_| Err("no".into()))
            .found
            .is_none());
        assert!(godot.resolved.lock_or_panic().is_none());
    }
}
