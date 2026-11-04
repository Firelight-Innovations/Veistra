//! Showing the game inside Play's pane (design §4), the way Godot 4.4's own
//! editor does: the game stays a separate process, so a crash never takes
//! Veistra down, and window management makes it look embedded.
//!
//! **R2, an owned popup, not R1, a child window.** The game's window keeps
//! being top level: no caption or borders, `WS_EX_TOOLWINDOW` so it has no
//! taskbar entry, and owned by the Veistra window, which keeps it above
//! Veistra and hides it with Veistra when Veistra is minimised. The cost is
//! repositioning on every move of the Veistra window (`lib.rs` calls
//! [`Embed::reapply`] on `WindowEvent::Moved`). What it buys is the reason
//! the design recommends it: the recorder captures the game window alone and
//! never Veistra's own UI, with no crop. R1 (`SetParent` into the Veistra
//! window) exists only in the embed spike (`spike.rs`, `pnpm spike:embed` on
//! Windows 11), which runs both against this code unchanged; the decision row
//! in `docs/design-notes/godot-play.md` records which one stays.
//!
//! Everything here except [`sys`] is plain arithmetic and state, tested on any
//! host through a fake [`WindowSystem`]. [`sys`] is Win32 on Windows and a
//! refusal elsewhere, which is the design's fallback (§4.5): the game opens in
//! its own window, and the live strip says so.

use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Condvar, Mutex, Once, PoisonError};
use std::time::{Duration, Instant};

/// How long to wait for the game's window before leaving it where it is.
pub const FIND_WINDOW_FOR: Duration = Duration::from_secs(10);

/// A box in the Veistra window, in CSS pixels, as the pane measures it: the
/// shell's report of where the pane's iframe sits plus the game box inside it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The same box on the screen, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// The Veistra window a game is placed in: its handle, where its client area
/// (the WebView's top-left) is on the screen in physical pixels, and its
/// scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Owner {
    pub hwnd: isize,
    pub origin: (i32, i32),
    pub scale: f64,
}

/// Physical pixels per CSS pixel. The Play page's own `devicePixelRatio`
/// includes the WebView's zoom as well as the monitor's scale, which the
/// window's scale factor alone does not, so it wins whenever the page sent a
/// usable one.
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

/// The physical size a game is first launched at, for `--resolution`: the
/// pane's last box if one is known, else 1280 x 720. Even numbers, because an
/// H.264 encoder refuses odd ones.
pub fn launch_size(css: Option<CssRect>, scale: f64) -> (u32, u32) {
    let even = |v: f64| ((v * scale).round() as u32).max(64) & !1;
    match css {
        Some(r) if r.w >= 32.0 && r.h >= 32.0 => (even(r.w), even(r.h)),
        _ => (1280, 720),
    }
}

/// What the pane last said: its box, whether to show the game, and the
/// page's `devicePixelRatio`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Last {
    pub rect: CssRect,
    pub visible: bool,
    pub dpr: Option<f64>,
}

impl Last {
    /// `next` on top of `self`. A hide with no real box (the pane leaving
    /// the live view sends 0 x 0) keeps the box it had, so Pop out and the
    /// next launch still know where the game was.
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

/// Where the game's window is, as the pane shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum State {
    /// Looking for the game's window.
    Waiting,
    /// Over the pane.
    Embedded,
    /// Its own decorated window, because the person asked (Pop out).
    PoppedOut,
    /// Its own window because embedding is not possible here; `reason` is
    /// what the live strip says.
    OwnWindow { reason: String },
}

/// What [`Embed`] asks of the window system: [`sys`] in the app, a fake in
/// the tests.
pub trait WindowSystem: Send + Sync {
    fn find_window(&self, pids: &[u32]) -> Option<isize>;
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
}

struct Native;

impl WindowSystem for Native {
    fn find_window(&self, pids: &[u32]) -> Option<isize> {
        sys::find_window(pids)
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
}

/// One placement for the worker to make.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Placement {
    hwnd: isize,
    at: ScreenRect,
    visible: bool,
    owner: isize,
}

