use super::super::detect::{self, Probe};
use super::super::testing::fake_godot;
use super::super::Godot;
use super::*;
use crate::embed::host::Hosts;
use crate::environments::Environment;
use std::sync::atomic::{AtomicBool, Ordering};
use tempfile::TempDir;

struct World {
    dir: TempDir,
    root: PathBuf,
    godot: Godot,
    hosts: Hosts,
    exe: PathBuf,
}

fn world_with(hosts: Hosts) -> World {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("env");
    std::fs::create_dir_all(root.join("game")).unwrap();
    std::fs::write(
        root.join("game/project.godot"),
        "config_version=5\n\n[application]\n\nconfig/name=\"Game\"\n",
    )
    .unwrap();
    let exe = fake_godot(dir.path(), true);
    World {
        dir,
        root,
        godot: Godot::default(),
        hosts,
        exe,
    }
}

fn world() -> World {
    world_with(Hosts::with(embed::native(), false, false))
}

fn ctx<'a>(w: &'a World, key: &str) -> Ctx<'a> {
    Ctx {
        godot: &w.godot,
        key: key.to_string(),
        root: Some(w.root.clone()),
        environment: None,
        project_root: Some(w.root.clone()),
        read_only: false,
        probe: Probe {
            setting: w.exe.display().to_string(),
            ..Probe::default()
        },
        check: &|p| detect::ask_version(p, Duration::from_secs(10)),
        cache_root: w.dir.path().join("appdata"),
        scratch: w.dir.path().join("scratch"),
        owner: Arc::new(|_| None),
        allow_asset: &|_| {},
        reveal: &|_| Ok(()),
        hosts: &w.hosts,
        instance: Some("godot-1".into()),
        shown: &|_| true,
        usage: Arc::new(|_, _| {}),
        agent: &|| true,
    }
}

