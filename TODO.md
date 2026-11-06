# Veistra Roadmap

Rough execution order. Items are mostly sequential; a couple are explicitly
parallel or vague-on-purpose (noted inline). Updated 2026-08-21.

## Known issues (open)

Reported by Braden on 2026-11-04. Pick one up by name; each needs scoping
before it is built.

1. **There is no Veistra harness yet.** Agents run inside whatever harness the
   terminal or agent tab launches; Veistra has no agent harness of its own.
2. **Login and usage: wired, not yet checked on Windows.** The app now defaults
   to the live account service and to `veistra.com`, and the service
   answers usage and runs (`docs/account-api.md`). Still open: one sign-in in a
   real Veistra from a clean profile, sign-out, and a restart that stays signed
   in; and recording runs (`POST /v1/runs`), without which the usage page's
   run counts stay at zero. Billed totals stay at zero until the gateway exists.
3. **Agents output only scripts, not the finished artifact.** Asked for a game
   (Elijah's game, for example), an agent writes the scripts and stops: there is
   no built, runnable result at the end. The deliverable should be the artifact
   itself, not only the code that would produce it.
   *In progress.* Elijah's agent (agent tab, Claude, developer mode off, a
   prompt naming Godot, an empty folder) left only `.gd` files: no scene and no
   main scene, though both are text it could write. That is guidance, so the
   first fix is the `finish-godot-game` built-in skill, plus `VEISTRA_GODOT` so
   the agent can import, check (`scripts/check_game.gd`), run and capture its
   game from its own shell. Still open, pending Braden: tools any agent can
   call to run the game in the Play pane, read its log and capture a frame, and
   the same treatment for Blender assets.

## Done

Kept rather than deleted, because the order things landed in is the argument
for the order the rest should land in.

| # | What | Landed as |
|---|---|---|
| 1 | Clustering & app system — panes, clusters, many instances of one app | #7, #8 |
| 2 | Lint rules, enforced on new code with the old grandfathered | #10 |
| 3 | Search feature + Git sidebar, worked in parallel on one branch | #9 |
| 4 | MCP server manager, and the settings UI to manage what registers | #11 |
| 5 | Full settings & preferences menu, generated from a schema | #11 |
| 6 | Tutorials & documentation | #12, #13 |
| 8 | Codebase cleanup & standards — grandfather clause lifted | #12 |

The lint grandfather clause from #2 is gone: all three baselines are empty, so
a violation today is a violation rather than a number to compare against.

## 7. Bug-fix pass

The one item out of order, and deliberately so — it now runs *alongside* #9
rather than before it. Sweep and fix small outstanding issues, but **file the
small ones as GitHub issues instead of fixing them**. A public repository with
an empty tracker gets stars and no pull requests, and this pass is the only
source of `good-first-issue` material that will exist on day one.

An issue that gets a first pull request names the file, describes the wrong
behaviour and the right one, and says which check proves it. Eight to twelve is
enough to seed a tracker.

## 9. Contributor readiness (done)

The repository is public, as `Firelight-Innovations/Veistra`. Landed:
Apache-2.0 with the marks held back, CI running `pnpm verify` on every pull
request and annotating each failure on the line that caused it, a dependency
audit, `CONTRIBUTING.md` and a code of conduct, a frontend test harness, a
tool-protocol stability statement, and the branding system that makes the
trademark line something a fork can act on.

`main` is protected: `verify` and `deny` are required, approvals are zero
because requiring one with a single maintainer would mean nothing can ever
merge, and admins are exempt so a hotfix is still possible. Tighten the last of
those when there is a second maintainer.

`docs/handoffs/` has been removed. It was working material — a brand packet, a
shell spec, agent coordination notes — and none of it was written to be read
from outside the project. It is gone from HEAD only; removing a file in a commit
does not remove it from history, so a fresh squashed history is still the only
way to make it unreachable, and that remains an open call.

Still open:

- Whether the public repository starts from a fresh squashed history.
- What to do about the placeholder stack repositories. They are a `v0.1.0` tag
  against a README, and the README now says so.
