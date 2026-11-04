# Godot: one app with Editor and Play, and Open in Godot

Code: `src-tauri/src/godot/` (`detect`, `runner`, `addon`, `scene`, `rpc`, `live`), one entry
(`godot::rpc::godot`) routed from `apps/godot_viewer.rs` for the Godot app's id, `godot-viewer`,
and its `play` alias. Frontend: `apps/godot-viewer/ui`, where `App.tsx` is the mode shell,
`SceneMode.tsx` is Editor mode and `play/` is Play mode. Shared types are in
`apps/shared/godot.ts`.

Godot is never drawn by the webview. It is a native process Veistra starts, watches and stops,
and Play places the game's window over its pane (owner decision 6 and spec section 11 replace
`VEISTRA-UX-REWORK.md` section 3.1's "never embedded"; the editor joins it there with C1).

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

**The game in the pane** (`src-tauri/src/embed/`, Windows). After spawn, the game's window is
found by process (the game and its children, since `_console.exe` starts the real executable;
the `Engine` class first, never a console or a message box), its caption and borders removed,
`WS_EX_TOOLWINDOW` set, made owned by the Veistra window, and its input queue detached from
Veistra's so a hung game cannot stall Veistra. The pane sends `play/embed-rect` with its game box
in window CSS pixels; Rust adds the window's client origin and scale, and a worker applies only
the newest box. The game is launched with `--windowed --resolution <pane size> --position <the
pane on screen>` so it first shows where the pane is. One registry (`embed/host.rs`) holds every
placed window, game, Godot editor or Blender, by the pane instance that shows it: it hides a
window whenever that pane is not the active tab of a cluster on screen (from the shell state)
and moves them all with the Veistra window. With no embedder (macOS, Linux), no window within
10 s, a refused style change (an elevated game) or a failed first move, the game keeps or gets
back its own decorated window, on screen over the pane, and the live strip says "Playing in its
own window" and why; `VEISTRA_EMBED=off` forces that path. A game whose Play pane closes is
stopped, its take saved first. An editor is never killed: it is handed back as a normal window
when its pane closes and at exit.

**Airspace.** The placed window paints above the WebView. The shell reports its open overlays
(menus, popovers, dialogs and the scrims behind modal sheets, the palette, toasts, the drag
ghost and where a dragged tab would drop, and a takeover or expanded page that covers the whole
tool window) as `veistra/overlays` (`src/shell/overlayWatch.ts`) to every app that declares
`places_window`. The pane (`apps/shared/useNativeBox.ts`) hides the window and shows its last
frame while one covers the box: the recording's while a take records, else a Graphics Capture of
the window itself (`embed/capture.rs`, only where Windows can leave out its yellow border), else
the capture addon's.

