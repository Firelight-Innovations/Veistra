import { describe, expect, it, vi } from "vitest";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn() }));

import { invoke } from "@veistra/bridge";
import { contextKey, handToAgent, listAgents, type AgentTarget } from "./context";

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

describe("handToAgent", () => {
  const around = { before: "Playtest feedback: 2 notes. Read ", after: " first." };
  const mocked = vi.mocked(invoke);

  it("types at the chosen terminal, and only there", async () => {
    mocked.mockReset().mockResolvedValue({ inserted: true });
    const to: AgentTarget = { kind: "terminal", id: "t2", label: "Claude Code · Terminal 2" };
    expect(await handToAgent(to, "ctx_1", "p/packet.md", around)).toEqual({ delivered: true });
    expect(mocked.mock.calls).toEqual([
      ["context/insert", { itemIds: ["ctx_1"], terminal: "t2", ...around }],
    ]);
  });

  it("chips the chosen agent tab, and only that one", async () => {
    mocked.mockReset().mockResolvedValue({ delivered: 1 });
    const to: AgentTarget = { kind: "agentTab", id: "agent-3", label: "Agent tab · Chat" };
    expect(await handToAgent(to, "ctx_1", "p/packet.md", around)).toEqual({ delivered: true });
    expect(mocked.mock.calls).toEqual([
      [
        "veistra/attach-to-agent",
        { contextId: "ctx_1", label: "p/packet.md", instanceId: "agent-3", ...around },
      ],
    ]);
  });

  it("says why when the agent chosen did not take it", async () => {
    mocked
      .mockReset()
      .mockResolvedValue({ inserted: false, reason: "the terminal you chose is gone" });
    const term: AgentTarget = { kind: "terminal", id: "t2", label: "t" };
    expect(await handToAgent(term, "c", "l", around)).toEqual({
      delivered: false,
      reason: "the terminal you chose is gone",
    });
    mocked.mockReset().mockResolvedValue({ delivered: 0 });
    const tab: AgentTarget = { kind: "agentTab", id: "gone", label: "t" };
    expect(await handToAgent(tab, "c", "l", around)).toEqual({
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
