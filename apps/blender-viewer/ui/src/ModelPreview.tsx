/**
 * The Model tab: the exported `.glb` in an orbitable 3D view with the markup
 * layer, or, when there is nothing trustworthy to show, a plain statement of
 * why with the Export action beside it. Never an empty canvas.
 *
 * three.js and Excalidraw sit behind `React.lazy`, so the viewer's first paint
 * does not pay for them.
 */
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { MarkupExport } from "@veistra/markup/layer";
import { nodeLookup } from "../../../shared/sceneNodes";
import { partNodeMap } from "./preview";
import { useGlb } from "./useGlb";
import type { MarkupTrigger } from "../../../shared/MarkupTrigger";
import type { BlenderPart } from "./rpc";

const MarkupScene = lazy(() => import("../../../shared/MarkupScene"));

export const STALE_MARKUP_NOTE = "The .blend changed since this export. Re-export to mark it up.";

export interface ModelPreviewProps {
  blend: string;
  /** The `.blend`, as the project names it. */
  rel: string | null;
  /** Absolute path of the exported `.glb`, or `null` when the export made none. */
  model: string | null;
  exportedAt: number | undefined;
  blenderVersion: string | undefined;
  /** The `.blend` changed on disk after this export. */
  stale: boolean;
  parts: BlenderPart[];
  selected: string | null;
  onSelect: (partName: string | null) => void;
  onMarkup: (result: MarkupExport) => void;
  onNotice: (message: string) => void;
  /** How to start drawing, for the toolbar's Mark up; `null` while no 3D view shows. */
  onTrigger: (trigger: MarkupTrigger | null) => void;
  /** Blender is there and no export is running: Export can be offered. */
  canExport: boolean;
  onExport: () => void;
  /** Shown instead when there is no model to look at: the static render. */
  fallback?: ReactNode;
  /** Shown under the stage: the kept markup, the facts. */
  children?: ReactNode;
}

function Reason({
  children,
  canExport,
  onExport,
  onRetry,
}: {
  children: ReactNode;
  canExport: boolean;
  onExport: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="k-markup__empty" role="status">
      <span>{children}</span>
      <div className="bv__row">
        {onRetry && (
          <button type="button" className="k-markup__action" onClick={onRetry}>
            Try again
          </button>
        )}
        <button
          type="button"
          className="k-markup__action"
          disabled={!canExport}
          onClick={onExport}
          title={canExport ? "Run Blender headless on this file" : "Blender is not ready to export"}
        >
          <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />
          Export
        </button>
      </div>
    </div>
  );
}

export default function ModelPreview(props: ModelPreviewProps) {
  const { blend, rel, model, exportedAt, blenderVersion, stale, parts, selected } = props;
  const { onSelect, onMarkup, onNotice, onTrigger, canExport, onExport, fallback, children } =
    props;
  const glb = useGlb(blend, model !== null, exportedAt);
  const nodeMap = useMemo(() => partNodeMap(parts), [parts]);
  const lookup = useMemo(() => nodeLookup(nodeMap), [nodeMap]);

  if (model === null) {
    return (
      <>
        <Reason canExport={canExport} onExport={onExport}>
          This export has no .glb to show in 3D: the scene has no visible meshes, or the glTF add-on
          is off.
        </Reason>
        {fallback}
        {children}
      </>
    );
  }
  if (glb.state.kind === "failed") {
    return (
      <>
        <Reason canExport={canExport} onExport={onExport} onRetry={glb.retry}>
          Couldn&apos;t load the 3D model: {glb.state.message}
        </Reason>
        {fallback}
        {children}
      </>
    );
  }
  if (glb.state.kind !== "ready") {
    return (
      <>
        <p className="bv__hint">Loading the 3D view…</p>
        {children}
      </>
    );
  }
  return (
    <>
      {stale && (
        <Reason canExport={canExport} onExport={onExport}>
          The .blend changed after this export, so this is the earlier version of the model.
        </Reason>
      )}
      <div className="bv__stage">
        <Suspense fallback={<p className="bv__hint">Loading the 3D view…</p>}>
          <MarkupScene
            glb={glb.state.glb}
            glbPath={model}
            extra={{
              engine: "blender",
              ...(rel ? { blend: rel } : {}),
              ...(blenderVersion ? { blender: blenderVersion } : {}),
            }}
            selectedPath={lookup.toView(selected)}
            onSelect={(viewPath) => onSelect(lookup.toScene(viewPath))}
            markupDisabled={stale ? STALE_MARKUP_NOTE : null}
            onMarkup={onMarkup}
            onNotice={onNotice}
            onTrigger={onTrigger}
          />
        </Suspense>
      </div>
      {children}
    </>
  );
}
