# Godot: one app with Editor and Play, and Open in Godot

Code: `src-tauri/src/godot/` (`detect`, `runner`, `addon`, `scene`, `rpc`, `live`, `editor`,
`plugin`), one entry (`godot::rpc::godot`) routed from `apps/godot_viewer.rs` for the Godot app's
id, `godot-viewer`, and its `play` alias, and `src-tauri/src/agent_activity.rs` for the editor's
banner. Frontend: `apps/godot-viewer/ui`, where `App.tsx` is the mode shell, `editor/` is Editor
mode, `SceneMode.tsx` is the scene viewer Editor falls back to and `play/` is Play mode. Shared
types are in `apps/shared/godot.ts`.

Godot is never drawn by the webview. It is a native process Veistra starts and watches, and its
window is placed over the pane: the game's in Play, and the Godot editor's in Editor. Owner
decision 6 and spec section 11 replace `VEISTRA-UX-REWORK.md` section 3.1's "never embedded"
(the row "Embedded editors" below). Veistra stops a game; it never ends an editor.

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

**Takes** (`record.rs`, `takes.rs`, `session.rs`). Record is per project, per computer, off by
default, and needs addon v2 and Windows. A take is `.veistra/takes/<utc minute>-<4 hex>/` with
`take.mp4`, `telemetry.jsonl`, `log.jsonl`, `take.json` and `notes.json`; the last ten are kept,
plus any with drafts, and `.git/info/exclude` keeps them out of git. On read-only main they go
under the app's data instead. Time zero is the first video frame's wall-clock time; telemetry
and the log carry wall time, so every lane lines up on one clock.

**Addon v2** writes a tick ten times a second (scene, camera, player, frame time, viewport,
tracked node boxes), marks for F8, and keys F7 and Ctrl Shift M, which it handles so the game
never sees them. `pick` casts a ray through a point. The marker is `# veistra-capture v2`, so a
project holding v1 shows "Update capture".

**Send** (`feedback.rs`) writes `.veistra/feedback/<take>-<n>/` with `packet.md` and per note
`markup.png`, `markup.json`, `contact.png`, `frames/` and `context.json`, files each note as a
comment with a `take` anchor, and the page attaches `packet.md` at the agent's prompt. Agents
use `list_play_notes`, `start_play_note` and `resolve_play_note` on the workspace server, or
on the context server from an agent tab.

### Decisions

