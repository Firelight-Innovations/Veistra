//! Placing another process's window over a pane (design §4 and §11.1): the
//! game Play runs, the Godot editor and Blender. Each stays its own process,
//! so a crash in it never takes Veistra down, and window management makes it
//! look embedded, the way Godot 4.4's own editor shows a running game.
//!
//! **R2, an owned popup, not R1, a child window.** The placed window stays
//! top level: no caption or borders, `WS_EX_TOOLWINDOW` so it has no taskbar
//! entry, and owned by the Veistra window, which keeps it above Veistra and
//! hides it with Veistra when Veistra is minimised. The cost is repositioning
//! on every move of the Veistra window ([`host::reposition_all`]). What it
//! buys is that the recorder and the still ([`capture`]) capture that window
//! alone, never Veistra's UI. The R1/R2 row in `docs/design-notes/godot-play.md`
//! waits on the embed spike (`godot/spike.rs`); R1 would change only [`sys`].
//!
//! [`host`] is the registry all three kinds go through, and its module doc is
//! the API for an app that hosts a window. This file is one window: finding
//! it, placing it, Pop out and Dock, and the fallback when it cannot be placed
//! (§4.5). Everything but [`sys`] is arithmetic and state, tested on any host
//! through a fake [`WindowSystem`]; [`sys`] is Win32 on Windows and a refusal
//! elsewhere.

pub mod capture;
pub mod host;

use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, Mutex, Once, PoisonError};
use std::time::{Duration, Instant};

/// How often to look for the window while the wait lasts.
const POLL: Duration = Duration::from_millis(100);

/// How often to look for a window that shows only after the wait: it is not
/// placed then (§4.2.2), only brought on screen.
const LATE_POLL: Duration = Duration::from_millis(500);

/// What a placed window is. One code path serves all three; the kind picks
/// how long to look for the window, which class to prefer, and what the pane
/// says when the window keeps its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Game,
    GodotEditor,
    Blender,
}

impl Kind {
    /// How long to look before giving up on placing it. An editor opening a
    /// large project imports first and shows nothing for a while.
    pub fn find_for(self) -> Duration {
        match self {
            Kind::Game => Duration::from_secs(10),
            Kind::GodotEditor | Kind::Blender => Duration::from_secs(90),
        }
    }

    /// The class of its main window, preferred over any other window of the
    /// process: Godot 4's is `Engine`, game and editor alike, Blender's
    /// `GHOST_WindowClass`. Unverified on a real machine.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn classes(self) -> &'static [&'static str] {
        match self {
            Kind::Game | Kind::GodotEditor => &["Engine"],
            Kind::Blender => &["GHOST_WindowClass"],
        }
    }

    /// What the pane says when the window keeps its own (§4.5 for the game).
    pub fn own_window(self) -> &'static str {
        match self {
            Kind::Game => "Playing in its own window",
            Kind::GodotEditor | Kind::Blender => "Open in its own window",
        }
    }

    pub fn what(self) -> &'static str {
        match self {
            Kind::Game => "the game",
            Kind::GodotEditor => "the Godot editor",
            Kind::Blender => "Blender",
        }
    }
}

/// Windows never placed in a pane, whatever process owns them: a console and
/// the terminal host that draws one, and a message box, which has to stay one.
#[cfg_attr(not(windows), allow(dead_code))]
const NEVER: &[&str] = &[
    "ConsoleWindowClass",
    "PseudoConsoleWindow",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "#32770",
];

/// The window to place, out of a process tree's visible, unowned top-level
/// windows as `(handle, class)` in z-order: the first of the kind's own
/// class, else the first that is not one of [`NEVER`].
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pick(candidates: &[(isize, String)], kind: Kind) -> Option<isize> {
    let usable = || {
        candidates
            .iter()
            .filter(|(_, class)| !NEVER.contains(&class.as_str()))
    };
    usable()
        .find(|(_, class)| kind.classes().contains(&class.as_str()))
        .or_else(|| usable().next())
        .map(|(hwnd, _)| *hwnd)
}

/// A box in the Veistra window, in CSS pixels, as the pane measures it: the
/// shell's report of where the pane's iframe sits plus the box inside it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The same box on the screen, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The Veistra window a window is placed in: its handle, where its client
/// area (the WebView's top-left) is on the screen in physical pixels, and its
/// scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Owner {
    pub hwnd: isize,
    pub origin: (i32, i32),
    pub scale: f64,
}

