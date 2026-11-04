//! What one Play run holds beyond its process ([`super::runner`]): where its
//! window is ([`crate::embed`]), whether it is being recorded
//! ([`super::record`]), and the marks and keys capture addon v2 reported.
//!
//! A take is planned when the run starts (its id, number and folder), begun
//! when the game's window appears, and finished exactly once, by whichever
//! comes first: Stop, Record being switched off, or the game exiting by
//! itself. [`Session::finish_take`] is that once; every path calls it and only
//! the first does anything.
//!
//! Finishing writes `take.json` while the encoder is still closing the video,
//! and moves the video into place after: the review opens on the summary, and
//! waiting for the MP4 first put a second or more between Stop and a take.

use super::addon;
use super::encode::Quality;
use super::mp4;
use super::record::{self, Capture};
use super::rpc::Usage;
use super::runner::{now_ms, LogLine, Run, Tap};
use super::takes::{self, EnvInfo, Summary, VideoInfo};
use super::telemetry::{self, Line, Tail};
use crate::embed::{Cause, Embed, State as EmbedState};
use crate::sync::MutexExt;
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long finishing a take waits for the game to write out its telemetry.
/// It reads commands ten times a second, so a live game answers well inside
/// this, and one that does not (a hung frame, an earlier script) costs no
/// more than it.
const FLUSH_WAIT: Duration = Duration::from_millis(600);

/// `Input.mouse_mode` while the game holds the mouse (`MOUSE_MODE_CAPTURED`).
const MOUSE_CAPTURED: u8 = 2;

/// Lines a take keeps of its own log, the oldest dropped first: an hour of a
/// game printing thirty lines a second, where the run keeps a few thousand.
const TAKE_LOG_CAP: usize = 100_000;

/// The longest keyframe gap a take's video is let off with: a second (the
/// GOP asked for) and some frames of slack.
const KEYFRAME_GAP_MS: u64 = 1_100;

/// Where a take is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TakeState {
    /// Not recording this run.
    Off,
    /// Waiting for the game's window, then recording.
    Starting {
        number: u32,
    },
    #[serde(rename_all = "camelCase")]
    Recording {
        id: String,
        number: u32,
        started_at: Option<u64>,
    },
    /// Stopped; the MP4 is being closed and the summary written.
    Saving {
        id: String,
        number: u32,
    },
    Saved {
        id: String,
        number: u32,
    },
    Failed {
        reason: String,
    },
}

/// What a take will be, decided when the run starts.
#[derive(Clone)]
pub struct Plan {
    pub takes_dir: PathBuf,
    /// The environment, for `.git/info/exclude`; `None` on read-only main,
    /// whose takes live under the app's own data instead.
    pub env_root: Option<PathBuf>,
    pub project: String,
    /// The version take.json names ("4.5.1"), and the line it came from.
    pub godot: String,
    pub godot_build: String,
    pub environment: EnvInfo,
    pub quality: Quality,
    /// Takes kept in `takes_dir`.
    pub keep: usize,
    /// Where `take_recorded` is reported once take.json is written.
    pub usage: Usage,
}

/// A key the addon handled for Veistra (F7, Ctrl Shift M), numbered so the
/// pane acts on each once.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyEvent {
    pub seq: u64,
    pub key: String,
    pub t: u64,
}

struct Active {
    capture: Box<dyn Capture>,
    id: String,
    number: u32,
    /// What it is being encoded at: a quality chosen while it records
    /// applies from the next take, so take.json must not read it from the
    /// plan.
    quality: Quality,
}

pub struct Session {
    pub run_id: u64,
    /// Shared with the run's registration in [`crate::embed::host::Hosts`].
    pub embed: Arc<Embed>,
    pub channel: Option<PathBuf>,
    plan: Mutex<Option<Plan>>,
    take: Mutex<TakeState>,
    active: Mutex<Option<Active>>,
    /// F8 marks, read from the addon's file. Kept apart from the toolbar's
    /// because a take reads its F8 marks from its own copy of that file, and
    /// handing it these too wrote every F8 mark twice.
    f8_marks: Mutex<Vec<u64>>,
    toolbar_marks: Mutex<Vec<u64>>,
    keys: Mutex<Vec<KeyEvent>>,
    tail: Mutex<Option<Tail>>,
    /// The mouse mode the last tick reported, `None` before the first tick
    /// and from an addon that does not report one.
    mouse: Mutex<Option<u8>>,
    /// How a take starts recording: [`record::start`], or a fake in tests.
    start_capture: record::Start,
    /// The take's own log, kept by [`Self::log_tap`] while one records.
    take_log: Mutex<Option<VecDeque<LogLine>>>,
    /// This run is recorded whatever Record is set to (Play <scene>, Still
    /// broken), so a take planned again after Dock records too. Record
    /// switched off mid-run clears it.
    once: AtomicBool,
    /// The note a Still broken run went back to; every take it saves starts
    /// with a draft for it.
    pub follow_up: Option<takes::FollowUp>,
}

impl Session {
    /// A session with an embed of its own, for the tests; a run's comes from
    /// the registry ([`Self::with_embed`]).
    #[cfg(test)]
    pub fn new(run_id: u64, channel: Option<PathBuf>, plan: Option<Plan>) -> Self {
        Self::with_embed(run_id, channel, plan, Arc::new(Embed::default()))
    }

