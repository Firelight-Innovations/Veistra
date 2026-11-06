use super::*;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::thread::ThreadId;

pub(super) fn owner(scale: f64) -> Owner {
    Owner {
        hwnd: 1,
        origin: (100, 50),
        scale,
    }
}

pub(super) fn rect(x: f64, w: f64) -> CssRect {
    CssRect {
        x,
        y: 0.0,
        w,
        h: 100.0,
    }
}

pub(super) fn shown(rect: CssRect) -> Last {
    Last {
        rect,
        visible: true,
        dpr: None,
    }
}

struct FakeStill;

impl Still for FakeStill {
    fn png(&self) -> Option<Vec<u8>> {
        Some(b"PNG".to_vec())
    }
}

/// A window system with one window, `7`, found on the `finds_before`th look.
/// `hung` held by a test is a process that stopped pumping messages; the
/// `fail_*` flags are Windows refusing.
#[derive(Default)]
pub(crate) struct Fake {
    pub finds_before: usize,
    pub looks: AtomicUsize,
    pub hung: Mutex<()>,
    pub(super) placed: Mutex<Vec<(Placement, ThreadId)>>,
    pub fail_embed: AtomicBool,
    pub fail_place: AtomicBool,
    pub released: Mutex<Vec<Option<ScreenRect>>>,
    pub shown_near: Mutex<Vec<Option<ScreenRect>>>,
    pub kinds: Mutex<Vec<Kind>>,
    pub closes: Mutex<Vec<isize>>,
    /// The mode of every embed and placement, in order.
    pub modes: Mutex<Vec<Mode>>,
    pub discarded: AtomicUsize,
    /// Every set of holes cut in a child's clip box, in order.
    pub cuts: Mutex<Vec<Vec<ScreenRect>>>,
}

impl Fake {
    /// One whose window is found on the `looks`th look; for a test outside
    /// this module, which cannot name every field.
    pub(crate) fn finding_after(looks: usize) -> Self {
        Self {
            finds_before: looks,
            ..Self::default()
        }
    }
}

impl WindowSystem for Fake {
    fn find_window(&self, _pids: &[u32], kind: Kind) -> Option<isize> {
        self.kinds.lock_or_panic().push(kind);
        let looks = self.looks.fetch_add(1, Ordering::SeqCst);
        (looks >= self.finds_before).then_some(7)
    }
    // `Saved` is a unit struct only off Windows.
    #[allow(clippy::default_constructed_unit_structs)]
    fn embed(&self, _hwnd: isize, _owner: isize, mode: Mode) -> Result<sys::Saved, String> {
        if self.fail_embed.load(Ordering::SeqCst) {
            return Err("Access is denied.".into());
        }
        self.modes.lock_or_panic().push(mode);
        Ok(sys::Saved::default())
    }
    fn place(
        &self,
        hwnd: isize,
        at: ScreenRect,
        visible: bool,
        owner: isize,
        mode: Mode,
    ) -> Result<(), String> {
        let _hung = self.hung.lock_or_panic();
        if self.fail_place.load(Ordering::SeqCst) {
            return Err("SetWindowPos failed".into());
        }
        self.modes.lock_or_panic().push(mode);
        let p = Placement {
            hwnd,
            at,
            visible,
            owner,
            scale: 1.0,
            asked: Instant::now(),
        };
        self.placed
            .lock_or_panic()
            .push((p, std::thread::current().id()));
        Ok(())
    }
    fn release(&self, _: isize, _: &sys::Saved, near: Option<ScreenRect>) -> Result<(), String> {
        self.released.lock_or_panic().push(near);
        Ok(())
    }
    fn show_near(&self, _: isize, near: Option<ScreenRect>) -> Result<(), String> {
        self.shown_near.lock_or_panic().push(near);
        Ok(())
    }
    fn watch(&self, _hwnd: isize) -> Option<Box<dyn Still>> {
        Some(Box::new(FakeStill))
    }
    fn request_close(&self, hwnd: isize) -> Result<(), String> {
        self.closes.lock_or_panic().push(hwnd);
        Ok(())
    }
    fn discard(&self, _saved: &sys::Saved) {
        self.discarded.fetch_add(1, Ordering::SeqCst);
    }
    fn cut(&self, _hwnd: isize, holes: &[ScreenRect]) -> Result<(), String> {
        self.cuts.lock_or_panic().push(holes.to_vec());
        Ok(())
    }
}

