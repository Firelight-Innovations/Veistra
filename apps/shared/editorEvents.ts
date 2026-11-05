/**
 * The pane's half of the Veistra tab inside Godot and Blender (#320,
 * DECISIONS X5). A press in the editor's tab is a line in `events.jsonl`;
 * the backend hands each one on in the editor-state poll as
 * `editor.events`, numbered by `seq`, and keeps handing it on until it is
 * answered with editor-ack. This does what the press asks through the same
 * calls the pane's own buttons use, then answers it, and the answer is what
 * the tab shows.
 *
 * - Ask the agent: the question, the selection and the viewport go to the
 *   agent as two context items and one chip, the question's, whose prompt
 *   names the picture's file, at the prompt of the agent tab last worked in,
 *   never Enter (X8), as Send selection does.
 * - Looks good / Still broken: `comments/verdict`, expecting the note to be
 *   fixed still, so a press on a card the agent has since reopened is
 *   refused, not applied to the wrong state.
 * - Mark up the viewport: the mode's own Mark up.
 * - Mention in agent: what it names as one chip, nothing typed
 *   (`editorMention.ts`). A pane that gives no `place` refuses it.
 */
import { useCallback, useRef } from "react";
import { invoke } from "@veistra/bridge";
import { verdictComment, type Verdict } from "./comments";
import {
  chipToAgent,
  contextKey,
  putWithAttached,
  type Attachment,
  type ContextRef,
} from "./context";
import {
  sendMention,
  type EditorTool,
  type MentionEvent,
  type MentionPlace,
} from "./editorMention";

export type { MentionEvent } from "./editorMention";

interface Base {
  /** The backend's number for it; the poll asks for those after the last one taken. */
  seq: number;
  /** The editor's own number for it, which the answer carries back. */
  n: number;
  /** Wall-clock milliseconds in the editor. */
  t: number;
}

/** The view the editor reported with an ask, as its tab read it. */
export interface AskCamera {
  pos?: number[];
  target?: number[];
  fov?: number;
  orthogonal?: boolean;
}

export interface AskEvent extends Base {
  kind: "ask";
  text: string;
  /** Godot: the edited scene, `res://...`. Blender: the open file's path. */
  scene: string | null;
  /** Godot node paths, or Blender object names. */
  nodes: string[];
  camera: AskCamera | null;
  /** The viewport as PNG, standard base64, or `null` with `pngProblem`. */
  pngBase64: string | null;
  pngProblem: string | null;
}

export interface VerdictEvent extends Base {
  kind: "verdict";
  id: string;
  verdict: Verdict;
  reply: string | null;
}

export interface MarkupEvent extends Base {
  kind: "markup";
}

export type EditorEvent = AskEvent | VerdictEvent | MarkupEvent | MentionEvent;

export type { EditorTool };

const WORDS: Record<EditorTool, { tab: string; view: string; picked: string }> = {
  godot: { tab: "the Godot editor's Veistra dock", view: "viewport", picked: "Selected nodes" },
  blender: { tab: "Blender's Veistra tab", view: "3D view", picked: "Selected objects" },
};

const leaf = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1) || p;

const vec = (v: number[]) => `(${v.map((n) => Math.round(n * 100) / 100).join(", ")})`;

/** What the agent reads: the question, then where it was asked from. */
export function askText(tool: EditorTool, e: AskEvent, where: string | null): string {
  const words = WORDS[tool];
  const lines = [`Question from ${words.tab}:`, e.text.trim(), ""];
  if (where) lines.push(`${tool === "godot" ? "Scene" : "File"}: ${where}`);
  lines.push(`${words.picked}: ${e.nodes.length ? e.nodes.join(", ") : "none"}`);
  const c = e.camera;
  if (c?.pos && c.target) {
    const lens = c.orthogonal ? "orthogonal" : typeof c.fov === "number" ? `fov ${c.fov}` : "";
    lines.push(`Camera at ${vec(c.pos)} looking at ${vec(c.target)}${lens ? `, ${lens}` : ""}.`);
  }
  lines.push(
    e.pngBase64
      ? `The editor's ${words.view} at that moment is attached beside this.`
      : `No picture of the ${words.view} came with it: ${e.pngProblem ?? "none was sent"}.`,
  );
  return lines.join("\n");
}

