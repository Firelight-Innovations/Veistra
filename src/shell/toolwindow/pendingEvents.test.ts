import { describe, expect, it } from "vitest";
import { PendingEvents } from "./pendingEvents";

const RECT = "veistra/window-rect";
const OPENED = "veistra:opened";

describe("PendingEvents", () => {
  it("keeps both of Play's first two events, in the order they were sent", () => {
    // `answerOpen` queues the scene, then the window-rect effect queues the
    // pane's rect, both before Play's frame has said hello.
    const pending = new PendingEvents([RECT]);
    pending.add("play-1", OPENED, { scene: "res://main.tscn" });
    pending.add("play-1", RECT, { x: 0, y: 40, width: 800, height: 600 });
    expect(pending.takeReady(new Set(["play-1"]))).toEqual([
      [
        "play-1",
        [
          { event: OPENED, payload: { scene: "res://main.tscn" } },
          { event: RECT, payload: { x: 0, y: 40, width: 800, height: 600 } },
        ],
      ],
    ]);
  });

  it("keeps every app event, since the shell cannot tell one supersedes another", () => {
    const pending = new PendingEvents([RECT]);
    pending.add("viewer-1", OPENED, { path: "a.md" });
    pending.add("viewer-1", OPENED, { path: "b.md" });
    expect(pending.take("viewer-1").map((p) => p.payload)).toEqual([
      { path: "a.md" },
      { path: "b.md" },
    ]);
  });

  it("keeps only the newest window rect, moved to where it was sent", () => {
    const pending = new PendingEvents([RECT]);
    pending.add("play-1", RECT, { width: 100 });
    pending.add("play-1", OPENED, { scene: "res://a.tscn" });
    pending.add("play-1", RECT, { width: 200 });
    pending.add("play-1", RECT, { width: 300 });
    expect(pending.take("play-1")).toEqual([
      { event: OPENED, payload: { scene: "res://a.tscn" } },
      { event: RECT, payload: { width: 300 } },
    ]);
  });

  it("leaves the frames that are not ready, and forgets what it has handed over", () => {
    const pending = new PendingEvents();
    pending.add("a", OPENED, 1);
    pending.add("b", OPENED, 2);
    expect(pending.takeReady(new Set(["b"]))).toEqual([["b", [{ event: OPENED, payload: 2 }]]]);
    expect(pending.takeReady(new Set(["b"]))).toEqual([]);
    expect(pending.take("a")).toEqual([{ event: OPENED, payload: 1 }]);
    expect(pending.take("a")).toEqual([]);
  });
});
