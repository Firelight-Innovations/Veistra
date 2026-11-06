//! What a launch was asked to open, and how a second launch reaches the first.
//!
//! Explorer's context menu is the only caller that matters: "Open with Veistra"
//! runs this binary with one path as its argument. `installer-hooks.nsh` writes
//! the registry entries that put it there.
//!
//! **A second launch must not become a second process.** Both would hold their
//! own `ShellState` and write `layout.json` and `projects.json` over each
//! other. `tauri-plugin-single-instance` hands the new argv to the process
//! already running and exits the new one, so a second launch is a *message*.
//!
//! **The first launch has nobody to tell yet.** Tauri does not replay events,
//! and at `setup` time no window is listening. The target is parked in
//! [`LaunchState`] for `take_launch_target` to collect, which is the shape
//! `boot_status` uses. A second launch parks *and* emits, because by then
//! something is listening.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::shell_state::ShellState;
use crate::sync::MutexExt;

/// The event a target is delivered on when a window is already listening.
pub const LAUNCH_TARGET_EVENT: &str = "veistra://launch-target";

/// What the shell should do about a path it was handed.
///
/// The split is made here, in Rust, rather than left to the frontend, because
/// answering it means touching the filesystem and that is this side's job. A
/// path that is neither a directory nor a file — deleted between the click and
/// the launch, or a broken link — produces no target at all rather than a
/// variant the frontend has to know to ignore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// A folder: open it as the cluster's project.
    Project { path: String },
    /// A file: show it, and open the folder holding it as the project so the
    /// file tree and the terminals have somewhere to be.
    File {
        path: String,
        parent: Option<String>,
    },
}

/// The target a launch asked for, until a frontend comes and takes it.
///
/// `Option` rather than a queue: two paths opened before the shell is ready is
/// not a scenario worth carrying state for, and the last one asked for is the
/// one a person is waiting to see.
#[derive(Default)]
pub struct LaunchState {
    pending: Mutex<Option<Target>>,
}

impl LaunchState {
    fn park(&self, target: Target) {
        *self.pending.lock_or_panic() = Some(target);
    }

    /// Take the parked target, clearing it.
    ///
    /// Clearing is what stops a target being opened twice when both delivery
    /// paths fire: a second launch emits the event *and* parks, and the
    /// frontend's handler and its mount-time poll both end up here.
    pub fn take(&self) -> Option<Target> {
        self.pending.lock_or_panic().take()
    }
}

/// The first real argument of a command line, if there is one.
///
/// Kept separate from [`classify`] so it can be tested without touching a disk.
/// Skips argv[0], and skips anything beginning with `-`: Tauri and the webview
/// both add switches of their own on some launches, and treating one of those
/// as a path would open a project named `--disable-gpu`.
pub fn first_path_arg<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .map(|a| a.as_ref().to_string())
        // A `veistra://` URL asks only for the window, which the caller
        // raises anyway; it is not a path to look for.
        .find(|a| !a.is_empty() && !a.starts_with('-') && !crate::url_scheme::is_url(a))
        .map(PathBuf::from)
}

/// Decide what a path on the command line means.
pub fn classify(path: &Path) -> Option<Target> {
    // Canonicalized so the title bar and the recents list get one spelling of a
    // path rather than whichever one Explorer happened to pass. Windows returns
    // a `\\?\` extended-length prefix from this, which is correct and is not
    // what anybody wants to read, so it is trimmed back off.
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let display = strip_extended_prefix(&resolved);

    if resolved.is_dir() {
        return Some(Target::Project { path: display });
    }
    if resolved.is_file() {
        return Some(Target::File {
            parent: resolved.parent().map(strip_extended_prefix),
            path: display,
        });
    }
    None
}

/// An extended-length path is a real path that no user recognises. Trim it.
fn strip_extended_prefix(path: &Path) -> String {
    let shown = path.display().to_string();
    match shown.strip_prefix("\\\\?\\") {
        Some(trimmed) => trimmed.to_string(),
        None => shown,
    }
}

