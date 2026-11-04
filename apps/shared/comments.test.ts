// @vitest-environment jsdom
//
// `comments.ts` imports `@veistra/bridge`, which builds its singleton
// client against the real `window` at module load time (see
// `packages/bridge/src/index.ts`) — so importing it at all, even just for
// `anchorLabel`/`formatPlayTime` below, needs a DOM to exist. See
// `vitest.config.ts`'s note on why this is a per-file docblock rather than a
// DOM for the whole config.
import { describe, expect, it } from "vitest";
import {
  anchorLabel,
  formatPlayTime,
  isActive,
  statusView,
  takeHistory,
  type Anchor,
  type Comment,
} from "./comments";

describe("formatPlayTime", () => {
  it("pads minutes and seconds to the board's mm:ss.s shape", () => {
    expect(formatPlayTime(42.8)).toBe("00:42.8");
  });

  it("carries minutes past sixty seconds", () => {
    expect(formatPlayTime(125.3)).toBe("02:05.3");
  });

  it("clamps a negative playhead to zero rather than printing a minus sign", () => {
    expect(formatPlayTime(-4)).toBe("00:00.0");
  });

  it("floors at zero seconds exactly", () => {
    expect(formatPlayTime(0)).toBe("00:00.0");
  });
});

describe("anchorLabel", () => {
  it("labels a node anchor with its scene-tree path", () => {
    const anchor: Anchor = { kind: "node", path: "Player/Flashlight" };
    expect(anchorLabel(anchor)).toBe("Node · Player/Flashlight");
  });

  it("labels a mesh anchor with its part and material", () => {
    const anchor: Anchor = { kind: "mesh", part: "headboard", material: "oak" };
    expect(anchorLabel(anchor)).toBe("headboard · oak");
  });

  it("labels a scene anchor with the playhead time and the scene name", () => {
    const anchor: Anchor = { kind: "scene", scene: "hospital_wing", time: 42.8, screenshot: true };
    expect(anchorLabel(anchor)).toBe("Play · 00:42.8 · hospital_wing");
  });

  it("drops the scene name when the anchor carries none", () => {
    const anchor: Anchor = { kind: "scene", scene: "", time: 5, screenshot: false };
    expect(anchorLabel(anchor)).toBe("Play · 00:05.0");
  });
});

describe("take notes", () => {
  it("label a take anchor with its number, time and object", () => {
    const anchor: Anchor = {
      kind: "take",
      take: "2026-10-30-1402-0f3a",
      n: 2,
      atMs: 102_180,
      packet: ".veistra/feedback/2026-10-30-1402-0f3a-1",
      nodePath: "Hallway/Enemy_02",
    };
    expect(anchorLabel(anchor)).toBe("Note 2 · 01:42.2 · Hallway/Enemy_02");
  });

  it("read each status in the board's words", () => {
    expect(statusView("open").label).toBe("Sent");
    expect(statusView("working")).toEqual({ label: "Agent working", tone: "warning" });
    expect(statusView("fixed").label).toBe("Fixed, check it");
    expect(statusView("resolved").tone).toBe("success");
  });

  it("count open and working as the agent's work, not fixed", () => {
    expect([
      isActive("open"),
      isActive("working"),
      isActive("fixed"),
      isActive("resolved"),
    ]).toEqual([true, true, false, false]);
  });

  it("list a Still broken note's takes oldest first, the first from its anchor", () => {
    const comment: Comment = {
      id: "cmt-1",
      anchor: {
        kind: "take",
        take: "2026-10-30-1402-0f3a",
        number: 4,
        n: 2,
        atMs: 102_000,
        packet: ".veistra/feedback/2026-10-30-1402-0f3a-1",
      },
      author: "user",
      body: "walks into the wall",
      status: "open",
      replies: [
        { by: "agent", body: "rebaked the nav mesh", at: 1 },
        {
          by: "user",
          body: "still clips at the corner",
          at: 2,
          take: {
            take: "2026-10-30-1440-9b1c",
            number: 5,
            packet: ".veistra/feedback/2026-10-30-1440-9b1c-1",
            n: 1,
            atMs: 12_000,
          },
        },
      ],
      created: 0,
      updated: 2,
    };
    expect(takeHistory(comment).map((t) => [t.number, t.n, t.atMs])).toEqual([
      [4, 2, 102_000],
      [5, 1, 12_000],
    ]);
    expect(takeHistory({ ...comment, anchor: { kind: "node", path: "World" } })).toEqual([]);
  });
});
