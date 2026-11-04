/**
 * Mark up in Blender's Editor mode: the shared markup tools over one capture
 * of Blender's 3D view. Blender's window paints above the page, so while the
 * person draws it is hidden and its capture stands in the box at the same size
 * (`useNativeBox`'s `hidden`).
 *
 * Built on `@veistra/markup`'s layer with an image host, the same as every
 * other viewer, so the output is the one `markup.png` + `markup.json` format
 * (`docs/markup-format.md`). Pins are placed bare; `pins.ts` names the object
 * under each after Done. Excalidraw is a lazy import, as in `MarkupScene`.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { imageHost } from "@veistra/markup";
import type { MarkupHost } from "@veistra/markup";
import type { MarkupController, MarkupExport } from "@veistra/markup/layer";
import { useTheme } from "../../../../shared/useTheme";

const MarkupLayer = lazy(() =>
  import("@veistra/markup/layer").then((m) => ({ default: m.MarkupLayer })),
);

export interface ViewportMarkupProps {
  /** An object URL of the capture. */
  src: string;
  /** What the markup JSON names as the picture. */
  path: string;
  onDone: (result: MarkupExport, shown: { width: number; height: number }) => void;
  onCancel: () => void;
  onProblem: (message: string) => void;
}

export default function ViewportMarkup({
  src,
  path,
  onDone,
  onCancel,
  onProblem,
}: ViewportMarkupProps) {
  const theme = useTheme();
  const box = useRef<HTMLDivElement | null>(null);
  const controller = useRef<MarkupController | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // The layer's coordinates are the shown picture's CSS pixels, so the host is
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
      pick: () => null,
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
    <div className="be-markup" ref={box}>
      <img
        className="be-markup__frame"
        src={src}
        alt="Blender's 3D view, being marked up"
        draggable={false}
      />
      {host && (
        <Suspense
          fallback={<p className="be__hint be-markup__loading">Loading the markup tools…</p>}
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
        className="be-markup__cancel k-btn k-btn--ghost k-btn--sm"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
