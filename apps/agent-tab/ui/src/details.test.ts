/**
 * What the Details panel, the agent map and the task cards read off the
 * transcript: clocks, changed and new files, subagents, tasks, and a
 * workflow's phases.
 */
import { describe, expect, it } from "vitest";
import type { Item, ItemKind, WorkflowAgent, WorkflowRun } from "./protocol.generated";
import {
  absolute,
  agentCounts,
  changesOf,
  childrenOf,
  currentPhase,
  elapsedOf,
  outputsOf,
  phasesOf,
  relative,
  stampItems,
  subagentsOf,
  taskElapsed,
  tasksOf,
  type Stamp,
} from "./details";

function item(id: string, kind: ItemKind, parent?: string): Item {
  return parent ? { id, turnId: "t1", kind, parent } : { id, turnId: "t1", kind };
}

function tool(
  status: "pending" | "inProgress" | "completed" | "failed",
  diffs: { path: string; oldText: string | null; newText: string; tooLarge?: boolean }[] = [],
): ItemKind {
  return {
    kind: "toolCall",
    title: "Edit",
    toolKind: "edit",
    status,
    output: "",
    truncated: false,
    paths: [],
    diffs: diffs.map((d) => ({ tooLarge: false, ...d })),
  };
}

function task(state: "running" | "completed" | "stopped", extra: Partial<ItemKind> = {}): ItemKind {
  return {
    kind: "task",
    taskId: "task-1",
    name: "Review",
    taskType: "workflow",
    description: "Review the change",
    state,
    summary: null,
    lastTool: null,
    usage: null,
    canStop: true,
    callItem: null,
    run: null,
    ...extra,
  } as ItemKind;
}

function agent(id: string, phase: string | null, state: WorkflowAgent["state"]): WorkflowAgent {
  return {
    id,
    label: id,
    phase,
    state,
    model: null,
    startedAt: null,
    durationMs: null,
    result: null,
  };
}

describe("stampItems", () => {
  it("times an item from when it was seen to when it was seen to finish", () => {
    const stamps = new Map<string, Stamp>();
    stampItems(stamps, [item("c1", tool("inProgress"))], 1000);
    expect(elapsedOf(stamps.get("c1"), 4000)).toBe(3000);
    stampItems(stamps, [item("c1", tool("completed"))], 6000);
    // Stopped at 6s, however late it is read.
    expect(elapsedOf(stamps.get("c1"), 60_000)).toBe(5000);
  });

  it("does not time an item that was already finished when first seen", () => {
    const stamps = new Map<string, Stamp>();
    stampItems(stamps, [item("c1", tool("completed"))], 1000);
    expect(elapsedOf(stamps.get("c1"), 9000)).toBeNull();
  });

  it("says whether anything changed, so a redraw can be skipped", () => {
    const stamps = new Map<string, Stamp>();
    const items = [item("c1", tool("inProgress"))];
    expect(stampItems(stamps, items, 1)).toBe(true);
    expect(stampItems(stamps, items, 2)).toBe(false);
  });
});

describe("taskElapsed", () => {
  it("takes the agent's figure for a task the tab did not watch start", () => {
    const stamps = new Map<string, Stamp>();
    const t = item(
      "k1",
      task("completed", { usage: { totalTokens: 10, toolUses: 1, durationMs: 42_000 } }),
    );
    stampItems(stamps, [t], 1000);
    expect(taskElapsed(t, stamps, 2000)).toBe(42_000);
  });

  it("counts on its own clock between the agent's reports", () => {
    const stamps = new Map<string, Stamp>();
    const t = item(
      "k1",
      task("running", { usage: { totalTokens: 10, toolUses: 1, durationMs: 2000 } }),
    );
    stampItems(stamps, [t], 0);
    expect(taskElapsed(t, stamps, 9000)).toBe(9000);
  });
});

describe("changesOf", () => {
  it("adds up every finished edit to a file, and marks the files it made", () => {
    const items = [
      item("c1", tool("completed", [{ path: "/w/a.ts", oldText: "one", newText: "one\ntwo" }])),
      item("c2", tool("completed", [{ path: "/w/b.ts", oldText: null, newText: "x\ny" }])),
      item("c3", tool("completed", [{ path: "/w/a.ts", oldText: "two", newText: "three" }])),
      item("c4", tool("failed", [{ path: "/w/c.ts", oldText: "a", newText: "b" }])),
    ];
    expect(changesOf(items)).toEqual([
      { path: "/w/a.ts", added: 2, removed: 1, isNew: false },
      { path: "/w/b.ts", added: 2, removed: 0, isNew: true },
    ]);
  });

  it("lists a change too large to diff without counting it", () => {
    const items = [
      item(
        "c1",
        tool("completed", [{ path: "/w/big", oldText: null, newText: "", tooLarge: true }]),
      ),
    ];
    expect(changesOf(items)).toEqual([{ path: "/w/big", added: 0, removed: 0, isNew: false }]);
  });
});

