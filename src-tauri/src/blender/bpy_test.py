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
import types
import unittest
import zlib

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


class Booted(unittest.TestCase):
    """The bed file open and the boot script loaded, not yet registered."""

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


class BootScript(Booted):
    def test_register_says_hello_and_installs_nothing(self):
        self.assertTrue(self.boot["register"]())
        hello = self.read("hello.json")
        self.assertEqual(hello["version"], 2)
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


class Layout:
    """Enough of a UILayout to record what a panel's draw puts in it."""

    def __init__(self, log):
        self.log = log
        self.enabled = True

    def label(self, text="", **_kw):
        self.log.append(("label", text))

    def prop(self, _data, name, **_kw):
        self.log.append(("prop", name))

    def operator(self, idname, text="", **_kw):
        op = types.SimpleNamespace()
        self.log.append(("op", idname, text, op, self))
        return op

    def box(self):
        return self

    def row(self, **_kw):
        return Layout(self.log)

    def separator(self, **_kw):
        pass


NOTES = {
    "version": 1, "rev": 3, "problem": None, "acks": [],
    "notes": [
        {"kind": "mesh", "part": "Frame", "material": "Oak", "title": "Oak",
         "id": "0190000000aa-0001", "status": "fixed", "label": "Fixed, check it",
         "body": "The headboard is too tall", "fix": {"by": "agent", "note": "Lowered it"},
         "replies": [{"by": "agent", "body": "Taken 10 cm off"}]},
        {"kind": "mesh", "part": "Pillow", "material": "none", "title": "none",
         "id": "0190000000aa-0002", "status": "open", "label": "Sent",
         "body": "Too round", "fix": None, "replies": []},
    ],
}


