//! Play's methods for a run in the pane and its takes (design §4 to §9):
//! the pane's box, Record, marks, picking, the still for overlays, Pop out and
//! Dock, and the takes on disk with their notes and Send.
//!
//! [`super::rpc`] keeps run, stop, restart and the log; it routes every other
//! `play/*` here. The split is by what the method touches: those four drive
//! the process, these drive the session around it ([`super::session`]).

use super::detect;
use super::encode::Quality;
use super::feedback;
use super::record;
use super::rpc::{fail, pick_project_for, Ctx};
use super::session::{Plan, Session, TakeState};
use super::takes;
use crate::embed::host::{self, Slot};
use crate::embed::{Cause, Kind, Owner, State as EmbedState};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use veistra_rpc::{RpcError, INVALID_PARAMS};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct P {
    project: Option<String>,
    x: f64,
    y: f64,
    /// `play/record`: Record on or off, kept as it was when absent, so the
    /// settings popover can change the quality alone.
    on: Option<bool>,
    /// `play/record`: `"720p30"` or `"1080p60"`, kept as it was when absent.
    quality: Option<String>,
    /// `play/record`: takes each environment keeps, kept as it was when absent.
    keep: Option<usize>,
    id: Option<String>,
    take: Option<String>,
    notes: Option<Value>,
}

fn params(raw: Option<&Value>) -> Result<P, RpcError> {
    match raw {
        None | Some(Value::Null) => Ok(P::default()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}"))),
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| fail(format!("could not serialize the answer: {e}")))
}

/// `None` when `method` is not one of these.
pub fn call(ctx: &Ctx, method: &str, raw: Option<&Value>) -> Option<Result<Value, RpcError>> {
    let p = match params(raw) {
        Ok(p) => p,
        Err(e) => return Some(Err(e)),
    };
    Some(match method {
        "play/embed-rect" => embed_rect(ctx, raw),
        "play/record" => set_record(ctx, &p),
        "play/mark" => mark(ctx),
        "play/pick" => pick(ctx, &p),
        "play/still" => still(ctx),
        "play/pop-out" => pop_out(ctx),
        "play/dock" => dock(ctx),
        "play/takes" => list_takes(ctx),
        "play/takes-reveal" => reveal_takes(ctx),
        "play/take" => one_take(ctx, &p),
        "play/take-delete" => delete_take(ctx, &p),
        "play/notes-save" => save_notes(ctx, &p),
        "play/send" => send(ctx, raw),
        "play/notes" => notes(ctx, &p),
        _ => return None,
    })
}

fn session(ctx: &Ctx) -> Option<Arc<Session>> {
    let run = ctx.godot.runner.get(&ctx.key)?;
    ctx.godot
        .session(&ctx.key)
        .filter(|s| s.run_id == run.id && run.is_running())
}

fn live_session(ctx: &Ctx) -> Result<Arc<Session>, RpcError> {
    session(ctx).ok_or_else(|| fail("no game is running"))
}

/// The Veistra window the game's pane is in.
fn owner(ctx: &Ctx, s: &Session) -> Option<Owner> {
    let hosted = ctx.hosts.hosting(&s.embed)?;
    ctx.hosts.owner_for(&hosted, &ctx.owner)
}

// --- the pane's box ----------------------------------------------------------

/// The pane's box, `embed::host`'s box message. It is kept per pane instance,
/// so the next launch is sized to the pane that pressed Play, and the pane
/// that sends `visible: true` takes the cluster's game: Play in two panes
/// hands it between them. A game an agent started with no Play pane open
/// joins the first pane that shows it ([`join_pane`]).
fn embed_rect(ctx: &Ctx, raw: Option<&Value>) -> Result<Value, RpcError> {
    let (asked, window) = host::parse_box(raw)?;
    let instance = ctx
        .instance
        .clone()
        .ok_or_else(|| fail("play/embed-rect comes from a Play pane, and this call names none"))?;
    let hosted = session(ctx).and_then(|s| ctx.hosts.hosting(&s.embed));
    if let (Some(h), true) = (&hosted, asked.visible) {
        ctx.hosts.claim(h, &instance, (ctx.shown)(&instance));
    }
    ctx.hosts
        .report_box(&Slot::new(&instance, Kind::Game), asked, window, &ctx.owner);
    let waiting_for_a_pane = hosted.is_some_and(|h| {
        matches!(
            h.embed.state(),
            EmbedState::OwnWindow {
                cause: Cause::NoPane,
                ..
            }
        )
    });
    if asked.visible && waiting_for_a_pane {
        join_pane(ctx);
    }
    Ok(json!({ "ok": true }))
}

