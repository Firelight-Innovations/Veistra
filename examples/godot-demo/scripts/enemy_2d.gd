extends CharacterBody2D

# The 2D Enemy_02: walks left and right, so a 2D pick (intersect_point
# through the canvas transform) has a moving target, as the 3D one does.

@export var speed := 120.0
@export var reach := 220.0

var _start_x := 0.0
var _heading := 1.0


func _ready() -> void:
	_start_x = position.x


func _physics_process(_delta: float) -> void:
	if position.x > _start_x + reach:
		_heading = -1.0
	elif position.x < _start_x - reach:
		_heading = 1.0
	velocity = Vector2(_heading * speed, 0.0)
	move_and_slide()
