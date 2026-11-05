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
#   notes.json        from Veistra, replaced whole: the notes on this file's
#                     parts and the answers to the tab's presses (#320)
#   events.jsonl      appended here, one line a press of the Veistra tab
#   ask-<n>.png       the viewport an Ask the agent line names
#   mention-<n>.png   the viewport a Mention in agent line names
#
# Commands: select (objects by name), viewport-only (maximise the 3D view, as
# Ctrl Space does), capture (a picture of the 3D view, with the view it shows
# and the selection), pick (the object under a point of that picture) and quit
# (Blender's own quit, which asks to save first). The last three read or ask;
# none edits the scene. A command is a function in COMMANDS taking the command
# and returning the fields of its answer; add one there.
#
# The Veistra tab (#320) is a panel in the 3D view's sidebar (N): the notes
# on the selected objects, Looks good and Still broken on a fixed one, Ask the
# agent and Mark up the viewport. It is registered only with a channel, keeps
# what is typed into it on the window manager, which is never saved in the
# file, and its operators make no undo step and add no datablock.
#
# Mention in agent (v3) puts the selected objects, the file or the viewport
# in the agent tab's prompt as one chip, nothing typed: from the tab, from
# the Outliner's and the 3D view's right-click menus, and on Ctrl+Alt+M. Its
# keys go in the session's add-on keymap, which Blender never saves.
#
# Everything runs on Blender's main thread from a persistent bpy.app.timers
# callback, which survives File > Open; every failure is caught, since a
# timer that raises is unregistered for good.

import json
import os
import struct
import textwrap
import time
import zlib

import bpy

VERSION = 3
CHANNEL = os.environ.get("VEISTRA_BLENDER_CHANNEL", "")
POLL_SECONDS = 0.25
# Veistra refuses a longer question (editor_notes.rs MAX_TEXT).
MAX_TEXT = 4000
# The long side of an Ask's picture, so it stays one small context item.
MAX_SIDE = 1600
# The agent tab's @ menu lists this many of the view layer's objects at most.
MAX_OBJECTS = 400

_last_id = None
_last_state = None
_tab = {"text": None, "notes": [], "problem": None, "status": "", "pending": {}, "last_n": 0}


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
        "objects": [{"name": o.name, "type": o.type}
                    for o in list(view_layer().objects)[:MAX_OBJECTS]],
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
    reply = {"png": name, "width": area.width, "height": area.height, "view": view_of(found)}
    # Read at the same moment as the picture, so Send selection never pairs
    # one selection with another moment's view.
    reply.update(selection())
    return reply


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


# --- the Veistra tab (#320) -----------------------------------------------------


