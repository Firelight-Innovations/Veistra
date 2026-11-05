/**
 * Blender as a context provider: what this viewer can hand to an agent, and
 * how. The store itself (`context/put`, the strip beside each terminal) is the
 * host's; this file only decides what each thing is called and what kind of
 * item it becomes, so the viewer's buttons and its drag share one path.
 */
import { invoke } from "@veistra/bridge";
import { contextKey, type ContextRef } from "../../../shared/context";
import type { MarkupJson } from "@veistra/markup";
import {
  BLENDER_TARGET,
  blobBase64,
  putMarkup as putMarkupShared,
} from "../../../shared/markupFlow";
import { saveMarkup, type BlenderPart, type BlenderViewerState } from "./rpc";

export { dragContext } from "../../../shared/context";

/** The one-line summary a parts-list row shows: geometry for meshes and instances, the kind otherwise. */
export function partSummary(p: BlenderPart): string {
  if (p.kind === "mesh") {
    return `${p.materials.join(", ") || "no material"} · ${p.tris.toLocaleString()} tris`;
  }
  if (p.kind === "instance") {
    return `instance of ${p.instanceOf ?? "a collection"} · ${p.tris.toLocaleString()} tris`;
  }
  return p.kind;
}

/** The parts list as the plain text an agent reads: one line per object. */
export function partsText(state: BlenderViewerState): string {
  const head = `Blender scene ${state.rel ?? ""} (${state.parts.length} objects)`;
  const rows = state.parts.map((p: BlenderPart) => {
    if (p.kind === "instance") {
      return [
        p.name,
        "instance",
        `of ${p.instanceOf ?? "a collection"}`,
        `${p.tris} tris`,
        `${p.verts} verts`,
        p.parent ? `parent ${p.parent}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
    }
    if (p.kind !== "mesh") return `${p.name} | ${p.kind}${p.parent ? ` | parent ${p.parent}` : ""}`;
    const dims = p.dimensions.map((d) => d.toFixed(2)).join(" x ");
    return [
      p.name,
      "mesh",
      `${p.tris} tris`,
      `${p.verts} verts`,
      p.materials.join(", ") || "no material",
      dims ? `${dims} m` : "",
      p.visible ? "" : "hidden",
      p.parent ? `parent ${p.parent}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  });
  return [head, ...rows].join("\n");
}

/** The blend as a key part: `art/crate.blend` is `art/crate`. */
function blendKey(rel: string | null): string {
  return (rel ?? "scene").replace(/\.blend$/i, "");
}

/** `view` is the render's own id (front, top, three-quarter...), not its label. */
export function putRender(base64: string, label: string, rel: string | null, view: string = label) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("blender", blendKey(rel), view),
    kind: "image",
    title: `${rel ?? "Blender"} - ${label}`,
    label: `Blender - ${label}`,
    bytesBase64: base64,
    prompt: `A ${label} render of the Blender file ${rel ?? "I have open"}. Use it for what I ask about how the model looks.`,
  });
}

export function putParts(state: BlenderViewerState) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("blender", blendKey(state.rel), "parts"),
    kind: "text",
    title: `${state.rel ?? "Blender"} - parts`,
    label: "Blender - parts list",
    text: partsText(state),
    prompt: `Every object in the Blender file ${state.rel ?? "I have open"}, one per line. Use it for what I ask about the model.`,
  });
}

export function putGlb(state: BlenderViewerState) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("blender", blendKey(state.rel), "model"),
    kind: "file",
    title: `${state.rel ?? "Blender"} - model`,
    label: "Blender - .glb",
    path: state.model,
    prompt: `The Blender file ${state.rel ?? "I have open"} exported as glTF binary. Use it for what I ask about the model.`,
  });
}

/** The picture's item, for a drag onto a terminal. */
export const putMarkup = (png: Blob, json: MarkupJson, rel: string | null) =>
  putMarkupShared(BLENDER_TARGET, png, json, rel);

/** Keeps the picture and JSON a markup was drawn on, beside this `.blend`'s export. */
export async function keepMarkup(png: Blob, json: MarkupJson, blend: string): Promise<void> {
  await saveMarkup(blend, await blobBase64(png), JSON.stringify(json));
}
