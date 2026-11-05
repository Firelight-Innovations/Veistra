/**
 * Files as context: what the File Viewer and the File Explorer hand to an agent
 * for a file on disk, and what each thing is called. The store (`context/put`,
 * the strip beside each terminal) is the host's; a path outside the environment
 * is copied in and one inside is referenced where it is, all decided in Rust.
 */
import { invoke } from "@veistra/bridge";
import { contextKey, type ContextRef } from "./context";

/** The formats the store accepts as an image, by their bytes. */
const RASTER = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
}

/** The path as written from the project root, or whole when it is not under it. */
export function relativePath(rootPath: string | null, path: string): string {
  if (!rootPath || !path.startsWith(rootPath)) return path;
  return path
    .slice(rootPath.length)
    .replace(/^[\\/]+/, "")
    .replace(/\\/g, "/");
}

/** Whether the store would take this file as an image rather than a file. */
export function isRaster(path: string): boolean {
  const dot = fileName(path).lastIndexOf(".");
  return (
    dot > 0 &&
    RASTER.has(
      fileName(path)
        .slice(dot + 1)
        .toLowerCase(),
    )
  );
}

/** A file by path: an image when it is one, a file otherwise. */
export function putFile(path: string, rel: string | null = null) {
  const name = rel ?? fileName(path);
  return invoke<ContextRef>("context/put", {
    kind: isRaster(path) ? "image" : "file",
    title: name,
    label: `File - ${fileName(path)}`,
    path,
    prompt: `The file ${name}, which I want you to look at for what I ask.`,
  });
}

/** `src/foo.ts:12-30`, or `src/foo.ts:12` for one line. */
export function lineRef(rel: string, startLine: number, endLine: number): string {
  return endLine > startLine ? `${rel}:${startLine}-${endLine}` : `${rel}:${startLine}`;
}

/** A selection as the plain text an agent reads: where it is, then what it says. */
export function selectionText(
  rel: string,
  startLine: number,
  endLine: number,
  snippet: string,
): string {
  return `${lineRef(rel, startLine, endLine)}\n\`\`\`\n${snippet}\n\`\`\``;
}

export function putSelection(rel: string, startLine: number, endLine: number, snippet: string) {
  const ref = lineRef(rel, startLine, endLine);
  return invoke<ContextRef>("context/put", {
    key: contextKey("file", ref),
    kind: "text",
    title: ref,
    label: `File - ${lineRef(fileName(rel), startLine, endLine)}`,
    text: selectionText(rel, startLine, endLine, snippet),
    prompt: `Lines ${ref} that I selected, which I want you to look at for what I ask.`,
  });
}

/** The Send to agent item is for a file that is there: not a folder, not blank space. */
export function canSendToAgent(target: {
  path: string | null;
  name: string | null;
  kind: string | null;
}): boolean {
  return target.path !== null && target.name !== null && target.kind === "file";
}
