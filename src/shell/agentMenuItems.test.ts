import { describe, expect, it, vi } from "vitest";
import type { Cluster, MenuItem, PaneNode } from "./contract";
import {
  agentMenuItems,
  agentScopeOf,
  type AgentMenuActions,
  type AgentScope,
} from "./agentMenuItems";

const OPEN = { kind: "open", id: "b", name: null } as const;
const SAVED = { kind: "saved", id: "s1", title: "Old", archived: false } as const;

/** The scope of tab `b` in a pane of agents `a b c` and a file `f`. */
const SCOPE: AgentScope = { paneTabs: ["a", "b", "f", "c"], agentTabs: ["a", "b", "c"] };

function everything() {
  return {
    rename: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    closeOthers: vi.fn(),
    closeToRight: vi.fn(),
    closeAll: vi.fn(),
    split: vi.fn(),
    moveToNewWindow: vi.fn(),
    openSettings: vi.fn(),
    feedback: vi.fn(),
    scope: vi.fn((): AgentScope | null => SCOPE),
    resume: vi.fn(),
    archive: vi.fn(),
  } satisfies AgentMenuActions;
}

const labels = (items: MenuItem[]) => items.map((i) => i.label);
const byLabel = (items: MenuItem[], label: string) => items.find((i) => i.label === label)!;
/** The labels that open a new group, which is where the rules go. */
const groupStarts = (items: MenuItem[]) =>
  items.filter((i) => i.separatorBefore === true).map((i) => i.label);

describe("agentMenuItems for an open agent", () => {
  it("lists the groups in the design's order", () => {
    const items = agentMenuItems(OPEN, everything());
    expect(labels(items)).toEqual([
      "Export Transcript",
      "Copy Request ID",
      "Give Feedback",
      "Rename Chat",
      "Fork Chat",
      "Close",
      "Close Others",
      "Close to the Right",
      "Close Saved",
      "Close All",
      "Reopen Editor With…",
      "Agent Settings",
      "Keep Open",
      "Pin",
      "Split Up",
      "Split Down",
      "Split Left",
      "Split Right",
      "Move into New Window",
    ]);
    expect(groupStarts(items)).toEqual([
      "Close",
      "Reopen Editor With…",
      "Agent Settings",
      "Keep Open",
      "Split Up",
      "Move into New Window",
    ]);
  });

  it("runs the live rows against the tab's own id", () => {
    const a = everything();
    const items = agentMenuItems(OPEN, a);
    for (const label of [
      "Close",
      "Close Others",
      "Close to the Right",
      "Close All",
      "Move into New Window",
      "Agent Settings",
      "Give Feedback",
      "Split Up",
      "Split Right",
    ]) {
      byLabel(items, label).onSelect?.();
    }
    expect(a.feedback).toHaveBeenCalledTimes(1);
    expect(a.close).toHaveBeenCalledWith("b");
    expect(a.closeOthers).toHaveBeenCalledWith("b");
    expect(a.closeToRight).toHaveBeenCalledWith("b");
    expect(a.closeAll).toHaveBeenCalledWith("b");
    expect(a.moveToNewWindow).toHaveBeenCalledWith("b");
    expect(a.openSettings).toHaveBeenCalledTimes(1);
    expect(a.split.mock.calls).toEqual([
      ["b", "column", true],
      ["b", "row", false],
    ]);
  });

  it("renames through a prompt that starts from the current name", async () => {
    const a = everything();
    const item = byLabel(agentMenuItems({ ...OPEN, name: "Login" }, a), "Rename Chat");
    expect(item.prompt?.initialValue).toBe("Login");
    await item.prompt?.onSubmit("  Billing ");
    expect(a.rename).toHaveBeenCalledWith("b", "Billing");
  });

  it("disables, with a reason, every row that has no action behind it", () => {
    const items = agentMenuItems(OPEN, everything());
    for (const label of [
      "Export Transcript",
      "Copy Request ID",
      "Fork Chat",
      "Close Saved",
      "Reopen Editor With…",
      "Keep Open",
      "Pin",
    ]) {
      const row = byLabel(items, label);
      expect(row.disabled, label).toBe(true);
      expect(row.onSelect, label).toBeUndefined();
      expect(row.hint, label).toBeTruthy();
    }
  });

  it("disables what the host did not supply, instead of leaving it live", () => {
    const items = agentMenuItems(OPEN, {});
    for (const label of [
      "Close",
      "Close All",
      "Rename Chat",
      "Agent Settings",
      "Give Feedback",
      "Split Up",
    ]) {
      expect(byLabel(items, label).disabled, label).toBe(true);
      expect(byLabel(items, label).onSelect, label).toBeUndefined();
    }
  });

  it("disables what has nothing to act on", () => {
    const a = everything();
    a.scope.mockReturnValue({ paneTabs: ["b"], agentTabs: ["b"] });
    const items = agentMenuItems(OPEN, a);
    expect(byLabel(items, "Close Others").disabled).toBe(true);
    expect(byLabel(items, "Close to the Right").disabled).toBe(true);
    expect(byLabel(items, "Split Left").disabled).toBe(true);
    expect(byLabel(items, "Close").disabled).toBeUndefined();
  });

  it("shows no shortcut, because none of these has a binding", () => {
    expect(agentMenuItems(OPEN, everything()).some((i) => i.accelerator !== undefined)).toBe(false);
  });
});

describe("agentMenuItems for a saved session", () => {
  it("offers only what an unopened session can do", () => {
    const items = agentMenuItems(SAVED, everything());
    expect(labels(items)).toEqual([
      "Open Session",
      "Export Transcript",
      "Rename Chat",
      "Fork Chat",
      "Archive",
    ]);
    expect(byLabel(items, "Rename Chat").disabled).toBe(true);
    expect(byLabel(items, "Export Transcript").disabled).toBe(true);
  });

  it("opens and archives by the session id, and restores an archived one", () => {
    const a = everything();
    const items = agentMenuItems(SAVED, a);
    byLabel(items, "Open Session").onSelect?.();
    byLabel(items, "Archive").onSelect?.();
    expect(a.resume).toHaveBeenCalledWith("s1");
    expect(a.archive).toHaveBeenCalledWith("s1", true);
    const back = agentMenuItems({ ...SAVED, archived: true }, a);
    byLabel(back, "Restore").onSelect?.();
    expect(a.archive).toHaveBeenLastCalledWith("s1", false);
  });
});

describe("agentScopeOf", () => {
  const leaf = (id: string, tabs: string[]): PaneNode =>
    ({ kind: "leaf", id, tabs, activeTab: tabs[0] ?? null }) as unknown as PaneNode;
  const clusters = [
    { tree: leaf("p1", ["x"]) },
    {
      tree: {
        kind: "split",
        id: "s",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [leaf("p2", ["a", "f", "b"]), leaf("p3", ["c"])],
      } as unknown as PaneNode,
    },
  ] as Pick<Cluster, "tree">[];
  const appOf = (id: string) => (id === "f" ? "viewer" : "agent-tab");

  it("finds the pane across clusters and keeps only the agent tabs among its members", () => {
    expect(agentScopeOf(clusters, appOf, "b")).toEqual({
      paneTabs: ["a", "f", "b"],
      agentTabs: ["a", "b"],
    });
  });

  it("is null for a tab in no pane", () => {
    expect(agentScopeOf(clusters, appOf, "nope")).toBeNull();
  });
});
