//! The Win32 half of [`super`]. Only this module touches window handles.

use super::{just_above, pick, styles, Kind, ScreenRect, ZOrder};
use windows_sys::Win32::Foundation::{GetLastError, SetLastError, HWND, LPARAM, RECT};
use windows_sys::Win32::System::Threading::AttachThreadInput;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetPropW, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, RemovePropW, SetPropW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_HWNDPARENT, GWL_EXSTYLE, GWL_STYLE,
    GW_HWNDPREV, GW_OWNER, HWND_TOP, SWP_FRAMECHANGED, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, WINDOW_LONG_PTR_INDEX,
    WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_MAXIMIZE, WS_MAXIMIZEBOX, WS_MINIMIZE,
    WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
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
    found: Vec<(isize, String)>,
}

fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: `buf` is a valid out buffer of the length passed.
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> i32 {
    // SAFETY: `data` is the `&mut Search` `find_window` passed, alive for the
    // whole of `EnumWindows`.
    let search = unsafe { &mut *(data as *mut Search) };
    let mut pid = 0u32;
    // SAFETY: `hwnd` comes from the enumeration, and `pid` is a valid out pointer.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    // SAFETY: plain queries on a handle the enumeration just gave us.
    let top_level = unsafe { GetWindow(hwnd, GW_OWNER) }.is_null();
    let visible = unsafe { IsWindowVisible(hwnd) } != 0;
    if search.pids.contains(&pid) && top_level && visible {
        search.found.push((hwnd as isize, class_of(hwnd)));
    }
    1
}

/// The window of `pids` to place: every visible, unowned top-level window
/// they have, handed to [`pick`] with its class.
pub fn find_window(pids: &[u32], kind: Kind) -> Option<isize> {
    if pids.is_empty() {
        return None;
    }
    let mut search = Search {
        pids,
        found: Vec::new(),
    };
    // SAFETY: `visit` only reaches `search` through the pointer, for the
    // duration of this call.
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    pick(&search.found, kind)
}

fn last_error(what: &str) -> String {
    format!("{what} failed: {}", std::io::Error::last_os_error())
}

