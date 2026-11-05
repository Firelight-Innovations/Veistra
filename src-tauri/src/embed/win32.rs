//! The Win32 half of [`super`]. Only this module touches window handles.

use super::{just_above, pick, styles, Kind, Mode, ScreenRect, ZOrder};
use windows_sys::Win32::Foundation::{
    GetLastError, SetLastError, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::AttachThreadInput;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumWindows, GetClassNameW, GetMessageW,
    GetParent, GetPropW, GetSystemMetrics, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, PostMessageW, PostQuitMessage,
    RegisterClassW, RemovePropW, SetParent, SetPropW, SetTimer, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, TranslateMessage, GWLP_HWNDPARENT, GWL_EXSTYLE, GWL_STYLE, GW_CHILD, GW_HWNDPREV,
    GW_OWNER, HWND_TOP, MSG, SM_CYSCREEN, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_HIDEWINDOW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNOACTIVATE, WINDOW_LONG_PTR_INDEX, WM_CLOSE, WM_DESTROY, WM_TIMER, WNDCLASSW,
    WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_APPWINDOW, WS_EX_NOPARENTNOTIFY,
    WS_EX_TOOLWINDOW, WS_MAXIMIZE, WS_MAXIMIZEBOX, WS_MINIMIZE, WS_MINIMIZEBOX, WS_POPUP,
    WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
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
        && styles::WS_CHILD == WS_CHILD
        && styles::WS_CLIPSIBLINGS == WS_CLIPSIBLINGS
        && styles::WS_EX_NOPARENTNOTIFY == WS_EX_NOPARENTNOTIFY
);

/// What undoes an embed, for Pop out: the styles to write back and, for a
/// child, the clip box it sits in (0 for an owned popup).
#[derive(Debug, Clone, Default)]
pub struct Saved {
    style: isize,
    ex_style: isize,
    clip: isize,
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
    let main = unsafe { owned_by_none_but_us(GetWindow(hwnd, GW_OWNER)) };
    let visible = unsafe { IsWindowVisible(hwnd) } != 0;
    if search.pids.contains(&pid) && main && visible {
        search.found.push((hwnd as isize, class_of(hwnd)));
    }
    1
}

/// A main window has no owner, or Veistra's: the Godot editor started with
/// `--wid` makes its window owned by the Veistra window itself. A window
/// owned by one of the program's own is a dialog, never placed.
///
/// # Safety
/// `owner` must be null or a window handle.
unsafe fn owned_by_none_but_us(owner: HWND) -> bool {
    if owner.is_null() {
        return true;
    }
    let mut pid = 0u32;
    // SAFETY: as the function's contract says; `pid` is a valid out pointer.
    unsafe { GetWindowThreadProcessId(owner, &mut pid) };
    pid == std::process::id()
}

/// The window of `pids` to place: every visible top-level window they have
/// that none of theirs owns, handed to [`pick`] with its class.
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

/// Strip the caption and borders and make the window Veistra's: owned by
/// `owner` with no taskbar entry, or a child of a clip box in `owner`.
/// Answers what is needed to undo it. The window is left hidden; [`place`]
/// shows it over the pane. Any refused write is undone and the window shown
/// again before this fails.
///
/// Every call here waits for the program to handle it, so the first can
/// take as long as the program goes without reading its messages: seconds,
/// for an editor still starting. Never called on the main thread.
pub fn embed(hwnd: isize, owner: isize, mode: Mode) -> Result<Saved, String> {
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
        if mode == Mode::Child {
            return embed_child(h, owner as HWND, style, ex_style);
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
        Ok(Saved {
            style: styles::restored(style),
            ex_style,
            clip: 0,
        })
    }
}

