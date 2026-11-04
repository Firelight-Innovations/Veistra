/**
 * The one-writer banner's words (#317, §13 test 12): with bed.blend open and
 * v1..v5 kept, the agent's next export is v6, beside the file.
 */
import { describe, expect, it } from "vitest";
import type { BlenderEditorInfo } from "./rpc";
import { conflictText, nextVersion, writerBanner } from "./writer";

const editor = (over: Partial<BlenderEditorInfo> = {}): BlenderEditorInfo => ({
  file: "props/bed.blend",
  opened: "props/bed.blend",
  pid: 10,
  blender: "4.2.1",
  embed: { state: { kind: "embedded" }, still: false },
  booted: true,
  script: 1,
  why: null,
  dirty: false,
  lock: { file: "props/bed.blend", pid: 10, since: 1 },
  conflict: null,
  view: null,
  ...over,
});

describe("nextVersion", () => {
  it("is one past the newest kept, whatever order they come in", () => {
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([5, 4, 3])).toBe(6);
    expect(nextVersion([2, 9, 4])).toBe(10);
  });
});

describe("writerBanner", () => {
  it("names the file, the version the agent's export lands as, and the newest to compare with", () => {
    expect(writerBanner(editor(), [5, 4, 3, 2, 1])).toEqual({
      text: "You have bed.blend open. The agent's next export goes to v6 beside it and never overwrites your file.",
      compareWith: 5,
    });
  });

  it("offers nothing to compare with before the first export", () => {
    expect(writerBanner(editor(), [])).toMatchObject({ compareWith: null });
    expect(writerBanner(editor(), [])?.text).toContain("goes to v1 beside it");
  });

  it("is not shown without a lock: no Blender, an unsaved file, or one held elsewhere", () => {
    expect(writerBanner(null, [1])).toBeNull();
    expect(writerBanner(editor({ file: null }), [1])).toBeNull();
    expect(writerBanner(editor({ lock: null, conflict: "props/bed.blend" }), [1])).toBeNull();
  });

  it("is not shown when the lock is on a file Blender has since moved away from", () => {
    expect(writerBanner(editor({ file: "props/chair.blend" }), [1])).toBeNull();
  });
});

describe("conflictText", () => {
  it("names the file and says what two Blenders on it do", () => {
    expect(conflictText("props/bed.blend")).toMatch(/^bed\.blend is open in another Blender too/);
    expect(conflictText("props/bed.blend")).toContain("save over each other");
  });
});
