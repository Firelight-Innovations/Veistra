//! Every window placed over a pane, in one registry: one code path for the
//! game, the Godot editor and Blender (design §11.1). Keyed by the pane
//! instance that shows a window and its [`Kind`] ([`Slot`]), never by cluster
//! or app id, so Play in two panes and Play inside the Godot app both work.
//! Visibility, moves, Pop out and Dock, and release at exit walk this list.
//!
//! **Hosting a window**, as `godot::rpc::start_run` and `godot::editor` do:
//! 1. Size and place the launch from the pane's last box: [`Hosts::box_of`]
//!    then [`super::launch_rect`], so the window starts where the pane is.
//! 2. Spawn it (a game supervised, `CREATE_NO_WINDOW` for a console program
//!    so no console window can be matched; an editor detached, to outlive
//!    Veistra), then [`Hosts::host`] with a [`HostSpec`]: instance, cluster,
//!    an [`Embed`] from [`Hosts::embed`], process ids, an alive check, what
//!    to do once it is placed, and what to do when its pane closes ([`Orphan`]).
//! 3. The pane reports its box with `embed/rect {kind, x, y, w, h, visible,
//!    window, dpr}` (the game's is `play/embed-rect`) through
//!    `apps/shared/useNativeBox.ts`, shows `embed/still` while an overlay
//!    covers it, and has `embed/pop-out`, `embed/dock` and `embed/state`
//!    ([`call`]). An editor is never killed: [`Orphan::Release`] and
//!    [`release_all`] hand it back decorated, so unsaved work survives.

use super::{Cause, CssRect, Embed, Kind, Last, Owner, OwnerFn, State, WindowSystem, SUPPORTED};
use crate::shell_state::{ShellSnapshot, SurfaceInstance};
use crate::sync::MutexExt;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The environment variable that turns placing off, to see the fallback on a
/// machine where embedding works (§13 test 9): `VEISTRA_EMBED=off`.
pub const SWITCH_ENV: &str = "VEISTRA_EMBED";

/// A pane's last box, kept between runs so a window is launched at its size.
#[derive(Debug, Clone, PartialEq)]
pub struct Pane {
    pub rect: CssRect,
    pub visible: bool,
    /// The Veistra window the pane is in, as the shell named it to the page.
    pub window: Option<String>,
    /// The page's `devicePixelRatio`, monitor scale times View zoom.
    pub dpr: Option<f64>,
}

impl Pane {
    pub fn last(&self) -> Last {
        Last {
            rect: self.rect,
            visible: self.visible,
            dpr: self.dpr,
        }
    }
}

/// Where a window is shown: the pane instance and the kind, because one
/// Godot pane can hold its editor and, in Play mode, its game.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Slot {
    pub instance: String,
    pub kind: Kind,
}

impl Slot {
    pub fn new(instance: &str, kind: Kind) -> Self {
        Self {
            instance: instance.to_string(),
            kind,
        }
    }
}

/// What happens to a window whose pane instance has closed.
pub enum Orphan {
    /// Hand it back as a normal decorated window. Every editor: it may hold
    /// unsaved work, and Veistra never closes it for the person. Unused until
    /// the Godot editor and Blender are hosted (#316, #317).
    #[allow(dead_code)]
    Release,
    /// Something of the host's own, on a thread of its own. The game: its run
    /// is stopped, as it is at exit, its take saved first.
    Stop(Box<dyn Fn() + Send + Sync>),
}

/// What [`Hosts::host`] needs to know about a window it will place.
pub struct HostSpec {
    /// The pane instance that shows it; `None` for one started with no pane
    /// open (an agent's `play/run`), which keeps its own window until a pane
    /// claims it: [`Embed::rejoin`] before the window shows, [`Embed::dock`]
    /// after.
    pub instance: Option<String>,
    pub cluster: String,
    /// From [`Hosts::embed`], so the host can hold it before the window exists.
    pub embed: Arc<Embed>,
    /// The process and everything below it, asked again on every look.
    pub pids: Box<dyn Fn() -> Vec<u32> + Send + Sync>,
    pub alive: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Once the search ends: the window, or `None` when none came.
    pub on_attached: Option<Box<dyn FnOnce(Option<isize>) + Send>>,
    pub on_orphan: Orphan,
}