/// [`embed`] as a child: a clip box made in `owner`, then the window made a
/// child of it. Its input queue stays joined to Veistra's, as every child's
/// is: measured, a child detached the way an owned popup is never gets a
/// key, since the keyboard goes to the queue of the Veistra window in front.
///
/// # Safety
/// `h` and `owner` must be window handles.
unsafe fn embed_child(
    h: HWND,
    owner: HWND,
    style: isize,
    ex_style: isize,
) -> Result<Saved, String> {
    let clip = make_clip(owner)?;
    // SAFETY: as the function's contract says; each write is checked, and
    // undone on the first that fails.
    unsafe {
        ShowWindow(h, SW_HIDE);
        let written = set_long(h, GWL_STYLE, styles::child(style))
            .and_then(|_| set_long(h, GWL_EXSTYLE, styles::child_ex(ex_style)))
            .and_then(|_| {
                SetLastError(0);
                let before = SetParent(h, clip);
                if before.is_null() && GetLastError() != 0 {
                    return Err(last_error("SetParent"));
                }
                Ok(())
            });
        if let Err(e) = written {
            SetParent(h, std::ptr::null_mut());
            SetWindowLongPtrW(h, GWL_STYLE, styles::restored(style));
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex_style);
            ShowWindow(h, SW_SHOWNOACTIVATE);
            close_clip(clip);
            return Err(e);
        }
        SetWindowPos(
            h,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(Saved {
        style: styles::popped_out(style),
        ex_style,
        clip: clip as isize,
    })
}

/// The class of the clip box a child sits in.
const CLIP_CLASS: *const u16 = windows_sys::w!("VeistraEmbedClip");

unsafe extern "system" fn clip_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_DESTROY {
        // SAFETY: ends this box's own message loop, on its own thread.
        unsafe { PostQuitMessage(0) };
        return 0;
    }
    if msg == WM_TIMER {
        // SAFETY: this box's own handle, from its own message.
        unsafe { refit(h) };
        return 0;
    }
    // SAFETY: every other message as Windows handles it.
    unsafe { DefWindowProcW(h, msg, w, l) }
}

/// How often a clip box checks that its window still fills it.
const REFIT_MS: u32 = 250;

/// Put the window in `clip` back at (0, 0) and the box's size, if it has
/// moved or resized itself. Godot does, after its editor loads: it restores
/// the window rect it saved last time (`[EditorWindow]` in
/// `editor_layout.cfg`), a screen position that a child takes as one inside
/// its box, so the editor sat offset in the pane with a dark band above and
/// beside it. Nothing tells the box when its child moves, so it looks.
///
/// Not while the box is hidden: before its first placement it is 1 x 1, and
/// the window would be squeezed to that.
///
/// # Safety
/// `clip` must be a window handle.
unsafe fn refit(clip: HWND) {
    // SAFETY: as the function's contract says; the child comes from it.
    unsafe {
        let child = GetWindow(clip, GW_CHILD);
        if child.is_null() || IsWindowVisible(clip) == 0 {
            return;
        }
        let (mut me, mut box_) = (empty(), empty());
        GetWindowRect(child, &mut me);
        GetWindowRect(clip, &mut box_);
        let (w, h) = (box_.right - box_.left, box_.bottom - box_.top);
        if fills((me, box_), (w, h)) {
            return;
        }
        // Asynchronous: a busy editor must not hold this box's thread.
        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
        SetWindowPos(child, std::ptr::null_mut(), 0, 0, w, h, flags);
    }
}

/// Whether a window's rect `me` is exactly at the top left of `box_` and
/// `size` big.
fn fills((me, box_): (RECT, RECT), size: (i32, i32)) -> bool {
    (
        me.left - box_.left,
        me.top - box_.top,
        me.right - me.left,
        me.bottom - me.top,
    ) == (0, 0, size.0, size.1)
}

