/**
 * Send selection (#316, spec §13 test 11): the nodes selected in the Godot
 * editor and its 3D viewport, to the agent as one message. One plugin round
 * trip reads both at the same moment (`godot/editor-selection`); this puts
 * them in the context store as two items and types both references at the
 * prompt in one `context/insert`, without pressing Enter (DECISIONS X8).
 *
 * Both keys name the scene and never the moment, so sending the same scene's
 * selection again replaces the two items instead of adding two more.
 */
import { invoke } from "@veistra/bridge";
import { contextKey, type ContextRef } from "../../../../shared/context";
import type { EditorCamera, EditorSelection, SelectedNode } from "./rpc";

const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

const vec = (v: number[]) => `(${v.map((n) => Math.round(n * 100) / 100).join(", ")})`;

function nodeLine(n: SelectedNode): string {
  const script = n.script ? `, script ${n.script}` : "";
  return `- ${n.path} (${n.type}${script})`;
}

function cameraLine(c: EditorCamera | undefined): string | null {
  if (!c?.pos || !c.target) return null;
  const lens = c.orthogonal ? `orthogonal, size ${c.size ?? "?"}` : `fov ${c.fov ?? "?"}`;
  return `Editor camera at ${vec(c.pos)} looking at ${vec(c.target)}, ${lens}.`;
}

/** What the agent reads: the scene, each node with its type and script, and the camera. */
export function selectionText(sel: Pick<EditorSelection, "scene" | "selected" | "camera">): string {
  const nodes = sel.selected ?? [];
  const scene = sel.scene || "the open scene";
  const count = nodes.length === 1 ? "1 node" : `${nodes.length} nodes`;
  const lines = [`Godot editor selection in ${scene} (${count}):`, ...nodes.map(nodeLine)];
  const camera = cameraLine(sel.camera);
  if (camera) lines.push(camera);
  lines.push("The editor's 3D viewport at that moment is attached beside this.");
  return lines.join("\n");
}

/**
 * Both items, then both references at the prompt. With no agent prompt to
 * type into the items are still in the Context strip, so that is not a
 * failure; `typed` says which it was.
 */
export async function sendSelection(
  sel: EditorSelection,
): Promise<{ text: ContextRef; image: ContextRef; typed: boolean }> {
  const scene = sel.scene || "scene";
  const text = await invoke<ContextRef>("context/put", {
    key: contextKey("godot", scene, "selection"),
    kind: "text",
    title: `Godot editor - selection in ${leaf(scene)}`,
    label: "Godot - selection",
    text: selectionText(sel),
  });
  const image = await invoke<ContextRef>("context/put", {
    key: contextKey("godot", scene, "editor-viewport"),
    kind: "image",
    title: `Godot editor - ${leaf(scene)} viewport`,
    label: "Godot - viewport",
    bytesBase64: sel.pngBase64,
  });
  try {
    await invoke("context/insert", { itemIds: [text.id, image.id] });
    return { text, image, typed: true };
  } catch (e) {
    console.error("veistra: could not type the selection references at the prompt", e);
    return { text, image, typed: false };
  }
}
