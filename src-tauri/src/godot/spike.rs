//! The R1/R2 embed spike (#308, design §4.1): how the game's window sits in
//! Play's pane. Windows 11 only; `pnpm spike:embed` runs it and writes the
//! report the decision row in `docs/design-notes/godot-play.md` is filled from.
//!
//! - **R1, a child window**: `SetParent` into the Veistra window, done here.
//! - **R2, an owned popup**: [`crate::embed`] unchanged, the code Play ships.
//! - **R2 with `--wid`**: Godot 4.4 and later make the owned popup themselves
//!   when given the owner's handle, which is how Godot's editor embeds a game.
//!
//! Each runs the demo game (`examples/godot-demo`, copied with the reporters in
//! `spike/` added) over a fixed box in a stand-in Veistra window: a top-level
//! window with a child "page" filling it where WebView2 would be. The checks are
//! the issue's four: it follows a move and a resize; Graphics Capture takes it;
//! a key and a click reach it; a menu the page draws shows over it. The chosen
//! way then runs the Godot editor (`--editor --single-window`) and Blender.
//!
//! Veistra moves the game when its window moves (`lib.rs` on `Moved`); the spike
//! does the same right after each change it makes. Everything above [`win`] is
//! data and arithmetic, tested on any host. Compiled only in test builds with
//! the `embed-spike` feature.
#![cfg_attr(not(windows), allow(dead_code))]

use super::detect;
use super::record::Stopped;
use super::runner::{RunSpec, WindowArgs};
use crate::embed::{styles, Kind, LaunchRect, ScreenRect};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Way {
    R1,
    R2,
    R2Wid,
}

impl Way {
    const ALL: [Way; 3] = [Way::R1, Way::R2, Way::R2Wid];

    fn id(self) -> &'static str {
        match self {
            Way::R1 => "r1",
            Way::R2 => "r2",
            Way::R2Wid => "r2wid",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Way::R1 => "R1 child window",
            Way::R2 => "R2 owned popup",
            Way::R2Wid => "R2 with --wid",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Game,
    Editor,
    Blender,
}

impl Target {
    const ALL: [Target; 3] = [Target::Game, Target::Editor, Target::Blender];

    fn id(self) -> &'static str {
        match self {
            Target::Game => "game",
            Target::Editor => "editor",
            Target::Blender => "blender",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Target::Game => "Demo game",
            Target::Editor => "Godot editor",
            Target::Blender => "Blender",
        }
    }

    /// How long its window may take: the editor imports the project first,
    /// and Blender loads its add-ons.
    fn find_for(self) -> Duration {
        match self {
            Target::Game => Duration::from_secs(20),
            Target::Editor | Target::Blender => Duration::from_secs(120),
        }
    }

    /// Frames two seconds of recording must hold. A game draws every frame;
    /// the editor and Blender redraw only when something changes, so for them
    /// one frame is the proof that capture works at all.
    fn min_frames(self) -> u64 {
        match self {
            Target::Game => 30,
            Target::Editor | Target::Blender => 1,
        }
    }

    /// The kind the embedder places it as, which picks the window class it
    /// prefers when the process has more than one window.
    fn kind(self) -> Kind {
        match self {
            Target::Game => Kind::Game,
            Target::Editor => Kind::GodotEditor,
            Target::Blender => Kind::Blender,
        }
    }
}

/// `VEISTRA_SPIKE_WAYS` or `VEISTRA_SPIKE_TARGETS`: ids separated by commas,
/// or every one of `all` when unset.
fn parse_list<T: Copy + PartialEq>(
    text: Option<&str>,
    all: &[T],
    id: fn(T) -> &'static str,
) -> Result<Vec<T>, String> {
    let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(all.to_vec());
    };
    let mut out = Vec::new();
    for word in text.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        let Some(found) = all
            .iter()
            .copied()
            .find(|t| id(*t).eq_ignore_ascii_case(word))
        else {
            let known: Vec<_> = all.iter().map(|t| id(*t)).collect();
            return Err(format!("{word:?} is not one of {}", known.join(", ")));
        };
        if !out.contains(&found) {
            out.push(found);
        }
    }
    Ok(out)
}

/// The issue's four checks, in the order they run and the table lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Item {
    Follows,
    Capture,
    Input,
    Menu,
}

impl Item {
    const ALL: [Item; 4] = [Item::Follows, Item::Capture, Item::Input, Item::Menu];

