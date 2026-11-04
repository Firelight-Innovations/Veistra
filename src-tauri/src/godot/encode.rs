//! The numbers a take's video is held to (design §5.2), and on Windows the
//! encoder that holds it to them.
//!
//! **720p at 30 fps by default**: the window's frame scaled to fit inside
//! 1280x720, keeping its shape, never upscaled, with even sides for H.264
//! ([`output_size`]). The size is fixed when the take starts and every frame
//! is stretched to it, so a pane resized mid-take changes the picture's
//! sharpness, never its framing: review maps a pin to the game's pixels by
//! proportion, and black bars or a cropped corner would move every pin.
//!
//! **A keyframe every second**, so review seeks to any mark without decoding
//! from the start. Media Foundation has no first-class setting for it through
//! the WinRT transcoder; both keys an H.264 encoder reads are set
//! ([`Quality::gop_frames`]), and `mp4::read` checks the result on a real take.
//!
//! The Windows half is adapted from `windows-capture` 2.0.1's `VideoEncoder`
//! (MIT, by NiiightmareXD), which keeps the window's size and queues without
//! bound. This one scales into textures of its own and drops a frame rather
//! than queue a second of them (docs/design-notes/godot-play.md, #310).

use serde::Serialize;

/// What a recording is encoded at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub max_width: u32,
    pub max_height: u32,
    /// The most frames a second kept; a game that draws fewer gives fewer.
    pub fps: u32,
    pub bitrate: u32,
    /// Frames between keyframes: one second's worth.
    pub gop_frames: u32,
}

impl Quality {
    /// 720p at 30 fps: 3.5 Mbit/s is 52.5 MB for two minutes, inside the 60
    /// the acceptance test allows (§13 test 3).
    pub const DEFAULT: Quality = Quality {
        max_width: 1280,
        max_height: 720,
        fps: 30,
        bitrate: 3_500_000,
        gop_frames: 30,
    };

    /// 1080p at 60 fps, the other choice design §5.1 offers. Twice the pixels
    /// and frames cost more than twice the bits, so a two-minute take is about
    /// 120 MB: the 60 MB test is the default's.
    pub const HIGH: Quality = Quality {
        max_width: 1920,
        max_height: 1080,
        fps: 60,
        bitrate: 8_000_000,
        gop_frames: 60,
    };

    /// The quality a setting names (`"720p30"`, `"1080p60"`).
    pub fn named(name: &str) -> Option<Quality> {
        match name {
            "720p30" => Some(Self::DEFAULT),
            "1080p60" => Some(Self::HIGH),
            _ => None,
        }
    }
}

/// The encoded size for a window of `width` by `height`: the largest even
/// size inside the quality's box with the window's shape, or the window's own
/// size (made even) when it already fits.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn output_size(width: u32, height: u32, q: &Quality) -> (u32, u32) {
    let (w, h) = (u64::from(width.max(2)), u64::from(height.max(2)));
    let (bw, bh) = (u64::from(q.max_width), u64::from(q.max_height));
    let (out_w, out_h) = if w <= bw && h <= bh {
        (w, h)
    } else if w * bh >= h * bw {
        (bw, h * bw / w)
    } else {
        (w * bh / h, bh)
    };
    let even = |v: u64| (u32::try_from(v).unwrap_or(u32::MAX) & !1).max(2);
    (even(out_w), even(out_h))
}

#[cfg(windows)]
pub use sys::Encoder;

