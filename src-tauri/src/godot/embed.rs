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
//! window) was not built; the design's Day 1 spike is where `CreateForWindow`
//! on a child window gets tried, and `docs/design-notes/godot-play.md` keeps
//! the decision row.
//!
//! Everything here except [`sys`] is plain arithmetic and state, tested on any
//! host. [`sys`] is Win32 on Windows and a refusal elsewhere, which is the
//! design's fallback (§4.5): the game opens in its own window, and the live
//! strip says so.

use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
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

/// CSS pixels to physical screen pixels. Each edge is rounded on its own, so
/// two boxes that share an edge in CSS still share it on screen.
pub fn to_screen(css: CssRect, owner: &Owner) -> ScreenRect {
    let edge = |v: f64| (v * owner.scale).round() as i32;
    let (left, top) = (edge(css.x), edge(css.y));
    let (right, bottom) = (edge(css.x + css.w), edge(css.y + css.h));
    ScreenRect {
        x: owner.origin.0 + left,
        y: owner.origin.1 + top,
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

/// One game's window and what was last asked of it.
pub struct Embed {
    state: Mutex<State>,
    hwnd: Mutex<Option<isize>>,
    saved: Mutex<Option<sys::Saved>>,
    last: Mutex<Option<(CssRect, bool)>>,
}

impl Default for Embed {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::Waiting),
            hwnd: Mutex::new(None),
            saved: Mutex::new(None),
            last: Mutex::new(None),
        }
    }
}

impl Embed {
    pub fn state(&self) -> State {
        self.state.lock_or_panic().clone()
    }

    pub fn hwnd(&self) -> Option<isize> {
        *self.hwnd.lock_or_panic()
    }

    fn set(&self, state: State) {
        *self.state.lock_or_panic() = state;
    }

    /// Leave the game in its own window, saying why, without looking for it:
    /// a platform with no embedder, or a run Play is not placing.
    pub fn give_up(&self, reason: &str) {
        self.set(State::OwnWindow {
            reason: reason.to_string(),
        });
    }

