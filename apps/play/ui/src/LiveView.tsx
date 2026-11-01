/**
 * The game in the pane (design §4): the box the game window is placed over,
 * and the live strip under it.
 *
 * The box only reports where it is; the backend places the window. It sends
 * `play/embed-rect` in window CSS pixels whenever the box moves or resizes,
 * the shell's report of the iframe moves, or what covers it changes, at most
 * once a frame. Nothing of Veistra's may sit inside the box while the game
 * is shown (§4.3, the game paints above the WebView), so when an overlay
 * covers it, or live mark up is drawing on it, the window is hidden and the
 * box shows the game's last frame as a still instead.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { MarkupExport } from "@veistra/markup/layer";
import { clock } from "./frames";
import { boxInWindow, covered, sameRect, type WindowRect } from "./geometry";
import { embedRect, still, type LogLine, type Rect, type Session } from "./rpc";

const FrameMarkup = lazy(() => import("./FrameMarkup"));

export interface LiveMarking {
  url: string;
  /** The captured frame's own size: the game's viewport, for picking. */
  natural: { width: number; height: number };
}

export interface LiveViewProps {
  session: Session | null;
  running: boolean;
  lines: LogLine[];
  frameRect: WindowRect | null;
  overlays: WindowRect[];
  /** Something of the pane's own is open over the box (a picker, a dialog). */
  coveredHere: boolean;
  /** This pane is in review, or otherwise not showing the game. */
  hidden: boolean;
  marking: LiveMarking | null;
  hint: string;
  onMarkupDone: (result: MarkupExport, shown: { width: number; height: number }) => void;
  onMarkupCancel: () => void;
  onProblem: (message: string) => void;
}

