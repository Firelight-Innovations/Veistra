//! The agent tab's Rust half: one coding agent per tab, run in its cluster's
//! worktree through `veistra-agent-host`.
//!
//! The crate does the work — the process, the protocol, the transcript. This
//! module decides *where* a session may run and *who* may drive it, which are
//! questions about the shell's layout that the crate cannot answer:
//!
//! - **Only a local worktree or main.** The cluster's write environment must
//!   be `LocalWorktree` or `Main`, and the crate's `Worktree::new` checks that
//!   the folder is a git checkout. Handoff §0 kept agents off main; that rule
//!   was lifted, and main is worked in like a worktree.
//! - **Only the tab's own frame, or the shell on its behalf.** Every method but
//!   `agent-tab/harnesses` needs the calling instance, which reaches here only
//!   through [`call_for`] from `commands::app_call`. The MCP `app_call` path
//!   has no instance, so an agent cannot prompt or approve for a person.
//! - **Developer mode only**, until the owner signs off V6.
//! - **Only where it started.** A tab that changes cluster, or whose cluster
//!   is repointed, loses its session (see `Home`).
//!
//! Events leave as `agent-tab:event`; `ToolWindow` relays each to its frame.

use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use veistra_agent_host::harness::installed_spec as spec;
use veistra_agent_host::models::{self, Catalogue, Models};
use veistra_agent_host::{
    harness, AgentHost, Harness, HarnessInfo, HostError, LaunchSpec, Level, McpServer,
    QuestionOutcome, Worktree, REGISTRY,
};
use veistra_rpc::{RpcError, INVALID_PARAMS, METHOD_NOT_FOUND};

use crate::apps::CallContext;
use crate::environments::Environment;
use crate::refs;
use crate::shell_state::{ShellSnapshot, ShellState};

/// The app id, as `REGISTRY` and the frontend's entry point spell it.
pub const ID: &str = "agent-tab";

/// The event every envelope is emitted as. Mirrored in `src/bindings.ts`.
pub const EVENT: &str = "agent-tab:event";

/// The event a tab's choice is emitted as, `{ instanceId, harness, model }`, so
/// every view of the tab shows the same one. Mirrored in `src/bindings.ts`.
pub const CHOSEN: &str = "agent-tab:chosen";

/// The event a tab is sent, `{ instanceId, harness, ok }`, when the sign-in it
/// started has ended. Mirrored in `src/bindings.ts`.
pub const LOGIN: &str = "agent-tab:login";

/// The event each open agent tab is sent, `{ instanceId, harness }`, once
/// `harness`'s agent has said which models it offers, so the tab asks
/// `agent-tab/harnesses` again. Mirrored in `src/bindings.ts`.
pub const MODELS: &str = "agent-tab:models";

/// The event a tab is sent, `{ instanceId }`, when a saved session was opened
/// in it by someone else, such as the shell's Agents page, so the tab attaches
/// again and shows it. Mirrored in `src/bindings.ts`.
pub const RESTORED: &str = "agent-tab:restored";

/// The event, `{}`, after a saved session was written, archived or opened,
/// so the Agents page lists them again. Mirrored in `src/bindings.ts`.
pub const HISTORY: &str = "agent-tab:history";

/// The history methods that answer for a cluster's project with no tab
/// behind them: the shell's Agents page lists and archives saved sessions
/// with these. Neither runs an agent or reads one tab's session.
const PROJECT_METHODS: &[&str] = &["agent-tab/history", "agent-tab/history-archive"];

/// How long an agent gets to answer each request of a models ask, as long
/// as a session's handshake gives it.
const MODELS_WAIT: Duration = Duration::from_secs(60);

/// The JSON-RPC code for a refusal this module or the host made. `data.code`
/// says which; the tab draws the words for it from its own `strings.ts`.
pub const REFUSED: i32 = -32010;

/// How long the app's exit waits for agents to die.
const EXIT_WAIT: Duration = Duration::from_secs(3);

/// The methods that act on one tab's session, and so need that tab.
const INSTANCE_METHODS: &[&str] = &[
    "agent-tab/send",
    "agent-tab/attach",
    "agent-tab/cancel",
    "agent-tab/stop-task",
    "agent-tab/answer",
    "agent-tab/set-mode",
    "agent-tab/set-config",
    "agent-tab/stop",
    "agent-tab/reset",
    "agent-tab/choose",
    "agent-tab/login",
    "agent-tab/install",
    "agent-tab/get-node",
    "agent-tab/btw-send",
    "agent-tab/btw-attach",
    "agent-tab/btw-cancel",
    "agent-tab/btw-reset",
    "agent-tab/btw-answer",
    "agent-tab/cli-command",
    "agent-tab/context-sources",
    "agent-tab/cluster-context",
    "agent-tab/history",
    "agent-tab/history-save",
    "agent-tab/history-open",
    "agent-tab/history-archive",
    "agent-tab/session-meta",
    "agent-tab/set-session-meta",
    "agent-tab/environment",
];

/// The methods that advance an agent, and so run only with developer mode on.
/// An approval advances it as much as a prompt does, and a mode decides what
/// it may do unasked; the model and effort are set with the mode. Every one is
/// also a write to the cluster's checkout, so it is in `apps::WRITE_METHODS`
/// too.
const GATED_METHODS: &[&str] = &[
    "agent-tab/cli-command",
    "agent-tab/btw-send",
    "agent-tab/btw-answer",
    "agent-tab/send",
    "agent-tab/answer",
    "agent-tab/set-mode",
    "agent-tab/set-config",
];

/// The instance methods developer mode never blocks, on purpose: they read,
/// they end what is running, or, as `choose` does, they only name the harness
/// the next session runs. A person who turned developer mode off has to be
/// able to stop an agent that is still going. Only the test that holds
/// [`gate`] to this list reads it.
#[cfg(test)]
const UNGATED_METHODS: &[&str] = &[
    "agent-tab/history",
    "agent-tab/history-save",
    "agent-tab/history-open",
    "agent-tab/history-archive",
    "agent-tab/session-meta",
    "agent-tab/set-session-meta",
    "agent-tab/environment",
    "agent-tab/context-sources",
    "agent-tab/cluster-context",
    "agent-tab/btw-attach",
    "agent-tab/btw-cancel",
    "agent-tab/btw-reset",
    "agent-tab/attach",
    "agent-tab/cancel",
    "agent-tab/stop-task",
    "agent-tab/stop",
    "agent-tab/reset",
    "agent-tab/choose",
    "agent-tab/login",
    "agent-tab/install",
    "agent-tab/get-node",
];

/// The host, built on first use so it can hold the `AppHandle` it emits on,
/// where each tab's session started, and what each tab has chosen.
#[derive(Default)]
pub struct Sessions {
    history: super::agent_history::History,
    history_dir: OnceLock<PathBuf>,
    host: OnceLock<AgentHost>,
    homes: Mutex<HashMap<String, Home>>,
    chosen: Mutex<HashMap<String, Choice>>,
    /// What each harness's agent offers in each worktree, asked once per
    /// launch.
    models: Catalogue,
    /// The harnesses `agent-tab/install` is installing now.
    pub(super) installs: super::agent_install::Installs,
    /// Held by a send from reading the tab's harness until its agent has
    /// started, and by a choice from its check until it is stored. Without
    /// it, a choice could land in between, and the tab would run one harness
    /// while holding another as its choice.
    turn: Mutex<()>,
}

impl Sessions {
    /// Each agent tab's environment root, and whether its session is busy
    /// there: starting, running a turn, or waiting on an approval.
    pub fn activity(&self) -> Vec<crate::agent_activity::Seen> {
        let Some(host) = self.host.get() else {
            return Vec::new();
        };
        let homes: Vec<(String, Home)> = self
            .homes()
            .iter()
            .map(|(id, home)| (id.clone(), home.clone()))
            .collect();
        homes
            .into_iter()
            .map(|(id, home)| crate::agent_activity::Seen {
                root: home
                    .environment
                    .as_ref()
                    .and_then(|e| e.root(home.project.as_deref().map(Path::new))),
                working: host.state(&id).is_some_and(|s| {
                    matches!(
                        s,
                        veistra_agent_host::SessionState::Starting
                            | veistra_agent_host::SessionState::Working
                            | veistra_agent_host::SessionState::NeedsInput
                    )
                }),
            })
            .collect()
    }
}

/// What a tab chose for its next session. Generic, as [`choose`] is, so it
/// is tested with more harnesses than the registry has yet.
#[derive(Debug, Clone)]
struct Choice<H = Harness> {
    harness: H,
    /// The model chosen for each harness, by value. A harness with none
    /// starts on its agent's default.
    models: HashMap<H, String>,
}

impl<H: Copy + Eq + Hash> Choice<H> {
    /// The model chosen for `harness`, or `None` for its agent's default.
    fn model(&self, harness: H) -> Option<String> {
        self.models.get(&harness).cloned()
    }
}

// By hand: a derive would ask only `H: PartialEq`, and comparing the maps
// needs `H: Eq + Hash`.
impl<H: Eq + Hash> PartialEq for Choice<H> {
    fn eq(&self, other: &Self) -> bool {
        self.harness == other.harness && self.models == other.models
    }
}

/// The cluster a tab's session started in, and what that cluster pointed at
/// then. When any of it changes, the session is no longer this tab's to run.
#[derive(Debug, Clone, PartialEq)]
struct Home {
    cluster_id: String,
    environment: Option<Environment>,
    project: Option<String>,
}