    fn title(self) -> &'static str {
        match self {
            Item::Follows => "Follows a Veistra move and resize",
            Item::Capture => "Graphics Capture accepts the window",
            Item::Input => "Keyboard and mouse reach the game",
            Item::Menu => "A Veistra menu draws over it",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Check {
    item: Item,
    /// `None` when what was seen cannot answer the question.
    pass: Option<bool>,
    detail: String,
}

impl Check {
    fn new(item: Item, pass: bool, detail: String) -> Self {
        Self {
            item,
            pass: Some(pass),
            detail,
        }
    }

    fn unmeasured(item: Item, why: &str) -> Self {
        Self {
            item,
            pass: None,
            detail: why.to_string(),
        }
    }
}

/// One way with one program: its checks, and what else was seen on the way,
/// as rows of the table under the checks.
#[derive(Debug, Clone, PartialEq)]
struct Run {
    way: Way,
    target: Target,
    checks: Vec<Check>,
    notes: Vec<(&'static str, String)>,
    /// Why it did not run, for a column that says so.
    skipped: Option<String>,
}

impl Run {
    fn new(way: Way, target: Target) -> Self {
        Self {
            way,
            target,
            checks: Vec::new(),
            notes: Vec::new(),
            skipped: None,
        }
    }

    fn not_run(way: Way, target: Target, why: &str) -> Self {
        Self {
            skipped: Some(why.to_string()),
            ..Self::new(way, target)
        }
    }

    fn note(&mut self, row: &'static str, text: impl Into<String>) {
        self.notes.push((row, text.into()));
    }

    fn check(&self, item: Item) -> Option<&Check> {
        self.checks.iter().find(|c| c.item == item)
    }

    fn passes(&self, item: Item) -> bool {
        self.check(item).is_some_and(|c| c.pass == Some(true))
    }

    fn cell(&self, item: Item) -> String {
        if let Some(why) = &self.skipped {
            return format!("not run: {why}");
        }
        match self.check(item) {
            Some(Check {
                pass: Some(true),
                detail,
                ..
            }) => format!("**yes**: {detail}"),
            Some(Check {
                pass: Some(false),
                detail,
                ..
            }) => format!("**no**: {detail}"),
            Some(Check { detail, .. }) => format!("not measured: {detail}"),
            None => "not measured".to_string(),
        }
    }

    fn note_cell(&self, row: &str) -> String {
        let all: Vec<&str> = self
            .notes
            .iter()
            .filter(|(r, _)| *r == row)
            .map(|(_, t)| t.as_str())
            .collect();
        if all.is_empty() {
            "-".to_string()
        } else {
            all.join("; ")
        }
    }
}

/// How soon after Veistra's window stops moving the game must sit exactly on
/// the box again: a few frames.
const SETTLE: Duration = Duration::from_millis(100);

/// What the follow check saw.
#[derive(Debug, Clone, Default)]
struct Follow {
    /// The widest gap, in physical pixels, between the window and the box
    /// while Veistra's window was dragged.
    drag_gap: i32,
    /// From the last step until the window sat exactly on the box; `None`
    /// when it did not within half a second.
    moved: Option<Duration>,
    resized: Option<Duration>,
    /// The size the program reported after the resize, against the box's.
    reported: Option<(u32, u32)>,
    wanted: (u32, u32),
    /// On the box and visible after Veistra was minimised and restored.
    restored: bool,
}

fn ms(d: Duration) -> String {
    format!("{} ms", d.as_millis())
}

fn judge_follow(f: &Follow) -> Check {
    let settled = |d: Option<Duration>| d.is_some_and(|d| d <= SETTLE);
    let when = |d: Option<Duration>| d.map_or("not within 500 ms".to_string(), ms);
    let pass = settled(f.moved) && settled(f.resized) && f.reported == Some(f.wanted) && f.restored;
    let reported = f
        .reported
        .map_or("no size report".to_string(), |(w, h)| format!("{w}x{h}"));
    Check::new(
        Item::Follows,
        pass,
        format!(
            "on the box {} after a move and {} after a resize; it reported {reported} for a \
             {}x{} box; {} px behind while dragged; {} after minimise and restore",
            when(f.moved),
            when(f.resized),
            f.wanted.0,
            f.wanted.1,
            f.drag_gap,
            if f.restored { "back" } else { "not back" },
        ),
    )
}

/// What the capture check saw.
#[derive(Debug, Clone)]
struct Capture {
    /// `CreateForWindow` on the window; the error names the HRESULT.
    item: Result<(), String>,
    /// Two seconds through Play's own recorder.
    recorded: Result<Stopped, String>,
    /// The size the recorder encodes the box at (`encode::output_size` at
    /// the default quality): the box's own, rounded down to even, while it
    /// fits inside 1280x720.
    wanted: (u32, u32),
    min_frames: u64,
}

fn judge_capture(c: &Capture) -> Check {
    match (&c.item, &c.recorded) {
        (Err(e), _) => Check::new(
            Item::Capture,
            false,
            format!("CreateForWindow refused it: {e}"),
        ),
        (Ok(()), Err(e)) => Check::new(
            Item::Capture,
            false,
            format!("CreateForWindow took it, but recording failed: {e}"),
        ),
        (Ok(()), Ok(s)) => Check::new(
            Item::Capture,
            (s.width, s.height) == c.wanted && s.frames >= c.min_frames,
            format!(
                "{} frames in 2 s at {}x{} (the box is {}x{}; {} needed)",
                s.frames, s.width, s.height, c.wanted.0, c.wanted.1, c.min_frames
            ),
        ),
    }
}

/// What the input check saw, from the program's reporter.
#[derive(Debug, Clone, Default)]
struct Input {
    /// The reporter started, so silence from it means something.
    listening: bool,
    key: bool,
    /// Where the reporter says the click landed, in its window's pixels.
    click: Option<(f64, f64)>,
    /// Where it should have, for the game; the editor's and Blender's reports
    /// use other origins, so only arrival counts for them.
    aim: Option<(f64, f64)>,
    /// Key-downs the stand-in Veistra window got while the key went to the game.
    host_keys: usize,
    focus: Option<bool>,
}

fn judge_input(i: &Input) -> Check {
    if !i.listening {
        return Check::unmeasured(Item::Input, "the reporter never started");
    }
    let landed = match (i.click, i.aim) {
        (Some((x, y)), Some((ax, ay))) => (x - ax).abs() <= 2.0 && (y - ay).abs() <= 2.0,
        (Some(_), None) => true,
        (None, _) => false,
    };
    let click = match (i.click, i.aim) {
        (None, _) => "the click did not arrive".to_string(),
        (Some((x, y)), Some((ax, ay))) => {
            format!("the click landed at {x:.0},{y:.0} for {ax:.0},{ay:.0}")
        }
        (Some(_), None) => "the click arrived".to_string(),
    };
    let focus = match i.focus {
        Some(true) => "focused",
        Some(false) => "not focused",
        None => "focus unknown",
    };
    Check::new(
        Item::Input,
        i.key && landed && i.host_keys == 0,
        format!(
            "F13 {}; {click} ({focus}); Veistra's window got {} key presses",
            if i.key { "arrived" } else { "did not arrive" },
            i.host_keys
        ),
    )
}

/// The longest a menu may take to show where the game was, and the game to
/// come back after it: about six frames, as a still swap would.
const SWAP: Duration = Duration::from_millis(100);

/// What the menu check read off the screen.
#[derive(Debug, Clone, Default)]
struct Menu {
    /// The program's window showed at the point read over the box
    /// ([`shows_window`]).
    window: bool,
    /// The menu's colour showed beside the game: the page painted it.
    drawn: bool,
    /// The menu showed over the game with the game left where it was.
    over: bool,
    /// From hiding the game until the menu showed in its place, and from
    /// closing the menu until the game showed again.
    swap: Option<Duration>,
    back: Option<Duration>,
}

fn judge_menu(m: &Menu) -> Check {
    if !m.window || !m.drawn {
        let missing = if m.window {
            "the menu never showed beside the box"
        } else {
            "the window never showed at the point read over it"
        };
        return Check::unmeasured(Item::Menu, &format!("{missing}, so the reads mean nothing"));
    }
    if m.over {
        return Check::new(
            Item::Menu,
            true,
            "the menu draws over the game as it is".into(),
        );
    }
    let within = |d: Option<Duration>| d.is_some_and(|d| d <= SWAP);
    let when = |d: Option<Duration>| d.map_or("not within 1 s".to_string(), ms);
    Check::new(
        Item::Menu,
        within(m.swap) && within(m.back),
        format!(
            "not over the game as it is; hiding the game while the menu is open shows the \
             menu {} after and the game {} after it closes",
            when(m.swap),
            when(m.back)
        ),
    )
}

/// The pane's game box in the stand-in window's client area, in physical
/// pixels, leaving room left, above, right and below as Play's layout does.
fn box_px(client: (i32, i32)) -> ScreenRect {
    ScreenRect {
        x: 200,
        y: 120,
        w: (client.0 - 200 - 280).max(64),
        h: (client.1 - 120 - 230).max(64),
    }
}

/// The page's menu, left, top, right and bottom in client pixels: over the
/// box's top-right corner, and partly above the box, where only the page is.
fn menu_px(b: ScreenRect) -> (i32, i32, i32, i32) {
    (b.x + b.w - 220, b.y - 80, b.x + b.w - 20, b.y + 140)
}

/// The two pixels read: one over the game, inside the reporter's patch, and
/// one beside it, above the box. Both are inside the menu.
fn probe_points(b: ScreenRect) -> ((i32, i32), (i32, i32)) {
    ((b.x + b.w - 120, b.y + 70), (b.x + b.w - 120, b.y - 40))
}

/// The colours the stand-in paints and the reporter draws.
const HOST_RGB: (u8, u8, u8) = (48, 48, 48);
const PAGE_RGB: (u8, u8, u8) = (64, 40, 96);
const MENU_RGB: (u8, u8, u8) = (255, 0, 255);
const PATCH_RGB: (u8, u8, u8) = (0, 255, 0);

/// Whether a pixel read over the box is the program's window, not the page
/// under it: the reporter's green patch for the game, which draws one, and
/// anything but the page's and the menu's colours for the editor and Blender.
fn shows_window(target: Target, c: u32) -> bool {
    match target {
        Target::Game => near(c, PATCH_RGB),
        Target::Editor | Target::Blender => {
            c >> 24 == 0 && !near(c, PAGE_RGB) && !near(c, MENU_RGB)
        }
    }
}

/// GDI's `0x00BBGGRR`.
fn colorref((r, g, b): (u8, u8, u8)) -> u32 {
    u32::from(r) | u32::from(g) << 8 | u32::from(b) << 16
}

/// Whether a pixel read is `rgb`, give or take what scaling and colour
/// management do to an edge. `CLR_INVALID` (off screen) is never near.
fn near(c: u32, rgb: (u8, u8, u8)) -> bool {
    let close = |shift: u32, want: u8| ((c >> shift) & 0xFF).abs_diff(u32::from(want)) <= 24;
    c >> 24 == 0 && close(0, rgb.0) && close(8, rgb.1) && close(16, rgb.2)
}

/// The widest gap between two rectangles' edges.
fn rect_gap(a: ScreenRect, b: ScreenRect) -> i32 {
    [
        a.x - b.x,
        a.y - b.y,
        (a.x + a.w) - (b.x + b.w),
        (a.y + a.h) - (b.y + b.h),
    ]
    .iter()
    .map(|d| d.abs())
    .max()
    .unwrap_or(0)
}

const WS_CHILD: u32 = 0x4000_0000;
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;

/// R1's style: what [`styles::embedded`] makes, a child instead of a popup.
/// It clips its siblings, so the page under it never paints over it.
fn child_style(style: isize) -> isize {
    (styles::embedded(style) & !(styles::WS_POPUP as isize)) | (WS_CHILD | WS_CLIPSIBLINGS) as isize
}

/// A child has no taskbar entry to lose, so neither flag means anything.
fn child_ex(ex_style: isize) -> isize {
    ex_style & !((styles::WS_EX_APPWINDOW | styles::WS_EX_TOOLWINDOW) as isize)
}

const REPORTER: &str = include_str!("spike/reporter.gd");
const EDITOR_REPORTER: &str = include_str!("spike/editor_reporter.gd");
const PLUGIN_CFG: &str = include_str!("spike/plugin.cfg");
const BLENDER_REPORTER: &str = include_str!("spike/blender_reporter.py");
const ADDON: &str = "addons/veistra_spike";

fn demo_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/godot-demo")
}

/// `text` with `line` first in `[section]`, which is added at the end when
/// there is none.
fn with_section_line(text: &str, section: &str, line: &str) -> String {
    let header = format!("[{section}]");
    let mut out = String::new();
    let mut done = false;
    for l in text.lines() {
        out.push_str(l);
        out.push('\n');
        if !done && l.trim() == header {
            out.push_str(line);
            out.push('\n');
            done = true;
        }
    }
    if !done {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push('\n');
        }
        let _ = write!(out, "{header}\n\n{line}\n");
    }
    out
}

/// The demo's `project.godot` with the game's reporter as an autoload and the
/// editor's as an enabled plugin.
fn spike_project_godot(original: &str) -> String {
    let autoload = format!("VeistraSpike=\"*res://{ADDON}/reporter.gd\"");
    let plugin = format!("enabled=PackedStringArray(\"res://{ADDON}/plugin.cfg\")");
    with_section_line(
        &with_section_line(original, "autoload", &autoload),
        "editor_plugins",
        &plugin,
    )
}

fn io_error(path: &Path) -> impl FnOnce(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

/// Copy `from` into `to`, all but Godot's import cache, which the copy
/// rebuilds for itself.
fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(io_error(to))?;
    for entry in std::fs::read_dir(from).map_err(io_error(from))? {
        let entry = entry.map_err(io_error(from))?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_name() == ".godot" {
            continue;
        }
        if entry.file_type().map_err(io_error(&src))?.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(io_error(&src))?;
        }
    }
    Ok(())
}

/// The spike's project: a copy of the demo with the reporters added. The demo
/// itself never loads them.
fn write_project(demo: &Path, to: &Path) -> Result<(), String> {
    copy_dir(demo, to)?;
    let file = to.join("project.godot");
    let text = std::fs::read_to_string(&file).map_err(io_error(&file))?;
    std::fs::write(&file, spike_project_godot(&text)).map_err(io_error(&file))?;
    let addon = to.join(ADDON);
    std::fs::create_dir_all(&addon).map_err(io_error(&addon))?;
    for (name, text) in [
        ("reporter.gd", REPORTER),
        ("editor_reporter.gd", EDITOR_REPORTER),
        ("plugin.cfg", PLUGIN_CFG),
    ] {
        let path = addon.join(name);
        std::fs::write(&path, text).map_err(io_error(&path))?;
    }
    Ok(())
}

/// `--wid` makes Godot create an owned popup from 4.4 on.
fn wid_supported(major: u32, minor: u32) -> bool {
    major > 4 || (major == 4 && minor >= 4)
}

/// The game's command line, as Play's own: the box's size, first shown where
/// the box is (`embed::launch_rect`, as `rpc::launch_window` uses it). `--wid`
/// only for the way that is about it.
fn game_args(project: &Path, way: Way, at: LaunchRect, host: isize) -> Vec<String> {
    let mut args = RunSpec {
        program: PathBuf::new(),
        project: project.to_path_buf(),
        scene: None,
        channel: None,
        window: Some(WindowArgs {
            width: at.width,
            height: at.height,
            position: at.position,
        }),
    }
    .args();
    if way == Way::R2Wid {
        args.extend(["--wid".to_string(), host.to_string()]);
    }
    args
}

/// `--single-window` keeps the editor's dialogs inside its own window, the
/// only way it can live in a pane.
fn editor_args(project: &Path) -> Vec<String> {
    ["--editor", "--single-window", "--path"]
        .map(String::from)
        .into_iter()
        .chain([project.display().to_string()])
        .collect()
}

fn blender_args(script: &Path) -> Vec<String> {
    vec![
        "--factory-startup".to_string(),
        "--python".to_string(),
        script.display().to_string(),
    ]
}

/// One line of a reporter's `input.jsonl`.
#[derive(Debug, Clone, PartialEq)]
enum Report {
    Ready((u32, u32)),
    Size((u32, u32)),
    Key(String),
    Click { at: (f64, f64), focus: Option<bool> },
    Hang,
    Awake,
}

/// Every line that parses. The file is read while the reporter appends to
/// it, so a torn last line is skipped and read whole next time.
fn parse_reports(text: &str) -> Vec<Report> {
    text.lines().filter_map(parse_report).collect()
}

