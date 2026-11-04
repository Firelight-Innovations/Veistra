# The embed spike's reporter for Blender (#308, src-tauri/src/godot/spike.rs).
# Run as:
#
#   blender --factory-startup --python blender_reporter.py
#
# It appends one JSON line per event to input.jsonl in VEISTRA_SPIKE_OUT, as
# the Godot reporters do: the main window's size when it changes, and every key
# and mouse button pressed in it. The listener is a modal operator that passes
# every event on, so Blender behaves as it always does, and nothing is
# installed into the user's Blender. Without VEISTRA_SPIKE_OUT it does nothing.
#
# Blender has no window yet while --python scripts run, so a timer starts the
# listener once the window manager has one, and then keeps reading its size.

import json
import os
import time

import bpy

OUT = os.environ.get("VEISTRA_SPIKE_OUT", "")
EVERY = 0.1
BUTTONS = {"LEFTMOUSE", "MIDDLEMOUSE", "RIGHTMOUSE"}
NOT_KEYS = ("MOUSE", "INBETWEEN", "WHEEL", "TRACKPAD", "NDOF", "TIMER", "WINDOW", "EVT_", "ACTIONZONE")

state = {"listening": False, "size": None}


def write(entry):
    if not OUT:
        return
    entry["ms"] = time.time() * 1000.0
    with open(os.path.join(OUT, "input.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def describe(event_type, value, x, y):
    """The line for one event, or None for one the spike does not log."""
    if value != "PRESS":
        return None
    if event_type in BUTTONS:
        return {"kind": "click", "at": [x, y], "button": event_type}
    if event_type.startswith(NOT_KEYS) or event_type.endswith("MOUSE"):
        return None
    return {"kind": "key", "key": event_type}


class SPIKE_OT_listen(bpy.types.Operator):
    """Logs the presses the main window receives and passes every event on."""

    bl_idname = "wm.veistra_spike_listen"
    bl_label = "Veistra embed spike listener"

    def invoke(self, context, event):
        context.window_manager.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def modal(self, context, event):
        entry = describe(event.type, event.value, event.mouse_x, event.mouse_y)
        if entry:
            write(entry)
        return {"PASS_THROUGH"}


def tick():
    # A background Blender has a window manager with one 0 x 0 window and no
    # events, so there is nothing to listen to.
    if not OUT or bpy.app.background:
        return None
    windows = bpy.context.window_manager.windows
    if not windows or windows[0].width == 0:
        return 0.5
    window = windows[0]
    if not state["listening"]:
        try:
            with bpy.context.temp_override(window=window):
                started = bpy.ops.wm.veistra_spike_listen("INVOKE_DEFAULT")
        except RuntimeError:
            started = set()
        if "RUNNING_MODAL" not in started:
            return 0.5
        state["listening"] = True
        write({"kind": "ready", "size": [window.width, window.height]})
    size = [window.width, window.height]
    if size != state["size"]:
        state["size"] = size
        write({"kind": "size", "size": size})
    return EVERY


if OUT:
    bpy.utils.register_class(SPIKE_OT_listen)
    bpy.app.timers.register(tick, first_interval=0.5)
