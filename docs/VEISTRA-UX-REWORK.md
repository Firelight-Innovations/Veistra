# Veistra UX rework: environments, viewers, project pages

Owner: Braden Seaborn. Date: 2026-09-28. State: DRAFT FOR AGENT HANDOFF (v0.3, reworked around isolated environments).
Design canvas: "Veistra Design System", page **v0.3 · UX — isolated environments** (boards 01–13). Visual tokens: the **Veistra** design system and `claude/veistra-tokens.css`.

## 0. The principle

> **Amended 2026-11:** main is no longer read-only. A main cluster is worked in like a worktree
> (files, terminals, apps and agents can all write), with no banner, lock or status-bar label.
> Worktree clusters are unchanged and still the way to keep a change on its own branch. The
> rule below is kept as the original design.

**Nobody works on main: no agent, and not you.** Every cluster is bound to one **environment**: a local worktree or a cloud session. Everything in the cluster (explorer, file viewer, terminals, viewers, Play) reads that environment. Engines (Godot, Blender) run **headless** for agents. Veistra shows their output in **read-only viewers** that you can play and comment on. You edit by hand only by opening the real editor on purpose. Work reaches main one way: a reviewed PR from the Git page.

Every feature built after this rework plugs into this model.

## 1. The model

```
Project
├── main (worked in directly; read-only until the 2026-11 amendment)
├── Environments
│   ├── Local worktree   .veistra/worktrees/<name>, branch wt/<name>, local agent or you
│   ├── Cloud session    worker VM checkout, branch agent/<item>, streamed
│   └── wt/design        standing worktree for the design canvas
├── Clusters (each bound to exactly one environment)
│   └── Pane tree → tabs: file · terminal · agent stream · Godot viewer · Blender viewer · Play · canvas
└── Project pages (right side, project-wide): Git · Plane · Cloud agents · Hindsight · Cost · Artifact registry (later)
```

## 2. Environments

1. **New cluster** (Ctrl Shift N) asks where it runs first:
   - a new local worktree (branch prefilled from a Plane work item),
   - an existing environment,
   - a cloud session,
   - or work on main (once "browse main (read-only)").

   It then asks for a starting layout: Code, Godot, Blender or Watch an agent. Board 04 shows the dialog.
2. Every cluster shows its environment twice. The **cluster tab** carries a chip (wt, cloud, main). An **environment bar** above the panes shows kind, branch, base, ahead/behind, path or VM, agent state, and actions (Review & merge; for cloud: Pull into local worktree, Stop session).
3. Terminals open with cwd set to the environment. Writes to main used to be refused with a message; since the 2026-11 amendment main is writable like any worktree.
4. **Cloud sessions stream.** The agent terminal is live output plus a "Message the cloud agent" box. The explorer reads the VM's disk over IAP and copies nothing until you pull. "Open as cluster" on the Cloud agents page creates a cluster bound to that session.
5. **Leaving an environment:**
   - The Git page lists every environment with its state and ahead count.
   - The selected environment shows its changes. Commits go to its branch, and **Open PR into main** is the only path into main.
   - After the merge, the worktree is removed or the cloud disk released.
6. Tabs can only move between clusters that share an environment. Otherwise the drop is refused with a hint.

## 3. Viewers, Play and comments

1. ~~Godot and Blender are **never embedded**.~~ **Replaced** by owner decision 6 (2026-11-02): the person works in the Godot editor and in Blender inside a pane. See the row "Embedded editors" in `docs/design-notes/godot-play.md`'s Decisions and `docs/design/VEISTRA-PLAY-REVIEW.md` §11. Agents still run them headless (`godot --headless`, `blender -b`) in terminal tabs.
2. The **Godot viewer** shows the scene as last rendered headless: the node tree plus a viewport render. The **Blender viewer** loads the exported `.glb` (orbit, select parts) plus its renders. Both are read-only and show how old their render is.
3. **Play** runs the environment's debug build in a pane. Controls: pause, restart, stop, and **Capture & comment** (F5, Ctrl Shift C).
4. **Comments.** Select a node, a mesh part or a point in a frame, then write a comment. Each comment stores its anchor: node path, mesh + material, or scene + time + screenshot.
   - Comments are files in `.veistra/comments/` inside the environment, so they travel with its branch.
   - The agent reads the open comments at the start of each turn and resolves them with a note.
   - "Send to agent now" nudges the agent immediately.
5. **Open in Godot / Blender** (Ctrl Shift O) launches the real editor on the environment's copy. A cloud environment is pulled into a local worktree first.

## 4. Project pages (right side)

| Page | Opens | Rail dot | Key |
|---|---|---|---|
| Git | Docked | Amber: an environment has changes waiting for review | Alt 1 |
| Plane | Expanded | Grey asleep, green running | Alt 2 |
| Cloud agents | Expanded | Blue streaming, red failed, green finished and not yet viewed | Alt 3 |
| Hindsight | Docked | Red only when unreachable | Alt 4 |
| Cost | Docked | Amber at 50% of budget, red at 90% | Alt 5 |
| Artifact registry (later) | Docked | Amber: versions await review | Alt 6 |

