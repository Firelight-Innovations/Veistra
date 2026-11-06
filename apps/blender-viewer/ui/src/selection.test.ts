import { describe, expect, it } from "vitest";
import { openedBlend, reconcileBlend, selectionWasDropped } from "./selection";

describe("reconcileBlend", () => {
  it("adopts the host's default when nothing was chosen", () => {
    expect(reconcileBlend(null, { blend: "C:/p/a.blend" })).toBe("C:/p/a.blend");
  });

  it("keeps the choice while the host resolved it", () => {
    expect(reconcileBlend("C:/p/a.blend", { blend: "C:/p/a.blend" })).toBe("C:/p/a.blend");
  });

  it("switches to the new project's file after the project changes", () => {
    expect(reconcileBlend("C:/old/room.blend", { blend: "C:/new/x.blend" })).toBe("C:/new/x.blend");
    expect(selectionWasDropped("C:/old/room.blend", { blend: "C:/new/x.blend" })).toBe(true);
  });

  it("clears the choice when the new project has no .blend files", () => {
    expect(reconcileBlend("C:/old/room.blend", { blend: null })).toBeNull();
    expect(selectionWasDropped("C:/old/room.blend", { blend: null })).toBe(true);
  });

  it("does not call an untouched selection dropped", () => {
    expect(selectionWasDropped(null, { blend: "C:/p/a.blend" })).toBe(false);
    expect(selectionWasDropped("C:/p/a.blend", { blend: "C:/p/a.blend" })).toBe(false);
  });
});

describe("openedBlend", () => {
  it("reads the file the Explorer opened this tab on", () => {
    expect(openedBlend({ blend: "C:/p/art/chair.blend" })).toBe("C:/p/art/chair.blend");
  });

  it("is null for a reveal, an empty file or no payload", () => {
    expect(openedBlend({ reveal: { tool: "blender", file: "a.blend" } })).toBeNull();
    expect(openedBlend({ blend: "" })).toBeNull();
    expect(openedBlend(null)).toBeNull();
  });
});
