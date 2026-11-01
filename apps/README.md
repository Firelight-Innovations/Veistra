# Apps

The surfaces the orchestrator ships itself.

An app and a tool look identical in the shell — a tab in the switcher bar, an
iframe in the tool window, `@veistra/bridge` in the frontend. The difference is
where the two halves come from, and it decides everything else:

| | Tool | App |
|---|---|---|
| Lives in | its own repository, cloned beside this one | `apps/` in this repo |
| Frontend built by | its own Vite project | this repo's `vite.config.ts` |
| Frontend served from | its dev server, or `veistra-tool://` | the shell's own origin |
| Rust half | a child process, over the standard streams | a module in `src-tauri/src/apps/` |
| Can be | missing, unbuilt, the wrong version | none of those — it is in the binary |

So a tool is code the orchestrator *finds*, and an app is code the orchestrator
*is*. Home and Files are apps because what they show is what the orchestrator
already owns: the stack it resolved at boot, the checkout it was pointed at, the
project it will one day open. Putting a process boundary between the shell and a
program that would only ask the shell for all of that again is shipping an IPC
hop in order to talk to ourselves.

`docs/tool-protocol.md` is still the contract for the half that matters to the
frontend. An app's UI calls `invoke("files/list")` through the bridge exactly as
the echo tool's UI calls `invoke("echo")`, and neither knows which kind of host
answered — which is what would let an app be extracted into a tool repo later, or
a tool be absorbed, without its interface code changing.

## Layout

```
apps/
  shared/                 code more than one app imports: app.css, the comment
                          model (comments.ts), CommentPanel.tsx, SegmentedControl.tsx, age.ts
  home/ui/                Home's frontend
  files/ui/               File Explorer's frontend
  viewer/ui/              File Viewer's frontend
  tutorial/ui/            Tutorials' frontend
  agent-tab/ui/           Agent's frontend: one Claude session in this cluster's worktree
  agents/ui/              Agents' frontend: Veistra Cloud's agent machines and sessions
  costs/ui/               Cost Tracker's frontend: this month's Google Cloud spend and forecast
  projects/ui/            Projects' frontend: the project switcher and its embedded Plane workspace
  design/ui/              Design Mode's frontend
  schematify/ui/          Schematify's frontend
  godot-viewer/ui/        Godot Viewer's frontend: the scene an agent's headless Godot run last produced
  blender-viewer/ui/      Blender Viewer's frontend: the .glb an agent's headless Blender export last produced
  play/ui/                Play's frontend: run the environment's debug build and capture a comment on it
  canvas/ui/              Canvas's frontend: Excalidraw design canvases, one JSON file each in the checkout
```

