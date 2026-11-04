//! Blender in the pane (#317): the person's own Blender, started by Veistra
//! as `blender <file.blend> --python veistra_boot.py`, placed over the
//! Blender pane by the embedder (DECISIONS X2) and reached through the boot
//! script's channel folder (X5). Nothing is installed into Blender: the
//! script is passed on the command line and does nothing without
//! [`CHANNEL_ENV`].
//!
//! **The person's Blender, never Veistra's to end.** Close posts `WM_CLOSE`,
//! what the title bar's close button sends, so Blender asks to save; with no
//! window to post to, the boot script's `quit` runs Blender's own quit, which
//! asks the same. A pane that closes, or Veistra exiting, hands the window
//! back as a normal one ([`Orphan::Release`]).
//!
//! **One writer per file** ([`super::lock`]): while Blender here has a
//! `.blend` open, `.veistra/locks/<file>.lock` names its process. A watcher
//! follows the file Blender reports, so File > Open moves the lock, an unsaved
//! new file holds none, and Blender exiting removes it. The agent's export
//! reads the lock and writes the next version instead of anything near the
//! `.blend` ([`super::versions`]).

use super::lock::{self, Lock};
use crate::editor_notes::{self, Ack, Scope};
use crate::embed::host::{HostSpec, Hosts, Orphan};
use crate::embed::{Embed, Kind, OwnerFn};
use crate::sync::MutexExt;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The boot script reads its channel folder from here, and without it does
/// nothing.
pub const CHANNEL_ENV: &str = "VEISTRA_BLENDER_CHANNEL";

/// The boot script's name in the channel folder.
const BOOT_FILE: &str = "veistra_boot.py";

/// How long a command may take. A viewport capture is the slowest answer;
/// longer means Blender is in a modal operator or a long render.
const WAIT: Duration = Duration::from_secs(5);

/// How often the watcher reads what Blender reports.
const FOLLOW_EVERY: Duration = Duration::from_millis(500);

const SILENT: &str = "Blender did not answer. It may be busy in a dialog or a long operation; \
     try again when it is free.";

const NOT_BOOTED: &str = "The Veistra script has not started in this Blender yet. If Blender \
     is still loading, wait a moment; if it was opened without Veistra, close it and open it \
     from this pane.";

/// Why Blender in the pane cannot be started on the main checkout.
pub const READ_ONLY_REASON: &str = "This is the main checkout, which is read-only in Veistra: \
     Blender would save into it. Open a worktree to edit there.";

/// One cluster's Blender.
pub struct Editor {
    /// The environment the file is in.
    pub project: PathBuf,
    /// The `.blend` it was opened on, relative to `project`.
    pub opened: String,
    /// `blender --version`'s answer, when it gave one.
    pub blender: Option<String>,
    pub channel: PathBuf,
    pub embed: Arc<Embed>,
    pub cluster: String,
    child: Mutex<Child>,
    /// The lock this Blender holds: on the file it has open, as it last said.
    held: Mutex<Option<Lock>>,
    /// A file Blender opened that another Blender holds, so this one could
    /// not lock it. Two editors on it may write over each other's saves.
    conflict: Mutex<Option<String>>,
    /// The Veistra tab's `notes.json` and `events.jsonl` (#320).
    tab: Mutex<editor_notes::Channel>,
}

impl Editor {
    /// The process the boot script says it runs in, else the one Veistra
    /// started. They differ when the executable is a launcher that starts
    /// Blender and exits, as `blender-launcher.exe` does.
    pub fn pid(&self) -> u32 {
        self.hello()
            .and_then(|h| h["pid"].as_u64())
            .and_then(|p| u32::try_from(p).ok())
            .unwrap_or_else(|| self.child.lock_or_panic().id())
    }

    /// `None` while it runs; once it has ended, its exit code if it had one.
    pub fn ended(&self) -> Option<Option<i32>> {
        let code = match self.child.lock_or_panic().try_wait() {
            Ok(None) => return None,
            Ok(Some(status)) => status.code(),
            Err(_) => None,
        };
        let real = self.pid();
        if real != self.child.lock_or_panic().id() && crate::godot::session::is_running(real) {
            return None;
        }
        Some(code)
    }

