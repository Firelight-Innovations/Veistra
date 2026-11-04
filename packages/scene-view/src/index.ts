/**
 * `@veistra/scene-view`: an interactive glTF preview for the Godot and
 * Blender viewers. See `SceneView.tsx` for how the pieces fit, and
 * `markupHost.ts` for the contract the markup layer consumes.
 *
 * Shipped as TypeScript source rather than a built `dist/`, unlike
 * `@veistra/bridge`: it is private to this repository and imports CSS, and a
 * second bundler pass would only get in the way of Vite's tree-shaking of
 * three.js.
 */
export { SceneView } from "./SceneView";
export type { SceneViewProps } from "./SceneView";
export type { CameraPose, PickHit, SceneViewHandle, Vec3, ViewportPoint } from "./markupHost";
export type { LoadedInfo } from "./engine";
export { posesClose } from "./pose";
export { DEFAULT_MAX_TRIANGLES } from "./limits";
export { MODEL_FORMATS, isModelFormat } from "./formats";
export type { ModelFormat, ModelSource } from "./formats";
export { CompareView, useCompare } from "./compare/CompareView";
export type { CompareState, CompareViewHandle, CompareViewProps } from "./compare/CompareView";
export type { CompareMode } from "./compare/engine";
export type { CompareOutcome } from "./compare/client";
export { CHANGE_CLASSES, DELTA, EPSILON } from "./compare/types";
export type {
  ChangeClass,
  Counts,
  DiffResult,
  PartDiff,
  PartStatus,
  Region,
} from "./compare/types";
export { nudgeSplit } from "./compare/split";