/**
 * The ask as one chip. Each ask is its own pair of items (its number is in
 * the key), so a second question does not replace the first. `where` names
 * the scene or file as the pane shows it. With no agent prompt to type into
 * the items are still in the Context strip; the answer says which it was.
 */
export async function sendAsk(
  tool: EditorTool,
  e: AskEvent,
  where: string | null,
): Promise<string> {
  const place = where ?? e.scene ?? "";
  const name = place ? leaf(place) : tool;
  const attached: Attachment[] = [];
  if (e.pngBase64) {
    const image = await invoke<ContextRef>("context/put", {
      key: contextKey(tool, place, `ask-${e.n}-view`),
      kind: "image",
      title: `${tool === "godot" ? "Godot editor" : "Blender"} - ${name} ${WORDS[tool].view}`,
      label: `${tool === "godot" ? "Godot" : "Blender"} - ${WORDS[tool].view}`,
      bytesBase64: e.pngBase64,
      prompt: `The ${WORDS[tool].view} as it was when I asked that question.`,
    });
    attached.push({ item: image, what: `the ${WORDS[tool].view} when I asked` });
  }
  const text = await putWithAttached(
    {
      key: contextKey(tool, place, `ask-${e.n}`),
      kind: "text",
      title: `${tool === "godot" ? "Godot editor" : "Blender"} - question about ${name}`,
      label: `${tool === "godot" ? "Godot" : "Blender"} - question`,
      text: askText(tool, e, where ?? e.scene),
      prompt: `Answer the question I asked from ${WORDS[tool].tab}, about what I had selected there.`,
    },
    attached,
  );
  try {
    const said = await chipToAgent(text);
    if (said.delivered) return "Sent to the agent.";
    return `The question is in Veistra's Context strip, but no agent took it: ${said.reason}.`;
  } catch (err) {
    console.error("veistra: could not hand the question to an agent", err);
    return "The question is in Veistra's Context strip; no agent prompt was open to take it.";
  }
}

export interface EventActions {
  tool: EditorTool;
  /** The scene or file as the pane names it, for the message. */
  where: () => string | null;
  /** Open the mode's Mark up; what it resolves to is the tab's message. */
  markup: () => Promise<string>;
  /** Where the editor's things are, for Mention in agent. */
  place?: () => MentionPlace;
}

/** Do what one press asks; the message for the tab, or a throw for a refusal. */
export async function act(e: EditorEvent, actions: EventActions): Promise<string> {
  switch (e.kind) {
    case "ask":
      return sendAsk(actions.tool, e, actions.where());
    case "verdict":
      await verdictComment(e.id, e.verdict, e.reply ?? undefined, "fixed");
      return e.verdict === "good" ? "Marked resolved." : "Reopened for the agent.";
    case "markup":
      return actions.markup();
    case "mention":
      if (!actions.place) throw new Error("This pane cannot mention things yet.");
      return sendMention(actions.tool, e, actions.place());
  }
}

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

/**
 * The tab's events, taken once each and in order. `since` is what the poll
 * sends as `eventsSince`; `take` is given each poll's `editor.events`. A
 * press is answered whether it went through or not, so the tab never waits
 * on one forever; an answer that fails to arrive is logged, and the press is
 * handed on again only to a pane that opens afresh.
 */
export function useEditorEvents(
  actions: EventActions,
  ack: (n: number, ok: boolean, message: string) => Promise<unknown>,
) {
  const since = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ actions, ack });
  latest.current = { actions, ack };

  const take = useCallback((events: EditorEvent[] | undefined) => {
    for (const e of events ?? []) {
      if (e.seq <= since.current) continue;
      since.current = e.seq;
      queue.current = queue.current.then(async () => {
        let ok = true;
        let message: string;
        try {
          message = await act(e, latest.current.actions);
        } catch (err) {
          ok = false;
          message = errorText(err);
        }
        try {
          await latest.current.ack(e.n, ok, message);
        } catch (err) {
          console.error(`veistra: could not answer the editor's event ${e.n}`, err);
        }
      });
    }
  }, []);

  return { since, take };
}