pub(super) fn placed(fake: &Fake) -> Vec<Placement> {
    fake.placed
        .lock_or_panic()
        .iter()
        .map(|(p, _)| *p)
        .collect()
}

pub(super) fn wait_for(what: &str, done: impl Fn() -> bool) {
    for _ in 0..300 {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

fn embedded(fake: &Arc<Fake>) -> Embed {
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    let found = embed.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(found, Some(7));
    assert_eq!(embed.state(), State::Embedded);
    assert_eq!(placed(fake).len(), 1, "placed before attach returned");
    embed
}

/// The placements made on this thread, in order.
fn placed_here(fake: &Fake) -> Vec<Placement> {
    let me = std::thread::current().id();
    fake.placed
        .lock_or_panic()
        .iter()
        .filter(|(_, on)| *on == me)
        .map(|(p, _)| *p)
        .collect()
}

fn cause(embed: &Embed) -> Cause {
    match embed.state() {
        State::OwnWindow { cause, .. } => cause,
        other => panic!("not its own window: {other:?}"),
    }
}

#[test]
fn css_pixels_become_physical_pixels_from_the_client_origin() {
    let r = CssRect {
        x: 10.0,
        y: 20.0,
        w: 640.0,
        h: 360.0,
    };
    let at = |scale| to_screen(r, (100, 50), scale);
    let px = |x, y, w, h| ScreenRect { x, y, w, h };
    assert_eq!(at(1.0), px(110, 70, 640, 360));
    assert_eq!(at(1.5), px(115, 80, 960, 540));
}

#[test]
fn the_page_s_device_pixel_ratio_carries_the_zoom_the_window_scale_lacks() {
    // 125 % View zoom on a 100 % monitor: the box at CSS 400..1200 is at
    // 500..1500 on screen.
    let at = to_screen(rect(400.0, 800.0), (0, 0), scale_for(Some(1.25), 1.0));
    assert_eq!((at.x, at.w), (500, 1000));
    for useless in [
        None,
        Some(0.0),
        Some(-1.0),
        Some(f64::NAN),
        Some(f64::INFINITY),
    ] {
        assert_eq!(scale_for(useless, 1.5), 1.5, "{useless:?}");
    }
}

#[test]
fn neighbouring_boxes_still_meet_after_rounding() {
    let a = to_screen(
        CssRect {
            x: 0.3,
            y: 0.0,
            w: 100.3,
            h: 10.0,
        },
        (0, 0),
        1.25,
    );
    let b = to_screen(rect(100.6, 50.0), (0, 0), 1.25);
    assert_eq!(a.x + a.w, b.x);
}

#[test]
fn a_window_launches_at_the_pane_s_size_in_even_physical_pixels() {
    let r = CssRect {
        x: 0.0,
        y: 0.0,
        w: 641.0,
        h: 361.0,
    };
    assert_eq!(launch_size(Some(r), 1.0), (640, 360));
    assert_eq!(launch_size(Some(r), 1.5), (962, 542));
    assert_eq!(launch_size(None, 2.0), (1280, 720));
    let tiny = CssRect {
        w: 4.0,
        h: 4.0,
        ..r
    };
    assert_eq!(launch_size(Some(tiny), 1.0), (1280, 720));
}

#[test]
fn a_window_launches_where_the_pane_is_on_the_screen() {
    let pane = Last {
        rect: CssRect {
            x: 10.0,
            y: 20.0,
            w: 800.0,
            h: 400.0,
        },
        visible: true,
        dpr: Some(1.25),
    };
    let at = launch_rect(Some(pane), Some(&owner(1.0)));
    assert_eq!((at.width, at.height), (1000, 500));
    assert_eq!(
        at.position,
        Some((113, 75)),
        "the client origin plus the box"
    );
    assert_eq!(launch_rect(Some(pane), None).position, None);
    let none = launch_rect(None, Some(&owner(1.0)));
    assert_eq!((none.width, none.height, none.position), (1280, 720, None));
}

#[test]
fn the_kind_s_own_class_wins_and_consoles_and_message_boxes_never_do() {
    let c = |h: isize, class: &str| (h, class.to_string());
    let tree = [
        c(1, "ConsoleWindowClass"),
        c(2, "#32770"),
        c(3, "Splash"),
        c(4, "Engine"),
    ];
    assert_eq!(pick(&tree, Kind::Game), Some(4));
    assert_eq!(pick(&tree, Kind::GodotEditor), Some(4));
    assert_eq!(
        pick(&tree, Kind::Blender),
        Some(3),
        "no Blender class: the first usable"
    );
    let blender = [
        c(5, "CASCADIA_HOSTING_WINDOW_CLASS"),
        c(6, "GHOST_WindowClass"),
    ];
    assert_eq!(pick(&blender, Kind::Blender), Some(6));
    assert_eq!(
        pick(&tree[..2], Kind::Game),
        None,
        "a console is never placed"
    );
}

#[test]
fn an_editor_is_looked_for_longer_than_the_game() {
    assert_eq!(Kind::Game.find_for(), Duration::from_secs(10));
    assert!(Kind::GodotEditor.find_for() > Kind::Game.find_for());
    assert_eq!(Kind::Blender.find_for(), Kind::GodotEditor.find_for());
}

#[test]
fn every_reason_but_an_early_exit_starts_with_the_own_window_line() {
    for cause in [
        Cause::Unsupported,
        Cause::Forced,
        Cause::NoPane,
        Cause::NoWindow,
        Cause::NoOwner,
        Cause::Refused,
        Cause::PlaceFailed,
    ] {
        assert!(
            reason(Kind::Game, cause).starts_with("Playing in its own window"),
            "{cause:?}"
        );
        assert!(reason(Kind::Blender, cause).starts_with("Open in its own window"));
    }
    assert_eq!(
        reason(Kind::Game, Cause::Exited),
        "The game closed before it showed a window."
    );
    assert!(reason(Kind::Game, Cause::NoWindow).contains("10 s"));
}

#[test]
fn with_no_window_found_the_game_keeps_its_own_and_the_strip_says_why() {
    let embed = Embed::default();
    assert_eq!(embed.state(), State::Waiting);
    let found = embed.attach(None, &Vec::new, &|| Some(owner(1.0)), &|| false);
    assert_eq!(found, None);
    assert_eq!(cause(&embed), Cause::Exited);
    assert!(embed.pop_out(None).is_err(), "nothing to pop out");
}

#[test]
fn the_newest_box_is_kept_before_the_window_exists() {
    let embed = Embed::default();
    let r = rect(1.0, 3.0);
    embed.set_rect(shown(r), None);
    assert_eq!(embed.last().map(|l| l.rect), Some(r));
    embed.reapply(&owner(1.0));
    assert_eq!(
        embed.state(),
        State::Waiting,
        "nothing is moved before it is embedded"
    );
}

#[test]
fn a_hide_with_an_empty_box_keeps_the_last_real_box() {
    let fake = Arc::new(Fake::default());
    let embed = embedded(&fake);
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
    embed.set_rect(gone, Some(&owner(1.0)));
    assert_eq!(embed.last().map(|l| l.rect), Some(rect(10.0, 640.0)));
    wait_for("the hide", || placed(&fake).len() == 2);
    let hide = placed(&fake)[1];
    assert!(!hide.visible);
    assert_eq!(hide.at.w, 640, "hidden where it was, not at 0 x 0");
}

#[test]
fn a_hung_game_never_blocks_the_caller_and_only_the_newest_placement_is_made() {
    let fake = Arc::new(Fake::default());
    let embed = Arc::new(embedded(&fake));
    let hung = fake.hung.lock_or_panic();
    let (tx, rx) = std::sync::mpsc::channel();
    let caller = {
        let embed = embed.clone();
        std::thread::spawn(move || {
            for x in [20.0, 30.0, 40.0] {
                embed.set_rect(shown(rect(x, 640.0)), Some(&owner(1.0)));
            }
            tx.send(std::thread::current().id()).unwrap();
        })
    };
    let caller_id = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the window moves returned while the game was hung");
    drop(hung);
    caller.join().unwrap();
    wait_for("the newest box", || {
        placed(&fake).last().is_some_and(|p| p.at.x == 140)
    });
    let all = fake.placed.lock_or_panic().clone();
    assert!(all.len() <= 3, "the middle box was dropped: {all:?}");
    assert!(all.iter().all(|(_, on)| *on != caller_id));
}

#[test]
fn the_window_is_asked_for_its_place_once_the_game_shows_up() {
    // Veistra moves 300 px while the game starts; the game must land
    // against where the window is then, not where it was at Play.
    let fake = Arc::new(Fake {
        finds_before: 2,
        ..Fake::default()
    });
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    let origin = AtomicI32::new(100);
    let looks = &fake.looks;
    let now = || {
        if looks.load(Ordering::SeqCst) > 2 {
            origin.store(400, Ordering::SeqCst);
        }
        Some(Owner {
            origin: (origin.load(Ordering::SeqCst), 50),
            ..owner(1.0)
        })
    };
    embed.attach(None, &|| vec![1], &now, &|| true);
    assert_eq!(placed(&fake).len(), 1);
    assert_eq!(placed(&fake)[0].at.x, 410);
}

#[test]
fn attach_and_dock_size_the_window_to_the_pane_before_a_take_can_start() {
    // A take starts the moment either returns and sizes its video from
    // the window then, so the move must already be made, on this thread.
    let fake = Arc::new(Fake::default());
    let embed = embedded(&fake);
    let pane = ScreenRect {
        x: 110,
        y: 50,
        w: 640,
        h: 100,
    };
    assert_eq!(
        placed_here(&fake).iter().map(|p| p.at).collect::<Vec<_>>(),
        [pane]
    );
    embed.pop_out(Some(&owner(1.0))).unwrap();
    embed.set_rect(shown(rect(20.0, 800.0)), Some(&owner(1.0)));
    embed.dock(&owner(1.0)).unwrap();
    let docked = placed_here(&fake);
    assert_eq!(docked.len(), 2, "Dock placed it before returning");
    assert_eq!((docked[1].at.x, docked[1].at.w), (120, 800));
    assert!(docked[1].visible);
}

#[test]
fn a_pane_moved_to_another_window_takes_the_game_with_it() {
    let fake = Arc::new(Fake::default());
    let embed = embedded(&fake);
    assert_eq!(placed(&fake)[0].owner, 1);
    let second = Owner {
        hwnd: 2,
        ..owner(1.0)
    };
    embed.set_rect(shown(rect(10.0, 640.0)), Some(&second));
    wait_for("the move", || placed(&fake).len() == 2);
    assert_eq!(placed(&fake)[1].owner, 2, "owned by the window it is in");
}

#[test]
fn a_game_that_ended_is_never_moved_again() {
    let fake = Arc::new(Fake::default());
    let embed = embedded(&fake);
    embed.forget();
    embed.reapply(&owner(1.0));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(placed(&fake).len(), 1, "a dead handle is left alone");
    assert_eq!(embed.still_png(), None, "and no still is kept for it");
}

/// Blender quit, or crashed: its window went with it, but the clip box it sat
/// in is Veistra's, and stayed over the pane as an empty dark rectangle on top
/// of the pane's own "Open Blender".
#[test]
fn an_editor_that_ended_lets_go_of_its_clip_box_once() {
    let fake = Arc::new(Fake::default());
    let editor = Embed::with(fake.clone(), Kind::Blender);
    editor.set_rect(shown(rect(10.0, 640.0)), None);
    let found = editor.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(found, Some(7));
    editor.forget();
    assert_eq!(fake.discarded.load(Ordering::SeqCst), 1);
    editor.forget();
    assert_eq!(
        fake.discarded.load(Ordering::SeqCst),
        1,
        "the box is closed once"
    );
    assert!(
        editor.pop_out(Some(&owner(1.0))).is_err(),
        "nothing to pop out"
    );
    assert!(fake.released.lock_or_panic().is_empty());
}

#[test]
fn a_refused_embed_leaves_the_window_decorated_on_screen_over_the_pane() {
    let fake = Arc::new(Fake::default());
    fake.fail_embed.store(true, Ordering::SeqCst);
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    assert_eq!(
        embed.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true),
        Some(7)
    );
    assert_eq!(cause(&embed), Cause::Refused);
    let near = fake.shown_near.lock_or_panic().clone();
    assert_eq!(near.len(), 1);
    assert_eq!(
        near[0].map(|r| (r.x, r.w)),
        Some((110, 640)),
        "where the pane is"
    );
    assert!(placed(&fake).is_empty());
}

#[test]
fn a_failed_first_placement_gives_the_window_back_decorated() {
    let fake = Arc::new(Fake::default());
    fake.fail_place.store(true, Ordering::SeqCst);
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    embed.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(
        cause(&embed),
        Cause::PlaceFailed,
        "not left stripped and hidden"
    );
    assert_eq!(fake.released.lock_or_panic().len(), 1);
    assert_eq!(embed.still_png(), None);
}

#[test]
fn a_window_with_no_veistra_window_is_brought_on_screen() {
    let fake = Arc::new(Fake::default());
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.attach(None, &|| vec![1], &|| None, &|| true);
    assert_eq!(cause(&embed), Cause::NoOwner);
    assert_eq!(fake.shown_near.lock_or_panic().clone(), vec![None]);
}

#[test]
fn a_window_that_shows_after_the_wait_is_put_on_screen_not_embedded() {
    let fake = Arc::new(Fake {
        finds_before: 3,
        ..Fake::default()
    });
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    let wait = Duration::from_millis(150);
    let found = embed.attach_within(wait, None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(found, Some(7));
    assert_eq!(cause(&embed), Cause::NoWindow);
    assert!(
        placed(&fake).is_empty(),
        "the embedder stopped after the wait"
    );
    assert_eq!(
        fake.shown_near.lock_or_panic().len(),
        1,
        "but it is on screen"
    );
}

#[test]
fn a_cause_known_up_front_skips_placing_and_only_shows_the_window() {
    let fake = Arc::new(Fake::default());
    let embed = Embed::with(fake.clone(), Kind::Game);
    embed.attach(
        Some(Cause::Forced),
        &|| vec![1],
        &|| Some(owner(1.0)),
        &|| true,
    );
    assert_eq!(cause(&embed), Cause::Forced);
    assert!(placed(&fake).is_empty());
    assert_eq!(fake.shown_near.lock_or_panic().len(), 1);
}

/// The settled hook's calls, for the outcome a window reports.
fn settled_log(embed: &Embed) -> Arc<Mutex<Vec<State>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    embed.when_settled(Box::new(move |s| log.lock_or_panic().push(s.clone())));
    seen
}

#[test]
fn a_window_started_with_no_pane_docks_into_the_pane_that_opens() {
    let fake = Arc::new(Fake::default());
    let embed = Embed::with(fake.clone(), Kind::Game);
    let seen = settled_log(&embed);
    embed.attach(Some(Cause::NoPane), &|| vec![1], &|| None, &|| true);
    assert_eq!(cause(&embed), Cause::NoPane);
    assert!(seen.lock_or_panic().is_empty(), "no pane is no outcome yet");
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    embed.dock(&owner(1.0)).unwrap();
    assert_eq!(embed.state(), State::Embedded);
    assert_eq!(placed(&fake).len(), 1);
    assert_eq!(
        seen.lock_or_panic().clone(),
        vec![State::Embedded],
        "the pane that docked it had the first try"
    );
    let refused = Embed::with(fake.clone(), Kind::Game);
    refused.attach(Some(Cause::Forced), &|| vec![1], &|| None, &|| true);
    assert!(
        refused.dock(&owner(1.0)).is_err(),
        "only a window with no pane joins one"
    );
}

/// An agent's run with no pane open, and Play opened while the game is still
/// loading: the window is placed when it shows, not left in its own frame.
#[test]
fn a_pane_that_opens_before_the_window_shows_gets_it_placed() {
    let fake = Arc::new(Fake {
        finds_before: 3,
        ..Fake::default()
    });
    let embed = Embed::with(fake.clone(), Kind::Game);
    let seen = settled_log(&embed);
    // As `Hosts::host` does: the cause first, then the search. The pane's
    // box lands before the window shows; the `ops` lock decides the order
    // when the two race, so the search runs after it here.
    embed.give_up(Cause::NoPane);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    assert!(embed.rejoin(), "no window yet, so it is looked for again");
    let found = embed.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(found, Some(7));
    assert_eq!(embed.state(), State::Embedded);
    assert_eq!(placed(&fake).len(), 1, "placed over the pane that opened");
    assert!(
        fake.shown_near.lock_or_panic().is_empty(),
        "never decorated"
    );
    assert_eq!(seen.lock_or_panic().clone(), vec![State::Embedded]);
    assert!(!embed.rejoin(), "in the pane, nothing to rejoin");

    let found = Embed::with(fake.clone(), Kind::Game);
    found.attach(Some(Cause::NoPane), &|| vec![1], &|| None, &|| true);
    assert!(!found.rejoin(), "its window exists: Dock places it");
    assert_eq!(cause(&found), Cause::NoPane);
}

/// The pane opens after the wait would have run out, and the window shows
/// just after that: it is placed, not left in its own frame, because the wait
/// counts from the pane. Without that, a pane opened at 15 s kept a window
/// that showed at 20 s out, while one opened at 25 s docked it.
#[test]
fn a_pane_that_rejoins_late_gets_the_whole_wait() {
    let fake = Arc::new(Fake {
        finds_before: 3,
        ..Fake::default()
    });
    let embed = Embed::with(fake.clone(), Kind::Game);
    let seen = settled_log(&embed);
    embed.give_up(Cause::NoPane);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    let looks = AtomicUsize::new(0);
    // Asked after each look that found nothing; the third comes at least
    // 200 ms in, past the wait, and the pane rejoins there.
    let alive = || {
        if looks.fetch_add(1, Ordering::SeqCst) == 2 {
            assert!(embed.rejoin());
        }
        true
    };
    let wait = Duration::from_millis(150);
    let found = embed.attach_within(wait, None, &|| vec![1], &|| Some(owner(1.0)), &alive);
    assert_eq!(found, Some(7));
    assert_eq!(embed.state(), State::Embedded);
    assert_eq!(placed(&fake).len(), 1);
    assert_eq!(seen.lock_or_panic().clone(), vec![State::Embedded]);
}

#[test]
fn the_outcome_is_reported_once_whatever_it_is() {
    let fake = Arc::new(Fake::default());
    let embed = Embed::with(fake.clone(), Kind::Game);
    let seen = settled_log(&embed);
    embed.set_rect(shown(rect(10.0, 640.0)), None);
    embed.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    embed.pop_out(None).unwrap();
    embed.dock(&owner(1.0)).unwrap();
    assert_eq!(seen.lock_or_panic().clone(), vec![State::Embedded]);
    let usage = usage_for(&State::Embedded, 820).unwrap();
    assert_eq!(
        (usage.0, usage.1["ms"].clone()),
        ("play_embedded", json!(820))
    );
    let failed = State::OwnWindow {
        reason: String::new(),
        cause: Cause::Refused,
    };
    let usage = usage_for(&failed, 0).unwrap();
    assert_eq!(
        (usage.0, usage.1["cause"].clone()),
        ("play_embed_failed", json!("refused"))
    );
    let exited = State::OwnWindow {
        reason: String::new(),
        cause: Cause::Exited,
    };
    assert_eq!(usage_for(&exited, 0), None, "nothing failed");
    let no_pane = State::OwnWindow {
        reason: String::new(),
        cause: Cause::NoPane,
    };
    assert_eq!(usage_for(&no_pane, 0), None, "nothing was tried");
}

#[test]
fn a_placed_window_keeps_a_still_until_it_pops_out() {
    let fake = Arc::new(Fake::default());
    let embed = embedded(&fake);
    assert_eq!(embed.still_png(), Some(b"PNG".to_vec()));
    embed.pop_out(None).unwrap();
    assert_eq!(embed.still_png(), None);
    let report = embed.report();
    assert_eq!(report["kind"], "game");
    assert_eq!(report["state"]["kind"], "poppedOut");
    assert!(report["lastPlaceMs"].is_u64(), "{report}");
}

/// Graphics Capture refuses a child window ("Failed to convert item to
/// `GraphicsCaptureItem`"), so an editor is never watched for a still.
#[test]
fn an_editor_placed_as_a_child_is_not_watched_for_a_still() {
    for kind in [Kind::Blender, Kind::GodotEditor] {
        let fake = Arc::new(Fake::default());
        let editor = Embed::with(fake.clone(), kind);
        editor.set_rect(shown(rect(10.0, 640.0)), None);
        editor.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
        assert_eq!(editor.state(), State::Embedded);
        assert_eq!(editor.still_png(), None, "{kind:?}");
        assert_eq!(editor.report()["still"], false);
    }
}

#[test]
fn an_overlay_leaves_a_hole_where_it_falls_on_the_window_and_none_where_it_misses() {
    let px = |x, y, w, h| ScreenRect { x, y, w, h };
    let at = px(100, 200, 400, 300);
    let covers = [
        // The app picker hanging from the tab strip into the box's top.
        px(250, 120, 300, 150),
        // A toast entirely inside it.
        px(150, 400, 50, 20),
        // A menu beside the box, touching its edge only.
        px(500, 200, 80, 80),
    ];
    assert_eq!(
        holes(at, &covers),
        vec![px(150, 0, 250, 70), px(50, 200, 50, 20)]
    );
    assert!(holes(at, &[]).is_empty());
}

/// An editor in its pane at CSS 10..650 x 0..100, at `scale`.
fn placed_editor(fake: &Arc<Fake>, scale: f64) -> Embed {
    let editor = Embed::with(fake.clone(), Kind::Blender);
    editor.set_rect(shown(rect(10.0, 640.0)), None);
    editor.attach(None, &|| vec![1], &|| Some(owner(scale)), &|| true);
    assert_eq!(editor.state(), State::Embedded);
    editor
}

fn cuts(fake: &Fake) -> Vec<Vec<ScreenRect>> {
    fake.cuts.lock_or_panic().clone()
}

#[test]
fn a_shell_overlay_over_a_child_editor_is_cut_out_of_it_and_given_back_when_it_closes() {
    let fake = Arc::new(Fake::default());
    let editor = placed_editor(&fake, 1.5);
    assert!(cuts(&fake).is_empty(), "nothing open, nothing cut");

    let picker = CssRect {
        x: 210.0,
        y: -40.0,
        w: 200.0,
        h: 100.0,
    };
    let before = placed(&fake).len();
    editor.set_overlays(vec![picker], Some(&owner(1.5)));
    let hole = ScreenRect {
        x: 300,
        y: 0,
        w: 300,
        h: 90,
    };
    wait_for("the hole", || {
        cuts(&fake) == vec![vec![hole]] && placed(&fake).len() > before
    });
    assert!(
        placed(&fake).last().unwrap().visible,
        "still shown around it"
    );
    assert_eq!(editor.report()["holes"][0]["w"], 300);

    // The same overlays again ask nothing of the window.
    let made = placed(&fake).len();
    editor.set_overlays(vec![picker], Some(&owner(1.5)));
    editor.reapply(&owner(1.5));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!((cuts(&fake).len(), placed(&fake).len()), (1, made));

    editor.set_overlays(Vec::new(), Some(&owner(1.5)));
    wait_for("the whole box back", || {
        cuts(&fake).last().is_some_and(|c| c.is_empty())
    });
}

#[test]
fn the_game_swaps_for_its_still_rather_than_being_cut() {
    let fake = Arc::new(Fake::default());
    let game = embedded(&fake);
    game.set_overlays(vec![rect(0.0, 2000.0)], Some(&owner(1.0)));
    game.reapply(&owner(1.0));
    std::thread::sleep(Duration::from_millis(50));
    assert!(cuts(&fake).is_empty());
}

#[test]
fn the_kind_is_handed_to_the_search() {
    let fake = Arc::new(Fake::default());
    let embed = Embed::with(fake.clone(), Kind::Blender);
    embed.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(fake.kinds.lock_or_panic().clone(), vec![Kind::Blender]);
    let State::Embedded = embed.state() else {
        panic!("Blender embeds through the same path");
    };
}

#[test]
fn a_shown_window_sits_just_above_its_owner() {
    assert_eq!(just_above(0, 7), ZOrder::Top);
    assert_eq!(just_above(7, 7), ZOrder::Keep);
    assert_eq!(just_above(9, 7), ZOrder::After(9));
}

#[test]
fn style_writes_never_carry_visible_minimised_or_maximised() {
    use styles::*;
    let popped = (WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE | WS_MINIMIZE) as isize;
    let e = embedded(popped);
    assert_eq!(e & (WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX) as isize, 0);
    assert_eq!(e & (WS_VISIBLE | WS_MINIMIZE | WS_MAXIMIZE) as isize, 0);
    assert_ne!(e & WS_POPUP as isize, 0);
    let back = restored((WS_CAPTION | WS_VISIBLE | WS_MAXIMIZE) as isize);
    assert_eq!(
        back, WS_CAPTION as isize,
        "the frame comes back, the states do not"
    );
    let ex = embedded_ex(WS_EX_APPWINDOW as isize);
    assert_eq!(ex, WS_EX_TOOLWINDOW as isize);
}

#[test]
fn an_editor_is_a_child_and_the_game_stays_an_owned_popup() {
    assert_eq!(
        Kind::Game.mode(),
        Mode::Owned,
        "the recorder captures it alone"
    );
    assert_eq!(Kind::GodotEditor.mode(), Mode::Child);
    assert_eq!(Kind::Blender.mode(), Mode::Child);
}

/// Braden's report: Veistra at 150 % with its client area at (285, 135) on
/// the screen, the Godot pane on the left and the agent pane from x 1440.
/// The pane's box, in CSS pixels, lands on whole physical pixels in Veistra's
/// client area for the child, ending exactly where the agent pane begins, and
/// the same box goes on the screen from the client origin for a popup.
#[test]
fn a_pane_at_150_percent_is_placed_in_physical_client_pixels() {
    let veistra = Owner {
        hwnd: 1,
        origin: (285, 135),
        scale: 1.5,
    };
    let pane = CssRect {
        x: 0.0,
        y: 36.0,
        w: 770.0,
        h: 744.0,
    };
    let px = |x, y, w, h| ScreenRect { x, y, w, h };
    let scale = scale_for(Some(1.5), veistra.scale);
    let child = target(Mode::Child, pane, &veistra, scale);
    assert_eq!(child, px(0, 54, 1155, 1116));
    assert_eq!(
        veistra.origin.0 + child.x + child.w,
        1440,
        "the editor stops where the agent pane starts"
    );
    assert_eq!(
        target(Mode::Owned, pane, &veistra, scale),
        px(285, 189, 1155, 1116)
    );
    // A View zoom on the same monitor: the page's ratio carries both.
    let zoomed = target(Mode::Child, pane, &veistra, scale_for(Some(1.75), 1.5));
    assert_eq!(zoomed, px(0, 63, 1348, 1302));
}

#[test]
fn moving_veistra_sends_an_editor_nothing_and_still_moves_the_game() {
    let fake = Arc::new(Fake::default());
    let editor = Embed::with(fake.clone(), Kind::Blender);
    editor.set_rect(shown(rect(10.0, 640.0)), None);
    editor.attach(None, &|| vec![1], &|| Some(owner(1.0)), &|| true);
    assert_eq!(placed(&fake).len(), 1);
    assert_eq!(placed(&fake)[0].at.x, 10, "in client pixels, not 110");
    let moved = Owner {
        origin: (400, 300),
        ..owner(1.0)
    };
    editor.reapply(&moved);
    editor.reapply(&owner(1.0));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        placed(&fake).len(),
        1,
        "a move of Veistra costs the editor nothing"
    );
    editor.set_rect(shown(rect(10.0, 500.0)), Some(&moved));
    wait_for("the new size", || placed(&fake).len() == 2);
    assert_eq!((placed(&fake)[1].at.x, placed(&fake)[1].at.w), (10, 500));
    assert!(fake.modes.lock_or_panic().iter().all(|m| *m == Mode::Child));

    let fake = Arc::new(Fake::default());
    let game = embedded(&fake);
    game.reapply(&moved);
    wait_for("the game's move", || placed(&fake).len() == 2);
    assert_eq!(
        placed(&fake)[1].at.x,
        410,
        "an owned popup is moved by hand"
    );
}