/// One registered window.
pub struct Hosted {
    pub kind: Kind,
    pub cluster: String,
    instance: Mutex<Option<String>>,
    pub embed: Arc<Embed>,
    alive: Arc<dyn Fn() -> bool + Send + Sync>,
    on_orphan: Orphan,
    orphaned: AtomicBool,
}

impl Hosted {
    pub fn instance(&self) -> Option<String> {
        self.instance.lock_or_panic().clone()
    }

    pub fn is_alive(&self) -> bool {
        (self.alive)()
    }

    fn slot(&self) -> Option<Slot> {
        self.instance().map(|instance| Slot {
            instance,
            kind: self.kind,
        })
    }

    /// Back to a normal window, if it is in a pane. A popped-out or own
    /// window is already the person's.
    fn release(&self, owner: Option<&Owner>) {
        if self.embed.state() != State::Embedded {
            return;
        }
        if let Err(e) = self.embed.pop_out(owner) {
            crate::veistra_log!("embed: could not hand back {}: {e}", self.kind.what());
        }
    }
}

/// The registry, managed by Tauri. Boxes are shared with the threads that
/// wait for a window, which read the pane's window label when it appears.
pub struct Hosts {
    win: Arc<dyn WindowSystem>,
    supported: bool,
    forced_off: bool,
    hosted: Mutex<Vec<Arc<Hosted>>>,
    boxes: Arc<Mutex<HashMap<Slot, Pane>>>,
}

impl Default for Hosts {
    fn default() -> Self {
        let off = std::env::var(SWITCH_ENV).is_ok_and(|v| v.eq_ignore_ascii_case("off"));
        Self::with(super::native(), SUPPORTED, off)
    }
}

fn window_of(boxes: &Mutex<HashMap<Slot, Pane>>, hosted: &Hosted) -> Option<String> {
    let slot = hosted.slot()?;
    boxes.lock_or_panic().get(&slot)?.window.clone()
}

