/**
 * Whether the app library is open, and the two calls that change that.
 *
 * A module rather than a prop or a context, copying `settingsSurface.ts`
 * exactly — the same two halves mount independently, and the argument in
 * `docs/settings.md` §9 applies here unchanged.
 */
import { useEffect, useState } from "react";
import { shell } from "./telemetry/features";

export interface LibrarySurface {
  open: boolean;
}

// Module scope, and a `Set` rather than one callback, for the reason
// `settingsSurface.ts` gives: a detached pair mounts two screens, and a second
// subscriber replacing the first would leave one of them unable to close.
let surface: LibrarySurface = { open: false };
const subscribers = new Set<(surface: LibrarySurface) => void>();

function announce(next: LibrarySurface): void {
  surface = next;
  for (const subscriber of subscribers) subscriber(surface);
}

/** Show the library. Safe to call twice. */
export function openLibrary(): void {
  if (!surface.open) shell.track("library_opened");
  announce({ open: true });
}

/** Dismiss it. Safe to call when it is already dismissed. */
export function closeLibrary(): void {
  if (!surface.open) return;
  announce({ open: false });
}

/**
 * Whether the screen should be drawn. Seeded from the current value so a
 * component mounting while it is already open draws it on its first frame.
 */
export function useLibrarySurface(): LibrarySurface {
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
