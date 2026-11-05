/**
 * Send selection in Blender's Editor mode: the objects selected in Blender and
 * its 3D view, to the agent as one message. One capture reads the picture, the
 * view and the selection at the same moment (`blender-viewer/editor-capture`);
 * this puts them in the context store as two items and leaves one chip, the
 * selection's, at the prompt of the agent last worked in, never pressing Enter
 * (DECISIONS X8), as the Godot editor's Send selection does. Its prompt names
 * the picture's file, so the agent opens it.
 *
 * Both keys name the file and never the moment, so sending the same file's
 * selection again replaces the two items instead of adding two more.
 */
import { invoke } from "@veistra/bridge";
import type { CameraPose } from "@veistra/markup";
import {
  chipToAgent,
  contextKey,
  putWithAttached,
  type ContextRef,
} from "../../../../shared/context";
import type { ViewCamera, ViewportCapture } from "./rpc";

const vec = (v: number[]) => `(${v.map((n) => Math.round(n * 100) / 100).join(", ")})`;

const leaf = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1) || p;

/** `props/bed.blend` as a key part: `props/bed`. */
const fileKey = (file: string | null) => (file ?? "unsaved").replace(/\.blend$/i, "");

function cameraLine(c: ViewCamera | undefined, perspective: string | undefined): string | null {
  if (!c?.pos || !c.target) return null;
  const lens = typeof c.fov === "number" ? `fov ${Math.round(c.fov * 10) / 10}` : "orthographic";
  const through = perspective === "CAMERA" ? " through the scene camera" : "";
  return `3D view${through} at ${vec(c.pos)} looking at ${vec(c.target)}, ${lens}.`;
}

/** What the agent reads: the file, each object with its type, the active one and the view. */
export function selectionText(
  cap: Pick<ViewportCapture, "file" | "selected" | "active" | "view">,
): string {
  const file = cap.file || "an unsaved file";
  const count = cap.selected.length === 1 ? "1 object" : `${cap.selected.length} objects`;
  const lines = [`Blender selection in ${file} (${count}):`];
  for (const o of cap.selected) {
    lines.push(`- ${o.name} (${o.type.toLowerCase()}${o.name === cap.active ? ", active" : ""})`);
  }
  const camera = cameraLine(cap.view?.camera, cap.view?.perspective);
  if (camera) lines.push(camera);
  lines.push("Blender's 3D view at that moment is attached beside this.");
  return lines.join("\n");
}

/** The view's camera as the markup format names it, when the boot script read all of it. */
export function cameraPose(c: ViewCamera | undefined): CameraPose | null {
  if (!c?.pos || !c.target || !c.up || typeof c.fov !== "number") return null;
  return { position: c.pos, target: c.target, up: c.up, fov: c.fov };
}

/**
 * The picture, then the selection naming it, then one chip. With no agent to
 * take it, the items are still in the Context strip, so that is not a
 * failure; `typed` says which it was.
 */
export async function sendSelection(
  cap: ViewportCapture,
): Promise<{ text: ContextRef; image: ContextRef; typed: boolean }> {
  const name = cap.file ? leaf(cap.file) : "unsaved file";
  const image = await invoke<ContextRef>("context/put", {
    key: contextKey("blender", fileKey(cap.file), "editor-viewport"),
    kind: "image",
    title: `Blender - ${name} 3D view`,
    label: "Blender - 3D view",
    bytesBase64: cap.pngBase64,
    prompt: "Blender's 3D view as it was when I selected those objects.",
  });
  const text = await putWithAttached(
    {
      key: contextKey("blender", fileKey(cap.file), "selection"),
      kind: "text",
      title: `Blender - selection in ${name}`,
      label: "Blender - selection",
      text: selectionText(cap),
      prompt: `The objects I selected in Blender, in ${cap.file || "an unsaved file"}. Use them for what I ask.`,
    },
    [{ item: image, what: "Blender's 3D view at that moment" }],
  );
  try {
    const said = await chipToAgent({ ...text, chipKind: "blender-selection" });
    return { text, image, typed: said.delivered };
  } catch (e) {
    console.error("veistra: could not hand the selection to an agent", e);
    return { text, image, typed: false };
  }
}
