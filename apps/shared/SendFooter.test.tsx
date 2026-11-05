// @vitest-environment jsdom
/** The shared send footer: what the buttons show, what they call, and how a failure reads. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn() }));

import { invoke } from "@veistra/bridge";
import { SendButton, SendFooter, useSendAction } from "./SendFooter";
import { CommentPanel } from "./CommentPanel";

afterEach(cleanup);

describe("SendButton", () => {
  it("calls its handler on click", () => {
    const onClick = vi.fn();
    render(<SendButton label="Send log" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Send log" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("says Sent in place of its label", () => {
    render(<SendButton label="Send log" sent />);
    expect(screen.getByRole("button", { name: "Sent" })).toBeTruthy();
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<SendButton label="Send log" disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Send log" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps its name for assistive tech when compact, and moves the label to the tooltip", () => {
    render(<SendButton label="Send parts" compact title="Add the parts list." />);
    const button = screen.getByRole("button", { name: "Send parts" });
    expect(button.getAttribute("title")).toBe("Send parts. Add the parts list.");
    expect(button.textContent).toBe("");
  });

  it("hands pointer-down to a drag source", () => {
    const onPointerDown = vi.fn();
    render(<SendButton label="Send tree" onPointerDown={onPointerDown} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Send tree" }));
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });
});

describe("SendFooter", () => {
  it("puts the sends first and the trailing controls after them", () => {
    const { container } = render(
      <SendFooter trailing={<button type="button">Open in Godot</button>}>
        <SendButton label="Send tree" />
        <SendButton label="Send frame" />
      </SendFooter>,
    );
    const names = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(names).toEqual(["Send tree", "Send frame", "Open in Godot"]);
    expect(container.querySelector(".k-send-footer__actions")?.children.length).toBe(2);
  });

  it("has no trailing group when there is nothing trailing", () => {
    const { container } = render(
      <SendFooter>
        <SendButton label="Send file" />
      </SendFooter>,
    );
    expect(container.querySelector(".k-send-footer__trailing")).toBeNull();
  });
});

describe("useSendAction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flashes Sent for the button that sent, then clears it", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useSendAction(onError, String));
    await act(async () => {
      await result.current.send("log", "log", () => Promise.resolve());
    });
    expect(result.current.sent).toBe("log");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.sent).toBeNull();
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("reports a failure in the shared sentence and does not flash Sent", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useSendAction(onError, (e) => `boom ${String(e)}`));
    await act(async () => {
      await result.current.send("tree", "the scene tree", () => Promise.reject("x"));
    });
    expect(result.current.sent).toBeNull();
    expect(onError).toHaveBeenLastCalledWith("Couldn't send the scene tree to the agent: boom x");
  });

  it("puts each item it stored on the agent's prompt as a chip, and nothing else", async () => {
    const mocked = vi.mocked(invoke).mockReset().mockResolvedValue({ delivered: 1 });
    const { result } = renderHook(() => useSendAction(vi.fn(), String));
    const log = { id: "ctx_log", title: "Play - output", source: { label: "Play - game output" } };
    await act(async () => {
      await result.current.send("log", "the log", () => Promise.resolve(log));
    });
    expect(mocked.mock.calls).toEqual([
      ["veistra/attach-to-agent", { contextId: "ctx_log", label: "Play - game output" }],
    ]);
    expect(result.current.sent).toBe("log");
  });

  it("says so rather than flashing Sent when no agent took it", async () => {
    vi.mocked(invoke)
      .mockReset()
      .mockResolvedValueOnce({ delivered: 0 })
      .mockResolvedValueOnce({ inserted: false, reason: "no agent is running here" });
    const onError = vi.fn();
    const { result } = renderHook(() => useSendAction(onError, String));
    await act(async () => {
      await result.current.send("log", "the log", () => Promise.resolve({ id: "ctx_log" }));
    });
    expect(result.current.sent).toBeNull();
    expect(onError).toHaveBeenLastCalledWith(
      "The log is in the Context strip, but no agent took it: no agent is running here.",
    );
  });
});

describe("CommentPanel", () => {
  it("keeps Send to agent now in the shared footer, disabled while nothing reads comments", () => {
    const { container } = render(
      <CommentPanel
        comments={[]}
        loading={false}
        error={null}
        onResolve={vi.fn()}
        emptyHint="none"
      />,
    );
    const button = screen.getByRole("button", { name: "Send to agent now" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
  });
});
