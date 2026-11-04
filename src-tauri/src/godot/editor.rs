//! The Godot editor in the pane (#316, owner decision 6): started by Veistra
//! with `--single-window`, so its dialogs and Project Settings stay inside one
//! window, placed over the Godot pane by the embedder (DECISIONS X2), and
//! reached through the Veistra plugin's file channel ([`super::plugin`], X5).
//!
//! **The person's editor, never Veistra's to end.** It is supervised only so
//! the pane can say it runs and follow it; nothing here kills it. Close posts
//! `WM_CLOSE` to its window, what the title bar's close button sends, so Godot
//! asks to save unsaved work and the person may cancel. With no window to post
//! to, the plugin's `close` does the same from inside. When the pane closes or
//! Veistra exits, the window is handed back as a normal one
//! ([`Orphan::Release`]).
//!
//! **One per cluster, one per project:** two editors on one project folder
//! write over each other's saves, so a second cluster's is refused.
//!
//! **Godot's Restart editor** quits and starts a new editor as its child,
//! without Veistra's arguments. The state read after the old one ends finds
//! that child ([`restarted`]) and hosts it in its place; `VEISTRA_EDITOR_DIR`,
//! which the child inherits, keeps the plugin on the same channel.

use super::addon;
use super::detect::GodotProject;
use super::plugin;
use super::rpc::{self, fail, Ctx, READ_ONLY};
use super::runner::{self, now_ms};
use super::session::{self, Proc};
use crate::editor_notes::{self, Ack, Scope};
use crate::embed::host::{HostSpec, Orphan, Pane, Slot};
use crate::embed::{self, Embed, Kind, LaunchRect};
use crate::sync::MutexExt;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use veistra_rpc::{RpcError, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The plugin reads its channel folder from here when the argument is gone.
pub const DIR_ENV: &str = "VEISTRA_EDITOR_DIR";

/// How long a plugin command may take. A viewport PNG of a large 3D view is
/// the slowest answer, well under a second; longer means the editor is busy
/// in a modal dialog or not running the plugin.
const WAIT: Duration = Duration::from_secs(5);

const SILENT: &str = "The Godot editor did not answer. It may be busy in a dialog; if the Veistra \
     plugin was enabled after this editor started, close the editor and open it again.";

/// Why the files of a project may not change now.
pub const CLOSE_FIRST: &str = "Close the Godot editor first: it keeps its own copy of \
     project.godot and would write over the change.";

/// A restart's new editor starts within this many seconds of the old one
/// ending; an older child is something the editor ran, such as the game.
const RESTART_SECS: u64 = 15;

enum Process {
    Spawned(Child),
    /// Started by Godot's Restart editor: Veistra holds no handle to it.
    Adopted(u32),
}

/// One cluster's editor.
pub struct Editor {
    pub project: PathBuf,
    pub rel: String,
    pub godot: String,
    /// Why the plugin cannot run on this engine, when it cannot.
    pub plugin_problem: Option<String>,
    pub channel: PathBuf,
    pub embed: Arc<Embed>,
    /// The Veistra dock's `notes.json` and `events.jsonl` (#320). Shared with
    /// the editor a restart starts, which keeps the channel.
    tab: Arc<Mutex<editor_notes::Channel>>,
    /// Seconds since the epoch when this process started.
    started: u64,
    process: Mutex<Process>,
}

impl Editor {
    pub fn pid(&self) -> u32 {
        match &*self.process.lock_or_panic() {
            Process::Spawned(child) => child.id(),
            Process::Adopted(pid) => *pid,
        }
    }

    /// `None` while it runs; once it has ended, its exit code if it had one.
    pub fn ended(&self) -> Option<Option<i32>> {
        match &mut *self.process.lock_or_panic() {
            Process::Spawned(child) => match child.try_wait() {
                Ok(None) => None,
                Ok(Some(status)) => Some(status.code()),
                Err(_) => Some(None),
            },
            Process::Adopted(pid) => (!session::is_running(*pid)).then_some(None),
        }
    }

    pub fn is_running(&self) -> bool {
        self.ended().is_none()
    }

    /// The plugin has said hello on this editor's channel.
    pub fn plugin_running(&self) -> bool {
        addon::running_version(&self.channel).is_some()
    }

    /// What the plugin last wrote to `state.json`: the edited scene, the open
    /// ones, the selection, the main screen and Viewport only.
    fn view(&self) -> Value {
        std::fs::read_to_string(self.channel.join("state.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null)
    }

    /// The same editor under the process a restart started, with an embed
    /// of its own: the old one's window is gone.
    fn restarted_as(&self, pid: u32, started: u64, embed: Arc<Embed>) -> Self {
        Self {
            project: self.project.clone(),
            rel: self.rel.clone(),
            godot: self.godot.clone(),
            plugin_problem: self.plugin_problem.clone(),
            channel: self.channel.clone(),
            embed,
            tab: self.tab.clone(),
            started,
            process: Mutex::new(Process::Adopted(pid)),
        }
    }

    #[cfg(test)]
    pub(super) fn end_for_test(&self) {
        if let Process::Spawned(child) = &mut *self.process.lock_or_panic() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Every cluster's editor, kept on [`super::Godot`].
#[derive(Default)]
pub struct Editors(Mutex<HashMap<String, Arc<Editor>>>);

impl Editors {
    pub fn get(&self, cluster: &str) -> Option<Arc<Editor>> {
        self.0.lock_or_panic().get(cluster).cloned()
    }

    fn set(&self, cluster: &str, editor: Arc<Editor>) {
        self.0.lock_or_panic().insert(cluster.to_string(), editor);
    }

    fn remove_if(&self, cluster: &str, editor: &Arc<Editor>) {
        let mut all = self.0.lock_or_panic();
        if all.get(cluster).is_some_and(|e| Arc::ptr_eq(e, editor)) {
            all.remove(cluster);
        }
    }

    /// The running editor on `project`, whichever cluster opened it.
    pub fn holding(&self, project: &Path) -> Option<(String, Arc<Editor>)> {
        let all: Vec<_> = self
            .0
            .lock_or_panic()
            .iter()
            .map(|(k, e)| (k.clone(), e.clone()))
            .collect();
        all.into_iter()
            .find(|(_, e)| e.project == project && e.is_running())
    }
}

/// `godot --editor --single-window --path <project>`, at the pane's rect when
/// it is known, and the channel after `--` where the plugin reads it.
pub fn launch_args(project: &Path, at: Option<LaunchRect>, channel: &Path) -> Vec<String> {
    let mut args: Vec<String> = ["--editor", "--single-window", "--path"]
        .map(String::from)
        .to_vec();
    args.push(project.display().to_string());
    if let Some(at) = at {
        args.push("--windowed".into());
        args.push("--resolution".into());
        args.push(format!("{}x{}", at.width, at.height));
        if let Some((x, y)) = at.position {
            args.push("--position".into());
            args.push(format!("{x},{y}"));
        }
    }
    args.push("--".into());
    args.push(format!("--veistra-editor-dir={}", channel.display()));
    args
}

/// The editor Godot's Restart editor started: a child of the old process
/// that started since `since`. Windows keeps a dead parent's id on its
/// children, which is what makes the new one findable after the old exits.
pub fn restarted(old: u32, since: u64, procs: &[Proc]) -> Option<&Proc> {
    procs
        .iter()
        .filter(|p| p.parent == Some(old) && p.started >= since)
        .max_by_key(|p| p.started)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    project: Option<String>,
    on: Option<bool>,
    what: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    paths: Vec<String>,
    scene: Option<String>,
    /// `editor-state`: the last dock event the pane has acted on.
    events_since: u64,
    /// `editor-ack`: the event, whether it went through, and what to say.
    n: Option<u64>,
    ok: bool,
    message: Option<String>,
}

fn params(raw: Option<&Value>) -> Result<Params, RpcError> {
    match raw {
        None | Some(Value::Null) => Ok(Params::default()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}"))),
    }
}

/// `godot/editor-*` and `godot/plugin-*`, which both modes answer. `None`
/// for any other method.
pub fn call(ctx: &Ctx, method: &str, raw: Option<&Value>) -> Option<Result<Value, RpcError>> {
    if !method.starts_with("godot/editor-") && !method.starts_with("godot/plugin-") {
        return None;
    }
    Some(params(raw).and_then(|p| match method {
        "godot/editor-open" => open(ctx, &p),
        "godot/editor-state" => Ok(with_tab(ctx, state(ctx), p.events_since)),
        "godot/editor-ack" => ack(ctx, &p),
        "godot/editor-close" => close(ctx),
        "godot/editor-selection" => selection(ctx),
        "godot/editor-capture" => capture(ctx, &p),
        "godot/editor-pick" => pick(ctx, &p),
        "godot/editor-select" => select(ctx, &p),
        "godot/editor-open-scene" => open_scene(ctx, &p),
        "godot/editor-viewport-only" => viewport_only(ctx, &p),
        "godot/editor-save" => command(ctx, "save", json!({})).map(|_| json!({ "saved": true })),
        "godot/plugin-status" => plugin_status(ctx, &p),
        "godot/plugin-install" => plugin_change(ctx, &p, true),
        "godot/plugin-remove" => plugin_change(ctx, &p, false),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }))
}

/// The cluster's editor while it runs.
pub fn running(ctx: &Ctx) -> Option<Arc<Editor>> {
    ctx.godot.editors.get(&ctx.key).filter(|e| e.is_running())
}

fn godot_4(project: &GodotProject) -> Result<(), RpcError> {
    if project.engine_major < 4 {
        return Err(fail(format!(
            "`{}` is a Godot 3 project; Veistra drives Godot 4.x",
            project.name
        )));
    }
    Ok(())
}

fn open(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    if ctx.read_only {
        return Err(RpcError::new(
            READ_ONLY,
            "This is the main checkout, which is read-only in Veistra - the editor could change it. \
             Open a worktree to edit there.",
        ));
    }
    let found = rpc::require_engine(ctx)?;
    let project = rpc::pick_project_for(ctx, p.project.as_deref())?;
    godot_4(&project)?;
    if let Some(editor) = running(ctx) {
        if editor.project == project.dir {
            return Ok(state(ctx));
        }
        return Err(fail(format!(
            "The Godot editor is open on {}. Close it before opening {}.",
            editor.rel, project.rel
        )));
    }
    if ctx.godot.editors.holding(&project.dir).is_some() {
        return Err(fail(
            "This project is open in the Godot editor of another cluster. Close it there first: \
             two editors on one project write over each other's saves.",
        ));
    }
    let base = ctx.scratch.join("editor");
    let channel = runner::fresh_channel(&base, &ctx.key, ctx.godot.next_command_id())
        .map_err(|e| fail(format!("could not create {}: {e}", base.display())))?;
    let pane = ctx
        .instance
        .as_deref()
        .and_then(|i| ctx.hosts.box_of(&Slot::new(i, Kind::GodotEditor)));
    let owner = (ctx.owner)(pane.as_ref().and_then(|p| p.window.as_deref()));
    let at =
        embed::SUPPORTED.then(|| embed::launch_rect(pane.as_ref().map(Pane::last), owner.as_ref()));
    // The GUI executable: the console wrapper would leave a console window
    // beside the editor, and nothing here reads the editor's output.
    let child = rpc::detached(
        &found.path,
        &launch_args(&project.dir, at, &channel),
        &project.dir,
    )
    .env(DIR_ENV, &channel)
    .spawn()
    .map_err(|e| fail(format!("could not start Godot: {e}")))?;
    let editor = Arc::new(Editor {
        project: project.dir.clone(),
        rel: project.rel.clone(),
        godot: found.version.clone(),
        plugin_problem: plugin::too_old(found.major, found.minor),
        tab: Arc::new(Mutex::new(editor_notes::Channel::new(channel.clone()))),
        channel,
        embed: ctx.hosts.embed(Kind::GodotEditor),
        started: now_ms() / 1000,
        process: Mutex::new(Process::Spawned(child)),
    });
    ctx.godot.editors.set(&ctx.key, editor.clone());
    host(ctx, &editor);
    let plugin = plugin::status(&project.dir) == addon::Installed::Yes;
    (ctx.usage)("editor_opened", json!({ "plugin": plugin }));
    Ok(state(ctx))
}

/// Hand the editor's window to the embedder for the calling pane.
fn host(ctx: &Ctx, editor: &Arc<Editor>) {
    let instance = ctx.instance.clone();
    let shown = instance.as_deref().is_some_and(|i| (ctx.shown)(i));
    let (tree, alive) = (editor.clone(), editor.clone());
    ctx.hosts.host(
        ctx.owner.clone(),
        shown,
        HostSpec {
            instance,
            cluster: ctx.key.clone(),
            embed: editor.embed.clone(),
            pids: Box::new(move || session::process_tree(tree.pid())),
            alive: Arc::new(move || alive.is_running()),
            on_attached: None,
            on_orphan: Orphan::Release,
        },
    );
}

/// The editor that took over from `old` after a Restart editor, hosted.
fn follow_restart(ctx: &Ctx, old: &Arc<Editor>) -> Option<Arc<Editor>> {
    let since = old
        .started
        .max((now_ms() / 1000).saturating_sub(RESTART_SECS));
    let procs = session::processes();
    let next = restarted(old.pid(), since, &procs)?;
    old.embed.forget();
    let embed = ctx.hosts.embed(Kind::GodotEditor);
    let editor = Arc::new(old.restarted_as(next.pid, next.started, embed));
    ctx.godot.editors.set(&ctx.key, editor.clone());
    host(ctx, &editor);
    Some(editor)
}

/// `godot/editor-state`, polled by the pane: whether the editor runs, where
/// its window is, what the plugin reports, and whether an agent is working
/// in this environment, for the banner.
pub fn state(ctx: &Ctx) -> Value {
    let agent = (ctx.agent)();
    let Some(mut editor) = ctx.godot.editors.get(&ctx.key) else {
        return json!({ "editor": Value::Null, "agent": agent });
    };
    if let Some(code) = editor.ended() {
        let next = if code == Some(0) || code.is_none() {
            follow_restart(ctx, &editor)
        } else {
            None
        };
        match next {
            Some(next) => editor = next,
            None => {
                editor.embed.forget();
                ctx.godot.editors.remove_if(&ctx.key, &editor);
                return json!({
                    "editor": Value::Null,
                    "ended": { "project": editor.rel, "code": code },
                    "agent": agent,
                });
            }
        }
    }
    let running = editor.plugin_running();
    json!({
        "editor": {
            "project": editor.rel,
            "pid": editor.pid(),
            "godot": editor.godot,
            "embed": editor.embed.report(),
            "plugin": {
                "installed": plugin::status(&editor.project),
                "running": running,
                "problem": editor.plugin_problem,
                // What each tool that needs it says while it cannot act.
                "why": (!running).then(|| no_plugin(&editor)),
            },
            "view": editor.view(),
        },
        "agent": agent,
    })
}

fn call_context(ctx: &Ctx) -> crate::apps::CallContext {
    crate::apps::CallContext {
        cluster_id: Some(ctx.key.clone()),
        project: ctx.root.clone(),
    }
}

/// The Veistra dock's half of a poll (#320): `notes.json` brought up to date
/// for the dock, and its events after `since` as `editor.events`, for the
/// pane to act on.
fn with_tab(ctx: &Ctx, mut state: Value, since: u64) -> Value {
    let Some(editor) = running(ctx).filter(|_| state["editor"].is_object()) else {
        return state;
    };
    let mut tab = editor.tab.lock_or_panic();
    tab.poll();
    if let Err(e) = tab.sync(&call_context(ctx), Scope::Godot) {
        crate::veistra_log!("Godot editor notes: {e}");
    }
    state["editor"]["events"] = Value::Array(tab.since(since));
    state
}

/// `godot/editor-ack {n, ok, message}`: the pane's answer to dock event `n`,
/// which the dock shows from the `notes.json` written here.
fn ack(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("no Godot editor is open in this cluster"))?;
    let n =
        p.n.ok_or_else(|| RpcError::new(INVALID_PARAMS, "editor-ack needs `n`"))?;
    let mut tab = editor.tab.lock_or_panic();
    tab.ack(Ack {
        n,
        ok: p.ok,
        message: p.message.clone().unwrap_or_default(),
    });
    tab.sync(&call_context(ctx), Scope::Godot).map_err(fail)?;
    Ok(json!({ "acked": n }))
}

fn close(ctx: &Ctx) -> Result<Value, RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("no Godot editor is open in this cluster"))?;
    let posted = editor.embed.request_close();
    if posted == Ok(true) {
        return Ok(json!({ "closing": true, "via": "window" }));
    }
    if editor.plugin_running() {
        command(ctx, "close", json!({}))?;
        return Ok(json!({ "closing": true, "via": "plugin" }));
    }
    Err(fail(match posted {
        Err(e) => format!("Veistra could not ask the editor to close ({e}). Close it from Godot."),
        Ok(_) => "Veistra cannot reach this editor's window. Close it from Godot.".to_string(),
    }))
}

/// Why the plugin cannot answer for this editor.
fn no_plugin(editor: &Editor) -> String {
    if let Some(problem) = &editor.plugin_problem {
        return problem.clone();
    }
    if plugin::status(&editor.project) != addon::Installed::Yes {
        return "This needs the Veistra plugin. Close the editor, enable the plugin here, and \
                open the editor again."
            .to_string();
    }
    "The Veistra plugin has not started in this editor yet. If it was enabled after the editor \
     opened, close the editor and open it again."
        .to_string()
}

/// One plugin command and its answer, with the PNG it names when it names one.
fn command(ctx: &Ctx, action: &str, extra: Value) -> Result<(Value, Option<Vec<u8>>), RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("no Godot editor is open in this cluster"))?;
    if !editor.plugin_running() {
        return Err(fail(no_plugin(&editor)));
    }
    let id = ctx.godot.next_command_id();
    let (reply, png) = addon::exchange(
        &editor.channel,
        id,
        action,
        extra,
        WAIT,
        SILENT,
        |dir, text| {
            let reply: Value =
                serde_json::from_str(text).map_err(|e| format!("unreadable reply: {e}"))?;
            let png = addon::png_in(dir, &reply)
                .map_err(|e| format!("the editor wrote no image: {e}"))?;
            // Answered: nothing in the folder is read twice, and a viewport PNG
            // a send makes every time would otherwise pile up.
            let _ = std::fs::remove_file(dir.join(format!("res-{id}.json")));
            if let Some(name) = reply["png"].as_str().filter(|_| png.is_some()) {
                let _ = std::fs::remove_file(dir.join(name));
            }
            Ok((reply, png))
        },
    )
    .map_err(fail)?;
    if reply["ok"].as_bool() != Some(true) {
        let error = reply["error"].as_str().unwrap_or("the editor refused");
        return Err(fail(format!("Godot: {error}")));
    }
    Ok((reply, png))
}

