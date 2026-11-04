# Runs export.py and veistra_boot.py inside a real bpy, headless.
#
#   python -I src-tauri/src/blender/bpy_test.py
#
# with a Python that has the `bpy` module (pip install bpy), or
#
#   blender -b --python-exit-code 1 --python src-tauri/src/blender/bpy_test.py
#
# Without bpy it prints why and exits 0, so it never fails a machine that has
# no Blender. `cargo test` runs it when VEISTRA_TEST_BPY_PYTHON names such a
# Python (blender::tests::the_scripts_pass_in_a_real_bpy).

import hashlib
import json
import os
import runpy
import shutil
import struct
import sys
import tempfile
import unittest

try:
    import bpy
except ImportError:
    print("skipped: this Python has no bpy module")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.join(HERE, "export.py")
BOOT = os.path.join(HERE, "veistra_boot.py")


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def glb_triangles(path):
    """Triangles in a .glb's meshes, read from its JSON chunk."""
    with open(path, "rb") as fh:
        data = fh.read()
    length = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    total = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            total += gltf["accessors"][prim["indices"]]["count"] // 3
    return total


def make_bed(path):
    """A cube subdivided twice by a modifier (6 * 16 quads, 192 triangles once
    applied, 12 if it is not) with a red Principled material, saved to path."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add()
    cube = bpy.context.active_object
    cube.name = "Frame"
    sub = cube.modifiers.new("subdivide", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    mat = bpy.data.materials.new("Oak")
    tree = mat.node_tree
    if tree is None:  # Blender 4.x makes the tree on request
        mat.use_nodes = True
        tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.8, 0.1, 0.1, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.25
    cube.data.materials.append(mat)
    bpy.ops.mesh.primitive_uv_sphere_add(location=(2.5, 0, 0))
    bpy.context.active_object.name = "Pillow"
    bpy.ops.wm.save_as_mainfile(filepath=path)


class ExportScript(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="veistra-bpy-")
        cls.blend = os.path.join(cls.dir, "bed.blend")
        make_bed(cls.blend)
        cls.before = sha256(cls.blend)
        cls.out = os.path.join(cls.dir, "out")
        bpy.ops.wm.open_mainfile(filepath=cls.blend)
        os.environ.update(
            VEISTRA_BLENDER_OUT=cls.out,
            VEISTRA_BLENDER_ENGINE="workbench",
            VEISTRA_BLENDER_RES="96",
            VEISTRA_BLENDER_VIEWS="front,wire",
        )
        runpy.run_path(EXPORT, run_name="__main__")
        with open(os.path.join(cls.out, "result.json"), encoding="utf-8") as fh:
            cls.result = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_the_blend_is_byte_for_byte_unchanged(self):
        self.assertEqual(sha256(self.blend), self.before)
        self.assertFalse(bpy.data.is_dirty and os.path.exists(self.blend + "1"))

    def test_the_glb_has_modifiers_applied(self):
        self.assertEqual(self.result["glb"], "model.glb")
        # 192 from the subdivided cube; the sphere adds its own.
        self.assertGreater(glb_triangles(os.path.join(self.out, "model.glb")), 192)

    def test_materials_carry_their_principled_values(self):
        oak = next(m for m in self.result["materials"] if m["name"] == "Oak")
        self.assertAlmostEqual(oak["color"][0], 0.8, places=3)
        self.assertAlmostEqual(oak["roughness"], 0.25, places=3)

    def test_the_wire_render_has_dark_lines_on_a_light_ground(self):
        wire = next(r for r in self.result["renders"] if r["id"] == "wire")
        img = bpy.data.images.load(os.path.join(self.out, wire["file"]))
        px = img.pixels[:]
        lum = [sum(px[i:i + 3]) / 3 for i in range(0, len(px), 4)]
        dark = sum(1 for v in lum if v < 0.3)
        light = sum(1 for v in lum if v > 0.6)
        # Before the fix the whole picture was one flat colour.
        self.assertGreater(dark, len(lum) // 100, "no wires drawn")
        self.assertGreater(light, len(lum) // 2, "no light ground")

    def test_the_wire_look_is_undone_after_rendering(self):
        frame = bpy.data.objects["Frame"]
        self.assertEqual([m.name for m in frame.modifiers], ["subdivide"])
        self.assertNotIn("veistra_wire_paper", bpy.data.worlds)


class BootScript(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="veistra-boot-")
        blend = os.path.join(self.dir, "bed.blend")
        make_bed(blend)
        bpy.ops.wm.open_mainfile(filepath=blend)
        self.addons = sorted(bpy.context.preferences.addons.keys())
        os.environ["VEISTRA_BLENDER_CHANNEL"] = self.dir
        self.boot = runpy.run_path(BOOT, run_name="veistra_boot")

    def tearDown(self):
        self.boot["unregister"]()
        os.environ.pop("VEISTRA_BLENDER_CHANNEL", None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def read(self, name):
        with open(os.path.join(self.dir, name), encoding="utf-8") as fh:
            return json.load(fh)

    def send(self, cmd):
        tmp = os.path.join(self.dir, "cmd.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cmd, fh)
        os.replace(tmp, os.path.join(self.dir, "cmd.json"))
        self.boot["tick"]()
        return self.read("res-%d.json" % cmd["id"])

    def test_register_says_hello_and_installs_nothing(self):
        self.assertTrue(self.boot["register"]())
        hello = self.read("hello.json")
        self.assertEqual(hello["version"], 1)
        self.assertEqual(hello["pid"], os.getpid())
        self.assertTrue(bpy.app.timers.is_registered(self.boot["tick"]))
        self.assertEqual(sorted(bpy.context.preferences.addons.keys()), self.addons)

    def test_without_a_channel_it_does_nothing(self):
        os.environ.pop("VEISTRA_BLENDER_CHANNEL")
        quiet = runpy.run_path(BOOT, run_name="veistra_boot")
        self.assertFalse(quiet["register"]())
        self.assertFalse(bpy.app.timers.is_registered(quiet["tick"]))

    def test_state_names_the_file_and_the_selection(self):
        self.boot["tick"]()
        state = self.read("state.json")
        self.assertTrue(state["file"].endswith("bed.blend"))
        # The bpy module calls every file dirty, even one just opened.
        self.assertIsInstance(state["dirty"], bool)
        # The bpy module keeps a window with a 3D view; `blender -b` has none.
        if state["view"] is not None:
            self.assertEqual(len(state["view"]["matrix"]), 4)
        self.assertEqual(state["selected"], [{"name": "Pillow", "type": "MESH"}])

    def test_select_selects_by_name_and_state_follows(self):
        res = self.send({"id": 1, "action": "select", "names": ["Frame"]})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["active"], "Frame")
        self.assertEqual(self.read("state.json")["selected"], [{"name": "Frame", "type": "MESH"}])

    def test_each_command_is_answered_once(self):
        self.send({"id": 2, "action": "select", "names": ["Frame"]})
        os.remove(os.path.join(self.dir, "res-2.json"))
        self.boot["tick"]()
        self.assertFalse(os.path.exists(os.path.join(self.dir, "res-2.json")))

    def test_a_refused_command_is_an_answer_not_a_crash(self):
        missing = self.send({"id": 3, "action": "select", "names": ["Ghost"]})
        self.assertFalse(missing["ok"])
        self.assertIn("Ghost", missing["error"])
        unknown = self.send({"id": 4, "action": "delete-everything"})
        self.assertFalse(unknown["ok"])
        # Headless there is nothing to take a picture of, one way or another.
        headless = self.send({"id": 5, "action": "capture"})
        self.assertFalse(headless["ok"])
        self.assertTrue(headless["error"])


if __name__ == "__main__":
    # Blender's own argv carries its flags; unittest must not read them.
    outcome = unittest.main(argv=[sys.argv[0]], exit=False).result
    sys.exit(0 if outcome.wasSuccessful() else 1)