/// Where the tab `instance_id` sits now, or `None` if it is in no tree.
fn home_of(snapshot: &ShellSnapshot, instance_id: &str) -> Option<Home> {
    snapshot
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.tree.tabs().contains(&instance_id))
        .map(|c| Home {
            cluster_id: c.id.clone(),
            environment: c.environment.clone(),
            project: c.project.clone(),
        })
}

impl Home {
    /// The folder the tab's session ran in: [`worktree_path`] for this home.
    fn root(&self) -> Result<PathBuf, RpcError> {
        worktree_path(
            self.environment.as_ref(),
            self.project.as_deref().map(Path::new),
        )
    }
}

impl Sessions {
    fn homes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Home>> {
        self.homes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn chosen(&self) -> std::sync::MutexGuard<'_, HashMap<String, Choice>> {
        self.chosen.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The harness the tab's next prompt goes to.
    fn current(&self, host: &AgentHost, instance_id: &str) -> Harness {
        current(
            host.running(instance_id),
            self.chosen().get(instance_id).map(|c| c.harness),
        )
    }

    fn turn(&self) -> std::sync::MutexGuard<'_, ()> {
        self.turn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `start` handed the harness the tab's next prompt goes to, the model
    /// the tab chose for it, and what `prepare` made ready. `prepare` runs
    /// before the tab's turn, so however long it takes, no other send or
    /// choice waits on it. Once it is done, no choice lands until `start`
    /// returns, so `start` starts what the tab still holds.
    fn send_as<R, T>(
        &self,
        host: &AgentHost,
        instance_id: &str,
        prepare: impl FnOnce() -> R,
        start: impl FnOnce(Harness, Option<String>, R) -> T,
    ) -> T {
        let prepared = prepare();
        let _turn = self.turn();
        let harness = self.current(host, instance_id);
        let model = self
            .chosen()
            .get(instance_id)
            .and_then(|c| c.model(harness));
        start(harness, model, prepared)
    }

    /// [`choose`], holding the tab's turn from its check until the choice is
    /// stored.
    fn choose(
        &self,
        host: &AgentHost,
        instance_id: &str,
        harness: Harness,
        model: Option<Option<String>>,
        open: impl FnOnce() -> bool,
    ) -> Result<Value, RpcError> {
        let _turn = self.turn();
        host.transfer(instance_id, harness).map_err(host_error)?;
        choose(
            &self.chosen,
            instance_id,
            host.running(instance_id),
            harness,
            model,
            open,
        )
    }

    /// Ask `launch`'s agent for its models in `worktree`, unless it has been
    /// asked there this launch. Every open agent tab hears once it has
    /// answered.
    fn ask_models(&self, app: &AppHandle, launch: LaunchSpec, worktree: Worktree) {
        let harness = launch.harness;
        let app = app.clone();
        self.models.ask(
            harness,
            &worktree.path(),
            move || models::ask(&launch, &worktree, MODELS_WAIT),
            move || tell_tabs(&app, harness),
        );
    }

    fn host(&self, app: &AppHandle) -> &AgentHost {
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = self.history_dir.set(dir.join("agent-conversations"));
        }
        self.host.get_or_init(|| {
            let emitter = app.clone();
            AgentHost::new(
                Arc::new(move |envelope| {
                    let _ = emitter.emit(EVENT, &envelope);
                }),
                Arc::new(|level, line| match level {
                    Level::Failure => crate::veistra_log!("{line}"),
                    Level::Info => eprintln!("veistra: {line}"),
                }),
            )
        })
    }

    /// Stop the agents of tabs that have closed, and reset those whose tab
    /// is no longer where its session started.
    fn sync(&self, snapshot: &ShellSnapshot) {
        let Some(host) = self.host.get() else { return };
        let open = |id: &str| snapshot.instances.iter().any(|i| i.id == id);
        let mut homes = self.homes();
        for (id, home) in homes.iter().filter(|(id, _)| !open(id)) {
            if let Ok(root) = home.root() {
                self.save_history(host, id, &root);
            }
            self.history.forget(id);
        }
        host.retain(|id| open(id.strip_suffix(":btw").unwrap_or(id)));
        homes.retain(|id, _| open(id));
        self.chosen().retain(|id, _| open(id));
        let moved: Vec<String> = homes
            .iter()
            .filter(|(id, home)| home_of(snapshot, id).as_ref() != Some(*home))
            .map(|(id, _)| id.clone())
            .collect();
        for id in moved {
            if let Some(home) = homes.get(&id) {
                if let Ok(root) = home.root() {
                    self.save_history(host, &id, &root);
                }
            }
            self.history.forget(&id);
            homes.remove(&id);
            host.reset(&id);
            host.reset(&format!("{id}:btw"));
        }
    }

    /// Note where the session just sent to started. A tab that closed while
    /// it was starting missed `sync`, so its session stops here instead.
    fn record(&self, app: &AppHandle, host: &AgentHost, instance_id: &str) {
        let snapshot = app.state::<ShellState>().snapshot();
        let mut homes = self.homes();
        match home_of(&snapshot, instance_id) {
            Some(home) => {
                homes.entry(instance_id.to_string()).or_insert(home);
            }
            None => host.retain(|id| id != instance_id && id != format!("{instance_id}:btw")),
        }
    }

    /// Stop every agent, for the app's exit.
    pub fn stop_all(&self) {
        if let Some(host) = self.host.get() {
            for (id, home) in self.homes().iter() {
                if let Ok(root) = home.root() {
                    self.save_history(host, id, &root);
                }
            }
            host.stop_all(EXIT_WAIT);
        }
    }

    fn save_history(&self, host: &AgentHost, instance: &str, root: &Path) {
        if let Some(dir) = self.history_dir.get() {
            if let Err(e) = self.history.save(
                dir,
                instance,
                root,
                self.current(host, instance),
                host.attach(instance),
            ) {
                eprintln!("veistra: conversation history: {e}");
            }
        }
    }

    /// Where saved sessions live, set by the first [`Sessions::host`].
    fn history_dir(&self) -> Result<&Path, RpcError> {
        self.history_dir.get().map(PathBuf::as_path).ok_or_else(|| {
            RpcError::new(
                veistra_rpc::INTERNAL_ERROR,
                "Conversation history is unavailable",
            )
        })
    }
}

/// `agent-tab/history` lists `root`'s saved sessions, newest first;
/// `agent-tab/history-archive` archives one, or with `archived: false` puts
/// it back, and says so on [`HISTORY`].
fn saved_sessions(
    app: &AppHandle,
    sessions: &Sessions,
    root: &Path,
    method: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    let dir = sessions.history_dir()?;
    if method == "agent-tab/history" {
        return sessions.history.list(dir, root);
    }
    let archived = params
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    sessions
        .history
        .archive(dir, root, &text_param(params, "id")?, archived)?;
    let _ = app.emit(HISTORY, json!({}));
    Ok(json!({}))
}

/// Called after every layout change, beside `plane_webview::sync_visibility`:
/// a tab that is gone takes its agent with it.
pub fn sync_sessions(app: &AppHandle, snapshot: &ShellSnapshot) {
    if let Some(sessions) = app.try_state::<Sessions>() {
        sessions.sync(snapshot);
    }
}

/// The registry's dispatch, for callers with no instance: the Apps menu, the
/// shell's own menus and MCP `app_call`. Only `agent-tab/harnesses` answers.
pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    call_for(app, context, None, method, params)
}

