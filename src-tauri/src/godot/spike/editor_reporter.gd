@tool
extends EditorPlugin

# The embed spike's reporter for the Godot editor (#308,
# src-tauri/src/godot/spike.rs). The spike enables this plugin only in its
# temporary copy of examples/godot-demo. It appends one JSON line per event to
# input.jsonl in $VEISTRA_SPIKE_OUT, as the game's reporter does: the editor
# window's size when it changes, and every key and mouse button it was given.
# It handles nothing, so the editor behaves as it always does. Without
# $VEISTRA_SPIKE_OUT it does nothing.

var _dir := ""


func _enter_tree() -> void:
	_dir = OS.get_environment("VEISTRA_SPIKE_OUT")
	if _dir.is_empty():
		set_process_input(false)
		return
	get_window().size_changed.connect(_on_size_changed)
	_write({"kind": "ready", "size": _size()})


func _exit_tree() -> void:
	if get_window().size_changed.is_connected(_on_size_changed):
		get_window().size_changed.disconnect(_on_size_changed)


func _input(event: InputEvent) -> void:
	var key := event as InputEventKey
	if key and key.pressed and not key.echo:
		_write({"kind": "key", "keycode": key.keycode, "key": OS.get_keycode_string(key.keycode)})
		return
	var button := event as InputEventMouseButton
	if button and button.pressed:
		var at := [button.position.x, button.position.y]
		_write({"kind": "click", "at": at, "focus": get_window().has_focus()})


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
