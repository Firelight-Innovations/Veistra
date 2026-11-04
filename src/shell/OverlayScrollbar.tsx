/**
 * A hover-revealed scrollbar that floats over a horizontally-scrolling strip
 * instead of reserving track space at its edge. The two strips it draws for —
 * `.panel__tabs-strip` and `.switcher__tabs` — hide their native scrollbar
 * outright (see the comments beside `scrollbar-width: none` in panel.css and
 * switcher.css for why that property specifically); what replaces it is a
 * `motion.div` thumb, sized and positioned by hand from the container's own
 * `scrollLeft`/`scrollWidth`/`clientWidth`, which framer-motion can fade.
 *
 * This component draws only the thumb, never the scroll container: the element
 * with `overflow-x: auto` stays the caller's, reached only through `targetRef`,
 * because a thumb that *was* its child would scroll away with the content. The
 * caller owns *where* this JSX mounts — an ancestor box sized to exactly the
 * strip it tracks, that is not itself the thing that scrolls.
 *
 * The thumb is draggable, redirects a plain wheel's `deltaY` into `scrollLeft`,
 * and tracks hover by rect rather than `pointerenter`. Reasons for all three,
 * and why it needs no `useDrag.tsx` coordination: `docs/design-notes/shell-core.md`.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { instant, instantOut } from "./motion";
import { horizontalWheelDelta } from "./stripScroll";
import "./overlayScrollbar.css";

/**
 * How long the thumb stays up after the last scroll event, if the pointer
 * isn't over the strip to keep it up on its own. Picked from the middle of
 * the "a couple hundred ms to just over half a second" range VS Code's own
 * overlay scrollbar uses — the reference the visual spec names — since there
 * is no handoff crop for a scrollbar's own timing to measure against.
 */
const SCROLL_IDLE_MS = 700;

/**
 * Below this many pixels of `scrollWidth - clientWidth`, the strip counts as
 * not overflowing at all — the fix for a known bug, not a stylistic choice.
 *
 * `ClusterBar`'s `AnimatePresence mode="popLayout"` briefly extends the
 * row's scroll range while a tab or a cluster's members animate out (see the
 * comments on `fade` and around the `popLayout` blocks in `ClusterBar.tsx`).
 * That used to flash the native scrollbar on for exactly one of those
 * transients. A 2px floor treats sub-pixel layout rounding as "not
 * overflowing" without needing to know anything about *why* the transient
 * happened; a real overflow in a tab strip is never this small; the
 * narrowest tab in either row is well over 2px on its own.
 */
const OVERFLOW_EPSILON = 2;

export interface OverlayScrollbarProps {
  /**
   * The scroll container this thumb tracks — the element with
   * `overflow-x: auto`. Measured only; never rendered. See the file header
   * for why this component cannot render it.
   */
  targetRef: RefObject<HTMLElement | null>;
}