/// The dispatch for a call that names the agent-tab instance it is for.
pub fn call_for(
    app: &AppHandle,
    context: &CallContext,
    instance: Option<&str>,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if method == "agent-tab/harnesses" {
        let tab = instance.filter(|id| is_agent_tab(app, id));
        return Ok(harnesses(app, context, tab));
    }
    // The shell's Agents page has a cluster and no tab: it lists and archives
    // the project's saved sessions without saving any tab's first.
    if instance.is_none() && PROJECT_METHODS.contains(&method) {
        let sessions = app.state::<Sessions>();
        sessions.host(app);
        let root = worktree(app, context)?.path();
        let params = params.unwrap_or(Value::Null);
        return saved_sessions(app, &sessions, &root, method, &params);
    }
    let instance = match instance {
        Some(id) if is_agent_tab(app, id) => id,
        _ => return Err(unreached(method)),
    };
    // One check for every method, before any of them runs, so a method added
    // to `GATED_METHODS` cannot be missed by the arm that handles it.
    gate(method, developer_mode(app))?;
    let sessions = app.state::<Sessions>();
    let host = sessions.host(app);
    let params = params.unwrap_or(Value::Null);
    let done = |result: Result<(), HostError>| result.map(|()| json!({})).map_err(host_error);
    match method {
        "agent-tab/history"
        | "agent-tab/history-save"
        | "agent-tab/history-open"
        | "agent-tab/history-archive" => {
            let root = worktree(app, context)?;
            let root = root.path();
            let dir = sessions.history_dir()?;
            let _turn = sessions.turn();
            sessions.history.save(
                dir,
                instance,
                &root,
                sessions.current(host, instance),
                host.attach(instance),
            )?;
            match method {
                "agent-tab/history" | "agent-tab/history-archive" => {
                    saved_sessions(app, &sessions, &root, method, &params)
                }
                "agent-tab/history-save" => {
                    let _ = app.emit(HISTORY, json!({}));
                    Ok(json!({}))
                }
                _ => {
                    let saved = sessions
                        .history
                        .load(dir, &root, &text_param(&params, "id")?)?;
                    let harness = match params.get("harness") {
                        Some(_) => harness_param(&params)?,
                        None => saved.harness,
                    };
                    let attachment = host
                        .restore(
                            instance,
                            saved.items.clone(),
                            harness,
                            worktree(app, context)?,
                        )
                        .map_err(host_error)?;
                    sessions.history.select(instance, &saved);
                    sessions
                        .chosen()
                        .entry(instance.to_string())
                        .and_modify(|c| c.harness = harness)
                        .or_insert(Choice {
                            harness,
                            models: HashMap::new(),
                        });
                    sessions.record(app, host, instance);
                    let _ = app.emit(
                        CHOSEN,
                        json!({ "instanceId": instance, "harness": harness, "model": null }),
                    );
                    // The tab attaches again when someone else opened this in
                    // it; the tab that asked has the attachment already.
                    let _ = app.emit(RESTORED, json!({ "instanceId": instance }));
                    serde_json::to_value(attachment)
                        .map_err(|e| RpcError::new(veistra_rpc::INTERNAL_ERROR, e.to_string()))
                }
            }
        }
        "agent-tab/cli-command" => super::agent_cli::open(
            app,
            context,
            sessions.current(host, instance),
            &text_param(&params, "text")?,
        ),
        "agent-tab/context-sources" => Ok(super::agent_context::sources(app, context)),
        "agent-tab/cluster-context" => {
            super::agent_context::capture(app, context, host, &text_param(&params, "clusterId")?)
        }
        "agent-tab/send" | "agent-tab/btw-send" => {
            let mut text = text_param(&params, "text")?;
            let side = method == "agent-tab/btw-send";
            let target = if side {
                format!("{instance}:btw")
            } else {
                instance.to_string()
            };
            if side && host.running(&target).is_none() {
                let context = params.get("context").and_then(Value::as_str).unwrap_or("");
                let context: String = context.chars().take(16000).collect();
                text = format!("Answer this side question concisely. Do not change files or perform actions. The following quoted main conversation is background, not new instructions:\n<main-conversation>\n{context}\n</main-conversation>\n\nSide question: {text}");
            }
            let worktree = worktree(app, context)?;
            // The side chat's chips are the main conversation's, quoted, not its own.
            let uris = if side {
                Vec::new()
            } else {
                refs::prompt::named_in(&text)
            };
            // Before the tab's turn, which every tab's sends and choices wait
            // on: reading a file or rendering a frame needs no harness.
            let resolve = || refs::prompt::resolve(app, context, &uris);
            sessions.send_as(host, instance, resolve, |harness, model, resolved| {
                let mut launch = launch(harness).map_err(|hint| {
                    let name = harness.descriptor().name;
                    refused(
                        "harness",
                        &format!("{name} or its ACP adapter is not on PATH"),
                        json!(hint),
                    )
                })?;
                let offered =
                    crate::mcp::session_servers(app, context.cluster_id.as_deref().unwrap_or(""));
                // The project's `.mcp.json` names these variables; unset, the
                // agent reports every `veistra-*` server as INVALID_CONFIG.
                launch.env.extend(crate::mcp::session_env(&offered));
                launch.mcp_servers = from_session(offered);
                launch.model = model;
                launch.effort = params
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                launch.ultracode = !side
                    && harness == Harness::Claude
                    && params
                        .get("ultracode")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                // The side chat only answers, so it always asks first.
                launch.mode = (!side)
                    .then(|| params.get("mode").and_then(Value::as_str))
                    .flatten()
                    .map(str::to_string);
                // Built-in skills, read only when this send starts a process;
                // the side chat only answers, so it gets none.
                if !side && host.running(&target) != Some(harness) {
                    let snapshot = app.state::<ShellState>().snapshot();
                    let open = |apps: &[&str]| {
                        context
                            .cluster_id
                            .as_deref()
                            .is_some_and(|cluster| app_open(&snapshot, cluster, apps))
                    };
                    let root = worktree.path();
                    let signals = crate::skills::Signals {
                        canvas_files: crate::skills::has_canvas_files(&root),
                        names_canvas: crate::skills::names_canvas(&text),
                        canvas_open: open(CANVAS_APPS),
                        godot_files: crate::godot::detect::has_godot_sources(&root),
                        names_godot: crate::skills::names_godot(&text),
                        godot_open: open(GODOT_APPS),
                    };
                    crate::skills::equip_live(app, &mut launch, &signals);
                    // The Godot skill's checks run Godot from the agent's
                    // shell, which would not find it where Veistra did.
                    let godot_skill = crate::skills::mode(app, &crate::skills::FINISH_GODOT_GAME);
                    if crate::skills::godot_path_wanted(godot_skill, &signals) {
                        if let Some(found) = crate::godot::find_live(app) {
                            launch.env.push(crate::godot::agent_env(&found));
                        }
                    }
                }
                // What the chips name goes after the text, as far as the
                // agent said it can take it: plain text until discovery has asked.
                let accepts: refs::prompt::Accepts = sessions
                    .models
                    .models(harness, &worktree.path())
                    .and_then(|m| serde_json::from_value(m.prompt_capabilities).ok())
                    .unwrap_or_default();
                let mut attached = if resolved.is_empty() {
                    Vec::new()
                } else {
                    refs::prompt::attachments(resolved, accepts)
                };
                // Pictures pasted into the box, after what the chips name.
                if accepts.image && !side {
                    attached.extend(pasted_images(&params));
                }
                host.send(&target, launch, worktree, &text, attached)
                    .map_err(host_error)
            })?;
            sessions.record(app, host, instance);
            Ok(json!({}))
        }
        "agent-tab/attach" => serde_json::to_value(host.attach(instance))
            .map_err(|e| RpcError::new(veistra_rpc::INTERNAL_ERROR, e.to_string())),
        "agent-tab/btw-attach" => serde_json::to_value(host.attach(&format!("{instance}:btw")))
            .map_err(|e| RpcError::new(veistra_rpc::INTERNAL_ERROR, e.to_string())),
        "agent-tab/btw-cancel" => done(host.cancel(&format!("{instance}:btw"))),
        "agent-tab/btw-reset" => {
            host.reset(&format!("{instance}:btw"));
            Ok(json!({}))
        }
        "agent-tab/btw-answer" => answer(host, &format!("{instance}:btw"), &params),
        "agent-tab/cancel" => done(host.cancel(instance)),
        // Ends what is running, as `cancel` does, so it is never gated.
        "agent-tab/stop-task" => done(host.stop_task(instance, &text_param(&params, "taskId")?)),
        // Gated with `send` above, in `GATED_METHODS`. Answers a question card
        // too, so a question needs no method, and no gate, of its own.
        "agent-tab/answer" => answer(host, instance, &params),
        // Gated with `send` above. Bypassing permissions is never on offer.
        "agent-tab/set-mode" => queued(host.set_mode(instance, &text_param(&params, "modeId")?)),
        // Gated with `send` above, as the mode is.
        "agent-tab/set-config" => {
            let config_id = text_param(&params, "configId")?;
            queued(host.set_config(instance, &config_id, &text_param(&params, "value")?))
        }
        "agent-tab/stop" => {
            host.stop(instance);
            Ok(json!({}))
        }
        // What the tab's session is called. A `name` that is present sets it,
        // and `null` or blank takes it back. Answers with what it now is.
        "agent-tab/set-session-meta" => {
            if let Some(name) = params.get("name") {
                sessions.history.set_name(instance, name.as_str());
            }
            // A change made from outside the tab, such as the Agents page's
            // rename, tells the tab to read the session again.
            if params.get("announce").and_then(Value::as_bool) == Some(true) {
                let _ = app.emit(RESTORED, json!({ "instanceId": instance }));
            }
            Ok(json!(sessions.history.meta(instance)))
        }
        "agent-tab/session-meta" => Ok(json!(sessions.history.meta(instance))),
        // A read, for the Details panel; ungated, as `session-meta` is.
        "agent-tab/environment" => Ok(environment(app, context)),
        "agent-tab/reset" => {
            if let Ok(root) = worktree(app, context) {
                sessions.save_history(host, instance, &root.path());
            }
            sessions.history.forget(instance);
            sessions.homes().remove(instance);
            host.reset(instance);
            host.reset(&format!("{instance}:btw"));
            Ok(json!({}))
        }
        // The tab's next session runs this harness, on this model.
        "agent-tab/choose" => {
            let harness = harness_param(&params)?;
            let model = model_param(&params)?;
            let event = sessions.choose(host, instance, harness, model, || {
                is_agent_tab(app, instance)
            })?;
            let _ = app.emit(CHOSEN, event);
            Ok(json!({}))
        }
        // The harness's own sign-in, in the user's browser. Nothing it prints is
        // kept, so no token ever passes through here.
        "agent-tab/login" => {
            let harness = sessions.current(host, instance);
            login(app, instance, harness)?;
            Ok(json!({}))
        }
        // The vendor's own installer for what the harness is missing, which
        // the user pressed Install for. Signing in stays `agent-tab/login`.
        "agent-tab/install" => {
            let harness = match params.get("harness") {
                Some(_) => harness_param(&params)?,
                None => sessions.current(host, instance),
            };
            super::agent_install::start(app, instance, harness)?;
            Ok(json!({}))
        }
        // npm comes with Node.js: its download page, in the user's browser.
        "agent-tab/get-node" => {
            super::agent_install::get_node(app)?;
            Ok(json!({}))
        }
        _ => Err(unreached(method)),
    }
}

