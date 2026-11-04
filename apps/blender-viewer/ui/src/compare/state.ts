/**
 * Compare's rules, free of React so each is tested on its own: which two
 * versions it opens on, how a version reads in a picker, which change Next
 * change frames, which notes are A's, and what changed in a part's materials.
 */
import { formatRenderAge } from "../../../../shared/age";
import type { Comment } from "../../../../shared/comments";
import type { ChangeClass } from "@veistra/scene-view";
import type { VersionEntry, VersionMaterial } from "../rpc";

export interface Picks {
  a: number;
  b: number;
}

/**
 * B is `b` when it is kept, else the newest. A is the version the person kept
 * when it is older than B, else the one just before B. `null` with fewer than
 * two versions, when there is nothing to compare.
 */
export function defaultPicks(
  versions: readonly VersionEntry[],
  kept: number | null,
  b?: number | null,
): Picks | null {
  const ns = versions.map((v) => v.n).sort((x, y) => y - x);
  if (ns.length < 2) return null;
  const bn = b != null && ns.includes(b) ? b : ns[0];
  const older = ns.filter((n) => n < bn);
  if (older.length === 0) return { a: bn, b: ns[ns.length - 2] };
  return { a: kept !== null && older.includes(kept) ? kept : older[0], b: bn };
}

/** `v5 · agent · 8c41e07 · 2h ago · 1,234 tris`, as the pickers list a version. */
export function versionLabel(v: VersionEntry, now: number = Date.now()): string {
  const bits = [`v${v.n}`, v.author];
  if (v.commit) bits.push(v.commit.slice(0, 7));
  bits.push(formatRenderAge(v.time, now).replace(/^rendered /, ""));
  if (v.triangles != null) bits.push(`${v.triangles.toLocaleString("en-US")} tris`);
  return bits.join(" · ");
}

export const ALL_SHOWN: Record<ChangeClass, boolean> = {
  added: true,
  changed: true,
  removed: true,
  unchanged: true,
};

export function toggleClass(
  shown: Record<ChangeClass, boolean>,
  cls: ChangeClass,
): Record<ChangeClass, boolean> {
  return { ...shown, [cls]: !shown[cls] };
}

/**
 * The region Next change frames from `at`, wrapping at either end; Shift+N
 * goes `back`. `-1` is "none framed yet", and stays so with no regions.
 */
export function stepRegion(at: number, count: number, back: boolean): number {
  if (count === 0) return -1;
  if (at < 0 || at >= count) return back ? count - 1 : 0;
  return (at + (back ? count - 1 : 1)) % count;
}

/**
 * The notes made on A that are still open: mesh notes on this `.blend` at or
 * before A's version. A note written before notes carried the file and the
 * version counts when its part is in A and it was written before B was made.
 */
export function notesFrom(
  comments: readonly Comment[],
  rel: string,
  a: VersionEntry,
  b: VersionEntry,
): Comment[] {
  const partsOfA = new Set(a.parts.map((p) => p.name));
  return comments.filter((c) => {
    if (c.status === "resolved" || c.anchor.kind !== "mesh") return false;
    const { blend, version, part } = c.anchor;
    if (blend !== undefined && blend !== rel) return false;
    if (version !== undefined) return version <= a.n;
    return partsOfA.has(part) && c.created <= b.time;
  });
}

const TOLERANCE = 1e-3;
const SCALARS = ["metallic", "roughness", "alpha"] as const;

const hex = (c: number[] | undefined) =>
  c
    ? `#${c
        .slice(0, 3)
        .map((x) =>
          Math.round(Math.min(1, Math.max(0, x)) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : "none";

function valueChanges(a: VersionMaterial, b: VersionMaterial): string[] {
  const out: string[] = [];
  const ca = a.color ?? [];
  const cb = b.color ?? [];
  if (ca.length !== cb.length || ca.some((x, i) => Math.abs(x - cb[i]) > TOLERANCE)) {
    out.push(`colour ${hex(a.color)} → ${hex(b.color)}`);
  }
  for (const key of SCALARS) {
    const x = a[key];
    const y = b[key];
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined || Math.abs(x - y) > TOLERANCE) {
      out.push(`${key} ${x ?? "none"} → ${y ?? "none"}`);
    }
  }
  return out;
}

/**
 * What changed in one part's materials from A to B (spec §12.1 item 6): a
 * material it gained or lost by name, or one it kept whose values moved.
 */
export function materialChanges(part: string, a: VersionEntry, b: VersionEntry): string[] {
  const namesA = a.parts.find((p) => p.name === part)?.materials ?? [];
  const namesB = b.parts.find((p) => p.name === part)?.materials ?? [];
  const out: string[] = [];
  for (const name of namesB) if (!namesA.includes(name)) out.push(`${name} added`);
  for (const name of namesA) if (!namesB.includes(name)) out.push(`${name} removed`);
  for (const name of namesB) {
    const ma = namesA.includes(name) ? a.materials.find((m) => m.name === name) : undefined;
    const mb = b.materials.find((m) => m.name === name);
    if (!ma || !mb) continue;
    const moved = valueChanges(ma, mb);
    if (moved.length > 0) out.push(`${name}: ${moved.join(", ")}`);
  }
  return out;
}
