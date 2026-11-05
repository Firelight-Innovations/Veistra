/**
 * Mentions between the agent tab and the Godot and Blender editors, both ways.
 *
 * - Editor to agent: Mention in agent (the Godot dock, Blender's tab, their
 *   right-click menus, Ctrl+Alt+M) is a `mention` line in `events.jsonl`; the
 *   pane makes one context item of what it names and hands it to the agent
 *   tab last worked in as a chip, nothing typed (`editorEvents.ts`). The
 *   agent tab's @ menu makes the same items from what the panes publish.
 * - Agent to editor: a chip clicked in the agent tab resolves to its item.
 *   Nodes and objects carry an `EditorTarget` as their JSON; a scene, script
 *   or `.blend` is the file itself. Either becomes a `reveal` the agent tab
 *   opens in the editor's pane (`veistra/open`), which selects or opens it.
 *
 * Nodes and objects are JSON items, so the agent reads the same fields the
 * pane acts on; a file is referenced where it is, so the agent reads the file.
 */
import { invoke } from "@veistra/bridge";
import { chipAllToAgent, contextKey, type ContextRef } from "./context";
import { fileName } from "./fileContext";

export type EditorTool = "godot" | "blender";

/** The app each editor's pane is. */
export const EDITOR_APP: Record<EditorTool, string> = {
  godot: "godot-viewer",
  blender: "blender-viewer",
};

/** What each pane publishes about its running editor, for the agent tab's @ menu. */
export const EDITOR_TOPIC: Record<EditorTool, string> = {
  godot: "godot/editor",
  blender: "blender/editor",
};

/** Marks a context item's JSON as something an editor can select again. */
export const TARGET_MARK = "veistra-editor-target";

export interface TargetNode {
  /** Godot: `Root/child`. Blender: the object's name. */
  path: string;
  type?: string;
  /** Godot: the node's script, `res://`, when it has one. */
  script?: string;
}

/** Selected nodes in a Godot scene, or objects in a Blender file. */
export interface EditorTarget {
  veistra: typeof TARGET_MARK;
  tool: EditorTool;
  /** Godot: the project folder, environment-relative (`.` for the root). */
  project?: string;
  /** Godot: the scene, `res://`. Blender: the `.blend`, environment-relative. */
  scene: string | null;
  nodes: TargetNode[];
}

/** What a pane is asked to show, in a `veistra/open` payload's `reveal`. */
export interface Reveal {
  tool: EditorTool;
  /** Godot: the project the scene is in. */
  project?: string;
  /** Godot: a `res://` scene. Blender: the `.blend`, environment-relative. */
  scene?: string | null;
  /** Node paths or object names to select. */
  nodes?: string[];
  /** An environment-relative file to open in the editor. */
  file?: string;
}

/** What a pane publishes under `EDITOR_TOPIC`: the running editor, or `null`. */
export interface EditorReport {
  tool: EditorTool;
  /** Godot: the project folder, environment-relative. */
  project?: string;
  /** Godot: the edited scene, `res://`. Blender: the open file, environment-relative. */
  scene: string | null;
  /** Godot: the open scenes. */
  scenes: string[];
  nodes: TargetNode[];
  selected: string[];
}

const WORDS: Record<EditorTool, { app: string; node: string; nodes: string; place: string }> = {
  godot: { app: "Godot", node: "node", nodes: "nodes", place: "scene" },
  blender: { app: "Blender", node: "object", nodes: "objects", place: "file" },
};

const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/** `res://levels/a.tscn` in project `game` is `game/levels/a.tscn` from the environment root. */
export function envPath(project: string | undefined, res: string): string | null {
  if (!res.startsWith("res://") || res.includes("..")) return null;
  const inner = res.slice("res://".length);
  return !project || project === "." ? inner : `${project.replace(/\/+$/, "")}/${inner}`;
}

/** The inverse of `envPath`: `null` when the file is not in that project. */
export function resPath(project: string | undefined, rel: string): string | null {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.includes("..")) return null;
  if (!project || project === ".") return `res://${clean}`;
  const prefix = `${project.replace(/\/+$/, "")}/`;
  return clean.startsWith(prefix) ? `res://${clean.slice(prefix.length)}` : null;
}

/** The chip's words: `Godot · Enemy_02`, `Blender · 3 objects`. */
export function targetLabel(t: EditorTarget): string {
  const words = WORDS[t.tool];
  const what = t.nodes.length === 1 ? leaf(t.nodes[0].path) : `${t.nodes.length} ${words.nodes}`;
  return `${words.app} · ${what}`;
}

