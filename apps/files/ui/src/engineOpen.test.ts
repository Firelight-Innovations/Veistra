import { describe, expect, it } from "vitest";
import { engineOpen, relativeTo } from "./engineOpen";

describe("a deliberate open of an engine's file", () => {
  it("opens a .blend in a Blender tab of its own, by its full path", () => {
    expect(engineOpen("C:\\env\\art\\Chair.BLEND", "C:\\env")).toEqual({
      appId: "blender-viewer",
      payload: { blend: "C:\\env\\art\\Chair.BLEND" },
    });
  });

  it("opens a Godot scene in the Godot editor, by its place in the environment", () => {
    expect(engineOpen("C:\\env\\game\\levels\\hall.tscn", "c:/env/")).toEqual({
      appId: "godot-viewer",
      payload: { reveal: { tool: "godot", file: "game/levels/hall.tscn" } },
    });
  });

  it("leaves text, and a scene it cannot place, to the File Viewer", () => {
    expect(engineOpen("/env/player.gd", "/env")).toBeNull();
    expect(engineOpen("/elsewhere/a.tscn", "/env")).toBeNull();
    expect(engineOpen("/env/a.tscn", null)).toBeNull();
  });
});

describe("relativeTo", () => {
  it("is null for a sibling that only shares a prefix", () => {
    expect(relativeTo("/env", "/env2/a.tscn")).toBeNull();
    expect(relativeTo("/env", "/env/a.tscn")).toBe("a.tscn");
  });

  it("keeps POSIX paths case sensitive", () => {
    expect(relativeTo("/Env", "/env/a.tscn")).toBeNull();
  });
});
