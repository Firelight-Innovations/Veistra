# veistra-dock v2
#
# The Veistra dock (#320): the notes on the selected node, Looks good and
# Still broken on a fixed one, Ask the agent and Mark up the viewport. The
# editor plugin adds it only when Veistra started this editor, and hands it
# the channel folder.
#
# v2 adds Mention in agent: the selected nodes, the scene, the open script or
# the viewport, put in the agent tab's prompt as one chip with nothing typed.
# The plugin's Ctrl+Alt+M and its right-click menus come here too.
#
# Two files beside cmd.json (DECISIONS X5). notes.json is Veistra's, read
# every READ_SEC and replaced whole by a rename, so it is never half written;
# it holds the notes this editor may show and the answers to the lines below.
# events.jsonl is the dock's, one JSON line appended a press, and nothing else
# writes it. The dock never reads or writes .veistra/comments/: the pane does
# what a press asks through the same calls its own cards use, then answers.
@tool
extends VBoxContainer

const READ_SEC := 0.25
const NOTES := "notes.json"
const EVENTS := "events.jsonl"
# Veistra refuses a longer question, so the box stops here first.
const MAX_TEXT := 4000
# The picture goes to the agent as one context item; this keeps it small.
const MAX_SIDE := 1600

var _dir := ""
var _node_path: Callable
var _camera: Callable
var _screen: Callable
var _accum := 0.0
var _notes_text := ""
var _notes: Array = []
var _shown := ""
var _last_n := 0
# The presses Veistra has not answered yet: n -> what was pressed.
var _pending := {}
var _answered := {}
var _drafts := {}
var _head: Label
var _list: VBoxContainer
var _ask: TextEdit
var _ask_button: Button
var _mention_button: MenuButton
var _status: Label

# Mention in agent's menu, by id.
const MENTION_ITEMS := [
	["The selected nodes", "selection"],
	["This scene", "scene"],
	["The open script", "script"],
	["The viewport", "viewport"],
]


func setup(dir: String, node_path: Callable, camera: Callable, screen: Callable) -> void:
	_dir = dir
	_node_path = node_path
	_camera = camera
	_screen = screen
	# The dock's tab is titled with this, read when the plugin adds it.
	name = "Veistra"


func _ready() -> void:
	_head = Label.new()
	_head.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_head)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)
	add_child(scroll)
	add_child(HSeparator.new())
	_ask = TextEdit.new()
	_ask.placeholder_text = "Ask the agent about the selection"
	_ask.custom_minimum_size = Vector2(0, 64)
	_ask.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_ask.text_changed.connect(_on_ask_changed)
	add_child(_ask)
	var row := HBoxContainer.new()
	_ask_button = _button("Ask the agent", _on_ask)
	_ask_button.tooltip_text = "The question, the selected nodes and the viewport, in one message"
	row.add_child(_ask_button)
	row.add_child(_button("Mark up the viewport", _on_markup))
	add_child(row)
	_mention_button = MenuButton.new()
	_mention_button.text = "Mention to Veistra agent"
	_mention_button.flat = false
	_mention_button.tooltip_text = "Mention this to Veistra agent"
	var popup := _mention_button.get_popup()
	for i in MENTION_ITEMS.size():
		popup.add_item(MENTION_ITEMS[i][0], i)
	popup.id_pressed.connect(func(id: int) -> void: mention(MENTION_ITEMS[id][1]))
	_mention_button.about_to_popup.connect(_on_mention_menu)
	add_child(_mention_button)
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_status)
	EditorInterface.get_selection().selection_changed.connect(_render)
	_on_ask_changed()
	_read_notes()
	_render()


func _exit_tree() -> void:
	var selection := EditorInterface.get_selection()
	if selection.selection_changed.is_connected(_render):
		selection.selection_changed.disconnect(_render)


func _process(delta: float) -> void:
	_accum += delta
	if _accum < READ_SEC:
		return
	_accum = 0.0
	if _read_notes():
		_render()


# True when the file says something new. The text is compared, not the time,
# so a rewrite within the clock's resolution is not missed.
func _read_notes() -> bool:
	var path := _dir.path_join(NOTES)
	if _dir == "" or not FileAccess.file_exists(path):
		return false
	var text := FileAccess.get_file_as_string(path)
	if text == "" or text == _notes_text:
		return false
	var data = JSON.parse_string(text)
	if typeof(data) != TYPE_DICTIONARY:
		return false
	_notes_text = text
	var notes = data.get("notes", [])
	_notes = notes if typeof(notes) == TYPE_ARRAY else []
	var problem = data.get("problem")
	if typeof(problem) == TYPE_STRING and problem != "":
		_say("Veistra could not read the notes: " + problem)
	var acks = data.get("acks", [])
	if typeof(acks) == TYPE_ARRAY:
		for ack in acks:
			_on_ack(ack)
	return true


