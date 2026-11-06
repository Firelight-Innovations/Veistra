/**
 * The agent end to end: a real `veistra-agent` process on stdio, Pi included, with only the model
 * scripted. Each test plays the host's side of ACP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Client, scratch } from "./client.js";

const clients: Client[] = [];
function client(...args: ConstructorParameters<typeof Client>): Client {
  const c = new Client(...args);
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

function worktree(): string {
  const dir = scratch("veistra-worktree-");
  mkdirSync(path.join(dir, ".git"));
  writeFileSync(path.join(dir, "README.md"), "# Game\n");
  return dir;
}

const WRITE_HELLO = [
  [{ text: "Writing it." }, { tool: "write", args: { path: "hello.txt", content: "hi\n" } }],
  [{ text: "Done." }],
];

describe("veistra-agent", () => {
  it("answers initialize with what the host reads", async () => {
    const c = client([]);
    const init = await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo).toMatchObject({ name: "veistra-agent", title: "Veistra" });
    expect(init.agentCapabilities).toMatchObject({
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true },
    });
  });

  it("opens a session ask-first, with its models and modes", async () => {
    const c = client([]);
    await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await c.request("session/new", { cwd: worktree(), mcpServers: [] });
    const modes = created.modes as { currentModeId: string; availableModes: { id: string }[] };
    expect(modes.currentModeId).toBe("default");
    expect(modes.availableModes.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan"]);
    const options = created.configOptions as {
      id: string;
      category: string;
      options: { value: string }[];
    }[];
    const model = options.find((o) => o.category === "model")!;
    expect(model.options.map((o) => o.value)).toContain("scripted/scripted-1");
  });

  it("refuses session/new as signed out when no provider has a key", async () => {
    const c = client(null);
    await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await expect(
      c.request("session/new", { cwd: worktree(), mcpServers: [] }),
    ).rejects.toMatchObject({
      code: -32000,
    });
  });

  it("streams text and asks before an edit, which runs once allowed", async () => {
    const c = client(WRITE_HELLO);
    const tree = worktree();
    const sessionId = await c.open(tree);
    const done = await c.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "write hello.txt" }],
    });
    expect(done.stopReason).toBe("end_turn");
    expect(c.text()).toBe("Writing it.Done.");
    expect(c.permissions).toHaveLength(1);
    const asked = c.permissions[0]!.toolCall as Record<string, unknown>;
    expect(asked).toMatchObject({ kind: "edit", title: "Write hello.txt" });
    expect(asked.rawInput).toMatchObject({ path: path.join(tree, "hello.txt") });
    expect(asked.content).toEqual([
      { type: "diff", path: path.join(tree, "hello.txt"), oldText: null, newText: "hi\n" },
    ]);
    expect(readFileSync(path.join(tree, "hello.txt"), "utf8")).toBe("hi\n");
    const finished = c.lastFor(asked.toolCallId as string)!;
    expect(finished.status).toBe("completed");
  });

  it("leaves the file alone and ends the turn when the user rejects", async () => {
    const c = client([...WRITE_HELLO, [{ text: "never sent" }]]);
    c.answer = "reject";
    const tree = worktree();
    const sessionId = await c.open(tree);
    await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(existsSync(path.join(tree, "hello.txt"))).toBe(false);
    const call = c.updates.find((u) => u.sessionUpdate === "tool_call")!;
    expect(c.lastFor(call.toolCallId as string)!.status).toBe("failed");
  });

  it("edits without asking in Accept edits, and refuses edits in Plan", async () => {
    const accept = client(WRITE_HELLO);
    const tree = worktree();
    const id = await accept.open(tree);
    await accept.request("session/set_mode", { sessionId: id, modeId: "acceptEdits" });
    await accept.request("session/prompt", {
      sessionId: id,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(accept.permissions).toHaveLength(0);
    expect(existsSync(path.join(tree, "hello.txt"))).toBe(true);

    const plan = client(WRITE_HELLO);
    const other = worktree();
    const planned = await plan.open(other);
    await plan.request("session/set_mode", { sessionId: planned, modeId: "plan" });
    await plan.request("session/prompt", {
      sessionId: planned,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(plan.permissions).toHaveLength(0);
    expect(existsSync(path.join(other, "hello.txt"))).toBe(false);
    expect(plan.updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    );
  });

  it("refuses a path outside the worktree without asking, in every mode", async () => {
    const tree = worktree();
    writeFileSync(path.join(path.dirname(tree), "secret.txt"), "no");
    const c = client([
      [{ tool: "read", args: { path: "../secret.txt" } }],
      [{ tool: "write", args: { path: "../escape.txt", content: "x" } }],
      [{ text: "ok" }],
    ]);
    const sessionId = await c.open(tree);
    await c.request("session/set_mode", { sessionId, modeId: "acceptEdits" });
    await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(c.permissions).toHaveLength(0);
    expect(existsSync(path.join(path.dirname(tree), "escape.txt"))).toBe(false);
    const failed = c.updates.filter(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "failed",
    );
    expect(failed).toHaveLength(2);
    expect(JSON.stringify(failed)).toContain("outside the worktree");
  });

  it("reads a file inside the worktree without asking", async () => {
    const c = client([
      [{ tool: "read", args: { path: "README.md" } }],
      [{ text: "It is a game." }],
    ]);
    const sessionId = await c.open(worktree());
    await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read" }] });
    expect(c.permissions).toHaveLength(0);
    const call = c.updates.find((u) => u.sessionUpdate === "tool_call")!;
    expect(call).toMatchObject({ kind: "read", title: "Read README.md" });
    expect(JSON.stringify(c.lastFor(call.toolCallId as string))).toContain("# Game");
  });

  it("ends a turn stopped while it waits on the user as cancelled, having run nothing", async () => {
    const c = client([[{ tool: "bash", args: { command: "touch ran.txt" } }], [{ text: "never" }]]);
    c.answer = "hold";
    const tree = worktree();
    const sessionId = await c.open(tree);
    const turn = c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    await expect.poll(() => c.permissions.length).toBe(1);
    c.notify("session/cancel", { sessionId });
    c.release();
    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
    expect(existsSync(path.join(tree, "ran.txt"))).toBe(false);
    expect(c.text()).toBe("");
  });

  it("asks before a command, with where it runs", async () => {
    const c = client([[{ tool: "bash", args: { command: "echo hi" } }], [{ text: "ran" }]]);
    c.answer = "reject";
    const tree = worktree();
    const sessionId = await c.open(tree);
    await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run" }] });
    expect(c.permissions).toHaveLength(1);
    const asked = c.permissions[0]!.toolCall as Record<string, unknown>;
    expect(asked).toMatchObject({ kind: "execute", title: "echo hi" });
    expect(asked.rawInput).toMatchObject({ command: "echo hi", cwd: tree });
  });

  it("gives the model a chip's hidden context, the user's words and what the chips name", async () => {
    const c = client(["echo"]);
    const sessionId = await c.open(worktree());
    const done = await c.request("session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "Context the transcript does not show." },
        { type: "text", text: "what is [@cube](<veistra://canvas/1>)?" },
        { type: "resource", resource: { uri: "veistra://canvas/1", text: "a red cube" } },
        { type: "resource_link", uri: "veistra://file/a.gd", name: "a.gd" },
      ],
    });
    expect(done.stopReason).toBe("end_turn");
    const seen = c.text();
    expect(seen).toContain("Context the transcript does not show.");
    expect(seen).toContain("what is [@cube](<veistra://canvas/1>)?");
    expect(seen).toContain('<context uri="veistra://canvas/1">\na red cube\n</context>');
    expect(seen).toContain("[a.gd](veistra://file/a.gd)");
  });

  it("offers its skills as commands and expands one invoked by name", async () => {
    const skills = scratch("veistra-skills-");
    mkdirSync(path.join(skills, "canvas-ready"));
    writeFileSync(
      path.join(skills, "canvas-ready", "SKILL.md"),
      "---\nname: canvas-ready\ndescription: Make the canvas ready for agents.\n---\n\nALWAYS-NUMBER-THE-FRAMES\n",
    );
    const c = client(["echo", "echo"]);
    const sessionId = await c.open(worktree(), { _meta: { veistra: { skills: [skills] } } });
    await expect
      .poll(() => c.updates.find((u) => u.sessionUpdate === "available_commands_update"))
      .toBeTruthy();
    const offered = c.updates.find((u) => u.sessionUpdate === "available_commands_update")!;
    expect(offered.availableCommands).toContainEqual(
      expect.objectContaining({
        name: "skill:canvas-ready",
        description: "Make the canvas ready for agents.",
      }),
    );
    await c.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/skill:canvas-ready tidy frame 2" }],
    });
    expect(c.text()).toContain("ALWAYS-NUMBER-THE-FRAMES");
    expect(c.text()).toContain("tidy frame 2");
    // Any other leading slash is the user's own text, sent as written.
    const before = c.text().length;
    await c.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/mcp is that a path?" }],
    });
    expect(c.text().slice(before)).toBe("/mcp is that a path?");
  });

  it("switches model and thinking level through config options", async () => {
    const c = client([]);
    const sessionId = await c.open(worktree());
    const answer = await c.request("session/set_config_option", {
      sessionId,
      configId: "thinking",
      value: "high",
    });
    const options = answer.configOptions as { id: string; currentValue: string }[];
    expect(options.find((o) => o.id === "thinking")!.currentValue).toBe("high");
    expect(options.find((o) => o.id === "model")!.currentValue).toBe("scripted/scripted-1");
    await expect(
      c.request("session/set_config_option", { sessionId, configId: "model", value: "nope/none" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