def read_notes():
    """Take in notes.json when its text changed; True when it did. The acks
    in it answer the presses still waiting."""
    try:
        with open(_path("notes.json"), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return False
    if not text or text == _tab["text"]:
        return False
    try:
        data = json.loads(text)
    except ValueError:
        return False
    if not isinstance(data, dict):
        return False
    _tab["text"] = text
    notes = data.get("notes")
    _tab["notes"] = [n for n in notes if isinstance(n, dict)] if isinstance(notes, list) else []
    _tab["problem"] = data.get("problem") if isinstance(data.get("problem"), str) else None
    for ack in data.get("acks") or []:
        if isinstance(ack, dict) and ack.get("n") in _tab["pending"]:
            what = _tab["pending"].pop(ack["n"])
            message = ack.get("message") or ""
            if ack.get("ok"):
                _tab["status"] = message or what + ": done."
            else:
                _tab["status"] = "%s did not go through: %s" % (what, message or "no reason given")
    return True


def notes_for(names):
    """The notes on any of these objects. Veistra has already kept only the
    open file's notes, and only notes on a part, which is an object's name in
    the exported model; Play's notes have no place here (X12)."""
    return [n for n in _tab["notes"] if n.get("kind") == "mesh" and n.get("part") in names]


def next_n():
    """Rising, and wall-clock milliseconds where it can be, so a restarted
    Blender does not reuse a number an earlier one sent."""
    _tab["last_n"] = max(_tab["last_n"] + 1, now_ms())
    return _tab["last_n"]


def send(event, what, n=None):
    """One line on the end of events.jsonl, which only ever grows, so Veistra
    reads it from where it stopped. The press then waits for its ack."""
    event = dict(event, n=n or next_n(), t=now_ms())
    with open(_path("events.jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")
    _tab["pending"][event["n"]] = what
    _tab["status"] = "Sent to Veistra; waiting for it to answer."
    return event


def png_bytes(width, height, rows):
    """A PNG of 8-bit RGBA rows, top row first, made in plain Python, so the
    picture never becomes an image datablock in the file."""
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    head = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head)
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _draw_view(found, path):
    """The 3D view as it shades, without the sidebar or the header, drawn
    off screen at no more than MAX_SIDE on its long side."""
    import gpu

    _win, area, region, r3d = found
    scale = min(1.0, MAX_SIDE / max(region.width, region.height, 1))
    w, h = max(1, int(region.width * scale)), max(1, int(region.height * scale))
    offscreen = gpu.types.GPUOffScreen(w, h)
    try:
        offscreen.draw_view3d(bpy.context.scene, view_layer(), area.spaces.active, region,
                              r3d.view_matrix, r3d.window_matrix, do_color_management=True)
        with offscreen.bind():
            pixels = gpu.state.active_framebuffer_get().read_color(0, 0, w, h, 4, 0, "UBYTE")
    finally:
        offscreen.free()
    try:
        data = memoryview(pixels).tobytes()
    except TypeError:  # a Buffer without the buffer protocol
        data = bytes(v for row in pixels.to_list() for px in row for v in px)
    stride = w * 4
    rows = [data[y * stride:(y + 1) * stride] for y in range(h - 1, -1, -1)]
    with open(path, "wb") as fh:
        fh.write(png_bytes(w, h, rows))


def ask_picture(n):
    """ask-<n>.png of the 3D view, or None when there is none to take."""
    return view_picture("ask-%d.png" % n)


def mention_picture(n):
    """mention-<n>.png of the 3D view, or None when there is none to take."""
    return view_picture("mention-%d.png" % n)


def view_picture(name):
    """The 3D view under `name` in the channel: drawn off screen, else
    Blender's screenshot of the area (sidebar and all). None without one."""
    found = view3d()
    if found is None:
        return None
    try:
        _draw_view(found, _path(name))
        return name
    except Exception as exc:  # no GPU here, or an older Blender
        print("veistra: drawing the view off screen failed (%s); taking a screenshot" % exc)
    try:
        with _override(found):
            bpy.ops.screen.screenshot_area(filepath=_path(name))
        return name if os.path.exists(_path(name)) else None
    except Exception as exc:
        print("veistra: no picture for the ask: %s" % exc)
        return None


def _redraw():
    wm = bpy.context.window_manager
    for win in (wm.windows if wm is not None else []):
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


class VeistraTabProps(bpy.types.PropertyGroup):
    question: bpy.props.StringProperty(
        name="Question", description="What to ask the agent about the selection",
        maxlen=MAX_TEXT)
    reply: bpy.props.StringProperty(
        name="Reply", description="What is still wrong (optional)", maxlen=MAX_TEXT)


class VEISTRA_OT_verdict(bpy.types.Operator):
    """Say whether the agent's fix to this note works"""
    bl_idname = "veistra.verdict"
    bl_label = "Verdict"
    bl_options = {"INTERNAL"}

    note: bpy.props.StringProperty(options={"HIDDEN", "SKIP_SAVE"})
    good: bpy.props.BoolProperty(options={"HIDDEN", "SKIP_SAVE"})

    def execute(self, context):
        props = context.window_manager.veistra
        event = {"kind": "verdict", "id": self.note, "verdict": "good" if self.good else "broken"}
        if props.reply.strip():
            event["reply"] = props.reply.strip()
        send(event, "Looks good" if self.good else "Still broken")
        props.reply = ""
        _redraw()
        return {"FINISHED"}


class VEISTRA_OT_ask(bpy.types.Operator):
    """Send the question, the selected objects and the 3D view to the agent, as one message"""
    bl_idname = "veistra.ask"
    bl_label = "Ask the agent"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, context):
        return bool(context.window_manager.veistra.question.strip())

    def execute(self, context):
        props = context.window_manager.veistra
        text = props.question.strip()
        if len(text) > MAX_TEXT:
            self.report({"ERROR"}, "The question is longer than %d characters" % MAX_TEXT)
            return {"CANCELLED"}
        n = next_n()
        found = view3d()
        view = view_of(found) if found is not None else None
        event = {
            "kind": "ask",
            "text": text,
            "scene": bpy.data.filepath or None,
            "nodes": [o["name"] for o in selection()["selected"]],
            "camera": view["camera"] if view else None,
        }
        # The picture first, under the name the line gives, so Veistra finds
        # it whole when it reads the line.
        png = ask_picture(n)
        if png:
            event["png"] = png
        send(event, "Ask the agent", n)
        props.question = ""
        _redraw()
        return {"FINISHED"}


