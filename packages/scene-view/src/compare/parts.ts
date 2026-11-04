/**
 * The whole-model diff: parts matched by name, each pair diffed by
 * `diffTriangles`, and the results gathered into one buffer a class for
 * drawing. A part only in B is all Added and a part only in A all Removed,
 * which is also what a rename looks like: Blender keeps no record of an
 * object's old name, and guessing one from the geometry would be wrong
 * exactly when it matters, for a part that was both renamed and edited.
 */
import { ADDED, CHANGED, UNCHANGED, bounds, diffTriangles } from "./diff";
import { RegionBuilder } from "./regions";
import { CHANGE_CLASSES, DELTA, EPSILON, zeroCounts } from "./types";
import type { ChangeClass, DiffResult, PartDiff, PartTriangles } from "./types";

const EMPTY = new Float32Array(0);

class Gather {
  private chunks: Record<ChangeClass, Float32Array[]> = {
    added: [],
    changed: [],
    removed: [],
    unchanged: [],
  };
  private lengths = zeroCounts();

  /** Copies the triangles of `t` that `pick` selects into `cls`. */
  take(cls: ChangeClass, t: Float32Array, pick: (i: number) => boolean, count: number) {
    if (count === 0) return;
    const out = new Float32Array(count * 9);
    let w = 0;
    for (let i = 0; i < t.length / 9; i++) {
      if (!pick(i)) continue;
      out.set(t.subarray(i * 9, i * 9 + 9), w);
      w += 9;
    }
    this.chunks[cls].push(out);
    this.lengths[cls] += out.length;
  }

  result(): Record<ChangeClass, Float32Array> {
    const geometry = {} as Record<ChangeClass, Float32Array>;
    for (const cls of CHANGE_CLASSES) {
      const out = new Float32Array(this.lengths[cls]);
      let w = 0;
      for (const c of this.chunks[cls]) {
        out.set(c, w);
        w += c.length;
      }
      geometry[cls] = out;
    }
    return geometry;
  }
}

function join(list: Float32Array[]): Float32Array {
  if (list.length === 1) return list[0];
  const out = new Float32Array(list.reduce((n, l) => n + l.length, 0));
  let w = 0;
  for (const l of list) {
    out.set(l, w);
    w += l.length;
  }
  return out;
}

/** Joins parts that share a name, which Blender's instancing can produce. */
function byName(parts: PartTriangles[]): Map<string, Float32Array> {
  const map = new Map<string, Float32Array[]>();
  for (const p of parts) map.set(p.name, [...(map.get(p.name) ?? []), p.positions]);
  return new Map([...map].map(([name, list]) => [name, join(list)]));
}

export function diffParts(
  aParts: PartTriangles[],
  bParts: PartTriangles[],
  epsilon = EPSILON,
  delta = DELTA,
): DiffResult {
  const started = performance.now();
  const a = byName(aParts);
  const b = byName(bParts);
  const names = [...new Set([...b.keys(), ...a.keys()])];
  const gather = new Gather();
  const all = bounds(...a.values(), ...b.values());
  const regions = new RegionBuilder(all.lo, all.hi, delta);
  const counts = zeroCounts();
  const parts: PartDiff[] = [];

  for (const name of names) {
    const ta = a.get(name) ?? EMPTY;
    const tb = b.get(name) ?? EMPTY;
    const d = diffTriangles(ta, tb, epsilon, delta);
    const c = zeroCounts();
    for (let j = 0; j < d.b.length; j++) {
      const v = d.b[j];
      if (v === UNCHANGED) c.unchanged++;
      else if (v === CHANGED) c.changed++;
      else c.added++;
      if (v !== UNCHANGED) regions.add(tb, j);
    }
    for (let i = 0; i < d.removed.length; i++) {
      if (!d.removed[i]) continue;
      c.removed++;
      regions.add(ta, i);
    }
    gather.take("added", tb, (j) => d.b[j] === ADDED, c.added);
    gather.take("changed", tb, (j) => d.b[j] === CHANGED, c.changed);
    gather.take("unchanged", tb, (j) => d.b[j] === UNCHANGED, c.unchanged);
    gather.take("removed", ta, (i) => d.removed[i] === 1, c.removed);
    for (const cls of CHANGE_CLASSES) counts[cls] += c[cls];

    const { lo, hi } = bounds(ta, tb);
    const status = !a.has(name)
      ? "added"
      : !b.has(name)
        ? "removed"
        : c.added + c.changed + c.removed > 0
          ? "changed"
          : "unchanged";
    parts.push({ name, status, counts: c, min: [lo[0], lo[1], lo[2]], max: [hi[0], hi[1], hi[2]] });
  }

  const changedOf = (p: PartDiff) => p.counts.added + p.counts.changed + p.counts.removed;
  parts.sort((x, y) => changedOf(y) - changedOf(x) || x.name.localeCompare(y.name));
  return {
    counts,
    parts,
    geometry: gather.result(),
    regions: regions.regions(),
    ms: performance.now() - started,
  };
}