/// Where a Veistra window is, by label (`None` for `main`). Shared with the
/// threads that wait for a window, hence `Arc`.
pub type OwnerFn = Arc<dyn Fn(Option<&str>) -> Option<Owner> + Send + Sync>;

/// Physical pixels per CSS pixel. The page's own `devicePixelRatio` includes
/// the WebView's zoom as well as the monitor's scale, which the window's
/// scale factor alone does not, so it wins whenever the page sent one.
pub fn scale_for(dpr: Option<f64>, window_scale: f64) -> f64 {
    match dpr {
        Some(d) if d.is_finite() && d > 0.0 => d,
        _ => window_scale,
    }
}

/// CSS pixels to physical screen pixels from the window's client `origin`.
/// Each edge is rounded on its own, so two boxes that share an edge in CSS
/// still share it on screen.
pub fn to_screen(css: CssRect, origin: (i32, i32), scale: f64) -> ScreenRect {
    let edge = |v: f64| (v * scale).round() as i32;
    let (left, top) = (edge(css.x), edge(css.y));
    let (right, bottom) = (edge(css.x + css.w), edge(css.y + css.h));
    ScreenRect {
        x: origin.0 + left,
        y: origin.1 + top,
        w: (right - left).max(1),
        h: (bottom - top).max(1),
    }
}

/// The physical size a window is first launched at: the pane's last box if
/// one is known, else 1280 x 720. Even numbers, because an H.264 encoder
/// refuses odd ones.
pub fn launch_size(css: Option<CssRect>, scale: f64) -> (u32, u32) {
    let even = |v: f64| ((v * scale).round() as u32).max(64) & !1;
    match css {
        Some(r) if r.w >= 32.0 && r.h >= 32.0 => (even(r.w), even(r.h)),
        _ => (1280, 720),
    }
}

/// Where and how big to launch a window that will be placed over a pane:
/// at the pane's own screen rect, so nothing flashes elsewhere first and a
/// window that is never placed is already where the person looks. `position`
/// is `None` with no box or no Veistra window to measure it against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchRect {
    pub width: u32,
    pub height: u32,
    pub position: Option<(i32, i32)>,
}

pub fn launch_rect(last: Option<Last>, owner: Option<&Owner>) -> LaunchRect {
    let scale = scale_for(last.and_then(|l| l.dpr), owner.map_or(1.0, |o| o.scale));
    let (width, height) = launch_size(last.map(|l| l.rect), scale);
    let position = match (last, owner) {
        (Some(l), Some(o)) if l.rect.w >= 1.0 && l.rect.h >= 1.0 => {
            let at = to_screen(l.rect, o.origin, scale);
            Some((at.x, at.y))
        }
        _ => None,
    };
    LaunchRect {
        width,
        height,
        position,
    }
}

/// What the pane last said: its box, whether to show the window, and the
/// page's `devicePixelRatio`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Last {
    pub rect: CssRect,
    pub visible: bool,
    pub dpr: Option<f64>,
}

impl Last {
    /// `next` on top of `self`. A hide with no real box (the pane leaving
    /// its live view sends 0 x 0) keeps the box it had, so Pop out and the
    /// next launch still know where the window was.
    pub fn then(previous: Option<Last>, next: Last) -> Last {
        let degenerate = next.rect.w < 1.0 || next.rect.h < 1.0;
        match previous {
            Some(old) if !next.visible && degenerate => Last {
                visible: false,
                ..old
            },
            _ => next,
        }
    }
}

/// Why a window keeps its own frame, as a code telemetry and C3's fallback
/// can read; the reason beside it is what the pane says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Cause {
    /// No embedder on this platform: everything but Windows today.
    Unsupported,
    /// `VEISTRA_EMBED=off`, to see the fallback where embedding works (§13 test 9).
    Forced,
    /// Nothing to place it over: started with no pane open for it.
    NoPane,
    /// No window within [`Kind::find_for`].
    NoWindow,
    /// The process ended before it showed a window.
    Exited,
    /// The Veistra window the pane is in is not known.
    NoOwner,
    /// Windows refused the style or owner change: an elevated process, UIPI.
    Refused,
    /// Embedded, but the first move failed, so it was handed back.
    PlaceFailed,
}

