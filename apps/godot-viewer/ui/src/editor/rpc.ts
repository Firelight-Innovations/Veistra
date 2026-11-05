/**
 * The wire shapes `godot/editor-*` and `godot/plugin-*` answer with, restated
 * from `src-tauri/src/godot/editor.rs` and the plugin it talks to
 * (`veistra_editor.gd`). The pane polls `godot/editor-state`; nothing is
 * pushed. Where the window is and its box go through the shared `embed/*`
 * (`apps/shared/nativeWindow.ts`), keyed by this pane and `godotEditor`.
 */
import { invoke } from "@veistra/bridge";
import type { EditorEvent } from "../../../../shared/editorEvents";
import type { AddonState } from "../../../../shared/godot";
import type { EmbedState } from "../../../../shared/nativeWindow";

/** A node the person has selected in the editor. */
export interface SelectedNode {
  /** `Root/child`, the capture addon's shape. */
  path: string;
  type: string;
  /** `res://` path of its script, `""` when it has none. */
  script: string;
}

/** What the plugin last wrote to `state.json`. */
export interface EditorView {
  /** The edited scene, `""` when none is open. */
  scene: string;
  open: string[];
  /** The main screen: `2D`, `3D`, `Script`, `AssetLib`. */
  screen: string;
  selected: SelectedNode[];
  /** The edited scene's nodes, root first, capped; a plugin before v3 leaves it out. */
  nodes?: Array<{ path: string; type: string }>;
  viewportOnly: boolean;
}

/** The editor's 3D camera, as the plugin reads it. */
export interface EditorCamera {
  pos?: [number, number, number];
  target?: [number, number, number];
  up?: [number, number, number];
  fov?: number;
  orthogonal?: boolean;
  size?: number;
}

export interface EditorInfo {
  /** The project folder relative to the environment root. */
  project: string;
  pid: number;
  godot: string;
  /** `Embed::report()`; only `state` is read here. */
  embed: { state: EmbedState; still: boolean };
  plugin: {
    installed: AddonState;
    /** The plugin said hello in this editor. */
    running: boolean;
    /** Why this Godot cannot run it (older than 4.2), or `null`. */
    problem: string | null;
    /** What a tool that needs the plugin says while it cannot act; `null` once it runs. */
    why: string | null;
  };
  /** `null` until the plugin first writes its state. */
  view: EditorView | null;
  /** Presses in the editor's Veistra dock after `eventsSince` not yet answered (#320). */
  events?: EditorEvent[];
}

export interface EditorState {
  /** `null` when no editor runs in this cluster. */
  editor: EditorInfo | null;
  /** The editor that just ended, once, so the pane can say so. */
  ended?: { project: string; code: number | null };
  /** An agent session works in this environment (the banner). */
  agent: boolean;
}

/** A viewport or window picture, with what the plugin read beside it. */
export interface EditorPicture {
  pngBase64: string;
  width: number;
  height: number;
  camera?: EditorCamera;
}

/** Send selection's one answer: the selection, the scene and the viewport. */
export interface EditorSelection extends EditorPicture, Partial<EditorView> {}

export interface EditorHit {
  nodePath: string;
  type?: string;
  worldPoint?: number[];
  source: "editor";
}

export interface PluginStatus {
  plugin: AddonState;
  problem: string | null;
  editorOpen: boolean;
  readOnly: boolean;
}

export const openEditor = (project?: string) =>
  invoke<EditorState>("godot/editor-open", { project });

/** The poll; `eventsSince` is the last dock event the pane has taken. */
export const editorState = (eventsSince = 0) =>
  invoke<EditorState>("godot/editor-state", { eventsSince });

/** The pane's answer to dock event `n`, which the dock then shows. */
export const editorAck = (n: number, ok: boolean, message: string) =>
  invoke<{ acked: number }>("godot/editor-ack", { n, ok, message });

export const editorSelection = () => invoke<EditorSelection>("godot/editor-selection", {});

export const editorCapture = (what: "viewport" | "window" = "viewport") =>
  invoke<EditorPicture>("godot/editor-capture", { what });

/** The node under a point of the last viewport capture, in its pixels. */
export const editorPick = (x: number, y: number) =>
  invoke<{ hit: EditorHit | null }>("godot/editor-pick", { x, y });

export const editorSelect = (paths: string[]) =>
  invoke<{ missing: string[] }>("godot/editor-select", { paths });

export const editorOpenScene = (scene: string) =>
  invoke<{ scene: string }>("godot/editor-open-scene", { scene });

/** A scene opens as a tab, a script in its editor, a resource in the Inspector (plugin v3). */
export const editorEdit = (path: string) => invoke<{ path: string }>("godot/editor-edit", { path });

export const setViewportOnly = (on: boolean) =>
  invoke<{ viewportOnly: boolean }>("godot/editor-viewport-only", { on });

export const saveAll = () => invoke<{ saved: boolean }>("godot/editor-save", {});

export const pluginStatus = (project?: string) =>
  invoke<PluginStatus>("godot/plugin-status", { project });

export const installPlugin = (project?: string) =>
  invoke<PluginStatus>("godot/plugin-install", { project });

export const removePlugin = (project?: string) =>
  invoke<PluginStatus>("godot/plugin-remove", { project });
