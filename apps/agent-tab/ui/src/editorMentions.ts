/**
 * The agent tab's half of mentions with the Godot and Blender editors
 * (`apps/shared/editorMention.ts`): the @ menu lists what the running editors
 * have open, from what their panes publish, and a chip clicked in the tab
 * shows its thing in the editor's pane.
 */
import { useEffect, useState } from "react";
import { invoke, openIn, subscribe } from "@veistra/bridge";
import {
  EDITOR_TOPIC,
  envPath,
  putTarget,
  revealFile,
  revealFor,
  targetLabel,
  TARGET_MARK,
  type EditorReport,
  type EditorTarget,
  type EditorTool,
  type ResolvedRef,
} from "../../../shared/editorMention";
import type { MentionHit } from "./mentions";

export type EditorReports = Partial<Record<EditorTool, EditorReport | null>>;

/** Every editor hit's uri starts with this; it is the menu's, never a chip's. */
export const EDITOR_HIT = "editor:";

/** The kinds the @ menu draws an editor hit as, each with its own icon and colour. */
export const EDITOR_KINDS = ["godot-node", "godot-scene", "blender-object"] as const;

const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/** What the running editors report, kept as each pane publishes it. */
export function useEditorReports(): EditorReports {
  const [reports, setReports] = useState<EditorReports>({});
  useEffect(() => {
    const offs = (Object.keys(EDITOR_TOPIC) as EditorTool[]).map((tool) =>
      subscribe(EDITOR_TOPIC[tool], (value) =>
        setReports((now) => ({ ...now, [tool]: (value as EditorReport | null) ?? null })),
      ),
    );
    return () => offs.forEach((off) => off());
  }, []);
  return reports;
}

/**
 * The @ menu's rows for the running editors: Godot's scene nodes and open
 * scenes, Blender's objects. Selected things come first, as the likeliest
 * to be meant.
 */
export function editorHits(reports: EditorReports): MentionHit[] {
  const hits: MentionHit[] = [];
  const godot = reports.godot;
  if (godot) {
    const scene = godot.scene ? leaf(godot.scene) : "";
    const picked = new Set(godot.selected);
    const nodes = [...godot.nodes].sort(
      (a, b) => Number(picked.has(b.path)) - Number(picked.has(a.path)),
    );
    for (const node of nodes) {
      hits.push({
        uri: `${EDITOR_HIT}godot:node:${node.path}`,
        kind: "godot-node",
        title: leaf(node.path),
        detail: [node.type, scene].filter(Boolean).join(" · "),
      });
    }
    const scenes = godot.scenes.length ? godot.scenes : godot.scene ? [godot.scene] : [];
    for (const res of scenes) {
      hits.push({
        uri: `${EDITOR_HIT}godot:scene:${res}`,
        kind: "godot-scene",
        title: leaf(res),
        detail: res,
      });
    }
  }
  const blender = reports.blender;
  if (blender) {
    const picked = new Set(blender.selected);
    const objects = [...blender.nodes].sort(
      (a, b) => Number(picked.has(b.path)) - Number(picked.has(a.path)),
    );
    for (const object of objects) {
      hits.push({
        uri: `${EDITOR_HIT}blender:object:${object.path}`,
        kind: "blender-object",
        title: object.path,
        detail: [object.type?.toLowerCase(), blender.scene ? leaf(blender.scene) : ""]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }
  return hits;
}

/** The hits whose name or detail holds what was typed after `@`. */
export function matchingHits(hits: readonly MentionHit[], query: string): MentionHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...hits];
  return hits.filter((h) => `${h.title} ${h.detail ?? ""}`.toLowerCase().includes(q));
}

/** What a picked editor hit becomes: the chip's reference, its words and its kind. */
export interface EditorChip {
  uri: string;
  title: string;
  kind: string;
}

/**
 * Make the chip for a picked editor hit. A node or object is a context item
 * holding its `EditorTarget`, so a click can select it again; a scene is the
 * project file itself. `null` when the editor no longer reports it.
 */
export async function editorChip(uri: string, reports: EditorReports): Promise<EditorChip | null> {
  const m = /^editor:(godot|blender):(node|scene|object):(.+)$/.exec(uri);
  if (!m) return null;
  const [, tool, what, name] = m as unknown as [string, EditorTool, string, string];
  const report = reports[tool];
  if (!report) return null;
  if (what === "scene") {
    const rel = envPath(report.project, name);
    return rel ? { uri: `veistra://file/${rel}`, title: leaf(name), kind: "godot-scene" } : null;
  }
  const node = report.nodes.find((n) => n.path === name) ?? { path: name };
  const target: EditorTarget = {
    veistra: TARGET_MARK,
    tool,
    ...(tool === "godot" ? { project: report.project ?? "." } : {}),
    scene: report.scene,
    nodes: [node],
  };
  const item = await putTarget(target);
  return {
    uri: `veistra://context/${item.id}`,
    title: targetLabel(target),
    kind: tool === "godot" ? "godot-node" : "blender-object",
  };
}

/** The chip kinds an editor made; their chips are context items `revealChip` resolves. */
const EDITOR_CHIP = new Set<string>(["godot", "blender", ...EDITOR_KINDS]);

/**
 * Whether a sent chip opens in an editor when clicked, known without asking
 * the host: an editor's own chip, by the kind it was made with, or a file
 * `revealFile` sends to Blender's or the running Godot's pane.
 */
export function opensInEditor(uri: string, kind: string | null, reports: EditorReports): boolean {
  if (kind && EDITOR_CHIP.has(kind)) return true;
  return revealFile(uri, reports) !== null;
}

/**
 * A chip clicked in the tab: if it names something an editor can show, open
 * that editor's pane with it, and answer `true`. Anything else is `false`,
 * so the click does what it did before.
 */
export async function revealChip(uri: string, reports: EditorReports): Promise<boolean> {
  let where: ReturnType<typeof revealFile> = null;
  if (uri.startsWith("veistra://file/")) {
    // A file's own reference says what it is; there is nothing to read.
    where = revealFile(uri, reports);
  } else if (uri.startsWith("veistra://context/")) {
    try {
      where = revealFor(await invoke<ResolvedRef>("refs/resolve", { uri }), reports);
    } catch {
      return false;
    }
  }
  if (!where) return false;
  await openIn(where.app, { reveal: where.reveal });
  return true;
}
