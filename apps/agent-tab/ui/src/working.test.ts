import { describe, expect, it } from "vitest";
import type { Item, ItemKind } from "./protocol.generated";
import { workingLine } from "./working";
import { strings } from "./strings";

let n = 0;
const item = (kind: ItemKind): Item => ({ id: `i${++n}`, turnId: "t1", kind });
const prompt = item({ kind: "userMessage", text: "go" });
const tool = (status: "pending" | "inProgress" | "completed", toolKind = "execute"): Item =>
  item({
    kind: "toolCall",
    title: "`pnpm test`",
    toolKind,
    status,
    output: "",
    truncated: false,
    paths: [],
    diffs: [],
  });

describe("the line under a running turn", () => {
  it("is reading the prompt until the agent says or does anything", () => {
    expect(workingLine([prompt])).toEqual({ activity: strings.activity.reading, phase: "reading" });
    // A plan update is not the agent answering yet.
    expect(workingLine([prompt, item({ kind: "plan", entries: [] })]).phase).toBe("reading");
  });

  it("is thinking while the agent reasons, and between one step and the next", () => {
    expect(workingLine([prompt, item({ kind: "reasoning", text: "hm" })]).phase).toBe("thinking");
    expect(workingLine([prompt, tool("completed")])).toEqual({
      activity: strings.activity.thinking,
      phase: "thinking",
    });
  });

  it("names the tool that is running", () => {
    expect(workingLine([prompt, tool("inProgress")])).toEqual({
      activity: strings.activity.running("pnpm test"),
      phase: "acting",
    });
    expect(workingLine([prompt, tool("pending", "read")]).activity).toBe("pnpm test");
  });

  it("reads only the turn since the last prompt", () => {
    expect(
      workingLine([prompt, tool("inProgress"), item({ kind: "userMessage", text: "and" })]).phase,
    ).toBe("reading");
  });

  it("says the agent is compacting while it summarises the conversation", () => {
    const compacting = item({ kind: "compaction", status: "inProgress", summary: "", error: null });
    expect(workingLine([prompt, compacting])).toEqual({
      activity: strings.activity.compacting,
      phase: "thinking",
    });
  });
});
