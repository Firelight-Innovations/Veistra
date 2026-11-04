/**
 * A uniform grid over points, for "is anything within r of here" in about
 * constant time. Points are sorted by cell key and found by binary search,
 * which keeps the whole grid in two typed arrays: no per-cell objects, so
 * 200,000 triangles a side build in a few milliseconds.
 *
 * Cells are counted from a corner of the box the caller passes, so keys stay
 * small and exact in a float64. The key is linear in the cell coordinates,
 * which is what lets one search cover three cells along z: the neighbours
 * `z - 1`, `z` and `z + 1` are keys `k`, `k + 1` and `k + 2`. A box too big
 * for the cell size gets a bigger cell, which only costs speed, never a
 * missed neighbour: a search always reaches a full cell in each direction.
 */

/** Cells along an axis before the cell grows, so the key stays exact. */
const MAX_CELLS_PER_AXIS = 100_000;

export class CellGrid {
  readonly cell: number;
  private ox: number;
  private oy: number;
  private oz: number;
  private sy: number;
  private sz: number;
  private keys: Float64Array;
  private ids: Uint32Array;

  /**
   * `points` holds xyz triples. Only those whose index is in `ids` go in;
   * `lo` and `hi` bound every point that will be stored or searched for.
   */
  constructor(
    points: Float64Array,
    ids: Uint32Array,
    cell: number,
    lo: readonly number[],
    hi: readonly number[],
  ) {
    const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0);
    this.cell = Math.max(cell, extent / MAX_CELLS_PER_AXIS);
    this.ox = lo[0];
    this.oy = lo[1];
    this.oz = lo[2];
    this.sy = Math.floor((hi[1] - lo[1]) / this.cell) + 3;
    this.sz = Math.floor((hi[2] - lo[2]) / this.cell) + 3;

    const keys = new Float64Array(ids.length);
    for (let q = 0; q < ids.length; q++) {
      const i = ids[q] * 3;
      keys[q] = this.keyOf(points[i], points[i + 1], points[i + 2], 0, 0, 0);
    }
    const order = new Uint32Array(ids.length);
    for (let q = 0; q < order.length; q++) order[q] = q;
    order.sort((a, b) => keys[a] - keys[b]);
    this.keys = new Float64Array(order.length);
    this.ids = new Uint32Array(order.length);
    for (let q = 0; q < order.length; q++) {
      this.keys[q] = keys[order[q]];
      this.ids[q] = ids[order[q]];
    }
  }

  get size(): number {
    return this.ids.length;
  }

  private keyOf(x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
    const cx = Math.floor((x - this.ox) / this.cell) + 1 + dx;
    const cy = Math.floor((y - this.oy) / this.cell) + 1 + dy;
    const cz = Math.floor((z - this.oz) / this.cell) + 1 + dz;
    return (cx * this.sy + cy) * this.sz + cz;
  }

  /**
   * Calls `fn` with each stored id in the 27 cells around (x, y, z) until it
   * returns true. Returns whether it did.
   */
  visit(x: number, y: number, z: number, fn: (id: number) => boolean): boolean {
    const keys = this.keys;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k0 = this.keyOf(x, y, z, dx, dy, -1);
        const k1 = k0 + 2;
        for (let q = lowerBound(keys, k0); q < keys.length && keys[q] <= k1; q++) {
          if (fn(this.ids[q])) return true;
        }
      }
    }
    return false;
  }
}

function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}
