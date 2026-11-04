//! Recording a run's window for a take (design §5.2), Windows only.
//!
//! Windows Graphics Capture, through `windows-capture`, captures the game's
//! own window (R2 in [`crate::embed`]), so a take never contains Veistra's UI.
//! Each frame goes to [`super::encode`], which fits it inside the take's size
//! and writes H.264.
//!
//! **Take time zero is the first frame**, in wall-clock milliseconds: the
//! frame's own capture time (`SystemRelativeTime`, on the QPC clock) moved onto
//! the wall clock by [`frame_wall_ms`], rather than when the callback ran,
//! which can be a frame or two later. The encoder writes frame times relative
//! to the first frame, so video time plus that stamp is wall time, the clock
//! the addon's telemetry and the log share.
//!
//! **Stopping is two steps**, [`Capture::halt`] and then [`Halted::finish`]:
//! capture stops at once and the MP4 is closed after, so the take's other
//! files never wait for the encoder to drain (take.json within a second of
//! Stop, §13 test 3).
//!
//! **Older Windows still records**: see [`Gate`].

use super::encode::Quality;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// What a stopped recording reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    /// Wall-clock milliseconds of the first frame, `None` when none arrived.
    pub first_frame_ms: Option<u64>,
    pub frames: u64,
    /// Frames the encoder could not keep up with.
    pub dropped: u64,
    /// The size the video is encoded at, not the window's.
    pub width: u32,
    pub height: u32,
}

/// A stopped recording whose MP4 is still being closed.
pub struct Halted {
    pub stopped: Stopped,
    /// Drains the encoder and closes the file: up to a second or so, which is
    /// why the caller runs it beside the take's other files.
    pub finish: Box<dyn FnOnce() -> Result<(), String> + Send>,
}

/// A recording in progress: Graphics Capture on Windows, a fake in the tests.
pub trait Capture: Send {
    fn first_frame_ms(&self) -> Option<u64>;
    /// The latest frame as a PNG, for a still over the pane (design §4.3).
    fn still_png(&self) -> Option<Vec<u8>>;
    /// Stop capturing. No frame arrives after this returns.
    fn halt(self: Box<Self>) -> Result<Halted, String>;
}

/// How a session starts recording a window into a file.
pub type Start =
    Arc<dyn Fn(isize, &Path, &Quality) -> Result<Box<dyn Capture>, String> + Send + Sync>;

/// Start recording `hwnd` into `path` at `quality`.
pub fn start(hwnd: isize, path: &Path, quality: &Quality) -> Result<Box<dyn Capture>, String> {
    sys::Handle::start(hwnd, path, quality).map(|h| Box::new(h) as Box<dyn Capture>)
}

/// Why recording cannot start here, or `None` when it can.
pub fn unavailable() -> Option<&'static str> {
    sys::unavailable()
}

/// The wall-clock time of a frame captured at `frame_100ns` on the QPC clock,
/// given that clock and the wall clock read together now. A frame stamped in
/// the future, or more than a second ago, means the two clocks disagree, and
/// then now is the better answer.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn frame_wall_ms(frame_100ns: i64, qpc_now_100ns: i64, wall_now_ms: u64) -> u64 {
    let ago = qpc_now_100ns.saturating_sub(frame_100ns) / 10_000;
    match u64::try_from(ago) {
        Ok(ago) if ago <= 1_000 => wall_now_ms.saturating_sub(ago),
        _ => wall_now_ms,
    }
}

/// Lets frames through at no more than one per `every`, for a capture
/// session that cannot be told a minimum interval itself.
///
/// Hiding the cursor and the yellow border, and capping the frame rate, are
/// properties Windows 10 and early Windows 11 lack, and asking for one the
/// session does not have fails the whole capture. Each is asked for only
/// where it exists; without the cap, this drops frames to the take's rate.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct Gate {
    every: Duration,
    due: Option<Duration>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Gate {
    pub fn new(every: Duration) -> Self {
        Self { every, due: None }
    }

    /// Whether the frame captured at `at` is kept. A frame up to a quarter
    /// interval early still counts, so a 60 Hz game's frames, which land
    /// either side of each 30 Hz slot, keep 30 a second rather than 20; the
    /// next slot follows the last one, not the frame, so that jitter never
    /// drifts the rate, unless the game stalled for a whole interval.
    pub fn admit(&mut self, at: Duration) -> bool {
        let due = *self.due.get_or_insert(at);
        if at + self.every / 4 < due {
            return false;
        }
        let next = due + self.every;
        self.due = Some(if at >= next { at + self.every } else { next });
        true
    }
}

