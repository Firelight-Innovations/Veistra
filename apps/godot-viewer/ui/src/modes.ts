/**
 * The Godot app's two modes, Editor and Play (owner decision 1 of the v0.2
 * design; `docs/design-notes/godot-play.md`, "One Godot app").
 *
 * A pane opens in the mode its URL names: the `play` id is an alias that opens
 * this app with `?mode=play` (`apps::entry_url`), and `scene`, the old name of
 * Editor, still means Editor. After that the pane's own choice wins, saved per
 * pane instance: a cluster switch unloads every frame and loads it afresh, and
 * a Play pane must come back in Play with its game, not in Editor over it.
 */
import type { GodotStatus } from "../../../shared/godot";
import type { ToolbarMode } from "../../../shared/ViewerToolbar";

export type GodotMode = "editor" | "play";

export const MODES: readonly { value: GodotMode; label: string }[] = [
  { value: "editor", label: "Editor" },
  { value: "play", label: "Play" },
];

/** The mode a frame's query string asks for; anything else is Editor. */
export function initialMode(search: string): GodotMode {
  return new URLSearchParams(search).get("mode") === "play" ? "play" : "editor";
}

const KEY = "godot.mode";

/**
 * The mode this pane instance last showed, or `null`. Every Godot frame shares
 * one origin and so one `localStorage`, hence the instance in the key; with no
 * instance (no shell) there is nothing to tell panes apart by, so nothing is
 * kept. Storage can throw (blocked, private), and remembering is a convenience.
 */
export function readMode(instanceId: string | null): GodotMode | null {
  if (!instanceId) return null;
  try {
    const saved = localStorage.getItem(`${KEY}.${instanceId}`);
    return saved === "play" || saved === "editor" ? saved : null;
  } catch {
    return null;
  }
}

export function writeMode(instanceId: string | null, mode: GodotMode): void {
  if (!instanceId) return;
  try {
    localStorage.setItem(`${KEY}.${instanceId}`, mode);
  } catch {
    // The pane opens in its URL's mode next time instead.
  }
}

/** What the shell hands both modes. */
export interface ModeProps {
  /** Slot 1 of the toolbar: switches this pane between the modes. */
  modeSwitch: ToolbarMode<GodotMode>;
  /** `godot/status`, read by the shell; `null` until it first answers. */
  status: GodotStatus | null;
  /** Why the last read of the status failed, if it did. */
  statusError: string | null;
  /** Read the status again; `refresh` searches for the engine afresh. */
  reloadStatus: (refresh: boolean) => Promise<void>;
}
