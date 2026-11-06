//! One agent process and the ACP session inside it.
//!
//! Six threads, each owning one thing, so that nothing that can block — a
//! pipe write, a read, a wait — ever runs while another thread needs the
//! session's lock:
//!
//! - the **writer** owns the child's stdin. Everyone else hands it a finished
//!   line over a channel and returns at once.
//! - the **reader** reads stdout: replies, the agent's own requests, updates.
//! - the **stderr** thread keeps a masked tail for the log, and nothing else.
//! - the **waiter** owns the child and notices it exit. That, not stdout's
//!   end, is what ends the session: a grandchild can hold stdout open long
//!   after the agent is gone.
//! - the **driver** runs the handshake and then one prompt at a time.
//! - the **settings** thread asks the agent for one setting change at a time
//!   — a mode, a model — in the order the user made them.
//!
//! None of them is joined. Each holds the shared state, and goes when its own
//! work ends.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config::{self, Settings};
use crate::elicit::{self, Form};
use crate::event::{
    Attachment, Envelope, Event, Hint, Item, ItemKind, QuestionOutcome, SessionState,
    SessionStatus, SettingTrouble,
};
use crate::guard::{escapes, request_scope, Worktree};
use crate::harness::{Harness, LaunchSpec};
use crate::host::HostError;
use crate::job::{self, Job};
use crate::mask::mask;
use crate::mcp::{self, McpServer};
use crate::models::MODEL_CATEGORY;
use crate::normalize::Normalizer;
use crate::transcript::Transcript;
use crate::wire::{self, Id, Incoming, RemoteError, AUTH_REQUIRED, METHOD_NOT_FOUND};
use crate::workflow;

/// How often a running workflow's folder is read.
const WORKFLOW_POLL: Duration = Duration::from_secs(1);

/// How long a request to stop a task waits for its answer.
const STOP_WAIT: Duration = Duration::from_secs(15);

/// Where every envelope goes. Called from one thread, in `seq` order.
pub type Sink = Arc<dyn Fn(Envelope) + Send + Sync>;

/// Where the host's diagnostic lines go. Never handed a prompt, an answer, a
/// tool's output or anything an `_auth/*` notification carried; stderr only
/// masked.
pub type Log = Arc<dyn Fn(Level, &str) + Send + Sync>;

/// How much a [`Log`] line matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// A session started, met its adapter or ended as asked.
    Info,
    /// A session failed to start or died on its own. The shell keeps these
    /// where `recent_errors` can read them.
    Failure,
}

/// How long each handshake step may take.
const HANDSHAKE: Duration = Duration::from_secs(60);

/// How many stderr lines are kept for the log.
const STDERR_TAIL: usize = 8;

/// The most of one stderr line kept for the log.
const STDERR_LINE: usize = 4 * 1024;

/// The longest stdout line read as a message. A longer one is dropped whole
/// and counted as noise, so an agent cannot grow the host without bound.
pub(crate) const MESSAGE_LIMIT: usize = 32 * 1024 * 1024;

/// The most approvals that may wait on the user at once. Past it a request is
/// refused unseen.
const MAX_PENDING_APPROVALS: usize = 64;

/// The most characters of an agent's reason for refusing a change that are
/// kept. It rides on every status event until the next change is answered
/// and is drawn inline, so a stack or a dumped option list stops short.
const REFUSAL_REASON: usize = 300;

/// Local codes for a reply that never came. Negative and far from JSON-RPC's
/// reserved range, so no agent sends them.
const CLOSED: i64 = -1;
const TIMED_OUT: i64 = -2;

/// Everything a session needs to start.
pub(crate) struct Start {
    pub(crate) instance_id: String,
    pub(crate) spec: LaunchSpec,
    pub(crate) worktree: Worktree,
    pub(crate) prefix: String,
    pub(crate) prior: Vec<Item>,
    pub(crate) seq: Arc<AtomicU64>,
    /// The host's count of setting changes, which numbers this session's.
    pub(crate) changes: Arc<AtomicU64>,
    pub(crate) events: Sender<Envelope>,
    pub(crate) log: Log,
}

/// A running (or finished) agent session. Dropping it kills the process.
pub(crate) struct Session {
    shared: Arc<Shared>,
}

struct Shared {
    instance_id: String,
    worktree: Worktree,
    expected_version: Option<&'static str>,
    /// The mode the handshake puts the session in, from its harness's policy.
    ask_first: &'static str,
    setting_timeout: Duration,
    /// Veistra's MCP servers, for `session/new`. Their bearers are also
    /// scrubbed from the stderr tail.
    mcp_servers: Vec<McpServer>,
    /// This session's skill folders, in its harness's shape (`LaunchSpec::plugins`).
    plugins: Vec<PathBuf>,
    /// The model the tab chose, which the handshake switches to.
    model: Option<String>,
    effort: Option<String>,
    ultracode: bool,
    /// The mode the tab picked before the session existed, which the
    /// handshake switches to once ask-first is confirmed.
    mode: Option<String>,
    harness: Harness,
    child: Mutex<Child>,
    /// What ends the child and everything it started at once.
    job: Option<Job>,
    writer: Sender<Line>,
    settings: Sender<Setting>,
    seq: Arc<AtomicU64>,
    changes: Arc<AtomicU64>,
    log: Log,
    stderr: Mutex<VecDeque<String>>,
    stderr_done: AtomicBool,
    /// Set when the host killed the process, so the exit is not a failure.
    stopped: AtomicBool,
    state: Mutex<Inner>,
    wake: Condvar,
}

struct Inner {
    ultracode: bool,
    mcp_http: bool,
    closed: bool,
    next_id: i64,
    replies: HashMap<i64, Option<Result<Value, RemoteError>>>,
    prompt: Option<String>,
    prompt_context: Option<String>,
    /// The content blocks that follow the queued prompt's text: what its @
    /// chips name, resolved.
    attached: Vec<Value>,
    /// The newest queued change; a new turn waits until settings reach it.
    queued_change: u64,
    approvals: Vec<Waiting>,
    normalizer: Normalizer,
    transcript: Transcript,
    status: SessionStatus,
    session_id: Option<String>,
    /// The id of the agent's config option for the mode, when it has one.
    /// Claude's does, and a change through it answers with every setting as
    /// it now stands, which `session/set_mode` does not.
    mode_option: Option<String>,
    /// Requests whose replies carry the session's settings, by id. The reader
    /// takes each reply in as it arrives, so a notification sent after it is
    /// never overwritten by it.
    changing: HashMap<i64, Asked>,
    /// How many times the agent has reported its mode, so a reply to
    /// `session/set_mode`, which does not say, knows whether one came first.
    mode_reports: u64,
    /// The mode the agent last reported, shown or not. `show_mode` holds a
    /// report back during the handshake, and the pick made then reads it here.
    reported: Option<String>,
    events: Sender<Envelope>,
    last_seq: u64,
    noise: u64,
    /// A thread is reading workflow folders (`watch_workflows`).
    watching: bool,
    /// Set when the tab stopped showing this session: nothing more is
    /// numbered or sent, so a reset tab never hears from its old agent.
    silenced: bool,
}

/// An approval or question the user has not answered, and the agent request
/// it answers.
struct Waiting {
    item_id: String,
    rpc: Id,
    /// The form a question answers; `None` for a permission request.
    form: Option<Form>,
}

impl Waiting {
    /// The reply that withdraws it: each request has its own shape.
    fn cancelled(&self) -> Value {
        match self.form {
            Some(_) => json!({ "action": "cancel" }),
            None => cancelled(),
        }
    }
}

enum Line {
    Send(String),
    Close,
}

/// Work for the settings thread.
enum Setting {
    Change(Change),
    Close,
}

/// One request that changes a setting.
struct Change {
    method: &'static str,
    params: Value,
    /// The mode it sets, for `session/set_mode`, whose reply does not say.
    mode: Option<String>,
    /// Its number, which `status.answered` takes once it is answered.
    ticket: u64,
}

/// A request in flight whose reply carries the session's settings.
struct Asked {
    /// The mode it sets, for `session/set_mode`, whose reply does not say.
    mode: Option<String>,
    /// `mode_reports` when it was sent.
    reports: u64,
}