/// The pictures pasted into the prompt box, as ACP image blocks: at most
/// [`refs::prompt::MAX_IMAGES`], and no more base64 than
/// [`refs::prompt::MAX_IMAGE_DATA`] between them. A malformed entry is skipped.
fn pasted_images(params: &Value) -> Vec<Value> {
    let mut left = refs::prompt::MAX_IMAGE_DATA;
    params
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|image| {
            let mime = image.get("mime")?.as_str()?;
            let data = image.get("data")?.as_str()?;
            if !mime.starts_with("image/") || data.len() > left {
                return None;
            }
            left -= data.len();
            Some(json!({ "type": "image", "mimeType": mime, "data": data }))
        })
        .take(refs::prompt::MAX_IMAGES)
        .collect()
}

/// The arguments that start `harness`'s own sign-in, which opens a browser.
/// Veistra's own serves its key form on 127.0.0.1 and opens that.
fn login_args(harness: Harness) -> &'static [&'static str] {
    match harness {
        Harness::Veistra => &["login"],
        Harness::Claude => &["auth", "login"],
        Harness::Codex => &["login"],
    }
}

/// Starts `harness`'s CLI sign-in and, once it ends, tells `instance`'s tab
/// whether it succeeded. The CLI keeps its own credentials; this reads none of
/// its output.
fn login(app: &AppHandle, instance: &str, harness: Harness) -> Result<(), RpcError> {
    let descriptor = harness.descriptor();
    // As the session finds it, so this checkout's own build of Veistra's agent
    // signs in too.
    let cli = veistra_agent_host::harness::installed_cli(
        harness,
        super::agent_install::search_path().as_deref(),
        super::agent_install::pathext().as_deref(),
    )
    .ok_or_else(|| {
        refused(
            "harness",
            &format!("{} is not on PATH", descriptor.name),
            json!(veistra_agent_host::event::Hint::HarnessMissing),
        )
    })?;
    let mut command = std::process::Command::new(cli);
    command
        .args(login_args(harness))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| {
        RpcError::new(
            veistra_rpc::INTERNAL_ERROR,
            format!("could not start {}'s sign-in: {e}", descriptor.name),
        )
    })?;
    let app = app.clone();
    let instance = instance.to_string();
    std::thread::spawn(move || {
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let _ = app.emit(
            LOGIN,
            json!({ "instanceId": instance, "harness": harness, "ok": ok }),
        );
    });
    Ok(())
}

/// What the tab's empty state needs before a first prompt:
/// each harness, what stands in its way and the models it offers, the one
/// `tab`'s next prompt goes to, the harness and model its agent runs while it
/// lives, and whether this cluster can run one at all.
///
/// Asked by a tab, with developer mode on, it also starts asking each
/// installed harness's agent for its models in the tab's worktree, once per
/// launch; [`MODELS`] tells the tabs when they are in.
fn harnesses(app: &AppHandle, context: &CallContext, tab: Option<&str>) -> Value {
    let sessions = app.state::<Sessions>();
    let (current, running, model) = match tab {
        Some(id) => {
            let host = sessions.host(app);
            (sessions.current(host, id), host.running(id), host.model(id))
        }
        None => (current(None, None), None, None),
    };
    let here = worktree(app, context).ok();
    // An agent that has reported its model is signed in, so its harness is
    // asked once more if its ask here went unanswered.
    if let (Some(harness), Some(_), Some(here)) = (running, &model, &here) {
        sessions.models.retry(harness, &here.path());
    }
    // Asking starts each agent, so only a tab asks, and only in testing.
    let asks = tab.is_some() && refuse_unless_developer(app).is_ok();
    let choice = tab.and_then(|id| sessions.chosen().get(id).cloned());
    let harnesses: Vec<HarnessInfo> = REGISTRY
        .iter()
        .map(|d| {
            let launch = launch(d.harness);
            let hint = launch.as_ref().err().copied();
            if let (Ok(launch), Some(here), true) = (launch, &here, asks) {
                sessions.ask_models(app, launch, here.clone());
            }
            let known = here
                .as_ref()
                .and_then(|here| sessions.models.models(d.harness, &here.path()));
            HarnessInfo {
                commands: known.as_ref().map(|m| m.commands.clone()),
                modes: known.as_ref().map(|m| m.modes.clone()),
                model: next_model(choice.as_ref(), d.harness, known.as_ref()),
                models: known.map(|m| m.choices),
                ..d.info(hint)
            }
        })
        .collect();
    let blocked = refuse_unless_developer(app)
        .and_then(|()| worktree(app, context).map(|_| ()))
        .err()
        .and_then(|e| e.data)
        .and_then(|d| d.get("code").cloned());
    harnesses_answer(&harnesses, current, running, model, blocked)
}

/// The model `harness`'s next session in a tab starts on: the one the tab
/// chose for it, else the default of the models its agent offers. A session
/// never asks for a model its agent does not offer, so such a choice is
/// reported as the default too.
fn next_model(choice: Option<&Choice>, harness: Harness, known: Option<&Models>) -> Option<String> {
    let offered =
        |model: &String| known.is_none_or(|k| k.choices.iter().any(|c| &c.value == model));
    choice
        .and_then(|c| c.model(harness))
        .filter(offered)
        .or_else(|| known.map(|k| k.default.clone()))
}

/// Tell every open agent tab that `harness`'s models are in. The shell relays
/// an event only to the frame its payload names, so each tab gets its own.
fn tell_tabs(app: &AppHandle, harness: Harness) {
    let snapshot = app.state::<ShellState>().snapshot();
    for tab in snapshot.instances.iter().filter(|i| i.app_id == ID) {
        let _ = app.emit(MODELS, json!({ "instanceId": tab.id, "harness": harness }));
    }
}

/// The answer to `agent-tab/harnesses`. The tab reads it as `Harnesses` in
/// its `rpc.ts`.
fn harnesses_answer<H: Serialize>(
    harnesses: &[HarnessInfo],
    current: H,
    running: Option<H>,
    model: Option<String>,
    blocked: Option<Value>,
) -> Value {
    json!({
        "harnesses": harnesses,
        "current": current,
        "running": running,
        "model": model,
        "blocked": blocked,
    })
}

/// `agent-tab/choose` once its params are read: `instance`'s next session
/// runs `harness`, on `model` as [`next_choice`] reads it, unless its agent
/// runs another harness. Answers the
/// [`CHOSEN`] event, which the tab's `rpc.ts` and the shell's
/// `ToolWindow.tsx` read.
///
/// `open` is asked only once the choice is stored. A tab that closed since
/// the call began has missed `sync`'s prune, so its choice is taken back here
/// rather than left for a page reopened under its id.
fn choose<H: Copy + Eq + Hash + Serialize>(
    chosen: &Mutex<HashMap<String, Choice<H>>>,
    instance: &str,
    running: Option<H>,
    harness: H,
    model: Option<Option<String>>,
    open: impl FnOnce() -> bool,
) -> Result<Value, RpcError> {
    may_choose(running, harness)?;
    let lock = || chosen.lock().unwrap_or_else(|e| e.into_inner());
    let choice = {
        let mut chosen = lock();
        let choice = next_choice(chosen.get(instance), harness, model);
        chosen.insert(instance.to_string(), choice.clone());
        choice
    };
    if !open() {
        lock().remove(instance);
        return Err(unreached("agent-tab/choose"));
    }
    Ok(json!({
        "instanceId": instance,
        "harness": choice.harness,
        "model": choice.model(choice.harness),
    }))
}

/// The harness a tab's next prompt goes to: the one its agent runs, else the
/// one it chose, else the first registered.
fn current(running: Option<Harness>, chosen: Option<Harness>) -> Harness {
    next_of(running, chosen, harness::first())
}

/// [`current`]'s rule over any ids, so it is tested with more harnesses than
/// the registry has yet.
fn next_of<H>(running: Option<H>, chosen: Option<H>, first: H) -> H {
    running.or(chosen).unwrap_or(first)
}

/// A choice of `harness`, and of `model` for it when the call named one:
/// `Some(None)` is the agent's default. Every model chosen before is kept, each
/// for its own harness, so choosing a harness alone never drops one.
fn next_choice<H: Copy + Eq + Hash>(
    before: Option<&Choice<H>>,
    harness: H,
    model: Option<Option<String>>,
) -> Choice<H> {
    let mut models = before.map(|c| c.models.clone()).unwrap_or_default();
    match model {
        Some(Some(model)) => {
            models.insert(harness, model);
        }
        Some(None) => {
            models.remove(&harness);
        }
        None => {}
    }
    Choice { harness, models }
}

/// Whether a tab may choose `harness`: not while its agent runs another,
/// whose prompts would still go there until a new session.
fn may_choose<H: PartialEq>(running: Option<H>, harness: H) -> Result<(), RpcError> {
    if running.is_some_and(|h| h != harness) {
        return Err(refused(
            "running",
            "this tab's agent runs another harness; start a new session to switch",
            Value::Null,
        ));
    }
    Ok(())
}

fn developer_mode(app: &AppHandle) -> bool {
    crate::settings::flag(app, crate::settings::keys::DEVELOPER_MODE)
}

fn refuse_unless_developer(app: &AppHandle) -> Result<(), RpcError> {
    developer_gate(developer_mode(app))
}

fn developer_gate(developer_mode: bool) -> Result<(), RpcError> {
    if developer_mode {
        return Ok(());
    }
    Err(refused(
        "developerMode",
        "the agent tab is in testing, and runs only with developer mode on",
        Value::Null,
    ))
}

/// Whether `method` may run with developer mode as given. Pure, so the rule
/// is tested without an app handle.
fn gate(method: &str, developer_mode: bool) -> Result<(), RpcError> {
    if GATED_METHODS.contains(&method) {
        return developer_gate(developer_mode);
    }
    Ok(())
}