    pub fn with_embed(
        run_id: u64,
        channel: Option<PathBuf>,
        plan: Option<Plan>,
        embed: Arc<Embed>,
    ) -> Self {
        let take = match &plan {
            Some(p) => TakeState::Starting {
                number: takes::next_number(&p.takes_dir),
            },
            None => TakeState::Off,
        };
        Self {
            run_id,
            embed,
            tail: Mutex::new(channel.as_ref().map(|c| Tail::new(c.join(telemetry::FILE)))),
            channel,
            plan: Mutex::new(plan),
            take: Mutex::new(take),
            active: Mutex::new(None),
            f8_marks: Mutex::new(Vec::new()),
            toolbar_marks: Mutex::new(Vec::new()),
            keys: Mutex::new(Vec::new()),
            mouse: Mutex::new(None),
            start_capture: Arc::new(record::start),
            take_log: Mutex::new(None),
            once: AtomicBool::new(false),
            follow_up: None,
        }
    }

    /// The same session recorded whatever Record says, for `play/run`'s
    /// `recordOnce`, and linked to the note Still broken went back to.
    pub fn recording_once(mut self, once: bool, follow_up: Option<takes::FollowUp>) -> Self {
        self.once = AtomicBool::new(once || follow_up.is_some());
        self.follow_up = follow_up;
        self
    }

    /// Whether this run records whatever Record is set to.
    pub fn records_once(&self) -> bool {
        self.once.load(Ordering::Relaxed)
    }

    /// Record switched off mid-run: no later take of this run records.
    pub fn stop_recording_once(&self) {
        self.once.store(false, Ordering::Relaxed);
    }

    /// The same session recording through `start` instead of the screen.
    #[cfg(test)]
    pub fn with_capture(mut self, start: record::Start) -> Self {
        self.start_capture = start;
        self
    }

    /// A tap for the run's log ([`Run::set_tap`]) that keeps every line while
    /// a take records, so a game that prints more than the run keeps still
    /// has the whole take in `log.jsonl` and its counts. Weak: the run
    /// holding it outlives the session's registration.
    pub fn log_tap(self: &Arc<Self>) -> Tap {
        let session = Arc::downgrade(self);
        Box::new(move |line: &LogLine| {
            let Some(s) = session.upgrade() else {
                return;
            };
            let mut log = s.take_log.lock_or_panic();
            if let Some(log) = log.as_mut() {
                if log.len() >= TAKE_LOG_CAP {
                    log.pop_front();
                }
                log.push_back(line.clone());
            }
        })
    }

    pub fn take_state(&self) -> TakeState {
        self.take.lock_or_panic().clone()
    }

    /// A new quality or keep for the takes still to come: one not begun yet
    /// is encoded at `quality`, and the next one saved keeps `keep`. The take
    /// recording now keeps the quality it began with.
    pub fn retune(&self, quality: Quality, keep: usize) {
        if let Some(plan) = self.plan.lock_or_panic().as_mut() {
            plan.quality = quality;
            plan.keep = keep.max(1);
        }
    }

    /// Plan a take for a run already going (Record switched on mid-run).
    pub fn plan(&self, plan: Plan) {
        let number = takes::next_number(&plan.takes_dir);
        *self.plan.lock_or_panic() = Some(plan);
        let mut take = self.take.lock_or_panic();
        if matches!(
            *take,
            TakeState::Off | TakeState::Saved { .. } | TakeState::Failed { .. }
        ) {
            *take = TakeState::Starting { number };
        }
    }

