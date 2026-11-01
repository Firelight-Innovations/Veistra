/**
 * Which of the shell's overlays are open, and where: menus, the Ctrl K
 * palette, search, dialogs, tooltips, toasts and a dragged tab.
 *
 * A native window placed over a pane (Play's game, design §4.3) paints above
 * the WebView, so anything the shell draws over that pane would be hidden
 * under it. The fix is the pane's: it swaps the game for its last frame while
 * an overlay covers it. What the shell owes it is this, the overlays' boxes in
 * window coordinates, so the pane can tell an overlay over its game from one
 * across the window.
 *
 * Found in the DOM by role and class rather than registered by each
 * component. The alternative, a hook every overlay calls, would be a promise
 * every future menu has to remember to keep; a role is something an
 * accessible overlay already has. The cost is a query per animation frame
 * after a DOM change, and only while something is listening.
 */

/** What counts as an overlay. A role an overlay already carries, or a class for the two that have none. */
export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  ".drag-ghost",
  ".library__toasts",
  "[data-overlay]",
].join(", ");

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
        new CustomEvent(now.length > 0 ? "veistra:overlay-open" : "veistra:overlay-close"),
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
    attributeFilter: ["role", "class", "style", "hidden", "open", "aria-hidden"],
  });
  doc.defaultView?.addEventListener("resize", schedule);
  schedule();
  return () => {
    observer.disconnect();
    doc.defaultView?.removeEventListener("resize", schedule);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
