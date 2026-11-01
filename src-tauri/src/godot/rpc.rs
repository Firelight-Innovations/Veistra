//! The methods Play and the Godot Viewer answer, over the bridge.
//!
//! [`Ctx`] carries everything a method needs - which cluster asked, its
//! environment root, whether that environment is the read-only main checkout,
//! and how to probe for the engine - so the handlers are plain functions the
//! tests drive with a fake `godot` and a tempdir, and `apps::play` /
//! `apps::godot_viewer` only have to build one from the live application.
//!
//! What is allowed on the read-only main checkout (#163): **running and viewing
//! are**, because they read the project. Installing the capture addon is not,
//! and neither is launching the editor - both are refused there, and both are
//! also in `apps::WRITE_METHODS` so the refusal happens before a handler runs.
//! Two things still touch a main checkout that Veistra does not control: Godot
//! itself keeps an import cache in `<project>/.godot/` whenever it loads a
//! project, and that folder is gitignored by every Godot template. The viewer's
//! own cache and a run's channel go under the app data and temp directories
//! instead.

use super::addon;
use super::detect::{self, Found, GodotProject, Probe, Resolution};
use super::embed::Owner;
use super::preview;
use super::runner::{RunSpec, Runner, WindowArgs};
use super::scene::{self, Refresh};
use super::session::Session;
use super::{scratch_root, Godot};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// Code for a write refused on main; the same value `apps::READ_ONLY` uses.
const READ_ONLY: i32 = -32003;

pub type Check<'a> = &'a dyn Fn(&Path) -> Result<String, String>;

/// Where a Veistra window is, by label (`None` for the one the pane is in
/// when it has not said): what [`super::embed`] places a game against. Shared
/// with the thread that waits for the game's window, hence `Arc`.
pub type OwnerFn = std::sync::Arc<dyn Fn(Option<&str>) -> Option<Owner> + Send + Sync>;

pub struct Ctx<'a> {
    pub godot: &'a Godot,
    /// The cluster id; runs and viewer jobs are kept per cluster.
    pub key: String,
    /// The environment's folder, `None` before a project is open.
    pub root: Option<PathBuf>,
    pub read_only: bool,
    pub probe: Probe,
    pub check: Check<'a>,
    /// Where a read-only environment's viewer cache goes instead of its own
    /// `.veistra/`, which main may not be written to.
    pub cache_root: PathBuf,
    pub scratch: PathBuf,
    pub owner: OwnerFn,
    /// Lets the page load files under this folder (a take's video) through
    /// the asset protocol.
    pub allow_asset: &'a dyn Fn(&Path),
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    project: Option<String>,
    scene: Option<String>,
    since: u64,
    refresh: bool,
    render: bool,
    paused: bool,
    /// `play/state`: the last key event the pane has acted on.
    key_since: u64,
    /// Who is asking, `"human"` or `"agent"`. Required by the preview.
    actor: Option<String>,
    /// Export again even if the cached glb is current, or a failure is remembered.
    force: bool,
    /// `godot-viewer/markup-save`: the picture the markup was drawn on, base64.
    png_base64: Option<String>,
    /// `godot-viewer/markup-save`: the markup JSON as text.
    json: Option<String>,
}

fn params(raw: Option<&Value>) -> Result<Params, RpcError> {
    match raw {
        None | Some(Value::Null) => Ok(Params::default()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}"))),
    }
}

pub(super) fn fail(message: impl Into<String>) -> RpcError {
    RpcError::new(INTERNAL_ERROR, message.into())
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|e| fail(format!("could not serialize the answer: {e}")))
}

/// `godot/*` methods both apps answer. `None` when `method` is not one of them.
pub fn common(ctx: &Ctx, method: &str, raw: Option<&Value>) -> Option<Result<Value, RpcError>> {
    Some(match method {
        "godot/status" => params(raw).and_then(|p| status(ctx, &p)),
        "godot/open-editor" => params(raw).and_then(|p| open_editor(ctx, &p)),
        _ => return None,
    })
}

/// Play's methods.
pub fn play(ctx: &Ctx, method: &str, raw: Option<&Value>) -> Option<Result<Value, RpcError>> {
    if let Some(answer) = common(ctx, method, raw) {
        return Some(answer);
    }
    if let Some(answer) = super::live::call(ctx, method, raw) {
        return Some(answer);
    }
    Some(params(raw).and_then(|p| match method {
        "play/state" => Ok(play_state_since(ctx, p.since, p.key_since)),
        "play/run" => play_run(ctx, &p),
        "play/stop" => stop_run(ctx).map(|_| play_state(ctx, 0)),
        "play/restart" => play_restart(ctx, &p),
        "play/pause" => play_pause(ctx, &p),
        "play/capture" => play_capture(ctx),
        "play/addon-status" => addon_status(ctx, &p),
        "play/addon-install" => addon_change(ctx, &p, true),
        "play/addon-remove" => addon_change(ctx, &p, false),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }))
}

/// The Godot Viewer's methods.
pub fn viewer(ctx: &Ctx, method: &str, raw: Option<&Value>) -> Option<Result<Value, RpcError>> {
    if let Some(answer) = common(ctx, method, raw) {
        return Some(answer);
    }
    Some(params(raw).and_then(|p| match method {
        "godot-viewer/state" => viewer_state(ctx, &p),
        "godot-viewer/refresh" => viewer_refresh(ctx, &p),
        "godot-viewer/image" => viewer_image(ctx, &p),
        "godot-viewer/markup-save" => markup_save(ctx, &p),
        "godot-viewer/markup" => markup_load(ctx, &p),
        "godot/preview-glb" => preview_glb(ctx, &p),
        "godot/preview-glb-bytes" => preview_glb_bytes(ctx, &p),
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }))
}

// --- shared lookups ---------------------------------------------------------

fn root<'a>(ctx: &'a Ctx) -> Result<&'a Path, RpcError> {
    ctx.root
        .as_deref()
        .ok_or_else(|| fail("this cluster has no environment yet - open a project first"))
}

