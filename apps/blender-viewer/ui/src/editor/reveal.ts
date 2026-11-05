/**
 * Mentions in the Blender editor pane (`apps/shared/editorMention.ts`): what
 * it publishes for the agent tab's @ menu, where a tab mention's things are,
 * and how a chip clicked in the agent tab is shown in the running Blender.
 */
import type { EditorReport, MentionPlace, Reveal } from "../../../../shared/editorMention";
import { editorSelect, type BlenderEditorInfo } from "./rpc";

/**
 * The running Blender as the agent tab lists it: the view layer's objects
 * (just the selection, from a boot script before v3). `null` with no Blender.
 */
export function blenderReport(editor: BlenderEditorInfo | null): EditorReport | null {
  if (!editor) return null;
  const view = editor.view;
  const selected = view?.selected ?? [];
  return {
    tool: "blender",
    scene: editor.file,
    scenes: [],
    nodes: (view?.objects ?? selected).map(({ name, type }) => ({ path: name, type })),
    selected: selected.map((o) => o.name),
  };
}

/** Where a tab mention's things are: the open file, each object's type. */
export function blenderPlace(editor: BlenderEditorInfo | null): MentionPlace {
  const view = editor?.view;
  return {
    root: null,
    file: editor?.file ?? null,
    node: (name) => {
      const found =
        view?.selected.find((o) => o.name === name) ?? view?.objects?.find((o) => o.name === name);
      return found ? { type: found.type } : undefined;
    },
  };
}

/**
 * Show what a chip names in the running Blender: its objects are selected,
 * the first active. A chip from another file says so instead, since opening
 * that file would leave this one. Resolves to a notice, or `null`.
 */
export async function revealInBlender(
  r: Reveal,
  editor: BlenderEditorInfo,
): Promise<string | null> {
  const wanted = r.file ?? r.scene ?? null;
  const same = (a: string, b: string) => a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
  if (wanted && editor.file && !same(wanted, editor.file)) {
    return `That is in ${wanted}; this Blender has ${editor.file} open.`;
  }
  if (!r.nodes?.length) return null;
  // Blender refuses the whole select for one unknown name, so ask only for the ones it has.
  const known = editor.view?.objects?.map((o) => o.name);
  const here = known ? r.nodes.filter((n) => known.includes(n)) : r.nodes;
  const missing = r.nodes.filter((n) => !here.includes(n));
  if (here.length) await editorSelect(here);
  return missing.length ? `Not in this file now: ${missing.join(", ")}.` : null;
}
