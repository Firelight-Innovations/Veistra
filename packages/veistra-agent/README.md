# @veistra/agent

Veistra's own coding agent, the harness the agent tab lists first. It is
[Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, MIT), pinned and
unmodified, run through its SDK, with Veistra's modules around it, speaking the Agent Client
Protocol on stdio. Why it is built this way: `docs/design/VEISTRA-HARNESS.md`.

Two programs:

| Program | What it is |
|---|---|
| `veistra-agent-acp` | The agent. The host launches it with no arguments and speaks ACP on its stdio. |
| `veistra-agent` | `login`, `logout`, `status`, `version`. Never speaks ACP. |

Requires Node.js 22.19 or newer, because Pi does.

## Signing in

The agent uses the person's own model provider key. `veistra-agent login` saves one in the agent's
home, `~/.veistra/agent/auth.json` (`VEISTRA_AGENT_DIR` moves it), through Pi's own credential
store. In a terminal it asks there; without one, which is how the tab's `/login` runs it, it opens a
one-time page on `127.0.0.1` in the browser. A provider's usual environment variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) works too.

## In this checkout

`pnpm build` (or `pnpm build:agent`) compiles `src/` to `dist/`. `bin/` holds launchers for that
build, which the host falls back to when no `veistra-agent-acp` is on PATH, the way it falls back
to the checkout's Codex adapter. They are not part of the published package, whose `bin` entries
npm writes itself.

## Modules

| File | Does |
|---|---|
| `rpc.ts` | JSON-RPC over newline-delimited JSON |
| `agent.ts` | The ACP requests: `initialize`, `session/new`, settings, `session/prompt`, `session/cancel` |
| `session.ts` | One Pi session: its events as `session/update`s, and the tool-call gate |
| `modes.ts` | Ask before edits, Accept edits, Plan, and what each lets through |
| `guard.ts` | Refuses a file tool whose path, symlinks resolved, leaves the worktree |
| `tools.ts` | A tool call's title, kind, locations and diff, as the tab draws them |
| `mcp.ts` | Veistra's MCP servers from `session/new`, as direct Pi tools |
| `skills.ts` | Veistra's built-in skills for one session |
| `prompt.ts` | What the model is told about Veistra, and ACP prompt blocks as Pi input |
| `login.ts` | `veistra-agent login` |

## Tests

`pnpm test` here builds, then runs `test/`. `test/agent.test.ts` drives the real agent process
end to end with only the model scripted (`scripts/scripted-agent.mjs`, which uses Pi's faux
provider). No test reaches a real model.
