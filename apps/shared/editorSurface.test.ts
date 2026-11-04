/**
 * The one switch from the backend's `editor` answer to what Editor mode
 * renders: until C1 and C2 build the editor surfaces, every answer is the
 * viewer, and an answer the app cannot draw falls back a step, never forward.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({ invoke }));

import { canLaunch, editorBody, openEditorSettings, type EditorSurface } from "./editorSurface";

const embedded: EditorSurface = { surface: "embedded", reason: null, code: null };
const popOut: EditorSurface = {
  surface: "popOut",
  reason: "Godot opens in its own window.",
  code: "noEmbedder",
};
const viewer: EditorSurface = { surface: "viewer", reason: "main", code: "main" };

describe("editorBody", () => {
  it("is the viewer for every answer while nothing else is built", () => {
    for (const s of [embedded, popOut, viewer, null, undefined]) {
      expect(editorBody(s)).toBe("viewer");
    }
  });

  it("is the editor only for an embedded answer once the embedded editor exists", () => {
    const built = { embedded: true, popOut: true };
    expect(editorBody(embedded, built)).toBe("editor");
    expect(editorBody(popOut, built)).toBe("popOut");
    expect(editorBody(viewer, built)).toBe("viewer");
  });

  it("pops out an embedded answer when only the popped-out state is built", () => {
    expect(editorBody(embedded, { embedded: false, popOut: true })).toBe("popOut");
  });

  it("never lets a pop out or the viewer become the editor in the pane", () => {
    const onlyEmbedded = { embedded: true, popOut: false };
    expect(editorBody(popOut, onlyEmbedded)).toBe("viewer");
    expect(editorBody(viewer, onlyEmbedded)).toBe("viewer");
    expect(editorBody(null, onlyEmbedded)).toBe("viewer");
  });
});

describe("canLaunch", () => {
  it("allows the editor in the pane or its own window, and not the viewer or no answer", () => {
    expect(canLaunch(embedded)).toBe(true);
    expect(canLaunch(popOut)).toBe(true);
    expect(canLaunch(viewer)).toBe(false);
    expect(canLaunch(null)).toBe(false);
  });
});

describe("openEditorSettings", () => {
  it("opens Settings on the tool's own section", async () => {
    invoke.mockResolvedValue({ section: "blender" });
    await openEditorSettings("blender");
    expect(invoke).toHaveBeenCalledWith("shell/open-settings", { section: "blender" });
  });
});
