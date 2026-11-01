/**
 * Whether the keyboard shortcuts screen is open, and the two calls that change
 * that.
 *
 * A module rather than a prop or a context, copying `librarySurface.ts` and
 * `settingsSurface.ts` exactly — the same two halves mount independently, and
 * the argument in `docs/settings.md` §9 applies here unchanged.
 */
import { useEffect, useState } from "react";
import { shell } from "./telemetry/features";

export interface ShortcutsSurface {
  open: boolean;
}

// Module scope, and a `Set` rather than one callback, for the reason
// `settingsSurface.ts` gives: a detached pair mounts two screens, and a second
// subscriber replacing the first would leave one of them unable to close.
let surface: ShortcutsSurface = { open: false };
const subscribers = new Set<(surface: ShortcutsSurface) => void>();

function announce(next: ShortcutsSurface): void {
  surface = next;
  for (const subscriber of subscribers) subscriber(surface);
}

/** Show the shortcuts. Safe to call twice. */
export function openShortcuts(): void {
  if (!surface.open) shell.track("shortcuts_opened");
  announce({ open: true });
}

/** Dismiss it. Safe to call when it is already dismissed. */
export function closeShortcuts(): void {
  if (!surface.open) return;
  announce({ open: false });
}

/**
 * Whether the screen should be drawn. Seeded from the current value so a
 * component mounting while it is already open draws it on its first frame.
 */
export function useShortcutsSurface(): ShortcutsSurface {
  const [current, setCurrent] = useState(surface);

  useEffect(() => {
    subscribers.add(setCurrent);
    setCurrent(surface);
    return () => {
      subscribers.delete(setCurrent);
    };
  }, []);

  return current;
}
