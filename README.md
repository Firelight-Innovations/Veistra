<div align="center">

<img src="assets/veistra-icon-256.svg" alt="Veistra" width="120" height="120">

# Veistra

<p>
  <strong>An Agentic Development Environment (ADE).</strong><br/>
  Built for game development, and general enough for any project.<br/>
  Clusters, an agent tab, terminals, a design canvas, Godot, Blender, and your coding agents in one window.
</p>

<p>
  <a href="https://github.com/Firelight-Innovations/Veistra/actions/workflows/verify.yml"><img src="https://github.com/Firelight-Innovations/Veistra/actions/workflows/verify.yml/badge.svg" alt="verify workflow status" /></a>
  <a href="https://github.com/Firelight-Innovations/Veistra/stargazers"><img src="https://img.shields.io/github/stars/Firelight-Innovations/Veistra?style=flat&label=%E2%98%85&color=08C" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-08C?style=flat" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-4493F8?style=flat" alt="Platform: Windows" />
  <a href="#status"><img src="https://img.shields.io/badge/status-alpha-yellow?style=flat" alt="Status: alpha" /></a>
</p>

<p>
  <a href="docs/user/tutorials/README.md"><ins>Tutorials</ins></a> &middot;
  <a href="docs/user/README.md"><ins>User docs</ins></a> &middot;
  <a href="docs/dev/README.md"><ins>Developer docs</ins></a> &middot;
  <a href="https://github.com/Firelight-Innovations/Veistra/discussions"><ins>Discussions</ins></a>
</p>

</div>

---

## What Veistra is

Veistra is an Agentic Development Environment (ADE): a desktop app that puts
your terminals, your files, a design canvas and your game tools in one window,
beside the coding agents you already use (Claude, Codex).

It is built for game development first. The Godot and Blender integrations and
the design canvas exist because that is the work it was made for. The rest
(clusters, terminals, files, git, MCP servers) is not tied to games, so with
some tweaks it works for ordinary software too.

Coding agents are limited by two things: the context they are given, and
whether they can check their own work. Without those, you do both by hand, and
every loop waits on you. Veistra supplies both, so the agent can close the loop
itself.

![A funnel: a very capable model narrows to a neck made of context and validation, and Veistra widens that neck](assets/bottleneck.svg)

Veistra is a development tool. It does not run the software you build with it.

## Status

Veistra is **alpha**. The features below run today, but expect rough edges,
changing behavior and bugs. It is Windows only. Parts marked **preview** or
**coming soon** are not finished, and the list is plain about which is which.

## What it does

### Clusters, worktrees and agent terminals

A cluster is one workspace: a project, a git worktree, and its own layout of
panes and terminals. Split panes freely and run Claude Code or Codex in a
terminal pane. Switch clusters and the panes and terminals swap together. The
main branch is read-only; work happens in worktrees, so several agents can work
on one repository without colliding.

![A cluster for a Minecraft-clone project: the design canvas, a Godot viewer with a running scene and its log, and the file explorer](assets/ui/godot-cluster.png)

A terminal pane has a context strip beside it. Items you keep from the canvas,
Godot or Blender (a rendered view, a canvas frame) collect there as thumbnails,
and you insert them at the agent's prompt in the form the agent can read.

