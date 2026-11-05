# Play, Godot editor and Blender views: design v0.2

Owner: Braden Seaborn. Date: 2026-11-02 (v0.1: 2026-10-30). State: DRAFT FOR AGENT HANDOFF.

Tracking issue: #307. Issues: #308 to #321.

v0.2 changes, from the owner's canvas comments: the Godot editor and Blender themselves run inside the pane (section 11), and Compare gets a change view (section 12).

Design canvas: "Veistra — Play, Scene and Blender views", https://claude.ai/artifact/UMKJaSBt66EEkmcQnAhefm (9 boards).
Launch: 2026-11-06. The P0 items in section 3 shall be done and tested by 2026-11-05.

What has been built, the decisions taken while building it, and what still needs a Windows machine are recorded in `docs/design-notes/godot-play.md`. Its "Decisions" table is the decision log this spec refers to.

## Decisions taken by the owner, 2026-11-02

1. One Godot app with Editor and Play modes. The `play` app id opens it in Play mode.
2. Record is off by default.
3. Issue A1 picks R1 or R2 for window placement.
4. Keep the last 10 takes per environment.
5. No video clip in the agent packet by default.
6. Godot and Blender themselves run inside the pane. This replaces `docs/VEISTRA-UX-REWORK.md` §3.1.

## 1. Goal

A user plays their game inside a Veistra pane. With Record on, every run is kept as a take. The user drops marks while playing, then reviews the take on a timeline, draws on a frame or a range, and sends the notes to an agent. The agent gets images and scene data for the fix, fixes the problem, and reports back on the note. The user plays again and closes the note.

The Godot editor and Blender run inside a pane, under a thin Veistra bar. Users keep the tools they know. The bar adds `Mark up`, `Send selection` and the same notes as Play. A small Veistra plugin inside each editor shows the notes on the selected node or object.

## 2. What exists today

This table is the state at v0.1 (2026-10-30). Since then the v0.1 work has landed: the game in the pane, Record and takes, addon v2, review, Send and the three MCP tools. `docs/design-notes/godot-play.md` describes what is built.

| Part | Location | State |
|---|---|---|
| Play app | `apps/play/ui/`, `src-tauri/src/apps/play.rs` | Runs the debug build. The game opens in its own window. The pane shows only the log. Capture & comment takes one PNG. |
| Godot runner | `src-tauri/src/godot/runner.rs` | `godot --path <project> [scene] -- --veistra-dir=<tmp>`. Kills the process tree on stop. |
| Capture addon v1 | `src-tauri/src/godot/veistra_capture.gd`, `addon.rs` | Opt-in autoload. File channel in a temp folder: `capture`, `pause`, `resume`. No network port. |
| Godot Viewer | `apps/godot-viewer/ui/` | Scene/Play switch (Play only redirects), scene tree, 3D view of an exported `.glb`, headless screenshot. |
| Blender Viewer | `apps/blender-viewer/ui/`, `blender_viewer.rs` | `.glb` view, renders, parts list, stale-export badge. |
| Markup | `apps/shared/useMarkup.ts`, `MarkupPanels.tsx`, `packages/markup` | Excalidraw ink over a frame. Output is `markup.png` + `markup.json`, per `docs/markup-format.md`. |
| Comments | `apps/shared/comments.ts`, `src-tauri/src/comments.rs` | Anchors `node`, `mesh`, `scene` (time + screenshot). Files in `.veistra/comments/`. Status and agent resolution exist. |
| Send to agent | `apps/shared/SendFooter.tsx` | One footer and one send action for every viewer. |

Reuse every part. Nothing in this design replaces the markup format or the comment store. It extends both.

## 3. Scope

### P0, for the launch

