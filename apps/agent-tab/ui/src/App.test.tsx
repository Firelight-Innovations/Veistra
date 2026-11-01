// @vitest-environment jsdom
/**
 * The agent tab end to end against a scripted bridge: attach, live envelopes,
 * sending, approvals, refusals, the mode, the model and the effort.
 */
import "./jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => {
  class VeistraRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  return {
    invoke: vi.fn(),
    listeners: new Map<string, (payload: unknown) => void>(),
    VeistraRpcError,
  };
});

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.listeners.set(event, cb);
    return () => bridge.listeners.delete(event);
  },
  reportPainted: vi.fn(),
  VeistraRpcError: bridge.VeistraRpcError,
}));

import App from "./App";
import { strings } from "./strings";
import type {
  Attachment,
  ConfigOption,
  Envelope,
  HarnessInfo,
  Item,
  SessionStatus,
} from "./protocol.generated";

/** Claude as `agent-tab/harnesses` describes it, from `harness/claude.rs`. */
const CLAUDE: HarnessInfo = {
  harness: "claude",
  name: "Claude",
  hint: null,
  setup: {
    cli: "claude",
    signIn: "claude",
    adapterInstall: "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0",
    adapterVersion: "0.90.0",
  },
  capabilities: { steer: false, fork: false, modes: false },
  models: null,
  model: null,
};

/** Codex as `agent-tab/harnesses` describes it, from `harness/codex.rs`. */
const CODEX: HarnessInfo = {
  harness: "codex",
  name: "Codex",
  hint: null,
  setup: {
    cli: "codex",
    signIn: "codex login",
    adapterInstall: "npm i -g --omit=optional @agentclientprotocol/codex-acp@2.2.2",
    adapterVersion: "2.2.2",
  },
  capabilities: { steer: false, fork: false, modes: false },
  models: null,
  model: null,
};

const STATUS: SessionStatus = {
  state: "ready",
  harness: "claude",
  cwd: "C:/work/feature-x",
  mode: "default",
  modes: [],
  config: [],
  answered: 0,
  settingTrouble: null,
  commands: [],
  adapterVersion: "0.90.0",
  exitCode: null,
  hint: null,
  pendingPrompt: null,
};

const choice = (value: string, name: string) => ({ value, name, description: null });

/** A session with Claude's three modes. */
const SETTINGS: SessionStatus = {
  ...STATUS,
  modes: [
    choice("default", "Manual"),
    choice("acceptEdits", "Accept edits"),
    choice("plan", "Plan"),
  ],
};

const option = (
  id: string,
  name: string,
  category: string,
  value: string,
  choices: [string, string][],
): ConfigOption => ({
  id,
  name,
  description: null,
  category,
  value,
  choices: choices.map(([v, n]) => choice(v, n)),
});

const LEVELS: [string, string][] = [
  ["default", "Default"],
  ["low", "Low"],
  ["high", "High"],
];

/** Claude's options as the adapter lists them for its default model. */
const MODELS: SessionStatus = {
  ...SETTINGS,
  config: [
    option("model", "Model", "model", "default", [
      ["default", "Default (recommended)"],
      ["opus", "Opus"],
      ["haiku", "Haiku"],
    ]),
    option("effort", "Effort", "thought_level", "default", LEVELS),
    option("fast", "Fast mode", "model_config", "off", [
      ["off", "Off"],
      ["on", "On"],
    ]),
  ],
};

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

function backend(
  attachment: Attachment,
  overrides: Record<string, (params?: { kinds?: string[] }) => Promise<unknown>> = {},
) {
  let ticket = 0;
  bridge.invoke.mockImplementation((method: string, params?: { kinds?: string[] }) => {
    const override = overrides[method];
    if (override) return override(params);
    switch (method) {
      case "agent-tab/attach":
        return Promise.resolve(attachment);
      case "agent-tab/harnesses":
        return Promise.resolve({ harnesses: [CLAUDE], current: "claude", blocked: null });
      case "agent-tab/set-mode":
      case "agent-tab/set-config":
        return Promise.resolve({ ticket: ++ticket });
      default:
        return Promise.resolve({});
    }
  });
}

function emit(envelope: Envelope) {
  act(() => bridge.listeners.get("agent-tab:event")?.(envelope));
}

function prompt() {
  return screen.getByRole("textbox", { name: "Message the agent" });
}

/** The settings button, which reads out every setting it shows. */
async function settingsButton() {
  return screen.findByRole("button", { name: /^Agent settings/ });
}

/** What the settings button shows, in order: harness, model, effort, mode. */
async function shown() {
  const label = (await settingsButton()).getAttribute("aria-label") ?? "";
  return label.split(", ").slice(1);
}

/** The same, at once, for use inside `waitFor`: nothing before the button is drawn. */
function named() {
  const button = screen.queryByRole("button", { name: /^Agent settings/ });
  return (button?.getAttribute("aria-label") ?? "").split(", ").slice(1);
}

/** The mode the settings button shows, by name. */
async function shownMode() {
  const label = (await settingsButton()).getAttribute("aria-label") ?? "";
  return label.split(", ").pop();
}

/** Wait for the settings button to show `name` as the mode. */
async function untilMode(name: string) {
  await waitFor(async () => expect(await shownMode()).toBe(name));
}

/** Choose a mode by name from the settings menu. */
async function pickMode(name: string) {
  const menu = await modeMenu();
  fireEvent.click(menu.getByRole("menuitemradio", { name }));
}

/** Choose `name` from the settings menu's `group` section. */
async function pick(group: string, name: string) {
  const button = await settingsButton();
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  const section = within(
    await screen.findByRole("group", { hidden: true, name: group === "Claude" ? "Model" : group }),
  );
  await act(async () => {
    fireEvent.click(section.getByRole(group === "Effort" ? "button" : "menuitemradio", { name }));
  });
  if (button.getAttribute("aria-expanded") === "true") fireEvent.click(button);
}