class VEISTRA_OT_markup(bpy.types.Operator):
    """Open Mark up on this view in Veistra"""
    bl_idname = "veistra.markup"
    bl_label = "Mark up the viewport"
    bl_options = {"INTERNAL"}

    def execute(self, context):
        send({"kind": "markup"}, "Mark up")
        _redraw()
        return {"FINISHED"}


MENTIONS = (
    ("AUTO", "Mention to Veistra agent", "The selected objects, else the file"),
    ("SELECTION", "Selected objects", "The selected objects, as one chip"),
    ("SCENE", "This file", "The open .blend, as one chip"),
    ("VIEWPORT", "Viewport", "A picture of the 3D view, as one chip"),
)


def mention_event(what, n):
    """The line Mention in agent sends, or a Refused saying what is missing.
    AUTO is the selection when there is one, else the file."""
    names = [o["name"] for o in selection()["selected"]]
    if what == "AUTO":
        what = "SELECTION" if names else "SCENE"
    event = {"kind": "mention", "what": what.lower(), "scene": bpy.data.filepath or None}
    if what == "SELECTION":
        if not names:
            raise Refused("Select an object to mention first.")
        event["nodes"] = names
    elif what == "SCENE":
        if not bpy.data.filepath:
            raise Refused("Save the file first; Veistra mentions it by its path.")
    elif what == "VIEWPORT":
        png = mention_picture(n)
        if not png:
            raise Refused("No 3D view is open to take a picture of.")
        event["png"] = png
    return event


class VEISTRA_OT_mention(bpy.types.Operator):
    """Mention this to Veistra agent"""
    bl_idname = "veistra.mention"
    bl_label = "Mention to Veistra agent"
    bl_options = {"INTERNAL"}

    what: bpy.props.EnumProperty(items=MENTIONS, default="AUTO", options={"SKIP_SAVE"})

    def execute(self, context):
        n = next_n()
        try:
            event = mention_event(self.what, n)
        except Refused as exc:
            self.report({"WARNING"}, str(exc))
            _tab["status"] = str(exc)
            _redraw()
            return {"CANCELLED"}
        send(event, "Mention to Veistra agent", n)
        _tab["status"] = "Sent to Veistra; the chip goes in the agent's prompt."
        _redraw()
        return {"FINISHED"}


def _mention_menu(self, _context):
    """Appended to the Outliner's and the 3D view's right-click menus."""
    self.layout.separator()
    self.layout.operator("veistra.mention", text="Mention to Veistra agent").what = "SELECTION"


# Each is looked up by name: a Blender without one of them still gets the rest.
MENTION_MENUS = ("OUTLINER_MT_object", "OUTLINER_MT_context_menu",
                 "VIEW3D_MT_object_context_menu")
_keymaps = []