    /// Start recording `hwnd` if a take is planned and none is going, and
    /// the game is in the pane: the recorder captures the whole window, so a
    /// decorated one would put its title bar in the video and push every
    /// telemetry box down by its height.
    pub fn begin_take(&self, hwnd: isize) {
        let Some(plan) = self.plan.lock_or_panic().clone() else {
            return;
        };
        let mut active = self.active.lock_or_panic();
        if active.is_some() {
            return;
        }
        match not_recordable(&self.embed.state()) {
            Some(Unrecordable::Yet) => return,
            Some(Unrecordable::Because(reason)) => {
                *self.take.lock_or_panic() = TakeState::Failed {
                    reason: reason.to_string(),
                };
                return;
            }
            None => {}
        }
        let number = takes::next_number(&plan.takes_dir);
        let started = now_ms();
        let id = takes::new_id(started, rand::random::<u16>());
        let dir = plan.takes_dir.join(&id);
        let result = std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))
            .and_then(|()| (self.start_capture)(hwnd, &dir.join(takes::VIDEO_PART), &plan.quality));
        match result {
            Ok(capture) => {
                if let Some(root) = &plan.env_root {
                    if let Err(e) = takes::ensure_excluded(root) {
                        crate::veistra_log!("play: could not keep takes out of git: {e}");
                    }
                }
                *self.take_log.lock_or_panic() = Some(VecDeque::new());
                *self.take.lock_or_panic() = TakeState::Recording {
                    id: id.clone(),
                    number,
                    started_at: None,
                };
                *active = Some(Active {
                    capture,
                    id,
                    number,
                    quality: plan.quality,
                });
            }
            Err(reason) => {
                let _ = std::fs::remove_dir_all(&dir);
                *self.take.lock_or_panic() = TakeState::Failed { reason };
            }
        }
    }

    /// Stop recording and write the take, once. `run` supplies the log; the
    /// marks are this session's. Called from Stop, from Record off, and from
    /// the thread that sees the game exit, so it must be safe to call again.
    pub fn finish_take(&self, run: &Run) {
        let Some(active) = self.active.lock_or_panic().take() else {
            // A take still waiting for the window never started; no plan
            // survives a finish, so the next run plans its own.
            let mut take = self.take.lock_or_panic();
            if matches!(*take, TakeState::Starting { .. }) {
                *take = TakeState::Off;
            }
            self.plan.lock_or_panic().take();
            return;
        };
        let Some(plan) = self.plan.lock_or_panic().take() else {
            return;
        };
        let (id, number) = (active.id.clone(), active.number);
        *self.take.lock_or_panic() = TakeState::Saving {
            id: id.clone(),
            number,
        };
        let state = self.save(run, &plan, active);
        *self.take.lock_or_panic() = state;
    }

    /// Stop `active` and write it as a take: everything but the video first,
    /// then the video once the encoder has closed it.
    fn save(&self, run: &Run, plan: &Plan, active: Active) -> TakeState {
        let ended = now_ms();
        let dir = plan.takes_dir.join(&active.id);
        let own_log = self.take_log.lock_or_panic().take();
        let halted = match active.capture.halt() {
            Ok(halted) => halted,
            Err(reason) => {
                let _ = std::fs::remove_dir_all(&dir);
                return TakeState::Failed { reason };
            }
        };
        let stopped = halted.stopped;
        let Some(first) = stopped.first_frame_ms else {
            let _ = (halted.finish)();
            let _ = std::fs::remove_dir_all(&dir);
            return TakeState::Failed {
                reason: "No frames were recorded, so there is no take.".into(),
            };
        };
        let closing = std::thread::spawn(halted.finish);
        self.flush_telemetry(run);
        self.poll();
        let marks = self.take_marks();
        let log: Vec<LogLine> = match own_log {
            Some(lines) if !lines.is_empty() => lines.into(),
            _ => run.log_since(0).lines,
        };
        let written = takes::finish(&takes::Finish {
            dir: &dir,
            id: &active.id,
            number: active.number,
            project: &plan.project,
            environment: plan.environment.clone(),
            godot: &plan.godot,
            godot_build: &plan.godot_build,
            started_at: first,
            ended_at: ended.max(first),
            video: VideoInfo {
                width: stopped.width,
                height: stopped.height,
                fps: active.quality.fps,
            },
            channel: self.channel.as_deref(),
            log: &log,
            marks: &marks,
            follow_up: self.follow_up.as_ref(),
        });
        let summary = match written {
            Ok(summary) => summary,
            Err(e) => {
                let _ = closing.join();
                return TakeState::Failed {
                    reason: format!("could not write the take: {e}"),
                };
            }
        };
        let id = &active.id;
        crate::veistra_log!(
            "play: take {id}: take.json {} ms after stop",
            now_ms().saturating_sub(ended)
        );
        (plan.usage)(
            "take_recorded",
            json!({
                "durationS": summary.duration_ms.saturating_add(500) / 1000,
                "marks": summary.marks.len(),
                "errors": summary.counts.errors,
                "warnings": summary.counts.warnings,
                "width": stopped.width,
                "height": stopped.height,
                "dropped": stopped.dropped,
            }),
        );
        let video = closing
            .join()
            .unwrap_or_else(|_| Err("the encoder thread panicked".into()))
            .and_then(|()| place_video(&dir));
        crate::veistra_log!(
            "play: take {id}: video closed {} ms after stop",
            now_ms().saturating_sub(ended)
        );
        if video.is_ok() {
            check_video(&dir, &summary);
        }
        // Retention reads every take and may delete old videos, which can be
        // slow while a scanner holds them. Review opens on this answer, so
        // retention runs beside it; the take just saved is the newest, kept.
        let (takes_dir, keep) = (plan.takes_dir.clone(), plan.keep.max(1));
        std::thread::spawn(move || takes::retain(&takes_dir, keep));
        match video {
            Ok(()) => TakeState::Saved {
                id: active.id,
                number: active.number,
            },
            Err(e) => TakeState::Failed {
                reason: format!("The take was saved without its video: {e}"),
            },
        }
    }

    /// Have the game write out the ticks it holds before the take copies its
    /// file: it flushes once a second, so the take's last second was
    /// missing. Not once the game has exited, which flushed as it closed.
    fn flush_telemetry(&self, run: &Run) {
        let Some(channel) = self.channel.as_deref() else {
            return;
        };
        if !run.is_running() {
            return;
        }
        if let Err(e) = addon::flush(channel, FLUSH_WAIT) {
            crate::veistra_log!("play: the game did not flush its telemetry: {e}");
        }
    }

    /// The recording's last frame, for a still over the pane.
    pub fn still_png(&self) -> Option<Vec<u8>> {
        self.active
            .lock_or_panic()
            .as_ref()
            .and_then(|a| a.capture.still_png())
    }

    /// Wall time zero for the live strip: the take's first frame while
    /// recording, else when the run started.
    pub fn zero(&self, run_started: u64) -> u64 {
        let active = self.active.lock_or_panic();
        active
            .as_ref()
            .and_then(|a| a.capture.first_frame_ms())
            .unwrap_or(run_started)
    }

    /// Keep [`TakeState::Recording`]'s start up to date once the first frame lands.
    pub fn refresh_take(&self) {
        let first = self
            .active
            .lock_or_panic()
            .as_ref()
            .and_then(|a| a.capture.first_frame_ms());
        if let TakeState::Recording { started_at, .. } = &mut *self.take.lock_or_panic() {
            *started_at = first;
        }
    }

    /// A mark from the toolbar, at this moment.
    pub fn mark(&self) -> u64 {
        let t = now_ms();
        self.toolbar_marks.lock_or_panic().push(t);
        t
    }

    /// The marks a take is handed: the toolbar's. Its F8 marks are in the
    /// telemetry it copies.
    fn take_marks(&self) -> Vec<u64> {
        self.toolbar_marks.lock_or_panic().clone()
    }

    /// Every mark, F8 and toolbar, for the live strip.
    pub fn marks(&self) -> Vec<u64> {
        let mut marks = self.f8_marks.lock_or_panic().clone();
        marks.extend(self.toolbar_marks.lock_or_panic().iter());
        marks.sort_unstable();
        marks
    }

    /// Keys after `since` (a [`KeyEvent::seq`]).
    pub fn keys_since(&self, since: u64) -> Vec<KeyEvent> {
        self.keys
            .lock_or_panic()
            .iter()
            .filter(|k| k.seq > since)
            .cloned()
            .collect()
    }

    pub fn ticks(&self) -> u64 {
        self.tail.lock_or_panic().as_ref().map_or(0, |t| t.ticks)
    }

    /// F8 marks so far: the pane counts the ones it has not seen, since
    /// [`Session::marks`] mixes them with the toolbar's.
    pub fn f8_count(&self) -> usize {
        self.f8_marks.lock_or_panic().len()
    }

    /// Whether the game held the mouse at the last tick, for the live strip's
    /// "F7 stops and opens the take": with the cursor captured there is no
    /// pointer to reach the toolbar with.
    pub fn mouse_captured(&self) -> bool {
        *self.mouse.lock_or_panic() == Some(MOUSE_CAPTURED)
    }

    /// Read what the addon wrote since the last call: F8 marks, keys and the
    /// mouse mode.
    pub fn poll(&self) {
        let lines = match self.tail.lock_or_panic().as_mut() {
            Some(tail) => tail.read(),
            None => return,
        };
        for line in lines {
            match line {
                Line::Mark { t } => self.f8_marks.lock_or_panic().push(t),
                Line::Key { t, key } => {
                    let mut keys = self.keys.lock_or_panic();
                    let seq = keys.last().map_or(0, |k| k.seq) + 1;
                    keys.push(KeyEvent { seq, key, t });
                }
                Line::Tick(tick) => *self.mouse.lock_or_panic() = tick.mouse,
                Line::Scene { .. } => {}
            }
        }
    }
}

