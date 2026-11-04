/**
 * The review timeline: six lanes over one time axis, top to bottom Frames,
 * Notes, Marks, Log, Scenes and Frame time (design §8.2, the PlayReview
 * board). Clicking or dragging anywhere on the lanes moves the playhead.
 * Everything is positioned as a percentage of the take's length, so the
 * lanes need no measuring and stay lined up at any width.
 */
import { useRef } from "react";
import type { Status } from "../../../../shared/comments";
import { clock } from "./frames";
import type { LogRow } from "./notes";

export interface LaneNote {
  n: number;
  atMs: number;
  inMs?: number;
  outMs?: number;
  status: Status | "draft";
}

export interface TimelineProps {
  durationMs: number;
  playheadMs: number;
  range: { inMs: number | null; outMs: number | null };
  /** Filmstrip frames, one every `stripEveryMs`; holes are frames still being made. */
  thumbs: string[];
  stripEveryMs: number;
  notes: LaneNote[];
  /** Marks in take time, and whether each is a note yet. */
  marks: { ms: number; made: boolean }[];
  log: LogRow[];
  scenes: { path: string; fromMs: number; toMs: number }[];
  frames: { ms: number; frameMs: number }[];
  selected: number | null;
  onSeek: (ms: number) => void;
  onPickNote: (n: number) => void;
}

/** The dashed line on the frame-time lane: a 30 fps budget. */
const BUDGET_MS = 33;

const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function Timeline(props: TimelineProps) {
  const { durationMs, playheadMs, range, thumbs, notes, marks, log, scenes, frames } = props;
  const lanes = useRef<HTMLDivElement | null>(null);
  const d = Math.max(1, durationMs);
  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), d) / d) * 100}%`;

  const seekAt = (clientX: number) => {
    const el = lanes.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    props.onSeek(((clientX - r.left) / r.width) * d);
  };

  const ticks = Array.from({ length: Math.floor(d / 30_000) + 1 }, (_, i) => i * 30_000);
  const flagged = log.filter((r) => r.level !== "info");
  const maxFrame = Math.max(BUDGET_MS * 1.5, ...frames.map((f) => f.frameMs));
  const line = frames
    .map(
      (f) => `${((f.ms / d) * 1000).toFixed(1)},${(26 - (f.frameMs / maxFrame) * 24).toFixed(1)}`,
    )
    .join(" ");
  const inMs = range.inMs;
  const outMs = range.outMs;
  // Each frame sits over the 2 s it stands for, the last one over what is
  // left, so the strip matches the playhead while frames are still arriving.
  const every = Math.max(1, props.stripEveryMs);
  const slots = Array.from({ length: Math.ceil(d / every) }, (_, i) => i * every);

  return (
    <div className="pl-tl" aria-label="Timeline">
      <div className="pl-tl__labels" aria-hidden="true">
        <span className="pl-tl__label pl-tl__label--ruler" />
        <span className="pl-tl__label pl-tl__label--frames">FRAMES</span>
        <span className="pl-tl__label pl-tl__label--notes">NOTES</span>
        <span className="pl-tl__label pl-tl__label--marks">MARKS</span>
        <span className="pl-tl__label pl-tl__label--log">LOG</span>
        <span className="pl-tl__label pl-tl__label--scenes">SCENES</span>
        <span className="pl-tl__label pl-tl__label--ft">FRAME TIME</span>
      </div>
      <div
        className="pl-tl__lanes"
        ref={lanes}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekAt(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seekAt(e.clientX);
        }}
      >
        <div className="pl-tl__ruler">
          {ticks.map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              {clock(t)}
            </span>
          ))}
        </div>
        <div className="pl-tl__frames">
          {slots.map((ms, i) => (
            <span
              key={ms}
              className="pl-tl__thumb"
              style={{ left: pct(ms), width: pct(Math.min(every, d - ms)) }}
            >
              {thumbs[i] && <img src={thumbs[i]} alt="" draggable={false} />}
            </span>
          ))}
        </div>
        <div className="pl-tl__lane pl-tl__lane--notes">
          {notes.map((n) =>
            n.inMs !== undefined && n.outMs !== undefined && n.outMs > n.inMs ? (
              <span
                key={`r${n.n}`}
                className="pl-tl__range"
                style={{ left: pct(n.inMs), width: pct(n.outMs - n.inMs) }}
              />
            ) : null,
          )}
          {notes.map((n) => (
            <button
              key={n.n}
              type="button"
              className={`pl-tl__note pl-tl__note--${n.status}${props.selected === n.n ? " pl-tl__note--selected" : ""}`}
              style={{ left: pct(n.atMs) }}
              title={`Note ${n.n} at ${clock(n.atMs)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => props.onPickNote(n.n)}
            >
              {n.n}
            </button>
          ))}
        </div>
        <div className="pl-tl__lane pl-tl__lane--marks">
          {marks.map((m) => (
            <span
              key={m.ms}
              className={`pl-tl__mark${m.made ? " pl-tl__mark--made" : ""}`}
              style={{ left: pct(m.ms) }}
              title={`Mark at ${clock(m.ms)}${m.made ? ", now a note" : ", not a note yet"}`}
            />
          ))}
        </div>
        <div className="pl-tl__lane pl-tl__lane--log">
          {flagged.map((r, i) => (
            <span
              key={i}
              className={`pl-tl__log pl-tl__log--${r.level}`}
              style={{ left: pct(r.ms) }}
              title={`${r.level === "error" ? "Error" : "Warning"} at ${clock(r.ms)}: ${r.text}`}
            />
          ))}
        </div>
        <div className="pl-tl__scenes">
          {scenes.map((s, i) => (
            <span
              key={`${s.path}-${i}`}
              className={`pl-tl__scene${i === 0 ? " pl-tl__scene--first" : ""}`}
              style={{ left: pct(s.fromMs), width: pct(s.toMs - s.fromMs) }}
              title={s.path}
            >
              {leaf(s.path)}
            </span>
          ))}
        </div>
        <div className="pl-tl__lane pl-tl__lane--ft">
          <svg
            viewBox="0 0 1000 26"
            preserveAspectRatio="none"
            role="img"
            aria-label="Frame time over the take"
          >
            <line
              className="pl-tl__budget"
              x1="0"
              x2="1000"
              y1={26 - (BUDGET_MS / maxFrame) * 24}
              y2={26 - (BUDGET_MS / maxFrame) * 24}
            />
            {line && <polyline className="pl-tl__ft" points={line} />}
          </svg>
        </div>
        {inMs !== null && outMs !== null && outMs > inMs ? (
          <div
            className="pl-tl__selection"
            aria-hidden="true"
            style={{ left: pct(inMs), width: pct(outMs - inMs) }}
          />
        ) : (
          // One end set so far: show it, or I looks as if it did nothing.
          <>
            {inMs !== null && (
              <div className="pl-tl__in" aria-hidden="true" style={{ left: pct(inMs) }} />
            )}
            {outMs !== null && (
              <div className="pl-tl__out" aria-hidden="true" style={{ left: pct(outMs) }} />
            )}
          </>
        )}
        <div className="pl-tl__playhead" aria-hidden="true" style={{ left: pct(playheadMs) }} />
      </div>
    </div>
  );
}
