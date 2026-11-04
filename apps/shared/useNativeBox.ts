/**
 * A pane's box for a native window (design §4.2, §4.3 and §11.1): the game,
 * the Godot editor or Blender. The box only reports where it is; the backend
 * places the window over it.
 *
 * A report goes out when the box moves or resizes, the shell's report of the
 * iframe moves, the page's `devicePixelRatio` changes, or what covers the box
 * changes, at most once a frame and only when something changed. The window
 * paints above the WebView, so nothing of Veistra's may sit inside the box
 * while it shows: when a shell overlay or something of the pane's own covers
 * the box, the window is hidden and its last frame stands in for it.
 *
 * Unmounting hides the window, because whatever takes the box's place would be
 * under it. The page going away (its pane closed, a cluster switch reloading
 * the frame) runs no cleanup at all; the backend hides the window then from
 * the shell's state (`embed::host::sync_visibility`).
 */
import { useEffect, useRef, useState } from "react";
import { on } from "@veistra/bridge";
import { OVERLAYS_EVENT, WINDOW_RECT_EVENT } from "@veistra/bridge/protocol";
import {
  boxInWindow,
  covered as coveredBy,
  isWindowRect,
  overlayRects,
  sameRect,
  type Rect,
  type WindowRect,
} from "./nativeBox";

export interface NativeBoxOptions {
  /** Where the iframe is in its window (`veistra/window-rect`); `null` until the shell says. */
  frameRect: WindowRect | null;
  /** The shell's open overlays (`veistra/overlays`). */
  overlays: readonly WindowRect[];
  /** Something of the pane's own is open over the box (a picker, a dialog): the still stands in. */
  coveredHere?: boolean;
  /** The pane draws in the box itself (live mark up): the window is hidden and no still is shown. */
  hidden?: boolean;
  /** The window is in the pane and its process running, so a still is worth asking for. */
  placed: boolean;
  /** Tell the backend the box: `play/embed-rect` for the game, `embed/rect` for an editor. */
  report: (
    rect: Rect,
    visible: boolean,
    window: string | undefined,
    dpr: number,
  ) => Promise<unknown>;
  /** The window's last frame as base64 PNG: `play/still`, `embed/still`. */
  still?: () => Promise<{ png: string }>;
  /** Changes when the window does (a new run): a still of the old one is never shown. */
  generation?: string | number | null;
}

export interface NativeBox {
  /** For the box element. */
  ref: (el: HTMLElement | null) => void;
  rect: Rect | null;
  /** An overlay, or something of the pane's own, is over the box. */
  covered: boolean;
  /** What the backend was last asked: the window shown over the box. */
  visible: boolean;
  /** The last frame while covered, kept from the last cover until a newer one arrives. */
  stillUrl: string | null;
}

/** What the backend was last told, so an unchanged box is not sent again. */
interface Reported {
  rect: Rect | null;
  visible: boolean;
  window?: string;
  dpr?: number;
}

export function useNativeBox(options: NativeBoxOptions): NativeBox {
  const { frameRect, overlays, coveredHere = false, hidden = false, placed } = options;
  const generation = options.generation ?? null;
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [measured, setMeasured] = useState(0);
  const [still, setStill] = useState<{ url: string; of: string | number | null } | null>(null);
  const last = useRef<Reported>({ rect: null, visible: false });
  // The callbacks may be new on every render; the effects call the newest.
  const latest = useRef(options);
  latest.current = options;

  // Re-measure when the box resizes; a move without a resize comes in as a new frameRect.
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(() => setMeasured((m) => m + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  // A move to a monitor of another scale changes devicePixelRatio and nothing
  // measured in CSS pixels, so only this sees it. A resolution query matches
  // one ratio, so each change watches the next.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList | null = null;
    const changed = () => {
      setMeasured((m) => m + 1);
      watch();
    };
    const watch = () => {
      query?.removeEventListener("change", changed);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener("change", changed);
    };
    watch();
    return () => query?.removeEventListener("change", changed);
  }, []);

  // Leaving hides the window. The ref is cleared so a remount (StrictMode
  // rehearses one) sends the box again.
  useEffect(
    () => () => {
      const prev = last.current;
      last.current = { rect: null, visible: false };
      if (prev.rect && prev.visible) {
        const dpr = prev.dpr ?? window.devicePixelRatio;
        void latest.current.report(prev.rect, false, prev.window, dpr).catch(() => undefined);
      }
    },
    [],
  );

  const rect = el && frameRect ? boxInWindow(frameRect, el.getBoundingClientRect()) : null;
  const covered = coveredHere || (rect !== null && coveredBy(rect, overlays));
  const visible = !covered && !hidden && rect !== null && rect.w > 0 && rect.h > 0;

  useEffect(() => {
    if (!rect) return;
    const frame = requestAnimationFrame(() => {
      const prev = last.current;
      const dpr = window.devicePixelRatio;
      const win = frameRect?.window;
      if (
        sameRect(prev.rect, rect) &&
        prev.visible === visible &&
        prev.window === win &&
        prev.dpr === dpr
      )
        return;
      last.current = { rect, visible, window: win, dpr };
      void latest.current.report(rect, visible, win, dpr).catch(() => undefined);
    });
    return () => cancelAnimationFrame(frame);
    // `measured` is what re-runs this after a resize the props did not see.
  }, [rect?.x, rect?.y, rect?.w, rect?.h, visible, frameRect?.window, measured]); // eslint-disable-line react-hooks/exhaustive-deps

  const wantStill = placed && covered && !hidden;
  useEffect(() => {
    const fetchStill = latest.current.still;
    if (!wantStill || !fetchStill) return;
    let live = true;
    fetchStill()
      .then(({ png }) => {
        if (!live) return;
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setStill({ url, of: generation });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wantStill, generation]);
  useEffect(() => {
    if (!still) return;
    const { url } = still;
    return () => URL.revokeObjectURL(url);
  }, [still]);

  const stillUrl = still && still.of === generation ? still.url : null;
  return { ref: setEl, rect, covered, visible, stillUrl };
}

/**
 * Where this frame is in its window, and the shell's overlays, as the shell
 * pushes both to an app that declares `placesWindow` (`ToolWindow.tsx`).
 */
export function useShellPlacement(): { frameRect: WindowRect | null; overlays: WindowRect[] } {
  const [frameRect, setFrameRect] = useState<WindowRect | null>(null);
  const [overlays, setOverlays] = useState<WindowRect[]>([]);
  useEffect(() => {
    const offRect = on(WINDOW_RECT_EVENT, (p) => {
      if (isWindowRect(p)) setFrameRect(p);
    });
    const offOverlays = on(OVERLAYS_EVENT, (p) => setOverlays(overlayRects(p)));
    return () => {
      offRect();
      offOverlays();
    };
  }, []);
  return { frameRect, overlays };
}