#[cfg(windows)]
mod sys {
    use super::{frame_wall_ms, Capture, Gate, Halted, Stopped};
    use crate::godot::encode::{output_size, Encoder, Quality};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::{Duration, Instant};
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    type BoxError = Box<dyn std::error::Error + Send + Sync>;

    /// How often the raw last frame is copied out for a still.
    const STILL_EVERY: Duration = Duration::from_millis(500);

    /// What the capture thread and the caller share.
    #[derive(Default)]
    struct Shared {
        first_frame_ms: AtomicU64,
        frames: AtomicU64,
        last: Mutex<Option<(Vec<u8>, u32, u32)>>,
        /// Why the encoder refused a frame. That ends the video but not the
        /// take, whose telemetry and log are still worth keeping.
        failed: Mutex<Option<String>>,
    }

    struct Flags {
        path: std::path::PathBuf,
        width: u32,
        height: u32,
        quality: Quality,
        shared: Arc<Shared>,
        gate: Option<Gate>,
    }

    struct Recording {
        encoder: Option<Encoder>,
        shared: Arc<Shared>,
        last_copy: Option<Instant>,
        gate: Option<Gate>,
        failed: bool,
    }

    /// The QPC clock now, in the 100 ns ticks a frame's time is given in.
    fn qpc_now_100ns() -> i64 {
        use windows_sys::Win32::System::Performance::{
            QueryPerformanceCounter, QueryPerformanceFrequency,
        };
        let (mut count, mut freq) = (0i64, 0i64);
        // SAFETY: each writes one i64 through a pointer to a live local.
        unsafe {
            QueryPerformanceCounter(&mut count);
            QueryPerformanceFrequency(&mut freq);
        }
        if freq <= 0 {
            return 0;
        }
        i64::try_from(i128::from(count) * 10_000_000 / i128::from(freq)).unwrap_or(i64::MAX)
    }

    impl GraphicsCaptureApiHandler for Recording {
        type Flags = Flags;
        type Error = BoxError;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let f = ctx.flags;
            let encoder = Encoder::new(&f.path, f.width, f.height, &f.quality)?;
            Ok(Self {
                encoder: Some(encoder),
                shared: f.shared,
                last_copy: None,
                gate: f.gate,
                failed: false,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let at = frame.timestamp()?.Duration;
            if let Some(gate) = self.gate.as_mut() {
                let ticks = u64::try_from(at).unwrap_or(0);
                if !gate.admit(Duration::from_nanos(ticks.saturating_mul(100))) {
                    return Ok(());
                }
            }
            if self.shared.first_frame_ms.load(Ordering::SeqCst) == 0 {
                let wall = frame_wall_ms(at, qpc_now_100ns(), crate::godot::runner::now_ms());
                self.shared
                    .first_frame_ms
                    .store(wall.max(1), Ordering::SeqCst);
            }
            self.shared.frames.fetch_add(1, Ordering::Relaxed);
            if let (Some(encoder), false) = (self.encoder.as_mut(), self.failed) {
                // Not returned as an error: that ends the capture with the
                // encoder still open, where `halt` can close it.
                if let Err(e) = encoder.push(frame) {
                    crate::veistra_log!("play: the recording stopped encoding: {e}");
                    self.failed = true;
                    *self
                        .shared
                        .failed
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(e);
                }
            }
            if self.last_copy.is_none_or(|t| t.elapsed() >= STILL_EVERY) {
                self.last_copy = Some(Instant::now());
                let buffer = frame.buffer()?;
                let (w, h) = (buffer.width(), buffer.height());
                let mut bytes = Vec::new();
                let raw = buffer.as_nopadding_buffer(&mut bytes).to_vec();
                if let Ok(mut last) = self.shared.last.lock() {
                    *last = Some((raw, w, h));
                }
            }
            Ok(())
        }
    }

    pub struct Handle {
        control: Option<CaptureControl<Recording, BoxError>>,
        shared: Arc<Shared>,
        size: (u32, u32),
    }

    pub fn unavailable() -> Option<&'static str> {
        None
    }

