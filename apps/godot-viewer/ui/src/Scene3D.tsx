/**
 * The interactive 3D view of a Godot scene: the shared markup stage, told this
 * is Godot and given the node lookup that turns the 3D view's paths into scene
 * paths. `App` loads this with `React.lazy`, so three.js and Excalidraw stay out
 * of the viewer's first chunk.
 */
import type { MarkupExport } from "@veistra/markup/layer";
import MarkupScene from "../../../shared/MarkupScene";
import type { MarkupTrigger } from "../../../shared/MarkupTrigger";
import type { NodeLookup } from "./preview";

export interface Scene3DProps {
  glb: ArrayBuffer;
  lookup: NodeLookup;
  /** Absolute path of the glb; the markup JSON records it relative to `.veistra`. */
  glbPath: string;
  /** `res://...` of the scene being shown. */
  scenePath: string;
  godot: string | null;
  /** The selected node's scene path, shared with the tree beside this view. */
  selected: string | null;
  onSelect: (scenePath: string | null) => void;
  /** A finished markup: what the person drew, ready to send. */
  onMarkup: (result: MarkupExport) => void;
  /** Something this view could not do, in words for the person. */
  onNotice: (message: string) => void;
  /** How to start drawing, for the toolbar's Mark up. */
  onTrigger: (trigger: MarkupTrigger | null) => void;
}

export default function Scene3D(props: Scene3DProps) {
  const { lookup, scenePath, godot, selected, onSelect, ...rest } = props;
  return (
    <MarkupScene
      {...rest}
      extra={{ engine: "godot", scene: scenePath, ...(godot ? { godot } : {}) }}
      selectedPath={lookup.toView(selected)}
      onSelect={(viewPath) => onSelect(lookup.toScene(viewPath))}
    />
  );
}