impl Session {
    /// Spawn the process and its threads. The handshake waits for the first
    /// prompt.
    pub(crate) fn start(start: Start) -> Result<Self, HostError> {
        let Start {
            instance_id,
            spec,
            worktree,
            prefix,
            prior,
            seq,
            changes,
            events,
            log,
        } = start;
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(spec.env.iter().map(|(k, v)| (k, v)))
            .current_dir(worktree.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in &spec.env_remove {
            command.env_remove(key);
        }
        let (mut child, job) = job::spawn(&mut command).map_err(|e| HostError::Spawn {
            hint: (e.kind() == std::io::ErrorKind::NotFound).then_some(Hint::AdapterMissing),
            message: mask(&e.to_string()),
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            job::kill(&mut child, job.as_ref());
            return Err(HostError::Spawn {
                hint: None,
                message: "the agent's pipes could not be opened".to_string(),
            });
        };
        let pid = child.id();
        let (writer, lines) = mpsc::channel();
        let (settings, queued) = mpsc::channel();
        let status = SessionStatus {
            state: SessionState::Starting,
            harness: spec.harness,
            cwd: worktree.path().to_string_lossy().into_owned(),
            mode: None,
            modes: Vec::new(),
            config: Vec::new(),
            commands: Vec::new(),
            answered: changes.load(Ordering::SeqCst),
            setting_trouble: None,
            adapter_version: None,
            exit_code: None,
            hint: None,
            pending_prompt: None,
            session_title: None,
        };
        let shared = Arc::new(Shared {
            instance_id,
            worktree,
            expected_version: spec.expected_version,
            ask_first: spec.policy.ask_first,
            model: spec.model.clone(),
            effort: spec.effort.clone(),
            ultracode: spec.ultracode,
            mode: spec.mode.clone(),
            harness: spec.harness,
            setting_timeout: spec.setting_timeout,
            mcp_servers: spec.mcp_servers,
            plugins: spec.plugins,
            child: Mutex::new(child),
            job,
            writer,
            settings,
            seq: Arc::clone(&seq),
            changes,
            log,
            stderr: Mutex::new(VecDeque::new()),
            stderr_done: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            state: Mutex::new(Inner {
                ultracode: spec.ultracode,
                mcp_http: false,
                closed: false,
                next_id: 0,
                replies: HashMap::new(),
                prompt: None,
                prompt_context: None,
                attached: Vec::new(),
                queued_change: status.answered,
                approvals: Vec::new(),
                normalizer: Normalizer::new(&prefix, spec.harness),
                transcript: Transcript::from_items(prior),
                status,
                session_id: None,
                mode_option: None,
                changing: HashMap::new(),
                mode_reports: 0,
                reported: None,
                events,
                last_seq: seq.load(Ordering::SeqCst),
                noise: 0,
                watching: false,
                silenced: false,
            }),
            wake: Condvar::new(),
        });
        (shared.log)(
            Level::Info,
            &format!(
                "agent-host: {} started {:?} as pid {pid}",
                shared.instance_id, spec.harness
            ),
        );
        {
            let mut inner = shared.lock();
            let status = inner.status.clone();
            shared.emit(&mut inner, Event::Status { status });
        }
        spawn("agent-writer", move || write_lines(stdin, &lines));
        let s = Arc::clone(&shared);
        spawn("agent-reader", move || s.read(stdout));
        let s = Arc::clone(&shared);
        spawn("agent-stderr", move || s.read_stderr(stderr));
        let s = Arc::clone(&shared);
        spawn("agent-waiter", move || s.wait_for_exit());
        let s = Arc::clone(&shared);
        spawn("agent-driver", move || s.drive());
        let s = Arc::clone(&shared);
        spawn("agent-settings", move || s.change_settings(&queued));
        Ok(Self { shared })
    }

    /// Queue a prompt. One at a time: a second while the first is running is
    /// refused rather than queued, so the tab never shows a prompt that has
    /// not started.
    pub(crate) fn prompt(&self, text: &str, attached: Vec<Value>) -> Result<(), HostError> {
        self.prompt_with_context(text, None, attached)
    }

    /// A cross-harness handoff is model context, not another user message in the transcript.
    pub(crate) fn prompt_with_context(
        &self,
        text: &str,
        context: Option<&str>,
        attached: Vec<Value>,
    ) -> Result<(), HostError> {
        let mut inner = self.shared.lock();
        if inner.closed || inner.status.state == SessionState::Failed {
            return Err(HostError::Closed);
        }
        // A turn the agent started itself does not hold the prompt back: the
        // prompt's turn closes it.
        if inner.prompt.is_some() || inner.normalizer.prompted() {
            return Err(HostError::Busy);
        }
        inner.prompt = Some(text.to_string());
        inner.prompt_context = context.map(str::to_owned);
        inner.attached = attached;
        if inner.status.state == SessionState::Starting
            || inner.queued_change > inner.status.answered
        {
            inner.status.pending_prompt = Some(text.to_string());
            let status = inner.status.clone();
            self.shared.emit(&mut inner, Event::Status { status });
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// Stop the running turn. Every open approval is answered `cancelled`.
    pub(crate) fn cancel(&self) {
        let shared = &self.shared;
        let mut inner = shared.lock();
        inner.prompt_context = None;
        inner.attached.clear();
        if inner.prompt.take().is_some() && inner.status.pending_prompt.take().is_some() {
            let status = inner.status.clone();
            shared.emit(&mut inner, Event::Status { status });
        }
        if inner.normalizer.turn().is_some() {
            if let Some(session_id) = inner.session_id.clone() {
                shared.send(wire::notification(
                    "session/cancel",
                    json!({ "sessionId": session_id }),
                ));
            }
        }
        shared.close_approvals(&mut inner, "cancelled");
        // No prompt is waiting on a turn the agent started itself, so
        // nothing else would end it.
        if inner.normalizer.autonomous() {
            let events = inner.normalizer.end_turn("cancelled");
            shared.emit_all(&mut inner, events);
            shared.set_state(&mut inner, SessionState::Ready);
        }
    }

    /// Ask the agent to stop a background task it reported as stoppable. The
    /// task's item says when it has.
    pub(crate) fn stop_task(&self, task_id: &str) -> Result<(), HostError> {
        let session_id = {
            let inner = self.shared.lock();
            let session_id = open(&inner)?;
            if !inner.normalizer.stoppable(task_id) {
                return Err(HostError::UnknownTask);
            }
            session_id
        };
        let shared = Arc::clone(&self.shared);
        let params = json!({ "sessionId": session_id, "asyncTaskId": task_id });
        spawn("agent-stop-task", move || {
            // The answer says only whether it stopped; the update that
            // follows says so on the task, and a refusal leaves it running.
            if let Err(e) = shared.request("_session/async_task/stop", params, Some(STOP_WAIT)) {
                (shared.log)(
                    Level::Info,
                    &format!(
                        "agent-host: {} could not stop a task: {}",
                        shared.instance_id,
                        mask(&e.message)
                    ),
                );
            }
        });
        Ok(())
    }

    /// Answer the approval `item_id` with `option_id`, which must be one the
    /// agent offered on it.
    pub(crate) fn answer(&self, item_id: &str, option_id: &str) -> Result<(), HostError> {
        let shared = &self.shared;
        let mut inner = shared.lock();
        let index = inner
            .approvals
            .iter()
            .position(|w| w.item_id == item_id)
            .ok_or(HostError::UnknownApproval)?;
        let offered = match inner.transcript.get(item_id).map(|item| &item.kind) {
            Some(ItemKind::Approval { options, .. }) => {
                options.iter().any(|o| o.option_id == option_id)
            }
            _ => false,
        };
        if !offered {
            return Err(HostError::UnknownOption);
        }
        let waiting = inner.approvals.remove(index);
        shared.send(wire::result(&waiting.rpc, selected(option_id)));
        shared.complete_approval(&mut inner, item_id, option_id);
        shared.settle(&mut inner);
        Ok(())
    }

    /// Answer the question card `item_id`. A pick it did not offer is
    /// refused, and the card stays open.
    pub(crate) fn reply(&self, item_id: &str, outcome: QuestionOutcome) -> Result<(), HostError> {
        let shared = &self.shared;
        let mut inner = shared.lock();
        let index = inner
            .approvals
            .iter()
            .position(|w| w.item_id == item_id && w.form.is_some())
            .ok_or(HostError::UnknownApproval)?;
        let result = match &inner.approvals[index].form {
            Some(form) => form.response(&outcome)?,
            None => return Err(HostError::UnknownApproval),
        };
        let waiting = inner.approvals.remove(index);
        shared.send(wire::result(&waiting.rpc, result));
        shared.complete_question(&mut inner, item_id, outcome);
        shared.settle(&mut inner);
        Ok(())
    }

    /// Switch the agent to `mode_id`, one of the modes its status offers.
    /// Returns the change's number once it is queued. The first status whose
    /// `answered` reaches that number shows the mode the agent settled on,
    /// which can differ from the one asked for.
    pub(crate) fn set_mode(&self, mode_id: &str) -> Result<u64, HostError> {
        let mut inner = self.shared.lock();
        let session_id = open(&inner)?;
        if !inner.status.modes.iter().any(|m| m.value == mode_id) {
            return Err(HostError::UnknownOption);
        }
        let change = match &inner.mode_option {
            Some(config_id) => (
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": mode_id }),
                None,
            ),
            None => (
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode_id }),
                Some(mode_id.to_string()),
            ),
        };
        Ok(self.shared.queue(&mut inner, change))
    }

    /// Set the option `config_id` to `value`, one of the choices the status
    /// offers for it. The mode is not among those options; it goes through
    /// [`Session::set_mode`]. Returns the change's number, as that does. The
    /// agent's reply carries every option as it then stands, which can differ
    /// in more than this one: a new model brings its own effort levels.
    pub(crate) fn set_config(&self, config_id: &str, value: &str) -> Result<u64, HostError> {
        let mut inner = self.shared.lock();
        let session_id = open(&inner)?;
        if config_id == "ultra_effort"
            && self.shared.harness == Harness::Claude
            && matches!(value, "on" | "off")
        {
            // Resolve model, effort and permissions only after preceding queued
            // settings have settled, not from a stale UI-time snapshot.
            return Ok(self.shared.queue(
                &mut inner,
                ("session/resume", json!({ "enabled": value == "on" }), None),
            ));
        }
        let offered = inner
            .status
            .config
            .iter()
            .find(|o| o.id == config_id)
            .is_some_and(|o| o.choices.iter().any(|c| c.value == value));
        if !offered {
            return Err(HostError::UnknownOption);
        }
        let change = (
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            None,
        );
        Ok(self.shared.queue(&mut inner, change))
    }

    /// Everything drawn so far.
    pub(crate) fn attach(&self) -> Attachment {
        let inner = self.shared.lock();
        Attachment {
            status: Some(inner.status.clone()),
            items: inner.transcript.items(),
            seq: inner.last_seq,
        }
    }

    /// The items, for a session that continues this one after it died.
    pub(crate) fn items(&self) -> Vec<Item> {
        self.shared.lock().transcript.items()
    }

    /// Whether the process is still running and can take a prompt. One whose
    /// handshake failed is on its way out, so it counts as gone.
    pub(crate) fn is_alive(&self) -> bool {
        let inner = self.shared.lock();
        !inner.closed && inner.status.state != SessionState::Failed
    }

    /// Send nothing more. Every event already numbered is ahead of whatever
    /// the caller numbers next.
    pub(crate) fn silence(&self) {
        self.shared.lock().silenced = true;
    }

    /// Which harness it runs.
    pub(crate) fn harness(&self) -> Harness {
        self.shared.lock().status.harness
    }

    /// Where it runs.
    pub(crate) fn worktree(&self) -> &Worktree {
        &self.shared.worktree
    }

    /// Where it is, without the transcript `attach` copies.
    pub(crate) fn status(&self) -> SessionStatus {
        self.shared.lock().status.clone()
    }

    /// Kill the process and everything it started. Returns at once; the
    /// waiter reports the exit.
    pub(crate) fn kill(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.send_close();
        let mut child = self.shared.child.lock().unwrap_or_else(|e| e.into_inner());
        job::kill(&mut child, self.shared.job.as_ref());
    }

    /// Wait until the process has exited, or `deadline` passes.
    pub(crate) fn wait_closed(&self, deadline: Instant) -> bool {
        let mut inner = self.shared.lock();
        while !inner.closed {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            inner = self
                .shared
                .wake
                .wait_timeout(inner, left)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|e| e.into_inner().0);
        }
        true
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

impl Inner {
    /// Take in a `configOptions` list: the mode option, if there is one, and
    /// every other option as the agent now reports it.
    fn apply(&mut self, settings: Settings) {
        if let Some(mode) = settings.mode {
            self.show_mode(mode.value);
            self.status.modes = config::allowed(mode.choices);
            self.mode_option = Some(mode.id);
        }
        self.status.config = settings.options;
        self.workflow_option();
    }

    /// Host-owned workflow state is separate from the adapter's reasoning-level option.
    fn workflow_option(&mut self) {
        if self.status.harness != Harness::Claude {
            return;
        }
        self.status.config.retain(|o| o.id != "ultra_effort");
        self.status.config.push(crate::event::ConfigOption {
            id: "ultra_effort".into(),
            name: "Ultra effort".into(),
            description: None,
            category: Some("workflow".into()),
            value: if self.ultracode { "on" } else { "off" }.into(),
            choices: ["off", "on"]
                .into_iter()
                .map(|v| crate::event::ConfigChoice {
                    value: v.into(),
                    name: v.into(),
                    description: None,
                })
                .collect(),
        });
    }

    /// Record the mode the agent reports, but only once the handshake has
    /// confirmed ask-first: whatever the user's own default is, it is not
    /// this session's mode until then, so neither a status sent meanwhile
    /// nor a failed handshake ever shows it. A session that has failed, or
    /// whose process has exited, never had that confirmation.
    fn show_mode(&mut self, mode: String) {
        if matches!(
            self.status.state,
            SessionState::Ready | SessionState::Working | SessionState::NeedsInput
        ) {
            self.status.mode = Some(mode.clone());
        }
        self.reported = Some(mode);
    }

    /// Take in a reply that carries the settings: `session/new`'s modes and
    /// list, or a change's list. `session/set_mode` answers `{}`, so the mode
    /// it asked for is taken as set, unless the agent has reported one since.
    fn answered(&mut self, result: &Value, asked: Asked) {
        if let Some(choices) = result.get("modes").and_then(config::modes) {
            self.status.modes = config::allowed(choices);
        }
        if let Some(list) = result.get("configOptions").filter(|l| l.is_array()) {
            self.apply(config::settings(list));
        }
        if let Some(mode) = asked.mode {
            if self.mode_reports == asked.reports {
                self.status.mode = Some(mode);
            }
        }
    }
}

/// The ACP session id, for a session that is open and past its handshake.
fn open(inner: &Inner) -> Result<String, HostError> {
    if inner.closed || inner.status.state == SessionState::Failed {
        return Err(HostError::Closed);
    }
    if inner.status.state == SessionState::Starting {
        return Err(HostError::NoSession);
    }
    inner.session_id.clone().ok_or(HostError::NoSession)
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(&self, line: String) {
        let _ = self.writer.send(Line::Send(line));
    }

    /// Number a change and hand it to the settings thread, which sends them
    /// in the order they were numbered. Taking the lock's guard keeps two
    /// callers from numbering in one order and queueing in the other.
    fn queue(
        &self,
        held: &mut Inner,
        (method, params, mode): (&'static str, Value, Option<String>),
    ) -> u64 {
        let ticket = self.changes.fetch_add(1, Ordering::SeqCst) + 1;
        held.queued_change = ticket;
        let change = Change {
            method,
            params,
            mode,
            ticket,
        };
        let _ = self.settings.send(Setting::Change(change));
        ticket
    }

    fn send_close(&self) {
        let _ = self.writer.send(Line::Close);
    }

    /// Number `event`, keep it, and hand it to the emitter — all under the
    /// lock, so the order the sink sees is the order of `seq`.
    fn emit(&self, inner: &mut Inner, event: Event) {
        if inner.silenced {
            return;
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        inner.transcript.apply(&event);
        inner.last_seq = seq;
        let _ = inner.events.send(Envelope {
            instance_id: self.instance_id.clone(),
            seq,
            event,
        });
    }

    fn emit_all(&self, inner: &mut Inner, events: Vec<Event>) {
        for event in events {
            self.emit(inner, event);
        }
    }

    fn set_state(&self, inner: &mut Inner, state: SessionState) {
        if inner.status.state != state {
            inner.status.state = state;
            let status = inner.status.clone();
            self.emit(inner, Event::Status { status });
        }
    }

    fn set_hint(&self, inner: &mut Inner, hint: Hint) {
        if inner.status.hint != Some(hint) {
            inner.status.hint = Some(hint);
            let status = inner.status.clone();
            self.emit(inner, Event::Status { status });
        }
    }

    /// Drop a `SignedOut` hint once the agent reports someone signed in.
    /// `AdapterVersion` stays: it holds for the life of the process.
    fn clear_signed_out(&self, inner: &mut Inner) {
        if inner.status.hint == Some(Hint::SignedOut) {
            inner.status.hint = None;
            let status = inner.status.clone();
            self.emit(inner, Event::Status { status });
        }
    }

    /// Back to `Working` once nothing is waiting on the user.
    fn settle(&self, inner: &mut Inner) {
        if inner.approvals.is_empty() && inner.normalizer.turn().is_some() && !inner.closed {
            self.set_state(inner, SessionState::Working);
        }
    }

    fn complete_approval(&self, inner: &mut Inner, item_id: &str, answer: &str) {
        let Some(mut item) = inner.transcript.get(item_id).cloned() else {
            return;
        };
        match &mut item.kind {
            ItemKind::Approval { answer: slot, .. } => *slot = Some(answer.to_string()),
            // A question is only ever closed here unanswered.
            ItemKind::Question { outcome, .. } => *outcome = Some(QuestionOutcome::Cancelled),
            _ => {}
        }
        self.emit(inner, Event::ItemCompleted { item });
    }

    fn complete_question(&self, inner: &mut Inner, item_id: &str, answered: QuestionOutcome) {
        let Some(mut item) = inner.transcript.get(item_id).cloned() else {
            return;
        };
        if let ItemKind::Question { outcome, .. } = &mut item.kind {
            *outcome = Some(answered);
        }
        self.emit(inner, Event::ItemCompleted { item });
    }

    fn close_approvals(&self, inner: &mut Inner, answer: &str) {
        for waiting in std::mem::take(&mut inner.approvals) {
            self.send(wire::result(&waiting.rpc, waiting.cancelled()));
            self.complete_approval(inner, &waiting.item_id, answer);
        }
        self.settle(inner);
    }

    /// Read every running workflow's folder once a second, and send what
    /// changed, until none is left to read. The reads happen outside the
    /// lock; a read that finds nothing new sends nothing.
    fn watch_workflows(self: Arc<Self>) {
        loop {
            let due = {
                let mut inner = self.lock();
                if inner.closed || !inner.normalizer.watching() {
                    inner.watching = false;
                    return;
                }
                inner.normalizer.runs_to_read()
            };
            let read: Vec<_> = due
                .into_iter()
                .filter_map(|(task_id, launch)| Some((task_id, workflow::read(&launch)?)))
                .collect();
            {
                let mut inner = self.lock();
                for (task_id, run) in read {
                    let events = inner.normalizer.set_run(&task_id, run);
                    self.emit_all(&mut inner, events);
                }
            }
            thread::sleep(WORKFLOW_POLL);
        }
    }

    // --- the driver ------------------------------------------------------

    /// The prompt stays queued through the handshake, so a second one sent
    /// meanwhile is refused as busy and a cancel can still withdraw it.
    fn drive(self: Arc<Self>) {
        let mut ready = false;
        loop {
            {
                let mut inner = self.lock();
                while inner.prompt.is_none() && !inner.closed {
                    inner = self.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
                }
                if inner.closed {
                    return;
                }
            }
            if !ready {
                if let Err(failure) = self.handshake() {
                    self.fail(failure);
                    return;
                }
                ready = true;
            }
            self.turn();
        }
    }

    fn handshake(&self) -> Result<(), Failure> {
        let init = self
            .request("initialize", hello(), Some(HANDSHAKE))
            .map_err(Failure::from)?;
        let version = init
            .pointer("/agentInfo/version")
            .and_then(Value::as_str)
            .map(str::to_string);
        {
            let mut inner = self.lock();
            inner.status.adapter_version = version.clone();
            if let (Some(want), Some(have)) = (self.expected_version, &version) {
                if want != have {
                    inner.status.hint = Some(Hint::AdapterVersion);
                }
            }
        }
        if let Some(version) = &version {
            (self.log)(
                Level::Info,
                &format!("agent-host: {} adapter {}", self.instance_id, mask(version)),
            );
        }
        let http = init
            .pointer("/agentCapabilities/mcpCapabilities/http")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.lock().mcp_http = http;
        let left_out: Vec<&str> = (self.mcp_servers.iter())
            .filter(|s| !mcp::offered(s, http))
            .map(|s| s.name.as_str())
            .collect();
        if !left_out.is_empty() {
            let why = if http {
                "MCP server not on this machine"
            } else {
                "agent takes no HTTP MCP servers"
            };
            (self.log)(
                Level::Info,
                &format!(
                    "agent-host: {} {why}; not offered: {}",
                    self.instance_id,
                    left_out.join(", ")
                ),
            );
        }
        let cwd = self.worktree.path().to_string_lossy().into_owned();
        let servers = mcp::wire(&self.mcp_servers, http);
        // Its modes and settings are taken in by the reader.
        let new_params =
            session_options(self.harness, &cwd, servers, self.ultracode, &self.plugins);
        let new = self
            .send_request("session/new", new_params, carries_settings(None))
            .and_then(|id| self.finish(id, "session/new", Some(HANDSHAKE)))
            .map_err(Failure::from)?;
        let session_id = new
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or(Failure::Protocol("session/new returned no sessionId"))?
            .to_string();
        self.lock().session_id = Some(session_id.clone());
        // Fail closed: a session that cannot be put in ask-first mode does not
        // run, whatever mode the user's own settings would have chosen.
        self.request(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": self.ask_first }),
            Some(HANDSHAKE),
        )
        .map_err(|_| Failure::Protocol("the agent would not switch to ask-first mode"))?;
        if let Some(model) = &self.model {
            self.choose_model(&session_id, model);
        }
        let effort = if self.ultracode {
            ultra_reasoning(&self.lock())
        } else {
            self.effort.clone()
        };
        if let Some(effort) = effort {
            self.choose_effort(&session_id, &effort);
        }
        // Only now, with ask-first confirmed: a pick that fails leaves it there.
        let picked = match self.mode.as_deref() {
            Some(mode) if mode != self.ask_first => Some(self.choose_mode(&session_id, mode)),
            _ => None,
        };
        let mut inner = self.lock();
        // The agent has the last word, as once the session runs. A report
        // since the pick is read under the lock that ends the handshake, so
        // one is either taken here or shown once the session is Ready.
        let mode = match picked {
            Some(fallback) => inner
                .reported
                .take()
                .unwrap_or_else(|| fallback.to_string()),
            None => self.ask_first.to_string(),
        };
        inner.status.mode = Some(mode);
        if inner.closed {
            return Ok(());
        }
        inner.status.state = SessionState::Ready;
        let status = inner.status.clone();
        self.emit(&mut inner, Event::Status { status });
        Ok(())
    }

    /// Switch the session to `model`, the tab's choice, unless it is on it
    /// already. A model the agent no longer offers, or a switch it refuses,
    /// leaves the session on the agent's default, which its status shows: a
    /// model is not worth failing a session over.
    fn choose_model(&self, session_id: &str, model: &str) {
        let option = self
            .lock()
            .status
            .config
            .iter()
            .find(|o| o.category.as_deref() == Some(MODEL_CATEGORY))
            .filter(|o| o.value != model)
            .map(|o| (o.id.clone(), o.choices.iter().any(|c| c.value == model)));
        let Some((config_id, offered)) = option else {
            return;
        };
        let switched = offered
            && self
                .send_request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": config_id, "value": model }),
                    carries_settings(None),
                )
                .and_then(|id| self.finish(id, "session/set_config_option", Some(HANDSHAKE)))
                .is_ok();
        if !switched {
            (self.log)(
                Level::Info,
                &format!(
                    "agent-host: {} runs the agent's default model, not the one chosen",
                    self.instance_id
                ),
            );
        }
    }

    /// Switch the session to `mode`, the tab's pick before it started, if the
    /// agent offers it, and answer with the mode it is in afterwards unless
    /// the agent says otherwise. The offer is the status's, which never holds
    /// a mode held back, so this cannot reach one. Claude's settles on Accept
    /// edits when its model cannot run Auto, and says so in a report.
    /// A mode refused or no longer offered leaves the session asking first.
    fn choose_mode<'a>(&'a self, session_id: &str, mode: &'a str) -> &'a str {
        let (offered, option) = {
            let mut inner = self.lock();
            // Only a report that answers this pick counts, not ask-first's.
            inner.reported = None;
            let offered = inner.status.modes.iter().any(|m| m.value == mode);
            (offered, inner.mode_option.clone())
        };
        // As `set_mode` does: through the mode option when there is one, whose
        // reply carries every setting, else directly, taken as set.
        let (method, params, sets) = match option {
            Some(config_id) => (
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": mode }),
                None,
            ),
            None => (
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode }),
                Some(mode.to_string()),
            ),
        };
        let switched = offered
            && self
                .send_request(method, params, carries_settings(sets))
                .and_then(|id| self.finish(id, method, Some(HANDSHAKE)))
                .is_ok();
        if !switched {
            (self.log)(
                Level::Info,
                &format!(
                    "agent-host: {} stays in ask-first mode, not the one chosen",
                    self.instance_id
                ),
            );
        }
        if switched {
            mode
        } else {
            self.ask_first
        }
    }

    /// The chosen model determines which effort values are legal. Never send an invented level.
    fn choose_effort(&self, session_id: &str, effort: &str) {
        let option = self
            .lock()
            .status
            .config
            .iter()
            .find(|o| {
                o.category.as_deref() == Some("thought_level")
                    && o.choices.iter().any(|c| c.value == effort)
            })
            .map(|o| o.id.clone());
        let Some(config_id) = option else { return };
        let result = self
            .send_request(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": effort }),
                carries_settings(None),
            )
            .and_then(|id| self.finish(id, "session/set_config_option", Some(HANDSHAKE)));
        if result.is_err() {
            (self.log)(Level::Info, "agent-host: the agent refused the initial effort; its reported setting is retained");
        }
    }

    /// The handshake did not finish. Drawn even when the process has already
    /// exited, since that is usually why; not drawn, nor logged as a failure,
    /// when the host stopped it on purpose.
    fn fail(&self, failure: Failure) {
        let stopped = self.stopped.load(Ordering::SeqCst);
        if !stopped {
            let mut inner = self.lock();
            let hint = match &failure {
                Failure::SignedOut => Some(Hint::SignedOut),
                _ => inner.status.hint,
            };
            inner.status.hint = hint;
            if !inner.closed {
                inner.status.state = SessionState::Failed;
            }
            // The prompt was accepted and the tab cleared its draft, so it is
            // drawn before the error: the text the user typed stays on screen,
            // and Retry on the error finds it. A prompt a cancel withdrew is
            // gone and draws nothing.
            inner.status.pending_prompt = None;
            inner.prompt_context = None;
            inner.attached.clear();
            let mut events = match inner.prompt.take() {
                Some(text) => inner.normalizer.begin_turn(&text),
                None => Vec::new(),
            };
            events.extend(inner.normalizer.error(&failure.message(), hint));
            events.extend(inner.normalizer.end_turn("error"));
            self.emit_all(&mut inner, events);
            let status = inner.status.clone();
            self.emit(&mut inner, Event::Status { status });
        }
        (self.log)(
            if stopped { Level::Info } else { Level::Failure },
            &format!(
                "agent-host: {} handshake failed: {}",
                self.instance_id,
                mask(&failure.message())
            ),
        );
        self.send_close();
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        job::kill(&mut child, self.job.as_ref());
    }

    /// Run the queued prompt, if a cancel has not withdrawn it.
    fn turn(&self) {
        let (text, session_id, context, attached) = {
            let mut inner = self.lock();
            while inner.prompt.is_some()
                && inner.queued_change > inner.status.answered
                && !inner.closed
            {
                inner = self.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
            }
            if inner.closed {
                return;
            }
            let Some(text) = inner.prompt.take() else {
                return;
            };
            inner.status.pending_prompt = None;
            let events = inner.normalizer.begin_turn(&text);
            self.emit_all(&mut inner, events);
            self.set_state(&mut inner, SessionState::Working);
            (
                text,
                inner.session_id.clone().unwrap_or_default(),
                inner.prompt_context.take(),
                std::mem::take(&mut inner.attached),
            )
        };
        let mut blocks = Vec::new();
        if let Some(context) = context {
            blocks.push(json!({ "type": "text", "text": context }));
        }
        blocks.push(json!({ "type": "text", "text": text }));
        // After the text, as `refs/prompt` lays them out; the transcript shows only the text.
        blocks.extend(attached);
        let reply = self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": blocks
            }),
            None,
        );
        let mut inner = self.lock();
        if inner.closed {
            return;
        }
        let stop_reason = match reply {
            Ok(result) => {
                // A turn that ran means the user is signed in now, whatever an
                // earlier one said.
                if inner.status.hint == Some(Hint::SignedOut) {
                    inner.status.hint = None;
                }
                result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string()
            }
            Err(e) => {
                let hint = (e.code == AUTH_REQUIRED).then_some(Hint::SignedOut);
                if let Some(hint) = hint {
                    inner.status.hint = Some(hint);
                }
                let events = inner.normalizer.error(&e.message, hint);
                self.emit_all(&mut inner, events);
                "error".to_string()
            }
        };
        self.close_approvals(&mut inner, "cancelled");
        let events = inner.normalizer.end_turn(&stop_reason);
        self.emit_all(&mut inner, events);
        inner.status.state = SessionState::Ready;
        let status = inner.status.clone();
        self.emit(&mut inner, Event::Status { status });
        self.wake.notify_all();
    }

    /// Send a request and wait for its reply. `None` waits until the reply
    /// comes or the process exits.
    fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RemoteError> {
        let id = self.send_request(method, params, |_, _| {})?;
        self.finish(id, method, timeout)
    }

    /// Send a request with a slot for its reply. `track` notes anything else
    /// about it under the same lock, before the reply can arrive.
    fn send_request(
        &self,
        method: &str,
        params: Value,
        track: impl FnOnce(&mut Inner, i64),
    ) -> Result<i64, RemoteError> {
        let id = {
            let mut inner = self.lock();
            if inner.closed {
                return Err(closed());
            }
            inner.next_id += 1;
            let id = inner.next_id;
            inner.replies.insert(id, None);
            track(&mut inner, id);
            id
        };
        self.send(wire::request(&Id::Number(id), method, params));
        Ok(id)
    }

    /// Wait for the reply to `id`; past `timeout`, give up on it. The slot
    /// is checked and, once the time is up, dropped under one hold of the
    /// lock, so a reply cannot land between the two: it was either taken in
    /// by the reader before, and is the answer, or comes after and is
    /// ignored.
    fn finish(
        &self,
        id: i64,
        method: &str,
        timeout: Option<Duration>,
    ) -> Result<Value, RemoteError> {
        let deadline = timeout.map(|t| Instant::now() + t);
        self.await_reply(id, deadline, |inner| {
            inner.changing.remove(&id);
            inner.replies.remove(&id);
        })
        .unwrap_or_else(|| Err(timed_out(method)))
    }

    /// Wait for the reply to `id` until `deadline`. `None` if it passes
    /// first, after `give_up` has run under the hold of the lock that found
    /// no reply; without one the slot stays, and can still be waited for.
    fn await_reply(
        &self,
        id: i64,
        deadline: Option<Instant>,
        give_up: impl FnOnce(&mut Inner),
    ) -> Option<Result<Value, RemoteError>> {
        let mut inner = self.lock();
        loop {
            if let Some(Some(_)) = inner.replies.get(&id) {
                let reply = inner.replies.remove(&id).flatten();
                return Some(reply.unwrap_or_else(|| Err(closed())));
            }
            inner = match deadline {
                None => self.wake.wait(inner).unwrap_or_else(|e| e.into_inner()),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        give_up(&mut inner);
                        return None;
                    }
                    self.wake
                        .wait_timeout(inner, left)
                        .map(|(guard, _)| guard)
                        .unwrap_or_else(|e| e.into_inner().0)
                }
            };
        }
    }

    // --- the settings thread ---------------------------------------------

    /// Reconfiguration uses the latest acknowledged state, including settings
    /// queued immediately before Ultra. It never opts into another permission mode.
    fn workflow_params(&self, inner: &Inner, enabled: bool) -> Value {
        let mut params = session_options(
            self.harness,
            &inner.status.cwd,
            mcp::wire(&self.mcp_servers, inner.mcp_http),
            enabled,
            &self.plugins,
        );
        params["sessionId"] = json!(inner.session_id);
        let options = &mut params["_meta"]["claudeCode"]["options"];
        options["permissionMode"] = json!(inner
            .status
            .mode
            .as_deref()
            .filter(|mode| inner
                .status
                .modes
                .iter()
                .any(|choice| choice.value == *mode))
            .unwrap_or(self.ask_first));
        if let Some(model) = inner
            .status
            .config
            .iter()
            .find(|o| o.category.as_deref() == Some("model") && o.value != "default")
        {
            options["model"] = json!(model.value);
        }
        let effort = if enabled {
            ultra_reasoning(inner)
        } else {
            inner
                .status
                .config
                .iter()
                .find(|o| o.category.as_deref() == Some("thought_level") && o.value != "default")
                .map(|o| o.value.clone())
        };
        if let Some(effort) = effort {
            options["effort"] = json!(effort);
        }
        params
    }

    /// Send each change and wait for its reply before the next, so two quick
    /// changes land in the order they were made. The reader takes the reply's
    /// settings in; this ends in a status whose `answered` counts the change,
    /// so the tab knows its choice was answered, and whose `setting_trouble`
    /// holds a refusal. A change with no reply within the spec's
    /// `setting_timeout` is reported as unanswered, and still waited for, so
    /// a late reply is taken in and the next change never overtakes it. Of
    /// several waiting changes to one setting in a row, only the last is sent.
    fn change_settings(self: Arc<Self>, changes: &Receiver<Setting>) {
        let mut backlog: VecDeque<Change> = VecDeque::new();
        loop {
            let change = match backlog.pop_front() {
                Some(change) => change,
                None => match changes.recv() {
                    Ok(Setting::Change(change)) => change,
                    Ok(Setting::Close) | Err(_) => return,
                },
            };
            let Change {
                method,
                mut params,
                mode,
                ticket,
            } = change;
            let workflow = (method == "session/resume")
                .then(|| params.get("enabled").and_then(Value::as_bool))
                .flatten();
            if workflow.is_some() {
                // Resume updates the same conversation without replay. Let an active turn finish first.
                let mut inner = self.lock();
                while inner.normalizer.turn().is_some() && !inner.closed {
                    inner = self.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
                }
                if inner.closed {
                    return;
                }
                params = self.workflow_params(&inner, workflow == Some(true));
            }
            let resume_mode = workflow.and_then(|_| {
                params
                    .pointer("/_meta/claudeCode/options/permissionMode")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            let resume_session = params.get("sessionId").cloned();
            let Ok(id) = self.send_request(method, params, carries_settings(mode)) else {
                return;
            };
            let deadline = Instant::now() + self.setting_timeout;
            let mut reply = self.await_reply(id, Some(deadline), |_| {});
            if reply.is_none() {
                if !self.report(Some(SettingTrouble::Unanswered { ticket }), None) {
                    return;
                }
                reply = self.await_reply(id, None, |_| {});
            }
            let trouble = match reply.unwrap_or_else(|| Err(closed())) {
                Ok(_) => {
                    if let Some(mode) = resume_mode {
                        // A resumed SDK query may rebuild its permission state. Confirm
                        // the same allowed mode before releasing the next queued prompt.
                        let restored = self
                            .send_request(
                                "session/set_mode",
                                json!({ "sessionId": resume_session, "modeId": mode }),
                                carries_settings(Some(mode)),
                            )
                            .and_then(|id| {
                                self.finish(id, "session/set_mode", Some(self.setting_timeout))
                            });
                        if let Err(error) = restored {
                            self.stopped.store(true, Ordering::SeqCst);
                            self.send_close();
                            let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
                            job::kill(&mut child, self.job.as_ref());
                            drop(child);
                            self.report(
                                Some(SettingTrouble::Refused {
                                    ticket,
                                    message: refusal_reason(&error.message),
                                }),
                                Some(ticket),
                            );
                            return;
                        }
                    }
                    if let Some(enabled) = workflow {
                        let mut inner = self.lock();
                        inner.ultracode = enabled;
                        inner.workflow_option();
                    }
                    None
                }
                Err(e) => Some(SettingTrouble::Refused {
                    ticket,
                    message: refusal_reason(&e.message),
                }),
            };
            if !self.report(trouble, Some(ticket)) {
                return;
            }
            // Changes made while that one was out: of several to one setting
            // in a row, only the last is sent, so a user who stepped through
            // modes to reach one never puts the agent in the ones between.
            for setting in changes.try_iter() {
                match setting {
                    Setting::Change(change) => queue_behind(&mut backlog, change),
                    Setting::Close => return,
                }
            }
        }
    }

    /// Emit the status with `trouble`, and with the number of the change it
    /// answers, if it does. False once the session has closed.
    fn report(&self, trouble: Option<SettingTrouble>, answered: Option<u64>) -> bool {
        let mut inner = self.lock();
        if inner.closed {
            return false;
        }
        inner.status.setting_trouble = trouble;
        if let Some(ticket) = answered {
            inner.status.answered = ticket;
        }
        let status = inner.status.clone();
        self.emit(&mut inner, Event::Status { status });
        self.wake.notify_all();
        true
    }

    // --- the reader ------------------------------------------------------

    fn read(self: Arc<Self>, stdout: impl Read) {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            match read_line_capped(&mut reader, &mut buf, MESSAGE_LIMIT) {
                Ok(None) | Err(_) => return,
                Ok(Some(true)) => self.lock().noise += 1,
                Ok(Some(false)) => {
                    let line = String::from_utf8_lossy(&buf);
                    self.on_line(&mcp::scrub(&line, &self.mcp_servers));
                }
            }
        }
    }

    fn on_line(self: &Arc<Self>, line: &str) {
        match wire::parse(line) {
            None => self.lock().noise += 1,
            Some(Incoming::Response { id, outcome }) => {
                let Id::Number(n) = id else { return };
                let mut inner = self.lock();
                if let Some(asked) = inner.changing.remove(&n) {
                    if let Ok(result) = &outcome {
                        inner.answered(result, asked);
                    }
                }
                if let Some(slot) = inner.replies.get_mut(&n) {
                    *slot = Some(outcome);
                    self.wake.notify_all();
                }
            }
            Some(Incoming::Request { id, method, params }) => {
                if method == "session/request_permission" {
                    self.permission(id, &params);
                } else if method == "elicitation/create" {
                    self.elicit(id, &params);
                } else {
                    // We declared no file system and no terminal; anything
                    // else the agent asks for is not ours to do.
                    self.send(wire::error(
                        &id,
                        METHOD_NOT_FOUND,
                        "not supported by this client",
                    ));
                }
            }
            Some(Incoming::Notification { method, params }) => match method.as_str() {
                "session/update" => {
                    let mut inner = self.lock();
                    if inner.closed {
                        return;
                    }
                    let update = params.get("update").unwrap_or(&Value::Null);
                    let cycling = inner.normalizer.autonomous();
                    let events = inner.normalizer.update(update);
                    self.emit_all(&mut inner, events);
                    // The agent started or finished working on its own.
                    if inner.normalizer.autonomous() != cycling && inner.prompt.is_none() {
                        let state = if cycling {
                            SessionState::Ready
                        } else {
                            SessionState::Working
                        };
                        if inner.approvals.is_empty() {
                            self.set_state(&mut inner, state);
                        }
                    }
                    if !inner.watching && inner.normalizer.watching() {
                        inner.watching = true;
                        let s = Arc::clone(self);
                        spawn("agent-workflows", move || s.watch_workflows());
                    }
                    let mode = inner.normalizer.take_mode();
                    let settings = inner.normalizer.take_settings();
                    let commands = inner.normalizer.take_commands();
                    let title = inner.normalizer.take_title();
                    if mode.is_none() && settings.is_none() && commands.is_none() && title.is_none()
                    {
                        return;
                    }
                    if let Some(commands) = commands {
                        inner.status.commands = commands;
                    }
                    if title.is_some() {
                        inner.status.session_title = title;
                    }
                    if let Some(mode) = mode {
                        inner.show_mode(mode);
                        inner.mode_reports += 1;
                    }
                    if let Some(settings) = settings {
                        if settings.mode.is_some() {
                            inner.mode_reports += 1;
                        }
                        inner.apply(settings);
                    }
                    // During the handshake, the status it ends with carries
                    // these; one per update would only flicker.
                    if inner.status.state != SessionState::Starting {
                        let status = inner.status.clone();
                        self.emit(&mut inner, Event::Status { status });
                    }
                }
                "$/cancel_request" => {
                    let Some(rpc) = params
                        .get("requestId")
                        .and_then(|id| serde_json::from_value::<Id>(id.clone()).ok())
                    else {
                        return;
                    };
                    let mut inner = self.lock();
                    if let Some(index) = inner.approvals.iter().position(|w| w.rpc == rpc) {
                        let waiting = inner.approvals.remove(index);
                        self.complete_approval(&mut inner, &waiting.item_id, "cancelled");
                        self.settle(&mut inner);
                    }
                }
                // Only whether anyone is signed in. The rest of the payload —
                // the account's email and organization — is never read.
                "_auth/status_update" => {
                    let kind = params.pointer("/authStatus/kind").and_then(Value::as_str);
                    let mut inner = self.lock();
                    match kind {
                        Some("none") => self.set_hint(&mut inner, Hint::SignedOut),
                        Some(_) => self.clear_signed_out(&mut inner),
                        None => {}
                    }
                }
                _ => {}
            },
        }
    }

    fn permission(&self, rpc: Id, params: &Value) {
        let call = params.get("toolCall").unwrap_or(&Value::Null);
        let id = call.get("toolCallId").and_then(Value::as_str);
        let reported = self.lock().normalizer.tool_paths(id.unwrap_or_default());
        let call = with_reported(call, reported);
        let paths = request_scope(&self.worktree, &call);
        let escapes = escapes(&self.worktree, &call);
        let mut inner = self.lock();
        if inner.closed {
            return;
        }
        if inner.approvals.len() >= MAX_PENDING_APPROVALS {
            // A flood of requests nobody answered: refuse the extra ones
            // rather than hold one more card and one more reply slot each.
            inner.normalizer.drop_one();
            self.send(wire::result(&rpc, cancelled()));
            return;
        }
        let events = inner.normalizer.close_text();
        self.emit_all(&mut inner, events);
        let mut item = inner.normalizer.approval(params, paths);
        if !escapes.is_empty() {
            // Refused without asking: no choice the user could make here is
            // one the host will honour.
            let reject = params
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|o| {
                    o.get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|k| k.starts_with("reject"))
                })
                .and_then(|o| o.get("optionId").and_then(Value::as_str));
            self.send(wire::result(
                &rpc,
                reject.map(selected).unwrap_or_else(cancelled),
            ));
            if let ItemKind::Approval { answer, .. } = &mut item.kind {
                *answer = Some("outside".to_string());
            }
            self.emit(&mut inner, Event::ItemCompleted { item });
            let events = inner
                .normalizer
                .error(&escapes.join("\n"), Some(Hint::OutsideWorktree));
            self.emit_all(&mut inner, events);
            return;
        }
        let item_id = item.id.clone();
        self.emit(&mut inner, Event::ItemStarted { item });
        inner.approvals.push(Waiting {
            item_id,
            rpc,
            form: None,
        });
        self.set_state(&mut inner, SessionState::NeedsInput);
    }

    /// An `elicitation/create`: the agent asks the user a question. Only the
    /// form mode is declared, so anything else is declined unasked.
    fn elicit(&self, rpc: Id, params: &Value) {
        let mut inner = self.lock();
        if inner.closed {
            return;
        }
        let Some((card, form)) = elicit::read(params) else {
            self.send(wire::result(&rpc, json!({ "action": "decline" })));
            return;
        };
        if inner.approvals.len() >= MAX_PENDING_APPROVALS {
            inner.normalizer.drop_one();
            self.send(wire::result(&rpc, json!({ "action": "cancel" })));
            return;
        }
        let events = inner.normalizer.close_text();
        self.emit_all(&mut inner, events);
        let item = inner.normalizer.question(card);
        let item_id = item.id.clone();
        self.emit(&mut inner, Event::ItemStarted { item });
        inner.approvals.push(Waiting {
            item_id,
            rpc,
            form: Some(form),
        });
        self.set_state(&mut inner, SessionState::NeedsInput);
    }

    // --- stderr and exit -------------------------------------------------

    fn read_stderr(self: Arc<Self>, stderr: impl Read) {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            match read_line_capped(&mut reader, &mut buf, STDERR_LINE) {
                Ok(None) | Err(_) => break,
                Ok(Some(cut)) => {
                    let line = String::from_utf8_lossy(&buf);
                    let line = line.trim_end();
                    let line = if cut {
                        mask(&mcp::scrub_cut(line, &self.mcp_servers))
                    } else {
                        mask(&mcp::scrub(line, &self.mcp_servers))
                    };
                    let mut tail = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
                    if tail.len() == STDERR_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        }
        self.stderr_done.store(true, Ordering::SeqCst);
    }

    fn wait_for_exit(self: Arc<Self>) {
        let code = loop {
            let polled = self
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .try_wait();
            match polled {
                Ok(Some(status)) => break status.code(),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break None,
            }
        };
        let (dropped, noise, ready) = {
            let mut inner = self.lock();
            inner.closed = true;
            inner.prompt_context = None;
            inner.attached.clear();
            // Nothing is left to answer a change, or to change.
            inner.status.setting_trouble = None;
            for slot in inner.replies.values_mut() {
                if slot.is_none() {
                    *slot = Some(Err(closed()));
                }
            }
            for waiting in std::mem::take(&mut inner.approvals) {
                self.complete_approval(&mut inner, &waiting.item_id, "cancelled");
            }
            let events = inner.normalizer.end_turn("error");
            self.emit_all(&mut inner, events);
            let events = inner.normalizer.end_tasks();
            self.emit_all(&mut inner, events);
            let ready = inner.status.state != SessionState::Starting
                && inner.status.state != SessionState::Failed;
            if inner.status.state != SessionState::Failed {
                inner.status.state = if ready {
                    SessionState::Stopped
                } else {
                    SessionState::Failed
                };
            }
            inner.status.exit_code = code;
            let status = inner.status.clone();
            self.emit(&mut inner, Event::Status { status });
            self.wake.notify_all();
            let _ = self.settings.send(Setting::Close);
            (inner.normalizer.dropped(), inner.noise, ready)
        };
        let code_text = code.map_or("none".to_string(), |c| c.to_string());
        let failed = !self.stopped.load(Ordering::SeqCst) && (code != Some(0) || !ready);
        let level = if failed { Level::Failure } else { Level::Info };
        (self.log)(
            level,
            &format!(
                "agent-host: {} exited with code {code_text}; {dropped} updates dropped, {noise} non-protocol lines",
                self.instance_id
            ),
        );
        if failed {
            // Give stderr a moment to reach its end, so the tail is the last
            // thing the agent said rather than whatever had arrived.
            let until = Instant::now() + Duration::from_millis(300);
            while !self.stderr_done.load(Ordering::SeqCst) && Instant::now() < until {
                thread::sleep(Duration::from_millis(10));
            }
            let tail = self
                .stderr
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            for line in tail {
                (self.log)(
                    Level::Failure,
                    &format!("agent-host: {} stderr: {line}", self.instance_id),
                );
            }
        }
    }
}

