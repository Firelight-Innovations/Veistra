# veistra-capture v2
#
# Installed by Veistra (Play > Enable capture) and removable from the same
# place. It does nothing unless the game was started by Veistra, which passes
# --veistra-dir=<folder> after `--`, and nothing at all in an exported build,
# whatever its command line says. It never opens a socket and never touches
# the network; the whole channel is files in one temp folder.
#
# Commands, in cmd.json, answered in res-<id>.json:
#   {"id": 1, "action": "capture"}, "pause", "resume", "flush",
#   {"id": 2, "action": "pick", "x": 640, "y": 360}   (pixels of the capture)
#
# Written to telemetry.jsonl, one JSON object a line, every line stamped with
# wall-clock milliseconds in "t":
#   a tick ten times a second: scene, camera, player, the longest frame since
#     the tick before, the viewport, the window and the box in it that shows
#     the viewport, the mouse mode, the screen boxes of tracked nodes, what
#     the tick before cost in microseconds, and, after the candidates were
#     read again, what that cost;
#   {"kind": "mark"} for F8, {"kind": "key", "key": "F7"} and "Ctrl Shift M",
#     and {"kind": "scene", "scene": ...} when the current scene changes.
# F7, F8 and Ctrl Shift M are handled here and marked handled, so the game's
# input callbacks never see them. Every other key goes to the game.
#
# Written for Godot 4.0 through 4.5. Nothing calls Vector2.min or max, which
# 4.0 lacks, or reads a property newer than 4.0.
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
# What the last read of the candidates cost, until a tick reports it.
var _refresh_usec := -1
var _log: FileAccess = null
var _scene_path := ""
# [node, local box, is 3D, path, class, box centre] for each candidate, read
# again only when the tree has changed, and then at most once a second, so a
# tick never walks the scene and a scene that holds still costs nothing to
# keep. Path and class stay null until a tick first reports the node (_entry).
var _candidates: Array = []
var _tree_changed := true
var _group_size := 0
# The last capture's size: pick's point is in its pixels.
var _capture_size := Vector2.ZERO
# Picks waiting for the physics frame: [{id, at}].
var _picks: Array = []
# Keycodes of keys whose press was Veistra's, until they are released.
var _held := {}

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	# "template" is set in every exported build and never in the editor
	# binary Veistra runs a project with, so a shipped game stays inert even
	# when someone passes it the argument by hand.
	if not OS.has_feature("template"):
		_dir = _arg_dir()
	if _dir == "":
		set_process(false)
		set_physics_process(false)
		set_process_input(false)
		return
	var path := _dir.path_join("telemetry.jsonl")
	if FileAccess.file_exists(path):
		_log = FileAccess.open(path, FileAccess.READ_WRITE)
	else:
		_log = FileAccess.open(path, FileAccess.WRITE)
	if _log:
		_log.seek_end()
	_last_usec = Time.get_ticks_usec()
	var tree := get_tree()
	tree.node_added.connect(_on_node_added)
	tree.node_removed.connect(_on_tree_changed)
	tree.node_renamed.connect(_on_tree_changed)
	var godot: String = Engine.get_version_info().get("string", "")
	_write("hello.json", {"pid": OS.get_process_id(), "godot": godot, "version": 2})
	_to_front.call_deferred()

func _arg_dir() -> String:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--veistra-dir="):
			return arg.substr("--veistra-dir=".length())
	return ""

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
	if key == null:
		return
	# A repeat or the release of a key whose press was Veistra's is Veistra's
	# too, so the game never sees half of a key press.
	if key.echo or not key.pressed:
		if _held.has(key.keycode):
			get_viewport().set_input_as_handled()
			if not key.pressed:
				_held.erase(key.keycode)
		return
	# A release lost to a change of focus would leave the key marked as ours,
	# and the game's own next press of it would lose its release.
	_held.erase(key.keycode)
	var which := _veistra_key(key)
	if which == "":
		return
	get_viewport().set_input_as_handled()
	_held[key.keycode] = true
	_release_actions(key)
	if which == "F8":
		_event({"kind": "mark"})
	else:
		_event({"kind": "key", "key": which})

