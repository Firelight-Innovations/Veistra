"""Writes fixtures/cube-a.glb and fixtures/cube-b.glb, the pair for spec test 13
(docs/design/VEISTRA-PLAY-REVIEW.md section 13): a 1 m cube, then the same cube
with its top face extruded 2 cm.

They are made by Blender itself, not by hand, because the test is about what a
real export looks like: which diagonal each quad is split on, whether the top
keeps its diagonal after the extrude, and where the new strip's corners land.
A hand-written pair would pin the triangulation we guessed rather than the one
Blender 5.0.1 gives. A has 12 triangles; B has 20, and the diff counts them as
8 added, 2 changed, 0 removed and 10 unchanged
(src/compare/compare.fixture.test.ts).

    blender -b --python scripts/make-compare-fixtures.py
    python scripts/make-compare-fixtures.py      # a Python with the bpy module

The export settings are the viewer's own (src-tauri/src/blender/export.py:
GLB, modifiers applied), so the pair is what Compare would be handed.
"""

import os

import bpy
import bmesh  # after bpy: the bpy module only provides it once loaded

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")


def cube():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    obj = bpy.context.object
    obj.name = "Cube"
    return obj


def export(name):
    path = os.path.join(OUT, name)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True)
    print("wrote", os.path.normpath(path))


def extrude_top(obj, height):
    bpy.ops.object.mode_set(mode="EDIT")
    mesh = bmesh.from_edit_mesh(obj.data)
    for face in mesh.faces:
        face.select = False
    max(mesh.faces, key=lambda f: f.calc_center_median().z).select = True
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.mesh.extrude_region_move(TRANSFORM_OT_translate={"value": (0, 0, height)})
    bpy.ops.object.mode_set(mode="OBJECT")


cube()
export("cube-a.glb")
extrude_top(cube(), 0.02)
export("cube-b.glb")