/// Move the closed video to `take.mp4`. A virus scanner or the indexer can
/// hold a file the moment it is closed, so a refusal is tried a few times.
fn place_video(dir: &Path) -> Result<(), String> {
    let (from, to) = (dir.join(takes::VIDEO_PART), dir.join(takes::VIDEO));
    let mut last = None;
    for attempt in 0..5 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(100));
        }
        match std::fs::rename(&from, &to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(format!(
        "could not move {} into place: {}",
        takes::VIDEO_PART,
        last.map_or_else(String::new, |e| e.to_string())
    ))
}

/// Read the closed video back and say whether it is what was asked for: a
/// keyframe a second, no sound. The size take.json names is the file's own
/// from here on, since review maps pins by it.
fn check_video(dir: &Path, summary: &Summary) {
    let id = &summary.id;
    let info = match mp4::read(&dir.join(takes::VIDEO)) {
        Ok(info) => info,
        Err(e) => {
            crate::veistra_log!("play: take {id}: could not read take.mp4 back: {e}");
            return;
        }
    };
    crate::veistra_log!(
        "play: take {id}: {}x{}, {} frames in {} ms, keyframes at most {} ms apart{}",
        info.width,
        info.height,
        info.frames,
        info.duration_ms,
        info.max_keyframe_gap_ms,
        if info.has_audio { ", with sound" } else { "" }
    );
    if info.max_keyframe_gap_ms > KEYFRAME_GAP_MS {
        crate::veistra_log!(
            "play: take {id}: the encoder ignored the keyframe interval; seeking will be slow"
        );
    }
    let size = (info.width, info.height);
    if size.0 > 0 && size != (summary.video.width, summary.video.height) {
        let video = VideoInfo {
            width: size.0,
            height: size.1,
            fps: summary.video.fps,
        };
        if let Err(e) = takes::set_video(dir, video) {
            crate::veistra_log!("play: take {id}: {e}");
        }
    }
}

/// Why a take cannot start now.
#[derive(Debug, PartialEq, Eq)]
enum Unrecordable {
    /// The window is still being placed; attaching starts the take.
    Yet,
    Because(&'static str),
}

fn not_recordable(state: &EmbedState) -> Option<Unrecordable> {
    match state {
        EmbedState::Embedded => None,
        EmbedState::Waiting => Some(Unrecordable::Yet),
        EmbedState::PoppedOut => Some(Unrecordable::Because(
            "Recording needs the game in the pane; Dock it first.",
        )),
        EmbedState::OwnWindow { .. } => Some(Unrecordable::Because(
            "Recording needs the game in the pane, and this one is playing in its own window.",
        )),
    }
}

/// One process as [`descendants`] reads it.
#[derive(Debug, Clone, Copy)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Seconds since the epoch.
    pub started: u64,
}

/// `root` and every process below it. A child must have started no earlier
/// than its parent: Windows hands a dead process's id to the next one, and
/// a process whose own parent died long ago still names that id, so without
/// the check an unrelated app (every one an old Explorer started) counts as
/// the game's and its window is the one embedded.
pub fn descendants(root: u32, procs: &[Proc]) -> Vec<u32> {
    let started = |pid: u32| procs.iter().find(|p| p.pid == pid).map(|p| p.started);
    let mut found = vec![root];
    let mut i = 0;
    while i < found.len() {
        let parent = found[i];
        let parent_started = started(parent).unwrap_or(0);
        for p in procs {
            if p.parent == Some(parent) && p.started >= parent_started && !found.contains(&p.pid) {
                found.push(p.pid);
            }
        }
        i += 1;
    }
    found
}

