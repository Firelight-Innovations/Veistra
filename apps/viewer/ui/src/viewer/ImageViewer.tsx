/**
 * A raster image, and the two numbers people actually opened it for.
 *
 * Fit-to-pane by default, click for 1:1 with scrollbars when the natural size
 * overflows. Below it, a strip carrying the pixel dimensions and the byte size —
 * for a PNG that is most of the reason the file got double-clicked, and neither
 * number is anywhere else in this app.
 *
 * What it deliberately does not do: pan, zoom to arbitrary levels, rotate, or
 * flip. Two states are enough to answer "how big is it" and "what does it look
 * like", and every additional control is one more thing between the file and
 * the person looking at it. It also does not decode anything itself — the
 * browser's image pipeline is behind the `<img>`, and this file's whole job is
 * to hand it a URL and take the URL back afterwards.
 *
 * The size shown is the one `files/read-bytes` reported, not `file.size` from
 * the directory listing. The listing can be a poll interval out of date; the
 * read cannot be, because these are the bytes on screen.
 */
import { useState } from "react";
import { formatSize } from "../rpc";
import { mimeFor, useBlobUrl, type Decode } from "./blobUrl";
import { rgbaToPng } from "./raster";
import { decodeTga } from "./tga";
import type { ViewerProps } from "./registry";
import "./media.css";

/** TGA is the one raster here `<img>` cannot decode; it is decoded to PNG first. */
const decodeTgaToPng: Decode = (bytes) => rgbaToPng(decodeTga(bytes));

interface Natural {
  width: number;
  height: number;
}

export default function ImageViewer({ file }: ViewerProps) {
  /**
   * `false` is fit-to-pane. Not reset anywhere here on purpose: `Viewer.tsx`
   * keys this subtree on the path, so opening a different image remounts and
   * starts fitted again.
   */
  const [actual, setActual] = useState(false);
  const [natural, setNatural] = useState<Natural | null>(null);

  const state = useBlobUrl(
    file.path,
    mimeFor(file.ext),
    file.ext === "tga" ? decodeTgaToPng : undefined,
  );

  if (state.status === "loading") {
    return <p className="app__note media__note">Reading {file.name}…</p>;
  }
  if (state.status === "failed") {
    return <p className="app__error media__note">{state.message}</p>;
  }

  const mode = actual ? "actual" : "fit";

  return (
    <div className="image">
      <div className="image__scroll">
        {/*
          A button rather than a click handler on the `<img>`: the toggle has to
          be reachable from the keyboard, and the element that does something on
          Enter is the element that should be focusable.
        */}
        <button
          type="button"
          className={`image__stage image__stage--${mode}`}
          aria-pressed={actual}
          title={actual ? "Fit to pane" : "Actual size"}
          onClick={() => setActual((previous) => !previous)}
        >
          <img
            className={`image__img image__img--${mode}`}
            src={state.url}
            alt={file.name}
            draggable={false}
            // The only place the natural size exists. `naturalWidth` is 0 until
            // decode finishes, so it cannot be read any earlier than this.
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        </button>
      </div>

      <p className="image__meta app__meta">
        <span>{natural ? `${natural.width} × ${natural.height}` : "—"}</span>
        <span>{file.ext.toUpperCase()}</span>
        <span>{formatSize(state.size)}</span>
        <span className="image__hint">
          {actual ? "Actual size" : "Fit to pane"} · click to toggle
        </span>
      </p>
    </div>
  );
}
