extends Label

# The on-screen millisecond clock for design section 13 test 4: press F8 at
# a known moment, and the mark lands within 100 ms of that frame in review.
#
# "wall" is the clock the capture addon stamps every telemetry line with
# (Unix milliseconds), shown as its last 100 seconds. "F8 down" is when this
# script, polling the keyboard, first saw F8 held: Godot updates its key
# state before any node is given the event, so the poll sees a key that the
# addon then marks handled. In review, the frame at an F8 mark should show a
# "wall" within 100 ms of its "F8 down".
#
# "Veistra keys the game was given" counts F7, F8 and Ctrl Shift M presses
# that reached this node's _input. The addon handles them before any node of
# the game, so with capture on the count stays 0; without it, it rises.

var _f8_was_down := false
var _f8_down_ms := -1
var _given := 0


func _process(_delta: float) -> void:
	var wall := _wall_ms()
	var down := Input.is_physical_key_pressed(KEY_F8)
	if down and not _f8_was_down:
		_f8_down_ms = wall
	_f8_was_down = down
	var f8 := "-" if _f8_down_ms < 0 else _clock(_f8_down_ms)
	text = (
		"t = %.3f s\nwall %s\nF8 down %s\nVeistra keys the game was given: %d"
		% [Time.get_ticks_msec() / 1000.0, _clock(wall), f8, _given]
	)


func _input(event: InputEvent) -> void:
	var key := event as InputEventKey
	if key == null or not key.pressed or key.echo:
		return
	var mark_up := key.keycode == KEY_M and key.ctrl_pressed and key.shift_pressed
	if key.keycode == KEY_F7 or key.keycode == KEY_F8 or mark_up:
		_given += 1


func _wall_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)


# The last 100 s of a wall time, to the millisecond: "37.042 s".
func _clock(ms: int) -> String:
	return "%.3f s" % ((ms % 100000) / 1000.0)
