/**
 * The arithmetic for a tab strip that scrolls sideways, kept out of the
 * components that wire it up — `panes/PaneTabStrip.tsx` and
 * `OverlayScrollbar.tsx` — so it can be tested without a layout engine.
 */

/** CSS pixels per line for a `deltaMode: 1` tick, which some wheels and OS
 *  settings report per notch; unscaled, a notch would move a pixel or two. 16
 *  is what browsers themselves use. A `deltaMode: 2` page is the strip's own
 *  width instead, since that is the axis the tick is redirected *into*. */
const WHEEL_LINE_PX = 16;

/**
 * How far a wheel tick should move `scrollLeft`, or `null` when `deltaX`
 * already dominates: a trackpad swipe or Shift+wheel, which the browser
 * scrolls natively, so redirecting as well would double it. A dead-even tick,
 * the all-zero one included, still redirects — a strip has no vertical
 * overflow to give it to.
 */
export function horizontalWheelDelta(
  el: { clientWidth: number },
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): number | null {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return null;
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * el.clientWidth;
  return deltaY;
}

/** Horizontal extent in viewport pixels, as `getBoundingClientRect` gives it. */
export interface Span {
  left: number;
  right: number;
}

/**
 * The `scrollLeft` that shows all of `tab` while moving as little as possible —
 * `scrollIntoView({ inline: "nearest" })`'s rule; why not that call itself is
 * at `useStripScroll` in PaneTabStrip.tsx. A tab wider than the view lines up
 * with its left edge, so its icon and the start of its label are what show.
 */
export function revealScrollLeft(view: Span & { scrollLeft: number }, tab: Span): number {
  if (tab.left < view.left || tab.right - tab.left > view.right - view.left) {
    return view.scrollLeft - (view.left - tab.left);
  }
  if (tab.right > view.right) return view.scrollLeft + (tab.right - view.right);
  return view.scrollLeft;
}