    /// Find the window of `pids` (the game and anything it started) and
    /// place it over the pane, or give up and say why. Blocks for up to
    /// [`FIND_WINDOW_FOR`]; called on the thread a run starts. `alive` stops
    /// the search when the game exits first.
    pub fn attach(
        &self,
        pids: &dyn Fn() -> Vec<u32>,
        owner: Option<Owner>,
        alive: &dyn Fn() -> bool,
    ) -> Option<isize> {
        let started = Instant::now();
        let hwnd = loop {
            if let Some(hwnd) = sys::find_window(&pids()) {
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
        *self.hwnd.lock_or_panic() = Some(hwnd);
        let Some(owner) = owner else {
            self.set(State::OwnWindow {
                reason: "Playing in its own window.".into(),
            });
            return Some(hwnd);
        };
        match sys::embed(hwnd, owner.hwnd) {
            Ok(saved) => {
                *self.saved.lock_or_panic() = Some(saved);
                self.set(State::Embedded);
                self.reapply(&owner);
            }
            Err(e) => {
                crate::veistra_log!("play: could not place the game in the pane: {e}");
                self.set(State::OwnWindow {
                    reason: "Playing in its own window.".into(),
                });
            }
        }
        Some(hwnd)
    }

    /// The pane's newest box. Kept even before the window is found, so the
    /// window lands in the right place the moment it is.
    pub fn set_rect(&self, rect: CssRect, visible: bool, owner: Option<&Owner>) {
        *self.last.lock_or_panic() = Some((rect, visible));
        if let Some(owner) = owner {
            self.reapply(owner);
        }
    }

    pub fn last_rect(&self) -> Option<CssRect> {
        self.last.lock_or_panic().map(|(r, _)| r)
    }

    /// Put the window where the pane last said, or hide it. Only while
    /// embedded: a popped-out or own window is the person's to move.
    pub fn reapply(&self, owner: &Owner) {
        if self.state() != State::Embedded {
            return;
        }
        let (Some(hwnd), Some((rect, visible))) = (self.hwnd(), *self.last.lock_or_panic()) else {
            return;
        };
        let visible = visible && rect.w >= 1.0 && rect.h >= 1.0;
        if let Err(e) = sys::place(hwnd, to_screen(rect, owner), visible) {
            crate::veistra_log!("play: could not move the game window: {e}");
        }
    }

    /// Pop out: the window gets its caption and borders back and leaves the pane.
    pub fn pop_out(&self, owner: Option<&Owner>) -> Result<(), String> {
        let hwnd = self.hwnd().ok_or("the game has no window yet")?;
        if self.state() != State::Embedded {
            return Err("the game is not in the pane".into());
        }
        let saved = self
            .saved
            .lock_or_panic()
            .clone()
            .ok_or("nothing to restore")?;
        let near = owner.and_then(|o| self.last_rect().map(|r| to_screen(r, o)));
        sys::release(hwnd, &saved, near)?;
        self.set(State::PoppedOut);
        Ok(())
    }

    /// Dock: back over the pane.
    pub fn dock(&self, owner: &Owner) -> Result<(), String> {
        let hwnd = self.hwnd().ok_or("the game has no window yet")?;
        if self.state() != State::PoppedOut {
            return Err("the game is not popped out".into());
        }
        let saved = sys::embed(hwnd, owner.hwnd)?;
        *self.saved.lock_or_panic() = Some(saved);
        self.set(State::Embedded);
        self.reapply(owner);
        Ok(())
    }
}

/// The Win32 half. Only this module touches window handles.
#[cfg(windows)]
pub mod sys {
    use super::ScreenRect;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
        IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_HWNDPARENT, GWL_EXSTYLE,
        GWL_STYLE, GW_OWNER, SWP_FRAMECHANGED, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, WS_CAPTION, WS_EX_APPWINDOW,
        WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    };

    /// A window's styles before it was embedded, for Pop out.
    #[derive(Debug, Clone)]
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
    /// window owned by `owner`. Answers what is needed to undo it.
    pub fn embed(hwnd: isize, owner: isize) -> Result<Saved, String> {
        let h = hwnd as HWND;
        // SAFETY: the handle came from `find_window`; a stale one makes these
        // calls fail, which is checked, rather than touch memory.
        unsafe {
            let style = GetWindowLongPtrW(h, GWL_STYLE);
            let ex_style = GetWindowLongPtrW(h, GWL_EXSTYLE);
            if style == 0 {
                return Err(last_error("GetWindowLongPtrW"));
            }
            let frame = (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
                as isize;
            // Hidden while the styles change, so the taskbar notices the
            // new tool-window style and drops the button.
            ShowWindow(h, SW_HIDE);
            SetWindowLongPtrW(h, GWL_STYLE, (style & !frame) | WS_POPUP as isize);
            SetWindowLongPtrW(
                h,
                GWL_EXSTYLE,
                (ex_style & !(WS_EX_APPWINDOW as isize)) | WS_EX_TOOLWINDOW as isize,
            );
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

    /// Move and size the window, or hide it.
    pub fn place(hwnd: isize, r: ScreenRect, visible: bool) -> Result<(), String> {
        let show = if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
        // SAFETY: as in `embed`; failure is reported, not assumed away.
        let ok = unsafe {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                r.x,
                r.y,
                r.w,
                r.h,
                SWP_NOZORDER | SWP_NOACTIVATE | show,
            )
        };
        if ok == 0 {
            return Err(last_error("SetWindowPos"));
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
            SetWindowLongPtrW(h, GWL_STYLE, saved.style);
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

    #[derive(Debug, Clone)]
    pub struct Saved;

    pub fn find_window(_pids: &[u32]) -> Option<isize> {
        None
    }

    pub fn embed(_hwnd: isize, _owner: isize) -> Result<Saved, String> {
        Err("embedding is Windows-only for now".into())
    }

    pub fn place(_hwnd: isize, _r: ScreenRect, _visible: bool) -> Result<(), String> {
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

    fn owner(scale: f64) -> Owner {
        Owner {
            hwnd: 1,
            origin: (100, 50),
            scale,
        }
    }

    #[test]
    fn css_pixels_become_physical_pixels_from_the_client_origin() {
        let r = CssRect {
            x: 10.0,
            y: 20.0,
            w: 640.0,
            h: 360.0,
        };
        assert_eq!(
            to_screen(r, &owner(1.0)),
            ScreenRect {
                x: 110,
                y: 70,
                w: 640,
                h: 360
            }
        );
        assert_eq!(
            to_screen(r, &owner(1.5)),
            ScreenRect {
                x: 115,
                y: 80,
                w: 960,
                h: 540
            }
        );
    }

    #[test]
    fn neighbouring_boxes_still_meet_after_rounding() {
        let o = owner(1.25);
        let a = to_screen(
            CssRect {
                x: 0.3,
                y: 0.0,
                w: 100.3,
                h: 10.0,
            },
            &o,
        );
        let b = to_screen(
            CssRect {
                x: 100.6,
                y: 0.0,
                w: 50.0,
                h: 10.0,
            },
            &o,
        );
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
        let found = embed.attach(&Vec::new, Some(owner(1.0)), &|| false);
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
        let r = CssRect {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
        };
        embed.set_rect(r, true, None);
        assert_eq!(embed.last_rect(), Some(r));
        embed.reapply(&owner(1.0));
        assert_eq!(
            embed.state(),
            State::Waiting,
            "nothing is moved before it is embedded"
        );
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
