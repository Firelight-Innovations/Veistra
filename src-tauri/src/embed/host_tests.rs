use super::*;
use crate::embed::tests::{owner, rect, wait_for, Fake};
use crate::layout::PaneNode;
use crate::shell_state::{Cluster, SurfaceInstance, SurfaceKind, WindowPlacement};
use std::sync::atomic::{AtomicBool, AtomicUsize};

fn leaf(id: &str, tabs: &[&str], active: &str) -> PaneNode {
    PaneNode::Leaf {
        id: id.to_string(),
        tabs: tabs.iter().map(|t| t.to_string()).collect(),
        active_tab: Some(active.to_string()),
    }
}

fn cluster(id: &str, tree: PaneNode) -> Cluster {
    Cluster {
        id: id.to_string(),
        name: id.to_string(),
        tree,
        project: None,
        worktree: None,
        active_terminal: None,
        band_height: None,
        page: None,
        environment: None,
        pinned: false,
        icon: None,
        environment_missing: false,
    }
}

/// Cluster `c1` with Play and Files in one pane (`active` the active tab),
/// and `c2` with a Godot pane, a Blender pane and a second Play pane; the
/// window shows `on`.
fn snapshot(on: &str, active: &str) -> ShellSnapshot {
    let instance = |id: &str, app: &str| SurfaceInstance {
        id: id.to_string(),
        app_id: app.to_string(),
        kind: SurfaceKind::App,
        title: app.to_string(),
    };
    let c2 = PaneNode::Split {
        id: "c2-split".into(),
        dir: crate::layout::SplitDir::Row,
        sizes: vec![0.5, 0.5],
        children: vec![
            leaf("c2-a", &["godot-1", "play-2"], "godot-1"),
            leaf("c2-b", &["blender-1"], "blender-1"),
        ],
    };
    ShellSnapshot {
        windows: vec![WindowPlacement {
            label: "main".into(),
            clusters: vec![
                cluster("c1", leaf("c1-pane", &["play-1", "files-1"], active)),
                cluster("c2", c2),
            ],
            active_cluster_id: Some(on.to_string()),
            geometry: None,
            right_page: None,
        }],
        instances: vec![
            instance("play-1", "play"),
            instance("files-1", "files"),
            instance("godot-1", "godot-viewer"),
            instance("play-2", "play"),
            instance("blender-1", "blender-viewer"),
        ],
        terminals: Vec::new(),
    }
}

fn without(mut s: ShellSnapshot, instance: &str) -> ShellSnapshot {
    s.instances.retain(|i| i.id != instance);
    s
}

fn owners() -> OwnerFn {
    Arc::new(|label| {
        Some(Owner {
            hwnd: if label == Some("w2") { 2 } else { 1 },
            ..owner(1.0)
        })
    })
}

fn hosts(fake: &Arc<Fake>) -> Hosts {
    Hosts::with(fake.clone(), true, false)
}

fn spec(hosts: &Hosts, instance: Option<&str>, kind: Kind, orphan: Orphan) -> HostSpec {
    HostSpec {
        instance: instance.map(str::to_string),
        cluster: "c1".into(),
        embed: hosts.embed(kind),
        pids: Box::new(|| vec![1]),
        alive: Arc::new(|| true),
        on_attached: None,
        on_orphan: orphan,
    }
}

fn boxed(hosts: &Hosts, instance: &str, kind: Kind) {
    let pane = Last {
        rect: rect(10.0, 640.0),
        visible: true,
        dpr: None,
    };
    hosts.report_box(
        &Slot::new(instance, kind),
        pane,
        Some("main".into()),
        &owners(),
    );
}

fn state_of(h: &Hosted) -> State {
    h.embed.state()
}

#[test]
fn a_window_shows_only_with_its_cluster_on_screen_and_its_pane_the_active_tab() {
    assert!(shown(&snapshot("c1", "play-1"), "play-1"));
    assert!(!shown(&snapshot("c1", "files-1"), "play-1"), "another tab");
    assert!(
        !shown(&snapshot("c2", "play-1"), "play-1"),
        "another cluster"
    );
    assert!(
        !shown(&snapshot("c1", "play-1"), "nope"),
        "no such instance"
    );
    let s = snapshot("c2", "play-1");
    assert!(
        shown(&s, "godot-1") && shown(&s, "blender-1"),
        "two panes, both on screen"
    );
    assert!(!shown(&s, "play-2"), "behind the Godot tab in its pane");
}