fn parse_report(line: &str) -> Option<Report> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let pair = |key: &str| {
        let a = v.get(key)?.as_array()?;
        Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
    };
    let size = || pair("size").map(|(w, h)| (w as u32, h as u32));
    match v.get("kind")?.as_str()? {
        "ready" => Some(Report::Ready(size()?)),
        "size" => Some(Report::Size(size()?)),
        "key" => Some(Report::Key(v.get("key")?.as_str()?.to_string())),
        "click" => Some(Report::Click {
            at: pair("at")?,
            focus: v.get("focus").and_then(serde_json::Value::as_bool),
        }),
        "hang" => Some(Report::Hang),
        "awake" => Some(Report::Awake),
        _ => None,
    }
}

/// The checks a way must pass on the demo game to be suggested. The menu
/// ranks nothing: any way shows Veistra's menus by swapping the game for a
/// still (design §4.3), and its row says how fast that is.
const DECIDING: [Item; 3] = [Item::Follows, Item::Capture, Item::Input];

/// The way the report suggests: R2 (what Play ships), then R2 with `--wid`,
/// then R1, whichever first passes [`DECIDING`] on the demo game.
fn verdict(runs: &[Run]) -> (Way, String) {
    for way in [Way::R2, Way::R2Wid, Way::R1] {
        let passed = runs.iter().any(|r| {
            r.way == way
                && r.target == Target::Game
                && r.skipped.is_none()
                && DECIDING.iter().all(|i| r.passes(*i))
        });
        if passed {
            return (
                way,
                format!(
                    "{} passed following, capture and input on the demo game",
                    way.label()
                ),
            );
        }
    }
    (
        Way::R2,
        "no way passed following, capture and input on the demo game, so R2 stays, the \
         design's default, until the failures below are understood"
            .to_string(),
    )
}

