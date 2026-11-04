/**
 * What the change view is made of (spec §12.1). Two versions of one model are
 * split into parts by glTF node name, which for a Blender export is the
 * object's name, and each triangle of B is Added, Changed or Unchanged
 * against A. A's triangles that left no trace in B are Removed and drawn as
 * a ghost.
 */
import type { Vec3 } from "../markupHost";

export type ChangeClass = "added" | "changed" | "removed" | "unchanged";

/** In the order the legend lists them. */
export const CHANGE_CLASSES: readonly ChangeClass[] = ["added", "changed", "removed", "unchanged"];

export type Counts = Record<ChangeClass, number>;

/**
 * Corners within this many metres of A's are the same corner: a move under
 * 1 mm counts as unchanged. glTF is in metres.
 */
export const EPSILON = 0.001;

/** A triangle with an A triangle's centroid this close was edited, not made. */
export const DELTA = 0.05;

/** One part's triangles in world space, nine floats each. */
export interface PartTriangles {
  name: string;
  positions: Float32Array;
}

export type PartStatus = "added" | "removed" | "changed" | "unchanged";

export interface PartDiff {
  name: string;
  /** `added` and `removed` are parts in only one version. */
  status: PartStatus;
  counts: Counts;
  /** Over both versions' triangles, so framing a removed part works. */
  min: Vec3;
  max: Vec3;
}

/** A cluster of touching changes, which Next change moves the camera to. */
export interface Region {
  min: Vec3;
  max: Vec3;
  triangles: number;
}

export interface DiffResult {
  counts: Counts;
  /** Changed parts first, most changed triangles first; then the unchanged. */
  parts: PartDiff[];
  /**
   * Each class's triangles, nine floats each: B's for Added, Changed and
   * Unchanged, A's for Removed.
   */
  geometry: Record<ChangeClass, Float32Array>;
  /** Largest first. */
  regions: Region[];
  /** Spent in the diff itself, not in parsing. */
  ms: number;
}

export function zeroCounts(): Counts {
  return { added: 0, changed: 0, removed: 0, unchanged: 0 };
}
