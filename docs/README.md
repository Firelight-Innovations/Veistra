# Documentation

Two audiences, two sections.

## [Using Veistra](https://veistra.com/docs)

For someone who wants to run Veistra and learn their way around it: the user
docs and tutorials live on the website, at <https://veistra.com/docs>. The Docs
app inside Veistra (Help ▸ Documentation) reads the same pages from there, so
they are never out of date with the site.

## [Developing Veistra](dev/README.md)

For someone working on the orchestrator's own code: how to open a pull
request, how the project is laid out and why, and what is and is not built
around releasing it.

## Everything else in this folder

The pages above are a map, not a copy — most of the source material lives
directly in this `docs/` folder or at the repository root, and the section
indexes link out to it rather than duplicating it. If you're looking for a
specific technical document and don't see it linked from either section
above, it is probably still here:

- [`tool-protocol.md`](tool-protocol.md) — the wire contract between the
  orchestrator and a tool.
- [`branding.md`](branding.md), [`settings.md`](settings.md),
  [`telemetry.md`](telemetry.md),
  [`mcp-server-manager.md`](mcp-server-manager.md),
  [`files-app-methods.md`](files-app-methods.md),
  [`docs-app.md`](docs-app.md) — one document per subsystem.
- [`design-notes/`](design-notes/) — longer rationale moved out of module
  comments, one page per area.
- [`../TODO.md`](../TODO.md) — the roadmap: what has landed, what is being
  built now, and what is still ahead.