impl Hosts {
    pub fn with(win: Arc<dyn WindowSystem>, supported: bool, forced_off: bool) -> Self {
        Self {
            win,
            supported,
            forced_off,
            hosted: Mutex::new(Vec::new()),
            boxes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Whether this registry can place a window in a pane at all: the
    /// platform's answer ([`SUPPORTED`]), or a test's. `VEISTRA_EMBED=off` is
    /// not part of it, since the fallback it shows is per window.
    pub fn supported(&self) -> bool {
        self.supported
    }

    /// An embed for a window of `kind`, placed by this registry's window system.
    pub fn embed(&self, kind: Kind) -> Arc<Embed> {
        Arc::new(Embed::with(self.win.clone(), kind))
    }

    pub fn box_of(&self, slot: &Slot) -> Option<Pane> {
        self.boxes.lock_or_panic().get(slot).cloned()
    }

    /// A pane's newest box, kept for the next launch and handed to the window
    /// in that slot if there is one. A box with no `window` keeps the one the
    /// pane last named: only the shell knows it, so a page that has not heard
    /// from the shell sends none, and taking that for `main` would re-own the
    /// window to `main`, over `main`'s UI.
    pub fn report_box(
        &self,
        slot: &Slot,
        asked: Last,
        window: Option<String>,
        owner_of: &OwnerFn,
    ) -> Pane {
        let pane = {
            let mut boxes = self.boxes.lock_or_panic();
            let old = boxes.get(slot).cloned();
            let last = Last::then(old.as_ref().map(Pane::last), asked);
            let pane = Pane {
                rect: last.rect,
                visible: last.visible,
                window: window.or_else(|| old.and_then(|o| o.window)),
                dpr: last.dpr,
            };
            boxes.insert(slot.clone(), pane.clone());
            pane
        };
        if let Some(hosted) = self.get(slot) {
            let owner = owner_of(pane.window.as_deref());
            hosted.embed.set_rect(asked, owner.as_ref());
        }
        pane
    }

    /// Register a window and start looking for it on a thread of its own.
    /// `shown` is whether the pane is on screen now, [`shown`] of the shell's
    /// state: a window started by an agent while its pane is another tab must
    /// not appear over that tab first.
    pub fn host(&self, owner_of: OwnerFn, shown: bool, spec: HostSpec) -> Arc<Hosted> {
        let HostSpec {
            instance,
            cluster,
            embed,
            pids,
            alive,
            on_attached,
            on_orphan,
        } = spec;
        let kind = embed.kind();
        if let Some(pane) = instance
            .as_deref()
            .and_then(|i| self.box_of(&Slot::new(i, kind)))
        {
            embed.set_rect(pane.last(), None);
        }
        embed.set_shown(shown && instance.is_some());
        let own = if self.forced_off {
            Some(Cause::Forced)
        } else if instance.is_none() {
            Some(Cause::NoPane)
        } else {
            None
        };
        let hosted = Arc::new(Hosted {
            kind,
            cluster,
            instance: Mutex::new(instance),
            embed: embed.clone(),
            alive: alive.clone(),
            on_orphan,
            orphaned: AtomicBool::new(false),
        });
        {
            let mut all = self.hosted.lock_or_panic();
            all.retain(|h| h.is_alive());
            all.push(hosted.clone());
        }
        if !self.supported {
            embed.give_up(Cause::Unsupported);
            if let Some(attached) = on_attached {
                attached(None);
            }
            return hosted;
        }
        // Here rather than on the thread: a pane that claims the window
        // meanwhile must find it already waiting for one ([`Embed::rejoin`]).
        if let Some(cause) = own {
            embed.give_up(cause);
        }
        let (boxes, who) = (self.boxes.clone(), hosted.clone());
        std::thread::spawn(move || {
            let owner = || owner_of(window_of(&boxes, &who).as_deref());
            let hwnd = embed.attach(None, &*pids, &owner, &*alive);
            if let Some(attached) = on_attached {
                attached(hwnd);
            }
        });
        hosted
    }

    fn live(&self) -> Vec<Arc<Hosted>> {
        let mut all = self.hosted.lock_or_panic();
        all.retain(|h| h.is_alive());
        all.clone()
    }

    /// The window shown in `slot`, newest first.
    pub fn get(&self, slot: &Slot) -> Option<Arc<Hosted>> {
        self.live()
            .into_iter()
            .rev()
            .find(|h| h.kind == slot.kind && h.instance().as_deref() == Some(&slot.instance))
    }

    /// The registration holding `embed`, for a caller that kept the embed.
    pub fn hosting(&self, embed: &Arc<Embed>) -> Option<Arc<Hosted>> {
        self.live()
            .into_iter()
            .find(|h| Arc::ptr_eq(&h.embed, embed))
    }

    /// `instance` takes `hosted` over: the game belongs to the Play pane that
    /// last sent `visible: true` for it, so Play in two panes of one cluster
    /// hands the game between them. The new pane's box comes with it.
    pub fn claim(&self, hosted: &Hosted, instance: &str, shown: bool) {
        {
            let mut now = hosted.instance.lock_or_panic();
            if now.as_deref() == Some(instance) {
                return;
            }
            *now = Some(instance.to_string());
        }
        hosted.embed.set_shown(shown);
        if let Some(pane) = self.box_of(&Slot::new(instance, hosted.kind)) {
            hosted.embed.set_rect(pane.last(), None);
        }
    }

    /// The Veistra window `hosted`'s pane is in.
    pub fn owner_for(&self, hosted: &Hosted, owner_of: &OwnerFn) -> Option<Owner> {
        owner_of(window_of(&self.boxes, hosted).as_deref())
    }

    /// After every change to the shell's state: hide or show each window with
    /// its pane, and let go of one whose pane instance has closed. Called
    /// from `ShellState::mutate` on the main thread, so a release or stop
    /// runs on a thread of its own.
    pub fn sync_visibility(&self, snapshot: &ShellSnapshot, owner_of: &OwnerFn) {
        let open = |id: &str| snapshot.instances.iter().any(|i| i.id == id);
        for hosted in self.live() {
            let Some(slot) = hosted.slot() else {
                continue;
            };
            if !open(&slot.instance) {
                self.orphan(&hosted, owner_of);
                continue;
            }
            if hosted.embed.set_shown(shown(snapshot, &slot.instance)) {
                if let Some(owner) = self.owner_for(&hosted, owner_of) {
                    hosted.embed.reapply(&owner);
                }
            }
        }
        self.boxes
            .lock_or_panic()
            .retain(|slot, _| open(&slot.instance));
    }

    fn orphan(&self, hosted: &Arc<Hosted>, owner_of: &OwnerFn) {
        if hosted.orphaned.swap(true, Ordering::SeqCst) {
            return;
        }
        self.hosted
            .lock_or_panic()
            .retain(|h| !Arc::ptr_eq(h, hosted));
        let owner = self.owner_for(hosted, owner_of);
        let hosted = hosted.clone();
        std::thread::spawn(move || match &hosted.on_orphan {
            Orphan::Release => hosted.release(owner.as_ref()),
            Orphan::Stop(stop) => stop(),
        });
    }

    /// Put every placed window back over its pane: the Veistra window moved,
    /// and an owned window does not move with its owner.
    pub fn reposition_all(&self, owner_of: &OwnerFn) {
        for hosted in self.live() {
            if let Some(owner) = self.owner_for(&hosted, owner_of) {
                hosted.embed.reapply(&owner);
            }
        }
    }

    /// At exit: every editor handed back as a normal window, never killed.
    /// The game is left to `Godot::shutdown`, which saves its take and stops
    /// it. Waits a little for each, on threads, so a hung editor cannot hold
    /// Veistra's exit.
    pub fn release_all(&self, owner_of: &OwnerFn) {
        let (done, wait) = std::sync::mpsc::channel();
        let mut count = 0;
        for hosted in self.live().into_iter().filter(|h| h.kind != Kind::Game) {
            let owner = self.owner_for(&hosted, owner_of);
            let done = done.clone();
            count += 1;
            std::thread::spawn(move || {
                hosted.release(owner.as_ref());
                let _ = done.send(());
            });
        }
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        for _ in 0..count {
            let left = until.saturating_duration_since(std::time::Instant::now());
            if wait.recv_timeout(left).is_err() {
                break;
            }
        }
    }

    /// Every placed window for `veistra-debug`'s `shell_snapshot`.
    pub fn report(&self) -> Value {
        Value::Array(
            self.live()
                .iter()
                .map(|h| {
                    let mut v = h.embed.report();
                    v["instance"] = json!(h.instance());
                    v["cluster"] = json!(h.cluster);
                    v
                })
                .collect(),
        )
    }
}

/// Whether `instance` is on screen: the active tab of a pane in a cluster
/// that some window shows. Anything else (another tab, another cluster, a
/// closed window) hides its window, whose process keeps running.
pub fn shown(snapshot: &ShellSnapshot, instance: &str) -> bool {
    use crate::layout::PaneNode;
    fn active(node: &PaneNode, instance: &str) -> bool {
        match node {
            PaneNode::Leaf { active_tab, .. } => active_tab.as_deref() == Some(instance),
            PaneNode::Split { children, .. } => children.iter().any(|c| active(c, instance)),
        }
    }
    snapshot.windows.iter().any(|w| {
        w.clusters
            .iter()
            .filter(|c| w.active_cluster_id.as_deref() == Some(c.id.as_str()))
            .any(|c| active(&c.tree, instance))
    })
}

/// The pane a call with no instance of its own stands for (an agent's
/// `app_call`): the cluster's instance that `wanted` accepts, preferring one
/// on screen, then the first in the cluster's tree.
pub fn instance_for(
    snapshot: &ShellSnapshot,
    cluster: &str,
    wanted: &dyn Fn(&SurfaceInstance) -> bool,
) -> Option<String> {
    let tree = snapshot
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.id == cluster)
        .map(|c| c.tree.tabs())?;
    let ours: Vec<&str> = tree
        .into_iter()
        .filter(|tab| snapshot.instances.iter().any(|i| i.id == *tab && wanted(i)))
        .collect();
    ours.iter()
        .find(|tab| shown(snapshot, tab))
        .or_else(|| ours.first())
        .map(|tab| tab.to_string())
}

// --- the box, from a page ----------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BoxParams {
    kind: Option<Kind>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    window: Option<String>,
    dpr: Option<f64>,
}