1. Play renders inside the pane on Windows (section 4).
2. Record toggle, takes on disk (section 5).
3. F8 marks while playing (section 6).
4. Mark up on the live frame, with object picking (section 7).
5. Review a take: video, lanes, notes, markup on a frame or a range (section 8).
6. Send: feedback packet on disk, message to the agent, three MCP tools (section 9).
7. Note status on cards and lanes (section 10).
8. The Godot editor and Blender run inside the pane on Windows, with the Veistra bar, `Mark up` and `Send selection` (section 11).
9. One toolbar shape in Godot Play, the Godot editor and Blender (Components board).

### P1, the week after launch

1. The Veistra tab inside Godot and inside Blender (section 11.2).
2. Blender versions strip and Compare with the change view (section 12).
3. Record settings popover with quality and retention.
4. "Still broken" sends a new take linked to the old note.

### Later

1. Cloud sessions: the game runs on the worker VM, frames stream to the pane over WebRTC, input goes back.
2. macOS and Linux Wayland embedders. Until then they use Pop out.
3. Talk while you play: microphone narration, transcribed into the notes lane.

## 4. Live view: the game inside the pane

### 4.1 How

Godot 4.4 added an embedded game view to its own editor. The game stays a separate process, and a game crash never takes the editor down. Window management makes the game look embedded. Godot does this on Windows, Linux and Android.

Its release notes state that macOS needs a different approach. Veistra shall use the same idea on Windows: keep the game process separate and place its window over the pane. The same embedder places the Godot editor and Blender (section 11).

Two ways to place it. The Day 1 spike shall pick one and record the choice as a decision row:

| | R1 child window | R2 owned popup |
|---|---|---|
| How | `SetParent` the game window into the Veistra window, add `WS_CHILD`, drop the caption | Keep it top level: `WS_POPUP`, `WS_EX_TOOLWINDOW`, owner = Veistra window, no taskbar entry |
| Moves with Veistra | Free | Reposition on every window move event |
| Recording | If Graphics Capture refuses a child window, capture the Veistra window and crop | Graphics Capture on the game window directly |
| Overlays | Game paints above the WebView | Same |

Recommendation: R2, because the recorder then captures the game window alone and never records Veistra's own UI. Verify in the spike whether `CreateForWindow` accepts a child window before ruling out R1. Godot's own Windows code for its editor embed is a useful reference.

The decision row is "R1 child window or R2 owned popup" in `docs/design-notes/godot-play.md`, under Decisions. The spike that produces its evidence is `src-tauri/src/godot/spike.rs`, behind the `embed-spike` feature.

### 4.2 Steps

1. The runner spawns Godot as today, plus `--windowed --resolution <w>x<h>` sized to the pane, and a position off screen to stop the window flashing.
2. The embedder finds the game's top-level window by process id (`EnumWindows` + `GetWindowThreadProcessId`). It waits up to 10 s for a visible window. After 10 s it stops and leaves the window in place.
3. It removes the caption and borders and places the window over the pane's game box.
4. The pane sends `play/embed_rect {x, y, w, h, visible}` in CSS pixels on every resize, scroll, layout change, tab switch, cluster switch and maximise. The backend converts to physical pixels with the window's scale factor and the WebView's offset. Updates are coalesced to one per frame.
5. When the pane is hidden (another tab, another cluster, minimised), the game window is hidden and the game keeps running.
6. **Pop out** returns the window to a normal decorated window. **Dock** brings it back.

### 4.3 Airspace rules

The game window paints over web content. Thus:

1. No Veistra element shall sit inside the game box while the game is shown. The toolbar, live strip and drawer sit outside it. The board shows this layout.
2. When any overlay opens that intersects the game box (menus, Ctrl K palette, dialogs, toasts, a dragged tab), the shell dispatches `veistra:overlay-open`. Play swaps the game window for its last frame as a still image, and swaps back on `veistra:overlay-close`.
3. A capture still comes from the recorder's last frame if recording, else from the addon's `capture`.

### 4.4 Keys while the game has focus

The game owns the keyboard while focused. When launched by Veistra, addon v2 handles three keys itself and forwards them on the file channel: **F7** (stop and review), **F8** (mark), **Ctrl Shift M** (mark up). It marks them handled. The game never sees them. Every other key goes to the game. If the game captures the mouse, the live strip shows "F7 stops and opens the take".

