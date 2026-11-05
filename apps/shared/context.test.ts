import { describe, expect, it, vi } from "vitest";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn() }));

import { invoke } from "@veistra/bridge";
import {
  attachedPrompt,
  chipLabel,
  chipToAgent,
  contextKey,
  handToAgent,
  listAgents,
  putWithAttached,
  type AgentTarget,
} from "./context";

describe("contextKey", () => {
  it("joins the parts of a source with slashes", () => {
    expect(contextKey("blender", "art/crate", "three-quarter")).toBe(
      "blender/art/crate/three-quarter",
    );
  });

  it("drops a scheme, backslashes, edge slashes and empty parts", () => {
    expect(contextKey("godot", "res://levels/main.tscn", "frame")).toBe(
      "godot/levels/main.tscn/frame",
    );
    expect(contextKey("file", "src\\a.ts:1-4", null, undefined, "")).toBe("file/src/a.ts:1-4");
    expect(contextKey("play", "/scene/", "log")).toBe("play/scene/log");
  });

  it("is the same for the same source every time", () => {
    expect(contextKey("godot", "res://m.tscn", "tree")).toBe(
      contextKey("godot", "res://m.tscn", "tree"),
    );
  });
});

describe("chipLabel", () => {
  it("is the strip's label, else the title, else a word", () => {
    expect(chipLabel({ id: "c", title: "t", source: { label: "Play - game output" } })).toBe(
      "Play - game output",
    );
    expect(chipLabel({ id: "c", title: "Spec - door", source: { label: null } })).toBe(
      "Spec - door",
    );
    expect(chipLabel({ id: "c" })).toBe("Context");
  });
});

describe("chipToAgent", () => {
  const mocked = vi.mocked(invoke);
  const item = { id: "ctx_1", title: "Play - output", source: { label: "Play - game output" } };

  it("chips the agent tab the shell picks, and types nothing anywhere", async () => {
    mocked.mockReset().mockResolvedValue({ delivered: 1 });
    expect(await chipToAgent(item)).toEqual({ delivered: true });
    expect(mocked.mock.calls).toEqual([
      ["veistra/attach-to-agent", { contextId: "ctx_1", label: "Play - game output" }],
    ]);
  });

  it("falls back to the agent terminal's prompt when no agent tab is open", async () => {
    mocked.mockReset().mockResolvedValueOnce({ delivered: 0 }).mockResolvedValueOnce({
      inserted: true,
    });
    expect(await chipToAgent(item)).toEqual({ delivered: true });
    expect(mocked.mock.calls[1]).toEqual(["context/insert", { itemIds: ["ctx_1"] }]);

    mocked.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({
      inserted: false,
      reason: "no agent is running in this environment's terminals",
    });
    expect(await chipToAgent(item)).toEqual({
      delivered: false,
      reason: "no agent is running in this environment's terminals",
    });
  });
});

describe("putWithAttached", () => {
  const mocked = vi.mocked(invoke);
  const picture = { id: "ctx_pic", path: "C:\\env\\.veistra\\context\\view.png" };

  it("names each attached item's file in the prompt the chip carries", async () => {
    mocked.mockReset().mockResolvedValueOnce({ id: "ctx_sel" });
    const item = await putWithAttached({ kind: "text", text: "Enemy", prompt: "The nodes." }, [
      { item: picture, what: "the editor's viewport" },
    ]);
    expect(mocked.mock.calls).toEqual([
      [
        "context/put",
        {
          kind: "text",
          text: "Enemy",
          prompt: `The nodes. The editor's viewport is at ${picture.path}; open it.`,
        },
      ],
    ]);
    expect(item).toEqual({ id: "ctx_sel", attached: [picture] });
  });

  it("names an item with no file by its context reference", () => {
    expect(attachedPrompt("Look.", [{ item: { id: "ctx_9" }, what: "the notes" }])).toBe(
      "Look. The notes is at veistra://context/ctx_9; open it.",
    );
    expect(attachedPrompt("Look.", [])).toBe("Look.");
  });

  it("makes one chip, and types every reference at a terminal, which cannot read the prompt", async () => {
    const item = { id: "ctx_sel", attached: [picture] };
    mocked.mockReset().mockResolvedValue({ delivered: 1 });
    await chipToAgent(item);
    expect(mocked.mock.calls).toEqual([
      ["veistra/attach-to-agent", { contextId: "ctx_sel", label: "Context" }],
    ]);
    mocked.mockReset().mockResolvedValueOnce({ delivered: 0 }).mockResolvedValueOnce({
      inserted: true,
    });
    expect(await chipToAgent(item)).toEqual({ delivered: true });
    expect(mocked.mock.calls[1]).toEqual(["context/insert", { itemIds: ["ctx_sel", "ctx_pic"] }]);
  });
});

describe("handToAgent", () => {
  const mocked = vi.mocked(invoke);

  it("types at the chosen terminal, and only there, with no words around it", async () => {
    mocked.mockReset().mockResolvedValue({ inserted: true });
    const to: AgentTarget = { kind: "terminal", id: "t2", label: "Claude Code · Terminal 2" };
    expect(await handToAgent(to, "ctx_1", "Take 1 feedback")).toEqual({ delivered: true });
    expect(mocked.mock.calls).toEqual([["context/insert", { itemIds: ["ctx_1"], terminal: "t2" }]]);
  });

  it("chips the chosen agent tab, and only that one", async () => {
    mocked.mockReset().mockResolvedValue({ delivered: 1 });
    const to: AgentTarget = { kind: "agentTab", id: "agent-3", label: "Agent tab · Chat" };
    expect(await handToAgent(to, "ctx_1", "Take 1 feedback")).toEqual({ delivered: true });
    expect(mocked.mock.calls).toEqual([
      [
        "veistra/attach-to-agent",
        { contextId: "ctx_1", label: "Take 1 feedback", instanceId: "agent-3" },
      ],
    ]);
  });

  it("says why when the agent chosen did not take it", async () => {
    mocked
      .mockReset()
      .mockResolvedValue({ inserted: false, reason: "the terminal you chose is gone" });
    const term: AgentTarget = { kind: "terminal", id: "t2", label: "t" };
    expect(await handToAgent(term, "c", "l")).toEqual({
      delivered: false,
      reason: "the terminal you chose is gone",
    });
    mocked.mockReset().mockResolvedValue({ delivered: 0 });
    const tab: AgentTarget = { kind: "agentTab", id: "gone", label: "t" };
    expect(await handToAgent(tab, "c", "l")).toEqual({
      delivered: false,
      reason: "that agent tab is no longer open",
    });
  });

  it("lists the agents the host answers, none when it has none", async () => {
    const agents: AgentTarget[] = [{ kind: "terminal", id: "t1", label: "Codex · Terminal 1" }];
    mocked.mockReset().mockResolvedValueOnce({ agents }).mockResolvedValueOnce({});
    expect(await listAgents()).toEqual(agents);
    expect(await listAgents()).toEqual([]);
    expect(mocked).toHaveBeenCalledWith("context/agents");
  });
});