/// The pane's words for `cause`. Every one but [`Cause::Exited`] starts with
/// the kind's own-window line, which is what §4.5 asks the strip to say.
pub fn reason(kind: Kind, cause: Cause) -> String {
    let own = kind.own_window();
    match cause {
        Cause::Exited => {
            let what = kind.what();
            let mut first = what.chars();
            let what = first
                .next()
                .map(|c| c.to_uppercase().chain(first).collect::<String>())
                .unwrap_or_default();
            format!("{what} closed before it showed a window.")
        }
        Cause::Unsupported | Cause::NoOwner => format!("{own}."),
        Cause::Forced => format!("{own}: placing it in the pane is switched off (VEISTRA_EMBED)."),
        Cause::NoPane => format!("{own}: no pane was open to place it in."),
        Cause::NoWindow => format!(
            "{own}: it showed none within {} s to place here.",
            kind.find_for().as_secs()
        ),
        Cause::Refused => {
            format!(
                "{own}: Windows would not let Veistra place it (is it running as administrator?)."
            )
        }
        Cause::PlaceFailed => format!("{own}: it could not be moved over the pane."),
    }
}

/// Where the window is, as the pane shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum State {
    /// Looking for the window.
    Waiting,
    /// Over the pane.
    Embedded,
    /// Its own decorated window, because the person asked (Pop out).
    PoppedOut,
    /// Its own window because it could not be placed; `reason` is what the
    /// pane says, `cause` the code.
    OwnWindow { reason: String, cause: Cause },
}

/// A window's last frame, kept so the pane can show it while an overlay
/// covers the box: [`capture::Watcher`] on Windows.
pub trait Still: Send + Sync {
    fn png(&self) -> Option<Vec<u8>>;
}

/// What [`Embed`] asks of the window system: [`sys`] in the app, a fake in
/// the tests.
pub trait WindowSystem: Send + Sync {
    fn find_window(&self, pids: &[u32], kind: Kind) -> Option<isize>;
    fn embed(&self, hwnd: isize, owner: isize) -> Result<sys::Saved, String>;
    /// Move and size the window over `owner`, owned by it, or hide it.
    fn place(&self, hwnd: isize, at: ScreenRect, visible: bool, owner: isize)
        -> Result<(), String>;
    fn release(
        &self,
        hwnd: isize,
        saved: &sys::Saved,
        near: Option<ScreenRect>,
    ) -> Result<(), String>;
    /// Show a window that keeps its own frame over `near`, or where it is,
    /// without touching its styles: the fallback brings it on screen.
    fn show_near(&self, hwnd: isize, near: Option<ScreenRect>) -> Result<(), String>;
    /// Start keeping the window's last frame, or `None` where that cannot be
    /// done cleanly.
    fn watch(&self, hwnd: isize) -> Option<Box<dyn Still>>;
    /// Ask the window to close, as its own close button does. Returns once
    /// the request is posted; the program may ask to save, or refuse.
    fn request_close(&self, hwnd: isize) -> Result<(), String>;
}

struct Native;

impl WindowSystem for Native {
    fn find_window(&self, pids: &[u32], kind: Kind) -> Option<isize> {
        sys::find_window(pids, kind)
    }
    fn embed(&self, hwnd: isize, owner: isize) -> Result<sys::Saved, String> {
        sys::embed(hwnd, owner)
    }
    fn place(
        &self,
        hwnd: isize,
        at: ScreenRect,
        visible: bool,
        owner: isize,
    ) -> Result<(), String> {
        sys::place(hwnd, at, visible, owner)
    }
    fn release(
        &self,
        hwnd: isize,
        saved: &sys::Saved,
        near: Option<ScreenRect>,
    ) -> Result<(), String> {
        sys::release(hwnd, saved, near)
    }
    fn show_near(&self, hwnd: isize, near: Option<ScreenRect>) -> Result<(), String> {
        sys::show_near(hwnd, near)
    }
    fn watch(&self, hwnd: isize) -> Option<Box<dyn Still>> {
        capture::Watcher::start(hwnd).map(|w| Box::new(w) as Box<dyn Still>)
    }
    fn request_close(&self, hwnd: isize) -> Result<(), String> {
        sys::request_close(hwnd)
    }
}

/// The window system this build places windows with.
pub fn native() -> Arc<dyn WindowSystem> {
    Arc::new(Native)
}

/// One placement for the worker to make, and when it was asked for, so the
/// debug snapshot can say how long a move took to land (§13 test 1: 50 ms).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Placement {
    hwnd: isize,
    at: ScreenRect,
    visible: bool,
    owner: isize,
    asked: Instant,
}

#[derive(Default)]
struct Queue {
    /// The newest placement not yet made; a newer one replaces it.
    next: Option<Placement>,
    /// The embed is gone, so its worker ends.
    closed: bool,
}