`apps/shared/` is deliberately outside the app-isolation rule ESLint enforces between the apps above
(`eslint.config.js`'s `APPS` array) — see "Comments", below, for why the Godot Viewer, the Blender
Viewer and Play needed one.

Each app's Rust half lives in `src-tauri/src/apps/<id>.rs`, and
`src-tauri/src/apps/mod.rs` is the registry that names it, describes it for the
switcher, and routes `invoke` to it. Adding an app means one entry there and one
`index.html` here — plus a line in `vite.config.ts`, which is the one piece that
cannot be inferred (Vite has to be told about every HTML entry point, or it
silently builds none of it).

There is no `package.json` under `apps/`. These are entry points of the
orchestrator's own frontend build, not workspace packages: `apps/home/ui/
index.html` is built to `dist/apps/home/ui/index.html` and served from there, so
one URL works under the Vite dev server and under Tauri's asset host alike.

## Running them

Nothing extra. `pnpm app` serves the apps from the same Vite server it serves the
shell from, and `pnpm dev:agent` does the same in a plain browser.

An app mounted in a browser draws itself and completes the `hello`/`ready`
handshake, because both of those are the shell's own work. What it cannot do is
reach Rust: there is no backend under a plain browser, so every `invoke` fails
and the app renders its failure path. A fixture answering those calls used to
live in `src/shell/state/fakeBackend.ts` and has been removed.

## Reporting in at startup

Every app owes the shell one thing beyond drawing itself: a call to
`reportPainted()` from `@veistra/bridge` once its first meaningful content is
committed to the DOM.

The orchestrator's splash window stays up until every app in the registry has
sent one (`src-tauri/src/boot.rs`), which is what makes the first frame after
the splash the app itself rather than a boot overlay that resolves into it a
beat later. The apps are already loading the whole time — the main window is
created hidden and its iframes mount as soon as the app list arrives — so this
costs nothing except the discipline of reporting at the right moment.

The right moment is the *content*, not the call that fetched it: Home reports
when `home/state` has landed and been rendered, Files when the tree has rows.
An error state counts, and reporting it is not a failure — a screen saying it
could not read anything is finished, and holding the window back for one that
is never going to improve only makes the bad news slower to arrive.

An app that never reports is waited on for four seconds, logged, and left
behind. So forgetting the call costs a slow start, not a hang — but it does cost
a slow start, which is why it is in this list rather than in a comment.

## Reporting usage

An app reports what people do with it through `apps/shared/telemetry.ts` —
`track("exported", { format: "png" })` — and opens the feedback dialog about
itself with `openFeedback()`. Both go to the shell over the bridge, which
decides whether anything is sent and which feature the app reports for. For an
app's events to be accepted, a feature in `src/shell/telemetry/features/` has to
list the app in its `apps` and declare the event; `docs/telemetry.md` §4 and §5
are the walkthrough.

## Apps talking to each other

An app's calls go *down* to its Rust half, and for a long time that was the only
direction there was. Two of them now need to reach each other instead: clicking
a file in File Explorer has to put it on screen in File Viewer, which is a
different app, in a different iframe, that the Explorer cannot see and must not
be able to address.

`veistra/open` and `veistra/publish` are that, and they are host business — the
shell routes them, exactly as it answers `veistra/painted` and `veistra/commands`,
and it does so without understanding either. An `appId` is matched against the
layout; a `topic` is a `Map` key. No payload is inspected and no intent is
enumerated, so two apps can agree on a new thing to say to each other without a
line changing in `src/shell/`. `docs/tool-protocol.md` §3 is the contract.

The rule that makes it safe is the one every message on this transport already
follows: the shell resolves *which frame is asking* from `event.source` against
its own map of mounted iframes, never from anything in the message. An app can
therefore only ever reach its own cluster, and can only name a **kind** of app
rather than a particular surface — which surface answers is a fact about the
layout that only the shell can see.

## The six apps

**Home** (`home/state`, plus the project verbs) — where a session starts: New,
Open and Clone on the left over a Recent list, tutorials on the right. It is the
one app the shell opens on, which is stated in `ShellState::default` rather than
left to whichever tab seeded first.

Clone is deliberately inert — cloning is a git operation with progress, auth and
partial-checkout failure, and this repo has git work in flight on its own branch
that the real one is built on rather than beside; the method exists and refuses,
and the button says "soon".

The tutorials column used to be dead too, and is not any more. `home/tutorials`
answers with the first few unfinished tutorials from `apps/tutorial.rs`'s
catalog, and a card calls `veistra/open` on the Tutorials app naming one. Home
holds no list of its own, which is the point: a second copy would be a second
place to add a tutorial.

The rules about what a project *is* are not here. They live in
`src-tauri/src/project/`, which takes paths and never opens a dialog — see the
README at the repo root.

**File Explorer** (`files/list`, `files/root`) — the project's folders and what
is in them, plus everything that changes the shape of it: create, rename,
duplicate, delete, trash. It does not show a file's contents. Clicking a row
asks the shell for a File Viewer in the same cluster (`veistra/open`) rather than
drawing the file itself.

**Agents** (`agents/overview`, `agents/transcript`, `agents/start`) — the agent
VMs in Veistra Cloud, every session each one has run, which workflow run a
session belongs to, and what the agent did in it. It reads the sessions bucket
and Compute Engine through `src-tauri/src/cloud/`, with the caller's own
`gcloud` sign-in, and polls only while visible. Its one write is starting a
stopped agent VM, which only a press of Start calls. Set
`VEISTRA_CLOUD_FIXTURES` to the absolute path of `src-tauri/fixtures/cloud` to run it against the committed
fixture instead of the live project.

Agents is a **page**, not an app you open into a pane. It is left out of the
Apps menu, the add-app button, presets and `veistra/open`, and `open_instance`
refuses it by name. Its chip at the left of the cluster bar opens it into its
own dedicated cluster instead. `src-tauri/src/pages.rs` declares which apps are
pages. Making another app a page takes a row there, on top of the app's usual
three edits.

**Cost Tracker** (`costs/estimate`) — what Veistra Cloud has cost so far this
month at list price, and the month's forecast against its 150 USD budget
(`VEISTRA_GCP_BUDGET` overrides it). It multiplies what exists (machines, disks,
reserved IPs, buckets, Cloud Run services) by how much each ran or held, from
Cloud Monitoring, by the public Cloud Billing Catalog price. The price lists
are cached for a day; the page refreshes every minute while visible. It only
reads. Egress, NAT, Secret Manager, logging, Artifact Registry, free tiers,
discounts and credits are left out, and the page lists them. The same
`VEISTRA_CLOUD_FIXTURES` folder answers it, with `clock.json` fixing "now".
`src-tauri/fixtures/cloud/billing/` holds real catalog SKUs, trimmed. It is a
page, like Agents: its chip opens it, and the Apps menu does not list it.

Beside the estimate it shows what Google actually billed, net of credits, from
the Cloud Billing export to BigQuery (`cloud::bigquery`). The standard usage
cost export has to be switched on once in the Console, into the
`billing_export` dataset (`VEISTRA_BILLING_DATASET` overrides it). Until then the
page says how, rather than failing. The export trails the estimate by a few
hours. Fixtures: `bigquery/tables.json` and `bigquery/billing.json`.

The page draws six charts on Apache ECharts (`apps/costs/ui/src/charts/`, plan
`docs/design/COST-TRACKER-CHARTS.md`, UI-7): the estimate alone draws the burn
line, the category donut and the top resources bar; a separate method,
`costs/trends`, answers the daily-by-service and last-six-months series behind
the other three once the billing export is on, polled every ten minutes and
only while the page is visible. Until then those charts show the same
`notEnabled` note as the billed table. Fixtures: `bigquery/daily.json` and
`bigquery/monthly.json`.

**Projects** (`projects/list`, `projects/wake-start`, `projects/plane-get`) —
every Veistra Cloud project's Plane workspace, picked from a switcher and
opened beside it. Selecting one wakes `plane-vm` if it was stopped
(`projects/wake-start`, polled by `projects/wake-status`), then lands a native
child webview over the pane — not an `<iframe>`, so Plane's own login session
survives a restart — positioned and resized by `src-tauri/src/plane_webview.rs`.
`projects/plane-get`/`-post`/`-patch` proxy the rest of Plane's REST API
through the backend's own PAT, out of Secret Manager, so nothing but that
same-origin webview ever needs one. Needs `plane.veistra.internal` resolving to
the tunnel's local port in the hosts file; the app surfaces the fix inline
when it does not. The same `VEISTRA_CLOUD_FIXTURES` folder runs it against a
fixture project list instead of the live bucket.

Projects is a page too, like Agents and Cost Tracker: its chip opens it, and
the Apps menu does not list it.

**File Viewer** (`files/read`, `files/write`) — open files in tabs, and what
each one looks like. Reads are capped at 256 KiB and say so when they truncate.
Single-clicking a row in the Explorer opens a *preview* tab here, which the next
single click takes over unless something has been typed into it — VS Code's
rule, and the reason browsing a folder leaves one tab behind rather than forty.

The two are separate apps sharing **one Rust half** — both registry rows
dispatch to `apps/files.rs`. There is one filesystem, and `files::call` holds no
state: every method takes its root from the `CallContext` the caller resolved,
which is a fact about where the *frame* is placed rather than which app is in
it. So an Explorer and a Viewer in one cluster resolve the same project, and a
pair in the next cluster resolve theirs.

**Design Mode** (`design/target`, `design/arm`, `design/disarm`, `design/capture`,
`design/comment/*`) — a page you are building, in a frame, with a click on any
element in it capturing that element's markup, computed styles and a cropped
screenshot. You then say what you want changed, and the capture becomes a comment
with an id.

It is the only app whose output an agent reads over MCP rather than through the
shell. `mcp::servers::design` serves the comments and takes the agent's turns on
the same threads; the clipboard handoff is still there and is now the fallback.
`docs/design-notes/design-comments.md` is the account of that half.

It is the only app that mounts something this repository did not write, and the
only one whose Rust half is a security boundary rather than a data source: what
may be embedded is decided by `design::normalize`, not by the frontend, because
a page classified as *local* by Tauri's origin test would reach every command
the shell has. `docs/design-notes/design-mode.md` is the whole account,
including what a hostile page in that frame can and cannot do — it is the page
to read before changing anything under `capabilities/`.

Getting into that frame at all needs Rust too. Same-origin policy means no code
in the shell can put a listener inside it, so `design/arm` installs a probe
through WebView2's `AddScriptToExecuteOnDocumentCreated`, which reaches child
frames the DevTools Protocol's equivalent cannot. The probe answers over
`postMessage` and is inert in every frame but the one this app armed.

**Canvas** (`canvas/list`, `canvas/read`, `canvas/assets`, `canvas/write`, `canvas/create`) — the design
canvas of `docs/VEISTRA-UX-REWORK.md` §5: draw on [Excalidraw](https://excalidraw.com), and each
canvas is one file, `<environment>/canvas/<id>.json` (`<id>` may nest folders: `levels/ward-b`),
so it is committed with the game and survives a clone. The file is an Excalidraw scene plus a
`veistra` object (`schema`, `id`, `title`, `parent`, `updated`, `updated_by`) — the shape of
`docs/cloud-services.md` §4, minus its bucket. **That section proposes the artifact store instead
and is marked "decision needed"; this follows `VEISTRA-UX-REWORK.md` §6 and the PRD's P7-2, which
are decided.** The app id is `canvas`, not `design`: `design` is the feature-gated Design Mode
app that points at a running page.

Saving is debounced (700 ms after the last change) and atomic (a sibling temp file, then
rename), and refuses if the file moved since it was read (`baseMtime`, the `files/write`
contract). The pane polls the file's mtime every two seconds while visible, and reloads when a
`git pull` or an agent changed it; with unsaved work it offers "Load the disk version" or "Keep
mine" instead. `canvas/write` and `canvas/create` are in `WRITE_METHODS`, so read-only main is
refused centrally and the pane opens in Excalidraw's view mode. A file that is not a valid scene
is reported and never overwritten. Only the background colour and grid are kept from Excalidraw's
view state, and deleted elements and unreferenced images are dropped, so a save is a small diff.

Canvases nest. Select a frame and "Create child canvas" makes a new canvas in a folder named
after its parent (`levels` becomes `levels/ward-b`), sets `customData.veistra.child` on the frame and
`veistra.parent` in the child's file, and opens it. Double-clicking a frame that has a child opens
it (the app takes that double-click before Excalidraw's own text edit does), and the breadcrumb
in the header follows `parent` back up. A frame whose child file is missing says so and stays
put. Unlinking only removes the frame's link; the child file is left alone. To link a frame to a
canvas that already exists, agents call `canvas/link-frame` (the `link_frame` tool), which also
rewrites that canvas's `parent`; `set-frame` cannot set the child, and says so.

A heavy canvas can be split into **sub-canvases**. Excalidraw repaints every element on every
pan, so a canvas holding thousands of elements across dozens of frames pans at a few frames a
second. When a canvas has over 1500 elements and frames of 40 or more, the pane offers "Split
into sub-canvases". The agent tool is `split_frames` (`canvas/split-frames`, with `frames`,
`minElements` and `dryRun` params). Each split frame's elements move into a child canvas,
`<parent>/<diagram id>`, together with a copy of the frame. The child keeps the frame's id, its
position and its diagram metadata. The parent keeps the empty frame. That frame is linked to
the child as any nested frame is, and it is marked `customData.veistra.subcanvas`. In the parent,
the frame shows a picture of its child: a locked image element that is never saved. To edit
the child, double-click the frame. The split is explicit, not done on open, for three reasons.
It turns one committed file into many, which is the person's call. Read-only main cannot write.
The parent is checkpointed first, so the split can be undone. A frame is skipped, with the
reason, when something outside it is bound to or grouped with its contents. Review comments on
a split frame move into the child's comment folder. The split checkpoint is kept outside the
five-entry ring. Restoring it brings the comments back to the parent and removes the children,
each copied into its own checkpoint ring first.

Pictures are drawn by Excalidraw's exporter from the child file, in the light theme. The dark
theme's picture is that image passed through the inverse of Excalidraw's dark-mode image
filter, so it inverts with the canvas like the drawing it stands for. They are cached in memory
for the session, and on disk in `.veistra/canvas-snapshots/`. Those files are git-ignored and
keyed by the child's mtime. They are listed by `canvas/snapshots` and written by
`canvas/put-snapshot`; neither is a design write. While a parent is open it polls its
children's mtimes every two seconds and redraws any that changed. Redrawing runs one picture at
a time in idle time, so panning never waits for it. The parent's frame follows its child's frame
size and name.

The agent methods still accept a diagram on the parent after a split. `describe-diagram`,
`view-diagram`, `add-shapes`, `import-mermaid`, `create-comment`, `frame` and `frame-image` all
follow a split frame into its child; their results name the canvas they used. `add-shapes`
writes into the child. It brings the parent's value table along, and afterwards it syncs the
parent's frame. `list-diagrams` counts a split frame's elements in its child and names that
child as `childCanvas`. `list-comments`, `resolve-comment` and `view-comment` also find the
comments that moved into children. `values` includes the uses found in children, and
`set-values` updates the children's copies of the table. `set-frame` renames the child's copy
of the frame as well.

An agent driving the editor through `veistra-ui` should know that Excalidraw's properties island
sits over the left edge of the canvas (about the first 195 px) while a shape is selected. A
click or drag there lands on the island, not on the scene. Draw with `canvas/add-shapes`
instead, or press Escape to clear the selection first.

Spec cards (`customData.veistra.spec`, fields from `docs/cloud-services.md` section 4) are made
by selecting any shape and filling in the inspector: name, size in metres, triangle budget,
style notes, reference images, plus the card's own review state (draft, review, accepted,
rejected). "Copy JSON" exports exactly the five documented fields, and refuses an incomplete
card. The "Asset list" tab calls `canvas/assets`, which reads every canvas in the checkout and
returns each card with its state; a canvas that cannot be read is named, not hidden. The state
shown is the card's own: joining the cloud artifact's build status needs the cloud store, so that
column is not there yet.

"Send selection" (header) renders the selected elements, with the members of a selected frame
and the text inside a selected shape, to a PNG with Excalidraw's exporter and puts it in the
agent's context; "Send card" puts a valid spec card as JSON text. Both can be dragged onto a
terminal as well as clicked, and both work on read-only main because `.veistra/context/` is not the
checkout. The PNG is tried at 2x, 1x, 0.5x and 0.25x until it fits the store's 8 MB limit.

Excalidraw is loaded lazily (`React.lazy`), and its fonts are served from
`/vendor/excalidraw/fonts/` by the `excalidrawFonts` plugin in `vite.config.ts` rather than from
a CDN. The 13 MB CJK fallback font is not shipped.

The editor wears the shell's tokens in both themes (`native.css`), and its links out to
excalidraw.com, the library site and socials are hidden. Excalidraw's MIT notice is under the main
menu's "About this editor". The app's own panels (Inspector, Diagrams, Comments) dock to the right
of the drawing and collapse to a strip; nothing floats over the drawing.

**For agents.** A design is a set of named frames (diagrams). These methods take an `actor` of
`"agent"` or `"human"` (never `"system"`) and an `id` (the canvas). How to draw is in
`docs/canvas-drawing-guide.md`.

| Method | Does |
|---|---|
| `canvas/list-diagrams` | Every named frame: id, title, summary, parent, level, covers. |
| `canvas/describe-diagram` | `{diagram}`: its shapes, labels and what each arrow joins, as text. |
| `canvas/view-diagram` | `{diagram, region?, scale?, theme?}`: a PNG of that frame alone, at `.veistra/canvas-views/<id>/<diagram>.png`, overwritten each time. |
| `canvas/save` | Flushes the open editor, then reports the file's path, element count and diagrams. |
| `canvas/add-shapes` | `{frame, shapes, replace?, nudge?, values?}` or `{index: true}`: measured layout, returns ids and warnings, checkpoints first. |
| `canvas/import-mermaid` | `{frame, source}`: a Mermaid flowchart or state diagram as a new frame. |
| `canvas/checkpoints`, `canvas/restore-checkpoint` | The last five saves before a bulk edit; restore one (default the newest). |
| `canvas/values`, `canvas/set-values` | The `{{name}}` value table, where each is used, and labels that no longer match. |
| `canvas/design-brief`, `canvas/set-design` | The detail level and drawing style in force for a canvas (its override, else Settings > Canvas, else the default), and a per-canvas override: `{detail?, style?}`, `null` clears. `add_shapes` draws in the style; `drawing_guide` ends with the guidance. The Canvas toolbar's Drawing style control sets the same override by hand (`veistra.design` in the file). `drawing_guide {topic: "design"}` serves `docs/canvas-design-prompt.md`, the brief for designing a game. |
| `canvas/coverage` | Which frames cover each checklist topic, and which topics none do. |
| `canvas/lint` | Agent-ready topology, rule by rule: named frames, no loose parts, bound labels. `canvas/add-shapes` returns the same report under `validation`. |
| `canvas/refs` | Reference images under `canvas/<id>/refs/`. |
| `canvas/list-comments` | `{status?: open\|resolved\|all, diagram?}`. |
| `canvas/create-comment` | `{diagram, elementIds \| region, text}`; the region is frame-relative. |
| `canvas/view-comment` | `{commentId}`: a PNG of what the comment points at, with a margin. |
| `canvas/resolve-comment`, `canvas/reopen-comment` | `{commentId, note}` / `{commentId}`. |

An app opens the shell's Settings on a section with the host method `shell/open-settings`
(`{section: "canvas"}`); Canvas' *Drawing style* button is the example.

`view-diagram`, `add-shapes`, `import-mermaid` and `view-comment` render and measure in the canvas
app's webview, so they need a canvas pane open in some window; without one they fail with
`kind: "canvas-not-open"` and say so. The rest read and write files and work either way. Through the
agent MCP server:

```sh
pnpm probe --agent --server agent app_call @view.json
# view.json: {"app":"canvas","method":"canvas/view-diagram",
#             "params":{"id":"flap-ball","diagram":"playfield","actor":"agent"}}
```

Comments are one JSON file each in `canvas/<id>.comments/`, beside the canvas, so they are
committed with it. The shape (`id`, `frameId`, `elementIds` or `region`, `text`, `author`,
`createdAt`, `status`, `resolution`) follows `@veistra/markup`'s annotation in spirit, pinned to a
frame instead of a page, without depending on that package. Images dropped into the editor are
written to `canvas/<id>/refs/` and the scene keeps a `veistraRef` path instead of base64; a read puts
the bytes back, so the editor never knows.

**Tutorials** (`tutorial/catalog`, `tutorial/complete`, `tutorial/reset`) — short
walkthroughs of what Veistra does today, with a tick against the ones you have
read. `docs/tutorials.md` is how to add one.

It is the only app that reads nothing on the machine: `tutorial::call` ignores
its `CallContext`, so a tutorial reads the same in a cluster with no project as
in one with a checkout — which is the state a person reading "your first project"
is most likely to be in. The catalog is in Rust because Home draws it too; the
prose is in the frontend because it is a view.

Like Home, it **covers** the cluster rather than taking a pane: no tab in the
switcher, no row in the Apps menu or the `+`, and gone as soon as you choose
something else. Home's cards are its door. It is still an ordinary registry entry
all the same — that is what resolves its frontend when `veistra/open` asks for one,
and the filtering is a fact about which menus offer it. `docs/tutorials.md` §8.

**Schematify** — the design layer of Veistra: draws the full-scale plan,
technical and product together, that coding agents build from. It replaces
two predecessor applications this scaffold was built from, folded into one
rather than two — see `docs/design/SCHEMATIFY-PRD.md` §1.3 for what each used
to own. It used to be planned as separate repositories, installed the way a
genuinely third-party tool is; it is an app instead for the same reason Home
and Files are — what it shows is what the orchestrator already resolved, and a
process boundary that only turns around and asks the shell for that again is
an IPC hop with nothing of its own on the other end. It is an ordinary pane
app — a tab in the switcher and a row in the Apps menu, like Files or the
Viewer. Scope grows wave by wave; `docs/design/SCHEMATIFY-PRD.md` §17 is
where that gets filled in.

**Godot Viewer** (`godot-viewer/state`) — read-only: the scene an agent's
headless `godot --headless` run last produced, a node tree beside a viewport
render. There is no live game view and no way to change anything from here —
selecting a node offers a comment, nothing else. `state()` has nothing to walk
yet, because nothing runs the headless export against this project in this
build; `nodes` is always `[]` until that lands. "Open in Godot" is visibly
present and visibly disabled — there is no install handoff behind it yet.

**Blender Viewer** (`blender-viewer/state`) — read-only, the same shape for
Blender: a Model/Renders/Wire switch, an honest placeholder in place of a real
3D viewport (deliberately not three.js — see
`docs/VEISTRA-UX-REWORK.md` §3.2), a parts list, a renders strip. Same story as
the Godot Viewer on emptiness and "Open in Blender".

**Play** (`play/state`) — runs the environment's debug build in a pane and
lets you comment on what you see: pause/restart/stop, a frame area, a debug
overlay, and Capture & comment on `F5`/`Ctrl+Shift+C` — bound on the app's own
root element, not `window`, so it never fires while a different pane has
focus. `state()` never reports a running build in this build of the app; the
transport controls stay disabled outside "Preview with sample data" (below)
because there is no RPC yet that actually starts, pauses or stops a run, and a
capture never carries a real screenshot for the same reason — see
`apps/play/ui/src/rpc.ts`.

All three show an honest empty state everywhere they have nothing to show,
rather than fabricating a render, a part list or a frame. Each has a single
"Preview with sample data" toggle, off by default, that swaps in a fixture
(`fixtures.ts` beside each app's `App.tsx`) so the layout can be reviewed
before anything upstream produces real data — never anything that looks like
it came from a real run.

## Comments

The Godot Viewer, the Blender Viewer and Play share one comment store rather
than three: `apps/shared/comments.ts` is the model and the three RPC calls
(`comments/list`, `comments/create`, `comments/resolve`), and
`apps/shared/CommentPanel.tsx` is the list every one of them mounts. All three
delegate to it from their own Rust module (`src-tauri/src/comments.rs`,
reached through `godot_viewer.rs`/`blender_viewer.rs`/`play.rs`'s `dispatch`),
which is why it lives under `apps/shared/` rather than in whichever app needed
it first — see that directory's note above on why the isolation rule excludes
it.

A comment anchors to one of three things: a Godot node path, a Blender part
plus material, or a Play scene plus a playhead time (`docs/VEISTRA-UX-REWORK.md`
§3.4). It is a file — one per comment — under `.veistra/comments/` inside the
calling cluster's environment, not a database row, for the same reason the
rest of this repo's structured state is files: it travels with the branch and
merges the way git already merges text. `src-tauri/src/comments.rs`'s doc
comment has the ID scheme and the merge reasoning in full.

"Send to agent now" is on every comment panel, and it is always disabled: it
is drawn now so the layout is right, but nothing reads `.veistra/comments/` into
an agent yet, and the button says so in its tooltip rather than pretending to
work.

## Context: pushing things to an agent

Any app can put an image, a file or a snippet where the agent working in this
environment can read it, with the same four calls Files, Play and the viewers
already make for everything else. They are answered by the host before any
app is looked up (`apps::call`, like `settings/all`), so they exist for every
app and plugin surface without registering anything.

```ts
import { invoke } from "@veistra/bridge";

// An image (a panel capture, a frame, a render): bytes cross once.
const item = await invoke("context/put", {
  kind: "panel", // "image" | "panel" | "file" | "text"; optional, inferred otherwise
  title: "Play frame 00:12",
  label: "Play - hospital_wing.tscn", // one line for the strip
  bytesBase64: png, // standard base64, no data: prefix
});

await invoke("context/put", { kind: "text", title: "Build log", text: tail });
await invoke("context/put", { path: "C:/game/renders/out.png" }); // a file you already wrote

await invoke("context/list"); // ContextItem[], newest first
await invoke("context/get", { id: item.id });
await invoke("context/remove", { id: item.id });
// Type @path references at the agent terminal's prompt, without pressing Enter. Answers
// { inserted: false, reason } when no agent is running; the items stay attached either way.
await invoke("context/insert", { itemIds: [item.id] });
```

Pass a stable `key` that names the source, never the moment
(`blender/<blend>/<view>`, `godot/<scene>/frame`, `file/<relpath>`). Sending
the same key again overwrites the one file and record and moves the strip entry
to the top; the path an agent was given for a key always holds the latest
version. Without a key, a file is keyed by its path and anything else by its
content hash, so identical pastes are stored once.

Send exactly one of `bytesBase64`, `text` or `path`. The item is a file under
`<environment>/.veistra/context/` plus a `<id>.json` record (id, kind, sniffed
mime, title, `source.appId`, size, `path`, `relPath`); that directory carries
its own `.gitignore`, so context never enters a commit. `source.appId` is
stamped by the shell from the calling frame and cannot be claimed in params.

Limits and refusals, all enforced in Rust (`src-tauri/src/context.rs`): images
must be PNG, JPEG, GIF or WebP by their bytes (a declared mime is not trusted)
and at most 8 MB, with no downscaling; text is cut at a line boundary at
256 KB and marked truncated; a copied file is at most 25 MB; executable-looking
content is refused; the store keeps at most 500 items or 500 MB, oldest first.
A `path` already inside the environment is referenced where it is and never
deleted by `context/remove`. An unsupported put fails with an `INVALID_PARAMS`
error whose message says why.

**These calls are allowed in a read-only main cluster.** `.veistra/context/` is
Veistra's own state, not the checkout, and is gitignored, so it is not in
`WRITE_METHODS`.

A store change emits the Tauri event `context:changed` (`{ root }`); the shell
strip beside each terminal listens to it. To let a user drag an item onto a
terminal, register it with `context/put` first and then send
`veistra/drag { phase: "begin", items: [item.id] }` (`paths` and `items` may be
mixed); the drop inserts the reference the running harness understands.

### Agent saw (Claude Code)

The strip can also show images the agent *read*. It is off until the person
turns it on in the strip, which asks first and then merges one `PostToolUse`
hook (matcher `Read`) into `<env>/.claude/settings.local.json`, keeping every
other key and hook. The hook appends each payload to
`.veistra/context/.saw.jsonl` (gitignored) and Veistra reads that file; a file
append was chosen over a hook binary posting to the local listener because it
needs no shipped executable, port or token, and works with Veistra closed. The
strip's "Stop tracking" removes exactly that hook. Codex and Gemini have no
adapter yet.

## References: `veistra://`

A `veistra://` reference names a file, a canvas frame, a comment or a context item
in a way a person and an agent read alike. The design is
[`docs/design/VEISTRA-CONTEXT-REFS.md`](../docs/design/VEISTRA-CONTEXT-REFS.md).
The host answers `refs/resolve` before any app is looked up, as it does
`context/*`, but only for Veistra's own apps: a plugin is someone else's code, and
a reference reads the project. A plugin's own `refs/` method still reaches the
plugin.

```ts
import { invoke } from "@veistra/bridge";

// What a reference chip draws: a kind, a title, and parts to show.
const r = await invoke("refs/resolve", { uri: "veistra://file/scripts/player.gd#L10-L20" });
// { uri, kind, title, detail?, meta, parts: [{ type: "text" | "image" | "json" | "note", … }], withheld? }
```

It resolves inside the calling surface's cluster and as the person, who is the
one looking. The agent server's `app_call` refuses it for that reason. Secrets
and gitignored files come back with `withheld` set and no content. Links out of
the project are refused. Excerpts, images and JSON are capped; the design doc
gives the rules and the numbers.
