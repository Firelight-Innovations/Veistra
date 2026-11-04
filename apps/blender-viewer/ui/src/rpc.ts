/**
 * The wire shapes `blender-viewer/*` answers with, restated for the same reason
 * `apps/godot-viewer/ui/src/rpc.ts` restates Godot's: an app's frontend calls
 * the bridge, not the Rust module. The Rust side is
 * `src-tauri/src/apps/blender_viewer.rs`.
 */
import { invoke } from "@veistra/bridge";
import type { EditorSurface, SurfaceEnvironment } from "../../../shared/editorSurface";

export interface BlenderPart {
  name: string;
  /** `mesh`, `instance`, `empty`, `armature`, `light`, `camera`, ... */
  kind: string;
  parent: string | null;
  visible: boolean;
  mesh: string | null;
  materials: string[];
  verts: number;
  polys: number;
  tris: number;
  dimensions: number[];
  /** For `kind: "instance"`: the collection this empty instances. */
  instanceOf?: string | null;
  /** For `kind: "instance"`: how many meshes the collection brings in. */
  instanceMeshes?: number;
}

export interface BlenderRender {
  id: string;
  /** A short label for the render, e.g. the camera or pass name. */
  label: string;
  /** Milliseconds since the Unix epoch — when the export that made it ran. */
  createdAt: number;
}

export interface BlenderInstall {
  found: boolean;
  path: string | null;
  source: "setting" | "env" | "path" | "programFiles" | "steam" | "standard" | null;
  version: string | null;
  major: number | null;
  /** Blender 4.x and 5.x are what the export script is written and tested against. */
  supported: boolean;
  /** The Settings path is set but nothing is there. */
  configuredMissing: boolean;
}

export interface BlendFile {
  path: string;
  rel: string;
  mtime: number;
  size: number;
}

export interface ExportJob {
  running: boolean;
  blend: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  step: number;
  total: number;
  label: string;
  log: string[];
  outcome: "ok" | "failed" | "cancelled" | null;
  error: string | null;
  warnings: string[];
}

export interface BlenderStats {
  objects?: number;
  meshes?: number;
  instances?: number;
  materials?: number;
  polys?: number;
  tris?: number;
}

export interface BlenderViewerState {
  blender: BlenderInstall;
  /** The cluster has an environment to look for `.blend` files in. */
  project: boolean;
  /** main: an export folder inside the checkout would be refused, and the cache is kept outside it. */
  readOnly: boolean;
  /** Where Blender's Editor mode shows, and why when not in the pane (`editorSurface.ts`). */
  editor: EditorSurface;
  environment: SurfaceEnvironment;
  blends: BlendFile[];
  /** The `.blend` this state is about (absolute), or `null` when there is none. */
  blend: string | null;
  rel: string | null;
  blendMtime?: number | null;
  /** The exported `.glb` (absolute), or `null` before any export. */
  model: string | null;
  glbBytes?: number | null;
  exportedAt?: number;
  /** The `.blend` has changed on disk since the export was made. */
  stale?: boolean;
  engine?: string;
  resolution?: number;
  blenderVersion?: string;
  stats?: BlenderStats;
  warnings?: string[];
  parts: BlenderPart[];
  renders: BlenderRender[];
  job: ExportJob;
}

export const getState = (blend?: string | null) =>
  invoke<BlenderViewerState>("blender-viewer/state", blend ? { blend } : undefined);

export const getImage = (blend: string, id: string) =>
  invoke<{ mime: string; base64: string }>("blender-viewer/image", { blend, id });

export const startExport = (blend: string) =>
  invoke<{ started: boolean }>("blender-viewer/export-start", { blend });

export const cancelExport = () => invoke<{ cancelled: boolean }>("blender-viewer/export-cancel");

export const openInBlender = (blend: string) =>
  invoke<{ launched: boolean; executable: string }>("blender-viewer/open", { blend });

export const detectBlender = () => invoke<BlenderInstall>("blender-viewer/detect");

export const setExecutable = (path: string) =>
  invoke<BlenderInstall>("blender-viewer/set-executable", { path });

/** The exported `.glb` as standard base64, for the 3D preview. */
export const getGlb = (blend: string) =>
  invoke<{ base64: string; size: number }>("blender-viewer/glb", { blend });

/** Replaces this `.blend`'s kept markup; one pair per file, so it never accumulates. */
export const saveMarkup = (blend: string, pngBase64: string, json: string) =>
  invoke<{ savedAt: number }>("blender-viewer/markup-save", { blend, pngBase64, json });

/** `null` when nothing has been marked up on this `.blend` yet. */
export const loadMarkup = (blend: string) =>
  invoke<{ png: string; json: string; savedAt: number } | null>("blender-viewer/markup", {
    blend,
  });
