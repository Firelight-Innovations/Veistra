/**
 * The game in the pane (design §4): the box the game window is placed over,
 * and the live strip under it.
 *
 * The box is `apps/shared/useNativeBox.ts`, the one the Godot editor and
 * Blender use too: it reports `play/embed-rect` at most once a frame, hides the
 * game while an overlay or something of the pane's own covers the box, and
 * shows the game's last frame (`play/still`) there instead. Live mark up draws
 * on the box itself, so the game is hidden then with no still.
 *
 * Opening review unmounts this, and the unmount hides the game. Keeping it
 * mounted under review with a `hidden` flag was the other way; it kept the
 * box's measuring, its still and the log running behind review for nothing.
 */
import { lazy, Suspense, useEffect, useRef } from "react";
import type { MarkupExport } from "@veistra/markup/layer";
import type { WindowRect } from "../../../../shared/nativeBox";
import { useNativeBox } from "../../../../shared/useNativeBox";
import { clock } from "./frames";
import { embedRect, still, type LogLine, type Session } from "./rpc";

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
  marking: LiveMarking | null;
  hint: string;
  onMarkupDone: (result: MarkupExport, shown: { width: number; height: number }) => void;
  onMarkupCancel: () => void;
  onProblem: (message: string) => void;
}

export function LiveView(props: LiveViewProps) {
  const { session, marking } = props;
  const embedded = session?.embed.kind === "embedded";
  const box = useNativeBox({
    frameRect: props.frameRect,
    overlays: props.overlays,
    coveredHere: props.coveredHere,
    hidden: marking !== null,
    placed: embedded && props.running,
    report: embedRect,
    still,
    generation: session?.runId ?? null,
  });

  return (
    <div className="pl-live__viewport">
      <div className="pl-live__box" ref={box.ref} data-embedded={embedded || undefined}>
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
          box.covered && box.stillUrl ? (
            <img className="pl-live__still" src={box.stillUrl} alt="The game's last frame" />
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
  /** Why Record cannot record here (no capture addon, or no recorder), whether it is on or off. */
  recordBlocked: string | null;
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
  // A game holding the mouse leaves nothing here to click, and the addon
  // forwards F7 from inside the game (spec §4.4), so the strip names the key.
  const captured = running && session?.mouseCaptured === true;

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
        {captured && <span className="pl-strip__hint">F7 stops and opens the take</span>}
        <button
          type="button"
          className="k-btn k-btn--primary k-btn--sm"
          title="Stop the game and open this take for review (F7)"
          onClick={props.onStopAndReview}
        >
          Stop and review <kbd className="pl-strip__kbd">F7</kbd>
        </button>
      </div>
    );
  }

  const message = !running
    ? "Not running."
    : captured
      ? "F7 stops the game."
      : where?.kind === "ownWindow"
        ? where.reason
        : where?.kind === "poppedOut"
          ? "Popped out into its own window. Dock brings it back."
          : take?.state === "failed"
            ? take.reason
            : take?.state === "starting"
              ? "Waiting for the game's window to start recording."
              : props.recordBlocked
                ? props.recordBlocked
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
      {running && (marks.length > 0 || errors.length > 0) && (
        <span className="pl-strip__counts">
          {marks.length} {marks.length === 1 ? "mark" : "marks"} · {errors.length}{" "}
          {errors.length === 1 ? "error" : "errors"}
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