fn projects(ctx: &Ctx) -> Result<Vec<GodotProject>, RpcError> {
    Ok(detect::find_projects(root(ctx)?))
}

fn pick_project(ctx: &Ctx, p: &Params) -> Result<GodotProject, RpcError> {
    pick_project_for(ctx, p.project.as_deref())
}

/// The Godot project `rel` names, or the environment's first.
pub(super) fn pick_project_for(ctx: &Ctx, rel: Option<&str>) -> Result<GodotProject, RpcError> {
    let all = projects(ctx)?;
    match rel {
        Some(rel) => all
            .into_iter()
            .find(|g| g.rel == rel)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no Godot project at `{rel}`"))),
        None => all.into_iter().next().ok_or_else(|| {
            fail("no project.godot found in this environment (looked four folders deep)")
        }),
    }
}

fn engine(ctx: &Ctx, refresh: bool) -> Resolution {
    ctx.godot.executable(&ctx.probe, refresh, ctx.check)
}

fn require_engine(ctx: &Ctx) -> Result<Found, RpcError> {
    let resolution = engine(ctx, false);
    resolution.found.ok_or_else(|| {
        let why = resolution.problems.first().cloned().unwrap_or_default();
        fail(format!(
            "Godot 4 was not found. Set its path in Settings > Godot, or put it on PATH. {why}"
        ))
    })
}

// --- godot/status and Open in Godot ----------------------------------------

fn status(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let resolution = engine(ctx, p.refresh);
    let list = match ctx.root.as_deref() {
        Some(root) => detect::find_projects(root),
        None => Vec::new(),
    };
    let mut described = Vec::new();
    for project in &list {
        let mut v = to_value(project)?;
        v["addon"] = to_value(&addon::status(&project.dir))?;
        described.push(v);
    }
    Ok(json!({
        "environment": {
            "root": ctx.root.as_ref().map(|r| r.display().to_string()),
            "readOnly": ctx.read_only,
        },
        "executable": {
            "found": to_value(&resolution.found)?,
            "problems": resolution.problems,
            "setting": ctx.probe.setting,
        },
        "projects": described,
    }))
}

/// `godot --editor --path <project>`
pub fn editor_args(project: &Path) -> Vec<String> {
    vec![
        "--editor".to_string(),
        "--path".to_string(),
        project.display().to_string(),
    ]
}

fn open_editor(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    if ctx.read_only {
        return Err(RpcError::new(
            READ_ONLY,
            "This is the main checkout, which is read-only in Veistra - the editor could change it. \
             Open a worktree and launch Godot there.",
        ));
    }
    let found = require_engine(ctx)?;
    let project = pick_project(ctx, p)?;
    if project.engine_major < 4 {
        return Err(fail(format!(
            "`{}` is a Godot 3 project; Veistra drives Godot 4.x",
            project.name
        )));
    }
    let pid = spawn_detached(&found.path, &editor_args(&project.dir), &project.dir)
        .map_err(|e| fail(format!("could not start Godot: {e}")))?;
    Ok(json!({ "pid": pid, "project": project.rel, "godot": found.version }))
}

/// Start a program that outlives Veistra: its own process group, no console, no
/// pipes. The editor is the person's to close; Veistra does not supervise it.
fn spawn_detached(program: &Path, args: &[String], cwd: &Path) -> std::io::Result<u32> {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    // Reaps the child if it exits while Veistra is still running.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

// --- Play -------------------------------------------------------------------

fn play_state(ctx: &Ctx, since: u64) -> Value {
    play_state_since(ctx, since, u64::MAX)
}

/// The run, the log after `since`, and the session's keys after `key_since`.
fn play_state_since(ctx: &Ctx, since: u64, key_since: u64) -> Value {
    let live = super::live::state(ctx, key_since);
    match ctx.godot.runner.get(&ctx.key) {
        Some(run) => json!({ "run": run.info(), "log": run.log_since(since), "live": live }),
        None => json!({ "run": Value::Null, "log": Value::Null, "live": live }),
    }
}

/// Stop: the take first, so its last frames are of a live window and the
/// review can open the moment this answers, then the game.
fn stop_run(ctx: &Ctx) -> Result<bool, RpcError> {
    if let (Some(run), Some(session)) =
        (ctx.godot.runner.get(&ctx.key), ctx.godot.session(&ctx.key))
    {
        if session.run_id == run.id {
            session.finish_take(&run);
        }
    }
    ctx.godot.runner.stop(&ctx.key).map_err(fail)
}

fn valid_scene(scene: &str) -> bool {
    scene.starts_with("res://")
        && (scene.ends_with(".tscn") || scene.ends_with(".scn"))
        && !scene.contains("..")
}

fn channel_for(ctx: &Ctx, project: &GodotProject) -> Result<Option<PathBuf>, RpcError> {
    if addon::status(&project.dir) != addon::Installed::Yes {
        return Ok(None);
    }
    let dir = super::runner::channel_dir(
        &ctx.scratch.join("play"),
        &ctx.key,
        ctx.godot.runner.peek_next_id(),
    );
    std::fs::create_dir_all(&dir)
        .map_err(|e| fail(format!("could not create {}: {e}", dir.display())))?;
    Ok(Some(dir))
}

fn start_run(ctx: &Ctx, project: &GodotProject, scene: Option<String>) -> Result<Value, RpcError> {
    let found = require_engine(ctx)?;
    if project.engine_major < 4 {
        return Err(fail(format!(
            "`{}` is a Godot 3 project; Veistra drives Godot 4.x",
            project.name
        )));
    }
    if let Some(s) = &scene {
        if !valid_scene(s) {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("`{s}` is not a res:// scene"),
            ));
        }
    } else if project.main_scene.is_none() {
        return Err(fail(
            "This project has no main scene. Set one in Project Settings > Application > Run, or choose a scene to play.",
        ));
    }
    let pane = ctx.godot.pane(&ctx.key);
    let owner = (ctx.owner)(pane.as_ref().and_then(|p| p.window.as_deref()));
    let window = super::embed::SUPPORTED.then(|| {
        let scale = owner.map_or(1.0, |o| o.scale);
        let (width, height) = super::embed::launch_size(pane.as_ref().map(|p| p.rect), scale);
        let (x, y) = WindowArgs::OFF_SCREEN;
        WindowArgs {
            width,
            height,
            x,
            y,
        }
    });
    let channel = channel_for(ctx, project)?;
    let spec = RunSpec {
        program: found.for_logging().to_path_buf(),
        project: project.dir.clone(),
        scene,
        channel: channel.clone(),
        window,
    };
    let run = ctx.godot.runner.start(&ctx.key, spec).map_err(fail)?;
    let plan = channel
        .is_some()
        .then(|| super::live::plan_for(ctx, &project.dir, &project.rel, &found.version))
        .flatten();
    let session = std::sync::Arc::new(Session::new(run.id, channel, plan));
    if let Some(pane) = &pane {
        session.embed.set_rect(pane.rect, pane.visible, None);
    }
    ctx.godot.set_session(&ctx.key, session.clone());
    {
        let (session, run) = (session.clone(), run.clone());
        run.clone()
            .on_exit(Box::new(move || session.finish_take(&run)));
    }
    let owner_fn = ctx.owner.clone();
    let label = pane.and_then(|p| p.window);
    std::thread::spawn(move || {
        super::session::attach(&session, &run, &|| owner_fn(label.as_deref()));
    });
    Ok(play_state(ctx, 0))
}

