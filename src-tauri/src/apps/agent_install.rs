//! Installing a harness from the agent tab, at the user's press.
//!
//! `agent-tab/install` runs what `veistra_agent_host::harness::install::plan`
//! says is missing: the vendor's own installer for the program, then the
//! pinned ACP adapter. It runs on its own thread, and the tab hears each step
//! as `agent-tab:install`. Only the tab's own frame reaches it (an MCP
//! `app_call` has no instance), so an agent can never install anything.
//!
//! Signing in is not part of it: a fresh install is signed out, and the tab
//! offers `/login`'s sign-in next.
//!
//! An installer adds its folder to the user's PATH, which Veistra read when it
//! started. [`search_path`] is that PATH widened by where the installers put
//! programs, and every lookup and launch in the tab goes through it, so what
//! was just installed is found without a restart.

use std::collections::HashSet;
use std::ffi::OsString;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use veistra_agent_host::harness::install::{self, Blocked, Step};
use veistra_agent_host::Harness;
use veistra_rpc::RpcError;

/// The event a tab hears each step of its install on:
/// `{ instanceId, harness, step, ok, hint, detail }`. `step` is `"cli"` or
/// `"adapter"` while one runs (`ok` is `null`) or has failed (`ok` is
/// `false`), and `null` once the install has ended. Mirrored in
/// `src/bindings.ts`.
pub const INSTALL: &str = "agent-tab:install";

/// Where to get Node.js when npm is missing. Fixed here, never a parameter.
const NODE_DOWNLOAD: &str = "https://nodejs.org/en/download";

/// How much of a failed step's output the tab is shown, from its end.
const DETAIL_CHARS: usize = 800;

/// The harnesses being installed now, so a second press waits for the first.
#[derive(Default)]
pub struct Installs(Mutex<HashSet<Harness>>);

impl Installs {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<Harness>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The PATH the tab searches and launches with: Veistra's own, then each
/// folder an installer puts programs in that it lacks.
pub fn search_path() -> Option<OsString> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let appdata = std::env::var_os("APPDATA");
    let dirs = install::known_dirs(
        home.as_deref().map(std::path::Path::new),
        appdata.as_deref().map(std::path::Path::new),
    );
    install::widen(std::env::var_os("PATH").as_deref(), &dirs)
}

/// Veistra's own PATHEXT, which [`search_path`] is searched with.
pub fn pathext() -> Option<OsString> {
    std::env::var_os("PATHEXT")
}

/// Start installing whatever `harness` is missing, telling `instance`'s tab
/// how each step went. Refused before anything runs when npm or the script's
/// shell is missing, or when the harness is being installed already.
pub fn start(app: &AppHandle, instance: &str, harness: Harness) -> Result<(), RpcError> {
    let path = search_path();
    let steps = install::plan(harness.descriptor(), path.as_deref(), pathext().as_deref())
        .map_err(|blocked| refusal(harness, blocked))?;
    if !installs(app).lock().insert(harness) {
        return Err(super::agent_tab::refused(
            "installing",
            &format!("{} is being installed already", harness.descriptor().name),
            Value::Null,
        ));
    }
    let app = app.clone();
    let instance = instance.to_string();
    std::thread::spawn(move || {
        let tell = |step: Option<&str>, ok: Option<bool>, detail: Option<String>| {
            let hint = super::agent_tab::launch(harness).err();
            let _ = app.emit(
                INSTALL,
                json!({
                    "instanceId": instance,
                    "harness": harness,
                    "step": step,
                    "ok": ok,
                    "hint": hint,
                    "detail": detail,
                }),
            );
        };
        let mut ok = true;
        for step in &steps {
            tell(Some(step.part.id()), None, None);
            if let Err(detail) = run(step, path.as_ref()) {
                tell(Some(step.part.id()), Some(false), Some(detail));
                ok = false;
                break;
            }
        }
        installs(&app).lock().remove(&harness);
        tell(None, Some(ok), None);
    });
    Ok(())
}

fn installs(app: &AppHandle) -> &Installs {
    &app.state::<super::agent_tab::Sessions>().inner().installs
}

/// Open Node.js's download page in the user's browser.
pub fn get_node(app: &AppHandle) -> Result<(), RpcError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(NODE_DOWNLOAD, None::<&str>)
        .map_err(|e| RpcError::new(veistra_rpc::INTERNAL_ERROR, e.to_string()))
}

fn refusal(harness: Harness, blocked: Blocked) -> RpcError {
    let name = harness.descriptor().name;
    match blocked {
        Blocked::NodeMissing => super::agent_tab::refused(
            "nodeMissing",
            &format!("installing {name} needs npm, which comes with Node.js"),
            Value::Null,
        ),
        Blocked::ShellMissing => super::agent_tab::refused(
            "shellMissing",
            &format!("{name}'s installer needs PowerShell or bash"),
            Value::Null,
        ),
    }
}

/// Run one step to its end, with no window and no input, on the widened PATH
/// so an npm shim finds the `node` beside it. `Err` holds the end of what it
/// printed, for the tab's details.
fn run(step: &Step, path: Option<&OsString>) -> Result<(), String> {
    let mut command = Command::new(&step.program);
    command
        .args(&step.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let mut printed = String::from_utf8_lossy(&output.stdout).into_owned();
    printed.push_str(&String::from_utf8_lossy(&output.stderr));
    Err(tail(&printed, DETAIL_CHARS))
}

/// The last `chars` characters of `text`, trimmed.
fn tail(text: &str, chars: usize) -> String {
    let text = text.trim();
    let skip = text.chars().count().saturating_sub(chars);
    text.chars().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_failure_shows_the_end_of_what_it_printed() {
        assert_eq!(tail("  one\ntwo three  ", 5), "three");
        assert_eq!(tail("short", 800), "short");
        assert_eq!(tail("ééé", 2), "éé");
    }

    #[test]
    fn a_failed_step_reports_its_output() {
        let step = Step {
            part: install::Part::Cli,
            program: PathBuf::from(if cfg!(windows) { "cmd" } else { "sh" }),
            args: if cfg!(windows) {
                vec!["/C".into(), "echo nope&& exit 3".into()]
            } else {
                vec!["-c".into(), "echo nope; exit 3".into()]
            },
        };
        assert_eq!(run(&step, None), Err("nope".to_string()));
    }

    #[test]
    fn a_step_that_cannot_start_says_why() {
        let step = Step {
            part: install::Part::Adapter,
            program: PathBuf::from("/nonexistent/npm"),
            args: Vec::new(),
        };
        assert!(run(&step, None).is_err());
    }

    #[test]
    fn nothing_is_installed_without_npm() {
        let err = refusal(Harness::Claude, Blocked::NodeMissing);
        assert_eq!(err.data.unwrap()["code"], "nodeMissing");
        let err = refusal(Harness::Codex, Blocked::ShellMissing);
        assert_eq!(err.data.unwrap()["code"], "shellMissing");
    }
}
