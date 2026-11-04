# Veistra's headless Blender export. Run as:
#
#   blender -b <file.blend> --disable-autoexec --python-exit-code 1 --python export.py
#
# It reads its job from VEISTRA_BLENDER_* environment variables (never argv, so
# there is nothing to quote), writes everything into VEISTRA_BLENDER_OUT, and
# never saves the .blend. Progress goes to stdout as
#   VEISTRA_PROGRESS <step>/<total> <label>
# and the final answer is <out>/result.json.
#
# Every stage is wrapped on its own: a scene with no camera-worthy geometry, or
# a Blender build without the glTF add-on, still yields whatever else worked,
# with the reason in "warnings" rather than a bare crash.

import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

OUT = os.environ["VEISTRA_BLENDER_OUT"]
ENGINE = os.environ.get("VEISTRA_BLENDER_ENGINE", "workbench")
RES = int(os.environ.get("VEISTRA_BLENDER_RES", "512"))
VIEWS = [v for v in os.environ.get("VEISTRA_BLENDER_VIEWS", "front,three-quarter,side,wire").split(",") if v]

# (id, label, azimuth degrees from -Y toward +X, elevation degrees, wireframe)
VIEW_TABLE = {
    "front": ("front", 0.0, 8.0, False),
    "three-quarter": ("three-quarter", 35.0, 22.0, False),
    "side": ("side", 90.0, 8.0, False),
    "wire": ("wire", 35.0, 22.0, True),
}

warnings = []
result = {
    "blenderVersion": ".".join(str(n) for n in bpy.app.version),
    "glb": None,
    "renders": [],
    "parts": [],
    "materials": [],
    "stats": {},
    "warnings": warnings,
}
total_steps = 2 + len([v for v in VIEWS if v in VIEW_TABLE])
step = 0


def progress(label):
    global step
    step += 1
    print("VEISTRA_PROGRESS %d/%d %s" % (step, total_steps, label), flush=True)


def mesh_objects(scene):
    return [o for o in scene.objects if o.type == "MESH" and not o.hide_render]


def mesh_counts(depsgraph, obj):
    """(verts, polys, tris) of an object's evaluated mesh."""
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    try:
        mesh.calc_loop_triangles()
        return len(mesh.vertices), len(mesh.polygons), len(mesh.loop_triangles)
    finally:
        ev.to_mesh_clear()


def mesh_instances(depsgraph):
    """Every instanced mesh (collection instances, nested ones, geometry-node
    and particle instances) as (parent object name or None, evaluated object,
    world matrix). The originals are not repeated here; scene.objects has them."""
    found = []
    for inst in depsgraph.object_instances:
        if not inst.is_instance or inst.object.type != "MESH" or inst.object.hide_render:
            continue
        parent = inst.parent.original.name if inst.parent is not None else None
        found.append((parent, inst.object, inst.matrix_world.copy()))
    return found


def collect_parts(scene):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    parts = []
    instanced = {}
    for parent, obj, _matrix in mesh_instances(depsgraph):
        verts, polys, tris = mesh_counts(depsgraph, obj)
        total = instanced.setdefault(parent, {"verts": 0, "polys": 0, "tris": 0, "meshes": 0})
        total["verts"] += verts
        total["polys"] += polys
        total["tris"] += tris
        total["meshes"] += 1
    for obj in scene.objects:
        entry = {
            "name": obj.name,
            "kind": obj.type.lower(),
            "parent": obj.parent.name if obj.parent else None,
            "visible": not obj.hide_render,
            "mesh": None,
            "materials": [],
            "verts": 0,
            "polys": 0,
            "tris": 0,
            "dimensions": [round(d, 4) for d in obj.dimensions],
        }
        if obj.type == "MESH":
            entry["mesh"] = obj.data.name
            entry["verts"], entry["polys"], entry["tris"] = mesh_counts(depsgraph, obj)
        if obj.instance_type == "COLLECTION" and obj.instance_collection is not None:
            # Additive fields: "kind" stays "empty" only for plain empties.
            total = instanced.get(obj.name, {"verts": 0, "polys": 0, "tris": 0, "meshes": 0})
            entry["kind"] = "instance"
            entry["instanceOf"] = obj.instance_collection.name
            entry["instanceMeshes"] = total["meshes"]
            entry["verts"] = total["verts"]
            entry["polys"] = total["polys"]
            entry["tris"] = total["tris"]
            entry["dimensions"] = instance_dimensions(depsgraph, obj.name)
        for slot in obj.material_slots:
            if slot.material is not None and slot.material.name not in entry["materials"]:
                entry["materials"].append(slot.material.name)
        parts.append(entry)
    return parts