### 4.5 Fallback

If embedding fails or the platform has no embedder, the game opens in its own window as today. The live strip shows "Playing in its own window". Nothing else changes.

## 5. Recording

### 5.1 Toggle

Rec is a per-project setting in the workspace state, default off. While on, every run is recorded until the user turns it off. The board shows the four button states.

### 5.2 Recorder

1. Use the `windows-capture` Rust crate. It wraps Windows Graphics Capture and has a hardware video encoder that writes MP4. Check its licence before adding it to `deny.toml`.
2. Capture the game window (R2) or the cropped pane (R1). Encode H.264, 720p at 30 fps by default, a keyframe every second, no audio at launch.
3. Write to `.veistra/takes/<yyyy-mm-dd-hhmm>-<4 hex>/take.mp4` inside the environment.
4. Keep takes out of git through the worktree's `.git/info/exclude`, not the project's `.gitignore`.

### 5.3 One clock

Every stream stamps wall-clock milliseconds: video frames, addon telemetry and log lines. Take time is wall time minus the first video frame's time. The F8 test in section 13 checks the offset.

### 5.4 Files in a take

| File | Content |
|---|---|
| `take.mp4` | The video |
| `telemetry.jsonl` | Addon ticks and events, one JSON object a line |
| `log.jsonl` | Runner log lines with level and time |
| `take.json` | Summary, written on stop |
| `notes.json` | Draft notes, written as the user types |

`take.json`:

```json
{
  "version": 1,
  "id": "2026-10-30-1402-0f3a",
  "environment": { "branch": "wt/enemy-chase", "commit": "8c41e07" },
  "godot": "4.5.1",
  "startedAt": 1793398920000,
  "durationMs": 151400,
  "video": { "width": 1280, "height": 720, "fps": 30 },
  "scenes": [{ "path": "res://levels/hallway.tscn", "fromMs": 0, "toMs": 125000 }],
  "marks": [41060, 72010, 104400],
  "counts": { "errors": 1, "warnings": 1 }
}
```

### 5.5 Addon v2 telemetry

A tick 10 times a second:

```json
{"t":1793398962180,"kind":"tick","scene":"res://levels/hallway.tscn",
 "camera":{"pos":[12.1,1.6,-2.3],"target":[14.0,1.2,-6.6],"up":[0,1,0],"fov":70},
 "player":{"path":"Hallway/Player","pos":[12.1,0,-2.3]},
 "frameMs":16.4,
 "nodes":[{"path":"Hallway/Enemy_02","type":"CharacterBody3D","rect":[905,210,250,410]}]}
```

Events: `{"kind":"mark"}`, `{"kind":"scene","scene":...}`, `{"kind":"key","key":"F7"}`.

Rules:

1. Tracked nodes are the nodes in the group `veistra_track` when that group has members. Otherwise they are the `CollisionObject3D` and `VisualInstance3D` nodes inside the camera frustum, nearest first, 64 or fewer.
2. `rect` is the node's projected bounding box in viewport pixels, clamped to the viewport.
3. 2D games use the active `Camera2D` and each node's global rect.
4. The player is the first node in the group `player`, if any.
5. A tick shall cost 0.5 ms or less at 64 nodes. Writes append to the channel folder and flush once a second.
6. The addon does nothing unless the game was launched with `--veistra-dir`. Exported builds are unaffected.
7. Bump the marker to `# veistra-capture v2`. The existing update prompt then offers the new script.

### 5.6 Retention

Keep the last 10 takes per environment. A take with draft notes is kept until those notes are sent or deleted. A sent packet holds its own copies of the frames. Deleting a take never breaks a packet.

## 6. Marks

F8 in the game, or the toolbar Mark button, writes a `mark` event. The live strip shows a flag at once. A mark is not a note. In review, each mark is listed as "Make a note" or "Dismiss". A mark that sits within 2 s of an error line shows that line, because the error is a first lead for the note.

