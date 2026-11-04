/**
 * The interactive 3D view: an orbitable three.js render of the exported glTF,
 * with an optional markup layer on top.
 *
 * This module is the only place `three` and Excalidraw are reached from, and
 * `App` loads it with `React.lazy`, so neither is in the viewer's first chunk.
 * Shared by the Godot and Blender viewers; each passes what its markup JSON
 * should say about the source, and translates selection to and from its own
 * node names.
 * Excalidraw is a second, nested lazy load: opening the 3D view costs three.js,
 * and only pressing "Mark up" costs Excalidraw. The button itself is on the
 * app's toolbar (`MarkupTrigger.tsx`); this view reports how to start drawing.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SceneView } from "@veistra/scene-view";
import type { SceneViewHandle } from "@veistra/scene-view";
import { poseMatches, sceneHost } from "@veistra/markup";
import type { CameraPose } from "@veistra/markup";
import type { MarkupController, MarkupExport } from "@veistra/markup/layer";
import type { MarkupTrigger } from "./MarkupTrigger";
import { projectRelative } from "./sceneNodes";
import "./markup.css";

/** The layer exports a named component; `lazy` wants a default. */
const MarkupLayer = lazy(() =>
  import("@veistra/markup/layer").then((m) => ({ default: m.MarkupLayer })),
);

export interface MarkupSceneProps {
  glb: ArrayBuffer;
  /** Absolute path of the glb; the markup JSON records it relative to `.veistra`. */
  glbPath: string;
  /** What the markup JSON says about where this came from: `engine`, the scene or `.blend`, a version. */
  extra: Record<string, string>;
  /** The selected node, as the 3D view names it. */
  selectedPath: string | null;
  onSelect: (viewPath: string | null) => void;
  /** Why marking up is unavailable right now (the model is out of date); `null` when it is available. */
  markupDisabled?: string | null;
  /** A finished markup: what the person drew, ready to send. */
  onMarkup: (result: MarkupExport) => void;
  /** Something this view could not do, in words for the person. */
  onNotice: (message: string) => void;
  /** How to start drawing, for the toolbar's Mark up; `null` once this view is gone. */
  onTrigger: (trigger: MarkupTrigger | null) => void;
}

function useTheme(): "dark" | "light" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"dark" | "light">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export default function MarkupScene(props: MarkupSceneProps) {
  const { glb, glbPath, extra, selectedPath, onSelect, markupDisabled, onMarkup, onNotice } = props;
  const { onTrigger } = props;
  // Callers build `extra` inline; its content, not its identity, decides the host.
  const extraKey = JSON.stringify(extra);
  const theme = useTheme();
  const [handle, setHandle] = useState<SceneViewHandle | null>(null);
  const [marking, setMarking] = useState(false);
  // Excalidraw is fetched the first time markup is opened, and kept after that so
  // pins from an earlier drawing keep following the camera.
  const [layerLoaded, setLayerLoaded] = useState(false);
  const controller = useRef<MarkupController | null>(null);
  const startedAt = useRef<CameraPose | null>(null);

  const host = useMemo(
    () =>
      handle
        ? sceneHost(handle, {
            glb: projectRelative(glbPath),
            extra: JSON.parse(extraKey) as Record<string, string>,
          })
        : null,
    [handle, glbPath, extraKey],
  );

  // The camera is locked for as long as the person is drawing: a pin or a stroke
  // is only right for the view it was made from. The layer does this too when it
  // loads; stating it here makes the lock a fact of this view, not of a lazy import.
  useEffect(() => {
    handle?.setInteractive(!marking);
  }, [handle, marking]);

  const begin = useCallback(() => {
    startedAt.current = handle?.getCamera() ?? null;
    setLayerLoaded(true);
    setMarking(true);
  }, [handle]);

  useEffect(() => {
    onTrigger({ begin, ready: handle !== null && !marking, disabled: markupDisabled ?? null });
  }, [onTrigger, begin, handle, marking, markupDisabled]);
  useEffect(() => () => onTrigger(null), [onTrigger]);

  // Done, or the camera leaving the view being drawn. Either way the layer has
  // already left markup mode; what is left is deciding whether to keep the result.
  const changeActive = useCallback(
    (next: boolean) => {
      setMarking(next);
      if (next) return;
      const from = startedAt.current;
      startedAt.current = null;
      const now = handle?.getCamera() ?? null;
      const layer = controller.current;
      if (!layer) return;
      if (from && now && !poseMatches(from, now)) {
        onNotice("The camera moved, so that markup stays at the view it was drawn from.");
        return;
      }
      layer
        .exportMarkup()
        .then((result) => {
          if (result.json.pins.length === 0 && result.json.annotations.length === 0) {
            onNotice("Nothing was drawn, so there is nothing to send.");
            return;
          }
          onMarkup(result);
        })
        .catch((e: unknown) => {
          onNotice(`Couldn't export the markup: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [handle, onMarkup, onNotice],
  );

  return (
    <div className="k-markup__scene">
      <div className="k-markup__bar">
        <span className="k-markup__hint">
          {marking
            ? "Drawing. The camera is locked until you press Done."
            : markupDisabled
              ? markupDisabled
              : "Drag to orbit, right-drag to pan, scroll to zoom. Double-click a node to focus it."}
        </span>
      </div>
      <div className="k-markup__stage">
        <SceneView
          ref={setHandle}
          source={glb}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onError={onNotice}
        >
          {host && layerLoaded && (
            <Suspense fallback={null}>
              <MarkupLayer
                host={host}
                theme={theme}
                active={marking}
                onActiveChange={changeActive}
                onController={(c) => {
                  controller.current = c;
                }}
              />
            </Suspense>
          )}
        </SceneView>
      </div>
    </div>
  );
}
