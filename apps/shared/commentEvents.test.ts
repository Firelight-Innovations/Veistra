// @vitest-environment jsdom
/**
 * The pushed comment change every comment-listing pane subscribes to: read
 * defensively, gathered over a burst, and dropped cleanly on unsubscribe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@veistra/bridge", () => ({
  on: (event: string, cb: (payload: unknown) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  },
}));

import {
  COALESCE_MS,
  COMMENTS_CHANGED,
  onCommentsChanged,
  readChange,
  useCommentsChanged,
} from "./commentEvents";

const push = (payload: unknown) => handlers.get(COMMENTS_CHANGED)?.(payload);
const fixed = { id: "a", kind: "take", take: "t1", status: "fixed", from: "working" };

beforeEach(() => {
  handlers.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("readChange", () => {
  it("reads the payload Rust sends", () => {
    expect(readChange({ ...fixed, clusterId: "c1", clusters: ["c1"] })).toEqual({
      id: "a",
      kind: "take",
      take: "t1",
      status: "fixed",
      from: "working",
    });
    expect(readChange({ id: "b", kind: "node", take: null, status: "open", from: null })).toEqual({
      id: "b",
      kind: "node",
      take: null,
      status: "open",
      from: null,
    });
  });

  it("refuses what it cannot read", () => {
    expect(readChange(null)).toBeNull();
    expect(readChange({ id: "a", status: "closed" })).toBeNull();
    expect(readChange({ status: "open" })).toBeNull();
  });
});

describe("onCommentsChanged", () => {
  it("answers a burst of changes once, after the first waits", () => {
    const cb = vi.fn();
    onCommentsChanged(cb);
    push(fixed);
    push({ ...fixed, id: "b" });
    push("not a change");
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].map((c: { id: string }) => c.id)).toEqual(["a", "b"]);

    push(fixed);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("drops a waiting burst and stops listening when unsubscribed", () => {
    const cb = vi.fn();
    const stop = onCommentsChanged(cb);
    push(fixed);
    stop();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(cb).not.toHaveBeenCalled();
    expect(handlers.has(COMMENTS_CHANGED)).toBe(false);
  });
});

describe("useCommentsChanged", () => {
  it("calls the latest refresh, on one subscription, until unmounted", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ refresh }) => useCommentsChanged(refresh), {
      initialProps: { refresh: first },
    });
    const subscribed = handlers.get(COMMENTS_CHANGED);
    rerender({ refresh: second });
    expect(handlers.get(COMMENTS_CHANGED)).toBe(subscribed);

    push(fixed);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
    expect(handlers.has(COMMENTS_CHANGED)).toBe(false);
  });
});
