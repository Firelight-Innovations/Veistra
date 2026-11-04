/**
 * A `.blend`, previewed without Blender: the thumbnail Blender saved inside
 * the file, and the version that saved it (issue #342).
 *
 * Only the head of the file is read (`files/read-head`), because a `.blend`
 * is routinely larger than a whole-file read allows and the thumbnail is in
 * its first blocks. The scene itself needs Blender to read — the Blender
 * Viewer app exports it to glTF — so this pane says so and offers the
 * handoff rather than pretending a thumbnail is the model.
 */
import { useEffect, useState } from "react";
import { describe, formatSize, readHead, toBytes } from "../rpc";
import { readBlend, type BlendInfo } from "./blend";
import HandoffActions from "./HandoffActions";
import { rgbaToPng } from "./raster";
import type { ViewerProps } from "./registry";
import "./media.css";

/** Enough for any thumbnail Blender writes (256² RGBA is 256 KiB) and the blocks before it. */
const HEAD_BYTES = 2 * 1024 * 1024;

type State =
  | { status: "loading" }
  | { status: "ready"; info: BlendInfo; size: number; url: string | null }
  | { status: "failed"; message: string };

export default function BlendViewer({ file }: ViewerProps) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setState({ status: "loading" });

    (async () => {
      const head = await readHead(file.path, HEAD_BYTES);
      const read = await readBlend(toBytes(head.base64));
      if (!read.ok) return { status: "failed", message: read.reason } as const;
      const thumb = read.info.thumbnail;
      const png = thumb ? await rgbaToPng(thumb) : null;
      if (live && png) url = URL.createObjectURL(png);
      return { status: "ready", info: read.info, size: head.size, url } as const;
    })().then(
      (next) => live && setState(next),
      (err: unknown) =>
        live && setState({ status: "failed", message: describe("files/read-head", err) }),
    );

    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [file.path]);

  if (state.status === "loading") {
    return <p className="app__note media__note">Reading {file.name}…</p>;
  }
  if (state.status === "failed") {
    return (
      <div className="unsupported">
        <div className="unsupported__body">
          <p className="unsupported__lead">{state.message}</p>
          <HandoffActions path={file.path} />
        </div>
      </div>
    );
  }

  const { info, size, url } = state;
  return (
    <div className="image">
      <div className="image__scroll blend__scroll">
        {url !== null ? (
          <img
            className="blend__thumb"
            src={url}
            alt={`Thumbnail of ${file.name}`}
            draggable={false}
          />
        ) : (
          <p className="app__note">
            This .blend has no thumbnail saved in it. Blender adds one when the file is saved with
            “Save Preview Images” on.
          </p>
        )}
        <p className="app__note blend__note">
          The thumbnail Blender saved with this file. The Blender Viewer app shows the model itself.
        </p>
        <HandoffActions path={file.path} />
      </div>
      <p className="image__meta app__meta">
        <span>Blender {info.version}</span>
        <span>BLEND</span>
        <span>{formatSize(size)}</span>
        {info.compression !== "none" && <span>{info.compression} compressed</span>}
      </p>
    </div>
  );
}
