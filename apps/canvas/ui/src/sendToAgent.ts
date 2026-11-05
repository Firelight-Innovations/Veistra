/**
 * Canvas as a context provider (CX-4): a selection as a PNG, and a spec card as
 * JSON text, sent to the agent working in this environment. The store and the
 * strip beside each terminal are the host's (`context/put`); this file decides
 * what each thing is and what it is called, so the buttons and the drag share
 * one path. The image is rendered by Excalidraw's own exporter, loaded on the
 * first send, not with the editor.
 */
import { invoke } from "@veistra/bridge";
import { contextKey, type ContextRef } from "../../../shared/context";
import type { SceneElement } from "./scene";

export { dragContext } from "../../../shared/context";

/** The store refuses an image above this many bytes (`src-tauri/src/context.rs`). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Scales tried in turn until the PNG fits under the limit. */
export const SCALES = [2, 1, 0.5, 0.25] as const;

/**
 * The elements a selection draws: what is selected, the members of any selected
 * frame, and the text bound inside a selected shape. Exporting only the selected
 * ids would send an empty frame and shapes without their labels.
 */
export function selectionElements(
  elements: readonly SceneElement[],
  selectedIds: Record<string, unknown> | undefined,
): SceneElement[] {
  const picked = new Set(Object.keys(selectedIds ?? {}).filter((id) => selectedIds?.[id]));
  if (picked.size === 0) return [];
  return elements.filter((el) => {
    if (el.isDeleted) return false;
    if (picked.has(el.id)) return true;
    const frame = el.frameId;
    if (typeof frame === "string" && picked.has(frame)) return true;
    const container = el.containerId;
    return typeof container === "string" && picked.has(container);
  });
}

/** How many elements the user picked, which is what the button offers to send. */
export function selectedCount(selectedIds: Record<string, unknown> | undefined): number {
  return Object.keys(selectedIds ?? {}).filter((id) => selectedIds?.[id]).length;
}

/** Standard base64 of a blob, without a `data:` prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Render `elements` as a PNG that fits the store: the largest of `SCALES` under
 * `limit` bytes. `render` is the exporter, passed in so this is testable.
 */
export async function renderWithinLimit(
  render: (scale: number) => Promise<Blob>,
  limit = MAX_IMAGE_BYTES,
): Promise<Blob> {
  for (const scale of SCALES) {
    const blob = await render(scale);
    if (blob.size <= limit) return blob;
  }
  throw new Error("The selection is too large to send as an image, even at a small scale.");
}

interface Exportable {
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  dark: boolean;
}

/** A selection as a PNG, through Excalidraw's exporter. */
export async function exportSelectionPng({
  elements,
  appState,
  files,
  dark,
}: Exportable): Promise<Blob> {
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  return renderWithinLimit((scale) =>
    exportToBlob({
      elements: elements as never,
      appState: {
        ...appState,
        exportBackground: true,
        exportWithDarkMode: dark,
      } as never,
      files: files as never,
      mimeType: "image/png",
      exportPadding: 16,
      getDimensions: (width: number, height: number) => ({
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        scale,
      }),
    }),
  );
}

export async function putSelectionImage(
  png: Blob,
  canvasTitle: string,
  count: number,
): Promise<ContextRef> {
  const noun = count === 1 ? "1 element" : `${count} elements`;
  return invoke<ContextRef>("context/put", {
    key: contextKey("canvas", canvasTitle, "selection"),
    kind: "image",
    title: `Design - ${canvasTitle}, ${noun}`,
    label: `Design - ${canvasTitle}`,
    bytesBase64: await blobToBase64(png),
    prompt: `${noun} I selected on the design canvas ${canvasTitle}, as a picture. Use it for what I ask.`,
  });
}

/** A spec card as the text an agent reads: which canvas it is on, then the JSON. */
export function specText(canvasPath: string, json: string): string {
  return `Spec card from ${canvasPath}\n\`\`\`json\n${json}\n\`\`\``;
}

export function putSpecCard(name: string, canvasPath: string, json: string) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("canvas", canvasPath, "spec", name),
    kind: "text",
    title: `Spec - ${name}`,
    label: `Spec - ${name}`,
    text: specText(canvasPath, json),
    prompt: `The spec card "${name}" from the design canvas ${canvasPath}, as JSON. Build or check against it for what I ask.`,
  });
}
