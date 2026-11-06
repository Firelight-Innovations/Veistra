---
name: finish-godot-game
description: Deliver a Godot game the person can play, not only its scripts - a main scene that runs, built from scenes that use the scripts, imported, run and looked at before you say it is done. Use this skill whenever you create, extend or fix a Godot 4 game, prototype or level - any project.godot, .gd script or .tscn scene, or a request to make, build or add to a game in Godot - even if the person only asks for code or a script, because a script nothing uses does not run.
---

# Finish a Godot game

When the person asks for a game, the deliverable is a game they can play. In Veistra they open
the Godot app, press **F5** (Play mode), and it runs. Godot runs **scenes**, not scripts. A
script does nothing until a node in a scene uses it, and a project with no main scene has nothing
to run. So a folder of `.gd` files is not a game, however good the code is.

Do not stop when the scripts are written. Do not finish with steps for the person to do ("create
a scene, attach `player.gd`, set it as main"). Doing those steps is your job, and every one of
them is a text file you can write.

## What done means

1. **A project.** `project.godot` exists at the project root.
2. **Scenes use the scripts.** Every script is attached to a node in a `.tscn`, registered as an
   autoload, or loaded by a script that is. If nothing uses a script, delete it or use it.
3. **A main scene.** `run/main_scene` in `project.godot` names the scene that starts the game.
   That scene builds the game: the player, the world, a camera, and the UI.
4. **Something to see without art.** Use shapes (`ColorRect`, `Polygon2D`, `MeshInstance3D` with
   a `BoxMesh`) unless the person gave you art. Never reference an image that does not exist.
5. **Controls work as delivered.** Use the built-in `ui_left`, `ui_right`, `ui_up`, `ui_down`
   and `ui_accept` actions, or add your own actions in code. Asking for an action nobody defined
   prints an error every frame and does nothing.
6. **You ran it and looked at it.** The project is imported, the checker passes, the output has
   no `SCRIPT ERROR` or `ERROR` lines, and you have looked at a frame. All of this is below.
7. **You told the person how to play.** Say what to press and what should happen.

## Finding Godot

Veistra gives the session the Godot executable it found in **`VEISTRA_GODOT`**. On Windows this
is the console build, so the output reaches your shell.

```bash
"$VEISTRA_GODOT" --version          # bash, including Git Bash on Windows
```

```powershell
& $env:VEISTRA_GODOT --version      # PowerShell
```

If it is unset, try `godot4` and then `godot` on PATH. If neither works, still do steps 1 to 5.
Then say plainly that you could not run the game, and ask the person to set **Settings > Godot >
Godot 4 executable**. Never say a game runs when you did not run it.

The commands below are written for bash with `GODOT="$VEISTRA_GODOT"`. `<project>` is the
folder holding `project.godot`. `<skill>` is this skill's folder, the one holding this file.

## Workflow

### 1. The project

If there is no `project.godot`, write one; `references/godot-text-formats.md` has it. Put the
engine's `major.minor`, from `--version`, in `config/features`. If one exists, read it first. It
may already name a main scene, autoloads or input actions.

### 2. Scenes

Write scenes as `.tscn` text. `references/godot-text-formats.md` has the exact format for 2D and
3D scenes, attaching scripts, sub-resources and instancing one scene in another. Read it before
writing your first scene.

- Give each reusable thing its own scene (`player.tscn`, `enemy.tscn`). Have `main.tscn`
  instance them, or spawn them from a script with `preload("res://enemy.tscn").instantiate()`.
- The node names in a scene must match the paths the scripts use: `$Player`, `%Score`,
  `get_node("World/Spawn")`.
- A script's `extends` must match the node type it is attached to. A `CharacterBody2D` script on
  a `Node2D` fails.

### 3. The main scene

Set it under `[application]` in `project.godot`:

```ini
run/main_scene="res://main.tscn"
```

### 4. Import, then check

```bash
GODOT="$VEISTRA_GODOT"
"$GODOT" --headless --path <project> --import
"$GODOT" --headless --path <project> -s <skill>/scripts/check_game.gd
```

`--import` builds Godot's caches: imported assets and the table of `class_name` scripts. Run it
again after adding a `class_name` script or any asset (`.png`, `.svg`, `.wav`, `.glb`). Without
it you get `Identifier "X" not declared` or `No loader found for resource`. On Godot older than
4.2, use `--editor --quit` instead of `--import`.

`check_game.gd` checks that the main scene is set and loads, and that every script parses and
every scene loads. Then it runs the main scene for 120 frames (`-- --frames 300` for more). Each
finding is a `PROBLEM:` line, and the last line is `CHECK PASSED` or `CHECK FAILED`.

**Read the whole output, not just the exit code.** Godot exits with 0 after a script error and
keeps the game running. On Godot 4.5 and later the checker counts those errors and fails. On
older versions it cannot, and its last line says so. There, any `SCRIPT ERROR` or `ERROR` line
above it is a bug to fix. Fix what it reports, import again if you added scripts or assets, and
rerun until it is clean.

### 5. Look at it

Render a few frames with Godot's Movie Maker and look at the last one:

```bash
mkdir -p /tmp/veistra-check
"$GODOT" --path <project> --write-movie /tmp/veistra-check/frame.png \
  --fixed-fps 10 --quit-after 30 --resolution 1280x720
```

Create the folder first. Movie Maker does not create it, and if it is missing Godot writes
nothing and still exits with 0. It writes `frame00000000.png` and the numbered frames after it,
plus a `.wav`. Open the last
frame with your image-reading tool. Check that the player, the world and the UI are on screen,
the right size, and lit (3D needs a `Camera3D` and a light). This opens a window for a moment.
Write the frames to a temp folder, never into the project, and delete them afterwards. If Godot
cannot render (no GPU driver), add `--rendering-method gl_compatibility`. If it still writes
nothing, say that you could not look at the game.

If the game has rules worth proving, such as a score, a win or a death, check them. Write a
short headless script with `-s` that loads the scene, drives it, and prints what happened.

### 6. Report

- What you built: the scenes, and which one is main.
- How to play: open the Godot app and press F5 (Play mode). List the controls and the goal.
- What you checked: the checker's last line, and what the frame you looked at showed.
- Anything you could not do or check, said plainly.

## Why a game does not run

| What you see | Why |
|---|---|
| `Can't run project: no main scene defined` | `run/main_scene` is missing from `project.godot` |
| `Identifier "Enemy" not declared` | a `class_name` script was added after the last `--import` |
| `No loader found for resource: res://x.png` | the asset is missing, or was never imported |
| `Node not found: "Player"` | a `$Path` in a script does not match the scene's node names |
| `Script inherits from native type ...` | the script's `extends` differs from its node's type |
| `The InputMap action "jump" doesn't exist` | an action used in code was never defined |
| A grey or black frame | nothing visible on screen, no `Camera3D`, or no light in 3D |
| Nothing moves | the script is not attached, or `_process` is not on a node in the tree |
