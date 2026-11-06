/**
 * The transcript as assistant-ui sees it. Each user prompt is a user message,
 * and everything the agent does until the next prompt is one assistant
 * message, one part per item.
 *
 * Every part carries its item's id, and the tab draws a part by looking that
 * item up and handing it to `ItemView`. assistant-ui owns the thread's shape
 * (turns, scrolling, the action bar); the slots still draw every item.
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Item } from "./protocol.generated";
import { cleanError } from "./errors";

/** The tool name for every item that is not text, reasoning or a tool call. */
export const ITEM_TOOL = "veistra.item";

/** The tool name for the agent's tool calls: the only parts that group (`Turns.tsx`). */
export const ACTION_TOOL = "veistra.action";

/** One turn: a run of items that becomes one message. */
export interface Turn {
  readonly id: string;
  readonly items: readonly Item[];
  readonly message: ThreadMessageLike;
}

function part(item: Item): Exclude<ThreadMessageLike["content"], string>[number] {
  const kind = item.kind;
  switch (kind.kind) {
    case "userMessage":
      return { type: "text", id: item.id, text: kind.text };
    case "assistantText":
      return { type: "text", id: item.id, text: kind.text };
    case "reasoning":
      return { type: "reasoning", id: item.id, text: kind.text };
    default:
      // `result` is set so assistant-ui does not wait on a tool result: the
      // agent ran the tool, and the item already says how it went.
      return {
        type: "tool-call",
        toolCallId: item.id,
        toolName: kind.kind === "toolCall" ? ACTION_TOOL : ITEM_TOOL,
        args: {},
        result: null,
      };
  }
}

function turn(items: readonly Item[]): Turn {
  const first = items[0];
  const role = first.kind.kind === "userMessage" ? "user" : "assistant";
  return {
    id: first.id,
    items,
    // The protocol carries no clock, so a turn is stamped when this tab last
    // changed it: for the turn just answered, that is when it finished.
    message: { id: first.id, role, content: items.map(part), createdAt: new Date() },
  };
}

function same(a: readonly Item[], b: readonly Item[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Groups items into turns. A turn whose items are the same objects as last
 * time is returned as the same object, so assistant-ui converts again only the turn
 * that changed.
 */
export function toTurns(items: readonly Item[], previous: readonly Turn[] = []): Turn[] {
  const runs: Item[][] = [];
  for (const item of items) {
    // A subagent's work is drawn inside the call that started it (`Items.tsx`).
    if (item.parent) continue;
    // Some adapters emit the same limit notice as text and again as a failed turn.
    if (
      item.kind.kind === "assistantText" &&
      items.some(
        (other) =>
          other.turnId === item.turnId &&
          other.kind.kind === "error" &&
          cleanError(other.kind.message) ===
            cleanError("text" in item.kind ? item.kind.text.replace(/\*\*/g, "") : ""),
      )
    )
      continue;
    const user = item.kind.kind === "userMessage";
    const last = runs[runs.length - 1];
    // A turn the agent started on its own, between prompts, is a turn of its own.
    const another =
      last !== undefined &&
      item.turnId !== "" &&
      last[0].turnId !== "" &&
      item.turnId !== last[0].turnId;
    if (user || !last || last[0].kind.kind === "userMessage" || another) runs.push([item]);
    else last.push(item);
  }
  const before = new Map(previous.map((t) => [t.id, t]));
  return runs.map((run) => {
    const old = before.get(run[0].id);
    return old && same(old.items, run) ? old : turn(run);
  });
}
