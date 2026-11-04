# Shell chrome design notes

Design rationale moved out of the source files under `src/shell/titlebar/` and
`src/shell/switcher/` to keep comment concentration under the caps in
STANDARDS.md §10. Nothing here is a summary — each section is the prose as it
stood in the file, moved verbatim, and the source points back at this page.

## src/shell/switcher/ClusterBar.tsx

### Why every tab is here and nowhere else

Panes used to draw their own tab strips and the panel drew one for terminals,
which meant the same handful of surfaces were listed in up to three rows at
once. They are all in this row now, and those two strips are gone rather than
duplicated — a tab in two places is two things that can disagree about which
one is active, and it is twice as much bar for the same information.

What is lost with the pane strips is being able to read a split's contents off
its own header, and what replaces it is `showing`: a member that is on screen
draws lifted. With a split, that is more than one member at once, which is
honest — there really is more than one surface visible.

### Pane groups, which are not the pane strips coming back

A pane holding several surfaces draws as one grouped region here — a raised
tray with thin dividers between its members, so pane membership is something
you read rather than something you have to click to find out. It is worth
being explicit that this does **not** undo the paragraph above, because it
looks at a glance like it might.

It is also the only thing in the window that says two surfaces share a pane,
which is why the first attempt at it being too faint to see was not a
cosmetic miss: with nothing marking the pane, clicking from one of its
members to the other reads as one app replacing another rather than as a
pane showing its other tab. `switcher.css` has what changed and why.

The lesson from the pane strips was not "never show which pane a tab is in".
It was that the same surface must not be *listed twice*, because two listings
are two things that can disagree about which one is active. This is still
exactly one row, and every surface still appears in it exactly once; the row
has gained grouping that mirrors the pane tree, not a second copy of anything.
There is nothing here that can disagree with anything else, because there is
nothing else.

A pane group must also not be mistakable for a *cluster* group, which is the
outer box this one nests in. Both are drawn in the same visual language on
purpose — a region marked by a fill spanning the tabs that belong to it — and
they differ in every variable of it at once: the cluster's fill is darker
than the bar, square, full height, banded in accent along its top, and always
introduced by a named chip; a pane's is lighter, rounded, inset from the bar's
edges, unbanded, and never named. They nest rather than overlap. See
`switcher.css`.

The terminal panel keeps its `+`, its worktree toggle and its collapse
chevron. Those operate the *region*; they are not tabs, and none of them names
a session.

### Page chips, which are not clusters

The Veistra Cloud screens — Agents and Cost Tracker today, Projects later —
are *pages*: each one gets its own cluster, separate from every real cluster,
rather than being an app you add to a pane. Braden's brief was that they must
not be separate apps and must keep their buttons small. So they sit as a
group of chips at the left of this row, set off from the cluster chips by a
divider. Each chip shows only its icon at rest. It widens to icon and label on
hover or keyboard focus, and stays wide while its page is on screen.
`PageChips.tsx` draws them.

**Rust owns the rules, not this row.** `src-tauri/src/pages.rs` declares
which pages exist and which app draws each one. `Cluster.page` names the
page a cluster *is*. `shell_state.rs` refuses everything that would make a
page cluster anything other than one pane holding one instance of its app:
close, rename, move to another window, split, dropping a tab in, and dragging
its tab out. Each of those refusals has its own test. The chips therefore
offer none of a cluster chip's furniture: no count, no ×, no rename, no drag
handle, and no members expanding beside them. That keeps the chips honest; it
is not what enforces the rules.

**The width animates in CSS, not framer.** Hover causes no React render, so
there is nothing for a `layout` animation to hang off. The label is a
one-column grid whose track goes from `0fr` to `1fr`, which is how CSS reaches
an intrinsic width without a guessed `max-width`. The label only grows in
place, so nothing in this scroll row travels sideways. That is the row's
standing rule — see the `fade` comment in `ClusterBar.tsx`.

**While a page is in front, the window reads as having no cluster to work
in.** `WindowRoot` keeps two names apart:

- `shownCluster` is what the tool window draws.
- `activeCluster` is `null` for a page.

The band, search, the Apps menu, presets and File > Open all see `null`.
Rust's `active_cluster_of` agrees, so a new terminal has nowhere to go. The
Home takeover does not apply either: a page has no Home, and its open chip
does not toggle one.

Closing the last real cluster never lands on a page. The window shows
`NoClustersState`, with the page chips still there to click.

## src/shell/titlebar/useNarrowTitlebar.ts and titlebar.css

### The title bar's collapse order (#336)

The decision is Braden's, on #336. Four things share the bar. The menus are on
the left. The project pill and the search field form one middle group, centred
on the window. The right-hand actions follow: Upgrade, new agent session,
terminal, Agents, Clusters and Settings, plus the tool-health badge while
something is unhealthy. The window controls come last. Nothing may draw over
anything else at any width down to the window's minimum, and the middle group
may not leave the centre to make room. As the window narrows, the bar gives way
in this order:

1. Below **1440px** the right-hand actions fold into one overflow button
   (`TitleBarActions`, `OverflowMenu`). Each row runs the same action and shows
   the same shortcut, because both forms are drawn from one list
   (`titleBarActions`). The tool-health badge becomes the menu's first row, with
   its tools and Re-scan in a submenu. The button then carries the badge's dot
   and says so in its accessible name.
2. Below **1180px** the six menus fold into the hamburger, as they always have.
3. If the middle group still has less room than it wants, search narrows to its
   icon and Ctrl+K, then to its icon alone (`search.css`, by the field's own
   width). Then the pill's environment chip or count truncates, and then the
   project name (`projectPill.css`).