fn play_run(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    start_run(ctx, &project, p.scene.clone())
}

/// Stop, then start again with the same project and scene. The channel is made
/// fresh, so a capture addon installed since the last run is picked up.
fn play_restart(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let previous = ctx.godot.runner.get(&ctx.key).map(|r| r.spec.clone());
    stop_run(ctx)?;
    let project = match &previous {
        Some(spec) => projects(ctx)?
            .into_iter()
            .find(|g| g.dir == spec.project)
            .ok_or_else(|| fail("the project that was running is no longer in this environment"))?,
        None => pick_project(ctx, p)?,
    };
    let scene = previous.and_then(|s| s.scene).or_else(|| p.scene.clone());
    start_run(ctx, &project, scene)
}

fn live_channel(
    runner: &Runner,
    key: &str,
) -> Result<(std::sync::Arc<super::runner::Run>, PathBuf), RpcError> {
    let run = runner
        .get(key)
        .filter(|r| r.is_running())
        .ok_or_else(|| fail("no game is running"))?;
    let channel = run.spec.channel.clone().ok_or_else(|| {
        fail("This game was started without the Veistra capture addon. Enable capture in Play, then restart the game.")
    })?;
    Ok((run, channel))
}

fn play_pause(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let (run, channel) = live_channel(&ctx.godot.runner, &ctx.key)?;
    let action = if p.paused { "pause" } else { "resume" };
    let reply = addon::send(
        &channel,
        ctx.godot.next_command_id(),
        action,
        Duration::from_secs(3),
    )
    .map_err(fail)?;
    if !reply.ok {
        return Err(fail(
            reply
                .error
                .unwrap_or_else(|| format!("the game refused to {action}")),
        ));
    }
    run.paused
        .store(reply.paused, std::sync::atomic::Ordering::SeqCst);
    Ok(play_state(ctx, u64::MAX))
}

fn play_capture(ctx: &Ctx) -> Result<Value, RpcError> {
    let (run, channel) = live_channel(&ctx.godot.runner, &ctx.key)?;
    let reply = addon::send(
        &channel,
        ctx.godot.next_command_id(),
        "capture",
        Duration::from_secs(5),
    )
    .map_err(fail)?;
    if !reply.ok {
        return Err(fail(reply.error.unwrap_or_else(|| {
            "the game could not capture a frame".to_string()
        })));
    }
    let png = reply
        .png
        .ok_or_else(|| fail("the game answered without an image"))?;
    let scene = if reply.scene.is_empty() {
        run.spec.scene.clone().unwrap_or_default()
    } else {
        reply.scene
    };
    Ok(json!({
        "png": BASE64.encode(png),
        "width": reply.size.map(|s| s.0),
        "height": reply.size.map(|s| s.1),
        "time": reply.time,
        "scene": scene,
    }))
}

fn addon_status(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let running_without = ctx
        .godot
        .runner
        .get(&ctx.key)
        .is_some_and(|r| r.is_running() && r.spec.channel.is_none());
    Ok(json!({
        "addon": to_value(&addon::status(&project.dir))?,
        "needsRestart": running_without && addon::status(&project.dir) == addon::Installed::Yes,
        "readOnly": ctx.read_only,
    }))
}

fn addon_change(ctx: &Ctx, p: &Params, install: bool) -> Result<Value, RpcError> {
    if ctx.read_only {
        return Err(RpcError::new(
            READ_ONLY,
            "This is the main checkout, which is read-only in Veistra, so the capture addon cannot be \
             installed here. Play still runs; make a worktree to capture frames.",
        ));
    }
    let project = pick_project(ctx, p)?;
    if install {
        addon::install(&project.dir).map_err(fail)?;
    } else {
        addon::remove(&project.dir).map_err(fail)?;
    }
    addon_status(ctx, p)
}

// --- Godot Viewer -----------------------------------------------------------