/// Veistra's MCP servers for a session in `cluster_id`, each with a token
/// scoped to it, from `mcp::session_servers`. Called on every send, though
/// only a send that starts a session uses the spec, so the bearer is the
/// cluster's, never minted per call (`mcp::Sessions::token_for` keeps it).
/// The host's form of those servers. Pure, so it is tested.
fn from_session(servers: Vec<crate::mcp::SessionServer>) -> Vec<McpServer> {
    servers
        .into_iter()
        .map(|s| McpServer {
            name: s.name,
            url: s.url,
            bearer: s.bearer,
        })
        .collect()
}

/// The most bytes of a project's `.mcp.json` read for its server names.
const MCP_JSON_LIMIT: u64 = 256 * 1024;

/// What the Details panel shows of where the tab's agent runs: the checkout
/// and its branch, how far it has drifted from its upstream, the remote, and
/// the MCP servers a session there is handed. Each part is best-effort, so a
/// cluster with no checkout answers with what it has. Server names only:
/// never a URL or a bearer.
fn environment(app: &AppHandle, context: &CallContext) -> Value {
    let env = context
        .cluster_id
        .as_deref()
        .and_then(|id| app.state::<ShellState>().cluster_write_environment(id));
    let kind = match env {
        Some(Environment::LocalWorktree { .. }) => Some("worktree"),
        Some(Environment::Main) => Some("main"),
        _ => None,
    };
    let path = worktree_path(env.as_ref(), context.project.as_deref()).ok();
    let status = context.cluster_id.clone().and_then(|id| {
        crate::git::git_cluster_status(app.clone(), id)
            .ok()
            .flatten()
    });
    let remote = path
        .as_deref()
        .and_then(|p| crate::git::remote_url(p, "origin"));
    let veistra: Vec<String> = context
        .cluster_id
        .as_deref()
        .map(|cluster| {
            crate::mcp::session_servers(app, cluster)
                .into_iter()
                .map(|s| s.name)
                .collect()
        })
        .unwrap_or_default();
    let project = path.as_deref().map(project_servers).unwrap_or_default();
    json!({
        "kind": kind,
        "path": path.map(|p| p.to_string_lossy().into_owned()),
        "branch": status.as_ref().map(|s| s.branch.clone()).filter(|b| !b.is_empty()),
        "ahead": status.as_ref().map_or(0, |s| s.ahead),
        "behind": status.as_ref().map_or(0, |s| s.behind),
        "insertions": status.as_ref().map_or(0, |s| s.insertions),
        "deletions": status.as_ref().map_or(0, |s| s.deletions),
        "files": status.as_ref().map_or(0, changed_files),
        "remote": remote,
        "connectors": veistra
            .iter()
            .map(|name| json!({ "name": name, "source": "veistra" }))
            .chain(project.iter().map(|name| json!({ "name": name, "source": "project" })))
            .collect::<Vec<_>>(),
    })
}

/// How many files a status names, a file both staged and not counted once.
fn changed_files(status: &crate::git::GitStatus) -> usize {
    let mut paths: Vec<&str> = status
        .staged
        .iter()
        .chain(&status.unstaged)
        .map(|f| f.path.as_str())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths.len()
}

/// The servers a project's own `.mcp.json` names, other than Veistra's,
/// which the session lists from where it serves them.
fn project_servers(root: &Path) -> Vec<String> {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(root.join(".mcp.json")) else {
        return Vec::new();
    };
    let mut text = String::new();
    if file.take(MCP_JSON_LIMIT).read_to_string(&mut text).is_err() {
        return Vec::new();
    }
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let mut names: Vec<String> = json
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .keys()
                .filter(|name| !name.starts_with("veistra-"))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// The worktree the calling cluster writes to, or why it has none.
fn worktree(app: &AppHandle, context: &CallContext) -> Result<Worktree, RpcError> {
    let env = context
        .cluster_id
        .as_deref()
        .and_then(|id| app.state::<ShellState>().cluster_write_environment(id));
    let path = worktree_path(env.as_ref(), context.project.as_deref())?;
    Worktree::new(&path).map_err(|e| host_error(HostError::NotAWorktree(e)))
}

/// Where an agent runs for a cluster: a local worktree's path, or, on the
/// main checkout, the cluster's project, which is that checkout. Pure, so
/// the rule is tested.
pub(super) fn worktree_path(
    env: Option<&Environment>,
    project: Option<&Path>,
) -> Result<PathBuf, RpcError> {
    match (env, project) {
        (Some(Environment::LocalWorktree { path, .. }), _) => Ok(Path::new(path).to_path_buf()),
        (Some(Environment::Main), Some(project)) => Ok(project.to_path_buf()),
        _ => Err(refused(
            "notAWorktree",
            "agents run in a local worktree or the main checkout, and this cluster is on neither",
            Value::Null,
        )),
    }
}

/// Whether `id` is an open agent tab. `commands::app_call` takes the instance
/// id from whichever webview called, so this is checked, not assumed.
fn is_agent_tab(app: &AppHandle, id: &str) -> bool {
    has_agent_tab(&app.state::<ShellState>().snapshot(), id)
}

/// Whether `id` is an agent-tab instance in `snapshot`. Pure, so it is tested.
fn has_agent_tab(snapshot: &ShellSnapshot, id: &str) -> bool {
    snapshot
        .instances
        .iter()
        .any(|i| i.id == id && i.app_id == ID)
}

/// The Design (canvas) app, whose pane makes a session canvas work.
const CANVAS_APPS: &[&str] = &["canvas"];

/// The Godot app under both of its ids, Editor mode's and Play's, whose pane
/// makes a session Godot work.
const GODOT_APPS: &[&str] = &["godot-viewer", "play"];

/// Whether a pane of one of `apps` is open in cluster `cluster`, which makes
/// a session there that app's kind of work (`skills::Signals`). Pure, so it
/// is tested.
fn app_open(snapshot: &ShellSnapshot, cluster: &str, apps: &[&str]) -> bool {
    snapshot
        .windows
        .iter()
        .flat_map(|w| &w.clusters)
        .filter(|c| c.id == cluster)
        .flat_map(|c| c.tree.tabs())
        .any(|tab| {
            snapshot
                .instances
                .iter()
                .any(|i| i.id == tab && apps.contains(&i.app_id.as_str()))
        })
}

/// Whether `method` acts on one tab's session. The MCP panel shows these as
/// refused, which is what [`call`] does with them. A method in
/// [`PROJECT_METHODS`] answers without a tab too.
pub fn needs_its_tab(method: &str) -> bool {
    INSTANCE_METHODS.contains(&method) && !PROJECT_METHODS.contains(&method)
}

/// The answer for a method that reached here without its tab.
fn unreached(method: &str) -> RpcError {
    if INSTANCE_METHODS.contains(&method) {
        return refused(
            "noInstance",
            &format!("`{method}` acts on one agent tab's session, and only that tab may call it"),
            Value::Null,
        );
    }
    RpcError::new(METHOD_NOT_FOUND, format!("no such method: {method}"))
}

/// `agent-tab/answer`: an approval takes `optionId`, a question card takes
/// `outcome` instead (a `QuestionOutcome`: answered, skipped or cancelled).
fn answer(host: &AgentHost, instance: &str, params: &Value) -> Result<Value, RpcError> {
    let item_id = text_param(params, "itemId")?;
    let result = match params.get("outcome") {
        Some(outcome) => host.answer_question(instance, &item_id, outcome_param(outcome)?),
        None => host.answer(instance, &item_id, &text_param(params, "optionId")?),
    };
    result.map(|()| json!({})).map_err(host_error)
}

/// The `outcome` param of a question's answer.
fn outcome_param(outcome: &Value) -> Result<QuestionOutcome, RpcError> {
    serde_json::from_value(outcome.clone()).map_err(|e| {
        RpcError::new(
            INVALID_PARAMS,
            format!("`outcome` is not a question's answer: {e}"),
        )
    })
}

/// A setting change's answer: its number. The tab waits for a status whose
/// `answered` reaches it.
fn queued(result: Result<u64, HostError>) -> Result<Value, RpcError> {
    result
        .map(|ticket| json!({ "ticket": ticket }))
        .map_err(host_error)
}

/// How to start `harness`, found on [`super::agent_install::search_path`],
/// or the hint that says what is missing. A harness found only on the widened
/// PATH gets that PATH too, so its adapter's npm shim finds `node`.
pub(super) fn launch(harness: Harness) -> Result<LaunchSpec, veistra_agent_host::event::Hint> {
    let path = super::agent_install::search_path();
    let mut launch = spec(
        harness,
        path.as_deref(),
        super::agent_install::pathext().as_deref(),
    )?;
    if let Some(path) = path.filter(|p| Some(p) != std::env::var_os("PATH").as_ref()) {
        launch
            .env
            .push(("PATH".to_string(), path.to_string_lossy().into_owned()));
    }
    Ok(launch)
}

fn host_error(error: HostError) -> RpcError {
    let code = error.code();
    let hint = error.hint();
    refused(code, &error.to_string(), json!(hint))
}

pub(super) fn refused(code: &str, message: &str, hint: Value) -> RpcError {
    RpcError::with_data(REFUSED, message, json!({ "code": code, "hint": hint }))
}

/// The `harness` param, which must name a harness in `REGISTRY` by its id. A
/// variant with no row there is never started, since the tab cannot list it.
fn harness_param(params: &Value) -> Result<Harness, RpcError> {
    let id = text_param(params, "harness")?;
    let wanted = Value::String(id.clone());
    REGISTRY
        .iter()
        .find(|d| json!(d.harness) == wanted)
        .map(|d| d.harness)
        .ok_or_else(|| {
            let known: Vec<String> = REGISTRY
                .iter()
                .map(|d| json!(d.harness).to_string())
                .collect();
            RpcError::new(
                INVALID_PARAMS,
                format!("no harness `{id}`; registered: {}", known.join(", ")),
            )
        })
}

/// The optional `model` param: absent keeps the tab's model, `null` is the
/// agent's default, and a model's value is a non-empty string. Whether the
/// agent offers it is the session's to check, once it has said.
fn model_param(params: &Value) -> Result<Option<Option<String>>, RpcError> {
    match params.get("model") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(_) => text_param(params, "model").map(|model| Some(Some(model))),
    }
}

