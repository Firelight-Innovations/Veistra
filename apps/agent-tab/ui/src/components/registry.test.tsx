// @vitest-environment jsdom
/**
 * The swap seam: the tab's logic draws nothing itself, every piece of DOM
 * comes from a slot, and a slot replaced through `SlotsProvider` is the one
 * that shows, at the top level and inside other components alike.
 */
import "../jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isValidElement, type ComponentType, type ReactNode } from "react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: () => () => {},
  subscribe: () => () => {},
  openIn: vi.fn(),
  reportPainted: vi.fn(),
  VeistraRpcError: class extends Error {},
}));

import App from "../App";
import type { Attachment, HarnessInfo, Item } from "../protocol.generated";
import { defaultSlots, SlotsProvider, type Slots } from "./registry";

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

const DIFF = { path: "src/a.ts", oldText: "a", newText: "b", tooLarge: false };

/** One of every item kind, a session that has stopped with a hint, a prompt
 *  still waiting on the agent, and an approval whose detail was cut short. */
const EVERYTHING: Attachment = {
  seq: 9,
  status: {
    state: "stopped",
    harness: "claude",
    cwd: "C:/work/feature-x",
    mode: "default",
    adapterVersion: "0.90.0",
    exitCode: 1,
    hint: "signedOut",
    pendingPrompt: "and then",
    modes: [{ value: "default", name: "Manual", description: null }],
    config: [],
    answered: 0,
    settingTrouble: null,
    commands: [],
  },
  items: [
    item("u", { kind: "userMessage", text: "hi" }),
    item("a", { kind: "assistantText", text: "**hello**" }),
    item("r", { kind: "reasoning", text: "hmm" }),
    item("x", {
      kind: "toolCall",
      title: "ls",
      toolKind: "execute",
      status: "completed",
      output: "",
      truncated: false,
      paths: [],
      diffs: [],
    }),
    item("t", {
      kind: "toolCall",
      title: "Edit a.ts",
      toolKind: "edit",
      status: "completed",
      output: "ok",
      truncated: true,
      paths: ["src/a.ts"],
      diffs: [DIFF],
    }),
    item("p", {
      kind: "approval",
      title: "Edit a.ts",
      toolCallId: "t",
      detail: "npm test",
      detailTruncated: true,
      paths: ["src/a.ts"],
      diffs: [{ ...DIFF, tooLarge: true }],
      options: [{ optionId: "ok", kind: "allow_once", name: "Allow" }],
      answer: null,
    }),
    item("l", {
      kind: "plan",
      entries: [{ content: "step", status: "pending", priority: "high" }],
    }),
    item("g", { kind: "usage", used: 10, size: 100 }),
    item("e", { kind: "error", message: "boom", hint: "harnessMissing", harness: "claude" }),
  ],
};

/** Claude as `agent-tab/harnesses` describes it. */
const CLAUDE: HarnessInfo = {
  harness: "claude",
  name: "Claude",
  hint: null,
  setup: {
    cli: "claude",
    signIn: "claude",
    cliInstall: "curl -fsSL https://claude.ai/install.sh | bash",
    adapterInstall: "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0",
    adapterVersion: "0.90.0",
  },
  capabilities: { steer: false, fork: false, modes: false },
  models: null,
  model: null,
};

function backend(attach: () => Promise<unknown>) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "agent-tab/attach") return attach();
    if (method === "agent-tab/harnesses")
      return Promise.resolve({ harnesses: [CLAUDE], current: "claude", blocked: null });
    return Promise.resolve({});
  });
}

/** A stand-in that draws nothing of its own but the slot's name, and passes
 *  through whatever other slots it was handed as props. */
function stub(name: string): ComponentType<Record<string, unknown>> {
  return function Stub(props: Record<string, unknown>) {
    const passed: ReactNode[] = [];
    for (const value of Object.values(props)) {
      if (isValidElement(value)) passed.push(value);
      else if (Array.isArray(value) && value.some(isValidElement)) passed.push(value);
    }
    return <div data-slot={name}>{passed}</div>;
  };
}

function stubs(names: (keyof Slots)[]): Partial<Slots> {
  return Object.fromEntries(names.map((n) => [n, stub(n)])) as Partial<Slots>;
}

const ALL = Object.keys(defaultSlots) as (keyof Slots)[];

function slotsShown(container: HTMLElement): Set<string> {
  return new Set(
    [...container.querySelectorAll("[data-slot]")].map((el) => el.getAttribute("data-slot")!),
  );
}

beforeEach(() => bridge.invoke.mockReset());
afterEach(cleanup);