/// `SetWindowLongPtrW`, checked. Its answer is the old value, which can be 0
/// on success (no owner before), so only 0 with an error set is a failure:
/// the write UIPI refuses for an elevated process, which used to be reported
/// as embedded.
///
/// # Safety
/// `h` must be a window handle; a stale one fails, which is reported.
unsafe fn set_long(h: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> Result<isize, String> {
    // SAFETY: as the function's contract says.
    unsafe {
        SetLastError(0);
        let previous = SetWindowLongPtrW(h, index, value);
        if previous == 0 && GetLastError() != 0 {
            return Err(last_error("SetWindowLongPtrW"));
        }
        Ok(previous)
    }
}

/// Owning a window joins its thread's input queue to the owner's, and a hung
/// game would then stall Veistra's own input. Godot's editor detaches them for
/// its embedded game the same way.
///
/// # Safety
/// Both must be window handles.
unsafe fn detach_input(h: HWND, owner: HWND) {
    // SAFETY: as the function's contract says; null out pointers are allowed.
    unsafe {
        let mine = GetWindowThreadProcessId(h, std::ptr::null_mut());
        let theirs = GetWindowThreadProcessId(owner, std::ptr::null_mut());
        if mine != 0 && theirs != 0 && mine != theirs {
            AttachThreadInput(mine, theirs, 0);
        }
    }
}

/// Strip the caption and borders, drop the taskbar entry, and make the window
/// owned by `owner`. Answers what is needed to undo it. The window is left
/// hidden; [`place`] shows it over the pane. Any refused write is undone and
/// the window shown again before this fails.
pub fn embed(hwnd: isize, owner: isize) -> Result<Saved, String> {
    let h = hwnd as HWND;
    // SAFETY: the handle came from `find_window`; a stale one makes these
    // calls fail, which is checked, rather than touch memory.
    unsafe {
        // A popped-out window the person minimised or maximised: restored
        // first, or it would stay minimised and draw nothing in the pane.
        if IsIconic(h) != 0 || IsZoomed(h) != 0 {
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        let style = GetWindowLongPtrW(h, GWL_STYLE);
        let ex_style = GetWindowLongPtrW(h, GWL_EXSTYLE);
        if style == 0 {
            return Err(last_error("GetWindowLongPtrW"));
        }
        // Hidden while the styles change, so the taskbar notices the new
        // tool-window style and drops the button when it is shown.
        ShowWindow(h, SW_HIDE);
        let written = set_long(h, GWL_STYLE, styles::embedded(style))
            .and_then(|_| set_long(h, GWL_EXSTYLE, styles::embedded_ex(ex_style)))
            .and_then(|_| set_long(h, GWLP_HWNDPARENT, owner));
        if let Err(e) = written {
            SetWindowLongPtrW(h, GWLP_HWNDPARENT, 0);
            SetWindowLongPtrW(h, GWL_STYLE, styles::restored(style));
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex_style);
            ShowWindow(h, SW_SHOWNOACTIVATE);
            return Err(e);
        }
        detach_input(h, owner as HWND);
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

struct Owned {
    owner: HWND,
    show: bool,
}

/// Marks a window [`set_owned`] hid, so only those are shown again.
const HID: *const u16 = windows_sys::w!("VeistraHidWithOwner");

unsafe extern "system" fn visit_owned(hwnd: HWND, data: LPARAM) -> i32 {
    // SAFETY: `data` is the `&Owned` `set_owned` passed, alive for the
    // whole of `EnumWindows`; the handle comes from the enumeration.
    unsafe {
        let owned = &*(data as *const Owned);
        if GetWindow(hwnd, GW_OWNER) != owned.owner {
            return 1;
        }
        if owned.show && !GetPropW(hwnd, HID).is_null() {
            RemovePropW(hwnd, HID);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        } else if !owned.show && IsWindowVisible(hwnd) != 0 {
            SetPropW(hwnd, HID, 1 as _);
            ShowWindow(hwnd, SW_HIDE);
        }
    }
    1
}

/// Hide or show the windows `hwnd` itself owns. Windows hides them with their
/// owner only when it is minimised, not when it is hidden, so Blender's
/// preferences (§11.1.4) would float over another tab without this.
fn set_owned(hwnd: HWND, show: bool) {
    let owned = Owned { owner: hwnd, show };
    // SAFETY: `visit_owned` only reads `owned`, for the duration of this call.
    unsafe { EnumWindows(Some(visit_owned), &owned as *const Owned as LPARAM) };
}

/// Move and size the window over `owner`, owned by it, or hide it. The owner
/// is checked each time because the pane can move to another Veistra window
/// while the process runs.
pub fn place(hwnd: isize, r: ScreenRect, visible: bool, owner: isize) -> Result<(), String> {
    let h = hwnd as HWND;
    // SAFETY: as in `embed`; failure is reported, not assumed away.
    unsafe {
        if GetWindow(h, GW_OWNER) as isize != owner {
            set_long(h, GWLP_HWNDPARENT, owner)?;
            detach_input(h, owner as HWND);
        }
        let was_visible = IsWindowVisible(h) != 0;
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
        if was_visible != visible {
            set_owned(h, visible);
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
    set_owned(h, true);
    Ok(())
}

/// Show a window that keeps its own frame, over `near` when given, else
/// where it is. Restores a minimised one first, and never activates it.
pub fn show_near(hwnd: isize, near: Option<ScreenRect>) -> Result<(), String> {
    let h = hwnd as HWND;
    // SAFETY: as in `embed`.
    unsafe {
        if IsIconic(h) != 0 {
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        let (r, keep) = match near {
            Some(r) => (r, 0),
            None => (
                ScreenRect {
                    x: 0,
                    y: 0,
                    w: 0,
                    h: 0,
                },
                SWP_NOMOVE | SWP_NOSIZE,
            ),
        };
        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | keep;
        if SetWindowPos(h, std::ptr::null_mut(), r.x, r.y, r.w, r.h, flags) == 0 {
            return Err(last_error("SetWindowPos"));
        }
    }
    Ok(())
}

/// Two real windows, the way `cargo test` on `windows-latest` can make them:
/// one with Godot's class, standing in for the game, and one for Veistra.
/// Messages sent to a window of this thread are handled in the call, so the
/// test needs no message loop. Never run off Windows.
#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    };

    fn window(class: *const u16) -> HWND {
        // SAFETY: registering a class twice fails harmlessly; the window is
        // destroyed by the test.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                lpfnWndProc: Some(DefWindowProcW),
                hInstance: instance,
                lpszClassName: class,
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            CreateWindowExW(
                0,
                class,
                class,
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                100,
                100,
                640,
                360,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        }
    }

    fn rect(h: HWND) -> RECT {
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: a window this test created.
        unsafe { GetWindowRect(h, &mut r) };
        r
    }

    #[test]
    fn a_real_window_is_found_stripped_owned_placed_hidden_and_given_back() {
        let game = window(windows_sys::w!("Engine"));
        let veistra = window(windows_sys::w!("VeistraEmbedTestOwner"));
        assert!(!game.is_null() && !veistra.is_null());
        let found = find_window(&[std::process::id()], Kind::Game);
        assert_eq!(found, Some(game as isize), "Godot's class is preferred");

        let saved = embed(game as isize, veistra as isize).expect("embed");
        // SAFETY: plain queries on windows this test created.
        unsafe {
            let style = GetWindowLongPtrW(game, GWL_STYLE) as u32;
            let ex = GetWindowLongPtrW(game, GWL_EXSTYLE) as u32;
            assert_eq!(style & WS_CAPTION, 0, "no caption");
            assert_ne!(ex & WS_EX_TOOLWINDOW, 0, "no taskbar button");
            assert_eq!(GetWindow(game, GW_OWNER), veistra, "owned by Veistra");
        }

        let at = ScreenRect {
            x: 200,
            y: 150,
            w: 400,
            h: 300,
        };
        place(game as isize, at, true, veistra as isize).expect("place");
        let r = rect(game);
        assert_eq!(
            (r.left, r.top, r.right - r.left, r.bottom - r.top),
            (200, 150, 400, 300)
        );
        // SAFETY: as above.
        assert_ne!(unsafe { IsWindowVisible(game) }, 0);
        place(game as isize, at, false, veistra as isize).expect("hide");
        // SAFETY: as above.
        assert_eq!(unsafe { IsWindowVisible(game) }, 0, "hidden with its pane");

        release(game as isize, &saved, None).expect("release");
        // SAFETY: as above.
        unsafe {
            let style = GetWindowLongPtrW(game, GWL_STYLE) as u32;
            assert_ne!(style & WS_CAPTION, 0, "the caption is back");
            assert!(GetWindow(game, GW_OWNER).is_null(), "no owner");
            DestroyWindow(game);
            DestroyWindow(veistra);
        }
    }
}