#[test]
fn a_call_with_no_pane_stands_for_the_cluster_s_play_pane_on_screen_first() {
    let s = snapshot("c2", "play-1");
    let apps =
        |ids: &'static [&'static str]| move |i: &SurfaceInstance| ids.contains(&i.app_id.as_str());
    let game = apps(&["play", "godot-viewer"]);
    assert_eq!(instance_for(&s, "c2", &game).as_deref(), Some("godot-1"));
    assert_eq!(
        instance_for(&s, "c2", &apps(&["play"])).as_deref(),
        Some("play-2")
    );
    assert_eq!(instance_for(&s, "c1", &game).as_deref(), Some("play-1"));
    assert_eq!(instance_for(&s, "c1", &apps(&["blender-viewer"])), None);
    assert_eq!(instance_for(&s, "c9", &game), None);
}

#[test]
fn a_window_started_while_its_pane_is_hidden_is_placed_hidden() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    boxed(&hosts, "play-1", Kind::Game);
    let shown_now = shown(&snapshot("c1", "files-1"), "play-1");
    let h = hosts.host(
        owners(),
        shown_now,
        spec(&hosts, Some("play-1"), Kind::Game, Orphan::Release),
    );
    wait_for("the placement", || {
        !crate::embed::tests::placed(&fake).is_empty()
    });
    let first = crate::embed::tests::placed(&fake)[0];
    assert!(
        !first.visible,
        "an agent's run behind another tab stays hidden"
    );
    assert_eq!(first.at.w, 640, "but sized to the pane");
    hosts.sync_visibility(&snapshot("c1", "play-1"), &owners());
    wait_for("the show", || crate::embed::tests::placed(&fake).len() == 2);
    assert!(crate::embed::tests::placed(&fake)[1].visible);
    assert_eq!(state_of(&h), State::Embedded);
}

#[test]
fn closing_an_editor_s_pane_hands_the_editor_back_and_closing_play_s_stops_the_game() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    boxed(&hosts, "blender-1", Kind::Blender);
    let blender = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("blender-1"), Kind::Blender, Orphan::Release),
    );
    wait_for("Blender placed", || state_of(&blender) == State::Embedded);
    let stops = Arc::new(AtomicUsize::new(0));
    let counted = stops.clone();
    let stop = Orphan::Stop(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    let game = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("play-1"), Kind::Game, stop),
    );
    wait_for("the game placed", || state_of(&game) == State::Embedded);

    let closed = without(without(snapshot("c1", "play-1"), "blender-1"), "play-1");
    hosts.sync_visibility(&closed, &owners());
    hosts.sync_visibility(&closed, &owners());
    wait_for("Blender handed back", || {
        state_of(&blender) == State::PoppedOut
    });
    wait_for("the game stopped", || stops.load(Ordering::SeqCst) == 1);
    assert_eq!(
        fake.released.lock_or_panic().len(),
        1,
        "released once, never killed"
    );
    assert!(hosts.get(&Slot::new("blender-1", Kind::Blender)).is_none());
    assert_eq!(hosts.box_of(&Slot::new("blender-1", Kind::Blender)), None);
}

#[test]
fn the_game_belongs_to_the_play_pane_that_last_showed_it() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    boxed(&hosts, "play-1", Kind::Game);
    let game = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("play-1"), Kind::Game, Orphan::Release),
    );
    wait_for("placed", || state_of(&game) == State::Embedded);
    let wide = Last {
        rect: rect(300.0, 900.0),
        visible: true,
        dpr: None,
    };
    let slot = Slot::new("play-2", Kind::Game);
    hosts.report_box(&slot, wide, Some("main".into()), &owners());
    hosts.claim(&game, "play-2", true);
    assert_eq!(game.instance().as_deref(), Some("play-2"));
    assert!(hosts.get(&slot).is_some());
    assert!(hosts.get(&Slot::new("play-1", Kind::Game)).is_none());
    assert_eq!(
        game.embed.last().map(|l| l.rect.w),
        Some(900.0),
        "the new pane's box"
    );
}

