# Agent harnesses

A harness is a coding agent the agent tab can run: Veistra's own, Claude and Codex. This page
describes the boundary between a harness and the rest of Veistra, and how to add a harness.

`src-tauri/src/harness.rs` is a different thing. It recognises a harness that runs in a terminal, so
that a dropped file is quoted the way that harness reads it. Nothing on this page touches it.

## The boundary

```text
agent tab ── agent-tab/* ── AgentHost ── Adapter ── harness process
             (src-tauri)    (crate)      (trait)    (ACP on stdio)
```

- **The registry.** `crates/veistra-agent-host/src/harness.rs` holds one `Descriptor` per harness,
  in `REGISTRY`. The host and `agent-tab/harnesses` read these facts about a harness from the
  registry and nowhere else:
  - its name
  - its programs
  - how the user installs it and signs in to it
  - the mode it starts in
  - what it supports

  The UI does not read them all yet. A registered harness's name, install command and sign-in
  reach the agent tab in `HarnessInfo`. The tab's `strings.ts` keeps a fallback name in
  `harnessName` only for a harness the host does not report.
- **The event model.** `apps/agent-tab/ui/src/protocol.generated.ts` is generated from the types
  in `event.rs`, and it is the only thing the UI reads. No harness's wire format reaches the UI.
- **The `Adapter` trait.** `host.rs` drives every session through it. `Session` implements it over
  ACP, for every descriptor whose `protocol` is `Protocol::Acp`. A harness that does not speak ACP
  gets its own type that implements `Adapter` and translates, and a new `Protocol` variant that
  `AgentHost::send` maps to that type.
- **Built-in skills.** A descriptor's `skills` (`SkillDelivery`) says how Veistra's built-in
  skills reach the harness: a per-session plugin folder (Claude), a per-session folder of skills
  named in `session/new`'s `_meta.veistra.skills` (Veistra's own), a marked copy in the harness's
  user skills folder (Codex), or a hint in the first prompt. `src-tauri/src/skills.rs` picks the
  skills and puts the files in place; a new harness only chooses a variant. A session doing Godot
  work also gets `VEISTRA_GODOT`, the Godot executable Veistra found, so the `finish-godot-game`
  skill can run the game from the agent's own shell.
