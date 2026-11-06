/**
 * Files that open in their engine rather than as text: a `.blend` in a Blender
 * tab of its own, a Godot scene in the Godot editor. Only for a deliberate open
 * (double click, Enter, a search hit); a single-click peek still shows the
 * file in the File Viewer, so browsing never starts an engine.
 *
 * The payloads are the target apps' own: `{ blend }` is the file a Blender tab
 * opens on (the shell gives each `.blend` its tab, `FILE_TAB_APPS` in
 * `ToolWindow.tsx`), and a Godot scene is a reveal (`editorMention.ts`), which
 * the editor starts on or, already running, opens.
 */
export interface EngineOpen {
  appId: string;
  payload: unknown;
}

const BLENDER_APP = "blender-viewer";
const GODOT_APP = "godot-viewer";

/** `path` relative to the environment root `root`, with `/`; `null` outside it. */
export function relativeTo(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const full = norm(path);
  const fold = /^[a-z]:/i.test(base);
  const same = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(full.slice(0, base.length), base) || full[base.length] !== "/") return null;
  return full.slice(base.length + 1);
}

/** Where a deliberate open of `path` goes, or `null` for the File Viewer. */
export function engineOpen(path: string, root: string | null): EngineOpen | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".blend")) return { appId: BLENDER_APP, payload: { blend: path } };
  if (lower.endsWith(".tscn") || lower.endsWith(".scn")) {
    const file = root ? relativeTo(root, path) : null;
    if (file) return { appId: GODOT_APP, payload: { reveal: { tool: "godot", file } } };
  }
  return null;
}
