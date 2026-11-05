// @vitest-environment jsdom
/**
 * The transcript's live touches: the reasoning the agent is still writing
 * shimmers, and stops once the turn is over. A run of tool calls folds into
 * one line.
 */
import "./jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.listeners.set(event, cb);
    return () => bridge.listeners.delete(event);
  },
  subscribe: () => () => {},
  openIn: vi.fn(),
  reportPainted: vi.fn(),
  VeistraRpcError: class extends Error {},
}));

import App from "./App";
import type { Attachment, Item, SessionState, ToolStatus } from "./protocol.generated";

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

function session(state: SessionState, items: Item[]): Attachment {
  return {
    seq: 1,
    status: {
      state,
      harness: "claude",
      cwd: "C:/work",
      mode: "default",
      adapterVersion: null,
      exitCode: null,
      hint: null,
      pendingPrompt: null,
      modes: [],
      config: [],
      answered: 0,
      settingTrouble: null,
      commands: [],
    },
    items,
  };
}

function backend(attachment: Attachment) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "agent-tab/attach") return Promise.resolve(attachment);
    if (method === "agent-tab/harnesses")
      return Promise.resolve({ harnesses: [{ harness: "claude", hint: null }], blocked: null });
    return Promise.resolve({});
  });
}

const PROMPT = item("u", { kind: "userMessage", text: "why" });
const THOUGHT = item("r", { kind: "reasoning", text: "hmm" });

function tool(id: string, toolKind: string, status: ToolStatus = "completed", output = ""): Item {
  return item(id, {
    kind: "toolCall",
    title: `call ${id}`,
    toolKind,
    status,
    output,
    truncated: false,
    paths: [],
    diffs: [],
  });
}

/** The host's next event, after the attachment's seq of 1. */
function arrive(seq: number, next: Item) {
  act(() =>
    bridge.listeners.get("agent-tab:event")?.({
      instanceId: "i",
      seq,
      event: { type: "itemStarted", item: next },
    }),
  );
}

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listeners.clear();
});
afterEach(cleanup);

describe("the transcript", () => {
  it("shimmers the thinking label while the agent is still thinking", async () => {
    backend(session("working", [PROMPT, THOUGHT]));
    render(<App />);
    const label = await screen.findByText("Thinking");
    expect(label.hasAttribute("data-live")).toBe(true);
  });

  it("stops the shimmer once the turn is over", async () => {
    backend(session("ready", [PROMPT, THOUGHT]));
    render(<App />);
    const label = await screen.findByText("Thinking");
    expect(label.hasAttribute("data-live")).toBe(false);
  });

  it("folds the reasoning behind a caret, not the browser's triangle", async () => {
    backend(session("ready", [PROMPT, THOUGHT]));
    render(<App />);
    const summary = (await screen.findByText("Thinking")).closest("summary");
    expect(summary?.className).toContain("at-disclosure");
  });

  it("folds adjacent tool calls into one line that names what they did", async () => {
    backend(
      session("ready", [PROMPT, tool("a", "execute"), tool("b", "execute"), tool("c", "read")]),
    );
    render(<App />);
    const line = await screen.findByText("Ran 2 commands, read a file");
    expect(line.hasAttribute("data-live")).toBe(false);
    const group = line.closest(".at-actions");
    expect(group?.textContent).toContain("call a");
    expect(group?.textContent).toContain("call c");
  });

  it("shimmers the line while a call in it is still running", async () => {
    backend(session("working", [PROMPT, tool("a", "execute"), tool("b", "read", "inProgress")]));
    render(<App />);
    const line = await screen.findByText("Ran a command, read a file");
    expect(line.hasAttribute("data-live")).toBe(true);
  });

  it("leaves a lone tool call as its own row", async () => {
    backend(session("ready", [PROMPT, tool("a", "execute"), THOUGHT]));
    render(<App />);
    expect(await screen.findByText("call a")).toBeTruthy();
    expect(screen.queryByText("Ran a command")).toBeNull();
  });

  it("breaks the run at anything that is not a tool call", async () => {
    const words = item("w", { kind: "assistantText", text: "between" });
    backend(session("ready", [PROMPT, tool("a", "execute"), words, tool("b", "execute")]));
    render(<App />);
    expect(await screen.findByText("call a")).toBeTruthy();
    expect(screen.getByText("call b")).toBeTruthy();
    expect(screen.queryByText("Ran 2 commands")).toBeNull();
  });

  it("shows Working in an agent turn that has nothing in it yet", async () => {
    backend(session("working", [PROMPT]));
    render(<App />);
    const label = await screen.findByText("Working…");
    expect(label.hasAttribute("data-live")).toBe(true);
  });

  it("says how many calls in the run failed", async () => {
    backend(session("ready", [PROMPT, tool("a", "execute", "failed"), tool("b", "read")]));
    render(<App />);
    const line = await screen.findByText("Ran a command, read a file");
    expect(line.closest("button")?.textContent).toContain("1 failed");
  });

  it("keeps a row the user opened open when a second call joins it", async () => {
    backend(session("working", [PROMPT, tool("a", "execute", "inProgress", "building…")]));
    render(<App />);
    const row = (await screen.findByText("call a")).closest("details")!;
    row.open = true;

    arrive(2, tool("b", "read", "inProgress"));
    await screen.findByText("Ran a command, read a file");
    expect(screen.getByText("call a").closest("details")).toBe(row);
    expect(row.open).toBe(true);
  });

  it("opens the run's card from its line", async () => {
    backend(session("ready", [PROMPT, tool("a", "execute"), tool("b", "execute")]));
    render(<App />);
    const head = (await screen.findByText("Ran 2 commands")).closest("button")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("call a").closest("[hidden]")).not.toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("call a").closest("[hidden]")).toBeNull();
  });
});
