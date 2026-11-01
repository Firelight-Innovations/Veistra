/**
 * The shell's own surfaces: which apps get loaded, and which full-window
 * screens get opened.
 *
 * Reported from the chokepoints rather than from every button that leads to
 * them — `ToolWindow`'s handshake for an app, the `*Surface.ts` modules for a
 * screen — so a new way in is counted without anyone remembering to.
 */
import { defineFeature } from "../define";

export const shell = defineFeature({
  id: "shell",
  name: "Windows, panes and menus",
  events: ["app_loaded", "settings_opened", "shortcuts_opened", "library_opened"],
});
