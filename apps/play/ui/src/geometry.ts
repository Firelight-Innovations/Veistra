/**
 * Where Play's game box is in the Veistra window, and whether anything the
 * shell draws is over it.
 *
 * `getBoundingClientRect()` inside this iframe is relative to the iframe; the
 * shell reports where the iframe is in the window over `veistra/window-rect`
 * (the same report `apps/projects` combines with its own rect for Plane), and
 * the sum is the box the backend places the game window on. Overlay boxes
 * (`veistra/overlays`) arrive in the same window space.
 */
import type { Rect } from "./rpc";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The window the iframe is in: `main`, or `win-<n>` for a popped-out one. */
  window?: string;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

export function isWindowRect(p: unknown): p is WindowRect {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    num(r.x) &&
    num(r.y) &&
    num(r.width) &&
    num(r.height) &&
    (r.window === undefined || typeof r.window === "string")
  );
}

/** The overlay boxes off a `veistra/overlays` payload; anything malformed is dropped. */
export function overlayRects(p: unknown): WindowRect[] {
  if (typeof p !== "object" || p === null) return [];
  const rects = (p as { rects?: unknown }).rects;
  return Array.isArray(rects) ? rects.filter(isWindowRect) : [];
}

/** The game box in window CSS pixels. */
export function boxInWindow(
  frame: WindowRect,
  local: { left: number; top: number; width: number; height: number },
): Rect {
  return { x: frame.x + local.left, y: frame.y + local.top, w: local.width, h: local.height };
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  );
}

/** Whether any overlay covers part of the game box. */
export function covered(box: Rect, overlays: readonly WindowRect[]): boolean {
  return overlays.some(
    (o) =>
      o.x < box.x + box.w && box.x < o.x + o.width && o.y < box.y + box.h && box.y < o.y + o.height,
  );
}