    /// The window's client size, which the video's size is fitted from.
    fn client_size(hwnd: isize) -> Result<(u32, u32), String> {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;
        let mut r = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: a stale handle makes GetClientRect fail, which is checked.
        if unsafe { GetClientRect(hwnd as _, &mut r) } == 0 {
            return Err(format!(
                "GetClientRect failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let side = |v: i32| u32::try_from(v.max(2)).unwrap_or(2);
        Ok((side(r.right - r.left), side(r.bottom - r.top)))
    }

    impl Handle {
        pub fn start(hwnd: isize, path: &Path, quality: &Quality) -> Result<Self, String> {
            let (width, height) = client_size(hwnd)?;
            let shared = Arc::new(Shared::default());
            let every = Duration::from_secs(1) / quality.fps.max(1);
            let can = |q: fn() -> Result<bool, windows_capture::graphics_capture_api::Error>| {
                q().unwrap_or(false)
            };
            let capped = can(GraphicsCaptureApi::is_minimum_update_interval_supported);
            let settings = Settings::new(
                Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void),
                if can(GraphicsCaptureApi::is_cursor_settings_supported) {
                    CursorCaptureSettings::WithoutCursor
                } else {
                    CursorCaptureSettings::Default
                },
                if can(GraphicsCaptureApi::is_border_settings_supported) {
                    DrawBorderSettings::WithoutBorder
                } else {
                    DrawBorderSettings::Default
                },
                SecondaryWindowSettings::Default,
                if capped {
                    MinimumUpdateIntervalSettings::Custom(every)
                } else {
                    MinimumUpdateIntervalSettings::Default
                },
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                Flags {
                    path: path.to_path_buf(),
                    width,
                    height,
                    quality: *quality,
                    shared: shared.clone(),
                    gate: (!capped).then(|| Gate::new(every)),
                },
            );
            let control = Recording::start_free_threaded(settings)
                .map_err(|e| format!("could not start recording: {e}"))?;
            Ok(Self {
                control: Some(control),
                shared,
                size: output_size(width, height, quality),
            })
        }
    }

    impl Capture for Handle {
        fn first_frame_ms(&self) -> Option<u64> {
            match self.shared.first_frame_ms.load(Ordering::SeqCst) {
                0 => None,
                t => Some(t),
            }
        }

        fn still_png(&self) -> Option<Vec<u8>> {
            let last = self.shared.last.lock().ok()?;
            let (raw, w, h) = last.as_ref()?;
            ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Bgra8)
                .ok()?
                .encode(raw, *w, *h)
                .ok()
        }

        /// Stop capturing first, so no frame arrives after the encoder is
        /// told the stream has ended; the caller finishes the encoder.
        fn halt(mut self: Box<Self>) -> Result<Halted, String> {
            let Some(control) = self.control.take() else {
                return Err("already stopped".into());
            };
            let callback = control.callback();
            control
                .stop()
                .map_err(|e| format!("could not stop recording: {e}"))?;
            let encoder = callback.lock().encoder.take();
            let counts = encoder.as_ref().map(Encoder::counts);
            let failed = self
                .shared
                .failed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            let stopped = Stopped {
                first_frame_ms: self.first_frame_ms(),
                frames: self.shared.frames.load(Ordering::Relaxed),
                dropped: counts
                    .as_ref()
                    .map_or(0, |c| c.dropped.load(Ordering::Relaxed)),
                width: self.size.0,
                height: self.size.1,
            };
            let finish = move || {
                let closed = encoder.map_or(Ok(()), Encoder::finish);
                let busy = counts.map_or(0, |c| c.reused_busy.load(Ordering::Relaxed));
                if busy > 0 {
                    crate::veistra_log!("play: {busy} frames drawn over one still encoding");
                }
                failed.map_or(closed, Err)
            };
            Ok(Halted {
                stopped,
                finish: Box::new(finish),
            })
        }
    }

    /// A recording dropped without `halt` (a panic on the way to it) still
    /// ends its capture thread rather than leaving it running.
    impl Drop for Handle {
        fn drop(&mut self) {
            if let Some(control) = self.control.take() {
                let _ = control.stop();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::super::start;
        use crate::godot::encode::Quality;
        use crate::godot::mp4;
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, SetWindowTextW,
            TranslateMessage, MSG, PM_REMOVE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(Some(0)).collect()
        }

        /// Pump this thread's messages for `ms`, changing the window's text
        /// each pass so every frame differs and Graphics Capture sends one.
        fn pump(hwnd: HWND, ms: u64) {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
            let mut n = 0u64;
            while std::time::Instant::now() < until {
                n += 1;
                let text = wide(&format!("frame {n}"));
                // SAFETY: a window this thread made and a live message buffer.
                unsafe {
                    SetWindowTextW(hwnd, text.as_ptr());
                    let mut msg: MSG = std::mem::zeroed();
                    while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(16));
            }
        }

        /// Needs a desktop session: `cargo test -p veistra-orchestrator
        /// record_ -- --ignored` on Windows 11. The design's §13 test 3 is the
        /// same check on a real game.
        #[test]
        #[ignore = "needs a Windows 11 desktop session"]
        fn record_a_window_to_a_720p_mp4_with_a_keyframe_a_second_and_no_audio() {
            let dir = tempfile::TempDir::new().unwrap();
            let path = dir.path().join("take.mp4");
            let class = wide("STATIC");
            let title = wide("veistra record test");
            // SAFETY: a plain STATIC window, destroyed below.
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    100,
                    100,
                    1600,
                    900,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    GetModuleHandleW(std::ptr::null()),
                    std::ptr::null(),
                )
            };
            assert!(!hwnd.is_null(), "CreateWindowExW");
            let capture = start(hwnd as isize, &path, &Quality::DEFAULT).unwrap();
            pump(hwnd, 3_000);
            let halted = capture.halt().unwrap();
            (halted.finish)().unwrap();
            // SAFETY: the window made above.
            unsafe { DestroyWindow(hwnd) };
            assert!(halted.stopped.frames > 30, "{:?}", halted.stopped);
            let info = mp4::read(&path).unwrap();
            assert!(info.width <= 1280 && info.height <= 720, "{info:?}");
            assert!(info.max_keyframe_gap_ms <= 1_100, "{info:?}");
            assert!(!info.has_audio, "{info:?}");
            let bytes = std::fs::metadata(&path).unwrap().len();
            let two_minutes = bytes * 120_000 / info.duration_ms.max(1);
            assert!(
                two_minutes <= 60_000_000,
                "{two_minutes} bytes for two minutes"
            );
        }
    }
}

