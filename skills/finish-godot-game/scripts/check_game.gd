## Checks that a Godot 4 project is a game someone can play, not only scripts.
##
##   godot --headless --path <project> -s <skill>/scripts/check_game.gd
##   godot --headless --path <project> -s <skill>/scripts/check_game.gd -- --frames 300
##
## It checks that a main scene is set and loads, that every script parses and
## every scene loads, then runs the main scene for a number of frames (120 by
## default). Each finding is a line starting with `PROBLEM:`, and the last line
## starts with `CHECK PASSED` or `CHECK FAILED`; the exit code is 0 or 1 to
## match.
##
## Errors a script raises while the game runs are printed by Godot as
## `SCRIPT ERROR:` lines. On Godot 4.5 and later this script counts them too.
## Before 4.5 Godot offers no way to, so the summary says so and the output
## above it has to be read.
extends SceneTree

const SKIP_DIRS := [".godot", ".import", ".git", "addons"]

var problems := PackedStringArray()
var frames_left := 120
var frames_run := 0
var main_path := ""
var started := false
var logger: Object = null


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var at := args.find("--frames")
	if at >= 0 and at + 1 < args.size():
		frames_left = maxi(1, args[at + 1].to_int())
	_check_main_scene()
	_check_files("res://")
	# After the static checks, which report their own failures, so an error
	# is counted once.
	_listen_for_errors()
	if main_path != "" and problems.is_empty():
		var packed := load(main_path) as PackedScene
		if packed != null:
			change_scene_to_packed(packed)
			started = true
			return
	frames_left = 0


func _process(_delta: float) -> bool:
	if frames_left <= 0:
		_finish()
		return true
	frames_left -= 1
	frames_run += 1
	return false


func _problem(text: String) -> void:
	problems.append(text)
	print("PROBLEM: ", text)


func _check_main_scene() -> void:
	var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main == "":
		_problem("no main scene: set run/main_scene under [application] in project.godot")
		return
	if main.begins_with("uid://"):
		var id := ResourceUID.text_to_id(main)
		if not ResourceUID.has_id(id):
			_problem("run/main_scene is %s, which names no file; import the project first" % main)
			return
		main = ResourceUID.get_id_path(id)
	if not ResourceLoader.exists(main):
		_problem("run/main_scene is %s, which does not exist" % main)
		return
	var packed := load(main) as PackedScene
	if packed == null:
		_problem("the main scene %s did not load as a scene" % main)
		return
	if not packed.can_instantiate():
		_problem("the main scene %s cannot be instanced" % main)
		return
	main_path = main
	print("main scene: ", main)


func _check_files(dir: String) -> void:
	for name in DirAccess.get_directories_at(dir):
		if not name in SKIP_DIRS:
			_check_files(dir.path_join(name))
	for name in DirAccess.get_files_at(dir):
		var path := dir.path_join(name)
		match name.get_extension():
			"gd":
				var script := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
				if script == null or not (script as Script).can_instantiate():
					_problem(
						"%s does not parse; its errors are printed above (a class_name another script added is unknown until the project is imported again)"
						% path
					)
			"tscn", "scn":
				var scene := ResourceLoader.load(path) as PackedScene
				if scene == null or not scene.can_instantiate():
					_problem("%s does not load as a scene; its errors are printed above" % path)


## On Godot 4.5+, a Logger hears every error, so runtime errors are counted.
## Compiled from text so this file still parses on versions without Logger.
func _listen_for_errors() -> void:
	if not ClassDB.class_exists("Logger") or not OS.has_method("add_logger"):
		return
	var source := GDScript.new()
	source.source_code = (
		"extends Logger\n"
		+ "var errors := PackedStringArray()\n"
		+ "func _log_error(function: String, file: String, line: int, code: String, "
		+ "rationale: String, editor_notify: bool, error_type: int, "
		+ "script_backtraces: Array[ScriptBacktrace]) -> void:\n"
		+ "\tif error_type != ERROR_TYPE_WARNING:\n"
		+ "\t\terrors.append(\"%s (%s:%d)\" % [rationale if rationale else code, file, line])\n"
	)
	if source.reload() != OK:
		return
	logger = source.new()
	OS.call("add_logger", logger)


func _finish() -> void:
	var counted := logger != null
	if counted:
		OS.call("remove_logger", logger)
		for error in logger.get("errors"):
			_problem("an error was raised: %s" % error)
	if started:
		print("ran %s for %d frames" % [main_path, frames_run])
	if problems.is_empty():
		var note := "" if counted else (
			" (Godot %s cannot count runtime errors: read the output above for"
			+ " SCRIPT ERROR or ERROR lines before calling the game done)"
		) % Engine.get_version_info().string
		print("CHECK PASSED", note)
		quit(0)
	else:
		print("CHECK FAILED: %d problem(s)" % problems.size())
		quit(1)
