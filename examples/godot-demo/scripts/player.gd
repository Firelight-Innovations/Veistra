extends CharacterBody3D

# WASD walks, the mouse looks while the game holds it. A click in the game
# takes the mouse and Esc gives it back: with the mouse taken there is no
# pointer to reach Veistra's toolbar with, which is when Play's live strip
# says "F7 stops and opens the take".

const SPEED := 4.0
const LOOK := 0.003
const PITCH_LIMIT := 1.2

@onready var _camera: Camera3D = $Camera


func _unhandled_input(event: InputEvent) -> void:
	var key := event as InputEventKey
	if key and key.pressed and not key.echo and key.keycode == KEY_ESCAPE:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		return
	var button := event as InputEventMouseButton
	if button and button.pressed and button.button_index == MOUSE_BUTTON_LEFT:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		return
	var motion := event as InputEventMouseMotion
	if motion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		rotate_y(-motion.relative.x * LOOK)
		_camera.rotate_x(-motion.relative.y * LOOK)
		_camera.rotation.x = clampf(_camera.rotation.x, -PITCH_LIMIT, PITCH_LIMIT)


# Physical keys, so the layout of the keyboard does not move them.
func _physics_process(_delta: float) -> void:
	var dir := Vector3.ZERO
	if Input.is_physical_key_pressed(KEY_W):
		dir.z -= 1.0
	if Input.is_physical_key_pressed(KEY_S):
		dir.z += 1.0
	if Input.is_physical_key_pressed(KEY_A):
		dir.x -= 1.0
	if Input.is_physical_key_pressed(KEY_D):
		dir.x += 1.0
	velocity = (transform.basis * dir).normalized() * SPEED
	move_and_slide()
