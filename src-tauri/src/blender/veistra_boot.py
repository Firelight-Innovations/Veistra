# Veistra's boot script for Blender in a pane (spec §11.2, DECISIONS X5).
# Veistra starts the person's own Blender as
#
#   blender <file.blend> --python veistra_boot.py
#
# with VEISTRA_BLENDER_CHANNEL naming a temporary folder. Nothing is installed
# into Blender: no add-on is enabled, no preference is read or written, and
# without that variable this script does nothing at all, so the same Blender
# opened any other way never sees it.
#
# The channel is the folder protocol the Godot capture addon uses:
#   hello.json        written once: {version, pid, blender}
#   state.json        rewritten when it changes: the open file, whether it has
#                     unsaved changes, the selected objects and the 3D view
#   cmd.json          from Veistra, renamed into place: {id, action, ...}
#   res-<id>.json     the answer, written to a .tmp and renamed
#   cap-<id>.png      a capture's picture
# Two more names are kept for #320 (the Veistra tab in the N-panel):
# events.jsonl from here to Veistra, notes.json from Veistra to here.
#
# Commands: select (objects by name), viewport-only (maximise the 3D view, as
# Ctrl Space does), capture (a picture of the 3D view and the view it shows),
# pick (the object under a point of that picture) and quit (Blender's own
# quit, which asks to save first). The last three read or ask; none edits the
# scene. A command is a function in COMMANDS taking the command and returning
# the fields of its answer; add one there.
#
# Everything runs on Blender's main thread from a persistent bpy.app.timers
# callback, which survives File > Open; every failure is caught, since a
# timer that raises is unregistered for good.

import json
import os
import time

import bpy

VERSION = 1
CHANNEL = os.environ.get("VEISTRA_BLENDER_CHANNEL", "")
POLL_SECONDS = 0.25

_last_id = None
_last_state = None


def _path(name):
    return os.path.join(CHANNEL, name)


def write_json(name, value):
    """Write a channel file whole: a .tmp beside it, then a rename, so a
    reader never sees half of one."""
    target = _path(name)
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh)
    os.replace(tmp, target)


def now_ms():
    return int(time.time() * 1000)


# --- what Blender shows --------------------------------------------------------


def _window():
    wm = bpy.context.window_manager
    return wm.windows[0] if wm is not None and len(wm.windows) else None


def view_layer():
    win = _window()
    return win.view_layer if win is not None else bpy.context.view_layer


def view3d():
    """(window, area, WINDOW region, region_3d) of the largest 3D view, or
    None in background mode or when no 3D view is open."""
    wm = bpy.context.window_manager
    best = None
    for win in (wm.windows if wm is not None else []):
        for area in win.screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next((r for r in area.regions if r.type == "WINDOW"), None)
            if region is None:
                continue
            size = area.width * area.height
            if best is None or size > best[0]:
                best = (size, win, area, region, area.spaces.active.region_3d)
    return best[1:] if best else None


def _rows(matrix):
    return [[round(v, 6) for v in row] for row in matrix]


def view_of(found):
    """The 3D view as markup and pins need it: both matrices, the region's
    place inside its area (a capture is of the area), and a camera."""
    if found is None:
        return None
    _win, area, region, r3d = found
    inverse = r3d.view_matrix.inverted()
    pos = inverse.translation
    camera = {
        "pos": [round(v, 6) for v in pos],
        "target": [round(v, 6) for v in r3d.view_location],
        "up": [round(v, 6) for v in inverse.col[1][:3]],
    }
    if r3d.view_perspective != "ORTHO" and r3d.window_matrix[1][1] != 0:
        import math

        camera["fov"] = round(math.degrees(2 * math.atan(1 / r3d.window_matrix[1][1])), 4)
    return {
        "matrix": _rows(r3d.view_matrix),
        "window": _rows(r3d.window_matrix),
        "perspective": r3d.view_perspective,
        "distance": round(r3d.view_distance, 6),
        "area": {"w": area.width, "h": area.height},
        "region": {
            "x": region.x - area.x,
            "y": region.y - area.y,
            "w": region.width,
            "h": region.height,
        },
        "camera": camera,
    }


def selection():
    vl = view_layer()
    active = vl.objects.active
    return {
        "selected": [{"name": o.name, "type": o.type} for o in vl.objects.selected],
        "active": active.name if active is not None else None,
    }


def state():
    win = _window()
    value = {
        "file": bpy.data.filepath,
        "dirty": bool(bpy.data.is_dirty),
        "view": view_of(view3d()),
        "fullscreen": bool(win.screen.show_fullscreen) if win is not None else False,
    }
    value.update(selection())
    return value


# --- commands ------------------------------------------------------------------


class Refused(Exception):
    """A command that cannot be done here; its text is the answer's error."""


def cmd_select(cmd):
    names = cmd.get("names")
    if not isinstance(names, list):
        raise Refused("select needs names, a list of object names")
    vl = view_layer()
    wanted = [n for n in names if isinstance(n, str)]
    missing = [n for n in wanted if vl.objects.get(n) is None]
    if missing:
        raise Refused("no object called %s in this view layer" % ", ".join(missing))
    for obj in vl.objects:
        obj.select_set(obj.name in wanted, view_layer=vl)
    if wanted:
        vl.objects.active = vl.objects[wanted[0]]
    return selection()


