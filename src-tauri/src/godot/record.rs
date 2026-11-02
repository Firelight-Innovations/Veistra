//! Recording a run to `take.mp4` (design §5.2), Windows only.
//!
//! `windows-capture` wraps Windows Graphics Capture and Media Foundation's
//! hardware encoder. It captures the game's own window (R2 in [`super::embed`]),
//! so a take never contains Veistra's UI.
//!
//! **The video is the window's size, not 720p.** The crate's encoder pads or
//! crops a frame to its target size; it does not scale, and the pane decides
//! the window's size. A scaling pass (a D3D11 video processor before the
//! encoder) is the follow-up that gets the design's 720p. Until then the
//! bitrate is fixed at [`BITRATE`], which is what keeps a two-minute take
//! under the 60 MB the acceptance test allows whatever the window's size.
//!
//! **Take time zero is the first frame**, stamped in wall-clock milliseconds
//! when it reaches this process. The encoder writes frame times relative to
//! the first frame, so video time plus that stamp is wall time, the clock the
//! addon's telemetry and the log share.
//!
//! **Older Windows still records**: see [`Gate`].

use serde::Serialize;
use std::path::Path;
use std::time::Duration;

/// 3.5 Mbit/s: two minutes is 52.5 MB. Read only by the Windows recorder.
#[cfg_attr(not(windows), allow(dead_code))]
pub const BITRATE: u32 = 3_500_000;
pub const FPS: u32 = 30;

/// What a finished recording reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    /// Wall-clock milliseconds of the first frame, `None` when none arrived.
    pub first_frame_ms: Option<u64>,
    pub frames: u64,
    pub width: u32,
    pub height: u32,
}

/// Lets frames through at no more than one per `every`, for a capture
/// session that cannot be told a minimum interval itself.
///
/// Hiding the cursor and the yellow border, and capping the frame rate, are
/// properties Windows 10 and early Windows 11 lack, and asking for one the
/// session does not have fails the whole capture. Each is asked for only
/// where it exists; without the cap, this drops frames to [`FPS`] instead.
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

/// Why recording cannot start here, or `None` when it can.
pub fn unavailable() -> Option<&'static str> {
    sys::unavailable()
}

/// A recording in progress.
pub struct Recorder(sys::Handle);

impl Recorder {
    /// Start recording `hwnd` into `path`.
    pub fn start(hwnd: isize, path: &Path) -> Result<Self, String> {
        sys::Handle::start(hwnd, path).map(Recorder)
    }

    pub fn first_frame_ms(&self) -> Option<u64> {
        self.0.first_frame_ms()
    }

    /// The latest frame as a PNG, for a still over the pane (design §4.3).
    /// The frame is copied out raw about twice a second, so this is one PNG
    /// encode away and costs nothing when no overlay ever opens.
    pub fn still_png(&self) -> Option<Vec<u8>> {
        self.0.still_png()
    }

    /// Stop and finish the file. Blocks until the MP4 is closed, about a second.
    pub fn stop(self) -> Result<Stopped, String> {
        self.0.stop()
    }
}

