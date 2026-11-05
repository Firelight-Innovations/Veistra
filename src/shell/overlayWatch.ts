/**
 * Which of the shell's overlays are open, and where: menus, the Ctrl K
 * palette, search, dialogs and the scrims that dim the window behind them,
 * tooltips, toasts, a dragged tab and where it would drop, and the surfaces
 * that cover the whole tool window.
 *
 * A native window placed over a pane (the game, the Godot editor or Blender,
 * design §4.3 and §11.1) paints above the WebView, so anything the shell draws
 * over that pane would be hidden under it. The fix is the pane's: it swaps the
 * window for its last frame while an overlay covers it. What the shell owes it
 * is this, the overlays' boxes in window coordinates, so the pane can tell an
 * overlay over its box from one across the window.
 *
 * Found in the DOM by role and class rather than registered by each
 * component. The alternative, a hook every overlay calls, would be a promise
 * every future menu has to remember to keep; a role is something an
 * accessible overlay already has. The cost is a query per animation frame
 * after a DOM change, and only while something is listening.
 */
import { OVERLAY_CLOSE_EVENT, OVERLAY_OPEN_EVENT } from "@veistra/bridge/protocol";

/** What counts as an overlay. A role an overlay already carries, or the class or attribute of one with none. */
export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  ".drag-ghost",
  ".library__toasts",
  ".toolhealth__popover",
  ".hamburger__dropdown",
  // Every surface `MenuItemList` portals beside a row, a prompt field included.
  "[data-menu-surface]",
  // The scrims that dim the whole window behind a modal sheet. The sheet itself
  // is a dialog, but a game box it does not overlap (a lower or side pane)
  // would stay bright above the dimmed window without these.
  ".palette",
  ".k-dialog-scrim",
  ".settings__backdrop",
  ".shortcuts__backdrop",
  ".library__backdrop",
  // A tab dragged over a pane draws where it would drop over that whole pane.
  ".pane__drop",
  ".drag-hint",
  ".drag-detach-outline",
  // These two cover the whole tool window: a takeover (Home, Docs) and an
  // expanded rail page. Play stays its pane's active tab under them, so nothing
  // else tells it that it is hidden. Named here rather than marked with
  // `data-overlay` where drawn, which would be one more thing to remember.
  ".toolwindow__surface[data-solo]",
  ".frame__page-expanded",
  "[data-overlay]",
].join(", ");

/**
 * The attributes whose change can make an element match, or stop matching,
 * `OVERLAY_SELECTOR`. A takeover is a surface that gains `data-solo` in place,
 * and a watch that did not listen for it would miss the takeover opening.
 */
const WATCHED_ATTRIBUTES = [
  "role",
  "class",
  "style",
  "hidden",
  "open",
  "aria-hidden",
  "data-solo",
  "data-menu-surface",
  "data-overlay",
];

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The boxes of every open overlay under `root`, in its viewport's coordinates. */
export function visibleOverlays(root: ParentNode): OverlayRect[] {
  const out: OverlayRect[] = [];
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (el.closest("[hidden], [aria-hidden='true']")) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return out;
}

export function sameRects(a: readonly OverlayRect[], b: readonly OverlayRect[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (r, i) =>
        r.x === b[i].x && r.y === b[i].y && r.width === b[i].width && r.height === b[i].height,
    )
  );
}

/** Whether two boxes overlap by any area. */
export function intersects(a: OverlayRect, b: OverlayRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Call `onChange` with the open overlays whenever the set changes, and
 * dispatch `veistra:overlay-open` / `veistra:overlay-close` on `window` as the
 * first opens and the last closes. Answers the stop function.
 *
 * The rects are what an app frame gets (`OVERLAYS_EVENT`, from `ToolWindow`):
 * a cross-origin frame cannot hear the shell document's DOM events, and a
 * flag could not tell a menu over the box from one across the window. The DOM
 * events stay for listeners in the shell document.
 */
export function watchOverlays(
  onChange: (rects: OverlayRect[]) => void,
  doc: Document = document,
): () => void {
  let last: OverlayRect[] = [];
  let frame = 0;
  const check = () => {
    frame = 0;
    const now = visibleOverlays(doc.body);
    if (sameRects(now, last)) return;
    const was = last.length > 0;
    last = now;
    const view = doc.defaultView;
    if (view && was !== now.length > 0) {
      view.dispatchEvent(
        new CustomEvent(now.length > 0 ? OVERLAY_OPEN_EVENT : OVERLAY_CLOSE_EVENT),
      );
    }
    onChange(now);
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(check);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });
  doc.defaultView?.addEventListener("resize", schedule);
  schedule();
  return () => {
    observer.disconnect();
    doc.defaultView?.removeEventListener("resize", schedule);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
