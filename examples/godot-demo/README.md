# Godot demo

A small Godot 4.3+ project for the acceptance runs in section 13 of
`docs/design/VEISTRA-PLAY-REVIEW.md`, and for anything else that needs a game with known names in
it. It uses no textures, so nothing has to be imported before it runs, and every scene is a
text `.tscn` that a test in `src-tauri/src/godot/scene.rs` holds to the names below.

| Scene                   | What it is for                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `levels/hallway.tscn`   | The main scene. `Hallway/Player` (group `player`, WASD, mouse look), `Hallway/Enemy_02` (a `CharacterBody3D` with a collider and a mesh, walking across the hall), a crate, walls, and an on-screen millisecond clock. |
| `levels/arena_2d.tscn`  | The 2D path: a `Camera2D`, `Arena/Player` and a walking `Arena/Enemy_02`, both `CharacterBody2D`.                                                                                                                      |
| `levels/bench.tscn`     | The tick-cost bench: 64 bodies in view and 1000 behind the camera (`bench.gd` exports both counts).                                                                                                                   |

`project.godot` has no `[autoload]` section on purpose. Play's **Enable capture** writes
`addons/veistra/veistra_capture.gd` and the autoload line, and **Disable capture** takes both out
again; `addons/veistra/` is in `.gitignore` because it is Veistra's copy, not the demo's.

## Opening it

Open Veistra's own checkout (or any environment of it) and open Play (the Godot app's Play mode
once #313 lands): the project list finds `examples/godot-demo`. Pick it, choose **Enable capture** and accept. Click in
the game to give it the mouse, and Esc to take it back.

The clock in the top left shows:

- `t`, seconds since the game started;
- `wall`, the clock the capture addon stamps every telemetry line with (the last 100 seconds of
  Unix time, to the millisecond);
- `F8 down`, the `wall` time at which this script, polling the keyboard, first saw F8 held;
- `Veistra keys the game was given`, the F7, F8 and Ctrl Shift M presses that reached the game's
  own `_input`. With capture on it stays 0.

## The checks, on Windows 11

Each needs a real Godot and, for the take files, Record on. `take.json` is in
`.veistra/takes/<id>/` of the environment.

1. **Ticks, design test 3.** Record on, run `hallway.tscn`, walk about for two minutes, press F7.
   In `take.json`, `tickRate` is 9 or more, and `take.mp4` is 60 MB or less.
2. **Tick cost, design 5.5.** Run `bench.tscn` with Record on for about 30 seconds. In `take.json`,
   `tickNodes` is 64 and `tickUsP95` is 500 or less. `refreshUs` in `telemetry.jsonl`, on the tick
   after each time the addon reads its candidates again (here only while the scene loads), is
   what that read cost.
3. **F8 timing, design test 4.** Record on, run `hallway.tscn`, press F8, then F7. In review, step
   to the mark: the frame there shows a `wall` within 100 ms of the `F8 down` the later frames
   show.
4. **Keys, design 4.4.** With the game focused, press F7, F8 and Ctrl Shift M: F8 flags appear in
   the live strip, Ctrl Shift M opens Mark up, F7 stops the run and opens review, and the clock's
   `Veistra keys the game was given` stays 0. WASD and Esc still reach the game. With the mouse
   held by the game, the live strip says "F7 stops and opens the take" (#313 draws it from
   `mouseCaptured`).
5. **Pick, B1 and B3.** In `hallway.tscn`, Ctrl Shift M, then drop a pin on the red capsule: the
   pin names `Hallway/Enemy_02` (`CharacterBody3D`, from a ray). A pin on empty floor names the
   floor. Repeat with Project Settings > Physics > 3D > Run on Separate Thread on, and with Jolt
   (4.4+). In `arena_2d.tscn`, a pin on the red square names `Arena/Enemy_02`.
6. **Without the addon, design test 8.** Disable capture and run again: Play runs, Rec shows why it
   is disabled, Mark up is disabled with its reason, and `pnpm probe recent_errors` lists nothing
   new in the shell or the backend (it does not cover the app's iframe).
7. **Exported builds.** Export the demo with capture enabled and run it by hand with
   `-- --veistra-dir=<an empty folder>`: nothing is written to the folder.