#[derive(Default)]
struct Queue {
    /// The newest placement not yet made; a newer one replaces it.
    next: Option<Placement>,
    /// The embed is gone, so its worker ends.
    closed: bool,
}

/// What the embed and its worker thread share.
struct Inner {
    win: Arc<dyn WindowSystem>,
    state: Mutex<State>,
    hwnd: Mutex<Option<isize>>,
    saved: Mutex<Option<sys::Saved>>,
    last: Mutex<Option<Last>>,
    /// Whether the shell shows the pane at all: its cluster on screen and
    /// Play the active tab. Decided in Rust from the shell's state, because a
    /// hidden cluster's pane may not be running to say so itself.
    shown: Mutex<bool>,
    queue: Mutex<Queue>,
    wake: Condvar,
    /// Held across every call into the window system, so a placement the
    /// worker is making cannot land after Pop out has released the window.
    /// Never taken on the main thread.
    ops: Mutex<()>,
}

impl Inner {
    fn state(&self) -> State {
        self.state.lock_or_panic().clone()
    }

    fn hwnd(&self) -> Option<isize> {
        *self.hwnd.lock_or_panic()
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
            if let Err(e) = self.win.place(next.hwnd, next.at, next.visible, next.owner) {
                crate::veistra_log!("play: could not move the game window: {e}");
            }
        }
    }
}

/// One game's window and what was last asked of it.
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
        Self::with(Arc::new(Native))
    }
}

impl Drop for Embed {
    fn drop(&mut self) {
        self.inner.queue.lock_or_panic().closed = true;
        self.inner.wake.notify_all();
    }
}

