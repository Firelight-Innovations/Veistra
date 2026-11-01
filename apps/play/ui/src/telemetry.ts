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
  /** The longest frame since the tick before. */
  frameMs?: number;
  /** The game's viewport size, which `rect`s are measured in. */
  viewport?: [number, number];
  /** The game window's size in pixels: the frame a take records. */
  window?: [number, number];
  /**
   * Where that window shows the viewport, as x, y, width, height in window
   * pixels. Outside it are the bars a stretch setting that keeps the
   * viewport's aspect leaves.
   */
  content?: [number, number, number, number];
  nodes: TrackedNode[];
}

interface Size {
  width: number;
  height: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** `count` finite numbers whose last two are sizes above zero, or undefined. */
function sized(v: unknown, count: number): number[] | undefined {
  if (!Array.isArray(v) || v.length !== count) return undefined;
  const n = v.map(Number);
  return n.every(Number.isFinite) && n[count - 2] > 0 && n[count - 1] > 0 ? n : undefined;
}

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
      ticks.push({
        t: v.t,
        scene: typeof v.scene === "string" ? v.scene : "",
        frameMs: typeof v.frameMs === "number" ? v.frameMs : undefined,
        viewport: sized(v.viewport, 2) as Tick["viewport"],
        window: sized(v.window, 2) as Tick["window"],
        content: sized(v.content, 4) as Tick["content"],
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
 * A point on the shown frame in the viewport pixels the tick's boxes are in.
 * The frame is the recorded window, bars and all, so the point is placed in
 * the window and then in the box the window shows the viewport in; a point
 * on a bar lands outside the viewport. A tick without that box, from an
 * addon build before it was reported, is read as the viewport fitted into
 * the window at its own aspect and centred, which is what Godot draws for
 * every stretch setting except aspect "ignore".
 */
export function toViewport(tick: Tick, x: number, y: number, shown: Size): [number, number] {
  const [vw, vh] = tick.viewport ?? [shown.width, shown.height];
  const [ww, wh] = tick.window ?? [shown.width, shown.height];
  let box = tick.window && tick.content;
  if (!box) {
    const fit = Math.min(ww / vw, wh / vh);
    box = [(ww - vw * fit) / 2, (wh - vh * fit) / 2, vw * fit, vh * fit];
  }
  const [cx, cy, cw, ch] = box;
  const wx = (x / shown.width) * ww;
  const wy = (y / shown.height) * wh;
  return [((wx - cx) / cw) * vw, ((wy - cy) / ch) * vh];
}

/**
 * The smallest tracked box under a point. `x` and `y` are in the displayed
 * frame's pixels, `shown` is that frame's size; the tick's boxes are in the
 * game's viewport pixels, so the point is mapped into them first.
 */
export function recordedTarget(
  tick: Tick | null,
  x: number,
  y: number,
  shown: Size,
): Target | null {
  if (!tick || shown.width <= 0 || shown.height <= 0) return null;
  const [px, py] = toViewport(tick, x, y, shown);
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
