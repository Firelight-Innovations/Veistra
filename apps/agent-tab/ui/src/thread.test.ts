/**
 * Items into turns: each prompt is its own user turn, everything after it is
 * one agent turn, and a turn whose items did not change is the same object.
 */
import { describe, expect, it } from "vitest";
import type { Item } from "./protocol.generated";
import { ACTION_TOOL, ITEM_TOOL, toTurns } from "./thread";

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

const U1 = item("u1", { kind: "userMessage", text: "go" });
const A1 = item("a1", { kind: "assistantText", text: "ok" });
const R1 = item("r1", { kind: "reasoning", text: "hmm" });
const G1 = item("g1", { kind: "usage", used: 1, size: 2 });
const U2 = item("u2", { kind: "userMessage", text: "again" });

describe("toTurns", () => {
  it("makes each prompt a user turn and the run after it one agent turn", () => {
    const turns = toTurns([U1, A1, R1, G1, U2]);
    expect(turns.map((t) => [t.message.role, t.items.map((i) => i.id)])).toEqual([
      ["user", ["u1"]],
      ["assistant", ["a1", "r1", "g1"]],
      ["user", ["u2"]],
    ]);
    expect(turns[1].message.content).toEqual([
      { type: "text", id: "a1", text: "ok" },
      { type: "reasoning", id: "r1", text: "hmm" },
      { type: "tool-call", toolCallId: "g1", toolName: ITEM_TOOL, args: {}, result: null },
    ]);
  });

  it("names tool calls apart from every other item, so only they group", () => {
    const tool = item("t1", {
      kind: "toolCall",
      title: "ls",
      toolKind: "execute",
      status: "completed",
      output: "",
      truncated: false,
      paths: [],
      diffs: [],
    });
    const [, agent] = toTurns([U1, tool, G1]);
    expect(agent.message.content).toEqual([
      { type: "tool-call", toolCallId: "t1", toolName: ACTION_TOOL, args: {}, result: null },
      { type: "tool-call", toolCallId: "g1", toolName: ITEM_TOOL, args: {}, result: null },
    ]);
  });

  it("starts with an agent turn when the agent spoke first", () => {
    expect(toTurns([A1, U1]).map((t) => t.message.role)).toEqual(["assistant", "user"]);
  });

  it("keeps the turns that did not change and remakes the one that did", () => {
    const first = toTurns([U1, A1]);
    const changed = { ...A1, kind: { kind: "assistantText" as const, text: "ok, done" } };
    const second = toTurns([U1, changed], first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(toTurns([U1, changed], second)[1]).toBe(second[1]);
  });

  it("remakes an agent turn that grows, and keeps the prompt before it", () => {
    const first = toTurns([U1, A1]);
    const second = toTurns([U1, A1, R1], first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].message.content).toHaveLength(2);
    const third = toTurns([U1, A1, R1, G1], second);
    expect(third[1].message.content).toHaveLength(3);
  });

  it("leaves a subagent's work out of the turn, to be drawn under its call", () => {
    const nested: Item = { ...item("n1", { kind: "assistantText", text: "inner" }), parent: "c1" };
    const turns = toTurns([U1, A1, nested, R1]);
    expect(turns[1].items.map((i) => i.id)).toEqual(["a1", "r1"]);
  });

  it("makes a turn the agent started on its own a turn of its own", () => {
    const later: Item = { id: "a2", turnId: "t2", kind: { kind: "assistantText", text: "done" } };
    const turns = toTurns([U1, A1, later]);
    expect(turns.map((t) => [t.message.role, t.items.map((i) => i.id)])).toEqual([
      ["user", ["u1"]],
      ["assistant", ["a1"]],
      ["assistant", ["a2"]],
    ]);
  });

  it("keeps an item with no turn in the turn it follows", () => {
    const loose: Item = { id: "e1", turnId: "", kind: { kind: "assistantText", text: "?" } };
    expect(toTurns([U1, A1, loose])[1].items.map((i) => i.id)).toEqual(["a1", "e1"]);
  });
});