export function LiveView(props: LiveViewProps) {
  const { session, frameRect, overlays, coveredHere, hidden, marking } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const last = useRef<{ rect: Rect | null; visible: boolean; window?: string }>({
    rect: null,
    visible: false,
  });
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [measured, setMeasured] = useState(0);
  const embedded = session?.embed.kind === "embedded";

  // Re-measure when the box resizes; a move without a resize comes in as a new frameRect.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setMeasured((m) => m + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rect = (() => {
    const el = box.current;
    if (!el || !frameRect) return null;
    const r = el.getBoundingClientRect();
    return boxInWindow(frameRect, r);
  })();
  const coveredNow = coveredHere || (rect !== null && covered(rect, overlays));
  const visible =
    !hidden && !coveredNow && marking === null && rect !== null && rect.w > 0 && rect.h > 0;

  // One report a frame at most, and only when something changed.
  useEffect(() => {
    if (!rect) return;
    const frame = requestAnimationFrame(() => {
      const prev = last.current;
      if (
        sameRect(prev.rect, rect) &&
        prev.visible === visible &&
        prev.window === frameRect?.window
      )
        return;
      last.current = { rect, visible, window: frameRect?.window };
      void embedRect(rect, visible, frameRect?.window).catch(() => undefined);
    });
    return () => cancelAnimationFrame(frame);
    // `measured` is what re-runs this after a resize the props did not see.
  }, [rect?.x, rect?.y, rect?.w, rect?.h, visible, frameRect?.window, measured]); // eslint-disable-line react-hooks/exhaustive-deps

  // While covered, the game's last frame stands in for it.
  const wantStill = embedded && props.running && coveredNow && marking === null && !hidden;
  useEffect(() => {
    if (!wantStill) return;
    let live = true;
    still()
      .then(({ png }) => {
        if (!live) return;
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setStillUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wantStill]);
  useEffect(
    () => () => {
      if (stillUrl) URL.revokeObjectURL(stillUrl);
    },
    [stillUrl],
  );

  return (
    <div className="pl-live__viewport">
      <div className="pl-live__box" ref={box} data-embedded={embedded || undefined}>
        {marking ? (
          <Suspense fallback={null}>
            <FrameMarkup
              src={marking.url}
              path="live frame"
              onDone={props.onMarkupDone}
              onCancel={props.onMarkupCancel}
              onProblem={props.onProblem}
            />
          </Suspense>
        ) : embedded && props.running ? (
          coveredNow && stillUrl ? (
            <img className="pl-live__still" src={stillUrl} alt="The game's last frame" />
          ) : (
            <span className="pl-sr">The game is shown here.</span>
          )
        ) : (
          <LogView lines={props.lines} hint={props.hint} />
        )}
      </div>
    </div>
  );
}

/** The log, where the game is not in the pane: its own window, or not running. */
export function LogView({ lines, hint }: { lines: LogLine[]; hint: string }) {
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  if (lines.length === 0) return <p className="pl-hint">{hint}</p>;
  return (
    <div className="pl__log" role="log" aria-label="Game output">
      {lines.map((l) => (
        <div key={l.seq} className={`pl__line pl__line--${l.level}`}>
          {l.text}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export interface LiveStripProps {
  session: Session | null;
  running: boolean;
  recordOn: boolean;
  errors: LogLine[];
  now: number;
  canCapture: boolean;
  onStopAndReview: () => void;
  onCapture: () => void;
}

/** Under the game: the take so far, its marks and errors, and Stop and review (Main board). */
export function LiveStrip(props: LiveStripProps) {
  const { session, running } = props;
  const take = session?.take;
  const recording = take?.state === "recording";
  const zero = session?.zero ?? props.now;
  const elapsed = Math.max(0, props.now - zero);
  const span = Math.max(elapsed, 1);
  const pos = (t: number) => `${Math.min(100, Math.max(0, ((t - zero) / span) * 100))}%`;
  const marks = session?.marks ?? [];
  const errors = props.errors.filter((l) => l.at >= zero);
  const where = session?.embed;

  if (running && recording) {
    return (
      <div className="pl-strip">
        <span className="pl-strip__rec">
          <span className="pl-strip__dot" aria-hidden="true" />
          <span className="pl-strip__clock">{clock(elapsed)}</span>
          <span>Take {take.number}</span>
        </span>
        <div className="pl-strip__bar" aria-label="This run so far">
          {errors.map((l) => (
            <span
              key={l.seq}
              className="pl-strip__error"
              style={{ left: pos(l.at) }}
              title={`Error: ${l.text}`}
            />
          ))}
          {marks.map((t) => (
            <span
              key={t}
              className="pl-strip__mark"
              style={{ left: pos(t) }}
              title={`Your mark at ${clock(t - zero)}`}
            />
          ))}
        </div>
        <span className="pl-strip__counts">
          {marks.length} {marks.length === 1 ? "mark" : "marks"} · {errors.length}{" "}
          {errors.length === 1 ? "error" : "errors"}
        </span>
        <button
          type="button"
          className="k-btn k-btn--primary k-btn--sm"
          title="Stop the game and open this take for review (F7)"
          onClick={props.onStopAndReview}
        >
          Stop and review
        </button>
      </div>
    );
  }

  const message = !running
    ? "Not running."
    : where?.kind === "ownWindow"
      ? where.reason
      : where?.kind === "poppedOut"
        ? "Popped out into its own window. Dock brings it back."
        : take?.state === "failed"
          ? take.reason
          : take?.state === "starting"
            ? "Waiting for the game's window to start recording."
            : props.recordOn
              ? "Record is on; the next run is recorded."
              : "Turn on Record to keep this run and mark it up afterwards. Mark up still works on the live frame.";
  return (
    <div className="pl-strip">
      <span className="pl-strip__off">
        <span className="pl-strip__ring" aria-hidden="true" />
        {take?.state === "saving" ? "Saving take…" : "Not recording"}
      </span>
      <span className="pl-strip__message">{message}</span>
      {running && marks.length > 0 && (
        <span className="pl-strip__counts">
          {marks.length} {marks.length === 1 ? "mark" : "marks"}
        </span>
      )}
      <button
        type="button"
        className="k-btn k-btn--secondary k-btn--sm"
        disabled={!props.canCapture}
        title={
          props.canCapture
            ? "Capture this frame to comment on it or send it (Ctrl Shift C)"
            : "Capturing needs the capture addon and a running game."
        }
        onClick={props.onCapture}
      >
        Capture this frame
      </button>
    </div>
  );
}