/** What the agent is asked, which the chip does not show. */
export function targetPrompt(t: EditorTarget): string {
  const words = WORDS[t.tool];
  const named = t.nodes.map((n) => n.path).join(", ");
  const where = t.scene ? ` in the ${words.place} ${t.scene}` : "";
  const project = t.project && t.project !== "." ? ` (Godot project ${t.project})` : "";
  const noun = t.nodes.length === 1 ? words.node : words.nodes;
  return (
    `The ${words.app} ${noun} ${named}${where}${project}, which I pointed at in the editor. ` +
    `Its fields are below; look at it for what I ask.`
  );
}

/** The agent tab's chip kind for a tool's nodes or objects, and for its files. */
export const CHIP_KIND: Record<EditorTool, { node: string; file: string }> = {
  godot: { node: "godot-node", file: "godot-scene" },
  blender: { node: "blender-object", file: "blender" },
};

/** One item for nodes or objects; the same nodes in the same place replace it. */
export async function putTarget(t: EditorTarget): Promise<ContextRef> {
  const item = await invoke<ContextRef>("context/put", {
    key: contextKey(
      t.tool,
      t.project,
      t.scene,
      "mention",
      t.nodes
        .map((n) => n.path)
        .sort()
        .join("+"),
    ),
    kind: "json",
    title: `${WORDS[t.tool].app} - ${t.nodes.map((n) => leaf(n.path)).join(", ")}`,
    label: targetLabel(t),
    text: JSON.stringify(t, null, 2),
    prompt: targetPrompt(t),
  });
  return { ...item, chipKind: CHIP_KIND[t.tool].node };
}

/** A scene, script, resource or `.blend` by its absolute path, read where it is. */
export async function putEditorFile(
  tool: EditorTool,
  abs: string,
  rel: string,
): Promise<ContextRef> {
  const item = await invoke<ContextRef>("context/put", {
    kind: "file",
    title: rel,
    label: `${WORDS[tool].app} · ${fileName(rel)}`,
    path: abs,
    prompt: `The ${WORDS[tool].app} file ${rel}, which I pointed at in the editor; look at it for what I ask.`,
  });
  // A script or resource is Godot's, but not a scene.
  const scene = tool === "blender" || /\.t?scn$/i.test(rel);
  return { ...item, chipKind: scene ? CHIP_KIND[tool].file : tool };
}

/** A picture of the viewport, sent on its own. */
export function putViewport(
  tool: EditorTool,
  place: string | null,
  n: number,
  pngBase64: string,
): Promise<ContextRef> {
  const view = tool === "godot" ? "viewport" : "3D view";
  return invoke<ContextRef>("context/put", {
    key: contextKey(tool, place, `mention-${n}-view`),
    kind: "image",
    title: `${WORDS[tool].app} - ${place ? leaf(place) : ""} ${view}`.replace(/\s+/g, " "),
    label: `${WORDS[tool].app} · ${view}`,
    bytesBase64: pngBase64,
    prompt: `The ${WORDS[tool].app} ${view} as I see it now; look at it for what I ask.`,
  });
}

/** A Mention in agent line, as the backend hands it on (`editor_notes.rs`). */
export interface MentionEvent {
  seq: number;
  n: number;
  t: number;
  kind: "mention";
  what: "selection" | "scene" | "file" | "viewport";
  /** Godot: the edited scene, `res://`. Blender: the open file's absolute path. */
  scene: string | null;
  nodes: string[];
  /** `file`: the `res://` script or resource. */
  path: string | null;
  pngBase64: string | null;
  pngProblem: string | null;
}

/** What a pane knows that the line does not: where things are, what they are. */
export interface MentionPlace {
  /** Godot: the project folder, environment-relative. */
  project?: string;
  /** The environment root, absolute; `null` when not known yet. */
  root: string | null;
  /** Blender: the open file, environment-relative. */
  file?: string | null;
  /** A node's or object's type and script, from the editor's last state. */
  node?: (path: string) => { type?: string; script?: string } | undefined;
}

const join = (root: string, rel: string) =>
  `${root.replace(/[\\/]+$/, "")}/${rel}`.replace(/\\/g, "/");

/** The items one mention makes: what it names, as the pane can say it. */
export async function mentionItems(
  tool: EditorTool,
  e: MentionEvent,
  place: MentionPlace,
): Promise<ContextRef[]> {
  const words = WORDS[tool];
  switch (e.what) {
    case "selection": {
      const target: EditorTarget = {
        veistra: TARGET_MARK,
        tool,
        ...(tool === "godot" ? { project: place.project ?? "." } : {}),
        scene: tool === "godot" ? e.scene || null : (place.file ?? null),
        nodes: e.nodes.map((path) => ({ path, ...place.node?.(path) })),
      };
      return [await putTarget(target)];
    }
    case "scene":
    case "file": {
      const named = e.what === "file" ? e.path : e.scene;
      if (!named) throw new Error(`The ${words.app} editor named no ${words.place}.`);
      if (tool === "blender") {
        const rel = place.file ?? fileName(named);
        return [await putEditorFile(tool, named, rel)];
      }
      const rel = envPath(place.project, named);
      if (!rel) throw new Error(`${named} is not a file in this project.`);
      if (!place.root) throw new Error("Veistra does not know where this environment is yet.");
      return [await putEditorFile(tool, join(place.root, rel), rel)];
    }
    case "viewport": {
      if (!e.pngBase64) throw new Error(e.pngProblem ?? "The editor sent no picture.");
      const where = tool === "godot" ? e.scene : (place.file ?? e.scene);
      return [await putViewport(tool, where, e.n, e.pngBase64)];
    }
  }
}