| Decision | Chosen | Why, and what was rejected |
|---|---|---|
| R1 child window or R2 owned popup | R2, pending the Day 1 spike | Graphics Capture records the game window alone, never Veistra's UI. R1 (`SetParent`) is not built; the spike is where `CreateForWindow` on a child window gets tried. |
| One Godot app or two (#313) | One app, two modes: Editor · Play (owner decision 1) | Play's UI moved into `apps/godot-viewer/ui/src/play/`, and one Rust entry answers both modes. The two apps that switched with `veistra/open` were rejected by the owner: a pane is the Godot app, and the mode is what it shows. |
| Record default | Off | Takes cost disk (open decision 2's recommendation). |
| Tracked nodes | The design's default | `veistra_track` when it has members, else bodies and visible meshes in view, nearest 64. |
| Video clip in the packet | Not built | The agent reads the contact sheet; the checkbox is shown disabled with why. |
| Retention | Ten takes | Open decision 7. |
| Video size | The window's, not 720p | `windows-capture` crops or pads, it does not scale. The bitrate is fixed at 3.5 Mbit/s, under 60 MB for two minutes. A D3D11 scaling pass is the follow-up. |
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
| Embedded editors (#316) | The person works in the Godot editor, and in Blender, inside a pane (owner decision 6, 2026-11-02); this row replaces `VEISTRA-UX-REWORK.md` §3.1's "never embedded". Agents still run both headless in terminal tabs | §3.1 kept the editors out so the pane could not hold a window Veistra does not own. The embedder (#309) answers that: the window is the person's, placed and handed back, never killed. Editing beside the agent, instead of in a second window behind Veistra, is the point of the rework. |
| How the editor starts (#316) | `godot --editor --single-window --path <the chosen project>`, at the pane's rect, the channel after `--`; only when the person presses Open the editor, never on mount | `--single-window` keeps Project Settings and every dialog inside the one window the embedder places. `--path` is the project folder the picker chose, not the environment root, which may hold several. Opening on mount was rejected: a cluster switch reloads every frame, and an editor is too heavy to start for a glance. |
| The Veistra plugin's floor (#316) | Godot 4.2 or later; on an older 4.x the editor still opens in the pane, with Mark up, Send selection and Viewport only disabled and saying why | `EditorInterface` became a singleton with its 3D viewports, and `distraction_free_mode` a property, in 4.2. A shim for 4.0 and 4.1 would be the only code in the plugin nobody could test. |
| The plugin's channel (#316) | The capture addon's: `cmd.json` in, `res-<id>.json` and `cap-<id>.png` out, `hello.json` and `state.json` from the plugin, in a temp folder named by `--veistra-editor-dir=` and by `VEISTRA_EDITOR_DIR` | No socket, as with the addon (DECISIONS X5). The variable is there because Godot's Restart editor drops the arguments and keeps the environment. |
| Close (#316) | `WM_CLOSE` to the editor's window, what its close button sends; with no window to post to, the plugin's `close`, which propagates `NOTIFICATION_WM_CLOSE_REQUEST`. Never a kill, never `quit()` | Spec §13 test 10: Godot asks to save, and the person may cancel. Closing the pane or Veistra hands the window back as a normal one (`Orphan::Release`), as #309 decided for editors. |
| Restart editor (#316) | The first state read after the editor exits cleanly (code 0, or no code for an adopted one) adopts a child of the old process that started within 15 s, and hosts it in the same pane | Godot's Restart editor starts the new editor as its child and quits; without this, the pane would say the editor closed while it reopened in its own window. An older child is something the editor ran, such as the game. |
| Godot's own Play from the editor (#316) | Left alone: under `--single-window` Godot's Run opens the game in its own window, outside the pane | Veistra's Play mode is where a run is placed, recorded and reviewed. Placing the editor's run too would make two owners for one window. |
| `project.godot` under a running editor (#316) | Enabling or removing the plugin or the capture addon is refused while Veistra's editor holds the project ("Close the Godot editor first") | The editor keeps its own copy of `project.godot` and writes it back on its saves. Routing the change through the plugin (`add_autoload_singleton`) was rejected: it needs the plugin installed to install the plugin, and gives two code paths for one change. |
| Picking a pin's node (#316) | The plugin's `pick`: `RenderingServer.instances_cull_ray` through the point, each mesh's faces with `segment_intersects_triangle` (its AABB for anything else), the nearest hit, climbed to the node the scene owns | It is what the editor's own click does. A physics ray was rejected: the editor does not step physics, and a mesh with no collider has nothing to hit. |
| Send selection (#316) | One `godot/editor-selection` answer (state, camera and viewport PNG), two Context items (`godot/<scene>/selection` text and `godot/<scene>/editor-viewport` image), then one `context/insert` with both, never Enter | Spec §13 test 11 asks for one message within 1 s; one plugin round trip is the slow part. The person sends the prompt, as with every Context reference. |
| Mark up in the editor (#316) | A viewport capture as the still, the editor window hidden while drawing, the markup tools Play uses (`FrameMarkup`, `resolvePins` shared), pins resolved through the plugin's `pick`; sent with `sendMarkup` under `godot/<scene>/markup` | The drawing belongs to one frame, so the window steps aside while the still is up, as it does for an overlay. A second markup surface for the editor would drift from Play's. |
| The banner (#316) | "An agent is working in this environment" over the box while an agent tab in a cluster on this root is busy, or a terminal there runs an agent CLI; Save all beside it, through the plugin | An agent reads files from disk, so unsaved edits are not what it sees. A terminal cannot say whether its agent is mid-turn, so an idle one counts: the banner is advice, and showing it too often is the cheaper mistake. |
| Ctrl Shift O in Play (#316) | Turns the pane to Editor mode | It started a second Godot in its own window that nothing tracked, beside the one Editor mode holds. `godot/open-editor` stays for agents and existing callers, and is refused while the pane's editor holds the project. |
| Open in Godot in the scene viewer (#316) | Always disabled, with the surface's reason | The viewer shows only where the editor cannot open (cloud, main, no Godot), so there is nothing for the button to start. It keeps its place so the bar does not change shape (#318). |
| The editor's floor size (#316) | The plugin lowers the window's minimum to 480 × 320 after the editor sets its own; without the plugin, nothing checks a pane smaller than 1024 × 600 | The editor holds its window at 1024 × 600, larger than many panes, and the embedder cannot shrink it below that. A size warning without the plugin was left out until a real pane shows how it looks cut off. |
| What an agent may call on the editor (#316) | `godot/editor-state`, `godot/editor-selection`, `godot/editor-capture`, `godot/editor-pick`, and the plugin's status, install and remove as for the capture addon; `app_call` refuses open, close, save, select, open scene and Viewport only | The editor in the pane is the person's: an agent reading what it shows is the point, an agent closing or steering it under the person is not. Agents edit the project on disk and run Godot headless. |
| `editor_opened` (#316) | Rust, once per open, `{plugin}` through `telemetry::track` | Whether people use the editor with the plugin is the question the plugin's cost rests on. A4's `features/godot.ts` must declare the event for the shell to forward it. |
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
| The Veistra tab's two files (#320) | Beside `cmd.json` in the editor's channel folder: `notes.json`, Veistra to the editor, one snapshot replaced whole through a `.tmp` and a rename, with a `rev`; `events.jsonl`, the editor to Veistra, one JSON line appended a press, an ask's `ask-<n>.png` written before its line. Rust tails the file, checks each line (`editor_notes::parse_event`) and numbers the good ones with a `seq`; a bad line with an `n` gets a failed ack, so the tab says why | DECISIONS X5. The editor never reads or writes `.veistra/comments/`, which can sit above `res://` and which only Veistra writes. A second `cmd.json`-style request and answer per press was rejected: it would put the person's press in the queue Veistra uses to ask the editor things, and a press needs an answer whether or not a pane is open to act. |
| Who carries out a press (#320) | The Editor mode pane, through the RPCs its own buttons use, then `godot/editor-ack` or `blender-viewer/editor-ack {n, ok, message}`, which the next `notes.json` carries back as `acks`; the backend hands an event on in every poll (`editor.events` after `eventsSince`) until it is answered | Ask needs `context/put` and `context/insert`, Mark up needs the pane's markup layer, and the verdict is the card's `comments/verdict`: all are the pane's already. Doing them in Rust would be a second copy of each. An agent may not call either ack (`app_call` refuses them): the press is the person's. |
| Ask the agent from the tab (#320) | The question, the scene or file, the selected nodes or objects, the camera and a picture of the viewport in one line; the pane files the text and the picture as two Context items, keyed by the ask's `n` so a second question does not replace the first, and types both in one `context/insert`, never Enter (X8). With no picture it still sends the text and says so in it | The done-when: one message with the text, the node path and the image. `context/agents` and a SEND TO choice are B4's (#315) and not on this branch, so the question goes to the agent prompt `context/insert` picks. |
| Looks good and Still broken in the tab (#320) | Only on a note whose status is `fixed`, as on Veistra's card; the pane sends `comments/verdict` with `expect: "fixed"`, and the store refuses it when the note is no longer fixed | The tab shows the note as `notes.json` last had it. Without the check a Still broken pressed after the agent had reopened the note would add a second reply to work the person never saw. |
| Which notes the Godot dock shows (#320) | Notes on a selected node in the edited scene (`Anchor::Node` now records `scene`; a note from before has none and shows in any scene with that path), and Play's notes on that node, in this scene or under another root (`Main/Hallway/Enemy_02` for `Hallway/Enemy_02`) | A node path alone matches the same name in two scenes. Play's paths start at the running game's root, which the edited scene is often instanced under. |
| Which notes Blender's tab shows (#320) | Notes on a part (`Anchor::Mesh`) whose name is a selected object's, in the open file when the note records one; no Play notes | X12: a Godot node path is not a Blender object name, and no mapping is decided. `blend` on a mesh note is #319's; until it lands, Blender notes carry none and show for any file with that object name. |
| The tab's picture (#320) | Godot: the main screen's viewport (2D when the 2D screen is up, else the first 3D viewport), scaled to 1600 px on its long side. Blender: the 3D view drawn off screen (`GPUOffScreen.draw_view3d`) at no more than 1600 px, else Blender's screenshot of the area | What the person is looking at when they ask, small enough for one Context image. The off-screen draw leaves out the sidebar the tab itself is in. |
| Notes reaching the tab (#320) | `notes.json` is rewritten in the Editor pane's poll (every 500 ms) when the comment files' count, size or newest time, the scope or the acks changed; the dock reads it every 250 ms by its text, Blender's tab in its 250 ms timer, and selecting a node redraws at once | The done-when: a selected node's notes within 1 s. Watching `.veistra/comments/` with a file watcher was rejected for now: the pane's poll already runs while the editor is in it. |

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

From #316, unit-tested in Rust through fakes and in jsdom, the GDScript parsed and linted with
`gdtoolkit` and its structure pinned in vitest, and type-checked for Windows; no WebView2, Win32
window or Godot ran:

- Spec test 10: Project Settings, and every other editor dialog, opens inside the box under
  `--single-window`; Close posts `WM_CLOSE` and Godot's save prompt appears, and Cancel leaves the
  editor open; with no window to post to, the plugin's close does the same.
- Spec test 11: Send selection reaches the agent's prompt within 1 s of the press, with the node
  paths, the camera and the viewport image, on a large 3D scene.
- The editor placed on the box after a splitter drag, a maximise and a cluster switch; Pop out and
  Dock; the editor still under a menu or the palette; the editor handed back as a normal window
  when its pane closes and when Veistra exits.
- Restart editor (Project, Reload Current Project, and the restart a changed setting asks for)
  adopted into the same pane, on Windows, where a dead parent's id stays on its child.
- The plugin on Godot 4.2, 4.3, 4.4 and 4.5: `hello.json`, `state.json`, the viewport and window
  captures, `pick` on meshes, CSG and an instanced scene, `select`, `open`, Viewport only, Save all,
  and the `.uid` file 4.4 writes being removed with the plugin. An older 4.x opening with the tools
  disabled.
- The minimum size override: a 600 × 400 pane holding the whole editor with the plugin, and how a
  small pane looks without it.
- The banner with a real agent tab and with Claude Code, Codex and Gemini in a terminal tab, on
  this root and on another worktree's.
- `godot:editor_opened` reaching PostHog, which needs A4's `features/godot.ts` to declare it.

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

From #320, unit-tested in Rust (the two files, the checks, the acks, the verdict guard) and in
jsdom (the pane carrying out each press), the dock parsed and linted with `gdtoolkit` and its
structure pinned in vitest, Blender's tab registered and its operators run headless in `bpy`
5.0.1 (`bpy_test.py`), and type-checked and linted for Windows; no Godot, no Blender with a
window, no GPU and no WebView2 ran:

- The done-when on a real machine: selecting Enemy_02 in the Godot editor in a pane shows its
  notes in the Veistra dock within 1 s, and a note written in Scene mode or Play appears there
  within 1 s; Ask sends the text, the node path and a viewport image to the agent's prompt in one
  message.
- The dock in Godot 4.2 to 4.5: added to the right upper dock slot when Veistra started the
  editor and absent when the project is opened in Godot by hand, removed with the plugin, the
  2D and 3D viewport pictures, a reply typed while `notes.json` changes, and the dock's layout
  in a narrow slot.
- Blender's tab in a windowed Blender 4.2 and 4.5: the Veistra tab in the 3D view's sidebar,
  the off-screen picture (`bpy` here has no GPU, so only the screenshot fallback's call is
  checked, and not its picture), Looks good and Still broken, and the tab surviving File > Open.
- `events.jsonl` appended by Godot's `FileAccess` and Python while Rust reads it, and
  `notes.json` replaced on Windows while the dock or the tab has it open: the rename is tried
  again on the next poll when it is refused.

## The Godot editor in the pane (#316)

`godot/editor.rs`, `godot/plugin.rs` and `veistra_editor.gd`; the pane is
`apps/godot-viewer/ui/src/editor/`. One editor per cluster, and one per project folder across
clusters, since two editors on one folder write over each other's saves.

**Opening.** The pane shows the project picker, the scene picker and Open the editor. The press
sends `godot/editor-open {project}`, which starts
`godot --editor --single-window --path <project> --windowed --resolution <pane> --position <pane on
screen> -- --veistra-editor-dir=<channel>` with `VEISTRA_EDITOR_DIR` set to the same folder, and
hands the window to the embedder as kind `godotEditor` for that pane (`embed/*` with
`kind: "godotEditor"`). The pane polls `godot/editor-state` every 500 ms: the process, the embed
report, what the plugin last wrote, and whether an agent works here. Refused on main, for a Godot 3
project, and while another cluster's editor holds the project.

**The bar.** Mode; the environment chip, the project picker (disabled while the editor runs) and
the scene picker (which opens the scene in the editor, through the plugin); the state chip:
Not open, Starting, Editing, Popped out, Own window, Closing; Viewport only, Mark up and Send
selection; Pop out or Dock; Close. Every tool that needs the plugin is disabled without it and says
why in its title, in words the backend gives (`plugin.why`).

**The plugin** (`addons/veistra/plugin.cfg`, `addons/veistra/veistra_editor.gd`,
`addons/veistra/veistra_dock.gd`, one `[editor_plugins]` entry), opt-in behind a consent that lists what it adds, what it reports and
takes, and that it uses no port. It is idle unless Veistra started the editor: no argument and no
variable, no channel. It writes `hello.json` once and `state.json` whenever the edited scene, the
open scenes, the selection or the main screen change; it answers `selection`, `capture`, `pick`,
`select`, `open`, `viewport-only`, `save` and `close`. The Veistra dock it adds (#320) is
described below.

**Mark up** captures the 3D viewport, hides the editor's window for as long as the still is up,
and opens Play's markup tools over it. On Done each pin is resolved by `godot/editor-pick` at its
point, so it carries the node path and world point the editor's own click would give; the markup
JSON records the source with `engine: "godot"`, `view: "editor"` and the scene, and the editor
camera. It is sent as Play's markup is.

**Send selection** asks the plugin for the selection, the camera and the viewport in one answer
and files them as two Context items, the text the agent reads and the image, then types both
references into the agent's prompt in one `context/insert`. With nothing selected it sends
nothing and says so.

**The banner.** While an agent is working in this environment (`agent_activity.rs`), a line over
the box says so and offers Save all, which asks the plugin to save every open scene; without the
plugin its title says to press Ctrl S in Godot.

**Closing.** Close asks Godot to close as its own close button does; the chip says Closing until
the process ends, and the pane then says the editor closed, with the exit code when it was not 0.
The pane closing or Veistra exiting hands the window back, still running.

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
`godot/open-editor`, `godot/editor-open`, `godot/editor-save`, `godot/plugin-install`,
`godot/plugin-remove`, `blender-viewer/open`, `blender-viewer/editor-open`, `files/open-in-blender`,
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
the selection or the 3D view change. None of its commands edits the scene. The Veistra tab it
adds to the 3D view's sidebar (#320, below) adds no command: it reads `notes.json` and appends to
`events.jsonl` from the same timer.

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

## The Veistra tab inside Godot and Blender (#320)

`editor_notes.rs`, `godot/veistra_dock.gd` and the tab in `blender/veistra_boot.py`; the pane's
half is `apps/shared/editorEvents.ts`, used by both Editor modes. A Veistra tab in the editor
shows the notes on what is selected there, and its buttons ask the pane to act.

**Two files** beside `cmd.json` in the editor's channel folder. `notes.json` is Veistra's:
`{version, rev, notes, problem, acks}`, replaced whole whenever the Editor pane's poll finds the
comment files, the open file or the acks changed. Each row carries the anchor (`kind`, `path` or
`part`, `scene`), the card's title and status words, the body, the thread and the agent's fix
note. `events.jsonl` is the editor's: one line a press, `ask`, `verdict` or `markup`, each with
the editor's own `n` and a time; an ask writes `ask-<n>.png` first and names it. The backend
tails the file, refuses a line that fails its checks with a failed ack, and hands the rest to
the pane as `editor.events` in `godot/editor-state` and `blender-viewer/editor-state`, numbered
by `seq`, until each is answered.

**The pane** passes `eventsSince` on its poll and carries out each new event once, in order:
Ask the agent puts the question and the picture as two Context items and types both at the
prompt in one `context/insert`, never Enter; Looks good and Still broken are `comments/verdict`
with `expect: "fixed"`; Mark up opens the mode's own Mark up, or is refused with the bar's reason
while the plugin or the boot script is not running. Each is answered with `editor-ack {n, ok,
message}`, and the tab shows the message.

**Godot's dock** (`veistra_dock.gd`, added by `veistra_editor.gd` to the right upper dock slot
only when Veistra started the editor) lists the notes on the selected nodes: node notes in the
edited scene, and Play's notes on that node. A note the agent fixed has a reply box and Looks
good / Still broken. Under the list are a question box, Ask the agent and Mark up the viewport,
and a line saying what the last press came to.

**Blender's tab** (the Veistra tab in the 3D view's sidebar, N) lists the notes on parts named
like the selected objects, with the same buttons. It is registered only when the boot script has
its channel, so a Blender opened by hand has no Veistra tab, and its operators do not touch the
scene or the undo history.