#[cfg(windows)]
mod sys {
    use super::{output_size, Quality};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::thread::JoinHandle;
    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Foundation::{PropertyValue, TimeSpan, TypedEventHandler};
    use windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
    use windows::Media::Core::{
        MediaStreamSample, MediaStreamSource, MediaStreamSourceSampleRequestedEventArgs,
        MediaStreamSourceStartingEventArgs, VideoStreamDescriptor,
    };
    use windows::Media::MediaProperties::{
        ContainerEncodingProperties, MediaEncodingProfile, MediaEncodingSubtypes,
        VideoEncodingProperties,
    };
    use windows::Media::Transcoding::MediaTranscoder;
    use windows::Storage::Streams::IRandomAccessStream;
    use windows::Storage::{FileAccessMode, StorageFile};
    use windows::System::Threading::{
        ThreadPool, WorkItemHandler, WorkItemOptions, WorkItemPriority,
    };
    use windows::Win32::Graphics::Direct3D11::{
        ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice,
        ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView,
        ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
        D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
        D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{
        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
    };
    use windows::Win32::Graphics::Dxgi::IDXGISurface;
    use windows::Win32::Media::MediaFoundation::{
        CODECAPI_AVEncMPVGOPSize, MF_MT_MAX_KEYFRAME_SPACING,
    };
    use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11SurfaceFromDXGISurface;
    use windows_capture::d3d11::SendDirectX;
    use windows_capture::frame::Frame;

    /// Frames waiting for the transcoder: a quarter second at 30 fps. One
    /// further behind than that is losing frames already, and a full queue
    /// drops the newest rather than growing and lengthening the finish.
    const QUEUE: usize = 8;

    /// Output textures, used in turn. More than the queue holds, so one is
    /// drawn into again only well after the transcoder took it; a texture the
    /// pipeline has not let go of yet is still reused, and counted.
    const RING: usize = QUEUE + 4;

    type Err = String;

    fn err(what: &str) -> impl Fn(windows::core::Error) -> Err + '_ {
        move |e| format!("{what}: {e}")
    }

    /// What the encoder did, read once it has finished, for the log.
    #[derive(Debug, Default)]
    pub struct Counts {
        pub sent: AtomicU64,
        /// Frames the queue was too full to take.
        pub dropped: AtomicU64,
        /// Textures drawn into while the pipeline may still have held them.
        pub reused_busy: AtomicU64,
    }

    /// One output texture, through the views the scaler and the transcoder
    /// use; each holds the texture alive.
    struct Slot {
        surface: SendDirectX<IDirect3DSurface>,
        view: ID3D11VideoProcessorOutputView,
        busy: Arc<AtomicBool>,
    }

    /// The D3D11 video processor, for one input size.
    struct Scaler {
        device: ID3D11VideoDevice,
        context: ID3D11VideoContext,
        enumerator: ID3D11VideoProcessorEnumerator,
        processor: ID3D11VideoProcessor,
        input: (u32, u32),
    }

    impl Scaler {
        fn new(
            device: &ID3D11Device,
            context: &ID3D11DeviceContext,
            input: (u32, u32),
            output: (u32, u32),
            fps: u32,
        ) -> Result<Self, Err> {
            let video: ID3D11VideoDevice = device.cast().map_err(err("no video device"))?;
            let video_context: ID3D11VideoContext =
                context.cast().map_err(err("no video context"))?;
            let rate = DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            };
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: input.0,
                InputHeight: input.1,
                OutputFrameRate: rate,
                OutputWidth: output.0,
                OutputHeight: output.1,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            // SAFETY: `desc` outlives the call, and both objects are the
            // capture's own device's.
            let enumerator = unsafe { video.CreateVideoProcessorEnumerator(&desc) }
                .map_err(err("no video processor for this size"))?;
            // SAFETY: as above.
            let processor = unsafe { video.CreateVideoProcessor(&enumerator, 0) }
                .map_err(err("could not create the video processor"))?;
            // SAFETY: a processor of this device, stream 0, which every one has.
            unsafe {
                video_context.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            }
            Ok(Self {
                device: video,
                context: video_context,
                enumerator,
                processor,
                input,
            })
        }

        fn output_view(
            &self,
            texture: &ID3D11Texture2D,
        ) -> Result<ID3D11VideoProcessorOutputView, Err> {
            let desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut view = None;
            // SAFETY: `desc` and `view` outlive the call; the texture is a
            // render target of this device.
            unsafe {
                self.device.CreateVideoProcessorOutputView(
                    texture,
                    &self.enumerator,
                    &desc,
                    Some(&mut view),
                )
            }
            .map_err(err("could not target the output texture"))?;
            view.ok_or_else(|| "the output view was not created".to_string())
        }