/// The last placement made, for `veistra-debug`'s `shell_snapshot`.
#[derive(Debug, Clone, Copy)]
struct Placed {
    at: ScreenRect,
    visible: bool,
    ms: u64,
}

/// Called once, when the first attempt to place the window has an outcome.
type Settled = Box<dyn FnOnce(&State) + Send>;

/// What the embed and its worker thread share.
struct Inner {
    win: Arc<dyn WindowSystem>,
    kind: Kind,
    state: Mutex<State>,
    hwnd: Mutex<Option<isize>>,
    saved: Mutex<Option<sys::Saved>>,
    last: Mutex<Option<Last>>,
    /// Whether the shell shows the pane at all: its cluster on screen and
    /// the pane's instance its active tab ([`host::shown`]). Decided in Rust
    /// from the shell's state, because a hidden cluster's pane may not be
    /// running to say so itself.
    shown: Mutex<bool>,
    queue: Mutex<Queue>,
    wake: Condvar,
    /// Held across every call into the window system, so a placement the
    /// worker is making cannot land after Pop out has released the window.
    /// Never taken on the main thread.
    ops: Mutex<()>,
    still: Mutex<Option<Box<dyn Still>>>,
    placed: Mutex<Option<Placed>>,
    settled: Mutex<Option<Settled>>,
    /// When the wait for the window began: the attach, or the pane that
    /// rejoined it ([`Embed::rejoin`]). [`Kind::find_for`] counts from here,
    /// because time with no pane open had nothing to place the window in.
    since: Mutex<Instant>,
}

impl Inner {
    fn state(&self) -> State {
        self.state.lock_or_panic().clone()
    }

    fn hwnd(&self) -> Option<isize> {
        *self.hwnd.lock_or_panic()
    }

    fn place(&self, p: &Placement) -> Result<(), String> {
        self.win.place(p.hwnd, p.at, p.visible, p.owner)?;
        *self.placed.lock_or_panic() = Some(Placed {
            at: p.at,
            visible: p.visible,
            ms: p.asked.elapsed().as_millis() as u64,
        });
        Ok(())
    }

    fn work(&self) {
        loop {
            let next = {
                let mut queue = self.queue.lock_or_panic();
                loop {
                    if queue.closed {
                        return;
                    }
                    if let Some(p) = queue.next.take() {
                        break p;
                    }
                    queue = self
                        .wake
                        .wait(queue)
                        .unwrap_or_else(PoisonError::into_inner);
                }
            };
            let _ops = self.ops.lock_or_panic();
            if self.state() != State::Embedded || self.hwnd() != Some(next.hwnd) {
                continue;
            }
            if let Err(e) = self.place(&next) {
                crate::veistra_log!("embed: could not move {}: {e}", self.kind.what());
            }
        }
    }
}

/// One placed window and what was last asked of it.
///
/// **Placing never blocks the main thread.** Moving another process's window
/// waits for that process to handle the move, and a game stuck in a loop never
/// does. Window moves and tab switches arrive on Veistra's main thread, so
/// [`Embed::reapply`] only records the newest placement and a thread of the
/// embed's own makes it. `SWP_ASYNCWINDOWPOS` alone was rejected: it stops
/// being asynchronous once the owner link has joined the two input queues.
/// Attach and Dock never run on the main thread, and make their first
/// placement themselves, so the window has the pane's size when a take starts;
/// having the take wait for the worker instead was rejected as a counter and
/// a timeout to buy the same order.
pub struct Embed {
    inner: Arc<Inner>,
    worker: Once,
}

impl Default for Embed {
    fn default() -> Self {
        Self::with(native(), Kind::Game)
    }
}

impl Drop for Embed {
    fn drop(&mut self) {
        self.inner.queue.lock_or_panic().closed = true;
        self.inner.wake.notify_all();
    }
}

impl Embed {
    pub fn with(win: Arc<dyn WindowSystem>, kind: Kind) -> Self {
        Self {
            inner: Arc::new(Inner {
                win,
                kind,
                state: Mutex::new(State::Waiting),
                hwnd: Mutex::new(None),
                saved: Mutex::new(None),
                last: Mutex::new(None),
                shown: Mutex::new(true),
                queue: Mutex::new(Queue::default()),
                wake: Condvar::new(),
                ops: Mutex::new(()),
                still: Mutex::new(None),
                placed: Mutex::new(None),
                settled: Mutex::new(None),
                since: Mutex::new(Instant::now()),
            }),
            worker: Once::new(),
        }
    }

    pub fn kind(&self) -> Kind {
        self.inner.kind
    }