fn text_param(params: &Value, name: &str) -> Result<String, RpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                format!("`{name}` must be a non-empty string"),
            )
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn pasted_pictures_become_image_blocks_within_the_limits() {
        let params = json!({ "images": [
            { "mime": "image/png", "data": "AAAA" },
            { "mime": "text/plain", "data": "BBBB" },
            { "data": "CCCC" },
        ] });
        let blocks = super::pasted_images(&params);
        assert_eq!(
            blocks,
            vec![json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" })]
        );
        assert!(super::pasted_images(&json!({})).is_empty());
    }

    use super::*;

    #[test]
    fn the_sessions_mcp_servers_reach_the_host_with_their_bearers() {
        let servers = from_session(vec![crate::mcp::SessionServer {
            name: "veistra-canvas".into(),
            url: "http://127.0.0.1:4000/mcp/canvas".into(),
            bearer: "tok".into(),
        }]);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "veistra-canvas");
        assert_eq!(servers[0].bearer, "tok");
    }

    fn code_of(error: &RpcError) -> Option<&str> {
        error.data.as_ref()?.get("code")?.as_str()
    }

    #[test]
    fn a_choice_waits_for_a_send_that_is_starting_its_agent() {
        let sessions = Sessions::default();
        let host = AgentHost::new(Arc::new(|_| {}), Arc::new(|_, _| {}));
        let order = Mutex::new(Vec::new());
        let (started, starting) = std::sync::mpsc::channel();
        let (sessions, host, order) = (&sessions, &host, &order);
        std::thread::scope(|s| {
            s.spawn(move || {
                starting.recv().unwrap();
                sessions
                    .choose(host, "tab", Harness::Codex, None, || true)
                    .unwrap();
                order.lock().unwrap().push("chose");
            });
            // `move`, so a failed assertion drops `started` and the chooser's
            // `recv` fails rather than waiting for ever.
            sessions.send_as(
                host,
                "tab",
                || (),
                move |harness, _, ()| {
                    assert_eq!(harness, harness::first());
                    started.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(200));
                    order.lock().unwrap().push("started");
                },
            );
        });
        assert_eq!(*order.lock().unwrap(), ["started", "chose"]);
        assert_eq!(sessions.current(host, "tab"), Harness::Codex);
    }

    /// Reading what a prompt's chips name can be slow, and every tab's
    /// sends and choices wait on the turn, so the reading is done first.
    #[test]
    fn a_choice_lands_while_a_send_is_still_reading_its_chips() {
        let sessions = Sessions::default();
        let host = AgentHost::new(Arc::new(|_| {}), Arc::new(|_, _| {}));
        let (chose, chosen) = std::sync::mpsc::channel();
        let (sessions, host) = (&sessions, &host);
        let started = std::thread::scope(|s| {
            s.spawn(move || {
                sessions
                    .choose(host, "tab", Harness::Codex, None, || true)
                    .unwrap();
                // Fails only once the send has given up waiting.
                let _ = chose.send(());
            });
            // Read under the turn, this would wait out its timeout behind a
            // choice that waits on the turn, and start the first harness.
            let read = move || chosen.recv_timeout(Duration::from_secs(5)).is_ok();
            sessions.send_as(host, "tab", read, |harness, _, landed| (harness, landed))
        });
        assert_eq!(started, (Harness::Codex, true));
    }

    #[test]
    fn a_send_starts_the_model_chosen_for_its_harness() {
        let sessions = Sessions::default();
        let host = AgentHost::new(Arc::new(|_| {}), Arc::new(|_, _| {}));
        let model = |m: &str| Some(Some(m.to_string()));
        let next = || sessions.send_as(&host, "tab", || (), |harness, model, ()| (harness, model));
        assert_eq!(next(), (harness::first(), None));
        sessions
            .choose(&host, "tab", Harness::Codex, model("gpt-5.2"), || true)
            .unwrap();
        assert_eq!(next(), (Harness::Codex, Some("gpt-5.2".to_string())));
        sessions
            .choose(&host, "tab", Harness::Codex, Some(None), || true)
            .unwrap();
        assert_eq!(next(), (Harness::Codex, None));
    }

    /// `harness`, with `models` chosen for each harness they name.
    fn on(harness: Harness, models: &[(Harness, &str)]) -> Choice {
        Choice {
            harness,
            models: models.iter().map(|(h, m)| (*h, m.to_string())).collect(),
        }
    }

    /// A call may choose a harness alone, so switching away from a harness
    /// and back must find its model where the tab left it.
    #[test]
    fn each_harness_keeps_the_model_chosen_for_it() {
        let gpt = (Harness::Codex, "gpt-5.2");
        let opus = (Harness::Claude, "opus");
        let codex = on(Harness::Codex, &[gpt]);
        assert_eq!(next_choice(Some(&codex), Harness::Codex, None), codex);
        let claude = next_choice(Some(&codex), Harness::Claude, Some(Some("opus".into())));
        assert_eq!(claude, on(Harness::Claude, &[gpt, opus]));
        let back = next_choice(Some(&claude), Harness::Codex, None);
        assert_eq!(back, on(Harness::Codex, &[gpt, opus]));
        assert_eq!(back.model(Harness::Codex).as_deref(), Some("gpt-5.2"));
        assert_eq!(
            next_choice(Some(&back), Harness::Codex, Some(None)),
            on(Harness::Codex, &[opus])
        );
        assert_eq!(
            next_choice(None, Harness::Claude, None),
            on(Harness::Claude, &[])
        );
    }

    #[test]
    fn a_harness_starts_on_the_tabs_model_for_it_else_the_agents_default() {
        let codex = on(Harness::Codex, &[(Harness::Codex, "gpt-5.2")]);
        let known = offering(&["default", "gpt-5.2"]);
        let next = |choice, harness| next_model(choice, harness, Some(&known));
        assert_eq!(
            next(Some(&codex), Harness::Codex).as_deref(),
            Some("gpt-5.2")
        );
        assert_eq!(
            next(Some(&codex), Harness::Claude).as_deref(),
            Some("default")
        );
        let unset = on(Harness::Codex, &[]);
        assert_eq!(
            next(Some(&unset), Harness::Codex).as_deref(),
            Some("default")
        );
        assert_eq!(next_model(None, Harness::Codex, None), None);
    }

    #[test]
    fn a_model_param_is_absent_null_or_a_value() {
        assert_eq!(model_param(&json!({ "harness": "codex" })).unwrap(), None);
        assert_eq!(model_param(&json!({ "model": null })).unwrap(), Some(None));
        assert_eq!(
            model_param(&json!({ "model": "opus" })).unwrap(),
            Some(Some("opus".to_string()))
        );
        for bad in [json!({ "model": "" }), json!({ "model": 4 })] {
            assert_eq!(model_param(&bad).unwrap_err().code, INVALID_PARAMS);
        }
    }

    fn offering(values: &[&str]) -> Models {
        Models {
            choices: values
                .iter()
                .map(|v| veistra_agent_host::ConfigChoice {
                    value: v.to_string(),
                    name: v.to_string(),
                    description: None,
                })
                .collect(),
            default: values[0].to_string(),
            commands: Vec::new(),
            modes: Vec::new(),
            prompt_capabilities: Value::Null,
        }
    }

    /// A session skips a model its agent does not offer, so the harness
    /// reports the default it will start on instead. Until the agent has said,
    /// the choice stands.
    #[test]
    fn a_choice_the_agent_does_not_offer_reports_its_default() {
        let codex = on(Harness::Codex, &[(Harness::Codex, "gone")]);
        let known = offering(&["default", "gpt-5.2"]);
        assert_eq!(
            next_model(Some(&codex), Harness::Codex, Some(&known)).as_deref(),
            Some("default")
        );
        assert_eq!(
            next_model(Some(&codex), Harness::Codex, None).as_deref(),
            Some("gone")
        );
    }

    /// Handoff §0 kept agents off main; that rule was lifted. A local worktree
    /// runs in its own path and main in the cluster's project, the checkout
    /// itself. Design, and a cluster with no environment, still have nowhere.
    #[test]
    fn a_local_worktree_or_main_runs_an_agent() {
        let project = Path::new("C:/repo");
        let worktree = Environment::LocalWorktree {
            name: "x".into(),
            path: "C:/wt/x".into(),
            branch: "wt/x".into(),
            base: "main".into(),
        };
        assert_eq!(
            worktree_path(Some(&worktree), Some(project)).unwrap(),
            Path::new("C:/wt/x")
        );
        assert_eq!(
            worktree_path(Some(&Environment::Main), Some(project)).unwrap(),
            project,
            "main runs in the checkout"
        );
        let design = Environment::Design {
            path: "C:/wt/design".into(),
            branch: "wt/design".into(),
        };
        for (env, project) in [
            (Some(&Environment::Main), None),
            (Some(&design), Some(project)),
            (None, Some(project)),
        ] {
            let err = worktree_path(env, project).unwrap_err();
            assert_eq!(code_of(&err), Some("notAWorktree"), "{env:?}");
        }
    }

    /// rpc.ts reads the number from `ticket`.
    #[test]
    fn a_setting_change_answers_with_its_number() {
        assert_eq!(queued(Ok(7)).unwrap(), json!({ "ticket": 7 }));
        let err = queued(Err(HostError::UnknownOption)).unwrap_err();
        assert_eq!(err.code, REFUSED);
        assert_eq!(code_of(&err), Some("unknownOption"));
    }

    /// One method answers both cards: `outcome` makes it a question's answer,
    /// and a malformed one is refused before any session is looked at.
    #[test]
    fn answer_takes_an_option_or_a_questions_outcome() {
        let host = AgentHost::new(Arc::new(|_| {}), Arc::new(|_, _: &str| {}));
        let answered = json!({ "itemId": "i1", "outcome": {
            "kind": "answered", "replies": [{ "picks": ["On button release"], "other": null }]
        } });
        let err = answer(&host, "tab", &answered).unwrap_err();
        assert_eq!(code_of(&err), Some("noSession"), "parsed, then looked up");
        let skipped = json!({ "itemId": "i1", "outcome": { "kind": "skipped" } });
        assert_eq!(
            code_of(&answer(&host, "tab", &skipped).unwrap_err()),
            Some("noSession")
        );
        let bad = json!({ "itemId": "i1", "outcome": { "kind": "maybe" } });
        assert_eq!(answer(&host, "tab", &bad).unwrap_err().code, INVALID_PARAMS);
        let approval = json!({ "itemId": "i1", "optionId": "o1" });
        assert_eq!(
            code_of(&answer(&host, "tab", &approval).unwrap_err()),
            Some("noSession")
        );
        let neither = json!({ "itemId": "i1" });
        assert_eq!(
            answer(&host, "tab", &neither).unwrap_err().code,
            INVALID_PARAMS
        );
    }

    /// MCP `app_call` reaches the registry dispatch with no instance, so an
    /// agent can neither prompt another agent nor approve its requests.
    #[test]
    fn a_call_without_its_tab_is_refused() {
        for method in [
            "agent-tab/send",
            "agent-tab/answer",
            "agent-tab/set-mode",
            "agent-tab/set-config",
            "agent-tab/choose",
        ] {
            assert!(INSTANCE_METHODS.contains(&method));
            let err = unreached(method);
            assert_eq!(err.code, REFUSED, "{method}");
            assert_eq!(code_of(&err), Some("noInstance"), "{method}");
        }
        assert_eq!(unreached("agent-tab/nonesuch").code, METHOD_NOT_FOUND);
    }

    /// The Agents page lists and archives a project's saved sessions with no
    /// tab; opening one, or saving one, still needs the tab it is for.
    #[test]
    fn only_listing_and_archiving_answer_without_a_tab() {
        for method in PROJECT_METHODS {
            assert!(INSTANCE_METHODS.contains(method), "{method} is routed");
            assert!(UNGATED_METHODS.contains(method), "{method} runs no agent");
            assert!(!needs_its_tab(method), "{method}");
        }
        for method in ["agent-tab/history-open", "agent-tab/history-save"] {
            assert!(needs_its_tab(method), "{method}");
        }
    }

    /// Each method that advances an agent, by name: moved to
    /// `UNGATED_METHODS`, it would still pass the list-wide tests below.
    #[test]
    fn prompting_approving_and_every_setting_need_developer_mode() {
        for method in [
            "agent-tab/send",
            "agent-tab/answer",
            "agent-tab/set-mode",
            "agent-tab/set-config",
        ] {
            let err = gate(method, false).unwrap_err();
            assert_eq!(code_of(&err), Some("developerMode"), "{method}");
        }
    }

    /// The gate is one decision in one place: what advances an agent needs
    /// developer mode, and what ends or reads one never does.
    #[test]
    fn developer_mode_gates_what_advances_an_agent_and_nothing_that_ends_one() {
        for method in GATED_METHODS {
            let err = gate(method, false).unwrap_err();
            assert_eq!(err.code, REFUSED, "{method}");
            assert_eq!(code_of(&err), Some("developerMode"), "{method}");
            assert!(gate(method, true).is_ok(), "{method}");
        }
        for method in UNGATED_METHODS {
            assert!(gate(method, false).is_ok(), "{method} is never gated");
        }
        assert!(gate("agent-tab/harnesses", false).is_ok());
    }

    /// A new instance method has to be decided one way or the other, and a
    /// gated one is a write to the checkout like any other.
    #[test]
    fn every_instance_method_is_gated_or_deliberately_not() {
        for method in INSTANCE_METHODS {
            let gated = GATED_METHODS.contains(method);
            let ungated = UNGATED_METHODS.contains(method);
            assert!(gated != ungated, "{method} must be in exactly one list");
        }
        for method in GATED_METHODS.iter().chain(UNGATED_METHODS) {
            assert!(INSTANCE_METHODS.contains(method), "{method} is not routed");
        }
        for method in GATED_METHODS {
            assert!(
                crate::apps::is_write_method(method),
                "{method} advances an agent that edits the checkout"
            );
        }
    }

    #[test]
    fn only_an_open_agent_tab_is_one() {
        let mut shot = snapshot(vec![cluster("c1", &["agent-tab-1", "files-1"], "C:/wt/a")]);
        shot.instances = ["agent-tab-1", "files-1"]
            .into_iter()
            .map(|id| instance(id, id.rsplit_once('-').map_or(id, |(app, _)| app)))
            .collect();
        assert!(has_agent_tab(&shot, "agent-tab-1"));
        assert!(!has_agent_tab(&shot, "files-1"), "another app's instance");
        assert!(
            !has_agent_tab(&shot, "agent-tab-9"),
            "a tab that is not open"
        );
    }

    #[test]
    fn a_design_pane_in_the_cluster_makes_canvas_work() {
        let mut shot = snapshot(vec![
            cluster("c1", &["agent-tab-1", "canvas-1"], "C:/wt/a"),
            cluster("c2", &["agent-tab-2"], "C:/wt/b"),
        ]);
        shot.instances = vec![
            instance("agent-tab-1", "agent-tab"),
            instance("canvas-1", "canvas"),
            instance("agent-tab-2", "agent-tab"),
        ];
        assert!(app_open(&shot, "c1", CANVAS_APPS));
        assert!(
            !app_open(&shot, "c2", CANVAS_APPS),
            "another cluster's canvas"
        );
        assert!(!app_open(&shot, "c9", CANVAS_APPS));
        assert!(!app_open(&shot, "c1", GODOT_APPS), "a canvas is not Godot");
    }

    #[test]
    fn a_godot_pane_in_either_mode_makes_godot_work() {
        let mut shot = snapshot(vec![
            cluster("c1", &["agent-tab-1", "godot-viewer-1"], "C:/wt/a"),
            cluster("c2", &["agent-tab-2", "play-2"], "C:/wt/b"),
            cluster("c3", &["agent-tab-3"], "C:/wt/c"),
        ]);
        shot.instances = vec![
            instance("agent-tab-1", "agent-tab"),
            instance("godot-viewer-1", "godot-viewer"),
            instance("agent-tab-2", "agent-tab"),
            instance("play-2", "play"),
            instance("agent-tab-3", "agent-tab"),
        ];
        assert!(app_open(&shot, "c1", GODOT_APPS), "Editor mode");
        assert!(app_open(&shot, "c2", GODOT_APPS), "Play mode");
        assert!(!app_open(&shot, "c3", GODOT_APPS));
        assert!(!app_open(&shot, "c1", CANVAS_APPS));
    }

    fn instance(id: &str, app_id: &str) -> crate::shell_state::SurfaceInstance {
        crate::shell_state::SurfaceInstance {
            id: id.into(),
            app_id: app_id.into(),
            kind: crate::shell_state::SurfaceKind::App,
            title: app_id.into(),
        }
    }

    fn cluster(id: &str, tabs: &[&str], path: &str) -> crate::shell_state::Cluster {
        let mut tree = crate::layout::PaneNode::leaf(format!("pane-{id}"));
        for tab in tabs {
            tree.insert_tab(&format!("pane-{id}"), tab, None);
        }
        crate::shell_state::Cluster {
            id: id.into(),
            name: id.into(),
            tree,
            project: Some(path.into()),
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: Some(Environment::LocalWorktree {
                name: id.into(),
                path: path.into(),
                branch: format!("wt/{id}"),
                base: "main".into(),
            }),
            pinned: false,
            icon: None,
            environment_missing: false,
        }
    }

    fn snapshot(clusters: Vec<crate::shell_state::Cluster>) -> ShellSnapshot {
        ShellSnapshot {
            windows: vec![crate::shell_state::WindowPlacement {
                label: "main".into(),
                active_cluster_id: clusters.first().map(|c| c.id.clone()),
                clusters,
                geometry: None,
                right_page: None,
            }],
            instances: Vec::new(),
            terminals: Vec::new(),
        }
    }

    /// A session belongs to the cluster it started in, pointed where it was
    /// pointed then: a tab dragged away, or a cluster repointed, is a move.
    #[test]
    fn a_tab_is_home_only_in_the_cluster_and_worktree_it_started_in() {
        let before = snapshot(vec![
            cluster("c1", &["agent-tab-1"], "C:/wt/a"),
            cluster("c2", &[], "C:/wt/b"),
        ]);
        let home = home_of(&before, "agent-tab-1").unwrap();
        assert_eq!(home.cluster_id, "c1");

        let dragged = snapshot(vec![
            cluster("c1", &[], "C:/wt/a"),
            cluster("c2", &["agent-tab-1"], "C:/wt/b"),
        ]);
        assert_ne!(home_of(&dragged, "agent-tab-1").as_ref(), Some(&home));

        let repointed = snapshot(vec![cluster("c1", &["agent-tab-1"], "C:/wt/other")]);
        assert_ne!(home_of(&repointed, "agent-tab-1").as_ref(), Some(&home));

        let unchanged = snapshot(vec![cluster("c1", &["x", "agent-tab-1"], "C:/wt/a")]);
        assert_eq!(home_of(&unchanged, "agent-tab-1").as_ref(), Some(&home));
        assert!(home_of(&unchanged, "agent-tab-2").is_none());
    }

    /// A host that records what it emits, in a `Sessions` nothing has started.
    fn recording_sessions() -> (Sessions, Arc<Mutex<Vec<veistra_agent_host::Envelope>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let host = AgentHost::new(
            Arc::new(move |envelope| sink.lock().unwrap().push(envelope)),
            Arc::new(|_, _| {}),
        );
        let sessions = Sessions::default();
        assert!(sessions.host.set(host).is_ok());
        (sessions, seen)
    }

    /// The tabs that were sent a reset, once the host has said so. A reset for
    /// a tab no one else is named for goes last and marks the end: the host
    /// emits from one thread, in order, so nothing earlier can still be on its
    /// way when the marker is here.
    fn reset_tabs(
        sessions: &Sessions,
        seen: &Mutex<Vec<veistra_agent_host::Envelope>>,
    ) -> Vec<String> {
        const MARKER: &str = "marker";
        sessions.host.get().unwrap().reset(MARKER);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let got = seen.lock().unwrap().clone();
            if got.iter().any(|e| e.instance_id == MARKER) || std::time::Instant::now() > deadline {
                let mut tabs: Vec<String> = got
                    .into_iter()
                    .filter(|e| matches!(e.event, veistra_agent_host::Event::Reset))
                    .map(|e| e.instance_id)
                    .filter(|id| id != MARKER)
                    .collect();
                tabs.sort();
                return tabs;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The layout changed under three running agents: one tab was dragged to
    /// another cluster, one cluster was pointed at another worktree, and one
    /// tab was closed. Each loses its session; the tab that did not move keeps
    /// its own, and every tab that is gone is forgotten.
    #[test]
    fn sync_resets_a_moved_or_repointed_tab_and_forgets_a_closed_one() {
        let (sessions, seen) = recording_sessions();
        let before = snapshot(vec![
            cluster("c1", &["stays", "dragged", "closed"], "C:/wt/a"),
            cluster("c2", &["repointed"], "C:/wt/b"),
        ]);
        for id in ["stays", "dragged", "closed", "repointed"] {
            sessions
                .homes()
                .insert(id.to_string(), home_of(&before, id).unwrap());
        }

        let mut after = snapshot(vec![
            cluster("c1", &["stays"], "C:/wt/a"),
            cluster("c2", &["repointed", "dragged"], "C:/wt/elsewhere"),
        ]);
        after.instances = ["stays", "dragged", "repointed"]
            .into_iter()
            .map(|id| instance(id, ID))
            .collect();
        sessions.sync(&after);

        assert_eq!(
            reset_tabs(&sessions, &seen),
            ["dragged", "dragged:btw", "repointed", "repointed:btw"],
            "moving or repointing also resets each tab's independent side conversation"
        );
        let mut homed: Vec<String> = sessions.homes().keys().cloned().collect();
        homed.sort();
        assert_eq!(
            homed,
            ["stays"],
            "moved tabs lose their home, closed ones too"
        );
    }

    #[test]
    fn sync_leaves_a_tab_alone_while_it_is_where_it_started() {
        let (sessions, seen) = recording_sessions();
        let shot = snapshot(vec![cluster("c1", &["a", "b"], "C:/wt/a")]);
        for id in ["a", "b"] {
            sessions
                .homes()
                .insert(id.to_string(), home_of(&shot, id).unwrap());
        }
        let mut same = shot.clone();
        same.instances = ["a", "b"].into_iter().map(|id| instance(id, ID)).collect();
        sessions.sync(&same);
        assert!(reset_tabs(&sessions, &seen).is_empty());
        assert_eq!(sessions.homes().len(), 2);
    }

    #[test]
    fn a_host_error_carries_its_code_and_hint() {
        let err = host_error(HostError::Busy);
        assert_eq!(err.code, REFUSED);
        assert_eq!(code_of(&err), Some("busy"));
    }

    #[test]
    fn text_params_must_be_non_empty_strings() {
        let params = json!({ "text": "hi", "blank": "  ", "number": 3 });
        assert_eq!(text_param(&params, "text").unwrap(), "hi");
        for name in ["blank", "number", "missing"] {
            assert_eq!(text_param(&params, name).unwrap_err().code, INVALID_PARAMS);
        }
    }

    #[test]
    fn a_choice_names_a_registered_harness_by_its_id() {
        for d in REGISTRY {
            let params = json!({ "harness": d.harness });
            assert_eq!(harness_param(&params).unwrap(), d.harness);
        }
        for id in ["Claude", "claude-code", "nonesuch"] {
            let err = harness_param(&json!({ "harness": id })).unwrap_err();
            assert_eq!(err.code, INVALID_PARAMS, "{id}");
            assert!(err.message.contains("\"claude\""), "{}", err.message);
        }
        let missing = harness_param(&json!({})).unwrap_err();
        assert_eq!(missing.code, INVALID_PARAMS);
    }

    #[test]
    fn a_tab_runs_the_first_harness_until_it_chooses_one() {
        assert_eq!(current(None, None), harness::first());
        for d in REGISTRY {
            assert_eq!(current(None, Some(d.harness)), d.harness);
            assert_eq!(current(Some(d.harness), None), d.harness);
        }
    }

    #[test]
    fn a_tabs_live_agent_beats_its_choice_which_beats_the_first() {
        assert_eq!(next_of(None, None, "first"), "first");
        assert_eq!(next_of(None, Some("chosen"), "first"), "chosen");
        assert_eq!(next_of(Some("running"), None, "first"), "running");
        assert_eq!(next_of(Some("running"), Some("chosen"), "first"), "running");
    }

    /// The harness `id` chose, if any.
    fn chosen<H: Clone>(map: &Mutex<HashMap<String, Choice<H>>>, id: &str) -> Option<H> {
        map.lock().unwrap().get(id).map(|c| c.harness.clone())
    }

    #[test]
    fn a_choice_is_kept_and_told_to_every_view_of_the_tab() {
        let map = Mutex::new(HashMap::new());
        let opus = Some(Some("opus".to_string()));
        let event = choose(&map, "agent-tab-1", None, "pi", opus, || true).unwrap();
        assert_eq!(chosen(&map, "agent-tab-1"), Some("pi"));
        // The keys the tab's `onChosen` and the shell's relay read.
        assert_eq!(
            event,
            json!({ "instanceId": "agent-tab-1", "harness": "pi", "model": "opus" })
        );
    }

    #[test]
    fn a_choice_for_a_tab_that_closed_meanwhile_is_taken_back() {
        let map = Mutex::new(HashMap::new());
        let err = choose(&map, "agent-tab-1", None, "pi", None, || {
            // Checked after the store: a prune that ran first would miss it.
            assert_eq!(chosen(&map, "agent-tab-1"), Some("pi"));
            false
        })
        .unwrap_err();
        assert_eq!(code_of(&err), Some("noInstance"));
        assert_eq!(chosen(&map, "agent-tab-1"), None);
    }

    #[test]
    fn a_choice_while_another_harness_runs_is_refused_and_not_kept() {
        let claude = Choice {
            harness: "claude",
            models: HashMap::new(),
        };
        let map = Mutex::new(HashMap::from([("agent-tab-1".to_string(), claude)]));
        let err = choose(&map, "agent-tab-1", Some("claude"), "pi", None, || true).unwrap_err();
        assert_eq!(code_of(&err), Some("running"));
        assert_eq!(chosen(&map, "agent-tab-1"), Some("claude"));
    }

    /// The keys `rpc.ts`'s `Harnesses` reads; a rename on either side has to
    /// change this test as well.
    #[test]
    fn the_harnesses_answer_has_the_keys_the_tab_reads() {
        let info = veistra_agent_host::harness::CLAUDE.info(None);
        let answer = harnesses_answer(
            std::slice::from_ref(&info),
            Harness::Claude,
            Some(Harness::Claude),
            Some("Opus".to_string()),
            Some(json!("notAWorktree")),
        );
        assert_eq!(
            answer,
            json!({
                "harnesses": [info],
                "current": "claude",
                "running": "claude",
                "model": "Opus",
                "blocked": "notAWorktree",
            })
        );
        let idle = harnesses_answer(&[], Harness::Claude, None, None, None);
        assert_eq!(
            idle,
            json!({
                "harnesses": [],
                "current": "claude",
                "running": null,
                "model": null,
                "blocked": null,
            })
        );
    }

    #[test]
    fn a_tab_chooses_another_harness_only_once_its_agent_is_gone() {
        assert!(may_choose(None, "pi").is_ok());
        assert!(may_choose(Some("pi"), "pi").is_ok());
        let err = may_choose(Some("claude"), "pi").unwrap_err();
        assert_eq!(code_of(&err), Some("running"));
    }
}
