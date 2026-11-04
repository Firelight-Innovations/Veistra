import { afterEach, describe, expect, it, vi } from "vitest";

const heard = vi.hoisted(() => ({
  cb: null as ((payload: unknown) => void) | null,
  stop: vi.fn(),
}));

vi.mock("../../bindings", () => ({
  COMMENTS_CHANGED_EVENT: "comments:changed",
  onCommentsChanged: (cb: (payload: unknown) => void) => {
    heard.cb = cb;
    return Promise.resolve(heard.stop);
  },
}));

import { commentFrames, commentsChangeConcerns, relayCommentChanges } from "./commentFrames";

const frame = (over: { isApp?: boolean; origin?: string | null } = {}) => ({
  isApp: true,
  origin: "http://app.localhost" as string | null,
  ...over,
});

const change = { clusterId: "c1", clusters: ["c1", "c3"], id: "x", status: "fixed" };

afterEach(() => {
  heard.cb = null;
  heard.stop.mockReset();
});

describe("commentsChangeConcerns", () => {
  it("is about every cluster on the environment the payload names", () => {
    expect(commentsChangeConcerns(change, "c1")).toBe(true);
    expect(commentsChangeConcerns(change, "c3")).toBe(true);
    expect(commentsChangeConcerns(change, "c2")).toBe(false);
  });

  it("falls back to the calling cluster, and drops anything else", () => {
    expect(commentsChangeConcerns({ clusterId: "c1" }, "c1")).toBe(true);
    expect(commentsChangeConcerns(change, null)).toBe(false);
    expect(commentsChangeConcerns(null, "c1")).toBe(false);
    expect(commentsChangeConcerns("c1", "c1")).toBe(false);
  });
});

describe("commentFrames", () => {
  it("answers every app frame that has said hello, at its own origin", () => {
    const frames = new Map([
      ["play", frame()],
      ["blender", frame({ origin: "http://other.localhost" })],
      ["quiet", frame({ origin: null })],
      ["tool", frame({ isApp: false })],
    ]);
    expect(commentFrames(frames, change, "c3")).toEqual([
      ["play", "http://app.localhost"],
      ["blender", "http://other.localhost"],
    ]);
    expect(commentFrames(frames, change, "c2")).toEqual([]);
  });
});

describe("relayCommentChanges", () => {
  it("posts the change to the frames of the shown cluster, read at delivery", async () => {
    const win = { postMessage: vi.fn() } as unknown as Window;
    let showing: string | null = "c2";
    const stop = relayCommentChanges(
      () => new Map([[win, frame()]]),
      () => showing,
    );
    await Promise.resolve();
    heard.cb?.(change);
    expect(win.postMessage).not.toHaveBeenCalled();

    showing = "c1";
    heard.cb?.(change);
    expect(win.postMessage).toHaveBeenCalledWith(
      { veistra: 1, kind: "event", event: "comments:changed", payload: change },
      "http://app.localhost",
    );
    stop();
    expect(heard.stop).toHaveBeenCalled();
  });

  it("unlistens even when stopped before Tauri answered", async () => {
    const stop = relayCommentChanges(
      () => [],
      () => "c1",
    );
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(heard.stop).toHaveBeenCalled();
  });
});
