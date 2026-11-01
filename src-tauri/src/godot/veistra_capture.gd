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
#   {"id": 2, "action": "pick", "x": 640, "y": 360}   (pixels of the capture)
#
# Written to telemetry.jsonl, one JSON object a line, every line stamped with
# wall-clock milliseconds in "t":
#   a tick ten times a second: scene, camera, player, the longest frame since
#     the tick before, the viewport, the window and the box in it that shows
#     the viewport, the screen boxes of tracked nodes, and what the tick
#     before cost in microseconds;
#   {"kind": "mark"} for F8, {"kind": "key", "key": "F7"} and "Ctrl Shift M",
#     and {"kind": "scene", "scene": ...} when the current scene changes.
# F7, F8 and Ctrl Shift M are handled here and marked handled, so the game
# never sees them. Every other key goes to the game.
#
# Written for Godot 4.0 through 4.5. Nothing calls Vector2.min or max, which
# 4.0 lacks, and the one newer property is read by name (_content_box).
extends Node

const TICK_SEC := 0.1
const POLL_SEC := 0.1
const FLUSH_SEC := 1.0
const REFRESH_SEC := 1.0
const MAX_NODES := 64
const TRACK_GROUP := "veistra_track"
const PLAYER_GROUP := "player"
# What a node is measured by when its size cannot be read cheaply: a small
# box at its origin, so that it is still tracked.
const UNIT_BOX := AABB(Vector3(-0.5, -0.5, -0.5), Vector3(1, 1, 1))
const UNIT_RECT := Rect2(-8, -8, 16, 16)

var _dir := ""
var _last_usec := 0
var _poll_accum := 0.0
var _tick_accum := 0.0
var _flush_accum := 0.0
var _refresh_accum := REFRESH_SEC
var _frame_ms := 0.0
var _tick_usec := 0
var _log: FileAccess = null
var _scene_path := ""
# [node, local box, is 3D, path, class] for each candidate, read again only
# when the tree has changed, and then at most once a second, so a tick never
# walks the scene and a scene that holds still costs nothing to keep. Path
# and class stay null until a tick first reports the node (_entry).
var _candidates: Array = []
var _tree_changed := true
var _group_size := 0
# The last capture's size: pick's point is in its pixels.
var _capture_size := Vector2.ZERO

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
	_last_usec = Time.get_ticks_usec()
	var tree := get_tree()
	tree.node_added.connect(_on_node_added)
	tree.node_removed.connect(_on_tree_changed)
	tree.node_renamed.connect(_on_tree_changed)
	_write("hello.json", {"pid": OS.get_process_id(), "godot": Engine.get_version_info().get("string", ""), "version": 2})
	_to_front.call_deferred()

# A node that joins the root (a new scene, or a level the game adds) goes
# after this one. Deferred calls run before the frame ends, so this node is
# back in front before the next frame's input reaches the game.
func _on_node_added(node: Node) -> void:
	_tree_changed = true
	if is_inside_tree() and node.get_parent() == get_tree().root:
		_to_front.call_deferred()

func _on_tree_changed(_node: Node) -> void:
	_tree_changed = true

# Input reaches the last child of the root first, so this node keeps itself
# there. _on_node_added moves it back after a scene change, and _process
# checks every frame in case the game reorders the root itself.
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