fn slug(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn cache_dir(ctx: &Ctx, project: &GodotProject) -> Result<PathBuf, RpcError> {
    let root = root(ctx)?;
    let leaf = slug(&project.rel);
    Ok(if ctx.read_only {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(root.to_string_lossy().as_bytes());
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        ctx.cache_root.join("godot-viewer").join(hex).join(leaf)
    } else {
        root.join(".veistra").join("godot-viewer").join(leaf)
    })
}

fn chosen_scene(project: &GodotProject, scenes: &[String], asked: Option<&str>) -> Option<String> {
    asked
        .map(str::to_string)
        .or_else(|| project.main_scene_path.clone())
        .or_else(|| scenes.first().cloned())
}

fn viewer_state(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let scenes = detect::scenes(&project.dir);
    let scene = chosen_scene(&project, &scenes, p.scene.as_deref());
    let cache = cache_dir(ctx, &project)?;
    let cached = scene.as_deref().and_then(|s| scene::read_cached(&cache, s));
    let found = engine(ctx, false).found;

    Ok(json!({
        "project": project.rel,
        "scenes": scenes,
        "scene": scene,
        "renderedAt": cached.as_ref().map(|c| c.rendered_at),
        "scenePath": cached.as_ref().map(|c| c.scene_path.clone()),
        "nodes": cached.as_ref().map(|c| to_value(&c.nodes)).transpose()?.unwrap_or_else(|| json!([])),
        "source": cached.as_ref().map(|c| to_value(&c.source)).transpose()?,
        "godot": cached.as_ref().and_then(|c| c.godot.clone()),
        "note": cached.as_ref().and_then(|c| c.note.clone()),
        "imageAt": cached.as_ref().and_then(|c| c.image_at),
        "job": ctx.godot.jobs.get(&ctx.key),
        "engineFound": found.is_some(),
    }))
}

fn viewer_refresh(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let scenes = detect::scenes(&project.dir);
    let scene = chosen_scene(&project, &scenes, p.scene.as_deref())
        .ok_or_else(|| fail("this project has no .tscn scenes to read"))?;
    if !valid_scene(&scene)
        || !project
            .dir
            .join(scene.trim_start_matches("res://"))
            .is_file()
    {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{scene}` is not a scene in this project"),
        ));
    }
    let job = ctx.godot.jobs.begin(&ctx.key, &scene).map_err(fail)?;
    let opts = Refresh {
        cache: cache_dir(ctx, &project)?,
        scratch: ctx.scratch.join("viewer").join(slug(&ctx.key)),
        godot: engine(ctx, false).found,
        project: project.dir,
        scene,
        render: p.render,
        limits: scene::Limits::default(),
    };
    std::thread::spawn(move || scene::refresh(&job, &opts));
    Ok(json!({ "started": true }))
}

fn viewer_image(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let scenes = detect::scenes(&project.dir);
    let Some(scene) = chosen_scene(&project, &scenes, p.scene.as_deref()) else {
        return Ok(json!({ "png": Value::Null }));
    };
    let bytes = scene::read_image(&cache_dir(ctx, &project)?, &scene);
    Ok(json!({ "png": bytes.map(|b| BASE64.encode(b)) }))
}

/// Keeps the markup picture and JSON for a scene so the person can look at them
/// again, whether or not they were ever sent. One pair per scene, replaced each
/// time. Kept beside the scene's other cache, not in the context store, so it
/// does not show up in a strip as something already sent.
fn markup_save(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let scene = p
        .scene
        .as_deref()
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "markup-save needs a scene"))?;
    let png = BASE64
        .decode(p.png_base64.as_deref().unwrap_or(""))
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("pngBase64 is not base64: {e}")))?;
    let json = p
        .json
        .as_deref()
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "markup-save needs the json"))?;
    let saved_at =
        scene::write_markup(&cache_dir(ctx, &project)?, scene, &png, json).map_err(fail)?;
    Ok(json!({ "savedAt": saved_at }))
}

fn markup_load(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let Some(scene) = chosen_scene(&project, &detect::scenes(&project.dir), p.scene.as_deref())
    else {
        return Ok(Value::Null);
    };
    Ok(
        match scene::read_markup(&cache_dir(ctx, &project)?, &scene) {
            Some(m) => json!({
                "png": BASE64.encode(m.png),
                "json": m.json,
                "savedAt": m.saved_at,
            }),
            None => Value::Null,
        },
    )
}

// --- the 3D preview ---------------------------------------------------------

/// `human` or `agent`; `system` is never accepted and a missing actor is an
/// error, the same rule Schematify's operations follow.
fn actor(p: &Params) -> Result<&'static str, RpcError> {
    match p.actor.as_deref() {
        Some("human") => Ok("human"),
        Some("agent") => Ok("agent"),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("actor must be \"human\" or \"agent\", got {other:?}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "actor is required")),
    }
}

/// Where a project's previews live: `<root>/.veistra/preview/godot/`, or under
/// the app data folder for the read-only main checkout, which is never written.
fn preview_dir(ctx: &Ctx) -> Result<PathBuf, RpcError> {
    let root = root(ctx)?;
    Ok(if ctx.read_only {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(root.to_string_lossy().as_bytes());
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        ctx.cache_root.join("preview").join("godot").join(hex)
    } else {
        root.join(".veistra").join("preview").join("godot")
    })
}

/// The scene a preview call is about, checked to be one this project has.
fn preview_scene(project: &GodotProject, p: &Params) -> Result<String, RpcError> {
    let scenes = detect::scenes(&project.dir);
    let scene = chosen_scene(project, &scenes, p.scene.as_deref())
        .ok_or_else(|| fail("this project has no .tscn scenes to preview"))?;
    if !valid_scene(&scene)
        || !project
            .dir
            .join(scene.trim_start_matches("res://"))
            .is_file()
    {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{scene}` is not a scene in this project"),
        ));
    }
    Ok(scene)
}

fn preview_reply(
    status: &str,
    scene: &str,
    dir: &Path,
    slug: &str,
    preview: Option<&preview::Preview>,
    job: Option<&scene::Job>,
    cached: bool,
) -> Result<Value, RpcError> {
    Ok(json!({
        "status": status,
        "scene": scene,
        "cached": cached,
        "path": preview.map(|_| preview::glb_path(dir, slug).display().to_string()),
        "exportedAt": preview.map(|p| p.exported_at),
        "godot": preview.map(|p| p.godot.clone()),
        "bytes": preview.map(|p| p.glb_bytes),
        "nodeMap": preview.map(|p| to_value(&p.node_map)).transpose()?,
        "phase": job.filter(|j| j.running).map(|j| j.phase.clone()),
        "error": job.filter(|j| !j.running).and_then(|j| j.error.clone()),
        "output": job.map(|j| j.output.clone()).unwrap_or_default(),
    }))
}