/** The settings menu's Mode group, opened. */
async function modeMenu() {
  fireEvent.click(await settingsButton());
  return within(await screen.findByRole("group", { hidden: true, name: "Mode" }));
}

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listeners.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe("the agent tab", () => {
  it("draws the attached transcript, then applies only newer events", async () => {
    backend({
      status: STATUS,
      seq: 5,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    render(<App />);
    await screen.findByText("list the files");

    emit({
      instanceId: "i",
      seq: 4,
      event: { type: "itemStarted", item: item("a0", { kind: "assistantText", text: "stale" }) },
    });
    emit({
      instanceId: "i",
      seq: 6,
      event: { type: "itemStarted", item: item("a1", { kind: "assistantText", text: "Here" }) },
    });
    emit({
      instanceId: "i",
      seq: 7,
      event: { type: "itemDelta", itemId: "a1", text: " they are" },
    });

    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("Here they are")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Ready");
  });

  it("sends on Enter to the tab's harness and clears the prompt", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "fix the test" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    // The host picks the harness: the live agent's, else the tab's choice.
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      text: "fix the test",
      effort: "medium",
      ultracode: false,
    });
    expect(prompt()).toHaveProperty("value", "");
  });

  it("reports a sent prompt as a usage event, with its choices and never its text", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "the secret plan" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const reported = bridge.invoke.mock.calls.filter(([method]) => method === "veistra/track");
    expect(reported).toEqual([
      [
        "veistra/track",
        {
          event: "prompt_sent",
          props: { effort: "medium", ultracode: false, mode: null, images: 0 },
        },
      ],
    ]);
    expect(JSON.stringify(reported)).not.toContain("secret");
  });

  it("shows a refusal and its hint in the tab's own words", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/send": () =>
          Promise.reject(
            new bridge.VeistraRpcError(-32010, "x", { code: "harness", hint: "adapterMissing" }),
          ),
      },
    );
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Claude is not ready to run.");
    expect(alert.textContent).toContain("claude-agent-acp@0.90.0");
    expect(prompt()).toHaveProperty("value", "go");
  });

  it("words the harness's setup hint in the empty state", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({
            harnesses: [{ ...CLAUDE, hint: "signedOut" }],
            current: "claude",
            blocked: null,
          }),
      },
    );
    render(<App />);
    expect(await screen.findByText(strings.hint.signedOut(CLAUDE))).toBeTruthy();
  });

  it("words an error item's hint inside the error", async () => {
    backend({
      status: STATUS,
      seq: 2,
      items: [
        item("e1", { kind: "error", message: "boom", hint: "harnessMissing", harness: "claude" }),
      ],
    });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(alert.textContent).toContain(strings.hint.harnessMissing(CLAUDE));
  });

  it("says a main checkout is why, when the shell refuses the write before the tab's own code", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/send": () =>
          Promise.reject(new bridge.VeistraRpcError(-32003, "main is read-only")),
      },
    );
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("main checkout");
    expect(alert.textContent).not.toContain("Could not send that.");
    expect(prompt()).toHaveProperty("value", "go");
  });

  it("answers an approval with the option clicked", async () => {
    backend({
      status: { ...STATUS, state: "needsInput" },
      seq: 3,
      items: [
        item("p1", {
          kind: "approval",
          title: "Run npm test",
          toolCallId: "c1",
          detail: "npm test",
          detailTruncated: false,
          paths: [],
          diffs: [],
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
          answer: null,
        }),
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/answer", {
        itemId: "p1",
        optionId: "allow",
      }),
    );
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", true);
  });

  it("lets an approval be answered again when the answer did not land", async () => {
    backend(
      {
        status: { ...STATUS, state: "needsInput" },
        seq: 3,
        items: [
          item("p1", {
            kind: "approval",
            title: "Run npm test",
            toolCallId: "c1",
            detail: "npm test",
            detailTruncated: false,
            paths: [],
            diffs: [],
            options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
            answer: null,
          }),
        ],
      },
      { "agent-tab/answer": () => Promise.reject(new Error("gone")) },
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("disabled", false),
    );
  });

  const grappleQuestion = item("q1", {
    kind: "question",
    message: "",
    toolCallId: null,
    questions: [
      {
        id: "question_0",
        header: null,
        text: "How should the grapple let go?",
        choices: [
          { value: "release", label: "On button release", description: null },
          { value: "top", label: "At the top of the swing", description: null },
        ],
        multi: false,
        other: true,
      },
    ],
    outcome: null,
  });

  it("answers an open question with a click", async () => {
    backend({ status: { ...STATUS, state: "needsInput" }, seq: 3, items: [grappleQuestion] });
    render(<App />);
    fireEvent.click(await screen.findByRole("radio", { name: /On button release/ }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/answer", {
        itemId: "q1",
        outcome: { kind: "answered", replies: [{ picks: ["release"], other: null }] },
      }),
    );
  });

  it("sends text typed in the composer as the open question's answer, not as a prompt", async () => {
    backend({ status: { ...STATUS, state: "needsInput" }, seq: 3, items: [grappleQuestion] });
    render(<App />);
    await screen.findByRole("radio", { name: /On button release/ });
    fireEvent.change(prompt(), { target: { value: "Only while held" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/answer", {
        itemId: "q1",
        outcome: { kind: "answered", replies: [{ picks: [], other: "Only while held" }] },
      }),
    );
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect(prompt()).toHaveProperty("value", "");
  });

  it("retries the prompt the error answered, and keeps what is being typed", async () => {
    backend({
      status: STATUS,
      seq: 4,
      items: [
        item("u1", { kind: "userMessage", text: "fix the build" }),
        item("e2", { kind: "error", message: "overloaded", hint: null, harness: "claude" }),
      ],
    });
    render(<App />);
    await screen.findByText("fix the build");
    fireEvent.change(prompt(), { target: { value: "half typed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      text: "fix the build",
      effort: "medium",
      ultracode: false,
    });
    expect(prompt()).toHaveProperty("value", "half typed");
  });

  it("offers to attach again when the first attach fails", async () => {
    let attempts = 0;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/attach": () =>
          ++attempts === 1
            ? Promise.reject(new Error("not yet"))
            : Promise.resolve({
                status: STATUS,
                seq: 2,
                items: [item("u1", { kind: "userMessage", text: "back again" })],
              }),
      },
    );
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not reach the agent host.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await screen.findByText("back again");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turns Send into Stop while the agent works, and Esc cancels the turn", async () => {
    backend({ status: { ...STATUS, state: "working" }, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("queues a prompt typed while the agent works instead of sending it", async () => {
    backend({ status: { ...STATUS, state: "working" }, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.change(prompt(), { target: { value: "then run the tests" } });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(screen.getByText("then run the tests")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    expect(screen.queryByText("then run the tests")).toBeNull();
  });

  it("puts a hover card away with Esc before Esc stops the turn", async () => {
    backend({
      status: { ...STATUS, state: "working" },
      seq: 2,
      items: [
        item("u1", { kind: "userMessage", text: "go" }),
        item("g1", { kind: "usage", used: 10, size: 100 }),
      ],
    });
    render(<App />);
    const meter = await screen.findByRole("button", { name: "Context window 10% full" });
    fireEvent.pointerEnter(meter.parentElement!);
    const card = screen.getByRole("tooltip", { hidden: true });
    expect(card.hasAttribute("data-open")).toBe(true);

    prompt().focus();
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(card.hasAttribute("data-open")).toBe(false);
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/cancel");

    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("shows the accepted prompt while the agent starts, and Stop and Esc withdraw it", async () => {
    backend({
      status: { ...STATUS, state: "starting", pendingPrompt: "fix the build" },
      seq: 2,
      items: [],
    });
    render(<App />);
    await screen.findByText("fix the build");
    expect(screen.getByText(/Your message is sent once it is ready/)).toBeTruthy();
    expect(document.querySelector(".at-empty")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
    bridge.invoke.mockClear();
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("retries a prompt whose handshake failed, with that prompt and not an older one", async () => {
    backend({
      status: { ...STATUS, state: "failed", hint: "signedOut" },
      seq: 9,
      items: [
        item("u1", { kind: "userMessage", text: "an older prompt" }),
        item("u2", { kind: "userMessage", text: "the one that failed" }),
        item("e2", {
          kind: "error",
          message: "authentication required",
          hint: "signedOut",
          harness: "claude",
        }),
      ],
    });
    render(<App />);
    await screen.findByText("the one that failed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      text: "the one that failed",
      effort: "medium",
      ultracode: false,
    });
  });

  it("groups the transcript into turns, and says it is working before the first reply", async () => {
    backend({
      status: { ...STATUS, state: "working" },
      seq: 2,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    const { container } = render(<App />);
    await screen.findByText("list the files");
    expect(screen.getByText("Working…")).toBeTruthy();

    emit({
      instanceId: "i",
      seq: 3,
      event: { type: "itemStarted", item: item("a1", { kind: "assistantText", text: "Here" }) },
    });
    emit({
      instanceId: "i",
      seq: 4,
      event: { type: "itemStarted", item: item("r1", { kind: "reasoning", text: "hmm" }) },
    });
    expect(screen.queryByText("Working…")).toBeNull();
    expect(container.querySelectorAll(".at-turn--user")).toHaveLength(1);
    const agent = container.querySelectorAll(".at-turn--agent");
    expect(agent).toHaveLength(1);
    expect(agent[0].textContent).toContain("Here");
  });

  it("says it is working after a tool row only while the turn runs", async () => {
    const tool = item("c1", {
      kind: "toolCall",
      title: "pnpm test",
      toolKind: "execute",
      status: "completed",
      output: "",
      truncated: false,
      paths: [],
      diffs: [],
    });
    const items = [item("u1", { kind: "userMessage", text: "run the tests" }), tool];
    backend({ status: STATUS, seq: 2, items });
    render(<App />);
    await screen.findByText("pnpm test");
    expect(screen.queryByText("Working…")).toBeNull();
    cleanup();

    backend({ status: { ...STATUS, state: "working" }, seq: 2, items });
    render(<App />);
    await screen.findByText("pnpm test");
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("keeps naming the running command when a plan update lands after it", async () => {
    const tool = item("c1", {
      kind: "toolCall",
      title: "pnpm test",
      toolKind: "execute",
      status: "inProgress",
      output: "",
      truncated: false,
      paths: [],
      diffs: [],
    });
    const plan = item("plan", {
      kind: "plan",
      entries: [{ content: "Run the tests", status: "in_progress", priority: "medium" }],
    });
    backend({
      status: { ...STATUS, state: "working" },
      seq: 3,
      items: [item("u1", { kind: "userMessage", text: "run the tests" }), tool, plan],
    });
    render(<App />);
    expect(await screen.findByText("Running pnpm test")).toBeTruthy();
  });

  it("does not say it is working while the agent waits on an approval", async () => {
    backend({
      status: { ...STATUS, state: "needsInput" },
      seq: 2,
      items: [
        item("u1", { kind: "userMessage", text: "edit the file" }),
        item("p1", {
          kind: "approval",
          title: "Edit a.ts",
          toolCallId: "c1",
          detail: null,
          detailTruncated: false,
          paths: [],
          diffs: [],
          options: [{ optionId: "ok", kind: "allow_once", name: "Allow" }],
          answer: null,
        }),
      ],
    });
    render(<App />);
    await screen.findByRole("button", { name: "Allow" });
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("puts Copy on every finished agent turn, where the keyboard can reach it", async () => {
    backend({
      status: STATUS,
      seq: 4,
      items: [
        item("u1", { kind: "userMessage", text: "one" }),
        item("a1", { kind: "assistantText", text: "first answer" }),
        item("u2", { kind: "userMessage", text: "two" }),
        item("a2", { kind: "assistantText", text: "second answer" }),
      ],
    });
    render(<App />);
    await screen.findByText("first answer");
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  it("keeps Copy on earlier turns while a turn runs, and leaves it off the one being written", async () => {
    const items = [
      item("u1", { kind: "userMessage", text: "one" }),
      item("a1", { kind: "assistantText", text: "first answer" }),
      item("u2", { kind: "userMessage", text: "two" }),
      item("a2", { kind: "assistantText", text: "half an answ" }),
    ];
    backend({ status: { ...STATUS, state: "working" }, seq: 4, items });
    const { container } = render(<App />);
    await screen.findByText("half an answ");
    const turns = container.querySelectorAll(".at-turn--agent");
    expect(turns[0].querySelector(".at-turn__actions")).not.toBeNull();
    expect(turns[1].querySelector(".at-turn__actions")).toBeNull();

    emit({ instanceId: "i", seq: 5, event: { type: "status", status: STATUS } });
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  it("leaves Copy off a turn with no text, and says when it has copied", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      backend({
        status: STATUS,
        seq: 4,
        items: [
          item("u1", { kind: "userMessage", text: "one" }),
          item("e1", { kind: "error", message: "boom", hint: null, harness: "claude" }),
          item("u2", { kind: "userMessage", text: "two" }),
          item("a2", { kind: "assistantText", text: "an answer" }),
        ],
      });
      render(<App />);
      await screen.findByText("an answer");
      const copy = screen.getByRole("button", { name: "Copy" });
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith("an answer");
      expect(copy.getAttribute("title")).toBe("Copied");
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("redraws no transcript item while a prompt is typed", async () => {
    const drawn = vi.fn();
    const { SlotsProvider } = await import("./components/registry");
    function CountingUserMessage({ text }: { text: string }) {
      drawn(text);
      return <p>{text}</p>;
    }
    backend({
      status: STATUS,
      seq: 2,
      items: [
        item("u1", { kind: "userMessage", text: "list the files" }),
        item("a1", { kind: "assistantText", text: "Here" }),
      ],
    });
    render(
      <SlotsProvider slots={{ UserMessage: CountingUserMessage }}>
        <App />
      </SlotsProvider>,
    );
    await screen.findByText("list the files");
    const before = drawn.mock.calls.length;
    for (const value of ["a", "ab", "abc"]) fireEvent.change(prompt(), { target: { value } });
    expect(drawn.mock.calls.length).toBe(before);
  });

  it("says when the mode will appear, and leaves Shift+Tab alone till then", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    const menu = await modeMenu();
    const later = menu.getByRole("menuitemradio", {
      name: "The mode and model appear once the session starts.",
    });
    expect(later.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-mode", expect.anything());
  });

  it("switches mode with Shift+Tab, showing the choice until the agent answers it", async () => {
    backend({ status: SETTINGS, seq: 1, items: [] });
    render(<App />);
    await untilMode("Manual");
    const menu = await modeMenu();
    const labels = menu.getAllByRole("menuitemradio").map((o) => o.textContent);
    expect(labels).toEqual(["Manual", "Accept edits", "Plan"]);
    fireEvent.click(await settingsButton());
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "acceptEdits" });
    expect(await shownMode()).toBe("Accept edits");

    // A status about something else, such as a turn starting, answers
    // nothing: the choice stands, and the next press moves on from it.
    status(2, { ...SETTINGS, state: "working" });
    expect(await shownMode()).toBe("Accept edits");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/set-mode", { modeId: "plan" });
    expect(await shownMode()).toBe("Plan");

    // The first answer leaves the second choice standing.
    status(3, { ...SETTINGS, mode: "acceptEdits", answered: 1 });
    expect(await shownMode()).toBe("Plan");

    // The agent has the last word.
    status(4, { ...SETTINGS, mode: "acceptEdits", answered: 2 });
    expect(await shownMode()).toBe("Accept edits");
  });

  it("switches once for a held Shift+Tab, and keeps focus where it is", async () => {
    backend({ status: SETTINGS, seq: 1, items: [] });
    render(<App />);
    await untilMode("Manual");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    let notPrevented = true;
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        notPrevented &&= fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true, repeat: true });
      }
    });
    expect(notPrevented).toBe(false);
    const sent = bridge.invoke.mock.calls.filter(([m]) => m === "agent-tab/set-mode");
    expect(sent).toEqual([["agent-tab/set-mode", { modeId: "acceptEdits" }]]);
    expect(await shownMode()).toBe("Accept edits");
  });

  it.each([
    ["has no modes", { ...STATUS, modes: [] }],
    ["has only the mode it is in", { ...STATUS, modes: [choice("default", "Manual")] }],
    ["has ended", { ...SETTINGS, state: "stopped" as const }],
    ["failed", { ...SETTINGS, state: "failed" as const }],
  ])("leaves Shift+Tab to move focus when the session %s", async (_, status) => {
    backend({ status, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("textbox", { name: "Message the agent" });
    const notPrevented = fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-mode", expect.anything());
  });

  it("keeps a choice shown when its status comes before the call's number", async () => {
    let number!: (answer: { ticket: number }) => void;
    backend(
      { status: SETTINGS, seq: 1, items: [] },
      { "agent-tab/set-mode": () => new Promise((resolve) => (number = resolve)) },
    );
    render(<App />);
    await act(async () => {
      await pickMode("Plan");
    });
    expect(await shownMode()).toBe("Plan");

    // The agent answered, settling elsewhere, before the call returned: the
    // choice is not taken back to the old mode, nor given the new one yet.
    emit({
      instanceId: "i",
      seq: 2,
      event: { type: "status", status: { ...SETTINGS, mode: "acceptEdits", answered: 1 } },
    });
    expect(await shownMode()).toBe("Plan");

    // Once the call is numbered, that status is the answer to it.
    await act(async () => number({ ticket: 1 }));
    expect(await shownMode()).toBe("Accept edits");
  });

  it("keeps the last choice shown when the calls return out of order", async () => {
    const numbers: ((answer: { ticket: number }) => void)[] = [];
    backend(
      { status: SETTINGS, seq: 1, items: [] },
      { "agent-tab/set-mode": () => new Promise((resolve) => numbers.push(resolve)) },
    );
    render(<App />);
    const status = (seq: number, mode: string, answered: number) =>
      emit({
        instanceId: "i",
        seq,
        event: { type: "status", status: { ...SETTINGS, mode, answered } },
      });
    await act(async () => {
      await pickMode("Accept edits");
    });
    await act(async () => {
      await pickMode("Plan");
    });

    // The second call returns first, then the first.
    await act(async () => numbers[1]({ ticket: 2 }));
    await act(async () => numbers[0]({ ticket: 1 }));
    expect(await shownMode()).toBe("Plan");

    // The first answer is not the last: the second choice stands.
    status(2, "acceptEdits", 1);
    expect(await shownMode()).toBe("Plan");

    // Both are answered, and the select follows the agent again.
    status(3, "default", 2);
    expect(await shownMode()).toBe("Manual");
  });

  it("changes the mode from the settings menu, and takes it back when refused", async () => {
    backend(
      { status: SETTINGS, seq: 1, items: [] },
      {
        "agent-tab/set-mode": () =>
          Promise.reject(
            new bridge.VeistraRpcError(-32010, "x", { code: "unknownOption", hint: null }),
          ),
      },
    );
    render(<App />);
    const menu = await modeMenu();
    await act(async () => {
      fireEvent.click(menu.getByRole("menuitemradio", { name: "Plan" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "plan" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The agent does not offer that choice.");
    expect(await shownMode()).toBe("Manual");
  });

  it("says a slow or refused change above the prompt, with nothing to retry", async () => {
    backend({
      status: SETTINGS,
      seq: 1,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    render(<App />);
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });
    const menu = await modeMenu();
    await act(async () => {
      fireEvent.click(menu.getByRole("menuitemradio", { name: "Plan" }));
    });

    status(2, { ...SETTINGS, settingTrouble: { kind: "unanswered", ticket: 1 } });
    await screen.findByText(
      "The agent has not answered that change yet. Later changes wait for it.",
    );
    expect(await shownMode()).toBe("Plan");

    status(3, {
      ...SETTINGS,
      answered: 1,
      settingTrouble: { kind: "refused", ticket: 1, message: "not in this session" },
    });
    await screen.findByText("The agent refused that change: not in this session");
    expect(await shownMode()).toBe("Manual");
    // A setting is not a prompt: a Retry here would resend "list the files".
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    // A refusal that gives no reason does not end on a colon.
    status(4, {
      ...SETTINGS,
      answered: 2,
      settingTrouble: { kind: "refused", ticket: 2, message: "" },
    });
    await screen.findByText("The agent refused that change.");

    // Once the session ends there is nothing left to answer it.
    status(5, {
      ...SETTINGS,
      state: "stopped",
      answered: 1,
      settingTrouble: { kind: "refused", ticket: 1, message: "not in this session" },
    });
    expect(screen.queryByText(/The agent refused that change/)).toBeNull();
  });

  it("does not promise a mode to a session that failed before reporting one", async () => {
    backend({ status: { ...STATUS, state: "failed" }, seq: 1, items: [] });
    render(<App />);
    fireEvent.click(await settingsButton());
    expect(screen.queryByRole("group", { hidden: true, name: "Mode" })).toBeNull();
    expect(screen.queryByText("The mode and model appear once the session starts.")).toBeNull();
  });

  it("offers no mode while stopped, until discovery has listed the next session's", async () => {
    backend({ status: { ...SETTINGS, state: "stopped" }, seq: 1, items: [] });
    render(<App />);
    const menu = await modeMenu();
    for (const item of menu.getAllByRole("menuitemradio")) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("offers the next session's modes while stopped, once discovery has listed them", async () => {
    const modes = [choice("default", "Manual"), choice("plan", "Plan")];
    backend(
      { status: { ...SETTINGS, state: "stopped" }, seq: 1, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({
            harnesses: [{ ...CLAUDE, modes, askFirst: "default" }],
            current: "claude",
            blocked: null,
          }),
      },
    );
    render(<App />);
    await untilMode("Manual");
    const items = (await modeMenu()).getAllByRole("menuitemradio");
    expect(items.map((o: HTMLElement) => o.textContent)).toEqual(["Manual", "Plan"]);
    for (const item of items) expect(item.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("shows a mode the agent entered but the tab does not offer, as it is", async () => {
    backend({ status: { ...SETTINGS, mode: "bypassPermissions" }, seq: 1, items: [] });
    render(<App />);
    await untilMode("bypassPermissions");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "default" });
  });

  it("picks the model and effort from the agent's own lists", async () => {
    backend({ status: MODELS, seq: 1, items: [] });
    render(<App />);
    await waitFor(async () =>
      expect(await shown()).toEqual(["Claude", "Default (recommended)", "Default", "Manual"]),
    );
    fireEvent.click(await settingsButton());
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups.slice(-2), "the model is under its harness").toEqual(["Effort", "Mode"]);
    expect(groups, "fast mode is not drawn here").not.toContain("Fast mode");
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });

    await act(async () => {
      const claude = within(screen.getByRole("group", { hidden: true, name: "Model" }));
      fireEvent.click(claude.getByRole("menuitemradio", { name: "Opus" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-config", {
      configId: "model",
      value: "opus",
    });
    expect(await shown()).toEqual(["Claude", "Opus", "Default", "Manual"]);

    // The answer lists the new model's own levels.
    const opus: SessionStatus = {
      ...MODELS,
      answered: 1,
      config: [
        { ...MODELS.config[0], value: "opus" },
        option("effort", "Effort", "thought_level", "default", [...LEVELS, ["xhigh", "Xhigh"]]),
      ],
    };
    status(2, opus);
    expect(await shown()).toEqual(["Claude", "Opus", "Default", "Manual"]);
    fireEvent.click(await settingsButton());
    const effort = within(screen.getByRole("group", { hidden: true, name: "Effort" }));
    const levels = effort
      .getAllByRole("button")
      .filter(
        (o) =>
          !(o as HTMLButtonElement).disabled &&
          ["Low", "Medium", "High", "Xhigh", "Max"].includes(o.textContent ?? ""),
      )
      .map((o) => o.textContent);
    expect(levels).toEqual(["Low", "High", "Xhigh"]);

    await act(async () => {
      fireEvent.click(effort.getByRole("button", { name: "Xhigh" }));
    });
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/set-config", {
      configId: "effort",
      value: "xhigh",
    });
    expect(await shown()).toEqual(["Claude", "Opus", "Xhigh", "Manual"]);

    // A model with no effort has no effort section.
    status(3, { ...MODELS, answered: 2, config: [{ ...MODELS.config[0], value: "haiku" }] });
    expect(await shown()).toEqual(["Claude", "Haiku", "Manual"]);
    fireEvent.click(await settingsButton());
    expect(screen.queryByRole("group", { hidden: true, name: "Effort" })).toBeNull();
  });

  it("holds each setting's choice until its own answer", async () => {
    backend({ status: MODELS, seq: 1, items: [] });
    render(<App />);
    await untilMode("Manual");
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });
    await pick("Effort", "High");
    await pick("Claude", "Opus");
    expect(await shown()).toEqual(["Claude", "Opus", "High", "Manual"]);

    // The agent refuses the effort and has yet to answer the model.
    status(2, {
      ...MODELS,
      answered: 1,
      settingTrouble: { kind: "refused", ticket: 1, message: "not for this model" },
    });
    await screen.findByText("The agent refused that change: not for this model");
    expect(
      await shown(),
      "the refused effort is taken back, and the unanswered model still stands",
    ).toEqual(["Claude", "Opus", "Default", "Manual"]);

    status(3, { ...MODELS, answered: 2, config: [{ ...MODELS.config[0], value: "opus" }] });
    expect(await shown()).toEqual(["Claude", "Opus", "Manual"]);
  });

  it("takes back only the choice the host refused", async () => {
    backend(
      { status: MODELS, seq: 1, items: [] },
      {
        "agent-tab/set-config": () =>
          Promise.reject(
            new bridge.VeistraRpcError(-32010, "x", { code: "unknownOption", hint: null }),
          ),
      },
    );
    render(<App />);
    await untilMode("Manual");
    await pickMode("Plan");
    await pick("Effort", "High");
    await screen.findByRole("alert");
    expect(await shown(), "the mode change is still on its way").toEqual([
      "Claude",
      "Default (recommended)",
      "Default",
      "Plan",
    ]);
  });

  it("never names the harness Claude Code", async () => {
    backend({ status: STATUS, seq: 1, items: [] });
    render(<App />);
    expect((await screen.findAllByText("Claude")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("Claude Code");
  });
});

describe("the harness", () => {
  const MODEL = {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    value: "opus",
    choices: [{ value: "opus", name: "Opus", description: null }],
  };

  it("names the running harness and its model on the settings button", async () => {
    backend({ status: { ...STATUS, config: [MODEL] }, seq: 1, items: [] });
    render(<App />);
    await waitFor(async () => expect(await shown()).toEqual(expect.arrayContaining(["Opus"])));
    expect(await shown()).toContain("Claude");
  });

  it("drops an ended session's model, which the next prompt does not run", async () => {
    backend({ status: { ...STATUS, state: "stopped", config: [MODEL] }, seq: 1, items: [] });
    render(<App />);
    await waitFor(async () => expect(await shown()).toContain("Claude"));
    expect(await shown()).not.toContain("Opus");
  });

  it("has no header bar to name it in: the pane's tab and this button do", async () => {
    backend({ status: { ...STATUS, config: [MODEL] }, seq: 1, items: [] });
    const { container } = render(<App />);
    await waitFor(async () => expect(await shown()).toContain("Opus"));
    expect(container.querySelector(".at-header")?.textContent).not.toContain("Opus");
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  });

  /** A second harness, fictional: the registry lists only Claude so far. */
  const PI = { ...CLAUDE, harness: "pi", name: "Pi" } as unknown as HarnessInfo;
  const both = () => Promise.resolve({ harnesses: [CLAUDE, PI], current: "claude", blocked: null });

  /** The one item under harness `name` in the settings menu: its default model. */
  async function harnessItem(name: string) {
    fireEvent.click(await settingsButton());
    const group = await screen.findByRole("group", { hidden: true, name: "Harness" });
    return within(group).getByRole("button", { name });
  }

  it("is chosen in the settings menu, and the host is told", async () => {
    backend({ status: null, seq: 0, items: [] }, { "agent-tab/harnesses": both });
    render(<App />);
    const pi = await harnessItem("Pi");
    expect(pi.getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(pi);
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/choose", { harness: "pi", model: null });
  });

  it("sends the model picked under a harness, and lists the harnesses again", async () => {
    const offered = [
      { value: "default", name: "Default", description: null },
      { value: "opus", name: "Opus", description: null },
    ];
    const claude = { ...CLAUDE, models: offered, model: "default" };
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [claude], current: "claude", blocked: null }),
      },
    );
    const asked = () =>
      bridge.invoke.mock.calls.filter(([method]) => method === "agent-tab/harnesses").length;
    render(<App />);
    await waitFor(() => expect(asked()).toBe(1));
    fireEvent.click(await settingsButton());
    const group = await screen.findByRole("group", { hidden: true, name: "Model" });
    await act(async () => {
      fireEvent.click(within(group).getByRole("menuitemradio", { name: /Opus/ }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/choose", {
      harness: "claude",
      model: "opus",
    });
    await waitFor(() => expect(asked()).toBe(2));
  });

  it("allows switching harnesses while a conversation exists", async () => {
    backend({ status: STATUS, seq: 1, items: [] }, { "agent-tab/harnesses": both });
    render(<App />);
    const other = await harnessItem("Pi");
    expect(other.getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(other);
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/choose", { harness: "pi", model: null });
  });

  it("shows a choice the host refused", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": both,
        "agent-tab/choose": () =>
          Promise.reject(new bridge.VeistraRpcError(-32010, "x", { code: "running", hint: null })),
      },
    );
    render(<App />);
    const pi = await harnessItem("Pi");
    await act(async () => {
      fireEvent.click(pi);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Start a new session to switch.");
  });

  it("follows a choice made in the agent bar", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [CLAUDE, CODEX], current: "codex", blocked: null }),
      },
    );
    render(<App />);
    await waitFor(() => expect(named()).toContain("Codex"));
    act(() => bridge.listeners.get("agent-tab:chosen")?.({ instanceId: "i", harness: "claude" }));
    expect(named()).toContain("Claude");
    expect(named()).not.toContain("Codex");
  });

  it("says a switch failed, not a send, when choosing fails", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": both,
        "agent-tab/choose": () => Promise.reject(new Error("gone")),
      },
    );
    render(<App />);
    const pi = await harnessItem("Pi");
    await act(async () => {
      fireEvent.click(pi);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not switch the harness.");
    expect(alert.textContent).not.toContain("Could not send that.");
  });

  it("keeps a choice it heard of while its list of harnesses was on the way", async () => {
    let reply: ((answer: unknown) => void) | undefined;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          new Promise((resolve) => {
            reply = resolve;
          }),
      },
    );
    render(<App />);
    await waitFor(() => expect(reply).toBeDefined());
    act(() => bridge.listeners.get("agent-tab:chosen")?.({ instanceId: "i", harness: "pi" }));
    // Asked before the choice, so its `current` is older than it.
    await act(async () => reply?.({ harnesses: [CLAUDE, PI], current: "claude", blocked: null }));
    expect(named()).toContain("Pi");
    expect(named()).not.toContain("Claude");
  });

  it("offers to list the harnesses again when the list fails", async () => {
    let attempts = 0;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          ++attempts === 1
            ? Promise.reject(new Error("not yet"))
            : Promise.resolve({ harnesses: [CLAUDE], current: "claude", blocked: null }),
      },
    );
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not list the harnesses.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(named()).toContain("Claude"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("words an ended session's hint for its own harness, not the one chosen next", async () => {
    const pi = { ...PI, setup: { ...CLAUDE.setup, cli: "pi", signIn: "pi login" } };
    backend(
      { status: { ...STATUS, state: "stopped", hint: "signedOut" }, seq: 1, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [CLAUDE, pi], current: "pi", blocked: null }),
      },
    );
    render(<App />);
    await waitFor(() => expect(named()).toContain("Pi"));
    await screen.findByText(/Claude is not signed in\. Run `claude` once/);
    expect(document.body.textContent).not.toContain("pi login");
  });

  it("says what the chosen harness still needs, in its own commands", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({
            harnesses: [{ ...CLAUDE, hint: "signedOut" }],
            current: "claude",
            blocked: null,
          }),
      },
    );
    render(<App />);
    await screen.findByText(/Claude is not signed in\. Run `claude` once/);
  });

  it("words an earlier session's error for the harness that raised it", async () => {
    const signedOut = item("e1", {
      kind: "error",
      message: "auth required",
      hint: "signedOut",
      harness: "claude",
    });
    backend(
      { status: { ...STATUS, harness: "codex" }, seq: 3, items: [signedOut] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [CLAUDE, CODEX], current: "codex", blocked: null }),
      },
    );
    render(<App />);
    await screen.findByText(/Claude is not signed in\. Run `claude` once/);
    expect(screen.queryByText(/codex login/)).toBeNull();
  });

  describe("before a session", () => {
    const claude: HarnessInfo = {
      ...CLAUDE,
      modes: [choice("default", "Manual"), choice("plan", "Plan"), choice("auto", "Auto")],
      askFirst: "default",
    };
    const codex: HarnessInfo = {
      ...CODEX,
      modes: [choice("read-only", "Read Only"), choice("auto", "Default")],
      askFirst: "read-only",
    };
    // The host's current harness is the last one chosen, as `agent-tab/choose` keeps it.
    const chosen = (): string =>
      [...bridge.invoke.mock.calls].reverse().find(([method]) => method === "agent-tab/choose")?.[1]
        ?.harness ?? "claude";
    const listed = () =>
      backend(
        { status: null, seq: 0, items: [] },
        {
          "agent-tab/harnesses": () =>
            Promise.resolve({ harnesses: [claude, codex], current: chosen(), blocked: null }),
        },
      );
    const checked = (menu: ReturnType<typeof within>) =>
      menu
        .getAllByRole("menuitemradio")
        .filter((o: HTMLElement) => o.getAttribute("aria-checked") === "true")
        .map((o: HTMLElement) => o.textContent);
    const send = async (text: string) => {
      fireEvent.change(prompt(), { target: { value: text } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
      });
    };

    it("lists the chosen harness's modes, and switching harness switches them in place", async () => {
      listed();
      render(<App />);
      const menu = await modeMenu();
      await waitFor(() => expect(checked(menu)).toEqual(["Manual"]));
      expect(menu.getAllByRole("menuitemradio").map((o: HTMLElement) => o.textContent)).toEqual([
        "Manual",
        "Plan",
        "Auto",
      ]);
      fireEvent.click(menu.getByRole("menuitemradio", { name: "Plan" }));
      // The menu stays open on a harness, so its mode is set in the same place.
      const modes = () => within(screen.getByRole("group", { hidden: true, name: "Mode" }));
      await act(async () => {
        fireEvent.click(await harnessItem("Codex"));
      });
      await waitFor(() => expect(checked(modes())).toEqual(["Read Only"]));
      expect(modes().getByRole("menuitemradio", { name: "Default" })).toBeTruthy();
      // Each harness keeps its own pick.
      const group = within(screen.getByRole("group", { hidden: true, name: "Harness" }));
      await act(async () => {
        fireEvent.click(group.getByRole("button", { name: "Claude" }));
      });
      await waitFor(() => expect(checked(modes())).toEqual(["Plan"]));
    });

    it("sends the picked mode with the prompt that starts the session", async () => {
      listed();
      render(<App />);
      await untilMode("Manual");
      fireEvent.click((await modeMenu()).getByRole("menuitemradio", { name: "Auto" }));
      await send("fix the build");
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
        text: "fix the build",
        effort: "medium",
        ultracode: false,
        mode: "auto",
      });
    });

    it("sends no mode when the pick is where the session starts anyway", async () => {
      listed();
      render(<App />);
      const menu = await modeMenu();
      fireEvent.click(menu.getByRole("menuitemradio", { name: "Plan" }));
      fireEvent.click((await modeMenu()).getByRole("menuitemradio", { name: "Manual" }));
      await send("fix the build");
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
        text: "fix the build",
        effort: "medium",
        ultracode: false,
      });
    });

    // The user asked for the tab to keep its settings, so a later session
    // starts in the last mode picked rather than asking first again.
    it("starts a later session in the mode last picked", async () => {
      listed();
      render(<App />);
      await untilMode("Manual");
      fireEvent.click((await modeMenu()).getByRole("menuitemradio", { name: "Auto" }));
      await send("fix the build");
      // The session enters the pick and ends, both before the tab draws again.
      const ran = { ...STATUS, modes: claude.modes ?? [] };
      const heard = bridge.listeners.get("agent-tab:event");
      act(() => {
        heard?.({
          instanceId: "i",
          seq: 1,
          event: { type: "status", status: { ...ran, mode: "auto" } },
        });
        heard?.({
          instanceId: "i",
          seq: 2,
          event: { type: "status", status: { ...ran, state: "stopped" } },
        });
      });
      await send("and the tests");
      const sent = bridge.invoke.mock.calls
        .filter(([method]) => method === "agent-tab/send")
        .map(([, params]) => params);
      expect(sent).toEqual([
        { text: "fix the build", effort: "medium", ultracode: false, mode: "auto" },
        { text: "and the tests", effort: "medium", ultracode: false, mode: "auto" },
      ]);
    });

    it("opens a new tab with the effort and mode picked in an earlier one", async () => {
      localStorage.setItem(
        "veistra.agent-tab.prefs",
        JSON.stringify({ effort: "high", modes: { claude: "auto" } }),
      );
      listed();
      render(<App />);
      await untilMode("Auto");
      await send("hello");
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
        text: "hello",
        effort: "high",
        ultracode: false,
        mode: "auto",
      });
    });

    it("switches the next session's mode with Shift+Tab", async () => {
      listed();
      render(<App />);
      await waitFor(async () => expect(await shownMode()).toBe("Manual"));
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
      await untilMode("Plan");
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true, repeat: true });
      expect(await shownMode()).toBe("Plan");
      expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-mode", expect.anything());
    });
  });

  it("asks for the harnesses again once an agent's models are in", async () => {
    backend({ status: null, seq: 0, items: [] });
    const asked = () =>
      bridge.invoke.mock.calls.filter(([method]) => method === "agent-tab/harnesses").length;
    render(<App />);
    await waitFor(() => expect(asked()).toBe(1));
    act(() => bridge.listeners.get("agent-tab:models")?.({ instanceId: "i", harness: "claude" }));
    await waitFor(() => expect(asked()).toBe(2));
  });
});