/// A clip box in `owner`, hidden, on a thread of its own that reads its
/// messages until it is closed ([`close_clip`]). Its own thread, not
/// Veistra's main one, so nothing here needs the main thread, and a box is
/// answered even while the main thread is busy. It clips the window inside
/// it to the pane: an editor that holds itself larger than the pane (Godot's
/// floor is 1024 x 600 times its scale) is cut off at the pane's edge.
fn make_clip(owner: HWND) -> Result<HWND, String> {
    static CLASS: std::sync::Once = std::sync::Once::new();
    let (tx, rx) = std::sync::mpsc::channel();
    let parent = owner as isize;
    std::thread::Builder::new()
        .name("embed-clip".into())
        .spawn(move || {
            // SAFETY: a class registered once for this process, and a window
            // made, read and destroyed on this thread; the parent is a handle.
            unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                CLASS.call_once(|| {
                    let class = WNDCLASSW {
                        lpfnWndProc: Some(clip_proc),
                        hInstance: instance,
                        lpszClassName: CLIP_CLASS,
                        // COLOR_WINDOWTEXT + 1: the system's text colour,
                        // dark, for the moment before the window draws.
                        hbrBackground: 9 as _,
                        ..std::mem::zeroed()
                    };
                    RegisterClassW(&class);
                });
                let clip = CreateWindowExW(
                    WS_EX_NOPARENTNOTIFY,
                    CLIP_CLASS,
                    std::ptr::null(),
                    WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                    0,
                    0,
                    1,
                    1,
                    parent as HWND,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                let made = if clip.is_null() {
                    Err(last_error("CreateWindowExW"))
                } else {
                    Ok(clip as isize)
                };
                let _ = tx.send(made);
                if clip.is_null() {
                    return;
                }
                SetTimer(clip, 1, REFIT_MS, None);
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        })
        .map_err(|e| format!("could not start the clip box's thread: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "the clip box was not made".to_string())?
        .map(|h| h as HWND)
}

/// Close a clip box on its own thread, which then ends. Its child must have
/// left it first: a child goes with its parent.
fn close_clip(clip: HWND) {
    // SAFETY: posting to a box of ours; a stale handle fails harmlessly.
    unsafe { PostMessageW(clip, WM_CLOSE, 0, 0) };
}

/// Close the clip box a window was in, once its process has ended: the
/// window went with it, and the box would stay over the pane, empty.
pub fn discard(saved: &Saved) {
    if saved.clip != 0 {
        close_clip(saved.clip as HWND);
    }
}

/// The clip box `h` sits in, if it is in one of ours.
///
/// # Safety
/// `h` must be a window handle.
unsafe fn clip_of(h: HWND) -> Option<HWND> {
    // SAFETY: as the function's contract says.
    let parent = unsafe { GetParent(h) };
    let ours = !parent.is_null() && class_of(parent) == "VeistraEmbedClip" && {
        let mut pid = 0u32;
        // SAFETY: a handle `GetParent` just answered; `pid` is an out pointer.
        unsafe { GetWindowThreadProcessId(parent, &mut pid) };
        pid == std::process::id()
    };
    ours.then_some(parent)
}

/// The height of the primary monitor in physical pixels, which Blender's
/// `-p` counts its window's position up from.
pub fn primary_height() -> Option<i32> {
    // SAFETY: a plain query.
    let h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    (h > 0).then_some(h)
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

/// Move and size the window over `owner`, or hide it. The owner is checked
/// each time because the pane can move to another Veistra window while the
/// process runs.
pub fn place(
    hwnd: isize,
    r: ScreenRect,
    visible: bool,
    owner: isize,
    mode: Mode,
) -> Result<(), String> {
    if mode == Mode::Child {
        // SAFETY: as in `embed`.
        return unsafe { place_child(hwnd as HWND, r, visible, owner as HWND) };
    }
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

/// [`place`] for a child, `r` in `owner`'s client pixels. The clip box moves
/// first: it is Veistra's own window, so a move of the pane never waits on the
/// editor, and the editor is sent a size only when its size is not the box's.
///
/// # Safety
/// `h` and `owner` must be window handles.
unsafe fn place_child(h: HWND, r: ScreenRect, visible: bool, owner: HWND) -> Result<(), String> {
    // SAFETY: as the function's contract says; failures are reported.
    unsafe {
        let clip = clip_of(h).ok_or("the window is not in its clip box")?;
        if GetParent(clip) != owner {
            SetLastError(0);
            if SetParent(clip, owner).is_null() && GetLastError() != 0 {
                return Err(last_error("SetParent"));
            }
        }
        let was_visible = IsWindowVisible(clip) != 0;
        let show = if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
        // Top of the window's children, above the WebView it covers.
        if SetWindowPos(clip, HWND_TOP, r.x, r.y, r.w, r.h, SWP_NOACTIVATE | show) == 0 {
            return Err(last_error("SetWindowPos"));
        }
        let (mut me, mut box_) = (empty(), empty());
        GetWindowRect(h, &mut me);
        GetWindowRect(clip, &mut box_);
        let shown = GetWindowLongPtrW(h, GWL_STYLE) & WS_VISIBLE as isize != 0;
        let fits = fills((me, box_), (r.w, r.h));
        if visible && !(fits && shown) {
            let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;
            if SetWindowPos(h, std::ptr::null_mut(), 0, 0, r.w, r.h, flags) == 0 {
                return Err(last_error("SetWindowPos"));
            }
        }
        if was_visible != visible {
            set_owned(h, visible);
        }
    }
    Ok(())
}

fn empty() -> RECT {
    RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    }
}

/// Undo [`embed`]: the saved styles back, no owner and no parent, shown near
/// `near`. A child's clip box is closed once the window has left it.
pub fn release(hwnd: isize, saved: &Saved, near: Option<ScreenRect>) -> Result<(), String> {
    let h = hwnd as HWND;
    let child = saved.clip != 0;
    // SAFETY: as in `embed`.
    unsafe {
        ShowWindow(h, SW_HIDE);
        if child {
            // Then the style, below: `SetParent` asks for `WS_CHILD` to be
            // cleared after a window leaves its parent, not before.
            SetParent(h, std::ptr::null_mut());
            close_clip(saved.clip as HWND);
        }
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
        // An owned popup was already above Veistra; a child that has just
        // left it would land anywhere in the z-order, so it goes to the top.
        let (after, keep) = if child {
            (HWND_TOP, 0)
        } else {
            (std::ptr::null_mut(), SWP_NOZORDER)
        };
        let ok = SetWindowPos(
            h,
            after,
            at.x + 24,
            at.y + 24,
            at.w,
            at.h,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW | keep,
        );
        if ok == 0 {
            return Err(last_error("SetWindowPos"));
        }
    }
    set_owned(h, true);
    Ok(())
}

/// Show a window that keeps its own frame, over `near` when given, else
/// where it is, at the top of the z-order: Blender is started behind
/// Veistra (`--no-window-focus`), and one that is not placed must not stay
/// there. Restores a minimised one first, and never activates it.
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
        let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | keep;
        if SetWindowPos(h, HWND_TOP, r.x, r.y, r.w, r.h, flags) == 0 {
            return Err(last_error("SetWindowPos"));
        }
    }
    Ok(())
}

/// Two real windows, the way `cargo test` on `windows-latest` can make them:
/// one with Godot's class, standing in for the game, and one for Veistra.
/// Messages sent to a window of this thread are handled in the call, so the
/// test needs no message loop. Never run off Windows.
/// Post `WM_CLOSE`, what the title bar's close button sends: Godot answers it
/// with its own "save before closing?" prompt, Blender likewise. Posted, not
/// sent, so a window that is busy cannot stall the caller.
pub fn request_close(hwnd: isize) -> Result<(), String> {
    // SAFETY: as in `embed`; posting to a handle that has since closed fails
    // and is reported, it does not reach another window's queue unless the
    // value was reused, which `Embed::forget` guards against.
    if unsafe { PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0) } == 0 {
        return Err(last_error("PostMessageW"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, IsWindow, PeekMessageW, PM_REMOVE, WS_OVERLAPPEDWINDOW,
    };

    fn window(class: *const u16) -> HWND {
        made(class, WS_OVERLAPPEDWINDOW | WS_VISIBLE)
    }

    fn made(class: *const u16, style: u32) -> HWND {
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
                style,
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

        let saved = embed(game as isize, veistra as isize, Mode::Owned).expect("embed");
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
        place(game as isize, at, true, veistra as isize, Mode::Owned).expect("place");
        let r = rect(game);
        assert_eq!(
            (r.left, r.top, r.right - r.left, r.bottom - r.top),
            (200, 150, 400, 300)
        );
        // SAFETY: as above.
        assert_ne!(unsafe { IsWindowVisible(game) }, 0);
        place(game as isize, at, false, veistra as isize, Mode::Owned).expect("hide");
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

    /// The editor's way: a child of a clip box in Veistra, placed in Veistra's
    /// client pixels, carried by a move of Veistra with no call at all, and
    /// given back as a top-level window with a frame.
    #[test]
    fn a_real_editor_window_becomes_a_child_that_moves_with_veistra_and_comes_back() {
        // Borderless, so its window rect is its client area.
        let veistra = made(
            windows_sys::w!("VeistraEmbedTestParent"),
            WS_POPUP | WS_VISIBLE,
        );
        let editor = window(windows_sys::w!("GHOST_WindowClass"));
        assert!(!veistra.is_null() && !editor.is_null());
        let saved = embed(editor as isize, veistra as isize, Mode::Child).expect("embed");
        // SAFETY: plain queries on windows this test created.
        let clip = unsafe { clip_of(editor) }.expect("in a clip box");
        unsafe {
            assert_eq!(GetParent(clip), veistra, "the box is Veistra's child");
            let style = GetWindowLongPtrW(editor, GWL_STYLE) as u32;
            assert_ne!(style & WS_CHILD, 0);
            assert_eq!(style & (WS_CAPTION | WS_POPUP), 0);
        }
        let pane = ScreenRect {
            x: 30,
            y: 40,
            w: 320,
            h: 200,
        };
        place(editor as isize, pane, true, veistra as isize, Mode::Child).expect("place");
        let (v, e) = (rect(veistra), rect(editor));
        assert_eq!(
            (
                e.left - v.left,
                e.top - v.top,
                e.right - e.left,
                e.bottom - e.top
            ),
            (30, 40, 320, 200),
            "at the pane, in Veistra's client pixels"
        );
        // SAFETY: windows this test created.
        unsafe {
            let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
            SetWindowPos(
                veistra,
                std::ptr::null_mut(),
                v.left + 150,
                v.top + 90,
                0,
                0,
                flags,
            );
        }
        let moved = rect(editor);
        assert_eq!(
            (moved.left - e.left, moved.top - e.top),
            (150, 90),
            "Veistra's move carried it, with no placement made"
        );

        // Godot restoring its saved rect after load: a screen position, taken
        // as one inside the box. The box puts it back on its own.
        // SAFETY: a window this test created; its messages are read here,
        // since the box's correction is posted to this thread.
        unsafe {
            SetWindowPos(
                editor,
                std::ptr::null_mut(),
                222,
                344,
                900,
                500,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            let mut msg: MSG = std::mem::zeroed();
            for _ in 0..200 {
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if fills((rect(editor), rect(clip)), (320, 200)) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        assert!(
            fills((rect(editor), rect(clip)), (320, 200)),
            "back at the box's top left, its size"
        );
        place(editor as isize, pane, false, veistra as isize, Mode::Child).expect("hide");
        // SAFETY: as above.
        assert_eq!(
            unsafe { IsWindowVisible(editor) },
            0,
            "hidden with its pane"
        );

        release(editor as isize, &saved, None).expect("release");
        // SAFETY: as above.
        unsafe {
            assert!(GetParent(editor).is_null(), "top level again");
            let style = GetWindowLongPtrW(editor, GWL_STYLE) as u32;
            assert_eq!(style & WS_CHILD, 0);
            assert_ne!(style & WS_CAPTION, 0, "the frame is back");
            DestroyWindow(editor);
            DestroyWindow(veistra);
        }
    }

    /// An editor whose process ended took its window with it; the clip box is
    /// Veistra's and stays, empty and dark over the pane, until it is closed.
    #[test]
    fn the_clip_box_of_an_editor_that_ended_is_closed() {
        let veistra = made(
            windows_sys::w!("VeistraEmbedTestParentC"),
            WS_POPUP | WS_VISIBLE,
        );
        let editor = window(windows_sys::w!("GHOST_WindowClassC"));
        let saved = embed(editor as isize, veistra as isize, Mode::Child).expect("embed");
        // SAFETY: windows this test created; the box is checked with IsWindow.
        unsafe {
            let clip = clip_of(editor).expect("in a clip box");
            DestroyWindow(editor);
            assert_ne!(IsWindow(clip), 0, "the box outlives the window");
            discard(&saved);
            for _ in 0..200 {
                if IsWindow(clip) == 0 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(IsWindow(clip), 0, "and is closed");
            DestroyWindow(veistra);
        }
    }

    #[test]
    fn a_window_owned_by_veistra_still_counts_as_a_main_window() {
        let veistra = window(windows_sys::w!("VeistraEmbedTestOwnerB"));
        // SAFETY: plain queries; null is allowed.
        unsafe {
            assert!(owned_by_none_but_us(std::ptr::null_mut()));
            assert!(owned_by_none_but_us(veistra), "Godot's editor with --wid");
            DestroyWindow(veistra);
        }
    }
}
