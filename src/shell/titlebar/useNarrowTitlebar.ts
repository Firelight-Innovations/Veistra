/**
 * The responsive rules, measured.
 *
 * "Below roughly 1180px [the inline menu block and the centred title] collide
 * — collapse the six menu items into a single hamburger button." The spec
 * calls for `matchMedia` with a listener rather than a `ResizeObserver` on the
 * bar, so the collapse tracks the *window's* width — the thing the rule is
 * actually about — instead of the bar's, which would also change for reasons
 * that have nothing to do with the collision (a panel resize, for instance).
 *
 * The right-hand buttons fold into one overflow button the same way, first,
 * at 1440 (#336): `docs/design-notes/shell-chrome.md` has why that width.
 */
import { useEffect, useState } from "react";

/** Below this window width the six menus become the hamburger. */
export const MENUS_COLLAPSE_BELOW = 1180;

/** Below this window width the right-hand buttons become one overflow button. */
export const ACTIONS_COLLAPSE_BELOW = 1440;

/** Range syntax: `max-width: 1179px` would leave a 1179.5px window (125% scaling) wide. */
function narrowerThan(px: number): string {
  return `(width < ${px}px)`;
}

function useWindowNarrowerThan(px: number): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowerThan(px)).matches);

  useEffect(() => {
    const mql = window.matchMedia(narrowerThan(px));
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [px]);

  return narrow;
}

/** Whether the menus are behind the hamburger. */
export function useNarrowTitlebar(): boolean {
  return useWindowNarrowerThan(MENUS_COLLAPSE_BELOW);
}

/** Whether the right-hand buttons are behind the overflow button. */
export function useCollapsedTitlebarActions(): boolean {
  return useWindowNarrowerThan(ACTIONS_COLLAPSE_BELOW);
}
