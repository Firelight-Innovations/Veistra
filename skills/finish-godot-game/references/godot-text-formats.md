# Godot 4 text formats

The exact text of the files a playable Godot 4 project needs. Every example here was loaded and
run with `scripts/check_game.gd` on Godot 4.3 and 4.5.

## project.godot

The smallest project that runs:

```ini
config_version=5

[application]

config/name="Dodge"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.3")
```

- `config_version=5` is every Godot 4 release.
- `config/features` holds the engine's `major.minor` (`--version` prints it). The editor adds a
  renderer name to it, such as `"Forward Plus"`, when it saves. Leave that to the editor.
- `run/main_scene` may also be a `uid://...` reference, which Godot 4.4 and later write when they
  save. Either form works. Keep whatever the project already has.
- Write keys only in the sections shown here. Godot rewrites the file when the editor saves, so
  do not rely on comments or ordering.

An autoload, a script or scene that lives for the whole game (score, input setup):

```ini
[autoload]

Game="*res://game.gd"
```

The `*` makes it a global you can reach by name, as `Game.score`.

## Input actions

Prefer adding actions in code. The `[input]` section of `project.godot` is a long serialized
`InputEventKey` that is easy to get wrong. Do it in the main scene's root script, in
`_enter_tree`, which runs before any child's `_ready`:

```gdscript
extends Node2D

func _enter_tree() -> void:
	add_key("jump", KEY_SPACE)
	add_key("fire", KEY_J)

static func add_key(action: StringName, key: Key) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var event := InputEventKey.new()
	event.physical_keycode = key
	InputMap.action_add_event(action, event)
```

The built-in `ui_left`, `ui_right`, `ui_up`, `ui_down` (arrow keys), `ui_accept` (Enter and
Space) and `ui_cancel` (Escape) need nothing at all:

```gdscript
var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
```

## A .tscn scene

```
[gd_scene load_steps=4 format=3]

[ext_resource type="Script" path="res://main.gd" id="1_main"]
[ext_resource type="Script" path="res://player.gd" id="2_player"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_player"]
size = Vector2(32, 32)

[node name="Main" type="Node2D"]
script = ExtResource("1_main")

[node name="Player" type="CharacterBody2D" parent="."]
position = Vector2(576, 324)
script = ExtResource("2_player")

[node name="Body" type="ColorRect" parent="Player"]
offset_left = -16.0
offset_top = -16.0
offset_right = 16.0
offset_bottom = 16.0
color = Color(0.3, 0.7, 1, 1)

[node name="CollisionShape2D" type="CollisionShape2D" parent="Player"]
shape = SubResource("RectangleShape2D_player")

[node name="Camera2D" type="Camera2D" parent="."]
position = Vector2(576, 324)
```

The rules:

1. **Header.** `[gd_scene load_steps=N format=3]`, where `N` is the number of `ext_resource`
   and `sub_resource` entries plus one. `format=3` is Godot 4. Godot 4.4 and later add a
   `uid="uid://..."` when the editor saves. Leave it out when you write a new scene, and keep it
   when one is there.
2. **Order.** Every `ext_resource` comes first, then every `sub_resource`, then the nodes.
3. **ext_resource** is a file: `type` is `Script`, `PackedScene`, `Texture2D`, `AudioStream` and
   so on, and `path` is a `res://` path. `id` is any string unique in the file, used as
   `ExtResource("id")`.
4. **sub_resource** is a resource that lives inside the scene, such as a shape, mesh or
   material. Use it as `SubResource("id")`.
5. **Nodes.** The first node is the root and has no `parent`. A direct child has `parent="."`.
   A deeper node names the path from the root, as `parent="Player"` or
   `parent="World/Enemies"`. A parent comes before its children.
6. **Properties** are written as Godot prints them: `Vector2(1, 2)`, `Color(r, g, b, a)` with
   0-1 floats, and floats with a decimal point (`16.0`). Leave out any property that keeps its
   default.
7. `unique_name_in_owner = true` on a node lets scripts reach it as `%Name` from anywhere in
   the scene.

### Instancing another scene

```
[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://player.tscn" id="1_player"]

[node name="Main" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("1_player")]
position = Vector2(576, 324)

[node name="Score" type="Label" parent="."]
unique_name_in_owner = true
offset_left = 16.0
offset_top = 16.0
text = "Score: 0"
```

An instanced node has `instance=` and no `type`. Properties under it override the instanced
scene's own.

From a script, `preload` the scene and add the instance to the tree:

```gdscript
const ENEMY := preload("res://enemy.tscn")

func spawn(at: Vector2) -> void:
	var enemy := ENEMY.instantiate()
	enemy.position = at
	add_child(enemy)
```

### A 3D scene

A 3D scene needs a camera and a light, or the frame is black:

```
[gd_scene load_steps=5 format=3]

[ext_resource type="Script" path="res://spin.gd" id="1_spin"]

[sub_resource type="BoxMesh" id="BoxMesh_cube"]

[sub_resource type="StandardMaterial3D" id="StandardMaterial3D_red"]
albedo_color = Color(0.9, 0.25, 0.2, 1)

[sub_resource type="PlaneMesh" id="PlaneMesh_floor"]
size = Vector2(10, 10)

[node name="Main" type="Node3D"]

[node name="Cube" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0)
mesh = SubResource("BoxMesh_cube")
surface_material_override/0 = SubResource("StandardMaterial3D_red")
script = ExtResource("1_spin")

[node name="Floor" type="MeshInstance3D" parent="."]
mesh = SubResource("PlaneMesh_floor")

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.5, 0.866, 0, -0.866, 0.5, 0, 5, 0)

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.94, 0.342, 0, -0.342, 0.94, 0, 2.5, 5)
current = true
```

In `Transform3D(...)` the first nine numbers are the rotation and scale and the last three are
the position. To place a node without rotating it, use
`Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z)`.

## The default window

A new project's window is 1152 x 648, and in 2D the camera-less view puts `(0, 0)` at its top
left. Keep 2D content inside that rectangle, or add a `Camera2D` that follows the player.