func _veistra_key(key: InputEventKey) -> String:
	if key.keycode == KEY_F7:
		return "F7"
	if key.keycode == KEY_F8:
		return "F8"
	if key.keycode == KEY_M and key.ctrl_pressed and key.shift_pressed:
		return "Ctrl Shift M"
	return ""

# Input took the press before any node saw it, so a game polling an action
# bound to one of these keys would still find it held. Releasing the action
# covers is_action_pressed. On 4.2 and later is_action_just_pressed still
# answers true until the frame ends (Godot keeps taps shorter than a frame),
# and Input.is_key_pressed reads the key itself; nothing a script does
# reaches either.
func _release_actions(key: InputEventKey) -> void:
	for action in InputMap.get_actions():
		if InputMap.event_is_action(key, action) and Input.is_action_pressed(action):
			Input.action_release(action)

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
		var group_size := get_tree().get_nodes_in_group(TRACK_GROUP).size()
		if _tree_changed or group_size != _group_size:
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

# A pick's physics query runs here, the one place Godot makes the direct
# space state safe to read: with physics on its own thread it refuses from
# _process, and Jolt refuses while it steps. Physics frames come at their
# own rate whatever Engine.time_scale is, and this node keeps processing
# while the tree is paused, so a pick still answers during Mark up.
func _physics_process(_delta: float) -> void:
	while not _picks.is_empty():
		var asked: Dictionary = _picks.pop_front()
		_answer(asked["id"], _pick(asked["id"], asked["at"]))

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
		# Between two scenes Godot has no current scene for part of a frame,
		# and that is not a scene the run was in.
		if scene != "":
			_event({"kind": "scene", "scene": scene})
		_refresh_candidates()
	# Timed from here, so a refresh's walk is reported as refreshUs instead
	# of swelling the tick's own cost.
	var started := Time.get_ticks_usec()
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
		"content": [int(content.position.x), int(content.position.y),
				int(content.size.x), int(content.size.y)],
		"mouse": Input.mouse_mode,
		"tickUs": _tick_usec,
	}
	if _refresh_usec >= 0:
		data["refreshUs"] = _refresh_usec
		_refresh_usec = -1
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
# the viewport pixels node boxes are measured in. The box is the visible rect
# put through the window's final transform, the one Godot inverts to bring a
# click in window pixels into the viewport: Window overrides it to add the
# bars' offset to the stretch, so it lands where the engine draws for every
# mode, aspect, scale factor and integer stretch. Working the box out here
# from those settings was tried first and got integer stretch wrong three
# ways; the engine's own transform cannot drift from what it draws.
func _content_box(win: Window, visible: Vector2) -> Rect2:
	var box: Rect2 = win.get_final_transform() * Rect2(Vector2.ZERO, visible)
	return Rect2(box.position.round(), box.size.round())

# The group when it has members; otherwise the defaults below. Each one's box
# is read here, so that a tick reads only where things are.
func _refresh_candidates() -> void:
	var started := Time.get_ticks_usec()
	_candidates.clear()
	_tree_changed = false
	var nodes: Array = get_tree().get_nodes_in_group(TRACK_GROUP)
	_group_size = nodes.size()
	if nodes.is_empty():
		nodes = _default_candidates()
	for node in nodes:
		var box = _local_box(node)
		if box != null:
			var is_3d: bool = node is Node3D
			var centre = box.get_center() if is_3d else null
			_candidates.append([node, box, is_3d, null, null, centre])
	_refresh_usec = Time.get_ticks_usec() - started

# Physics bodies, and the meshes and sprites that are not part of one. A
# body's own mesh is the body: two boxes for one enemy would let the mesh's,
# a little smaller, take a pin that should name the body. Geometry rather
# than every VisualInstance3D, so lights, probes and decals stay out. With no
# current scene (a game that builds its own tree) the whole tree is searched.
func _default_candidates() -> Array:
	var root := _scene_root()
	if root == null:
		root = get_tree().root
	var found: Array = root.find_children("*", "CollisionObject3D", true, false)
	found.append_array(root.find_children("*", "CollisionObject2D", true, false))
	var loose: Array = root.find_children("*", "GeometryInstance3D", true, false)
	loose.append_array(root.find_children("*", "Sprite2D", true, false))
	loose.append_array(root.find_children("*", "AnimatedSprite2D", true, false))
	for node in loose:
		if not _in_body(node, root):
			found.append(node)
	return found

