/**
 * How a file becomes a pane. The one file to edit when adding a format.
 *
 * A viewer is a descriptor — a predicate and a dynamic `import()` — and the
 * list below is ordered, most specific first, terminated by two fallbacks that
 * always match. Nothing else in the app knows this list exists: the explorer
 * opens a path, `Viewer.tsx` asks here what to mount, and that is the whole
 * coupling.
 */
import type { ComponentType } from "react";
import type { Stat } from "../rpc";
import {
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
  MODEL_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from "./assetFormats";

/** A file, as a viewer receives it. A `Stat` that is known to be a file. */
export interface OpenFile {
  path: string;
  name: string;
  /** Lowercased, no dot, `""` when the name has none. See `extensionOf`. */
  ext: string;
  size: number | null;
  mtime: number | null;
}

export interface ViewerProps {
  file: OpenFile;

  /**
   * Report whether this viewer is holding unsaved edits.
   *
   * A read-only viewer never calls it. Called on change, not on every render —
   * the tab strip draws a dot from this and nothing else.
   */
  onDirty(dirty: boolean): void;

  /**
   * Hand the app a way to save from outside the viewer, or `null` to withdraw
   * it on unmount.
   *
   * Needed because Ctrl+S has to work when focus is in the tab strip, and
   * because closing a dirty tab offers to save — neither of which can reach
   * into a Monaco instance that lives behind a dynamic import. A read-only
   * viewer never calls this either.
   */
  registerSave(save: (() => Promise<void>) | null): void;

  /**
   * Show this same file under a different viewer, by id.
   *
   * Two callers, and they are the reason this exists rather than a bare
   * fallback: the text viewer calls it with `"unsupported"` when the read comes
   * back not-UTF-8, and the SVG viewer uses it to toggle between the rendered
   * image and its source — an SVG being genuinely both.
   */
  reopenWith(viewerId: string): void;

  /**
   * Open another file in this app's tabs. Used by the Markdown preview for a
   * relative link to a sibling document; absent where the host did not wire it.
   */
  openPath?(path: string): void;
}

export interface ViewerDescriptor {
  /** Stable across releases: `reopenWith` and any future "Open with…" name it. */
  id: string;
  /** Human-readable, for a future "Open with…" menu. Not drawn anywhere yet. */
  label: string;
  /** Whether this viewer can produce unsaved edits. Drives the close prompt. */
  editable: boolean;
  /**
   * Whether this viewer claims the file.
   *
   * What this deliberately does not do: pick a viewer from the file's
   * *contents*. Rust never sniffs a MIME type and neither does this. Extension
   * and filename are the whole input, with one exception the type system cannot
   * express — the text viewer is the fallback because "is this UTF-8" is not
   * knowable from a name, so it tries the read and hands off to `unsupported`
   * when the backend says no. See `isNotText` in `../rpc`.
   */
  match(file: OpenFile): boolean;
  /**
   * Reachable only through `reopenWith`, never chosen by `pick`. For a rendered
   * form of a file whose *source* is what opening it should show — Markdown and
   * HTML, like VS Code, where Ctrl+Shift+V is the way in.
   */
  optIn?: boolean;
  /**
   * **`load` must stay a dynamic `import()`.** It is not a style choice. `apps/`
   * is not a pnpm workspace member, so Monaco, pdf.js and mermaid all sit in the
   * repository root's dependencies with nothing scoping them to this app — the
   * only thing keeping them out of the Files entry chunk, and out of the shell's,
   * is that the sole path to each is behind one of these thunks. A static
   * `import` at the top of this file would put all three in every bundle that
   * touches the explorer.
   */
  load(): Promise<{ default: ComponentType<ViewerProps> }>;
}

/** Set membership reads better than a chain of `||` and is the same cost. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tga",
]);

export const VIEWERS: ViewerDescriptor[] = [
  {
    id: "image",
    label: "Image",
    editable: false,
    match: (file) => IMAGE_EXTENSIONS.has(file.ext),
    load: () => import("./ImageViewer"),
  },
  {
    // Above `image` in intent but below it in effect — the sets are disjoint,
    // so the order between these two never decides anything. It is listed
    // separately because an SVG is a document as well as a picture, and the
    // viewer that knows that is not the one that draws a PNG.
    id: "svg",
    label: "SVG",
    editable: false,
    match: (file) => file.ext === "svg",
    load: () => import("./SvgViewer"),
  },
  {
    id: "pdf",
    label: "PDF",
    editable: false,
    match: (file) => file.ext === "pdf",
    load: () => import("./PdfViewer"),
  },
  {
    // Previews only (issue #342). Editing a model is its application's app.
    id: "model",
    label: "3D model",
    editable: false,
    match: (file) => MODEL_EXTENSIONS.has(file.ext),
    load: () => import("./ModelViewer"),
  },
  {
    id: "blend",
    label: "Blender file",
    editable: false,
    match: (file) => file.ext === "blend",
    load: () => import("./BlendViewer"),
  },
  {
    id: "media",
    label: "Audio and video",
    editable: false,
    match: (file) => AUDIO_EXTENSIONS.has(file.ext) || VIDEO_EXTENSIONS.has(file.ext),
    load: () => import("./MediaViewer"),
  },
  {
    id: "font",
    label: "Font",
    editable: false,
    match: (file) => FONT_EXTENSIONS.has(file.ext),
    load: () => import("./FontViewer"),
  },
  {
    id: "mermaid",
    label: "Mermaid diagram",
    editable: false,
    match: (file) => file.ext === "mmd" || file.ext === "mermaid",
    load: () => import("./MermaidViewer"),
  },
  {
    // Opt-in: `.md` opens as source. See `optIn` and `preview/`.
    id: "markdown",
    label: "Markdown preview",
    editable: false,
    optIn: true,
    match: (file) => file.ext === "md" || file.ext === "markdown",
    load: () => import("./MarkdownViewer"),
  },
  {
    id: "html",
    label: "HTML preview",
    editable: false,
    optIn: true,
    match: (file) => file.ext === "html" || file.ext === "htm",
    load: () => import("./HtmlViewer"),
  },
  {
    // The fallback, not an extension list. Anything that is not one of the
    // above is *tried* as text, because a name cannot say whether bytes decode.
    id: "text",
    label: "Text",
    editable: true,
    match: () => true,
    load: () => import("./TextViewer"),
  },
  {
    // Never reached by `pick` — `text` matches everything above it. Reachable
    // only through `reopenWith("unsupported")`, which is exactly what the text
    // viewer does when the read fails as not-UTF-8. Listed here so it has an
    // id and a label like any other viewer rather than being a special case
    // hidden inside `Viewer.tsx`.
    id: "unsupported",
    label: "Unsupported",
    editable: false,
    match: () => true,
    load: () => import("./UnsupportedViewer"),
  },
];

/** The first viewer that claims this file. Never `undefined` — `text` matches all. */
export function pick(file: OpenFile): ViewerDescriptor {
  return (
    VIEWERS.find((viewer) => !viewer.optIn && viewer.match(file)) ?? VIEWERS[VIEWERS.length - 1]
  );
}

/** A viewer by id, for `reopenWith`. `undefined` if the id is not registered. */
export function byId(id: string): ViewerDescriptor | undefined {
  return VIEWERS.find((viewer) => viewer.id === id);
}

/** A `Stat` narrowed to what a viewer needs, with the extension worked out. */
export function toOpenFile(stat: Stat, ext: string): OpenFile {
  return { path: stat.path, name: stat.name, ext, size: stat.size, mtime: stat.mtime };
}
