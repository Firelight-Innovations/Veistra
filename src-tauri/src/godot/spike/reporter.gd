extends Node

# The embed spike's reporter for the game (#308, src-tauri/src/godot/spike.rs).
# The spike adds it as an autoload to a temporary copy of examples/godot-demo;
# the demo itself never loads it. It appends one JSON line per event to
# input.jsonl in $VEISTRA_SPIKE_OUT: the window's size when it changes, and
# every key and mouse button that reached the game, with whether its window
# had focus. That is how the harness tells input that arrived from input that
# Windows delivered somewhere else.
#
# The green patch in the top right is the colour the harness reads off the
# screen for the menu check. The left clicks it logs are marked handled, so
# the hallway's player never takes the mouse in the middle of a run. A `hang`
# file in the folder stops the game pumping messages for five seconds, for
# the hung-game row. Without $VEISTRA_SPIKE_OUT none of this happens.

const PATCH := Color(0.0, 1.0, 0.0)
const PATCH_SIZE := Vector2(240.0, 180.0)
const HANG_MS := 5000

var _dir := ""


func _ready() -> void:
	_dir = OS.get_environment("VEISTRA_SPIKE_OUT")
	if _dir.is_empty():
		set_process(false)
		set_process_input(false)
		return
	var layer := CanvasLayer.new()
	layer.layer = 100
	var patch := ColorRect.new()
	patch.color = PATCH
	patch.mouse_filter = Control.MOUSE_FILTER_IGNORE
	patch.anchor_left = 1.0
	patch.anchor_right = 1.0
	patch.offset_left = -PATCH_SIZE.x
	patch.offset_bottom = PATCH_SIZE.y
	layer.add_child(patch)
	add_child(layer)
	get_window().size_changed.connect(_on_size_changed)
	_write({"kind": "ready", "size": _size()})


func _process(_delta: float) -> void:
	var hang := _dir.path_join("hang")
	if not FileAccess.file_exists(hang):
		return
	DirAccess.remove_absolute(hang)
	_write({"kind": "hang"})
	var until := Time.get_ticks_msec() + HANG_MS
	while Time.get_ticks_msec() < until:
		pass
	_write({"kind": "awake"})


func _input(event: InputEvent) -> void:
	var key := event as InputEventKey
	if key and key.pressed and not key.echo:
		_write({"kind": "key", "keycode": key.keycode, "key": OS.get_keycode_string(key.keycode)})
		return
	var button := event as InputEventMouseButton
	if button and button.pressed:
		var at := [button.position.x, button.position.y]
		_write({"kind": "click", "at": at, "focus": get_window().has_focus()})
		if button.button_index == MOUSE_BUTTON_LEFT:
			get_viewport().set_input_as_handled()


func _on_size_changed() -> void:
	_write({"kind": "size", "size": _size()})


func _size() -> Array:
	var s := get_window().size
	return [s.x, s.y]


func _write(entry: Dictionary) -> void:
	entry["ms"] = Time.get_unix_time_from_system() * 1000.0
	var path := _dir.path_join("input.jsonl")
	var f := FileAccess.open(path, FileAccess.READ_WRITE)
	if f == null:
		f = FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return
	f.seek_end()
	f.store_line(JSON.stringify(entry))
	f.close()