fn esc(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

/// A Markdown table: the four checks, then every note any run made, with a
/// column per run.
fn table(corner: &str, runs: &[&Run], head: fn(&Run) -> &'static str) -> String {
    let mut out = format!("| {corner} |");
    for r in runs {
        let _ = write!(out, " {} |", head(r));
    }
    out.push_str("\n|---|");
    out.push_str(&"---|".repeat(runs.len()));
    out.push('\n');
    let mut row = |title: &str, cells: Vec<String>| {
        let _ = write!(out, "| {} |", esc(title));
        for c in cells {
            let _ = write!(out, " {} |", esc(&c));
        }
        out.push('\n');
    };
    for item in Item::ALL {
        row(item.title(), runs.iter().map(|r| r.cell(item)).collect());
    }
    let mut notes: Vec<&str> = Vec::new();
    for (key, _) in runs.iter().flat_map(|r| &r.notes) {
        if !notes.contains(key) {
            notes.push(key);
        }
    }
    for key in notes {
        row(key, runs.iter().map(|r| r.note_cell(key)).collect());
    }
    out
}

/// What the report's first line says about the machine.
#[derive(Debug, Clone, Default)]
struct Header {
    when_ms: u64,
    windows: String,
    scale: f64,
    godot: String,
    blender: String,
}

const BY_EYE: &[&str] = &[
    "A real Veistra menu over a running game, in `pnpm app`: the command palette (Ctrl K) and a \
     pane's context menu. The spike paints a stand-in, and veistra-ui's screenshot is the \
     WebView's own frame, which never shows another program's window, so this is by eye.",
    "Godot editor: Project > Project Settings and a file dialog stay inside the box \
     (`--single-window`).",
    "Blender: Edit > Preferences opens a window of its own; it should come up above Veistra.",
    "Veistra dragged between two monitors with different scales, with the game following.",
];

/// The whole report: header, suggestion, the ways on the demo game, the chosen
/// way on the editor and Blender, and what is left to check by eye.
fn report(
    h: &Header,
    game: &[Run],
    apps: &[Run],
    chosen: Way,
    suggested: &(Way, String),
) -> String {
    let (y, mo, d, hh, mm) = super::takes::utc_minute(h.when_ms);
    let mut out = format!(
        "# Embed spike report (#308)\n\n{y}-{mo:02}-{d:02} {hh:02}:{mm:02} UTC; {}; display \
         scale {}; Godot {}; Blender {}.\n\n**Suggested: {}.** {}. The choice is the owner's: \
         it goes in the R1 or R2 row of `docs/design-notes/godot-play.md`, with these tables.\n",
        h.windows,
        h.scale,
        h.godot,
        h.blender,
        suggested.0.label(),
        suggested.1
    );
    if !game.is_empty() {
        let runs: Vec<&Run> = game.iter().collect();
        let _ = write!(
            out,
            "\n## The demo game, each way\n\n{}",
            table("Check", &runs, |r| r.way.label())
        );
    }
    let mut chosen_runs: Vec<&Run> = game.iter().filter(|r| r.way == chosen).collect();
    chosen_runs.extend(apps);
    if !apps.is_empty() {
        let _ = write!(
            out,
            "\n## {} with the Godot editor and Blender\n\n",
            chosen.label()
        );
        if chosen != suggested.0 {
            out.push_str("Chosen with `VEISTRA_SPIKE_CHOSEN`, over the suggestion.\n\n");
        }
        if apps_way(chosen) != chosen {
            let _ = write!(
                out,
                "`--wid` is Godot's own, so the editor and Blender ran {}: the same owned \
                 popup, made by Veistra.\n\n",
                apps_way(chosen).label()
            );
        }
        out.push_str(&table("Check", &chosen_runs, |r| r.target.label()));
    }
    out.push_str("\n## Still to check by eye\n\n");
    for line in BY_EYE {
        let _ = writeln!(out, "- {line}");
    }
    out
}

/// The way the editor and Blender run for the chosen one.
fn apps_way(chosen: Way) -> Way {
    match chosen {
        Way::R2Wid => Way::R2,
        way => way,
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// The Win32 half: the stand-in Veistra window, the three ways, and the checks.
#[cfg(windows)]
mod win {
    use super::*;
    use crate::embed::{self, CssRect, Embed, Last, Owner, State, Still, WindowSystem};
    use crate::godot::encode::{self, Quality};
    use crate::godot::{record, runner, session};
    use std::cell::Cell;
    use std::sync::Arc;
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{
        GetLastError, SetLastError, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, ClientToScreen, CreateSolidBrush, DeleteObject, EndPaint, FillRect, GetDC,
        GetPixel, InvalidateRect, ReleaseDC, UpdateWindow, HDC, PAINTSTRUCT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::HiDpi::{
        GetAwarenessFromDpiAwarenessContext, GetDpiForWindow, GetWindowDpiAwarenessContext,
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, SetFocus, INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, VK_F13,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows,
        GetClientRect, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, LoadCursorW, MoveWindow,
        PeekMessageW, RegisterClassW, SetCursorPos, SetForegroundWindow, SetParent,
        SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW,
        GWL_EXSTYLE, GWL_STYLE, GW_OWNER, HWND_TOP, IDC_ARROW, MSG, PM_REMOVE, SIZE_MINIMIZED,
        SWP_FRAMECHANGED, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SWP_SHOWWINDOW, SW_MINIMIZE, SW_RESTORE, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN,
        WM_PAINT, WM_SIZE, WM_SYSKEYDOWN, WNDCLASSW, WS_CAPTION, WS_CLIPCHILDREN, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
    };

    const _: () = assert!(
        super::WS_CHILD == windows_sys::Win32::UI::WindowsAndMessaging::WS_CHILD
            && super::WS_CLIPSIBLINGS
                == windows_sys::Win32::UI::WindowsAndMessaging::WS_CLIPSIBLINGS
    );

    /// Where the stand-in window starts each run, in physical pixels.
    const HOME: ScreenRect = ScreenRect {
        x: 80,
        y: 80,
        w: 1280,
        h: 860,
    };

    // What the window procedure reads and counts. All of it lives on the test's
    // thread, which owns every window the spike makes.
    thread_local! {
        static HOST: Cell<isize> = const { Cell::new(0) };
        static PAGE: Cell<isize> = const { Cell::new(0) };
        static POPUP: Cell<isize> = const { Cell::new(0) };
        static MENU_OPEN: Cell<bool> = const { Cell::new(false) };
        static KEYS: Cell<usize> = const { Cell::new(0) };
        static CLICKS: Cell<usize> = const { Cell::new(0) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn last_error(what: &str) -> String {
        format!("{what} failed: {}", std::io::Error::last_os_error())
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_ERASEBKGND => 1,
            WM_SIZE if hwnd as isize == HOST.get() && wp as u32 != SIZE_MINIMIZED => {
                let (w, h) = ((lp & 0xFFFF) as i32, ((lp >> 16) & 0xFFFF) as i32);
                if PAGE.get() != 0 {
                    // SAFETY: the page is this thread's own window.
                    unsafe { MoveWindow(PAGE.get() as HWND, 0, 0, w, h, 1) };
                }
                0
            }
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                KEYS.set(KEYS.get() + 1);
                // SAFETY: passing on a message this thread was given.
                unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
            }
            WM_LBUTTONDOWN => {
                CLICKS.set(CLICKS.get() + 1);
                0
            }
            // SAFETY: as above.
            _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
        }
    }

    /// SAFETY: `dc` is a device context this thread is painting into.
    unsafe fn fill(dc: HDC, r: &RECT, rgb: (u8, u8, u8)) {
        // SAFETY: the brush is made, used and freed here.
        unsafe {
            let brush = CreateSolidBrush(colorref(rgb));
            FillRect(dc, r, brush);
            DeleteObject(brush);
        }
    }

    /// The host is grey, the page purple with the menu on it when open, and
    /// the popup is all menu.
    fn paint(hwnd: HWND) {
        let h = hwnd as isize;
        let mut ps = PAINTSTRUCT::default();
        let mut client = RECT::default();
        // SAFETY: called for this thread's own window from its WM_PAINT, with
        // `ps` alive from BeginPaint to EndPaint.
        unsafe {
            let dc = BeginPaint(hwnd, &mut ps);
            GetClientRect(hwnd, &mut client);
            let base = match h {
                _ if h == PAGE.get() => PAGE_RGB,
                _ if h == POPUP.get() => MENU_RGB,
                _ => HOST_RGB,
            };
            fill(dc, &client, base);
            if h == PAGE.get() && MENU_OPEN.get() {
                let (left, top, right, bottom) = menu_px(box_px((client.right, client.bottom)));
                let menu = RECT {
                    left,
                    top,
                    right,
                    bottom,
                };
                fill(dc, &menu, MENU_RGB);
            }
            EndPaint(hwnd, &ps);
        }
    }

    fn pump() {
        let mut msg = MSG::default();
        // SAFETY: `msg` is a valid out pointer; only this thread's messages
        // are taken and dispatched.
        unsafe {
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    fn pump_for(d: Duration) {
        let end = Instant::now() + d;
        while Instant::now() < end {
            pump();
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Pump until `f` answers, or `limit` passes; with how long it took.
    fn pump_until<T>(limit: Duration, mut f: impl FnMut() -> Option<T>) -> Option<(T, Duration)> {
        let start = Instant::now();
        loop {
            pump();
            if let Some(v) = f() {
                return Some((v, start.elapsed()));
            }
            if start.elapsed() > limit {
                return None;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn window_rect(hwnd: isize) -> ScreenRect {
        let mut r = RECT::default();
        // SAFETY: a stale handle leaves `r` zeroed, which reads as a miss.
        unsafe { GetWindowRect(hwnd as HWND, &mut r) };
        ScreenRect {
            x: r.left,
            y: r.top,
            w: r.right - r.left,
            h: r.bottom - r.top,
        }
    }

    fn visible(hwnd: isize) -> bool {
        // SAFETY: a plain query.
        unsafe { IsWindowVisible(hwnd as HWND) != 0 }
    }

    /// One pixel of what is on the screen, in physical pixels.
    fn pixel((x, y): (i32, i32)) -> u32 {
        // SAFETY: the screen's DC is taken and given back here.
        unsafe {
            let dc = GetDC(std::ptr::null_mut());
            let c = GetPixel(dc, x, y);
            ReleaseDC(std::ptr::null_mut(), dc);
            c
        }
    }

    fn send(inputs: &[INPUT]) {
        // SAFETY: `inputs` is a live slice of fully initialised INPUTs.
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
    }

    /// A real left click at a screen point, through the system's input queue.
    fn click_at((x, y): (i32, i32)) {
        // SAFETY: a plain call.
        unsafe { SetCursorPos(x, y) };
        let button = |flags| {
            let mut i = INPUT {
                r#type: INPUT_MOUSE,
                ..Default::default()
            };
            i.Anonymous.mi = MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            };
            i
        };
        send(&[button(MOUSEEVENTF_LEFTDOWN), button(MOUSEEVENTF_LEFTUP)]);
    }

    /// F13: no program binds it, so a press of it can only be the spike's.
    fn press_f13() {
        let key = |flags| {
            let mut i = INPUT {
                r#type: INPUT_KEYBOARD,
                ..Default::default()
            };
            i.Anonymous.ki = KEYBDINPUT {
                wVk: VK_F13,
                dwFlags: flags,
                ..Default::default()
            };
            i
        };
        send(&[key(0), key(KEYEVENTF_KEYUP)]);
    }

    /// The stand-in Veistra window: a top-level window and the child page.
    struct Host {
        hwnd: HWND,
        page: HWND,
        tid: u32,
        class: Vec<u16>,
        instance: HINSTANCE,
    }

    impl Host {
        fn new() -> Result<Host, String> {
            let class = wide("VeistraEmbedSpike");
            // SAFETY: plain calls; every handle made is checked.
            unsafe {
                // Per-monitor, as Tauri's window is, so every coordinate here
                // is physical pixels.
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let instance = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance,
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                    lpszClassName: class.as_ptr(),
                    ..Default::default()
                };
                if RegisterClassW(&wc) == 0 {
                    return Err(last_error("RegisterClassW"));
                }
                let title = wide("Veistra embed spike (a stand-in Veistra window)");
                let hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_VISIBLE,
                    HOME.x,
                    HOME.y,
                    HOME.w,
                    HOME.h,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    return Err(last_error("CreateWindowExW"));
                }
                HOST.set(hwnd as isize);
                let mut c = RECT::default();
                GetClientRect(hwnd, &mut c);
                let page = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                    0,
                    0,
                    c.right,
                    c.bottom,
                    hwnd,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if page.is_null() {
                    return Err(last_error("CreateWindowExW (page)"));
                }
                PAGE.set(page as isize);
                SetForegroundWindow(hwnd);
                Ok(Host {
                    hwnd,
                    page,
                    tid: GetCurrentThreadId(),
                    class,
                    instance,
                })
            }
        }

        fn id(&self) -> isize {
            self.hwnd as isize
        }

        fn set_rect(&self, r: ScreenRect) {
            // SAFETY: this thread's own window.
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    std::ptr::null_mut(),
                    r.x,
                    r.y,
                    r.w,
                    r.h,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                )
            };
        }

        fn home(&self) {
            // SAFETY: as above.
            unsafe { ShowWindow(self.hwnd, SW_RESTORE) };
            self.set_rect(HOME);
            pump_for(Duration::from_millis(200));
        }

        fn client_size(&self) -> (i32, i32) {
            let mut c = RECT::default();
            // SAFETY: as above.
            unsafe { GetClientRect(self.hwnd, &mut c) };
            (c.right, c.bottom)
        }

        /// A client point on the screen.
        fn to_screen(&self, (x, y): (i32, i32)) -> (i32, i32) {
            let mut p = POINT { x, y };
            // SAFETY: as above, with a valid in/out pointer.
            unsafe { ClientToScreen(self.hwnd, &mut p) };
            (p.x, p.y)
        }

        /// What `embed::host::owner_of` answers for a Tauri window.
        fn owner(&self) -> Owner {
            // SAFETY: as above.
            let dpi = unsafe { GetDpiForWindow(self.hwnd) };
            Owner {
                hwnd: self.id(),
                origin: self.to_screen((0, 0)),
                scale: f64::from(dpi.max(1)) / 96.0,
            }
        }

        /// The box as the pane would send it, in CSS pixels.
        fn box_css(&self) -> CssRect {
            let (b, scale) = (box_px(self.client_size()), self.owner().scale);
            CssRect {
                x: f64::from(b.x) / scale,
                y: f64::from(b.y) / scale,
                w: f64::from(b.w) / scale,
                h: f64::from(b.h) / scale,
            }
        }

        /// Where the game should be on the screen, worked out as Play does.
        fn expected(&self) -> ScreenRect {
            let o = self.owner();
            embed::to_screen(self.box_css(), o.origin, o.scale)
        }

        fn set_menu(&self, open: bool) {
            MENU_OPEN.set(open);
            // SAFETY: this thread's own window, repainted now.
            unsafe {
                InvalidateRect(self.page, std::ptr::null(), 0);
                UpdateWindow(self.page);
            }
        }

        /// A native popup Veistra owns, over the menu's place.
        fn popup(&self) -> HWND {
            let (l, t, r, b) = menu_px(box_px(self.client_size()));
            let (x, y) = self.to_screen((l, t));
            // SAFETY: made, checked by the caller's screen read, and destroyed
            // by `close_popup`.
            unsafe {
                let h = CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    self.class.as_ptr(),
                    std::ptr::null(),
                    WS_POPUP,
                    x,
                    y,
                    r - l,
                    b - t,
                    self.hwnd,
                    std::ptr::null_mut(),
                    self.instance,
                    std::ptr::null(),
                );
                POPUP.set(h as isize);
                SetWindowPos(
                    h,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                h
            }
        }

        fn close_popup(&self, h: HWND) {
            // SAFETY: this thread's own window, made by `popup`.
            unsafe { DestroyWindow(h) };
            POPUP.set(0);
        }

        /// Make Veistra's window the foreground one, as a person would: a
        /// click on the page, left of the box.
        fn activate(&self) {
            click_at(self.to_screen((100, 100)));
            pump_for(Duration::from_millis(250));
        }
    }

    struct Owned<'a> {
        pids: &'a [u32],
        owner: isize,
        found: HWND,
    }

    unsafe extern "system" fn visit_owned(hwnd: HWND, data: LPARAM) -> i32 {
        // SAFETY: `data` is the `&mut Owned` `find_owned` passed, alive for
        // the whole of `EnumWindows`.
        let search = unsafe { &mut *(data as *mut Owned) };
        let mut pid = 0u32;
        // SAFETY: plain queries on a handle the enumeration just gave us.
        let (owner, shown) = unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
            (
                GetWindow(hwnd, GW_OWNER) as isize,
                IsWindowVisible(hwnd) != 0,
            )
        };
        if search.pids.contains(&pid) && owner == search.owner && shown {
            search.found = hwnd;
            return 0;
        }
        1
    }

    /// The first visible window of `pids` owned by `owner`: what `--wid` makes.
    fn find_owned(pids: &[u32], owner: isize) -> Option<isize> {
        let mut search = Owned {
            pids,
            owner,
            found: std::ptr::null_mut(),
        };
        // SAFETY: `visit_owned` reads `search` only during this call.
        unsafe { EnumWindows(Some(visit_owned), &mut search as *mut Owned as LPARAM) };
        (!search.found.is_null()).then_some(search.found as isize)
    }

    /// [`WindowSystem`] for `--wid`: Godot made the window an owned popup
    /// itself, so finding it means finding the host's owned window, and there
    /// are no styles to change or put back. Placing, showing and the still are
    /// the shipped window system's.
    struct Wid {
        owner: isize,
        native: Arc<dyn WindowSystem>,
    }

    impl WindowSystem for Wid {
        fn find_window(&self, pids: &[u32], _kind: Kind) -> Option<isize> {
            find_owned(pids, self.owner)
        }
        fn embed(
            &self,
            _hwnd: isize,
            _owner: isize,
            _mode: embed::Mode,
        ) -> Result<embed::sys::Saved, String> {
            Ok(embed::sys::Saved::default())
        }
        fn place(
            &self,
            hwnd: isize,
            at: ScreenRect,
            shown: bool,
            owner: isize,
            mode: embed::Mode,
        ) -> Result<(), String> {
            self.native.place(hwnd, at, shown, owner, mode)
        }
        fn release(
            &self,
            _: isize,
            _: &embed::sys::Saved,
            _: Option<ScreenRect>,
        ) -> Result<(), String> {
            Ok(())
        }
        fn show_near(&self, hwnd: isize, near: Option<ScreenRect>) -> Result<(), String> {
            self.native.show_near(hwnd, near)
        }
        fn watch(&self, hwnd: isize) -> Option<Box<dyn Still>> {
            self.native.watch(hwnd)
        }
        fn request_close(&self, hwnd: isize) -> Result<(), String> {
            self.native.request_close(hwnd)
        }
    }

    /// A program started for one run, stopped with everything it started when
    /// the run ends, however it ends.
    struct Spawned {
        child: std::process::Child,
        out: PathBuf,
    }

    impl Spawned {
        fn start(program: &Path, args: &[String], out: &Path) -> Result<Spawned, String> {
            std::fs::create_dir_all(out).map_err(io_error(out))?;
            // Forward slashes: Godot's path_join appends one either way.
            let dir = out.display().to_string().replace('\\', "/");
            let child = detect::base_command(program)
                .args(args)
                .env("VEISTRA_SPIKE_OUT", dir)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(io_error(program))?;
            Ok(Spawned {
                child,
                out: out.to_path_buf(),
            })
        }

        fn pid(&self) -> u32 {
            self.child.id()
        }

        fn reports(&self) -> Vec<Report> {
            std::fs::read_to_string(self.out.join("input.jsonl"))
                .map(|t| parse_reports(&t))
                .unwrap_or_default()
        }

        fn count(&self, what: fn(&Report) -> bool) -> usize {
            self.reports().iter().filter(|r| what(r)).count()
        }
    }

    impl Drop for Spawned {
        fn drop(&mut self) {
            runner::kill_tree(self.child.id());
            let _ = self.child.wait();
        }
    }

    /// The game's window, put in the pane one of the three ways.
    enum Placed {
        Child(isize),
        Owned(isize, Arc<Embed>),
    }

    impl Placed {
        fn hwnd(&self) -> isize {
            match self {
                Placed::Child(h) | Placed::Owned(h, _) => *h,
            }
        }

        /// What Veistra does after its window moved or was resized.
        fn follow(&self, host: &Host, resized: bool) {
            match self {
                // A child moves with its parent; only a new box moves it.
                Placed::Child(h) if resized => r1_place(host, *h, true),
                Placed::Child(_) => {}
                Placed::Owned(_, e) if resized => self.show(host, e, true),
                Placed::Owned(_, e) => e.reapply(&host.owner()),
            }
        }

        fn show(&self, host: &Host, e: &Embed, shown: bool) {
            let last = Last {
                rect: host.box_css(),
                visible: shown,
                dpr: None,
            };
            e.set_rect(last, Some(&host.owner()));
        }

        fn set_shown(&self, host: &Host, shown: bool) {
            match self {
                Placed::Child(h) => r1_place(host, *h, shown),
                Placed::Owned(_, e) => self.show(host, e, shown),
            }
        }
    }

    /// R1: the window keeps its own process and thread but becomes a child of
    /// Veistra's window, over the page. Styles first: `SetParent` documents
    /// that a window becoming a child must already be `WS_CHILD`.
    fn r1_embed(host: &Host, hwnd: isize) -> Result<(), String> {
        let h = hwnd as HWND;
        // SAFETY: the handle came from the search; a stale one makes these
        // fail, which is checked.
        unsafe {
            if IsIconic(h) != 0 || IsZoomed(h) != 0 {
                ShowWindow(h, SW_RESTORE);
            }
            let style = GetWindowLongPtrW(h, GWL_STYLE);
            if style == 0 {
                return Err(last_error("GetWindowLongPtrW"));
            }
            SetWindowLongPtrW(h, GWL_STYLE, child_style(style));
            SetWindowLongPtrW(h, GWL_EXSTYLE, child_ex(GetWindowLongPtrW(h, GWL_EXSTYLE)));
            SetLastError(0);
            let previous = SetParent(h, host.hwnd);
            let error = GetLastError();
            if previous.is_null() && error != 0 {
                return Err(format!(
                    "SetParent failed: {}",
                    std::io::Error::from_raw_os_error(error as i32)
                ));
            }
            SetWindowPos(
                h,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
        r1_place(host, hwnd, true);
        Ok(())
    }

    /// A child is placed in its parent's client coordinates.
    fn r1_place(host: &Host, hwnd: isize, shown: bool) {
        let (r, (ox, oy)) = (host.expected(), host.to_screen((0, 0)));
        let flag = if shown {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
        // SAFETY: as in `r1_embed`.
        unsafe {
            SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                r.x - ox,
                r.y - oy,
                r.w,
                r.h,
                SWP_NOACTIVATE | flag,
            )
        };
    }

    /// R2 and R2 with `--wid`: [`Embed`] as Play runs it, of the target's
    /// kind, attached on a thread of its own while this one keeps the
    /// stand-in's messages moving, as Play attaches off the main thread.
    fn r2_embed(host: &Host, game: &Spawned, way: Way, target: Target) -> Result<Placed, String> {
        let win: Arc<dyn WindowSystem> = match way {
            Way::R2Wid => Arc::new(Wid {
                owner: host.id(),
                native: embed::native(),
            }),
            _ => embed::native(),
        };
        let e = Arc::new(Embed::with(win, target.kind()));
        let last = Last {
            rect: host.box_css(),
            visible: true,
            dpr: None,
        };
        e.set_rect(last, None);
        let (owner, pid) = (host.owner(), game.pid());
        let found = std::thread::scope(|s| {
            let t = s.spawn(|| {
                e.attach(
                    None,
                    &|| session::process_tree(pid),
                    &|| Some(owner),
                    &|| true,
                )
            });
            while !t.is_finished() {
                pump();
                std::thread::sleep(Duration::from_millis(2));
            }
            t.join()
        })
        .map_err(|_| "Embed::attach panicked".to_string())?;
        let hwnd = found.ok_or("Embed::attach found no window")?;
        if e.state() != State::Embedded {
            return Err(format!("Embed::attach left it {:?}", e.state()));
        }
        Ok(Placed::Owned(hwnd, e))
    }

    fn follow_check(host: &Host, placed: &Placed, game: &Spawned) -> Check {
        let hwnd = placed.hwnd();
        let gap = || rect_gap(window_rect(hwnd), host.expected());
        let on_box = || (gap() == 0).then_some(());
        let start = window_rect(host.id());
        let mut f = Follow::default();
        for step in 1..=12 {
            host.set_rect(ScreenRect {
                x: start.x + 15 * step,
                ..start
            });
            placed.follow(host, false);
            pump_for(Duration::from_millis(16));
            f.drag_gap = f.drag_gap.max(gap());
        }
        f.moved = pump_until(Duration::from_millis(500), on_box).map(|(_, d)| d);
        let bigger = window_rect(host.id());
        host.set_rect(ScreenRect {
            w: bigger.w + 160,
            h: bigger.h + 100,
            ..bigger
        });
        placed.follow(host, true);
        f.resized = pump_until(Duration::from_millis(500), on_box).map(|(_, d)| d);
        let b = host.expected();
        f.wanted = (b.w as u32, b.h as u32);
        let latest = || {
            game.reports().iter().rev().find_map(|r| match r {
                Report::Ready(s) | Report::Size(s) => Some(*s),
                _ => None,
            })
        };
        f.reported = pump_until(Duration::from_secs(1), || {
            latest().filter(|s| *s == f.wanted)
        })
        .map(|(s, _)| s)
        .or_else(latest);
        // SAFETY: this thread's own window.
        unsafe { ShowWindow(host.hwnd, SW_MINIMIZE) };
        pump_for(Duration::from_millis(400));
        // SAFETY: as above.
        unsafe { ShowWindow(host.hwnd, SW_RESTORE) };
        placed.follow(host, true);
        f.restored = pump_until(Duration::from_millis(800), || {
            (gap() == 0 && visible(hwnd)).then_some(())
        })
        .is_some();
        host.set_rect(start);
        placed.follow(host, true);
        pump_until(Duration::from_millis(500), on_box);
        judge_follow(&f)
    }

    /// `CreateForWindow`, the call the recorder starts with, alone.
    fn capture_item(hwnd: isize) -> Result<(), String> {
        use windows_capture::settings::GraphicsCaptureItemType;
        use windows_capture::window::Window;
        let item: Result<GraphicsCaptureItemType, _> =
            Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void).try_into();
        item.map(|_| ())
            .map_err(|e| format!("{e} (HRESULT {:#010x})", e.code().0))
    }

    /// Play's recorder at the default quality, stopped and its MP4 closed.
    fn record_for(hwnd: isize, path: &Path, d: Duration) -> Result<Stopped, String> {
        let r = record::start(hwnd, path, &Quality::DEFAULT)?;
        pump_for(d);
        let halted = r.halt()?;
        (halted.finish)()?;
        Ok(halted.stopped)
    }

    fn capture_check(
        host: &Host,
        placed: &Placed,
        target: Target,
        run: &mut Run,
        out: &Path,
    ) -> Check {
        let hwnd = placed.hwnd();
        let b = host.expected();
        let c = Capture {
            item: capture_item(hwnd),
            recorded: record_for(hwnd, &out.join("take.mp4"), Duration::from_secs(2)),
            wanted: encode::output_size(b.w as u32, b.h as u32, &Quality::DEFAULT),
            min_frames: target.min_frames(),
        };
        let yes_no =
            |r: Result<(), String>| r.map_or_else(|e| format!("no: {e}"), |()| "yes".into());
        match (placed, &c.item) {
            (Placed::Child(_), Err(_)) => {
                run.note(
                    "Graphics Capture of Veistra's window instead",
                    yes_no(capture_item(host.id())),
                );
            }
            (Placed::Owned(..), Err(_)) => {
                // SAFETY: the game's window, its flag put back straight after.
                let ex = unsafe { GetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE) };
                let tool = WS_EX_TOOLWINDOW as isize;
                // SAFETY: as above.
                unsafe { SetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE, ex & !tool) };
                run.note(
                    "Graphics Capture without WS_EX_TOOLWINDOW",
                    yes_no(capture_item(hwnd)),
                );
                // SAFETY: as above.
                unsafe { SetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE, ex) };
            }
            (_, Ok(())) => {
                placed.set_shown(host, false);
                pump_for(Duration::from_millis(200));
                let hidden = record_for(hwnd, &out.join("hidden.mp4"), Duration::from_secs(1));
                placed.set_shown(host, true);
                pump_until(Duration::from_millis(500), || visible(hwnd).then_some(()));
                run.note(
                    "Frames recorded while the game is hidden",
                    hidden.map_or_else(|e| e, |s| format!("{} in 1 s", s.frames)),
                );
            }
        }
        judge_capture(&c)
    }

    fn menu_check(host: &Host, placed: &Placed, target: Target, run: &mut Run) -> Check {
        let (over, beside) = probe_points(box_px(host.client_size()));
        let (over, beside) = (host.to_screen(over), host.to_screen(beside));
        let shows = |at: (i32, i32), rgb| move || near(pixel(at), rgb).then_some(());
        let window = move || shows_window(target, pixel(over)).then_some(());
        let second = Duration::from_secs(1);
        let mut m = Menu {
            window: pump_until(second, window).is_some(),
            ..Menu::default()
        };
        host.set_menu(true);
        m.drawn = pump_until(Duration::from_millis(500), shows(beside, MENU_RGB)).is_some();
        pump_for(Duration::from_millis(150));
        m.over = near(pixel(over), MENU_RGB);
        let t = Instant::now();
        placed.set_shown(host, false);
        m.swap = pump_until(second, shows(over, MENU_RGB)).map(|_| t.elapsed());
        let t = Instant::now();
        host.set_menu(false);
        placed.set_shown(host, true);
        m.back = pump_until(second, window).map(|_| t.elapsed());
        let popup = host.popup();
        let wins = pump_until(Duration::from_millis(500), shows(over, MENU_RGB)).is_some();
        host.close_popup(popup);
        pump_until(second, window);
        run.note(
            "A native popup Veistra owns shows over the game",
            if wins { "yes" } else { "no" },
        );
        judge_menu(&m)
    }

    fn input_check(
        host: &Host,
        placed: &Placed,
        game: &Spawned,
        target: Target,
        run: &mut Run,
    ) -> Check {
        let mut i = Input {
            listening: game.count(|r| matches!(r, Report::Ready(_))) > 0,
            ..Input::default()
        };
        let b = host.expected();
        i.aim = (target == Target::Game).then(|| (f64::from(b.w / 2), f64::from(b.h / 2)));
        let (before, keys) = (game.reports().len(), KEYS.get());
        let arrived = |key: bool| {
            game.reports().into_iter().skip(before).find(|r| match r {
                Report::Key(k) => key && k == "F13",
                Report::Click { .. } => !key,
                _ => false,
            })
        };
        click_at((b.x + b.w / 2, b.y + b.h / 2));
        if let Some((Report::Click { at, focus }, _)) =
            pump_until(Duration::from_secs(2), || arrived(false))
        {
            i.click = Some(at);
            i.focus = focus;
        }
        press_f13();
        i.key = pump_until(Duration::from_secs(2), || arrived(true)).is_some();
        i.host_keys = KEYS.get() - keys;
        // SAFETY: a plain query.
        let front = unsafe { GetForegroundWindow() } as isize;
        let who = match front {
            f if f == placed.hwnd() => "the game",
            f if f == host.id() => "Veistra's window",
            _ => "another window",
        };
        run.note("Foreground window after clicking the game", who);
        if !i.key {
            // Whether Veistra could fix it: SetFocus works across threads
            // whose input is joined, as a child's is; an owned popup is
            // brought to the front instead.
            // SAFETY: plain calls on the game's window.
            unsafe {
                match placed {
                    Placed::Child(h) => SetFocus(*h as HWND),
                    Placed::Owned(h, _) => {
                        SetForegroundWindow(*h as HWND);
                        std::ptr::null_mut()
                    }
                };
            }
            let before = game.reports().len();
            press_f13();
            let again = pump_until(Duration::from_secs(1), || {
                game.reports()
                    .into_iter()
                    .skip(before)
                    .find(|r| matches!(r, Report::Key(k) if k == "F13"))
            });
            run.note(
                "F13 after Veistra hands the game focus",
                if again.is_some() {
                    "arrived"
                } else {
                    "did not arrive"
                },
            );
        }
        judge_input(&i)
    }

    /// Whether Veistra's own clicks wait for a hung game. Windows joins the
    /// input queues of a child and its parent, and of an owned window and its
    /// owner, when they are on different threads; Godot 4.4's `--wid` undoes
    /// that with `AttachThreadInput(.., FALSE)`, so the second pass does too.
    /// The embedder's R2 already detaches once it owns the window (#309), so
    /// for R2 the first pass measures the shipped detach, and the second's
    /// call reads "refused (not joined)" when it is already apart; for R1 the
    /// first pass is the joined queue.
    fn hang_notes(host: &Host, placed: &Placed, game: &Spawned, run: &mut Run) {
        // SAFETY: a plain query.
        let game_tid =
            unsafe { GetWindowThreadProcessId(placed.hwnd() as HWND, std::ptr::null_mut()) };
        for detach in [false, true] {
            let row = if detach {
                "Veistra's click while the game hangs, input detached"
            } else {
                "Veistra's click while the game hangs"
            };
            if detach {
                // SAFETY: two thread ids; a refusal is reported.
                let ok = unsafe { AttachThreadInput(game_tid, host.tid, 0) } != 0;
                run.note(
                    "AttachThreadInput(game, Veistra, FALSE)",
                    if ok {
                        "succeeded"
                    } else {
                        "refused (not joined)"
                    },
                );
            }
            let (hangs, awakes) = (
                game.count(|r| *r == Report::Hang),
                game.count(|r| *r == Report::Awake),
            );
            if std::fs::write(game.out.join("hang"), "").is_err()
                || pump_until(Duration::from_secs(3), || {
                    (game.count(|r| *r == Report::Hang) > hangs).then_some(())
                })
                .is_none()
            {
                run.note(row, "not measured: the game never hung");
                continue;
            }
            let (clicks, t) = (CLICKS.get(), Instant::now());
            click_at(host.to_screen((100, 100)));
            let handled = pump_until(Duration::from_secs(8), || {
                (CLICKS.get() > clicks).then_some(())
            });
            run.note(
                row,
                handled.map_or("not within 8 s".to_string(), |_| {
                    format!("handled after {}", ms(t.elapsed()))
                }),
            );
            pump_until(Duration::from_secs(8), || {
                (game.count(|r| *r == Report::Awake) > awakes).then_some(())
            });
        }
    }

    /// Whether the window kept the frame and parent it was given: a program
    /// that rewrites its own style on a resize would undo the embed.
    fn frame_note(way: Way, hwnd: isize) -> String {
        // SAFETY: a plain query.
        let style = unsafe { GetWindowLongPtrW(hwnd as HWND, GWL_STYLE) } as u32;
        let caption = style & WS_CAPTION == WS_CAPTION;
        let child = style & super::WS_CHILD != 0;
        match (way, caption, child) {
            (Way::R1, false, true) | (Way::R2 | Way::R2Wid, false, false) => "yes".to_string(),
            _ => format!("no: its style is now {style:#010x}"),
        }
    }

    fn awareness(hwnd: isize) -> &'static str {
        // SAFETY: plain queries.
        match unsafe {
            GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd as HWND))
        } {
            0 => "unaware",
            1 => "system",
            2 => "per monitor",
            _ => "unknown",
        }
    }

    /// What one run needs from the whole spike.
    struct Ctx {
        godot: detect::Found,
        project: PathBuf,
        root: PathBuf,
        blender: Option<PathBuf>,
        script: PathBuf,
    }

    fn run_one(ctx: &Ctx, host: &Host, way: Way, target: Target) -> Run {
        let mut run = Run::new(way, target);
        println!("embed spike: {} with the {}", way.label(), target.label());
        if let Err(e) = attempt(ctx, host, way, target, &mut run) {
            run.note("Harness error", e);
        }
        host.home();
        run
    }

    fn attempt(
        ctx: &Ctx,
        host: &Host,
        way: Way,
        target: Target,
        run: &mut Run,
    ) -> Result<(), String> {
        host.home();
        let out = ctx.root.join(format!("{}-{}", way.id(), target.id()));
        let pane = Last {
            rect: host.box_css(),
            visible: true,
            dpr: None,
        };
        let at = embed::launch_rect(Some(pane), Some(&host.owner()));
        let (program, args) = match target {
            Target::Game => (
                ctx.godot.path.clone(),
                game_args(&ctx.project, way, at, host.id()),
            ),
            Target::Editor => (ctx.godot.path.clone(), editor_args(&ctx.project)),
            Target::Blender => (
                ctx.blender.clone().ok_or("Blender was not found")?,
                blender_args(&ctx.script),
            ),
        };
        let started = Instant::now();
        let game = Spawned::start(&program, &args, &out)?;
        let owned_by = (way == Way::R2Wid).then_some(host.id());
        let find = || {
            let pids = session::process_tree(game.pid());
            match owned_by {
                Some(owner) => find_owned(&pids, owner),
                None => embed::sys::find_window(&pids, target.kind()),
            }
        };
        let (first, _) = pump_until(target.find_for(), find).ok_or_else(|| {
            format!(
                "it showed no window within {} s",
                target.find_for().as_secs()
            )
        })?;
        run.note("Time to its window", ms(started.elapsed()));
        let seen = window_rect(first);
        run.note(
            "First seen at",
            format!("{},{} {}x{}", seen.x, seen.y, seen.w, seen.h),
        );
        let ready = |r: &Report| matches!(r, Report::Ready(_));
        if pump_until(target.find_for(), || (game.count(ready) > 0).then_some(())).is_none() {
            run.note("Reporter", "never started");
        }
        let placed = match way {
            Way::R1 => r1_embed(host, first).map(|()| Placed::Child(first))?,
            Way::R2 | Way::R2Wid => r2_embed(host, &game, way, target)?,
        };
        pump_for(Duration::from_millis(500));
        host.activate();
        let follows = follow_check(host, &placed, &game);
        run.checks.push(follows);
        let capture = capture_check(host, &placed, target, run, &out);
        run.checks.push(capture);
        let menu = menu_check(host, &placed, target, run);
        run.checks.push(menu);
        host.activate();
        let input = input_check(host, &placed, &game, target, run);
        run.checks.push(input);
        run.note(
            "Frame and parent kept through the checks",
            frame_note(way, placed.hwnd()),
        );
        run.note(
            "DPI awareness, Veistra / the window",
            format!("{} / {}", awareness(host.id()), awareness(placed.hwnd())),
        );
        if target == Target::Game {
            hang_notes(host, &placed, &game, run);
        }
        Ok(())
    }

    fn windows_version() -> String {
        std::process::Command::new("cmd")
            .args(["/c", "ver"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "Windows (version unknown)".to_string())
    }

    /// The whole spike: every way on the demo game, then the chosen way on
    /// the editor and Blender. Errors only for a spike that cannot start.
    pub(super) fn spike() -> Result<String, String> {
        let probe = detect::Probe::from_system(&env("VEISTRA_SPIKE_GODOT").unwrap_or_default());
        let resolution =
            detect::resolve(&probe, &|p| detect::ask_version(p, Duration::from_secs(15)));
        let godot = resolution
            .found
            .ok_or_else(|| format!("no Godot 4 found: {}", resolution.problems.join("; ")))?;
        let ways = parse_list(env("VEISTRA_SPIKE_WAYS").as_deref(), &Way::ALL, Way::id)?;
        let targets = parse_list(
            env("VEISTRA_SPIKE_TARGETS").as_deref(),
            &Target::ALL,
            Target::id,
        )?;
        let root = std::env::temp_dir()
            .join("veistra-embed-spike")
            .join(runner::now_ms().to_string());
        let project = root.join("project");
        write_project(&demo_dir(), &project)?;
        let script = root.join("blender_reporter.py");
        std::fs::write(&script, BLENDER_REPORTER).map_err(io_error(&script))?;
        let blender = crate::blender::detect::find(&crate::blender::detect::RealHost, "")
            .hit
            .map(|(_, p)| p);
        let blender_version = blender
            .as_deref()
            .and_then(crate::blender::detect::probe_version)
            .map_or("not found".to_string(), |(v, _)| v);

        let host = Host::new()?;
        println!("embed spike: hands off the mouse and keyboard until the report prints.");
        for n in (1..=5).rev() {
            println!("  {n}");
            pump_for(Duration::from_secs(1));
        }
        let header = Header {
            when_ms: runner::now_ms(),
            windows: windows_version(),
            scale: host.owner().scale,
            godot: format!("{} ({})", godot.version, godot.path.display()),
            blender: blender_version,
        };
        let ctx = Ctx {
            godot,
            project,
            root,
            blender,
            script,
        };
        let mut game_runs = Vec::new();
        for way in ways.iter().filter(|_| targets.contains(&Target::Game)) {
            game_runs.push(
                if *way == Way::R2Wid && !wid_supported(ctx.godot.major, ctx.godot.minor) {
                    Run::not_run(*way, Target::Game, "needs Godot 4.4 or later")
                } else {
                    run_one(&ctx, &host, *way, Target::Game)
                },
            );
        }
        let suggested = verdict(&game_runs);
        let chosen = match env("VEISTRA_SPIKE_CHOSEN") {
            Some(id) => parse_list(Some(&id), &Way::ALL, Way::id)?
                .first()
                .copied()
                .unwrap_or(suggested.0),
            None => suggested.0,
        };
        let for_apps = apps_way(chosen);
        let mut app_runs = Vec::new();
        for target in [Target::Editor, Target::Blender] {
            if !targets.contains(&target) {
                continue;
            }
            app_runs.push(if target == Target::Blender && ctx.blender.is_none() {
                Run::not_run(for_apps, target, "Blender was not found")
            } else {
                run_one(&ctx, &host, for_apps, target)
            });
        }
        Ok(report(&header, &game_runs, &app_runs, chosen, &suggested))
    }
}

