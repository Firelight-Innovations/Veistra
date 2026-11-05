# veistra-editor v3
#
# The Veistra editor plugin. Installed by Veistra (Godot > Editor > Enable the
# Veistra plugin) beside the capture addon in addons/veistra/, and removable
# from the same place. It does nothing unless Veistra started this editor,
# which passes --veistra-editor-dir=<folder> after `--` and sets
# VEISTRA_EDITOR_DIR, so opening the project any other way is unaffected. It
# never opens a socket and never touches the network; the whole channel is
# files in one temp folder, as with veistra_capture.gd.
#
# Commands, in cmd.json, answered in res-<id>.json:
#   {"id": 1, "action": "selection"}   the state, the 3D camera and a viewport PNG
#   {"id": 2, "action": "capture", "what": "viewport" | "window"}
#   {"id": 3, "action": "select", "paths": ["Hallway/Enemy_02"]}
#   {"id": 4, "action": "open", "scene": "res://levels/hallway.tscn"}
#   {"id": 5, "action": "viewport-only", "on": true}
#   {"id": 6, "action": "pick", "x": 640, "y": 360}   (pixels of the last capture)
#   {"id": 7, "action": "save"}
#   {"id": 8, "action": "close"}   (the editor's own save prompt, then quit)
#   {"id": 9, "action": "edit", "path": "res://enemy.gd"}   (v3: a script or resource)
#
# Written to state.json whenever it changes: the edited scene, the open
# scenes, the selected nodes, the edited scene's nodes (v3, for the agent
# tab's @ menu), the main screen and whether only the viewport shows. The
# Veistra dock (veistra_dock.gd, #320) reads notes.json and appends to
# events.jsonl in the same folder (DECISIONS X5).
#
# Mention in agent (v3) is the dock's: its button, Ctrl+Alt+M here, and on
# Godot 4.4 or later the right-click menus veistra_menu.gd adds.
#
# Needs Godot 4.2 or later: EditorInterface as a singleton, its 3D viewports
# and distraction_free_mode as a property all arrived in 4.2.
@tool
extends EditorPlugin

const POLL_SEC := 0.1
const STATE_SEC := 0.5
const DIR_ARG := "--veistra-editor-dir="
const DIR_ENV := "VEISTRA_EDITOR_DIR"
# The editor holds its window at 1024x600 or more, which would spill out of a
# smaller pane; Veistra sizes the window, so the floor comes down to this.
const MIN_SIZE := Vector2i(480, 320)
const Dock := preload("veistra_dock.gd")
# Loaded, not preloaded: its base class is 4.4's, and 4.2 would refuse the file.
const MENU := "veistra_menu.gd"
# The agent tab lists this many of the edited scene's nodes at most.
const MAX_NODES := 400

var _dir := ""
var _poll_accum := 0.0
var _state_accum := 0.0
var _screen := ""
var _last_state := ""
var _capture_size := Vector2.ZERO
var _dock: Dock = null
var _menus: Array = []


func _enter_tree() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with(DIR_ARG):
			_dir = arg.substr(DIR_ARG.length())
	# The environment outlives the arguments: Godot's own Restart editor
	# starts the new editor without them.
	if _dir == "":
		_dir = OS.get_environment(DIR_ENV)
	if _dir == "" or not DirAccess.dir_exists_absolute(_dir):
		_dir = ""
		set_process(false)
		return
	main_screen_changed.connect(_on_main_screen_changed)
	_lower_min_size.call_deferred()
	var godot: String = Engine.get_version_info().get("string", "")
	_write("hello.json", {"pid": OS.get_process_id(), "godot": godot, "version": 3})
	var dock := Dock.new()
	dock.setup(_dir, _node_path, _camera, func() -> String: return _screen)
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)
	_dock = dock
	_add_menus()
	set_process(true)


