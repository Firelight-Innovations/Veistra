/**
 * The shared markup tools over one still frame: a frame of a take in review,
 * the live frame the addon captured (design §7, §8), or the Godot editor's
 * viewport (#316).
 *
 * Built on `@veistra/markup`'s layer with an image host, the same as every
 * other viewer, so the output is the one `markup.png` + `markup.json` format
 * (`docs/markup-format.md`). What Play adds is `pick`: in review, the object
 * under a pin comes from the take's recorded boxes; live and in the editor,
 * there is no synchronous answer (the ray cast is a file round trip), so pins
 * are placed bare and the caller asks the game or the editor after Done.
 *
 * Excalidraw is a lazy import, as in `MarkupScene`, so the review page does
 * not pay for it until someone draws.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { imageHost } from "@veistra/markup";
import type { MarkupHost, PickHit } from "@veistra/markup";
import type { MarkupController, MarkupExport } from "@veistra/markup/layer";
import "./frame-markup.css";

const MarkupLayer = lazy(() =>
  import("@veistra/markup/layer").then((m) => ({ default: m.MarkupLayer })),
);

export interface FrameMarkupProps {
  /** An object URL of the frame. */
  src: string;
  /** What the markup JSON names as the frame. */
  path: string;
  /** The node under a point of the shown frame, when it can be told at once. */
  pick?: (x: number, y: number, shown: { width: number; height: number }) => PickHit | null;
  onDone: (result: MarkupExport, shown: { width: number; height: number }) => void;
  onCancel: () => void;
  onProblem: (message: string) => void;
}

function useTheme(): "dark" | "light" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"dark" | "light">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export default function FrameMarkup({
  src,
  path,
  pick,
  onDone,
  onCancel,
  onProblem,
}: FrameMarkupProps) {
  const theme = useTheme();
  const box = useRef<HTMLDivElement | null>(null);
  const controller = useRef<MarkupController | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const pickRef = useRef(pick);
  pickRef.current = pick;

  // The layer's coordinates are the shown frame's CSS pixels, so the host is
  // made once the box has a size and told when it changes.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ width: r.width, height: r.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ready = size !== null;
  const host = useMemo<MarkupHost | null>(() => {
    if (!ready || !sizeRef.current) return null;
    const image = imageHost(src, { path, size: sizeRef.current });
    return {
      capture: () => image.capture(),
      size: () => sizeRef.current ?? image.size(),
      describe: () => image.describe(),
      pick: (x, y) => pickRef.current?.(x, y, sizeRef.current ?? image.size()) ?? null,
    };
  }, [src, path, ready]);

  const finish = (active: boolean) => {
    if (active) return;
    const layer = controller.current;
    const shown = sizeRef.current;
    if (!layer || !shown) {
      onCancel();
      return;
    }
    layer
      .exportMarkup()
      .then((result) => onDone(result, shown))
      .catch((e: unknown) => {
        onProblem(`Couldn't keep the markup: ${e instanceof Error ? e.message : String(e)}`);
        onCancel();
      });
  };

  return (
    <div className="pl-markup" ref={box}>
      <img
        className="pl-markup__frame"
        src={src}
        alt="The frame being marked up"
        draggable={false}
      />
      {host && (
        <Suspense
          fallback={<p className="pl-hint pl-markup__loading">Loading the markup tools…</p>}
        >
          <MarkupLayer
            host={host}
            theme={theme}
            active
            onActiveChange={finish}
            onController={(c) => {
              controller.current = c;
            }}
          />
        </Suspense>
      )}
      <button
        type="button"
        className="pl-markup__cancel k-btn k-btn--ghost k-btn--sm"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
