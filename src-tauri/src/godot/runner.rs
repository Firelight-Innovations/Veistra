//! Running a Godot project as a child process of an environment.
//!
//! One [`Runner`] holds every run, keyed by the cluster that started it, so two
//! clusters can each have a game going and Stop in one never reaches the other.
//! A run is a native process in its own window, not a web export - see
//! `docs/design-notes/godot-play.md` for why - so this module's whole job is
//! process hygiene: capture the log, classify it, and make sure Stop and
//! application exit leave nothing behind.

use crate::sync::MutexExt;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Lines kept per run. The oldest are dropped first and the count of drops is
/// reported, so a chatty game cannot grow this without bound.
const LOG_CAP: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub stream: &'static str,
    pub level: Level,
    pub text: String,
    pub at: u64,
}

/// Where a run is in its life. `Stopped` is a Stop the user asked for; `Exited`
/// is the game ending by itself, with its exit code when the OS gave one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunState {
    Running,
    Stopped,
    #[serde(rename_all = "camelCase")]
    Exited {
        code: Option<i32>,
    },
}

#[derive(Default)]
struct Log {
    lines: VecDeque<LogLine>,
    next_seq: u64,
    dropped: u64,
    last_level: Option<Level>,
}

impl Log {
    fn push(&mut self, stream: &'static str, text: String) {
        let level = classify(&text, self.last_level);
        self.last_level = Some(level);
        if self.lines.len() >= LOG_CAP {
            self.lines.pop_front();
            self.dropped += 1;
        }
        self.lines.push_back(LogLine {
            seq: self.next_seq,
            stream,
            level,
            text,
            at: now_ms(),
        });
        self.next_seq += 1;
    }
}

/// What a line of Godot output is, judged by the prefixes the engine prints.
/// A `at:` line belongs to the error or warning above it.
pub fn classify(text: &str, previous: Option<Level>) -> Level {
    let t = text.trim_start();
    let error = [
        "ERROR:",
        "SCRIPT ERROR:",
        "USER ERROR:",
        "FATAL",
        "Unhandled Exception",
    ];
    let warning = ["WARNING:", "USER WARNING:", "SCRIPT WARNING:"];
    if error.iter().any(|p| t.starts_with(p)) || t.starts_with("Parse Error") {
        Level::Error
    } else if warning.iter().any(|p| t.starts_with(p)) {
        Level::Warning
    } else if t.starts_with("at:") && matches!(previous, Some(Level::Error | Level::Warning)) {
        previous.unwrap_or(Level::Info)
    } else {
        Level::Info
    }
}

/// Godot colours its output with ANSI escapes when it thinks it has a terminal.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Everything needed to start one run.
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub program: PathBuf,
    pub project: PathBuf,
    /// A `res://` scene to run instead of the project's main scene.
    pub scene: Option<String>,
    /// The folder the Veistra capture addon listens in, when it is installed.
    pub channel: Option<PathBuf>,
    /// The window's size and where it first appears, when Play is going to
    /// place it over its pane.
    pub window: Option<WindowArgs>,
}

/// `--windowed --resolution <w>x<h> --position <x>,<y>`: sized to the pane,
/// and first shown off screen so it does not flash before it is placed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowArgs {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

impl WindowArgs {
    /// Far enough left and up to be on no monitor anyone has.
    pub const OFF_SCREEN: (i32, i32) = (-32000, -32000);
}

impl RunSpec {
    /// `godot --path <project> [window args] [scene] [-- --veistra-dir=<dir>]`
    pub fn args(&self) -> Vec<String> {
        let mut args = vec!["--path".to_string(), self.project.display().to_string()];
        if let Some(w) = &self.window {
            args.push("--windowed".to_string());
            args.push("--resolution".to_string());
            args.push(format!("{}x{}", w.width, w.height));
            args.push("--position".to_string());
            args.push(format!("{},{}", w.x, w.y));
        }
        if let Some(scene) = &self.scene {
            args.push(scene.clone());
        }
        if let Some(channel) = &self.channel {
            args.push("--".to_string());
            args.push(format!("--veistra-dir={}", channel.display()));
        }
        args
    }
}