describe("slash commands", () => {
  it("opens model settings without sending a prompt", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "/model" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
  });

  it("searches context from the plus button and sends the selected stable reference", async () => {
    const hit = {
      uri: "veistra://canvas/design#frame=login",
      kind: "frame",
      title: "Login design",
    };
    backend(
      { status: null, seq: 0, items: [] },
      { "refs/search": () => Promise.resolve({ items: [hit] }) },
    );
    render(<App />);
    await settingsButton();
    fireEvent.click(screen.getByRole("button", { name: "Add project context" }));
    fireEvent.click(await screen.findByRole("option", { name: "Design" }));
    fireEvent.click(await screen.findByRole("option", { name: "Frames" }));
    const option = await screen.findByRole("option", { name: /Login design/ });
    fireEvent.click(option);
    // The chip sits in the text where it was picked.
    expect(prompt()).toHaveProperty("value", "@Login design ");
    expect(screen.getByRole("group", { hidden: true, name: "Login design" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      text: "[@Login design](<veistra://canvas/design#frame=login>)",
      effort: "medium",
      ultracode: false,
    });
    expect(screen.getByRole("button", { name: "Voice dictation" })).toBeTruthy();
  });

  it("navigates nested design context from the keyboard and inserts a chip", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "refs/search": () =>
          Promise.resolve({
            items: [
              { uri: "veistra://canvas/design#frame=login", kind: "frame", title: "Login design" },
            ],
          }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    // The search over every kind, not the frame listing the menu also asks for on opening.
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({ kinds: undefined }),
      ),
    );
    fireEvent.keyDown(prompt(), { key: "ArrowRight" });
    fireEvent.keyDown(prompt(), { key: "ArrowDown" });
    fireEvent.keyDown(prompt(), { key: "ArrowRight" });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(screen.getByRole("group", { hidden: true, name: "Login design" })).toBeTruthy();
    expect(prompt()).toHaveProperty("value", "@Login design ");
  });

  it("opens a canvas onto its frames, with the whole canvas first", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "refs/search": (p?: { kinds?: string[] }) =>
          Promise.resolve({
            items: p?.kinds?.includes("frame")
              ? [{ uri: "veistra://canvas/hammer#frame=f1", kind: "frame", title: "Fling physics" }]
              : [{ uri: "veistra://canvas/hammer", kind: "canvas", title: "hammer" }],
          }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({ kinds: undefined }),
      ),
    );
    fireEvent.click(await screen.findByRole("option", { name: /Design/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Canvases/ }));
    fireEvent.click(await screen.findByRole("option", { name: /hammer/ }));
    await screen.findByRole("option", { name: /Whole canvas/ });
    fireEvent.click(screen.getByRole("option", { name: /Fling physics/ }));
    expect(screen.getByRole("group", { hidden: true, name: "Fling physics" })).toBeTruthy();
  });

  // The canvas `hammer` held two open comments, and Design's Comments listed neither: it
  // searched Design Mode's and the viewers' comments, never the ones left on a canvas.
  const canvasComments = [
    {
      uri: "veistra://canvas/hammer#comment=c-1",
      kind: "canvas-comment",
      title: "Opinion on this?",
      detail: "open · canvas hammer, frame f1",
    },
    {
      uri: "veistra://canvas/hammer#comment=c-2",
      kind: "canvas-comment",
      title: "What the fahh is this?",
      detail: "open · canvas hammer, frame f2",
    },
  ];

  it("searches canvas comments under Design's Comments, and picks one by its reference", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        // As the backend answers: canvas comments only for a search that names their kind.
        "refs/search": (p?: { query?: string; kinds?: string[] }) =>
          Promise.resolve({
            items: p?.kinds?.includes("canvas-comment")
              ? canvasComments.filter((c) => c.title.toLowerCase().includes(p.query ?? ""))
              : [],
          }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    fireEvent.click(await screen.findByRole("option", { name: "Design" }));
    fireEvent.click(await screen.findByRole("option", { name: "Comments" }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({ kinds: ["canvas-comment", "design-comment"] }),
      ),
    );
    expect(await screen.findByRole("option", { name: /Opinion on this\?/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /What the fahh is this\?/ })).toBeTruthy();
    fireEvent.change(prompt(), { target: { value: "@opinion" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /What the fahh/ })).toBeNull());
    fireEvent.click(screen.getByRole("option", { name: /Opinion on this\?/ }));
    expect(screen.getByRole("group", { hidden: true, name: "Opinion on this?" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith(
      "agent-tab/send",
      expect.objectContaining({
        text: "[@Opinion on this?](<veistra://canvas/hammer#comment=c-1>)",
      }),
    );
  });

  it("lists canvas comments the opening search found under Design's Comments", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      { "refs/search": () => Promise.resolve({ items: canvasComments }) },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    fireEvent.click(await screen.findByRole("option", { name: "Design" }));
    fireEvent.click(await screen.findByRole("option", { name: "Comments" }));
    fireEvent.click(await screen.findByRole("option", { name: /What the fahh is this\?/ }));
    expect(
      screen.getByRole("group", { hidden: true, name: "What the fahh is this?" }),
    ).toBeTruthy();
  });

  it("offers the Design group's search when @design is typed", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "refs/search": (p?: { kinds?: string[] }) =>
          Promise.resolve({
            items: p?.kinds?.includes("canvas-comment")
              ? [
                  { uri: "veistra://canvas/hammer", kind: "canvas", title: "hammer" },
                  { uri: "veistra://canvas/hammer#frame=f1", kind: "frame", title: "Fling" },
                  ...canvasComments,
                ]
              : [],
          }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@design" } });
    await screen.findByRole("option", { name: "Design" });
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(prompt()).toHaveProperty("value", "@");
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({
          query: "",
          kinds: ["canvas", "frame", "canvas-comment", "design-comment"],
        }),
      ),
    );
    expect(await screen.findByRole("option", { name: /Fling/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Opinion on this\?/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Opinion on this\?/ }));
    expect(screen.getByRole("group", { hidden: true, name: "Opinion on this?" })).toBeTruthy();
  });

  it("takes a context item another app attached as a chip", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await settingsButton();
    act(() =>
      bridge.listeners.get("agent-tab:attach")?.({ contextId: "ctx_1", label: "Canvas selection" }),
    );
    expect(screen.getByRole("group", { hidden: true, name: "Canvas selection" })).toBeTruthy();
  });

  it("offers a kind's search when its name is typed, and starts that search empty", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      { "refs/search": () => Promise.resolve({ items: [] }) },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@sav" } });
    await screen.findByRole("option", { name: "Saved context" });
    // Only once the search has answered can its empty result have said "no match".
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({ query: "sav" }),
      ),
    );
    await act(async () => {});
    expect(screen.queryByText("No matching project context")).toBeNull();
    expect(screen.getByRole("option", { name: "Saved context" })).toBeTruthy();
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(prompt()).toHaveProperty("value", "@");
    expect(await screen.findByText("Type to search")).toBeTruthy();
  });

  it("does not pick a hit left over from an earlier query while the new one is searched", async () => {
    const canvas = { uri: "veistra://canvas/a", kind: "canvas", title: "Canvas A" };
    const readme = { uri: "veistra://file/README.md", kind: "file", title: "README.md" };
    let answer: (value: unknown) => void = () => {};
    backend({ status: null, seq: 0, items: [] });
    const base = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation((method: string, params?: { query?: string }) => {
      if (method !== "refs/search") return base(method, params);
      if (params?.query === "readme") return new Promise((resolve) => (answer = resolve));
      return Promise.resolve({ items: params?.query ? [] : [canvas] });
    });
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    await screen.findByRole("option", { name: "Design" });
    fireEvent.change(prompt(), { target: { value: "@readme" } });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({ query: "readme" }),
      ),
    );
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(screen.queryByRole("group", { hidden: true, name: "Canvas A" })).toBeNull();
    expect(prompt()).toHaveProperty("value", "@readme");
    await act(async () => answer({ items: [readme] }));
    fireEvent.keyDown(prompt(), { key: "Enter" });
    expect(screen.getByRole("group", { hidden: true, name: "README.md" })).toBeTruthy();
    expect(prompt()).toHaveProperty("value", "@README.md ");
  });

  it("starts the next @ at the top level after a pick inside a scope", async () => {
    const readme = { uri: "veistra://file/README.md", kind: "file", title: "README.md" };
    backend({ status: null, seq: 0, items: [] });
    const base = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation((method: string, params?: { kinds?: string[] }) =>
      method === "refs/search"
        ? Promise.resolve({ items: params?.kinds ? [readme] : [] })
        : base(method, params),
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    // With no file listed yet, Files is the search itself rather than a level to open.
    fireEvent.click(await screen.findByRole("option", { name: "Files" }));
    fireEvent.click(await screen.findByRole("option", { name: /README\.md/ }));
    expect(screen.getByRole("group", { hidden: true, name: "README.md" })).toBeTruthy();
    expect(prompt()).toHaveProperty("value", "@README.md ");
    // The pick puts the caret back on the next frame; type after it, as a person would.
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    fireEvent.change(prompt(), { target: { value: "@" } });
    await screen.findByRole("option", { name: "Design" });
    const searched = bridge.invoke.mock.calls.filter(([method]) => method === "refs/search").length;
    await waitFor(() =>
      expect(
        bridge.invoke.mock.calls.filter(([method]) => method === "refs/search").length,
      ).toBeGreaterThan(searched),
    );
    const searches = bridge.invoke.mock.calls.filter(([method]) => method === "refs/search");
    expect(searches[searches.length - 1][1]).toHaveProperty("kinds", undefined);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("holds Send while a cluster's transcript is copied into its chip", async () => {
    let copied: (hit: unknown) => void = () => {};
    backend(
      { status: null, seq: 0, items: [] },
      {
        "refs/search": () => Promise.resolve({ items: [] }),
        "agent-tab/context-sources": () =>
          Promise.resolve({ clusters: [{ id: "c2", title: "Backend work" }], issues: [] }),
        "agent-tab/cluster-context": () => new Promise((resolve) => (copied = resolve)),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    fireEvent.click(await screen.findByRole("option", { name: "Other clusters" }));
    fireEvent.click(await screen.findByRole("option", { name: "Backend work" }));
    // The "@" goes at once, so typing on loses nothing; the prompt waits for the chip.
    expect(prompt()).toHaveProperty("value", "");
    fireEvent.change(prompt(), { target: { value: "carry on" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      copied({ uri: "veistra://cluster/c2", kind: "cluster", title: "Backend work" }),
    );
    expect(screen.getByRole("group", { hidden: true, name: "Backend work" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      text: expect.stringContaining("veistra://cluster/c2"),
      effort: "medium",
      ultracode: false,
    });
  });

  it("gives the menus no keys while the issue-link form covers them", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "refs/search": () =>
          Promise.resolve({
            items: [{ uri: "veistra://file/a.ts", kind: "file", title: "a.ts" }],
          }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@" } });
    fireEvent.click(await screen.findByRole("option", { name: "Project management" }));
    fireEvent.click(await screen.findByRole("option", { name: "Jira" }));
    fireEvent.click(await screen.findByRole("option", { name: "Add issue link" }));
    fireEvent.change(prompt(), { target: { value: "@a" } });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        "refs/search",
        expect.objectContaining({ query: "a" }),
      ),
    );
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(prompt().getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(prompt(), { key: "ArrowDown" });
    expect(screen.queryByRole("group", { hidden: true, name: "a.ts" })).toBeNull();
  });

  it("does not send a half-typed mention when Enter has nothing to pick", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      { "refs/search": () => Promise.resolve({ items: [] }) },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "@zzz" } });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("refs/search", expect.anything()),
    );
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect(prompt()).toHaveProperty("value", "@zzz");
  });

  it("opens saved conversation history with either harness without sending a prompt", async () => {
    const restored = item("old", { kind: "userMessage", text: "A saved conversation" });
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/history": () =>
          Promise.resolve({
            sessions: [
              {
                id: "saved",
                title: "A saved conversation",
                updated: 1,
                harness: "claude",
                archived: false,
              },
            ],
          }),
        "agent-tab/history-open": () =>
          Promise.resolve({ seq: 5, status: null, items: [restored] }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    await screen.findByRole("button", { name: /A saved conversation/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Continue with" }), {
      target: { value: "codex" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /A saved conversation/ }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/history-open", {
      id: "saved",
      harness: "codex",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("A saved conversation")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
  });

  it("shows a saved session the Agents page opened in it", async () => {
    const restored = item("old", { kind: "userMessage", text: "Resumed from the Agents page" });
    let attachment: Attachment = { status: null, seq: 0, items: [] };
    backend(attachment, { "agent-tab/attach": () => Promise.resolve(attachment) });
    render(<App />);
    await settingsButton();
    expect(screen.queryByText("Resumed from the Agents page")).toBeNull();
    attachment = { status: null, seq: 5, items: [restored] };
    await act(async () => {
      bridge.listeners.get("agent-tab:restored")?.({ instanceId: "tab" });
    });
    expect(await screen.findByText("Resumed from the Agents page")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
  });

  it("routes btw to a separate conversation and preserves the main transcript", async () => {
    const main = item("u1", { kind: "userMessage", text: "Build a dashboard" });
    backend(
      { status: { ...STATUS, state: "working" }, seq: 1, items: [main] },
      {
        "agent-tab/btw-attach": () => Promise.resolve({ status: null, seq: 0, items: [] }),
      },
    );
    render(<App />);
    await settingsButton();
    fireEvent.change(prompt(), { target: { value: "/btw What is CSS grid?" } });
    // Sending a side question is allowed while the main agent is busy.
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/btw-send", {
      text: "What is CSS grid?",
      context: "userMessage: Build a dashboard",
    });
    expect(screen.getByRole("region", { name: "Side chat" })).toBeTruthy();
    expect(screen.getByText("Build a dashboard")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/cancel");
  });
  const WITH_COMMANDS: SessionStatus = {
    ...STATUS,
    commands: [
      { name: "compact", description: "Clear history", hint: "instructions" },
      { name: "init", description: "Set up CLAUDE.md", hint: null },
    ],
  };

  async function ready(status: SessionStatus | null) {
    backend({ status, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("status");
  }

  const names = () => screen.queryAllByRole("option").map((o) => o.textContent);

  it("lists the agent's commands, and login, for a bare slash", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/" } });
    expect(names()).toContain("compactClear history");
    expect(names()).toContain("loginSign in to your account");
    expect(names()).toContain("btwAsk a side question");
    expect(names().length).toBeGreaterThan(8);
  });

  it("filters as the name is typed, and offers nothing once an argument starts", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/co" } });
    expect(names()).toContain("compactClear history");
    fireEvent.change(prompt(), { target: { value: "/compact now" } });
    expect(names()).toEqual([]);
  });

  it("offers login before any session has listed commands", async () => {
    await ready(null);
    fireEvent.change(prompt(), { target: { value: "/" } });
    expect(names()).toEqual(
      expect.arrayContaining([
        "loginSign in to your account",
        "modelChoose a harness and model",
        "effortSet reasoning effort",
        "clearStart a new conversation",
        "stopStop the current response",
        "helpShow available commands",
        "btwAsk a side question",
      ]),
    );
  });

  it("opens skills as a search, and a pick becomes a chip", async () => {
    await ready({
      ...STATUS,
      commands: [
        { name: "benchmark", description: "Performance regression detection", hint: null },
        { name: "investigate", description: "Systematic debugging", hint: null },
      ],
    });
    fireEvent.change(prompt(), { target: { value: "/" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /^skills/ }));
    });
    expect(prompt()).toHaveProperty("value", "/skills ");
    expect(screen.getByText("Search skills")).toBeTruthy();
    expect(names()).toEqual([
      "benchmarkPerformance regression detection",
      "investigateSystematic debugging",
    ]);
    fireEvent.change(prompt(), { target: { value: "/skills debug" } });
    expect(names()).toEqual(["investigateSystematic debugging"]);
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(screen.getByRole("group", { hidden: true, name: "investigate" })).toBeTruthy();
    expect(prompt()).toHaveProperty("value", "");
    fireEvent.change(prompt(), { target: { value: "/skills zzz" } });
    expect(screen.getByText("No matching skills")).toBeTruthy();
    fireEvent.change(prompt(), { target: { value: "/skills " } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "ArrowLeft" });
    });
    expect(prompt()).toHaveProperty("value", "/");
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
  });

  it("moves with the arrows, and Enter fills the name instead of sending it", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/" } });
    fireEvent.keyDown(prompt(), { key: "ArrowDown" });
    fireEvent.keyDown(prompt(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("model");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(prompt()).toHaveProperty("value", "/model ");
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
  });

  it("fills on Tab or a click, and closes on Escape until the draft changes", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/co" } });
    fireEvent.keyDown(prompt(), { key: "Tab" });
    expect(prompt()).toHaveProperty("value", "/compact ");
    fireEvent.change(prompt(), { target: { value: "/i" } });
    fireEvent.click(screen.getByRole("option", { name: /init/ }));
    expect(prompt()).toHaveProperty("value", "/init ");
    fireEvent.change(prompt(), { target: { value: "/c" } });
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(names()).toEqual([]);
    fireEvent.change(prompt(), { target: { value: "/co" } });
    expect(names()).toContain("compactClear history");
  });

  it("sends a command typed out in full that takes no argument", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/init" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      text: "/init",
      effort: "medium",
      ultracode: false,
    });
  });

  it("signs in on /login without sending it to the agent, and says how it ended", async () => {
    await ready(null);
    fireEvent.change(prompt(), { target: { value: "/login" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/login");
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect(prompt()).toHaveProperty("value", "");
    expect(await screen.findByText("Finish signing in to Claude in your browser.")).toBeTruthy();

    act(() => bridge.listeners.get("agent-tab:login")?.({ harness: "claude", ok: true }));
    expect(
      await screen.findByText("Signed in to Claude. Send a prompt to start a session."),
    ).toBeTruthy();
    act(() => bridge.listeners.get("agent-tab:login")?.({ harness: "claude", ok: false }));
    expect(await screen.findByText("Could not sign in to Claude. Try /login again.")).toBeTruthy();
  });

  it("names a sign-in that could not start", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      { "agent-tab/login": () => Promise.reject(new Error("no")) },
    );
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "/login" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(await screen.findByText("Could not start the sign-in.")).toBeTruthy();
  });
});