fn call(c: &Ctx, method: &str, params: Value) -> Result<Value, RpcError> {
    super::call(c, method, Some(&params)).expect("an editor method")
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

/// Answers on `dir` as the plugin would, from `answer`, until the flag is set.
fn plugin_on(dir: PathBuf, answer: fn(&Value) -> Value) -> Arc<AtomicBool> {
    std::fs::write(dir.join("hello.json"), r#"{"version":1}"#).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    std::thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            if let Ok(text) = std::fs::read_to_string(dir.join("cmd.json")) {
                let _ = std::fs::remove_file(dir.join("cmd.json"));
                let cmd: Value = serde_json::from_str(&text).unwrap();
                let mut reply = answer(&cmd);
                if reply["png"].is_string() {
                    std::fs::write(dir.join("cap.png"), b"PNG").unwrap();
                }
                reply["id"] = cmd["id"].clone();
                let id = cmd["id"].as_u64().unwrap();
                std::fs::write(dir.join(format!("res-{id}.json")), reply.to_string()).unwrap();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    stop
}

fn answer(cmd: &Value) -> Value {
    match cmd["action"].as_str().unwrap() {
        "selection" => json!({
            "ok": true,
            "png": "cap.png",
            "width": 640,
            "height": 360,
            "scene": "res://main.tscn",
            "selected": [{ "path": "World/Enemy", "type": "CharacterBody3D", "script": "" }],
            "camera": { "pos": [0, 2, 5] },
        }),
        "pick" => json!({
            "ok": true,
            "hit": { "nodePath": "World/Enemy", "worldPoint": [cmd["x"], cmd["y"], 0], "source": "editor" },
        }),
        "select" => json!({ "ok": false, "error": "no such node in the open scene" }),
        _ => json!({ "ok": true }),
    }
}

fn channel(w: &World) -> PathBuf {
    w.godot.editors.get("c1").unwrap().channel.clone()
}

fn end(w: &World) {
    w.godot.editors.get("c1").unwrap().end_for_test();
}

#[test]
fn the_editor_launches_in_one_window_at_the_pane_with_its_channel() {
    let at = LaunchRect {
        width: 960,
        height: 540,
        position: Some((110, -20)),
    };
    assert_eq!(
        launch_args(
            Path::new("/p"),
            Some(at),
            Some(0x3213f2),
            None,
            Path::new("/tmp/e")
        ),
        vec![
            "--editor",
            "--single-window",
            "--path",
            "/p",
            "--windowed",
            "--resolution",
            "960x540",
            "--position",
            "110,-20",
            "--wid",
            "3281906",
            "--",
            "--veistra-editor-dir=/tmp/e",
        ]
    );
    let centred = launch_args(Path::new("/p"), None, None, None, Path::new("/tmp/e"));
    assert_eq!(centred[3..], ["/p", "--", "--veistra-editor-dir=/tmp/e"]);
    // A scene opened from the Explorer is the editor's own argument, before `--`.
    let on_scene = launch_args(
        Path::new("/p"),
        None,
        None,
        Some("res://levels/a.tscn"),
        Path::new("/tmp/e"),
    );
    assert_eq!(
        on_scene[3..],
        [
            "/p",
            "res://levels/a.tscn",
            "--",
            "--veistra-editor-dir=/tmp/e"
        ]
    );
}

/// `--wid` makes the window Veistra's from its first frame, with no frame or
/// taskbar button of its own, so it is only for a window that will be placed.
#[test]
fn the_editor_is_started_owned_by_veistra_only_when_it_will_be_placed() {
    let veistra = Owner {
        hwnd: 0x3213f2,
        origin: (285, 135),
        scale: 1.5,
    };
    let over = LaunchRect {
        width: 1156,
        height: 1116,
        position: Some((285, 189)),
    };
    let nowhere = LaunchRect {
        position: None,
        ..over
    };
    let ask = |at, owner, places, version| wid_for(Some(at), owner, places, version);
    assert_eq!(ask(over, Some(&veistra), true, (4, 7)), Some(0x3213f2));
    assert_eq!(ask(over, Some(&veistra), true, (5, 0)), Some(0x3213f2));
    assert_eq!(
        ask(over, Some(&veistra), true, (4, 3)),
        None,
        "4.3 has no --wid"
    );
    assert_eq!(
        ask(over, Some(&veistra), false, (4, 7)),
        None,
        "VEISTRA_EMBED=off"
    );
    assert_eq!(
        ask(nowhere, Some(&veistra), true, (4, 7)),
        None,
        "no pane on screen"
    );
    assert_eq!(ask(over, None, true, (4, 7)), None);
    assert_eq!(wid_for(None, Some(&veistra), true, (4, 7)), None);
}

#[test]
fn a_restart_is_the_old_editor_s_newest_recent_child_and_never_its_game() {
    let proc = |pid, parent, started| Proc {
        pid,
        parent: Some(parent),
        started,
    };
    let procs = [
        proc(20, 10, 100), // the game it ran a while ago
        proc(30, 10, 205),
        proc(40, 99, 210), // someone else's
    ];
    assert_eq!(restarted(10, 200, &procs).map(|p| p.pid), Some(30));
    assert_eq!(restarted(10, 206, &procs).map(|p| p.pid), None);
    assert_eq!(restarted(11, 0, &procs).map(|p| p.pid), None);
}

#[test]
fn opening_is_refused_on_main_and_for_a_project_another_cluster_holds() {
    let w = world();
    let main = Ctx {
        environment: Some(Environment::Main),
        read_only: true,
        ..ctx(&w, "c1")
    };
    let err = call(&main, "godot/editor-open", json!({})).unwrap_err();
    assert_eq!(err.code, READ_ONLY);

    let c = ctx(&w, "c1");
    for bad in ["levels/a.tscn", "res://../a.tscn", "res://a.gd"] {
        let err = call(&c, "godot/editor-open", json!({ "scene": bad })).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS, "{bad}");
    }
    let opened = call(&c, "godot/editor-open", json!({})).unwrap();
    assert_eq!(opened["editor"]["project"], "game");
    assert_eq!(opened["agent"], true);
    assert_eq!(
        call(&c, "godot/editor-open", json!({})).unwrap()["editor"]["pid"],
        opened["editor"]["pid"],
        "asking again shows the same editor"
    );
    let other = ctx(&w, "c2");
    let err = call(&other, "godot/editor-open", json!({})).unwrap_err();
    assert!(err.message.contains("another cluster"), "{err:?}");
    end(&w);
}

#[test]
fn off_windows_the_editor_keeps_its_own_window_and_says_why() {
    let w = world();
    let c = ctx(&w, "c1");
    call(&c, "godot/editor-open", json!({})).unwrap();
    let state = call(&c, "godot/editor-state", json!({})).unwrap();
    assert_eq!(state["editor"]["embed"]["state"]["kind"], "ownWindow");
    assert_eq!(state["editor"]["embed"]["state"]["cause"], "unsupported");
    assert_eq!(state["editor"]["plugin"]["installed"], "no");
    assert_eq!(state["editor"]["plugin"]["running"], false);
    let why = state["editor"]["plugin"]["why"].as_str().unwrap();
    assert!(why.contains("enable the plugin here"), "{why}");
    end(&w);
}

#[test]
fn nothing_writes_the_project_file_while_its_editor_runs() {
    let w = world();
    let c = ctx(&w, "c1");
    call(&c, "godot/editor-open", json!({})).unwrap();
    let before = std::fs::read_to_string(w.root.join("game/project.godot")).unwrap();
    for method in ["godot/plugin-install", "godot/plugin-remove"] {
        let err = call(&c, method, json!({})).unwrap_err();
        assert_eq!(err.message, CLOSE_FIRST, "{method}");
    }
    let err = rpc::play(&c, "play/addon-install", None)
        .unwrap()
        .unwrap_err();
    assert_eq!(err.message, CLOSE_FIRST);
    let err = rpc::common(&c, "godot/open-editor", None)
        .unwrap()
        .unwrap_err();
    assert!(err.message.contains("already open"), "{err:?}");
    let after = std::fs::read_to_string(w.root.join("game/project.godot")).unwrap();
    assert_eq!(before, after);
    end(&w);

    let installed = call(&c, "godot/plugin-install", json!({})).unwrap();
    assert_eq!(installed["plugin"], "yes", "{installed}");
    assert!(w.root.join("game/addons/veistra/plugin.cfg").is_file());
}

#[test]
fn without_the_plugin_each_command_says_what_to_do() {
    let w = world();
    let c = ctx(&w, "c1");
    call(&c, "godot/editor-open", json!({})).unwrap();
    let err = call(&c, "godot/editor-selection", json!({})).unwrap_err();
    assert!(err.message.contains("enable the plugin here"), "{err:?}");
    let err = call(&c, "godot/editor-close", json!({})).unwrap_err();
    assert!(err.message.contains("Close it from Godot"), "{err:?}");
    end(&w);
}

#[test]
fn send_selection_brings_the_nodes_and_the_viewport_in_one_answer() {
    let w = world();
    let c = ctx(&w, "c1");
    call(&c, "godot/editor-open", json!({})).unwrap();
    let stop = plugin_on(channel(&w), answer);
    let state = call(&c, "godot/editor-state", json!({})).unwrap();
    let plugin = &state["editor"]["plugin"];
    assert_eq!(
        (&plugin["running"], &plugin["why"]),
        (&json!(true), &Value::Null)
    );
    let sent = std::time::Instant::now();
    let got = call(&c, "godot/editor-selection", json!({})).unwrap();
    assert!(sent.elapsed() < Duration::from_secs(1), "spec §13 test 11");
    assert_eq!(got["selected"][0]["path"], "World/Enemy");
    assert_eq!(got["pngBase64"], BASE64.encode(b"PNG"));
    assert_eq!(got["width"], 640);
    assert!(got.get("png").is_none() && got.get("id").is_none());
    assert!(
        !channel(&w).join("cap.png").exists(),
        "a sent picture is not kept"
    );

    let hit = call(&c, "godot/editor-pick", json!({ "x": 3.0, "y": 4.0 })).unwrap();
    assert_eq!(hit["hit"]["source"], "editor");
    assert_eq!(hit["hit"]["worldPoint"], json!([3.0, 4.0, 0]));
    let err = call(&c, "godot/editor-select", json!({ "paths": ["Nope"] })).unwrap_err();
    assert!(err.message.contains("no such node"), "{err:?}");
    let err = call(&c, "godot/editor-open-scene", json!({ "scene": "../x" })).unwrap_err();
    assert_eq!(err.code, INVALID_PARAMS);
    // A chip clicked in the agent tab: a script opens in its editor.
    assert_eq!(
        call(&c, "godot/editor-edit", json!({ "path": "res://enemy.gd" })).unwrap(),
        json!({ "path": "res://enemy.gd" })
    );
    for bad in [
        "C:/Windows/win.ini",
        "res://../secret.gd",
        "res://",
        "res://levels/",
    ] {
        let err = call(&c, "godot/editor-edit", json!({ "path": bad })).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS, "{bad}");
    }
    assert_eq!(
        call(&c, "godot/editor-viewport-only", json!({ "on": false })).unwrap(),
        json!({ "viewportOnly": false })
    );

    let closing = call(&c, "godot/editor-close", json!({})).unwrap();
    assert_eq!(closing["via"], "plugin", "no window to post to here");
    stop.store(true, Ordering::SeqCst);
    end(&w);
    let state = call(&c, "godot/editor-state", json!({})).unwrap();
    assert_eq!(state["editor"], Value::Null);
    assert_eq!(state["ended"]["project"], "game");
    assert!(w.godot.editors.get("c1").is_none());
}