![A terminal pane with the context strip: kept renders and canvas views, ready to insert at the agent's prompt](assets/ui/terminal-pane.png)

### Agent tab

The agent tab is a chat with a coding agent, built into the window. Pick a
harness (Veistra's own, Claude or Codex) and a mode before the session starts,
and Veistra can install a harness you are missing from the tab itself.
Type `@` to attach files and other context as chips, use slash commands with
autocomplete, rename sessions, and reopen previous ones. Built-in skills, such
as the one for drawing canvas designs, can be switched on in Settings.

### Design canvas

The canvas is where you and your agents draw designs. Frames nest into
sub-canvases, so a game's design can be split into one canvas per system. Each
frame can carry a spec card, and the asset list gathers what the design needs
to have built.

Leave comments on the canvas and they go to your agents, which read them, edit
the drawing and reply: a comment loop between you and the agent. Settings
control the level of detail and the drawing style agents use, and a design-agent
prompt tells an agent how to draw.

![The canvas overview with the Minecraft-clone design split into numbered frames](assets/ui/canvas-overview.png)

![A sub-canvas: the crafting design with recipes, a tech tree and the inspector](assets/ui/canvas-subcanvas.png)

![Settings, Canvas: level of detail and drawing style for agents](assets/ui/settings-canvas.png)

### Godot

Veistra drives the headless Godot CLI. You need Godot installed; Veistra
does not bundle it.

- **Godot Viewer** shows the scene tree and a 3D preview. The preview is
  approximate, not Godot's own renderer.
- **Open in Godot** hands the scene to the Godot editor.
- **Send to agent** puts a scene tree or log on the agent's context.
- **Play** runs the project's main scene in the pane itself, and records each
  run as a take you can review, with notes the agent can read, so a bug found
  in play can go straight into the fix loop.

### Blender

Veistra drives headless Blender. You need Blender installed.

- **Blender Viewer** exports a `.blend` to `.glb` and shows the model, with a
  parts list and renders.
- **Markup and Send to agent** let you mark up a view and send it to an agent.
- **Open in Blender** opens the file in Blender itself.

![The Blender Viewer in the full window: an exported room model with its parts list, beside the Godot viewer and file explorer](assets/ui/blender-viewer.png)

### Files, context and sending things to agents

The File Explorer and File Viewer open any project file. Files, scenes, logs,
takes and canvas selections can be kept as **context items** and sent to an agent
with **Send to agent**, instead of pasted into a terminal by hand.

### Plane project management

The Projects page shows the work items of a Plane workspace, so planning sits
next to the work. **Preview / coming soon:** it reaches Plane through the
Veistra Cloud gateway, so it needs a cloud setup that is not generally
available yet. The screenshot shows fixture data, not a live workspace.

![The Plane page listing a workspace's projects, from fixture data (preview, coming soon)](assets/ui/plane-projects.png)

### MCP servers

Veistra hosts MCP (Model Context Protocol) servers and writes them into
`.mcp.json`, so your coding agent can call them. They cover the canvas, the
workspace and design tools. Each server has its own switch under
Settings, MCP servers. [The MCP server manager](docs/mcp-server-manager.md)
explains each one.

![The MCP servers settings section: the Canvas and Workspace servers, each with its route, tool count and a switch](assets/ui/mcp-servers.png)

### Cost tracker

The Cost Tracker estimates what your Veistra Cloud resources have cost this
month at list price, forecasts the month against a budget, and shows what
Google has billed beside it. An estimate, not a bill. **Preview / coming soon:**
it is only useful with a cloud setup, and the screenshot shows fixture data.

![The Cost Tracker with fixture data: estimate, forecast, budget and charts (preview, coming soon)](assets/ui/cost-tracker.png)

### Search, git and settings

`Ctrl+K` searches the project, `Ctrl+Shift+P` opens the command palette and
`Ctrl+,` opens Settings from anywhere. A source control panel shows branch,
staged and unstaged changes, and takes a commit message. Every setting comes
from one schema.

### Usage data

Veistra can send anonymous usage data, session recordings and feedback through
PostHog. It is **opt-in**: nothing is sent, and the PostHog SDK is not even
loaded, until you say yes. [Usage data and feedback](docs/telemetry.md) lists
exactly what is sent.

## Coming soon

- **Cloud agents.** Running agents on cloud machines, with a page to watch
  their sessions, machines and workflows. This is **not shipped**. A preview
  exists, but it is not usable yet.

![The Cloud agents page with fixture data: agents, sessions and a transcript (preview, coming soon)](assets/ui/cloud-agents.png)

## Known limits

- **Nothing is signed.** Windows SmartScreen warns about the installer. You
  have to click through it.
- **Windows only.** macOS and Linux are untested, not excluded.
- **Godot and Blender previews are approximate.** Open the real editor for
  anything that has to be exact.
- **Help, Documentation** has nothing published to point at yet.

## Install

**[Download Veistra for Windows](https://github.com/Firelight-Innovations/Veistra/releases/latest/download/Veistra-setup.exe)**

Run the installer. It does not ask for administrator rights. It installs for
your account only. Veistra also fetches the WebView2 runtime for you, if your
machine does not already have it.

> **Windows will warn you. You can go ahead.** The installer is not signed.
> SmartScreen shows "Windows protected your PC" and hides the button. Click
> **More info**, then **Run anyway**. A signing certificate costs money that an
> alpha does not yet justify. [Releases and
> updates](docs/dev/releases.md#what-still-does-not-exist) explains what
> signing would and would not fix.

After installing, right-click any folder in Explorer and choose **Open with
Veistra**. Veistra opens the folder as a project. The same entry appears on files.
A file opens in the File Viewer, with its folder as the project.

## Build from source

Use this option to build Veistra yourself, or to contribute code to it.

Every prerequisite below is a Windows prerequisite. Install each one once.

- **Rust** (stable): `winget install Rustlang.Rustup`
- **MSVC build tools**: install Visual Studio Build Tools 2022. Choose the
  *Desktop development with C++* workload. Rust needs the MSVC linker on
  Windows.
- **WebView2 runtime**: Windows 11 already has this.
- **Node 20+** and **pnpm**: run `npm i -g pnpm`.

Then run:

```sh
git clone https://github.com/Firelight-Innovations/Veistra.git
cd Veistra
pnpm install
pnpm app
```

The first `pnpm app` command compiles the whole Rust dependency tree. This
step takes several minutes. Later runs are fast.

## Learn your way around

[Ten short tutorials](docs/user/tutorials/README.md) cover the window, your
first project, panes and clusters, terminals, search, settings, files and
editing, git and worktrees, MCP servers, and the stack. Veistra ships the same
pages in its own Tutorials tool. Read each tutorial beside the thing it
describes.

Start with [The Veistra window](docs/user/tutorials/the-window.md).

## The stack

Veistra's own tools are apps inside this repository, under `apps/`, and ship
in the same binary as the window. A third-party tool can live in its own
repository instead, pinned to an exact version in `veistra.toml`. Nothing is
pinned today, so the switcher bar's health badge stays silent.
[The stack, end to end](docs/user/tutorials/the-stack.md) explains how to read
that badge once something is pinned.

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It
explains how to get a build running, the four checks every pull request must
pass, and what we will not accept.

Then read the [developer docs](docs/dev/README.md). These pages cover the
technical details:

- [How the orchestrator is built](docs/dev/architecture.md)
- [The rule book](STANDARDS.md)
- [The tool protocol](docs/tool-protocol.md)
- [What exists around releases](docs/dev/releases.md)

The maintainer builds the core directly, including the app download system and
the design canvas. This is not a closed door. Nobody should spend a weekend on a
foundation that already has an owner. Outside contributions fit best as
features and quality-of-life work on top of it. A roadmap and a set of starter
issues are coming. They will point to exactly where.

Found a bug? Open an issue. Want something that is not here? Open an issue
too. Want to talk about an idea first? Open a
[discussion](https://github.com/Firelight-Innovations/Veistra/discussions).

## License

Veistra uses the Apache-2.0 license. [LICENSE](LICENSE) has the full text.
[NOTICE](NOTICE) is the file that a redistributor must carry with it.

Veistra uses Apache, not MIT, because of the patent grant. Third-party tools
load into Veistra through the tool protocol. MIT says nothing about patents.
Veistra does not use GPL or AGPL, under any circumstances. A copyleft license
would give someone a real argument that private tools mounting into Veistra are
derivative works.

The license covers the code. It does not cover the names. Veistra and
the marks that go with it are trademarks of Veistra.

You can fork Veistra. You can sell what you build on it. State plainly that your
work is based on Veistra. All of that is fine.

Do not ship your fork as Veistra itself. The code is free to copy. The name is
not. The name tells a user which build runs the tools on their machine.