# Every timer runs on the wall clock. delta is scaled by Engine.time_scale, so
# a game that sets it to 0 for a pause menu or a hit-stop would stop the
# ticks, the flush and the command poll with it, and Veistra's pause, capture
# and pick would time out.
func _process(_delta: float) -> void:
	var now := Time.get_ticks_usec()
	var elapsed := (now - _last_usec) / 1000000.0
	_last_usec = now
	# The longest frame since the last tick. The one frame a tick lands on
	# would miss most stutters.
	_frame_ms = maxf(_frame_ms, elapsed * 1000.0)
	_tick_accum += elapsed
	_flush_accum += elapsed
	_refresh_accum += elapsed
	_poll_accum += elapsed
	_to_front()
	if _refresh_accum >= REFRESH_SEC:
		_refresh_accum = 0.0
		# Group membership can change with no node entering or leaving.
		if _tree_changed or get_tree().get_nodes_in_group(TRACK_GROUP).size() != _group_size:
			_refresh_candidates()
	if _tick_accum >= TICK_SEC:
		_tick_accum = fmod(_tick_accum, TICK_SEC)
		_tick()
		_frame_ms = 0.0
	if _flush_accum >= FLUSH_SEC and _log:
		_flush_accum = 0.0
		_log.flush()
	if _poll_accum >= POLL_SEC:
		_poll_accum = 0.0
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
	var started := Time.get_ticks_usec()
	var root := _scene_root()
	var scene := root.scene_file_path if root else ""
	if scene != _scene_path:
		_scene_path = scene
		_event({"kind": "scene", "scene": scene})
		_refresh_candidates()
	var viewport := get_viewport()
	var size := viewport.get_visible_rect().size
	var win := get_window()
	var content := _content_box(win, size)
	# tickUs is the tick before's cost: a tick cannot time its own write.
	var data := {
		"kind": "tick",
		"scene": scene,
		"frameMs": snappedf(_frame_ms, 0.1),
		"viewport": [int(size.x), int(size.y)],
		"window": [win.size.x, win.size.y],
		"content": [int(content.position.x), int(content.position.y), int(content.size.x), int(content.size.y)],
		"tickUs": _tick_usec,
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
	_tick_usec = Time.get_ticks_usec() - started

# Where the window shows the viewport, in window pixels. A recording is the
# whole window, bars and all, so the page maps a pin through this box into
# the viewport pixels node boxes are measured in. Godot draws the visible
# rect as large as it fits, centred, at its own aspect, which leaves bars
# wherever that aspect is not the window's (expand has already grown the
# rect to match; keep_width and keep_height grow it one way only). Aspect
# "ignore" stretches it to fill instead, and integer stretch rounds the
# scale down to a whole number.
func _content_box(win: Window, visible: Vector2) -> Rect2:
	var full := Vector2(win.size)
	var whole := Rect2(Vector2.ZERO, full)
	if visible.x <= 0.0 or visible.y <= 0.0 or win.content_scale_mode == Window.CONTENT_SCALE_MODE_DISABLED:
		return whole
	if win.content_scale_aspect == Window.CONTENT_SCALE_ASPECT_IGNORE:
		return whole
	var fit := minf(full.x / visible.x, full.y / visible.y)
	# Integer stretch is 4.2's. Read by name, so 4.0 and 4.1 get null rather
	# than a script that does not compile.
	var stretch = win.get("content_scale_stretch")
	if typeof(stretch) == TYPE_INT and stretch == 1:
		fit = maxf(1.0, floorf(fit))
	var drawn := (visible * fit).floor()
	return Rect2(((full - drawn) / 2.0).round(), drawn)

# The group when it has members; otherwise physics bodies and visible meshes
# (or their 2D counterparts). Each one's box is read here, so that a tick
# reads only where things are.
func _refresh_candidates() -> void:
	_candidates.clear()
	_tree_changed = false
	var nodes: Array = get_tree().get_nodes_in_group(TRACK_GROUP)
	_group_size = nodes.size()
	var root := _scene_root()
	if root == null:
		return
	if nodes.is_empty():
		nodes = root.find_children("*", "CollisionObject3D", true, false)
		nodes.append_array(root.find_children("*", "VisualInstance3D", true, false))
		nodes.append_array(root.find_children("*", "CollisionObject2D", true, false))
		nodes.append_array(root.find_children("*", "Sprite2D", true, false))
	for node in nodes:
		var box = _local_box(node)
		if box != null:
			_candidates.append([node, box, node is Node3D, null, null])

# The box a candidate is measured by, in its own space, or null for a node
# with no place on screen. Nothing here builds a mesh: Shape3D.get_debug_mesh()
# allocates and uploads one per shape, which for a trimesh or heightmap
# collider is seconds and tens of megabytes. A node whose size cannot be read
# cheaply still gets a box, so every veistra_track member is tracked.
func _local_box(node):
	if node is VisualInstance3D:
		return node.get_aabb()
	if node is CollisionObject3D:
		var shapes = _shapes_box(node)
		return shapes if shapes != null else _meshes_box(node)
	if node is Node3D:
		return _meshes_box(node)
	if node is Sprite2D or node is AnimatedSprite2D:
		return _sprite_rect(node)
	if node is CollisionObject2D:
		for child in node.get_children():
			if child is CollisionShape2D and child.shape:
				return child.transform * child.shape.get_rect()
		return UNIT_RECT
	if node is Control:
		return Rect2(Vector2.ZERO, node.size)
	if node is Node2D:
		return _sprites_rect(node)
	return null

# A body's collision shapes, merged. A shape adds nothing when its size
# would have to be walked out of its data (trimesh, heightmap) or it has none
# (an infinite plane, a ray), and null means no shape could be measured.
func _shapes_box(body):
	var box = null
	for child in body.get_children():
		if child is CollisionShape3D and child.shape:
			var local = _shape_box(child.shape)
			if local != null:
				var placed: AABB = child.transform * local
				box = placed if box == null else box.merge(placed)
	return box

func _shape_box(shape):
	if shape is BoxShape3D:
		return AABB(-shape.size / 2.0, shape.size)
	if shape is SphereShape3D:
		var r: float = shape.radius
		return AABB(Vector3(-r, -r, -r), Vector3(r, r, r) * 2.0)
	# Both stand on Y, and height is the whole height, caps included.
	if shape is CapsuleShape3D or shape is CylinderShape3D:
		var r: float = shape.radius
		var h: float = shape.height
		return AABB(Vector3(-r, -h / 2.0, -r), Vector3(r * 2.0, h, r * 2.0))
	if shape is ConvexPolygonShape3D and not shape.points.is_empty():
		var points: PackedVector3Array = shape.points
		var hull := AABB(points[0], Vector3.ZERO)
		for p in points:
			hull = hull.expand(p)
		return hull
	return null

# A Node3D with no size of its own, such as a prop's root or a body whose
# colliders cannot be measured: the geometry under it, merged, or a 1 m box.
# Geometry rather than every VisualInstance3D, so a lamp's light range does
# not swell the lamp.
func _meshes_box(node) -> AABB:
	var xform: Transform3D = node.global_transform
	# A node scaled to zero (often the first frame of a spawn tween) has no
	# inverse, and asking for one prints an error into the take's log.
	if is_zero_approx(xform.basis.determinant()):
		return UNIT_BOX
	var to_local := xform.affine_inverse()
	var box = null
	var meshes: Array = node.find_children("*", "GeometryInstance3D", true, false)
	for mesh in meshes:
		var placed: AABB = to_local * mesh.global_transform * mesh.get_aabb()
		box = placed if box == null else box.merge(placed)
	return box if box != null else UNIT_BOX

# A Sprite2D's rect, or an AnimatedSprite2D's worked out from its current
# frame the way Sprite2D works out its own: AnimatedSprite2D exposes none.
func _sprite_rect(sprite) -> Rect2:
	if sprite is Sprite2D:
		return sprite.get_rect()
	var frames = sprite.sprite_frames
	var texture = frames.get_frame_texture(sprite.animation, sprite.frame) if frames else null
	if texture == null:
		return UNIT_RECT
	var size: Vector2 = texture.get_size()
	var corner: Vector2 = sprite.offset - (size / 2.0 if sprite.centered else Vector2.ZERO)
	return Rect2(corner, size)

# A Node2D with no size of its own: the sprites under it, merged, or a small
# box at its origin.
func _sprites_rect(node) -> Rect2:
	var xform: Transform2D = node.get_global_transform()
	if is_zero_approx(xform.x.cross(xform.y)):
		return UNIT_RECT
	var to_local := xform.affine_inverse()
	var rect = null
	var sprites: Array = node.find_children("*", "Sprite2D", true, false)
	sprites.append_array(node.find_children("*", "AnimatedSprite2D", true, false))
	for sprite in sprites:
		var placed: Rect2 = to_local * sprite.get_global_transform() * _sprite_rect(sprite)
		rect = placed if rect == null else rect.merge(placed)
	return rect if rect != null else UNIT_RECT

# The screen boxes of up to MAX_NODES candidates, 2D ones first, then 3D ones
# nearest first. Every candidate gets the cheap checks; corners are projected
# only for the nearest, in order, until the cap is reached, so a tick costs
# what the cap allows rather than what happens to be in view.
func _tracked_rects(cam3: Camera3D, size: Vector2) -> Array:
	var view := Rect2(Vector2.ZERO, size)
	var out: Array = []
	# Vector2(distance squared, index): Array.sort orders vectors by x, then
	# y, natively. sort_custom would be a GDScript call per comparison.
	var near: Array = []
	var eye := cam3.global_position if cam3 else Vector3.ZERO
	for i in _candidates.size():
		var c: Array = _candidates[i]
		if not is_instance_valid(c[0]):
			continue
		if c[2]:
			var n3: Node3D = c[0]
			if cam3 == null or not n3.is_inside_tree() or not n3.is_visible_in_tree():
				continue
			# One native call that rebuilds the frustum each time; testing the
			# six planes here would be six GDScript calls instead.
			var at := n3.global_position
			if cam3.is_position_in_frustum(at):
				near.append(Vector2(eye.distance_squared_to(at), i))
		elif out.size() < MAX_NODES:
			var item: CanvasItem = c[0]
			if not item.is_inside_tree() or not item.is_visible_in_tree():
				continue
			var box: Rect2 = c[1]
			var r := (item.get_global_transform_with_canvas() * box).intersection(view)
			if r.has_area():
				out.append(_entry(c, r))
	near.sort()
	for key in near:
		if out.size() >= MAX_NODES:
			break
		var c: Array = _candidates[int(key.y)]
		var n3: Node3D = c[0]
		var r = _project_box(cam3, n3.global_transform, c[1], size)
		if r != null:
			out.append(_entry(c, r))
	return out

# A candidate's path and class are built the first time it is reported and
# kept, so neither a refresh nor a later tick builds them again.
func _entry(c: Array, r: Rect2) -> Dictionary:
	var node = c[0]
	if c[3] == null:
		c[3] = _node_path(node)
		c[4] = node.get_class()
	return {
		"path": c[3],
		"type": c[4],
		"rect": [int(r.position.x), int(r.position.y), int(r.size.x), int(r.size.y)],
		"pos": _v3(node.global_position) if c[2] else _v2(node.global_position),
	}

func _script_of(node) -> String:
	var script = node.get_script()
	return script.resource_path if script else ""

# The screen box of a local AABB: its corners projected, clamped to the view.
func _project_box(cam: Camera3D, xform: Transform3D, box: AABB, size: Vector2):
	var r := Rect2()
	var any := false
	for i in 8:
		var corner := xform * box.get_endpoint(i)
		if cam.is_position_behind(corner):
			continue
		var p := cam.unproject_position(corner)
		r = r.expand(p) if any else Rect2(p, Vector2.ZERO)
		any = true
	if not any:
		return null
	r = r.intersection(Rect2(Vector2.ZERO, size))
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
	_capture_size = Vector2(image.get_width(), image.get_height())
	return {"id": id, "ok": true, "png": "cap-%d.png" % id, "width": image.get_width(), "height": image.get_height()}

# What is under a point of the last capture: a physics ray from the camera
# first, then the smallest tracked box that holds the point. A capture is the
# render target, which under canvas_items stretch is the size the window
# shows rather than the visible rect's, so the point is scaled into the
# visible rect first: rays, the 2D canvas and node boxes are all measured
# there.
func _pick(id: int, on_capture: Vector2) -> Dictionary:
	var result := {"id": id, "ok": true, "hit": null}
	var viewport := get_viewport()
	var visible := viewport.get_visible_rect().size
	var shot := _capture_size if _capture_size.x > 0.0 else viewport.get_texture().get_size()
	var at := on_capture * visible / shot if shot.x > 0.0 and shot.y > 0.0 else on_capture
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
	for item in _tracked_rects(cam3, visible):
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