#[test]
fn close_asks_the_window_as_its_close_button_would_and_kills_nothing() {
    let fake = Arc::new(crate::embed::tests::Fake::finding_after(0));
    let w = world_with(Hosts::with(fake.clone(), true, false));
    let c = ctx(&w, "c1");
    call(&c, "godot/editor-open", json!({})).unwrap();
    let editor = w.godot.editors.get("c1").unwrap();
    wait_until("the window", || editor.embed.hwnd().is_some());
    let closing = call(&c, "godot/editor-close", json!({})).unwrap();
    assert_eq!(closing["via"], "window");
    assert_eq!(*fake.closes.lock_or_panic(), vec![7]);
    assert!(editor.is_running(), "asked, not ended: Godot decides");
    end(&w);
}

#[test]
fn an_open_is_counted_once_with_whether_the_plugin_is_enabled() {
    let w = world();
    let seen: Arc<Mutex<Vec<(&'static str, Value)>>> = Arc::default();
    let log = seen.clone();
    let mut c = ctx(&w, "c1");
    c.usage = Arc::new(move |event, props| log.lock().unwrap().push((event, props)));
    call(&c, "godot/editor-open", json!({})).unwrap();
    // A second press while it runs answers the open editor and counts nothing.
    call(&c, "godot/editor-open", json!({})).unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![("editor_opened", json!({ "plugin": false }))]
    );
    end(&w);
}