/// The game's process and everything below it, for finding its window: the
/// `_console.exe` Veistra prefers on Windows starts the real executable as a
/// child, and the window is the child's.
pub fn process_tree(root: u32) -> Vec<u32> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let procs: Vec<Proc> = sys
        .processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            parent: p.parent().map(|pp| pp.as_u32()),
            started: p.start_time(),
        })
        .collect();
    descendants(root, &procs)
}

/// The search for the game's window ended ([`crate::embed::host::HostSpec`]'s
/// `on_attached`): start the take if one is planned, or say why it cannot.
pub fn attached(session: &Session, hwnd: Option<isize>) {
    match hwnd {
        Some(hwnd) => session.begin_take(hwnd),
        None => settled(session, &session.embed.state()),
    }
}

/// The first attempt to place the game's window has an outcome
/// ([`Embed::when_settled`]). A planned take that cannot be recorded says so
/// now: a window that shows only after the wait is still looked for until the
/// game exits, and its take would read "starting" all that time.
pub fn settled(session: &Session, state: &EmbedState) {
    let reason = match state {
        EmbedState::Embedded | EmbedState::Waiting | EmbedState::PoppedOut => return,
        EmbedState::OwnWindow {
            cause: Cause::Unsupported,
            ..
        } => record::unavailable().unwrap_or("Recording is not available here."),
        EmbedState::OwnWindow {
            cause: Cause::Exited,
            ..
        } => "The game showed no window to record.",
        EmbedState::OwnWindow { .. } => {
            "Recording needs the game in the pane, and this one is playing in its own window."
        }
    };
    if session.plan.lock_or_panic().take().is_some() {
        *session.take.lock_or_panic() = TakeState::Failed {
            reason: reason.to_string(),
        };
    }
}