    pub fn state(&self) -> State {
        self.inner.state()
    }

    pub fn hwnd(&self) -> Option<isize> {
        self.inner.hwnd()
    }

    fn set(&self, state: State) {
        *self.inner.state.lock_or_panic() = state;
    }

    fn own_window(&self, cause: Cause) {
        self.set(State::OwnWindow {
            reason: reason(self.inner.kind, cause),
            cause,
        });
    }

    /// Run `f` once the first attempt to place the window has an outcome:
    /// placed, or kept in its own window and why. Where the outcome is
    /// decided is where the game's `play_embedded` and `play_embed_failed`
    /// are reported from.
    pub fn when_settled(&self, f: Settled) {
        *self.inner.settled.lock_or_panic() = Some(f);
    }

    fn settle(&self) {
        let hook = self.inner.settled.lock_or_panic().take();
        if let Some(hook) = hook {
            hook(&self.state());
        }
    }

    /// Leave the window in its own frame, saying why, without looking for it:
    /// a platform with no embedder. No pane is not an outcome: nothing was
    /// tried, and the pane that later shows the window ([`Self::rejoin`],
    /// [`Self::dock`]) has the first one.
    pub fn give_up(&self, cause: Cause) {
        self.own_window(cause);
        if cause != Cause::NoPane {
            self.settle();
        }
    }

    /// The process ended: its window is gone, so nothing may be sent to the
    /// handle again (Windows reuses handle values). The state stays, for the
    /// pane's last word on where the window was.
    pub fn forget(&self) {
        let _ops = self.inner.ops.lock_or_panic();
        *self.inner.hwnd.lock_or_panic() = None;
        self.inner.queue.lock_or_panic().next = None;
        self.inner.still.lock_or_panic().take();
    }

    /// Where the pane last was on the screen, against `owner`.
    fn near(&self, owner: &Owner) -> Option<ScreenRect> {
        self.last()
            .map(|l| to_screen(l.rect, owner.origin, scale_for(l.dpr, owner.scale)))
    }

    /// Find the window of `pids` (the process and anything it started) and
    /// place it over the pane, or keep it in its own frame and say why.
    /// Blocks for up to [`Kind::find_for`] and the first placement; after that,
    /// a window that shows late is brought on screen, never placed, and this
    /// returns once it does or the process exits. `own` skips placing for a
    /// cause known up front (forced off, or no pane). `owner` is asked once
    /// the window exists, because Veistra may have moved meanwhile.
    pub fn attach(
        &self,
        own: Option<Cause>,
        pids: &dyn Fn() -> Vec<u32>,
        owner: &dyn Fn() -> Option<Owner>,
        alive: &dyn Fn() -> bool,
    ) -> Option<isize> {
        self.attach_within(self.inner.kind.find_for(), own, pids, owner, alive)
    }

    fn attach_within(
        &self,
        wait: Duration,
        own: Option<Cause>,
        pids: &dyn Fn() -> Vec<u32>,
        owner: &dyn Fn() -> Option<Owner>,
        alive: &dyn Fn() -> bool,
    ) -> Option<isize> {
        if let Some(cause) = own {
            self.give_up(cause);
        }
        *self.inner.since.lock_or_panic() = Instant::now();
        let hwnd = loop {
            if let Some(hwnd) = self.inner.win.find_window(&pids(), self.inner.kind) {
                break hwnd;
            }
            if !alive() {
                if self.state() == State::Waiting {
                    self.own_window(Cause::Exited);
                }
                self.settle();
                return None;
            }
            let (late, gave_up) = {
                // Under `ops`, so a pane rejoining now restarts the wait
                // before it is judged over.
                let _ops = self.inner.ops.lock_or_panic();
                let late = self.inner.since.lock_or_panic().elapsed() > wait;
                let gave_up = late && self.state() == State::Waiting;
                if gave_up {
                    self.own_window(Cause::NoWindow);
                }
                (late, gave_up)
            };
            if gave_up {
                self.settle();
            }
            std::thread::sleep(if late { LATE_POLL } else { POLL });
        };
        {
            // Under `ops` from here to the decision, so a pane claiming the
            // window ([`Self::rejoin`]) is either seen here or sees the window.
            let _ops = self.inner.ops.lock_or_panic();
            *self.inner.hwnd.lock_or_panic() = Some(hwnd);
            if self.state() != State::Waiting {
                self.show_own(hwnd, owner().as_ref());
                return Some(hwnd);
            }
            match owner() {
                Some(owner) => {
                    self.embed_now(hwnd, &owner, Cause::Refused);
                }
                None => {
                    self.own_window(Cause::NoOwner);
                    self.show_own(hwnd, None);
                }
            }
        }
        self.settle();
        Some(hwnd)
    }

