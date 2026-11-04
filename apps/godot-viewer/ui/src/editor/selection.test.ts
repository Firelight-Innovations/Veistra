/**
 * Send selection's message (#316, spec §13 test 11): what the agent reads,
 * and the two items with both references typed in one `context/insert`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@veistra/bridge", () => ({ invoke: bridge.invoke }));

import { selectionText, sendSelection } from "./selection";
import type { EditorSelection } from "./rpc";

const SELECTION: EditorSelection = {
  pngBase64: "AAAA",
  width: 1280,
  height: 720,
  scene: "res://levels/hallway.tscn",
  selected: [
    { path: "Hallway/Enemy_02", type: "CharacterBody3D", script: "res://enemy.gd" },
    { path: "Hallway/Lamp", type: "OmniLight3D", script: "" },
  ],
  camera: { pos: [0, 2.004, 5], target: [0, 1.5, 4.13], up: [0, 1, 0], fov: 75 },
};

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

beforeEach(() => {
  bridge.invoke.mockReset();
  let n = 0;
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "context/put") return Promise.resolve({ id: `item${++n}` });
    return Promise.resolve(null);
  });
});

describe("selectionText", () => {
  it("names the scene, each node with its type and script, and the camera", () => {
    expect(selectionText(SELECTION)).toBe(
      [
        "Godot editor selection in res://levels/hallway.tscn (2 nodes):",
        "- Hallway/Enemy_02 (CharacterBody3D, script res://enemy.gd)",
        "- Hallway/Lamp (OmniLight3D)",
        "Editor camera at (0, 2, 5) looking at (0, 1.5, 4.13), fov 75.",
        "The editor's 3D viewport at that moment is attached beside this.",
      ].join("\n"),
    );
  });

  it("says an orthogonal camera's size, and leaves the camera out when there is none", () => {
    const ortho = selectionText({
      ...SELECTION,
      selected: [SELECTION.selected![0]!],
      camera: { pos: [0, 10, 0], target: [0, 9, 0], orthogonal: true, size: 12 },
    });
    expect(ortho).toContain("(1 node):");
    expect(ortho).toContain("orthogonal, size 12.");
    const none = selectionText({ scene: "", selected: SELECTION.selected });
    expect(none).toContain("in the open scene (2 nodes)");
    expect(none).not.toContain("Editor camera");
  });
});

describe("sendSelection", () => {
  it("puts the text and the viewport, then types both references once, without Enter", async () => {
    const sent = await sendSelection(SELECTION);
    const puts = calls("context/put");
    expect(puts).toHaveLength(2);
    expect(puts[0]![1]).toMatchObject({
      kind: "text",
      key: "godot/levels/hallway.tscn/selection",
      label: "Godot - selection",
      title: "Godot editor - selection in hallway.tscn",
      text: selectionText(SELECTION),
    });
    expect(puts[1]![1]).toMatchObject({
      kind: "image",
      key: "godot/levels/hallway.tscn/editor-viewport",
      label: "Godot - viewport",
      bytesBase64: "AAAA",
    });
    expect(calls("context/insert")).toEqual([["context/insert", { itemIds: ["item1", "item2"] }]]);
    expect(sent.typed).toBe(true);
  });

  it("keeps both items when no prompt takes the references, and says so", async () => {
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "context/insert") return Promise.reject(new Error("no agent terminal"));
      return Promise.resolve({ id: "x" });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sent = await sendSelection(SELECTION);
    expect(sent.typed).toBe(false);
    expect(calls("context/put")).toHaveLength(2);
    error.mockRestore();
  });
});