## 7. Mark up on the live frame

1. Ctrl Shift M or the Mark up button: addon `pause`, then `capture` (existing).
2. The pane swaps the game window for the PNG and opens the existing markup tools over it.
3. A pin calls addon `pick {x, y}`. The addon casts a ray from the camera through the point (`PhysicsDirectSpaceState3D.intersect_ray`) and returns `{nodePath, type, worldPoint}`. If the ray hits nothing, it uses the tracked node rects.
4. Done creates a note at the current take time (if recording) and resumes the game.

## 8. Review

### 8.1 Opening

Review opens on F7, on "Stop and review", or when a take is picked from the Take menu. It shall open within 2 s of stop for a 2-minute take.

### 8.2 Layout

The PlayReview board is the reference: markup tools above the frame, the frame, the timeline, the Notes panel at the side.

1. The frame is a `<video>` element. The take is served through Tauri's asset protocol, with the takes folder added to the asset scope.
2. Lanes, top to bottom: Frames, Notes, Marks, Log, Scenes, Frame time.
3. The filmstrip is made in the page: a hidden `<video>` seeks every 2 s and draws to a canvas. No ffmpeg.
4. Keys: Space, the arrow keys (one frame), I and O (range), N (new note), Ctrl Enter (send).

### 8.3 A note

```json
{
  "n": 2,
  "kind": "range",
  "atMs": 102180, "inMs": 98000, "outMs": 106000,
  "body": "The enemy walks into the east wall ...",
  "target": { "nodePath": "Hallway/Enemy_02", "type": "CharacterBody3D",
              "worldPoint": [14.2, 0.0, -6.8], "source": "recorded" },
  "markup": { "...": "the markup.json document, unchanged format" },
  "doneWhen": "tests/chase_wall.gd passes"
}
```

1. `n` is stable and never reused, the same rule as markup pins.
2. `target.source` is `pick` for live mark up and `recorded` for review. A recorded target is the smallest tracked rect under the pin in the tick nearest `atMs`.
3. `doneWhen` is optional. The field holds the user's acceptance condition, written in plain words or as a probe command.
4. Errors and warnings within 10 s of the note are attached automatically.

## 9. Send

### 9.1 The packet

Send writes `.veistra/feedback/<take id>-<send n>/`:

```text
packet.md            the agent reads this first
take.json            copy
notes/<n>/markup.png the frame with ink
notes/<n>/markup.json
notes/<n>/contact.png frames at 1 a second from in − 2 s to out + 2 s, at most 16, 4 columns, time on each
notes/<n>/frames/    in.png, note.png, out.png at full size
notes/<n>/context.json scene, target, camera, player, log lines, frame time
notes/<n>/clip.mp4   only when "Video clip per note" is ticked
```

The agent reads images, not video. `contact.png` carries the motion. Contact sheets and frames are made in the page from the `<video>` and written through one `invoke`. The AgentHandoff board shows `packet.md`.

### 9.2 Delivery

1. The selected agent session gets one message through the existing send path: "Playtest feedback: 2 notes. Read `<packet>/packet.md` first."
2. Each note becomes a comment in `.veistra/comments/` with a new anchor kind (section 10). The Godot editor and Blender then show the note on its node or part.

### 9.3 MCP tools

Add to the workspace MCP server, in the existing snake_case style:

| Tool | Does |
|---|---|
| `list_play_notes` | Open notes for this environment, with packet paths |
| `start_play_note` | Sets a note to Agent working |
| `resolve_play_note` | `{id, summary, commit?}`, sets the note to Completed |

## 10. Note status

| Status | Set by | Shown as |
|---|---|---|
| Draft | User typing | Grey word |
| Sent | Send | Blue dot |
| Agent working | `start_play_note` | Amber dot |
| Completed | `resolve_play_note` | Accent dot, with the agent's summary, a note that the agent completed it and the person should check it and resolve it, and **Play `<scene>`**, **Resolve**, **Still broken** |
| Resolved | User, Resolve | Green dot, folded at the bottom |