The window controls never fold. They sit outside the actions slot
(`TitleBar.tsx`), so nothing that collapses can take them with it.

**Why 1440, and why the buttons first.** A box centred on the window can be at
most the bar's width less twice the *wider* side. Measured in Chromium, with
the fallback font because Inter is not bundled:

| Piece | Width |
|---|---|
| Left: logo and inline menus | 360px |
| Left: logo and hamburger | 65px |
| Right: Upgrade, five icon buttons, window controls | 446px |
| Right: overflow button and window controls | 182px |
| Middle, the issue's example: pill (297px), gap, full search (240px) | 545px |

With everything inline, the example group needs 545 + 2 × 446 = 1437px, so
1440 is where the bar stops fitting all of it at once. The buttons go first
because the right is the wider side. Folding the menus would gain nothing while
the right still takes 446px. With the buttons folded, the menus are the wider
side and the group gets the bar less 720px: at 1180px the example's search has
narrowed to 153px. With both folded it gets the bar less 364px, which is 536px
at the main window's 900px minimum, so search sits at 231px with its label
still showing.

**Steps on the window's width, the bound measured.** The two steps use
`matchMedia` on the window's width (range syntax, so 1179.5px is below 1180),
for the reason the spec gives for the hamburger. The middle group's bound is
measured instead. `TitleBar`'s `useSideReserve` writes the wider side's width to
`--titlebar-side`, and `.titlebar__middle` takes `100cqw` less twice that. The
sides change with the font (Segoe UI on Windows), with which step the window is
at, and with the badge, so a width written into the stylesheet would be wrong
somewhere.

**What this replaced.** Commit 82403361 tried to clear the overlap another way.
Below 1000px it let the pill leave the centre, below 900px it hid Upgrade, and
it clipped the right cell instead of letting it spill. Search lived in the
right cell and became an icon below 1240px. Measured with the issue's example,
the right cell's buttons still drew under the pill from 800px to 1180px, and
search was cut off or out of reach. All of that is gone.
`titlebar/titlebarCollapse.test.ts` and `titlebarMiddleGroup.test.ts` pin what
replaced it. The old cap on the pill (a third of the bar) went too: the group's
bound keeps the pill clear of both sides, and search gives way first, so a cap
would only cut a name short while there was still room for it.

**Known edge.** A detached window can be 480px wide. With the overflow button
and the hamburger at that width, the middle group gets 116px. Search is an icon,
and the chip keeps its 36px floor (glyph and ellipsis), so the project's name
can shrink to nothing before the chip does. That follows the order #336 asked
for, but it is the one width where it reads oddly.

## src/shell/titlebar/useEditTarget.ts

### Paste is disabled on both branches

**Paste is disabled on both branches**, and this is the one item where that
is a decision rather than a consequence:

- `document.execCommand("paste")` has been refused in web content by every
  Chromium-based engine for years — it resolves `false` and does nothing.
  WebView2 is Chromium. So the field branch has no mechanism at all.
- `navigator.clipboard.readText()` is the replacement, and it is gated on the
  `clipboard-read` permission. What a Tauri v2 WebView2 window does with that
  request is not something this work could establish without running the app,
  and browser verification is unavailable in this environment.

The handoff's own instruction for exactly this case is to disable it and say
why rather than ship a Paste that silently does nothing — so it is disabled,
and the hint names Ctrl+V, which works, because it is the *browser's* paste
and never goes through this code at all. Clipboard **write** is not affected:
Cut and Copy go through `navigator.clipboard.writeText` on the app side,
which this repo already relies on in the Files context menu's "Copy path".

The shell's right-click menu takes the same decision for the same reasons, and
states it once — `contextMenu.ts`'s `PASTE_HINT` is the sentence this section
is about, and it points back here.

## src-tauri/src/webview.rs

### Why the default context menu is turned off in Rust

Right-clicking anywhere in Veistra used to raise Chromium's own menu: Back,
Forward, Refresh, Print, Save as, View source. None of the six is an operation
this application has. There is nothing to go back to, "Save as" offers to save
the shell's own HTML, and printing a workspace is not a thing anybody wants.

It cannot be turned off from `tauri.conf.json`. Tauri v2 has no configuration
key for it and no builder method either — WebView2 exposes it only as
`ICoreWebView2Settings::AreDefaultContextMenusEnabled`, a property on the
settings object, so reaching it means reaching the COM object. `devtools.rs`
already holds that interface for the UI-driving server, and this borrows the
same route. It is applied from a page-load hook, which is the one place that
sees the main window, the splash, and a window `windows::create` builds long
after setup has run, without any of them remembering to ask.

The alternative considered and rejected was a global `contextmenu` handler in
the shell calling `preventDefault` unconditionally. It would not have reached
inside an app's iframe — the shell's JavaScript cannot install a listener in a
document it does not own, which is the same same-origin wall
`devtools::install_script` exists to get around — so every app and plugin
surface would have kept the browser's menu. The setting belongs to the whole
WebView2 environment and so covers child frames as well.

### It suppresses the menu, not the event

`contextmenu` still fires on every element exactly as before. That is what
lets `ContextMenuHost` open at all, and it is why the Files and Viewer apps'
own right-click menus are unaffected. What changes is that a surface which
ignores the event now shows nothing rather than the browser's menu.

### A failure is logged, not fatal

A webview that will not hand over its settings object is not a reason to
refuse to start. The cost is one window where a right-click shows the
browser's menu — and `ContextMenuHost` calls `preventDefault` itself when it
opens, which covers that case for everything the shell draws. On a non-Windows
build the whole function is a no-op, for the reason `devtools.rs` keeps its
non-Windows half: a function that is absent on one platform is harder to
account for than one that does nothing there.
