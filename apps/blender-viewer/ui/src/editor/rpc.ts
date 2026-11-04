/**
 * The wire shapes `blender-viewer/editor-*` answer with, restated from
 * `src-tauri/src/blender/editor.rs` and the boot script it talks to
 * (`veistra_boot.py`). The pane polls `blender-viewer/editor-state`; nothing
 * is pushed. Where Blender's window is, and its box, go through the shared
 * `embed/*` (`apps/shared/nativeWindow.ts`), keyed by this pane and `blender`.
 */
import { invoke } from "@veistra/bridge";
import type { EditorEvent } from "../../../../shared/editorEvents";
import type { EmbedState } from "../../../../shared/nativeWindow";

/** An object selected in Blender, as `bpy` names it: `MESH`, `EMPTY`, `LIGHT`... */
export interface SelectedObject {
  name: string;
  type: string;
}

/** The 3D view's camera, as the boot script reads it from the view matrix. */
export interface ViewCamera {
  pos?: [number, number, number];
  target?: [number, number, number];
  up?: [number, number, number];
  /** Degrees; absent in an orthographic view. */
  fov?: number;
}

/** The largest 3D view in Blender's window, as the boot script reports it. */
export interface ViewReport {
  matrix: number[][];
  window: number[][];
  /** `PERSP`, `ORTHO` or `CAMERA`. */
  perspective: string;
  distance: number;
  area: { w: number; h: number };
  region: { x: number; y: number; w: number; h: number };
  camera: ViewCamera;
}

/** What the boot script last wrote to `state.json`. */
export interface BlenderView {
  /** Absolute; `""` for a new file never saved. */
  file: string;
  dirty: boolean;
  /** `null` when no 3D view is open. */
  view: ViewReport | null;
  /** The 3D view fills the window (Viewport only). */
  fullscreen: boolean;
  selected: SelectedObject[];
  active: string | null;
}

/** A lock as the pane shows it (`.veistra/locks/<file>.lock`). */
export interface BlendLock {
  file: string;
  pid: number;
  since: number;
}

export interface BlenderEditorInfo {
  /** The file Blender has open, relative to the environment; `null` for an unsaved new file. */
  file: string | null;
  /** The file it was started on. */
  opened: string;
  pid: number;
  /** `blender --version`'s answer, when it gave one. */
  blender: string | null;
  /** `Embed::report()`; only `state` is read here. */
  embed: { state: EmbedState; still: boolean };
  /** The boot script said hello on this Blender's channel. */
  booted: boolean;
  /** The boot script's version, once it has said hello. */
  script: number | null;
  /** What a tool that needs the boot script says while it cannot act; `null` once it runs. */
  why: string | null;
  /** Unsaved changes, as Blender reports them; `null` before the first report. */
  dirty: boolean | null;
  /** The lock this Blender holds on its file. */
  lock: BlendLock | null;
  /** A file it opened that another Blender holds, so it holds no lock on it. */
  conflict: string | null;
  view: BlenderView | null;
  /** Presses in Blender's Veistra tab after `eventsSince` not yet answered (#320). */
  events?: EditorEvent[];
}

export interface BlenderEditorState {
  /** `null` when no Blender runs from this cluster. */
  editor: BlenderEditorInfo | null;
  /** The Blender that just ended, once, so the pane can say so. */
  ended?: { file: string | null; code: number | null };
}

/** A picture of the 3D view's area, with the view and the selection of the same moment. */
export interface ViewportCapture {
  pngBase64: string;
  width: number;
  height: number;
  view: ViewReport | null;
  selected: SelectedObject[];
  active: string | null;
  /** Relative to the environment, as `file` above. */
  file: string | null;
}

export interface ViewportHit {
  object: string;
  type?: string;
  worldPoint?: number[];
}

/** Starts Blender on `blend`, or answers the one already running on it. */
export const openEditor = (blend: string) =>
  invoke<BlenderEditorState>("blender-viewer/editor-open", { blend });

/** The poll; `eventsSince` is the last tab event the pane has taken. */
export const editorState = (eventsSince = 0) =>
  invoke<BlenderEditorState>("blender-viewer/editor-state", { eventsSince });

/** The pane's answer to tab event `n`, which the tab then shows. */
export const editorAck = (n: number, ok: boolean, message: string) =>
  invoke<{ acked: number }>("blender-viewer/editor-ack", { n, ok, message });

/** Asks, as the window's close button would: Blender offers to save first. */
export const closeEditor = () =>
  invoke<{ closing: boolean; via: "window" | "blender" }>("blender-viewer/editor-close", {});

export const editorCapture = () => invoke<ViewportCapture>("blender-viewer/editor-capture", {});

/** The object under a point of the last capture, in its pixels from the top left. */
export const editorPick = (x: number, y: number) =>
  invoke<{ hit: ViewportHit | null }>("blender-viewer/editor-pick", { x, y });

export const setViewportOnly = (on: boolean) =>
  invoke<{ viewportOnly: boolean }>("blender-viewer/editor-viewport-only", { on });
