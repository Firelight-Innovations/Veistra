//! Blender in the pane against a stand-in `blender` that only sleeps. The
//! channel's other end is played by the test: it writes `hello.json` and
//! `state.json` as the boot script would, and answers commands from a thread.

use super::*;
use crate::embed;
use std::sync::atomic::AtomicBool;
use tempfile::TempDir;

/// A `blender` that writes its arguments into the channel and then sleeps,
/// as the real one sits open on a file.
fn sleeping_blender(dir: &Path) -> PathBuf {
    #[cfg(windows)]
    let (name, body) = (
        "blender.cmd",
        "@echo off\r\necho %*> \"%VEISTRA_BLENDER_CHANNEL%\\argv.txt\"\r\nping -n 60 127.0.0.1 >nul\r\n",
    );
    #[cfg(not(windows))]
    let (name, body) = (
        "blender",
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$VEISTRA_BLENDER_CHANNEL/argv.txt\"\nexec sleep 60\n",
    );
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

struct World {
    _dir: TempDir,
    root: PathBuf,
    scratch: PathBuf,
    exe: PathBuf,
    editors: Editors,
    hosts: Hosts,
}

impl World {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("env");
        std::fs::create_dir_all(root.join("props")).unwrap();
        std::fs::write(root.join("props/bed.blend"), b"BLENDER-v402 bed").unwrap();
        std::fs::write(root.join("props/lamp.blend"), b"BLENDER-v402 lamp").unwrap();
        let scratch = dir.path().join("scratch");
        let exe = sleeping_blender(dir.path());
        Self {
            root: root.canonicalize().unwrap(),
            scratch,
            exe,
            _dir: dir,
            editors: Editors::default(),
            // Not placing: the window stays its own, which is all a test can see.
            hosts: Hosts::with(embed::native(), false, false),
        }
    }

    fn with<R>(&self, read_only: bool, f: impl FnOnce(&Ctx) -> R) -> R {
        let exe = self.exe.clone();
        let find = move || Ok((exe.clone(), Some("4.2.1".to_string())));
        let ctx = Ctx {
            editors: &self.editors,
            hosts: &self.hosts,
            cluster: "c1".into(),
            instance: Some("pane-1".into()),
            project: Some(self.root.clone()),
            read_only,
            find: &find,
            scratch: self.scratch.clone(),
            owner: Arc::new(|_| None),
            shown: &|_| true,
        };
        f(&ctx)
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.with(false, |ctx| {
            call(ctx, method, Some(&params)).expect("an editor method")
        })
    }

    fn open(&self, blend: &str) -> Arc<Editor> {
        self.call("blender-viewer/editor-open", json!({ "blend": blend }))
            .expect("opened");
        self.editors.get("c1").expect("an editor")
    }
}

impl Drop for World {
    fn drop(&mut self) {
        for editor in self.editors.all.lock_or_panic().values() {
            editor.end_for_test();
        }
    }
}

fn write(dir: &Path, name: &str, value: Value) {
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, value.to_string()).unwrap();
    std::fs::rename(tmp, dir.join(name)).unwrap();
}

/// Say hello as the boot script does, from the process Veistra started.
fn boot(editor: &Editor) {
    let pid = editor.child.lock_or_panic().id();
    write(
        &editor.channel,
        "hello.json",
        json!({ "version": 1, "pid": pid, "blender": "4.2.1" }),
    );
}

/// Blender reports `file` open, as the boot script's state.json does.
fn report(editor: &Editor, file: &str, dirty: bool) {
    write(
        &editor.channel,
        "state.json",
        json!({ "file": file, "dirty": dirty, "selected": [], "active": null, "view": null }),
    );
}