/// A game started with no pane open meets the pane that shows it: placed
/// when its window appears if it has none yet, docked now if it has. The box
/// is kept either way, so a failure is only logged.
fn join_pane(ctx: &Ctx) {
    let Some(s) = session(ctx) else {
        return;
    };
    if s.embed.rejoin() {
        replan(ctx, &s);
    } else if let Err(e) = dock(ctx) {
        crate::veistra_log!("play: could not dock the game: {}", e.message);
    }
}

/// Pop out ends a take going: the recorder captures the whole window, and a
/// decorated one would put its title bar in the video.
fn pop_out(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    s.embed.pop_out(owner(ctx, &s).as_ref()).map_err(fail)?;
    if let Some(run) = ctx.godot.runner.get(&ctx.key) {
        s.finish_take(&run);
    }
    Ok(json!({ "embed": s.embed.state() }))
}

/// Dock puts the game back in the pane, and with Record on starts a new take
/// of the rest of the run.
fn dock(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    let o = owner(ctx, &s).ok_or_else(|| fail("the Veistra window is not known"))?;
    s.embed.dock(&o).map_err(fail)?;
    replan(ctx, &s);
    Ok(json!({ "embed": s.embed.state() }))
}

/// With Record on, plan a take of the rest of the run and start it if the
/// window is in the pane already; one still being looked for starts it when
/// it is placed (`session::attached`).
fn replan(ctx: &Ctx, s: &Session) {
    let (Some(run), Some(root)) = (ctx.godot.runner.get(&ctx.key), ctx.root.as_ref()) else {
        return;
    };
    let rel = run
        .spec
        .project
        .strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .ok()
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let godot = ctx.godot.version_for_takes();
    if let Some(plan) = plan_for(ctx, &run.spec.project, &rel, &godot, false) {
        s.plan(plan);
        if let Some(hwnd) = s.embed.hwnd() {
            s.begin_take(hwnd);
        }
    }
}

// --- Record ------------------------------------------------------------------

/// Why Record cannot be on for this project, or `None` when it can.
pub fn record_blocked(ctx: &Ctx, project_dir: &Path) -> Option<String> {
    if let Some(why) = record::unavailable() {
        return Some(why.to_string());
    }
    if !super::addon::status(project_dir).usable() {
        return Some(
            "Recording needs the capture addon, version 2. Enable capture, then run the game."
                .to_string(),
        );
    }
    let _ = ctx;
    None
}

/// Record's settings for a project on this computer (X9): whether it is on,
/// the video's quality, and how many takes each environment keeps. Off
/// until switched on (open decision 2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecSettings {
    pub on: bool,
    pub quality: String,
    pub keep: usize,
}

impl Default for RecSettings {
    fn default() -> Self {
        Self {
            on: false,
            quality: "720p30".into(),
            keep: takes::KEEP,
        }
    }
}

/// Every project's settings are one file; two panes saving at once would
/// each write back the other's old value.
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());

fn setting_file(ctx: &Ctx) -> PathBuf {
    ctx.cache_root.join("play-record.json")
}

/// What the settings are kept under: the cluster's project, so all its
/// environments share them, or the environment when no project is known.
fn setting_key(ctx: &Ctx) -> Option<String> {
    let key = ctx.project_root.as_ref().or(ctx.root.as_ref())?;
    Some(key.to_string_lossy().into_owned())
}

/// This project's Record settings. The file once held a bare `on` per
/// environment, which an environment with nothing newer still reads.
pub fn rec_settings(ctx: &Ctx) -> RecSettings {
    let Some(key) = setting_key(ctx) else {
        return RecSettings::default();
    };
    let all: Value = std::fs::read_to_string(setting_file(ctx))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    if let Ok(saved) = serde_json::from_value::<RecSettings>(all[&key].clone()) {
        if all[&key].is_object() {
            return saved;
        }
    }
    let env = ctx.root.as_ref().map(|r| r.to_string_lossy().into_owned());
    RecSettings {
        on: env.is_some_and(|env| all[&env].as_bool() == Some(true)),
        ..RecSettings::default()
    }
}

fn write_rec_settings(ctx: &Ctx, settings: &RecSettings) -> Result<(), RpcError> {
    let key = setting_key(ctx).ok_or_else(|| fail("open a project first"))?;
    let _one = SETTINGS_WRITE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = setting_file(ctx);
    let mut all: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    all[key] = to_value(settings)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| fail(format!("could not save Record: {e}")))?;
    }
    super::scene::write_atomic(&path, all.to_string().as_bytes())
        .map_err(|e| fail(format!("could not save Record: {e}")))
}