    pub fn is_running(&self) -> bool {
        self.ended().is_none()
    }

    fn read(&self, name: &str) -> Option<Value> {
        let text = std::fs::read_to_string(self.channel.join(name)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn hello(&self) -> Option<Value> {
        self.read("hello.json")
    }

    /// The boot script has said hello on this Blender's channel.
    pub fn booted(&self) -> bool {
        self.hello().is_some()
    }

    /// What the boot script last wrote to `state.json`: the open file, whether
    /// it has unsaved changes, the selection and the 3D view.
    pub fn view(&self) -> Value {
        self.read("state.json").unwrap_or(Value::Null)
    }

    /// The file Blender has open, relative to the environment: `Some("")` for
    /// a new file never saved, `None` for one outside the environment or
    /// before Blender has said.
    fn reported_file(&self) -> Option<String> {
        let view = self.view();
        let file = view["file"].as_str()?;
        if file.is_empty() {
            return Some(String::new());
        }
        super::relative_blend(&self.project, Path::new(file))
    }

    /// The file this Blender has open now, relative to the environment.
    pub fn file(&self) -> Option<String> {
        match self.reported_file() {
            Some(rel) if rel.is_empty() => None,
            Some(rel) => Some(rel),
            None if self.view()["file"].is_string() => None,
            None => Some(self.opened.clone()),
        }
    }

    pub fn lock(&self) -> Option<Lock> {
        self.held.lock_or_panic().clone()
    }

    /// Whether the file `rel` is the one open here, with unsaved changes.
    pub fn dirty(&self, rel: &str) -> Option<bool> {
        (self.file().as_deref() == Some(rel))
            .then(|| self.view()["dirty"].as_bool())
            .flatten()
    }

    fn take(&self, rel: &str) {
        match lock::acquire(
            &self.project,
            rel,
            self.pid(),
            Some(&self.cluster),
            Some(&self.channel),
        ) {
            Ok(lock) => {
                *self.held.lock_or_panic() = Some(lock);
                *self.conflict.lock_or_panic() = None;
            }
            Err(e) => {
                crate::veistra_log!("blender: no lock on {rel}: {e}");
                *self.conflict.lock_or_panic() = Some(rel.to_string());
            }
        }
    }

    /// Remove the lock this Blender holds, if it still holds it.
    pub fn release(&self) {
        if let Some(lock) = self.held.lock_or_panic().take() {
            lock::release(&self.project, &lock.file, &lock);
        }
    }

    /// Move the lock to the file Blender reports now. Called by the watcher
    /// and by every state read, so the lock is never behind for long.
    pub fn follow(&self) {
        let now = self.file();
        let held = self.lock();
        let same = |l: &Lock| Some(&l.file) == now.as_ref() && l.pid == self.pid();
        if held.as_ref().is_some_and(same) {
            return;
        }
        // Still on a file another Blender holds: wait for that one to close.
        let refused = held.is_none() && now.is_some() && *self.conflict.lock_or_panic() == now;
        if refused
            && now
                .as_deref()
                .is_some_and(|rel| lock::live(&self.project, rel).is_some())
        {
            return;
        }
        self.release();
        *self.conflict.lock_or_panic() = None;
        if let Some(rel) = now {
            self.take(&rel);
        }
    }

    #[cfg(test)]
    pub(super) fn end_for_test(&self) {
        let mut child = self.child.lock_or_panic();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Every cluster's Blender, managed by Tauri.
#[derive(Default)]
pub struct Editors {
    all: Mutex<HashMap<String, Arc<Editor>>>,
    next_id: AtomicU64,
}

impl Editors {
    pub fn get(&self, cluster: &str) -> Option<Arc<Editor>> {
        self.all.lock_or_panic().get(cluster).cloned()
    }

    fn set(&self, cluster: &str, editor: Arc<Editor>) {
        self.all.lock_or_panic().insert(cluster.to_string(), editor);
    }

    fn remove_if(&self, cluster: &str, editor: &Arc<Editor>) {
        let mut all = self.all.lock_or_panic();
        if all.get(cluster).is_some_and(|e| Arc::ptr_eq(e, editor)) {
            all.remove(cluster);
        }
    }

    /// The running Blender that has `rel` in `project` open, whichever
    /// cluster started it.
    pub fn holding(&self, project: &Path, rel: &str) -> Option<Arc<Editor>> {
        let all: Vec<_> = self.all.lock_or_panic().values().cloned().collect();
        all.into_iter().find(|e| {
            same_dir(&e.project, project) && e.file().as_deref() == Some(rel) && e.is_running()
        })
    }

    /// [`Editor::dirty`] for whichever Blender has the file open.
    pub fn dirty(&self, project: &Path, rel: &str) -> Option<bool> {
        self.holding(project, rel)?.dirty(rel)
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// What a call needs besides its params, so it runs in tests without an app.
pub struct Ctx<'a> {
    pub editors: &'a Editors,
    pub hosts: &'a Hosts,
    pub cluster: String,
    /// The pane instance that asked, which the window is placed over.
    pub instance: Option<String>,
    /// The cluster's environment.
    pub project: Option<PathBuf>,
    /// The environment is `main`, where Blender is not started.
    pub read_only: bool,
    /// The Blender to start and its version, or why there is none.
    pub find: &'a dyn Fn() -> Result<(PathBuf, Option<String>), String>,
    /// Where channel folders go.
    pub scratch: PathBuf,
    pub owner: OwnerFn,
    pub shown: &'a dyn Fn(&str) -> bool,
}

fn fail(message: impl Into<String>) -> RpcError {
    RpcError::new(INTERNAL_ERROR, message.into())
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message.into())
}

/// `blender-viewer/editor-*`. `None` for any other method.
pub fn call(ctx: &Ctx, method: &str, params: Option<&Value>) -> Option<Result<Value, RpcError>> {
    if !method.starts_with("blender-viewer/editor-") {
        return None;
    }
    Some(match method {
        "blender-viewer/editor-open" => open(ctx, params),
        "blender-viewer/editor-state" => Ok(with_tab(ctx, state(ctx), params)),
        "blender-viewer/editor-ack" => ack(ctx, params),
        "blender-viewer/editor-close" => close(ctx),
        "blender-viewer/editor-capture" => capture(ctx),
        "blender-viewer/editor-pick" => pick(ctx, params),
        "blender-viewer/editor-select" => select(ctx, params),
        "blender-viewer/editor-viewport-only" => viewport_only(ctx, params),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    })
}

/// The arguments Blender starts with: the file, then the boot script, which
/// runs once the file has loaded. Not `--disable-autoexec`: this is the
/// person's Blender on their own file, and their preference decides.
pub fn launch_args(blend: &Path, boot: &Path) -> Vec<String> {
    vec![
        blend.display().to_string(),
        "--python".into(),
        boot.display().to_string(),
    ]
}

/// Blender, detached: its own process group and no pipes, so neither
/// Veistra's console nor its exit reaches it.
fn spawn(exe: &Path, args: &[String], cwd: &Path, channel: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .env(CHANNEL_ENV, channel)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: blender.exe is a
        // console program, and its console would open beside the window.
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()
}

/// The running Blender in this cluster.
pub fn running(ctx: &Ctx) -> Option<Arc<Editor>> {
    ctx.editors.get(&ctx.cluster).filter(|e| e.is_running())
}

fn open(ctx: &Ctx, params: Option<&Value>) -> Result<Value, RpcError> {
    if ctx.read_only {
        return Err(RpcError::new(crate::apps::READ_ONLY, READ_ONLY_REASON));
    }
    let project = ctx
        .project
        .clone()
        .ok_or_else(|| invalid("this cluster has no environment — open a project first"))?;
    let raw = params
        .and_then(|p| p.get("blend"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("`blend` is required"))?;
    let path = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        project.join(raw)
    };
    let rel = super::relative_blend(&project, &path).ok_or_else(|| {
        invalid(format!(
            "{raw} is not a .blend file inside this environment"
        ))
    })?;

    if let Some(editor) = running(ctx) {
        if editor.file().as_deref() == Some(rel.as_str()) {
            return Ok(state(ctx));
        }
        return Err(fail(format!(
            "Blender is open on {} in this pane. Close it before opening {rel}.",
            editor
                .file()
                .unwrap_or_else(|| "an unsaved file".to_string())
        )));
    }
    if ctx.editors.holding(&project, &rel).is_some() {
        return Err(fail(format!(
            "{rel} is open in Blender in another cluster. Close it there first: two Blenders on \
             one file save over each other."
        )));
    }
    // Locks a Blender left when it crashed with no Veistra watching.
    lock::sweep(&project);
    if let Some(held) = lock::live(&project, &rel) {
        return Err(fail(format!(
            "{rel} is already open in another Blender (process {}). Close it there first: two \
             Blenders on one file save over each other.",
            held.pid
        )));
    }
    let (exe, version) = (ctx.find)().map_err(invalid)?;

    let channel = fresh_channel(&ctx.scratch, &ctx.cluster, ctx.editors.next_id())
        .map_err(|e| fail(format!("could not create a channel folder: {e}")))?;
    let boot = channel.join(BOOT_FILE);
    std::fs::write(&boot, super::BOOT_SCRIPT)
        .map_err(|e| fail(format!("could not write {}: {e}", boot.display())))?;
    let child = spawn(&exe, &launch_args(&path, &boot), &project, &channel)
        .map_err(|e| fail(format!("could not start Blender: {e}")))?;
    let editor = Arc::new(Editor {
        project,
        opened: rel.clone(),
        blender: version,
        tab: Mutex::new(editor_notes::Channel::new(channel.clone())),
        channel,
        embed: ctx.hosts.embed(Kind::Blender),
        cluster: ctx.cluster.clone(),
        child: Mutex::new(child),
        held: Mutex::new(None),
        conflict: Mutex::new(None),
    });
    editor.take(&rel);
    ctx.editors.set(&ctx.cluster, editor.clone());
    host(ctx, &editor);
    watch(editor);
    Ok(state(ctx))
}

/// An empty channel folder for one Blender, named for the cluster, this
/// process and a counter, so neither another cluster nor an earlier run of
/// Veistra can have left files in it.
fn fresh_channel(base: &Path, cluster: &str, n: u64) -> std::io::Result<PathBuf> {
    let safe: String = cluster
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let dir = base
        .join("blender-editor")
        .join(format!("{safe}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Hand Blender's window to the embedder for the calling pane.
fn host(ctx: &Ctx, editor: &Arc<Editor>) {
    let instance = ctx.instance.clone();
    let shown = instance.as_deref().is_some_and(|i| (ctx.shown)(i));
    let (tree, alive) = (editor.clone(), editor.clone());
    ctx.hosts.host(
        ctx.owner.clone(),
        shown,
        HostSpec {
            instance,
            cluster: ctx.cluster.clone(),
            embed: editor.embed.clone(),
            pids: Box::new(move || crate::godot::session::process_tree(tree.pid())),
            alive: Arc::new(move || alive.is_running()),
            on_attached: None,
            on_orphan: Orphan::Release,
        },
    );
}

/// Follow the file Blender has open until it exits, then remove its lock.
/// On a thread of its own, so the lock is right whether or not a pane is
/// polling: Blender keeps running after its pane closes.
fn watch(editor: Arc<Editor>) {
    std::thread::spawn(move || loop {
        if editor.ended().is_some() {
            editor.release();
            return;
        }
        editor.follow();
        std::thread::sleep(FOLLOW_EVERY);
    });
}

fn lock_json(lock: Option<&Lock>) -> Value {
    lock.map_or(
        Value::Null,
        |l| json!({ "file": l.file, "pid": l.pid, "since": l.since }),
    )
}

/// `blender-viewer/editor-state`, polled by the pane: whether Blender runs,
/// where its window is, the file and its lock, and what the boot script
/// reports of the selection and the 3D view.
pub fn state(ctx: &Ctx) -> Value {
    let Some(editor) = ctx.editors.get(&ctx.cluster) else {
        return json!({ "editor": Value::Null });
    };
    if let Some(code) = editor.ended() {
        editor.embed.forget();
        editor.release();
        ctx.editors.remove_if(&ctx.cluster, &editor);
        return json!({
            "editor": Value::Null,
            "ended": { "file": editor.file(), "code": code },
        });
    }
    editor.follow();
    let hello = editor.hello();
    let booted = hello.is_some();
    let view = editor.view();
    json!({
        "editor": {
            "file": editor.file(),
            "opened": editor.opened,
            "pid": editor.pid(),
            "blender": editor.blender,
            "embed": editor.embed.report(),
            "booted": booted,
            "script": hello.as_ref().and_then(|h| h["version"].as_u64()),
            "why": (!booted).then_some(NOT_BOOTED),
            "dirty": view["dirty"].as_bool(),
            "lock": lock_json(editor.lock().as_ref()),
            "conflict": *editor.conflict.lock_or_panic(),
            "view": view,
        },
    })
}

fn call_context(ctx: &Ctx) -> crate::apps::CallContext {
    crate::apps::CallContext {
        cluster_id: Some(ctx.cluster.clone()),
        project: ctx.project.clone(),
    }
}

/// The Veistra tab's half of a poll (#320): `notes.json` brought up to date
/// for the open file, and the tab's events after `eventsSince` as
/// `editor.events`, for the pane to act on.
fn with_tab(ctx: &Ctx, mut state: Value, params: Option<&Value>) -> Value {
    let Some(editor) = running(ctx).filter(|_| state["editor"].is_object()) else {
        return state;
    };
    let since = params
        .and_then(|p| p.get("eventsSince"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let file = editor.file();
    let mut tab = editor.tab.lock_or_panic();
    tab.poll();
    let scope = Scope::Blender {
        file: file.as_deref(),
    };
    if let Err(e) = tab.sync(&call_context(ctx), scope) {
        crate::veistra_log!("Blender editor notes: {e}");
    }
    state["editor"]["events"] = Value::Array(tab.since(since));
    state
}

/// `blender-viewer/editor-ack {n, ok, message}`: the pane's answer to tab
/// event `n`, which the tab shows from the `notes.json` written here.
fn ack(ctx: &Ctx, params: Option<&Value>) -> Result<Value, RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("Blender is not open in this cluster"))?;
    let field = |k: &str| params.and_then(|p| p.get(k));
    let n = field("n")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("editor-ack needs `n`"))?;
    let file = editor.file();
    let mut tab = editor.tab.lock_or_panic();
    tab.ack(Ack {
        n,
        ok: field("ok").and_then(Value::as_bool).unwrap_or(false),
        message: field("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    });
    let scope = Scope::Blender {
        file: file.as_deref(),
    };
    tab.sync(&call_context(ctx), scope).map_err(fail)?;
    Ok(json!({ "acked": n }))
}

fn close(ctx: &Ctx) -> Result<Value, RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("Blender is not open in this cluster"))?;
    let posted = editor.embed.request_close();
    if posted == Ok(true) {
        return Ok(json!({ "closing": true, "via": "window" }));
    }
    if editor.booted() {
        command(ctx, "quit", json!({}))?;
        return Ok(json!({ "closing": true, "via": "blender" }));
    }
    Err(fail(match posted {
        Err(e) => format!("Veistra could not ask Blender to close ({e}). Close it from Blender."),
        Ok(_) => "Veistra cannot reach this Blender's window. Close it from Blender.".to_string(),
    }))
}

/// One round trip on the channel: `cmd.json` written whole and renamed into
/// place, then `res-<id>.json` waited for. The answer is read as it came,
/// since each command answers different fields.
fn exchange(
    dir: &Path,
    id: u64,
    action: &str,
    extra: Value,
    wait: Duration,
) -> Result<Value, String> {
    let mut cmd = json!({ "id": id, "action": action });
    if let (Some(into), Value::Object(more)) = (cmd.as_object_mut(), extra) {
        for (k, v) in more {
            into.entry(k).or_insert(v);
        }
    }
    let tmp = dir.join("cmd.json.tmp");
    std::fs::write(&tmp, cmd.to_string()).map_err(|e| format!("could not write a command: {e}"))?;
    std::fs::rename(&tmp, dir.join("cmd.json"))
        .map_err(|e| format!("could not send a command: {e}"))?;
    let reply = dir.join(format!("res-{id}.json"));
    let started = Instant::now();
    let mut unreadable = None;
    loop {
        if let Ok(text) = std::fs::read_to_string(&reply) {
            // A reply seen half-written parses badly; look again until the wait ends.
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => {
                    let _ = std::fs::remove_file(&reply);
                    return Ok(v);
                }
                Err(e) => unreadable = Some(format!("unreadable reply: {e}")),
            }
        }
        if started.elapsed() > wait {
            return Err(unreadable.unwrap_or_else(|| SILENT.to_string()));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// The picture a reply names, read from the channel folder and removed. A
/// name with a separator in it is ignored, so a reply cannot point outside.
fn picture(dir: &Path, reply: &Value) -> Result<Option<Vec<u8>>, String> {
    let Some(name) = reply["png"].as_str().filter(|n| !n.contains(['/', '\\'])) else {
        return Ok(None);
    };
    let path = dir.join(name);
    let png = std::fs::read(&path).map_err(|e| format!("Blender wrote no image: {e}"))?;
    let _ = std::fs::remove_file(&path);
    Ok(Some(png))
}

/// One command to this cluster's Blender, and its answer when it was `ok`.
fn command(ctx: &Ctx, action: &str, extra: Value) -> Result<Value, RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("Blender is not open in this cluster"))?;
    if !editor.booted() {
        return Err(fail(NOT_BOOTED));
    }
    let id = ctx.editors.next_id();
    let reply = exchange(&editor.channel, id, action, extra, WAIT).map_err(fail)?;
    if reply["ok"].as_bool() != Some(true) {
        let error = reply["error"].as_str().unwrap_or("Blender refused");
        return Err(fail(format!("Blender: {error}")));
    }
    Ok(reply)
}

/// A picture of the 3D view, the view it shows, and the selection, read at
/// one moment: what Send selection hands the agent.
fn capture(ctx: &Ctx) -> Result<Value, RpcError> {
    let editor = running(ctx).ok_or_else(|| fail("Blender is not open in this cluster"))?;
    let mut reply = command(ctx, "capture", json!({}))?;
    let png = picture(&editor.channel, &reply).map_err(fail)?;
    if let Some(png) = png {
        reply["pngBase64"] = Value::String(BASE64.encode(png));
    }
    if let Some(o) = reply.as_object_mut() {
        for k in ["id", "ok", "png", "t"] {
            o.remove(k);
        }
    }
    reply["file"] = json!(editor.file());
    Ok(reply)
}

/// The object under a point of the last capture: `{hit: {object, type,
/// worldPoint} | null}`.
fn pick(ctx: &Ctx, params: Option<&Value>) -> Result<Value, RpcError> {
    let coord = |k: &str| params.and_then(|p| p.get(k)).and_then(Value::as_f64);
    let (Some(x), Some(y)) = (coord("x"), coord("y")) else {
        return Err(invalid("pick needs `x` and `y`"));
    };
    let reply = command(ctx, "pick", json!({ "x": x, "y": y }))?;
    Ok(json!({ "hit": reply["hit"] }))
}

fn select(ctx: &Ctx, params: Option<&Value>) -> Result<Value, RpcError> {
    let names: Vec<&str> = params
        .and_then(|p| p.get("names"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return Err(invalid("select needs `names`, the objects to select"));
    }
    let reply = command(ctx, "select", json!({ "names": names }))?;
    Ok(json!({ "selected": reply["selected"], "active": reply["active"] }))
}

fn viewport_only(ctx: &Ctx, params: Option<&Value>) -> Result<Value, RpcError> {
    let on = params
        .and_then(|p| p.get("on"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let reply = command(ctx, "viewport-only", json!({ "on": on }))?;
    Ok(json!({ "viewportOnly": reply["fullscreen"] }))
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