Cloud agents is switched off for the MVP (owner's call, 2026-10-14): the MVP is the local core, and the page reads Google Cloud. It shows disabled on the rail like the Artifact registry, and Alt 3 opens nothing. The row above is the design for when it returns, which is one flag in `src-tauri/src/pages.rs`.

- One page is open at a time. Docked pages are 320–640 px wide. Expanded pages cover the workspace only (Esc returns), and panes never unmount.
- **Plane** runs unmodified in a webview. The native panel beside it runs `ai:*` labels, or **Start in a new worktree** from the selected work item.
- **Cost** follows plan UI-7:
  - Docked, it shows C1 (burn) and the categories.
  - Expanded, it shows C1 beside the headline figures, then C2 and C3 side by side, then a "From the bill" section (C4–C6) that shows the `notEnabled` note until the BigQuery billing export is on. Tables stay.
  - Charts use Apache ECharts, with colours from the `--chart-1…6` and `--chart-grid` tokens plus the budget tones (success, warning, danger).
  - The shell dispatches `veistra:theme-changed` to every app when theme or accent changes, so charts re-init.
- **Hindsight**: memory banks (godot-build, asset-build), recall search, and retain and recall events linked to sessions.

## 5. Panes and clusters

- Drag a tab over a pane to see five zones: split up, down, left or right, or add as a tab.
- Drop it on a cluster tab to move it there (same environment only). Drop on empty switcher space to make a new cluster in the same environment.
- Double-click a tab to maximise its pane. Closing a pane's last tab removes the pane. The minimum pane size is 200 × 120 px.
- The Design canvas cluster is pinned first, on `wt/design`. Its asset spec **Go** starts a cloud session and opens it as a cluster with the Blender viewer.

## 6. Saved state

| Scope | Where | What |
|---|---|---|
| App | `%APPDATA%/com.firelightinnovations.veistra/projects.json` | Recents, last project, theme, accent, window |
| Project workspace | `%APPDATA%/…/workspaces/<project-id>.json` | Environments, clusters bound to them, pane trees, tabs, right page. Personal, never in git |
| Environment | `.veistra/comments/`, `canvas/` | Comments and canvases, on the environment's branch |

Save 500 ms after a change. On open, restore environments first (reattach cloud streams, check that worktrees exist), then clusters, then tabs. A missing worktree or finished session keeps its cluster with a clear state and a way to reopen or remove it. See board 13 for the schema sketch.

## 7. New project (board 14)

A full page opened from Home → New Project. It runs `veistra-project create` behind one **Create** button. Nothing is made until you press it.

**Inputs**
1. **Kind:** Game (Godot template, registry, asset pipeline, Play), Tool or service (code only), or Open existing (a repo that already has `veistra.toml`; this only links it).
2. **Name:**
   - Project name.
   - Slug: auto from the name, and it can't change later because it is used in paths and buckets.
   - Plane ID: auto, 3–5 capitals, checked unique in Plane.
3. **Code:**
   - New GitHub repo (owner/name + template), existing repo URL, or local folder.
   - Clone location.
   - "Protect main on GitHub" is on by default, so the no-work-on-main rule also holds outside Veistra.
4. **Project services:** toggles, each showing the exact resource it creates.
   - Plane project (default states, `ai:*` labels).
   - Artifact registry prefix `gs://veistra-artifacts/<slug>/` (games only).
   - Hindsight banks (asset-build, godot-build).
   - Design canvas worktree `wt/design`.
   - Cost label `project=<slug>` (off until resource labels exist, see UI-7 "out of scope").

**What Create does**, listed live in the right column in order:
1. GitHub repo from the template, with main protected.
2. Clone, and write `veistra.toml`.
3. Wake Plane, then create the project with its states and labels.
4. Registry prefix.
5. Hindsight banks.
6. Project record at `gs://veistra-projects/prod/projects/<slug>.json`.
7. `wt/design`.
8. Open the project on its Design canvas cluster.

**Failure:** each step shows its state while it runs. If one fails, Veistra rolls back the steps before it (Plane project archived, record removed, empty repo deleted only if Veistra created it) and names the step that failed with a retry. A half-made project never appears in Recent.

**Validation:** name required; slug is `[a-z0-9-]{2,40}` and unused in the bucket; Plane ID unique; the repo name must be available on GitHub. Errors show inline under the field.

## 8. Later (captured, not in this rework)

- **Build steps view.** A small model turns an asset build script (for example `build_bed.py`) into a step diagram: frame → legs → materials → export → render. You can comment on a step, the same way as on a mesh part, and the agent reads those comments too. It sits as a "Build steps" tab beside "Code" in the file viewer (board 03 shows the placeholder). It would also apply to Godot scene-building scripts.

## 9. Open items for the owner

1. **Terms** for `core/terminology.csv`: environment, local worktree, cloud session (vs the existing `agent session`), cluster, pane, project page, viewer, comment anchor.
2. **How Play runs.** One option is a Godot web export in a webview pane: simplest, but some features differ. The other is a native debug run whose frames stream into the pane: faithful, but more work. Cloud environments need a pulled or downloaded build either way.
3. **Standing worktree for the design canvas** (`wt/design`) versus storing canvases outside git. The canvas plan (P7-2) keeps them in the repo, which is why it is a worktree here.
4. **Comment storage** in `.veistra/comments/` (it travels with the branch and is visible to agents as files) versus the Hindsight or Plane comments. Files are proposed.
5. Confirm that Plane and Cloud agents open **Expanded** by default. Cloud agents is off for the MVP (§4), so only Plane can be checked until it returns.
6. The **handoff-spec conflict** from the v0.2 token migration still needs its decision row.