Extend `comments.rs`:

1. Anchor kind `take`: `{take, atMs, inMs?, outMs?, packet}`.
2. Statuses `open`, `working`, `fixed`, `resolved`. An agent resolve sets `fixed`. Only the user sets `resolved`.
3. Still broken sets `open` again and adds the user's reply.

## 11. Godot editor and Blender in the pane

This section replaces a rule in `docs/VEISTRA-UX-REWORK.md` §3.1 (2026-09-28): "Godot and Blender are never embedded". The person now works in the editors themselves, inside a pane. Agents still run both headless.

### 11.1 How

1. The embedder from section 4 places three window kinds: the game, the Godot editor and Blender. One code path serves all three.
2. Godot: `godot --editor --single-window --path <environment>`. Single-window mode keeps every dialog inside the editor window.
3. Blender: `blender <file.blend> --python <veistra_boot.py>`, started in the environment. The boot script loads the Veistra add-on for that session only. Nothing is installed into the user's Blender.
4. Blender file dialogs and preferences open as their own windows above Veistra, owned by Blender.
5. The Veistra bar sits above the editor. It holds the mode switch (Editor · Play, or Editor · Renders · Compare), the environment chip and a state chip. Its buttons are `Viewport only`, `Mark up`, `Send selection`, `Pop out` and `Close`. No Veistra element sits over the editor box (section 4.3).
6. **Viewport only** turns on Godot's distraction-free mode or Blender's maximised area, through the plugin or add-on.
7. **Mark up**: the plugin or add-on returns a viewport image and the 3D camera. The pane swaps the editor window for that still and opens the markup tools. Pins resolve through the editor's own picking.
8. `Send selection`: the selected nodes or objects, their paths and a viewport image go to the agent session as one message.
9. Godot's own Play inside the embedded editor still works. **Play** in the Veistra bar runs the game in Play mode with Record (sections 4 to 8).

### 11.2 Veistra plugin and add-on

| | Godot editor plugin | Blender add-on |
|---|---|---|
| Lives in | `addons/veistra/` in the project, opt-in, beside the capture addon | Loaded per session by `--python`, never installed |
| Channel | The temp-folder file channel from section 2 | The same channel, polled with `bpy.app.timers` |
| Reports | Selected nodes, edited scene, 3D camera, viewport PNG | Selected objects, open file, view matrix, viewport PNG |
| Commands | Select node, open scene, viewport only | Select object, viewport only |
| Veistra tab (P1) | A dock: notes on the selected node, Ask the agent, Mark up | An N-panel tab with the same three |

### 11.3 Two writers

1. Godot reloads files that change on disk. While an agent session works in the same environment, the bar shows a banner: save before you send.
2. Blender never reloads a `.blend` by itself. While Blender has a file open, Veistra writes `.veistra/locks/<file>.lock`. The agent's Blender tools shall refuse to save over a locked file and write the next version beside it.
3. Closing the editor removes the lock.

### 11.4 Fallback

Three cases open the read-only viewer from v0.1: a cloud session, the main checkout, and a machine without the editor. The viewers live in `apps/godot-viewer` and `apps/blender-viewer`. macOS and Linux Wayland use Pop out until each has an embedder.

## 12. Blender Compare (P1)

1. Every agent export is kept in `.veistra/exports/<asset>/v<n>/` with `{commit, time, author, triangles}`, last 10 kept. The versions strip sits below the editor.
2. Two views: **Changes**, the default, and **Split**. One camera serves both versions.
3. Change classes: Added (blue fill), Changed (amber hatch), Removed (coral dashed ghost of version A), Unchanged (grey). Each class has a toggle and a triangle count. Each class has its own fill pattern and its own colour.
4. **Next change** (N) frames the next changed region.
5. The side list shows each part with its counts and material changes, then the notes from version A with Looks good and Still broken.

