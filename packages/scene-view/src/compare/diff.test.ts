import { describe, expect, it } from "vitest";
import { ADDED, CHANGED, UNCHANGED, diffTriangles } from "./diff";
import { CellGrid } from "./grid";
import { diffParts } from "./parts";
import { box, concat, moved, plane } from "./testShapes";
import type { Counts } from "./types";

function count(a: Float32Array, b: Float32Array): Counts {
  const d = diffTriangles(a, b);
  const n = (v: number) => d.b.filter((c) => c === v).length;
  return {
    added: n(ADDED),
    changed: n(CHANGED),
    removed: d.removed.filter((r) => r === 1).length,
    unchanged: n(UNCHANGED),
  };
}

const flat = plane(40, 2);
const QUADS = 40 * 40;

describe("diffTriangles", () => {
  it("calls a re-indexed copy unchanged: corner order and triangle order do not matter", () => {
    const shuffled = new Float32Array(flat.length);
    const n = flat.length / 9;
    for (let i = 0; i < n; i++) {
      const from = (n - 1 - i) * 9;
      // Corners (0, 1, 2) become (1, 2, 0).
      shuffled.set(flat.subarray(from + 3, from + 9), i * 9);
      shuffled.set(flat.subarray(from, from + 3), i * 9 + 6);
    }
    expect(count(flat, shuffled)).toEqual({ added: 0, changed: 0, removed: 0, unchanged: n });
  });

  it("calls a move under 1 mm unchanged and a move over it changed", () => {
    const n = flat.length / 9;
    expect(count(flat, moved(flat, 0, 0.0005, 0)).unchanged).toBe(n);
    expect(count(flat, moved(flat, 0, 0.002, 0))).toEqual({
      added: 0,
      changed: n,
      removed: 0,
      unchanged: 0,
    });
  });

  it("calls a quad split on its other diagonal changed, not added", () => {
    const a = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
    const b = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
    const small = a.map((v) => v * 0.04);
    const smallB = b.map((v) => v * 0.04);
    expect(count(small, smallB)).toEqual({ added: 0, changed: 2, removed: 0, unchanged: 0 });
  });

  it("matches one to one, so a doubled face is half added", () => {
    const quad = plane(1, 0.04);
    expect(count(quad, concat(quad, quad))).toEqual({
      added: 2,
      changed: 0,
      removed: 0,
      unchanged: 2,
    });
  });

  it("calls a part moved further than δ all added and all removed", () => {
    const n = flat.length / 9;
    expect(count(flat, moved(flat, 0, 1, 0))).toEqual({
      added: n,
      changed: 0,
      removed: n,
      unchanged: 0,
    });
  });

  it("calls an extruded patch of a dense face changed, and only what moved", () => {
    const inPatch = (x: number, z: number) => x > 0.5 && x < 0.9 && z > 0.5 && z < 0.9;
    const bumped = plane(40, 2, (x, z) => (inPatch(x, z) ? 0.02 : 0));
    let moving = 0;
    for (let i = 0; i < bumped.length; i += 9) {
      if ([1, 4, 7].some((k) => bumped[i + k] !== 0)) moving++;
    }
    expect(moving).toBeGreaterThan(0);
    expect(count(flat, bumped)).toEqual({
      added: 0,
      changed: moving,
      removed: 0,
      unchanged: QUADS * 2 - moving,
    });
  });

  // The two cases the refined δ rule exists for (see diff.ts).
  it("calls a knob on an untouched face added, not changed", () => {
    const knob = box([0.98, 0, 0.98], [1.02, 0.03, 1.02]);
    expect(count(flat, concat(flat, knob))).toEqual({
      added: 12,
      changed: 0,
      removed: 0,
      unchanged: QUADS * 2,
    });
  });

  it("calls a hole's missing triangles removed though the face around them stayed", () => {
    const hole = plane(40, 2, undefined, (i, k) => i >= 10 && i < 14 && k >= 10 && k < 14);
    expect(count(flat, hole)).toEqual({
      added: 0,
      changed: 0,
      removed: 32,
      unchanged: QUADS * 2 - 32,
    });
  });

  it("handles either side empty", () => {
    expect(count(new Float32Array(0), flat).added).toBe(QUADS * 2);
    expect(count(flat, new Float32Array(0)).removed).toBe(QUADS * 2);
    expect(count(new Float32Array(0), new Float32Array(0)).unchanged).toBe(0);
  });
});