        /// Stretch the whole of `input` over the whole of `output`.
        fn blt(
            &self,
            input: &ID3D11Texture2D,
            output: &ID3D11VideoProcessorOutputView,
        ) -> Result<(), Err> {
            let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ArraySlice: 0,
                    },
                },
            };
            let mut view: Option<ID3D11VideoProcessorInputView> = None;
            // SAFETY: as for the output view; the frame's texture is valid for
            // the callback this runs in.
            unsafe {
                self.device.CreateVideoProcessorInputView(
                    input,
                    &self.enumerator,
                    &desc,
                    Some(&mut view),
                )
            }
            .map_err(err("could not read the frame"))?;
            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(view),
                ..Default::default()
            };
            let streams = [stream];
            // SAFETY: one enabled stream whose input view lives in `streams`
            // until after the call.
            let done = unsafe {
                self.context
                    .VideoProcessorBlt(&self.processor, output, 0, &streams)
            };
            let [mut stream] = streams;
            // SAFETY: taken once, after the call that borrowed it.
            drop(unsafe { std::mem::ManuallyDrop::take(&mut stream.pInputSurface) });
            done.map_err(err("could not scale the frame"))
        }
    }

    /// An H.264 MP4 being written from capture frames.
    pub struct Encoder {
        size: (u32, u32),
        fps: u32,
        sender: Option<SyncSender<MediaStreamSample>>,
        source: MediaStreamSource,
        tokens: (i64, i64),
        output: SendDirectX<IRandomAccessStream>,
        transcode: Option<JoinHandle<Result<(), Err>>>,
        scaler: Option<Scaler>,
        ring: Vec<Slot>,
        next: usize,
        first: Option<i64>,
        counts: Arc<Counts>,
    }

    impl Encoder {
        /// Start writing `path` for a window of `width` by `height`.
        pub fn new(path: &Path, width: u32, height: u32, q: &Quality) -> Result<Self, Err> {
            let size = output_size(width, height, q);
            let profile = MediaEncodingProfile::new().map_err(err("no encoding profile"))?;
            let video = VideoEncodingProperties::CreateH264().map_err(err("no H.264"))?;
            let set = || -> windows::core::Result<()> {
                video.SetBitrate(q.bitrate)?;
                video.SetWidth(size.0)?;
                video.SetHeight(size.1)?;
                video.FrameRate()?.SetNumerator(q.fps)?;
                video.FrameRate()?.SetDenominator(1)?;
                video.PixelAspectRatio()?.SetNumerator(1)?;
                video.PixelAspectRatio()?.SetDenominator(1)?;
                let gop: IInspectable = PropertyValue::CreateUInt32(q.gop_frames)?;
                video
                    .Properties()?
                    .Insert(MF_MT_MAX_KEYFRAME_SPACING, &gop)?;
                video.Properties()?.Insert(CODECAPI_AVEncMPVGOPSize, &gop)?;
                profile.SetVideo(&video)?;
                let container = ContainerEncodingProperties::new()?;
                container.SetSubtype(&MediaEncodingSubtypes::Mpeg4()?)?;
                profile.SetContainer(&container)
            };
            set().map_err(err("could not describe the video"))?;

            // No audio stream at all, rather than an audio track left empty.
            let input = VideoEncodingProperties::CreateUncompressed(
                &MediaEncodingSubtypes::Bgra8().map_err(err("no BGRA"))?,
                size.0,
                size.1,
            )
            .map_err(err("could not describe the frames"))?;
            let descriptor = VideoStreamDescriptor::Create(&input).map_err(err("no stream"))?;
            let source = MediaStreamSource::CreateFromDescriptor(&descriptor)
                .map_err(err("no stream source"))?;
            source
                .SetBufferTime(std::time::Duration::from_millis(30).into())
                .map_err(err("could not set the buffer"))?;
            let starting = source
                .Starting(&TypedEventHandler::<
                    MediaStreamSource,
                    MediaStreamSourceStartingEventArgs,
                >::new(|_, args| {
                    if let Some(args) = args.as_ref() {
                        args.Request()?
                            .SetActualStartPosition(TimeSpan { Duration: 0 })?;
                    }
                    Ok(())
                }))
                .map_err(err("could not hook the start"))?;
            let (sender, receiver) = mpsc::sync_channel::<MediaStreamSample>(QUEUE);
            let requested = hook_requests(&source, Arc::new(Mutex::new(receiver)))?;

            let output = open(path)?;
            let transcoder = MediaTranscoder::new().map_err(err("no transcoder"))?;
            transcoder
                .SetHardwareAccelerationEnabled(true)
                .map_err(err("no hardware encoder setting"))?;
            let prepared = transcoder
                .PrepareMediaStreamSourceTranscodeAsync(&source, &output, &profile)
                .and_then(|op| op.join())
                .map_err(err("could not prepare the encoder"))?;
            if !prepared.CanTranscode().unwrap_or(false) {
                let why = prepared.FailureReason().map(|r| r.0).unwrap_or(-1);
                return Err(format!("the encoder refused this video (reason {why})"));
            }
            let transcode = std::thread::spawn(move || {
                let done = prepared
                    .TranscodeAsync()
                    .and_then(|op| op.join())
                    .map_err(err("could not finish take.mp4"));
                drop(transcoder);
                done
            });
            Ok(Self {
                size,
                fps: q.fps,
                sender: Some(sender),
                source,
                tokens: (starting, requested),
                output: SendDirectX::new(output),
                transcode: Some(transcode),
                scaler: None,
                ring: Vec::new(),
                next: 0,
                first: None,
                counts: Arc::new(Counts::default()),
            })
        }

        pub fn counts(&self) -> Arc<Counts> {
            self.counts.clone()
        }

        /// Scale `frame` into the next texture and queue it. Called on the
        /// capture thread, which owns the device context.
        pub fn push(&mut self, frame: &Frame) -> Result<(), Err> {
            if self.transcode.as_ref().is_none_or(JoinHandle::is_finished) {
                return Err("the encoder stopped".into());
            }
            let at = frame.timestamp().map_err(err("no frame time"))?.Duration;
            let first = *self.first.get_or_insert(at);
            let input = (frame.width(), frame.height());
            if self.scaler.as_ref().is_none_or(|s| s.input != input) {
                let scaler = Scaler::new(
                    frame.device(),
                    frame.device_context(),
                    input,
                    self.size,
                    self.fps,
                )?;
                // Output views belong to an enumerator, so they go with it.
                self.ring.clear();
                self.scaler = Some(scaler);
            }
            let Some(scaler) = self.scaler.as_ref() else {
                return Ok(());
            };
            if self.ring.len() < RING {
                self.ring.push(slot(frame.device(), scaler, self.size)?);
                self.next = self.ring.len() - 1;
            } else {
                self.next = (self.next + 1) % RING;
            }
            let Some(slot) = self.ring.get(self.next) else {
                return Ok(());
            };
            if slot.busy.swap(true, Ordering::AcqRel) {
                self.counts.reused_busy.fetch_add(1, Ordering::Relaxed);
            }
            scaler.blt(frame.as_raw_texture(), &slot.view)?;
            // SAFETY: the capture thread's own context.
            unsafe { frame.device_context().Flush() };
            let sample = MediaStreamSample::CreateFromDirect3D11Surface(
                &slot.surface.0,
                TimeSpan {
                    Duration: at - first,
                },
            )
            .map_err(err("could not wrap the frame"))?;
            let busy = slot.busy.clone();
            sample
                .Processed(&TypedEventHandler::<MediaStreamSample, IInspectable>::new(
                    move |_, _| {
                        busy.store(false, Ordering::Release);
                        Ok(())
                    },
                ))
                .map_err(err("could not watch the frame"))?;
            let Some(sender) = self.sender.as_ref() else {
                return Ok(());
            };
            match sender.try_send(sample) {
                Ok(()) => {
                    self.counts.sent.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Full(_)) => {
                    slot.busy.store(false, Ordering::Release);
                    self.counts.dropped.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Disconnected(_)) => return Err("the encoder stopped".into()),
            }
            Ok(())
        }

        /// End the stream and wait for the MP4 to be closed: the queue is
        /// drained first, then the transcoder writes the index.
        pub fn finish(mut self) -> Result<(), Err> {
            // Closing the queue is the end of the stream once it is empty.
            self.sender.take();
            let done = match self.transcode.take() {
                Some(t) => t
                    .join()
                    .unwrap_or_else(|_| Err("the encoder thread panicked".into())),
                None => Ok(()),
            };
            let _ = self.source.RemoveStarting(self.tokens.0);
            let _ = self.source.RemoveSampleRequested(self.tokens.1);
            // So the file is free to be renamed the moment this returns.
            let _ = self.output.0.Close();
            done
        }
    }

    /// A dropped encoder (a capture that failed) still ends its stream.
    impl Drop for Encoder {
        fn drop(&mut self) {
            self.sender.take();
            if let Some(t) = self.transcode.take() {
                let _ = t.join();
            }
        }
    }

    fn slot(device: &ID3D11Device, scaler: &Scaler, size: (u32, u32)) -> Result<Slot, Err> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: size.0,
            Height: size.1,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: `desc` and `texture` outlive the call.
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }
            .map_err(err("could not create an output texture"))?;
        let texture: ID3D11Texture2D =
            texture.ok_or_else(|| "the output texture was not created".to_string())?;
        let dxgi: IDXGISurface = texture.cast().map_err(err("no DXGI surface"))?;
        // SAFETY: a live DXGI surface of a D3D11 texture, as the call expects.
        let surface: IDirect3DSurface = unsafe { CreateDirect3D11SurfaceFromDXGISurface(&dxgi) }
            .and_then(|s| s.cast())
            .map_err(err("no WinRT surface"))?;
        Ok(Slot {
            view: scaler.output_view(&texture)?,
            surface: SendDirectX::new(surface),
            busy: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Hand the transcoder a frame each time it asks, from the thread pool so
    /// the stream source's own thread never waits on the queue.
    fn hook_requests(
        source: &MediaStreamSource,
        frames: Arc<Mutex<Receiver<MediaStreamSample>>>,
    ) -> Result<i64, Err> {
        source
            .SampleRequested(&TypedEventHandler::<
                MediaStreamSource,
                MediaStreamSourceSampleRequestedEventArgs,
            >::new(move |_, args| {
                let Some(args) = args.as_ref() else {
                    return Ok(());
                };
                let request = args.Request()?;
                let deferral = request.GetDeferral()?;
                let frames = frames.clone();
                ThreadPool::RunWithPriorityAndOptionsAsync(
                    &WorkItemHandler::new(move |_| {
                        let next = frames.lock().unwrap_or_else(PoisonError::into_inner).recv();
                        match next {
                            Ok(sample) => request.SetSample(&sample)?,
                            // The queue is closed and empty: the end.
                            Err(_) => request.SetSample(None)?,
                        }
                        deferral.Complete()
                    }),
                    WorkItemPriority::Normal,
                    WorkItemOptions::None,
                )?;
                Ok(())
            }))
            .map_err(err("could not hook the frame requests"))
    }

    /// Create `path` and open it for the transcoder. WinRT takes an absolute
    /// path without the `\\?\` prefix `canonicalize` would add.
    fn open(path: &Path) -> Result<IRandomAccessStream, Err> {
        std::fs::File::create(path).map_err(|e| format!("could not create take.mp4: {e}"))?;
        let path = std::path::absolute(path).map_err(|e| format!("bad take path: {e}"))?;
        let name = HSTRING::from(path.as_os_str().to_os_string());
        StorageFile::GetFileFromPathAsync(&name)
            .and_then(|op| op.join())
            .and_then(|file| file.OpenAsync(FileAccessMode::ReadWrite))
            .and_then(|op| op.join())
            .map_err(err("could not open take.mp4"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_is_fitted_inside_720p_keeping_its_shape_and_never_upscaled() {
        let q = Quality::DEFAULT;
        assert_eq!(output_size(1920, 1080, &q), (1280, 720));
        assert_eq!(output_size(2560, 1440, &q), (1280, 720));
        assert_eq!(output_size(1000, 1000, &q), (720, 720), "taller than wide");
        assert_eq!(output_size(1601, 899, &q), (1280, 718), "even sides");
        assert_eq!(output_size(640, 360, &q), (640, 360), "no upscaling");
        assert_eq!(output_size(641, 361, &q), (640, 360));
        assert_eq!(
            output_size(3840, 400, &q),
            (1280, 132),
            "a strip stays a strip"
        );
        assert_eq!(output_size(0, 0, &q), (2, 2), "never below two pixels");
        assert_eq!(output_size(10_000, 1, &q), (1280, 2));
    }

    #[test]
    fn the_default_keeps_two_minutes_under_sixty_megabytes_with_a_keyframe_a_second() {
        let q = Quality::DEFAULT;
        let bytes = u64::from(q.bitrate) / 8 * 120;
        assert!(bytes <= 60 * 1_000_000, "{bytes} bytes");
        assert_eq!(q.gop_frames, q.fps, "one keyframe a second");
        assert_eq!(Quality::HIGH.gop_frames, Quality::HIGH.fps);
        assert_eq!(Quality::named("720p30"), Some(q));
        assert_eq!(Quality::named("1080p60"), Some(Quality::HIGH));
        assert_eq!(Quality::named("4k"), None);
        assert_eq!(output_size(1920, 1080, &Quality::HIGH), (1920, 1080));
    }
}
