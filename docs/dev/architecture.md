# How the orchestrator is built

This page holds the technical description of the repository. It moved here out
of the root `README.md`, which is now written for someone who wants to run
Veistra rather than work on it.

Read [CONTRIBUTING.md](../../CONTRIBUTING.md) first if you have not opened a
pull request against this repository before. Read
[STANDARDS.md](../../STANDARDS.md) for the rules a review turns on.

## Tech stack

This repository is a [Tauri v2](https://tauri.app) desktop app. A Rust backend
drives a web frontend, and the operating system webview renders it. On Windows
that webview is WebView2.

| Layer | Choice | Lives in |
|---|---|---|
| Backend | Rust (stable) | `src-tauri/src/` |
| Shell and runtime | Tauri v2 | `src-tauri/tauri.conf.json` |
| Frontend | React 19 + TypeScript + Vite | `src/` |
| Stack manifest | TOML | `veistra.toml` |

Rust owns everything that touches the machine. Rust reads the manifest, finds
the tool checkouts, and compares each one against its pinned version. The
frontend is a view over the resulting snapshot. The frontend reaches Rust only
through the typed wrappers in `src/bindings.ts`.

## The stack manifest

`veistra.toml` says which components make up the stack, and which version of each
one this orchestrator expects. On launch the app reads the manifest. The app
then looks for each component's checkout under `checkout-root`, which defaults
to the sibling directories of this repository. Each tool then reports one of
four states.

| State | Meaning |
|---|---|
| `v0.1.0` | The checkout is present and its version matches the pin |
| `!=` | The checkout is present but reports a different version |
| `unversioned` | The checkout is present with no `Cargo.toml` or `package.json` to read |
| `not cloned` | Nothing sits at the expected path |

Set `VEISTRA_MANIFEST` to point a dev build at a different manifest.

## Layout

This repository is a Cargo workspace and a pnpm workspace at the same time. The
tool protocol needs libraries that *other* Veistra repositories depend on, so
those libraries live outside `src-tauri/` and are shared through the workspace.

One consequence is worth knowing. Rust build output lands in `target/`, not in
`src-tauri/target/`. Every crate therefore compiles the Tauri dependency tree
once between them, rather than once each.

```
Cargo.toml            Rust workspace root
pnpm-workspace.yaml   Node workspace root
veistra.toml          stack manifest: pinned component versions
branding.toml         what the product is called, and what it is drawn as
docs/
  tool-protocol.md      the wire contract between the shell and a tool
  branding.md           which names are branding and which are wire formats
crates/               Rust libraries shared with the tool repositories
  veistra-tool-manifest/  parses and validates veistra-tool.toml
  veistra-rpc/            JSON-RPC over the standard streams, both halves
packages/             npm packages shipped to the tool repositories
  bridge/               @veistra/bridge: one tool frontend, either host
examples/
  echo-tool/            reference tool: manifest + core + frontend
apps/                 first-party surfaces, see apps/README.md
  shared/app.css        the chrome every app draws inside
  home/ui/              Home: the stack at a glance
  files/ui/             Files: browse the checkout
  viewer/ui/            Viewer: read a file, whatever its format
  docs/ui/              Docs: veistra.com/docs, read live from the website
  design/ui/            Design Mode: a running page, and elements picked out of it
index.html            Vite entry point (main window)
splash.html           Vite entry point (splash window)
src/                  React frontend
  bindings.ts           typed wrappers over the Rust commands
  App.tsx               owns the stack snapshot, renders the shell
  tokens.css            palette and resets, shared by both windows
  ui/                   leaf components shared across the shell
  splash/               the startup window
  shell/                the frame tools run inside, one directory per region,
                        each built against contract.ts (STANDARDS.md 1.2)
    contract.ts           the sanctioned vocabulary every region shares
    WindowRoot.tsx        one Veistra window
    frame/                the window frame itself
    titlebar/             title bar and its menus
    panes/ panel/         the pane tree, and the side panel
    switcher/ toolwindow/ tabs, and where an app actually mounts
    terminal/             the terminal band
    search/               project search and the locator
    diff/ worktree/       git surfaces
    github/               issues and pull requests, and opening a worktree
                          from one
    settings/             the settings screen
    state/                the shell's own state, mirrored from Rust
    drag/ keys/ statusbar/
src-tauri/            Rust backend
  src/
    main.rs             binary entry point (thin shim over lib.rs)
    lib.rs              builds the Tauri app, registers state and commands
    boot.rs             the startup sequence behind the splash
    commands.rs         the #[tauri::command] bridge to the frontend
    manifest.rs         locating and parsing veistra.toml
    tool.rs             tool types: declared spec against resolved status
    discovery.rs        joins the manifest against the filesystem
    shell_state.rs      clusters, panes and instances: the shell's own model
    shell_store.rs      what of that survives a restart
    layout.rs           the pane tree, and how an open splits it
    windows.rs          creating and tracking operating system windows
    git.rs              status, diffs and worktrees
    github.rs           what is open on the repository a cluster checks out
    search.rs           the project search the overlay calls
    pty.rs              terminals
    sync.rs             the lock-poisoning answer, given once (STANDARDS.md 5)
    apps/               the first-party apps' Rust halves
      mod.rs              the registry, and `invoke` routing
      home.rs             home/state, and the folder pickers
      files.rs            files/list, files/read
      trash.rs            deleting, and getting it back
      docs.rs             the website's docs index and pages, fetched live
      design.rs           what Design Mode may embed, and what goes inside it
      design_probe.js     the browser code that goes inside it
    project/            what a project is, and which one is open
      mod.rs              open / create / initialize / close / forget
      marker.rs           the <name>.veistra manifest
      store.rs            the recents file, and what survives a restart
    mcp/                the MCP servers Veistra hosts for a coding agent
    settings/           the schema the settings screen is generated from
    presets/            saved layouts
    error.rs            one error type, serializable across the IPC boundary
    state.rs            shared app state
  capabilities/       Tauri permissions, scoped per window label
  tauri.conf.json     window, bundle and build configuration
```

## Projects

A project is **a folder**. The folder becomes a *Veistra* project when it holds a
`<name>.veistra` manifest. That manifest is small, hand-editable TOML, and is
meant for version control. A `.veistra/` directory sits beside it and holds
everything Veistra generates about the project: agent traces, designs, docs, and
the history of how the project got built.

The manifest and the directory cannot share one name. The manifest therefore
takes the project's own name and an extension, the way `.uproject` and `.sln`
do.

A folder with no manifest still opens. That behaviour is intentional. Veistra can
open a project that already exists, and the answer to "what happens when the
`.veistra` format changes" must never be "the project stops opening". Home marks
such a folder *not set up* and offers to write a manifest.

Which project is open, and the last twenty opened before it, live in
`projects.json` in the operating system config directory. That file is the only
orchestrator state that survives the process. Everything else is re-derived at
boot. Opening a project sets where the Files app starts, where a new terminal
opens, and the window title. The next launch restores it.

`src-tauri/src/project/` is the whole of it, and it owns no user interface. The
module takes paths. Choosing a folder by pointing at one is Home's job, in
`src-tauri/src/apps/home.rs`. That split keeps "open this project" something a
command-line flag or a double-clicked `.veistra` file could do later, with no
human at the keyboard.

## Startup

The app opens on a splash window. Behind it, `boot.rs` locates the manifest,
reads it, and scans the checkouts on a background thread. The main window is
created at the same time but stays hidden, so its webview and every app iframe
in it are loading throughout.

When the scan finishes, the snapshot goes into `AppState`. Boot then waits for
each first-party app to report a painted frame. The main window is shown and
the splash closes. The main window reads the cached snapshot rather than
scanning again.

Four things there are load-bearing and easy to break.

- **Tauri events are not replayed.** Boot can finish before the splash webview
  registers its listener. The splash therefore also polls `boot_status` once on
  mount, after `listen` has resolved. Both paths are needed, and neither is
  redundant.
- **A watchdog forces the handoff** ten seconds after boot reaches a terminal
  state. A frontend bug then cannot strand the user on a splash that never
  closes.
- **The apps are waited for, not started.** They boot in parallel behind the
  splash whether anything waits or not. Waiting is what stops the window being
  revealed mid-load, with a boot overlay as the first thing anyone sees.
- **That wait is bounded** at four seconds. Four seconds sits inside the
  splash's own five-second minimum, so a timeout costs no startup time. An app
  that misses the deadline is logged and left behind, rather than allowed to
  hold the window hostage.

## Shell

`src/shell/WindowRoot.tsx` is one Veistra window. The frame is a title bar, a
switcher bar, the tool window, a terminal band and a status bar. Each region
lives in its own directory and is built against `src/shell/contract.ts`.

The switcher holds this build's own apps and nothing else. The tools are
resolved and still reported, and the warning badge and its health list read the
full stack. No tool is docked yet. A tool's core is a child process, the broker
that would reach it is not written, and no project exists to open one against. A
tool tab today could only open on a state explaining why it is empty. Tool tabs
come back when the broker does.

## Apps

`apps/` holds the surfaces the orchestrator ships itself: Home, Files, the file
viewer, Docs and Design Mode. They mount in the same tool window a tool
would. They speak the same transport to the shell, and they import the same
`@veistra/bridge`.

Their frontends are entry points of *this* repository's Vite build, and their
Rust halves are modules in `src-tauri/src/apps/`. The shell reaches them
in-process rather than over a pipe. A tool is code the orchestrator finds; an
app is code the orchestrator is. `apps/README.md` has the full comparison and
the reasoning.

## Tools

The protocol is built ahead of the first real tool. `examples/echo-tool` is what
it is tested against: a complete tool in miniature, with a `veistra-tool.toml`, a
core that speaks JSON-RPC over its standard streams, and a frontend whose only
host coupling is `@veistra/bridge`. Copying it is the intended way to start a tool
repository.

Two transports meet in the shell. The frontend talks to the shell over window
messages. The shell talks to the core over the child process's standard
streams. Tool code sees neither. Tool code calls `invoke("echo", ...)` from the
bridge and gets an answer, under either host.

The broker that joins those two transports is not built yet, so the shell's tool
surface is still blank. `crates/veistra-rpc` is the shell's half of the second
transport, and `packages/bridge` is the tool's half of the first.

[The tool protocol](../tool-protocol.md) is the whole contract: the wire format,
and the reasoning behind each rule that has one.

## Adding a command

Write the command in `src-tauri/src/commands.rs`. Register it in the
`generate_handler!` list in `src-tauri/src/lib.rs`. Add a typed wrapper in
`src/bindings.ts`.

The TypeScript types in `src/bindings.ts` are a hand-maintained mirror of the
Rust structs. Keep the two in sync.

## Running and verifying

```sh
pnpm install          # frontend dependencies
pnpm app              # run the desktop app (tauri dev)
pnpm verify           # the gate: build, test, lint, format
```

The first `pnpm app` compiles the whole Rust dependency tree and takes several
minutes. Later runs are incremental and fast. Editing anything under `src/`
hot-reloads. Editing anything under `src-tauri/src/` recompiles and restarts the
app.

There is no separate "build the frontend" step for running the app. `pnpm build`
and `pnpm dev` are only the frontend half, and `tauri.conf.json` invokes them
through `beforeDevCommand` and `beforeBuildCommand`. Use the two `app` scripts.

`CONTRIBUTING.md` covers `pnpm verify` in full: what the four checks are, what
`pnpm verify:fast` is and is not for, and what the three lint baselines exist to
prevent.

One note that belongs with the code rather than the contributing guide. `cargo
clippy` replays cached diagnostics, and will report "Finished" in well under a
second without rechecking anything. Run `cargo clean -p <crate>` first to force a
real check of a crate you just changed. That rebuilds only that crate, not the
dependency tree.
