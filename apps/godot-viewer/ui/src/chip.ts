/**
 * The Godot Scene toolbar's status chip: one word on how fresh the tree on
 * screen is, worked out from `godot-viewer/state` alone so the rules can be
 * tested without rendering the app.
 *
 * Fresh reads "Read 3m ago", not the design's "Up to date". The backend keeps
 * no modification time for the cached tree (`viewer_state` in
 * `src-tauri/src/godot/rpc.rs` returns whatever `read_cached` finds), so the
 * viewer cannot tell whether the `.tscn` was edited since, and "Up to date"
 * would be a claim nothing checks. The age is true, and it is the render age
 * the old header showed, so moving it into the chip loses nothing. When the
 * backend learns staleness, this is the one place that changes.
 */
import { formatRenderAge } from "../../../shared/age";
import type { ToolbarStatus } from "../../../shared/ViewerToolbar";
import type { GodotViewerState } from "./rpc";

const EDITS_NOT_SEEN =
  "This view shows a cached read and does not notice edits on its own. Refresh the tree after changing the scene.";

export function sceneChip(
  state: GodotViewerState | null,
  preview: boolean,
  now: number = Date.now(),
): ToolbarStatus | null {
  if (preview) {
    return {
      tone: "accent",
      label: "Sample data",
      title: "Showing the built-in sample scene, not this project.",
    };
  }
  if (!state) return null;
  const job = state.job;
  // A running refresh blocks every scene, so it is reported whichever is picked.
  if (job?.running) {
    const phase = job.phase || "refreshing";
    return {
      tone: "info",
      label: `${phase.charAt(0).toUpperCase()}${phase.slice(1)}...`,
      title: `Godot is reading ${job.scene}`,
    };
  }
  // The job is the cluster's last one, not this scene's: a failure on another
  // scene says nothing about the tree shown here.
  if (job?.error && job.scene === state.scene) {
    return { tone: "danger", label: "Failed", title: job.error };
  }
  if (state.scenes.length === 0) {
    return { tone: "idle", label: "No scenes", title: "This project has no .tscn scenes." };
  }
  if (state.renderedAt === null) {
    return {
      tone: "idle",
      label: "Not read yet",
      title: "Refresh the tree to read this scene.",
    };
  }
  return {
    tone: "success",
    label: formatRenderAge(state.renderedAt, now).replace("rendered", "Read"),
    title: EDITS_NOT_SEEN,
  };
}