#[cfg(windows)]
#[test]
#[ignore = "Windows 11 desktop with Godot 4 (and Blender for its column); run with pnpm spike:embed"]
fn r1_against_r2() {
    let report = win::spike().unwrap_or_else(|e| panic!("the embed spike could not start: {e}"));
    let path = env("VEISTRA_SPIKE_REPORT").map_or_else(
        || {
            std::env::temp_dir()
                .join("veistra-embed-spike")
                .join("report.md")
        },
        PathBuf::from,
    );
    std::fs::write(&path, &report).unwrap();
    println!("{report}\nThe report is in {}", path.display());
}

/// Elsewhere `pnpm spike:embed` still finds the test, and says why it cannot run.
#[cfg(not(windows))]
#[test]
#[ignore = "Windows 11 only; run with pnpm spike:embed there"]
fn r1_against_r2() {
    panic!("the embed spike places Win32 windows, so it runs on Windows 11 only");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passed(way: Way, target: Target, items: &[Item]) -> Run {
        let mut run = Run::new(way, target);
        for item in Item::ALL {
            run.checks
                .push(Check::new(item, items.contains(&item), "seen".to_string()));
        }
        run
    }

    #[test]
    fn the_table_has_a_row_per_check_and_note_and_a_column_per_way() {
        let mut r1 = passed(Way::R1, Target::Game, &[Item::Follows]);
        r1.note("Graphics Capture of Veistra's window instead", "yes");
        r1.checks[3] = Check::unmeasured(Item::Menu, "a | b");
        let r2 = passed(Way::R2, Target::Game, &Item::ALL);
        let wid = Run::not_run(Way::R2Wid, Target::Game, "needs Godot 4.4 or later");
        let text = table("Check", &[&r1, &r2, &wid], |r| r.way.label());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            "| Check | R1 child window | R2 owned popup | R2 with --wid |"
        );
        assert_eq!(lines[1], "|---|---|---|---|");
        assert_eq!(lines.len(), 2 + Item::ALL.len() + 1);
        assert_eq!(
            lines[2],
            "| Follows a Veistra move and resize | **yes**: seen | **yes**: seen | not run: needs \
             Godot 4.4 or later |"
        );
        assert!(lines[3].starts_with("| Graphics Capture accepts the window | **no**: seen |"));
        assert!(lines[5].contains("not measured: a \\| b"), "{}", lines[5]);
        assert_eq!(
            lines[6],
            "| Graphics Capture of Veistra's window instead | yes | - | - |"
        );
    }

    #[test]
    fn the_verdict_prefers_r2_then_wid_then_r1_on_the_three_deciding_checks() {
        let all = Item::ALL;
        let no_menu = [Item::Follows, Item::Capture, Item::Input];
        let runs = [
            passed(Way::R1, Target::Game, &all),
            passed(Way::R2, Target::Game, &no_menu),
            passed(Way::R2Wid, Target::Game, &all),
        ];
        assert_eq!(verdict(&runs).0, Way::R2, "the menu decides nothing");

        let runs = [
            passed(Way::R1, Target::Game, &all),
            passed(Way::R2, Target::Game, &[Item::Follows, Item::Input]),
            passed(Way::R2Wid, Target::Game, &all),
        ];
        assert_eq!(verdict(&runs).0, Way::R2Wid);

        let runs = [
            passed(Way::R1, Target::Game, &all),
            passed(Way::R2, Target::Game, &[Item::Capture]),
            Run::not_run(Way::R2Wid, Target::Game, "old Godot"),
            passed(Way::R2Wid, Target::Editor, &all),
        ];
        assert_eq!(verdict(&runs).0, Way::R1, "only the game's runs count");

        let (way, why) = verdict(&[passed(Way::R1, Target::Game, &[])]);
        assert_eq!(
            way,
            Way::R2,
            "nothing passed, so the design's default stays"
        );
        assert!(why.contains("no way passed"));
    }

    #[test]
    fn an_r1_window_is_a_clipping_child_with_no_frame_popup_states_or_taskbar_flags() {
        let framed = 0x14CF_0000_isize; // WS_OVERLAPPEDWINDOW | WS_VISIBLE
        let style = child_style(framed | styles::WS_MAXIMIZE as isize);
        assert_eq!(style, (WS_CHILD | WS_CLIPSIBLINGS) as isize);
        let popup = child_style(styles::WS_POPUP as isize | 0x0000_0004);
        assert_eq!(popup, (WS_CHILD | WS_CLIPSIBLINGS | 0x0000_0004) as isize);
        let ex = (styles::WS_EX_APPWINDOW | styles::WS_EX_TOOLWINDOW | 0x0000_0008) as isize;
        assert_eq!(child_ex(ex), 0x0000_0008);
    }

    #[test]
    fn the_spike_project_loads_both_reporters_and_keeps_the_demo_s_scene() {
        let demo = std::fs::read_to_string(demo_dir().join("project.godot")).unwrap();
        let text = spike_project_godot(&demo);
        let parsed = detect::parse_project_file(&text);
        assert_eq!(
            parsed.main_scene.as_deref(),
            Some("res://levels/hallway.tscn")
        );
        assert_eq!(parsed.config_version, Some(5));
        assert!(text
            .contains("[autoload]\n\nVeistraSpike=\"*res://addons/veistra_spike/reporter.gd\"\n"));
        assert!(text.contains(
            "[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/veistra_spike/plugin.cfg\")\n"
        ));

        let existing = "config_version=5\n\n[autoload]\n\nOther=\"*res://other.gd\"\n";
        let text = spike_project_godot(existing);
        assert_eq!(text.matches("[autoload]").count(), 1);
        assert!(text.contains(
            "[autoload]\nVeistraSpike=\"*res://addons/veistra_spike/reporter.gd\"\n\nOther="
        ));
    }

    #[test]
    fn the_project_copy_adds_the_reporters_and_leaves_out_the_import_cache() {
        let dir = tempfile::TempDir::new().unwrap();
        let demo = dir.path().join("demo");
        std::fs::create_dir_all(demo.join("levels")).unwrap();
        std::fs::create_dir_all(demo.join(".godot/imported")).unwrap();
        std::fs::write(demo.join("project.godot"), "config_version=5\n").unwrap();
        std::fs::write(demo.join("levels/a.tscn"), "[gd_scene]\n").unwrap();
        std::fs::write(demo.join(".godot/imported/x"), "cache").unwrap();
        let copy = dir.path().join("copy");

        write_project(&demo, &copy).unwrap();

        assert!(copy.join("levels/a.tscn").is_file());
        assert!(!copy.join(".godot").exists());
        for name in ["reporter.gd", "editor_reporter.gd", "plugin.cfg"] {
            assert!(copy.join(ADDON).join(name).is_file(), "{name}");
        }
        let project = std::fs::read_to_string(copy.join("project.godot")).unwrap();
        assert!(project.contains("VeistraSpike="));
        assert!(
            std::fs::read_to_string(demo.join("project.godot"))
                .unwrap()
                .find("Veistra")
                .is_none(),
            "the demo itself is left alone"
        );
        let cfg = std::fs::read_to_string(copy.join(ADDON).join("plugin.cfg")).unwrap();
        assert!(cfg.contains("script=\"editor_reporter.gd\""));
    }

    #[test]
    fn wid_goes_only_to_its_own_way_and_single_window_only_to_the_editor() {
        let project = Path::new("C:/spike/project");
        let at = LaunchRect {
            width: 800,
            height: 450,
            position: Some((280, 200)),
        };
        let r2 = game_args(project, Way::R2, at, 0x1234);
        assert_eq!(
            r2,
            [
                "--path",
                "C:/spike/project",
                "--windowed",
                "--resolution",
                "800x450",
                "--position",
                "280,200"
            ],
            "at the box, as Play launches it"
        );
        assert_eq!(game_args(project, Way::R1, at, 0x1234), r2);
        let wid = game_args(project, Way::R2Wid, at, 0x1234);
        assert_eq!(wid[..r2.len()], r2[..]);
        assert_eq!(
            wid[r2.len()..],
            ["--wid", "4660"],
            "decimal, as Godot reads it"
        );
        assert_eq!(
            editor_args(project),
            ["--editor", "--single-window", "--path", "C:/spike/project"]
        );
        assert_eq!(
            blender_args(Path::new("r.py")),
            ["--factory-startup", "--python", "r.py"]
        );
        assert!(!wid_supported(4, 3));
        assert!(wid_supported(4, 4));
        assert!(wid_supported(5, 0));
    }

    #[test]
    fn reports_parse_sizes_keys_clicks_and_the_hang_and_skip_a_torn_line() {
        let text = concat!(
            "{\"kind\":\"ready\",\"size\":[800,450],\"ms\":1}\n",
            "{\"kind\":\"size\",\"size\":[960.0,550.0],\"ms\":2}\n",
            "{\"kind\":\"key\",\"keycode\":4194344,\"key\":\"F13\",\"ms\":3}\n",
            "{\"kind\":\"click\",\"at\":[400,225],\"focus\":true,\"ms\":4}\n",
            "{\"kind\":\"click\",\"at\":[1,2],\"button\":\"LEFTMOUSE\",\"ms\":5}\n",
            "{\"kind\":\"hang\",\"ms\":6}\n{\"kind\":\"awake\",\"ms\":7}\n",
            "{\"kind\":\"later\"}\nnot json\n{\"kind\":\"key\",\"ke",
        );
        assert_eq!(
            parse_reports(text),
            [
                Report::Ready((800, 450)),
                Report::Size((960, 550)),
                Report::Key("F13".into()),
                Report::Click {
                    at: (400.0, 225.0),
                    focus: Some(true)
                },
                Report::Click {
                    at: (1.0, 2.0),
                    focus: None
                },
                Report::Hang,
                Report::Awake,
            ]
        );
    }

    #[test]
    fn following_passes_only_when_every_step_settles_and_the_size_is_reported() {
        let good = Follow {
            drag_gap: 9,
            moved: Some(Duration::from_millis(20)),
            resized: Some(Duration::from_millis(40)),
            reported: Some((960, 550)),
            wanted: (960, 550),
            restored: true,
        };
        let check = judge_follow(&good);
        assert_eq!(check.pass, Some(true));
        assert!(check.detail.contains("9 px behind"), "{}", check.detail);
        for bad in [
            Follow {
                moved: None,
                ..good.clone()
            },
            Follow {
                resized: Some(Duration::from_millis(250)),
                ..good.clone()
            },
            Follow {
                reported: Some((800, 450)),
                ..good.clone()
            },
            Follow {
                restored: false,
                ..good.clone()
            },
        ] {
            assert_eq!(judge_follow(&bad).pass, Some(false), "{bad:?}");
        }
    }

    #[test]
    fn capture_passes_on_an_accepted_item_and_a_take_of_the_box_s_even_size() {
        let take = Stopped {
            first_frame_ms: Some(1),
            frames: 58,
            dropped: 0,
            width: 960,
            height: 550,
        };
        let good = Capture {
            item: Ok(()),
            recorded: Ok(take),
            wanted: (960, 550),
            min_frames: 30,
        };
        assert_eq!(judge_capture(&good).pass, Some(true));
        let refused = Capture {
            item: Err("E_INVALIDARG (HRESULT 0x80070057)".into()),
            ..good.clone()
        };
        let check = judge_capture(&refused);
        assert_eq!(check.pass, Some(false));
        assert!(check.detail.contains("0x80070057"));
        let few = Capture {
            recorded: Ok(Stopped { frames: 3, ..take }),
            ..good.clone()
        };
        assert_eq!(judge_capture(&few).pass, Some(false));
        assert_eq!(
            judge_capture(&Capture {
                min_frames: 1,
                ..few
            })
            .pass,
            Some(true),
            "the editor redraws only on change"
        );
        let padded = Capture {
            recorded: Ok(Stopped {
                width: 1280,
                height: 720,
                ..take
            }),
            ..good
        };
        assert_eq!(judge_capture(&padded).pass, Some(false));
    }

    #[test]
    fn input_passes_when_the_key_and_click_reach_the_game_and_not_veistra() {
        let good = Input {
            listening: true,
            key: true,
            click: Some((400.0, 226.0)),
            aim: Some((400.0, 225.0)),
            host_keys: 0,
            focus: Some(true),
        };
        assert_eq!(judge_input(&good).pass, Some(true));
        let elsewhere = Input {
            click: Some((10.0, 10.0)),
            ..good.clone()
        };
        assert_eq!(judge_input(&elsewhere).pass, Some(false));
        let stolen = Input {
            host_keys: 1,
            ..good.clone()
        };
        assert_eq!(judge_input(&stolen).pass, Some(false));
        let editor = Input {
            click: Some((10.0, 10.0)),
            aim: None,
            ..good.clone()
        };
        assert_eq!(judge_input(&editor).pass, Some(true));
        let deaf = Input {
            listening: false,
            ..good
        };
        assert_eq!(judge_input(&deaf).pass, None);
    }

    #[test]
    fn the_menu_passes_over_the_game_or_by_a_quick_swap_and_needs_both_colours() {
        let swap = Menu {
            window: true,
            drawn: true,
            over: false,
            swap: Some(Duration::from_millis(30)),
            back: Some(Duration::from_millis(60)),
        };
        assert_eq!(judge_menu(&swap).pass, Some(true));
        let slow = Menu {
            back: Some(Duration::from_millis(300)),
            ..swap.clone()
        };
        assert_eq!(judge_menu(&slow).pass, Some(false));
        let over = Menu {
            over: true,
            swap: None,
            back: None,
            ..swap.clone()
        };
        assert_eq!(judge_menu(&over).pass, Some(true));
        let unseen = Menu {
            window: false,
            ..swap.clone()
        };
        let check = judge_menu(&unseen);
        assert_eq!(check.pass, None);
        assert!(
            check.detail.contains("window never showed"),
            "{}",
            check.detail
        );
        let blind = Menu {
            drawn: false,
            ..swap
        };
        assert_eq!(judge_menu(&blind).pass, None);
    }

    #[test]
    fn the_reads_land_in_the_game_s_patch_and_beside_the_box_and_both_in_the_menu() {
        let b = box_px((1264, 801));
        assert_eq!((b.x, b.y, b.w, b.h), (200, 120, 784, 451));
        let (over, beside) = probe_points(b);
        let (l, t, r, bottom) = menu_px(b);
        let inside = |(x, y): (i32, i32)| x > l && x < r && y > t && y < bottom;
        assert!(inside(over) && inside(beside));
        // The reporter's patch is 240 x 180 at the game's top right.
        assert!(over.0 > b.x + b.w - 240 && over.0 < b.x + b.w);
        assert!(over.1 > b.y && over.1 < b.y + 180);
        assert!(beside.1 < b.y && t >= 0, "above the box, in the window");
        assert_eq!(box_px((300, 300)).w, 64, "never smaller than a usable box");
    }

    #[test]
    fn colours_match_within_a_tolerance_and_never_off_screen() {
        assert_eq!(colorref((1, 2, 3)), 0x0003_0201);
        assert!(near(colorref((250, 10, 245)), MENU_RGB));
        assert!(!near(colorref(PAGE_RGB), MENU_RGB));
        assert!(!near(0xFFFF_FFFF, (255, 255, 255)), "CLR_INVALID");
        let editor_grey = colorref((33, 37, 43));
        assert!(shows_window(Target::Game, colorref(PATCH_RGB)));
        assert!(
            !shows_window(Target::Game, editor_grey),
            "only the patch is the game"
        );
        assert!(shows_window(Target::Editor, editor_grey));
        assert!(!shows_window(Target::Blender, colorref(PAGE_RGB)));
        assert!(!shows_window(Target::Blender, colorref(MENU_RGB)));
        assert!(!shows_window(Target::Editor, 0xFFFF_FFFF));
        let a = ScreenRect {
            x: 10,
            y: 10,
            w: 100,
            h: 50,
        };
        assert_eq!(rect_gap(a, a), 0);
        assert_eq!(rect_gap(a, ScreenRect { x: 13, w: 97, ..a }), 3);
    }

    #[test]
    fn ways_and_targets_parse_from_their_variables() {
        assert_eq!(parse_list(None, &Way::ALL, Way::id).unwrap(), Way::ALL);
        assert_eq!(
            parse_list(Some(" r2 ,R1,r2"), &Way::ALL, Way::id).unwrap(),
            [Way::R2, Way::R1]
        );
        assert_eq!(
            parse_list(Some("blender"), &Target::ALL, Target::id).unwrap(),
            [Target::Blender]
        );
        let e = parse_list(Some("r3"), &Way::ALL, Way::id).unwrap_err();
        assert!(e.contains("r1, r2, r2wid"), "{e}");
    }

    #[test]
    fn the_report_suggests_a_way_and_puts_the_chosen_way_s_runs_side_by_side() {
        let game = [
            passed(Way::R1, Target::Game, &[]),
            passed(Way::R2, Target::Game, &Item::ALL),
        ];
        let apps = [
            passed(Way::R2, Target::Editor, &Item::ALL),
            Run::not_run(Way::R2, Target::Blender, "Blender was not found"),
        ];
        let header = Header {
            when_ms: 1_793_793_600_000,
            windows: "Microsoft Windows [Version 10.0.26100.1]".into(),
            scale: 1.5,
            godot: "4.4.1.stable".into(),
            blender: "not found".into(),
        };
        let text = report(&header, &game, &apps, Way::R2, &verdict(&game));
        assert!(text.contains("2026-11-04 12:00 UTC"), "{text}");
        assert!(text.contains("**Suggested: R2 owned popup.**"));
        assert!(text.contains("| Check | R1 child window | R2 owned popup |\n"));
        assert!(text.contains("## R2 owned popup with the Godot editor and Blender"));
        assert!(text.contains("| Check | Demo game | Godot editor | Blender |\n"));
        assert!(text.contains("not run: Blender was not found"));
        assert!(text.contains("## Still to check by eye"));
        assert!(!text.contains("VEISTRA_SPIKE_CHOSEN") && !text.contains("Godot's own"));

        let mut wid = passed(Way::R2Wid, Target::Game, &Item::ALL);
        wid.note("Time to its window", "900 ms");
        let game = [game[0].clone(), wid];
        let text = report(&header, &game, &apps, Way::R2Wid, &verdict(&game));
        assert!(text.contains("**Suggested: R2 with --wid.**"));
        assert!(text.contains("## R2 with --wid with the Godot editor and Blender"));
        assert!(text.contains("the editor and Blender ran R2 owned popup"));
        assert!(
            text.contains("| Time to its window | 900 ms | - | - |"),
            "the game column is the --wid run: {text}"
        );
        let text = report(&header, &game, &apps, Way::R1, &verdict(&game));
        assert!(text.contains("Chosen with `VEISTRA_SPIKE_CHOSEN`"));
    }

    #[test]
    fn the_design_note_holds_the_empty_table_this_spike_fills() {
        let note = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/design-notes/godot-play.md");
        let text = std::fs::read_to_string(note).unwrap();
        let header = format!(
            "| Check | {} | {} | {} |",
            Way::R1.label(),
            Way::R2.label(),
            Way::R2Wid.label()
        );
        assert!(text.contains(&header), "the template's header row");
        for item in Item::ALL {
            assert!(
                text.contains(&format!("| {} | pending |", item.title())),
                "{}",
                item.title()
            );
        }
        assert!(text.contains("| Check | Demo game | Godot editor | Blender |"));
        assert!(text.contains("pnpm spike:embed"));
    }
}