/// Why the handshake did not finish.
enum Failure {
    SignedOut,
    Remote(RemoteError),
    Protocol(&'static str),
}

impl From<RemoteError> for Failure {
    fn from(e: RemoteError) -> Self {
        if e.code == AUTH_REQUIRED {
            Failure::SignedOut
        } else {
            Failure::Remote(e)
        }
    }
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Failure::SignedOut => "authentication required".to_string(),
            Failure::Remote(e) => e.message.clone(),
            Failure::Protocol(m) => (*m).to_string(),
        }
    }
}

/// A permission request's tool call, with the files that call named earlier
/// added to its locations. Codex's file-change request names only the file a
/// change edits; where a move puts it is in the diff the change started with.
fn with_reported(call: &Value, reported: Vec<String>) -> Value {
    let mut call = call.clone();
    if let Some(fields) = call.as_object_mut().filter(|_| !reported.is_empty()) {
        let mut locations = fields
            .get("locations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        locations.extend(reported.into_iter().map(|path| json!({ "path": path })));
        fields.insert("locations".to_string(), Value::Array(locations));
    }
    call
}

fn selected(option_id: &str) -> Value {
    json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
}

fn cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

fn closed() -> RemoteError {
    RemoteError {
        code: CLOSED,
        message: "the agent exited".to_string(),
    }
}

fn timed_out(method: &str) -> RemoteError {
    RemoteError {
        code: TIMED_OUT,
        message: format!("{method} got no reply"),
    }
}

/// Add `change` to the changes still to send. It takes the place of the last
/// one if that sets the same thing: a later choice answers an earlier one that
/// was never sent, and its number covers the earlier number.
fn queue_behind(backlog: &mut VecDeque<Change>, change: Change) {
    let same = |a: &Change| {
        a.method == change.method && a.params.get("configId") == change.params.get("configId")
    };
    match backlog.back_mut() {
        Some(last) if same(last) => *last = change,
        _ => backlog.push_back(change),
    }
}

/// An agent's reason for refusing a change, as it is stored and sent with
/// every status: its first line, masked, and cut to [`REFUSAL_REASON`]
/// characters with an ellipsis.
fn refusal_reason(message: &str) -> String {
    let line = message
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let line = mask(line);
    match line.char_indices().nth(REFUSAL_REASON) {
        Some((end, _)) => format!("{}…", line[..end].trim_end()),
        None => line,
    }
}

/// Claude's documented adapter extension scopes workflow settings to this query only.
///
/// `plugins` go the same way: the adapter spreads `_meta.claudeCode.options`
/// into the SDK's options, whose `plugins` start `claude` with one
/// `--plugin-dir` each. `skipMcpDiscovery` because a built-in skill's plugin
/// brings no servers; Veistra's own arrive in `mcpServers`.
///
/// Veistra's own agent takes its skill folders as `_meta.veistra.skills`
/// (`SkillDelivery::SessionFolder`).
fn session_options(
    harness: Harness,
    cwd: &str,
    servers: Value,
    ultracode: bool,
    plugins: &[PathBuf],
) -> Value {
    let mut params = json!({ "cwd": cwd, "mcpServers": servers });
    if harness == Harness::Claude {
        params["_meta"] =
            json!({ "claudeCode": { "options": { "settings": { "ultracode": ultracode } } } });
        if !plugins.is_empty() {
            // `iter().map(..).collect()` builds a `Vec<Value>`, which `json!`
            // turns into an array.
            let list: Vec<Value> = plugins
                .iter()
                .map(|dir| {
                    json!({
                        "type": "local",
                        "path": dir.to_string_lossy(),
                        "skipMcpDiscovery": true,
                    })
                })
                .collect();
            params["_meta"]["claudeCode"]["options"]["plugins"] = json!(list);
        }
    }
    if harness == Harness::Veistra && !plugins.is_empty() {
        let list: Vec<Value> = plugins
            .iter()
            .map(|dir| json!(dir.to_string_lossy()))
            .collect();
        params["_meta"] = json!({ "veistra": { "skills": list } });
    }
    params
}

/// Ultra means Claude's xhigh reasoning plus workflows, falling back only to
/// a reasoning level this model actually advertises.
fn ultra_reasoning(inner: &Inner) -> Option<String> {
    let option = inner
        .status
        .config
        .iter()
        .find(|o| o.category.as_deref() == Some("thought_level"))?;
    ["xhigh", "max", "high", "medium", "low"]
        .into_iter()
        .find(|value| option.choices.iter().any(|choice| choice.value == *value))
        .map(str::to_owned)
}

/// `initialize`'s params, which every agent the host starts is sent. They
/// declare no file system or terminal, so the agent never asks Veistra to
/// read or write a file, run a command, or open a URL. They do declare form
/// elicitation: it is how every agent asks the user a question, and Claude's
/// adapter disallows its AskUserQuestion tool without it (see `elicit.rs`).
///
/// The rest is for Claude's adapter, and an agent that knows none of it
/// ignores it; each key says what it is for.
pub(crate) fn hello() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
            "elicitation": { "form": {} },
            // Advisories and compaction as updates of their own, rather than
            // as text in the answer and a made-up tool call.
            "session": { "notices": {}, "compaction": {} },
            // `subagent-transcript` forwards what a subagent writes, marked
            // with the call that started it, so it nests under that call.
            //
            // AIR's `asyncTasks` reports background work (workflows, shell
            // commands, monitors) as tasks the user can stop. It also sends
            // a tool's `_meta` only once (remembered in `normalize.rs`) and
            // drops Read and Grep calls' text output. AIR's `subagents` is
            // left out: it hides the subagent's call, where its work is drawn.
            "_meta": {
                "subagent-transcript": true,
                "jetbrains": { "air": { "version": 1, "capabilities": ["asyncTasks"] } }
            }
        },
        "clientInfo": { "name": "veistra", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// Mark a request as one whose reply carries the settings, for the reader to
/// take in. `mode` is the mode a `session/set_mode` sets.
fn carries_settings(mode: Option<String>) -> impl FnOnce(&mut Inner, i64) {
    move |inner, id| {
        let reports = inner.mode_reports;
        inner.changing.insert(id, Asked { mode, reports });
    }
}

/// Read one line into `buf`, keeping at most `limit` bytes of it and reading
/// past the rest. `None` at the end of the stream; otherwise whether the line
/// was cut.
pub(crate) fn read_line_capped(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut cut = false;
    let mut any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(any.then_some(cut));
        }
        any = true;
        let end = available.iter().position(|&b| b == b'\n');
        let used = end.map_or(available.len(), |i| i + 1);
        let room = limit.saturating_sub(buf.len());
        cut |= used > room;
        buf.extend_from_slice(&available[..used.min(room)]);
        reader.consume(used);
        if end.is_some() {
            return Ok(Some(cut));
        }
    }
}

