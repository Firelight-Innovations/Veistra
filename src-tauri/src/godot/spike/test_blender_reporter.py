# Checks the embed spike's Blender reporter under Blender's own Python module.
# Run as:
#
#   python src-tauri/src/godot/spike/test_blender_reporter.py
#
# with a Python that has `bpy` (the `bpy` wheel, headless). Without it every
# test is skipped: CI has no bpy. Headless Blender has no windows, so what a
# real window's events do is left to the Windows run; this holds the parts
# that run anywhere to their contract.

import json
import os
import runpy
import tempfile
import unittest

try:
    import bpy
except ImportError:
    bpy = None

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "blender_reporter.py")


def load(out):
    os.environ["VEISTRA_SPIKE_OUT"] = out
    try:
        return runpy.run_path(SCRIPT, run_name="veistra_spike_reporter")
    finally:
        del os.environ["VEISTRA_SPIKE_OUT"]


def lines(out):
    with open(os.path.join(out, "input.jsonl"), encoding="utf-8") as f:
        return [json.loads(line) for line in f]


@unittest.skipIf(bpy is None, "needs Blender's bpy module")
class BlenderReporterTest(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="veistra-spike-")
        self.module = load(self.out)

    def tearDown(self):
        if bpy.app.timers.is_registered(self.module["tick"]):
            bpy.app.timers.unregister(self.module["tick"])
        bpy.utils.unregister_class(self.module["SPIKE_OT_listen"])

    def test_the_listener_and_its_timer_are_registered(self):
        self.assertTrue(hasattr(bpy.ops.wm, "veistra_spike_listen"))
        self.assertTrue(bpy.app.timers.is_registered(self.module["tick"]))

    def test_in_the_background_the_timer_stops_at_once_and_writes_nothing(self):
        self.assertTrue(bpy.app.background)
        self.assertIsNone(self.module["tick"]())
        self.assertFalse(os.path.exists(os.path.join(self.out, "input.jsonl")))

    def test_presses_are_logged_as_keys_and_clicks_and_the_rest_is_not(self):
        describe = self.module["describe"]
        self.assertEqual(describe("K", "PRESS", 1, 2), {"kind": "key", "key": "K"})
        self.assertEqual(
            describe("LEFTMOUSE", "PRESS", 400, 300),
            {"kind": "click", "at": [400, 300], "button": "LEFTMOUSE"},
        )
        for ignored in [("K", "RELEASE"), ("MOUSEMOVE", "PRESS"), ("WHEELUPMOUSE", "PRESS"), ("TIMER", "PRESS")]:
            self.assertIsNone(describe(ignored[0], ignored[1], 0, 0), ignored)

    def test_the_operator_passes_every_event_on_and_writes_a_line_per_press(self):
        class Event:
            type = "K"
            value = "PRESS"
            mouse_x = 10
            mouse_y = 20

        op = self.module["SPIKE_OT_listen"]
        self.assertEqual(op.modal(None, None, Event()), {"PASS_THROUGH"})
        [line] = lines(self.out)
        self.assertEqual(line["kind"], "key")
        self.assertEqual(line["key"], "K")
        self.assertIn("ms", line)


@unittest.skipIf(bpy is None, "needs Blender's bpy module")
class WithoutTheVariableTest(unittest.TestCase):
    def test_nothing_is_registered(self):
        module = runpy.run_path(SCRIPT, run_name="veistra_spike_reporter_off")
        self.assertFalse(bpy.app.timers.is_registered(module["tick"]))
        self.assertFalse(hasattr(bpy.types, "WM_OT_veistra_spike_listen"))


if __name__ == "__main__":
    unittest.main()
