/**
 * Mentions in the Godot editor pane (`apps/shared/editorMention.ts`): what it
 * publishes for the agent tab's @ menu, where a dock mention's things are,
 * and how a chip clicked in the agent tab is shown in the running editor.
 */
import {
  resPath,
  type EditorReport,
  type MentionPlace,
  type Reveal,
} from "../../../../shared/editorMention";
import { editorEdit, editorOpenScene, editorSelect, type EditorInfo } from "./rpc";

/**
 * The running editor as the agent tab lists it: the edited scene's nodes
 * (just the selection, from a plugin before v3), the open scenes. `null`
 * with no editor.
 */
export function godotReport(editor: EditorInfo | null): EditorReport | null {
  if (!editor) return null;
  const view = editor.view;
  const selected = view?.selected ?? [];
  return {
    tool: "godot",
    project: editor.project,
    scene: view?.scene || null,
    scenes: view?.open ?? [],
    nodes: view?.nodes ?? selected.map(({ path, type }) => ({ path, type })),
    selected: selected.map((n) => n.path),
  };
}

/** Where a dock mention's things are: the project, the environment, each node's type. */
export function godotPlace(editor: EditorInfo | null, root: string | null): MentionPlace {
  const view = editor?.view;
  return {
    project: editor?.project ?? ".",
    root,
    node: (path) => {
      const picked = view?.selected.find((n) => n.path === path);
      if (picked) return { type: picked.type, ...(picked.script ? { script: picked.script } : {}) };
      const listed = view?.nodes?.find((n) => n.path === path);
      return listed ? { type: listed.type } : undefined;
    },
  };
}

/**
 * Show what a chip names in the running editor: a file opens in its editor,
 * nodes are selected, after opening their scene when another is edited.
 * Resolves to a notice, or `null` when there is nothing to say.
 */
export async function revealInGodot(r: Reveal, editor: EditorInfo): Promise<string | null> {
  if (r.project && r.project !== editor.project) {
    return `That is in the project ${r.project}; this editor has ${editor.project} open.`;
  }
  if (r.file) {
    const res = resPath(editor.project, r.file);
    if (!res) return `${r.file} is not in the project ${editor.project}.`;
    await editorEdit(res);
    return null;
  }
  if (r.scene && r.scene !== editor.view?.scene) await editorOpenScene(r.scene);
  if (!r.nodes?.length) return null;
  const { missing } = await editorSelect(r.nodes);
  return missing.length ? `Not in the scene now: ${missing.join(", ")}.` : null;
}
