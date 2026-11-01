# veistra-capture v2
#
# Installed by Veistra (Play > Enable capture) and removable from the same
# place. It does nothing unless the game was started by Veistra, which passes
# --veistra-dir=<folder> after `--`, so an exported build is unaffected. It
# never opens a socket and never touches the network; the whole channel is
# files in one temp folder.
#
# Commands, in cmd.json, answered in res-<id>.json:
#   {"id": 1, "action": "capture"}, "pause", "resume",
#   {"id": 2, "action": "pick", "x": 640, "y": 360}   (viewport pixels)
#
# Written to telemetry.jsonl, one JSON object a line, every line stamped with
# wall-clock milliseconds in "t":
#   a tick ten times a second: scene, camera, player, frame time, viewport,
#     and the screen boxes of tracked nodes;
#   {"kind": "mark"} for F8, {"kind": "key", "key": "F7"} and "Ctrl Shift M",
#     and {"kind": "scene", "scene": ...} when the current scene changes.
# F7, F8 and Ctrl Shift M are handled here and marked handled, so the game
# never sees them. Every other key goes to the game.
extends Node

const TICK_SEC := 0.1
const FLUSH_SEC := 1.0
const REFRESH_SEC := 1.0
const MAX_NODES := 64
const TRACK_GROUP := "veistra_track"
const PLAYER_GROUP := "player"

var _dir := ""
var _accum := 0.0
var _tick_accum := 0.0
var _flush_accum := 0.0
var _refresh_accum := REFRESH_SEC
var _frame_ms := 0.0
var _log: FileAccess = null
var _scene_path := ""
# Candidate nodes and the local box each one is measured by, refreshed once a
# second rather than walked every tick.
var _candidates: Array = []

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--veistra-dir="):
			_dir = arg.substr("--veistra-dir=".length())
	if _dir == "":
		set_process(false)
		set_process_input(false)
		return
	var path := _dir.path_join("telemetry.jsonl")
	_log = FileAccess.open(path, FileAccess.READ_WRITE) if FileAccess.file_exists(path) else FileAccess.open(path, FileAccess.WRITE)
	if _log:
		_log.seek_end()
	_write("hello.json", {"pid": OS.get_process_id(), "godot": Engine.get_version_info().get("string", ""), "version": 2})
	_to_front.call_deferred()

# Input reaches the last child of the root first, so this node keeps itself
# there; a scene change puts the new scene after it, and the next tick moves
# it back.
func _to_front() -> void:
	var root := get_tree().root
	if get_parent() == root and get_index() != root.get_child_count() - 1:
		root.move_child(self, root.get_child_count() - 1)

func _input(event: InputEvent) -> void:
	var key := event as InputEventKey
	if key == null or not key.pressed or key.echo:
		return
	var which := ""
	if key.keycode == KEY_F7:
		which = "F7"
	elif key.keycode == KEY_F8:
		which = "F8"
	elif key.keycode == KEY_M and key.ctrl_pressed and key.shift_pressed:
		which = "Ctrl Shift M"
	if which == "":
		return
	get_viewport().set_input_as_handled()
	if which == "F8":
		_event({"kind": "mark"})
	else:
		_event({"kind": "key", "key": which})

func _process(delta: float) -> void:
	_frame_ms = delta * 1000.0
	_tick_accum += delta
	_flush_accum += delta
	_refresh_accum += delta
	_accum += delta
	if _refresh_accum >= REFRESH_SEC:
		_refresh_accum = 0.0
		_refresh_candidates()
		_to_front()
	if _tick_accum >= TICK_SEC:
		_tick_accum = fmod(_tick_accum, TICK_SEC)
		_tick()
	if _flush_accum >= FLUSH_SEC and _log:
		_flush_accum = 0.0
		_log.flush()
	if _accum >= 0.1:
		_accum = 0.0
		_poll_command()

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
		if _log:
			_log.flush()

# --- telemetry -------------------------------------------------------------

func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

func _append(data: Dictionary) -> void:
	if _log == null:
		return
	data["t"] = _now_ms()
	_log.store_line(JSON.stringify(data))

# An event is flushed at once, so the live strip shows a mark as it happens.
func _event(data: Dictionary) -> void:
	_append(data)
	if _log:
		_log.flush()

func _v3(v: Vector3) -> Array:
	return [snappedf(v.x, 0.01), snappedf(v.y, 0.01), snappedf(v.z, 0.01)]

func _v2(v: Vector2) -> Array:
	return [snappedf(v.x, 0.01), snappedf(v.y, 0.01)]

