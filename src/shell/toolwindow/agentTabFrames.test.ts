import { describe, expect, it } from "vitest";
import { agentTabFrames, attachFrames, attachRequest } from "./agentTabFrames";

const frame = (id: string, over: { isApp?: boolean; origin?: string | null } = {}) => ({
  id,
  isApp: true,
  origin: "http://app.localhost" as string | null,
  ...over,
});

describe("agentTabFrames", () => {
  it("answers the frame the payload names, at its own origin", () => {
    const frames = new Map([
      ["one", frame("agent-1")],
      ["two", frame("agent-2", { origin: "http://other.localhost" })],
    ]);
    expect(agentTabFrames(frames, { instanceId: "agent-2", harness: "pi" })).toEqual([
      ["two", "http://other.localhost"],
    ]);
  });

  it("skips a frame that has not said hello, and one that is not an app", () => {
    const frames = new Map([
      ["quiet", frame("agent-1", { origin: null })],
      ["tool", frame("agent-1", { isApp: false })],
    ]);
    expect(agentTabFrames(frames, { instanceId: "agent-1" })).toEqual([]);
  });

  it("answers nothing for a payload that names no instance", () => {
    const frames = new Map([["one", frame("agent-1")]]);
    expect(agentTabFrames(frames, null)).toEqual([]);
    expect(agentTabFrames(frames, { harness: "pi" })).toEqual([]);
    expect(agentTabFrames(frames, "agent-1")).toEqual([]);
  });
});

describe("attachFrames", () => {
  const tab = (id: string, over: { appId?: string; origin?: string | null } = {}) => ({
    id,
    appId: "agent-tab",
    isApp: true,
    origin: "http://agent.localhost" as string | null,
    ...over,
  });
  const frames = new Map([
    ["a", tab("agent-1")],
    ["b", tab("agent-2")],
    ["quiet", tab("agent-3", { origin: null })],
    ["canvas", tab("canvas-1", { appId: "canvas" })],
  ]);

  // One chip in one prompt: the same item in every open agent tab would be a
  // message the person has to delete from all but one.
  it("goes to the agent tab last focused when none was chosen, else the first", () => {
    const to = (last?: string | null) =>
      attachFrames(frames, "agent-tab", undefined, last).map(([w]) => w);
    expect(to("agent-2")).toEqual(["b"]);
    expect(to(null)).toEqual(["a"]);
    // Closed since, or never said hello: the first that can take it.
    expect(to("agent-9")).toEqual(["a"]);
    expect(to("agent-3")).toEqual(["a"]);
    expect(attachFrames(new Map(), "agent-tab", undefined, "agent-2")).toEqual([]);
  });

  it("goes to the chosen tab alone, and to none when it has closed", () => {
    expect(attachFrames(frames, "agent-tab", "agent-2", "agent-1")).toEqual([
      ["b", "http://agent.localhost"],
    ]);
    expect(attachFrames(frames, "agent-tab", "agent-9", "agent-1")).toEqual([]);
    expect(attachFrames(frames, "agent-tab", "canvas-1")).toEqual([]);
  });
});

describe("attachRequest", () => {
  it("keeps the chip's label and the tab chosen, and drops words meant for the prompt", () => {
    expect(
      attachRequest({
        contextId: "ctx_1",
        label: "Take 1 feedback",
        instanceId: "agent-2",
        before: "Read ",
        after: " first.",
      }),
    ).toEqual({
      payload: { contextId: "ctx_1", label: "Take 1 feedback" },
      instanceId: "agent-2",
    });
  });

  it("passes on the kind of chip an app asks for, as its glyph and colour", () => {
    expect(
      attachRequest({ contextId: "ctx_1", label: "Godot · Enemy", kind: "godot-node" }),
    ).toEqual({ payload: { contextId: "ctx_1", label: "Godot · Enemy", kind: "godot-node" } });
  });

  it("labels an item by its id, drops what is not a string, and refuses no id", () => {
    expect(attachRequest({ contextId: "ctx_1", label: 3, instanceId: 4, before: null })).toEqual({
      payload: { contextId: "ctx_1", label: "ctx_1" },
    });
    expect(attachRequest({ contextId: "ctx_1", kind: 5 })?.payload).toEqual({
      contextId: "ctx_1",
      label: "ctx_1",
    });
    expect(attachRequest({ label: "x" })).toBeNull();
    expect(attachRequest(null)).toBeNull();
  });
});