/// `godot/preview-glb`: the scene as a glTF the viewer can orbit.
///
/// Answers at once, and is meant to be polled. `ready` carries the glb's path
/// and the node map; `running` means an export is under way; `failed` carries
/// why. The glb is exported only when nothing current is cached - the key
/// covers the scene, what it instances and the engine - and `force` exports
/// again regardless, which is how a failure is retried.
fn preview_glb(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    actor(p)?;
    let project = pick_project(ctx, p)?;
    let scene = preview_scene(&project, p)?;
    let godot = require_engine(ctx)?;
    let dir = preview_dir(ctx)?;
    let stem = preview::slug(&project.rel, &scene);
    let key = preview::cache_key(&project.dir, &scene, &godot.version).map_err(fail)?;
    let job_key = format!("{}#preview", ctx.key);

    if !p.force {
        if let Some(hit) = preview::read_fresh(&dir, &stem, &key) {
            return preview_reply("ready", &scene, &dir, &stem, Some(&hit), None, true);
        }
    }
    if let Some(job) = ctx.godot.jobs.get(&job_key) {
        if job.running {
            return preview_reply("running", &job.scene, &dir, &stem, None, Some(&job), false);
        }
        if !p.force && preview::failure(&job, &scene).is_some() {
            return preview_reply("failed", &scene, &dir, &stem, None, Some(&job), false);
        }
    }

    let job = ctx.godot.jobs.begin(&job_key, &scene).map_err(fail)?;
    let opts = preview::Export {
        project: project.dir,
        scene: scene.clone(),
        dir: dir.clone(),
        slug: stem.clone(),
        key,
        godot,
        scratch: ctx.scratch.join("preview").join(slug(&ctx.key)),
        limits: scene::Limits::default(),
    };
    let started = preview::snapshot(&job);
    std::thread::spawn(move || preview::run(&job, &opts));
    preview_reply("running", &scene, &dir, &stem, None, Some(&started), false)
}

/// `godot/preview-glb-bytes`: the exported glb, base64, for the viewer to hand
/// to three.js. Reads only the file this scene's export wrote.
fn preview_glb_bytes(ctx: &Ctx, p: &Params) -> Result<Value, RpcError> {
    let project = pick_project(ctx, p)?;
    let scene = preview_scene(&project, p)?;
    let dir = preview_dir(ctx)?;
    let bytes = preview::read_glb(&dir, &preview::slug(&project.rel, &scene)).map_err(fail)?;
    Ok(json!({ "base64": BASE64.encode(&bytes), "size": bytes.len() }))
}

/// Run `f` with a [`Ctx`] built from the live application: the cluster's
/// environment, the `godot.executablePath` setting, and the real machine probe.
pub fn with_live<R>(
    app: &tauri::AppHandle,
    context: &crate::apps::CallContext,
    f: impl FnOnce(&Ctx) -> R,
) -> R {
    use tauri::Manager;
    let key = context.cluster_id.clone().unwrap_or_default();
    let read_only = context.cluster_id.as_deref().is_some_and(|cluster| {
        app.state::<crate::shell_state::ShellState>()
            .cluster_write_environment(cluster)
            .is_some_and(|env| env.is_main())
    });
    let setting = crate::settings::text(app, super::KEY_EXECUTABLE_PATH);
    let cache_root = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| scratch_root());
    let check = |p: &Path| detect::ask_version(p, Duration::from_secs(10));
    let godot = app.state::<Godot>();
    let handle = app.clone();
    let owner: OwnerFn = std::sync::Arc::new(move |label| owner_of(&handle, label));
    let allow_asset = |dir: &Path| {
        if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
            crate::veistra_log!("play: could not serve {}: {e}", dir.display());
        }
    };
    let ctx = Ctx {
        godot: &godot,
        key,
        root: context.project.clone(),
        read_only,
        probe: Probe::from_system(&setting),
        check: &check,
        cache_root,
        scratch: scratch_root(),
        owner,
        allow_asset: &allow_asset,
    };
    f(&ctx)
}

/// The Veistra window `label` names (`main` when none), as the embedder
/// needs it: its handle, where its WebView starts on the screen, and its
/// scale. `None` off Windows, or for a window that is gone.
pub fn owner_of(app: &tauri::AppHandle, label: Option<&str>) -> Option<Owner> {
    use tauri::Manager;
    let window = app.get_webview_window(label.unwrap_or("main"))?;
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().ok()?;
    #[cfg(windows)]
    let hwnd = window.hwnd().ok()?.0 as isize;
    #[cfg(not(windows))]
    let hwnd = 0;
    super::embed::SUPPORTED.then_some(Owner {
        hwnd,
        origin: (origin.x, origin.y),
        scale,
    })
}

