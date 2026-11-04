/**
 * A file's bytes as an object URL, for the two viewers that draw a picture.
 *
 * Shared by `ImageViewer` and `SvgViewer` because both answer the same question
 * — "give me a URL an `<img>` can point at, and take it back when the pane goes
 * away" — and because the revoke is the part that is easy to get wrong. A viewer
 * is mounted and unmounted every time someone clicks a different file, so an
 * object URL that is never revoked is not a theoretical leak: it pins a full
 * decoded copy of every image the session has ever opened, for the lifetime of
 * the document.
 *
 * This deliberately does not cache. Two tabs on the same path get two URLs, and
 * that is correct — the alternative is a cache that has to know when a file
 * changed on disk, which is the explorer's job and not this module's.
 */
import { useEffect, useState } from "react";
import { describe, readBytes, toBytes } from "../rpc";

export type BlobUrlState =
  | { status: "loading" }
  | { status: "ready"; url: string; size: number }
  | { status: "failed"; message: string };

/**
 * Keyed by the lowercased, dotless extension `OpenFile.ext` carries.
 *
 * This module also does not sniff. The MIME type comes from the extension,
 * because that is the only input the rest of this app admits (see the header of
 * `registry.ts`), and because for a raster `<img>` the type barely matters — the
 * decoder reads the bytes. It matters for exactly one format, and that format is
 * the reason this map exists at all: an SVG in a `Blob` typed anything other
 * than `image/svg+xml` does not render.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",

  // Media and fonts, for `MediaViewer` and `FontViewer`. Unlike a raster the
  // type matters to `<audio>`/`<video>`, which pick a demuxer by it.
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * The type to stamp on the `Blob`.
 *
 * The fallback is `application/octet-stream` rather than `""` so that a format
 * the registry starts matching before this map learns about it fails visibly as
 * a broken image, instead of half-working on whichever browsers sniff.
 */
export function mimeFor(ext: string): string {
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Bytes to the `Blob` to show, for a format the browser cannot take as-is
 * (TGA). Must be a stable reference — a module-level function — because it is
 * an effect dependency below, and a new one each render would re-read forever.
 */
export type Decode = (bytes: Uint8Array) => Promise<Blob>;

export function useBlobUrl(path: string, type: string, decode?: Decode): BlobUrlState {
  const [state, setState] = useState<BlobUrlState>({ status: "loading" });

  useEffect(() => {
    // Captured by the cleanup below. `null` until the read lands, which is the
    // case that matters: unmounting mid-read must not leave a URL behind, and
    // must not create one afterwards either.
    let url: string | null = null;
    let live = true;

    setState({ status: "loading" });

    readBytes(path).then(
      async (bytes) => {
        const raw = toBytes(bytes.base64) as Uint8Array<ArrayBuffer>;
        let blob: Blob;
        try {
          blob = decode ? await decode(raw) : new Blob([raw], { type });
        } catch (err) {
          if (live) setState({ status: "failed", message: messageOf(err) });
          return;
        }
        if (!live) return;
        url = URL.createObjectURL(blob);
        setState({ status: "ready", url, size: bytes.size });
      },
      (err: unknown) => {
        if (!live) return;
        setState({ status: "failed", message: describe("files/read-bytes", err) });
      },
    );

    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [path, type, decode]);

  return state;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
