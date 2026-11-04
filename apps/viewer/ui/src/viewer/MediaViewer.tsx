/**
 * Audio and video, in the webview's own players (issue #342). The formats in
 * the registry are the ones Chromium — so WebView2 — plays without a codec
 * pack: WAV, MP3, Ogg Vorbis/Opus, FLAC, AAC in MP4, and MP4/WebM video.
 *
 * Read whole, through the same object-URL hook the image viewer uses, so a
 * file over the binary-read cap says so instead of playing. Streaming a long
 * video would need a URL the backend serves, which is a larger change than a
 * preview warrants today.
 */
import { formatSize } from "../rpc";
import { VIDEO_EXTENSIONS } from "./assetFormats";
import { mimeFor, useBlobUrl } from "./blobUrl";
import type { ViewerProps } from "./registry";
import "./media.css";

export default function MediaViewer({ file }: ViewerProps) {
  const state = useBlobUrl(file.path, mimeFor(file.ext));
  const video = VIDEO_EXTENSIONS.has(file.ext);

  if (state.status === "loading") {
    return <p className="app__note media__note">Reading {file.name}…</p>;
  }
  if (state.status === "failed") {
    return <p className="app__error media__note">{state.message}</p>;
  }

  return (
    <div className="av">
      <div className="av__stage">
        {video ? (
          <video className="av__video" src={state.url} controls preload="metadata" />
        ) : (
          <audio className="av__audio" src={state.url} controls preload="metadata" />
        )}
      </div>
      <p className="image__meta app__meta">
        <span>{file.ext.toUpperCase()}</span>
        <span>{formatSize(state.size)}</span>
      </p>
    </div>
  );
}