fn until(what: &str, done: impl Fn() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Answer every command in `dir` with `answer`, until `stop` is set.
fn responder(
    dir: PathBuf,
    answer: impl Fn(&Path, &Value) -> Value + Send + 'static,
) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        let mut last = None;
        while !flag.load(Ordering::SeqCst) {
            if let Ok(text) = std::fs::read_to_string(dir.join("cmd.json")) {
                if let Ok(cmd) = serde_json::from_str::<Value>(&text) {
                    if let Some(id) = cmd["id"].as_u64().filter(|id| last != Some(*id)) {
                        last = Some(id);
                        let mut reply = answer(&dir, &cmd);
                        reply["id"] = cmd["id"].clone();
                        write(&dir, &format!("res-{id}.json"), reply);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    stop
}

#[test]
fn blender_starts_on_the_file_with_the_boot_script_and_its_channel() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    until("argv", || editor.channel.join("argv.txt").is_file());
    let argv = std::fs::read_to_string(editor.channel.join("argv.txt")).unwrap();
    let args: Vec<&str> = argv.lines().map(str::trim).collect();
    assert!(args[0].ends_with("bed.blend"), "{argv}");
    assert_eq!(args[1], "--python");
    assert!(args[2].ends_with(BOOT_FILE));
    assert!(
        !argv.contains("--disable-autoexec"),
        "the person's own setting decides"
    );
    // The script Blender runs is this build's.
    let boot = std::fs::read_to_string(editor.channel.join(BOOT_FILE)).unwrap();
    assert_eq!(boot, crate::blender::BOOT_SCRIPT);
    assert!(
        editor.channel.starts_with(&w.scratch),
        "nothing is written beside the file"
    );
}

#[test]
fn an_open_file_is_locked_with_blender_s_process() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    let held = lock::live(&w.root, "props/bed.blend").expect("a lock");
    assert_eq!(held.pid, editor.child.lock_or_panic().id());
    assert_eq!(held.cluster.as_deref(), Some("c1"));
    let state = w.call("blender-viewer/editor-state", json!({})).unwrap();
    assert_eq!(state["editor"]["file"], "props/bed.blend");
    assert_eq!(state["editor"]["lock"]["file"], "props/bed.blend");
    assert_eq!(state["editor"]["booted"], false);
    assert!(state["editor"]["why"].is_string());
}

#[test]
fn closing_blender_removes_the_lock() {
    // §13 test 12's second half: Blender exits, and with no pane polling the
    // watcher still takes the lock away.
    let w = World::new();
    let editor = w.open("props/bed.blend");
    assert!(lock::live(&w.root, "props/bed.blend").is_some());
    editor.end_for_test();
    until("the lock to go", || {
        !lock::lock_path(&w.root, "props/bed.blend")
            .unwrap()
            .exists()
    });
    let state = w.call("blender-viewer/editor-state", json!({})).unwrap();
    assert!(state["editor"].is_null());
    assert_eq!(state["ended"]["file"], "props/bed.blend");
}

#[test]
fn opening_another_file_in_blender_moves_the_lock() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    report(
        &editor,
        &w.root.join("props/lamp.blend").display().to_string(),
        false,
    );
    until("the lock to move", || {
        lock::live(&w.root, "props/lamp.blend").is_some()
            && lock::live(&w.root, "props/bed.blend").is_none()
    });
    assert_eq!(editor.file().as_deref(), Some("props/lamp.blend"));
}

#[test]
fn an_unsaved_new_file_holds_no_lock() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    report(&editor, "", true);
    until("the lock to go", || {
        lock::live(&w.root, "props/bed.blend").is_none()
    });
    assert_eq!(editor.file(), None);
    assert!(editor.lock().is_none());
}

#[test]
fn a_file_another_blender_holds_is_reported_and_its_lock_left_alone() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    // Another Blender, here this test's own process, has lamp.blend.
    let theirs =
        lock::acquire(&w.root, "props/lamp.blend", std::process::id(), None, None).unwrap();
    report(
        &editor,
        &w.root.join("props/lamp.blend").display().to_string(),
        false,
    );
    until("the conflict", || {
        editor.conflict.lock_or_panic().as_deref() == Some("props/lamp.blend")
    });
    let held = lock::live(&w.root, "props/lamp.blend").unwrap();
    assert_eq!(held.pid, theirs.pid, "not taken over");
    assert!(
        lock::live(&w.root, "props/bed.blend").is_none(),
        "bed.blend is no longer open"
    );
    let state = w.call("blender-viewer/editor-state", json!({})).unwrap();
    assert_eq!(state["editor"]["conflict"], "props/lamp.blend");
}

#[test]
fn a_file_open_in_another_blender_is_not_opened_again() {
    let w = World::new();
    lock::acquire(&w.root, "props/bed.blend", std::process::id(), None, None).unwrap();
    let err = w
        .call(
            "blender-viewer/editor-open",
            json!({ "blend": "props/bed.blend" }),
        )
        .unwrap_err();
    assert!(
        err.message.contains("already open in another Blender"),
        "{}",
        err.message
    );
    assert!(w.editors.get("c1").is_none(), "nothing started");
}

#[test]
fn opening_the_same_file_again_answers_the_running_blender() {
    let w = World::new();
    let first = w.open("props/bed.blend");
    let again = w.open("props/bed.blend");
    assert!(Arc::ptr_eq(&first, &again));
    let other = w
        .call(
            "blender-viewer/editor-open",
            json!({ "blend": "props/lamp.blend" }),
        )
        .unwrap_err();
    assert!(
        other.message.contains("Close it before opening"),
        "{}",
        other.message
    );
}

