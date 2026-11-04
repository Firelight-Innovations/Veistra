# Godot: Play, the Godot Viewer, and Open in Godot

Code: `src-tauri/src/godot/` (`detect`, `runner`, `addon`, `scene`, `rpc`), routed from
`apps/play.rs` and `apps/godot_viewer.rs`. Frontends: `apps/play/ui`, `apps/godot-viewer/ui`,
shared types in `apps/shared/godot.ts`.

The rule everything obeys is `VEISTRA-UX-REWORK.md` section 3.1: Godot is never embedded in the
webview. It is a native process Veistra starts, watches and stops.

## Section 9.2, decided: a native run

Play runs `godot --path <project>` as a child process of the environment. The game opens in its
own window and the pane shows what Veistra can honestly know about it: state, an stdout/stderr
log with errors and warnings highlighted, and pause, restart and stop.

The alternative was a web export shown in the pane. It was rejected because it needs an export
template and a build step before the first frame, changes what the game is (WebGL, no threads,
no native extensions), and would make "Play" mean a different program from the one that ships.
A native run needs nothing but the engine, and what it shows is what the player gets.

Cost: the frame is not in the pane. That is what Capture was for, until the game moved into
the pane: see "The game in the pane", below.

## Finding the engine

`detect.rs`. An explicit `godot.executablePath` setting is authoritative: a bad value is
reported, never silently replaced by another install. With no setting, the order is the
`GODOT4`/`GODOT` variables, `PATH`, common install folders, then Steam libraries. The first
that answers `--version` with a 4.x wins. On Windows the `_console.exe` sibling is preferred
for runs, because the GUI-subsystem exe writes nothing to a pipe. A found engine is remembered
until the setting changes or the pane asks to check again; a failed search is never cached.

Projects are `project.godot` files at or below the environment root (four folders deep,
skipping `.git`, `.godot`, `node_modules`, `.veistra`, `addons`). With several, the pane offers a
picker. A `config_version` of 4 or less is Godot 3 and is refused with a message.

## The run

`runner.rs`. One run per cluster. stdout and stderr are read on their own threads into a
bounded log (4000 lines, oldest dropped, drops counted). Lines are classified from the prefixes
Godot prints (`ERROR:`, `SCRIPT ERROR:`, `WARNING:`), and indented `at:` lines inherit the level
of the line they follow. The pane polls `play/state` with a cursor every 500 ms.

Stop kills the whole tree: `taskkill /T /F` on Windows, the process group on Unix, so the game
window and anything it spawned go with it. `RunEvent::Exit` calls `Godot::shutdown`, so no game
outlives Veistra. `Stopped` (asked for) and `Exited { code }` (the game ended) are different
states.

## Capture & comment, and pause

Godot has no external "give me a frame" interface, so a real screenshot needs code inside the
game. That is the capture addon: one GDScript autoload, opt in per project, consent-gated,
removable.

- Enable adds `addons/veistra/veistra_capture.gd` and one `[autoload]` line to `project.godot`.
  Disable removes exactly those, leaving anything else in `addons/veistra/` alone.
- The channel is a folder in the OS temp directory, passed as `-- --veistra-dir=<dir>`. Veistra
  writes `cmd.json` (atomically), the script answers `res-<id>.json`. No socket, no listener,
  no network. A reply may not name a file outside its own folder.
- Without the addon, Capture and Pause are disabled and say why. Nothing is faked.

## The game in the pane, takes, notes (design v0.1, 2026-10-30)

The "Play, Scene and Blender views" design (canvas "Veistra — Play, Scene and Blender views")
moves the game into the pane, records runs as takes, and closes the loop with an agent. The
native run above still holds: the game is its own process, and a crash in it never takes
Veistra down.

