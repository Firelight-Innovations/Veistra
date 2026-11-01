//! Play's methods for a run in the pane and its takes (design §4 to §9):
//! the pane's box, Record, marks, picking, the still for overlays, Pop out and
//! Dock, and the takes on disk with their notes and Send.
//!
//! [`super::rpc`] keeps run, stop, restart and the log; it routes every other
//! `play/*` here. The split is by what the method touches: those four drive
//! the process, these drive the session around it ([`super::session`]).

use super::embed::{CssRect, Owner, State as EmbedState};
use super::feedback;
use super::record;
use super::rpc::{fail, pick_project_for, Ctx};
use super::session::{Plan, Session, TakeState};
use super::takes;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use veistra_rpc::{RpcError, INVALID_PARAMS};

/// The pane's last box, kept per cluster so a game is launched at its size.
#[derive(Debug, Clone, PartialEq)]
pub struct Pane {
    pub rect: CssRect,
    pub visible: bool,
    pub window: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct P {
    project: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    window: Option<String>,
    on: bool,
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
        "play/embed-rect" => embed_rect(ctx, &p),
        "play/record" => set_record(ctx, &p),
        "play/mark" => mark(ctx),
        "play/pick" => pick(ctx, &p),
        "play/still" => still(ctx),
        "play/pop-out" => pop_out(ctx),
        "play/dock" => dock(ctx),
        "play/takes" => list_takes(ctx),
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

fn owner(ctx: &Ctx, window: Option<&str>) -> Option<Owner> {
    (ctx.owner)(window)
}

// --- the pane's box ----------------------------------------------------------

fn embed_rect(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    if ![p.x, p.y, p.w, p.h].iter().all(|v| v.is_finite()) || p.w < 0.0 || p.h < 0.0 {
        return Err(RpcError::new(INVALID_PARAMS, "the box needs x, y, w and h"));
    }
    let rect = CssRect {
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
    };
    ctx.godot.set_pane(
        &ctx.key,
        Pane {
            rect,
            visible: p.visible,
            window: p.window.clone(),
        },
    );
    if let Some(s) = session(ctx) {
        s.embed
            .set_rect(rect, p.visible, owner(ctx, p.window.as_deref()).as_ref());
    }
    Ok(json!({ "ok": true }))
}

fn pop_out(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    let window = ctx.godot.pane(&ctx.key).and_then(|p| p.window);
    s.embed
        .pop_out(owner(ctx, window.as_deref()).as_ref())
        .map_err(fail)?;
    Ok(json!({ "embed": s.embed.state() }))
}

fn dock(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    let window = ctx.godot.pane(&ctx.key).and_then(|p| p.window);
    let o = owner(ctx, window.as_deref()).ok_or_else(|| fail("the Veistra window is not known"))?;
    s.embed.dock(&o).map_err(fail)?;
    Ok(json!({ "embed": s.embed.state() }))
}

// --- Record ------------------------------------------------------------------

/// Why Record cannot be on for this project, or `None` when it can.
pub fn record_blocked(ctx: &Ctx, project_dir: &Path) -> Option<String> {
    if let Some(why) = record::unavailable() {
        return Some(why.to_string());
    }
    if super::addon::status(project_dir) != super::addon::Installed::Yes {
        return Some(
            "Recording needs the capture addon, version 2. Enable capture, then run the game."
                .to_string(),
        );
    }
    let _ = ctx;
    None
}

fn setting_file(ctx: &Ctx) -> PathBuf {
    ctx.cache_root.join("play-record.json")
}

/// Whether Record is on for this environment: per project, on this
/// computer, off until switched on (open decision 2).
pub fn record_on(ctx: &Ctx) -> bool {
    let Some(root) = ctx.root.as_ref() else {
        return false;
    };
    std::fs::read_to_string(setting_file(ctx))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v[root.to_string_lossy().as_ref()].as_bool())
        .unwrap_or(false)
}

fn write_record_on(ctx: &Ctx, on: bool) -> Result<(), RpcError> {
    let root = ctx
        .root
        .as_ref()
        .ok_or_else(|| fail("open a project first"))?;
    let path = setting_file(ctx);
    let mut all: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    all[root.to_string_lossy().as_ref()] = json!(on);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| fail(format!("could not save Record: {e}")))?;
    }
    std::fs::write(&path, all.to_string()).map_err(|e| fail(format!("could not save Record: {e}")))
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

/// The take a run started now will be, if Record is on and possible.
pub fn plan_for(ctx: &Ctx, project_dir: &Path, project_rel: &str, godot: &str) -> Option<Plan> {
    if !record_on(ctx) || record_blocked(ctx, project_dir).is_some() {
        return None;
    }
    let root = ctx.root.clone()?;
    Some(Plan {
        takes_dir: takes_dir(ctx).ok()?,
        env_root: (!ctx.read_only).then(|| root.clone()),
        project: project_rel.to_string(),
        godot: godot.to_string(),
        environment: super::session::env_info(&root),
    })
}