/// Act on a target: open its folder here, and hand a file to the frontend.
///
/// The split of labour is the point. Opening a folder as a project is
/// `project::open`, which this side already owns, and doing it here rather than
/// over the wire means the launch terminal a few lines later in `lib.rs`'s
/// setup opens *in* that folder rather than in whatever was open last time.
///
/// Showing a file is the other half, and it cannot be done here. It means
/// finding or creating a viewer instance and handing it a payload, which is a
/// question about the layout — `ToolWindow` is the only thing that can answer
/// it. So a file is parked and announced, and the frontend does that part.
pub fn apply(app: &AppHandle, target: Target) {
    let folder = match &target {
        Target::Project { path } => Some(path.clone()),
        // A file with no parent is a root, which cannot be a project. The file
        // still opens; it just opens without one.
        Target::File { parent, .. } => parent.clone(),
    };

    if let Some(folder) = folder {
        match app.state::<ShellState>().active_cluster_of("main") {
            Some(cluster_id) => {
                if let Err(e) = crate::project::open(app, Path::new(&folder), &cluster_id) {
                    crate::veistra_log!("could not open `{folder}` as a project: {e}");
                }
            }
            // No cluster yet means no window is showing work, which is not a
            // state a launch can create. Reported rather than ignored, because
            // reaching it means something above this changed.
            None => crate::veistra_log!("no cluster to open `{folder}` into"),
        }
    }

    if matches!(target, Target::File { .. }) {
        app.state::<LaunchState>().park(target.clone());
        // Ignored deliberately. At first launch there is no listener and this
        // reaches nobody; the parked copy is what that case runs on. See the
        // module doc.
        let _ = app.emit(LAUNCH_TARGET_EVENT, target);
    }
}

/// Handle this process's own command line, at startup.
pub fn from_own_args(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    if let Some(target) = first_path_arg(&args).as_deref().and_then(classify) {
        apply(app, target);
    }
}

/// Handle a second launch's command line, relayed by the single-instance
/// plugin.
///
/// Raises the window too: a click in Explorer that appears to do nothing
/// because the window was behind something else is indistinguishable from a
/// broken feature.
pub fn from_second_instance(app: &AppHandle, args: Vec<String>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(target) = first_path_arg(&args).as_deref().and_then(classify) {
        apply(app, target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_non_flag_argument() {
        let args = ["veistra-orchestrator.exe", "C:\\code\\game"];
        assert_eq!(first_path_arg(args), Some(PathBuf::from("C:\\code\\game")));
    }

    #[test]
    fn ignores_argv_zero_even_when_it_is_the_only_thing_there() {
        assert_eq!(first_path_arg(["veistra-orchestrator.exe"]), None);
    }

    /// The webview adds switches of its own on some launches, and one arriving
    /// where a path was expected must not open a project named after a flag.
    #[test]
    fn skips_switches() {
        let args = [
            "veistra-orchestrator.exe",
            "--disable-gpu",
            "C:\\code\\game",
        ];
        assert_eq!(first_path_arg(args), Some(PathBuf::from("C:\\code\\game")));
    }

    /// veistra.com's "Open the Veistra app" launches with `veistra://open`.
    #[test]
    fn a_veistra_url_is_not_a_path() {
        let args = ["veistra-orchestrator.exe", "veistra://open"];
        assert_eq!(first_path_arg(args), None);
    }

    #[test]
    fn skips_empty_arguments() {
        let args = ["veistra-orchestrator.exe", "", "C:\\x"];
        assert_eq!(first_path_arg(args), Some(PathBuf::from("C:\\x")));
    }

    #[test]
    fn a_directory_becomes_a_project() {
        let dir = std::env::temp_dir().join("veistra-launch-dir-test");
        let _ = std::fs::create_dir_all(&dir);
        match classify(&dir) {
            Some(Target::Project { path }) => assert!(path.ends_with("veistra-launch-dir-test")),
            other => panic!("expected a project target, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_becomes_a_file_target_carrying_its_folder() {
        let dir = std::env::temp_dir().join("veistra-launch-file-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("notes.md");
        let _ = std::fs::write(&file, b"x");
        match classify(&file) {
            Some(Target::File { path, parent }) => {
                assert!(path.ends_with("notes.md"));
                assert!(parent.is_some_and(|p| p.ends_with("veistra-launch-file-test")));
            }
            other => panic!("expected a file target, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleted between the click and the launch. No target, rather than one the
    /// frontend has to know to throw away.
    #[test]
    fn a_path_that_is_neither_produces_nothing() {
        let missing = std::env::temp_dir().join("veistra-launch-does-not-exist-9f3a");
        assert_eq!(classify(&missing), None);
    }

    #[test]
    fn taking_a_parked_target_clears_it() {
        let state = LaunchState::default();
        state.park(Target::Project {
            path: "C:\\x".into(),
        });
        assert!(state.take().is_some());
        assert!(state.take().is_none(), "a target must not be opened twice");
    }
}