fn write_lines(mut stdin: ChildStdin, lines: &Receiver<Line>) {
    for line in lines {
        match line {
            Line::Send(text) => {
                let written = stdin
                    .write_all(text.as_bytes())
                    .and_then(|()| stdin.write_all(b"\n"))
                    .and_then(|()| stdin.flush());
                if written.is_err() {
                    return;
                }
            }
            Line::Close => return,
        }
    }
}

fn spawn(name: &str, work: impl FnOnce() + Send + 'static) {
    // A thread that cannot start leaves the session without that part; the
    // waiter or the reader still ends it, and the process is killed on drop.
    let _ = thread::Builder::new().name(name.to_string()).spawn(work);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_settings_are_scoped_to_claudes_session_options() {
        let claude = session_options(Harness::Claude, "C:/tree", json!([]), true, &[]);
        assert_eq!(
            claude["_meta"]["claudeCode"]["options"]["settings"]["ultracode"],
            true
        );
        assert!(
            claude["_meta"]["claudeCode"]["options"]
                .get("plugins")
                .is_none(),
            "no plugin key without a plugin"
        );
        let off = session_options(Harness::Claude, "C:/tree", json!([]), false, &[]);
        assert_eq!(
            off["_meta"]["claudeCode"]["options"]["settings"]["ultracode"],
            false
        );
        let codex = session_options(Harness::Codex, "C:/tree", json!([]), true, &[]);
        assert!(codex.get("_meta").is_none());
    }

    #[test]
    fn built_in_skill_plugins_reach_claude_and_only_claude() {
        let plugins = [PathBuf::from("C:/veistra/skills/claude/agent-ready-canvas")];
        let claude = session_options(Harness::Claude, "C:/tree", json!([]), false, &plugins);
        assert_eq!(
            claude["_meta"]["claudeCode"]["options"]["plugins"],
            json!([{
                "type": "local",
                "path": "C:/veistra/skills/claude/agent-ready-canvas",
                "skipMcpDiscovery": true,
            }])
        );
        let codex = session_options(Harness::Codex, "C:/tree", json!([]), false, &plugins);
        assert!(codex.get("_meta").is_none(), "Codex has no plugin option");
    }

    #[test]
    fn veistras_skill_folders_reach_it_as_its_own_meta() {
        let folders = [PathBuf::from(
            "C:/veistra/skills/veistra/agent-ready-canvas",
        )];
        let veistra = session_options(Harness::Veistra, "C:/tree", json!([]), true, &folders);
        assert_eq!(
            veistra["_meta"],
            json!({ "veistra": { "skills": ["C:/veistra/skills/veistra/agent-ready-canvas"] } }),
            "only its skills: Ultra is Claude's alone"
        );
        let none = session_options(Harness::Veistra, "C:/tree", json!([]), false, &[]);
        assert!(none.get("_meta").is_none());
    }

    #[test]
    fn a_refusal_reason_is_one_masked_line_of_bounded_length() {
        assert_eq!(refusal_reason("Internal error: no"), "Internal error: no");
        assert_eq!(refusal_reason(""), "");
        // The first line only, so a stack stays out of every status.
        assert_eq!(
            refusal_reason("\n  Invalid Mode: plan\n    at run (agent.js:1)\n"),
            "Invalid Mode: plan"
        );
        assert_eq!(
            refusal_reason("bad key sk-abcdefghijklmnopqrstuvwxyz"),
            "bad key <redacted>"
        );
        // Cut on a character boundary, however wide the characters are.
        let long = "é".repeat(REFUSAL_REASON + 50);
        let cut = refusal_reason(&long);
        assert_eq!(cut.chars().count(), REFUSAL_REASON + 1);
        assert!(cut.ends_with('…'));
        // Exactly the limit is kept whole.
        let exact = "x".repeat(REFUSAL_REASON);
        assert_eq!(refusal_reason(&exact), exact);
    }

    #[test]
    fn a_long_line_is_cut_and_the_next_one_is_whole() {
        let mut reader = BufReader::with_capacity(4, "abcdefgh\nxy\nz".as_bytes());
        let mut buf = Vec::new();
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            Some(true)
        );
        assert_eq!(buf, b"abcde");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            Some(false)
        );
        assert_eq!(buf, b"xy\n");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            Some(false)
        );
        assert_eq!(buf, b"z");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 5).unwrap(), None);
    }

    fn inner() -> Inner {
        let (events, _) = mpsc::channel();
        Inner {
            ultracode: false,
            mcp_http: false,
            closed: false,
            next_id: 0,
            replies: HashMap::new(),
            prompt: None,
            prompt_context: None,
            attached: Vec::new(),
            queued_change: 0,
            approvals: Vec::new(),
            normalizer: Normalizer::new("t", crate::harness::Harness::Claude),
            transcript: Transcript::from_items(Vec::new()),
            status: SessionStatus {
                state: SessionState::Starting,
                harness: crate::harness::Harness::Claude,
                cwd: String::new(),
                mode: None,
                modes: Vec::new(),
                config: Vec::new(),
                commands: Vec::new(),
                answered: 0,
                setting_trouble: None,
                adapter_version: None,
                exit_code: None,
                hint: None,
                pending_prompt: None,
                session_title: None,
            },
            session_id: None,
            mode_option: None,
            changing: HashMap::new(),
            mode_reports: 0,
            reported: None,
            events,
            last_seq: 0,
            noise: 0,
            watching: false,
            silenced: false,
        }
    }

    #[test]
    fn a_mode_is_shown_only_once_ask_first_is_confirmed() {
        for (state, shown) in [
            (SessionState::Starting, false),
            (SessionState::Failed, false),
            (SessionState::Stopped, false),
            (SessionState::Ready, true),
            (SessionState::Working, true),
            (SessionState::NeedsInput, true),
        ] {
            let mut inner = inner();
            inner.status.state = state;
            inner.show_mode("auto".to_string());
            assert_eq!(
                inner.status.mode.is_some(),
                shown,
                "the user's own mode, in {state:?}"
            );
        }
    }
}