fn params(raw: Option<&Value>) -> Result<BoxParams, RpcError> {
    match raw {
        None | Some(Value::Null) => Ok(BoxParams::default()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}"))),
    }
}

/// A box message, checked: `{x, y, w, h, visible, window?, dpr?}` in window
/// CSS pixels. Leaving a live view sends `visible: false` with any box, 0 x 0
/// included, and [`Last::then`] keeps the old box then.
pub fn parse_box(raw: Option<&Value>) -> Result<(Last, Option<String>), RpcError> {
    let p = params(raw)?;
    if ![p.x, p.y, p.w, p.h].iter().all(|v| v.is_finite()) || p.w < 0.0 || p.h < 0.0 {
        return Err(RpcError::new(INVALID_PARAMS, "the box needs x, y, w and h"));
    }
    let last = Last {
        rect: CssRect {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
        },
        visible: p.visible,
        dpr: p.dpr.filter(|d| d.is_finite() && *d > 0.0),
    };
    Ok((last, p.window))
}

/// Whether `method` is one of the host-answered `embed/*` methods.
pub fn is_method(method: &str) -> bool {
    method.starts_with("embed/")
}

fn fail(message: impl Into<String>) -> RpcError {
    RpcError::new(INTERNAL_ERROR, message.into())
}

