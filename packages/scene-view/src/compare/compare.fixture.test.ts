import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffParts } from "./parts";
import { parseParts } from "./triangles";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

function glb(name: string): ArrayBuffer {
  const bytes = readFileSync(join(fixtures, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Spec test 13 on the pair Blender made (scripts/make-compare-fixtures.py):
 * a 1 m cube, then the same cube with its top extruded 2 cm. B's four new
 * side quads are 8 added triangles; the top's two triangles moved 2 cm and
 * are changed; the other ten are where they were.
 */
describe("the extruded cube (spec test 13)", async () => {
  const [a, b] = await Promise.all([parseParts(glb("cube-a.glb")), parseParts(glb("cube-b.glb"))]);

  it("reads one part under Blender's object name", () => {
    expect(a.map((p) => [p.name, p.positions.length / 9])).toEqual([["Cube", 12]]);
    expect(b.map((p) => [p.name, p.positions.length / 9])).toEqual([["Cube", 20]]);
  });

  it("gives 8 added, 2 changed, 0 removed and 10 unchanged", () => {
    const result = diffParts(a, b);
    expect(result.counts).toEqual({ added: 8, changed: 2, removed: 0, unchanged: 10 });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ name: "Cube", status: "changed" });
  });

  it("hands over each class's triangles for drawing", () => {
    const { geometry } = diffParts(a, b);
    expect(geometry.added.length / 9).toBe(8);
    expect(geometry.changed.length / 9).toBe(2);
    expect(geometry.removed.length).toBe(0);
    expect(geometry.unchanged.length / 9).toBe(10);
    // The changed triangles are the new top, 2 cm above the old one.
    for (let i = 1; i < geometry.changed.length; i += 3) {
      expect(geometry.changed[i]).toBeCloseTo(0.52, 5);
    }
  });

  it("makes the new top and the strip under it one place to visit", () => {
    const { regions } = diffParts(a, b);
    expect(regions).toHaveLength(1);
    expect(regions[0].triangles).toBe(10);
    expect(regions[0].min[1]).toBeCloseTo(0.5, 5);
    expect(regions[0].max[1]).toBeCloseTo(0.52, 5);
  });

  it("finds nothing between a version and itself", () => {
    expect(diffParts(a, a).counts).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 12 });
  });
});