impl Embed {
    pub fn with(win: Arc<dyn WindowSystem>) -> Self {
        Self {
            inner: Arc::new(Inner {
                win,
                state: Mutex::new(State::Waiting),
                hwnd: Mutex::new(None),
                saved: Mutex::new(None),
                last: Mutex::new(None),
                shown: Mutex::new(true),
                queue: Mutex::new(Queue::default()),
                wake: Condvar::new(),
                ops: Mutex::new(()),
            }),
            worker: Once::new(),
        }
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

    /// Leave the game in its own window, saying why, without looking for it:
    /// a platform with no embedder, or a run Play is not placing.
    pub fn give_up(&self, reason: &str) {
        self.set(State::OwnWindow {
            reason: reason.to_string(),
        });
    }

    /// The run ended: its window is gone, so nothing may be sent to the
    /// handle again (Windows reuses handle values). The state stays, for
    /// the pane's last word on where the game was.
    pub fn forget(&self) {
        let _ops = self.inner.ops.lock_or_panic();
        *self.inner.hwnd.lock_or_panic() = None;
        self.inner.queue.lock_or_panic().next = None;
    }

    /// Find the window of `pids` (the game and anything it started) and
    /// place it over the pane, or give up and say why. Blocks for up to
    /// [`FIND_WINDOW_FOR`] and then for the first placement; called on the
    /// thread a run starts. `owner` is asked once the window exists, because
    /// Veistra may have moved while the game started. `alive` stops the
    /// search when the game exits first.
    pub fn attach(
        &self,
        pids: &dyn Fn() -> Vec<u32>,
        owner: &dyn Fn() -> Option<Owner>,
        alive: &dyn Fn() -> bool,
    ) -> Option<isize> {
        let started = Instant::now();
        let hwnd = loop {
            if let Some(hwnd) = self.inner.win.find_window(&pids()) {
                break hwnd;
            }
            if !alive() {
                self.set(State::OwnWindow {
                    reason: "The game closed before it showed a window.".into(),
                });
                return None;
            }
            if started.elapsed() > FIND_WINDOW_FOR {
                self.set(State::OwnWindow {
                    reason: "Playing in its own window: it showed none within 10 s to place here."
                        .into(),
                });
                return None;
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        *self.inner.hwnd.lock_or_panic() = Some(hwnd);
        let Some(owner) = owner() else {
            self.set(State::OwnWindow {
                reason: "Playing in its own window.".into(),
            });
            return Some(hwnd);
        };
        let embedded = {
            let _ops = self.inner.ops.lock_or_panic();
            self.inner.win.embed(hwnd, owner.hwnd).map(|saved| {
                *self.inner.saved.lock_or_panic() = Some(saved);
                self.set(State::Embedded);
                self.place_now(&owner);
            })
        };
        if let Err(e) = embedded {
            crate::veistra_log!("play: could not place the game in the pane: {e}");
            self.set(State::OwnWindow {
                reason: "Playing in its own window.".into(),
            });
        }
        Some(hwnd)
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
        let shown = *self.inner.shown.lock_or_panic();
        Some(Placement {
            hwnd,
            at: to_screen(last.rect, owner.origin, scale_for(last.dpr, owner.scale)),
            visible: last.visible && shown && last.rect.w >= 1.0 && last.rect.h >= 1.0,
            owner: owner.hwnd,
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
    fn place_now(&self, owner: &Owner) {
        let placement = {
            let mut queue = self.inner.queue.lock_or_panic();
            // Anything queued already was worked out from an older box.
            queue.next = None;
            self.placement(owner)
        };
        let Some(p) = placement else {
            return;
        };
        if let Err(e) = self.inner.win.place(p.hwnd, p.at, p.visible, p.owner) {
            crate::veistra_log!("play: could not move the game window: {e}");
        }
    }

    /// Pop out: the window gets its caption and borders back and leaves the pane.
    pub fn pop_out(&self, owner: Option<&Owner>) -> Result<(), String> {
        let _ops = self.inner.ops.lock_or_panic();
        let hwnd = self.hwnd().ok_or("the game has no window yet")?;
        if self.state() != State::Embedded {
            return Err("the game is not in the pane".into());
        }
        let saved = self
            .inner
            .saved
            .lock_or_panic()
            .clone()
            .ok_or("nothing to restore")?;
        let near = owner.and_then(|o| {
            self.last()
                .map(|l| to_screen(l.rect, o.origin, scale_for(l.dpr, o.scale)))
        });
        self.inner.queue.lock_or_panic().next = None;
        self.inner.win.release(hwnd, &saved, near)?;
        self.set(State::PoppedOut);
        Ok(())
    }

    /// Dock: back over the pane, sized to it before this returns.
    pub fn dock(&self, owner: &Owner) -> Result<(), String> {
        let _ops = self.inner.ops.lock_or_panic();
        let hwnd = self.hwnd().ok_or("the game has no window yet")?;
        if self.state() != State::PoppedOut {
            return Err("the game is not popped out".into());
        }
        let saved = self.inner.win.embed(hwnd, owner.hwnd)?;
        *self.inner.saved.lock_or_panic() = Some(saved);
        self.set(State::Embedded);
        self.place_now(owner);
        Ok(())
    }
}

/// Where a shown game goes in the z-order: just above its owner, which is
/// below whatever sits just above the owner (`owner_prev`, the window
/// `GW_HWNDPREV` names, 0 for none). Making the game owned does not move it,
/// and Dock happens while Veistra is in front of the game.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZOrder {
    /// Already just above the owner.
    Keep,
    /// The owner is the top window, so the game goes to the top.
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

    /// The style an embedded game gets: no frame, a popup, and no states.
    pub fn embedded(style: isize) -> isize {
        (style & !((FRAME | STATES) as isize)) | WS_POPUP as isize
    }

    /// No taskbar entry.
    pub fn embedded_ex(ex_style: isize) -> isize {
        (ex_style & !(WS_EX_APPWINDOW as isize)) | WS_EX_TOOLWINDOW as isize
    }

    /// The style saved before embedding, written back on Pop out.
    pub fn restored(saved: isize) -> isize {
        saved & !(STATES as isize)
    }
}

/// The Win32 half. Only this module touches window handles.
#[cfg(windows)]
pub mod sys {
    use super::{just_above, styles, ScreenRect, ZOrder};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, IsZoomed, SetWindowLongPtrW, SetWindowPos, ShowWindow,
        GWLP_HWNDPARENT, GWL_EXSTYLE, GWL_STYLE, GW_HWNDPREV, GW_OWNER, HWND_TOP, SWP_FRAMECHANGED,
        SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
        SW_HIDE, SW_SHOWNOACTIVATE, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_MAXIMIZE,
        WS_MAXIMIZEBOX, WS_MINIMIZE, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
        WS_VISIBLE,
    };

    const _: () = assert!(
        styles::WS_CAPTION == WS_CAPTION
            && styles::WS_THICKFRAME == WS_THICKFRAME
            && styles::WS_SYSMENU == WS_SYSMENU
            && styles::WS_MINIMIZEBOX == WS_MINIMIZEBOX
            && styles::WS_MAXIMIZEBOX == WS_MAXIMIZEBOX
            && styles::WS_POPUP == WS_POPUP
            && styles::WS_VISIBLE == WS_VISIBLE
            && styles::WS_MINIMIZE == WS_MINIMIZE
            && styles::WS_MAXIMIZE == WS_MAXIMIZE
            && styles::WS_EX_APPWINDOW == WS_EX_APPWINDOW
            && styles::WS_EX_TOOLWINDOW == WS_EX_TOOLWINDOW
    );

    /// A window's styles before it was embedded, for Pop out.
    #[derive(Debug, Clone, Default)]
    pub struct Saved {
        style: isize,
        ex_style: isize,
    }

    struct Search<'a> {
        pids: &'a [u32],
        found: HWND,
    }

    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> i32 {
        // SAFETY: `data` is the `&mut Search` `find_window` passed, alive for
        // the whole of `EnumWindows`.
        let search = unsafe { &mut *(data as *mut Search) };
        let mut pid = 0u32;
        // SAFETY: `hwnd` comes from the enumeration, and `pid` is a valid out pointer.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        // SAFETY: plain queries on a handle the enumeration just gave us.
        let top_level = unsafe { GetWindow(hwnd, GW_OWNER) }.is_null();
        let visible = unsafe { IsWindowVisible(hwnd) } != 0;
        if search.pids.contains(&pid) && top_level && visible {
            search.found = hwnd;
            return 0;
        }
        1
    }

    /// The first visible, unowned top-level window of any of `pids`.
    pub fn find_window(pids: &[u32]) -> Option<isize> {
        if pids.is_empty() {
            return None;
        }
        let mut search = Search {
            pids,
            found: std::ptr::null_mut(),
        };
        // SAFETY: `visit` only reads `search` through the pointer, for the
        // duration of this call.
        unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
        (!search.found.is_null()).then_some(search.found as isize)
    }

    fn last_error(what: &str) -> String {
        format!("{what} failed: {}", std::io::Error::last_os_error())
    }

    /// Strip the caption and borders, drop the taskbar entry, and make the
    /// window owned by `owner`. Answers what is needed to undo it. The window
    /// is left hidden; [`place`] shows it over the pane.
    pub fn embed(hwnd: isize, owner: isize) -> Result<Saved, String> {
        let h = hwnd as HWND;
        // SAFETY: the handle came from `find_window`; a stale one makes these
        // calls fail, which is checked, rather than touch memory.
        unsafe {
            // A popped-out game the person minimised or maximised: restored
            // first, or it would stay minimised and draw nothing in the pane.
            if IsIconic(h) != 0 || IsZoomed(h) != 0 {
                ShowWindow(h, SW_SHOWNOACTIVATE);
            }
            let style = GetWindowLongPtrW(h, GWL_STYLE);
            let ex_style = GetWindowLongPtrW(h, GWL_EXSTYLE);
            if style == 0 {
                return Err(last_error("GetWindowLongPtrW"));
            }
            // Hidden while the styles change, so the taskbar notices the
            // new tool-window style and drops the button when it is shown.
            ShowWindow(h, SW_HIDE);
            SetWindowLongPtrW(h, GWL_STYLE, styles::embedded(style));
            SetWindowLongPtrW(h, GWL_EXSTYLE, styles::embedded_ex(ex_style));
            SetWindowLongPtrW(h, GWLP_HWNDPARENT, owner);
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            Ok(Saved { style, ex_style })
        }
    }

    /// Move and size the window over `owner`, owned by it, or hide it. The
    /// owner is checked each time because the pane can move to another
    /// Veistra window while the game runs.
    pub fn place(hwnd: isize, r: ScreenRect, visible: bool, owner: isize) -> Result<(), String> {
        let h = hwnd as HWND;
        // SAFETY: as in `embed`; failure is reported, not assumed away.
        unsafe {
            if GetWindow(h, GW_OWNER) as isize != owner {
                SetWindowLongPtrW(h, GWLP_HWNDPARENT, owner);
            }
            let (after, flags) = if visible {
                let prev = GetWindow(owner as HWND, GW_HWNDPREV) as isize;
                match just_above(prev, hwnd) {
                    ZOrder::Keep => (std::ptr::null_mut(), SWP_NOZORDER | SWP_SHOWWINDOW),
                    ZOrder::Top => (HWND_TOP, SWP_SHOWWINDOW),
                    ZOrder::After(p) => (p as HWND, SWP_SHOWWINDOW),
                }
            } else {
                (std::ptr::null_mut(), SWP_NOZORDER | SWP_HIDEWINDOW)
            };
            if SetWindowPos(h, after, r.x, r.y, r.w, r.h, SWP_NOACTIVATE | flags) == 0 {
                return Err(last_error("SetWindowPos"));
            }
        }
        Ok(())
    }

    /// Undo [`embed`]: the saved styles back, no owner, shown near `near`.
    pub fn release(hwnd: isize, saved: &Saved, near: Option<ScreenRect>) -> Result<(), String> {
        let h = hwnd as HWND;
        // SAFETY: as in `embed`.
        unsafe {
            ShowWindow(h, SW_HIDE);
            SetWindowLongPtrW(h, GWLP_HWNDPARENT, 0);
            SetWindowLongPtrW(h, GWL_STYLE, styles::restored(saved.style));
            SetWindowLongPtrW(h, GWL_EXSTYLE, saved.ex_style);
            let mut now = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetWindowRect(h, &mut now);
            let at = near.unwrap_or(ScreenRect {
                x: now.left,
                y: now.top,
                w: now.right - now.left,
                h: now.bottom - now.top,
            });
            let ok = SetWindowPos(
                h,
                std::ptr::null_mut(),
                at.x + 24,
                at.y + 24,
                at.w,
                at.h,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_SHOWWINDOW,
            );
            if ok == 0 {
                return Err(last_error("SetWindowPos"));
            }
        }
        Ok(())
    }
}

/// Everywhere but Windows: no embedder yet (macOS needs a different
/// approach, the design says; Linux Wayland too), so the game keeps its own
/// window. `find_window` still answers `None`, which is what makes
/// [`Embed::attach`] report the fallback after its wait.
#[cfg(not(windows))]
pub mod sys {
    use super::ScreenRect;

    #[derive(Debug, Clone, Default)]
    pub struct Saved;

    pub fn find_window(_pids: &[u32]) -> Option<isize> {
        None
    }

    pub fn embed(_hwnd: isize, _owner: isize) -> Result<Saved, String> {
        Err("embedding is Windows-only for now".into())
    }

    pub fn place(
        _hwnd: isize,
        _r: ScreenRect,
        _visible: bool,
        _owner: isize,
    ) -> Result<(), String> {
        Err("embedding is Windows-only for now".into())
    }

    pub fn release(_hwnd: isize, _saved: &Saved, _near: Option<ScreenRect>) -> Result<(), String> {
        Err("embedding is Windows-only for now".into())
    }
}

/// Whether this build can place a game in the pane at all.
pub const SUPPORTED: bool = cfg!(windows);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
    use std::thread::ThreadId;

    fn owner(scale: f64) -> Owner {
        Owner {
            hwnd: 1,
            origin: (100, 50),
            scale,
        }
    }

    fn rect(x: f64, w: f64) -> CssRect {
        CssRect {
            x,
            y: 0.0,
            w,
            h: 100.0,
        }
    }

    fn shown(rect: CssRect) -> Last {
        Last {
            rect,
            visible: true,
            dpr: None,
        }
    }

    /// A window system with one window, `7`, found on the `finds_before`th
    /// look. `hung` held by a test is a game that stopped pumping messages.
    #[derive(Default)]
    struct Fake {
        finds_before: usize,
        looks: AtomicUsize,
        hung: Mutex<()>,
        placed: Mutex<Vec<(Placement, ThreadId)>>,
    }

    impl WindowSystem for Fake {
        fn find_window(&self, _pids: &[u32]) -> Option<isize> {
            let looks = self.looks.fetch_add(1, Ordering::SeqCst);
            (looks >= self.finds_before).then_some(7)
        }
        // `Saved` is a unit struct only off Windows.
        #[allow(clippy::default_constructed_unit_structs)]
        fn embed(&self, _hwnd: isize, _owner: isize) -> Result<sys::Saved, String> {
            Ok(sys::Saved::default())
        }
        fn place(
            &self,
            hwnd: isize,
            at: ScreenRect,
            visible: bool,
            owner: isize,
        ) -> Result<(), String> {
            let _hung = self.hung.lock_or_panic();
            let p = Placement {
                hwnd,
                at,
                visible,
                owner,
            };
            self.placed
                .lock_or_panic()
                .push((p, std::thread::current().id()));
            Ok(())
        }
        fn release(&self, _: isize, _: &sys::Saved, _: Option<ScreenRect>) -> Result<(), String> {
            Ok(())
        }
    }

    fn placed(fake: &Fake) -> Vec<Placement> {
        fake.placed
            .lock_or_panic()
            .iter()
            .map(|(p, _)| *p)
            .collect()
    }

    fn wait_for(what: &str, done: impl Fn() -> bool) {
        for _ in 0..200 {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {what}");
    }

    fn embedded(fake: &Arc<Fake>) -> Embed {
        let embed = Embed::with(fake.clone());
        embed.set_rect(shown(rect(10.0, 640.0)), None);
        let found = embed.attach(&|| vec![1], &|| Some(owner(1.0)), &|| true);
        assert_eq!(found, Some(7));
        assert_eq!(embed.state(), State::Embedded);
        assert_eq!(placed(fake).len(), 1, "placed before attach returned");
        embed
    }

    /// The placements made on this thread, in order.
    fn placed_here(fake: &Fake) -> Vec<Placement> {
        let me = std::thread::current().id();
        fake.placed
            .lock_or_panic()
            .iter()
            .filter(|(_, on)| *on == me)
            .map(|(p, _)| *p)
            .collect()
    }

    #[test]
    fn css_pixels_become_physical_pixels_from_the_client_origin() {
        let r = CssRect {
            x: 10.0,
            y: 20.0,
            w: 640.0,
            h: 360.0,
        };
        let at = |scale| to_screen(r, (100, 50), scale);
        assert_eq!(
            at(1.0),
            ScreenRect {
                x: 110,
                y: 70,
                w: 640,
                h: 360
            }
        );
        assert_eq!(
            at(1.5),
            ScreenRect {
                x: 115,
                y: 80,
                w: 960,
                h: 540
            }
        );
    }

    #[test]
    fn the_page_s_device_pixel_ratio_carries_the_zoom_the_window_scale_lacks() {
        // 125 % View zoom on a 100 % monitor: the box at CSS 400..1200 is at
        // 500..1500 on screen.
        let at = to_screen(rect(400.0, 800.0), (0, 0), scale_for(Some(1.25), 1.0));
        assert_eq!((at.x, at.w), (500, 1000));
        for useless in [
            None,
            Some(0.0),
            Some(-1.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert_eq!(scale_for(useless, 1.5), 1.5, "{useless:?}");
        }
    }

    #[test]
    fn neighbouring_boxes_still_meet_after_rounding() {
        let a = to_screen(
            CssRect {
                x: 0.3,
                y: 0.0,
                w: 100.3,
                h: 10.0,
            },
            (0, 0),
            1.25,
        );
        let b = to_screen(rect(100.6, 50.0), (0, 0), 1.25);
        assert_eq!(a.x + a.w, b.x);
    }

    #[test]
    fn a_game_launches_at_the_pane_s_size_in_even_physical_pixels() {
        let r = CssRect {
            x: 0.0,
            y: 0.0,
            w: 641.0,
            h: 361.0,
        };
        assert_eq!(launch_size(Some(r), 1.0), (640, 360));
        assert_eq!(launch_size(Some(r), 1.5), (962, 542));
        assert_eq!(launch_size(None, 2.0), (1280, 720));
        let tiny = CssRect {
            w: 4.0,
            h: 4.0,
            ..r
        };
        assert_eq!(launch_size(Some(tiny), 1.0), (1280, 720));
    }

    #[test]
    fn with_no_window_found_the_game_keeps_its_own_and_the_strip_says_why() {
        let embed = Embed::default();
        assert_eq!(embed.state(), State::Waiting);
        let found = embed.attach(&Vec::new, &|| Some(owner(1.0)), &|| false);
        assert_eq!(found, None);
        let State::OwnWindow { reason } = embed.state() else {
            panic!("own window");
        };
        assert!(reason.contains("closed"));
        assert!(embed.pop_out(None).is_err(), "nothing to pop out");
    }

    #[test]
    fn the_newest_box_is_kept_before_the_window_exists() {
        let embed = Embed::default();
        let r = rect(1.0, 3.0);
        embed.set_rect(shown(r), None);
        assert_eq!(embed.last().map(|l| l.rect), Some(r));
        embed.reapply(&owner(1.0));
        assert_eq!(
            embed.state(),
            State::Waiting,
            "nothing is moved before it is embedded"
        );
    }

    #[test]
    fn a_hide_with_an_empty_box_keeps_the_last_real_box() {
        let fake = Arc::new(Fake::default());
        let embed = embedded(&fake);
        let gone = Last {
            rect: CssRect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            visible: false,
            dpr: None,
        };
        embed.set_rect(gone, Some(&owner(1.0)));
        assert_eq!(embed.last().map(|l| l.rect), Some(rect(10.0, 640.0)));
        wait_for("the hide", || placed(&fake).len() == 2);
        let hide = placed(&fake)[1];
        assert!(!hide.visible);
        assert_eq!(hide.at.w, 640, "hidden where it was, not at 0 x 0");
    }

    #[test]
    fn a_hung_game_never_blocks_the_caller_and_only_the_newest_placement_is_made() {
        let fake = Arc::new(Fake::default());
        let embed = Arc::new(embedded(&fake));
        let hung = fake.hung.lock_or_panic();
        let (tx, rx) = std::sync::mpsc::channel();
        let caller = {
            let embed = embed.clone();
            std::thread::spawn(move || {
                for x in [20.0, 30.0, 40.0] {
                    embed.set_rect(shown(rect(x, 640.0)), Some(&owner(1.0)));
                }
                tx.send(std::thread::current().id()).unwrap();
            })
        };
        let caller_id = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the window moves returned while the game was hung");
        drop(hung);
        caller.join().unwrap();
        wait_for("the newest box", || {
            placed(&fake).last().is_some_and(|p| p.at.x == 140)
        });
        let all = fake.placed.lock_or_panic().clone();
        assert!(all.len() <= 3, "the middle box was dropped: {all:?}");
        assert!(all.iter().all(|(_, on)| *on != caller_id));
    }

    #[test]
    fn the_window_is_asked_for_its_place_once_the_game_shows_up() {
        // Veistra moves 300 px while the game starts; the game must land
        // against where the window is then, not where it was at Play.
        let fake = Arc::new(Fake {
            finds_before: 2,
            ..Fake::default()
        });
        let embed = Embed::with(fake.clone());
        embed.set_rect(shown(rect(10.0, 640.0)), None);
        let origin = AtomicI32::new(100);
        let looks = &fake.looks;
        let now = || {
            if looks.load(Ordering::SeqCst) > 2 {
                origin.store(400, Ordering::SeqCst);
            }
            Some(Owner {
                origin: (origin.load(Ordering::SeqCst), 50),
                ..owner(1.0)
            })
        };
        embed.attach(&|| vec![1], &now, &|| true);
        assert_eq!(placed(&fake).len(), 1);
        assert_eq!(placed(&fake)[0].at.x, 410);
    }

    #[test]
    fn attach_and_dock_size_the_window_to_the_pane_before_a_take_can_start() {
        // A take starts the moment either returns and sizes its video from
        // the window then, so the move must already be made, on this thread.
        let fake = Arc::new(Fake::default());
        let embed = embedded(&fake);
        let pane = ScreenRect {
            x: 110,
            y: 50,
            w: 640,
            h: 100,
        };
        assert_eq!(
            placed_here(&fake).iter().map(|p| p.at).collect::<Vec<_>>(),
            [pane]
        );
        embed.pop_out(Some(&owner(1.0))).unwrap();
        embed.set_rect(shown(rect(20.0, 800.0)), Some(&owner(1.0)));
        embed.dock(&owner(1.0)).unwrap();
        let docked = placed_here(&fake);
        assert_eq!(docked.len(), 2, "Dock placed it before returning");
        assert_eq!((docked[1].at.x, docked[1].at.w), (120, 800));
        assert!(docked[1].visible);
    }

    #[test]
    fn a_pane_moved_to_another_window_takes_the_game_with_it() {
        let fake = Arc::new(Fake::default());
        let embed = embedded(&fake);
        assert_eq!(placed(&fake)[0].owner, 1);
        let second = Owner {
            hwnd: 2,
            ..owner(1.0)
        };
        embed.set_rect(shown(rect(10.0, 640.0)), Some(&second));
        wait_for("the move", || placed(&fake).len() == 2);
        assert_eq!(placed(&fake)[1].owner, 2, "owned by the window it is in");
    }

    #[test]
    fn a_game_that_ended_is_never_moved_again() {
        let fake = Arc::new(Fake::default());
        let embed = embedded(&fake);
        embed.forget();
        embed.reapply(&owner(1.0));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(placed(&fake).len(), 1, "a dead handle is left alone");
    }

    #[test]
    fn a_shown_game_sits_just_above_its_owner() {
        assert_eq!(just_above(0, 7), ZOrder::Top);
        assert_eq!(just_above(7, 7), ZOrder::Keep);
        assert_eq!(just_above(9, 7), ZOrder::After(9));
    }

    #[test]
    fn style_writes_never_carry_visible_minimised_or_maximised() {
        use styles::*;
        let popped = (WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE | WS_MINIMIZE) as isize;
        let e = embedded(popped);
        assert_eq!(e & (WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX) as isize, 0);
        assert_eq!(e & (WS_VISIBLE | WS_MINIMIZE | WS_MAXIMIZE) as isize, 0);
        assert_ne!(e & WS_POPUP as isize, 0);
        let back = restored((WS_CAPTION | WS_VISIBLE | WS_MAXIMIZE) as isize);
        assert_eq!(
            back, WS_CAPTION as isize,
            "the frame comes back, the states do not"
        );
        let ex = embedded_ex(WS_EX_APPWINDOW as isize);
        assert_eq!(ex, WS_EX_TOOLWINDOW as isize);
    }

    #[test]
    fn states_serialize_as_the_pane_reads_them() {
        let v = serde_json::to_value(State::OwnWindow { reason: "x".into() }).unwrap();
        assert_eq!(v["kind"], "ownWindow");
        assert_eq!(v["reason"], "x");
        assert_eq!(
            serde_json::to_value(State::PoppedOut).unwrap()["kind"],
            "poppedOut"
        );
    }
}