func _scene_root() -> Node:
	return get_tree().current_scene

# "Hallway/Enemy_02": the scene root's name, then the path below it.
func _node_path(node: Node) -> String:
	var root := _scene_root()
	if root == null:
		return str(node.get_path())
	if node == root:
		return String(root.name)
	if root.is_ancestor_of(node):
		return String(root.name) + "/" + str(root.get_path_to(node))
	return str(node.get_path())

func _tick() -> void:
	var root := _scene_root()
	var scene := root.scene_file_path if root else ""
	if scene != _scene_path:
		_scene_path = scene
		_event({"kind": "scene", "scene": scene})
		_refresh_candidates()
	var viewport := get_viewport()
	var size := viewport.get_visible_rect().size
	var data := {
		"kind": "tick",
		"scene": scene,
		"frameMs": snappedf(_frame_ms, 0.1),
		"viewport": [int(size.x), int(size.y)],
	}
	var cam3 := viewport.get_camera_3d()
	var cam2 := viewport.get_camera_2d()
	if cam3:
		var basis := cam3.global_transform.basis
		data["camera"] = {
			"pos": _v3(cam3.global_position),
			"target": _v3(cam3.global_position - basis.z),
			"up": _v3(basis.y),
			"fov": snappedf(cam3.fov, 0.1),
		}
	elif cam2:
		data["camera"] = {"pos": _v2(cam2.get_screen_center_position()), "zoom": _v2(cam2.zoom)}
	# Untyped on purpose: GDScript does not narrow on `is`, and the position
	# is read from whichever of the two node kinds this turns out to be.
	var player = get_tree().get_first_node_in_group(PLAYER_GROUP)
	if player is Node3D:
		data["player"] = {"path": _node_path(player), "pos": _v3(player.global_position)}
	elif player is Node2D:
		data["player"] = {"path": _node_path(player), "pos": _v2(player.global_position)}
	data["nodes"] = _tracked_rects(cam3, size)
	_append(data)

# The group when it has members; otherwise physics bodies and visible meshes
# (or their 2D counterparts). The box each is measured by is read here, once.
func _refresh_candidates() -> void:
	_candidates.clear()
	var root := _scene_root()
	if root == null:
		return
	var nodes: Array = get_tree().get_nodes_in_group(TRACK_GROUP)
	if nodes.is_empty():
		nodes = root.find_children("*", "CollisionObject3D", true, false)
		nodes.append_array(root.find_children("*", "VisualInstance3D", true, false))
		nodes.append_array(root.find_children("*", "CollisionObject2D", true, false))
		nodes.append_array(root.find_children("*", "Sprite2D", true, false))
	for node in nodes:
		var box = _local_box(node)
		if box != null:
			_candidates.append([node, box])

func _local_box(node):
	if node is VisualInstance3D:
		return node.get_aabb()
	if node is CollisionObject3D:
		var box := AABB()
		var any := false
		for child in node.get_children():
			if child is CollisionShape3D and child.shape:
				var shape_box: AABB = child.transform * child.shape.get_debug_mesh().get_aabb()
				box = shape_box if not any else box.merge(shape_box)
				any = true
		return box if any else AABB(Vector3(-0.5, -0.5, -0.5), Vector3.ONE)
	if node is Sprite2D:
		return node.get_rect()
	if node is CollisionObject2D:
		for child in node.get_children():
			if child is CollisionShape2D and child.shape:
				return child.transform * child.shape.get_rect()
		return Rect2(-8, -8, 16, 16)
	return null

func _tracked_rects(cam3: Camera3D, size: Vector2) -> Array:
	var found: Array = []
	for pair in _candidates:
		var node = pair[0]
		if not is_instance_valid(node) or not node.is_inside_tree():
			continue
		if node is Node3D:
			if cam3 == null or not node.is_visible_in_tree():
				continue
			if not cam3.is_position_in_frustum(node.global_position):
				continue
			var rect = _project_box(cam3, node.global_transform, pair[1], size)
			if rect != null:
				found.append([cam3.global_position.distance_to(node.global_position), node, rect])
		elif node is CanvasItem and node.is_visible_in_tree():
			var xform: Transform2D = node.get_global_transform_with_canvas()
			var r: Rect2 = (xform * (pair[1] as Rect2)).intersection(Rect2(Vector2.ZERO, size))
			if r.has_area():
				found.append([0.0, node, r])
	found.sort_custom(func(a, b): return a[0] < b[0])
	var out: Array = []
	for item in found.slice(0, MAX_NODES):
		var r: Rect2 = item[2]
		var node = item[1]
		out.append({
			"path": _node_path(node),
			"type": node.get_class(),
			"rect": [int(r.position.x), int(r.position.y), int(r.size.x), int(r.size.y)],
			"pos": _v3(node.global_position) if node is Node3D else _v2(node.global_position),
		})
	return out