func _on_ack(ack) -> void:
	if typeof(ack) != TYPE_DICTIONARY:
		return
	var n := int(ack.get("n", 0))
	if not _pending.has(n) or _answered.has(n):
		return
	_answered[n] = true
	var what: String = _pending[n]
	_pending.erase(n)
	var message := str(ack.get("message", ""))
	if bool(ack.get("ok", false)):
		_say(message if message != "" else what + ": done.")
	else:
		_say(what + " did not go through: " + (message if message != "" else "no reason given"))


func _selected_paths() -> Array:
	var paths: Array = []
	for node in EditorInterface.get_selection().get_selected_nodes():
		paths.append(_node_path.call(node))
	return paths


func _scene() -> String:
	var root := EditorInterface.get_edited_scene_root()
	return root.scene_file_path if root else ""


# A note on a node, written in this scene or before notes said which; or a
# Play note on that node, written in this scene, or anywhere the running game
# had the scene under another root ("Main/Hallway/Enemy_02").
static func matches(note: Dictionary, path: String, scene: String) -> bool:
	var at := str(note.get("path", ""))
	var on = note.get("scene")
	var same_scene: bool = on == null or str(on) == "" or str(on) == scene
	match str(note.get("kind", "")):
		"node":
			return at == path and same_scene
		"take":
			return (at == path and same_scene) or at.ends_with("/" + path)
	return false


func _render() -> void:
	if _list == null:
		return
	var paths := _selected_paths()
	var scene := _scene()
	var shown: Array = []
	for note in _notes:
		if typeof(note) != TYPE_DICTIONARY:
			continue
		for path in paths:
			if matches(note, path, scene):
				shown.append(note)
				break
	# Rebuilt only when what it shows changed, so a reply being typed stays.
	var key := JSON.stringify([paths, shown, _pending.keys()])
	if key == _shown:
		return
	_shown = key
	for child in _list.get_children():
		_list.remove_child(child)
		child.queue_free()
	if paths.is_empty():
		_head.text = "Select a node to see its notes."
	elif shown.is_empty():
		_head.text = "No notes on %s." % ", ".join(paths)
	else:
		var count := "1 note" if shown.size() == 1 else "%d notes" % shown.size()
		_head.text = "%s on %s" % [count, ", ".join(paths)]
	for note in shown:
		_list.add_child(_card(note))
	_on_ask_changed()


func _card(note: Dictionary) -> Control:
	var panel := PanelContainer.new()
	var box := VBoxContainer.new()
	panel.add_child(box)
	box.add_child(_text("%s - %s" % [str(note.get("title", "Note")), str(note.get("label", ""))]))
	box.add_child(_text(str(note.get("body", ""))))
	var replies = note.get("replies", [])
	if typeof(replies) == TYPE_ARRAY:
		for reply in replies:
			if typeof(reply) == TYPE_DICTIONARY:
				box.add_child(_text("%s: %s" % [str(reply.get("by", "")), str(reply.get("body", ""))]))
	var fix = note.get("fix")
	if typeof(fix) == TYPE_DICTIONARY and str(fix.get("note", "")) != "":
		box.add_child(_text("Fix: " + str(fix.get("note", ""))))
	if str(note.get("status", "")) == "fixed":
		_verdict_row(box, str(note.get("id", "")))
	return panel


# Only on a note the agent says it fixed, which is what Veistra's own card
# offers them on. Veistra checks it is still fixed before acting.
func _verdict_row(box: VBoxContainer, id: String) -> void:
	var waiting := _pending.values().has("Verdict " + id)
	var reply := LineEdit.new()
	reply.placeholder_text = "What is still wrong (optional)"
	reply.text = _drafts.get(id, "")
	reply.max_length = MAX_TEXT
	reply.text_changed.connect(func(t: String) -> void: _drafts[id] = t)
	box.add_child(reply)
	var row := HBoxContainer.new()
	var good := _button("Looks good", func() -> void: _verdict(id, true, reply.text))
	var broken := _button("Still broken", func() -> void: _verdict(id, false, reply.text))
	good.disabled = waiting
	broken.disabled = waiting
	row.add_child(good)
	row.add_child(broken)
	box.add_child(row)


func _verdict(id: String, good: bool, reply: String) -> void:
	var event := {"kind": "verdict", "id": id, "verdict": "good" if good else "broken"}
	if reply.strip_edges() != "":
		event["reply"] = reply.strip_edges()
	if _send(event, "Verdict " + id):
		_drafts.erase(id)
		_say("Sent to Veistra; waiting for it to answer.")
	_render()


func _on_ask_changed() -> void:
	if _ask_button == null:
		return
	var text := _ask.text.strip_edges()
	_ask_button.disabled = text == "" or _ask.text.length() > MAX_TEXT
	if _ask.text.length() > MAX_TEXT:
		_say("The question is longer than %d characters." % MAX_TEXT)