export default function OverlayScrollbar({ targetRef }: OverlayScrollbarProps) {
  // Null means "not overflowing" — the one state that must draw nothing,
  // which is also what keeps a mid-animation transient (see OVERFLOW_EPSILON
  // above) from ever having a rect to fade in with in the first place.
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    // `el`'s rect, cached rather than re-read on every `pointermove` — see
    // `onWindowPointerMove` below for why the naive version is a real cost here,
    // not a theoretical one. Kept alongside `measure`'s other reads because it
    // needs the same invalidation `measure` already has: `ResizeObserver` fires
    // whenever `el`'s own box changes size for *any* reason, `MutationObserver`
    // when its content does, and both already exist below — this rides along
    // rather than adding a third observer. Two cases that sound like gaps are
    // not, and the one thing this genuinely depends on (every bar these strips
    // sit in having a fixed height), are in `docs/design-notes/shell-core.md`.
    let rect: DOMRect | null = null;

    const measure = () => {
      rect = el.getBoundingClientRect();
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow < OVERFLOW_EPSILON) {
        setThumb(null);
        return;
      }
      setThumb({
        left: (el.scrollLeft / el.scrollWidth) * el.clientWidth,
        width: (el.clientWidth / el.scrollWidth) * el.clientWidth,
      });
    };

    measure();

    const onScroll = () => {
      measure();
      setScrolling(true);
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => setScrolling(false), SCROLL_IDLE_MS);
    };
    // Rect containment on `window` `pointermove` rather than
    // `pointerenter`/`pointerleave` on `el`; the file header says why.
    //
    // Reads the cache above rather than calling `getBoundingClientRect` itself,
    // and that is not a micro-optimisation: the call forces a synchronous style
    // and layout flush whenever the DOM is dirty, and in this shell it usually
    // is — framer-motion mid-flight on a `layoutId` handoff for much of any
    // interaction, and `useDrag` mutating the DOM through exactly the gestures
    // that fire `pointermove` hardest. Even coalesced to once a frame that is
    // the same class of jank this component exists to remove. Reading the cache
    // costs a property lookup, and setting the same boolean is a no-op render
    // under React's `Object.is` bail-out.
    const onWindowPointerMove = (ev: PointerEvent) => {
      if (!rect) return;
      setHovering(
        ev.clientX >= rect.left &&
          ev.clientX < rect.right &&
          ev.clientY >= rect.top &&
          ev.clientY < rect.bottom,
      );
    };
    // `pointermove` alone never fires again once the cursor leaves the
    // window outright — there is nothing left inside the document to move
    // over — which would leave `hovering` stuck true. `document`'s
    // `pointerleave` (unlike `el`'s, which this replaces) fires only when
    // the pointer leaves the whole viewport, covering exactly that gap.
    const onWindowPointerLeave = () => setHovering(false);

    // A plain mouse wheel reports only `deltaY` — there is no horizontal
    // scroll gesture on a mouse the way a trackpad's two-finger swipe or a
    // held Shift give one, and neither of those needs help: the browser
    // already drives `scrollLeft` from `deltaX` on its own. Redirecting
    // `deltaY` here (through `horizontalWheelDelta`, in `stripScroll.ts`) is
    // what lets a plain wheel scroll these strips at all, which is the whole
    // point of drawing a horizontal scrollbar for them.
    //
    // `{ passive: false }` because redirecting *is* calling
    // `preventDefault()`: left passive, the browser would still try to
    // scroll something vertically with the same event after this handler
    // returns (most likely nothing local, since there is nowhere for it to
    // go here, but possibly an ancestor) — a second reaction to a wheel tick
    // this handler already spent.
    const onWheel = (e: WheelEvent) => {
      const delta = horizontalWheelDelta(el, e.deltaX, e.deltaY, e.deltaMode);
      if (delta === null) return;
      el.scrollLeft += delta;
      e.preventDefault();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onWindowPointerMove);
    document.addEventListener("pointerleave", onWindowPointerLeave);

    // Catches the *container* resizing — the panel dragged wider, the window
    // resized, the search field collapsing and handing the row's width back.
    const resize = new ResizeObserver(measure);
    resize.observe(el);

    // Catches the *content* changing instead, which `ResizeObserver` on `el`
    // alone cannot see: `el`'s own box is fixed by the flex layout around
    // it, so a tab being added or removed changes `scrollWidth` without
    // changing anything a `ResizeObserver` on `el` reports. `subtree: true`
    // because a cluster's members sit two levels below `.switcher__tabs`
    // itself (a group, then a members list, then the member) — a tab or a
    // cluster opening, closing, or being renamed all land here.
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { childList: true, subtree: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onWindowPointerMove);
      document.removeEventListener("pointerleave", onWindowPointerLeave);
      resize.disconnect();
      mutations.disconnect();
      window.clearTimeout(idleTimer.current);
    };
  }, [targetRef]);

  // Pointer down on the thumb starts a drag; `scrollLeft` follows the
  // pointer directly rather than through `measure()`/`onScroll` — those still
  // fire (setting `scrollLeft` dispatches a native `scroll` event same as a
  // user scroll does), which is what keeps this thumb's own size and
  // position in sync with the drag and, after release, is what hands the
  // idle-fade countdown its normal `SCROLL_IDLE_MS` head start with no extra
  // code here for that part.
  //
  // Two listener mechanisms doing the one job, matching `useDrag.tsx`'s own
  // tab-drag gesture rather than inventing a second convention: capture is
  // what keeps events routed to this pointer once the cursor leaves the
  // thumb's own 5px band, which a drag does on its very first move off axis;
  // `window`-level `pointermove`/`pointerup`/`pointercancel` are what actually
  // consume them once that's true, since capture alone can silently fail (the
  // browser throws for a pointer id it no longer considers active) and
  // `useDrag.tsx` already established the guarded-try pattern for that.
  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = targetRef.current;
    if (!el) return;

    // No text selection, no native drag-image, and no bubbling to a chip
    // underneath — though the last of those is already moot: the thumb is
    // the pointerdown's actual target (see the file header), so there is no
    // chip handler in this event's path to reach regardless.
    e.preventDefault();
    e.stopPropagation();

    const thumbEl = e.currentTarget;
    try {
      thumbEl.setPointerCapture(e.pointerId);
    } catch {
      // Nothing to do; the window listeners below are the mechanism, this is
      // the optimisation. See the comment above.
    }

    const pointerId = e.pointerId;
    const startClientX = e.clientX;
    const startScrollLeft = el.scrollLeft;
    // Content pixels per pointer pixel, snapshotted once at the start of the
    // drag rather than recomputed on every move — the same ratio `measure()`
    // sizes and places the thumb with, inverted. A live recompute would feed
    // this drag's own `scrollLeft` writes (and the `measure()` they trigger)
    // back into the mapping mid-drag, which is exactly the kind of loop a
    // snapshot avoids.
    const contentPerTrackPx = el.scrollWidth / el.clientWidth;

    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const target = targetRef.current;
      if (!target) return;
      target.scrollLeft = startScrollLeft + (ev.clientX - startClientX) * contentPerTrackPx;
    };

    const endDrag = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      try {
        thumbEl.releasePointerCapture(pointerId);
      } catch {
        // Already released, or never captured — either way, nothing to do.
      }
      setDragging(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  };

  // The same redirection the effect above wires onto `el`, repeated here
  // because the thumb is `el`'s sibling rather than its descendant — a wheel
  // tick whose target is the thumb itself never bubbles to that listener.
  // Without this, spinning the wheel exactly over the visible scrollbar
  // (the most natural place to try it) would silently do nothing.
  const onThumbWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = targetRef.current;
    if (!el) return;
    const delta = horizontalWheelDelta(el, e.deltaX, e.deltaY, e.deltaMode);
    if (delta === null) return;
    el.scrollLeft += delta;
    e.preventDefault();
  };

  return (
    <AnimatePresence>
      {/* `dragging` is its own term rather than folded into `scrolling`: a
          drag that pauses without moving fires no `scroll` event to keep
          `scrolling`'s idle timer from expiring, and the thumb must not fade
          out from under a pointer that is still holding it down. */}
      {thumb && (hovering || scrolling || dragging) && (
        <motion.div
          className="overlay-scrollbar__thumb"
          data-dragging={dragging || undefined}
          style={{ left: thumb.left, width: thumb.width }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: instant }}
          exit={{ opacity: 0, transition: instantOut }}
          onPointerDown={onThumbPointerDown}
          onWheel={onThumbWheel}
          aria-hidden="true"
        />
      )}
    </AnimatePresence>
  );
}