/// Record on or off. While a game runs, on starts a take now and off saves
/// the one going, so the toggle means "from now", not "from the next run".
fn set_record(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let project = pick_project_for(ctx, p.project.as_deref())?;
    if p.on {
        if let Some(why) = record_blocked(ctx, &project.dir) {
            return Err(fail(why));
        }
    }
    write_record_on(ctx, p.on)?;
    if let (Some(s), Some(run)) = (session(ctx), ctx.godot.runner.get(&ctx.key)) {
        if p.on {
            let godot = ctx.godot.version_for_takes();
            if let Some(plan) = plan_for(ctx, &project.dir, &project.rel, &godot) {
                s.plan(plan);
                if let Some(hwnd) = s.embed.hwnd() {
                    s.begin_take(hwnd);
                }
            }
        } else {
            s.finish_take(&run);
        }
    }
    Ok(json!({ "on": p.on }))
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
/// recording's last frame when there is one, else the addon's capture.
fn still(ctx: &Ctx) -> Result<Value, RpcError> {
    let s = live_session(ctx)?;
    if let Some(png) = s.still_png() {
        return Ok(json!({ "png": BASE64.encode(png), "source": "recording" }));
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
    }))
}

fn delete_take(ctx: &Ctx, p: &P) -> Result<Value, RpcError> {
    let dir = takes_dir(ctx)?;
    let id = take_id(p)?;
    if session(ctx).is_some_and(
        |s| matches!(s.take_state(), TakeState::Recording { id: ref now, .. } if *now == id),
    ) {
        return Err(fail("that take is still recording"));
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

/// Whether cluster `key`'s Play pane is on screen: the cluster is the one
/// some window shows, and a Play instance is the active tab of one of its
/// panes. Anything else (another tab, another cluster, a closed window)
/// hides the game, which keeps running.
pub fn play_shown(snapshot: &crate::shell_state::ShellSnapshot, key: &str) -> bool {
    use crate::layout::PaneNode;
    fn active(node: &PaneNode, out: &mut Vec<String>) {
        match node {
            PaneNode::Leaf { active_tab, .. } => out.extend(active_tab.clone()),
            PaneNode::Split { children, .. } => children.iter().for_each(|c| active(c, out)),
        }
    }
    snapshot.windows.iter().any(|w| {
        w.active_cluster_id.as_deref() == Some(key)
            && w.clusters.iter().filter(|c| c.id == key).any(|c| {
                let mut tabs = Vec::new();
                active(&c.tree, &mut tabs);
                tabs.iter().any(|tab| {
                    snapshot
                        .instances
                        .iter()
                        .any(|i| &i.id == tab && i.app_id == "play")
                })
            })
    })
}

/// Hide or show every running game after a change to the shell's state.
/// Called beside `plane_webview::sync_visibility`, for the same reasons.
pub fn sync_visibility(app: &tauri::AppHandle, snapshot: &crate::shell_state::ShellSnapshot) {
    use tauri::Manager;
    let godot = app.state::<super::Godot>();
    for (key, session) in godot.sessions() {
        if !session.embed.set_shown(play_shown(snapshot, &key)) {
            continue;
        }
        let label = godot.pane(&key).and_then(|p| p.window);
        if let Some(owner) = super::rpc::owner_of(app, label.as_deref()) {
            session.embed.reapply(&owner);
        }
    }
}

/// The `live` part of `play/state`.
pub fn state(ctx: &Ctx, key_since: u64) -> Value {
    let run = ctx.godot.runner.get(&ctx.key);
    let s = run
        .as_ref()
        .and_then(|r| ctx.godot.session(&ctx.key).filter(|s| s.run_id == r.id));
    let project = pick_project_for(ctx, None).ok();
    let blocked = project.as_ref().and_then(|p| record_blocked(ctx, &p.dir));
    let record = json!({
        "on": record_on(ctx),
        "blocked": blocked,
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
            "keys": s.keys_since(key_since),
            "ticks": s.ticks(),
            "addon": s.channel.as_deref().and_then(super::addon::running_version),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::PaneNode;
    use crate::shell_state::{
        Cluster, ShellSnapshot, SurfaceInstance, SurfaceKind, WindowPlacement,
    };

    fn snapshot(active_cluster: &str, active_tab: &str) -> ShellSnapshot {
        let cluster = |id: &str| Cluster {
            id: id.to_string(),
            name: id.to_string(),
            tree: PaneNode::Leaf {
                id: format!("{id}-pane"),
                tabs: vec![format!("{id}-play"), format!("{id}-files")],
                active_tab: Some(format!("{id}-{active_tab}")),
            },
            project: None,
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: None,
            pinned: false,
            icon: None,
            environment_missing: false,
        };
        let instance = |id: &str, app: &str| SurfaceInstance {
            id: id.to_string(),
            app_id: app.to_string(),
            kind: SurfaceKind::App,
            title: app.to_string(),
        };
        ShellSnapshot {
            windows: vec![WindowPlacement {
                label: "main".into(),
                clusters: vec![cluster("c1"), cluster("c2")],
                active_cluster_id: Some(active_cluster.to_string()),
                geometry: None,
                right_page: None,
            }],
            instances: ["c1", "c2"]
                .iter()
                .flat_map(|c| {
                    [
                        instance(&format!("{c}-play"), "play"),
                        instance(&format!("{c}-files"), "files"),
                    ]
                })
                .collect(),
            terminals: Vec::new(),
        }
    }

    #[test]
    fn the_game_shows_only_with_its_cluster_on_screen_and_play_the_active_tab() {
        assert!(play_shown(&snapshot("c1", "play"), "c1"));
        assert!(!play_shown(&snapshot("c1", "files"), "c1"), "another tab");
        assert!(
            !play_shown(&snapshot("c2", "play"), "c1"),
            "another cluster"
        );
        assert!(
            !play_shown(&snapshot("c1", "play"), "c9"),
            "no such cluster"
        );
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