#[test]
fn the_dock_gets_its_notes_and_its_ask_reaches_the_pane_once_with_the_picture() {
    use crate::comments::{self, Anchor, Draft};
    let w = world();
    let c = ctx(&w, "c1");
    call(&c, "godot/editor-open", json!({})).unwrap();
    let dir = channel(&w);
    let made = comments::create(
        &call_context(&c),
        Draft {
            anchor: Anchor::Node {
                path: "Hallway/Enemy_02".into(),
                scene: Some("res://levels/hallway.tscn".into()),
            },
            body: "floats".into(),
            screenshot_png: None,
        },
    )
    .unwrap();

    // The first poll writes the note where the dock reads it.
    let state = call(&c, "godot/editor-state", json!({})).unwrap();
    assert_eq!(state["editor"]["events"], json!([]));
    let notes: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("notes.json")).unwrap()).unwrap();
    assert_eq!(notes["notes"][0]["id"], made.id.as_str());
    assert_eq!(notes["notes"][0]["path"], "Hallway/Enemy_02");

    // Ask the agent from the dock: the picture first, then the line.
    std::fs::write(dir.join("ask-5.png"), b"PNG").unwrap();
    std::fs::write(
        dir.join("events.jsonl"),
        "{\"n\":5,\"kind\":\"ask\",\"text\":\"why does it float?\",\"scene\":\"res://levels/hallway.tscn\",\"nodes\":[\"Hallway/Enemy_02\"],\"png\":\"ask-5.png\"}\n",
    )
    .unwrap();
    let state = call(&c, "godot/editor-state", json!({ "eventsSince": 0 })).unwrap();
    let events = state["editor"]["events"].as_array().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["nodes"][0], "Hallway/Enemy_02");
    assert_eq!(events[0]["pngBase64"], BASE64.encode(b"PNG"));
    let seq = events[0]["seq"].as_u64().unwrap();
    let again = call(&c, "godot/editor-state", json!({ "eventsSince": seq })).unwrap();
    assert_eq!(again["editor"]["events"], json!([]), "acted on once");

    // The pane's answer is in notes.json for the dock's status line.
    let err = call(&c, "godot/editor-ack", json!({})).unwrap_err();
    assert_eq!(err.code, INVALID_PARAMS);
    call(
        &c,
        "godot/editor-ack",
        json!({ "n": 5, "ok": true, "message": "Sent to the agent" }),
    )
    .unwrap();
    let notes: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("notes.json")).unwrap()).unwrap();
    assert_eq!(
        notes["acks"],
        json!([{ "n": 5, "ok": true, "message": "Sent to the agent" }])
    );
    assert!(
        !dir.join("ask-5.png").exists(),
        "an answered ask's picture goes"
    );
    end(&w);
    let err = call(&c, "godot/editor-ack", json!({ "n": 6 })).unwrap_err();
    assert!(err.message.contains("no Godot editor"), "{err:?}");
}