#[test]
fn an_editor_s_child_style_has_no_frame_and_tells_its_parent_nothing() {
    use styles::*;
    let decorated = (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_VISIBLE | WS_MAXIMIZE) as isize;
    let c = child(decorated);
    assert_eq!(c, (WS_CHILD | WS_CLIPSIBLINGS) as isize);
    // Godot's editor started with `--wid`: WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS.
    let godot = 0x8600_0000_u32 as isize;
    assert_eq!(child(godot) & WS_POPUP as isize, 0);
    assert_ne!(
        child(godot) & 0x0200_0000,
        0,
        "its own clip-children bit is kept"
    );
    let ex = child_ex((WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | 0x10) as isize);
    assert_eq!(ex, (WS_EX_NOPARENTNOTIFY | 0x10) as isize);
}

#[test]
fn popping_out_gives_a_frameless_editor_a_frame_and_a_framed_one_its_own() {
    use styles::*;
    let framed = (WS_CAPTION | WS_THICKFRAME | WS_VISIBLE) as isize;
    assert_eq!(popped_out(framed), (WS_CAPTION | WS_THICKFRAME) as isize);
    let godot = popped_out(0x9600_0000_u32 as isize);
    assert_eq!(godot & (WS_POPUP | WS_VISIBLE | WS_CHILD) as isize, 0);
    assert_eq!(
        godot & (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU) as isize,
        (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU) as isize,
        "a caption to move it by"
    );
}

#[test]
fn states_serialize_as_the_pane_reads_them() {
    let v = serde_json::to_value(State::OwnWindow {
        reason: "x".into(),
        cause: Cause::NoWindow,
    })
    .unwrap();
    assert_eq!(v["kind"], "ownWindow");
    assert_eq!(v["reason"], "x");
    assert_eq!(v["cause"], "noWindow");
    assert_eq!(
        serde_json::to_value(State::PoppedOut).unwrap()["kind"],
        "poppedOut"
    );
    assert_eq!(
        serde_json::to_value(Kind::GodotEditor).unwrap(),
        "godotEditor"
    );
}