    /// A pane opened for a window started with no pane open, before the
    /// window showed: look for it as though the pane had been there from the
    /// start, so it is placed the moment it appears, and give it the whole
    /// wait from now. `false` once the window exists, which [`Self::dock`]
    /// places, or for one not waiting for a pane.
    pub fn rejoin(&self) -> bool {
        let _ops = self.inner.ops.lock_or_panic();
        let no_pane = matches!(
            self.state(),
            State::OwnWindow {
                cause: Cause::NoPane,
                ..
            }
        );
        if !no_pane || self.hwnd().is_some() {
            return false;
        }
        *self.inner.since.lock_or_panic() = Instant::now();
        self.set(State::Waiting);
        true
    }

    /// Bring a window that is not going to be placed on screen, over the pane
    /// when that is known: it was launched there, but a window that was
    /// stripped and then refused, or that Godot moved, may not be.
    fn show_own(&self, hwnd: isize, owner: Option<&Owner>) {
        let near = owner.and_then(|o| self.near(o));
        if let Err(e) = self.inner.win.show_near(hwnd, near) {
            crate::veistra_log!("embed: could not show {}: {e}", self.inner.kind.what());
        }
    }

    /// Strip, own and place `hwnd`, with `ops` held; on any failure leave it
    /// decorated and on screen, saying `refused` for a refused embed. Answers
    /// whether it is in the pane.
    fn embed_now(&self, hwnd: isize, owner: &Owner, refused: Cause) -> bool {
        let saved = match self.inner.win.embed(hwnd, owner.hwnd) {
            Ok(saved) => saved,
            Err(e) => {
                crate::veistra_log!("embed: could not place {}: {e}", self.inner.kind.what());
                self.own_window(refused);
                self.show_own(hwnd, Some(owner));
                return false;
            }
        };
        *self.inner.saved.lock_or_panic() = Some(saved.clone());
        self.set(State::Embedded);
        if let Err(e) = self.place_now(owner) {
            crate::veistra_log!("embed: could not move {}: {e}", self.inner.kind.what());
            if let Err(e) = self.inner.win.release(hwnd, &saved, self.near(owner)) {
                crate::veistra_log!("embed: could not give back {}: {e}", self.inner.kind.what());
            }
            self.own_window(Cause::PlaceFailed);
            return false;
        }
        *self.inner.still.lock_or_panic() = self.inner.win.watch(hwnd);
        true
    }

    /// The pane's newest box. Kept even before the window is found, so the
    /// window lands in the right place the moment it is.
    pub fn set_rect(&self, next: Last, owner: Option<&Owner>) {
        {
            let mut last = self.inner.last.lock_or_panic();
            *last = Some(Last::then(*last, next));
        }
        if let Some(owner) = owner {
            self.reapply(owner);
        }
    }

    /// The shell showed or hid the pane. Answers whether that changed anything.
    pub fn set_shown(&self, shown: bool) -> bool {
        let mut now = self.inner.shown.lock_or_panic();
        let changed = *now != shown;
        *now = shown;
        changed
    }

    pub fn shown(&self) -> bool {
        *self.inner.shown.lock_or_panic()
    }

    pub fn last(&self) -> Option<Last> {
        *self.inner.last.lock_or_panic()
    }

    /// Where the pane last said, against `owner`; `None` unless embedded,
    /// because a popped-out or own window is the person's to move. Callers
    /// hold the queue while working it out, so a placement queued later was
    /// worked out from a box at least as new.
    fn placement(&self, owner: &Owner) -> Option<Placement> {
        if self.state() != State::Embedded {
            return None;
        }
        let (hwnd, last) = (self.hwnd()?, self.last()?);
        let shown = self.shown();
        Some(Placement {
            hwnd,
            at: to_screen(last.rect, owner.origin, scale_for(last.dpr, owner.scale)),
            visible: last.visible && shown && last.rect.w >= 1.0 && last.rect.h >= 1.0,
            owner: owner.hwnd,
            asked: Instant::now(),
        })
    }

    /// Put the window where the pane last said, or hide it, by handing the
    /// placement to the worker.
    pub fn reapply(&self, owner: &Owner) {
        {
            let mut queue = self.inner.queue.lock_or_panic();
            let Some(placement) = self.placement(owner) else {
                return;
            };
            queue.next = Some(placement);
        }
        self.inner.wake.notify_all();
        self.worker.call_once(|| {
            let inner = self.inner.clone();
            std::thread::spawn(move || inner.work());
        });
    }

