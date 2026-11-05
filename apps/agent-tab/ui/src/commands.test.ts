import { describe, expect, it } from "vitest";
import { commandSupport, completion, isLogin, matching, offered, skillCommands } from "./commands";
import type { AgentCommand } from "./protocol.generated";

const cmd = (name: string, hint: string | null = null): AgentCommand => ({
  name,
  description: `${name} it`,
  hint,
});

const AGENT = [cmd("compact", "instructions"), cmd("init"), cmd("review")];

describe("the commands on offer", () => {
  it("add the tab's own login to the agent's, once", () => {
    expect(
      offered(AGENT)
        .slice(0, 8)
        .map((c) => c.name),
    ).toEqual(["login", "skills", "model", "effort", "clear", "stop", "help", "btw"]);
    expect(offered([...AGENT, cmd("login")]).filter((c) => c.name === "login")).toHaveLength(1);
  });

  it("still offer login before the agent has listed any", () => {
    expect(
      offered([])
        .slice(0, 8)
        .map((c) => c.name),
    ).toEqual(["login", "skills", "model", "effort", "clear", "stop", "help", "btw"]);
  });

  it("offers the complete builtin catalog and marks CLI-only actions truthfully", () => {
    const all = offered(AGENT);
    expect(all.length).toBeGreaterThan(100);
    expect(all.find((entry) => entry.name === "compact")?.support).toBe("agent");
    expect(all.find((entry) => entry.name === "permissions")?.support).toBe("terminal");
    expect(all.find((entry) => entry.name === "login")?.support).toBe("native");
    expect(all.some((entry) => entry.name === "workflows")).toBe(true);
    expect(all.some((entry) => entry.name === "vim")).toBe(false);
    expect(new Set(all.map((entry) => entry.name)).size).toBe(all.length);
  });

  it("groups bundled, project, and plugin skills instead of adding top-level rows", () => {
    const listed = [...AGENT, cmd("simplify"), cmd("team:custom"), cmd("local-tool")];
    expect(skillCommands(listed).map((entry) => entry.name)).toEqual([
      "review",
      "simplify",
      "team:custom",
      "local-tool",
    ]);
    const names = offered(listed).map((entry) => entry.name);
    expect(names).not.toContain("review");
    expect(names).not.toContain("simplify");
    expect(names).not.toContain("team:custom");
    expect(names).not.toContain("local-tool");
  });

  it("uses Codex's own builtins and groups its dollar-prefixed skills", () => {
    const listed = [
      cmd("review"),
      cmd("review-branch"),
      cmd("$documents:documents"),
      cmd("$custom"),
    ];
    expect(skillCommands(listed, "codex").map((entry) => entry.name)).toEqual([
      "$documents:documents",
      "$custom",
    ]);
    const all = offered(listed, "codex");
    expect(all.find((entry) => entry.name === "review")?.support).toBe("agent");
    expect(all.find((entry) => entry.name === "review-branch")?.support).toBe("agent");
    expect(all.find((entry) => entry.name === "keymap")?.support).toBe("terminal");
    expect(all.some((entry) => entry.name === "workflows")).toBe(false);
  });

  it("offers Veistra only the tab's own commands and the skills its agent lists", () => {
    const listed = [cmd("skill:agent-ready-canvas", "what to do with it")];
    expect(skillCommands(listed, "veistra").map((entry) => entry.name)).toEqual([
      "skill:agent-ready-canvas",
    ]);
    const all = offered(listed, "veistra");
    expect(all.every((entry) => entry.support === "native")).toBe(true);
    expect(all.some((entry) => entry.name === "compact")).toBe(false);
    expect(commandSupport("/permissions", listed, "veistra")).toBeNull();
  });

  it("routes explicit commands without misreading unknown commands or ordinary text", () => {
    expect(commandSupport("/compact focus here", AGENT)).toBe("agent");
    expect(commandSupport("/permissions", AGENT)).toBe("terminal");
    expect(commandSupport("/design consent", AGENT)).toBe("terminal");
    expect(commandSupport("/model", AGENT)).toBe("native");
    expect(commandSupport("/nonexistent", AGENT)).toBeNull();
    expect(commandSupport("please /permissions", AGENT)).toBeNull();
    expect(commandSupport("/permissions-extra", AGENT)).toBeNull();
    expect(commandSupport("/permissions\ttool", AGENT)).toBe("terminal");
    expect(commandSupport("/new", AGENT, "codex")).toBe("native");
    expect(commandSupport("/reset", AGENT)).toBe("native");
  });

  it("keeps local handlers in charge even when the adapter advertises the same command", () => {
    const listed = [cmd("login"), cmd("model"), cmd("skills"), cmd("clear")];
    for (const command of listed) {
      expect(commandSupport(`/${command.name}`, listed)).toBe("native");
      expect(offered(listed).filter((entry) => entry.name === command.name)).toHaveLength(1);
    }
  });

  it("deduplicates skills without changing their invocation names", () => {
    const listed = [cmd("$documents:documents"), cmd("$documents:documents"), cmd("$custom")];
    expect(skillCommands(listed, "codex").map((entry) => entry.name)).toEqual([
      "$documents:documents",
      "$custom",
    ]);
    expect(offered(listed, "codex").some((entry) => entry.name.startsWith("$"))).toBe(false);
  });
});

describe("matching a draft", () => {
  it("lists everything for a bare slash", () => {
    expect(matching("/", AGENT)).toHaveLength(3);
  });

  it("puts names that start with the text before names that only contain it", () => {
    const all = [cmd("preview"), cmd("review"), cmd("rewind")];
    expect(matching("/re", all).map((c) => c.name)).toEqual(["review", "rewind", "preview"]);
  });

  it("ignores case", () => {
    expect(matching("/COM", AGENT).map((c) => c.name)).toEqual(["compact"]);
  });

  it("offers nothing for ordinary text, or once an argument is being typed", () => {
    expect(matching("fix the bug", AGENT)).toEqual([]);
    expect(matching("", AGENT)).toEqual([]);
    expect(matching("/compact now", AGENT)).toEqual([]);
    expect(matching("look at /init", AGENT)).toEqual([]);
  });

  it("keeps every match so the scrollable menu can reach later commands", () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`c${i}`));
    expect(matching("/", many)).toHaveLength(30);
    expect(matching("/c29", many).map((entry) => entry.name)).toEqual(["c29"]);
  });

  it("preserves routing metadata when filtering the command catalog", () => {
    expect(matching("/permissions", offered([]))[0]?.support).toBe("terminal");
    expect(matching("/compact", offered(AGENT))[0]?.support).toBe("agent");
  });
});

describe("picking a command", () => {
  it("writes its name and room for an argument", () => {
    expect(completion(cmd("compact"))).toBe("/compact ");
  });

  it("knows the sign-in command only when it stands alone", () => {
    expect(isLogin("/login")).toBe(true);
    expect(isLogin("  /login \n")).toBe(true);
    expect(isLogin("/login now")).toBe(false);
    expect(isLogin("please /login")).toBe(false);
  });
});
