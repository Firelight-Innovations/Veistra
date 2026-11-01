/**
 * A take's `telemetry.jsonl` as the review page reads it: the ticks capture
 * addon v2 wrote ten times a second (`src-tauri/src/godot/telemetry.rs` has
 * the format). The page needs three things from them: the frame-time lane,
 * and the object under a pin drawn in review, which is the smallest tracked
 * box under the pin in the tick nearest the note (design §8.3.2).
 */
import type { Target } from "./notes";

export interface TrackedNode {
  path: string;
  type: string;
  /** Viewport pixels: x, y, width, height. */
  rect: [number, number, number, number];
  pos?: number[];
}

export interface Tick {
  /** Wall-clock milliseconds. */
  t: number;
  scene: string;
  frameMs?: number;
  /** The game's viewport size, which `rect`s are measured in. */
  viewport?: [number, number];
  nodes: TrackedNode[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function node(v: unknown): TrackedNode | null {
  if (!isRecord(v) || typeof v.path !== "string" || !Array.isArray(v.rect)) return null;
  const rect = v.rect.map(Number);
  if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) return null;
  return {
    path: v.path,
    type: typeof v.type === "string" ? v.type : "",
    rect: rect as [number, number, number, number],
    pos: Array.isArray(v.pos) ? v.pos.map(Number) : undefined,
  };
}

/** The ticks in a telemetry file, in order. Events and torn lines are skipped. */
export function parseTicks(text: string): Tick[] {
  const ticks: Tick[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"tick"')) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (!isRecord(v) || v.kind !== "tick" || typeof v.t !== "number") continue;
      const vp = Array.isArray(v.viewport) ? v.viewport.map(Number) : null;
      ticks.push({
        t: v.t,
        scene: typeof v.scene === "string" ? v.scene : "",
        frameMs: typeof v.frameMs === "number" ? v.frameMs : undefined,
        viewport: vp && vp.length === 2 ? [vp[0], vp[1]] : undefined,
        nodes: (Array.isArray(v.nodes) ? v.nodes : [])
          .map(node)
          .filter((n): n is TrackedNode => n !== null),
      });
    } catch {
      // A half-written last line is normal: the addon flushes once a second.
    }
  }
  return ticks;
}

/** The tick closest to `wallMs`, if one is within `withinMs`. Ticks are in time order. */
export function nearestTick(ticks: readonly Tick[], wallMs: number, withinMs = 1000): Tick | null {
  let lo = 0;
  let hi = ticks.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].t < wallMs) lo = mid + 1;
    else hi = mid;
  }
  const best = [ticks[lo], ticks[lo - 1]]
    .filter((t): t is Tick => t !== undefined)
    .sort((a, b) => Math.abs(a.t - wallMs) - Math.abs(b.t - wallMs))[0];
  return best && Math.abs(best.t - wallMs) <= withinMs ? best : null;
}

/**
 * The smallest tracked box under a point. `x` and `y` are in the displayed
 * frame's pixels, `shown` is that frame's size; the tick's boxes are in the
 * game's viewport pixels, so the point is scaled into them first.
 */
export function recordedTarget(
  tick: Tick | null,
  x: number,
  y: number,
  shown: { width: number; height: number },
): Target | null {
  if (!tick || shown.width <= 0 || shown.height <= 0) return null;
  const [vw, vh] = tick.viewport ?? [shown.width, shown.height];
  const px = (x / shown.width) * vw;
  const py = (y / shown.height) * vh;
  let best: TrackedNode | null = null;
  for (const n of tick.nodes) {
    const [rx, ry, rw, rh] = n.rect;
    if (px < rx || py < ry || px > rx + rw || py > ry + rh) continue;
    if (!best || rw * rh < best.rect[2] * best.rect[3]) best = n;
  }
  if (!best) return null;
  const pos = best.pos && best.pos.length === 2 ? [best.pos[0], best.pos[1], 0] : best.pos;
  return {
    nodePath: best.path,
    type: best.type || undefined,
    worldPoint: pos ?? null,
    source: "recorded",
  };
}

/** Frame time against take time, for the lane. */
export function frameSeries(
  ticks: readonly Tick[],
  zero: number,
): { ms: number; frameMs: number }[] {
  return ticks
    .filter((t) => t.frameMs !== undefined)
    .map((t) => ({ ms: t.t - zero, frameMs: t.frameMs as number }));
}