/// Where this environment's takes live: inside it, or for the read-only main
/// checkout under the app's own data, which may be written.
pub fn takes_dir(ctx: &Ctx) -> Result<PathBuf, RpcError> {
    let root = ctx
        .root
        .as_ref()
        .ok_or_else(|| fail("this cluster has no environment yet - open a project first"))?;
    Ok(if ctx.read_only {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(root.to_string_lossy().as_bytes());
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        ctx.cache_root.join("takes").join(hex)
    } else {
        takes::dir_in(root)
    })
}

/// The take a run started now will be, if Record is on (or `once`, a run
/// recorded without changing the setting) and possible. `godot` is the
/// engine's `--version` line.
pub fn plan_for(
    ctx: &Ctx,
    project_dir: &Path,
    project_rel: &str,
    godot: &str,
    once: bool,
) -> Option<Plan> {
    let settings = rec_settings(ctx);
    if !(settings.on || once) || record_blocked(ctx, project_dir).is_some() {
        return None;
    }
    let root = ctx.root.clone()?;
    Some(Plan {
        takes_dir: takes_dir(ctx).ok()?,
        env_root: (!ctx.read_only).then(|| root.clone()),
        project: project_rel.to_string(),
        godot: detect::short_version(godot),
        godot_build: godot.trim().to_string(),
        environment: super::session::env_info(&root),
        quality: Quality::named(&settings.quality).unwrap_or(Quality::DEFAULT),
        keep: settings.keep.max(1),
        usage: ctx.usage.clone(),
    })
}

/// `play/record`: Record on or off, its quality, and how many takes each
/// environment keeps; whatever is absent stays as it was. While a game runs,
/// on starts a take now and off saves the one going, so the toggle means
/// "from now", not "from the next run". The quality and keep apply from the
/// next take: the one recording keeps what it began with, and the keep is
/// applied when the next take is saved.
fn set_record(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let project = pick_project_for(ctx, p.project.as_deref())?;
    if p.on == Some(true) {
        if let Some(why) = record_blocked(ctx, &project.dir) {
            return Err(fail(why));
        }
    }
    let mut settings = rec_settings(ctx);
    if let Some(on) = p.on {
        settings.on = on;
    }
    let mut quality = Quality::named(&settings.quality).unwrap_or(Quality::DEFAULT);
    if let Some(name) = &p.quality {
        quality = Quality::named(name).ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                format!("quality is \"720p30\" or \"1080p60\", not {name:?}"),
            )
        })?;
        settings.quality.clone_from(name);
    }
    if let Some(keep) = p.keep {
        if keep == 0 {
            return Err(RpcError::new(INVALID_PARAMS, "keep at least one take"));
        }
        settings.keep = keep;
    }
    write_rec_settings(ctx, &settings)?;
    if let (Some(s), Some(run)) = (session(ctx), ctx.godot.runner.get(&ctx.key)) {
        match p.on {
            Some(true) => {
                let godot = ctx.godot.version_for_takes();
                if let Some(plan) = plan_for(ctx, &project.dir, &project.rel, &godot, false) {
                    s.plan(plan);
                    if let Some(hwnd) = s.embed.hwnd() {
                        s.begin_take(hwnd);
                    }
                }
            }
            Some(false) => s.finish_take(&run),
            None => s.retune(quality, settings.keep),
        }
    }
    Ok(json!({ "on": settings.on, "quality": settings.quality, "keep": settings.keep }))
}

// --- marks, picks and stills ---------------------------------------------------

fn mark(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    let t = s.mark();
    Ok(json!({ "t": t, "marks": s.marks() }))
}

fn channel(s: &Session) -> Result<PathBuf, RpcError> {
    s.channel.clone().ok_or_else(|| {
        fail("This game was started without the capture addon. Enable capture, then restart it.")
    })
}

/// What is under a point of the game's viewport, in its own pixels.
fn pick(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    let reply = super::addon::send_with(
        &channel(&s)?,
        ctx.godot.next_command_id(),
        "pick",
        json!({ "x": p.x, "y": p.y }),
        Duration::from_secs(3),
    )
    .map_err(fail)?;
    if !reply.ok {
        return Err(fail(
            reply
                .error
                .unwrap_or_else(|| "the game could not pick".into()),
        ));
    }
    Ok(json!({ "hit": reply.hit, "t": reply.t }))
}

/// The frame to show in place of the game while an overlay is open: the
/// recording's last frame while a take runs, else the window's own capture
/// (`embed::capture`), else the addon's. The capture needs neither Record nor
/// the addon, so a plain run has a still too.
fn still(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    if let Some(png) = s.still_png() {
        return Ok(json!({ "png": BASE64.encode(png), "source": "recording" }));
    }
    if let Some(png) = s.embed.still_png() {
        return Ok(json!({ "png": BASE64.encode(png), "source": "capture" }));
    }
    let reply = super::addon::send(
        &channel(&s)?,
        ctx.godot.next_command_id(),
        "capture",
        Duration::from_secs(3),
    )
    .map_err(fail)?;
    let png = reply.png.filter(|_| reply.ok).ok_or_else(|| {
        fail(
            reply
                .error
                .unwrap_or_else(|| "the game sent no frame".into()),
        )
    })?;
    Ok(json!({
        "png": BASE64.encode(png),
        "source": "addon",
        "width": reply.size.map(|s| s.0),
        "height": reply.size.map(|s| s.1),
    }))
}

