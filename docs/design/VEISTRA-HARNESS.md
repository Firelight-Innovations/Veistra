# The Veistra harness

Owner: Braden Seaborn. Date: 2026-11-05. State: DECIDED, first cut built.
Closes item 1 of "Known issues (open)" in `TODO.md`. Builds on
`docs/design/VEISTRA-AGENT-EMBEDDING-DESIGN.md` §3.2 (Pi) and `docs/agent-harnesses.md`.

## The decision in one line

The Veistra harness is Pi, run unmodified through its SDK, with Veistra's own modules around it,
shipped as one ACP agent (`packages/veistra-agent`, the `veistra-agent-acp` program) that the agent
tab launches the way it launches Claude's and Codex's adapters.

## The three questions

### 1. What "Veistra harness" means

**A packaged ACP agent that Veistra ships, not a third tool loop written in Rust.** Pi already is a
tool loop: providers, tools, compaction, sessions, skills, MCP. Writing our own loop would rebuild
that and add nothing a person would notice. The Rust side stays as it is: `Harness::Veistra` is a
third variant with `Protocol::Acp`, so the transcript, approvals, chips, models, saved conversations
and the worktree guard are the same code that runs Claude and Codex.

"Ours" means the modules, not a fork. The agent pins `@earendil-works/pi-coding-agent` to an exact
version and changes none of its files. Everything Veistra-specific goes through Pi's SDK options
and its extension API, as design §3.2 point 5 asks ("stay on upstream Pi through extensions"):

| Module | File | What it does |
|---|---|---|
| ACP front end | `src/acp.ts`, `src/rpc.ts` | Speaks ACP on stdio and turns Pi's events into `session/update`s |
| Modes and permissions | `src/modes.ts`, `src/permissions.ts` | Ask-first, Accept edits, Plan; asks the user through `session/request_permission` from Pi's `tool_call` gate |
| Worktree guard | `src/guard.ts` | Refuses a file tool whose path, symlinks resolved, leaves the worktree, before it can ask |
| Veistra's MCP servers | `src/mcp.ts` | The servers the host offers in `session/new`, given to Pi's MCP extension as direct tools |
| Skills | `src/skills.ts` | Veistra's built-in skills for this session only (`_meta.veistra.skills`) |
| Identity | `src/prompt.ts` | A system-prompt section that says what Veistra is and how its tools behave |
| Sign-in | `src/login.ts` | `veistra-agent login`, which stores a provider key in the harness's own store |
| Quiet | `src/node.ts` | Turns off Pi's install telemetry, provider attribution headers and version check |

Why not the community `pi-acp` shim: it is a 0.0.x adapter that runs `pi --mode rpc`, so it reads
the user's personal `~/.pi` configuration and extensions, cannot take per-session skills or MCP
servers, and has no permission gate. Pi has no permission prompts of its own, so the gate is the one
thing the host cannot do without, and only an in-process module can hold a tool call until the user
answers.

### 2. Whose model access it uses

**The user's own provider key, for now.** The Veistra account (handoff 2) does not sign in yet, so it
cannot carry the first version. The key lives where Pi keeps keys, in the harness's own store
(`~/.veistra/agent/auth.json`, which Pi writes with mode 0600), and nowhere else:

- `veistra-agent login` sets it. In a terminal it asks for the provider and the key. Run with no
  terminal, which is how the tab's `/login` runs it, it opens a page on `127.0.0.1` in the browser
  with a one-time path, takes the key there, and exits. Either way it is the harness's own sign-in,
  like `claude auth login`. Veistra never sees the key, and the descriptor's `env` carries none.
- A provider's usual variable in the user's own environment (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` and so on) works too, because Pi reads it. Veistra does not set it.
- Signing in to Claude with a Pro or Max subscription through Pi is not offered, per design §6.
  The provider list in `veistra-agent login` is API keys only.

When the Veistra account works, it becomes one more Pi provider, registered by a module in this
package, and one more choice in `veistra-agent login`. Nothing in the host changes for that.

### 3. Which tools it gets

- **Files and the terminal in the worktree:** Pi's own `read`, `bash`, `edit`, `write`, `grep`,
  `find` and `ls`, with the worktree as their working directory.
- **Veistra's MCP servers:** the host already offers them in `session/new` (`mcpServers`), with
  their bearer headers. `mcp.ts` hands them to Pi's MCP extension with `direct` exposure, so each
  tool reaches the model as `mcp__<server>__<tool>`, through the same permission gate. The user's
  personal Pi MCP configuration is not read: the agent's home is its own (`~/.veistra/agent`).
- **Built-in skills:** a new `SkillDelivery::SessionFolder`. `src-tauri/src/skills.rs` writes the
  session's skills to a folder under Veistra's app data, the host sends its path in `session/new` as
  `_meta.veistra.skills`, and the agent passes it to Pi as `additionalSkillPaths`. Nothing is
  written into the user's profile or the project.
- **Skill commands:** the agent lists every skill it has as `skill:<name>` in
  `available_commands_update`, so the tab's skill chips and `/skills` menu reach it, and it expands
  only that form. Any other leading slash is the user's text.
- **Project instructions:** `AGENTS.md` and `CLAUDE.md` load, as Pi loads them. A project's own Pi
  extensions do not: the agent never grants project trust, because nobody could answer the prompt.

## Modes

Every session starts in `default`, the ask-first mode the host requires (`Policy::ask_first`).
No mode acts without the user, and none hands approval to anything else, so nothing goes in
`config::NOT_OFFERED`.

| Mode id | Name | Reads in the worktree | Edits in the worktree | Commands and MCP tools |
|---|---|---|---|---|
| `default` | Ask before edits | run | ask | ask |
| `acceptEdits` | Accept edits | run | run | ask |
| `plan` | Plan | run | refused | ask |

A path outside the worktree is refused in every mode, before anything is asked. The host's guard
checks each permission request again (`guard::escapes`), so the two disagree only if one has a bug.

## How it is installed

- **Development:** `pnpm build` builds the package. The host finds the checkout's
  `packages/veistra-agent/bin/veistra-agent-acp` when nothing is on PATH, as it already does for
  the checkout's Codex adapter.
- **Release:** the package is `@veistra/agent`, and the tab's Install button installs it with npm,
  pinned, like the other adapters. Publishing it is an owner step that has not happened yet; until
  then a release build finds the agent only on PATH.
- **Node.js 22.19 or newer** is required, because Pi requires it. CI's verify job moves to Node 22
  for the same reason.

## How it is tested

No test reaches a real model. `packages/veistra-agent/scripts/scripted-agent.mjs` is the shipped
agent with Pi's faux provider in place of a model, and two suites drive it as a real process:

- `packages/veistra-agent/test/agent.test.ts` plays the host's side of ACP: streaming, each mode,
  approvals allowed, rejected and cancelled, the worktree guard, chip context, skills and settings.
- `crates/veistra-agent-host/tests/veistra.rs` runs it under `AgentHost`, so the transcript, the
  approval card and its diff, and the host's guard see what the agent really sends.

## Not in this cut

- The Veistra account as a model provider (waits on handoff 2).
- Steering a running turn and forking. Pi supports both; the host offers neither for any harness.
- Resuming a saved Pi session across processes. Saved conversations restore the way they do for
  the other harnesses: the transcript, plus bounded context in the next prompt.
- Publishing `@veistra/agent` to npm, and bundling it with the installer.
- A turn in the tab on Windows against a real provider. Everything above was run on Linux; the
  owner runs the Windows check.
