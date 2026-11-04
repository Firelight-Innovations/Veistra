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

  it("goes to every agent tab that has said hello when none was chosen", () => {
    expect(attachFrames(frames, "agent-tab").map(([w]) => w)).toEqual(["a", "b"]);
  });

  it("goes to the chosen tab alone, and to none when it has closed", () => {
    expect(attachFrames(frames, "agent-tab", "agent-2")).toEqual([["b", "http://agent.localhost"]]);
    expect(attachFrames(frames, "agent-tab", "agent-9")).toEqual([]);
    expect(attachFrames(frames, "agent-tab", "canvas-1")).toEqual([]);
  });
});

describe("attachRequest", () => {
  it("keeps the words around the chip and the tab chosen", () => {
    expect(
      attachRequest({
        contextId: "ctx_1",
        label: "p/packet.md",
        instanceId: "agent-2",
        before: "Read ",
        after: " first.",
      }),
    ).toEqual({
      payload: { contextId: "ctx_1", label: "p/packet.md", before: "Read ", after: " first." },
      instanceId: "agent-2",
    });
  });

  it("labels an item by its id, drops what is not a string, and refuses no id", () => {
    expect(attachRequest({ contextId: "ctx_1", label: 3, instanceId: 4, before: null })).toEqual({
      payload: { contextId: "ctx_1", label: "ctx_1" },
    });
    expect(attachRequest({ label: "x" })).toBeNull();
    expect(attachRequest(null)).toBeNull();
  });
});
