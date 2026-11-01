/**
 * Whether the settings screen is open, and the two calls that change that.
 *
 * A module rather than a prop threaded through `WindowRoot`, and rather than a
 * context — `docs/settings.md` §9 has the argument.
 */
import { useEffect, useState } from "react";
import { shell } from "./telemetry/features";

export interface SettingsSurface {
  open: boolean;
  /**
   * Which section to land on, or `null` for the screen's first. A request,
   * not a selection: the screen falls back to its own first section when this
   * names one that is not registered, so a stale shortcut opens on something.
   */
  section: string | null;
}

// Module scope, because the two halves mount independently and neither is the
// other's parent. A `Set` rather than one callback: both windows of a detached
// pair mount their own screen, and a second subscriber replacing the first would
// leave one of them unable to close.
let surface: SettingsSurface = { open: false, section: null };
const subscribers = new Set<(surface: SettingsSurface) => void>();

function announce(next: SettingsSurface): void {
  surface = next;
  for (const subscriber of subscribers) subscriber(surface);
}

/** Show the settings screen, optionally on a named section. Safe to call twice. */
export function openSettings(section?: string): void {
  if (!surface.open) shell.track("settings_opened", { section: section ?? null });
  announce({ open: true, section: section ?? null });
}

/** Dismiss it. Safe to call when it is already dismissed. */
export function closeSettings(): void {
  if (!surface.open) return;
  // The request is kept, but nothing reads it while the screen is shut, and the
  // next `openSettings` replaces it. The screen also forgets what was picked in
  // its sidebar when it unmounts, so it reopens on its first section.
  announce({ open: false, section: surface.section });
}

/**
 * Whether the screen should be drawn, and where it should land. Seeded from the
 * current value, so a component mounting while settings is already open draws it
 * on its first frame instead of flashing the window behind it.
 */
export function useSettingsSurface(): SettingsSurface {
  const [current, setCurrent] = useState(surface);

  useEffect(() => {
    subscribers.add(setCurrent);
    // A subscriber that mounted between the announce and this effect would have
    // missed it. Cheap to re-read and impossible to get wrong.
    setCurrent(surface);
    return () => {
      subscribers.delete(setCurrent);
    };
  }, []);

  return current;
}
