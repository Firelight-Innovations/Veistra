// @vitest-environment jsdom
/**
 * The item renderers on their own: what an agent's Markdown may do when it is
 * clicked, the approval card's diff and cut-off notice, and the question card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ItemView, NestedItems } from "./Items";
import { strings } from "./strings";
import { answerOpenCard } from "./questions";
import type { FileDiff, Item, Question, QuestionOutcome, WorkflowRun } from "./protocol.generated";

afterEach(cleanup);

const actions = {
  onAnswer: () => Promise.resolve(),
  onQuestion: () => Promise.resolve(),
  onRetry: () => {},
  hintText: () => "",
  onOpenTask: () => {},
  onStopTask: () => Promise.resolve(),
  elapsed: () => null,
};

function view(item: Item) {
  return render(<ItemView item={item} actions={actions} />);
}

const reply = (text: string): Item => ({
  id: "a1",
  turnId: "t1",
  kind: { kind: "assistantText", text },
});

describe("an agent's Markdown", () => {
  it("never lets a click or a middle click on a link navigate the frame", () => {
    view(reply("see [the docs](https://example.com/docs)"));
    const link = screen.getByRole("link", { name: "the docs" });
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.click(link)).toBe(false);
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    expect(fireEvent(link, middle)).toBe(false);
  });

  it("does not make a link of a javascript: address", () => {
    view(reply("[run it](javascript:alert(1))"));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("copies the text of a fenced block from its button", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    view(reply("```sh\nnpm test\n```"));
    const copy = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("npm test\n");
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
  });
});

const diff = (path: string, oldText: string | null, newText: string): FileDiff => ({
  path,
  oldText,
  newText,
  tooLarge: false,
});

const approval = (over: Partial<Extract<Item["kind"], { kind: "approval" }>>): Item => ({
  id: "p1",
  turnId: "t1",
  kind: {
    kind: "approval",
    title: "Edit a.txt",
    toolCallId: "c1",
    detail: null,
    detailTruncated: false,
    paths: [],
    diffs: [],
    options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    answer: null,
    ...over,
  },
});

describe("an approval card", () => {
  it("shows the change an edit would make, line by line", () => {
    view(approval({ diffs: [diff("C:/w/a.txt", "one\ntwo\n", "one\nthree\n")] }));
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText("- two")).toBeTruthy();
    expect(screen.getByText("+ three")).toBeTruthy();
    expect(screen.getByText("C:/w/a.txt")).toBeTruthy();
  });

  it("draws several diffs of one file without a duplicate key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    view(
      approval({
        paths: ["C:/w/a.txt", "C:/w/a.txt"],
        diffs: [diff("C:/w/a.txt", "a", "b"), diff("C:/w/a.txt", "c", "d")],
      }),
    );
    expect(screen.getAllByText("C:/w/a.txt").length).toBeGreaterThanOrEqual(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("says when the command shown is only the start of it", () => {
    view(approval({ detail: "rm -rf build", detailTruncated: true }));
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText(/Only the start of this is shown/)).toBeTruthy();
  });

  it("says nothing of the sort for a command shown in full", () => {
    view(approval({ detail: "ls" }));
    expect(screen.queryByText(/Only the start of this is shown/)).toBeNull();
  });
});

type QuestionKind = Extract<Item["kind"], { kind: "question" }>;

const grapple: Question = {
  id: "question_0",
  header: "Grapple",
  text: "How should the grapple let go?",
  choices: [
    { value: "release", label: "On button release", description: null },
    { value: "top", label: "At the top of the swing", description: null },
    { value: "both", label: "Both, test each", description: null },
  ],
  multi: false,
  other: true,
};

const extras: Question = {
  id: "question_1",
  header: null,
  text: "Which extras?",
  choices: [
    { value: "rope", label: "Rope sway", description: null },
    { value: "dust", label: "Dust puffs", description: null },
  ],
  multi: true,
  other: false,
};

const question = (over: Partial<QuestionKind> = {}): Item => ({
  id: "q1",
  turnId: "t1",
  kind: {
    kind: "question",
    message: "",
    toolCallId: null,
    questions: [grapple],
    outcome: null,
    ...over,
  },
});

function ask(item: Item) {
  const onQuestion = vi.fn<(id: string, outcome: QuestionOutcome) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const utils = render(<ItemView item={item} actions={{ ...actions, onQuestion }} />);
  return { onQuestion, ...utils };
}

const key = (k: string) => fireEvent.keyDown(window, { key: k, bubbles: true, cancelable: true });

describe("a question card", () => {
  it("shows the question in bold over numbered, full-width rows", () => {
    ask(question());
    expect(screen.getByText("How should the grapple let go?").className).toContain(
      "at-question__text",
    );
    const rows = screen.getAllByRole("radio");
    expect(rows.map((r) => r.textContent)).toEqual([
      "1 ·On button release",
      "2 ·At the top of the swing",
      "3 ·Both, test each",
    ]);
    expect(rows.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    // One question, one pick: no Submit to press.
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  });

  it("sends a single question's answer on the click", () => {
    const { onQuestion } = ask(question());
    fireEvent.click(screen.getByRole("radio", { name: /At the top of the swing/ }));
    expect(onQuestion).toHaveBeenCalledWith("q1", {
      kind: "answered",
      replies: [{ picks: ["top"], other: null }],
    });
    expect(screen.getByRole("radio", { name: /At the top/ }).getAttribute("data-picked")).toBe(
      "true",
    );
  });

  it("picks by number key while it is the open card", () => {
    const { onQuestion } = ask(question());
    key("3");
    expect(onQuestion).toHaveBeenCalledWith("q1", {
      kind: "answered",
      replies: [{ picks: ["both"], other: null }],
    });
  });

  it("ignores a number past the last choice", () => {
    const { onQuestion } = ask(question());
    key("7");
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it("takes the composer's text as the typed answer", async () => {
    const { onQuestion } = ask(question());
    expect(answerOpenCard("  Only while held  ")).toBe(true);
    await waitFor(() =>
      expect(onQuestion).toHaveBeenCalledWith("q1", {
        kind: "answered",
        replies: [{ picks: [], other: "Only while held" }],
      }),
    );
  });

  it("shows checkboxes for a multi-select and sends on Submit", () => {
    const { onQuestion } = ask(question({ questions: [grapple, extras] }));
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Keys answer the first open question, then move on to the next.
    key("1");
    expect(onQuestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Dust puffs/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Rope sway/ }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onQuestion).toHaveBeenCalledWith("q1", {
      kind: "answered",
      // In the agent's order, not the order they were clicked in.
      replies: [
        { picks: ["release"], other: null },
        { picks: ["rope", "dust"], other: null },
      ],
    });
  });

  it("sends a skip", () => {
    const { onQuestion } = ask(question());
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onQuestion).toHaveBeenCalledWith("q1", { kind: "skipped" });
  });

  it("can be answered again when the answer did not land", async () => {
    const onQuestion = vi.fn(() => Promise.reject(new Error("gone")));
    render(<ItemView item={question()} actions={{ ...actions, onQuestion }} />);
    fireEvent.click(screen.getByRole("radio", { name: /On button release/ }));
    await waitFor(() =>
      expect(
        (screen.getByRole("radio", { name: /On button release/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("collapses to the question and the answer once answered", () => {
    const { onQuestion } = ask(
      question({
        questions: [grapple, extras],
        outcome: {
          kind: "answered",
          replies: [
            { picks: [], other: "Only while held" },
            { picks: ["dust"], other: null },
          ],
        },
      }),
    );
    expect(screen.getByText("How should the grapple let go?")).toBeTruthy();
    expect(screen.getByText("“Only while held”")).toBeTruthy();
    const rows = screen.getAllByRole("checkbox");
    expect(rows.map((r) => r.textContent)).toEqual(["2 ·✓Dust puffs"]);
    expect((rows[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    // A closed card no longer takes keys or text.
    key("1");
    expect(answerOpenCard("more")).toBe(false);
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it("says when it was skipped or withdrawn", () => {
    ask(question({ outcome: { kind: "skipped" } }));
    expect(screen.getByText("Skipped")).toBeTruthy();
    cleanup();
    ask(question({ outcome: { kind: "cancelled" } }));
    expect(screen.getByText("Withdrawn")).toBeTruthy();
    expect(screen.queryByText("No answer")).toBeNull();
  });

  it("answers only the newest open card from the keyboard", () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    render(
      <>
        <ItemView item={question()} actions={{ ...actions, onQuestion: first }} />
        <ItemView item={{ ...question(), id: "q2" }} actions={{ ...actions, onQuestion: second }} />
      </>,
    );
    key("2");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("q2", {
      kind: "answered",
      replies: [{ picks: ["top"], other: null }],
    });
  });
});

const taskItem = (state: "running" | "completed", run: WorkflowRun | null = null): Item => ({
  id: "k1",
  turnId: "t1",
  kind: {
    kind: "task",
    taskId: "task-7",
    name: "Review the branch",
    taskType: "workflow",
    description: "Review the branch",
    state,
    summary: null,
    lastTool: null,
    usage: null,
    canStop: true,
    callItem: null,
    run,
  },
});

describe("a background task", () => {
  it("shows a workflow's phase and agents, and asks to stop it by its task id", () => {
    const onStopTask = vi.fn(() => Promise.resolve());
    const onOpenTask = vi.fn();
    render(
      <ItemView
        item={taskItem("running", {
          runId: "wf_1",
          phases: [
            { title: "Survey", detail: null },
            { title: "Review", detail: null },
          ],
          agents: [
            {
              id: "a",
              label: "a",
              phase: "Survey",
              state: "done",
              model: null,
              startedAt: null,
              durationMs: null,
              result: null,
            },
            {
              id: "b",
              label: "b",
              phase: "Review",
              state: "running",
              model: null,
              startedAt: null,
              durationMs: null,
              result: null,
            },
          ],
        })}
        actions={{ ...actions, onStopTask, onOpenTask, elapsed: () => 65_000 }}
      />,
    );
    expect(screen.getByText(strings.task.phase(1, 2, "Review"))).toBeTruthy();
    expect(screen.getByText(strings.task.agents(1, 1, 0))).toBeTruthy();
    expect(screen.getByText("1m 5s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.task.details }));
    expect(onOpenTask).toHaveBeenCalledWith("k1");
    fireEvent.click(screen.getByRole("button", { name: strings.task.stop }));
    expect(onStopTask).toHaveBeenCalledWith("task-7");
    expect(screen.getByRole("button", { name: strings.task.stopping })).toBeTruthy();
  });

  it("offers no Stop once it has ended", () => {
    render(<ItemView item={taskItem("completed")} actions={actions} />);
    expect(screen.queryByRole("button", { name: strings.task.stop })).toBeNull();
    expect(screen.getByText(strings.task.state.completed)).toBeTruthy();
  });

  it("lets Stop be pressed again when the request fails", async () => {
    const onStopTask = vi.fn(() => Promise.reject(new Error("no")));
    render(<ItemView item={taskItem("running")} actions={{ ...actions, onStopTask }} />);
    fireEvent.click(screen.getByRole("button", { name: strings.task.stop }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: strings.task.stop })).toBeTruthy(),
    );
  });
});

describe("the agent's advisories and compaction", () => {
  it("draws a notice with its title and description", () => {
    view({
      id: "n1",
      turnId: "t1",
      kind: {
        kind: "notice",
        severity: "warning",
        title: "Rate limited",
        description: "Retrying soon",
      },
    });
    expect(screen.getByText("Rate limited")).toBeTruthy();
    expect(screen.getByText("Retrying soon")).toBeTruthy();
  });

  it("draws compaction as a divider with what was kept folded under it", () => {
    view({
      id: "m1",
      turnId: "t1",
      kind: { kind: "compaction", status: "completed", summary: "Kept the plan", error: null },
    });
    expect(screen.getByText(strings.compaction.completed)).toBeTruthy();
    expect(screen.getByText("Kept the plan")).toBeTruthy();
  });
});

describe("a subagent", () => {
  it("draws its work inside the call that started it", () => {
    const call: Item = {
      id: "c1",
      turnId: "t1",
      kind: {
        kind: "toolCall",
        title: "Survey the code",
        toolKind: "think",
        status: "inProgress",
        output: "",
        truncated: false,
        paths: [],
        diffs: [],
      },
    };
    const inner: Item = { ...reply("found the parser"), id: "n1", parent: "c1" };
    const { container } = render(
      <NestedItems.Provider value={new Map([["c1", [inner]]])}>
        <ItemView item={call} actions={actions} />
      </NestedItems.Provider>,
    );
    const nested = container.querySelector('[data-item="c1"] .at-tool__nested');
    expect(nested?.textContent).toContain("found the parser");
  });
});