/// One run, shared between the threads that feed it and the calls that read it.
pub struct Run {
    pub id: u64,
    pub pid: u32,
    pub spec: RunSpec,
    pub started: u64,
    state: Mutex<RunState>,
    ended: Mutex<Option<u64>>,
    log: Mutex<Log>,
    stop_requested: AtomicBool,
    pub paused: AtomicBool,
    on_exit: Mutex<Option<ExitHook>>,
}

/// What to do once a run has ended, set after it starts.
type ExitHook = Box<dyn FnOnce() + Send>;

/// A run as the pane draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: u64,
    pub pid: u32,
    pub state: RunState,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub scene: Option<String>,
    pub project: String,
    pub paused: bool,
    pub capture_ready: bool,
}

/// A slice of the log, and whether the caller's cursor had fallen off the end.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSlice {
    pub lines: Vec<LogLine>,
    pub next_seq: u64,
    pub truncated: bool,
}

impl Run {
    pub fn state(&self) -> RunState {
        self.state.lock_or_panic().clone()
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state(), RunState::Running)
    }

    pub fn info(&self) -> RunInfo {
        RunInfo {
            id: self.id,
            pid: self.pid,
            state: self.state(),
            started_at: self.started,
            ended_at: *self.ended.lock_or_panic(),
            scene: self.spec.scene.clone(),
            project: self.spec.project.display().to_string(),
            paused: self.paused.load(Ordering::SeqCst),
            capture_ready: self.spec.channel.is_some(),
        }
    }

    /// Lines with `seq >= since`.
    pub fn log_since(&self, since: u64) -> LogSlice {
        let log = self.log.lock_or_panic();
        let first = log.lines.front().map_or(log.next_seq, |l| l.seq);
        LogSlice {
            truncated: since < first,
            next_seq: log.next_seq,
            lines: log
                .lines
                .iter()
                .filter(|l| l.seq >= since)
                .cloned()
                .collect(),
        }
    }

    fn note(&self, text: String) {
        self.log.lock_or_panic().push("veistra", text);
    }

    fn finish(&self, code: Option<i32>) {
        let mut state = self.state.lock_or_panic();
        *state = if self.stop_requested.load(Ordering::SeqCst) {
            RunState::Stopped
        } else {
            RunState::Exited { code }
        };
        drop(state);
        *self.ended.lock_or_panic() = Some(now_ms());
        let hook = self.on_exit.lock_or_panic().take();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// Run `hook` once the run has ended, on the thread that saw it end; at
    /// once, here, if it already has. Replaces a hook set before.
    pub fn on_exit(&self, hook: ExitHook) {
        let mut slot = self.on_exit.lock_or_panic();
        if self.is_running() {
            *slot = Some(hook);
            return;
        }
        drop(slot);
        hook();
    }
}

/// Every run this process started, by the key its caller chose (a cluster id).
#[derive(Default)]
pub struct Runner {
    runs: Mutex<HashMap<String, Arc<Run>>>,
    next_id: AtomicU64,
}

impl Runner {
    pub fn get(&self, key: &str) -> Option<Arc<Run>> {
        self.runs.lock_or_panic().get(key).cloned()
    }

