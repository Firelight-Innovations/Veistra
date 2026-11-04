extends CharacterBody3D

# Walks back and forth across the hallway, so a pick has to find Enemy_02
# where it is now rather than where the scene file put it. It stops while
# the tree is paused, which is what Play's Mark up does first.

@export var speed := 1.5
@export var reach := 2.5

var _start_x := 0.0
var _heading := 1.0


func _ready() -> void:
	_start_x = position.x


func _physics_process(_delta: float) -> void:
	if position.x > _start_x + reach:
		_heading = -1.0
	elif position.x < _start_x - reach:
		_heading = 1.0
	velocity = Vector3(_heading * speed, 0.0, 0.0)
	move_and_slide()
