import { describe, expect, it } from "vitest";
import { diffParts } from "./parts";
import { plane } from "./testShapes";

/**
 * Spec §12.1's budget: 200,000 triangles a side in 2 s or less. The pair is
 * a dense face with a patch raised 2 cm, so every step of the diff has work:
 * most triangles match in the ε pass, a patch goes through the δ search, and
 * the changes are gathered into places. Parsing is not in the number; it is
 * the loader's, and the same cost the viewer already pays to show a version.
 */
describe("the diff's budget", () => {
  it("diffs 200,000 triangles a side in 2 s or less", () => {
    const n = 317;
    const a = plane(n, 2);
    const b = plane(n, 2, (x, z) => (x > 0.5 && x < 0.9 && z > 0.5 && z < 0.9 ? 0.02 : 0));
    expect(a.length / 9).toBeGreaterThanOrEqual(200_000);

    const times: number[] = [];
    let changed = 0;
    for (let run = 0; run < 3; run++) {
      const result = diffParts(
        [{ name: "Floor", positions: a }],
        [{ name: "Floor", positions: b }],
      );
      times.push(result.ms);
      changed = result.counts.changed;
    }
    times.sort((x, y) => x - y);
    expect(changed).toBeGreaterThan(0);
    expect(times[1]).toBeLessThanOrEqual(2000);
  }, 30_000);
});
