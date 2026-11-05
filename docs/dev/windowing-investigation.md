# Windowing: what was wrong, and what is still only suspected

Written for [#45](https://github.com/Firelight-Innovations/Veistra/issues/45), which
reported that opening an app inside the shell — the Design app was the example — behaved
badly, with no root cause known. This page records what the investigation found, what was
fixed, and what was looked at and left alone, so the next person to touch the pane tree does
not start from the beginning.

## The root cause

**`dismiss_takeover` deleted the pane its caller was about to fill.**

The mechanism is three functions deep and each of them is correct on its own, which is why it
survived a suite that already had thirty-odd tests over this tree.

1. Home and Docs (then Tutorials) *cover* a cluster rather than taking a pane beside it, so when anything
   else arrives in the pane one of them is sitting in, the shell closes it — otherwise it
   would be a live surface with no way back on screen. That is `dismiss_takeover` in
   `src-tauri/src/shell_state.rs`, and it ran **before** the arrival, deliberately: a pane
   holding nothing but Home has to read as *empty* to `PaneNode::open_into`, or the surface
   opened over Home gains Home's pane as a sibling instead of taking it.
2. It removed the tab with `PaneNode::remove_tab`, which ends with `prune`.
3. `prune` enforces the module's first invariant — *no empty leaves, except the root*. So it
   deleted the leaf that had just been emptied.

The caller's next line then named that leaf. `open_into` could not find it, returned `false`,
and nothing was placed.

It was invisible in a cluster of one pane, because `prune` exempts the root — which is
exactly the shape every existing test used. In any **split** cluster it swallowed the open
whole:

- **Apps menu → Design Mode, with Home covering a split cluster.** `open_instance` returned
  `None`, `commands::open_instance` turned that into `AppError::UnknownTool("design")`, and
  `WindowRoot`'s `onOpenApp` logged it to the console. On screen: Home vanishes and nothing
  opens. The error names the wrong thing entirely — the app is registered and perfectly
  fine.
- **Opening a project.** `PROJECT_OPEN_PRESET_ID` asks for a terminal, `presets::plan` sweeps
  the unclaimed Home into a pane of its own, and filling the terminal gap evicted Home from
  that pane and pruned it away. The pty spawned and the session existed; it just never
  reached the layout.
- **Dragging a tab onto a pane holding only Home.** `move_instance` had already taken the tab
  out of every *other* cluster by then, so a cross-cluster drop lost the tab outright: gone
  from the tree, still in `instances`, invisible and unclosable.

The existing test `a_project_opening_onto_an_empty_cluster_ends_with_home_closed` drove this
exact sequence and passed, because it asserted that Home had *gone* and never that the
terminal had *arrived*. That assertion is now in it.

## The second defect, found on the way

**`move_instance` copied a tab instead of moving it, within one cluster.**

It swept the tab out of every cluster whose id was not the target's, and relied on
`insert_tab`'s own `tabs.retain` for the rest — but that retain only covers the pane it is
inserting *into*. A tab dragged from one pane to another **in the same cluster** was therefore
left in both. That is the most ordinary gesture the layout has, and `useDrag`'s `commit`
always passes the *active* cluster id, so every intra-cluster drop took this path.

The shell then drew one instance twice, from a `tabs.map` keyed by instance id — duplicate
React keys, and two entries in the cluster bar that disagree about where the surface is.

## The fix

One function, `place_surface` in `src-tauri/src/shell_state.rs`, is now the only door into a
pane. `open_instance`, `add_terminal_in_pane` and `move_instance` all go through it, and it
does four things in this order:

1. Resolve the pane, falling back to the cluster's first when the caller names one this tree
   does not hold — the forgiveness `active_pane` already documents.
2. Take the surface out of wherever it already is, **without pruning**
   (`PaneNode::remove_tab_unpruned`, new in `layout.rs`). This is the fix for the copy, and
   the unpruned part is the fix for the deletion.
3. Evict a takeover surface, if the caller asked for it.
4. Place, and prune only the pane step 2 emptied.

Step 4 is narrower than it looks and the narrowness is load-bearing: between a preset being
applied and its gaps being filled, the tree **deliberately holds empty leaves**, one per gap.
An unconditional `prune` there deletes the panes the remaining gaps were going to land in.
`dismiss_crowded_takeover` carries the same warning for the same reason.

`move_instance` keeps its own `holds_pane` guard ahead of everything, so the first-pane
fallback does not apply to a drag. An open must produce a surface somewhere; a drop onto a
pane that has gone should leave the tab exactly where it was, which is what a cancelled drag
looks like. `split_with_instance` already argues this at length.

Step 1's fallback also forced a second, smaller correction. `open_instance` resolved its
cluster as "whichever this window is showing", which was fine while an unknown pane simply
refused the open — and is not, once an unknown pane falls back to a first pane. It now
resolves the cluster that **owns** the pane the caller named, and only then the active one.
`fill_preset_gaps` is the caller that needs it: `apply_preset_to_cluster`'s own doc points out
that the cluster a project opened into may not be the active one by the time the folder pick
has resolved, so its gap panes could belong to a tree `open_instance` was not looking at.
Forgiving a stale id inside a cluster is right; dropping a surface into a cluster the caller
was not talking about is not. That change is not covered by a unit test — `open_instance`
takes an `&AppHandle` and cannot be driven from one — which is why it is written down here.

## What is still only suspected

None of the following was reproduced, and none of it should be "fixed" without evidence.

### 1. `hideTakeover` races its own open

`WindowRoot.tsx`'s `onOpenApp` calls `hideTakeover()` — which fires `closeInstance(home)` and
does not await it — and then `openInstance(...)` naming the pane the user was last in. Two
`invoke` calls in flight with no ordering between them.

With the fix both orders now place the surface, but in *different panes*: if the close lands
first the pane is pruned and the open falls back to the cluster's first pane; if the open
lands first the surface takes Home's pane. So the layout after "open an app from Home" may not
be deterministic.

**Confidence: medium.** The race is plainly there in the source; whether Tauri serialises IPC
per window closely enough that it never bites is unknown. Awaiting the close would fix it at
the cost of a round trip, and that is not worth doing on suspicion.

### 2. Showing Home splits a pane nobody sees split

`showHome` passes `splitDirOnOpen(activePaneId)`, so opening Home into a cluster that has none
carves a new pane for it — under a surface that covers the whole window, so the split is never
seen. Closing Home collapses it again. The visible outcome is the same as opening Home as a
tab would give, which is why this is listed rather than changed, but it does burn pane and
split counters on every look at Home.

**Confidence: low that it matters.**

### 3. Stale rects while the window is occluded

`ToolWindow`'s `measure()` returns early when its container measures 0×0 and keeps the last
good geometry — correct, and the same hazard the repo's own notes record for Chrome. It relies
on the `ResizeObserver` firing again on the way back to visible. If a window is restored at
exactly the size it was hidden at, that callback may not fire, and any layout change made
while it was hidden would be drawn against the old rectangles.

**Confidence: low.** Not reproduced, and the observer also watches every pane host.

## Confirming it by hand

The three that were fixed, in the real app. Each needs a **split** cluster — the single-pane
case worked before and still works, and testing there proves nothing.

1. **The reported bug.** Open a project, or otherwise get a cluster with two panes side by
   side. Click the cluster chip to bring Home up. From the Apps menu, choose **Design Mode**.
   *Before:* Home disappears, nothing opens, and the console reads
   `veistra: could not open that app: UnknownTool("design")`. *After:* Design Mode appears in
   the pane Home was covering with.
2. **The project-open terminal.** Open a folder as a project into a fresh cluster. The
   built-in project-open preset asks for Files, the viewer and a terminal.
   *Before:* the terminal is missing from the layout. *After:* it is in its pane. Cross-check
   with `pnpm probe shell_snapshot`, which lists the pane trees and the terminals.
3. **The copy.** With two panes open, drag a tab from one into the other — onto the pane's
   middle, or onto that pane's part of the cluster bar. *Before:* it appears in both, and the
   webview console warns about two children with the same key. *After:* it moves.

`pnpm probe shell_snapshot` answers all three from outside the app and needs nothing launched
or restarted. Note its standing caveat: `recent_errors` covers the shell and the backend only,
never errors inside an app's own iframe.
