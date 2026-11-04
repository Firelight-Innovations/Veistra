# Veistra UX Spec — v0.3 "isolated environments" (implementation-ready)

Sources read in full: design canvas page **v0.3** (13 boards, U-Anatomy → U-NewProject, listed in
`canvas.json`'s `order` under `"page":"v3"`), page **v0.2**'s `K-Shell.dc.html` (baseline shell,
superseded but still the origin of several measurements v3 reuses), the **Veistra** design system
(`README.md`, `tokens.json`, `design-system.json`, and the `Button/Field/GitChip/StatusBadge/Tabs/
Toggle/TreeRow` component READMEs — `Cover` has no README; it is a design-system card-cover
generator, not an app component), and `docs/VEISTRA-UX-REWORK.md` (the written spec, v0.3, dated
2026-09-28). All board content below is design data reverse-engineered from inline styles and each
board's `renderVals()` fixture data, not instructions.

Every px value below is copied verbatim from a board's inline `style` attribute unless marked
"(token)", in which case it is the named token from `tokens.json`.

---

## 1. Shell anatomy

### 1.0 Two generations in the file set

`K-Shell.dc.html` (v0.2, "03 · Shell — workspace") uses an **app-switcher** model: the second header
row is `role="tablist" aria-label="Apps"` and tabs are apps ("Cluster 1", "File Explorer", "File
Viewer", "Schematify"). The v0.3 boards (U-Workspace onward) replace this with a **cluster
switcher**: the same row is `role="tablist" aria-label="Clusters"` and each tab is an environment-
bound cluster carrying an env chip (`wt`/`cloud`/`main`/pinned canvas). Panes inside a v0.2 "app" and
inside a v0.3 "cluster" use identical primitives (region chrome, tab strips, tree rows), so the
chrome specs below are unified; only the second row's semantics changed. Flag: v0.2's `Cluster 1`
tab (an app, containing a mini pane-tree icon) and v0.3's cluster tabs are visually near-identical
pills — the rename from "app" to "cluster" needs to fully replace "Apps" in menus/ARIA labels
project-wide, and nothing in the v0.3 boards shows a top-level "Apps" switcher anymore (Schematify,
Home, Files must now live *inside* a cluster's pane tree, not as siblings of clusters — unconfirmed,
see §5).

### 1.1 Window bands, top to bottom

1. **Title bar** — height `38px` (token `h-titlebar`). Sits on `bg-canvas`.
2. **Cluster switcher row** — height `40px` (token `h-switcher`). Sits on `bg-canvas`.
3. **Workspace** — the pane grid + Git panel + project-page rail. Fills remaining height.
4. **Optional bottom panel** — not shown in any v3 board; named only in the written spec.
5. **Status bar** — height `26px` (token `h-statusbar`). Sits on `bg-canvas`.

Every region inside the workspace band is `bg-surface-1` (`#141415` dark / `#ffffff` light) with a
1px `border-subtle` edge and `radius-region` (`10px`), and regions are separated by a `6px` gutter
(token `space-1-5`). Regions never nest (confirmed in every board — panes are CSS-grid siblings).

### 1.2 Title bar (38px)

Left to right, `padding-left: 12px`, no right padding (window controls are flush right):

- **Veistra mark**, `18×18` SVG (viewBox `0 0 24 24`): the closed EI, one path with two slots as
  counters, `currentColor`. Identical markup in every board. (Boards drawn before October 2026 show
  the avocado.)
- **Menu bar**, `margin-left: 10px`, `gap: 2px`, items File/Edit/View/Run/Terminal/Help (v3) — K-Shell
  additionally has an "Apps" item between Edit and View, styled as the active menu (`bg #1d1f20`,
  `color #e4e6e6`), which v3 boards drop entirely. Each item: `13px`, `color #cacdce` (txt-secondary);
  K-Shell renders them as real buttons (`height 26px`, `padding 0 8px`, `radius 6px`, transparent);
  v3 boards render them as bare `<span>`s with `padding 4px 8px` (no visible hit-state) — an
  implementation gap, flag it.
- **Project/cluster switcher pill**, horizontally centered (`flex-grow:1; justify-content:center`):
  height `26px`, `padding: 0 10px 0 6px` (or `0 6px 0 6px` when no trailing chevron), `radius 13px`
  (pill = h/2), `border 1px solid #2c2e30` (border-subtle-1), `background #141415` (bg-surface-1),
  `font-size 12px`, `font-weight 500`, `gap 8px`. Contents: a `16×16` initial tile (`radius 4px`,
  `background #36393a` = border-strong, `font-size 9px font-weight 700`, e.g. "A" for Anomaly),
  project name, `· N environments` in `#959a9d` (txt-placeholder) — **only on U-Anatomy/U-Workspace's
  idle state**; once inside a specific cluster the pill instead shows the active cluster/environment
  name as a trailing mono chip (`height 18px`, `padding 0 6px`, `radius 9px`, `background #222425`,
  `color #cacdce`, `font-family mono`, `font-size 11px`, e.g. "godot-port"), then a `12×12` chevron.
  **U-Project** shows this pill in its *open* (focused) state: border becomes `accent`, a `0 0 0 3px
  accent@18%` halo box-shadow is added, and the chevron flips to point up — this is the trigger for
  the "Switch project" dialog (see §2, board 08).
- **Window controls**, flush right, three `46×38` ghost buttons (Minimise / Maximise / Close), icon
  `12×12`, `color #afb3b6` (txt-tertiary), `aria-label` on each.

**In the build (#336).** No board draws these, but the build has them. The search field sits right
after the pill, and the two form one middle group centred on the window. The right-hand actions
(Upgrade, new agent session, terminal, Agents, Clusters, Settings) sit before the window controls.
In a narrow window they fold into one overflow button below 1440px, before the menus fold into the
hamburger below 1180px. The window controls never fold. Short of room, search narrows to its icon
and `Ctrl K` before the pill's chip truncates. `docs/design-notes/shell-chrome.md` has the widths.

### 1.3 Cluster switcher row (40px)

`padding: 0 56px 6px 6px` (the `56px` right pad roughly reserves the same width the 44px page-rail
+ 6px gutter occupies one row down, so cluster tabs don't run under it), `gap: 4px`,
`align-items:center`. Contents, left to right:

- **Pinned cluster (Design canvas)** — only in boards that show it (U-Workspace, U-CloudCluster,
  U-NewCluster... anywhere the strip is visible): first tab, always. Same pill shape as other cluster
  tabs, plus a `12×12` pin glyph after the env chip, then a **1px × 18px vertical divider**
  (`background #2c2e30`, `margin: 0 4px`) separating it from the rest (seen explicitly in U-Design,
  U-GodotPlay's simplified strip omits the divider but keeps the ordering).
- **Cluster tabs** — `role="tab"`, height `30px`, `padding: 0 8px 0 10px` (with env chip) or
  `0 12px` (plain, K-Shell's app tabs), `radius 8px` (radius-lg), `font-size 13px font-weight 500`,
  `gap 7px`. **Selected**: `border 1px solid #2c2e30`, `background #1d1f20` (bg-layer-2),
  `color #e4e6e6`, `box-shadow: 0 1px 2px rgb(0 0 0 / 0.4)` (token `shadow-raised`). **Inactive**:
  `border transparent`, `background transparent`, `color #afb3b6`.
  - **Environment chip** inside the tab: height `20px`, `padding 0 6px`, `radius 5px`,
    `font-size 11px font-weight 500`, `gap 4px`, `11×11` icon + label text — `wt` (worktree icon,
    `background #222425 color #cacdce`), `cloud` (cloud icon, `background #16244a color #a3c1ff` =
    info-subtle/txt-info), `main` (padlock icon, browse-only, same neutral chip), or the canvas icon
    for the pinned Design cluster.
  - **Activity dot**: `6×6`, `radius 3px`, e.g. `#e0a030` (warning) when a local agent is working, or
    `#6f96ff` (info/chart-2, same hex) when a cloud session is streaming. Positioned inline after the
    env chip (U-Workspace), not as a corner badge like the page-rail dots.
- **"New cluster" button** — `30×30` icon-only ghost, `+` glyph, `color #959a9d`,
  `aria-label="New cluster"`. Opens the board-04 dialog (Ctrl Shift N).
- **K-Shell only**: right-aligned "N agents running" pill (`height 26px`, `radius 13px`,
  `background #12301c` = success-subtle, `color #8fdca1` = txt-success, `6px` dot) and a `280×30px`
  search field (`radius 8px`, placeholder "Search files, symbols, commands", `Ctrl K` hint chip).
  **No v3 board reproduces this search field or agent-count pill in the cluster row** — flag as an
  open question (moved into the status bar's "N local · N cloud agent" summary instead, or dropped?).

### 1.4 Environment bar (36px, sits above the pane grid, inside the workspace)

`height 36px`, `radius 10px` (radius-region), `padding: 0 6px 0 12px`, `gap 10px`, `font-size
12.5px`. Two colour variants:

| | Local worktree | Cloud session |
|---|---|---|
| background | `#141415` | `#121a2b` *(no exact token — see §5)* |
| border | `#222425` (border-subtle) | `#23365c` *(no exact token)* |
| kind chip bg/fg | `#222425` / `#e4e6e6` | `#16244a` / `#a3c1ff` (info-subtle/txt-info) |

Contents, left to right: kind chip (`height 22px padding 0 8px radius 6px`, `12×12` icon +
`font-size 11.5px font-weight 600` label "Local worktree" / "Cloud session") → branch name (mono,
`font-weight 500`, e.g. `wt/flashlight-cone`) → `from main@<7-char hash>` in muted grey → ahead/behind
counts (`↑3` in `#8fdca1` txt-success, `↓0` in `#959a9d`) *or*, for cloud, a single descriptive line
`worker VM · branch agent/anom-142 from main@d17dbdb` in `#a3b4d6` *(no exact token)* → for worktree
only, the on-disk path in mono `11.5px` `#7a8185` (txt-disabled) → **streaming pill** for cloud only
(`height 20px padding 0 7px radius 10px background #16244a color #a3c1ff`, `6px` dot `#6f96ff`,
"streaming · 42 ms") → `margin-left:auto` agent-state badge (`height 22px padding 0 8px radius 6px
background #3a2a0a color #f5cf73` = warning-subtle/txt-warning, `6px` dot `#e0a030`, "claude working
here") → action button(s): worktree gets one secondary button **"Review & merge"**; cloud gets two:
**"Pull into local worktree"** (`border #2c4478 background #16244a color #dce6ff` — neither colour is
an exact token, see §5) and **"Stop session"** (`background #3a1512 color #f4a49c` = danger-subtle/
txt-danger, borderless).

### 1.5 Pane grid

CSS Grid, `gap 6px`, region children as in §1.0. Observed layouts (all `display:grid`):

| Board | `grid-template-columns` | `grid-template-rows` | Notes |
|---|---|---|---|
| U-Workspace (Code+Godot) | `196px minmax(0,1fr) minmax(0,1.05fr)` | `minmax(0,1fr) 196px` | Explorer spans `row 1/span 2` in col 1. Editor top-mid, Godot viewer top-right. Terminals span `col 2/span 2` bottom row. |
| U-CloudCluster | `210px minmax(0,0.9fr) minmax(0,1.1fr)` | `minmax(0,1fr) 230px` | Remote explorer spans both rows col 1. File viewer top-mid, Blender viewer top-right. Streamed terminal spans `col 2/span 2` bottom. |
| U-DragDrop (Code) | `220px minmax(0,1fr)` | `minmax(0,1fr) 200px` | Explorer spans both rows. Editor top, Terminals bottom. |
| K-Shell (v2, Code) | fixed `290px` explorer, flexible editor+`230px`-tall terminal stack, fixed `360/380px` right aside | — | Not a CSS grid; flex column nesting. |

Minimum pane size per the written spec: **200 × 120 px**. Region border is `1px solid #222425`
normally, `1px solid #36393a` (border-strong) on the pane treated as "focused" in the mock (editor
pane in U-Workspace, Blender viewer with an open comment in U-CloudCluster, Play pane in
U-GodotPlay).

### 1.6 Pane/tab-strip chrome (generic, reused by every pane type)

- **Header/tab strip**: `height 34px` in every v3 cluster board (viewer headers, editor tab strips,
  terminal tab strips) vs `height 38px` for the editor's tab row in K-Shell — **inconsistent with the
  `h-paneltabs` token (36px)**; no board actually renders 36px. Flag in §5.
  - Editor/terminal **tabs**: `padding 0 12px`, `font-size 12.5–13px`. Active tab: `color txt-primary`,
    `box-shadow: inset 0 -2px 0 accent` (the 2-px underline). Modified-file dot: `6–7px` amber circle
    after the label (Tabs README: turns into `×` on hover — not rendered statically in any board).
    File-type colour square: `11–12px`, `radius 3px`, solid colour keyed by extension (`.gd` → `#7fc8f8`
    = syn-type, `.rs` → `#e5734b` unlisted colour — see §5, `.tscn` → `#6f96ff`, `.toml`/`.md` greys).
  - Viewer headers (Godot/Blender/File viewer): same 34px strip, `gap 8px`, a mode badge
    (`height 16–18px`, `radius 4px`, `background #222425 color #afb3b6`, `font 10px font-weight 600
    letter-spacing .04em`, e.g. "GODOT VIEWER · READ-ONLY", "READ-ONLY · AGENT DRIVING") and a trailing
    **segmented mini-control** (Scene/Play, Model/Renders/Wire, Code/Build steps) using the Tabs
    component's "segmented" style at a denser `20px` row height inside a `2px`-padded track.
- **Tree rows** (explorer): `height 26–28px`, `padding: 0 6px 0 <indent>px`. **v3 cluster boards**
  (U-Workspace, U-CloudCluster) use `indent = 6 + depth×12`, a `12×12` file/folder colour swatch, and
  a `16×16` git chip. **K-Shell / the TreeRow component README** specify `indent = 8 + depth×14`, a
  `14px` file-type icon and an `18×18` GitChip. These are two different implementations of the same
  row — flag as a contradiction (§5), K-Shell/TreeRow-README is presumably the one to keep since it
  matches the published GitChip spec (18px).
- **Terminal content**: mono `12–12.5px`, `line-height 19–20px`. Agent-driven terminals render a feed
  of bulleted lines (`●` in the accent or info colour + action text + muted detail in a trailing
  `<span style="color:#959a9d">`), ending in a message box (`border 1px #2c2e30 radius 8px background
  #181a1b`, placeholder "Message claude…" / "Message the cloud agent…"). Human terminals show a real
  prompt with a blinking-block cursor (`8×15px`, `background accent`).

### 1.7 Right-side project-page rail

`width 44px`, `flex-shrink 0`, `flex-direction column`, `align-items center`, `gap 4px`,
`padding: 2px 0 6px`. Sits directly on `bg-canvas` (it is chrome, not a bordered region). Six buttons
in fixed order — **Git, Plane, Cloud agents, Hindsight, Cost, Artifact registry (later)** — each
`36×36`, `radius 8px`, `16px` Lucide-style icon at `stroke-width 1.4`. Active/selected page:
`border 1px #2c2e30`, `background #1d1f20`, icon colour = `accent`. Inactive: transparent, icon
`#afb3b6` (txt-tertiary). Disabled/future (Artifact registry, and Cloud agents while it is switched
off for the MVP): `opacity 0.45`. Unread/attention dot:
`7×7` circle, `position absolute right 5px top 5px`, `border 2px solid #0f0f10` (bg-canvas, creates
the notch), colour per the written spec's rail-dot table (§4 of VEISTRA-UX-REWORK.md). Alt 1–6 open
the pages in that order (from U-Spec's key list).

### 1.8 Docked vs expanded page geometry

- **Docked**: page renders as an `aside` sibling of the pane grid, inside the same `gap:6px` flex
  row, width **380px** in U-DockedPages' three mockups (matches token `w-panel-default`). Written
  spec allows 320–640px, so 380 is the default, not a fixed value. The rail (44px) still shows to
  its right. K-Shell's Source-control aside is `360px` (v2) / `330px` (U-Workspace's Git aside,
  v3) — three different docked widths across the file set (330 / 360 / 380px); flag in §5.
- **Expanded**: page replaces the entire pane-grid area (title bar, cluster row's *breadcrumb*
  variant, and the rail persist). The cluster row is replaced by a single 40px header: a
  **"← <cluster name>" back button** (`height 30px`, chevron-left icon, `Esc` hint in mono,
  optionally an activity pill like "1 working") + page title (`15px font-weight 600`) + context
  subtitle + page-specific status pills + right-aligned actions (`Open in browser`, `Dock beside
  panes`, `New agent session`, …). Per the written spec, panes never unmount while a page is
  expanded (confirmed conceptually, not independently visible in a static mock). `Esc` returns to
  the cluster; `Ctrl Shift E` toggles expand/dock (from U-Spec's key table).

### 1.9 Status bar (26px)

`padding 0 12px`, `gap 14px`, `font-size 12px`, `color #afb3b6`. Left cluster: project name
(`color #e4e6e6 font-weight 500`), branch/environment (mono), diff stat (`+N` in `#6fcf86`, `−N` in
`#f08a80` — **neither is an exact token**, see §5). Code-context-only (K-Shell): cursor position
"Ln 10, Col 1", "UTF-8", language "Rust". Right cluster (`margin-left:auto` on the first item):
dot+label status chips (GitHub connected, Plane asleep/running, "N local · N cloud agent", "Worker
VM", "GPU node rendering") and, on every v3 cluster board, a trailing **"main is read-only"** label
reinforcing the core principle. "Layout saved" appears in U-Project/U-DragDrop as a transient
save-confirmation string in the same slot.

---

## 2. Board-by-board

### Board 01 — U-Anatomy ("Principle & anatomy")
A 2-column explainer, not a real app screen: full-bleed dark canvas, `padding 40px 48px`. Top: an
amber principle callout (`radius 12px background #3b2612 border 1px #6b4520`, lock icon, heading
"Agents never work on main.", body copy — colours `#f7dcc0`/`#e8c9a8` are not tokens, see §5). Left
column (flex-grow, "ONE PROJECT, MANY ENVIRONMENTS" label): a "main · Anomaly" summary row (icon +
name + hash), then a 3-column grid of **environment cards** (worktree ×2, cloud ×1) each showing
kind badge, mono name, description, a divider, "CLUSTER" label, the bound cluster's name chip and its
pane summary in one sentence — this is the canonical description of what "cluster = environment"
means. Below: a dashed note about the one-way merge flow. Right column: a numbered 6-item **legend**
(circular accent badges 1–6, title + description) explaining cluster=environment, panes-follow-
environment, engines-run-headless, comment-on-what-you-see, edit-by-hand-on-purpose, right-side-is-
project-wide. No interactive states; pure reference content.

### Board 02 — U-Workspace ("Local worktree cluster")
The canonical **local worktree cluster** screen — see §1 for full chrome measurements. Cluster tab
strip: Design canvas (pinned) · **Flashlight** (selected, `wt`, amber dot) · ANOM-142 (`cloud`, blue
dot) · Audio (`wt`, you) · Browse (`main`, lock). Environment bar: `wt/flashlight-cone`, `↑3 ↓0`,
"claude working here", **Review & merge**. Panes: Explorer (12 rows, `flashlight.gd` selected + `M`
chip, `main.tscn` `M`, `render_view.gd` `A`), Editor (GDScript, `flashlight.gd` active with a
highlighted diff line `@export var cone_degrees := 34.0  + agent`, `lidar_scan.gd` tab with a
modified dot), Godot viewer (headless render placeholder, an open numbered comment pin "1" with a
popover showing author "you", comment text, and "Agent reads this on its next turn"; footer: Comment
button with "1 open" count, "Open in Godot", primary "Play"), Terminals (3 tabs: `claude`[working],
`godot --headless`, `pwsh`; cwd shown top-right; feed of 3 agent actions ending in a resolved-comment
note and a message box). Git aside (330px): ENVIRONMENTS list (3 rows with state labels
working/streaming/idle), CHANGES IN wt/flashlight-cone (3 rows: `flashlight.gd` M, `main.tscn` M,
`render_view.gd` A, each tagged "claude"), footer: "3 commits ahead of main · checks pass", primary
**Open PR into main**, secondary **Discard environment…**.

### Board 03 — U-CloudCluster ("Cloud session cluster")
The canonical **cloud session** screen. Environment bar (blue variant, see §1.4): `job-7f3a`,
"worker VM · branch agent/anom-142 from main@d17dbdb", streaming·42ms pill, **Pull into local
worktree** / **Stop session**. Panes: Remote explorer (`REMOTE` badge, footer note "Files live on
the worker VM. They are read over IAP and nothing is copied until you pull."), File viewer
(`build_bed.py`, Blender python script, badge "READ-ONLY · AGENT DRIVING", segmented Code / **Build
steps** — the latter disabled-looking with a "LATER" micro-label and a tooltip about the future
step-diagram feature from VEISTRA-UX-REWORK.md §8), Blender viewer (`hospital-bed.glb v2`, badge
"BLENDER VIEWER · READ-ONLY", segmented Model/Renders·4/Wire, an orbit hint, a selected-mesh comment
composer inline — not just a popover but an open `<textarea>`-style box with Cancel/**Comment for
agent** buttons — footer: tri-count "3,612 tris · 2 materials", "1 open comment", **Open in
Blender**), Streamed agent terminal (spans both right columns, tabs `claude·job-7f3a`[LIVE badge] /
`blender -b` / `ssh worker`, 4-line action feed ending in "v2 is ready in the viewer. Waiting for
comments or accept." + a blue-tinted "Message the cloud agent…" box). Status bar: "cloud · job-7f3a",
branch mono, "GPU node rendering" info dot.

### Board 04 — U-NewCluster ("New cluster: where it runs")
Modal dialog over a dimmed (`opacity 0.3` skeleton + `rgb(0 0 0/0.45)` backdrop) workspace. `role
dialog`, `width 980px`, `radius 12px`, `shadow 0 24px 48px -12px rgb(0 0 0/0.7)`. Header: title +
one-line description. Two-column body (`1.25fr / 1fr`, divided by a 1px border):
- **Left, `role="radiogroup"` "ENVIRONMENT"**: 4 options, each a card (`radius 10px`, selected gets
  `border accent background #222425`, a filled radio dot, else `border #2c2e30 background #181a1b`
  with an empty radio): **New local worktree** (selected in the mock) — expands an inline detail grid
  (2×2) once selected: Work item (prefilled `ANOM-157 Monster pathing`), Branch (accent-bordered mono
  field `wt/anom-157-pathing`), From (`main@d17dbdb`), "Who works here" 2-segment control (**Local
  agent** selected / Me); **Existing environment** (reopen a listed worktree or finished cloud
  session); **Cloud session** (blue icon tile, runs on the worker VM); **Browse main (read-only)**
  (no agent, no writable terminal, nothing to merge).
- **Right, "STARTING LAYOUT"**: 4 rows, each a `64×42px` mini pane-diagram icon (explorer strip +
  2 content blocks, colour-coded per layout) + title + one-line pane list: **Code** (Explorer·editor·
  terminal), **Godot** (Explorer·Godot viewer·Play·terminal — highlighted/selected in the mock),
  **Blender** (Explorer·Blender viewer·terminal), **Watch an agent** (Streamed terminal·explorer·
  viewer). Caption: "You can rearrange panes later. The layout is saved with the cluster."

Footer: left icon+note "Nothing in Veistra writes to main. Merges go through Git → PR."; right
**Cancel** (ghost) + primary **"Create worktree and cluster"** (label changes per selected option,
not shown for the other 3 states).

### Board 05 — U-GodotPlay ("Play the game & comment")
Cluster row shows Flashlight selected (`wt` chip) among Design canvas / ANOM-142 / Audio. **Play
pane** (flex-grow, border-strong): header (40px) — "Playing" pill (green, dot), "Anomaly · debug
build", meta "from wt/flashlight-cone · exported headless 1 min ago · 60 fps", right transport
controls (Pause/Restart/Stop, `28×28` ghost icon buttons) + primary **"Capture & comment"** (`F5` /
`Ctrl Shift C` per the keys table). Viewport: dark first-person game render placeholder with a
battery HUD (`90×8px` bar + "BATTERY 38%" mono label), a numbered comment pin ("3", `22×22`
rounded-square accent badge) positioned over the in-game subject, and a "Mouse captured · Esc
releases" hint chip top-right. Footer strip (36px): scene path (mono), playhead time `t=00:42.8`,
right-aligned "The game runs only the environment's build. Nothing you do here edits files."
**Comments aside** (360px): header "Comments" + env label + "2 unread by agent" pill (info). 3 comment
cards (numbered pin badge, anchor line e.g. "Play · 00:42.8 · hospital_wing" / "Scene ·
Player/Flashlight", state label Open[blue]/Resolved[green], optional 70px screenshot thumbnail,
comment text, reply/resolution meta). Footer: explanation of `.veistra/comments/` + **Open in Godot** /
primary **"Send to agent now"**.

### Board 06 — U-Cost ("Cost, expanded — UI-7 charts")
1440×**1080** canvas (taller than the 900px standard — Cost's expanded page needs the extra height).
Header row: back-to-cluster "Flashlight" (Esc), title "Cost", subtitle "veistra-prod · September
2026", a **"FIXTURE DATA"** badge (flagging this board's numbers are illustrative), right meta
"Estimate updated 40 s ago · polls every minute" + secondary **"Dock beside panes"**. Main region
(single large panel):
- Headline column (300px) + **C1** chart side by side, exactly matching VEISTRA-UX-REWORK.md §4's
  "Docked... Expanded, it shows C1 beside the headline figures": Spent to date `$88.40` (32px mono),
  Forecast month end `$94.70` (20px mono), Budget `$150` + green "Under budget · 63%" pill. **C1**
  ("Will this month land under budget?", labelled `C1` in the corner): SVG line chart, gridlines at
  $0/$50/$100, a red dashed budget line + "Budget $150" label, a solid accent actual-spend line to
  "now", a dashed accent forecast segment beyond it, "now $88.40" callout, x-axis Sep 1/28/30,
  3-item legend (solid=Spent estimated, dashed accent=Forecast, dashed red=Budget), caption: "Two
  real points from the estimate. It becomes a daily line when the billing export is on."
- **C2** + **C3** side by side (2-col grid), matching "then C2 and C3 side by side": **C2** ("Where
  does the money go?") — 150×150 SVG donut (5 segments, chart-1..5) with centre total, + a legend
  list (swatch, name, `$` value, `%`) for Machines/Disks/Cloud Run/Addresses/Cloud Storage. **C3**
  ("Which resources cost the most?") — 9 horizontal bar rows (mono name, 10px rounded bar, `$`
  value), covering worker-vm, gpu-node (Spot), veistra-api (Run), worker-vm boot disk, plane-vm,
  plane-data disk, worker static IP, veistra-artifacts, Other.
- **"FROM THE BILL"** section (label + "C4 daily by service · C5 last 6 months · C6 estimate vs
  billed" caption): 3-column grid of dashed-border placeholder cards (min-height 96px), each with a
  question heading + `C4`/`C5`/`C6` id chip + the exact `notEnabled` copy: "The Cloud Billing export
  to BigQuery is off, so this chart has no data yet. Turn it on in the Google Cloud console for
  veistra-prod. Data appears a few hours later." This matches VEISTRA-UX-REWORK.md §4 precisely.

Footer: "Charts: Apache ECharts · colours from --chart-1…6 tokens".

### Board 07 — U-DragDrop ("Drag a tab to split")
Demonstrates the **five drop zones** (written spec §5) mid-drag. Cluster row: current cluster
"Flashlight · wt" solid, three **dashed ghost targets** (ANOM-142·cloud, Audio·wt, Design canvas) and
a dashed "+ New cluster" ghost, plus caption "Drop on a cluster to move the tab there" — this row
shows what every *other* cluster looks like as a drop target while dragging, confirming environment-
scoped drop rules visually (all shown as valid here since it's a same-environment demo; the written
spec says a cross-environment drop is refused with a hint, not shown statically). Editor pane:
`flashlight.gd` active tab, `lidar_scan.gd` rendered as a **dashed ghost tab** (the tab currently
being dragged, `border 1px dashed #36393a`), `player.tscn` plain. An absolutely-positioned 3×3-ish
overlay (`pointer-events:none`) shows the 5 zones: **Split up** (full-width top), **Split left** /
**Add as tab** (middle row sides), **Split right** highlighted/active (accent `2px` border + accent
`14%`-alpha fill + icon + label — the zone under the cursor), **Split down** (full-width bottom). A
floating drag-ghost (cursor arrow + a shadowed chip reading "lidar_scan.gd") sits near the target
zone. Bottom-center floating hint bar: **"Split right"** (bold, live zone name) `|` **Ctrl** copy
instead of move `|` **Esc** cancel.

### Board 08 — U-Project ("Switch project, restore state")
Two things layered on a dimmed (`opacity 0.35`) skeleton workspace:
1. **"Switch project" dialog** (`Ctrl Alt P`, matches the project-pill's open state in §1.2):
   `width 620px`, positioned `top:46px` centered — i.e. it drops from the title-bar pill, not
   screen-centered like the New Cluster dialog. Header: search icon + "Switch project…" placeholder +
   `Ctrl Alt P` hint. 4 project rows, each: 32px colour-tile with initial, name + branch (mono) +
   "OPEN" badge if current, one-line layout summary (e.g. "3 environments · Flashlight (wt) active ·
   4 panes · Git docked"), a wrapped row of status chips (work=amber "1 agent working", ok=green
   "cloud session finished", idle=grey "Plane asleep"/"nothing running"), right-aligned relative time
   (now / 2 h ago / yesterday / last week). Footer: **Open folder…** / **New project** secondary
   buttons, right note "Agents keep running when you switch away".
2. **Restore toast** (bottom-right, `330px`, independent of the dialog — depicts what happens *after*
   you pick a project): spinner + "Restoring Torn Apart" + "2 environments · 6 panes · cloud stream
   reattached · Git docked" — a concrete example of VEISTRA-UX-REWORK.md §6's restore order
   (environments first, then clusters, then tabs, then right page).

### Board 09 — U-PlaneFull ("Plane, expanded")
Header: back "Code" (with a "1 working" amber pill), title "Plane" + "Anomaly · Work items", a green
"plane-vm running · stops after 30 min idle" pill, right **Open in browser** / **Dock beside panes**.
Main region, labelled "Plane (embedded)" / footnote "Plane CE · unmodified webview": segmented
List/Board/Cycles view tabs; two grouped lists ("In progress" ×4 items, "Todo" ×5 items), group
header = ring+fill status icon + name + count; each 42px item row = ID (mono) + title + optional
`ai:*` pill (breakdown=violet, queued=amber, done=green — see §5 for the missing violet-subtle/
txt-violet token pair) + a bordered label chip + due date + a coloured initials avatar. Selected row
(`ANOM-142`) highlighted. **Right aside** (320px, "Veistra actions for the selected work item"):
selected item header (ID + 15px title), **"Run an agent on this"** — 4 stacked 44px action buttons
(Break it into tasks/`ai:breakdown`, Gather context/`ai:context`, Do it on the worker VM/`ai:do`,
Review cycle scope/`ai:plan-cycle`), **"Work locally"** — primary **"Start in a new worktree"** +
caption: "Creates worktree wt/anom-142 from main and opens a cluster on it with a claude terminal.
The work item is its context. Main is never touched." This is the concrete UI for VEISTRA-UX-REWORK.md
§4's "Start in a new worktree from the selected work item."

### Board 10 — U-AgentsFull ("Cloud agents, expanded")
Header: back "Code" (Esc), title "Cloud agents" + "Anomaly", status pills "Worker VM running"
(green), "GPU node stopped" (idle grey), a plain "MAX_AI_JOBS 1" chip, right **Dock beside panes** /
primary **"New agent session"**. **Sessions aside** (330px): segmented Live·1 / Queue·2 / History
tabs; 6 session rows (dot + title + relative time, sub-row = kind mono label + meta — "ANOM-142",
"queued", "done · 6 files", "failed · Blender exit 1"). **Live session detail** (flex-grow): header
block — `job-7f3a · ANOM-142` (mono) + amber "Running · 4m 12s" pill, 17px title "Break down: Port
flashlight and LiDAR shader", meta line "ai:breakdown · claude -p on the worker VM · branch
agent/anom-142 · Plane MCP, Hindsight (godot-build)"; right **Open as cluster** (secondary — binds a
new cluster to this session, per written spec §2.4) / **Stop** (danger). Sub-tabs (38px strip):
Activity (active, accent underline) / Terminal / Changes (badge "3") / Memory used. Activity feed:
9 timestamped rows (mono time, coloured icon badge by kind — read=grey, mem=violet "recall",
add=green "created", tool=blue), title + mono detail. Trailing live-typing indicator: pulsing dot +
"Writing estimates for 6 child items…".

### Board 11 — U-DockedPages ("Hindsight, Cost, Registry docked")
Not a live app screen but an explicit **docked-width gallery**: header "Docked project pages" +
caption "shown at the docked width (380 px) · fixture data", then a 3-column grid, each column an
independent 380px `aside` mock:
- **Hindsight**: header + `:8888` connection status pill (green) + close. "Recall from memory…"
  search field. "MEMORY BANKS" — 2 bank cards (`godot-build` 62% fill / `asset-build` 38% fill,
  violet `#a585f0` progress bars, "N memories", "Last retain…"/"Recalled N× today"). "ACTIVITY" — 5
  events, each a kind chip (RETAIN=violet, RECALL=blue) + text + meta (bank · time).
- **Cost**: headline `$88.40` of `$150` · forecast `$94.70`; a mini 90px-tall C1 sparkline (same
  construction as the full C1, scaled down); "BY CATEGORY · FORECAST" — 5 compact bar rows; a dashed
  note box: "Daily and monthly charts need the Cloud Billing export to BigQuery. Expand the page to
  see what is waiting on it." — directly ties the docked and expanded Cost views together.
- **Artifact registry**: "LATER" badge in the header; 2×2 grid of asset cards (96px placeholder
  swatch + name + version(mono) + state pill — review=amber, accepted=green — for Chair(test) v2,
  Lantern v1, Door frame v3, Crate v1); footer note: "It reads gs://veistra-artifacts/anomaly/.
  Accept, reject or leave feedback here, and each choice opens a review round for the agent."

### Board 12 — U-Design ("Design canvas cluster")
Cluster row: **Design canvas** pinned first (`wt/design` chip + pin glyph + divider, selected here),
then Flashlight / ANOM-142 / Audio unselected — confirms it is always tab #1 and always visible.
Canvas pane (border-strong, "focused"): breadcrumb "Anomaly / Levels / **Hospital wing**" + mono path
`canvas/levels/hospital-wing.json` + segmented Canvas / "Asset list · 9" tabs. Canvas surface: dotted
grid background; a **frame node** "Ward B" (dashed container implying a nested/child canvas) holding
two solid rectangles + one dashed "corridor · flicker lights" annotation (italic label); a rotated
amber **sticky note** ("Player learns the scan gun here. Keep it dark until the first scan.") linked
by a curved connector arrow to an **Asset spec card** (accent border + halo glow, header "ASSET SPEC"
+ "DRAFT" badge, body: name/type/tris+texture line); a floating **bottom toolbar** (pill, 7 tools:
Select[active] / Frame / Rectangle / Arrow / Text / Sticky note / Asset spec) and a zoom chip "86%"
bottom-right. **Asset spec inspector aside** (340px): 6 labelled fields (Name, Type, Registry path
[mono], Triangle budget, Texture size, Style notes) as 30px bordered display rows, plus a dashed
"Reference" dropzone (72px, "Drop images or link a frame"). Footer: primary **"Go · build on the
worker VM"** + caption: "Starts a cloud session with this spec and the asset-build memory, and opens
it as a cluster. You watch the build in the Blender viewer and comment on parts. Accepted versions go
to the Artifact registry." — this is the literal UI for VEISTRA-UX-REWORK.md §5's "Its asset spec Go
starts a cloud session and opens it as a cluster with the Blender viewer." Status bar: "Design canvas
· 9 asset specs · 3 in review" · right "Saved to wt/design · merges with the next PR".

### Board 13 — U-Spec ("Rules for the rework")
A 1440×**1560** reference page (not an app screen) that mirrors most of `VEISTRA-UX-REWORK.md`,
rendered for engineers. Amber principle banner (same style as board 01's, `#6b4520` border). 3-column
rule cards — **Environments** (7 bullets), **Viewers, Play and comments** (7 bullets), **Panes and
the right side** (6 bullets) — each a bulleted list, phrased slightly differently from the .md but
matching it in substance. **"Project pages (the right side)"** table: PAGE / OPENS (Docked=grey chip,
Expanded=amber chip) / RAIL DOT / SHOWS / KEY columns, 6 rows (Git…Artifact registry), matching
VEISTRA-UX-REWORK.md §4's table content and wording closely (not verbatim). **"What is saved, and
where"**: 3 cards (App / **Project workspace**[accent-highlighted] / Environment) matching §6's
table, plus a literal **workspace-state JSON schema** `<pre>` block:
```json
{
  "v": 2, "project": "anomaly", "activeCluster": "flashlight",
  "environments": {
    "wt-flashlight": { "kind": "worktree", "branch": "wt/flashlight-cone", "base": "main@d17dbdb",
                       "path": ".veistra/worktrees/flashlight-cone", "agent": "claude" },
    "job-7f3a":      { "kind": "cloud", "session": "job-7f3a", "branch": "agent/anom-142", "vm": "worker" },
    "wt-design":     { "kind": "worktree", "branch": "wt/design", "standing": true }
  },
  "clusters": [
    { "id": "design", "env": "wt-design", "pinned": true, "root": { "pane": "p0", "tabs": ["canvas:levels/hospital-wing"] } },
    { "id": "flashlight", "name": "Flashlight", "env": "wt-flashlight", "root": { "split": "row", "sizes": [0.16, 0.84], "children": [
        { "pane": "p1", "tabs": ["explorer"] },
        { "split": "column", "sizes": [0.72, 0.28], "children": [
            { "split": "row", "children": [ { "pane": "p2", "tabs": ["file:player/flashlight.gd"] },
                                            { "pane": "p3", "tabs": ["godot-view:main.tscn", "play"] } ] },
            { "pane": "p4", "tabs": ["term:claude", "term:godot-headless"] } ] } ] } },
    { "id": "anom-142", "env": "job-7f3a", "root": { "pane": "p5", "tabs": ["stream:job-7f3a", "blender-view:hospital-bed.glb"] } }
  ],
  "rightPage": { "open": "git", "mode": "docked", "width": 330, "overrides": { "plane": "expanded" } }
}
```
Note this schema's `rightPage.width` example is **330**, not 380 — a third docked-width value (see
§5). **"Keys"** card: 14 shortcuts — New cluster `Ctrl Shift N`, Switch project `Ctrl Alt P`, Search
in environment `Ctrl K`, Next cluster `Ctrl Tab`, Project page 1–6 `Alt 1–6`, Expand/dock page
`Ctrl Shift E`, Back to cluster `Esc`, Split pane right `Ctrl \`, Maximise pane `Ctrl Shift M`, Play
`F5`, Capture & comment `Ctrl Shift C`, Open in Godot/Blender `Ctrl Shift O`, Message the agent
`Ctrl Shift A`, Review & merge `Ctrl Shift R`.

### Board 14 — U-NewProject ("New project")
Full page (960px canvas), reached from Home → New Project (no cluster chrome — Home is outside any
project). Header: **"← Home"** ghost button, title "New project" (17px), caption "Everything is set
up in one step. Nothing is created until you press Create." Body: 2-col grid — form (flexible) /
420px right rail.
- **1 · WHAT IT IS**: 3-option radiogroup — **Game** (selected: "Godot project, artifact registry,
  asset pipeline and play-testing. Anomaly and Torn Apart are games."), **Tool or service** ("Code
  only. No engine, no asset pipeline. Veistra itself is one."), **Open existing** ("A folder or repo
  that already has veistra.toml. Veistra just links it.").
- **2 · NAME**: 3 fields — Project name (text input, focused/accent state shown, value "Torn Apart"),
  Slug (mono, "torn-apart", helper "Used in paths and buckets. Can't change later."), Plane ID (mono,
  "TORN", helper "TORN-1, TORN-2 …").
- **3 · CODE**: segmented control (New GitHub repo[selected] / Existing repo / Local folder); 3-col
  detail row (Owner/name mono "Firelight-Innovations/torn-apart", Template dropdown "Godot 4.5 game",
  Clone to mono path); checkbox "Protect main on GitHub: PRs only, no direct pushes" (checked by
  default, matching §7's "on by default").
- **4 · PROJECT SERVICES**: 5 bordered toggle rows (icon, title+description, right-aligned mono value
  preview, `Toggle` switch): Plane project (**on**, "TORN"), Artifact registry (**on**,
  `gs://veistra-artifacts/torn-apart/`), Hindsight banks (**on**, "asset-build · godot-build"),
  Design canvas (**on**, "wt/design"), Cost label (**off**, "project=torn-apart" — matches §7's "off
  until resource labels exist").

**Right rail "WHAT CREATE DOES"**: 8 numbered steps (circular badges), matching VEISTRA-UX-REWORK.md
§7 exactly: 1 Create the GitHub repo from the template (mono detail: owner/name · main protected),
2 Clone it and write veistra.toml (mono path), 3 Wake Plane and create the project (TORN · states ·
ai:* labels), 4 Create the registry folder, 5 Create the Hindsight banks, 6 Write the project record
(`gs://veistra-projects/prod/projects/torn-apart.json`), 7 Create wt/design, 8 Open the project
("Design canvas cluster, then 'New cluster' to start work" — step 8's detail line is **not mono**,
unlike steps 1–7, an intentional distinction in the mock's `st()` helper worth preserving: mono for
machine-generated paths/ids, plain prose for the final human action). Failure note box: "If any step
fails, Veistra undoes the ones before it (the Plane project and record are rolled back) and shows which
step failed. Nothing is left half-made." Footer: **Cancel** / primary **"Create Torn Apart"** (label
interpolates the project name).

---

## 3. Component list

| Component | Variants / states | Sizes | Key tokens |
|---|---|---|---|
| **Button** | primary, secondary, ghost, danger, icon-only | `control-sm`(24) row actions · `control-md`(28) default · `control-lg`(32) commit/search · `control-xl`(36) dialogs · `control-2xl`(40) Home | fill `accent`→`accent-hover`; secondary `bg-layer-2`+`border-strong`→`border-strong-1`; ghost hover `bg-layer-1-hover`; danger `danger-subtle`/`txt-danger`→solid `danger`; text `txt-on-accent`; focus 2px `accent` outline offset 2; disabled `bg-layer-1-selected`/`txt-disabled`; `radius-md` |
| **StatusBadge** | danger, warning, success, info, idle; count-badge variant | 22px (badge), 18px (count pill) | `*-subtle` fill + `txt-*` + `*` 6px dot per state table in the README; count pill `accent-subtle`/`txt-accent` |
| **GitChip** | M, A, D, U, R | 18×18 | M `warning-subtle`/`txt-warning`; A `success-subtle`/`txt-success`; D `danger-subtle`/`txt-danger`; U `info-subtle`/`txt-info`; R `bg-layer-1-selected`/`txt-tertiary`; `radius-sm`; deleted-file name gets `txt-placeholder` strikethrough |
| **Tabs** | app-switcher pill, editor/pane flat tab, segmented control | switcher 30px pill `radius-lg`; pane strip `h-paneltabs`(36, but boards render 34/38 — see §5); segmented 24px track rows, 2px padding | active switcher: `bg-layer-2` + `border-subtle-1` + `shadow-raised`; inactive `txt-tertiary`; attention dot 6px `warning`; drop target dashed `accent` over `accent-subtle`; active pane tab: `txt-primary` + 2px inset `accent` underline; modified dot 7px `warning`→`×` on hover; segmented selected `bg-layer-1-selected` |
| **Toggle** | on / off | 36×20 | on: track `accent`, knob `txt-on-accent`; off: track `border-strong`, knob `txt-tertiary`; `role=switch` |
| **Field** | rest, focus, error | 32px (`control-lg`, settings) / 28px (dense panels) | `bg-layer-1` + `border-subtle-1`; focus → `accent` edge + 3px `accent-subtle` halo; error → `danger` edge + `txt-danger` helper; helper text `caption`/`txt-tertiary`; mono for code-like values |
| **TreeRow** | rest, hover, selected, ignored, drop-target | 28px (per README) — **cluster boards render 26px**, see §5 | rest transparent/`txt-secondary`; hover `bg-layer-1-hover`/`txt-primary`; selected `bg-layer-1-selected` + weight 500 (fill only, no side bar); ignored `txt-disabled`; drop target `accent-subtle` + 1px inset `accent` ring; indent 14px/depth + 8px base (README) vs 12px/depth + 6px base (cluster boards — contradiction); chevron 10px `txt-disabled`; file icon 14px (README) vs 12px (cluster boards) |
| **Env chip** *(new, undocumented in the design-system README — only in v3 boards)* | `wt`, `cloud`, `main`, `canvas` (pinned design) | 20px h in a cluster tab, 22px h standalone in the environment bar | wt/main neutral `bg-layer-3`/`txt-secondary`; cloud `info-subtle`/`txt-info`; needs its own component doc |
| **Environment bar** *(new)* | worktree, cloud | 36px height, full pane-grid width | worktree bg `bg-surface-1`/`border-subtle`; cloud bg/border have no exact tokens (see §5); contains kind chip, branch, ahead/behind or streaming pill, action button(s) |
| **Project-page rail button** *(new)* | active, inactive, disabled/future, with/without unread dot | 36×36, icon 18px | active `bg-layer-2` + `border-subtle-1` + `accent` icon; inactive `txt-tertiary`; disabled `opacity .45`; dot 7px, 2px `bg-canvas` ring, colour per page-specific rule |
| **Dialog** | New cluster (980px, 2-col), Switch project (620px, dropped from title pill), New Project (full-page, not modal) | `radius-xl`(12px), `shadow-overlay` | backdrop `bg-backdrop`; header/body/footer 3-part layout; footer holds ghost Cancel + primary confirm |
| **Comment pin/card** *(new)* | open, resolved, with/without screenshot | pin badge ~20×20 rounded-square-with-notch | open pin `accent`/muted-grey when resolved; state label `txt-info`(open)/`txt-success`(resolved) |
| **Chart primitives (C1–C6)** | line (C1), donut (C2), horizontal bar (C3), 3× "from the bill" placeholder (C4–6) | via Apache ECharts per written spec | `chart-1`…`chart-6`, `chart-grid`; budget line uses `danger` directly, not a chart token |
| **Cover** | n/a — design-system card-cover generator, not an app UI component | 960×288 | uses `mark-rust`/`accent`/`accent-subtle`/`txt-primary`, region/pill radii — informative for icon/brand tiling only |

---

## 4. Token table

### 4.1 Color — grouped by role (dark / light)

**Backgrounds**
| Token | Dark | Light | Usage |
|---|---|---|---|
| `bg-canvas` | `#0f0f10` | `#f2f2f3` | Window root only: title bar, switcher, status bar, 6px gutters |
| `bg-surface-1` | `#141415` | `#ffffff` | Every region (sibling, never nested) |
| `bg-surface-2` | `#181a1b` | `#fcfcfc` | Secondary region beside a surface-1 (rare) |
| `bg-layer-1` | `#181a1b` | `#f9f9f9` | Rows, inputs, cards inside a region |
| `bg-layer-1-hover` | `#1d1f20` | `#f2f2f3` | Hover on layer-1 / transparent rows |
| `bg-layer-1-selected` | `#222425` | `#eaebec` | Selected tree row/terminal/settings section/segmented tab |
| `bg-layer-2` | `#1d1f20` | `#ffffff` | Active switcher/cluster tab, menus, palette, chip-in-card |
| `bg-layer-2-hover` | `#222425` | `#fcfcfc` | Hover on layer-2 |
| `bg-layer-3` | `#222425` | `#f2f2f3` | Third depth: chip-in-menu, code-chip-in-card |
| `bg-inverse` | `#e4e6e6` | `#0f0f10` | Tooltips only |
| `bg-backdrop` | `rgba(0,0,0,.5)` | `rgba(15,15,16,.3)` | Behind palette/dialogs |

**Borders**
| Token | Dark | Light | Usage |
|---|---|---|---|
| `border-subtle` | `#222425` | `#eaebec` | Region edges, dividers |
| `border-subtle-1` | `#2c2e30` | `#e1e2e3` | Input/search field edges, overlay edges |
| `border-strong` | `#36393a` | `#d5d7d9` | Secondary button edge, checkbox edge, detached-window edge |
| `border-strong-1` | `#45484a` | `#cacdcf` | Secondary button hover edge |

**Text**
| Token | Dark | Light | Usage |
|---|---|---|---|
| `txt-primary` | `#e4e6e6` | `#0f0f10` | Titles, active tabs, selected rows, code |
| `txt-secondary` | `#cacdce` | `#313435` | Tree rows, menu items, body labels |
| `txt-tertiary` | `#afb3b6` | `#494d50` | Inactive tabs, descriptions, icon strokes (lightest allowed <16px) |
| `txt-placeholder` | `#959a9d` | `#5d6265` | Placeholders, section labels, kbd hints, paths |
| `txt-disabled` | `#7a8185` | `#767c7f` | Disabled controls; **below AA in light — never for required reading text** |

**Accent**
| Token | Dark | Light | Usage |
|---|---|---|---|
| `accent` | `#3f76ff` | `#2f62e0` | Default (Blue, Plane's brand blue; Amber is the original); tab underline, focus, drop targets, primary fill |
| `accent-hover` | `#5c8bff` | `#2853be` | Primary button hover |
| `accent-subtle` | `#192440` | `#e6ecfb` | Accent chips: branch chip, count badges, step numbers |
| `txt-accent` | `#799fff` | `#2853be` | Links, text on accent-subtle |
| `txt-on-accent` | `#0f0f10` | `#ffffff` | Text/icons on accent fill |
| `accent-blue` | `#3f76ff` | `#2f62e0` | Accent option (default) |
| `accent-green` | `#4cb863` | `#23803b` | Accent option |
| `accent-violet` | `#a585f0` | `#6c47c9` | Accent option |
| `accent-coral` | `#e5736b` | `#b8392f` | Accent option |

**Status** (each: dot / `*-subtle` fill / `txt-*` text)
| State | dot dark/light | subtle dark/light | txt dark/light |
|---|---|---|---|
| success | `#4cb863`/`#2f934b` | `#12301c`/`#e0f5e6` | `#8fdca1`/`#1f6b35` |
| warning | `#e0a030`/`#bb4d00` | `#3a2a0a`/`#fdf1dc` | `#f5cf73`/`#8a3a00` |
| danger | `#e5534b`/`#bf2c22` | `#3a1512`/`#fdf0ef` | `#f4a49c`/`#9c231b` |
| info | `#6f96ff`/`#155dfc` | `#16244a`/`#eef3ff` | `#a3c1ff`/`#1447c2` |
| idle (`state-idle`) | `#7a8185`/`#767c7f` | (uses `bg-layer-1-selected`) | `txt-tertiary` |

**Charts**: `chart-1`=`{accent}` both themes · `chart-2` `#6f96ff`/`#1f63b5` · `chart-3` `#4fc4bd`/
`#0e7c74` · `chart-4` `#a585f0`/`#6c47c9` · `chart-5` `#d96fb1`/`#a8326e` · `chart-6` `#9fd89a`/
`#23803b` · `chart-grid` `#222425`/`#eaebec`. Budget-line tone in every chart reuses `success`/
`warning`/`danger` directly, not a chart token.

**Syntax** (editor, dark/light): keyword `#c49bf2`/`#7a3fc4` · type `#7fc8f8`/`#1f63b5` · function
`#f0c674`/`#8a5a00` · string `#9fd89a`/`#23803b` · number `#e8a868`/`#a85a14` · comment `#7a8185`/
`#767c7f` (grey, not green).

**Brand mark** (never in UI chrome): `mark-rust` `#b4442e`.

### 4.2 Type scale
| Style | Size | Line-height | Weight | Family | Sample usage |
|---|---|---|---|---|---|
| `display` | 40px | 1.1 | 600 | sans | Home wordmark only |
| `h1` | 24px | 1.25 | 600 | sans | Settings section title, page title |
| `h2` | 16px | 1.35 | 600 | sans | Setting name, card title |
| `body` | 13px | 1.5 | 450 | sans | Tabs, tree rows, menus, buttons |
| `body-strong` | 13px | 1.5 | 500 | sans | Active tab, selected row, button label |
| `caption` | 12px | 1.45 | 450 | sans | Descriptions, meta, status bar |
| `label` | 11px | 1.3 | 600, `+0.04em` | sans | Uppercase section labels (STAGED CHANGES) |
| `code` | 13px | 22px | 400 | mono | Editor text |
| `mono-meta` | 12px | 1.4 | 400 | mono | Paths, hashes, ports, kbd hints |

Families: sans `Inter, "Inter Variable", system-ui, "Segoe UI", sans-serif`; mono `"IBM Plex Mono",
ui-monospace, "Cascadia Mono", Consolas, monospace`.

### 4.3 Spacing
`space-1` 4px (icon-to-label, small controls) · `space-1-5` 6px (region gutter; icon gap md controls)
· `space-2` 8px (row padding, button gap) · `space-3` 12px (panel padding) · `space-4` 16px (card/
settings-row padding) · `space-6` 24px (section gap, settings/Home).

### 4.4 Radius
`radius-sm` 4px (git chips, kbd hints, tags) · `radius-md` 6px (buttons, inputs, tree rows, badges) ·
`radius-lg` 8px (menus, switcher/cluster tabs, cards) · `radius-region` 10px (every canvas region) ·
`radius-xl` 12px (dialogs, palette, settings window).

### 4.5 Shadow
`shadow-raised`: dark `0 1px 2px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.25)` / light `0px 1px 2px -1px
rgba(41,47,61,.06), 0px 1px 3px 0px rgba(41,47,61,.05)` — active switcher tab, dragged tab.
`shadow-overlay`: dark `0 12px 32px -6px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.3)` / light `0px 10px
10px -5px rgba(41,47,61,.04), 0px 10px 40px -5px rgba(41,47,61,.04)` — menus, toasts, palette,
dialogs.

### 4.6 Size ladder
`control-sm` 24px (row actions, segmented panel tabs, git-chip row) · `control-md` 28px (default:
tree rows, buttons, inputs) · `control-lg` 32px (settings inputs, commit button, search field) ·
`control-xl` 36px (dialog buttons) · `control-2xl` 40px (Home start actions, onboarding) ·
`h-titlebar` 38px · `h-switcher` 40px · `h-paneltabs` 36px *(boards render 34/38, never 36 — see §5)*
· `h-statusbar` 26px · `w-panel-default` 380px (matches U-DockedPages' rendered width) ·
`w-panel-collapsed` 40px (identity with the 44px project-page rail is unconfirmed — see §5).

### 4.7 Tokens the written spec implies but `tokens.json` does not define
- A **semantic pair for violet/"memory" events** (Hindsight's RETAIN/RECALL chips, Plane's
  `ai:breakdown` pill): boards use `#261d3d`/`#c7b2f7` and `bg #261d3d`/`fg #a3c1ff`-adjacent hues
  that are close to, but not equal to, `accent-violet` (`#a585f0`/`#6c47c9`). Every other semantic
  state (success/warning/danger/info/idle) has a `*-subtle`/`txt-*` pair; violet does not.
- **Diff add/remove tones** used in the status bar (`+39`/`−6` as `#6fcf86`/`#f08a80`) and in
  terminal action bullets — close to but not identical to `success`/`danger`. No `diff-add`/
  `diff-remove` tokens exist.
- **Cloud-environment bar colours** (`#121a2b` bg, `#23365c` border, `#a3b4d6` meta text, `#2c4478`
  button border, `#dce6ff` button text) — a whole cloud-tinted mini-palette with no token names,
  distinct from `info`/`info-subtle`/`txt-info`.
- **Callout/banner colours** (`#3b2612` bg with `#6b4520` border, `#f7dcc0` heading, `#e8c9a8` body) —
  `#3b2612` matches `accent-subtle` (dark) exactly, but the border and text colours used alongside it
  do not match any token.
- **Link hover colour** `#f2c08c`, hardcoded in every board's `<style>` (`a:hover{color:#f2c08c}`) —
  not `txt-accent`, not `accent-hover`; a raw hex with no token.
- **Focus-ring alpha**: the README states focus rings are "2px at 45% alpha, offset 2," but no board
  renders that; halos observed are `accent@18%` (title-bar pill open state, board 08) and
  `accent@14%` (drag-drop zone fill, board 07) — two different alphas, neither 45%, and Field's
  README says its focus halo is the *solid* `accent-subtle` token, not an alpha ring at all.

---

## 5. Open questions / contradictions

1. **Apps vs Clusters — is the app-switcher gone?** K-Shell's (v2) second header row switches
   between *apps* (Cluster 1, File Explorer, File Viewer, Schematify) sitting as siblings on the
   canvas. Every v0.3 board replaces that row with a *cluster* switcher bound to environments, and no
   v0.3 board shows a top-level app anywhere. It's unclear whether apps (Schematify, Home, Files) now
   live only *inside* a cluster's pane tree as tabs, whether the app-switcher concept is retired
   outright, or whether it survives as a hidden second level. VEISTRA-UX-REWORK.md never mentions
   "apps" at all in v0.3. Needs an owner decision — this changes the shell's top-level object model.

2. **Three different docked-panel widths.** U-DockedPages renders and labels its mocks "380 px"
   (= `w-panel-default`). K-Shell's Source-control aside is `360px`. U-Workspace's Git aside is
   `330px`, and U-Spec's own JSON schema example gives `"width": 330`. The written spec's range
   (320–640px) accommodates all three, but there's no single canonical default in the artifacts —
   pick one (330? 380?) before building.

3. **`h-paneltabs` (36px) is never actually rendered.** Every tab/viewer-header strip in the v0.3
   boards is 34px; K-Shell's editor tab row is 38px. Either the token is wrong or every board is
   off by 2px — needs reconciling before engineers copy pixel values out of the boards.

4. **TreeRow geometry disagrees with its own component README.** The published TreeRow spec says
   indent = `8 + depth×14`, a 14px file icon, and an 18px GitChip (matching K-Shell's actual tree).
   U-Workspace and U-CloudCluster (the two boards showing the *current* file explorer) use
   indent = `6 + depth×12`, a 12px icon swatch, and a 16px git chip instead. One of these two needs
   to become the real spec; right now the documented component and the newest mockups disagree.

5. **Focus-ring alpha is inconsistent across three sources** (README says 45%, board 07's drop-zone
   fill is 14%, board 08's pill halo is 18%, Field's own README says its halo is a solid token, not
   an alpha ring). See §4.7's last bullet for the values; needs one definition.

6. **No token pair for "memory"/violet semantic state**, despite it appearing in two different
   places (Hindsight retain/recall chips, Plane's `ai:*` breakdown pill) with two slightly different
   hex pairs. If violet becomes a fifth semantic status (alongside success/warning/danger/info) it
   needs `violet-subtle`/`txt-violet` tokens; if it's meant to just be the `accent-violet` *option*
   repurposed as a semantic colour, that's a token-reuse decision that should be stated explicitly
   (today's boards don't use the accent-violet values exactly).

7. **Cloud-environment styling is an undocumented sub-palette.** The environment bar, session pills,
   "Pull into local worktree" button, and related cloud chrome all use one-off hexes (`#121a2b`,
   `#23365c`, `#a3b4d6`, `#2c4478`, `#dce6ff`) that resemble but don't equal `info`/`info-subtle`/
   `txt-info`. Either fold cloud chrome onto the existing info tokens (simpler, fewer special cases)
   or formally add a cloud-specific token set — right now it's neither.

8. **Diff-stat colours (`+N`/`−N`) have no token**, and reuse different hexes in different places
   (`#6fcf86`/`#f08a80` in the status bar vs the exact `success`/`danger` tokens elsewhere, e.g.
   K-Shell's own footer diff stat uses `#6fcf86`/`#f08a80` too, but a themed component would be
   expected to use `success`/`danger` directly). Recommend just mapping diff add/remove onto
   `success`/`danger` outright rather than inventing new tokens, unless the slightly different hue is
   deliberate (git-diff green/red convention vs the app's semantic green/red).

9. **The cluster-row search field and "N agents running" pill from K-Shell (v2) have no v0.3
   equivalent.** `Ctrl K` still appears in U-Spec's keys table as "Search in environment," so the
   feature isn't dropped from the product — but no v0.3 board shows where it now lives (was it
   demoted into a command palette invoked purely by the shortcut, with no persistent search box?).
   Needs a v0.3 mock or explicit statement that it's shortcut-only.
   **Answered in the build:** the box persists, in the title bar. It sat in the right cell at first,
   and since #336 it sits beside the pill, centred with it (§1.2).

10. **`w-panel-collapsed` (40px) vs the 44px project-page rail — same thing or not?** The token
    describes "the right panel collapsed to its icon rail," which sounds exactly like the always-
    visible 44px project-page rail described throughout the v0.3 boards and VEISTRA-UX-REWORK.md §4,
    but the numbers don't match (40 vs 44) and v0.3 never shows the rail in an "expanded" 380px form
    the way v2's Source-control panel collapses/expands. Confirm whether these are the same UI
    element renamed, or two genuinely different affordances.

11. **VEISTRA-UX-REWORK.md §9 already flags two of its own open items** that the boards don't resolve
    either: (a) how Play actually runs technically (web export in a webview vs. native debug build
    streamed frame-by-frame) — board 05 shows only the resulting UI, not which implementation it
    assumes; (b) "the handoff-spec conflict from the v0.2 token migration still needs its decision
    row" — referenced but not present in any file read for this task (a `K-Migration.dc.html` board
    exists in the v0.2 page and was not required reading here; it likely contains that decision row
    and should be pulled in before implementation starts).

12. **Menu-bar items render as inert `<span>`s in every v0.3 board** (`padding: 4px 8px`, no
    background/hover states), vs. K-Shell's real `<button>` styling with hover/active backgrounds.
    Likely just mockup shorthand, but worth confirming the File/Edit/View/Run/Terminal/Help menu
    bar is still meant to be a real interactive menu (it presumably is — this is almost certainly
    fixture-authoring laziness, not a design decision, but is listed for completeness).