/// Put every embedded game back over its pane: the Veistra window moved, and
/// an owned window does not move with its owner.
pub fn reposition_all(app: &tauri::AppHandle) {
    use tauri::Manager;
    let godot = app.state::<Godot>();
    for (key, session) in godot.sessions() {
        let label = godot.pane(&key).and_then(|p| p.window);
        if let Some(owner) = owner_of(app, label.as_deref()) {
            session.embed.reapply(&owner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::runner::RunState;
    use super::super::testing::fake_godot;
    use super::*;
    use tempfile::TempDir;

    struct World {
        _dir: TempDir,
        root: PathBuf,
        godot: Godot,
        exe: PathBuf,
        scratch: PathBuf,
    }

    fn world(linger: bool) -> World {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("env");
        std::fs::create_dir_all(root.join("game")).unwrap();
        std::fs::write(
            root.join("game/project.godot"),
            "config_version=5\n\n[application]\n\nconfig/name=\"Game\"\nrun/main_scene=\"res://main.tscn\"\n",
        )
        .unwrap();
        std::fs::write(
            root.join("game/main.tscn"),
            "[gd_scene format=3]\n\n[node name=\"World\" type=\"Node3D\"]\n",
        )
        .unwrap();
        let exe = fake_godot(dir.path(), linger);
        let scratch = dir.path().join("scratch");
        World {
            _dir: dir,
            root,
            godot: Godot::default(),
            exe,
            scratch,
        }
    }

    fn ctx<'a>(w: &'a World, read_only: bool, check: Check<'a>) -> Ctx<'a> {
        Ctx {
            godot: &w.godot,
            key: "c1".to_string(),
            root: Some(w.root.clone()),
            read_only,
            probe: Probe {
                setting: w.exe.display().to_string(),
                ..Probe::default()
            },
            check,
            cache_root: w.scratch.join("appdata"),
            scratch: w.scratch.clone(),
            owner: std::sync::Arc::new(|_| None),
            allow_asset: &|_| {},
        }
    }

    fn real_check(p: &Path) -> Result<String, String> {
        detect::ask_version(p, Duration::from_secs(10))
    }

    fn call(c: &Ctx, method: &str, params: Value) -> Result<Value, RpcError> {
        let answer = if method.starts_with("godot-viewer/") || method.starts_with("godot/preview") {
            viewer(c, method, Some(&params))
        } else {
            play(c, method, Some(&params))
        };
        answer.expect("a method these modules answer")
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out waiting for {what}");
    }

    #[test]
    fn status_finds_the_fake_engine_and_the_project() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        let s = call(&c, "godot/status", json!({})).unwrap();
        assert_eq!(s["executable"]["found"]["version"], "4.3.stable.fake");
        assert_eq!(s["projects"][0]["name"], "Game");
        assert_eq!(s["projects"][0]["rel"], "game");
        assert_eq!(s["projects"][0]["addon"], "no");
        assert_eq!(s["environment"]["readOnly"], false);
    }

    #[test]
    fn status_without_godot_says_why_and_still_lists_projects() {
        let w = world(false);
        let mut c = ctx(&w, false, &real_check);
        c.probe.setting = w.root.join("missing").display().to_string();
        let s = call(&c, "godot/status", json!({})).unwrap();
        assert_eq!(s["executable"]["found"], Value::Null);
        assert!(s["executable"]["problems"][0]
            .as_str()
            .unwrap()
            .contains("does not exist"));
        assert_eq!(s["projects"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_cluster_with_no_environment_answers_status_and_refuses_the_rest_by_name() {
        let w = world(false);
        let mut c = ctx(&w, false, &real_check);
        c.root = None;
        assert_eq!(
            call(&c, "godot/status", json!({})).unwrap()["projects"],
            json!([])
        );
        assert!(call(&c, "play/run", json!({}))
            .unwrap_err()
            .message
            .contains("open a project"));
    }

    #[test]
    fn play_runs_the_project_streams_its_log_and_stops_cleanly() {
        let w = world(true);
        let c = ctx(&w, false, &real_check);
        let started = call(&c, "play/run", json!({})).unwrap();
        assert_eq!(started["run"]["state"]["kind"], "running");

        wait_until("the log", || {
            call(&c, "play/state", json!({ "since": 0 })).unwrap()["log"]["lines"]
                .as_array()
                .is_some_and(|l| l.len() >= 5)
        });
        let state = call(&c, "play/state", json!({ "since": 0 })).unwrap();
        let lines = state["log"]["lines"].as_array().unwrap();
        assert!(lines
            .iter()
            .any(|l| l["level"] == "error" && l["text"].as_str().unwrap().contains("broke")));
        assert!(lines
            .iter()
            .any(|l| l["text"].as_str().unwrap().contains("--path")));

        let err = call(&c, "play/run", json!({})).unwrap_err();
        assert!(err.message.contains("already running"));

        let stopped = call(&c, "play/stop", json!({})).unwrap();
        assert_eq!(stopped["run"]["state"]["kind"], "stopped");
    }

    #[test]
    fn restart_stops_and_starts_the_same_scene_again() {
        let w = world(true);
        let c = ctx(&w, false, &real_check);
        let first = call(&c, "play/run", json!({ "scene": "res://main.tscn" })).unwrap();
        let second = call(&c, "play/restart", json!({})).unwrap();
        assert_ne!(first["run"]["id"], second["run"]["id"]);
        assert_eq!(second["run"]["scene"], "res://main.tscn");
        assert_eq!(second["run"]["state"]["kind"], "running");
        w.godot.shutdown();
    }

    #[test]
    fn a_project_with_no_main_scene_asks_for_one_and_a_bad_scene_is_refused() {
        let w = world(false);
        std::fs::write(
            w.root.join("game/project.godot"),
            "config_version=5\n[application]\nconfig/name=\"G\"\n",
        )
        .unwrap();
        let c = ctx(&w, false, &real_check);
        assert!(call(&c, "play/run", json!({}))
            .unwrap_err()
            .message
            .contains("no main scene"));
        assert_eq!(
            call(&c, "play/run", json!({ "scene": "../evil" }))
                .unwrap_err()
                .code,
            INVALID_PARAMS
        );
        assert!(call(&c, "play/run", json!({ "scene": "res://main.tscn" })).is_ok());
        w.godot.shutdown();
    }

    #[test]
    fn a_godot_3_project_is_refused_before_anything_starts() {
        let w = world(false);
        std::fs::write(w.root.join("game/project.godot"), "config_version=4\n").unwrap();
        let c = ctx(&w, false, &real_check);
        assert!(call(&c, "play/run", json!({ "scene": "res://main.tscn" }))
            .unwrap_err()
            .message
            .contains("Godot 3"));
        assert!(w.godot.runner.get("c1").is_none());
    }

    #[test]
    fn running_is_allowed_on_main_but_the_editor_and_the_addon_are_not() {
        let w = world(false);
        let c = ctx(&w, true, &real_check);
        assert!(
            call(&c, "play/run", json!({})).is_ok(),
            "running reads the project"
        );
        for method in [
            "godot/open-editor",
            "play/addon-install",
            "play/addon-remove",
        ] {
            let err = call(&c, method, json!({})).unwrap_err();
            assert_eq!(err.code, READ_ONLY, "{method}");
        }
        assert!(
            !w.root.join("game/addons").exists(),
            "nothing was written into main"
        );
        w.godot.shutdown();
    }

    #[test]
    fn the_editor_launches_detached_and_reports_a_pid() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        let opened = call(&c, "godot/open-editor", json!({})).unwrap();
        assert!(opened["pid"].as_u64().unwrap() > 0);
        assert_eq!(opened["project"], "game");
        assert_eq!(
            editor_args(Path::new("/p")),
            vec!["--editor", "--path", "/p"]
        );
    }

    #[test]
    fn capture_needs_the_addon_and_then_round_trips_through_the_running_game() {
        let w = world(true);
        let c = ctx(&w, false, &real_check);

        call(&c, "play/run", json!({})).unwrap();
        let err = call(&c, "play/capture", json!({})).unwrap_err();
        assert!(err.message.contains("without the Veistra capture addon"));

        let after = call(&c, "play/addon-install", json!({})).unwrap();
        assert_eq!(after["addon"], "yes");
        assert_eq!(
            after["needsRestart"], true,
            "the running game predates the install"
        );
        assert!(w
            .root
            .join("game/addons/veistra/veistra_capture.gd")
            .is_file());

        call(&c, "play/restart", json!({})).unwrap();
        let channel = w
            .godot
            .runner
            .get("c1")
            .unwrap()
            .spec
            .channel
            .clone()
            .expect("a channel now exists");
        assert!(
            !channel.starts_with(&w.root),
            "the channel is outside the project"
        );

        let game = channel.clone();
        let responder = std::thread::spawn(move || {
            for _ in 0..400 {
                if let Ok(text) = std::fs::read_to_string(game.join("cmd.json")) {
                    let cmd: Value = serde_json::from_str(&text).unwrap();
                    let id = cmd["id"].as_u64().unwrap();
                    std::fs::remove_file(game.join("cmd.json")).unwrap();
                    std::fs::write(game.join(format!("cap-{id}.png")), b"PNGDATA").unwrap();
                    std::fs::write(
                        game.join(format!("res-{id}.json")),
                        json!({"id": id, "ok": true, "png": format!("cap-{id}.png"), "width": 640, "height": 360,
                               "time": 3.25, "scene": "res://main.tscn", "paused": false})
                        .to_string(),
                    )
                    .unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let shot = call(&c, "play/capture", json!({})).unwrap();
        responder.join().unwrap();
        assert_eq!(shot["png"], BASE64.encode(b"PNGDATA"));
        assert_eq!(shot["width"], 640);
        assert_eq!(shot["time"], 3.25);
        assert_eq!(shot["scene"], "res://main.tscn");

        call(&c, "play/addon-remove", json!({})).unwrap();
        assert!(!w.root.join("game/addons").exists());
        w.godot.shutdown();
    }

    #[test]
    fn a_game_that_exits_by_itself_reports_its_code_not_stopped() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        call(&c, "play/run", json!({})).unwrap();
        wait_until("exit", || {
            matches!(
                w.godot.runner.get("c1").unwrap().state(),
                RunState::Exited { .. }
            )
        });
        let s = call(&c, "play/state", json!({})).unwrap();
        assert_eq!(s["run"]["state"], json!({"kind": "exited", "code": 3}));
    }

    #[test]
    fn the_viewer_lists_scenes_refreshes_headless_and_serves_the_cached_tree() {
        let w = world(false);
        std::fs::create_dir_all(w.root.join("game/.godot/imported")).unwrap();
        let c = ctx(&w, false, &real_check);

        let empty = call(&c, "godot-viewer/state", json!({})).unwrap();
        assert_eq!(empty["scenes"], json!(["res://main.tscn"]));
        assert_eq!(empty["renderedAt"], Value::Null);
        assert_eq!(empty["nodes"], json!([]));

        // The play fake writes no tree, so the refresh falls back to the scene
        // file - which is exactly the honest-degradation path.
        call(&c, "godot-viewer/refresh", json!({})).unwrap();
        wait_until("the refresh", || {
            call(&c, "godot-viewer/state", json!({})).unwrap()["job"]["running"] == json!(false)
        });
        let state = call(&c, "godot-viewer/state", json!({})).unwrap();
        assert_eq!(state["source"], "parsed");
        assert_eq!(state["nodes"][0]["name"], "World");
        assert!(state["renderedAt"].as_u64().unwrap() > 0);
        assert!(state["note"].as_str().unwrap().contains("scene file"));
        assert!(
            w.root.join(".veistra/godot-viewer").is_dir(),
            "the cache lives in the environment's .veistra"
        );
        assert_eq!(
            call(&c, "godot-viewer/image", json!({})).unwrap()["png"],
            Value::Null
        );
    }

    #[test]
    fn a_read_only_environment_caches_outside_the_checkout() {
        let w = world(false);
        let c = ctx(&w, true, &real_check);
        call(&c, "godot-viewer/refresh", json!({})).unwrap();
        wait_until("the refresh", || {
            call(&c, "godot-viewer/state", json!({})).unwrap()["job"]["running"] == json!(false)
        });
        assert!(
            !w.root.join(".veistra").exists(),
            "main's checkout is untouched"
        );
        assert!(w.scratch.join("appdata/godot-viewer").is_dir());
    }

    #[test]
    fn multiple_projects_are_addressed_by_their_folder() {
        let w = world(false);
        std::fs::create_dir_all(w.root.join("tool")).unwrap();
        std::fs::write(w.root.join("tool/project.godot"), "config_version=5\n").unwrap();
        let c = ctx(&w, false, &real_check);
        let s = call(&c, "godot/status", json!({})).unwrap();
        assert_eq!(s["projects"].as_array().unwrap().len(), 2);
        assert_eq!(
            call(&c, "play/addon-status", json!({ "project": "tool" })).unwrap()["addon"],
            "no"
        );
        assert_eq!(
            call(&c, "play/addon-status", json!({ "project": "nope" }))
                .unwrap_err()
                .code,
            INVALID_PARAMS
        );
    }

    fn preview_params(extra: Value) -> Value {
        let mut base = json!({ "actor": "agent" });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    fn engine_version(c: &Ctx) -> String {
        call(c, "godot/status", json!({})).unwrap()["executable"]["found"]["version"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Writes what a finished export leaves, so the cache-hit path can be
    /// tested without an engine that can convert a scene.
    fn seed_preview(c: &Ctx, w: &World, dir: &Path) {
        let key = preview::cache_key(&w.root.join("game"), "res://main.tscn", &engine_version(c))
            .unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("game__main_tscn.glb"), b"glb-bytes").unwrap();
        let sidecar = preview::Preview {
            key,
            scene: "res://main.tscn".into(),
            exported_at: 42,
            godot: engine_version(c),
            glb_bytes: 9,
            node_map: std::collections::BTreeMap::from([("World".into(), "World".into())]),
        };
        std::fs::write(
            dir.join("game__main_tscn.json"),
            serde_json::to_string(&sidecar).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn the_preview_needs_an_actor_and_never_accepts_system() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        let missing = call(&c, "godot/preview-glb", json!({})).unwrap_err();
        assert_eq!(missing.code, INVALID_PARAMS);
        assert!(missing.message.contains("actor is required"));
        let system = call(&c, "godot/preview-glb", json!({ "actor": "system" })).unwrap_err();
        assert_eq!(system.code, INVALID_PARAMS);
    }

    #[test]
    fn a_current_glb_is_served_from_the_cache_and_no_engine_runs() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        let dir = w.root.join(".veistra/preview/godot");
        seed_preview(&c, &w, &dir);

        let answer = call(&c, "godot/preview-glb", preview_params(json!({}))).unwrap();
        assert_eq!(answer["status"], "ready");
        assert_eq!(answer["cached"], true);
        assert_eq!(answer["nodeMap"]["World"], "World");
        assert_eq!(answer["exportedAt"], 42);
        assert!(answer["path"]
            .as_str()
            .unwrap()
            .ends_with("game__main_tscn.glb"));
        assert!(
            w.godot.jobs.get("c1#preview").is_none(),
            "a cache hit starts no job"
        );

        let bytes = call(&c, "godot/preview-glb-bytes", json!({})).unwrap();
        assert_eq!(bytes["size"], 9);
        assert_eq!(
            BASE64.decode(bytes["base64"].as_str().unwrap()).unwrap(),
            b"glb-bytes"
        );
    }

    #[test]
    fn editing_the_scene_makes_the_cached_glb_stale() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        seed_preview(&c, &w, &w.root.join(".veistra/preview/godot"));
        std::fs::write(
            w.root.join("game/main.tscn"),
            "[gd_scene format=3]\n\n[node name=\"World\" type=\"Node3D\"]\n\n[node name=\"New\" type=\"Node3D\" parent=\".\"]\n",
        )
        .unwrap();
        let answer = call(&c, "godot/preview-glb", preview_params(json!({}))).unwrap();
        assert_eq!(answer["status"], "running", "{answer}");
        assert_eq!(answer["cached"], false);
        wait_until("the export", || {
            w.godot.jobs.get("c1#preview").is_some_and(|j| !j.running)
        });
    }

    #[test]
    fn a_failed_export_is_remembered_until_it_is_forced_again() {
        let w = world(false);
        std::fs::create_dir_all(w.root.join("game/.godot/imported")).unwrap();
        let c = ctx(&w, false, &real_check);

        let first = call(&c, "godot/preview-glb", preview_params(json!({}))).unwrap();
        assert_eq!(first["status"], "running");
        wait_until("the export", || {
            w.godot.jobs.get("c1#preview").is_some_and(|j| !j.running)
        });

        // The fake engine exits without writing anything, and says so.
        let failed = call(&c, "godot/preview-glb", preview_params(json!({}))).unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(failed["error"]
            .as_str()
            .unwrap()
            .contains("without exporting"));
        assert!(!failed["output"].as_array().unwrap().is_empty());
        assert_eq!(failed["path"], Value::Null);

        let again = call(
            &c,
            "godot/preview-glb",
            preview_params(json!({ "force": true })),
        )
        .unwrap();
        assert_eq!(again["status"], "running", "force retries");
        wait_until("the retry", || {
            w.godot.jobs.get("c1#preview").is_some_and(|j| !j.running)
        });
        let dir = w.root.join(".veistra/preview/godot");
        assert!(
            std::fs::read_dir(&dir).map_or(true, |mut d| d.next().is_none()),
            "a failed export leaves no file behind"
        );
    }

    #[test]
    fn a_read_only_environment_previews_outside_the_checkout() {
        let w = world(false);
        std::fs::create_dir_all(w.root.join("game/.godot/imported")).unwrap();
        let c = ctx(&w, true, &real_check);
        call(&c, "godot/preview-glb", preview_params(json!({}))).unwrap();
        wait_until("the export", || {
            w.godot.jobs.get("c1#preview").is_some_and(|j| !j.running)
        });
        assert!(
            !w.root.join(".veistra").exists(),
            "main's checkout is untouched"
        );
        assert!(w.scratch.join("appdata/preview/godot").is_dir());
    }

    #[test]
    fn previewing_a_scene_that_is_not_there_is_refused() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        let err = call(
            &c,
            "godot/preview-glb",
            preview_params(json!({ "scene": "res://../secret.tscn" })),
        )
        .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
        let err = call(&c, "godot/preview-glb-bytes", json!({})).unwrap_err();
        assert!(err.message.contains("not been exported"), "{}", err.message);
    }

    #[test]
    fn an_unknown_method_is_not_swallowed() {
        let w = world(false);
        let c = ctx(&w, false, &real_check);
        assert_eq!(
            call(&c, "play/nope", json!({})).unwrap_err().code,
            METHOD_NOT_FOUND
        );
        // Comments are answered before this module is asked (`apps::play::call`).
        assert_eq!(
            call(&c, "comments/list", json!({})).unwrap_err().code,
            METHOD_NOT_FOUND
        );
    }
}