func _exit_tree() -> void:
	if _dir != "" and main_screen_changed.is_connected(_on_main_screen_changed):
		main_screen_changed.disconnect(_on_main_screen_changed)
	for menu in _menus:
		call("remove_context_menu_plugin", menu)
	_menus.clear()
	if _dock != null:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null


# Mention in agent on the Scene dock's, the FileSystem dock's and the Script
# editor's right-click menus. By name through call(): add_context_menu_plugin
# is 4.4's, and 4.2 would refuse a script that names it outright.
func _add_menus() -> void:
	if not ClassDB.class_exists("EditorContextMenuPlugin") or not has_method("add_context_menu_plugin"):
		return
	var script = load(get_script().resource_path.get_base_dir().path_join(MENU))
	if script == null:
		return
	for slot in [0, 1, 2]:
		var menu = script.new()
		menu.slot = slot
		menu.mention = _dock.mention
		call("add_context_menu_plugin", slot, menu)
		_menus.append(menu)


# Ctrl+Alt+M: Mention in agent, whatever is in front (the dock decides).
func _shortcut_input(event: InputEvent) -> void:
	if _dock == null or not event is InputEventKey:
		return
	var key := event as InputEventKey
	if key.pressed and not key.echo and key.keycode == KEY_M and key.ctrl_pressed and key.alt_pressed:
		_dock.mention_now()
		get_viewport().set_input_as_handled()


# Deferred: the editor sets its own floor when it is ready, after plugins load.
func _lower_min_size() -> void:
	var window := get_tree().root
	window.min_size = MIN_SIZE
	DisplayServer.window_set_min_size(MIN_SIZE, window.get_window_id())


func _process(delta: float) -> void:
	_poll_accum += delta
	_state_accum += delta
	if _poll_accum >= POLL_SEC:
		_poll_accum = 0.0
		_poll_command()
	if _state_accum >= STATE_SEC:
		_state_accum = 0.0
		_write_state()


func _on_main_screen_changed(screen_name: String) -> void:
	_screen = screen_name


# Only when it changed, so the folder is not rewritten twice a second.
func _write_state() -> void:
	var text := JSON.stringify(_state())
	if text == _last_state:
		return
	_last_state = text
	_write_text("state.json", text)


# "Hallway/Enemy_02": the edited scene root's name, then the path below it,
# the same shape the capture addon and the viewer's tree use.
func _node_path(node: Node) -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null or node == root:
		return String(node.name)
	return String(root.name) + "/" + str(root.get_path_to(node))


func _node_at(path: String) -> Node:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return null
	if path == String(root.name):
		return root
	var prefix := String(root.name) + "/"
	if not path.begins_with(prefix):
		return null
	return root.get_node_or_null(NodePath(path.substr(prefix.length())))


func _v3(v: Vector3) -> Array:
	return [snappedf(v.x, 0.001), snappedf(v.y, 0.001), snappedf(v.z, 0.001)]


func _camera() -> Dictionary:
	var cam := EditorInterface.get_editor_viewport_3d(0).get_camera_3d()
	if cam == null:
		return {}
	var basis := cam.global_transform.basis
	return {
		"pos": _v3(cam.global_position),
		"target": _v3(cam.global_position - basis.z),
		"up": _v3(basis.y),
		"fov": snappedf(cam.fov, 0.1),
		"orthogonal": cam.projection == Camera3D.PROJECTION_ORTHOGONAL,
		"size": snappedf(cam.size, 0.001),
	}


func _state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var selected: Array = []
	for node in EditorInterface.get_selection().get_selected_nodes():
		var script = node.get_script()
		selected.append({
			"path": _node_path(node),
			"type": node.get_class(),
			"script": script.resource_path if script else "",
		})
	return {
		"scene": root.scene_file_path if root else "",
		"open": Array(EditorInterface.get_open_scenes()),
		"screen": _screen,
		"selected": selected,
		"nodes": _scene_nodes(root),
		"viewportOnly": EditorInterface.distraction_free_mode,
	}


