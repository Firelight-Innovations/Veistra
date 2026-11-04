//! What one Play run holds beyond its process ([`super::runner`]): where its
//! window is ([`crate::embed`]), whether it is being recorded
//! ([`super::record`]), and the marks and keys capture addon v2 reported.
//!
//! A take is planned when the run starts (its id, number and folder), begun
//! when the game's window appears, and finished exactly once, by whichever
//! comes first: Stop, Record being switched off, or the game exiting by
//! itself. [`Session::finish_take`] is that once; every path calls it and only
//! the first does anything.

use super::record::{self, Recorder};
use super::runner::{now_ms, Run};
use super::takes::{self, EnvInfo, VideoInfo};
use super::telemetry::{self, Line, Tail};
use crate::embed::{Cause, Embed, State as EmbedState};
use crate::sync::MutexExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
#[derive(Debug, Clone)]
pub struct Plan {
    pub takes_dir: PathBuf,
    /// The environment, for `.git/info/exclude`; `None` on read-only main,
    /// whose takes live under the app's own data instead.
    pub env_root: Option<PathBuf>,
    pub project: String,
    pub godot: String,
    pub environment: EnvInfo,
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
    recorder: Recorder,
    id: String,
    number: u32,
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
        }
    }

    pub fn take_state(&self) -> TakeState {
        self.take.lock_or_panic().clone()
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
            .and_then(|()| Recorder::start(hwnd, &dir.join(takes::VIDEO)));
        match result {
            Ok(recorder) => {
                if let Some(root) = &plan.env_root {
                    if let Err(e) = takes::ensure_excluded(root) {
                        crate::veistra_log!("play: could not keep takes out of git: {e}");
                    }
                }
                *self.take.lock_or_panic() = TakeState::Recording {
                    id: id.clone(),
                    number,
                    started_at: None,
                };
                *active = Some(Active {
                    recorder,
                    id,
                    number,
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
        *self.take.lock_or_panic() = TakeState::Saving {
            id: active.id.clone(),
            number: active.number,
        };
        let ended = now_ms();
        let dir = plan.takes_dir.join(&active.id);
        let stopped = active.recorder.stop();
        let state = match stopped {
            Ok(stopped) => match stopped.first_frame_ms {
                Some(first) => {
                    self.poll();
                    let marks = self.take_marks();
                    let log = run.log_since(0).lines;
                    let summary = takes::finish(&takes::Finish {
                        dir: &dir,
                        id: &active.id,
                        number: active.number,
                        project: &plan.project,
                        environment: plan.environment.clone(),
                        godot: &plan.godot,
                        started_at: first,
                        ended_at: ended.max(first),
                        video: VideoInfo {
                            width: stopped.width,
                            height: stopped.height,
                            fps: record::FPS,
                        },
                        channel: self.channel.as_deref(),
                        log: &log,
                        marks: &marks,
                    });
                    match summary {
                        Ok(_) => {
                            takes::retain(&plan.takes_dir, takes::KEEP);
                            TakeState::Saved {
                                id: active.id,
                                number: active.number,
                            }
                        }
                        Err(e) => TakeState::Failed {
                            reason: format!("could not write the take: {e}"),
                        },
                    }
                }
                None => {
                    let _ = std::fs::remove_dir_all(&dir);
                    TakeState::Failed {
                        reason: "No frames were recorded, so there is no take.".into(),
                    }
                }
            },
            Err(reason) => TakeState::Failed { reason },
        };
        *self.take.lock_or_panic() = state;
    }

    /// The recording's last frame, for a still over the pane.
    pub fn still_png(&self) -> Option<Vec<u8>> {
        self.active
            .lock_or_panic()
            .as_ref()
            .and_then(|a| a.recorder.still_png())
    }

    /// Wall time zero for the live strip: the take's first frame while
    /// recording, else when the run started.
    pub fn zero(&self, run_started: u64) -> u64 {
        let active = self.active.lock_or_panic();
        active
            .as_ref()
            .and_then(|a| a.recorder.first_frame_ms())
            .unwrap_or(run_started)
    }

    /// Keep [`TakeState::Recording`]'s start up to date once the first frame lands.
    pub fn refresh_take(&self) {
        let first = self
            .active
            .lock_or_panic()
            .as_ref()
            .and_then(|a| a.recorder.first_frame_ms());
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

    /// Read what the addon wrote since the last call: F8 marks and keys.
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
                Line::Tick(_) | Line::Scene { .. } => {}
            }
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
    use super::*;
    use tempfile::TempDir;

    fn plan(dir: &Path) -> Plan {
        Plan {
            takes_dir: dir.join("takes"),
            env_root: None,
            project: ".".into(),
            godot: "4.5.1".into(),
            environment: EnvInfo::default(),
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
            started_at: started,
            ended_at: toolbar + 1_000,
            video: VideoInfo::default(),
            channel: Some(&channel),
            log: &[],
            marks: &s.take_marks(),
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

    #[test]
    fn a_take_that_never_began_finishes_as_off_and_drops_its_plan() {
        let dir = TempDir::new().unwrap();
        let game = dir.path().join("game");
        std::fs::create_dir_all(&game).unwrap();
        let runner = super::super::runner::Runner::default();
        let run = runner
            .start(
                "c1",
                super::super::runner::RunSpec {
                    program: super::super::testing::fake_godot(dir.path(), false),
                    project: game,
                    scene: None,
                    channel: None,
                    window: None,
                },
            )
            .unwrap();
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
    fn the_process_tree_starts_with_the_game_itself() {
        let me = std::process::id();
        assert_eq!(process_tree(me).first(), Some(&me));
    }
}