func _script_of(node) -> String:
	var script = node.get_script()
	return script.resource_path if script else ""

# The screen box of a local AABB: its corners projected, clamped to the view.
func _project_box(cam: Camera3D, xform: Transform3D, box: AABB, size: Vector2):
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	var any := false
	for i in 8:
		var corner := xform * box.get_endpoint(i)
		if cam.is_position_behind(corner):
			continue
		var p := cam.unproject_position(corner)
		lo = Vector2(minf(lo.x, p.x), minf(lo.y, p.y))
		hi = Vector2(maxf(hi.x, p.x), maxf(hi.y, p.y))
		any = true
	if not any:
		return null
	var r := Rect2(lo, hi - lo).intersection(Rect2(Vector2.ZERO, size))
	return r if r.has_area() else null

# --- commands ----------------------------------------------------------------

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
	var result := {"id": id, "ok": false}
	match str(cmd.get("action", "")):
		"capture":
			result = _capture(id)
		"pause":
			get_tree().paused = true
			result["ok"] = true
		"resume":
			get_tree().paused = false
			result["ok"] = true
		"pick":
			result = _pick(id, Vector2(float(cmd.get("x", 0)), float(cmd.get("y", 0))))
		_:
			result["error"] = "unknown action"
	result["time"] = Time.get_ticks_msec() / 1000.0
	result["t"] = _now_ms()
	var scene := _scene_root()
	result["scene"] = scene.scene_file_path if scene else ""
	result["paused"] = get_tree().paused
	_write("res-%d.json" % id, result)

func _capture(id: int) -> Dictionary:
	var image := get_viewport().get_texture().get_image()
	if image == null:
		return {"id": id, "ok": false, "error": "the viewport has no image (is this a headless run?)"}
	var path := _dir.path_join("cap-%d.png" % id)
	var err := image.save_png(path)
	if err != OK:
		return {"id": id, "ok": false, "error": "save_png failed: %d" % err}
	return {"id": id, "ok": true, "png": "cap-%d.png" % id, "width": image.get_width(), "height": image.get_height()}

# What is under a viewport point: a physics ray from the camera first, then the
# smallest tracked box that holds the point.
func _pick(id: int, at: Vector2) -> Dictionary:
	var result := {"id": id, "ok": true, "hit": null}
	var viewport := get_viewport()
	var cam3 := viewport.get_camera_3d()
	if cam3:
		var from := cam3.project_ray_origin(at)
		var to := from + cam3.project_ray_normal(at) * cam3.far
		var query := PhysicsRayQueryParameters3D.create(from, to)
		var hit := cam3.get_world_3d().direct_space_state.intersect_ray(query)
		if not hit.is_empty() and hit["collider"] is Node:
			var body = hit["collider"]
			result["hit"] = {"nodePath": _node_path(body), "type": body.get_class(), "worldPoint": _v3(hit["position"]), "script": _script_of(body), "source": "ray"}
			return result
	elif viewport.get_camera_2d():
		var world: Vector2 = viewport.get_canvas_transform().affine_inverse() * at
		var params := PhysicsPointQueryParameters2D.new()
		params.position = world
		var hits := viewport.world_2d.direct_space_state.intersect_point(params, 1)
		if not hits.is_empty() and hits[0]["collider"] is Node:
			var body2 = hits[0]["collider"]
			result["hit"] = {"nodePath": _node_path(body2), "type": body2.get_class(), "worldPoint": _v2(world), "script": _script_of(body2), "source": "ray"}
			return result
	var best = null
	var best_area := INF
	for item in _tracked_rects(cam3, viewport.get_visible_rect().size):
		var r: Array = item["rect"]
		var box := Rect2(r[0], r[1], r[2], r[3])
		if box.has_point(at) and box.get_area() < best_area:
			best_area = box.get_area()
			best = item
	if best != null:
		result["hit"] = {"nodePath": best["path"], "type": best["type"], "worldPoint": best["pos"], "source": "rect"}
	return result

func _write(file_name: String, data: Dictionary) -> void:
	var tmp := _dir.path_join(file_name + ".tmp")
	var file := FileAccess.open(tmp, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(data))
	file.close()
	DirAccess.rename_absolute(tmp, _dir.path_join(file_name))