**Takes** (`record.rs`, `encode.rs`, `takes.rs`, `session.rs`). Record is per project, per
computer, off by default, and needs addon v2 and Windows; its settings are `{on, quality,
keep}`, opened from the chevron beside Record (`play/RecordSettings.tsx`, #321). A quality or
keep chosen there applies from the next take, never the one recording, and Show folder opens
the takes folder (`play/takes-reveal`); the folder itself is not a setting. A take is `.veistra/takes/<utc minute>-<4 hex>/` with `take.mp4`, `telemetry.jsonl`,
`log.jsonl`, `take.json` and `notes.json`; the last `keep` (ten) are kept, plus any with drafts,
and `.git/info/exclude` keeps them out of git. On read-only main they go under the app's data
instead. The video is H.264 with no audio, fitted inside 1280x720 at 30 fps with a keyframe a
second. Time zero is the first video frame's wall-clock time; telemetry and the log carry wall
time, so every lane lines up on one clock. Stop writes everything but the video at once, and
the video follows as `take.mp4` once the encoder has closed it (#310).

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

**Review** (`play/Review.tsx`, `Timeline.tsx`, `NotesPanel.tsx`) plays `take.mp4` through the
asset protocol. Under it are six lanes, top to bottom: Frames, Notes, Marks, Log, Scenes and
Frame time. The filmstrip is drawn from a video of its own, one frame every 2 s at the video's
shape, each over the 2 s it stands for. It starts once the player can play, so its seeks never
compete with the first frame. The keys are Space, Left and Right (one frame, 1/fps), I and O
(an end set on the wrong side of the other drops it), N, and Ctrl Enter to send. On read-only
main notes are written and edited as anywhere; only Send is refused. The toolbar has the take
menu and Play again (F5),
which runs the reviewed take's project. Notes follow §8.3: `n` is never reused, and a mark's
note goes at the mark, leaving a pending range alone. A pin's target is the smallest tracked
box under it in the tick nearest the note, lifted to the nearest tracked physics body or area
above it whose box also holds the pin. `markup.json` is the existing format, with `source.path`
the take's video at `#t=<seconds>`. Errors and warnings within 10 s of a note go with it and
are counted on its card; an error within 2 s of a mark shows beside the mark. The page fires
`note_created` `{kind, from}` and `mark_dropped` `{source, recording}` (#314).

Opening review from F7 waits for, in order: Stop's telemetry flush (600 ms at most), `take.json`,
the encoder closing the MP4 (its index grows with the take), `play/take`, and the player's first
frame. The telemetry, the log and the filmstrip load after that. The time from the F7 press,
taken from the addon's key event, to that first frame is on the review's root as
`data-open-ms`, and logged as `review of take … opened in N ms`. Read it with
`pnpm probe --agent --server agent eval` inside the Play frame:
`document.querySelector('.pl-review').dataset.openMs`.

**Send** (`feedback.rs`) writes `.veistra/feedback/<take>-<n>/` with `packet.md` and per note
`markup.png`, `markup.json`, `contact.png`, `frames/` and `context.json`, files each note as a
comment with a `take` anchor, and the page attaches `packet.md` at the agent's prompt. Agents
use `list_play_notes`, `start_play_note` and `resolve_play_note` on the workspace server, or
on the context server from an agent tab.

**Still broken** (#321). Still broken on a fixed take note reopens it with the person's reply
(`comments/verdict`), then runs the note's scene in its take's project with `play/run`
`followUp: <comment id>`, which records that run whatever Record says and leaves Record as it
was. The take it saves names the note in `take.json` (`followUp`) and starts with one draft,
the reply, at the first F8 or the start. Its review says "Still broken · note N of Take M" and
lists the note's takes; SEND TO starts on the agent in the note's `sentTo`. Send files the
draft onto the same comment (`comments::add_take`): the take joins the note's history as
`Reply.take`, the packet says the note is still broken and lists every earlier packet and the
fix that did not hold, and the line is "Still broken after your fix: 1 note. Read …".
`list_play_notes` points at the newest packet and lists every take. Where Record is blocked,
nothing runs: the words go to the `sentTo` agent as a text item, Enter never pressed.

**Note status reaches panes by push** (#311). Every comment write is announced as
`comments:changed` (`comment_events.rs`), relayed by each window's shell to the app frames of
the clusters on that environment, and an app re-lists through `apps/shared/commentEvents.ts`.
An agent's resolve is a Rust call no frame sees, so this is what turns an open card to "Fixed,
check it". The same chokepoint reports `godot:note_fixed` and `godot:note_resolved` through
`telemetry::track`, which hands the event to the main window's shell to check and send.

### Decisions

| Decision | Chosen | Why, and what was rejected |
|---|---|---|
| R1 child window or R2 owned popup | R2, pending the Day 1 spike | Graphics Capture records the game window alone, never Veistra's UI. R1 (`SetParent`) is not built; the spike is where `CreateForWindow` on a child window gets tried. |
| One Godot app or two (#313) | One app, two modes: Editor · Play (owner decision 1) | Play's UI moved into `apps/godot-viewer/ui/src/play/`, and one Rust entry answers both modes. The two apps that switched with `veistra/open` were rejected by the owner: a pane is the Godot app, and the mode is what it shows. |
| Record default | Off | Takes cost disk (open decision 2's recommendation). |
| Tracked nodes | The design's default, with geometry for its "VisualInstance3D" | `veistra_track` when it has members, else bodies, plus the geometry and sprites not inside one, in view by their box's centre, nearest 64. VisualInstance3D also takes in lights, probes and decals; a body's own mesh tracked beside it could take a pin that should name the body; and a character's origin is at its feet, below a frame that shows the rest of it (#312). |
| Video clip in the packet | Not built (replaced by #315's below) | The agent reads the contact sheet; the checkbox is shown disabled with why. |
| Retention | Ten takes | Open decision 7. |
| Video size | The window's, not 720p (replaced by #310's below) | `windows-capture` crops or pads, it does not scale. The bitrate is fixed at 3.5 Mbit/s, under 60 MB for two minutes. A D3D11 scaling pass is the follow-up. |
| One embedder for the game, the Godot editor and Blender (#309) | `crate::embed`, a registry keyed by pane instance and kind; the game belongs to the Play pane that last sent `visible: true` | Keying by cluster or app id was rejected: a cluster can hold an editor and a game, Play can be open in two panes, and `play` becomes a mode of the Godot app (#313). The embed living inside Play's run gave the editors nothing to call. |
| Which apps get window rects and overlays (#309) | A `places_window` capability on the registry entry: projects, play, godot-viewer, blender-viewer | The hard-coded `{projects, play}` lists in `ToolWindow.tsx` would have hidden the game once Play moves into `godot-viewer`. A plugin surface never gets it. |
| Overlay signal (#309) | `veistra/overlays` with the overlays' rects, to frames; the `veistra:overlay-open/close` DOM events kept in the shell document | The spec's DOM events (§4.3.2) cannot reach a cross-origin frame, and a flag cannot tell a menu over the box from one across the window. Modal scrims and tab drop targets count, so a game in a pane the sheet does not reach steps aside too. |
| Method names (#309) | `play/embed-rect` (the spec's `play/embed_rect`); `embed/rect`, `embed/still`, `embed/pop-out`, `embed/dock`, `embed/state` with a `kind` for the editors | Every app method here is kebab-case. The game keeps methods of its own because Pop out finishes a take and Dock starts one. |
| The fallback (#309) | Launch at the pane's screen rect; on any failure a decorated window on screen over the pane, a cause code beside the reason; a window that shows after the 10 s wait is brought on screen, not placed | `--position -32000,-32000` left every fallback off screen, which is not "in its own window". `VEISTRA_EMBED=off` lets spec test 9 run where embedding works. |
| Editors when their pane closes and at exit (#309) | Handed back as a normal decorated window, never killed; the game keeps its rule (stopped, take saved) | Killing an editor loses unsaved work. A game left running hidden after its pane closed plays audio nobody can stop. |
| A still without a recording or the addon (#309) | Graphics Capture of the placed window, a frame kept every 500 ms, only where Windows can leave out the border; order recorder, capture, addon | Record is off by default and the addon is opt-in, so a plain run, and an editor always, had no still. A permanent yellow border on older Windows 10 is worse than an empty box. |
| `WS_EX_TOOLWINDOW` on a placed window (#309) | Kept | `windows-capture` 2.0.1 skips tool windows only in `Window::enumerate` (`is_valid`); the recorder and the still build the item from the handle (`from_raw_hwnd`, then `CreateForWindow`), which does not check. To confirm in the spike run. |
| Input queues under R2 (#309) | Detached once the window is owned (`AttachThreadInput(.., FALSE)`), as Godot's own embedding does | The owner link joins the two queues, so a hung game or a long editor import would stall Veistra's focus changes. |
| Where play_embedded and play_embed_failed fire (#309) | Rust, once per run when the outcome settles, through `telemetry::track`: `{ms}` or `{cause}`; nothing for a game that closed first, or for Pop out. A run with no pane open settles when a pane first places it | The page sees the outcome only while a Play pane polls, so an agent's run would go uncounted. Counting "no pane" as a failure was rejected: nothing was tried, and agents' runs would swamp the failure rate. The shell forwards these once #311's `features/godot.ts` and `backendTrack.ts` are in. |
| The `play` id (#313) | An alias in the registry: it serves the Godot app with `?mode=play`, shares its dispatch, keeps its own title and is left out of the Apps menu | Saved layouts, the Godot starting layout, presets, and agents' `veistra/open` and `app_call` name `play`, so deleting it would break them. An initial message to pick the mode was rejected: the bridge drops an event nobody listens for yet, and the mode must be known at first paint. |
| Mode names and Editor before C1 (#313) | Editor · Play; `?mode=scene` still means Editor. Until C1, Editor is the read-only scene view, with one line saying the editor opens in its own window | The spec names the modes Editor · Play. C1 replaces Editor's content with the embedded editor, and C3 keeps the scene view as its fallback, so the view stays where it is. |
| Which mode a pane opens in (#313) | The URL's first, then the pane's own choice, saved per pane instance in `localStorage` | A cluster switch unloads every frame and loads it afresh, and a Play pane must come back in Play over its game. Every Godot frame shares one origin, hence the instance in the key; with no instance nothing is kept. |
| What the mode shell holds (#313) | The window rect, the overlays and an open's payload, caught from the first moment; the Godot status; Play's project and the live notes | The modes load lazily, the bridge keeps no event nobody listened for, and the shell sends an unchanged window rect only once, so a mode loaded later would never hear where it is. |
| The status after a project move (#313) | Read again on every `project:changed`, and each mode reads what it took from the old root again | Read once at mount, the read-only banner and flag stayed on the main checkout's answer after the cluster moved to a worktree, which is where the banner sends people. |
| Rec's disabled state (#313) | Off and blocked, Record is disabled with the reason as its title, and Ctrl R does nothing; on and blocked it stays clickable to turn Record off | §5.1 asks for a disabled state. Off and blocked opened the capture consent; Enable capture stays in the footer, where it always was, and the strip says why. |
| Slot 5 (#313) | Pop out alone, always there, disabled with a reason when there is no game in the pane; Open in Godot is Editor's | A button that comes and goes shifts the toolbar as a run starts. Ctrl Shift O still opens the editor from Play until C1 embeds it. |
| Slot 2 in Play (#313) | The project picker when there are several, then a scene picker from `godot-viewer/state`, the main scene first, disabled while running | There was no way to choose what F5 runs, though `play/run` takes a scene. Restart keeps the running scene, so a pick while running would not be honoured. |
| The drawer's counts (#313) | Output counts every line; Errors counts what its tab lists, warnings with errors; the strip counts errors only | The Errors count was errors only while its tab listed warnings too. The strip says "errors", and counts those. |
| Reload keys (#313) | F5 and Ctrl R are kept from WebView2 inside the Godot app, Shift F5 too; F5 in Editor turns to Play and runs, as Godot's Run Project does; each mode's root takes the focus back when it falls to the page | WebView2's reload unloads the pane and, in Play, the game's place in it. Ctrl R typed into a note reached the page. A focused button that left with its view dropped the focus where F5 is the reload. |
| Comment pushes and the mark telemetry (#313) | Not wired here; #314 does both | The issue moves Play; the comment push (`useCommentsChanged`) and `mark_dropped` belong to review and its notes. |
| The captured-mouse hint (#313) | The strip reads an optional `session.mouseCaptured`: "F7 stops and opens the take" while recording, "F7 stops the game." otherwise; absent reads as not captured | Spec §4.4. A game holding the mouse leaves nothing in the pane to click, and F7 is the key the addon forwards. #312's backend sends the field; this branch does not contain it, so the hint shows once the two meet. |
| A game an agent started with no Play pane open (#309) | Its own window until a Play pane shows it; that pane places it when the window appears, or docks it at once if it is already up | Failing the pane's first box because the window had not shown yet left the game in its own frame for the whole run. The 10 s wait restarts when the pane opens: time with no pane had nothing to place the window in, and counting it kept a slow window out of a pane opened at 15 s while one opened at 25 s docked it. |
| Where an editor shows (#318) | The backend decides, once, in `editor_surface::decide`, and `godot/status` and `blender-viewer/state` answer it as `editor: {surface, reason, code}`; the order is cloud, then main, then no editor, then embedded where there is an embedder and Pop out where there is not | Each page working it out again from `readOnly` and a found path was how the two apps came to disagree. Wayland was not a separate surface: macOS, Linux on X11 and Linux on Wayland all lack an embedder today, so Pop out is "no embedder here" and the platform only changes the sentence. |
| The fallback's reason (#318) | One line under the toolbar (`ToolbarReason`), not a slot or a banner; a missing editor gets Open Settings on its section, main and a cloud session have nothing to press. The mode's label stays Editor | The five slots are full, and a sixth is how the toolbars drift apart. Renaming the mode to Viewer when the viewer shows was rejected: the mode would change name under the person as the cluster moved. |
| Cloud sessions in the viewer (#318) | A reason only: nothing is read, no scene and no comments, and Play does not offer Run | The files are on the VM. No cloud cluster can be made in this build, so the case is unit-tested only. |
| Mark up's place (#318) | Slot 4 in every surface; the lazy 3D view reports how to start drawing (`onTrigger`) and the toolbar draws the button (`MarkupButton`) | It sat on the 3D view's own bar in Editor and the Blender viewer and in slot 4 in Play. A handle into the lazy view was rejected: it would pull three.js into the eager chunk. |
| The environment chip (#318) | First in slot 2, before the picker: `wt`, `cloud`, `main` or `design` and the branch, with main in the warning tone | Which checkout an edit lands in is the first thing to know before pressing anything; Play's review keeps one state chip and says Record is on in Play again's title. |
| Blender on main (#318) | `blender-viewer/open` and `files/open-in-blender` are writes, refused on main; the Blender export cache for main moved to app-local data, keyed by the checkout's path | Blender saves into what it opens. The cache under `<project>/.veistra/blender/` was the one thing the viewer still wrote into main. |
| Embedded editors, Blender (#317) | Editor mode is the person's own Blender, started as `blender <file.blend> --python veistra_boot.py` and placed over the box as kind `blender`; nothing is installed or enabled in Blender, and the script does nothing without `VEISTRA_BLENDER_CHANNEL`. Owner decision 6 replaces `VEISTRA-UX-REWORK.md` §3.1's "never embedded"; agents still run Blender headless | An add-on enabled in the person's Blender would outlive Veistra and load in every Blender they open. `--python` runs once the file has loaded, in this Blender only. Not `--disable-autoexec`: it is the person's file, and their preference decides. |
| Opening Blender (#317) | Only on a press, never on mount: Open in Blender in Editor mode, or Renders' Open in Blender, which now goes through `blender-viewer/editor-open`. Refused on main, while this cluster's Blender has another file, and while another cluster or another Blender holds the file | A cluster switch reloads every frame, and Blender is too heavy to start for a glance. Renders' button started the detached `blender-viewer/open`, which takes no lock, so the person could have had two Blenders on one file. |
| Where Blender's window starts (#317) | No `-p`: Blender opens where it would, and the embedder places the window over the box when it appears | `-p` measures from the lower-left corner in Blender's own screen coordinates, which nothing here could check. To revisit if the first frame shows at Blender's default place on a real machine. |
| The boot script's channel (#317) | The capture addon's folder protocol (X5) in `temp_dir()/veistra-blender/blender-editor/<cluster>-<pid>-<n>`: `hello.json` once (with Blender's own pid), `state.json` on change (the file, unsaved, the selection, the 3D view), `cmd.json` in, `res-<id>.json` and `cap-<id>.png` out, every file written to a `.tmp` and renamed. One persistent `bpy.app.timers` callback every 250 ms | No socket and no port, as for the addon. A timer is the one way to run on Blender's main thread without a modal operator, and a persistent one survives File > Open. Commands are a table (`COMMANDS`), so #320's N-panel adds entries beside `select`, `viewport-only`, `capture`, `pick` and `quit`. |
| The one-writer lock (#317) | `.veistra/locks/<file>.lock`, mirroring the file's folders, written and removed by Rust only, naming Blender's pid and that process's start time; a lock whose process is gone or whose pid now names a later process is stale, and the first reader removes it. A watcher thread follows the file Blender reports every 500 ms, so File > Open moves the lock, an unsaved new file holds none, and Blender exiting removes it with no pane polling | Blender has no quit hook to clean up, and Veistra may exit first and leave Blender running, so the lock cannot depend on either writing it last. The pid alone was rejected: Windows reuses pids. `hello.json`'s pid is the one locked, so a launcher that exits does not read as Blender gone. |
| A Blender left running at exit (#317) | Its lock stays, correctly, until that Blender exits; Veistra does not adopt it into a pane after a restart | The lock still names a live Blender with the file open. Adopting it needs the window found from the pid with no channel to say which file it has; not built. |
| Closing Blender (#317) | `WM_CLOSE` to its window, what its close button sends; with no window to post to, the boot script's `quit`, which runs Blender's own quit with its save prompt; otherwise the pane says to close it from Blender. Never a kill. The pane closing or Veistra exiting hands the window back (`Orphan::Release`) | An unsaved scene is the person's work (X2). |
| Exports as versions (#317) | Every export, the person's or an agent's, lands as `.veistra/exports/<asset>/v<n>/` (`model.glb`, `renders/`, `export.log`, then `export.json` last), with `asset.json`'s `next` so a number is never handed out twice; the last ten are kept. Every export names its actor, `human` or `agent`; `system` is refused. `blender-viewer/export-versions` lists them newest first | Spec §11.3 and X6. Overwriting the one cached export would lose what Compare (#319) compares. A version is the folder with `export.json`, so an export that died midway is never listed. |
| The export never writes the `.blend` (#317) | It reads the saved file in a headless Blender and writes only the new version; a live lock is recorded in the version (`sourceLocked`) and left alone | Spec §13 test 12. The person's unsaved changes are not on disk, so the agent exports what was last saved; the banner says the export never overwrites their file. |
| The agent's export tools (#317) | `export_blend` and `list_blend_exports` on the workspace and context servers; `export_blend` answers as soon as the export starts, and `list_blend_exports` shows the version once it lands | A tool call runs inline on the server's worker, and an export can take minutes. |
| What an agent may call on Blender in the pane (#317) | `blender-viewer/editor-state`, `editor-capture` and `editor-pick` read it; `app_call` refuses `editor-open`, `editor-close`, `editor-select` and `editor-viewport-only` | Blender in the pane is the person's: an agent reading what it shows is the point, an agent opening, closing or steering it under the person is not. |
| Send selection and Mark up in Blender (#317) | One `capture` answer holds the picture, the view and the selection of the same moment; Send selection files it as two Context items (for `props/bed.blend`, `blender/props/bed/selection` text and `blender/props/bed/editor-viewport` image, each replacing the last send's) and types both references in one `context/insert`, never Enter (X8). Mark up draws on that capture and asks Blender what is under each pin (`pick`) after Done | Two round trips could pair a selection with a view the person had already moved. |
| The markup host and pin naming in Blender (#317) | Blender-local copies of the Godot editor's (`editor/ViewportMarkup.tsx`, `editor/pins.ts`); `useTheme` moved to `apps/shared` | An app may not import another app's source (`eslint.config.js`). The copies can move to `apps/shared` once #316 and this have both landed. |
| Compare before #319 (#317) | Drawn in the mode switch, `aria-disabled`, with a tooltip saying it is not built; the banner's Compare with v<n> waits for it the same way | A mode that appears later moves the switch under the person. `aria-disabled` keeps the tooltip and the tab stop, which `disabled` would drop. |
| Opening a file Blender in a pane holds (#317) | `blender-viewer/open` and `files/open-in-blender` look for a live lock in every folder above the file (`lock::live_above`) and refuse it, naming the process | Files' Open in Blender gets an absolute path with no environment, and two Blenders on one file save over each other. The detached opens still take no lock of their own. |
| Two bugs (#317) | `blender-viewer/open` resolves a project-relative path inside the environment, as `export-start` does; the wire render is SOLID with temporary Wireframe modifiers, dark lines on a light world, undone afterwards, and the `.glb` is exported with modifiers applied | The open refused `props/bed.blend`, the only kind the viewer and agents send. Workbench ignores WIREFRAME shading in a final render, so the wire pass was a blank white PNG. |
| Agents editing a `.blend` (#317) | Not built: an agent exports and reads, and never saves a `.blend`, locked or not | Whether an agent may change a `.blend` while nobody has it open is the owner's question (X12). |
| Where pick's physics query runs (#312) | `_physics_process`; the command poll only queues the pick | Godot makes the direct space state safe there alone: from `_process` it refuses with physics on its own thread, and Jolt refuses while it steps, so the pick fell back to boxes without saying why. The node runs while paused, so a pick still answers during Mark up. |
| Exported builds (#312) | Inert whenever `OS.has_feature("template")` | Relying on a missing `--veistra-dir` alone was rejected: a shipped game started with the argument by hand would write telemetry and answer commands, against §5.5 rule 6 and the consent text. |
| When Update capture is offered (#312) | Whenever the installed script's text is not this build's, CRLF read as LF; an earlier v2 goes out as `partial` but keeps its channel | The marker alone called every earlier v2 current, so no fix to the script ever reached a project that had one. Treating an earlier v2 as a broken install was rejected: its game would lose capture and Rec until updated. |
| The take's last second of ticks (#312) | Stop sends the addon `flush` (600 ms at most, only while the game runs) before the copy; commands to one channel take turns | The addon flushes once a second, so up to a second was missing. Flushing every tick costs a write a tick. The game reads one `cmd.json`, so a flush landing during the pane's pick would have replaced it. |
| Veistra's keys and the game (#312) | Handled in `_input` by the root's last child, with the key's repeats and release; an InputMap action bound to the key is released | `Window.window_input` was rejected: `push_input` resets the handled flag after it. Two leaks remain: a game polling `Input.is_key_pressed` or `is_action_just_pressed` sees the press in its frame, and a key pressed while the game's own embedded sub-window has focus goes to that window. Staying last means a game that takes the root's last child for its scene finds the addon; `current_scene` is unaffected. The demo's clock counts what reaches the game. |
| Toolbar marks (#312) | Kept out of `telemetry.jsonl`; `take.json` `marks` merges them with F8's, and `play/state` counts F8's apart as `f8Marks` | The game is the only writer of its telemetry file, so no two writers interleave lines in it. `mark_dropped` (#314) needs F8's told apart. |
| Demo game (#312) | `examples/godot-demo`: text scenes, no textures, no autoload line | The game the earlier runs used was a folder on one machine. Text scenes need no import, a test holds them to the names the checks use, and Enable capture adds the autoload as it would in any project. |
| Video size (#310) | Fitted inside 1280x720 at 30 fps (or 1920x1080 at 60, the other quality), keeping the window's shape, never upscaled, even sides; set when the take starts, every frame stretched to it by the D3D11 video processor | Review maps a pin to the game's pixels by proportion, so black bars or a cropped corner, which a fixed size with padding gives a resized pane, would move every pin. Starting a new file on a resize was rejected: one take, one video. |
| The encoder (#310) | Our own, adapted from `windows-capture` 2.0.1's `VideoEncoder` (MIT); its capture half is still the crate's | The crate's encoder makes the output the input's size and cannot set the keyframe interval. It also hands the capture pool's surface to the transcoder and queues without bound; ours copies into a ring of twelve textures and drops the newest frame past eight queued, counted as `dropped`. Hardware encoding is asked for; the transcoder falls back to software where there is none. |
| A keyframe a second (#310) | Both keys an H.264 encoder reads (`MF_MT_MAX_KEYFRAME_SPACING`, `CODECAPI_AVEncMPVGOPSize`) on the profile, and `mp4.rs` reads the closed file's sync samples back | The WinRT transcoder has no setting of its own for it, and which key a given hardware encoder honours is only known on the machine. A gap over 1.1 s is logged, not failed: the take is still worth keeping. The reader also corrects `take.json`'s size if the encoder chose another. |
| The frames' clock (#310) | Each frame's own capture time (QPC), put on the wall clock by how long ago it was | Its arrival time is later by the queue's length, so every mark and tick would sit that much early against the video. |
| Record's settings (#310) | `{on, quality, keep}` per project (the cluster's project folder), on this computer; retention per environment; an environment switched on before keeps reading as on | Decision X9: all of a project's environments record alike. Keyed by environment, a new worktree started with Record off. |
| `take.json` at Stop (#310) | Written while the encoder closes the video, which is recorded as `take.mp4.part` and renamed when closed | Closing an MP4 writes its index, a second or more for a long take; the review opens on `take.json`, which the spec wants within 1 s. A take listed without `take.mp4` is one still closing. |
| A take's telemetry and log (#310) | Telemetry lines within the take, 200 ms either side, streamed; the log from a tap that keeps every line while a take records, up to 100,000 | Copying the run's whole telemetry gave a second take of one run the first's ticks. The run's log keeps a few thousand lines, so a chatty game lost the start of a long take and undercounted its errors. |
| `godot` in `take.json` (#310) | The version number ("4.5.1"), with the full `--version` line as `godotBuild` | Decision X9; the spec's example has the number alone. |
| Takes that never finished (#310) | A folder with no `take.json`, untouched for an hour, goes at the next retention pass | Veistra closing mid-take left folders the list never shows. A recording take writes its video continuously, so an hour untouched is never one in progress. |
| `take_recorded` (#310) | Fired in Rust once `take.json` is written: `durationS`, `marks`, `errors`, `warnings`, `width`, `height`, `dropped` | Decision X1. No file size: the video is still closing at that point. |
| `recordOnce` (#310) | `play/run` and `play/restart` take it; it records that run and leaves the setting alone | Decision X9, for Play <scene> and Still broken. |
| How note status reaches open panes (#311) | Pushed: `comments:changed` from the comment store's write chokepoint, relayed by the shell to the frames of every cluster on that environment | Polling in each pane was rejected: Review polls every 2 s and the other panes never saw an agent's fix. The file watcher was rejected: it watches only roots a Files frame asked for and fires on every write. Review's poll stays as the fallback. |
| Where note_fixed and note_resolved fire (#311) | Rust, from the same chokepoint, through `telemetry::track` to the main window's shell, checked against the `godot` feature there | Tracking in a frame misses a fix made while no Play pane is open, and a broadcast is counted once per window. Capture stays in the webview (`docs/telemetry.md` §9). |
| "Only the user sets resolved" (#311) | Enforced in `comments::resolve_with_commit`, with one write lock across read, edit and rename | Checks only in the MCP tools let a future caller undo a Looks good, and an agent's resolve racing a verdict lost one of them. |
| Review's markup (#314) | `@veistra/markup`'s `MarkupLayer` over the paused frame, through `FrameMarkup.tsx`, which live mark up shares; not `useMarkup` | Decision X11. `useMarkup` owns the send to an agent, and a note's markup is kept in the note until Send. The layer gives the same `markup.json` and PNG, and `pick` names what a pin is on. |
| A pin's recorded target (#314) | The smallest tracked box under the pin, lifted to the nearest tracked body or area above it whose box also holds the pin | Decision X11. The mesh's box is nearly always the smallest, so a pin on the enemy named `Enemy_02/Mesh` while a live pick, which hits the collider, names `Enemy_02`. A body whose box does not hold the pin is not lifted to. |
| `note_created` and `mark_dropped` (#314) | Fired in the page through `apps/shared/telemetry.ts`: `{kind, from}` with `from` one of key, button, mark, markup or live; `{source, recording}` with `source` game, button or pane_key | Decision X1: short scalars, never a note's words. A live markup counts when it is kept, not when review folds it into the take. The game's F8 marks are counted by the poll from `f8Marks`, none from before the pane opened. |
| Retention at Stop (#314) | On its own thread once the take is written; a note with no words and no markup is not a draft | Retention reads every take and can delete a video, which review was waiting behind. One N pressed and left empty kept a take past `keep` for good. |
| Play again from review (#314) | The reviewed take's project, and the project picker follows | The take menu lists every project's takes, so Play again could run another game than the one reviewed. |
| One `godot` telemetry feature (#311) | `features/godot.ts`, apps `godot-viewer` and `play`, all eight §13 events declared at once | One feature per app was rejected: `play` becomes a mode of the Godot app (#313), and an app may report for one feature only. Declared whole so later issues add calls, not list edits. |
| Who Send tells (#315) | One agent, picked in SEND TO from `context/agents`: the cluster's agent terminals, the shown one first, then its agent tabs, the shown one first; the head of the list is the default | Decision X8. Send typed at the first agent terminal and chipped every agent tab too, so one Send could reach several agents. A chosen agent that has gone is a refusal with its reason, never a fall back to another: the packet would go to someone the person did not pick. |
| The one message (#315) | "Playtest feedback: 2 notes. Read `<reference>` first." on one line at that agent's prompt, Enter never pressed; `context/insert` takes `terminal`, `before` and `after`, and the agent tab's chip takes the same words | Decision X8. The bare reference said nothing about what it was. Control characters are dropped from the words, so an app's sentence cannot carry an Enter. |
| Attach to one agent tab (#315) | `veistra/attach-to-agent` takes an `instanceId` and answers `{delivered}`; without one it still chips every agent tab | A chosen tab that had closed was missed without a word. The canvas's Send selection names no tab and keeps working as before. |
| `sentTo` on a comment (#315) | The target, `{kind, id, label}`, stored on every comment Send files, absent on older ones | Decision X7, so Still broken (#321) goes back to the same agent. |
| Video clip per note (#315) | Built, off by default: Rust cuts `clip.mp4` from `take.mp4`, two seconds either side of the note, with the Windows media transcoder; the tick is disabled elsewhere with the reason | Decision X12 asks the owner to confirm. Cutting in the page would play the span in real time through `MediaRecorder` and ship the bytes over the bridge. A clip that fails is named in `problems` and in `packet.md`'s "Not in this packet", and the Send goes on. |
| A Send that partly fails (#315) | Everything that can refuse the whole Send does so before any note is filed; after that a note not filed stays a draft, is named in `problems`, and the rest go; only a Send that filed nothing is an error | Failing the whole Send after some comments were filed would leave them filed and their notes drafts, and the next Send would file them twice. |
| Contact sheets (#315) | Cells 320 px wide at the take's own shape; `context.json` and `packet.md` give the times when they are not one a second apart | A 4:3 or ultrawide game was squashed into 16:9 cells, and a span longer than sixteen seconds is sampled evenly, which "1 frame a second" would misdescribe. |
| A note with no ink (#315) | Its `markup.json` names `frames/note.png` in the markup format with no pins; its `markup.png` is the frame | Every note has the three files the packet promises, and an agent reads one format for both. |
| `notes_sent` (#315) | Fired in the page once `play/send` answers: `notes`, `ranged`, `markedUp`, `contact`, `clip`, `to` and `delivered` | Decision X1: counts and flags only. `delivered` false with `to` set means the agent chosen did not take the line. |
| Record settings (#321) | A chevron beside Record, "Settings for Record", opens a popover: Record every run, quality (720p · 30 fps or 1080p · 60, with its size for two minutes), takes to keep (5, 10, 20, 50, or the one set), the folder and Show folder, and Talk while you play as Later | The "Record settings" board. Its own name keeps "Record" a single button for every test and screen reader that looks for it. Open, it counts as covering the game, like the drawer. |
| One setting at a time (#321) | `play/record` takes `on`, `quality` and `keep`, each optional, kept as it was when absent; a call without `on` touches no take | `on` read as false when absent, so choosing 1080p switched Record off and saved the take a running game was waiting for. |
| When a change applies (#321) | The quality from the next take begun, the keep at the next save; the take recording keeps the quality it began with | Decision X9 and the board's "From the next take". `take.json` read the fps from the plan, which a change replaced mid-take. |
| The takes folder (#321) | Shown, not chosen: `.veistra/takes/ · git-ignored`, or "Outside this read-only checkout" with the app-data path as its title; Show folder opens it, made first, through the opener plugin | Retention, the asset scope and the git exclude all assume takes live where Rust puts them. On read-only main nothing is written to the checkout. |
| What Still broken runs (#321) | `play/run` `followUp`: the note's take's project and scene, recorded once (it implies `recordOnce`), Record left as it was; a game already running is stopped first | The issue asks for the scene with Record on. Turning Record on for it would leave every later run recorded. The take's project, not the picker's, because the take menu lists every project's takes. |
| `followUp` is checked first (#321) | A take note that is not resolved, before anything starts; Dock and a restart keep it, Record switched off ends it, and a restart that asks for its own `recordOnce` or `followUp` drops it | A run for a note that cannot take one would record a take nothing files. |
| The follow-up draft (#321) | Rust writes it into the take's first `notes.json`: the person's reply, `followUp` the comment id, at the first F8 or 0:00; it counts as a draft for retention | The reply is already the description of what still breaks, and F8 is where the person showed it. Written by Rust, the draft is there before the review opens and survives a closed pane. |
| One note, many takes (#321) | Send files a follow-up through `comments::add_take`: the take goes on the reply when the words are the reply unchanged, else on a new reply; a note marked fixed since opens again; `sentTo` updates | A second comment for the same problem gave the agent no way to tie the attempts together. `TakeRef` carries the take, its number, packet and time. |
| The same agent (#321) | SEND TO's default is the checked note's `sentTo` when that agent is still listed, else the head of the list | Decision X7. An agent that has gone is not a refusal here, unlike a chosen one at Send (#315): the person sees the default before pressing Send. |
| Still broken where Record is blocked (#321) | Nothing runs; the words go to the `sentTo` agent (else the first listed) as a `context/put` text item with the reason no take was recorded, referenced at its prompt as "Still broken after your fix: note N of Take M. Read <item>." | Decision X8: Enter is never pressed. A run nothing records would leave the person a game and no way to send what they saw. Owner question. |
| The packet for a follow-up (#321) | `packet.md` marks the note still broken and lists "Sent before" (each earlier packet) and "Last fix" (the agent's summary and commit) | The agent reads one packet, the newest, and is told where the earlier ones are. |
| `list_play_notes` for a follow-up (#321) | `packet` and `packetMd` are the newest take's; `takes` lists each `{take, number, n, when, packet}`, oldest first | An agent given the first packet would work from the take that no longer shows the problem. |
| Play <scene> from review (#321) | Runs the scene with `recordOnce` | Decision X9: Play <scene> records that run, so its take can be reviewed against this one. |
| `followUp` on `notes_sent` (#321) | `followUp: true`, only on a Send with a Still broken note in it | Decision X1. Absent otherwise, so earlier Sends read as they did. |

### Not verified on a real machine

Built and tested on Linux with unit tests and a Windows type-check; the Win32 embedder, the
recorder and the GDScript have not run. The acceptance list in section 13 of the design needs
a Windows 11 pass on the demo game and on Anomaly.

From #309, unit-tested through a fake window system and type-checked for Windows only:

- Spec test 1: the demo game and Anomaly in the pane with no title bar and no taskbar button;
  Pop out brings both back and Dock removes them. After a splitter drag or a maximise the window
  matches the box within 50 ms: `lastPlaceMs` in `pnpm probe --agent shell_snapshot`'s `embeds`.
- Moving Veistra, a monitor of another scale and 125% View zoom keep the window on the box.
- Spec test 2: a menu, the Ctrl K palette and its scrim, a dialog, a toast and a dragged tab
  over the box show the still, and the game never paints over them. The Graphics Capture still
  has no yellow border on Windows 11 and is the frame from just before the hide.
- Spec test 9: with `VEISTRA_EMBED=off`, and with an elevated game whose style change UIPI
  refuses, the game opens decorated on screen over the pane and the strip says "Playing in its
  own window". A window that first shows after 10 s ends up on screen.
- A hung game (a GDScript infinite loop) does not freeze Veistra's UI.
- The window classes `Engine` (Godot 4, game and editor) and `GHOST_WindowClass` (Blender).
- The real-window test in `embed/win32.rs`, which runs on CI's `windows-latest` only.
- `godot:play_embedded` and `godot:play_embed_failed` reaching PostHog.

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

From #310, the take's timing and files tested through a fake capture; the encoder, the scaling
pass and the frame clock type-checked for Windows only:

- The ignored test `godot::record::sys::tests::record_a_window_to_a_720p_mp4_with_a_keyframe_a_second_and_no_audio`
  (`cargo test -- --ignored record_a_window`), which records a real window for three seconds.
- Spec test 3: a two-minute take of the demo at 720p30 is 60 MB or less, keyframes at most 1.1 s
  apart (the log's `keyframes at most` line), no audio track, and plays in the review.
- With a pane resized mid-take, the video keeps its size and framing and pins still land.
- `take.json` within 1 s of Stop (the log's `take.json N ms after stop`), and `take.mp4` after.
- An F8 mark within 100 ms of the frame it was pressed on, against the demo's clock.
- A take whose machine has no hardware H.264 encoder (software fallback) keeps up at 30 fps;
  `dropped` in `take_recorded` says how many it did not.
- `godot:take_recorded` reaching PostHog.

From #313, tested in jsdom and type-checked for Windows only; no WebView2 or Godot ran:

- The layout against the board at 1440 × 900 and at 1024 px wide: the five slots on one row,
  the pickers giving way, the strip and drawer under the box, nothing of Veistra's inside it.
  jsdom does no layout; only the CSS declarations are checked (`narrow.css.test.ts`).
- F5, Shift F5, F6, F7, F8, Ctrl R and Ctrl Shift M with the pane focused in WebView2, and that
  F5, Shift F5 and Ctrl R never reload the pane, in either mode. The focus returning to the
  mode's root after Back to live or a mode switch was tested with `document.hasFocus` stubbed,
  since jsdom forgets it when the focused element goes.
- Switching a pane with an embedded game to Editor hides the game, and back to Play shows it in
  the box; the scene picker's native dropdown hides the game while it is open.
- A Play pane reloaded by a cluster switch comes back in Play, and an Editor pane in Editor
  (`localStorage` per origin in WebView2).
- The read-only banner going when the title bar's switcher or `set_project` moves the cluster
  from the main checkout to a worktree.
- The captured-mouse hint with a real game: it needs #312's backend, which sends
  `mouseCaptured`, and a game that captures the mouse.

From #318, unit-tested in Rust and jsdom; no WebView2, Godot or Blender ran:

- The Godot app and the Blender viewer opened on the main checkout in the real window: the
  viewer, the reason under the bar, the `main` chip, Open in Godot and Open in Blender disabled.
- The Pop out wording on macOS and on Linux with X11 and with Wayland: the platform is read from
  `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE`, tested as strings only.
- A cloud session's reason: no cloud cluster can be made in this build.
- The reason line and the environment chip against the board at 1440 and 1024 px wide.
- A Blender export on main landing under app-local data, with a real Blender.

From #317, unit-tested in Rust through fakes (a fake Blender that writes the boot script's files,
a fake window system) and in jsdom, `export.py` and `veistra_boot.py` run headless in `bpy` 5.0.1
(`bpy_test.py`; `cargo test` runs it where `VEISTRA_TEST_BPY_PYTHON` names a Python with `bpy`,
and it skips without one), and type-checked and linted for Windows; no WebView2, Win32 window or
Blender with a window ran:

- Spec §13 test 12 on a real machine: with `bed.blend` open in Blender in a pane and v1 to v5
  kept, an agent's `export_blend` writes v6 and `bed.blend`'s bytes are unchanged; closing Blender
  removes `.veistra/locks/bed.blend.lock`. The Rust test runs the same steps with a fake Blender.
- Blender's window found by its class (`GHOST_WindowClass`) and placed over the box, after a
  splitter drag, a maximise and a cluster switch; Pop out and Dock; the still under a menu or the
  palette; the window handed back when its pane closes and when Veistra exits. Where the window
  first shows before the embedder places it, with no `-p`.
- Close: `WM_CLOSE` reaching Blender, its save prompt, and Cancel leaving it open; the boot
  script's `quit` with no window to post to. File dialogs and Preferences opening above Veistra.
- The boot script in a windowed Blender 4.2 and 4.5: `hello.json` and `state.json`, `select`,
  `viewport-only` (and back), `capture` with the view and selection, `pick` on a mesh, `quit`, and
  the timer surviving File > Open. The headless `bpy` run covers only what needs no window.
- The lock's process start time on Windows (`sysinfo`), and a Blender found through a launcher or a
  Steam install, where the pid Veistra starts is not Blender's: `hello.json`'s pid is locked.
- Paths on Windows: a `.blend` named with different case or with `\` reaching
  `relative_blend`, `lock::live_above` from Files' Open in Blender, and `canonicalize`'s `\\?\`
  prefix.
- The wire render fix with a real Blender's Workbench: dark lines on a light world, then the
  scene restored. The headless `bpy` test checks the PNG is not blank.
- Send selection reaching an agent's prompt with the text and the image; Mark up's pins named
  through `pick`.
- The Editor bar and banner against the Components and BlenderModel boards at 1440 and 1024 px
  wide; Compare's tooltip.

From #314, tested in jsdom and type-checked only; no WebView2, video decoder or Godot ran:

- Spec test 5: review within 2 s of F7 for a two-minute take of the demo (`data-open-ms`, above),
  and in which step the time goes if not.
- A pin on the enemy in a demo take naming `Hallway/Enemy_02`: the lift was tested on a tick
  written by hand, not one the addon wrote.
- The filmstrip drawn from a real take, through the asset protocol's CORS, with frames under
  their times while it fills in; the player and Send's pictures not disturbed by it.
- Arrow keys landing on the next decoded frame (WebView2 seeks to the nearest frame, which
  may not be the next one when the video's timestamps are not on the 30 fps grid).
- `godot:note_created` and `godot:mark_dropped` reaching PostHog.

From #315, unit-tested through fakes, jsdom and a Windows type-check; no WebView2, terminal,
agent tab, video decoder or media transcoder ran:

- A Send from a real take: every note's `markup.png`, `contact.png` and `context.json` in
  `.veistra/feedback/<take>-<n>/`, the contact sheet's frames under their printed times, and
  `packet.md` read against the AgentHandoff board.
- The line "Playtest feedback: N notes. Read @<packet>/packet.md first." waiting, unsent, at a
  Claude Code, Codex and Gemini CLI prompt, and in an agent tab as a chip with the words around
  it; a terminal picked in SEND TO and then closed refused with its reason.
- `clip.mp4`: the transcoder's trim (`SetTrimStartTime` and `SetTrimStopTime` read as positions in
  the source), its thread and apartment, the clip playing, and how long a clip of each note takes
  against Send's longer bridge timeout (30 s, plus 30 s a note with clips on).
- The seek timeout (5 s) never firing on a healthy take, so a slow first seek does not drop a
  picture.
- `godot:notes_sent` reaching PostHog.

From #321, unit-tested through fakes and jsdom and type-checked for Windows; no WebView2, Godot,
recorder, terminal or agent tab ran:

- A take at 1080p · 60 after choosing it with a game running: the take recording keeps 720p,
  the next is 1920x1080 at 60 fps (`take.json`), and its size for two minutes is near 120 MB.
  The board's 60 MB is the default quality's.
- Keep 5 with more takes on disk: the next save leaves five plus any with drafts.
- Show folder opening Explorer on `.veistra/takes/`, and on read-only main on the folder under
  the app's data, with nothing written to the checkout.
- The popover over the embedded game: the game hides while it is open, and Escape and a press
  on the game's still close it.
- The loop end to end with a Claude Code terminal and with an agent tab: Send, the agent's
  `resolve_play_note`, Still broken with a reply, the scene starting recorded, F8, F7, the
  review saying "Still broken · note N of Take M" with both takes listed, SEND TO on the same
  agent, and the line "Still broken after your fix: 1 note. Read @…/packet.md first." waiting
  unsent. `list_play_notes` then names the new packet and both takes.
- Still broken with capture missing: the text item at the agent's prompt, nothing run.
- `godot:notes_sent` with `followUp` reaching PostHog.

From #311, not yet run in a real Veistra (unit-tested only):

- `comments:changed` reaching every window and being relayed into the right cluster's app
  frames, including two clusters on one checkout and a cluster in a second window.
- Spec test 7 end to end: an agent session calls `list_play_notes` and `resolve_play_note` and
  an open card turns to "Fixed, check it" without a reload. The Blender Viewer and both modes
  of the Godot app listen for the push (#314); Play's review keeps its 2 s poll as the fallback.
- `telemetry:event` sent with `emit_to("main")` arriving once, in the main window's
  window-targeted listener only, and `godot:note_fixed` / `godot:note_resolved` reaching
  PostHog in a release build with a project key and consent on.

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
`godot/open-editor`, `blender-viewer/open`, `blender-viewer/editor-open`, `files/open-in-blender`,
`play/addon-install`, `play/addon-remove`, `play/send`, `comments/create` and `comments/verdict` are in
`WRITE_METHODS` and are refused on main before a handler runs. The Godot viewer's cache and the
Blender viewer's export cache go under the app-local data folder for main (Blender's keyed by
the checkout's path) and under `<env>/.veistra/` for a worktree; run channels are always in temp.

On main, Editor mode is the read-only viewer and says why under the toolbar
(`editor_surface.rs`, #318): Open in Godot and Open in Blender are disabled with that reason,
and the comment composers say comments cannot be kept in main.

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

## Blender in the pane (#317)

`blender/editor.rs`, `blender/lock.rs`, `blender/versions.rs` and `blender/veistra_boot.py`; the
methods are in `apps/blender_viewer.rs`, the agent's tools in `mcp/servers/blender_exports.rs`, and
the pane is `apps/blender-viewer/ui/src/editor/`. One Blender per cluster, and one per file across
clusters and across Blenders, through the lock.

**Opening.** Editor mode shows the `.blend` picker and Open in Blender. The press sends
`blender-viewer/editor-open {blend}`, which writes `veistra_boot.py` into a fresh channel folder,
starts `blender <file.blend> --python <channel>/veistra_boot.py` detached with
`VEISTRA_BLENDER_CHANNEL` naming the folder, takes the lock, and hands the window to the embedder
as kind `blender` for that pane (`embed/*` with `kind: "blender"`). Where there is no embedder the
same Blender opens in its own window and the bar says so. The pane polls
`blender-viewer/editor-state` every 500 ms: the process, the embed report, the file and its lock,
whether it has unsaved changes, and what the boot script last wrote. Refused on main, for a path
outside the environment, and while the file is open in another Blender.

**The bar.** Mode (Editor, Renders, Compare); the environment chip, the file, with a dot while
Blender has unsaved changes; the state chip: Not open, Starting, Editing, Popped out, Own window,
Closing; Viewport only, Mark up and Send selection; Pop out or Dock, and Close. Each tool is
disabled with its reason until the boot script has said hello. The footer names the Blender and
the boot script's version.

**The boot script** answers `select`, `viewport-only`, `capture`, `pick` and `quit` from one
persistent `bpy.app.timers` callback, and rewrites `state.json` when the file, its unsaved flag,
the selection or the 3D view change. None of its commands edits the scene. #320's Veistra tab in
the N-panel adds its commands to the same `COMMANDS` table and uses the two names kept for it,
`events.jsonl` and `notes.json`.

**One writer.** While Blender has the file open, `.veistra/locks/<file>.lock` holds Blender's pid
and start time, the cluster and the channel. A banner under the bar says "You have bed.blend open.
The agent's next export goes to v6 beside it and never overwrites your file.", with Compare with
v5 waiting for #319. Opening the same file again, from another pane, `blender-viewer/open` or
Files' Open in Blender, is refused with the holding process; a file Blender reaches through
File > Open that another Blender holds gets the conflict banner and no lock, until that one
closes.

**Exports.** Every export, the person's Export or an agent's `export_blend`, reads the saved
`.blend` headless and lands as the next `.veistra/exports/<asset>/v<n>/`; ten are kept. Renders
shows the newest; `blender-viewer/export-versions` lists them all, with the lock, for Compare.
On main the same tree is under app-local data.

**Closing.** Close asks Blender to quit as its own close button does, so Blender asks about
unsaved work and the person may cancel; the chip says Closing until the process ends, and the
watcher removes the lock. The pane closing or Veistra exiting hands the window back, still
running, and its lock stays until it exits.
