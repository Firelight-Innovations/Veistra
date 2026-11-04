/**
 * The Blender app's modes, Editor · Renders · Compare, as the Components and
 * BlenderModel boards draw them.
 *
 * - **Editor** is Blender itself in the pane (`editor/EditorMode.tsx`, #317),
 *   or, where the backend says it cannot open there (main, a cloud session, no
 *   Blender), the read-only viewer of the last export.
 * - **Renders** is what an export made: its preview renders, the `.glb` in 3D
 *   and Blender's wireframe pass, with the parts list.
 * - **Compare** is what changed between two kept versions of the file
 *   (`compare/CompareMode.tsx`, #319). With fewer than two it is drawn and
 *   cannot be chosen, and its tooltip says why.
 */
import type { SegmentedOption } from "../../../shared/SegmentedControl";

export type BlenderMode = "editor" | "renders" | "compare";

export const COMPARE_NEEDS_TWO =
  "Compare needs two exports of this file. Export it again, or let the agent export it, and Compare shows what changed.";

/** The mode switch for a file with `versions` kept versions. */
export function modesFor(versions: number): readonly SegmentedOption<BlenderMode>[] {
  const compare: SegmentedOption<BlenderMode> =
    versions >= 2
      ? { value: "compare", label: "Compare" }
      : { value: "compare", label: "Compare", disabled: true, title: COMPARE_NEEDS_TWO };
  return [{ value: "editor", label: "Editor" }, { value: "renders", label: "Renders" }, compare];
}

/**
 * How Renders, and the viewer in Editor mode, look at an export, in the
 * Actions slot. Stills are the preview renders; 3D is the live glTF view with
 * its materials; Wire is Blender's wireframe pass, a still from the export.
 */
export type ExportView = "stills" | "3d" | "wire";

export const EXPORT_VIEWS: readonly SegmentedOption<ExportView>[] = [
  { value: "stills", label: "Stills" },
  { value: "3d", label: "3D" },
  { value: "wire", label: "Wire" },
];

/** Each mode opens on its own view: Renders on the stills, the viewer on the model. */
export function viewFor(mode: BlenderMode): ExportView {
  return mode === "renders" ? "stills" : "3d";
}
