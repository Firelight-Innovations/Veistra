//! Running Blender headless as a supervised child process.
//!
//! [`run`] is the whole lifecycle — spawn, stream, wait, cancel, time out — and
//! knows nothing about Tauri, so the tests drive it with a fake executable.
//! [`Jobs`] wraps it in the one-at-a-time state the viewer polls.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Everything a run needs. `out_dir` is a scratch directory the script fills;
/// nothing in it is trusted until [`run`] has parsed `result.json`.
#[derive(Debug, Clone)]
pub struct Spec {
    pub exe: PathBuf,
    pub blend: PathBuf,
    pub script: PathBuf,
    pub out_dir: PathBuf,
    pub engine: String,
    pub resolution: u32,
    pub views: Vec<String>,
    pub timeout: Duration,
    /// Every stdout/stderr line is appended here as it arrives.
    pub log_path: Option<PathBuf>,
}

/// `blender -b <blend> ... --python <script>`. No `--`-style arguments: the job
/// travels in environment variables ([`build_env`]), so nothing is re-quoted.
///
/// `--disable-autoexec` because a `.blend` from anywhere can carry a Python
/// driver or script link that would otherwise run with this user's privileges.
pub fn build_args(blend: &Path, script: &Path) -> Vec<OsString> {
    vec![
        "-b".into(),
        blend.as_os_str().to_owned(),
        "--disable-autoexec".into(),
        "-noaudio".into(),
        "--python-exit-code".into(),
        "1".into(),
        "--python".into(),
        script.as_os_str().to_owned(),
    ]
}

pub fn build_env(spec: &Spec) -> Vec<(&'static str, String)> {
    vec![
        ("VEISTRA_BLENDER_OUT", spec.out_dir.display().to_string()),
        ("VEISTRA_BLENDER_ENGINE", spec.engine.clone()),
        ("VEISTRA_BLENDER_RES", spec.resolution.to_string()),
        ("VEISTRA_BLENDER_VIEWS", spec.views.join(",")),
    ]
}

#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub step: u32,
    pub total: u32,
    pub label: String,
}