    /// Start a run under `key`. Refused while the previous one is still going:
    /// replacing a live run would orphan its process, and Restart is the verb
    /// that stops first.
    pub fn start(&self, key: &str, spec: RunSpec) -> Result<Arc<Run>, String> {
        if self.get(key).is_some_and(|r| r.is_running()) {
            return Err("a game is already running here - stop it or restart it".to_string());
        }

        let mut command = super::detect::base_command(&spec.program);
        command
            .args(spec.args())
            .current_dir(&spec.project)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", spec.program.display()))?;

        let run = Arc::new(Run {
            id: self.next_id.fetch_add(1, Ordering::SeqCst) + 1,
            pid: child.id(),
            started: now_ms(),
            spec,
            state: Mutex::new(RunState::Running),
            ended: Mutex::new(None),
            log: Mutex::new(Log::default()),
            stop_requested: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            on_exit: Mutex::new(None),
        });
        run.note(format!(
            "$ {} {}",
            run.spec.program.display(),
            run.spec.args().join(" ")
        ));

        if let Some(out) = child.stdout.take() {
            pipe_into(run.clone(), "out", out);
        }
        if let Some(err) = child.stderr.take() {
            pipe_into(run.clone(), "err", err);
        }
        wait_in_background(run.clone(), child);

        self.runs
            .lock_or_panic()
            .insert(key.to_string(), run.clone());
        Ok(run)
    }

    /// Kill the run's whole process tree and wait for the exit to be observed.
    /// `Ok(false)` when nothing was running.
    pub fn stop(&self, key: &str) -> Result<bool, String> {
        let Some(run) = self.get(key) else {
            return Ok(false);
        };
        if !run.is_running() {
            return Ok(false);
        }
        run.stop_requested.store(true, Ordering::SeqCst);
        kill_tree(run.pid);
        for _ in 0..150 {
            if !run.is_running() {
                run.note("stopped".to_string());
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(format!(
            "process {} did not exit after being killed",
            run.pid
        ))
    }

    /// Kill everything still running. Called when the application exits, so a
    /// game never outlives the window that started it.
    pub fn stop_all(&self) {
        let runs: Vec<Arc<Run>> = self.runs.lock_or_panic().values().cloned().collect();
        for run in runs.iter().filter(|r| r.is_running()) {
            run.stop_requested.store(true, Ordering::SeqCst);
            kill_tree(run.pid);
        }
        // Wait for the exits to be observed, so the caller knows they are gone.
        for run in &runs {
            for _ in 0..150 {
                if !run.is_running() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn pipe_into<R: Read + Send + 'static>(run: Arc<Run>, stream: &'static str, source: R) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(source);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let clean = strip_ansi(text.trim_end_matches(['\r', '\n']));
                    run.log.lock_or_panic().push(stream, clean);
                }
            }
        }
    });
}

fn wait_in_background(run: Arc<Run>, mut child: Child) {
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        run.finish(code);
    });
}

/// `taskkill /T` walks descendants, which is what reaches the game when the
/// program Veistra started was a wrapper (a `.cmd` shim, or a launcher that spawns
/// the real binary). Killing only the pid it holds would leave the game window
/// open with nothing supervising it.
#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let result = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Err(e) = result {
        crate::veistra_log!("could not stop the game (pid {pid}): {e}");
    }
}

/// The run was started as its own process group, so a negative pid reaches
/// every descendant that did not leave it.
#[cfg(not(windows))]
pub fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &format!("-{pid}")])
        .output();
}

/// The folder holding a run's channel files, unique per run so a stale command
/// from a previous game can never be read by the next one. Run ids start at 1
/// on every launch and cluster ids are restored from disk, so the process id
/// is in the name too: without it the first run after a relaunch read the
/// last launch's telemetry, F7 included, and stopped itself.
pub fn channel_dir(base: &Path, key: &str, id_hint: u64) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    base.join(format!("{safe}-{}-{id_hint}", std::process::id()))
}

/// [`channel_dir`], emptied and made: a folder left by a process that had
/// this id before is someone else's old run.
pub fn fresh_channel(base: &Path, key: &str, id_hint: u64) -> std::io::Result<PathBuf> {
    let dir = channel_dir(base, key, id_hint);
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            crate::veistra_log!("play: could not clear {}: {e}", dir.display());
        }
        _ => {}
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

