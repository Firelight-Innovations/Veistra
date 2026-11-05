/**
 * Send selection's message (#316, spec §13 test 11): what the agent reads,
 * and the two items, one chip at the agent's prompt that names the picture.
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
    if (method === "context/put") {
      n += 1;
      return Promise.resolve({ id: `item${n}`, path: `C:/env/item${n}.png` });
    }
    if (method === "veistra/attach-to-agent") return Promise.resolve({ delivered: 1 });
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
  it("puts the viewport and the text, then leaves one chip, the selection's, and types nothing", async () => {
    const sent = await sendSelection(SELECTION);
    const puts = calls("context/put");
    expect(puts).toHaveLength(2);
    expect(puts[0]![1]).toMatchObject({
      kind: "image",
      key: "godot/levels/hallway.tscn/editor-viewport",
      label: "Godot - viewport",
      bytesBase64: "AAAA",
    });
    expect(puts[1]![1]).toMatchObject({
      kind: "text",
      key: "godot/levels/hallway.tscn/selection",
      label: "Godot - selection",
      title: "Godot editor - selection in hallway.tscn",
      text: selectionText(SELECTION),
    });
    expect(
      calls("veistra/attach-to-agent").map((c) => (c[1] as { contextId: string }).contextId),
    ).toEqual(["item2"]);
    // In Godot's colour in the agent tab.
    expect(calls("veistra/attach-to-agent")[0][1]).toMatchObject({ kind: "godot-selection" });
    expect(calls("context/insert")).toEqual([]);
    // The chip's hidden prompt names the picture's file, so the agent opens it.
    const prompt = (puts[1]![1] as { prompt: string }).prompt;
    expect(prompt).toMatch(/nodes I selected/);
    expect(prompt).toContain(
      "The editor's 3D viewport at that moment is at C:/env/item1.png; open it.",
    );
    expect(sent.typed).toBe(true);
  });

  it("types both references at a terminal when no agent tab takes the chip", async () => {
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "context/put") return Promise.resolve({ id: `item${calls(method).length}` });
      if (method === "veistra/attach-to-agent") return Promise.resolve({ delivered: 0 });
      return Promise.resolve({ inserted: true });
    });
    expect((await sendSelection(SELECTION)).typed).toBe(true);
    expect(calls("context/insert")).toEqual([["context/insert", { itemIds: ["item2", "item1"] }]]);
  });

  it("says nothing was taken when no agent takes the chips", async () => {
    // What `context/insert` answers with no agent terminal in the cluster:
    // not an error, because the items are attached in the strip either way.
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "context/insert") {
        return Promise.resolve({ inserted: false, reason: "no agent terminal is open" });
      }
      return Promise.resolve({ id: "x" });
    });
    const sent = await sendSelection(SELECTION);
    expect(sent.typed).toBe(false);
    expect(calls("context/put")).toHaveLength(2);
  });

  it("keeps both items when typing the references fails, and says so", async () => {
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