/** Mention in agent: the items, as chips at the agent tab last worked in. */
export async function sendMention(
  tool: EditorTool,
  e: MentionEvent,
  place: MentionPlace,
): Promise<string> {
  const items = await mentionItems(tool, e, place);
  try {
    const said = await chipAllToAgent(items);
    if (said.delivered) return "In the agent's prompt.";
    return `It is in Veistra's Context strip, but no agent took it: ${said.reason}.`;
  } catch (err) {
    console.error("veistra: could not hand the mention to an agent", err);
    return "It is in Veistra's Context strip; no agent prompt was open to take it.";
  }
}

/** The target a context item's JSON holds, or `null` for any other JSON. */
export function asTarget(value: unknown): EditorTarget | null {
  const v = value as Partial<EditorTarget> | null;
  if (!v || typeof v !== "object" || v.veistra !== TARGET_MARK) return null;
  if (v.tool !== "godot" && v.tool !== "blender") return null;
  if (!Array.isArray(v.nodes) || !v.nodes.every((n) => typeof n?.path === "string")) return null;
  return {
    veistra: TARGET_MARK,
    tool: v.tool,
    ...(typeof v.project === "string" ? { project: v.project } : {}),
    scene: typeof v.scene === "string" ? v.scene : null,
    nodes: v.nodes,
  };
}

/** The slice of `refs/resolve`'s answer a click reads. */
export interface ResolvedRef {
  kind: string;
  meta?: Record<string, unknown>;
  parts?: Array<{ type: string; value?: unknown; text?: string; language?: string }>;
}

/** Where a click on a resolved chip goes: an editor's pane and what it shows, or `null`. */
export function revealFor(
  r: ResolvedRef,
  running: Partial<Record<EditorTool, EditorReport | null>>,
): { app: string; reveal: Reveal } | null {
  for (const part of r.parts ?? []) {
    let value: unknown = part.type === "json" ? part.value : undefined;
    if (part.type === "text" && part.language === "json" && part.text) {
      try {
        value = JSON.parse(part.text);
      } catch {
        value = undefined;
      }
    }
    const t = asTarget(value);
    if (t) {
      const reveal: Reveal = {
        tool: t.tool,
        ...(t.project ? { project: t.project } : {}),
        scene: t.scene,
        nodes: t.nodes.map((n) => n.path),
      };
      return { app: EDITOR_APP[t.tool], reveal };
    }
  }
  const file = typeof r.meta?.file === "string" ? r.meta.file : null;
  return file ? revealFile(file, running) : null;
}

const GODOT_FILES = /\.(tscn|scn|gd|tres|res|gdshader|cs)$/i;

/**
 * A `veistra://file/<rel>` chip: a `.blend` opens in Blender's pane; a scene,
 * script or resource in the running Godot editor's project opens there. Any
 * other file, or a Godot file with no Godot editor to show it, goes nowhere.
 */
export function revealFile(
  uri: string,
  running: Partial<Record<EditorTool, EditorReport | null>>,
): { app: string; reveal: Reveal } | null {
  const m = /^veistra:\/\/file\/([^#?]+)/.exec(uri);
  if (!m) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (/\.blend$/i.test(rel))
    return { app: EDITOR_APP.blender, reveal: { tool: "blender", file: rel } };
  const godot = running.godot;
  if (GODOT_FILES.test(rel) && godot && resPath(godot.project, rel)) {
    return {
      app: EDITOR_APP.godot,
      reveal: { tool: "godot", ...(godot.project ? { project: godot.project } : {}), file: rel },
    };
  }
  return null;
}

/** The reveal a `veistra/open` payload carries for `tool`, or `null`. */
export function revealOf(payload: unknown, tool: EditorTool): Reveal | null {
  const r = (payload as { reveal?: Partial<Reveal> } | null)?.reveal;
  if (!r || typeof r !== "object" || r.tool !== tool) return null;
  const nodes = Array.isArray(r.nodes) ? r.nodes.filter((n) => typeof n === "string") : undefined;
  return {
    tool,
    ...(typeof r.project === "string" ? { project: r.project } : {}),
    ...(typeof r.scene === "string" ? { scene: r.scene } : {}),
    ...(nodes?.length ? { nodes } : {}),
    ...(typeof r.file === "string" ? { file: r.file } : {}),
  };
}