- The issue backlog from #7, which is what a first-time contributor actually
  needs and does not exist yet.

## 9b. Release pipeline (done)

Tagging `v*` builds on `windows-latest` and publishes a **draft** GitHub
Release with the MSI and the NSIS setup attached. `workflow_dispatch` runs the
same build without a tag, for changing the workflow without spending one.

The version now lives in `package.json` alone. `tauri.conf.json` reads it
through Tauri's own `"../package.json"` indirection, `src-tauri/Cargo.toml`
inherits it from the workspace, and `scripts/check-version.mjs` — in
`pnpm lint` — catches the one remaining copy drifting, plus any commit that
turns an indirection back into a literal.

Not done, and deliberately: **signing**. Unsigned installers hit SmartScreen,
every release says so in `.github/release-preamble.md`, and a certificate is a
purchase rather than a configuration. The **updater** waits on releases
happening at a cadence rather than one at a time.

## 10. App download system (done)

Landed as #23 and #27. An app arrives one of three ways — from the curated
library, from a GitHub repository named by the user, or from a folder on this
machine — and nothing else. `docs/design-notes/app-library.md` has why there are
exactly three.

`veistra-tool.toml` grew surfaces, so one repository holds several apps and a
backend-only package declares none. The broker relays a surface's `invoke` to
its own package's core, which was specified at v1 and had never run. A folder
install is watched, so a rebuilt core restarts without anyone asking.

`catalog.toml` is the library, compiled into the binary. It is **not** a
permission boundary — any repository or folder still installs — but an entry
marked `default = true` installs on a first run without being asked, and a
plugin core is unsandboxed. `scripts/check-catalog.mjs` therefore fails any pull
request touching it unless the maintainer wrote it.

**Two of its questions were pulled forward into #9** and are answered in
`docs/tool-protocol.md`: a release artifact rather than a clone, and what a
mounted tool is permitted to do. The second is answered honestly rather than
comfortably — a core holds the user's full privileges, `[permissions]` still has
no schema, and installing an app is running arbitrary code.

Still open from this item:

- **`[permissions]` has no schema.** The broker shipped first on the grounds
  that the plugin population is one and in-repo. That expires the moment
  somebody outside Veistra writes an app.
- **Layout presets cannot hold a plugin surface.** `presets::normalized` filters
  slots through `is_app`. Not a regression — presets never held a tool either —
  but it bites the first time somebody saves a preset with an installed plugin
  in it. Schematify no longer triggers this: it moved to `apps/`
  (see #11), and `is_app` already covers it.
- **A backend-only package installs and spawns, but nothing calls it.**
  `mcp::Registry` holds `&'static` servers, so a plugin-provided MCP server
  cannot be one. The manifest reserves the space; the plumbing does not exist.

## 10b. Publish `@veistra/bridge` to npm

**Nothing outside this repository can build an app frontend until this is done.**

### Why

`docs/tool-protocol.md` §5 says a tool frontend's *only* host coupling is
`@veistra/bridge`, and `.github/CODEOWNERS` calls it "the npm package a tool
author actually installs". It is not published — `npm view @openkaava/bridge` (now
`@veistra/bridge`) is a 404 as of 2026-08-21 — so there is nothing to install, and
the sentence in the protocol document is currently false.