# The edited scene's nodes, root first, at most MAX_NODES: what the agent
# tab's @ menu offers. Nodes inside an instanced scene are the instance's.
func _scene_nodes(root: Node) -> Array:
	var nodes: Array = []
	if root == null:
		return nodes
	var queue: Array = [root]
	while not queue.is_empty() and nodes.size() < MAX_NODES:
		var node: Node = queue.pop_front()
		nodes.append({"path": _node_path(node), "type": node.get_class()})
		for child in node.get_children():
			if child.owner == root:
				queue.append(child)
	return nodes


func _poll_command() -> void:
	var cmd_path := _dir.path_join("cmd.json")
	if not FileAccess.file_exists(cmd_path):
		return
	var text := FileAccess.get_file_as_string(cmd_path)
	DirAccess.remove_absolute(cmd_path)
	var cmd = JSON.parse_string(text)
	if typeof(cmd) != TYPE_DICTIONARY:
		return
	var id := int(cmd.get("id", 0))
	var result := {"id": id, "ok": true}
	match str(cmd.get("action", "")):
		"selection":
			result = _capture(id, "viewport")
			result.merge(_state())
		"capture":
			result = _capture(id, str(cmd.get("what", "viewport")))
		"select":
			result = _select(id, cmd.get("paths", []))
		"open":
			result = _open(id, str(cmd.get("scene", "")))
		"edit":
			result = _edit(id, str(cmd.get("path", "")))
		"viewport-only":
			var on := bool(cmd.get("on", true))
			if on:
				EditorInterface.set_main_screen_editor("3D")
			EditorInterface.distraction_free_mode = on
		"pick":
			result = _pick(id, Vector2(float(cmd.get("x", 0)), float(cmd.get("y", 0))))
		"save":
			EditorInterface.save_all_scenes()
		"close":
			# What the window's close button does: the editor asks to save
			# anything unsaved, in its own dialog, and may be cancelled.
			get_tree().root.propagate_notification(NOTIFICATION_WM_CLOSE_REQUEST)
		_:
			result = {"id": id, "ok": false, "error": "unknown action"}
	result["t"] = int(Time.get_unix_time_from_system() * 1000.0)
	_write("res-%d.json" % id, result)


# "viewport" is the 3D view without the editor around it, for Mark up and
# Send selection; "window" is the whole editor.
func _capture(id: int, what: String) -> Dictionary:
	var image: Image = null
	if what == "window":
		image = get_tree().root.get_texture().get_image()
	else:
		image = EditorInterface.get_editor_viewport_3d(0).get_texture().get_image()
	if image == null or image.is_empty():
		return {"id": id, "ok": false, "error": "the editor has no image to give"}
	var name := "cap-%d.png" % id
	var err := image.save_png(_dir.path_join(name))
	if err != OK:
		return {"id": id, "ok": false, "error": "save_png failed: %d" % err}
	if what != "window":
		_capture_size = Vector2(image.get_width(), image.get_height())
	return {
		"id": id,
		"ok": true,
		"png": name,
		"width": image.get_width(),
		"height": image.get_height(),
		"camera": _camera(),
	}


func _select(id: int, paths) -> Dictionary:
	var missing: Array = []
	var found: Array = []
	for path in paths:
		var node := _node_at(str(path))
		if node == null:
			missing.append(str(path))
		else:
			found.append(node)
	if found.is_empty():
		return {"id": id, "ok": false, "error": "no such node in the open scene", "missing": missing}
	var selection := EditorInterface.get_selection()
	selection.clear()
	for node in found:
		selection.add_node(node)
	EditorInterface.edit_node(found[0])
	return {"id": id, "ok": true, "missing": missing}


func _open(id: int, scene: String) -> Dictionary:
	if not scene.begins_with("res://") or not ResourceLoader.exists(scene):
		return {"id": id, "ok": false, "error": "not a scene in this project"}
	EditorInterface.open_scene_from_path(scene)
	return {"id": id, "ok": true}


