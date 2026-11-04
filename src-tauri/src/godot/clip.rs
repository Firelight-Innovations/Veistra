//! A note's video clip, cut from the take's `take.mp4` when the person ticks
//! "Video clip per note" at Send (design §9.1). Off by default: the agent reads
//! the contact sheet, and a clip is for a person who wants to watch it.
//!
//! Cut here rather than drawn in the page. The page could only record one by
//! playing the span in real time through `MediaRecorder`, and would then ship
//! the bytes over the bridge; Windows' own media transcoder trims the file
//! faster than real time and writes `notes/<n>/clip.mp4` straight to the
//! packet. It re-encodes, so the clip starts on a frame of its own whatever the
//! take's keyframes are.
//!
//! Windows only, like the recorder. Elsewhere [`unavailable`] says why and the
//! page shows the tick disabled with that reason.

use std::path::Path;

/// How far a clip runs past its note on each side: the contact sheet's span.
pub const PAD_MS: u64 = 2_000;

/// The span a note's clip covers, `(from, to)` in take milliseconds: two
/// seconds before its in point (or the note's moment) to two seconds after its
/// out point, inside the take.
pub fn window(in_ms: Option<u64>, out_ms: Option<u64>, at_ms: u64, duration_ms: u64) -> (u64, u64) {
    let from = in_ms.unwrap_or(at_ms).min(at_ms).saturating_sub(PAD_MS);
    let to = out_ms
        .unwrap_or(at_ms)
        .max(at_ms)
        .saturating_add(PAD_MS)
        .min(duration_ms);
    (from.min(to), to)
}

/// Why clips cannot be cut on this machine, or `None` when they can.
pub fn unavailable() -> Option<&'static str> {
    if cfg!(windows) {
        None
    } else {
        Some("Video clips are cut by the Windows media transcoder, so only Windows makes them.")
    }
}

/// Write the part of `src` from `from_ms` to `to_ms` to `dst` as an MP4.
pub fn cut(src: &Path, dst: &Path, from_ms: u64, to_ms: u64) -> Result<(), String> {
    if to_ms <= from_ms {
        return Err("the clip would be empty".into());
    }
    #[cfg(windows)]
    {
        sys::cut(src, dst, from_ms, to_ms)
    }
    #[cfg(not(windows))]
    {
        let _ = (src, dst);
        Err(unavailable().unwrap_or_default().into())
    }
}

#[cfg(windows)]
mod sys {
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use windows::core::HSTRING;
    use windows::Media::MediaProperties::{MediaEncodingProfile, VideoEncodingQuality};
    use windows::Media::Transcoding::MediaTranscoder;
    use windows::Storage::StorageFile;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    /// On a thread of its own, in the multithreaded apartment the transcoder's
    /// async calls need, so the app-call worker's apartment is never changed.
    pub fn cut(src: &Path, dst: &Path, from_ms: u64, to_ms: u64) -> Result<(), String> {
        let (src, dst) = (src.to_path_buf(), dst.to_path_buf());
        std::thread::spawn(move || {
            // SAFETY: a fresh thread, initialised once and uninitialised below.
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
                .map_err(|e| format!("could not start WinRT for the clip: {e}"))?;
            let done = transcode(&src, &dst, from_ms, to_ms);
            // SAFETY: balances the RoInitialize above, on the same thread.
            unsafe { RoUninitialize() };
            if done.is_err() {
                let _ = std::fs::remove_file(&dst);
            }
            done
        })
        .join()
        .unwrap_or_else(|_| Err("the clip cutter panicked".into()))
    }

    /// WinRT takes an absolute path without the `\\?\` prefix `canonicalize`
    /// would add.
    fn file(path: &Path) -> Result<StorageFile, String> {
        let path: PathBuf = std::path::absolute(path).map_err(|e| format!("bad clip path: {e}"))?;
        StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str().to_os_string()))
            .and_then(|op| op.join())
            .map_err(|e| format!("could not open {}: {e}", path.display()))
    }

    fn transcode(src: &Path, dst: &Path, from_ms: u64, to_ms: u64) -> Result<(), String> {
        let input = file(src)?;
        std::fs::File::create(dst).map_err(|e| format!("could not create clip.mp4: {e}"))?;
        let output = file(dst)?;
        let err = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
        let transcoder = MediaTranscoder::new().map_err(err("no transcoder"))?;
        transcoder
            .SetHardwareAccelerationEnabled(true)
            .map_err(err("no hardware encoder setting"))?;
        // Both are positions in the source: where the clip starts and ends.
        transcoder
            .SetTrimStartTime(Duration::from_millis(from_ms).into())
            .map_err(err("could not set the clip's start"))?;
        transcoder
            .SetTrimStopTime(Duration::from_millis(to_ms).into())
            .map_err(err("could not set the clip's end"))?;
        let profile = MediaEncodingProfile::CreateMp4(VideoEncodingQuality::Auto)
            .map_err(err("no MP4 profile"))?;
        let prepared = transcoder
            .PrepareFileTranscodeAsync(&input, &output, &profile)
            .and_then(|op| op.join())
            .map_err(err("could not prepare the clip"))?;
        if !prepared.CanTranscode().unwrap_or(false) {
            let why = prepared.FailureReason().map(|r| r.0).unwrap_or(-1);
            return Err(format!("the transcoder refused this take (reason {why})"));
        }
        prepared
            .TranscodeAsync()
            .and_then(|op| op.join())
            .map_err(err("could not cut the clip"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clip_runs_two_seconds_past_its_note_inside_the_take() {
        assert_eq!(
            window(Some(98_000), Some(106_000), 102_180, 151_400),
            (96_000, 108_000)
        );
        assert_eq!(window(None, None, 41_000, 151_400), (39_000, 43_000));
        assert_eq!(
            window(None, None, 500, 151_400),
            (0, 2_500),
            "not before the start"
        );
        assert_eq!(
            window(None, None, 150_000, 151_400),
            (148_000, 151_400),
            "not past the end"
        );
        assert_eq!(
            window(None, None, 9_000, 0),
            (0, 0),
            "a take with no length"
        );
    }

    #[test]
    fn off_windows_a_clip_is_refused_with_the_reason_the_page_shows() {
        if cfg!(windows) {
            assert!(unavailable().is_none());
            return;
        }
        let why = unavailable().unwrap();
        let dir = tempfile::TempDir::new().unwrap();
        let err = cut(
            &dir.path().join("take.mp4"),
            &dir.path().join("clip.mp4"),
            0,
            1_000,
        )
        .unwrap_err();
        assert_eq!(err, why);
        assert!(!dir.path().join("clip.mp4").exists());
        assert!(cut(Path::new("a"), Path::new("b"), 5, 5).is_err());
    }
}