That is what stopped the Schematify scaffold from landing with #27, back when
its two predecessors were planned as separate repositories that would install
like any other tool. That is no longer why it waits: it has since been
reclassified as an in-repo app under `apps/` (see #11), which pulls
`@veistra/bridge` from the pnpm workspace rather than from npm, so it is not
blocked on this item any more. This still blocks the first genuinely
third-party tool repository, which is the case it was written for.

A git dependency is not a workaround here. `packages/bridge` publishes `dist`,
which is built rather than committed, so installing from the repository would
need a `prepare` script and a build of the whole workspace to get one small
package. The Rust half has no such problem — `veistra-rpc` resolves fine as a git
dependency against a public repo — which is why only the frontend is blocking:

```toml
veistra-rpc = { git = "https://github.com/Firelight-Innovations/Veistra.git" }
```

Publishing `veistra-rpc` to crates.io is tidier and optional. This is neither.

### How

1. **Confirm the `@veistra` scope is ours.** Unverified — npm was not
   authenticated on the machine this was written on, so `npm whoami` returned
   `ENEEDAUTH` and nothing about ownership could be established. `npm login`,
   then `npm org ls veistra`. If the scope is taken by someone else, the package
   name is the decision to make before anything else, and it reaches
   `tool-protocol.md`, `CODEOWNERS` and every app repository that ever installs
   it.
2. **Add the two missing fields** to `packages/bridge/package.json`:
   `"publishConfig": { "access": "public" }` and a `"repository"` entry. Without
   the first, a scoped package publishes as restricted, which needs a paid org
   and would fail for every outside contributor. The rest of the manifest is
   already publishable — name, description, license, `types`, `exports` and
   `files` are all correct.
3. **Decide what its version tracks.** It is `0.1.0` while the workspace is at
   `0.1.2`. The bridge implements transport B, which is versioned by the
   *protocol* rather than by the application, and `scripts/check-version.mjs`
   deliberately does not police this file. Pinning it to the app version would
   tie a wire format to a UI release; say which it is in the package and in
   §6 of the protocol document, and keep the two agreeing.
4. **Publish.** `pnpm --filter @veistra/bridge build`, then
   `npm publish --access public` from `packages/bridge`. First publish by hand
   is fine; automate it on a tag afterwards, which needs an `NPM_TOKEN` secret
   and a job that refuses to publish a version already on the registry.
5. **Then scaffold the first genuinely third-party tool**, whenever one shows
   up. `docs/dev/app-releases.md` carries the manifest shape and the exact
   release workflow a separate repository needs — zip plus `.sha256`, no
   installer, published as a draft. Schematify no longer goes through this
   path; see #11.

### Also outstanding, and unrelated to npm

**`.github/CODEOWNERS` is inert.** Every rule assigns to
`@Firelight-Innovations/maintainers`, and that team does not exist — the
organisation has no teams at all — so no rule in the file matches anybody. On
top of that, `main`'s protection has `required_pull_request_reviews` set to
null, so code-owner review is only *requested*, never enforced.

This matters more than it looks. A `pull_request` workflow runs the pull
request's own code, so `check-catalog.mjs` can ultimately be edited by the
change it is checking; CODEOWNERS is the only boundary GitHub evaluates
server-side, out of reach of the branch. Create the team, add the maintainer,
and turn on "Require review from Code Owners".

## 11. Schematify

**No longer vague.** This item used to track two separate, undefined
placeholders — one for the technical design tool, one for the product design
tool, each planned as its own repository installed like any other tool. The
overnight Schematify build (`docs/design/SCHEMATIFY-PRD.md`) replaced both
with one specced application, folded into one rather than two — see that
document's §1.3 for why.

**No longer blocked on #10b.** It is an in-repo app under `apps/schematify/`,
alongside Home, Files and the rest, whose frontend pulls `@veistra/bridge`
straight from the pnpm workspace rather than from npm — see `apps/README.md`.
#10b still stands, and still blocks the first genuinely third-party tool
repository; it just no longer blocks this one.

**Built by the maintainer, like #10.** Not because outside help is
unwelcome — so that nobody spends a weekend on a foundation that is already
half-written. Once it exists, features and quality-of-life work on top of it
is where an outside change lands best, and a roadmap and a set of starter
issues are coming to say where. This is stated in `CONTRIBUTING.md` and in the
"What should we build next?" discussion, and the two places should keep
agreeing.

Scope is no longer undefined: `docs/design/SCHEMATIFY-PRD.md` §17 lays out
the build waves, from the rename and scaffold through the
Schematic engine, the linter, and reconciliation with running code. One idea
carries over from the old placeholder text: the architecture linter and
Schematify's own editor are the same boundary model, one checking it and one
authoring it, and building the checker first is what forces the model to be
precise before it has to be pretty.

---

*Big-picture goal: get Veistra into the best agentic development environment
(ADE) shape possible, done properly, efficiently, and ready for open source.*