describe("outputsOf", () => {
  it("lists the files the agent made, then the cards it showed", () => {
    const shown = item("s1", {
      ...(tool("completed") as Extract<ItemKind, { kind: "toolCall" }>),
      veistra: { version: 1, component: "table", props: {}, failed: [] },
    } as ItemKind);
    const made = item(
      "c1",
      tool("completed", [{ path: "/w/new.md", oldText: null, newText: "hi" }]),
    );
    const items = [shown, made];
    expect(outputsOf(items, changesOf(items))).toEqual([
      { kind: "file", path: "/w/new.md" },
      { kind: "show", itemId: "s1", component: "table" },
    ]);
  });
});

describe("subagentsOf", () => {
  it("finds the calls other items nest under, with their tool count and tokens", () => {
    const call = item("c1", tool("inProgress"));
    const items = [
      call,
      item("n1", tool("completed"), "c1"),
      item("n2", { kind: "assistantText", text: "found it" }, "c1"),
      item("n3", tool("inProgress"), "c1"),
      item(
        "k1",
        task("running", {
          callItem: "c1",
          usage: { totalTokens: 5000, toolUses: 2, durationMs: 1 },
        }),
      ),
      item("c2", tool("completed")),
    ];
    const stamps = new Map<string, Stamp>();
    stampItems(stamps, items, 0);
    const children = childrenOf(items);
    expect(children.get("c1")?.map((i) => i.id)).toEqual(["n1", "n2", "n3"]);
    expect(subagentsOf(items, children, stamps, 3000)).toEqual([
      {
        itemId: "c1",
        title: "Edit",
        status: "inProgress",
        toolUses: 2,
        elapsed: 3000,
        tokens: 5000,
      },
    ]);
  });
});

describe("tasksOf", () => {
  it("lists every task in the order it started", () => {
    const items = [
      item("k1", task("running")),
      item("c1", tool("completed")),
      item("k2", task("stopped")),
    ];
    expect(tasksOf(items, new Map(), 0).map((t) => [t.itemId, t.task.state])).toEqual([
      ["k1", "running"],
      ["k2", "stopped"],
    ]);
  });
});

describe("phasesOf", () => {
  const run = (agents: WorkflowAgent[]): WorkflowRun => ({
    runId: "wf_1",
    phases: [
      { title: "Survey", detail: "Read the code" },
      { title: "Review", detail: null },
      { title: "Verify", detail: null },
    ],
    agents,
  });

  it("puts agents under their phase, and says where each phase is", () => {
    const r = run([
      agent("a", "Survey", "done"),
      agent("b", "Review", "running"),
      agent("x", null, "done"),
    ]);
    const { phases, loose } = phasesOf(r, true);
    expect(phases.map((p) => [p.title, p.state, p.agents.map((a) => a.id)])).toEqual([
      ["Survey", "done", ["a"]],
      ["Review", "running", ["b"]],
      ["Verify", "next", []],
    ]);
    expect(loose.map((a) => a.id)).toEqual(["x"]);
    expect(currentPhase(r)).toEqual({ index: 1, title: "Review" });
    expect(agentCounts(r)).toEqual({ running: 1, done: 2, failed: 0 });
  });

  it("marks a phase passed with no agent done, and one never reached skipped once it ends", () => {
    const { phases } = phasesOf(run([agent("b", "Review", "failed")]), false);
    expect(phases.map((p) => p.state)).toEqual(["done", "failed", "skipped"]);
  });

  it("has no current phase before any agent starts", () => {
    expect(currentPhase(run([]))).toBeNull();
  });
});

describe("paths", () => {
  it("joins a relative path onto the worktree and keeps an absolute one", () => {
    expect(absolute("src/a.ts", "C:\\w")).toBe("C:\\w\\src/a.ts");
    expect(absolute("C:\\x\\a.ts", "C:\\w")).toBe("C:\\x\\a.ts");
    expect(absolute("/x/a.ts", "/w")).toBe("/x/a.ts");
    expect(absolute("a.ts", null)).toBe("a.ts");
  });

  it("shows a path under the worktree from the worktree, whatever its slashes", () => {
    expect(relative("C:\\w\\src\\a.ts", "C:/w/")).toBe("src/a.ts");
    expect(relative("/elsewhere/a.ts", "/w")).toBe("/elsewhere/a.ts");
  });
});
