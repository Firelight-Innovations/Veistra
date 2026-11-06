/**
 * Structure checks for the Veistra editor plugin,
 * `src-tauri/src/godot/veistra_editor.gd` (#316). No Godot runs in CI, so
 * these pin the editor API each command goes through, as
 * `play/capture.gd.test.ts` does for the capture addon. What the editor then
 * does rests on the API facts the script's comments name; these only stop
 * the mechanism from quietly going away.
 */
import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the app tsconfig carries no Node types.
import script from "../../../../../src-tauri/src/godot/veistra_editor.gd?raw";

/** One function, from its `func` line to the next line that starts at column zero. */
function fn(name: string): string {
  const start = script.indexOf(`\nfunc ${name}(`);
  expect(start, `func ${name} is missing`).toBeGreaterThanOrEqual(0);
  const rest = script.slice(start + 1);
  const end = rest.search(/\n(?=\S)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Without its comment lines, which name the calls the code avoids. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("the Veistra editor plugin", () => {
  it("is an editor plugin, and says its version on the first line for the installer", () => {
    expect(script.split("\n")[0]).toBe("# veistra-editor v4");
    expect(code(script)).toMatch(/^@tool\nextends EditorPlugin$/m);
  });

  // Godot's own Restart editor drops the arguments; the environment survives.
  it("finds its channel from the argument, then the environment, and is idle without one", () => {
    const body = fn("_enter_tree");
    expect(body).toContain("OS.get_cmdline_user_args()");
    expect(script).toContain('const DIR_ARG := "--veistra-editor-dir="');
    expect(script).toContain('const DIR_ENV := "VEISTRA_EDITOR_DIR"');
    expect(body).toContain("OS.get_environment(DIR_ENV)");
    expect(body.indexOf("get_cmdline_user_args")).toBeLessThan(body.indexOf("get_environment"));
    expect(body).toMatch(/_dir = ""\s+set_process\(false\)\s+return/);
    expect(body).toContain('_write("hello.json"');
  });

  it("never opens a socket: the whole channel is files in one folder", () => {
    expect(code(script)).not.toMatch(/TCPServer|UDPServer|HTTPRequest|HTTPClient|WebSocket/);
    expect(code(script)).not.toMatch(/PacketPeer|StreamPeer|ENet|MultiplayerPeer/);
  });

  it("writes beside and renames into place, so Veistra never reads half a file", () => {
    const body = fn("_write_text");
    expect(body).toContain('file_name + ".tmp"');
    expect(body).toContain("DirAccess.rename_absolute(tmp,");
  });

  it("reports the selection, the scene and whether only the viewport shows", () => {
    const body = fn("_state");
    expect(body).toContain("EditorInterface.get_selection().get_selected_nodes()");
    expect(body).toContain("scene_file_path");
    expect(body).toContain("EditorInterface.get_open_scenes()");
    expect(body).toContain("EditorInterface.distraction_free_mode");
  });

  it("captures the 3D viewport, not the editor around it, unless asked for the window", () => {
    const body = fn("_capture");
    expect(body).toContain("EditorInterface.get_editor_viewport_3d(0).get_texture().get_image()");
    expect(body).toContain("get_tree().root.get_texture().get_image()");
    expect(body).toContain('"camera": _camera()');
    expect(fn("_camera")).toContain("get_editor_viewport_3d(0).get_camera_3d()");
  });

  it("takes the three commands, and Send selection reads both in one answer", () => {
    const poll = fn("_poll_command");
    expect(poll).toMatch(/"selection":\s+result = _capture\(id, "viewport"\)\s+result\.merge/);
    expect(fn("_select")).toContain("selection.add_node(node)");
    expect(fn("_open")).toContain("EditorInterface.open_scene_from_path(scene)");
    expect(fn("_open")).toContain('scene.begins_with("res://")');
    expect(poll).toContain("EditorInterface.distraction_free_mode = on");
  });

  // v3: a chip clicked in the agent tab opens its script or resource here,
  // and the agent tab's @ menu lists the scene's nodes from the state.
  it("opens a script or resource for edit, and lists the edited scene's nodes", () => {
    expect(fn("_poll_command")).toMatch(/"edit":\s+result = _edit\(id,/);
    const edit = fn("_edit");
    expect(edit).toContain("EditorInterface.edit_script(");
    expect(edit).toContain("EditorInterface.edit_resource(");
    expect(edit).toContain('begins_with("res://")');
    expect(fn("_state")).toContain('"nodes": _scene_nodes(root)');
    expect(fn("_scene_nodes")).toContain("MAX_NODES");
  });

  // Spec §13 test 10: Close asks Godot to save first, as its close button does.
  // The one quit with no prompt is `quit`, sent only for a cluster the person
  // closed with Close after Veistra asked; it is never killed.
  it("closes the way the window's close button does, and quits outright only on quit", () => {
    const poll = fn("_poll_command");
    expect(poll).toMatch(
      /"close":\s+(#[^\n]*\s+)*get_tree\(\)\.root\.propagate_notification\(NOTIFICATION_WM_CLOSE_REQUEST\)/,
    );
    expect(poll).toMatch(/"quit":\s+(#[^\n]*\s+)*get_tree\(\)\.quit\(\)/);
    expect(code(script).match(/\.quit\(/g)).toHaveLength(1);
    expect(code(script)).not.toMatch(/OS\.kill/);
  });

  it("picks as the editor does: the renderer's ray, then each mesh's faces", () => {
    const body = fn("_pick");
    expect(body).toContain("RenderingServer.instances_cull_ray(from, to,");
    expect(body).toContain("_capture_size");
    expect(body).toContain('"source": "editor"');
    expect(fn("_hit_point")).toContain("Geometry3D.segment_intersects_triangle(");
    // No physics: the editor does not step the physics server.
    expect(code(body)).not.toMatch(/intersect_ray|PhysicsRayQueryParameters3D/);
  });

  // The editor holds its window at 1024x600; a smaller pane would cut it off.
  it("lowers the window's floor once the editor has set its own", () => {
    expect(fn("_enter_tree")).toContain("_lower_min_size.call_deferred()");
    expect(fn("_lower_min_size")).toContain("DisplayServer.window_set_min_size(MIN_SIZE,");
  });
});