class VeistraTab(Booted):
    """The N-panel tab (#320): registered with the script, drawn from
    notes.json, and its three buttons each append one line Veistra reads."""

    def setUp(self):
        super().setUp()
        self.assertTrue(self.boot["register"]())
        self.wm = bpy.context.window_manager

    def write_notes(self, notes):
        tmp = os.path.join(self.dir, "notes.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(notes, fh)
        os.replace(tmp, os.path.join(self.dir, "notes.json"))
        self.boot["tick"]()

    def events(self):
        path = os.path.join(self.dir, "events.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def draw(self, names):
        log = []
        panel = types.SimpleNamespace(layout=Layout(log))
        objects = [bpy.data.objects[n] for n in names]
        context = types.SimpleNamespace(
            window_manager=self.wm, selected_objects=objects,
            region=types.SimpleNamespace(width=300))
        self.boot["VEISTRA_PT_notes"].draw(panel, context)
        return log

    def labels(self, log):
        return [entry[1] for entry in log if entry[0] == "label"]

    def test_the_tab_is_in_the_3d_views_sidebar_and_goes_with_unregister(self):
        panel = self.boot["VEISTRA_PT_notes"]
        self.assertEqual((panel.bl_space_type, panel.bl_region_type, panel.bl_category),
                         ("VIEW_3D", "UI", "Veistra"))
        self.assertTrue(panel.is_registered)
        for op in ("verdict", "ask", "markup"):
            self.assertTrue(hasattr(bpy.ops.veistra, op))
            # No undo step: a press is not an edit of the file.
            self.assertNotIn("UNDO", self.boot["VEISTRA_OT_" + op].bl_options)
        self.assertTrue(hasattr(bpy.types.WindowManager, "veistra"))
        self.boot["unregister"]()
        self.assertFalse(panel.is_registered)
        self.assertFalse(hasattr(bpy.types.WindowManager, "veistra"))

    def test_without_a_channel_there_is_no_tab(self):
        self.boot["unregister"]()
        os.environ.pop("VEISTRA_BLENDER_CHANNEL")
        quiet = runpy.run_path(BOOT, run_name="veistra_boot")
        self.assertFalse(quiet["register"]())
        self.assertFalse(quiet["VEISTRA_PT_notes"].is_registered)
        self.assertFalse(hasattr(bpy.types.WindowManager, "veistra"))

    def test_the_selected_objects_notes_show_and_a_fixed_one_offers_the_verdicts(self):
        self.write_notes(NOTES)
        log = self.draw(["Frame"])
        labels = self.labels(log)
        self.assertEqual(labels[0], "1 note on Frame")
        self.assertIn("Frame: Oak - Fixed, check it", labels)
        self.assertIn("The headboard is too tall", labels)
        self.assertIn("agent: Taken 10 cm off", labels)
        self.assertIn("Fix: Lowered it", labels)
        verdicts = [e for e in log if e[0] == "op" and e[1] == "veistra.verdict"]
        self.assertEqual([(e[2], e[3].good) for e in verdicts],
                         [("Looks good", True), ("Still broken", False)])
        self.assertEqual(verdicts[0][3].note, "0190000000aa-0001")
        pillow = self.draw(["Pillow"])
        self.assertIn("Too round", self.labels(pillow))
        self.assertNotIn("veistra.verdict", [e[1] for e in pillow if e[0] == "op"])
        self.assertEqual(self.labels(self.draw([]))[0], "Select an object to see its notes.")

    def test_still_broken_sends_one_line_with_the_reply_and_waits_for_its_ack(self):
        self.write_notes(NOTES)
        self.wm.veistra.reply = "still too tall"
        self.assertEqual(bpy.ops.veistra.verdict(note="0190000000aa-0001", good=False),
                         {"FINISHED"})
        [line] = self.events()
        self.assertEqual((line["kind"], line["id"], line["verdict"], line["reply"]),
                         ("verdict", "0190000000aa-0001", "broken", "still too tall"))
        self.assertIsInstance(line["n"], int)
        self.assertIsInstance(line["t"], int)
        self.assertEqual(self.wm.veistra.reply, "")
        row = next(e[4] for e in self.draw(["Frame"]) if e[0] == "op" and e[1] == "veistra.verdict")
        self.assertFalse(row.enabled, "pressed once; not again until Veistra answers")
        answered = dict(NOTES, rev=4, acks=[{"n": line["n"], "ok": True, "message": "Reopened."}])
        self.write_notes(answered)
        self.assertIn("Reopened.", self.labels(self.draw(["Frame"])))
        row = next(e[4] for e in self.draw(["Frame"]) if e[0] == "op" and e[1] == "veistra.verdict")
        self.assertTrue(row.enabled)

    def test_ask_sends_the_question_and_the_selection_in_one_line_and_adds_no_image(self):
        self.send({"id": 1, "action": "select", "names": ["Frame"]})
        images = len(bpy.data.images)
        self.assertFalse(bpy.ops.veistra.ask.poll(), "nothing to ask yet")
        self.wm.veistra.question = "Why is the frame so dark?"
        self.assertEqual(bpy.ops.veistra.ask(), {"FINISHED"})
        [line] = self.events()
        self.assertEqual((line["kind"], line["text"], line["nodes"]),
                         ("ask", "Why is the frame so dark?", ["Frame"]))
        self.assertTrue(line["scene"].endswith("bed.blend"))
        # The bpy module has a 3D view but no GPU, and its screenshot of the
        # area fails; a picture, when there is one, is this ask's own.
        if "png" in line:
            self.assertEqual(line["png"], "ask-%d.png" % line["n"])
            self.assertTrue(os.path.exists(os.path.join(self.dir, line["png"])))
        self.assertEqual(len(bpy.data.images), images)
        self.assertEqual(self.wm.veistra.question, "")

    def test_mark_up_sends_its_line_and_a_refusal_is_shown(self):
        bpy.ops.veistra.markup()
        [line] = self.events()
        self.assertEqual(line["kind"], "markup")
        self.write_notes(dict(NOTES, acks=[{"n": line["n"], "ok": False,
                                            "message": "the Editor mode is not open"}]))
        # Long lines are wrapped to the sidebar's width.
        self.assertIn("Mark up did not go through: the Editor mode is not open",
                      " ".join(self.labels(self.draw([]))))

    def test_numbers_rise_even_within_one_millisecond(self):
        bpy.ops.veistra.markup()
        bpy.ops.veistra.markup()
        first, second = self.events()
        self.assertGreater(second["n"], first["n"])

    def test_the_png_writer_makes_a_picture_blender_reads(self):
        rows = [bytes([255, 0, 0, 255, 0, 255, 0, 255]), bytes([0, 0, 255, 255, 0, 0, 0, 0])]
        path = os.path.join(self.dir, "two.png")
        with open(path, "wb") as fh:
            fh.write(self.boot["png_bytes"](2, 2, rows))
        img = bpy.data.images.load(path)
        try:
            self.assertEqual(tuple(img.size), (2, 2))
            px = img.pixels[:]
            # Blender's rows run bottom up: the top-left red pixel is row 1.
            self.assertAlmostEqual(px[8], 1.0, places=2)
            self.assertAlmostEqual(px[9], 0.0, places=2)
        finally:
            bpy.data.images.remove(img)
        with open(path, "rb") as fh:
            data = fh.read()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(zlib.decompress(data[41:41 + struct.unpack_from(">I", data, 33)[0]])[:1],
                         b"\x00")


if __name__ == "__main__":
    # Blender's own argv carries its flags; unittest must not read them.
    outcome = unittest.main(argv=[sys.argv[0]], exit=False).result
    sys.exit(0 if outcome.wasSuccessful() else 1)