/// The branch and commit of `root`, for `take.json`. Not a repository, or
/// git missing, is two `None`s: a take is still worth keeping without them.
pub fn env_info(root: &Path) -> EnvInfo {
    let git = |args: &[&str]| {
        crate::git::run_git(root, "play take", args)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    EnvInfo {
        branch: git(&["rev-parse", "--abbrev-ref", "HEAD"]),
        commit: git(&["rev-parse", "--short", "HEAD"]),
    }
}

#[cfg(test)]
mod tests {
    use super::super::record::{Halted, Stopped};
    use super::super::runner::{Level, RunSpec, Runner};
    use super::*;
    use crate::embed::{Kind, Owner};
    use serde_json::Value;
    use std::time::Instant;
    use tempfile::TempDir;

    type Reported = Arc<Mutex<Vec<(&'static str, Value)>>>;

    fn plan(dir: &Path) -> Plan {
        plan_reporting(dir).0
    }

    fn plan_reporting(dir: &Path) -> (Plan, Reported) {
        let reported: Reported = Arc::default();
        let sink = reported.clone();
        let plan = Plan {
            takes_dir: dir.join("takes"),
            env_root: None,
            project: ".".into(),
            godot: "4.5.1".into(),
            godot_build: "4.5.1.stable.official.f62fdbde1".into(),
            environment: EnvInfo::default(),
            quality: Quality::DEFAULT,
            keep: 10,
            usage: Arc::new(move |event, props| sink.lock_or_panic().push((event, props))),
        };
        (plan, reported)
    }

    /// A recording that writes its partial file at once, says its first
    /// frame landed at `first`, and takes `closing` to close the video.
    fn fake_capture(first: Option<u64>, closing: Duration) -> record::Start {
        struct Fake(Option<u64>, Duration);
        impl Capture for Fake {
            fn first_frame_ms(&self) -> Option<u64> {
                self.0
            }
            fn still_png(&self) -> Option<Vec<u8>> {
                None
            }
            fn halt(self: Box<Self>) -> Result<Halted, String> {
                let closing = self.1;
                Ok(Halted {
                    stopped: Stopped {
                        first_frame_ms: self.0,
                        frames: 90,
                        dropped: 2,
                        width: 1280,
                        height: 720,
                    },
                    finish: Box::new(move || {
                        std::thread::sleep(closing);
                        Ok(())
                    }),
                })
            }
        }
        Arc::new(move |_hwnd, path: &Path, _quality: &Quality| {
            std::fs::write(path, b"video").map_err(|e| e.to_string())?;
            Ok(Box::new(Fake(first, closing)) as Box<dyn Capture>)
        })
    }

    /// The game's window, in the pane.
    fn embedded() -> Arc<Embed> {
        let win = Arc::new(crate::embed::tests::Fake::finding_after(0));
        let embed = Arc::new(Embed::with(win, Kind::Game));
        let owner = Owner {
            hwnd: 1,
            origin: (0, 0),
            scale: 1.0,
        };
        embed.attach(None, &Vec::new, &|| Some(owner), &|| true);
        assert_eq!(embed.state(), EmbedState::Embedded);
        embed
    }

    fn exited_run(dir: &Path) -> (Runner, Arc<Run>) {
        let game = dir.join("game");
        std::fs::create_dir_all(&game).unwrap();
        let runner = Runner::default();
        let spec = RunSpec {
            program: super::super::testing::fake_godot(dir, false),
            project: game,
            scene: None,
            channel: None,
            window: None,
        };
        let run = runner.start("c1", spec).unwrap();
        (runner, run)
    }

    fn log_line(text: &str, level: Level) -> LogLine {
        LogLine {
            seq: 0,
            stream: "stdout",
            level,
            text: text.into(),
            at: now_ms(),
        }
    }

    #[test]
    fn a_planned_take_starts_numbered_and_one_with_no_plan_is_off() {
        let dir = TempDir::new().unwrap();
        let s = Session::new(1, None, Some(plan(dir.path())));
        assert_eq!(s.take_state(), TakeState::Starting { number: 1 });
        assert_eq!(Session::new(2, None, None).take_state(), TakeState::Off);
    }

    #[test]
    fn marks_and_keys_come_from_the_toolbar_and_the_addon_s_file() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().to_path_buf();
        let s = Session::new(1, Some(channel.clone()), None);
        let t = s.mark();
        std::fs::write(
            channel.join(telemetry::FILE),
            "{\"t\":5,\"kind\":\"mark\"}\n{\"t\":6,\"kind\":\"key\",\"key\":\"F7\"}\n\
             {\"t\":7,\"kind\":\"key\",\"key\":\"Ctrl Shift M\"}\n",
        )
        .unwrap();
        s.poll();
        assert_eq!(s.marks(), vec![5, t]);
        assert_eq!(s.f8_count(), 1, "the toolbar's mark is not F8's");
        let keys: Vec<(u64, String)> = s
            .keys_since(0)
            .into_iter()
            .map(|k| (k.seq, k.key))
            .collect();
        assert_eq!(keys, vec![(1, "F7".into()), (2, "Ctrl Shift M".into())]);
        assert_eq!(s.keys_since(1).len(), 1, "the pane acts on each key once");
    }

    #[test]
    fn an_f8_mark_reaches_the_take_once() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().join("chan");
        std::fs::create_dir_all(&channel).unwrap();
        let s = Session::new(1, Some(channel.clone()), None);
        let toolbar = s.mark();
        let started = toolbar - 5_000;
        std::fs::write(
            channel.join(telemetry::FILE),
            format!("{{\"t\":{},\"kind\":\"mark\"}}\n", started + 3_000),
        )
        .unwrap();
        s.poll();
        assert_eq!(
            s.marks(),
            vec![started + 3_000, toolbar],
            "the strip shows both"
        );
        assert_eq!(
            s.take_marks(),
            vec![toolbar],
            "the F8 mark is the telemetry's"
        );
        let summary = takes::finish(&takes::Finish {
            dir: &dir.path().join("take"),
            id: "2026-10-30-1402-0f3a",
            number: 1,
            project: ".",
            environment: EnvInfo::default(),
            godot: "4.5.1",
            godot_build: "4.5.1.stable.official.f62fdbde1",
            started_at: started,
            ended_at: toolbar + 1_000,
            video: VideoInfo::default(),
            channel: Some(&channel),
            log: &[],
            marks: &s.take_marks(),
            follow_up: None,
        })
        .unwrap();
        assert_eq!(summary.marks, vec![3_000, 5_000]);
    }

    #[test]
    fn a_take_starts_only_with_the_game_in_the_pane() {
        let dir = TempDir::new().unwrap();
        let s = Session::new(1, None, Some(plan(dir.path())));
        s.begin_take(7);
        assert_eq!(
            s.take_state(),
            TakeState::Starting { number: 1 },
            "still being placed: attaching starts it"
        );
        s.embed.give_up(Cause::NoWindow);
        s.begin_take(7);
        let TakeState::Failed { reason } = s.take_state() else {
            panic!("a decorated window is not recorded");
        };
        assert!(reason.contains("in the pane"), "{reason}");
        assert_eq!(
            not_recordable(&EmbedState::PoppedOut),
            Some(Unrecordable::Because(
                "Recording needs the game in the pane; Dock it first."
            ))
        );
        assert_eq!(not_recordable(&EmbedState::Embedded), None);
    }

    /// A game whose window is still being looked for after the wait (a slow
    /// first import) must not read "waiting to start recording" until it exits.
    #[test]
    fn a_take_that_cannot_start_says_so_when_the_window_s_outcome_is_known() {
        let dir = TempDir::new().unwrap();
        let s = Session::new(1, None, Some(plan(dir.path())));
        settled(&s, &EmbedState::Embedded);
        assert_eq!(
            s.take_state(),
            TakeState::Starting { number: 1 },
            "placed: attach starts it"
        );
        let late = EmbedState::OwnWindow {
            reason: String::new(),
            cause: Cause::NoWindow,
        };
        settled(&s, &late);
        let TakeState::Failed { reason } = s.take_state() else {
            panic!("the take is given up at once");
        };
        assert!(reason.contains("its own window"), "{reason}");
        s.begin_take(7);
        assert!(
            matches!(s.take_state(), TakeState::Failed { .. }),
            "the late window starts none"
        );

        let gone = Session::new(2, None, Some(plan(dir.path())));
        attached(&gone, None);
        assert_eq!(
            gone.take_state(),
            TakeState::Starting { number: 1 },
            "still waiting"
        );
        gone.embed.give_up(Cause::Exited);
        attached(&gone, None);
        let TakeState::Failed { reason } = gone.take_state() else {
            panic!("no window, no take");
        };
        assert_eq!(reason, "The game showed no window to record.");
    }

    #[test]
    fn a_process_older_than_its_named_parent_is_not_the_game_s() {
        let p = |pid, parent, started| Proc {
            pid,
            parent: Some(parent),
            started,
        };
        let procs = [
            Proc {
                pid: 10,
                parent: Some(1),
                started: 1_000,
            },
            p(11, 10, 1_000),
            p(12, 11, 1_002),
            // Started by an earlier process 10 that died; the id was reused.
            p(20, 10, 400),
            p(21, 20, 401),
        ];
        assert_eq!(descendants(10, &procs), vec![10, 11, 12]);
    }

    /// The review opens on take.json, so it is written while the encoder is
    /// still closing the video, and the video is moved in once it is closed.
    #[test]
    fn a_take_is_written_within_a_second_of_stop_and_its_video_follows() {
        let dir = TempDir::new().unwrap();
        let (_runner, run) = exited_run(dir.path());
        let (plan, reported) = plan_reporting(dir.path());
        let takes_dir = plan.takes_dir.clone();
        let session = Session::with_embed(run.id, None, Some(plan), embedded());
        let s = Arc::new(
            session.with_capture(fake_capture(Some(now_ms()), Duration::from_millis(1_500))),
        );
        let mut tap = s.log_tap();
        tap(&log_line("before the take", Level::Error));
        s.begin_take(7);
        let TakeState::Recording { id, number: 1, .. } = s.take_state() else {
            panic!("recording: {:?}", s.take_state());
        };
        tap(&log_line("ERROR: in the take", Level::Error));
        tap(&log_line("WARNING: also", Level::Warning));
        let take = takes_dir.join(&id);
        let stop = Instant::now();
        let seen = std::thread::scope(|scope| {
            let watch = scope.spawn(|| {
                while stop.elapsed() < Duration::from_secs(5) {
                    if take.join(takes::SUMMARY).exists() {
                        return Some((
                            stop.elapsed(),
                            s.take_state(),
                            take.join(takes::VIDEO).exists(),
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                None
            });
            s.finish_take(&run);
            watch.join().unwrap()
        });
        let (after, state, had_video) = seen.expect("take.json is written");
        assert!(
            after < Duration::from_secs(1),
            "take.json {after:?} after stop"
        );
        assert!(matches!(state, TakeState::Saving { .. }), "{state:?}");
        assert!(!had_video, "the video is moved in once closed");
        assert!(stop.elapsed() >= Duration::from_millis(1_500));
        assert_eq!(s.take_state(), TakeState::Saved { id, number: 1 });
        assert!(take.join(takes::VIDEO).exists());
        assert!(!take.join(takes::VIDEO_PART).exists());

        let summary: Value =
            serde_json::from_str(&std::fs::read_to_string(take.join(takes::SUMMARY)).unwrap())
                .unwrap();
        assert_eq!(summary["video"]["width"], 1280);
        assert_eq!(summary["godotBuild"], "4.5.1.stable.official.f62fdbde1");
        let log = std::fs::read_to_string(take.join(takes::LOG)).unwrap();
        assert_eq!(log.lines().count(), 2, "only the take's own lines: {log}");

        s.finish_take(&run);
        let reported = reported.lock_or_panic().clone();
        assert_eq!(reported.len(), 1, "reported once: {reported:?}");
        let (event, props) = &reported[0];
        assert_eq!(*event, "take_recorded");
        assert_eq!(props["errors"], 1);
        assert_eq!(props["warnings"], 1);
        assert_eq!(props["dropped"], 2);
        assert_eq!(props["height"], 720);
        tap(&log_line("after the take", Level::Info));
        assert!(
            s.take_log.lock_or_panic().is_none(),
            "kept only while recording"
        );
    }

    /// A quality chosen in Record's settings reaches the take not begun yet,
    /// and one chosen while a take records waits for the next: the take
    /// going keeps what it began with, in its encoder and in take.json.
    #[test]
    fn a_quality_chosen_mid_take_applies_from_the_next_take() {
        let dir = TempDir::new().unwrap();
        let (_runner, run) = exited_run(dir.path());
        let plan = plan(dir.path());
        let takes_dir = plan.takes_dir.clone();
        let asked: Arc<Mutex<Vec<u32>>> = Arc::default();
        let seen = asked.clone();
        let inner = fake_capture(Some(now_ms()), Duration::ZERO);
        let start: record::Start = Arc::new(move |hwnd, path: &Path, quality: &Quality| {
            seen.lock_or_panic().push(quality.fps);
            inner(hwnd, path, quality)
        });
        let s = Session::with_embed(run.id, None, Some(plan), embedded()).with_capture(start);
        s.retune(Quality::HIGH, 3);
        s.begin_take(7);
        assert_eq!(*asked.lock_or_panic(), vec![60], "not begun: the new one");
        s.retune(Quality::DEFAULT, 0);
        assert_eq!(
            s.plan.lock_or_panic().as_ref().map(|p| p.keep),
            Some(1),
            "at least the take just saved is kept"
        );
        s.finish_take(&run);
        let TakeState::Saved { id, .. } = s.take_state() else {
            panic!("{:?}", s.take_state());
        };
        let summary = takes::read(&takes_dir, &id).unwrap().summary;
        assert_eq!(summary.video.fps, 60, "the take keeps what it began with");
    }

    /// A Still broken run records whatever Record says, and the take it saves
    /// opens with the note's draft. Record switched off ends the once.
    #[test]
    fn a_still_broken_run_saves_its_take_with_the_note_s_draft() {
        let dir = TempDir::new().unwrap();
        let (_runner, run) = exited_run(dir.path());
        let plan = plan(dir.path());
        let takes_dir = plan.takes_dir.clone();
        let checking = takes::FollowUp {
            comment: "cmt-0001".into(),
            take: "2026-10-30-1402-0f3a".into(),
            n: 2,
            number: Some(4),
            reply: "still clips at the corner".into(),
        };
        let s = Session::with_embed(run.id, None, Some(plan), embedded())
            .with_capture(fake_capture(Some(now_ms()), Duration::ZERO))
            .recording_once(false, Some(checking));
        assert!(s.records_once(), "a Still broken run is recorded once");
        s.begin_take(7);
        s.finish_take(&run);
        let TakeState::Saved { id, .. } = s.take_state() else {
            panic!("{:?}", s.take_state());
        };
        let listed = takes::read(&takes_dir, &id).unwrap();
        assert_eq!(
            listed.summary.follow_up.map(|f| f.comment).as_deref(),
            Some("cmt-0001")
        );
        assert_eq!(listed.drafts, 1);
        assert_eq!(
            takes::load_notes(&takes_dir, &id)["notes"][0]["body"],
            "still clips at the corner"
        );
        s.stop_recording_once();
        assert!(!s.records_once());
    }

    #[test]
    fn a_take_with_no_frames_leaves_nothing_behind_and_is_not_reported() {
        let dir = TempDir::new().unwrap();
        let (_runner, run) = exited_run(dir.path());
        let (plan, reported) = plan_reporting(dir.path());
        let takes_dir = plan.takes_dir.clone();
        let s = Session::with_embed(run.id, None, Some(plan), embedded())
            .with_capture(fake_capture(None, Duration::ZERO));
        s.begin_take(7);
        assert!(matches!(s.take_state(), TakeState::Recording { .. }));
        s.finish_take(&run);
        let TakeState::Failed { reason } = s.take_state() else {
            panic!("{:?}", s.take_state());
        };
        assert!(reason.contains("No frames"), "{reason}");
        assert_eq!(std::fs::read_dir(&takes_dir).unwrap().count(), 0);
        assert!(reported.lock_or_panic().is_empty());
    }

    #[test]
    fn a_take_s_log_keeps_its_newest_lines_up_to_the_cap() {
        let dir = TempDir::new().unwrap();
        let s = Arc::new(Session::new(1, None, Some(plan(dir.path()))));
        let mut tap = s.log_tap();
        *s.take_log.lock_or_panic() = Some(VecDeque::new());
        for n in 0..TAKE_LOG_CAP + 3 {
            tap(&log_line(&n.to_string(), Level::Info));
        }
        let log = s.take_log.lock_or_panic().take().unwrap();
        assert_eq!(log.len(), TAKE_LOG_CAP);
        assert_eq!(log.front().unwrap().text, "3");
        drop(s);
        tap(&log_line("the session is gone", Level::Info));
    }

    #[test]
    fn a_take_that_never_began_finishes_as_off_and_drops_its_plan() {
        let dir = TempDir::new().unwrap();
        let (_runner, run) = exited_run(dir.path());
        let s = Session::new(run.id, None, Some(plan(dir.path())));
        s.finish_take(&run);
        assert_eq!(s.take_state(), TakeState::Off);
        s.finish_take(&run);
        assert_eq!(
            s.take_state(),
            TakeState::Off,
            "finishing twice is harmless"
        );
        assert!(s.plan.lock_or_panic().is_none());
    }

    #[test]
    fn finishing_asks_a_live_game_to_flush_and_leaves_an_exited_one_alone() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().join("chan");
        let game = dir.path().join("game");
        std::fs::create_dir_all(&channel).unwrap();
        std::fs::create_dir_all(&game).unwrap();
        let runner = Runner::default();
        let start = |key: &str, linger: bool| {
            let bin = dir.path().join(key);
            std::fs::create_dir_all(&bin).unwrap();
            let spec = RunSpec {
                program: super::super::testing::fake_godot(&bin, linger),
                project: game.clone(),
                scene: None,
                channel: Some(channel.clone()),
                window: None,
            };
            runner.start(key, spec).unwrap()
        };
        let run = start("live", true);
        let s = Session::new(run.id, Some(channel.clone()), None);
        let answer = {
            let channel = channel.clone();
            std::thread::spawn(move || {
                for _ in 0..200 {
                    if let Ok(text) = std::fs::read_to_string(channel.join("cmd.json")) {
                        std::fs::remove_file(channel.join("cmd.json")).unwrap();
                        let cmd: serde_json::Value = serde_json::from_str(&text).unwrap();
                        let id = cmd["id"].as_u64().unwrap();
                        let reply = serde_json::json!({ "id": id, "ok": true });
                        std::fs::write(channel.join(format!("res-{id}.json")), reply.to_string())
                            .unwrap();
                        return cmd["action"].as_str().map(str::to_string);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                None
            })
        };
        s.flush_telemetry(&run);
        assert_eq!(answer.join().unwrap().as_deref(), Some("flush"));
        assert_eq!(runner.stop("live"), Ok(true));

        // A game that ended by itself, which is also what a stopped one is by
        // the time a take finishes.
        let ended = start("ended", false);
        for _ in 0..500 {
            if !ended.is_running() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!ended.is_running(), "the fake exits by itself");
        let asked = std::time::Instant::now();
        s.flush_telemetry(&ended);
        assert!(
            asked.elapsed() < FLUSH_WAIT,
            "an exited game is not waited for"
        );
        assert!(!channel.join("cmd.json").exists());
    }

    #[test]
    fn the_process_tree_starts_with_the_game_itself() {
        let me = std::process::id();
        assert_eq!(process_tree(me).first(), Some(&me));
    }
}
