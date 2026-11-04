//! Godot integration: finding the engine, running a project, capturing a frame,
//! recording a run, and reading a scene's tree.
//!
//! `docs/VEISTRA-UX-REWORK.md` §3.1 is the rule everything here obeys: **Godot is
//! never embedded in the webview.** It runs as its own native process - the
//! editor in its own window when someone opens it, the game in its own window
//! when someone plays it, and a windowless `--headless` process when the viewer
//! reads a scene. Play places that window over its pane ([`embed`]), the way
//! Godot's own editor shows a running game, but the game is still its own
//! process: Veistra holds the handles, the logs and the results, and does not
//! draw the engine.

/// The opt-in capture script and its file channel.
pub mod addon;
/// The executable and the projects inside an environment.
pub mod detect;
/// The game's window placed over Play's pane (Windows).
pub mod embed;
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
/// The R1/R2 embed spike (#308): an ignored Windows test, built only with the
/// `embed-spike` feature.
#[cfg(test)]
#[cfg(feature = "embed-spike")]
mod spike;
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
    /// Each cluster's latest run's session: its window, take and marks.
    sessions: Mutex<HashMap<String, Arc<session::Session>>>,
    /// Each cluster's Play pane box, kept between runs. Shared, so a thread
    /// that outlives the call that started it can read it ([`Self::pane_window`]).
    panes: Arc<Mutex<HashMap<String, live::Pane>>>,
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

    /// The sessions whose run is still going: a finished game's window is
    /// gone, and moving it would only fail (or, with its handle reused, move
    /// some other program's window) on every step of a window drag.
    pub fn live_sessions(&self) -> Vec<(String, Arc<session::Session>)> {
        self.sessions()
            .into_iter()
            .filter(|(key, s)| {
                self.runner
                    .get(key)
                    .is_some_and(|r| r.id == s.run_id && r.is_running())
            })
            .collect()
    }

    pub fn pane(&self, key: &str) -> Option<live::Pane> {
        self.panes.lock_or_panic().get(key).cloned()
    }

    pub fn set_pane(&self, key: &str, pane: live::Pane) {
        self.panes.lock_or_panic().insert(key.to_string(), pane);
    }

    /// Reads the label of the Veistra window cluster `key`'s pane is in each
    /// time it is called, not once now.
    pub fn pane_window(&self, key: &str) -> impl Fn() -> Option<String> + Send + Sync + 'static {
        let (panes, key) = (self.panes.clone(), key.to_string());
        move || {
            panes
                .lock_or_panic()
                .get(&key)
                .and_then(|p| p.window.clone())
        }
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
    fn a_session_whose_run_is_gone_is_not_live() {
        let godot = Godot::default();
        godot.set_session("c1", Arc::new(session::Session::new(1, None, None)));
        assert_eq!(godot.sessions().len(), 1);
        assert!(godot.live_sessions().is_empty(), "no run, nothing to move");

        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("game")).unwrap();
        let run = godot
            .runner
            .start(
                "c2",
                runner::RunSpec {
                    program: testing::fake_godot(dir.path(), false),
                    project: dir.path().join("game"),
                    scene: None,
                    channel: None,
                    window: None,
                },
            )
            .unwrap();
        godot.set_session("c2", Arc::new(session::Session::new(run.id, None, None)));
        for _ in 0..400 {
            if !run.is_running() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(!run.is_running());
        assert!(
            godot.live_sessions().is_empty(),
            "a game that exited is not moved"
        );
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
