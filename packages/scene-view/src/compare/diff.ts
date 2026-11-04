/**
 * The triangle diff of spec §12.1, with the δ rule refined (see the
 * decision row in docs/design-notes/godot-play.md, "Compare's δ rule").
 *
 * 1. Unchanged: a triangle of B whose three corners each lie within ε of a
 *    corner of one A triangle, and the other way round. Corner order does
 *    not matter, so a re-indexed mesh is unchanged. Matching is one to one:
 *    an A triangle explains at most one B triangle, or two copies of a face
 *    in B would both read as unchanged against one in A.
 * 2. Changed: a B triangle left over from step 1 with the centroid of an A
 *    triangle also left over within δ. It is A's face, edited.
 * 3. Added: every other B triangle.
 * 4. Removed: an A triangle left over from step 1 with no left-over B
 *    centroid within δ.
 *
 * The refinement is "left over" in steps 2 and 4. As written, the spec
 * searches all of A and all of B, so a knob on an untouched face reads as
 * Changed and the faces around a hole hide what was deleted from it.
 */
import { CellGrid } from "./grid";
import { DELTA, EPSILON } from "./types";

/** `b` per B triangle; `removed` per A triangle. */
export interface TriangleDiff {
  b: Uint8Array;
  removed: Uint8Array;
}

/** Values of `TriangleDiff.b`. */
export const ADDED = 1;
export const CHANGED = 2;
export const UNCHANGED = 3;

export function centroids(t: Float32Array): Float64Array {
  const n = t.length / 9;
  const c = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    c[i * 3] = (t[b] + t[b + 3] + t[b + 6]) / 3;
    c[i * 3 + 1] = (t[b + 1] + t[b + 4] + t[b + 7]) / 3;
    c[i * 3 + 2] = (t[b + 2] + t[b + 5] + t[b + 8]) / 3;
  }
  return c;
}

/** The box around every corner in `lists`. Empty input gives a zero box. */
export function bounds(...lists: Float32Array[]): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const t of lists) {
    for (let i = 0; i < t.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = t[i + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
  }
  if (lo[0] > hi[0]) return { lo: [0, 0, 0], hi: [0, 0, 0] };
  return { lo, hi };
}

function range(n: number, keep?: (i: number) => boolean): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!keep || keep(i)) out.push(i);
  return Uint32Array.from(out);
}

/** Every corner of triangle `i` of `s` is within ε of a corner of triangle `j` of `t`. */
function cornersNear(s: Float32Array, i: number, t: Float32Array, j: number, e2: number): boolean {
  for (let p = 0; p < 3; p++) {
    const sx = s[i * 9 + p * 3];
    const sy = s[i * 9 + p * 3 + 1];
    const sz = s[i * 9 + p * 3 + 2];
    let found = false;
    for (let q = 0; q < 3 && !found; q++) {
      const dx = sx - t[j * 9 + q * 3];
      const dy = sy - t[j * 9 + q * 3 + 1];
      const dz = sz - t[j * 9 + q * 3 + 2];
      found = dx * dx + dy * dy + dz * dz <= e2;
    }
    if (!found) return false;
  }
  return true;
}

/** Classifies one part's triangles: `a` and `b` hold nine floats a triangle. */
export function diffTriangles(
  a: Float32Array,
  b: Float32Array,
  epsilon = EPSILON,
  delta = DELTA,
): TriangleDiff {
  const nA = a.length / 9;
  const nB = b.length / 9;
  const ca = centroids(a);
  const cb = centroids(b);
  const { lo, hi } = bounds(a, b);
  const out: TriangleDiff = { b: new Uint8Array(nB), removed: new Uint8Array(nA) };

  // Step 1. Corners within ε put centroids within ε, so 2ε cells and a
  // one-cell search cannot miss a match.
  const fine = new CellGrid(ca, range(nA), 2 * epsilon, lo, hi);
  const matched = new Uint8Array(nA);
  const e2 = epsilon * epsilon;
  for (let j = 0; j < nB; j++) {
    fine.visit(cb[j * 3], cb[j * 3 + 1], cb[j * 3 + 2], (i) => {
      if (matched[i] || !cornersNear(b, j, a, i, e2) || !cornersNear(a, i, b, j, e2)) return false;
      matched[i] = 1;
      out.b[j] = UNCHANGED;
      return true;
    });
  }

  // Steps 2 to 4, each searching only what step 1 left on the other side.
  const leftA = new CellGrid(
    ca,
    range(nA, (i) => !matched[i]),
    delta,
    lo,
    hi,
  );
  const leftB = new CellGrid(
    cb,
    range(nB, (j) => out.b[j] !== UNCHANGED),
    delta,
    lo,
    hi,
  );
  const d2 = delta * delta;
  const near = (c: Float64Array, x: number, y: number, z: number) => (i: number) => {
    const dx = c[i * 3] - x;
    const dy = c[i * 3 + 1] - y;
    const dz = c[i * 3 + 2] - z;
    return dx * dx + dy * dy + dz * dz <= d2;
  };
  for (let j = 0; j < nB; j++) {
    if (out.b[j] === UNCHANGED) continue;
    const x = cb[j * 3];
    const y = cb[j * 3 + 1];
    const z = cb[j * 3 + 2];
    out.b[j] = leftA.size > 0 && leftA.visit(x, y, z, near(ca, x, y, z)) ? CHANGED : ADDED;
  }
  for (let i = 0; i < nA; i++) {
    if (matched[i]) continue;
    const x = ca[i * 3];
    const y = ca[i * 3 + 1];
    const z = ca[i * 3 + 2];
    if (leftB.size === 0 || !leftB.visit(x, y, z, near(cb, x, y, z))) out.removed[i] = 1;
  }
  return out;
}