**The game in the pane** (`embed.rs`, Windows). After spawn, the game's window is found by
process (the game and its children, since `_console.exe` starts the real executable), its
caption and borders removed, `WS_EX_TOOLWINDOW` set, and made owned by the Veistra window. The
pane sends `play/embed-rect` with its game box in window CSS pixels; Rust adds the window's
client origin and scale. The game is launched with `--windowed --resolution <pane size>
--position -32000,-32000` so it never flashes in the wrong place. Rust hides it whenever its
cluster is off screen or Play is not the active tab (`live::sync_visibility`, from the shell
state, beside the Plane webview's). With no embedder (macOS, Linux) or no window within 10 s,
the game keeps its own window and the live strip says so.

**Airspace.** The game paints above the WebView. The shell reports its open overlays (menus,
popovers, dialogs, the palette, the drag ghost, and a takeover or expanded page that covers the
whole tool window) to Play as `veistra/overlays` (`src/shell/overlayWatch.ts`), and Play hides
the game and shows its last frame while one covers the box.

**Takes** (`record.rs`, `takes.rs`, `session.rs`). Record is per project, per computer, off by
default, and needs addon v2 and Windows. A take is `.veistra/takes/<utc minute>-<4 hex>/` with
`take.mp4`, `telemetry.jsonl`, `log.jsonl`, `take.json` and `notes.json`; the last ten are kept,
plus any with drafts, and `.git/info/exclude` keeps them out of git. On read-only main they go
under the app's data instead. Time zero is the first video frame's wall-clock time; telemetry
and the log carry wall time, so every lane lines up on one clock.

**Addon v2** (`veistra_capture.gd`) writes a tick ten times a second (scene, camera, player,
the longest frame since the tick before, the viewport and the box the window shows it in, the
mouse mode, tracked node boxes, and its own cost as `tickUs`), marks for F8, and keys F7 and
Ctrl Shift M. It handles those three in `_input` from the root's last child, with their repeats
and releases, so the game's input callbacks never see them. Tracked nodes are the
`veistra_track` group when it has members, else physics bodies and the geometry and sprites
that are not part of one, in view by their box's centre, nearest 64. `pick` is answered in the
physics frame: a camera ray, a 2D point query, then the smallest tracked box. The addon does
nothing without `--veistra-dir`, and nothing in an exported build whatever its arguments.

The pane shows "Update capture" whenever the installed script is not this build's text (a v1
script, or an earlier v2, whose game keeps its channel until the update). Stop sends the addon
`flush` before the take copies its telemetry, and `take.json`'s `ticks`, `tickRate`,
`tickUsP95` and `tickNodes` count only the take's own ticks. `examples/godot-demo` is the game
the acceptance runs use, and its README is the procedure (#312).

**Send** (`feedback.rs`) writes `.veistra/feedback/<take>-<n>/` with `packet.md` and per note
`markup.png`, `markup.json`, `contact.png`, `frames/` and `context.json`, files each note as a
comment with a `take` anchor, and the page attaches `packet.md` at the agent's prompt. Agents
use `list_play_notes`, `start_play_note` and `resolve_play_note` on the workspace server, or
on the context server from an agent tab.

### Decisions

| Decision | Chosen | Why, and what was rejected |
|---|---|---|
| R1 child window or R2 owned popup | R2, provisional: the owner chooses from the embed spike's Windows 11 run (#308, below) | Graphics Capture records the game window alone, never Veistra's UI, and R2 is what `embed.rs` builds. R1 (`SetParent`) exists only in the spike, which also tries `CreateForWindow` on a child window. |
| One Godot app or two | Two, with the shared toolbar | Scene · Play switches between the apps (`veistra/open`). Folding Play into the Godot app (open decision 1) is left for the owner; it is a move, not a rewrite. |
| Record default | Off | Takes cost disk (open decision 2's recommendation). |
| Tracked nodes | The design's default, with geometry for its "VisualInstance3D" | `veistra_track` when it has members, else bodies, plus the geometry and sprites not inside one, in view by their box's centre, nearest 64. VisualInstance3D also takes in lights, probes and decals; a body's own mesh tracked beside it could take a pin that should name the body; and a character's origin is at its feet, below a frame that shows the rest of it (#312). |
| Video clip in the packet | Not built | The agent reads the contact sheet; the checkbox is shown disabled with why. |
| Retention | Ten takes | Open decision 7. |
| Video size | The window's, not 720p | `windows-capture` crops or pads, it does not scale. The bitrate is fixed at 3.5 Mbit/s, under 60 MB for two minutes. A D3D11 scaling pass is the follow-up. |
| Where pick's physics query runs (#312) | `_physics_process`; the command poll only queues the pick | Godot makes the direct space state safe there alone: from `_process` it refuses with physics on its own thread, and Jolt refuses while it steps, so the pick fell back to boxes without saying why. The node runs while paused, so a pick still answers during Mark up. |
| Exported builds (#312) | Inert whenever `OS.has_feature("template")` | Relying on a missing `--veistra-dir` alone was rejected: a shipped game started with the argument by hand would write telemetry and answer commands, against §5.5 rule 6 and the consent text. |
| When Update capture is offered (#312) | Whenever the installed script's text is not this build's, CRLF read as LF; an earlier v2 goes out as `partial` but keeps its channel | The marker alone called every earlier v2 current, so no fix to the script ever reached a project that had one. Treating an earlier v2 as a broken install was rejected: its game would lose capture and Rec until updated. |
| The take's last second of ticks (#312) | Stop sends the addon `flush` (600 ms at most, only while the game runs) before the copy; commands to one channel take turns | The addon flushes once a second, so up to a second was missing. Flushing every tick costs a write a tick. The game reads one `cmd.json`, so a flush landing during the pane's pick would have replaced it. |
| Veistra's keys and the game (#312) | Handled in `_input` by the root's last child, with the key's repeats and release; an InputMap action bound to the key is released | `Window.window_input` was rejected: `push_input` resets the handled flag after it. Two leaks remain: a game polling `Input.is_key_pressed` or `is_action_just_pressed` sees the press in its frame, and a key pressed while the game's own embedded sub-window has focus goes to that window. Staying last means a game that takes the root's last child for its scene finds the addon; `current_scene` is unaffected. The demo's clock counts what reaches the game. |
| Toolbar marks (#312) | Kept out of `telemetry.jsonl`; `take.json` `marks` merges them with F8's, and `play/state` counts F8's apart as `f8Marks` | The game is the only writer of its telemetry file, so no two writers interleave lines in it. `mark_dropped` (#314) needs F8's told apart. |
| Demo game (#312) | `examples/godot-demo`: text scenes, no textures, no autoload line | The game the earlier runs used was a folder on one machine. Text scenes need no import, a test holds them to the names the checks use, and Enable capture adds the autoload as it would in any project. |
| What the spike measures as R2 (#308) | `embed.rs` itself, through `Embed::default()`, unchanged; `--wid` through the same `Embed` with a window system that finds the window Godot made owned | A copy of the R2 code inside the spike could pass while Play's own code fails. |
| R2 with `--wid` as a third way (#308) | Measured on the demo game with Godot 4.4 or later; if it wins, the editor and Blender run plain R2 | It is how Godot's own editor embeds a game: Godot makes the owned popup itself, detaches its input from the owner's thread and skips its off-screen clamp. Only Godot takes the argument. |
| How the spike sees a menu over the game (#308) | Screen pixels: a stand-in menu the page paints, read over the game reporter's green patch and beside the box | veistra-ui's screenshot is WebView2's own frame, which never shows another program's window, so it cannot see airspace. A real Veistra menu over a real game stays a by-eye check, listed in the report. The menu ranks no way: §4.3's still swap shows menus whichever wins. |
| A hung game and Veistra's input (#308) | Measured, not decided: the report times Veistra's click while the game busy-waits for five seconds, then again after `AttachThreadInput(.., FALSE)` | Windows joins the input queues of a child and its parent, and of an owned window and its owner, across threads. If the click waits, the detach `--wid` already does is the fix. |
| Where the spike lives (#308) | `src-tauri/src/godot/spike.rs` and `spike/`, an ignored test compiled only with the `embed-spike` feature | Nothing ships it: no build without the feature has it, and the feature only adds two `windows-sys` modules to test builds. |

### The embed spike (#308)

`pnpm spike:embed`, on a Windows 11 desktop, fills in the R1/R2 row's evidence. It opens a
stand-in Veistra window (a top-level window with a child "page" where WebView2 would be),
starts the demo game from a temporary copy of `examples/godot-demo` with the reporters in
`src-tauri/src/godot/spike/` added, and puts its window over a fixed box three ways: R1
(`SetParent`, written in the spike), R2 (`embed.rs` as Play ships it) and R2 with `--wid`. Each
way gets the four checks below; the way it suggests then runs the Godot editor (`--editor
--single-window`) and Blender (`--factory-startup`).

It takes a few minutes and drives the real mouse and keyboard (clicks, F13, screen reads), so
leave both alone until the report prints. The report goes to
`%TEMP%\veistra-embed-spike\report.md` (or `VEISTRA_SPIKE_REPORT`): the suggested way, the two
tables below filled in, rows of what else it saw (how long the window took and where it first
showed, frames recorded while hidden, a native popup over the game, the foreground window,
whether the frame and parent held, DPI awareness, Veistra's click while the game hangs), and
what is left to check by eye. `VEISTRA_SPIKE_GODOT` names the executable, as the Godot setting
does; `VEISTRA_SPIKE_WAYS` (`r1,r2,r2wid`) and `VEISTRA_SPIKE_TARGETS` (`game,editor,blender`)
narrow the run; `VEISTRA_SPIKE_CHOSEN` runs the editor and Blender with another way. The editor
opens the copy with your own Godot editor settings; Blender saves nothing.

A check passes when:

- **Follows**: after twelve 15 px steps and after a resize, the window sits exactly on the box
  within 100 ms, the program reports the new size within a second, and it is back on the box
  after Veistra is minimised and restored.
- **Graphics Capture**: `CreateForWindow` accepts the window, and two seconds through Play's
  recorder hold 30 frames (one for the editor and Blender, which redraw only on change) at the
  box's size.
- **Input**: a real click at the box's centre lands there (within 2 px, the game) and F13
  arrives, and none of it reaches Veistra's window.
- **Menu**: the menu shows over the window as it is, or, with the window hidden while the menu
  is open, the menu shows within 100 ms and the window is back within 100 ms of it closing.

It suggests R2, then R2 with `--wid`, then R1: the first to pass the first three on the demo
game, and R2 when none does. The choice is the owner's. Paste the report's tables over these
and record it in the R1/R2 row.

| Check | R1 child window | R2 owned popup | R2 with --wid |
|---|---|---|---|
| Follows a Veistra move and resize | pending | pending | pending |
| Graphics Capture accepts the window | pending | pending | pending |
| Keyboard and mouse reach the game | pending | pending | pending |
| A Veistra menu draws over it | pending | pending | pending |

| Check | Demo game | Godot editor | Blender |
|---|---|---|---|
| Follows a Veistra move and resize | pending | pending | pending |
| Graphics Capture accepts the window | pending | pending | pending |
| Keyboard and mouse reach the game | pending | pending | pending |
| A Veistra menu draws over it | pending | pending | pending |

### Not verified on a real machine

Built and tested on Linux with unit tests and a Windows type-check; the Win32 embedder, the
recorder and the GDScript have not run. The acceptance list in section 13 of the design needs
a Windows 11 pass on the demo game and on Anomaly.

From #312, not yet run in a real Godot (gdparse, gdlint and Rust tests only):

- `veistra_capture.gd` on Godot 4.3, 4.4 and 4.5: gdparse checks syntax, not types, API
  presence or runtime errors. Check `pnpm probe recent_errors` and the take's `log.jsonl` for
  `SCRIPT ERROR` lines.
- `examples/godot-demo` loading and playing at all: its scenes are written by hand.
- Ticks: `tickRate` 9 or more over a two-minute recorded run of the demo, with the game in the
  pane and again hidden behind another tab. `tickUsP95` 500 or less at `tickNodes` 64 on
  `bench.tscn`, and on Anomaly.
- `pick` on Enemy_02 naming `Hallway/Enemy_02` from a ray, also with physics on its own thread
  and with Jolt; `Arena/Enemy_02` in the 2D scene.
- F7, F8 and Ctrl Shift M with the game focused: the demo clock's count stays 0 and every other
  key reaches the game. The F8 mark within 100 ms of the frame (also needs #310's clock).
- Stop's `flush`: the take's telemetry runs to its last 100 ms.
- With the addon removed, Play runs, Rec says why it is off, and nothing throws; an exported
  build with the addon writes nothing to the folder it is given.

From #308, not yet run (unit tests, a Windows type-check and clippy only):

- `pnpm spike:embed` as a whole: nothing in `spike.rs`'s Win32 half has run, so the R1/R2 row
  waits on its first run. A failure of the harness itself shows as a "Harness error" row, not as
  a failed check; fix the harness and run it again before reading the tables.
- The reporters: `reporter.gd` and `editor_reporter.gd` in a real Godot 4.3 or later (gdparse
  and gdlint only), and `blender_reporter.py`'s listener in a Blender with a window (its tests
  run in background `bpy`, which has no window and no events).

## The Godot Viewer

`scene.rs`. Refresh runs `godot --headless --path P -s dump_scene.gd -- --out F --scene S`,
which instantiates the scene without adding it to the tree and writes its nodes as JSON.
`--import` runs first when the project has no `.godot/` cache. The result is cached, stamped,
and shown with its age; nothing runs until someone presses Refresh.

If Godot is missing or the run fails, the tree is parsed from the `.tscn` text instead and the
pane says so ("Read from the scene file - Godot did not run", with the reason). Instanced
scenes take their type from the scene they instance, to a depth of four.

Render view is a separate, explicit action: Godot's Movie Maker mode for one frame, keeping the
last frame written. It is not headless, since a headless run has no renderer, so a Godot window
appears briefly. The frame is cached beside the tree and stamped separately.

## Read-only main (#163)

Running and viewing read the project, so they work on main. Writing does not:
`godot/open-editor`, `play/addon-install`, `play/addon-remove`, `play/send` and
`comments/verdict` are in `WRITE_METHODS` and are refused on main before a handler runs. The viewer's cache goes under the app-local data folder
for main and under `<env>/.veistra/godot-viewer/` for a worktree; run channels are always in temp.

What Veistra cannot prevent: Godot writes `<project>/.godot/` (import cache) whenever it loads a
project. It is engine-generated and gitignored by every Godot template.

## The 3D preview and markup

The Godot Viewer's "3D" tab shows the scene as an orbitable glTF instead of one still frame. It
needs Godot, like the tree does; "Render" is the still frame, and it is what the viewer falls back
to, with the reason, when the export fails.

**Export.** `godot/preview-glb` (params: `scene`, `actor`, optional `force`) runs
`export_glb.gd` headless (`GLTFDocument.append_from_scene`) and answers `ready`, `running` or
`failed`. The file is `<project>/.veistra/preview/godot/<scene-slug>.glb`, one per scene, replaced in
place through a temp file and rename. A `.json` beside it holds the cache key and the node map. The
key hashes the Godot version, the scene, every text scene or resource it references (by content)
and binary assets (by size and modified time), so an unchanged scene answers `ready` without
running Godot. Failures are remembered until `force`. On read-only main the file goes under the
app cache instead of `.veistra`. `actor` must be `human` or `agent`; `system` is refused.
`godot/preview-glb-bytes` hands the file to the viewer (48 MB cap).

**Node paths.** three.js renames nodes it loads (spaces become `_`, and `[ ] . : /` are dropped)
and Godot renames duplicates on export (`Crate2`). The reply's `nodeMap` maps each three.js-side
path to the Godot scene path (`Main/Crate/Crate`), so a pin's `nodePath` in the JSON below is a
Godot path.

**Mark up.** "Mark up" opens the markup layer over the 3D view (Excalidraw loads on first use, so
neither it nor three.js is in the viewer's first chunk). Arrows and boxes snap to nodes, and pins
carry the picked node. Done shows the result with "Send to agent". Sending stores two items, both
overwritten on the next send for that scene: the PNG under `godot/<scene>/markup` and the JSON
under `godot/<scene>/markup-json` (kind text, because the store caps images at 8 MB and text at
256 KB). If the JSON would exceed the cap the raw `excalidraw.elements` are dropped and
`excalidrawOmitted: true` is set; pins and annotations are always kept. Moving the camera during
markup discards it, since the drawing belongs to one view.

The JSON an agent receives is the format in `docs/markup-format.md`, with the source recorded as:

```json
{
  "version": 1,
  "source": { "kind": "scene", "glb": ".veistra/preview/godot/main_tscn.glb",
              "engine": "godot", "scene": "res://main.tscn", "godot": "4.7.2" },
  "camera": { "position": [4, 3, 5], "target": [0, 1, 0], "up": [0, 1, 0], "fov": 50 },
  "size": { "width": 640, "height": 360 },
  "pins": [{ "n": 1, "note": "too tall", "nodePath": "Main/Crate", "worldPoint": [1, 0.5, 0] }],
  "annotations": []
}
```