/// A reply's picture as the page takes it, beside its size and camera.
fn with_picture(mut reply: Value, png: Option<Vec<u8>>) -> Value {
    if let Some(png) = png {
        reply["pngBase64"] = Value::String(BASE64.encode(png));
    }
    if let Some(o) = reply.as_object_mut() {
        for k in ["id", "ok", "png", "t"] {
            o.remove(k);
        }
    }
    reply
}

/// Send selection's one round trip: the selected nodes, the scene, the 3D
/// camera and the viewport, read at the same moment.
fn selection(ctx: &Ctx) -> Result<Value, RpcError> {
    let (reply, png) = command(ctx, "selection", json!({}))?;
    Ok(with_picture(reply, png))
}

fn capture(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let what = p.what.as_deref().unwrap_or("viewport");
    if !matches!(what, "viewport" | "window") {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "`what` is `viewport` or `window`",
        ));
    }
    let (reply, png) = command(ctx, "capture", json!({ "what": what }))?;
    Ok(with_picture(reply, png))
}

/// The node under a point of the last viewport capture, by the editor's own
/// picking: `{hit: {nodePath, type, worldPoint, source: "editor"} | null}`.
fn pick(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let (Some(x), Some(y)) = (p.x, p.y) else {
        return Err(RpcError::new(INVALID_PARAMS, "pick needs `x` and `y`"));
    };
    let (reply, _) = command(ctx, "pick", json!({ "x": x, "y": y }))?;
    Ok(json!({ "hit": reply["hit"] }))
}

