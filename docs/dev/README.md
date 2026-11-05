# Developing Veistra

This section is for someone working on the orchestrator's code, not someone
running the app. If you want to use Veistra instead, see
[the user docs](../user/README.md).

The prose these pages are built from already lives in this repository, close
to the code it describes. Rather than duplicate it — and have two copies
drift apart — this page is a map to where it actually is.

## Making a change

Start with [CONTRIBUTING.md](../../CONTRIBUTING.md) at the repository root.
It covers, in order: getting a build, why `pnpm verify` is a gate rather than
a suggestion (and what `pnpm verify:fast` is and is not for), the two rules
most reviews turn on, commit message style, and what a pull request will not
be accepted for. Read it before your first change — it is written for someone
who has never seen the repo.

## How the project works, technically

- **[How the orchestrator is built](architecture.md)** — the tech stack, the
  stack manifest, the directory layout, what a project is, the startup
  sequence, the shell, the apps, the tools, and how to add a command. This is
  the page that used to be most of the root `README.md`.
- **[STANDARDS.md](../../STANDARDS.md)** — the rule book. Layering (what may
  import what), the two files that exist purely as chokepoints, the
  app/tool distinction, comment conventions, Rust and TypeScript style, test
  expectations, and exactly what is mechanically enforced versus what is
  still a convention.
- **[The tool protocol](../tool-protocol.md)** — the wire contract between
  the orchestrator and a tool: the exact bytes, the exact field names, and
  the reasoning behind each rule that has one. This is the API every tool
  repository is built against.
- **[Porting a repository to Schematify](porting-a-repo-to-schematify.md)** —
  what the `.veistra/` on-disk contract actually is, which file decides each part
  of it, the thirteen linter rules a finished tree has to satisfy, and how this
  repository was ported to itself. Written while doing it, so it also records
  what the repository does *not* document, which is the list a future skills
  server has to fill.
- **[Design notes](../design-notes/)** — longer rationale that would have
  overrun a module's comment budget: why a mechanism is shaped the way it
  is, and what was considered and rejected. One page per area, e.g.
  `shell-state.md`, `backend-project.md`, `files-app.md`.
- **[Windowing: what was wrong](windowing-investigation.md)** — the pane-tree
  defects behind issue #45, why every existing test passed over them, and the
  three hypotheses that were looked at and deliberately left alone.
- **[Settings](../settings.md)** — what a setting costs to add, and the rule
  that a row writing a value nothing reads is worse than no row at all.
- **[The Files app's methods](../files-app-methods.md)** — the RPC surface a
  frontend, or an agent, uses to browse, edit and delete files.
- **[The MCP server manager](../mcp-server-manager.md)** — how Veistra hosts
  MCP servers for a coding agent, and the rule that decides what earns one.
- **[Docs](../docs-app.md)** — how the in-app Docs pane reads
  [veistra.com/docs](https://veistra.com/docs) live, what it does offline, and
  what the website must keep serving for installed builds. The docs and
  tutorials themselves are written on the website, not in this repository.
- **[Branding](../branding.md)** — which names are branding (configurable)
  and which are wire formats (frozen), and the two scripts that enforce the
  distinction.

## Releases and updates

**[Releases and updates](releases.md)** is how a build reaches a person: tag,
build on GitHub, review the draft, publish. It also covers where the version
lives — `package.json`, once, with everything else inheriting or checked — and
what still does not exist (signing, an updater).

## Where this is all going

**[`TODO.md`](../../TODO.md)** is the roadmap, and it is the only forward-looking
document that is kept current. It says what has landed, what is being built now,
and what is deliberately still ahead — including which pieces the maintainer is
building directly rather than farming out.