#[cfg(windows)]
mod sys {
    use super::{Gate, Stopped, BITRATE, FPS};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, ImageEncoder, ImageEncoderPixelFormat,
        ImageFormat, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType,
    };
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
    }

    struct Flags {
        path: std::path::PathBuf,
        width: u32,
        height: u32,
        shared: Arc<Shared>,
        gate: Option<Gate>,
    }

    struct Capture {
        encoder: Option<VideoEncoder>,
        shared: Arc<Shared>,
        last_copy: Option<Instant>,
        gate: Option<Gate>,
    }

    impl GraphicsCaptureApiHandler for Capture {
        type Flags = Flags;
        type Error = BoxError;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let f = ctx.flags;
            let video = VideoSettingsBuilder::new(f.width, f.height)
                .sub_type(VideoSettingsSubType::H264)
                .bitrate(BITRATE)
                .frame_rate(FPS);
            let encoder = VideoEncoder::new(
                video,
                AudioSettingsBuilder::default().disabled(true),
                ContainerSettingsBuilder::default(),
                &f.path,
            )?;
            Ok(Self {
                encoder: Some(encoder),
                shared: f.shared,
                last_copy: None,
                gate: f.gate,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            if let Some(gate) = self.gate.as_mut() {
                // `SystemRelativeTime` counts in 100 ns ticks.
                let ticks = u64::try_from(frame.timestamp()?.Duration).unwrap_or(0);
                if !gate.admit(Duration::from_nanos(ticks.saturating_mul(100))) {
                    return Ok(());
                }
            }
            let _ = self.shared.first_frame_ms.compare_exchange(
                0,
                crate::godot::runner::now_ms(),
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            self.shared.frames.fetch_add(1, Ordering::Relaxed);
            if let Some(encoder) = self.encoder.as_mut() {
                encoder.send_frame(frame)?;
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
        control: Option<CaptureControl<Capture, BoxError>>,
        shared: Arc<Shared>,
        width: u32,
        height: u32,
    }

    pub fn unavailable() -> Option<&'static str> {
        None
    }

    /// The window's client size, rounded down to even numbers for H.264.
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
        let even = |v: i32| (v.max(2) as u32) & !1;
        Ok((even(r.right - r.left), even(r.bottom - r.top)))
    }

    impl Handle {
        pub fn start(hwnd: isize, path: &Path) -> Result<Self, String> {
            let (width, height) = client_size(hwnd)?;
            let shared = Arc::new(Shared::default());
            let every = Duration::from_secs(1) / FPS;
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
                    shared: shared.clone(),
                    gate: (!capped).then(|| Gate::new(every)),
                },
            );
            let control = Capture::start_free_threaded(settings)
                .map_err(|e| format!("could not start recording: {e}"))?;
            Ok(Self {
                control: Some(control),
                shared,
                width,
                height,
            })
        }

        pub fn first_frame_ms(&self) -> Option<u64> {
            match self.shared.first_frame_ms.load(Ordering::SeqCst) {
                0 => None,
                t => Some(t),
            }
        }

        pub fn still_png(&self) -> Option<Vec<u8>> {
            let last = self.shared.last.lock().ok()?;
            let (raw, w, h) = last.as_ref()?;
            ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Bgra8)
                .ok()?
                .encode(raw, *w, *h)
                .ok()
        }

        /// Stop capturing first, so no frame arrives after the encoder is
        /// told the stream has ended, then finish the encoder.
        pub fn stop(mut self) -> Result<Stopped, String> {
            let Some(control) = self.control.take() else {
                return Err("already stopped".into());
            };
            let callback = control.callback();
            control
                .stop()
                .map_err(|e| format!("could not stop recording: {e}"))?;
            let encoder = callback.lock().encoder.take();
            if let Some(encoder) = encoder {
                encoder
                    .finish()
                    .map_err(|e| format!("could not finish take.mp4: {e}"))?;
            }
            Ok(Stopped {
                first_frame_ms: self.first_frame_ms(),
                frames: self.shared.frames.load(Ordering::Relaxed),
                width: self.width,
                height: self.height,
            })
        }
    }

    /// A recording dropped without `stop` (a panic on the way to it) still
    /// ends its capture thread rather than leaving it running.
    impl Drop for Handle {
        fn drop(&mut self) {
            if let Some(control) = self.control.take() {
                let _ = control.stop();
            }
        }
    }
}

/// Everywhere but Windows there is no recorder yet, and Rec says so.
#[cfg(not(windows))]
mod sys {
    use super::Stopped;
    use std::path::Path;

    pub struct Handle;

    pub fn unavailable() -> Option<&'static str> {
        Some("Recording needs Windows for now.")
    }

    impl Handle {
        pub fn start(_hwnd: isize, _path: &Path) -> Result<Self, String> {
            Err(unavailable().unwrap_or_default().to_string())
        }

        pub fn first_frame_ms(&self) -> Option<u64> {
            None
        }

        pub fn still_png(&self) -> Option<Vec<u8>> {
            None
        }

        pub fn stop(self) -> Result<Stopped, String> {
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
        assert!(Recorder::start(0, Path::new("take.mp4")).is_err());
    }

    fn kept(fps_in: u64, seconds: u64) -> usize {
        let mut gate = Gate::new(Duration::from_secs(1) / FPS);
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
    fn the_bitrate_keeps_two_minutes_under_sixty_megabytes() {
        let bytes = u64::from(BITRATE) / 8 * 120;
        assert!(bytes <= 60 * 1_000_000, "{bytes} bytes");
    }
}