describe("diffParts", () => {
  const cube = box([0, 0, 0], [1, 1, 1]);
  const legs = box([0, -1, 0], [0.1, 0, 0.1]);

  it("calls a part only in B added and a part only in A removed", () => {
    const result = diffParts(
      [
        { name: "Frame", positions: cube },
        { name: "Leg", positions: legs },
      ],
      [
        { name: "Frame", positions: cube },
        { name: "Pillow", positions: moved(cube, 3, 0, 0) },
      ],
    );
    expect(result.counts).toEqual({ added: 12, changed: 0, removed: 12, unchanged: 12 });
    expect(result.parts.map((p) => [p.name, p.status])).toEqual([
      ["Leg", "removed"],
      ["Pillow", "added"],
      ["Frame", "unchanged"],
    ]);
  });

  it("treats a rename as a removal and an addition", () => {
    const result = diffParts(
      [{ name: "Cube", positions: cube }],
      [{ name: "Box", positions: cube }],
    );
    expect(result.parts.map((p) => p.status).sort()).toEqual(["added", "removed"]);
  });

  it("joins parts that share a name before diffing", () => {
    const result = diffParts(
      [{ name: "Leg", positions: concat(legs, moved(legs, 1, 0, 0)) }],
      [
        { name: "Leg", positions: moved(legs, 1, 0, 0) },
        { name: "Leg", positions: legs },
      ],
    );
    expect(result.counts.unchanged).toBe(24);
    expect(result.parts).toHaveLength(1);
  });

  it("frames each part over both versions, so a removed part has a box", () => {
    const [leg] = diffParts([{ name: "Leg", positions: legs }], []).parts;
    expect(leg.min).toEqual([0, -1, 0]);
    expect(leg.max.map((v) => +v.toFixed(6))).toEqual([0.1, 0, 0.1]);
  });

  it("puts separate changes in separate places, the larger first", () => {
    const knob = box([0.98, 0, 0.98], [1.02, 0.03, 1.02]);
    const far = box([0, 5, 0], [1, 6, 1]);
    const result = diffParts(
      [{ name: "Floor", positions: flat }],
      [{ name: "Floor", positions: concat(flat, knob, far, moved(far, 0, 0, 3)) }],
    );
    expect(result.regions.map((r) => r.triangles)).toEqual([12, 12, 12]);
    expect(result.regions[0].min[1]).toBe(0);
  });
});

describe("CellGrid", () => {
  it("finds what a brute-force search finds", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1;
    const points = Float64Array.from({ length: 3000 }, random);
    const ids = Uint32Array.from({ length: 1000 }, (_, i) => i);
    const grid = new CellGrid(points, ids, 0.05, [0, 0, 0], [1, 1, 1]);
    for (let q = 0; q < 300; q++) {
      const [x, y, z] = [random(), random(), random()];
      const found = new Set<number>();
      grid.visit(x, y, z, (i) => {
        if (Math.hypot(points[i * 3] - x, points[i * 3 + 1] - y, points[i * 3 + 2] - z) <= 0.05) {
          found.add(i);
        }
        return false;
      });
      const brute = [...ids].filter(
        (i) => Math.hypot(points[i * 3] - x, points[i * 3 + 1] - y, points[i * 3 + 2] - z) <= 0.05,
      );
      expect([...found].sort((p, r) => p - r)).toEqual(brute);
    }
  });

  it("grows its cell for a huge box rather than lose exact keys, and still finds neighbours", () => {
    const points = Float64Array.from([9000, 0.5, 0.5, 9000.0009, 0.5, 0.5]);
    const grid = new CellGrid(points, Uint32Array.from([0]), 0.002, [0, 0, 0], [10000, 1, 1]);
    expect(grid.cell).toBeGreaterThan(0.002);
    expect(grid.visit(9000.0009, 0.5, 0.5, (i) => i === 0)).toBe(true);
  });
});