impl Runner {
    /// The id the next run will get, for naming its channel folder before spawn.
    pub fn peek_next_id(&self) -> u64 {
        self.next_id.load(Ordering::SeqCst) + 1
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fake_godot;
    use super::*;
    use tempfile::TempDir;

    fn spec(dir: &TempDir, linger: bool, scene: Option<&str>) -> RunSpec {
        let project = dir.path().join("game");
        std::fs::create_dir_all(&project).unwrap();
        RunSpec {
            program: fake_godot(dir.path(), linger),
            project,
            scene: scene.map(str::to_string),
            channel: None,
            window: None,
        }
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..300 {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}");
    }

    #[test]
    fn classification_follows_the_prefixes_godot_prints() {
        assert_eq!(classify("ERROR: x", None), Level::Error);
        assert_eq!(classify("  SCRIPT ERROR: Parse Error", None), Level::Error);
        assert_eq!(classify("USER WARNING: y", None), Level::Warning);
        assert_eq!(
            classify("   at: f (res://a.gd:3)", Some(Level::Error)),
            Level::Error
        );
        assert_eq!(
            classify("   at: f (res://a.gd:3)", Some(Level::Info)),
            Level::Info
        );
        assert_eq!(classify("hello", Some(Level::Error)), Level::Info);
    }

    #[test]
    fn ansi_colour_codes_are_stripped_from_log_text() {
        assert_eq!(strip_ansi("\u{1b}[1;31mERROR:\u{1b}[0m bad"), "ERROR: bad");
    }

    #[test]
    fn args_put_the_scene_before_the_user_args_and_the_channel_after_the_separator() {
        let spec = RunSpec {
            program: PathBuf::from("godot"),
            project: PathBuf::from("/p"),
            scene: Some("res://a.tscn".to_string()),
            channel: Some(PathBuf::from("/tmp/c")),
            window: None,
        };
        assert_eq!(
            spec.args(),
            vec!["--path", "/p", "res://a.tscn", "--", "--veistra-dir=/tmp/c"]
        );
    }

    #[test]
    fn window_args_are_engine_args_before_the_scene_and_the_separator() {
        let spec = RunSpec {
            program: PathBuf::from("godot"),
            project: PathBuf::from("/p"),
            scene: Some("res://a.tscn".to_string()),
            channel: Some(PathBuf::from("/tmp/c")),
            window: Some(WindowArgs {
                width: 960,
                height: 540,
                x: -32000,
                y: -32000,
            }),
        };
        assert_eq!(
            spec.args(),
            vec![
                "--path",
                "/p",
                "--windowed",
                "--resolution",
                "960x540",
                "--position",
                "-32000,-32000",
                "res://a.tscn",
                "--",
                "--veistra-dir=/tmp/c"
            ]
        );
    }

    #[test]
    fn an_exit_hook_runs_once_the_game_ends_or_at_once_if_it_has() {
        let dir = TempDir::new().unwrap();
        let runner = Runner::default();
        let run = runner.start("c1", spec(&dir, false, None)).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let early = tx.clone();
        run.on_exit(Box::new(move || early.send("ended").unwrap()));
        assert_eq!(rx.recv_timeout(Duration::from_secs(6)), Ok("ended"));
        wait_until("exit", || !run.is_running());
        run.on_exit(Box::new(move || tx.send("late").unwrap()));
        assert_eq!(
            rx.try_recv(),
            Ok("late"),
            "a hook set after the end runs at once"
        );
    }

    #[test]
    fn a_run_streams_both_streams_classifies_them_and_records_the_exit_code() {
        let dir = TempDir::new().unwrap();
        let runner = Runner::default();
        let run = runner
            .start("c1", spec(&dir, false, Some("res://main.tscn")))
            .unwrap();
        wait_until("the game to exit", || !run.is_running());
        wait_until("the log to fill", || run.log_since(0).lines.len() >= 6);

        assert_eq!(run.state(), RunState::Exited { code: Some(3) });
        let slice = run.log_since(0);
        let by = |needle: &str| {
            slice
                .lines
                .iter()
                .find(|l| l.text.contains(needle))
                .unwrap()
        };
        assert_eq!(by("something broke").level, Level::Error);
        assert_eq!(by("something broke").stream, "out");
        assert_eq!(
            by("at: thing").level,
            Level::Error,
            "an `at:` line inherits the error above it"
        );
        assert_eq!(by("at: thing").stream, "err");
        assert_eq!(by("careful").level, Level::Warning);
        assert!(by("args:").text.contains("--path"));
        assert!(by("args:").text.contains("res://main.tscn"));
    }

    #[test]
    fn the_log_cursor_returns_only_new_lines_and_reports_a_fallen_cursor() {
        let dir = TempDir::new().unwrap();
        let runner = Runner::default();
        let run = runner.start("c1", spec(&dir, false, None)).unwrap();
        wait_until("exit", || !run.is_running());
        wait_until("log", || run.log_since(0).lines.len() >= 6);

        let all = run.log_since(0);
        let rest = run.log_since(all.next_seq - 1);
        assert_eq!(rest.lines.len(), 1);
        assert!(run.log_since(all.next_seq).lines.is_empty());

        for i in 0..(LOG_CAP + 10) {
            run.log.lock_or_panic().push("out", format!("line {i}"));
        }
        assert!(run.log_since(0).truncated);
        assert_eq!(run.log_since(0).lines.len(), LOG_CAP);
    }

    #[test]
    fn stop_kills_a_lingering_run_and_marks_it_stopped_not_exited() {
        let dir = TempDir::new().unwrap();
        let runner = Runner::default();
        let run = runner.start("c1", spec(&dir, true, None)).unwrap();
        wait_until("output", || !run.log_since(0).lines.is_empty());
        assert!(run.is_running(), "the fake game lingers");

        assert_eq!(runner.stop("c1"), Ok(true));
        assert_eq!(run.state(), RunState::Stopped);
        assert!(run.info().ended_at.is_some());
        assert_eq!(
            runner.stop("c1"),
            Ok(false),
            "stopping twice is not an error"
        );
    }

    #[test]
    fn a_second_start_is_refused_while_one_runs_but_allowed_after_it_ends() {
        let dir = TempDir::new().unwrap();
        let runner = Runner::default();
        runner.start("c1", spec(&dir, true, None)).unwrap();
        let err = runner.start("c1", spec(&dir, true, None)).err().unwrap();
        assert!(err.contains("already running"));

        runner.start("c2", spec(&dir, true, None)).unwrap();
        runner.stop("c1").unwrap();
        runner.start("c1", spec(&dir, false, None)).unwrap();
        runner.stop_all();
        assert!(
            !runner.get("c2").unwrap().is_running(),
            "stop_all reaches every cluster's game"
        );
        assert!(
            !runner.get("c1").unwrap().is_running(),
            "and the one started after a restart"
        );
    }

    #[test]
    fn a_program_that_cannot_start_is_an_error_not_a_dead_run() {
        let dir = TempDir::new().unwrap();
        let runner = Runner::default();
        let mut bad = spec(&dir, false, None);
        bad.program = dir.path().join("nope");
        assert!(runner.start("c1", bad).is_err());
        assert!(runner.get("c1").is_none());
    }

    #[test]
    fn a_channel_never_holds_what_an_earlier_launch_left() {
        let dir = TempDir::new().unwrap();
        let name = channel_dir(dir.path(), "cluster-1", 1);
        assert!(
            name.to_string_lossy()
                .contains(&format!("-{}-", std::process::id())),
            "a relaunch gets its own folder: {}",
            name.display()
        );
        std::fs::create_dir_all(&name).unwrap();
        std::fs::write(
            name.join("telemetry.jsonl"),
            "{\"t\":1,\"kind\":\"key\",\"key\":\"F7\"}\n",
        )
        .unwrap();
        std::fs::write(name.join("res-1.json"), "{}").unwrap();
        let fresh = fresh_channel(dir.path(), "cluster-1", 1).unwrap();
        assert_eq!(fresh, name);
        assert_eq!(
            std::fs::read_dir(&fresh).unwrap().count(),
            0,
            "emptied first"
        );
    }
}