/// `embed/*` for a pane whose app places an editor (C1's Godot editor, C2's
/// Blender). The game's box has its own methods (`play/embed-rect`,
/// `play/pop-out`, `play/dock`), because Play takes and saves takes around
/// them, so `kind: "game"` is refused here. Pure, so it is tested without an
/// app; [`call`] supplies the registry.
pub fn answer(
    hosts: &Hosts,
    owner_of: &OwnerFn,
    instance: Option<&str>,
    method: &str,
    raw: Option<&Value>,
) -> Result<Value, RpcError> {
    let kind = params(raw)?
        .kind
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "`kind` is required"))?;
    if kind == Kind::Game {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "the game's box is play/embed-rect, and Pop out and Dock are play/pop-out and play/dock",
        ));
    }
    let instance =
        instance.ok_or_else(|| fail("embed methods are for a pane; this call names none"))?;
    let slot = Slot::new(instance, kind);
    let hosted = hosts.get(&slot);
    let state = |h: &Option<Arc<Hosted>>| {
        let embed = h.as_ref().map(|h| h.embed.state());
        json!({ "embed": embed, "embedded": embed == Some(State::Embedded) })
    };
    match method {
        "embed/rect" => {
            let (asked, window) = parse_box(raw)?;
            hosts.report_box(&slot, asked, window, owner_of);
            Ok(json!({ "ok": true }))
        }
        "embed/state" => Ok(state(&hosted)),
        "embed/still" => {
            let png = hosted
                .as_ref()
                .and_then(|h| h.embed.still_png())
                .ok_or_else(|| fail(format!("no frame of {} to show yet", kind.what())))?;
            Ok(json!({ "png": BASE64.encode(png), "source": "capture" }))
        }
        "embed/pop-out" | "embed/dock" => {
            let h = hosted
                .as_ref()
                .ok_or_else(|| fail(format!("{} is not open in this pane", kind.what())))?;
            let owner = hosts.owner_for(h, owner_of);
            if method == "embed/pop-out" {
                h.embed.pop_out(owner.as_ref()).map_err(fail)?;
            } else {
                let owner = owner.ok_or_else(|| fail("the Veistra window is not known"))?;
                h.embed.dock(&owner).map_err(fail)?;
            }
            Ok(state(&hosted))
        }
        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

// --- the live application ------------------------------------------------------

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
    SUPPORTED.then_some(Owner {
        hwnd,
        origin: (origin.x, origin.y),
        scale,
    })
}

pub fn owner_fn(app: &tauri::AppHandle) -> OwnerFn {
    let app = app.clone();
    Arc::new(move |label| owner_of(&app, label))
}

/// [`Hosts::sync_visibility`], from `ShellState::mutate`.
pub fn sync_visibility(app: &tauri::AppHandle, snapshot: &ShellSnapshot) {
    use tauri::Manager;
    app.state::<Hosts>()
        .sync_visibility(snapshot, &owner_fn(app));
}

/// [`Hosts::reposition_all`], from a Veistra window's move or resize.
pub fn reposition_all(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<Hosts>().reposition_all(&owner_fn(app));
}

/// [`Hosts::release_all`], at exit.
pub fn release_all(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<Hosts>().release_all(&owner_fn(app));
}

/// `embed/*` from a pane, routed by `apps::call` for an app that places a
/// window.
pub fn call(
    app: &tauri::AppHandle,
    instance: Option<&str>,
    method: &str,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    use tauri::Manager;
    answer(
        &app.state::<Hosts>(),
        &owner_fn(app),
        instance,
        method,
        params,
    )
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
