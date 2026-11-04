/**
 * The wire to the window a pane places over itself, restated from
 * `src-tauri/src/embed/` (`State`, `Cause`, and `host::answer`'s `embed/*`).
 *
 * The game has methods of its own (`play/embed-rect`, `play/still`,
 * `play/pop-out`, `play/dock`), because Play starts and saves takes around
 * them. The Godot editor and Blender (#316, #317) use these, which the host
 * answers for any app that declares `placesWindow`, keyed by the pane that
 * calls and the `kind` it names.
 */
import { invoke } from "@veistra/bridge";
import type { Rect } from "./nativeBox";

/** Why a window keeps its own frame (`embed::Cause`), for code that branches on it. */
export type EmbedCause =
  | "unsupported"
  | "forced"
  | "noPane"
  | "noWindow"
  | "exited"
  | "noOwner"
  | "refused"
  | "placeFailed";

/** Where the window is (`embed::State`). `reason` is what the pane says; it starts with
 *  "Playing in its own window" for the game and "Open in its own window" for an editor. */
export type EmbedState =
  | { kind: "waiting" }
  | { kind: "embedded" }
  | { kind: "poppedOut" }
  | { kind: "ownWindow"; reason: string; cause: EmbedCause };

/** The windows a pane can place through `embed/*`. */
export type EditorKind = "godotEditor" | "blender";

export interface EmbedAnswer {
  /** `null` before anything was launched for this pane. */
  embed: EmbedState | null;
  embedded: boolean;
}

/**
 * The pane's box, in window CSS pixels. `dpr` is the page's
 * `devicePixelRatio`, the monitor scale times the WebView's zoom, which is
 * what turns CSS pixels into the screen's; the window's own scale misses the
 * zoom. Kept for the next launch even before the window exists.
 */
export const embedRect = (
  kind: EditorKind,
  r: Rect,
  visible: boolean,
  window: string | undefined,
  dpr: number,
) => invoke<{ ok: boolean }>("embed/rect", { kind, ...r, visible, window, dpr });

export const embedState = (kind: EditorKind) => invoke<EmbedAnswer>("embed/state", { kind });

/** The window's last frame, for the box while an overlay covers it. Rejects until there is one. */
export const embedStill = (kind: EditorKind) =>
  invoke<{ png: string; source: string }>("embed/still", { kind });

export const popOut = (kind: EditorKind) => invoke<EmbedAnswer>("embed/pop-out", { kind });
export const dock = (kind: EditorKind) => invoke<EmbedAnswer>("embed/dock", { kind });
