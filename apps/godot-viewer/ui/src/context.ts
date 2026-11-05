/**
 * The Godot Viewer as a context provider: the scene tree as text and the
 * rendered frame as an image, for the agent working in this environment. The
 * store and the strip beside each terminal are the host's (`context/put`).
 */
import { invoke } from "@veistra/bridge";
import { contextKey, type ContextRef } from "../../../shared/context";
import type { MarkupJson } from "@veistra/markup";
import {
  GODOT_TARGET,
  blobBase64,
  putMarkup as putMarkupShared,
  sendMarkup as sendMarkupShared,
} from "../../../shared/markupFlow";
import { saveMarkup, type GodotNode, type GodotViewerState } from "./rpc";

export { dragContext } from "../../../shared/context";

/** The tree as indented text: name, class, and the script or scene behind it. */
export function treeText(state: Pick<GodotViewerState, "scenePath" | "source" | "nodes">): string {
  const how = state.source === "parsed" ? "read from the scene file" : "read by Godot";
  const rows: string[] = [`Godot scene ${state.scenePath ?? ""} (${how})`];
  const walk = (node: GodotNode, depth: number) => {
    const extra = [
      node.script && `script ${node.script}`,
      node.instance && `scene ${node.instance}`,
    ]
      .filter(Boolean)
      .join(", ");
    rows.push(`${"  ".repeat(depth)}${node.name} (${node.type})${extra ? ` - ${extra}` : ""}`);
    node.children.forEach((c) => walk(c, depth + 1));
  };
  state.nodes.forEach((n) => walk(n, 0));
  return rows.join("\n");
}

export function putTree(state: GodotViewerState) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("godot", state.scenePath ?? "scene", "tree"),
    kind: "text",
    title: `${state.scenePath ?? "Godot"} - scene tree`,
    label: "Godot - scene tree",
    text: treeText(state),
    prompt: `The node tree of the Godot scene ${state.scenePath ?? "I have open"}, as Veistra reads it. Use it for what I ask about the scene.`,
  });
}

export function putFrame(base64: string, scenePath: string | null) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("godot", scenePath ?? "scene", "frame"),
    kind: "image",
    title: `${scenePath ?? "Godot"} - rendered view`,
    label: "Godot - rendered view",
    bytesBase64: base64,
    prompt: `How the Godot scene ${scenePath ?? "I have open"} renders right now. Use it for what I ask about how it looks.`,
  });
}

export { base64Blob, markupJsonText } from "../../../shared/markupFlow";

/** The picture's item, for a drag onto a terminal. */
export const putMarkup = (png: Blob, json: MarkupJson, scenePath: string | null) =>
  putMarkupShared(GODOT_TARGET, png, json, scenePath);

/**
 * Attaches a markup as context and types `@path` references to it at the
 * agent's prompt; the shared flow, as Godot.
 */
export const sendMarkup = (png: Blob, json: MarkupJson, scenePath: string | null) =>
  sendMarkupShared(GODOT_TARGET, png, json, scenePath);

/** Keeps the picture and JSON a markup was drawn on, so it can be looked at again. */
export async function keepMarkup(png: Blob, json: MarkupJson, scene: string): Promise<void> {
  await saveMarkup(scene, await blobBase64(png), JSON.stringify(json));
}
