import { describe, expect, it } from "vitest";
import type { Comment } from "../../../../shared/comments";
import type { VersionEntry } from "../rpc";
import {
  ALL_SHOWN,
  defaultPicks,
  materialChanges,
  notesFrom,
  stepRegion,
  toggleClass,
  versionLabel,
} from "./state";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function version(n: number, extra: Partial<VersionEntry> = {}): VersionEntry {
  return {
    n,
    author: "human",
    time: NOW - (10 - n) * HOUR,
    commit: null,
    branch: null,
    triangles: null,
    sourceLocked: false,
    parts: [],
    materials: [],
    model: `C:/p/.veistra/exports/bed/v${n}/model.glb`,
    blendCopy: null,
    ...extra,
  };
}

const part = (name: string, materials: string[]) => ({
  name,
  kind: "mesh",
  parent: null,
  visible: true,
  mesh: name,
  materials,
  verts: 8,
  polys: 6,
  tris: 12,
  dimensions: [1, 1, 1],
});

describe("defaultPicks", () => {
  const three = [version(3), version(2), version(1)];

  it("compares the newest with the one before it", () => {
    expect(defaultPicks(three, null)).toEqual({ a: 2, b: 3 });
  });

  it("compares against the kept version when it is older than B", () => {
    expect(defaultPicks(three, 1)).toEqual({ a: 1, b: 3 });
    // Kept is B itself: A falls back to the one before it.
    expect(defaultPicks(three, 3)).toEqual({ a: 2, b: 3 });
  });

  it("opens on the B the Editor banner asked for", () => {
    expect(defaultPicks(three, null, 2)).toEqual({ a: 1, b: 2 });
    // A B that is no longer kept is the newest instead.
    expect(defaultPicks(three, null, 9)).toEqual({ a: 2, b: 3 });
    // The oldest as B has nothing older: the one after it is the other side.
    expect(defaultPicks(three, null, 1)).toEqual({ a: 1, b: 2 });
  });

  it("has nothing to compare with fewer than two versions", () => {
    expect(defaultPicks([version(1)], null)).toBeNull();
    expect(defaultPicks([], null)).toBeNull();
  });
});

describe("versionLabel", () => {
  it("names the version, who made it, the commit, its age and its triangles", () => {
    const v = version(5, {
      author: "agent",
      commit: "8c41e07aa",
      triangles: 1234,
      time: NOW - 2 * HOUR,
    });
    expect(versionLabel(v, NOW)).toBe("v5 · agent · 8c41e07 · 2h ago · 1,234 tris");
  });

  it("leaves out what the version does not know", () => {
    expect(versionLabel(version(1, { time: NOW }), NOW)).toBe("v1 · human · just now");
  });
});

describe("stepRegion", () => {
  it("starts at the first change, walks forward and wraps", () => {
    expect(stepRegion(-1, 3, false)).toBe(0);
    expect(stepRegion(0, 3, false)).toBe(1);
    expect(stepRegion(2, 3, false)).toBe(0);
  });

  it("walks back with Shift and wraps the other way", () => {
    expect(stepRegion(-1, 3, true)).toBe(2);
    expect(stepRegion(0, 3, true)).toBe(2);
    expect(stepRegion(2, 3, true)).toBe(1);
  });

  it("frames nothing when nothing changed, and restarts past a shrunk list", () => {
    expect(stepRegion(-1, 0, false)).toBe(-1);
    expect(stepRegion(4, 2, false)).toBe(0);
  });
});

describe("toggleClass", () => {
  it("flips one class and leaves the others", () => {
    const next = toggleClass(ALL_SHOWN, "added");
    expect(next).toEqual({ added: false, changed: true, removed: true, unchanged: true });
    expect(toggleClass(next, "added")).toEqual(ALL_SHOWN);
    expect(ALL_SHOWN.added).toBe(true);
  });
});

describe("notesFrom", () => {
  const a = version(4, { parts: [part("Frame", ["Wood"])], time: 10 });
  const b = version(6, { parts: [part("Frame", ["Wood"])], time: 20 });
  const note = (id: string, anchor: object, extra: Partial<Comment> = {}): Comment =>
    ({
      id,
      anchor: { kind: "mesh", part: "Frame", material: "Wood", ...anchor },
      author: "user",
      body: id,
      status: "open",
      created: 5,
      updated: 5,
      ...extra,
    }) as Comment;

  it("keeps this file's open notes made at or before A", () => {
    const comments = [
      note("on-a", { blend: "bed.blend", version: 4 }),
      note("before-a", { blend: "bed.blend", version: 2 }, { status: "fixed" }),
      note("on-b", { blend: "bed.blend", version: 6 }),
      note("other-file", { blend: "chair.blend", version: 1 }),
      note("resolved", { blend: "bed.blend", version: 4 }, { status: "resolved" }),
    ];
    expect(notesFrom(comments, "bed.blend", a, b).map((c) => c.id)).toEqual(["on-a", "before-a"]);
  });

  it("counts a note from before notes carried a version by its part and its time", () => {
    const comments = [
      note("old", {}),
      note("old-after-b", {}, { created: 25 }),
      note("old-other-part", { part: "Lamp" }),
      note("no-version", { blend: "bed.blend" }),
      { ...note("scene", {}), anchor: { kind: "scene", path: "Main" } } as unknown as Comment,
    ];
    expect(notesFrom(comments, "bed.blend", a, b).map((c) => c.id)).toEqual(["old", "no-version"]);
  });
});

describe("materialChanges", () => {
  it("names a material gained, one lost and one whose values moved", () => {
    const a = version(1, {
      parts: [part("Frame", ["Wood", "Paint"])],
      materials: [
        { name: "Wood", color: [0.5, 0.25, 0, 1], metallic: 0, roughness: 0.5 },
        { name: "Paint", color: [1, 1, 1, 1], metallic: 0, roughness: 0.4 },
      ],
    });
    const b = version(2, {
      parts: [part("Frame", ["Wood", "Brass"])],
      materials: [
        { name: "Wood", color: [1, 0, 0, 1], metallic: 0, roughness: 0.3 },
        { name: "Brass", color: [1, 0.8, 0.2, 1], metallic: 1, roughness: 0.2 },
      ],
    });
    expect(materialChanges("Frame", a, b)).toEqual([
      "Brass added",
      "Paint removed",
      "Wood: colour #804000 → #ff0000, roughness 0.5 → 0.3",
    ]);
  });

  it("says nothing for values that moved less than the tolerance, or a part only on one side", () => {
    const a = version(1, {
      parts: [part("Frame", ["Wood"])],
      materials: [{ name: "Wood", color: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 0.5 }],
    });
    const b = version(2, {
      parts: [part("Frame", ["Wood"])],
      materials: [{ name: "Wood", color: [0.5004, 0.5, 0.5, 1], metallic: 0, roughness: 0.5002 }],
    });
    expect(materialChanges("Frame", a, b)).toEqual([]);
    expect(materialChanges("Lamp", a, b)).toEqual([]);
  });
});