// --- takes ---------------------------------------------------------------------

/// What the page loads a take's files through: Tauri's asset protocol, which
/// serves ranges (so the `<video>` seeks) and answers with the page's own
/// origin in CORS (so frames drawn from it into a canvas can be read back).
pub fn asset_url(path: &Path) -> String {
    let mut out = String::new();
    for b in path.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    if cfg!(windows) {
        format!("http://asset.localhost/{out}")
    } else {
        format!("asset://localhost/{out}")
    }
}

fn urls(dir: &Path) -> Value {
    json!({
        "video": asset_url(&dir.join(takes::VIDEO)),
        "telemetry": asset_url(&dir.join(super::telemetry::FILE)),
        "log": asset_url(&dir.join(takes::LOG)),
    })
}

fn list_takes(ctx: &Ctx) -> Result<Value, RpcError> {
    let dir = takes_dir(ctx)?;
    (ctx.allow_asset)(&dir);
    let listed = takes::list(&dir);
    Ok(json!({ "takes": to_value(&listed)?, "dir": dir.display().to_string() }))
}

/// `play/takes-reveal`: open this environment's takes folder in the file
/// manager, making it first when no take has been saved yet. The folder is
/// shown, never chosen: the asset scope, retention and the git exclude all
/// assume takes live where [`takes_dir`] says.
fn reveal_takes(ctx: &Ctx) -> Result<Value, RpcError> {
    let dir = takes_dir(ctx)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| fail(format!("could not create {}: {e}", dir.display())))?;
    if let Some(root) = ctx.root.as_ref().filter(|_| !ctx.read_only) {
        if let Err(e) = takes::ensure_excluded(root) {
            crate::veistra_log!("play: could not keep takes out of git: {e}");
        }
    }
    (ctx.reveal)(&dir).map_err(fail)?;
    Ok(json!({ "dir": dir.display().to_string() }))
}

fn take_id(p: &P) -> Result<String, RpcError> {
    p.id.clone()
        .or_else(|| p.take.clone())
        .filter(|id| takes::valid_id(id))
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "a take id is required"))
}

fn one_take(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let dir = takes_dir(ctx)?;
    let id = take_id(p)?;
    (ctx.allow_asset)(&dir);
    let listed = takes::read(&dir, &id).map_err(fail)?;
    Ok(json!({
        "take": to_value(&listed)?,
        "urls": urls(&dir.join(&id)),
        "notes": takes::load_notes(&dir, &id),
        // Why Send's "Video clip per note" cannot be ticked here, or null.
        "clipUnavailable": super::clip::unavailable(),
    }))
}

fn delete_take(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let dir = takes_dir(ctx)?;
    let id = take_id(p)?;
    let busy = |s: &Session| match s.take_state() {
        TakeState::Recording { id: now, .. } | TakeState::Saving { id: now, .. } => now == id,
        _ => false,
    };
    if session(ctx).is_some_and(|s| busy(&s)) {
        return Err(fail("that take is still being recorded or saved"));
    }
    takes::delete(&dir, &id).map_err(fail)?;
    Ok(json!({ "deleted": id }))
}

fn save_notes(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let dir = takes_dir(ctx)?;
    let id = take_id(p)?;
    let notes = p
        .notes
        .as_ref()
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "notes are required"))?;
    takes::save_notes(&dir, &id, notes).map_err(fail)?;
    Ok(json!({ "saved": true }))
}

fn send(ctx: &Ctx, raw: Option<&Value>) -> Result<Value, RpcError> {
    let req: feedback::Request = serde_json::from_value(raw.cloned().unwrap_or(Value::Null))
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}")))?;
    let dir = takes_dir(ctx)?;
    let name = pick_project_for(ctx, None)
        .map(|p| p.name)
        .unwrap_or_else(|_| "Project".to_string());
    let context = crate::apps::CallContext {
        cluster_id: Some(ctx.key.clone()),
        project: ctx.root.clone(),
    };
    let sent = feedback::send(&context, &dir, &name, &req).map_err(fail)?;
    to_value(&sent)
}