/// `VEISTRA_PROGRESS 2/5 render front` to `Progress { 2, 5, "render front" }`.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let rest = line.trim().strip_prefix("VEISTRA_PROGRESS ")?;
    let (fraction, label) = rest.split_once(' ').unwrap_or((rest, ""));
    let (step, total) = fraction.split_once('/')?;
    Some(Progress {
        step: step.parse().ok()?,
        total: total.parse().ok()?,
        label: label.trim().to_string(),
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderEntry {
    pub id: String,
    pub label: String,
    pub file: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PartEntry {
    pub name: String,
    pub kind: String,
    pub parent: Option<String>,
    pub visible: bool,
    pub mesh: Option<String>,
    pub materials: Vec<String>,
    pub verts: u64,
    pub polys: u64,
    pub tris: u64,
    pub dimensions: Vec<f64>,
    /// For `kind == "instance"`: the collection the empty instances.
    pub instance_of: Option<String>,
    /// For `kind == "instance"`: how many meshes that collection brings in.
    pub instance_meshes: u64,
}

/// What `export.py` wrote to `result.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScriptResult {
    pub blender_version: String,
    pub glb: Option<String>,
    pub renders: Vec<RenderEntry>,
    pub parts: Vec<PartEntry>,
    /// Each material's name, colour and scalar values, as Compare reads them.
    pub materials: Vec<Value>,
    pub stats: Value,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum Event {
    Progress(Progress),
    Line(String),
}

#[derive(Debug)]
pub enum Outcome {
    Done(ScriptResult),
    Failed(String),
    Cancelled,
}

/// Tail of the log kept for an error message.
const TAIL: usize = 12;

pub fn run(
    spec: &Spec,
    cancel: &AtomicBool,
    on_event: Arc<dyn Fn(Event) + Send + Sync>,
) -> Outcome {
    if let Err(e) = std::fs::create_dir_all(&spec.out_dir) {
        return Outcome::Failed(format!("could not create {}: {e}", spec.out_dir.display()));
    }
    let _ = std::fs::remove_file(spec.out_dir.join("result.json"));

    let mut cmd = Command::new(&spec.exe);
    cmd.args(build_args(&spec.blend, &spec.script))
        .envs(build_env(spec))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    super::no_window(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Outcome::Failed(format!("could not start {}: {e}", spec.exe.display()));
        }
    };

    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    // Set once Blender has been deliberately stopped: from then on the readers
    // are on their own and must not touch the job's log.
    let detached = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|stream| {
        let on_event = on_event.clone();
        let tail = tail.clone();
        let detached = detached.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            while matches!(reader.read_until(b'\n', &mut buf), Ok(n) if n > 0) {
                if detached.load(Ordering::SeqCst) {
                    break;
                }
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                buf.clear();
                match parse_progress(&line) {
                    Some(p) => on_event(Event::Progress(p)),
                    None => {
                        let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                        t.push(line.clone());
                        if t.len() > TAIL {
                            t.remove(0);
                        }
                        drop(t);
                        on_event(Event::Line(line));
                    }
                }
            }
        })
    })
    .collect();

    let deadline = Instant::now() + spec.timeout;
    let mut stopped: Option<&'static str> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Outcome::Failed(format!("lost track of Blender: {e}")),
        }
        if cancel.load(Ordering::SeqCst) {
            stopped = Some("cancelled");
        } else if Instant::now() >= deadline {
            stopped = Some("timed out");
        }
        if stopped.is_some() {
            kill_tree(&mut child);
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    if stopped.is_some() {
        // The outcome is already decided, so do not wait for the pipes to reach
        // end-of-file. They close only when every process holding the write end
        // is gone, and `taskkill /T` can miss a grandchild spawned while it
        // enumerated the tree. Joining here would hold the job at
        // `running: true` until that orphan exits on its own.
        detached.store(true, Ordering::SeqCst);
    } else {
        for reader in readers {
            let _ = reader.join();
        }
    }

    match (stopped, status) {
        (Some("cancelled"), _) => Outcome::Cancelled,
        (Some(why), _) => Outcome::Failed(format!(
            "Blender {why} after {}s and was stopped",
            spec.timeout.as_secs()
        )),
        (None, Some(status)) if !status.success() => {
            let lines = tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
            Outcome::Failed(format!("Blender exited with {status}\n{lines}"))
        }
        _ => parse_result(&spec.out_dir),
    }
}

fn parse_result(out_dir: &Path) -> Outcome {
    let raw = match std::fs::read_to_string(out_dir.join("result.json")) {
        Ok(raw) => raw,
        Err(_) => return Outcome::Failed(
            "Blender finished but wrote no result.json — the export script did not run to its end"
                .into(),
        ),
    };
    let result: ScriptResult = match serde_json::from_str(&raw) {
        Ok(result) => result,
        Err(e) => return Outcome::Failed(format!("result.json was unreadable: {e}")),
    };
    // A file the script names must exist, or the manifest would point at air.
    let ok = |name: &str| out_dir.join(name).is_file();
    let result = ScriptResult {
        glb: result.glb.filter(|g| ok(g)),
        renders: result.renders.into_iter().filter(|r| ok(&r.file)).collect(),
        ..result
    };
    if result.glb.is_none() && result.renders.is_empty() && result.parts.is_empty() {
        let why = if result.warnings.is_empty() {
            "nothing was produced".to_string()
        } else {
            result.warnings.join("; ")
        };
        return Outcome::Failed(format!("the export produced nothing usable: {why}"));
    }
    Outcome::Done(result)
}

/// Blender is one process, but a wrapper script or a launcher may not be, and
/// "no orphans" is the promise — so on Windows the whole tree goes.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::no_window(&mut cmd);
        let _ = cmd.status();
    }
    let _ = child.kill();
}

// --- the one running job ----------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub running: bool,
    pub blend: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub step: u32,
    pub total: u32,
    pub label: String,
    pub log: Vec<String>,
    /// `"ok"`, `"failed"` or `"cancelled"` once a run has ended.
    pub outcome: Option<&'static str>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

const LOG_LINES: usize = 400;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
pub struct Jobs {
    snapshot: Arc<Mutex<Snapshot>>,
    cancel: Arc<AtomicBool>,
}