# Whether a mesh or sprite sits under a body, below `root`. The root itself
# does not count: a level whose root is a body would otherwise fold every
# mesh in it into one box.
func _in_body(node: Node, root: Node) -> bool:
	var up := node.get_parent()
	while up != null and up != root:
		if up is CollisionObject3D or up is CollisionObject2D:
			return true
		up = up.get_parent()
	return false

# The box a candidate is measured by, in its own space, or null for a node
# with no place on screen. Nothing here builds a mesh: Shape3D.get_debug_mesh()
# allocates and uploads one per shape, which for a trimesh or heightmap
# collider is seconds and tens of megabytes. A node whose size cannot be read
# cheaply still gets a box, so every veistra_track member is tracked.
func _local_box(node):
	var box = null
	if node is VisualInstance3D:
		box = node.get_aabb()
	elif node is CollisionObject3D:
		box = _shapes_box(node)
		if box == null:
			box = _meshes_box(node)
	elif node is Node3D:
		box = _meshes_box(node)
	elif node is Sprite2D or node is AnimatedSprite2D:
		box = _sprite_rect(node)
	elif node is CollisionObject2D:
		box = _body_rect(node)
	elif node is Control:
		box = Rect2(Vector2.ZERO, node.size)
	elif node is Node2D:
		box = _sprites_rect(node)
	return box

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

# A 2D body's first collision shape, or a small box at its origin.
func _body_rect(body) -> Rect2:
	for child in body.get_children():
		if child is CollisionShape2D and child.shape:
			return child.transform * child.shape.get_rect()
	return UNIT_RECT

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
			# The box's centre rather than the origin, which for a character
			# is often at its feet, below the frame when the camera shows the
			# rest of it. One native call that rebuilds the frustum each time;
			# testing the six planes here would be six GDScript calls instead.
			var at: Vector3 = n3.global_transform * c[5]
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
		"flush":
			# Stop copies the file straight away, and the ticks written since
			# the last flush would otherwise be missing from the take's end.
			if _log:
				_log.flush()
			result["ok"] = true
		"pick":
			_picks.append({"id": id, "at": Vector2(float(cmd.get("x", 0)), float(cmd.get("y", 0)))})
			return
		_:
			result["error"] = "unknown action"
	_answer(id, result)

# Every answer also says when it was made and where the game was.
func _answer(id: int, result: Dictionary) -> void:
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
	var width := image.get_width()
	var height := image.get_height()
	_capture_size = Vector2(width, height)
	return {"id": id, "ok": true, "png": "cap-%d.png" % id, "width": width, "height": height}

# What is under a point of the last capture: a physics ray from the camera
# first, then the smallest tracked box that holds the point. A capture is the
# render target, which under canvas_items stretch is the size the window
# shows rather than the visible rect's, so the point is scaled into the
# visible rect first: rays, the 2D canvas and node boxes are all measured
# there. Called from _physics_process only.
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
			result["hit"] = _ray_hit(hit["collider"], _v3(hit["position"]))
			return result
	elif viewport.get_camera_2d():
		var world: Vector2 = viewport.get_canvas_transform().affine_inverse() * at
		var params := PhysicsPointQueryParameters2D.new()
		params.position = world
		var hits := viewport.world_2d.direct_space_state.intersect_point(params, 1)
		if not hits.is_empty() and hits[0]["collider"] is Node:
			result["hit"] = _ray_hit(hits[0]["collider"], _v2(world))
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
		result["hit"] = {
			"nodePath": best["path"],
			"type": best["type"],
			"worldPoint": best["pos"],
			"source": "rect",
		}
	return result

func _ray_hit(body: Node, world_point: Array) -> Dictionary:
	return {
		"nodePath": _node_path(body),
		"type": body.get_class(),
		"worldPoint": world_point,
		"script": _script_of(body),
		"source": "ray",
	}

func _write(file_name: String, data: Dictionary) -> void:
	var tmp := _dir.path_join(file_name + ".tmp")
	var file := FileAccess.open(tmp, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(data))
	file.close()
	DirAccess.rename_absolute(tmp, _dir.path_join(file_name))