#[test]
fn a_hide_without_a_window_keeps_the_window_the_pane_is_in() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    let slot = Slot::new("play-1", Kind::Game);
    let live = Last {
        rect: rect(10.0, 800.0),
        visible: true,
        dpr: Some(1.25),
    };
    hosts.report_box(&slot, live, Some("w2".into()), &owners());
    let gone = Last {
        rect: CssRect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        },
        visible: false,
        dpr: None,
    };
    let pane = hosts.report_box(&slot, gone, None, &owners());
    assert_eq!(
        pane.window.as_deref(),
        Some("w2"),
        "the hide is made in w2, not main"
    );
    assert_eq!(
        (pane.rect.w, pane.dpr, pane.visible),
        (800.0, Some(1.25), false)
    );
    let game = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("play-1"), Kind::Game, Orphan::Release),
    );
    wait_for("placed", || state_of(&game) == State::Embedded);
    assert_eq!(
        crate::embed::tests::placed(&fake)[0].owner,
        2,
        "the window waits for the game and asks where the pane is then"
    );
}

#[test]
fn an_editor_is_handed_back_at_exit_and_the_game_is_left_to_its_runner() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    let editor = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("godot-1"), Kind::GodotEditor, Orphan::Release),
    );
    let game = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("play-1"), Kind::Game, Orphan::Release),
    );
    wait_for("both placed", || {
        state_of(&editor) == State::Embedded && state_of(&game) == State::Embedded
    });
    hosts.release_all(&owners());
    assert_eq!(state_of(&editor), State::PoppedOut);
    assert_eq!(state_of(&game), State::Embedded);
}

#[test]
fn off_windows_forced_off_and_with_no_pane_the_window_keeps_its_own_and_says_why() {
    let fake = Arc::new(Fake::default());
    let unsupported = Hosts::with(fake.clone(), false, false);
    let attached = Arc::new(Mutex::new(Vec::new()));
    let log = attached.clone();
    let mut s = spec(&unsupported, Some("play-1"), Kind::Game, Orphan::Release);
    s.on_attached = Some(Box::new(move |hwnd| log.lock_or_panic().push(hwnd)));
    let h = unsupported.host(owners(), true, s);
    let cause = |h: &Hosted| match state_of(h) {
        State::OwnWindow { cause, .. } => Some(cause),
        _ => None,
    };
    assert_eq!(cause(&h), Some(Cause::Unsupported));
    assert_eq!(
        attached.lock_or_panic().clone(),
        vec![None],
        "told at once, nothing looked for"
    );

    let forced = Hosts::with(fake.clone(), true, true);
    let h = forced.host(
        owners(),
        true,
        spec(&forced, Some("play-1"), Kind::Game, Orphan::Release),
    );
    wait_for("forced", || cause(&h) == Some(Cause::Forced));
    let none = hosts(&fake);
    let h = none.host(
        owners(),
        false,
        spec(&none, None, Kind::Game, Orphan::Release),
    );
    wait_for("no pane", || cause(&h) == Some(Cause::NoPane));
    assert!(!h.embed.shown());
}