impl Jobs {
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Start `spec` on a background thread. `finish` runs on that thread after
    /// a successful run, to move the scratch output into place; its error makes
    /// the run a failure.
    pub fn start<F>(&self, label: String, spec: Spec, finish: F) -> Result<(), String>
    where
        F: FnOnce(&ScriptResult) -> Result<(), String> + Send + 'static,
    {
        {
            let mut snap = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            if snap.running {
                return Err(format!(
                    "an export of {} is already running — cancel it or wait",
                    snap.blend.as_deref().unwrap_or("another file")
                ));
            }
            *snap = Snapshot {
                running: true,
                blend: Some(label),
                started_at: Some(now_ms()),
                ..Snapshot::default()
            };
        }
        self.cancel.store(false, Ordering::SeqCst);

        let snapshot = self.snapshot.clone();
        let cancel = self.cancel.clone();
        std::thread::spawn(move || {
            let log_file = spec.log_path.as_ref().and_then(|p| {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                std::fs::File::create(p).ok()
            });
            let log_file = Mutex::new(log_file);
            let live = snapshot.clone();
            let on_event: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |event| {
                let mut snap = live.lock().unwrap_or_else(|e| e.into_inner());
                match event {
                    Event::Progress(p) => {
                        snap.step = p.step;
                        snap.total = p.total;
                        snap.label = p.label;
                    }
                    Event::Line(line) => {
                        if let Some(file) =
                            log_file.lock().unwrap_or_else(|e| e.into_inner()).as_mut()
                        {
                            let _ = writeln!(file, "{line}");
                        }
                        snap.log.push(line);
                        if snap.log.len() > LOG_LINES {
                            snap.log.remove(0);
                        }
                    }
                }
            });

            let outcome = run(&spec, &cancel, on_event);
            let (outcome, error, warnings) = match outcome {
                Outcome::Done(result) => match finish(&result) {
                    Ok(()) => ("ok", None, result.warnings),
                    Err(e) => ("failed", Some(e), Vec::new()),
                },
                Outcome::Failed(e) => ("failed", Some(e), Vec::new()),
                Outcome::Cancelled => ("cancelled", None, Vec::new()),
            };
            let _ = std::fs::remove_dir_all(&spec.out_dir);

            let mut snap = snapshot.lock().unwrap_or_else(|e| e.into_inner());
            snap.running = false;
            snap.finished_at = Some(now_ms());
            snap.outcome = Some(outcome);
            snap.error = error;
            snap.warnings = warnings;
        });
        Ok(())
    }

    pub fn cancel(&self) -> bool {
        let running = self.snapshot().running;
        if running {
            self.cancel.store(true, Ordering::SeqCst);
        }
        running
    }

    /// For app exit: cancel and wait briefly, so no Blender outlives Veistra.
    pub fn stop_all(&self) {
        if self.cancel() {
            let until = Instant::now() + Duration::from_secs(3);
            while self.snapshot().running && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn instance_fields_survive_result_parsing() {
        let json = r#"{"parts":[{"name":"CrateLinked","kind":"instance","tris":108,
            "instanceOf":"CrateProp","instanceMeshes":1},{"name":"Old","kind":"mesh"}]}"#;
        let result: ScriptResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.parts[0].instance_of.as_deref(), Some("CrateProp"));
        assert_eq!(result.parts[0].instance_meshes, 1);
        assert_eq!(result.parts[1].instance_of, None);
    }

    /// A stand-in `blender`. On Windows a `.cmd`, elsewhere `sh`; both read the
    /// same environment variables the real script does and write the same
    /// files, so the run exercises spawn, streaming, parsing and cancel for real.
    pub(crate) fn fake_blender(dir: &Path, mode: &str) -> PathBuf {
        let body: &str = match mode {
            "ok" => OK,
            "hang" => HANG,
            "crash" => CRASH,
            "empty" => EMPTY,
            _ => panic!("unknown fake mode"),
        };
        let name = if cfg!(windows) {
            "blender.cmd"
        } else {
            "blender"
        };
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write fake");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
        path
    }

    #[cfg(windows)]
    const OK: &str = "@echo off\r\n\
if \"%1\"==\"--version\" (\r\necho Blender 4.2.1\r\nexit /b 0\r\n)\r\n\
echo %*> \"%VEISTRA_BLENDER_OUT%\\argv.txt\"\r\n\
echo VEISTRA_PROGRESS 1/3 parts list\r\n\
echo hello from blender\r\n\
echo VEISTRA_PROGRESS 2/3 glb\r\n\
echo glb> \"%VEISTRA_BLENDER_OUT%\\model.glb\"\r\n\
echo png> \"%VEISTRA_BLENDER_OUT%\\front.png\"\r\n\
echo VEISTRA_PROGRESS 3/3 render front\r\n\
echo {\"blenderVersion\":\"4.2.1\",\"glb\":\"model.glb\",\"renders\":[{\"id\":\"front\",\"label\":\"front\",\"file\":\"front.png\"},{\"id\":\"gone\",\"label\":\"gone\",\"file\":\"missing.png\"}],\"parts\":[{\"name\":\"Frame\",\"kind\":\"mesh\",\"visible\":true,\"mesh\":\"Frame\",\"materials\":[\"steel\"],\"verts\":8,\"polys\":6,\"tris\":12,\"dimensions\":[1,1,1]}],\"stats\":{\"objects\":1},\"warnings\":[\"a warning\"]}> \"%VEISTRA_BLENDER_OUT%\\result.json\"\r\n";
    #[cfg(not(windows))]
    const OK: &str = "#!/bin/sh\n\
if [ \"$1\" = \"--version\" ]; then echo 'Blender 4.2.1'; exit 0; fi\n\
printf '%s ' \"$@\" > \"$VEISTRA_BLENDER_OUT/argv.txt\"\n\
echo 'VEISTRA_PROGRESS 1/3 parts list'\n\
echo 'hello from blender'\n\
echo 'VEISTRA_PROGRESS 2/3 glb'\n\
echo glb > \"$VEISTRA_BLENDER_OUT/model.glb\"\n\
echo png > \"$VEISTRA_BLENDER_OUT/front.png\"\n\
echo 'VEISTRA_PROGRESS 3/3 render front'\n\
echo '{\"blenderVersion\":\"4.2.1\",\"glb\":\"model.glb\",\"renders\":[{\"id\":\"front\",\"label\":\"front\",\"file\":\"front.png\"},{\"id\":\"gone\",\"label\":\"gone\",\"file\":\"missing.png\"}],\"parts\":[{\"name\":\"Frame\",\"kind\":\"mesh\",\"visible\":true,\"mesh\":\"Frame\",\"materials\":[\"steel\"],\"verts\":8,\"polys\":6,\"tris\":12,\"dimensions\":[1,1,1]}],\"stats\":{\"objects\":1},\"warnings\":[\"a warning\"]}' > \"$VEISTRA_BLENDER_OUT/result.json\"\n";

    #[cfg(windows)]
    const HANG: &str = "@echo off\r\nif \"%1\"==\"--version\" (\r\necho Blender 4.2.1\r\nexit /b 0\r\n)\r\necho VEISTRA_PROGRESS 1/3 parts list\r\nping -n 60 127.0.0.1 >nul\r\n";
    #[cfg(not(windows))]
    const HANG: &str = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Blender 4.2.1'; exit 0; fi\necho 'VEISTRA_PROGRESS 1/3 parts list'\nexec sleep 60\n";

    #[cfg(windows)]
    const CRASH: &str = "@echo off\r\nif \"%1\"==\"--version\" (\r\necho Blender 4.2.1\r\nexit /b 0\r\n)\r\necho Error: cannot open file 1>&2\r\nexit /b 3\r\n";
    #[cfg(not(windows))]
    const CRASH: &str = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Blender 4.2.1'; exit 0; fi\necho 'Error: cannot open file' >&2\nexit 3\n";

    #[cfg(windows)]
    const EMPTY: &str = "@echo off\r\nif \"%1\"==\"--version\" (\r\necho Blender 4.2.1\r\nexit /b 0\r\n)\r\nexit /b 0\r\n";
    #[cfg(not(windows))]
    const EMPTY: &str =
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Blender 4.2.1'; exit 0; fi\nexit 0\n";

    fn spec(dir: &Path, exe: PathBuf) -> Spec {
        Spec {
            exe,
            blend: dir.join("bed.blend"),
            script: dir.join("export.py"),
            out_dir: dir.join("pending"),
            engine: "workbench".into(),
            resolution: 256,
            views: vec!["front".into(), "wire".into()],
            timeout: Duration::from_secs(30),
            log_path: None,
        }
    }

    type Sink = Arc<dyn Fn(Event) + Send + Sync>;

    fn sink() -> (Sink, Arc<Mutex<Vec<Event>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let inner = events.clone();
        (Arc::new(move |e| inner.lock().unwrap().push(e)), events)
    }

    #[test]
    fn arguments_run_headless_without_autoexec_and_name_the_script() {
        let args = build_args(Path::new("a.blend"), Path::new("x.py"));
        let args: Vec<_> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[..2], ["-b", "a.blend"]);
        assert!(args.contains(&"--disable-autoexec".to_string()));
        assert_eq!(args[args.len() - 2..], ["--python", "x.py"]);
        let py = args.iter().position(|a| a == "--python-exit-code").unwrap();
        assert_eq!(args[py + 1], "1");
    }

    #[test]
    fn the_job_travels_in_environment_variables() {
        let dir = TempDir::new().unwrap();
        let env = build_env(&spec(dir.path(), PathBuf::from("blender")));
        let get = |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("VEISTRA_BLENDER_ENGINE"), Some("workbench"));
        assert_eq!(get("VEISTRA_BLENDER_RES"), Some("256"));
        assert_eq!(get("VEISTRA_BLENDER_VIEWS"), Some("front,wire"));
        assert!(get("VEISTRA_BLENDER_OUT").unwrap().ends_with("pending"));
    }

    #[test]
    fn progress_lines_parse_and_other_lines_do_not() {
        assert_eq!(
            parse_progress("VEISTRA_PROGRESS 2/5 render front\r"),
            Some(Progress {
                step: 2,
                total: 5,
                label: "render front".into()
            })
        );
        assert_eq!(parse_progress("VEISTRA_PROGRESS x/5 y"), None);
        assert_eq!(parse_progress("Fra:1 Mem:12M"), None);
    }

    #[test]
    fn a_successful_run_streams_progress_and_parses_the_result() {
        let dir = TempDir::new().unwrap();
        let exe = fake_blender(dir.path(), "ok");
        let (sink, events) = sink();
        let outcome = run(&spec(dir.path(), exe), &AtomicBool::new(false), sink);

        let Outcome::Done(result) = outcome else {
            panic!("expected Done, got {outcome:?}");
        };
        assert_eq!(result.glb.as_deref(), Some("model.glb"));
        // The render the script named but never wrote is dropped.
        assert_eq!(result.renders.len(), 1);
        assert_eq!(result.renders[0].id, "front");
        assert_eq!(result.parts[0].materials, ["steel"]);
        assert_eq!(result.parts[0].tris, 12);
        assert_eq!(result.warnings, ["a warning"]);

        let events = events.lock().unwrap();
        let steps: Vec<u32> = events
            .iter()
            .filter_map(|e| match e {
                Event::Progress(p) => Some(p.step),
                _ => None,
            })
            .collect();
        assert_eq!(steps, [1, 2, 3]);
        assert!(events
            .iter()
            .any(|e| matches!(e, Event::Line(l) if l == "hello from blender")));

        let argv = std::fs::read_to_string(dir.path().join("pending").join("argv.txt")).unwrap();
        assert!(argv.contains("--disable-autoexec"));
        assert!(argv.contains("bed.blend"));
    }

    #[test]
    fn a_crash_is_a_failure_carrying_the_tail_of_stderr() {
        let dir = TempDir::new().unwrap();
        let exe = fake_blender(dir.path(), "crash");
        let (sink, _) = sink();
        let Outcome::Failed(why) = run(&spec(dir.path(), exe), &AtomicBool::new(false), sink)
        else {
            panic!("expected Failed");
        };
        assert!(why.contains("cannot open file"), "{why}");
    }

    #[test]
    fn exiting_cleanly_without_a_result_is_a_failure_not_a_success() {
        let dir = TempDir::new().unwrap();
        let exe = fake_blender(dir.path(), "empty");
        let (sink, _) = sink();
        let outcome = run(&spec(dir.path(), exe), &AtomicBool::new(false), sink);
        assert!(matches!(outcome, Outcome::Failed(w) if w.contains("result.json")));
    }

    #[test]
    fn a_missing_executable_is_a_failure() {
        let dir = TempDir::new().unwrap();
        let (sink, _) = sink();
        let outcome = run(
            &spec(dir.path(), dir.path().join("no-such-blender")),
            &AtomicBool::new(false),
            sink,
        );
        assert!(matches!(outcome, Outcome::Failed(w) if w.contains("could not start")));
    }

    #[test]
    fn cancel_stops_a_hung_run_promptly() {
        let dir = TempDir::new().unwrap();
        let exe = fake_blender(dir.path(), "hang");
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let started = Instant::now();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::SeqCst);
        });
        let (sink, _) = sink();
        let outcome = run(&spec(dir.path(), exe), &cancel, sink);
        stopper.join().unwrap();
        assert!(matches!(outcome, Outcome::Cancelled), "{outcome:?}");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "cancel took too long"
        );
    }

    /// A grandchild that outlives the process we kill keeps the output pipes
    /// open. The cancelled outcome must not wait for it. `kill` reaches only the
    /// shell here, where Windows' `taskkill /T` would also take the child.
    #[cfg(unix)]
    #[test]
    fn cancel_does_not_wait_for_an_orphan_holding_the_pipes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let exe = dir.path().join("blender");
        std::fs::write(&exe, "#!/bin/sh\nsleep 30 &\nwait\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let (sink, _) = sink();
        let outcome = run(&spec(dir.path(), exe), &cancel, sink);
        stopper.join().unwrap();
        assert!(matches!(outcome, Outcome::Cancelled), "{outcome:?}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the run waited on the orphan's pipes"
        );
    }

    #[test]
    fn a_run_past_its_timeout_is_stopped_and_reported() {
        let dir = TempDir::new().unwrap();
        let exe = fake_blender(dir.path(), "hang");
        let mut s = spec(dir.path(), exe);
        s.timeout = Duration::from_millis(500);
        let (sink, _) = sink();
        let outcome = run(&s, &AtomicBool::new(false), sink);
        assert!(matches!(outcome, Outcome::Failed(w) if w.contains("timed out")));
    }

    #[test]
    fn jobs_run_one_at_a_time_and_report_the_outcome() {
        let dir = TempDir::new().unwrap();
        let hang = fake_blender(dir.path(), "hang");
        let jobs = Jobs::default();
        jobs.start("bed.blend".into(), spec(dir.path(), hang), |_| Ok(()))
            .unwrap();

        let second = jobs.start(
            "other.blend".into(),
            spec(dir.path(), PathBuf::new()),
            |_| Ok(()),
        );
        assert!(second.unwrap_err().contains("already running"));
        assert_eq!(jobs.snapshot().blend.as_deref(), Some("bed.blend"));

        assert!(jobs.cancel());
        let until = Instant::now() + Duration::from_secs(20);
        while jobs.snapshot().running && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let snap = jobs.snapshot();
        assert!(!snap.running);
        assert_eq!(snap.outcome, Some("cancelled"));
    }

    #[test]
    fn a_finished_job_records_progress_log_and_warnings() {
        let dir = TempDir::new().unwrap();
        let exe = fake_blender(dir.path(), "ok");
        let jobs = Jobs::default();
        let mut s = spec(dir.path(), exe);
        s.log_path = Some(dir.path().join("logs").join("export.log"));
        let log = s.log_path.clone().unwrap();
        jobs.start("bed.blend".into(), s, |_| Ok(())).unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        while jobs.snapshot().running && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let snap = jobs.snapshot();
        assert_eq!(snap.outcome, Some("ok"));
        assert_eq!((snap.step, snap.total), (3, 3));
        assert!(snap.log.iter().any(|l| l == "hello from blender"));
        assert_eq!(snap.warnings, ["a warning"]);
        assert!(std::fs::read_to_string(log)
            .unwrap()
            .contains("hello from blender"));
    }
}