def world_corners(obj, matrix):
    return [matrix @ Vector(corner) for corner in obj.bound_box]


def instance_dimensions(depsgraph, parent_name):
    """World-space size of everything one instancing object brings in."""
    points = []
    for parent, obj, matrix in mesh_instances(depsgraph):
        if parent == parent_name:
            points.extend(world_corners(obj, matrix))
    if not points:
        return [0.0, 0.0, 0.0]
    return [round(max(p[i] for p in points) - min(p[i] for p in points), 4) for i in range(3)]


def scene_bounds(scene):
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    found = False
    depsgraph = bpy.context.evaluated_depsgraph_get()
    corners = []
    for obj in mesh_objects(scene):
        corners.extend(world_corners(obj, obj.matrix_world))
    for _parent, obj, matrix in mesh_instances(depsgraph):
        corners.extend(world_corners(obj, matrix))
    for world in corners:
        lo = Vector((min(lo[i], world[i]) for i in range(3)))
        hi = Vector((max(hi[i], world[i]) for i in range(3)))
        found = True
    if not found:
        return None
    return lo, hi


def principled(mat):
    """The material's Principled BSDF, or None."""
    if mat.node_tree is None:
        return None
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return None


def collect_materials():
    """Each used material's colour and scalar values, so Compare can say what
    changed in a material between two versions (spec §12.1). The Principled
    BSDF's inputs where they are plain values, the viewport ones otherwise."""
    found = []
    for mat in bpy.data.materials:
        if mat.users == 0:
            continue
        entry = {
            "name": mat.name,
            "color": [round(c, 4) for c in mat.diffuse_color],
            "metallic": round(mat.metallic, 4),
            "roughness": round(mat.roughness, 4),
        }
        node = principled(mat)
        if node is not None:
            for key, socket in (("color", "Base Color"), ("metallic", "Metallic"),
                                ("roughness", "Roughness"), ("alpha", "Alpha")):
                field = node.inputs.get(socket)
                if field is None or field.is_linked:
                    continue
                value = field.default_value
                entry[key] = [round(c, 4) for c in value] if key == "color" else round(value, 4)
        found.append(entry)
    return found


def export_glb(path):
    try:
        # Modifiers applied, so the .glb is the shape on screen, not the cage.
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True)
        result["glb"] = os.path.basename(path)
    except Exception as exc:  # the add-on can be missing or disabled
        warnings.append("glb export failed: %s" % exc)


def pick_engine(scene, wire):
    if wire or ENGINE == "workbench":
        scene.render.engine = "BLENDER_WORKBENCH"
        return
    # 4.2 renamed Eevee; try the new id first, then the old.
    for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = name
            return
        except TypeError:
            continue
    scene.render.engine = "BLENDER_WORKBENCH"
    warnings.append("Eevee is unavailable in this Blender; rendered with Workbench")


def sync_viewport_colours():
    """Workbench's MATERIAL colour reads Material.diffuse_color, which stays the
    default grey when the colour lives only in the node tree. Copy each
    Principled BSDF base colour across. In memory only: nothing here is saved."""
    for mat in bpy.data.materials:
        try:
            # Not the material's node-usage flag: 5.x deprecates it (removal in
            # 6.0) and prints a warning per material. No node tree, nothing to read.
            node = principled(mat)
            if node is None:
                continue
            base = node.inputs["Base Color"]
            if not base.is_linked:
                mat.diffuse_color = tuple(base.default_value)
        except Exception as exc:  # e.g. linked library data refusing the write
            warnings.append("viewport colour for %s not synced: %s" % (mat.name, exc))


WIRE_INK = (0.05, 0.05, 0.06)
WIRE_PAPER = (0.9, 0.9, 0.9)