    /// The first placement after embedding, made on the caller's thread with
    /// `ops` held, never the main thread. A take starts right after it, and
    /// the recorder sizes its video once from the window's client area:
    /// queued, the move could land after that, while the client area is
    /// still the whole frameless launch window, and the take would be padded
    /// out to that size with black.
    fn place_now(&self, owner: &Owner) -> Result<(), String> {
        let placement = {
            let mut queue = self.inner.queue.lock_or_panic();
            // Anything queued already was worked out from an older box.
            queue.next = None;
            self.placement(owner)
        };
        match placement {
            Some(p) => self.inner.place(&p),
            None => Ok(()),
        }
    }

    /// Pop out: the window gets its caption and borders back and leaves the pane.
    pub fn pop_out(&self, owner: Option<&Owner>) -> Result<(), String> {
        let _ops = self.inner.ops.lock_or_panic();
        let what = self.inner.kind.what();
        let hwnd = self
            .hwnd()
            .ok_or_else(|| format!("{what} has no window yet"))?;
        if self.state() != State::Embedded {
            return Err(format!("{what} is not in the pane"));
        }
        let saved = self
            .inner
            .saved
            .lock_or_panic()
            .clone()
            .ok_or("nothing to restore")?;
        let near = owner.and_then(|o| self.near(o));
        self.inner.queue.lock_or_panic().next = None;
        self.inner.still.lock_or_panic().take();
        self.inner.win.release(hwnd, &saved, near)?;
        self.set(State::PoppedOut);
        Ok(())
    }

    /// Dock: back over the pane, sized to it before this returns. Also how a
    /// window started with no pane open joins the pane that opens later.
    pub fn dock(&self, owner: &Owner) -> Result<(), String> {
        let what = self.inner.kind.what();
        let placed = {
            let _ops = self.inner.ops.lock_or_panic();
            let hwnd = self
                .hwnd()
                .ok_or_else(|| format!("{what} has no window yet"))?;
            let dockable = matches!(
                self.state(),
                State::PoppedOut
                    | State::OwnWindow {
                        cause: Cause::NoPane,
                        ..
                    }
            );
            if !dockable {
                return Err(format!("{what} is not popped out"));
            }
            self.embed_now(hwnd, owner, Cause::Refused)
        };
        // A window started with no pane has its first outcome here; after a
        // Pop out this does nothing, the outcome long since reported.
        self.settle();
        if placed {
            Ok(())
        } else {
            Err(format!("{what} could not be placed in the pane"))
        }
    }

    /// The frame to show while an overlay covers the box, from the window's
    /// own capture; `None` before the first frame, off Windows, or where
    /// Windows would draw its capture border around the window.
    /// Ask the window to close as its close button would, so an editor asks
    /// to save its work first and the person may cancel. `Ok(false)` when
    /// there is no window to ask. Never kills anything.
    pub fn request_close(&self) -> Result<bool, String> {
        let _ops = self.inner.ops.lock_or_panic();
        let Some(hwnd) = self.hwnd() else {
            return Ok(false);
        };
        self.inner.win.request_close(hwnd).map(|()| true)
    }

    pub fn still_png(&self) -> Option<Vec<u8>> {
        self.inner.still.lock_or_panic().as_ref()?.png()
    }

    /// The state with what the debug snapshot shows of it.
    pub fn report(&self) -> Value {
        let placed = *self.inner.placed.lock_or_panic();
        json!({
            "kind": self.inner.kind,
            "state": self.state(),
            "shown": self.shown(),
            "box": self.last().map(|l| json!({ "rect": l.rect, "visible": l.visible, "dpr": l.dpr })),
            "placed": placed.map(|p| json!({ "at": p.at, "visible": p.visible })),
            "lastPlaceMs": placed.map(|p| p.ms),
            "still": self.inner.still.lock_or_panic().is_some(),
        })
    }
}

/// The usage event a settled game reports (`docs/telemetry.md`; spec §13):
/// `play_embedded` once placed, `play_embed_failed` with the cause otherwise.
/// A game that closed before it showed a window, or while no pane was open
/// for it, failed nothing, and says nothing. Properties are short scalars only.
pub fn usage_for(state: &State, ms: u64) -> Option<(&'static str, Value)> {
    match state {
        State::Embedded => Some(("play_embedded", json!({ "ms": ms }))),
        State::OwnWindow {
            cause: Cause::Exited | Cause::NoPane,
            ..
        }
        | State::Waiting
        | State::PoppedOut => None,
        State::OwnWindow { cause, .. } => Some(("play_embed_failed", json!({ "cause": cause }))),
    }
}