# The question, the selection and the viewport go in one line, the picture
# written first under the name the line gives, so Veistra finds it whole.
func _on_ask() -> void:
	var text := _ask.text.strip_edges()
	if text == "" or text.length() > MAX_TEXT:
		return
	var n := _next_n()
	var event := {
		"kind": "ask",
		"text": text,
		"scene": _scene(),
		"nodes": _selected_paths(),
		"camera": _camera.call(),
	}
	var image := _viewport_image()
	if image != null and image.save_png(_dir.path_join("ask-%d.png" % n)) == OK:
		event["png"] = "ask-%d.png" % n
	if _send(event, "Ask the agent", n):
		_ask.text = ""
		_on_ask_changed()
		_say("Sent to Veistra; waiting for it to answer.")


func _on_markup() -> void:
	if _send({"kind": "markup"}, "Mark up"):
		_say("Opening Mark up in Veistra.")


# Only what there is to mention can be pressed.
func _on_mention_menu() -> void:
	var popup := _mention_button.get_popup()
	popup.set_item_disabled(0, _selected_paths().is_empty())
	popup.set_item_disabled(1, _scene() == "")
	popup.set_item_disabled(2, _open_script() == "")


# The script open in the Script screen, when it is a file of its own (a
# built-in script lives inside its scene and has no path to name).
func _open_script() -> String:
	var script = EditorInterface.get_script_editor().get_current_script()
	if script == null:
		return ""
	var path: String = script.resource_path
	return path if path.begins_with("res://") and not path.contains("::") else ""


# Ctrl+Alt+M: the open script on the Script screen, else the selected nodes,
# else the scene.
func mention_now() -> void:
	if str(_screen.call()) == "Script" and _open_script() != "":
		mention("script")
	elif not _selected_paths().is_empty():
		mention("selection")
	else:
		mention("scene")


# Mention in agent: "selection", "scene", "script", "viewport", or "file"
# with a res:// path. One line, a picture first for the viewport; Veistra
# makes the chip and answers.
func mention(what: String, path: String = "") -> void:
	var n := _next_n()
	var event := {"kind": "mention", "what": what, "scene": _scene()}
	match what:
		"selection":
			event["nodes"] = _selected_paths()
			if event["nodes"].is_empty():
				_say("Select a node to mention first.")
				return
		"scene":
			if _scene() == "":
				_say("Save the scene first; Veistra mentions it by its file.")
				return
		"script":
			event["what"] = "file"
			event["path"] = _open_script()
			if event["path"] == "":
				_say("Open a script that is saved as its own file first.")
				return
		"file":
			event["path"] = path
		"viewport":
			var image := _viewport_image()
			if image == null or image.save_png(_dir.path_join("mention-%d.png" % n)) != OK:
				_say("The viewport has no picture to send.")
				return
			event["png"] = "mention-%d.png" % n
	if _send(event, "Mention to Veistra agent", n):
		_say("Sent to Veistra; the chip goes in the agent's prompt.")


# What the editor shows in its main screen: the 2D canvas when that is up,
# the first 3D viewport otherwise. Scaled down to MAX_SIDE on its long side.
func _viewport_image() -> Image:
	var viewport: Viewport = EditorInterface.get_editor_viewport_3d(0)
	if str(_screen.call()) == "2D":
		viewport = EditorInterface.get_editor_viewport_2d()
	var image := viewport.get_texture().get_image()
	if image == null or image.is_empty():
		return null
	var side := maxi(image.get_width(), image.get_height())
	if side > MAX_SIDE:
		var ratio := float(MAX_SIDE) / float(side)
		image.resize(
			maxi(1, int(image.get_width() * ratio)),
			maxi(1, int(image.get_height() * ratio)),
			Image.INTERPOLATE_BILINEAR
		)
	return image


# Rising, and wall-clock milliseconds where it can be, so a restarted editor
# does not reuse a number an earlier one sent.
func _next_n() -> int:
	_last_n = maxi(_last_n + 1, int(Time.get_unix_time_from_system() * 1000.0))
	return _last_n


# One line on the end of events.jsonl. The file is only ever appended to, so
# Veistra reads it from where it stopped.
func _send(event: Dictionary, what: String, n: int = 0) -> bool:
	if _dir == "":
		return false
	event["n"] = n if n > 0 else _next_n()
	event["t"] = int(Time.get_unix_time_from_system() * 1000.0)
	var path := _dir.path_join(EVENTS)
	var file: FileAccess = null
	if FileAccess.file_exists(path):
		file = FileAccess.open(path, FileAccess.READ_WRITE)
	else:
		file = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		_say("Could not write to Veistra: %s" % error_string(FileAccess.get_open_error()))
		return false
	file.seek_end()
	file.store_line(JSON.stringify(event))
	file.close()
	_pending[int(event["n"])] = what
	return true


func _say(text: String) -> void:
	if _status != null:
		_status.text = text


func _text(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return label


func _button(text: String, pressed: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(pressed)
	return button
