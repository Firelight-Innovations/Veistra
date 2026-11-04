extends Node3D

# Design section 5.5: a tick costs 0.5 ms or less at 64 tracked nodes. This
# builds `in_view` bodies in a grid in front of the camera, which the addon
# tracks (its cap is 64), and `out_of_view` behind it, which it does not
# track but still gives the cheap per-candidate check every tick makes
# before the cap. Read tickUsP95 in the take's take.json, and refreshUs in
# telemetry.jsonl for what reading the candidates again cost.

@export var in_view := 64
@export var out_of_view := 1000
@export var spacing := 1.0


func _ready() -> void:
	var shape := BoxShape3D.new()
	shape.size = Vector3(0.5, 0.5, 0.5)
	var mesh := BoxMesh.new()
	mesh.size = shape.size
	var side := ceili(sqrt(float(in_view)))
	for i in in_view:
		var cell := Vector2(i % side, floorf(i / float(side))) - Vector2(side, side) / 2.0
		var at := Vector3(cell.x * spacing, cell.y * spacing, -12.0)
		add_child(_body("InView_%d" % i, at, shape, mesh))
	# The camera looks down -Z, so +Z is behind it.
	for i in out_of_view:
		var cell := Vector2(i % 40, floorf(i / 40.0)) - Vector2(20.0, 12.0)
		var at := Vector3(cell.x * 1.5, cell.y * 1.5, 20.0)
		add_child(_body("Behind_%d" % i, at, shape, mesh))


func _body(label: String, at: Vector3, shape: Shape3D, mesh: Mesh) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.name = label
	body.position = at
	var collider := CollisionShape3D.new()
	collider.shape = shape
	body.add_child(collider)
	var visual := MeshInstance3D.new()
	visual.mesh = mesh
	body.add_child(visual)
	return body