/// The notes Send filed for this environment, with their status, newest
/// take first; `take` narrows it to one take.
fn notes(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let context = crate::apps::CallContext {
        cluster_id: Some(ctx.key.clone()),
        project: ctx.root.clone(),
    };
    let all = crate::comments::list(&context)?;
    let wanted: Vec<_> = all
        .into_iter()
        .filter(|c| match (&c.anchor, &p.take) {
            (crate::comments::Anchor::Take { take, .. }, Some(want)) => take == want,
            (crate::comments::Anchor::Take { .. }, None) => true,
            _ => false,
        })
        .collect();
    Ok(json!({ "notes": to_value(&wanted)? }))
}

/// `root/rel` when `rel` is a plain relative folder (`.` for the root) that
/// holds a `project.godot`. Reads one file, never the environment.
pub fn project_at(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    let plain = rel
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    let dir = root.join(rel);
    (plain && dir.join("project.godot").is_file()).then_some(dir)
}

/// The Godot project `play/state` judges Record against: the one running,
/// else the one the page has chosen (`rel`), else the one that ran last.
/// `play/state` is polled twice a second, so this never looks for projects:
/// a walk of the environment, and the scenes of a Godot 4.4 project whose
/// main scene is a `uid://`, ran on every poll before.
pub fn record_project(
    root: Option<&Path>,
    rel: Option<&str>,
    running: Option<&Path>,
    ran: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(dir) = running {
        return Some(dir.to_path_buf());
    }
    match rel {
        Some(rel) => project_at(root?, rel),
        None => ran.map(Path::to_path_buf),
    }
}