/// Everywhere but Windows there is no recorder yet, and Rec says so.
#[cfg(not(windows))]
mod sys {
    use super::{Capture, Halted};
    use crate::godot::encode::Quality;
    use std::path::Path;

    pub struct Handle;

    pub fn unavailable() -> Option<&'static str> {
        Some("Recording needs Windows for now.")
    }

    impl Handle {
        pub fn start(_hwnd: isize, _path: &Path, _quality: &Quality) -> Result<Self, String> {
            Err(unavailable().unwrap_or_default().to_string())
        }
    }

    impl Capture for Handle {
        fn first_frame_ms(&self) -> Option<u64> {
            None
        }

        fn still_png(&self) -> Option<Vec<u8>> {
            None
        }

        fn halt(self: Box<Self>) -> Result<Halted, String> {
            Err(unavailable().unwrap_or_default().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn without_a_recorder_rec_says_why_and_starting_is_refused() {
        assert!(unavailable().is_some_and(|w| w.contains("Windows")));
        assert!(start(0, Path::new("take.mp4"), &Quality::DEFAULT).is_err());
    }

    fn kept(fps_in: u64, seconds: u64) -> usize {
        let mut gate = Gate::new(Duration::from_secs(1) / Quality::DEFAULT.fps);
        let step = 1_000_000_000 / fps_in;
        (0..fps_in * seconds)
            .filter(|i| gate.admit(Duration::from_nanos(i * step)))
            .count()
    }

    #[test]
    fn without_a_capped_session_frames_are_kept_at_thirty_a_second() {
        assert!((29..=31).contains(&kept(60, 1)), "{}", kept(60, 1));
        assert!((29..=31).contains(&kept(144, 1)), "{}", kept(144, 1));
        assert!(
            (299..=301).contains(&kept(60, 10)),
            "no drift: {}",
            kept(60, 10)
        );
        assert_eq!(kept(30, 1), 30, "a 30 Hz game loses nothing");
        assert_eq!(kept(20, 1), 20);
        let mut gate = Gate::new(Duration::from_millis(33));
        let ms = Duration::from_millis;
        assert!(gate.admit(ms(0)));
        assert!(gate.admit(ms(1_000)), "after a stall");
        assert!(!gate.admit(ms(1_016)), "and no burst after it");
        assert!(gate.admit(ms(1_033)));
    }

    #[test]
    fn a_frame_is_stamped_with_when_it_was_captured_not_when_it_arrived() {
        let wall = 1_793_398_920_000;
        let qpc = 50_000_000_000;
        assert_eq!(
            frame_wall_ms(qpc - 450_000, qpc, wall),
            wall - 45,
            "45 ms ago"
        );
        assert_eq!(frame_wall_ms(qpc, qpc, wall), wall);
        assert_eq!(
            frame_wall_ms(qpc + 10_000, qpc, wall),
            wall,
            "from the future"
        );
        assert_eq!(
            frame_wall_ms(qpc - 20_000_000, qpc, wall),
            wall,
            "two seconds old: the clocks disagree"
        );
        assert_eq!(frame_wall_ms(i64::MIN, i64::MAX, wall), wall);
    }
}