/// Where a shown window goes in the z-order: just above its owner, which is
/// below whatever sits just above the owner (`owner_prev`, the window
/// `GW_HWNDPREV` names, 0 for none). Making the window owned does not move
/// it, and Dock happens while Veistra is in front of it.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZOrder {
    /// Already just above the owner.
    Keep,
    /// The owner is the top window, so the placed window goes to the top.
    Top,
    /// Below this window.
    After(isize),
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn just_above(owner_prev: isize, me: isize) -> ZOrder {
    match owner_prev {
        0 => ZOrder::Top,
        p if p == me => ZOrder::Keep,
        p => ZOrder::After(p),
    }
}

/// The style bits embedding changes, by value, so the arithmetic is tested
/// on any host; [`sys`] checks them against `windows-sys` when it builds.
#[cfg_attr(not(windows), allow(dead_code))]
pub mod styles {
    pub const WS_CAPTION: u32 = 0x00C0_0000;
    pub const WS_THICKFRAME: u32 = 0x0004_0000;
    pub const WS_SYSMENU: u32 = 0x0008_0000;
    pub const WS_MINIMIZEBOX: u32 = 0x0002_0000;
    pub const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
    pub const WS_POPUP: u32 = 0x8000_0000;
    pub const WS_VISIBLE: u32 = 0x1000_0000;
    pub const WS_MINIMIZE: u32 = 0x2000_0000;
    pub const WS_MAXIMIZE: u32 = 0x0100_0000;
    pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
    pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;

    const FRAME: u32 = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;

    /// Shown, minimised and maximised are states `ShowWindow` changes. A
    /// style write that carried them would flip them behind its back: a
    /// window marked visible while hidden ignores the later show the taskbar
    /// relies on, and a minimised one would stay minimised in the pane.
    const STATES: u32 = WS_VISIBLE | WS_MINIMIZE | WS_MAXIMIZE;

    /// The style an embedded window gets: no frame, a popup, and no states.
    pub fn embedded(style: isize) -> isize {
        (style & !((FRAME | STATES) as isize)) | WS_POPUP as isize
    }

    /// No taskbar entry. `windows-capture` 2.0.1 checks for this style only
    /// when it lists capturable windows, never when it captures a handle, so
    /// the recorder and the still keep working with it.
    pub fn embedded_ex(ex_style: isize) -> isize {
        (ex_style & !(WS_EX_APPWINDOW as isize)) | WS_EX_TOOLWINDOW as isize
    }

    /// The style saved before embedding, written back on Pop out.
    pub fn restored(saved: isize) -> isize {
        saved & !(STATES as isize)
    }
}

#[cfg(windows)]
#[path = "win32.rs"]
pub mod sys;

/// Everywhere but Windows: no embedder yet (macOS needs a different
/// approach, the design says; Linux Wayland too), so a window keeps its own
/// frame and [`host`] gives up with [`Cause::Unsupported`] without looking.
#[cfg(not(windows))]
pub mod sys {
    use super::{Kind, ScreenRect};

    #[derive(Debug, Clone, Default)]
    pub struct Saved;

    const NONE: &str = "placing a window in a pane is Windows-only for now";

    pub fn find_window(_pids: &[u32], _kind: Kind) -> Option<isize> {
        None
    }

    pub fn embed(_hwnd: isize, _owner: isize) -> Result<Saved, String> {
        Err(NONE.into())
    }

    pub fn place(
        _hwnd: isize,
        _r: ScreenRect,
        _visible: bool,
        _owner: isize,
    ) -> Result<(), String> {
        Err(NONE.into())
    }

    pub fn release(_hwnd: isize, _saved: &Saved, _near: Option<ScreenRect>) -> Result<(), String> {
        Err(NONE.into())
    }

    pub fn show_near(_hwnd: isize, _near: Option<ScreenRect>) -> Result<(), String> {
        Err(NONE.into())
    }

    pub fn request_close(_hwnd: isize) -> Result<(), String> {
        Err(NONE.into())
    }
}

/// Whether this build can place a window in a pane at all.
pub const SUPPORTED: bool = cfg!(windows);

/// The fake window system is shared with Play's tests (`godot::live`).
#[cfg(test)]
pub(crate) mod tests;
