/**
 * Groups changed triangles into places for Next change to visit. A triangle
 * occupies the δ cells its three corners and its centroid fall in; cells a
 * triangle spans, and cells that touch, are one place. So a face and the
 * strip around it, which share corners, are one stop however large the
 * triangles, and a change on the far side of the model is another.
 */
import { DELTA } from "./types";
import type { Region } from "./types";

/** As in `CellGrid`: keeps the key exact in a float64. */
const MAX_CELLS_PER_AXIS = 100_000;

export class RegionBuilder {
  private cells = new Map<number, number>();
  private parent: number[] = [];
  private boxes: number[][] = [];
  private counts: number[] = [];
  private readonly cell: number;
  private readonly sy: number;
  private readonly sz: number;

  /** `lo` and `hi` bound every corner that will be added. */
  constructor(
    private readonly lo: readonly number[],
    hi: readonly number[],
    cell = DELTA,
  ) {
    const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0);
    this.cell = Math.max(cell, extent / MAX_CELLS_PER_AXIS);
    this.sy = Math.floor((hi[1] - lo[1]) / this.cell) + 3;
    this.sz = Math.floor((hi[2] - lo[2]) / this.cell) + 3;
  }

  /** Adds triangle `i` of `t`, nine floats a triangle. */
  add(t: Float32Array, i: number) {
    const b = i * 9;
    const x = (t[b] + t[b + 3] + t[b + 6]) / 3;
    const y = (t[b + 1] + t[b + 4] + t[b + 7]) / 3;
    const z = (t[b + 2] + t[b + 5] + t[b + 8]) / 3;
    const id = this.cellAt(x, y, z);
    for (let p = 0; p < 9; p += 3)
      this.union(id, this.cellAt(t[b + p], t[b + p + 1], t[b + p + 2]));
    const box = this.boxes[id];
    for (let p = 0; p < 9; p += 3) {
      for (let k = 0; k < 3; k++) {
        box[k] = Math.min(box[k], t[b + p + k]);
        box[k + 3] = Math.max(box[k + 3], t[b + p + k]);
      }
    }
    this.counts[id]++;
  }

  private cellAt(x: number, y: number, z: number): number {
    const cx = Math.floor((x - this.lo[0]) / this.cell) + 1;
    const cy = Math.floor((y - this.lo[1]) / this.cell) + 1;
    const cz = Math.floor((z - this.lo[2]) / this.cell) + 1;
    const key = (cx * this.sy + cy) * this.sz + cz;
    const found = this.cells.get(key);
    if (found !== undefined) return found;
    const id = this.parent.length;
    this.cells.set(key, id);
    this.parent.push(id);
    this.boxes.push([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    this.counts.push(0);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const other = this.cells.get(((cx + dx) * this.sy + cy + dy) * this.sz + cz + dz);
          if (other !== undefined) this.union(id, other);
        }
      }
    }
    return id;
  }

  private find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  private union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }

  /** Largest first; ties nearest the origin first, so the order is stable. */
  regions(): Region[] {
    const byRoot = new Map<number, Region>();
    for (let id = 0; id < this.parent.length; id++) {
      if (this.counts[id] === 0) continue;
      const root = this.find(id);
      const box = this.boxes[id];
      const region = byRoot.get(root);
      if (!region) {
        byRoot.set(root, {
          min: [box[0], box[1], box[2]],
          max: [box[3], box[4], box[5]],
          triangles: this.counts[id],
        });
        continue;
      }
      for (let k = 0; k < 3; k++) {
        region.min[k] = Math.min(region.min[k], box[k]);
        region.max[k] = Math.max(region.max[k], box[k + 3]);
      }
      region.triangles += this.counts[id];
    }
    const centre = (r: Region) => Math.hypot(...r.min.map((v, k) => (v + r.max[k]) / 2));
    return [...byRoot.values()].sort((p, q) => q.triangles - p.triangles || centre(p) - centre(q));
  }
}
