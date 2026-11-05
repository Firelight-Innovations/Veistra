# Agent host: pinned versions

The versions each harness was tested with, on Windows 11. Each harness's descriptor in
`crates/veistra-agent-host/src/harness/` pins its adapter's version, and only that one. Another
adapter version still runs, and the tab shows the `adapterVersion` hint for it. The program rows
record the version that was tested; nothing pins or checks them. See `docs/agent-harnesses.md`.

| Harness | Program | Version | Source | Tested |
|---|---|---|---|---|
| Claude | `claude` | 2.1.296 | the user's own install | 2026-10-14 |
| Claude | `@agentclientprotocol/claude-agent-acp` | 0.90.0 | the user's global npm install, `--omit=optional` | 2026-10-14 |
| Codex | `codex` | 0.153.0 | the user's own install | 2026-10-14 |
| Codex | `@agentclientprotocol/codex-acp` | 2.2.2 | global npm or worktree-local `pnpm setup:codex`, `--omit=optional` | 2026-10-25 |
| Veistra | `@veistra/agent` | 0.1.0 | this repository (`packages/veistra-agent`); not yet published to npm | 2026-11-05 |
| Veistra | `@earendil-works/pi-coding-agent` (Pi) | 1.5.0 | pinned exactly in `@veistra/agent`'s dependencies | 2026-11-05 |

Codex was tested through `initialize`, `session/new`, read-only mode, model selection and reasoning
effort selection (`gpt-6-astra`, `high`), so no prompt spent the user's quota.
The adapter is built against `@openai/codex` 0.160.1, and its handshake works with 0.153.0. A full
turn is still to be run by the owner.

Veistra's own harness was tested on Linux with Node 22.23, not yet on Windows 11: the package's
end-to-end tests and `crates/veistra-agent-host/tests/veistra.rs` drive the real agent, Pi
included, through whole turns, with only the model scripted. No turn has reached a real model
provider yet; that and the tab on Windows are the owner's to run.