/// The `live` part of `play/state`. `project` is the page's chosen project,
/// as `godot/status` names it. `marks` holds F8's and the toolbar's together;
/// `f8Marks` counts F8's alone, so the page can tell a mark made in the game.
/// `mouseCaptured` is the last tick's mouse mode.
pub fn state(ctx: &Ctx, key_since: u64, project: Option<&str>) -> Value {
    let run = ctx.godot.runner.get(&ctx.key);
    let s = run
        .as_ref()
        .and_then(|r| ctx.godot.session(&ctx.key).filter(|s| s.run_id == r.id));
    let dir = record_project(
        ctx.root.as_deref(),
        project,
        run.as_ref()
            .filter(|r| r.is_running())
            .map(|r| r.spec.project.as_path()),
        run.as_ref().map(|r| r.spec.project.as_path()),
    );
    let blocked = dir.as_ref().and_then(|d| record_blocked(ctx, d));
    let settings = rec_settings(ctx);
    // `inEnvironment`: the folder is the environment's `.veistra/takes/`,
    // kept out of git; on read-only main it is under the app's data instead.
    let record = json!({
        "on": settings.on,
        "quality": settings.quality,
        "keep": settings.keep,
        "blocked": blocked,
        "dir": takes_dir(ctx).ok().map(|d| d.display().to_string()),
        "inEnvironment": !ctx.read_only,
    });
    let Some(s) = s else {
        return json!({ "record": record, "session": Value::Null });
    };
    if run.as_ref().is_some_and(|r| r.is_running()) {
        s.poll();
    }
    s.refresh_take();
    let started = run.as_ref().map_or(0, |r| r.started);
    let embed = s.embed.state();
    json!({
        "record": record,
        "session": {
            "runId": s.run_id,
            "embed": embed,
            "embedded": embed == EmbedState::Embedded,
            "take": s.take_state(),
            "zero": s.zero(started),
            "marks": s.marks(),
            "f8Marks": s.f8_count(),
            "keys": s.keys_since(key_since),
            "ticks": s.ticks(),
            "mouseCaptured": s.mouse_captured(),
            "addon": s.channel.as_deref().and_then(super::addon::running_version),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct World {
        dir: tempfile::TempDir,
        godot: super::super::Godot,
        hosts: crate::embed::host::Hosts,
    }

    fn world() -> World {
        let dir = tempfile::TempDir::new().unwrap();
        for rel in ["game", "tool"] {
            std::fs::create_dir_all(dir.path().join(rel)).unwrap();
            std::fs::write(
                dir.path().join(rel).join("project.godot"),
                "config_version=5\n",
            )
            .unwrap();
        }
        World {
            dir,
            godot: super::super::Godot::default(),
            hosts: crate::embed::host::Hosts::with(crate::embed::native(), false, false),
        }
    }

    fn ctx(w: &World) -> Ctx<'_> {
        Ctx {
            godot: &w.godot,
            key: "c1".into(),
            root: Some(w.dir.path().to_path_buf()),
            project_root: Some(w.dir.path().to_path_buf()),
            read_only: false,
            probe: super::super::detect::Probe::default(),
            check: &|_| Err("no engine here".into()),
            cache_root: w.dir.path().join("appdata"),
            scratch: w.dir.path().join("scratch"),
            owner: Arc::new(|_| None),
            allow_asset: &|_| {},
            reveal: &|_| Ok(()),
            hosts: &w.hosts,
            instance: Some("play-1".into()),
            shown: &|_| true,
            usage: Arc::new(|_, _| {}),
        }
    }

    /// X9: Record is the project's, so each of its environments has it on
    /// at once, and an environment switched on before that is still on.
    #[test]
    fn record_is_off_until_switched_on_and_shared_by_a_project_s_environments() {
        let w = world();
        let c = ctx(&w);
        assert_eq!(rec_settings(&c), RecSettings::default());
        assert!(!rec_settings(&c).on);

        let record = |c: &Ctx, params: Value| call(c, "play/record", Some(&params)).unwrap();
        let saved = record(
            &c,
            json!({ "project": "game", "on": false, "quality": "1080p60", "keep": 3 }),
        )
        .unwrap();
        assert_eq!(
            saved,
            json!({ "on": false, "quality": "1080p60", "keep": 3 })
        );
        for bad in [
            json!({ "project": "game", "quality": "4k" }),
            json!({ "project": "game", "keep": 0 }),
        ] {
            let e = record(&c, bad.clone()).unwrap_err();
            assert_eq!(e.code, INVALID_PARAMS, "{bad}");
        }
        let on = RecSettings {
            on: true,
            ..rec_settings(&c)
        };
        write_rec_settings(&c, &on).unwrap();
        let other_env = w.dir.path().join("other");
        let sibling = Ctx {
            root: Some(other_env.clone()),
            ..ctx(&w)
        };
        assert_eq!(
            rec_settings(&sibling),
            on,
            "the project's, not the environment's"
        );
        assert_eq!(state(&sibling, 0, None)["record"]["keep"], 3);

        let elsewhere = Ctx {
            root: Some(other_env.clone()),
            project_root: Some(w.dir.path().join("another-project")),
            ..ctx(&w)
        };
        assert!(!rec_settings(&elsewhere).on, "another project's is its own");
        let mut legacy = serde_json::Map::new();
        legacy.insert(other_env.to_string_lossy().into_owned(), json!(true));
        std::fs::write(setting_file(&c), Value::Object(legacy).to_string()).unwrap();
        let read = rec_settings(&elsewhere);
        assert!(read.on, "the old per-environment switch still counts");
        assert_eq!((read.quality.as_str(), read.keep), ("720p30", takes::KEEP));
    }

    /// The settings popover sends the quality or the keep alone. Neither may
    /// switch Record off, nor save the take a running game is waiting to start.
    #[test]
    fn a_settings_change_alone_leaves_record_and_the_take_as_they_were() {
        let w = world();
        let c = ctx(&w);
        let on = RecSettings {
            on: true,
            ..RecSettings::default()
        };
        write_rec_settings(&c, &on).unwrap();
        let spec = super::super::runner::RunSpec {
            program: super::super::testing::fake_godot(w.dir.path(), true),
            project: w.dir.path().join("game"),
            scene: None,
            channel: None,
            window: None,
        };
        let run = w.godot.runner.start("c1", spec).unwrap();
        let takes = takes_dir(&c).unwrap();
        let plan = Plan {
            takes_dir: takes.clone(),
            env_root: None,
            project: "game".into(),
            godot: "4.5.1".into(),
            godot_build: String::new(),
            environment: takes::EnvInfo::default(),
            quality: Quality::DEFAULT,
            keep: 10,
            usage: Arc::new(|_, _| {}),
        };
        let s = Arc::new(Session::new(run.id, None, Some(plan)));
        w.godot.set_session("c1", s.clone());
        let params = json!({ "project": "game", "quality": "1080p60", "keep": 4 });
        let saved = call(&c, "play/record", Some(&params)).unwrap();
        let after = s.take_state();
        assert_eq!(w.godot.runner.stop("c1"), Ok(true));
        assert_eq!(
            saved.unwrap(),
            json!({ "on": true, "quality": "1080p60", "keep": 4 })
        );
        assert_eq!(after, TakeState::Starting { number: 1 }, "not saved");
        let record = state(&c, 0, None)["record"].clone();
        assert_eq!(record["dir"], takes.display().to_string());
        assert_eq!(record["inEnvironment"], true);
    }

    /// Show folder opens the environment's own takes folder, made if no take
    /// was saved yet, and on read-only main the one under the app's data,
    /// leaving main's checkout untouched.
    #[test]
    fn show_folder_opens_the_takes_folder_and_never_writes_to_main() {
        let w = world();
        let opened: Mutex<Vec<PathBuf>> = Mutex::default();
        let reveal = |dir: &Path| {
            opened.lock().unwrap().push(dir.to_path_buf());
            Ok(())
        };
        let worktree = Ctx {
            reveal: &reveal,
            ..ctx(&w)
        };
        let answer = call(&worktree, "play/takes-reveal", None).unwrap().unwrap();
        let own = takes::dir_in(w.dir.path());
        assert!(own.is_dir(), "made before it is opened");
        assert_eq!(answer["dir"], own.display().to_string());

        std::fs::remove_dir_all(w.dir.path().join(".veistra")).unwrap();
        let main = Ctx {
            read_only: true,
            reveal: &reveal,
            ..ctx(&w)
        };
        call(&main, "play/takes-reveal", None).unwrap().unwrap();
        let opened = opened.lock().unwrap().clone();
        assert_eq!(opened.len(), 2);
        assert_eq!(opened[0], own);
        assert!(
            opened[1].starts_with(w.dir.path().join("appdata")),
            "{opened:?}"
        );
        assert!(
            !w.dir.path().join(".veistra").exists(),
            "main is not written"
        );
        assert_eq!(state(&main, 0, None)["record"]["inEnvironment"], false);

        let refused = Ctx {
            reveal: &|_| Err("no file manager".into()),
            ..ctx(&w)
        };
        let e = call(&refused, "play/takes-reveal", None)
            .unwrap()
            .unwrap_err();
        assert!(e.message.contains("no file manager"), "{}", e.message);
    }

    #[test]
    fn record_is_judged_against_the_project_the_page_chose_and_only_that() {
        let w = world();
        let c = ctx(&w);
        let blocked = |project: Option<&str>| state(&c, 0, project)["record"]["blocked"].clone();
        assert!(
            blocked(Some("tool")).is_string(),
            "the addon is missing there"
        );
        assert_eq!(
            blocked(None),
            Value::Null,
            "before the page has chosen, nothing is looked for"
        );
        for bad in ["../tool", "nope", "/etc"] {
            assert_eq!(blocked(Some(bad)), Value::Null, "{bad}");
        }
    }

    #[test]
    fn a_project_is_a_plain_folder_under_the_root_that_holds_project_godot() {
        let w = world();
        let root = w.dir.path();
        assert_eq!(project_at(root, "game"), Some(root.join("game")));
        assert_eq!(project_at(root, "./tool"), Some(root.join("./tool")));
        assert_eq!(project_at(root, "."), None, "no project.godot at the root");
        std::fs::write(root.join("project.godot"), "").unwrap();
        assert_eq!(project_at(root, "."), Some(root.join(".")));
        assert_eq!(project_at(root, "game/.."), None);
        let outside = root.join("game").display().to_string();
        assert_eq!(project_at(root, &outside), None, "an absolute path");
        let running = root.join("game");
        assert_eq!(
            record_project(Some(root), Some("tool"), Some(&running), None),
            Some(running.clone()),
            "the game running is the one being recorded"
        );
        assert_eq!(
            record_project(Some(root), None, None, Some(&running)),
            Some(running)
        );
        assert_eq!(record_project(Some(root), None, None, None), None);
    }

    /// An agent's `play/run` with no Play pane open, and Play opened while the
    /// game is still loading: the pane's first box puts the game back to being
    /// looked for, to be placed when its window shows, instead of failing the
    /// report and leaving the game in its own frame.
    #[test]
    fn a_play_pane_that_opens_before_an_agent_s_game_shows_takes_it() {
        use crate::embed::host::{HostSpec, Hosts, Orphan};
        use crate::embed::OwnerFn;
        let fake = Arc::new(crate::embed::tests::Fake::finding_after(usize::MAX));
        let mut w = world();
        w.hosts = Hosts::with(fake, true, false);
        let spec = super::super::runner::RunSpec {
            program: super::super::testing::fake_godot(w.dir.path(), true),
            project: w.dir.path().join("game"),
            scene: None,
            channel: None,
            window: None,
        };
        let run = w.godot.runner.start("c1", spec).unwrap();
        let embed = w.hosts.embed(Kind::Game);
        let session = Session::with_embed(run.id, None, None, embed.clone());
        w.godot.set_session("c1", Arc::new(session));
        let (alive, nowhere): (_, OwnerFn) = (run.clone(), Arc::new(|_| None));
        let hosted = w.hosts.host(
            nowhere,
            false,
            HostSpec {
                instance: None,
                cluster: "c1".into(),
                embed: embed.clone(),
                pids: Box::new(Vec::new),
                alive: Arc::new(move || alive.is_running()),
                on_attached: None,
                on_orphan: Orphan::Stop(Box::new(|| {})),
            },
        );
        let before = embed.state();
        let rect =
            json!({ "x": 10, "y": 20, "w": 800, "h": 400, "visible": true, "window": "main" });
        let reply = call(&ctx(&w), "play/embed-rect", Some(&rect)).unwrap();
        let after = embed.state();
        // Clean-up only: nothing below depends on how the stop went.
        let _ = w.godot.runner.stop("c1");
        assert!(
            matches!(
                before,
                EmbedState::OwnWindow {
                    cause: Cause::NoPane,
                    ..
                }
            ),
            "{before:?}"
        );
        assert!(reply.is_ok(), "{reply:?}");
        assert_eq!(after, EmbedState::Waiting, "to be placed when it shows");
        assert_eq!(hosted.instance().as_deref(), Some("play-1"));
    }

    #[test]
    fn the_box_is_kept_per_pane_with_the_page_s_pixel_ratio_and_a_hide_keeps_it() {
        let w = world();
        let c = ctx(&w);
        let pane = || w.hosts.box_of(&Slot::new("play-1", Kind::Game)).unwrap();
        let rect = json!({ "x": 10, "y": 20, "w": 800, "h": 400, "visible": true, "window": "main", "dpr": 1.25 });
        call(&c, "play/embed-rect", Some(&rect)).unwrap().unwrap();
        assert_eq!((pane().rect.w, pane().dpr), (800.0, Some(1.25)));
        let hide = json!({ "x": 0, "y": 0, "w": 0, "h": 0, "visible": false });
        call(&c, "play/embed-rect", Some(&hide)).unwrap().unwrap();
        assert!(!pane().visible);
        assert_eq!(
            (pane().rect.w, pane().dpr, pane().window.as_deref()),
            (800.0, Some(1.25), Some("main")),
            "kept for the next launch"
        );
        let zero = json!({ "x": 0, "y": 0, "w": 10, "h": 10, "visible": true, "dpr": 0 });
        call(&c, "play/embed-rect", Some(&zero)).unwrap().unwrap();
        assert_eq!(pane().dpr, None, "an unusable ratio is not kept");
        let bad = json!({ "x": 0, "y": 0, "w": -1, "h": 0, "visible": false });
        assert!(call(&c, "play/embed-rect", Some(&bad)).unwrap().is_err());
        let nobody = Ctx {
            instance: None,
            ..ctx(&w)
        };
        assert!(
            call(&nobody, "play/embed-rect", Some(&rect))
                .unwrap()
                .is_err(),
            "a box belongs to a pane"
        );
        assert!(
            w.hosts.box_of(&Slot::new("play-2", Kind::Game)).is_none(),
            "another pane's box is its own"
        );
    }

    #[test]
    fn state_counts_f8_marks_apart_and_says_when_the_game_holds_the_mouse() {
        let w = world();
        let c = ctx(&w);
        let channel = w.dir.path().join("chan");
        std::fs::create_dir_all(&channel).unwrap();
        let spec = super::super::runner::RunSpec {
            program: super::super::testing::fake_godot(w.dir.path(), true),
            project: w.dir.path().join("game"),
            scene: None,
            channel: Some(channel.clone()),
            window: None,
        };
        let run = w.godot.runner.start("c1", spec).unwrap();
        let s = Arc::new(Session::new(run.id, Some(channel.clone()), None));
        w.godot.set_session("c1", s.clone());
        s.mark();
        let file = channel.join(super::super::telemetry::FILE);
        std::fs::write(
            &file,
            "{\"t\":5,\"kind\":\"mark\"}\n{\"t\":6,\"kind\":\"tick\",\"mouse\":2}\n",
        )
        .unwrap();
        let first = state(&c, 0, None)["session"].clone();
        std::fs::write(
            &file,
            "{\"t\":5,\"kind\":\"mark\"}\n{\"t\":6,\"kind\":\"tick\",\"mouse\":2}\n\
             {\"t\":7,\"kind\":\"tick\",\"mouse\":0}\n",
        )
        .unwrap();
        let then = state(&c, 0, None)["session"].clone();
        assert_eq!(w.godot.runner.stop("c1"), Ok(true));
        assert_eq!(first["marks"].as_array().map(Vec::len), Some(2));
        assert_eq!(first["f8Marks"], 1, "the toolbar's is not F8's");
        assert_eq!(first["mouseCaptured"], true);
        assert_eq!(then["mouseCaptured"], false, "the last tick decides");
    }

    #[test]
    fn asset_urls_encode_the_path_the_way_convert_file_src_does() {
        let url = asset_url(Path::new("/home/me/My Game/.veistra/takes/a b.mp4"));
        let encoded = "%2Fhome%2Fme%2FMy%20Game%2F.veistra%2Ftakes%2Fa%20b.mp4";
        if cfg!(windows) {
            assert_eq!(url, format!("http://asset.localhost/{encoded}"));
        } else {
            assert_eq!(url, format!("asset://localhost/{encoded}"));
        }
    }
}
