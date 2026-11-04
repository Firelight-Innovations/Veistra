/**
 * A 3D model, orbitable — `.glb`, `.gltf`, `.obj`, `.fbx`, `.dae`, `.stl`,
 * `.ply`, `.3ds`, `.3mf` (issue #342). The view is `@veistra/scene-view`, the
 * same one the Godot and Blender viewers draw their scenes in, so a model
 * looks the same here as it does there.
 *
 * Read-only by design. Changing a model is the owning application's app; this
 * pane answers "what is in this file", plus the one number that matters for a
 * game asset — its triangle count.
 *
 * What it deliberately does not do: resolve an `.obj`'s `.mtl` or an `.fbx`'s
 * external textures. Those formats name their companions loosely and often
 * wrongly; a `.gltf`'s companions are named exactly, so those are inlined.
 */
import { useEffect, useMemo, useState } from "react";
import {
  SceneView,
  type LoadedInfo,
  type ModelFormat,
  type ModelSource,
} from "@veistra/scene-view";
import { describe, formatSize, readBytes, toBytes } from "../rpc";
import { inlineGltf } from "./gltfInline";
import type { ViewerProps } from "./registry";
import "./media.css";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; bytes: ArrayBuffer; size: number }
  | { status: "failed"; message: string };

async function load(
  path: string,
  format: ModelFormat,
): Promise<{ bytes: ArrayBuffer; size: number }> {
  const read = await readBytes(path);
  const raw = toBytes(read.base64);
  if (format !== "gltf") return { bytes: raw.buffer as ArrayBuffer, size: read.size };
  const json = await inlineGltf(new TextDecoder().decode(raw), path, async (companion) => {
    return (await readBytes(companion)).base64;
  });
  return { bytes: new TextEncoder().encode(json).buffer as ArrayBuffer, size: read.size };
}

export default function ModelViewer({ file }: ViewerProps) {
  const format = file.ext as ModelFormat;
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [info, setInfo] = useState<LoadedInfo | null>(null);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    load(file.path, format).then(
      (loaded) => live && setState({ status: "ready", ...loaded }),
      (err: unknown) =>
        live &&
        setState({
          status: "failed",
          message: err instanceof Error ? err.message : describe("files/read-bytes", err),
        }),
    );
    return () => {
      live = false;
    };
  }, [file.path, format]);

  // One object per read: `SceneView` reloads when `source` changes identity.
  const source = useMemo<ModelSource | null>(
    () => (state.status === "ready" ? { bytes: state.bytes, format } : null),
    [state, format],
  );

  if (state.status === "loading") {
    return <p className="app__note media__note">Reading {file.name}…</p>;
  }
  if (state.status === "failed" || source === null) {
    return (
      <p className="app__error media__note">
        {state.status === "failed" ? state.message : "Nothing to show."}
      </p>
    );
  }

  return (
    <div className="model">
      <div className="model__stage">
        <SceneView source={source} onLoad={setInfo} />
      </div>
      <p className="image__meta app__meta">
        <span>{info ? `${info.triangles.toLocaleString()} triangles` : "—"}</span>
        <span>{file.ext.toUpperCase()}</span>
        <span>{formatSize(state.size)}</span>
        <span className="image__hint">Drag to orbit · right-drag to pan · scroll to zoom</span>
      </p>
    </div>
  );
}