#[test]
fn blender_is_not_started_on_main_or_outside_the_environment() {
    let w = World::new();
    let err = w
        .with(true, |ctx| {
            call(
                ctx,
                "blender-viewer/editor-open",
                Some(&json!({ "blend": "props/bed.blend" })),
            )
        })
        .unwrap()
        .unwrap_err();
    assert_eq!(err.code, crate::apps::READ_ONLY);
    let outside = w
        .call(
            "blender-viewer/editor-open",
            json!({ "blend": "../elsewhere.blend" }),
        )
        .unwrap_err();
    assert_eq!(outside.code, INVALID_PARAMS);
}

#[test]
fn close_asks_blender_to_quit_and_never_kills_it() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    // No window (this platform places none) and no boot script yet: there is
    // nothing to ask, and Blender is left running rather than ended.
    let err = w
        .call("blender-viewer/editor-close", json!({}))
        .unwrap_err();
    assert!(
        err.message.contains("Close it from Blender"),
        "{}",
        err.message
    );
    assert!(editor.is_running());

    boot(&editor);
    let stop = responder(editor.channel.clone(), |_, cmd| {
        assert_eq!(cmd["action"], "quit");
        json!({ "ok": true, "quitting": true })
    });
    let closing = w.call("blender-viewer/editor-close", json!({})).unwrap();
    stop.store(true, Ordering::SeqCst);
    assert_eq!(closing["via"], "blender");
    assert!(
        editor.is_running(),
        "Blender decides; it may ask to save first"
    );
}

#[test]
fn commands_wait_for_the_boot_script_and_carry_its_answer() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    let early = w
        .call(
            "blender-viewer/editor-select",
            json!({ "names": ["Frame"] }),
        )
        .unwrap_err();
    assert!(
        early.message.contains("has not started"),
        "{}",
        early.message
    );

    boot(&editor);
    let booted = w.call("blender-viewer/editor-state", json!({})).unwrap();
    assert_eq!(booted["editor"]["booted"], true);
    assert_eq!(
        booted["editor"]["script"], 1,
        "the footer names the script's version"
    );
    assert_eq!(booted["editor"]["why"], Value::Null);
    let stop = responder(editor.channel.clone(), |_, cmd| {
        match cmd["action"].as_str() {
            Some("select") => {
                json!({ "ok": true, "selected": [{ "name": "Frame", "type": "MESH" }], "active": "Frame" })
            }
            Some("viewport-only") => json!({ "ok": true, "fullscreen": cmd["on"] }),
            Some("pick") => {
                json!({ "ok": true, "hit": { "object": "Frame", "worldPoint": [0, 0, 1] } })
            }
            _ => json!({ "ok": false, "error": "unknown action" }),
        }
    });
    let selected = w
        .call(
            "blender-viewer/editor-select",
            json!({ "names": ["Frame"] }),
        )
        .unwrap();
    assert_eq!(selected["active"], "Frame");
    let full = w
        .call("blender-viewer/editor-viewport-only", json!({ "on": true }))
        .unwrap();
    assert_eq!(full["viewportOnly"], true);
    let hit = w
        .call("blender-viewer/editor-pick", json!({ "x": 10, "y": 20 }))
        .unwrap();
    assert_eq!(hit["hit"]["object"], "Frame");
    stop.store(true, Ordering::SeqCst);
}

#[test]
fn a_capture_hands_back_the_picture_once_and_removes_it() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    boot(&editor);
    let dir = editor.channel.clone();
    let stop = responder(dir.clone(), |channel, cmd| {
        let name = format!("cap-{}.png", cmd["id"]);
        std::fs::write(channel.join(&name), b"\x89PNG").unwrap();
        json!({ "ok": true, "png": name, "width": 640, "height": 360,
                "view": { "matrix": [[1, 0, 0, 0]] }, "selected": [] })
    });
    let shot = w.call("blender-viewer/editor-capture", json!({})).unwrap();
    stop.store(true, Ordering::SeqCst);
    assert_eq!(shot["pngBase64"], BASE64.encode(b"\x89PNG"));
    assert_eq!(shot["width"], 640);
    assert_eq!(shot["file"], "props/bed.blend");
    assert!(shot.get("png").is_none() && shot.get("id").is_none());
    let left: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("cap-") || n.starts_with("res-"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn a_reply_cannot_name_a_picture_outside_the_channel() {
    let dir = TempDir::new().unwrap();
    let reply = json!({ "png": "../secret.png" });
    assert_eq!(picture(dir.path(), &reply), Ok(None));
}

#[test]
fn unsaved_changes_are_read_from_the_blender_that_has_the_file() {
    let w = World::new();
    let editor = w.open("props/bed.blend");
    assert_eq!(
        w.editors.dirty(&w.root, "props/bed.blend"),
        None,
        "not said yet"
    );
    report(
        &editor,
        &w.root.join("props/bed.blend").display().to_string(),
        true,
    );
    assert_eq!(w.editors.dirty(&w.root, "props/bed.blend"), Some(true));
    assert_eq!(w.editors.dirty(&w.root, "props/lamp.blend"), None);
}