### 12.1 How the diff works

1. A Web Worker loads both `.glb` exports with the three.js loader the viewer already uses.
2. Parts match by object name. A part only in B is all Added. A part only in A is all Removed.
3. For a matched part, each triangle goes into a spatial hash keyed by its centroid, with 5 cm cells.
4. A triangle in B is Unchanged when a triangle in A has all three corners within ε = 1 mm. The triangle is Changed when the nearest A centroid is within δ = 5 cm. Every other B triangle is Added.
5. A triangle in A with no B centroid within δ is Removed.
6. Material changes compare the material name and the scalar and colour values in the export metadata.
7. Budget: 200,000 triangles on each side in 2 s or less on the owner's laptop.

## 13. Build order and tests

Split across three agents, each in its own worktree:

| Agent | Work, in order |
|---|---|
| A, Rust | Day 1 spike R1 vs R2 → embedder → `embed_rect` → recorder → take writer → comment anchor and statuses → MCP tools |
| B, addon and Play UI | Addon v2 (ticks, marks, keys, `pick`) → live strip and toolbar → review page → notes → packet writer in the page |
| C, editors | Godot editor plugin and Blender boot add-on → Veistra bar over the editors (uses agent A's embedder) → lock file → fallback to the read-only viewers → Compare change view (P1) |

Acceptance, run on the demo game and on Anomaly, Windows 11:

1. The game runs inside the pane with no title bar. After a pane resize ends, the game matches the new box within 50 ms.
2. Opening a menu, the Ctrl K palette or a dialog over the game shows the still frame. The game never paints over Veistra UI.
3. A 2-minute recorded run gives a `take.mp4` of 60 MB or less, with 9 or more ticks a second on average.
4. In the demo game, add an on-screen millisecond timer. Press F8 at a known moment. The mark lands within 100 ms of that frame in review.
5. Review opens within 2 s of F7.
6. Send writes `packet.md`, and every note has `markup.png`, `contact.png` and `context.json`.
7. An agent session calls `list_play_notes` and `resolve_play_note`, and the card shows Completed without a reload.
8. With the addon removed, Play still runs, Rec shows its disabled state, and nothing throws.
9. On a machine where embedding fails, the game opens in its own window and the live strip shows "Playing in its own window".
10. The Godot editor opens inside the pane. Project Settings opens inside the editor box, not as a separate window.
11. Select a node in the embedded editor and press `Send selection`. The agent session gets the node path and a viewport image within 1 s.
12. With `bed.blend` open in Blender, an agent export writes v6. The bytes of `bed.blend` stay unchanged.
13. Change view on a test pair: a 1 m cube, then the same cube with its top face extruded 2 cm. The view reports 8 added, 2 changed and 0 removed triangles.

PostHog events to add for launch data: `play_embedded`, `play_embed_failed`, `take_recorded`, `mark_dropped`, `note_created`, `notes_sent`, `note_fixed`, `note_resolved`.

## 14. Open decisions for the owner

0. **Embedded editors.** Add a decision row that replaces `docs/VEISTRA-UX-REWORK.md` §3.1, and point §3.1 to it. The owner's comment on 2026-11-02 sets the direction. The row records it.
1. **One Godot app.** Move Play's UI into the Godot app as its Play mode, and make the `play` app id open Godot in Play mode. Recommended. The other way keeps two apps with a shared toolbar.
2. **Record default.** Off, recommended, because takes cost disk. On catches first-run bugs.
3. **R1 or R2.** The Day 1 spike decides, then a decision row records it.
4. **Terms** for `core/terminology.csv`: take, mark, note, feedback packet, contact sheet. The boards use "note" everywhere now, and the code uses "comment". Pick one word for all three surfaces.
5. **Tracked nodes.** The default policy in 5.5, or only the `veistra_track` group.
6. **Video clip** in the packet off by default.
7. **Retention** of 10 takes.