describe("the slot registry", () => {
  it("draws every transcript item kind through a slot, and nothing outside one", async () => {
    backend(() => Promise.resolve(EVERYTHING));
    const { container } = render(
      <SlotsProvider slots={stubs(ALL)}>
        <App />
      </SlotsProvider>,
    );
    await screen.findAllByText((_, el) => el?.getAttribute("data-slot") === "UserMessage");

    const loose = [...container.querySelectorAll("*")].filter(
      (el) => !el.hasAttribute("data-slot"),
    );
    expect(loose.map((el) => el.outerHTML)).toEqual([]);

    const shown = slotsShown(container);
    for (const name of [
      "Layout",
      "Header",
      "Transcript",
      "UserTurn",
      "AssistantTurn",
      "UserMessage",
      "AssistantText",
      "Thinking",
      "ToolCall",
      "ActionGroup",
      "Approval",
      "TodoList",
      "ErrorItem",
      "Hint",
      "Note",
      "Composer",
      "ModelMenu",
      "ContextMeter",
      "UsageRing",
      "SendButton",
    ]) {
      expect(shown, name).toContain(name);
    }
    // The usage item is the composer's context ring, not a line in the transcript.
    expect(shown).not.toContain("Usage");
  });

  it("puts the settings and the latest usage in the composer's footer", async () => {
    backend(() => Promise.resolve(EVERYTHING));
    render(<App />);
    // EVERYTHING's usage item is 10 of 100 tokens; its session runs Claude in
    // "default", shown by the name the agent gives it.
    expect(await screen.findByRole("button", { name: "Context window 10% full" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Agent settings/ }).textContent).toBe(
      "Claude · Medium · Manual",
    );
  });

  it("draws the empty state and a failed attach through slots too", async () => {
    backend(() => Promise.reject(new Error("not yet")));
    const { container } = render(
      <SlotsProvider slots={stubs(ALL)}>
        <App />
      </SlotsProvider>,
    );
    await screen.findAllByText((_, el) => el?.getAttribute("data-slot") === "Notice");
    const shown = slotsShown(container);
    expect(shown).toContain("EmptyState");
    expect(shown).toContain("Notice");
    expect([...container.querySelectorAll("*")].every((el) => el.hasAttribute("data-slot"))).toBe(
      true,
    );
  });

  it("reaches the pieces other components draw, through the same map", async () => {
    backend(() => Promise.resolve(EVERYTHING));
    const { container } = render(
      <SlotsProvider
        slots={stubs(["StatusBadge", "Diff", "PathList", "Note", "Hint", "TurnActions"])}
      >
        <App />
      </SlotsProvider>,
    );
    await screen.findByText("hi");
    const shown = slotsShown(container);
    for (const name of ["StatusBadge", "Diff", "PathList", "Note", "Hint", "TurnActions"]) {
      expect(shown, name).toContain(name);
    }
    // The defaults are gone wherever a stub stands in.
    expect(container.querySelector(".at-status")).toBeNull();
    expect(container.querySelector(".at-diff")).toBeNull();
    expect(container.querySelector(".at-paths")).toBeNull();
    expect(container.querySelector(".at-note")).toBeNull();
    expect(container.querySelector(".at-hint")).toBeNull();
  });

  it("draws Working through its slot while a turn runs", async () => {
    backend(() =>
      Promise.resolve({
        seq: 1,
        status: { ...EVERYTHING.status!, state: "working", hint: null, exitCode: null },
        items: [item("u", { kind: "userMessage", text: "hi" })],
      }),
    );
    const { container } = render(
      <SlotsProvider slots={stubs(["Working"])}>
        <App />
      </SlotsProvider>,
    );
    await screen.findByText("hi");
    expect(slotsShown(container)).toContain("Working");
    expect(container.querySelector(".at-working")).toBeNull();
  });

  it.each([
    ["StatusBadge", ".at-status"],
    ["Diff", ".at-diff"],
    ["PathList", ".at-paths"],
    ["Note", ".at-note"],
    ["Hint", ".at-hint"],
  ] as const)("leaves no default %s anywhere once it is replaced", async (name, selector) => {
    backend(() => Promise.resolve(EVERYTHING));
    const { container } = render(
      <SlotsProvider slots={stubs([name])}>
        <App />
      </SlotsProvider>,
    );
    await screen.findByText("hi");
    expect(slotsShown(container)).toContain(name);
    expect(container.querySelector(selector)).toBeNull();
  });

  it("draws the empty state's hints through the Hint slot", async () => {
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "agent-tab/attach")
        return Promise.resolve({ seq: 0, status: null, items: [] });
      if (method === "agent-tab/harnesses")
        return Promise.resolve({
          harnesses: [{ ...CLAUDE, hint: "signedOut" }],
          current: "claude",
          blocked: "developerMode",
        });
      return Promise.resolve({});
    });
    const { container } = render(
      <SlotsProvider slots={stubs(["Hint"])}>
        <App />
      </SlotsProvider>,
    );
    await waitFor(() => expect(container.querySelectorAll("[data-slot='Hint']")).toHaveLength(2));
    expect(container.querySelector(".at-hint")).toBeNull();
  });

  it("sums a tool call's diffs into its row, and names its status only until it is done", () => {
    const { ToolCall } = defaultSlots;
    const diff = (path: string, added: number, removed: number) => ({
      path,
      isNew: false,
      lines: [],
      added,
      removed,
    });
    const row = (status: "inProgress" | "completed") =>
      render(
        <ToolCall
          title="Edit a.ts"
          toolKind="edit"
          status={status}
          output=""
          truncated={false}
          paths={[]}
          diffs={[diff("a.ts", 3, 1), diff("b.ts", 2, 0)]}
        />,
      ).container.querySelector(".at-tool__head")!;
    expect(row("completed").querySelector(".at-tool__counts")?.textContent).toBe("+5 −1");
    expect(row("completed").querySelector(".at-tool__status")).toBeNull();
    expect(row("completed").querySelector("svg.at-tool__glyph--completed")).not.toBeNull();
    cleanup();
    expect(row("inProgress").querySelector(".at-tool__status")?.textContent).toBe("Running");
  });

  it("offers New session before and during a session, and announces the state", () => {
    const { Header } = defaultSlots;
    const onNewSession = vi.fn();
    render(<Header state={null} onNewSession={onNewSession} />);
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No session");
    cleanup();
    render(<Header state="working" onNewSession={onNewSession} />);
    expect(screen.getByRole("status").textContent).toBe("Working");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledOnce();
  });
});
