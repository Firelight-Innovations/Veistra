import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ editorSelect: vi.fn() }));

import { editorSelect, type BlenderEditorInfo } from "./rpc";
import { blenderPlace, blenderReport, revealInBlender } from "./reveal";

const editor = {
  file: "art/crate.blend",
  view: {
    selected: [{ name: "Crate", type: "MESH" }],
    objects: [
      { name: "Camera", type: "CAMERA" },
      { name: "Crate", type: "MESH" },
    ],
  },
} as unknown as BlenderEditorInfo;

beforeEach(() => {
  vi.mocked(editorSelect).mockReset().mockResolvedValue({ selected: [], active: null });
});

describe("what the Blender pane reports", () => {
  it("lists the view layer's objects and the selection, or nothing with no Blender", () => {
    expect(blenderReport(editor)).toEqual({
      tool: "blender",
      scene: "art/crate.blend",
      scenes: [],
      nodes: [
        { path: "Camera", type: "CAMERA" },
        { path: "Crate", type: "MESH" },
      ],
      selected: ["Crate"],
    });
    expect(blenderReport(null)).toBeNull();
  });

  // A boot script before v3 reports no objects; the selection stands in.
  it("falls back to the selection from an older boot script", () => {
    const old = { ...editor, view: { selected: editor.view!.selected } } as BlenderEditorInfo;
    expect(blenderReport(old)?.nodes).toEqual([{ path: "Crate", type: "MESH" }]);
  });

  // Without a place, every Mention in agent from Blender was refused.
  it("gives a mention its file and each object's type", () => {
    const place = blenderPlace(editor);
    expect(place.file).toBe("art/crate.blend");
    expect(place.node?.("Camera")).toEqual({ type: "CAMERA" });
    expect(place.node?.("Gone")).toBeUndefined();
  });
});

describe("a chip shown in the running Blender", () => {
  it("selects only the objects this file has, and names the rest", async () => {
    const said = await revealInBlender(
      { tool: "blender", scene: "art\\crate.blend", nodes: ["Crate", "Barrel"] },
      editor,
    );
    expect(editorSelect).toHaveBeenCalledWith(["Crate"]);
    expect(said).toBe("Not in this file now: Barrel.");
  });

  it("says another file is open rather than leaving this one", async () => {
    const said = await revealInBlender({ tool: "blender", file: "art/barrel.blend" }, editor);
    expect(said).toBe("That is in art/barrel.blend; this Blender has art/crate.blend open.");
    expect(editorSelect).not.toHaveBeenCalled();
  });
});
