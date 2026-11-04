/**
 * Where an app's Editor mode shows, as the backend decides it
 * (`src-tauri/src/editor_surface.rs`, DECISIONS X4): the editor in the pane,
 * the editor in its own window, or the read-only viewer, and why when it is
 * not the first. `godot/status` and `blender-viewer/state` both answer it as
 * `editor`. Restated here, not imported from `src-tauri`, as `godot.ts` does.
 *
 * The frontend never works this out again from `readOnly` or a found path:
 * the order (cloud, main, no editor, no embedder) lives in one place.
 */
import { invoke } from "@veistra/bridge";

export type SurfaceKind = "embedded" | "popOut" | "viewer";

/** Why the surface is not `embedded`. */
export type SurfaceCode = "cloud" | "main" | "noEditor" | "noEmbedder";

export interface EditorSurface {
  surface: SurfaceKind;
  /** One line for under the toolbar; `null` when embedded. */
  reason: string | null;
  code: SurfaceCode | null;
}

/** The environment as the toolbar's chip names it; `kind` is `null` for a plain folder. */
export interface SurfaceEnvironment {
  kind: "localWorktree" | "cloud" | "main" | "design" | null;
  branch: string | null;
}

/** Which editor surfaces this app can draw yet. C1 and C2 turn these on. */
export interface EditorBuilt {
  embedded: boolean;
  popOut: boolean;
}

export const NOTHING_BUILT: EditorBuilt = { embedded: false, popOut: false };

/** What Editor mode renders: the editor in the pane, the popped-out state, or the viewer. */
export type EditorBody = "editor" | "popOut" | "viewer";

/**
 * The one switch between the backend's answer and what Editor mode renders.
 * A surface the app cannot draw yet falls back a step: an embedder with no
 * embedded editor pops out, and a pop out with no popped-out state is the
 * viewer. `null` (no answer yet, or a failed read) is the viewer too, since
 * it is the one surface that writes nothing.
 */
export function editorBody(
  surface: EditorSurface | null | undefined,
  built: EditorBuilt = NOTHING_BUILT,
): EditorBody {
  const kind = surface?.surface ?? "viewer";
  if (kind === "embedded" && built.embedded) return "editor";
  if (kind !== "viewer" && built.popOut) return "popOut";
  return "viewer";
}

/** Whether the editor may be launched at all, in the pane or in its own window. */
export function canLaunch(surface: EditorSurface | null | undefined): boolean {
  return surface != null && surface.surface !== "viewer";
}

export type EditorTool = "godot" | "blender";

/** Open Settings on the tool's section, where its path is set (`shell/open-settings`). */
export const openEditorSettings = (tool: EditorTool) =>
  invoke<{ section: string | null }>("shell/open-settings", { section: tool });
