/**
 * The Blender toolbar's status chip: whether the export on screen still
 * matches the `.blend`, from `blender-viewer/state` alone so the rules can be
 * tested without rendering the app. This replaces the header's
 * ".blend changed since" badge; the age the header showed beside it moves to
 * the chip's tooltip.
 *
 * Unlike the Godot viewer, this one can say "Up to date" honestly: the backend
 * compares the `.blend`'s modification time with the one the export recorded
 * and reports `stale` (`src-tauri/src/apps/blender_viewer.rs`).
 */
import { formatRenderAge } from "../../../shared/age";
import type { ToolbarStatus } from "../../../shared/ViewerToolbar";
import type { BlenderViewerState } from "./rpc";

/** Whether the state carries anything exported to look at. */
export function hasExport(state: BlenderViewerState): boolean {
  return state.model !== null || state.renders.length > 0 || state.parts.length > 0;
}

export function exportChip(
  state: BlenderViewerState,
  now: number = Date.now(),
): ToolbarStatus | null {
  // No file to describe: the body already says why.
  if (!state.rel) return null;
  const age = formatRenderAge(state.exportedAt ?? null, now);
  const when = `${age.charAt(0).toUpperCase()}${age.slice(1)}.`;
  // The job is the cluster's; only an export of this file changes this chip.
  if (state.job.running && state.job.blend === state.rel) {
    return { tone: "info", label: "Exporting", title: `Blender is exporting ${state.rel}.` };
  }
  if (!hasExport(state)) {
    return { tone: "idle", label: "No export", title: `${state.rel} has not been exported yet.` };
  }
  if (state.stale) {
    return {
      tone: "warning",
      label: "Changed after export",
      title: `The .blend changed after this export. ${when}`,
    };
  }
  return { tone: "success", label: "Up to date", title: when };
}