def register_mentions():
    for name in MENTION_MENUS:
        menu = getattr(bpy.types, name, None)
        if menu is not None:
            menu.append(_mention_menu)
    keyconfig = bpy.context.window_manager.keyconfigs.addon
    if keyconfig is None:  # in the background there is no keymap to add to
        return
    for name, space in (("3D View", "VIEW_3D"), ("Outliner", "OUTLINER")):
        km = keyconfig.keymaps.new(name=name, space_type=space)
        item = km.keymap_items.new("veistra.mention", "M", "PRESS", ctrl=True, alt=True)
        item.properties.what = "AUTO"
        _keymaps.append((km, item))


def unregister_mentions():
    for name in MENTION_MENUS:
        menu = getattr(bpy.types, name, None)
        if menu is not None:
            menu.remove(_mention_menu)
    for km, item in _keymaps:
        km.keymap_items.remove(item)
    _keymaps.clear()


def _lines(layout, text, width):
    for para in str(text).splitlines() or [""]:
        for line in textwrap.wrap(para, width) or [""]:
            layout.label(text=line)


class VEISTRA_PT_notes(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Veistra"
    bl_label = "Veistra"

    def draw(self, context):
        layout = self.layout
        props = context.window_manager.veistra
        width = max(20, int(getattr(context.region, "width", 280) / 7))
        names = [o.name for o in (getattr(context, "selected_objects", None) or [])]
        shown = notes_for(names)
        if not names:
            layout.label(text="Select an object to see its notes.")
        elif not shown:
            layout.label(text="No notes on %s." % ", ".join(names))
        else:
            count = "1 note" if len(shown) == 1 else "%d notes" % len(shown)
            layout.label(text="%s on %s" % (count, ", ".join(names)))
        if _tab["problem"]:
            _lines(layout, "Veistra could not read the notes: " + _tab["problem"], width)
        waiting = set(_tab["pending"].values())
        for note in shown:
            box = layout.box()
            box.label(text="%s: %s - %s" % (note.get("part"), note.get("title") or "Note",
                                            note.get("label", "")))
            _lines(box, note.get("body", ""), width)
            for reply in note.get("replies") or []:
                _lines(box, "%s: %s" % (reply.get("by", ""), reply.get("body", "")), width)
            fix = note.get("fix") or {}
            if fix.get("note"):
                _lines(box, "Fix: " + fix["note"], width)
            if note.get("status") == "fixed":
                box.prop(props, "reply", text="")
                row = box.row()
                row.enabled = not (waiting & {"Looks good", "Still broken"})
                good = row.operator("veistra.verdict", text="Looks good")
                good.note, good.good = note.get("id", ""), True
                broken = row.operator("veistra.verdict", text="Still broken")
                broken.note, broken.good = note.get("id", ""), False
        layout.separator()
        layout.prop(props, "question", text="")
        layout.operator("veistra.ask", text="Ask the agent")
        layout.operator("veistra.markup", text="Mark up the viewport")
        layout.label(text="Mention to Veistra agent (Ctrl+Alt+M)")
        row = layout.row(align=True)
        for what, text in (("SELECTION", "Selection"), ("SCENE", "File"),
                           ("VIEWPORT", "Viewport")):
            row.operator("veistra.mention", text=text).what = what
        if _tab["status"]:
            _lines(layout, _tab["status"], width)


CLASSES = (VeistraTabProps, VEISTRA_OT_verdict, VEISTRA_OT_ask, VEISTRA_OT_markup,
           VEISTRA_OT_mention, VEISTRA_PT_notes)


def register_tab():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.WindowManager.veistra = bpy.props.PointerProperty(type=VeistraTabProps)
    register_mentions()


def unregister_tab():
    unregister_mentions()
    if hasattr(bpy.types.WindowManager, "veistra"):
        del bpy.types.WindowManager.veistra
    for cls in reversed(CLASSES):
        if getattr(cls, "is_registered", False):
            bpy.utils.unregister_class(cls)


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
        if read_notes():
            _redraw()
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
    register_tab()
    return True


def unregister():
    unregister_tab()
    for handlers in (bpy.app.handlers.load_post, bpy.app.handlers.save_post):
        if _changed in handlers:
            handlers.remove(_changed)
    if bpy.app.timers.is_registered(tick):
        bpy.app.timers.unregister(tick)


if __name__ == "__main__":
    register()
