/**
 * Send selection's words and its two items: what the agent reads about the
 * objects selected in Blender, and the keys that let a second send replace
 * the first instead of adding to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@veistra/bridge", () => ({ invoke: bridge.invoke }));

import { cameraPose, selectionText, sendSelection } from "./selection";
import type { ViewportCapture } from "./rpc";

const CAP: ViewportCapture = {
  pngBase64: "QUJD",
  width: 800,
  height: 600,
  view: {
    matrix: [],
    window: [],
    perspective: "PERSP",
    distance: 8,
    area: { w: 800, h: 600 },
    region: { x: 0, y: 0, w: 800, h: 600 },
    camera: { pos: [7.123, -7, 5], target: [0, 0, 1], up: [0, 0, 1], fov: 39.6 },
  },
  selected: [
    { name: "Frame", type: "MESH" },
    { name: "Key", type: "LIGHT" },
  ],
  active: "Frame",
  file: "props/bed.blend",
};

beforeEach(() => {
  bridge.invoke.mockReset();
  let n = 0;
  bridge.invoke.mockImplementation((method: string) =>
    Promise.resolve(method === "context/put" ? { id: `i${++n}`, key: "k" } : { inserted: true }),
  );
});

describe("selectionText", () => {
  it("names the file, each object with its type, the active one and the view", () => {
    expect(selectionText(CAP)).toBe(
      [
        "Blender selection in props/bed.blend (2 objects):",
        "- Frame (mesh, active)",
        "- Key (light)",
        "3D view at (7.12, -7, 5) looking at (0, 0, 1), fov 39.6.",
        "Blender's 3D view at that moment is attached beside this.",
      ].join("\n"),
    );
  });

  it("says when the view is the scene camera's, or orthographic, and when the file is unsaved", () => {
    const camera = selectionText({
      ...CAP,
      file: null,
      selected: [CAP.selected[0]!],
      view: { ...CAP.view!, perspective: "CAMERA" },
    });
    expect(camera).toContain("in an unsaved file (1 object)");
    expect(camera).toContain("3D view through the scene camera at");
    const ortho = selectionText({
      ...CAP,
      view: { ...CAP.view!, camera: { ...CAP.view!.camera, fov: undefined } },
    });
    expect(ortho).toContain(", orthographic.");
  });
});

describe("cameraPose", () => {
  it("is the markup format's pose when the boot script read all of it", () => {
    expect(cameraPose(CAP.view!.camera)).toEqual({
      position: [7.123, -7, 5],
      target: [0, 0, 1],
      up: [0, 0, 1],
      fov: 39.6,
    });
    expect(cameraPose({ pos: [0, 0, 0], target: [0, 0, 1] })).toBeNull();
    expect(cameraPose(undefined)).toBeNull();
  });
});

describe("sendSelection", () => {
  it("puts the text and the picture under the file's keys, then types both references", async () => {
    const sent = await sendSelection(CAP);
    const puts = bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");
    expect(puts.map((c) => (c[1] as { key: string }).key)).toEqual([
      "blender/props/bed/selection",
      "blender/props/bed/editor-viewport",
    ]);
    expect(puts[0]![1]).toMatchObject({ kind: "text", title: "Blender - selection in bed.blend" });
    expect(puts[1]![1]).toMatchObject({ kind: "image", bytesBase64: "QUJD" });
    expect(bridge.invoke).toHaveBeenLastCalledWith("context/insert", { itemIds: ["i1", "i2"] });
    expect(sent.typed).toBe(true);
  });

  it("says nothing was typed when no agent terminal takes the references", async () => {
    // What `context/insert` answers with no agent terminal in the cluster:
    // not an error, because the items are attached in the strip either way.
    bridge.invoke.mockImplementation((method: string) =>
      Promise.resolve(
        method === "context/insert"
          ? { inserted: false, reason: "no agent terminal is open" }
          : { id: "i", key: "k" },
      ),
    );
    const sent = await sendSelection(CAP);
    expect(sent.typed).toBe(false);
  });

  it("keeps the items when typing the references fails, and says so", async () => {
    bridge.invoke.mockImplementation((method: string) =>
      method === "context/insert"
        ? Promise.reject(new Error("no agent terminal"))
        : Promise.resolve({ id: "i", key: "k" }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sent = await sendSelection(CAP);
    expect(sent.typed).toBe(false);
    error.mockRestore();
  });
});
