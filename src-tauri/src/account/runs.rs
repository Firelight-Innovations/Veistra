//! Claude Code and Codex sessions, recorded on the account service as runs, so
//! the dashboard and Settings → Usage can show them (`POST /v1/runs`, `PATCH
//! /v1/runs/{id}`, `docs/account-api.md`). They run on the person's own Claude
//! or ChatGPT plan, so they are recorded unbilled: they never use a plan's
//! credits or count against the spend limit.
//!
//! One run is one agent session: from the harness process starting in a tab
//! to its stopping, as the agent host reports each session's state. A Veistra
//! harness session is not recorded here; billed work is metered by the
//! service's own gateway, never reported by a client.
//!
//! What is sent: the harness, "Claude Code session" or "Codex session", and the
//! working folder's name as the project. Never a prompt, a session title (the
//! agent writes it from the prompts) or a path.
//!
//! Best effort, off the agent host's event thread: a run that cannot be sent
//! (signed out, offline, the setting off) is not retried, and nothing waits on
//! it. A run left open when Veistra quits stays "running" on the dashboard.
//! Rejected: recording at each prompt instead, which counted a conversation's
//! every message as a separate run.

use super::{methods, Account, AccountError};
use crate::settings::{self, keys};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Manager};
use veistra_agent_host::{Harness, SessionState};

/// What to tell the service about a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Start {
        id: String,
        harness: &'static str,
        name: String,
        project: String,
    },
    Finish {
        id: String,
        failed: bool,
    },
}

/// The open run of each agent tab, and the thread that sends.
#[derive(Default)]
pub struct Runs {
    open: Mutex<HashMap<String, (String, Harness)>>,
    worker: Mutex<Option<mpsc::Sender<Op>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The service's name for a harness the app records, and the run's name.
fn recorded(harness: Harness) -> Option<(&'static str, &'static str)> {
    match harness {
        Harness::Claude => Some(("claude_code", "Claude Code session")),
        Harness::Codex => Some(("codex", "Codex session")),
        Harness::Veistra => None,
    }
}

/// The working folder's own name: `Anomaly` from `C:\work\Anomaly`.
fn folder(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string()
}

/// A version-4 UUID, which the service takes as the run's id so a retried
/// POST is still one run.
fn new_id() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex =
        |r: std::ops::Range<usize>| -> String { b[r].iter().map(|x| format!("{x:02x}")).collect() };
    format!(
        "{}-{}-{}-{}-{}",
        hex(0..4),
        hex(4..6),
        hex(6..8),
        hex(8..10),
        hex(10..16)
    )
}

impl Runs {
    /// What one session state change in tab `instance` calls for. `start` is
    /// false while recording is turned off: open runs still finish.
    ///
    /// A status from a session of another harness than the tab's open run is
    /// either the tab's new session (which ends the old run and starts its
    /// own) or the old one's late stop, which is ignored: a tab that switches
    /// harness hears its new session start before the old one has exited.
    pub fn observe(
        &self,
        instance: &str,
        state: SessionState,
        harness: Harness,
        cwd: &str,
        start: bool,
    ) -> Vec<Op> {
        let live = !matches!(state, SessionState::Stopped | SessionState::Failed);
        let mut open = lock(&self.open);
        let mut ops = Vec::new();
        match open.get(instance).cloned() {
            Some((id, running)) if running == harness => {
                if !live {
                    open.remove(instance);
                    ops.push(Op::Finish {
                        id,
                        failed: state == SessionState::Failed,
                    });
                }
                return ops;
            }
            Some(_) if !live => return ops,
            Some((id, _)) => {
                open.remove(instance);
                ops.push(Op::Finish { id, failed: false });
            }
            None => {}
        }
        if let (true, true, Some((service_name, name))) = (live, start, recorded(harness)) {
            let id = new_id();
            open.insert(instance.to_string(), (id.clone(), harness));
            ops.push(Op::Start {
                id,
                harness: service_name,
                name: name.to_string(),
                project: folder(cwd),
            });
        }
        ops
    }
}

/// Send one op as the signed-in person. Signed out or not configured, nothing
/// leaves this computer: [`Account::write`] answers before any request.
pub fn send(account: &Account, api: &str, op: &Op) -> Result<Value, AccountError> {
    match op {
        Op::Start {
            id,
            harness,
            name,
            project,
        } => account.write(
            api,
            "POST",
            "v1/runs",
            &json!({ "id": id, "harness": harness, "name": name, "project": project }),
        ),
        Op::Finish { id, failed } => account.write(
            api,
            "PATCH",
            &format!("v1/runs/{id}"),
            &json!({ "status": if *failed { "failed" } else { "finished" }, "tokens": null }),
        ),
    }
}

/// The agent host's hook: called for every session state change, on its
/// event thread, so it only queues.
pub fn record(app: &AppHandle, instance: &str, state: SessionState, harness: Harness, cwd: &str) {
    let runs = app.state::<Runs>();
    let on = settings::flag(app, keys::RUNS_RECORD);
    let ops = runs.observe(instance, state, harness, cwd, on);
    if ops.is_empty() {
        return;
    }
    let mut worker = lock(&runs.worker);
    let sender = worker.get_or_insert_with(|| {
        let (tx, rx) = mpsc::channel::<Op>();
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("account-runs".into())
            .spawn(move || {
                for op in rx {
                    let api = methods::api(&app);
                    if let Err(e) = send(&app.state::<Account>(), &api, &op) {
                        if !matches!(e, AccountError::SignedOut | AccountError::NotConfigured) {
                            crate::veistra_log!(
                                "veistra: a run was not recorded: {}",
                                e.describe()
                            );
                        }
                    }
                }
            });
        tx
    });
    for op in ops {
        let _ = sender.send(op);
    }
}