# A chip clicked in the agent tab: a script in the Script screen, any other
# resource in the Inspector, as a double-click in the FileSystem dock does.
func _edit(id: int, path: String) -> Dictionary:
	if not path.begins_with("res://") or not ResourceLoader.exists(path):
		return {"id": id, "ok": false, "error": "not a file in this project"}
	var resource := load(path)
	if resource == null:
		return {"id": id, "ok": false, "error": "the editor could not load it"}
	if resource is Script:
		EditorInterface.set_main_screen_editor("Script")
		EditorInterface.edit_script(resource)
	else:
		EditorInterface.edit_resource(resource)
	EditorInterface.get_file_system_dock().navigate_to_path(path)
	return {"id": id, "ok": true}


# What the editor itself does to pick: ask the renderer which instances the
# ray passes through, then test each one's triangles, nearest hit first. No
# physics: the editor does not step the physics server.
func _pick(id: int, on_capture: Vector2) -> Dictionary:
	var viewport := EditorInterface.get_editor_viewport_3d(0)
	var cam := viewport.get_camera_3d()
	var root := EditorInterface.get_edited_scene_root()
	if cam == null or root == null:
		return {"id": id, "ok": true, "hit": null}
	var size := Vector2(viewport.size)
	var at := on_capture * size / _capture_size if _capture_size.x > 0.0 else on_capture
	var from := cam.project_ray_origin(at)
	var to := from + cam.project_ray_normal(at) * cam.far
	var best = null
	var best_dist := INF
	for oid in RenderingServer.instances_cull_ray(from, to, viewport.find_world_3d().scenario):
		var obj = instance_from_id(oid)
		if not obj is GeometryInstance3D or not root.is_ancestor_of(obj):
			continue
		var point = _hit_point(obj, from, to)
		if point == null:
			continue
		var dist := from.distance_to(point)
		if dist < best_dist:
			best_dist = dist
			best = [obj, point]
	if best == null:
		return {"id": id, "ok": true, "hit": null}
	var node := _selectable(best[0], root)
	var hit := {
		"nodePath": _node_path(node),
		"type": node.get_class(),
		"worldPoint": _v3(best[1]),
		"source": "editor",
	}
	return {"id": id, "ok": true, "hit": hit}


# The nearest triangle the segment crosses, in world space, or null. A mesh's
# faces only; anything without one is judged by its box.
func _hit_point(obj, from: Vector3, to: Vector3):
	var xform: Transform3D = obj.global_transform
	if is_zero_approx(xform.basis.determinant()):
		return null
	var inv := xform.affine_inverse()
	var a := inv * from
	var b := inv * to
	if obj is MeshInstance3D and obj.mesh != null:
		var faces: PackedVector3Array = obj.mesh.get_faces()
		var near = null
		var near_d := INF
		for i in range(0, faces.size(), 3):
			var p = Geometry3D.segment_intersects_triangle(a, b, faces[i], faces[i + 1], faces[i + 2])
			if p != null and a.distance_to(p) < near_d:
				near_d = a.distance_to(p)
				near = p
		return xform * near if near != null else null
	var box: AABB = obj.get_aabb()
	var hit = box.intersects_segment(a, b)
	return xform * hit if hit != null else null


# What a click in the editor would select: the topmost node under the edited
# root that the scene owns, so a pin on an instanced enemy names the enemy.
func _selectable(node: Node, root: Node) -> Node:
	var at := node
	while at.owner != null and at.owner != root and not root.is_editable_instance(at.owner):
		at = at.owner
	return at


func _write(file_name: String, data: Dictionary) -> void:
	_write_text(file_name, JSON.stringify(data))


# Written beside and renamed into place, so Veistra never reads half a file.
func _write_text(file_name: String, text: String) -> void:
	var tmp := _dir.path_join(file_name + ".tmp")
	var file := FileAccess.open(tmp, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(text)
	file.close()
	DirAccess.rename_absolute(tmp, _dir.path_join(file_name))
