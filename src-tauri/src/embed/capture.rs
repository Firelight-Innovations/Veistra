//! A placed window's last frame, for the still the pane shows while an
//! overlay covers its box (design §4.3). Windows Graphics Capture on the
//! window itself, which under R2 is that window alone, never Veistra's UI.
//!
//! **Why a source of its own.** §4.3.3 names the recorder's last frame and
//! the capture addon's `capture`, but Record is off by default and the addon
//! is opt-in, so a plain run had nothing to show, and the Godot editor and
//! Blender have neither. This needs neither: one frame is copied out every
//! [`EVERY`] and encoded to PNG only when asked. A hidden window sends no
//! frames, so the still is the last one before the hide, which is the frame
//! the person was looking at when the overlay opened.
//!
//! **Only where Windows can leave out its yellow capture border.** Older
//! Windows 10 draws one around a captured window for as long as the capture
//! runs, and a permanent border round the game is worse than no still; there
//! [`Watcher::start`] answers `None` and the pane falls back to the addon.
//! The recorder (`godot::record`) captures the same window in a session of
//! its own while a take runs, and its frame wins then.

use std::time::Duration;

/// How often a frame is copied out.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EVERY: Duration = Duration::from_millis(500);

/// A capture that keeps the window's last frame, until dropped.
pub struct Watcher(sys::Handle);

impl Watcher {
    /// `None` off Windows, where the border cannot be left out, or when the
    /// capture will not start.
    pub fn start(hwnd: isize) -> Option<Self> {
        sys::Handle::start(hwnd).map(Watcher)
    }
}

impl super::Still for Watcher {
    fn png(&self) -> Option<Vec<u8>> {
        self.0.png()
    }
}

#[cfg(windows)]
mod sys {
    use super::EVERY;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
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
    type Frame8 = Arc<Mutex<Option<(Vec<u8>, u32, u32)>>>;

    struct Keep {
        last: Frame8,
        copied: Option<Instant>,
    }

    impl GraphicsCaptureApiHandler for Keep {
        type Flags = Frame8;
        type Error = BoxError;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                last: ctx.flags,
                copied: None,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            if self.copied.is_some_and(|t| t.elapsed() < EVERY) {
                return Ok(());
            }
            self.copied = Some(Instant::now());
            let buffer = frame.buffer()?;
            let (w, h) = (buffer.width(), buffer.height());
            let mut bytes = Vec::new();
            let raw = buffer.as_nopadding_buffer(&mut bytes).to_vec();
            if let Ok(mut last) = self.last.lock() {
                *last = Some((raw, w, h));
            }
            Ok(())
        }
    }

    pub struct Handle {
        control: Option<CaptureControl<Keep, BoxError>>,
        last: Frame8,
    }

    impl Handle {
        pub fn start(hwnd: isize) -> Option<Self> {
            let can = |q: fn() -> Result<bool, windows_capture::graphics_capture_api::Error>| {
                q().unwrap_or(false)
            };
            if !can(GraphicsCaptureApi::is_border_settings_supported) {
                return None;
            }
            let last = Frame8::default();
            let settings = Settings::new(
                Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void),
                if can(GraphicsCaptureApi::is_cursor_settings_supported) {
                    CursorCaptureSettings::WithoutCursor
                } else {
                    CursorCaptureSettings::Default
                },
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                if can(GraphicsCaptureApi::is_minimum_update_interval_supported) {
                    MinimumUpdateIntervalSettings::Custom(EVERY)
                } else {
                    MinimumUpdateIntervalSettings::Default
                },
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                last.clone(),
            );
            match Keep::start_free_threaded(settings) {
                Ok(control) => Some(Self {
                    control: Some(control),
                    last,
                }),
                Err(e) => {
                    crate::veistra_log!("embed: no still for this window: {e}");
                    None
                }
            }
        }

        pub fn png(&self) -> Option<Vec<u8>> {
            let last = self.last.lock().ok()?;
            let (raw, w, h) = last.as_ref()?;
            ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Bgra8)
                .ok()?
                .encode(raw, *w, *h)
                .ok()
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if let Some(control) = self.control.take() {
                let _ = control.stop();
            }
        }
    }
}

#[cfg(not(windows))]
mod sys {
    pub struct Handle;

    impl Handle {
        pub fn start(_hwnd: isize) -> Option<Self> {
            None
        }

        pub fn png(&self) -> Option<Vec<u8>> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    #[test]
    fn off_windows_there_is_no_still_and_nothing_is_started() {
        assert!(super::Watcher::start(7).is_none());
    }
}