describe("naming the chat", () => {
  const ONE_PROMPT: Attachment = {
    status: STATUS,
    seq: 1,
    items: [item("u1", { kind: "userMessage", text: "Hello!" })],
  };

  async function type(text: string) {
    fireEvent.change(prompt(), { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
  }

  const titles = () =>
    bridge.invoke.mock.calls.filter(([m]) => m === "veistra/title").map(([, p]) => p);
  // Indexed rather than `.at(-1)`: CI type-checks against ES2021.
  const lastTitle = () => {
    const all = titles();
    return all[all.length - 1];
  };

  it("/rename names the tab over its first prompt, keeps it, and sends nothing to the agent", async () => {
    backend(ONE_PROMPT);
    render(<App />);
    await screen.findByText("Hello!");
    await waitFor(() => expect(lastTitle()).toMatchObject({ title: "Hello!" }));
    await type("/rename  balls ");
    expect(await screen.findByText("Session renamed to: balls")).toBeTruthy();
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-session-meta", { name: "balls" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/history-save");
    expect(lastTitle()).toMatchObject({ title: "balls" });
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/cli-command", expect.anything());
  });

  it("/rename with no name says how to use it", async () => {
    backend(ONE_PROMPT);
    render(<App />);
    await screen.findByText("Hello!");
    await type("/rename ");
    expect(await screen.findByText(strings.rename.usage)).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-session-meta", expect.anything());
  });

  it("brings back the name a reopened session was saved with", async () => {
    backend(ONE_PROMPT, {
      "agent-tab/session-meta": () => Promise.resolve({ name: "balls" }),
    });
    render(<App />);
    await waitFor(() => expect(lastTitle()).toMatchObject({ title: "balls" }));
  });

  it("re-reads them when the Agents page renames or restores the session", async () => {
    let meta = { name: null as string | null };
    backend(ONE_PROMPT, { "agent-tab/session-meta": () => Promise.resolve(meta) });
    render(<App />);
    await screen.findByText("Hello!");
    meta = { name: "from the sidebar" };
    act(() => bridge.listeners.get("agent-tab:restored")?.({ instanceId: "i" }));
    await waitFor(() => expect(lastTitle()).toMatchObject({ title: "from the sidebar" }));
  });

  it("takes a name the agent gives the conversation, but not one it had before", async () => {
    backend({ ...ONE_PROMPT, status: { ...STATUS, sessionTitle: "old" } });
    render(<App />);
    await screen.findByText("Hello!");
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-session-meta", expect.anything());
    emit({
      instanceId: "i",
      seq: 2,
      event: { type: "status", status: { ...STATUS, sessionTitle: "Agent named" } },
    });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-session-meta", {
        name: "Agent named",
      }),
    );
  });

  it("a new conversation starts unnamed", async () => {
    backend(ONE_PROMPT, {
      "agent-tab/session-meta": () => Promise.resolve({ name: "balls" }),
    });
    render(<App />);
    await waitFor(() => expect(lastTitle()).toMatchObject({ title: "balls" }));
    await type("/clear");
    await waitFor(() => expect(lastTitle()).not.toMatchObject({ title: "balls" }));
  });
});