fn select(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    if p.paths.is_empty() {
        return Err(RpcError::new(INVALID_PARAMS, "select needs `paths`"));
    }
    let (reply, _) = command(ctx, "select", json!({ "paths": p.paths }))?;
    Ok(json!({ "missing": reply["missing"] }))
}

fn open_scene(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let scene = p.scene.as_deref().unwrap_or_default();
    if !rpc::valid_scene(scene) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{scene}` is not a res:// scene"),
        ));
    }
    command(ctx, "open", json!({ "scene": scene }))?;
    Ok(json!({ "scene": scene }))
}

fn viewport_only(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let on = p.on.unwrap_or(true);
    command(ctx, "viewport-only", json!({ "on": on }))?;
    Ok(json!({ "viewportOnly": on }))
}

fn plugin_status(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = rpc::pick_project_for(ctx, p.project.as_deref())?;
    let problem = rpc::engine(ctx, false)
        .found
        .and_then(|f| plugin::too_old(f.major, f.minor));
    Ok(json!({
        "plugin": plugin::status(&project.dir),
        "problem": problem,
        "editorOpen": ctx.godot.editors.holding(&project.dir).is_some(),
        "readOnly": ctx.read_only,
    }))
}

fn plugin_change(ctx: &Ctx, p: &Params, install: bool) -> Result<Value, RpcError> {
    if ctx.read_only {
        return Err(RpcError::new(
            READ_ONLY,
            "This is the main checkout, which is read-only in Veistra, so the Veistra plugin \
             cannot be added here. Make a worktree to edit with it.",
        ));
    }
    let project = rpc::pick_project_for(ctx, p.project.as_deref())?;
    if ctx.godot.editors.holding(&project.dir).is_some() {
        return Err(fail(CLOSE_FIRST));
    }
    if install {
        godot_4(&project)?;
        if let Some(found) = rpc::engine(ctx, false).found {
            if let Some(problem) = plugin::too_old(found.major, found.minor) {
                return Err(fail(problem));
            }
        }
        plugin::install(&project.dir).map_err(fail)?;
    } else {
        plugin::remove(&project.dir).map_err(fail)?;
    }
    plugin_status(ctx, p)
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
