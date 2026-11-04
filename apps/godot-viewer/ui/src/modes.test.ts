// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialMode, MODES, readMode, writeMode } from "./modes";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Godot app modes", () => {
  it("are Editor and Play", () => {
    expect(MODES.map((m) => m.label)).toEqual(["Editor", "Play"]);
  });

  it("opens in Play for the play alias, and in Editor for anything else", () => {
    expect(initialMode("?mode=play")).toBe("play");
    expect(initialMode("?mode=editor")).toBe("editor");
    // The viewer's old name for Editor.
    expect(initialMode("?mode=scene")).toBe("editor");
    expect(initialMode("")).toBe("editor");
    expect(initialMode("?mode=nonsense")).toBe("editor");
  });

  it("keeps each pane instance's mode apart", () => {
    writeMode("a", "play");
    writeMode("b", "editor");
    expect(readMode("a")).toBe("play");
    expect(readMode("b")).toBe("editor");
    expect(readMode("c")).toBeNull();
  });

  it("keeps nothing for a frame with no instance", () => {
    writeMode(null, "play");
    expect(localStorage.length).toBe(0);
    expect(readMode(null)).toBeNull();
  });

  it("ignores a saved value that is not a mode", () => {
    localStorage.setItem("godot.mode.a", "scene");
    expect(readMode("a")).toBeNull();
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeMode("a", "play")).not.toThrow();
    expect(readMode("a")).toBeNull();
  });
});