def _override(found):
    win, area, region, _r3d = found
    return bpy.context.temp_override(window=win, screen=win.screen, area=area, region=region)


def _need_view():
    found = view3d()
    if found is None:
        raise Refused("no 3D view is open in Blender")
    return found


def cmd_viewport_only(cmd):
    on = bool(cmd.get("on", True))
    win = _window()
    if win is None:
        raise Refused("Blender has no window here")
    if bool(win.screen.show_fullscreen) != on:
        with _override(_need_view()):
            bpy.ops.screen.screen_full_area(use_hide_panels=False)
    return {"fullscreen": bool(_window().screen.show_fullscreen)}


def cmd_capture(cmd):
    found = _need_view()
    name = "cap-%d.png" % int(cmd["id"])
    with _override(found):
        bpy.ops.screen.screenshot_area(filepath=_path(name))
    _win, area, _region, _r3d = found
    return {"png": name, "width": area.width, "height": area.height, "view": view_of(found)}


def cmd_pick(cmd):
    """The object under (x, y), in pixels of a capture of the 3D view's area
    from its top left, by a ray from the view into the scene."""
    from bpy_extras import view3d_utils

    found = _need_view()
    _win, area, region, r3d = found
    try:
        x, y = float(cmd["x"]), float(cmd["y"])
    except (KeyError, TypeError, ValueError):
        raise Refused("pick needs x and y")
    point = (x - (region.x - area.x), (area.height - y) - (region.y - area.y))
    if not (0 <= point[0] <= region.width and 0 <= point[1] <= region.height):
        return {"hit": None}
    origin = view3d_utils.region_2d_to_origin_3d(region, r3d, point)
    direction = view3d_utils.region_2d_to_vector_3d(region, r3d, point)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    hit, location, _normal, _index, obj, _matrix = bpy.context.scene.ray_cast(
        depsgraph, origin, direction
    )
    if not hit or obj is None:
        return {"hit": None}
    return {"hit": {"object": obj.name, "type": obj.type,
                    "worldPoint": [round(v, 6) for v in location]}}


def cmd_quit(_cmd):
    win = _window()
    if win is None:
        raise Refused("Blender has no window here")

    def ask():
        # INVOKE_DEFAULT: Blender's own quit, with its "save changes?" prompt.
        with bpy.context.temp_override(window=win):
            bpy.ops.wm.quit_blender("INVOKE_DEFAULT")

    # After this answer is written, so Veistra reads it before Blender asks.
    bpy.app.timers.register(ask, first_interval=0.05)
    return {"quitting": True}


COMMANDS = {
    "select": cmd_select,
    "viewport-only": cmd_viewport_only,
    "capture": cmd_capture,
    "pick": cmd_pick,
    "quit": cmd_quit,
}


def answer(cmd):
    """Run one command and say how it went, never raising."""
    reply = {"id": cmd.get("id"), "ok": True, "t": now_ms()}
    run = COMMANDS.get(cmd.get("action"))
    try:
        if run is None:
            raise Refused("unknown action %r" % cmd.get("action"))
        reply.update(run(cmd))
    except Refused as exc:
        reply.update(ok=False, error=str(exc))
    except Exception as exc:  # a Blender operator refusing its context, say
        reply.update(ok=False, error="%s: %s" % (type(exc).__name__, exc))
    return reply


# --- the loop ------------------------------------------------------------------


def poll_command():
    """Answer cmd.json once per id. A command Veistra gave up on is answered
    anyway; nothing waits for it."""
    global _last_id
    try:
        with open(_path("cmd.json"), encoding="utf-8") as fh:
            cmd = json.load(fh)
    except (OSError, ValueError):
        return
    if not isinstance(cmd, dict) or not isinstance(cmd.get("id"), int):
        return
    if cmd["id"] == _last_id:
        return
    _last_id = cmd["id"]
    write_json("res-%d.json" % cmd["id"], answer(cmd))


def write_state():
    global _last_state
    value = state()
    if value != _last_state:
        _last_state = value
        write_json("state.json", dict(value, t=now_ms()))


def tick():
    try:
        poll_command()
        write_state()
    except Exception as exc:  # pragma: no cover - reported, never raised
        print("veistra: %s" % exc)
    return POLL_SECONDS


@bpy.app.handlers.persistent
def _changed(_arg=None, _more=None):
    """A file was opened or saved: say so on the next tick."""
    global _last_state
    _last_state = None


def register():
    if not CHANNEL:
        return False
    os.makedirs(CHANNEL, exist_ok=True)
    write_json("hello.json", {
        "version": VERSION,
        "pid": os.getpid(),
        "blender": bpy.app.version_string,
    })
    for handlers in (bpy.app.handlers.load_post, bpy.app.handlers.save_post):
        if _changed not in handlers:
            handlers.append(_changed)
    if not bpy.app.timers.is_registered(tick):
        bpy.app.timers.register(tick, first_interval=POLL_SECONDS, persistent=True)
    return True


def unregister():
    for handlers in (bpy.app.handlers.load_post, bpy.app.handlers.save_post):
        if _changed in handlers:
            handlers.remove(_changed)
    if bpy.app.timers.is_registered(tick):
        bpy.app.timers.unregister(tick)


if __name__ == "__main__":
    register()
