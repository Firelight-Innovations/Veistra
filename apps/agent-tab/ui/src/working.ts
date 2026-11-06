/**
 * What the line under a running turn says, and which stretch of the turn it
 * is in (`WorkingPhase`), read off the transcript. Only the items since the
 * last prompt count: an earlier turn's last tool call says nothing about this
 * one.
 */
import type { Item } from "./protocol.generated";
import type { WorkingPhase } from "./components/types";
import { strings } from "./strings";

export interface WorkingLine {
  /** The words, or `undefined` for the plain "Working…". */
  activity?: string;
  phase: WorkingPhase;
}

export function workingLine(items: readonly Item[]): WorkingLine {
  // A plan or usage update draws nothing, so the line reads past it.
  let last: Item["kind"] | undefined;
  for (const item of items) {
    const kind = item.kind.kind;
    if (kind === "userMessage") last = undefined;
    else if (kind !== "plan" && kind !== "usage") last = item.kind;
  }
  // Nothing back yet: the agent is still taking the prompt in.
  if (last === undefined) return { activity: strings.activity.reading, phase: "reading" };
  if (last.kind === "reasoning") return { activity: strings.activity.thinking, phase: "thinking" };
  if (last.kind === "compaction" && last.status === "inProgress")
    return { activity: strings.activity.compacting, phase: "thinking" };
  if (last.kind === "toolCall" && (last.status === "pending" || last.status === "inProgress")) {
    const title = last.title.replace(/`/g, "");
    return {
      activity: last.toolKind === "execute" ? strings.activity.running(title) : title,
      phase: "acting",
    };
  }
  // A step finished and the next has not started: the model is deciding.
  return { activity: strings.activity.thinking, phase: "thinking" };
}
