/**
 * A font file as a type specimen: its name, the alphabet, and a pangram at a
 * ladder of sizes (issue #342). Loaded through the `FontFace` API under a
 * private family name, so it never collides with — or replaces — a font the
 * app itself uses.
 */
import { useEffect, useState } from "react";
import { describe, formatSize, readBytes, toBytes } from "../rpc";
import type { ViewerProps } from "./registry";
import "./media.css";

const SIZES = [12, 16, 24, 36, 56];
const PANGRAM = "Sphinx of black quartz, judge my vow.";
const ALPHABET = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789 !?&@#%(){}[]",
];

let nextFamily = 0;

type State =
  | { status: "loading" }
  | { status: "ready"; family: string; size: number }
  | { status: "failed"; message: string };

export default function FontViewer({ file }: ViewerProps) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    let face: FontFace | null = null;
    setState({ status: "loading" });
    nextFamily += 1;
    const family = `veistra-preview-${nextFamily}`;

    readBytes(file.path)
      .then(async (bytes) => {
        face = new FontFace(family, toBytes(bytes.base64) as Uint8Array<ArrayBuffer>);
        await face.load();
        if (!live) return;
        document.fonts.add(face);
        setState({ status: "ready", family, size: bytes.size });
      })
      .catch((err: unknown) => {
        if (!live) return;
        const message =
          err instanceof DOMException || err instanceof SyntaxError
            ? "This font could not be loaded; the file may be damaged or in a format the webview does not read."
            : describe("files/read-bytes", err);
        setState({ status: "failed", message });
      });

    return () => {
      live = false;
      if (face) document.fonts.delete(face);
    };
  }, [file.path]);

  if (state.status === "loading") {
    return <p className="app__note media__note">Reading {file.name}…</p>;
  }
  if (state.status === "failed") {
    return <p className="app__error media__note">{state.message}</p>;
  }

  const style = { fontFamily: `"${state.family}"` };
  return (
    <div className="font">
      <div className="font__scroll">
        <p className="font__name" style={style}>
          {file.name.replace(/\.[^.]+$/, "")}
        </p>
        {ALPHABET.map((line) => (
          <p key={line} className="font__line" style={style}>
            {line}
          </p>
        ))}
        {SIZES.map((size) => (
          <p key={size} className="font__sample">
            <span className="font__size">{size}</span>
            <span style={{ ...style, fontSize: `${size}px` }}>{PANGRAM}</span>
          </p>
        ))}
      </div>
      <p className="image__meta app__meta">
        <span>{file.ext.toUpperCase()}</span>
        <span>{formatSize(state.size)}</span>
      </p>
    </div>
  );
}