#[test]
fn embed_methods_place_an_editor_for_its_pane_and_leave_the_game_to_play() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    let o = owners();
    let rect = json!({ "kind": "blender", "x": 10, "y": 20, "w": 800, "h": 400, "visible": true, "window": "main", "dpr": 1.0 });
    answer(&hosts, &o, Some("blender-1"), "embed/rect", Some(&rect)).unwrap();
    let pane = hosts
        .box_of(&Slot::new("blender-1", Kind::Blender))
        .unwrap();
    assert_eq!(pane.rect.w, 800.0, "kept for the launch");
    let ask = |method: &str| {
        answer(
            &hosts,
            &o,
            Some("blender-1"),
            method,
            Some(&json!({ "kind": "blender" })),
        )
    };
    assert_eq!(
        ask("embed/state").unwrap()["embed"],
        Value::Null,
        "nothing launched yet"
    );
    assert!(ask("embed/pop-out").is_err());

    let blender = hosts.host(
        o.clone(),
        true,
        spec(&hosts, Some("blender-1"), Kind::Blender, Orphan::Release),
    );
    wait_for("placed", || state_of(&blender) == State::Embedded);
    assert_eq!(ask("embed/state").unwrap()["embedded"], true);
    // A child has no still: Graphics Capture takes only top-level windows,
    // so a menu over it is cut out of it instead (below).
    assert!(ask("embed/still").is_err());
    let picker = CssRect {
        x: 100.0,
        y: 0.0,
        w: 200.0,
        h: 100.0,
    };
    hosts.set_overlays("win-2", vec![picker], &o);
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(
        fake.cuts.lock_or_panic().is_empty(),
        "another window's menu is not over it"
    );
    hosts.set_overlays("main", vec![picker], &o);
    wait_for("the hole", || !fake.cuts.lock_or_panic().is_empty());
    hosts.set_overlays("main", Vec::new(), &o);
    wait_for("the hole closed", || {
        fake.cuts
            .lock_or_panic()
            .last()
            .is_some_and(|c| c.is_empty())
    });
    assert_eq!(ask("embed/pop-out").unwrap()["embed"]["kind"], "poppedOut");
    assert_eq!(ask("embed/dock").unwrap()["embed"]["kind"], "embedded");

    let game = json!({ "kind": "game" });
    assert_eq!(
        answer(&hosts, &o, Some("play-1"), "embed/state", Some(&game))
            .unwrap_err()
            .code,
        INVALID_PARAMS
    );
    assert!(answer(
        &hosts,
        &o,
        None,
        "embed/state",
        Some(&json!({ "kind": "blender" }))
    )
    .is_err());
    let bad = json!({ "kind": "blender", "x": 0, "y": 0, "w": -1, "h": 0 });
    assert!(answer(&hosts, &o, Some("blender-1"), "embed/rect", Some(&bad)).is_err());
    assert!(is_method("embed/rect") && !is_method("play/embed-rect"));
}

#[test]
fn the_debug_report_names_each_window_s_pane_and_how_long_its_last_move_took() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    boxed(&hosts, "play-1", Kind::Game);
    let game = hosts.host(
        owners(),
        true,
        spec(&hosts, Some("play-1"), Kind::Game, Orphan::Release),
    );
    wait_for("placed", || state_of(&game) == State::Embedded);
    let report = hosts.report();
    assert_eq!(report[0]["instance"], "play-1");
    assert_eq!(report[0]["cluster"], "c1");
    assert_eq!(report[0]["state"]["kind"], "embedded");
    assert_eq!(report[0]["placed"]["at"]["w"], 640);
    assert!(report[0]["lastPlaceMs"].is_u64());
}

/// Was `Godot::live_sessions`' test: a finished game's window is gone, and
/// moving it would only fail, or with its handle reused move some other
/// program's window, on every step of a window drag.
#[test]
fn a_window_whose_process_ended_is_never_moved_again() {
    let fake = Arc::new(Fake::default());
    let hosts = hosts(&fake);
    boxed(&hosts, "play-1", Kind::Game);
    let running = Arc::new(AtomicBool::new(true));
    let alive = running.clone();
    let mut s = spec(&hosts, Some("play-1"), Kind::Game, Orphan::Release);
    s.alive = Arc::new(move || alive.load(Ordering::SeqCst));
    let game = hosts.host(owners(), true, s);
    wait_for("placed", || state_of(&game) == State::Embedded);
    running.store(false, Ordering::SeqCst);
    hosts.reposition_all(&owners());
    hosts.sync_visibility(&without(snapshot("c1", "play-1"), "play-1"), &owners());
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_eq!(
        crate::embed::tests::placed(&fake).len(),
        1,
        "only the first placement"
    );
    assert!(fake.released.lock_or_panic().is_empty(), "nor handed back");
    assert!(hosts.get(&Slot::new("play-1", Kind::Game)).is_none());
}