def wire_look(scene, radius):
    """Make the next render a wireframe, and return what undoes it.

    Workbench does not draw WIREFRAME shading in a final render: the frame
    comes out as the bare background, one flat colour, which is why the wire
    view was a blank PNG. So it renders SOLID instead, each mesh swapped for
    its edges by a temporary Wireframe modifier, dark lines on a light world.
    The .glb was written before any of this, and nothing is saved."""
    shading = scene.display.shading
    saved = {key: getattr(shading, key) for key in (
        "type", "light", "color_type",
        "show_object_outline", "show_cavity", "show_shadows")}
    # A copy: the property itself would follow the change below.
    saved["single_color"] = tuple(shading.single_color)
    old_world = scene.world
    paper = bpy.data.worlds.new("veistra_wire_paper")
    paper.color = WIRE_PAPER
    scene.world = paper
    shading.type = "SOLID"
    shading.light = "FLAT"
    shading.color_type = "SINGLE"
    shading.single_color = WIRE_INK
    shading.show_object_outline = False
    shading.show_cavity = False
    shading.show_shadows = False
    # The frame is about 2.44 radii across (see render_views), so this is a
    # line about 1.5 pixels wide at any resolution, in each object's own
    # units: the modifier works before the object's scale.
    width = radius * 3.6 / RES
    added = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        try:
            scale = max(abs(s) for s in obj.matrix_world.to_scale()) or 1.0
            mod = obj.modifiers.new("veistra_wire", "WIREFRAME")
            mod.thickness = max(width / scale, 1e-5)
            mod.use_replace = True
            mod.use_even_offset = True
            added.append((obj, mod))
        except Exception as exc:  # linked library data refuses new modifiers
            warnings.append("wire view: %s drawn solid: %s" % (obj.name, exc))

    def undo():
        for obj, mod in added:
            obj.modifiers.remove(mod)
        for key, value in saved.items():
            setattr(shading, key, value)
        scene.world = old_world
        bpy.data.worlds.remove(paper)

    return undo


def render_views(scene, bounds):
    lo, hi = bounds
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.001)

    cam_data = bpy.data.cameras.new("veistra_cam")
    cam = bpy.data.objects.new("veistra_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.lens = 50
    distance = radius / math.sin(math.atan(18.0 / 50.0)) * 1.15
    cam_data.clip_end = max(distance * 4, 100.0)

    sun = None
    if ENGINE != "workbench" and not any(o.type == "LIGHT" for o in scene.objects):
        sun_data = bpy.data.lights.new("veistra_sun", "SUN")
        sun_data.energy = 3.0
        sun = bpy.data.objects.new("veistra_sun", sun_data)
        sun.rotation_euler = (math.radians(50), 0, math.radians(30))
        scene.collection.objects.link(sun)

    sync_viewport_colours()

    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    for view_id in VIEWS:
        spec = VIEW_TABLE.get(view_id)
        if spec is None:
            warnings.append("unknown view %r skipped" % view_id)
            continue
        label, azimuth, elevation, wire = spec
        progress("render " + label)
        try:
            az, el = math.radians(azimuth), math.radians(elevation)
            offset = Vector((
                math.sin(az) * math.cos(el),
                -math.cos(az) * math.cos(el),
                math.sin(el),
            )) * distance
            cam.location = center + offset
            cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
            pick_engine(scene, wire)
            undo = None
            if wire:
                undo = wire_look(scene, radius)
            else:
                scene.display.shading.type = "SOLID"
                # Default is the studio grey; MATERIAL shows each material's viewport colour.
                scene.display.shading.color_type = "MATERIAL"
            filename = "%s.png" % view_id
            scene.render.filepath = os.path.join(OUT, filename)
            try:
                bpy.ops.render.render(write_still=True)
            finally:
                if undo is not None:
                    undo()
            result["renders"].append({"id": view_id, "label": label, "file": filename})
        except Exception as exc:
            warnings.append("render %s failed: %s" % (label, exc))

    if sun is not None:
        bpy.data.objects.remove(sun)
    bpy.data.objects.remove(cam)


def main():
    scene = bpy.context.scene
    os.makedirs(OUT, exist_ok=True)

    progress("parts list")
    try:
        parts = collect_parts(scene)
        result["parts"] = parts
        meshes = [p for p in parts if p["kind"] in ("mesh", "instance")]
        result["stats"] = {
            "objects": len(parts),
            "meshes": len([p for p in parts if p["kind"] == "mesh"]),
            "instances": len([p for p in parts if p["kind"] == "instance"]),
            "materials": len(bpy.data.materials),
            "polys": sum(p["polys"] for p in meshes),
            "tris": sum(p["tris"] for p in meshes),
        }
    except Exception as exc:
        warnings.append("parts list failed: %s" % exc)
    try:
        result["materials"] = collect_materials()
    except Exception as exc:
        warnings.append("material values failed: %s" % exc)

    progress("glb")
    if mesh_objects(scene) or mesh_instances(bpy.context.evaluated_depsgraph_get()):
        export_glb(os.path.join(OUT, "model.glb"))
    else:
        warnings.append("no visible mesh objects, so there is nothing to export or render")

    bounds = scene_bounds(scene)
    if bounds is not None and VIEWS:
        render_views(scene, bounds)


try:
    main()
except Exception:
    warnings.append("export aborted: " + traceback.format_exc())
    print(traceback.format_exc(), file=sys.stderr, flush=True)
finally:
    with open(os.path.join(OUT, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh)
