/**
 * Structure checks for the Veistra dock, `src-tauri/src/godot/veistra_dock.gd`
 * (#320). No Godot runs in CI, so these pin the two files it shares with
 * Veistra (DECISIONS X5) and the editor API it reads the selection through,
 * as `plugin.gd.test.ts` does for the plugin that adds it. The lines it writes
 * are checked against what `src-tauri/src/editor_notes.rs` accepts.
 */
import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the app tsconfig carries no Node types.
import dock from "../../../../../src-tauri/src/godot/veistra_dock.gd?raw";
import plugin from "../../../../../src-tauri/src/godot/veistra_editor.gd?raw";
import notesRs from "../../../../../src-tauri/src/editor_notes.rs?raw";

/** One function, from its `func` line to the next line that starts at column zero. */
function fn(script: string, name: string): string {
  const start = script.search(new RegExp(`\\n(static )?func ${name}\\(`));
  expect(start, `func ${name} is missing`).toBeGreaterThanOrEqual(0);
  const rest = script.slice(start + 1);
  const end = rest.search(/\n(?=\S)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Without its comment lines. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("the Veistra dock", () => {
  it("is a tool control without a global class name, versioned on its first line", () => {
    expect(dock.split("\n")[0]).toBe("# veistra-dock v2");
    expect(code(dock)).toMatch(/^@tool\nextends VBoxContainer$/m);
    expect(code(dock)).not.toMatch(/^class_name/m);
  });

  it("is added only when Veistra started the editor, and taken away with the plugin", () => {
    const enter = fn(plugin, "_enter_tree");
    expect(enter.indexOf("return")).toBeLessThan(enter.indexOf("Dock.new()"));
    expect(enter).toContain("add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)");
    expect(plugin).toContain('const Dock := preload("veistra_dock.gd")');
    const exit = fn(plugin, "_exit_tree");
    expect(exit).toContain("remove_control_from_docks(_dock)");
    expect(exit).toContain("_dock.queue_free()");
  });

  it("follows the editor's selection the moment it changes", () => {
    expect(fn(dock, "_ready")).toContain(
      "EditorInterface.get_selection().selection_changed.connect(_render)",
    );
    expect(fn(dock, "_selected_paths")).toContain("get_selected_nodes()");
  });

  // Done when: selecting Enemy_02 shows its notes within 1 s.
  it("reads notes.json often enough, by its text, and never writes it", () => {
    const read = Number(/const READ_SEC := ([\d.]+)/.exec(dock)?.[1]);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThanOrEqual(0.5);
    expect(fn(dock, "_read_notes")).toContain("text == _notes_text");
    expect(code(dock)).not.toMatch(/FileAccess\.open\(_dir\.path_join\(NOTES\)/);
    expect(code(dock)).not.toContain(".veistra");
  });

  it("matches a node note by path and scene, and a Play note under another root too", () => {
    const body = fn(dock, "matches");
    expect(body).toMatch(/"node":\s+return at == path and same_scene/);
    expect(body).toMatch(
      /"take":\s+return \(at == path and same_scene\) or at\.ends_with\("\/" \+ path\)/,
    );
    // The path the dock matches with is the plugin's own, so it is the one
    // a note written from the pane's tree carries.
    expect(fn(plugin, "_enter_tree")).toContain("dock.setup(_dir, _node_path, _camera,");
  });

  it("offers Looks good and Still broken only on a note the agent fixed", () => {
    expect(fn(dock, "_card")).toMatch(
      /if str\(note\.get\("status", ""\)\) == "fixed":\s+_verdict_row/,
    );
    const verdict = fn(dock, "_verdict");
    expect(verdict).toContain('"kind": "verdict"');
    expect(verdict).toContain('"verdict": "good" if good else "broken"');
  });

  it("asks with the question, the scene, the selection, the camera and the viewport", () => {
    const ask = fn(dock, "_on_ask");
    for (const key of ['"kind": "ask"', '"text": text', '"scene"', '"nodes"', '"camera"']) {
      expect(ask).toContain(key);
    }
    // The picture is written first, under the one name Veistra accepts.
    expect(ask).toContain('save_png(_dir.path_join("ask-%d.png" % n))');
    expect(ask.indexOf("save_png")).toBeLessThan(ask.indexOf("_send(event"));
    expect(notesRs).toContain('name == format!("{prefix}-{n}.png")');
    expect(notesRs).toContain('own_png(&v, "ask", n)');
    expect(fn(dock, "_viewport_image")).toContain("get_editor_viewport_3d(0)");
  });

  it("mentions the selection, the scene, a file or the viewport, in lines Veistra takes", () => {
    const body = fn(dock, "mention");
    expect(body).toContain('"kind": "mention"');
    for (const what of ['"selection":', '"scene":', '"script":', '"file":', '"viewport":']) {
      expect(body).toContain(what);
    }
    // A script goes as a file, the one kind of path Veistra accepts.
    expect(body).toContain('event["what"] = "file"');
    expect(body).toContain('save_png(_dir.path_join("mention-%d.png" % n))');
    expect(notesRs).toContain('own_png(v, "mention", n)');
    for (const [variant, what] of [
      ["Selection", "selection"],
      ["Scene", "scene"],
      ["File", "file"],
      ["Viewport", "viewport"],
    ]) {
      expect(notesRs).toContain(`Self::${variant} => "${what}"`);
    }
    expect(dock).toContain('_mention_button.text = "Mention to Veistra agent"');
    expect(dock).toContain('_mention_button.tooltip_text = "Mention this to Veistra agent"');
  });

  it("puts Mention on the editor's right-click menus and Ctrl+Alt+M, from 4.4 on", () => {
    expect(fn(plugin, "_add_menus")).toContain('ClassDB.class_exists("EditorContextMenuPlugin")');
    expect(fn(plugin, "_add_menus")).toContain("menu.mention = _dock.mention");
    expect(fn(plugin, "_exit_tree")).toContain('call("remove_context_menu_plugin", menu)');
    const keys = fn(plugin, "_shortcut_input");
    expect(keys).toContain("_dock.mention_now()");
    expect(keys).toMatch(/ctrl_pressed.*alt_pressed|alt_pressed.*ctrl_pressed/s);
  });

  it("keeps the question within what Veistra takes", () => {
    const gd = Number(/const MAX_TEXT := (\d+)/.exec(dock)?.[1]);
    const rs = Number(/pub const MAX_TEXT: usize = (\d+);/.exec(notesRs)?.[1]);
    expect(gd).toBe(rs);
  });

  it("appends one line a press to events.jsonl and keeps what it waits on", () => {
    const send = fn(dock, "_send");
    expect(dock).toContain('const EVENTS := "events.jsonl"');
    expect(send).toContain("FileAccess.READ_WRITE");
    expect(send).toContain("file.seek_end()");
    expect(send).toContain("file.store_line(JSON.stringify(event))");
    expect(send).toContain("_pending[");
    expect(fn(dock, "_on_markup")).toContain('{"kind": "markup"}');
    expect(fn(dock, "_on_ack")).toContain('ack.get("message"');
  });

  it("never opens a socket", () => {
    expect(code(dock)).not.toMatch(/TCPServer|UDPServer|HTTPRequest|HTTPClient|WebSocket/);
    expect(code(dock)).not.toMatch(/PacketPeer|StreamPeer|ENet|MultiplayerPeer/);
  });
});