- **`agent-tab/harnesses`.** It answers one `HarnessInfo` per descriptor, with these fields:
  - the harness's name
  - what stands in its way, as a `Hint`
  - the commands that set it up: sign in, install the pinned adapter
  - its capabilities
  - `models`: the models its agent offers, or `null` until the agent has said (see
    [Models](#models))
  - `model`: the model its next session starts on, as a value: the tab's choice for that harness,
    else the agent's default. A choice that the agent does not offer is reported as the default,
    since the session never asks for it.

  Asked as an agent tab, it also answers these:
  - `current`: the harness the tab's next prompt goes to
  - `running`: the harness its agent runs, while that agent lives
  - `model`: the name of the model that agent runs, once the agent reports one
- **The harness a tab runs.** Each agent tab chooses its own harness, and the host resolves it in
  this order:
  1. the harness its live agent runs
  2. the harness it chose with `agent-tab/choose`
  3. the first harness in `REGISTRY`

  `agent-tab/choose` stops the outgoing harness before switching. Visible history stays in
  the tab; the next prompt gives the receiving harness bounded conversation and tool context.
  Pending approvals are cancelled and private reasoning is excluded from transferred context.
  Each choice emits `agent-tab:chosen`, so every view of the tab shows the same harness.

  `agent-tab/choose` also takes an optional `model`: a model's value, or `null` for the agent's
  default. The tab keeps one model for each harness. A call without `model` leaves them all as
  they are, so a caller that chooses a harness only never drops one. A model chosen while
  the tab's agent runs applies to the tab's next session. `agent-tab:chosen` carries the chosen
  harness's model.

### Saved conversations and Ultra effort

The tab's history button searches locally persisted conversations across harnesses for the current
worktree. Snapshots live in app data under `agent-conversations`, outside the checkout. The tab
saves completed content after a short debounce, before reset, on tab closure and on shutdown.
Conversations can be archived, searched, reopened, and continued using either harness. Reopening
does not run inference: the next prompt starts a fresh process with bounded restored context.
Snapshots cannot be opened from another worktree and pending approvals are cancelled on restore.

Ultra effort is the Claude-only sixth slider stop. It uses an advertised deep reasoning level
(prefer xhigh) plus workflows. Changing it resumes the same Claude session through
`_meta.claudeCode.options.settings.ultracode`; queued settings finish before the next prompt,
and the model, transcript, permitted mode and negotiated MCP capabilities are retained.
The slider and composer share an animated violet dot field, with reduced-motion equivalents.
- **`agent-tab/send`.** It takes the prompt's `text`, sends it to the tab's harness, and starts
  that harness with `harness::spec` if no agent runs.

## Rules every harness follows

These rules come from handoff §0 and design AGT-002 and AGT-004. Review refuses a descriptor that
breaks one.

- Veistra runs the user's own, unmodified binary, signed in by the user. It never reads, stores
  or logs a token. Veistra's own harness is Veistra's program, but the rest holds for it: its key
  is the user's, kept by its own sign-in (`veistra-agent login`), never seen by the app. It starts a sign-in only when the user types `/login` in the tab
  (`agent-tab/login`): that runs the harness's own CLI sign-in (`claude auth login`, `codex login`),
  which opens a browser and keeps its credentials itself, and nothing it prints is read. `sign_in`
  is the same command for the user's own terminal.
- ACP is the wire protocol. A harness without ACP gets a translating adapter behind the same
  `Adapter` trait, never a second UI.
- The adapter is pinned to a tested version. Record that version in
  `docs/agent-host-versions.md`. The user installs it, from their terminal or with the tab's
  Install button (see [Installing from the tab](#installing-from-the-tab)); Veistra never ships
  a third party's harness or adapter. Its own, `@veistra/agent`, installs the same way.
- Every session that `harness::spec` builds starts in the harness's ask-first mode,
  `Policy::ask_first`. If the agent refuses to switch to it, the session does not run.
- The tab must never offer two kinds of mode:
  - a mode in which the agent acts without asking
  - a mode in which something other than the user approves a request

  The worktree guard checks each `session/request_permission`, and a mode like these skips that
  request, so the guard never sees what the agent does. Name those modes when you verify the
  adapter (step 1), and add their ids to `config::NOT_OFFERED`. The host drops those ids from
  every option's choices, and never starts a session in one. One exception, decided by the owner
  in 2026-10: Claude's `auto` is offered, and the calls it approves skip the guard.
- `env` never carries a credential.
- The UI calls a harness by its short name: "Veistra", "Claude", "Codex".

## What the UI shows

The agent tab draws every registered harness from `agent-tab/harnesses`, by the name the host
reports. Its own strings name no program or version. The tab's settings menu also lists harnesses
that are not registered yet, as "Coming soon", by the fallback names in `harnessName`.

- **The picker.** The tab's settings menu has a group per harness, listing its models, or only
  its default until its agent has said (see [Models](#models)). Choosing a model chooses that
  harness and that model. While the tab's agent runs, the menu cannot switch harness. A model
  chosen under the running harness changes that agent's model at once, through
  `agent-tab/set-config`. A choice under any other harness is ignored.
- **The order.** Veistra, then Claude, then Codex (`HARNESSES` in
  `apps/agent-tab/ui/src/harnesses.ts`). A registered harness that is not installed can still be
  chosen: it is marked with a dot, its models read "Not set up", and the tab shows the setup
  card below.
- **The model.** While an agent runs, the tab's header shows its harness and its model.
- **Hints.** Each `Hint` is a sentence template in the tab's `apps/agent-tab/ui/src/strings.ts`.
  A template fills in the harness's name and its setup commands from `HarnessInfo`, so a new
  harness gets correct install and sign-in hints without a new string. `tsc` holds the tab's table
  to `Hint`, so a new `Hint` needs a sentence in the tab. An error item records the harness that
  raised it, so its hint names that harness after the tab switches to another.

## Installing from the tab

When the chosen harness reports `harnessMissing` or `adapterMissing`, the tab shows a setup card
(`useSetup.ts`, drawn by the `SetupCard` slot) in place of the hint. It names the command a person
would type (`Setup.cliInstall` or `Setup.adapterInstall`) and has an Install button.

- **What a press runs.** `agent-tab/install` asks `harness::install::plan` for what is missing and
  runs it on its own thread, in order: the vendor's own installer for the program (Anthropic's
  install script for Claude through PowerShell or bash, `npm i -g @openai/codex` for Codex, from
  `Descriptor::install`), then the pinned adapter with `npm i -g --omit=optional`. Nothing runs
  unless the whole plan can: a missing npm refuses the press as `nodeMissing`, and the card offers
  "Get Node.js", which opens nodejs.org's download page (`agent-tab/get-node`).
- **Who can press it.** Both methods are tab-only (`INSTANCE_METHODS`). An MCP `app_call` has no
  instance, so an agent can never install anything. One install per harness runs at a time;
  a second press is refused as `installing`.
- **What the tab hears.** `agent-tab:install` carries `{harness, step, ok, hint, detail}` for each
  step, and once more with `step: null` when the install ends. A failed step's `detail` is the
  end of what it printed, shown folded under the card's retry button.
- **Signing in.** Installing never signs in. When the install ends with no hint left, the card
  offers "Sign in to {name}", which is `/login`.
- **A PATH that is out of date.** An installer adds its folder to the user's PATH, but Veistra
  read its PATH when it started. `agent_install::search_path` adds the folders the installers use
  (`~/.local/bin`, and `%APPDATA%\npm` on Windows) after the user's own, and every lookup and
  launch in the tab goes through it, so a harness is found without restarting Veistra. The
  launched agent gets the widened PATH as `env`, which is not a credential.

## Veistra's own harness

`harness/veistra.rs` runs `veistra-agent-acp` from `@veistra/agent` (`packages/veistra-agent`): Pi,
pinned and unmodified, run through its SDK, with Veistra's modules around it, speaking ACP itself.
It is first in `REGISTRY`, so a new tab runs it. Why it is built this way, and what it can do:
`docs/design/VEISTRA-HARNESS.md`.

- **No third-party adapter.** The agent speaks ACP, so the descriptor's `adapter` is the agent and
  its `cli` is `veistra-agent`, the sign-in program from the same package. `cli_env` is `None`:
  there is no separate binary to point the agent at. `CliInstall::WithAdapter` makes the tab's
  Install one pinned `npm i -g` of that package.
- **This checkout.** With nothing on PATH, the host runs the agent `pnpm build` compiled, through
  the launchers in `packages/veistra-agent/bin/` (`harness/managed.rs`), once its `dist/` exists.
  Signing in from the tab finds the same build.
- **Signing in.** `/login` runs `veistra-agent login` with no terminal, so it serves a one-time form
  on `127.0.0.1`, opens it in the browser, saves the key in the agent's own home and exits. A
  provider's usual environment variable works too. A signed-out `session/new` answers
  `auth_required`, and the tab shows the `signedOut` hint.
- **Modes.** `default` (ask before edits, commands and tools), `acceptEdits` and `plan`. Every
  one asks the user, or refuses, before anything but a read in the worktree, so none is in
  `config::NOT_OFFERED`. The agent refuses a path outside the worktree itself, before asking, and
  the host's guard checks every request it does ask again.
- **Commands.** It lists its skills as `skill:<name>`, which the tab groups under `/skills`. It has
  no CLI session, so the tab offers it none of Claude's or Codex's terminal commands.
- **Show calls.** It names a tool's MCP server and tool in `_meta.veistra`, from the server names
  the host gave it, which `veistra_call::is_show` reads.

## Models

ACP has no request that lists an agent's models outside a session. So the host asks for them:

1. A tab calls `agent-tab/harnesses`, with developer mode on and a worktree to run in. The tab
   does this when it opens. The shell makes the same call as the cluster's agent tab
   (`useAgentTabRefresh`, in `src/shell/state/agentTab.ts`). It calls when the tab mounts, when a
   setting or the cluster's environment changes, and on each status or reset event from the
   tab's session.
2. For each installed harness that it has not asked in that worktree this launch, the host starts
   the harness's adapter there. It sends `initialize` and `session/new`, and nothing else.
3. It reads the option of category `model` from the reply to `session/new`, and kills the agent.
4. It sends `agent-tab:models` to each open agent tab, and the tab calls `agent-tab/harnesses`
   again.

The ask never sends a prompt, so it uses none of the user's quota. It starts the user's agent
once per launch for each harness and worktree, as a session would. The agent therefore starts its
own MCP servers and hooks too, and Codex treats the worktree as trusted, as it does for every
session Veistra starts. The host asks each worktree separately because a project's settings can
narrow the list or change the default. Claude reads them from the worktree's
`.claude/settings.json`, and Codex from its project config.

A harness lists no models in these cases:

- **A signed-out Codex.** It refuses `session/new`. Claude's adapter opens a session while signed
  out, so Claude lists its models; its first prompt then reports the sign-out.
- **A slow agent.** The host kills an agent that does not answer a request within 60 seconds, the
  time a session's handshake gives it.

The host asks such a harness once more, when a tab asks for the harnesses while a session of that
harness has reported its model. That report shows that the agent is signed in.

While a session runs, its models are in `SessionStatus.config`.

**The model a session starts on.** `agent-tab/send` puts the tab's model in `LaunchSpec.model`.
After `session/set_mode`, the handshake sends `session/set_config_option` for the `model` option.
The session reports that it is ready after this request. A model that the agent no longer offers is
never sent. If the agent refuses the model, the session stays on the agent's default, and the host
logs this. The status shows the model that the session actually runs. The exception is an agent that
answers the switch only after the handshake's 60 seconds; the status then keeps the default.

## Codex

`harness/codex.rs` runs the user's own `codex` through `@agentclientprotocol/codex-acp`, which
starts `codex app-server` and speaks ACP for it. The user installs the adapter with
`--omit=optional`. The adapter depends on `@openai/codex`, which carries its native `codex` binary
in optional, per-platform packages, so npm installs the wrapper without that binary. The host
sets `CODEX_PATH` to the user's `codex`, and the adapter runs that one. The user signs in with
`codex login` in a terminal. A signed-out `session/new` answers `auth_required`, and the tab shows the `signedOut`
hint. The adapter never inherits `DEFAULT_AUTH_REQUEST` (`Descriptor::env_remove`): with it set, a
signed-out session would sign itself in, and `chat-gpt` opens a browser.

For development, `pnpm setup:codex` installs the same pinned adapter inside this checkout's
`node_modules/.agent-adapters/codex/`, without changing global npm packages or installing a second
native Codex CLI. `installed_spec` prefers an adapter already on PATH, then checks that one local
directory. Its root is the agent-host crate's build checkout, never the user's active project or
the process's current directory. The CLI itself must still be on PATH and signed in by the user.
The local adapter is not a bundled release asset: a packaged app still needs an adapter on PATH.

The 2026-10-25 check confirmed `initialize`, `session/new`, read-only mode, model switching and
reasoning-effort changes with the user's Codex 0.153.0 and local codex-acp 2.2.2. No prompt was sent.
That CLI's model catalog did not include the user's configured `gpt-6.1-sol` default, so the
adapter inserted that default without effort metadata. Choosing an advertised model such as
`gpt-6-astra` supplied its reasoning levels. The host does not invent levels for a missing model.

Discovery also keeps the adapter's `available_commands_update` notification, including argument
hints. It watches notifications during the handshake and for at most one second after
`session/new`, without sending a prompt. These commands populate `HarnessInfo.commands` before
the user's session starts. Codex reports skill invocations with a leading `$`; the UI groups
skills below its single skills command rather than adding each one to the top-level menu.

The slash menu includes the documented Claude Code and Codex builtins, including commands whose
terminal dialogs are outside ACP. A command advertised by the active adapter runs through that
adapter; the tab handles its own model, effort, login, side-chat, and composer controls. Other
builtins carry an **Open in terminal** label. Submitting one explicitly opens a fresh native CLI
session in the same cluster's worktree, with the command as its initial input. Picking the row
only fills the composer. The existing agent conversation keeps running separately; no session
identifier is guessed and no transcript is sent as an extra inference prompt. Native command
availability still depends on the installed CLI version and account. Bundled workflows, bundled
skills, plugin commands, custom commands, and Codex's `$` invocations live below `/skills`.

**Modes.** Each Codex mode joins an approval policy and a sandbox:

| Mode id | Name | Who approves a request | Sandbox | Veistra |
|---|---|---|---|---|
| `read-only` | Read-only | the user | reads anywhere | every session starts here |
| `workspace-write` | Workspace access | the user | also writes the workspace and temp | allowed |
| `agent` | Auto review | a reviewer model | also writes the workspace and temp | held back |
| `agent-full-access` | Full access | nobody | none | held back |

A command that stays inside its sandbox runs without a request. In both modes the tab allows, that
means a sandboxed command reads any file on the disk without asking. In `workspace-write` it also
writes the worktree, `TMPDIR` and `/tmp` without asking. A request reaches the user, and the guard,
only when a command needs more than its sandbox grants.

The owner decided both points on 2026-10-15: `workspace-write` is allowed, and a sandboxed command
may read without asking. Claude's `default` asks before every command, so Codex asks less. Making
it match would need an approval policy of `untrusted` or a narrower sandbox, and codex-acp 2.2.2
offers neither as a mode.

`agent` is the adapter's default. A reviewer model approves requests in it, so those requests skip
the guard, as in Claude's `auto`. `agent-full-access` is Codex's equivalent of Claude's
`bypassPermissions`. Both ids are in `config::NOT_OFFERED`. The descriptor sets
`INITIAL_AGENT_MODE=read-only`, so the session opens in `read-only` before the host's own
`set_mode`, and never runs in `agent`.

**Settings.** The adapter reports these select options, and the host passes each one to the tab in
`SessionStatus.config`. `agent-tab/harnesses` lists the models before a session starts (see
[Models](#models)). While an agent runs, the tab's header shows the model. The
tab has no control for the other options yet.

- `model`: the model
- `reasoning_effort`: the effort, only for a model that has levels
- `collaboration_mode`: `default` or `plan`
- `fast-mode`: `on` or `off`, only for a model that supports it

**The guard.** A command request carries its working directory as `rawInput.cwd`. A sandbox
request carries what it grants under `permissions` or `additionalPermissions`, as
`fileSystem.read`, `fileSystem.write` and `entries`. The approval card lists all of it, and
`guard::escapes` refuses the request without asking if any part is outside the worktree:

- A path is resolved against the worktree, as any other path is.
- A glob pattern is checked by the folder its literal start names, so `src/**` is checked as
  `src/`. A pattern has no such folder, and is refused, if it starts with a wildcard or with `~`,
  or if a part after its first wildcard holds `..`.
- An entry of type `special` is a named scope. The project, which is the worktree, is checked by
  its subpath. Every other scope is refused: the whole disk, the temp folders, and any kind Codex
  adds later.
- An entry whose access is `deny` grants nothing, and is skipped.
- A file change's request names the files it edits, and a moved file by its source only. A move's
  destination is in the diff that the change reported when it started, so the guard also checks
  every file the same tool call named before. A command's files count the same way, whether or not
  it has started. The adapter drops a diff over 1 MiB, path and all, so a move with a diff that
  large is not checked.

## Adding a harness

1. **Verify first.** Install the adapter in a scratch directory. Run `initialize` and
   `session/new` against a scratch git repository, and record what the adapter answers:
   - its modes, which one asks before acting, and which ones skip the user's approval
   - its config options
   - the kinds of its approval options
   - what a signed-out session answers

   Do not send a prompt that spends the user's quota without asking them.
2. **Add the variant.** Add it to `Harness` in `harness.rs` and to the match in
   `Harness::descriptor`. The compiler then lists each match that must handle it. It cannot check
   `REGISTRY`, which is a plain list. The test `every_variant_has_a_row_in_the_registry` checks it
   instead, and fails until step 3 adds the variant there.
3. **Write the descriptor.** Create `harness/<name>.rs` with one `Descriptor`, modelled on
   `harness/claude.rs`. Declare it in `harness.rs` with `mod <name>;` and
   `pub use <name>::<NAME>;`, and add it to `REGISTRY`. The struct documents each field.
4. **Extend the guard if needed.** `guard::request_paths` reads the paths that a permission
   request names, and the session adds the files its tool call named earlier.
   `guard::request_scope` adds where a command runs and what a sandbox grant opens, and the
   approval card shows it all. `guard::escapes` refuses any part of it outside the
   worktree, or that no path stands for. If the new adapter puts paths under keys that none of
   these reads, add those keys, with a test.
5. **Regenerate the TypeScript types.** Run
   `VEISTRA_BLESS=1 cargo test -p veistra-agent-host generated_types`. The new id joins the `Harness`
   union. The tab's settings menu lists the new harness, and no UI code changes.
6. **Record the version.** Add a row to `docs/agent-host-versions.md`.
7. **Run `pnpm verify`.**
