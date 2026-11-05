# Shell core design notes

Long-form design rationale moved verbatim out of the files directly under `src/shell/`, to keep
comment concentration under the caps in STANDARDS.md §10. Each of those files points back here; the
prose is the same prose, only further from the code it is about.

## src/shell/contract.ts

`contract.ts` is the interface's own vocabulary (STANDARDS.md §2), so its per-type and per-field
documentation stays in the source. What moved here is the long-form argument behind a handful of
those types — why each is shaped the way it is, and what was rejected. The two rules the file
enforces rather than merely records (no version number reaches the interface, no backend vocabulary
reaches the interface) stay in the source header.

### `ToolPresentation.isApp`

One bit, and it earns its place by being the routing decision the tool window cannot make any other
way: an app's `invoke` is answered in-process by `app_call`, a tool's would go to its core over the
broker. Everything else about the two is identical here on purpose — an app gets no special tab, no
badge, and no separate section in the bar, because to the person using it the difference is an
implementation detail of where the code happens to live.

### `appPresentation` has no health to map

An app has no health to map. It ships inside the binary that is asking about it, so `missing` is not
a state it can be in and `mismatch` has no pinned version to disagree with — `ok` is not an
optimistic default here, it is the only answer the type can carry.

### Terminals: a session is two separate things

A session is two separate things, and they are deliberately two interfaces.

`TerminalSource` is *identity and lifetime*: which sessions exist, what they are called, which
window's panel holds one. That is shared state — a terminal can be dragged between windows and
outlives whichever window is showing it — so it is Rust's, and this is a projection of `shell:state`.

`TerminalTransport` is *bytes*: one PTY's output going to one emulator, and that emulator's
keystrokes going back. It is per-session, high-volume, and nothing outside the terminal view has any
business seeing it.

Keeping them apart is what makes the interception point in Rust worth having. Every byte in either
direction crosses one seam there, so a wrapper around a coding harness — tracking what it did,
injecting input, restarting it — is written once in the transport and needs no cooperation from
anything in the contract.

`TerminalControl` has deliberately no `subscribe`. Which sessions exist is part of `shell:state` — it
has to be, since a terminal can be dragged into another window — so a second subscription would be a
second answer to a question that already has one, and the two could disagree.

### `TerminalControl.createInPane`, the second way to make a terminal

The second of two legitimate ways to make a terminal, and it looks like a contradiction of the first
until you notice they answer different questions: `create` is *what am I watching*, and outlives the
cluster; this is *what am I working in*, and is part of an arrangement — the right-hand pane of a
"Files & Terminal" preset, or whatever someone drags there by hand. It is sized by the layout and
moves when the layout does. Both exist in VS Code for the same reason, as the panel and an
editor-area terminal. They no longer differ in lifetime: both belong to the cluster.

There is still only one thing in the application that spawns a shell: Rust opens the session the
usual way and then moves its id into the tree, which is precisely what dragging a terminal's tab into
a pane does. See `commands::open_terminal_into_pane`.

`paneId` names the pane this open is *relative to*; omitted, it is the active cluster's first. `dir`
splits that pane along the given axis and gives the terminal a pane of its own — the same treatment
opening an app gets, because Terminal is a row in the same menu. Omitted, it arrives as a tab in the
named pane. See `panes/splitOnOpen.ts` for where the axis comes from and `PaneNode::open_into` for
when the split is declined.

### `TerminalControl.setTitle` lives on Control, not Transport

Lives on `TerminalControl`, not `TerminalTransport`: a title is identity — the same thing
`TerminalSession.title` already is — not a byte on the session's stream, and Rust is the owner of
record for identity because a terminal can be dragged into another window's panel. This call only
ever *reports*; the title a caller should render still comes back around through `shell:state`.

### `TerminalTransport.attach` replays before it streams

`onData` is called with everything the shell has already said before it is called with anything new,
so an emulator that mounts late still sees the whole session. That is not a convenience: a pty starts
talking the instant it is spawned, well before React has mounted anything, and on Windows its opening
line is a question the shell blocks on until an emulator answers. A transport that only carried live
events would leave every terminal permanently blank. See `src-tauri/src/pty.rs`.

`attach` returns its own unsubscribe rather than taking an id to detach, because the emulator that
attached is the only thing that should be able to stop listening — an id-keyed `detach` lets any
caller silence someone else's terminal.

### Source control is request/reply, and scoped to a cluster

These replace an earlier `Worktree`/`WorktreeSource` pair, which was a subscription over a single
flat change list and had nowhere to put the half of git that matters: the index. What is here instead
is request/reply, because there is no watcher — the panel re-asks after every mutation and when the
shown tool changes, and that is the whole update model.

Every `GitControl` method takes a **cluster** id. It used to be a tool id, which was not a near-miss
but a dead end — Rust resolved a tool id against the `veistra.toml` `[[tool]]` pins, a list
`discovery.rs` leaves empty for every project, so every call rejected and the source-control view drew
an error where its change list should have been. `git.rs`'s note on `git_cluster_status` has the full
account.

A cluster is also the honest subject. It is the thing a user opens a project into, the thing that can
be moved onto a worktree, and the thing whose branch the status bar names — none of which the pane
that happens to hold focus has any bearing on.

`GIT_KIND_TOKEN`: modified/added/deleted keep the three colours the worktree list has always used;
the three kinds that list could not express borrow from the same small palette rather than introduce
new tokens — renamed reads as a modification, untracked as not-yet-anything, and a conflict as the
error it is.

### Worktrees live outside the project, on purpose

A cluster can work inside a git worktree instead of the project folder itself, which is what lets two
clusters hold two branches of one repository open at the same time without either one's edits showing
up in the other's file tree. The worktree is a real second checkout on disk; git maintains it, and
`git worktree list` — not anything Veistra writes down — is the authority on which ones exist.

They are created *outside* the project, at `<project>/../.worktrees/<project-name>/<name>/`, and that
placement is load-bearing rather than tidiness. A worktree nested inside the project would be a
complete second copy of the codebase sitting in the tree that every file walker descends: the Files
app, the search index, and Vite's watcher would each find one more copy of `src/` per cluster.
Outside, nothing has to be taught to ignore it.

`WorktreeControl` is request/reply for the same reason `GitControl` is: there is no watcher, and every
one of these either follows a user action or a cluster switch, both of which are already moments the
panel re-asks at.

`graph` is on `WorktreeControl` rather than `GitControl` because it is scoped to a cluster and spans
every worktree of its repository — the graph is the one part of the panel that is deliberately *not*
about the cluster's own checkout, which is why the top half stays put while the bottom half changes as
you switch clusters.

`divergenceDiff` takes the `mergeBase` from the `GitDivergence` the file came from rather than letting
the backend resolve it again: a merge base computed twice during one reading of one list could differ
if something fetched in between, and a diff taken against a different base than the list was built
from is quietly wrong rather than visibly broken.

`create` uses one name for both the branch and the folder, because two names for one thing is two
things to keep in agreement and the user is naming a piece of work, not a directory.

`remove` deletes the checkout on disk but never the branch — the commits on it are the point of having
made it. `force` is what a worktree with uncommitted changes needs, and git's refusal without it is
correct: that refusal is the only thing standing between a stray click and unrecoverable work.

### `clusterRoot`, and what it deliberately is not

The precedence lives in `clusterRoot` and nowhere else. Terminals spawn in this directory, the Files
app roots its tree at it, and the search index scopes to it — three features that must agree, and
would eventually stop agreeing if each carried its own copy of the rule. The Rust side resolves the
same precedence in `project::cluster_path`.

Deliberately *not* the answer to "which project is this cluster on" — that is `Cluster.project`, and
it stays the project even while the work is happening in a worktree beside it. Home names the project,
the file tree walks the root, and conflating them would have Home renaming itself every time somebody
made a branch.

Synchronous, so it cannot check that the directory still exists. A worktree removed outside Veistra
leaves the path pointing at nothing until the backend reconciles against `git worktree list`, which it
does on load and after every worktree mutation. Callers that walk the result should treat a missing
directory as empty rather than as a failure.

### `MenuItem.hint` and `MenuItem.submenu`

`hint` is almost always **why it is disabled**, which is the case it exists for: an item the user
cannot click owes them a reason, and "no dead items" is only half an answer without one. It is also
allowed on a live item whose effect is not obvious from its label — File > Open Recent, which shows
the Home app rather than a submenu.

It is rendered on the wrapping `<li>` rather than the button, because a `disabled` button receives no
pointer events and so never shows a tooltip of its own — which would leave the explanation reachable
on exactly the items that do not need one.

There was none of `submenu` until presets arrived, and the two menus that wanted one before — File >
Open Recent, and the Apps list itself — both went the other way deliberately, because what they had to
show was richer than a column of labels. A preset is exactly a column of labels: a name, and clicking
it does the thing. Flattening them into the Apps menu instead would put "open one more Files" and
"rearrange this whole cluster" in one undifferentiated list, which is the reason a submenu exists at
all.

`MenuPrompt.onSubmit` rejects with something to *show* rather than something to log: the refusals it
can produce — a blank name, a name one of the built-in presets already holds — are answers to what was
just typed, and belong under the field that typed it. The alternative was `window.prompt`, which is a
modal the shell does not control, does not style, and — being synchronous — blocks the webview that
every iframe in the window is a child of.

### The layout is Rust's, and so is a preset's shape

The distinction the layout section draws: an *app id* is a type, an *instance id* is an identity.
`files` names some code; `files-1` and `files-2` name two live surfaces with their own open files and
their own scroll positions.

All of it is owned by Rust and arrives on `shell:state`, for the reason `TerminalSession.groupId`
gives about terminal groups: anything a tab can be dragged across windows with cannot live in one
window's own state, because it would come apart the moment it moved. A client-side pane tree would be
the first shell layout state outside that broadcast, and it would be wrong for exactly the same
reason.

Layout presets mirror `src-tauri/src/presets/mod.rs`, and the distinction that module is built around
survives the crossing: a `PaneNode` is made of *identities* — pane ids, split ids, instance ids, all
minted per session — and a `PresetNode` is the same shape with every one of them removed. What is left
is a direction, the weights, and in each pane the **app ids** that belong there, because a type is the
only thing about an arrangement that outlives the session it was arranged in. Nothing in the shell
draws a preset's shape today; the menu draws its name.

### `GitHunk` is measured against HEAD

What the editor's gutter draws one mark per. Against HEAD rather than the index, matching VS Code:
staging a change does not clear the bar, because the line really is still different from the last
committed version and a mark that vanished on `git add` would say the file matches HEAD when it does
not. A deletion covers no current lines — `lines` is `0` — and is drawn as a wedge between two lines
rather than as a bar beside one.

### A cluster chip is a place, not a filter

`Cluster` — one tab in the switcher bar: a layout, the project it is about, and its worktree.
Switching cluster tabs swaps the pane tree, the project underneath it, *and* the terminals in the band
below it — the whole of what is on screen for one piece of work, which is what makes a chip a place
rather than a filter. See `TerminalSessionState.clusterId`. A terminal dragged into the layout is a tab
in `tree` like any other surface and the band stops listing it: membership of one excludes the other,
and both are derived from the tree rather than tracked.

`Cluster.page`, when present, says the cluster is a *page* (`agents`). It is absent from the JSON for
an ordinary cluster, so a `layout.json` written before pages existed loads unchanged. A page cluster
never shows among the chips. It is one pane holding one instance of its page's app, and Rust refuses
every change to that. `open_page` is the only way to make or show one. See `src-tauri/src/pages.rs`,
and `shell-chrome.md` for how the bar draws it.

`ClusterMember`: the bar is one row — a chip per cluster, and, for the cluster that is expanded, every
surface and terminal inside it, inline. So a member is whichever of those two things a tab happens to
be, flattened to the one shape the bar draws. `paneId` is the whole distinction: a surface lives in a
pane of the layout, a terminal lives in the panel, and `null` is what says which.

Built fresh from `shell:state` on every render rather than tracked. There is no membership stored
anywhere — a cluster's surfaces are its tree's tabs and its terminals are the sessions carrying its id,
both already single sources of truth, and a cached list beside them would be a second answer that could
disagree.

`ClusterMember.dragId` is the same as `id` except for a split terminal, whose tab is identified by the
group and whose *sessions* are what can actually be moved. Carried explicitly so no caller has to know
that a group id is not a session id.

### Drag: two payloads, and a target that can refuse

Two things can be dragged, and `what` is which. They are not variations on one shape: a surface is a
tab and goes *into* the layout, while a cluster is the layout — it can only ever be dropped on a
window, never in a pane, so it has no pane, no index and no edge to speak of. A union rather than a
wide object with half its fields unused is what makes `commit` say that out loud instead of leaving a
cluster to fall through the tab branches and land somewhere it cannot go.

`SurfaceDrag` is one kind where there used to be two. A tab is a tab: an app surface and a terminal
drag identically, drop in the same places, and split a pane the same way. `kind` is carried for the
ghost's benefit — a terminal's ghost shows its agent-finished dot — and for nothing else.

The `ClusterDrag` gesture exists for a second monitor: one cluster over there, another over here.
Nothing of the cluster's contents is carried, because nothing needs to be — the id is the address, and
the tree travels with it in the backend.

`DropTarget`'s `none` is the pointer being somewhere this *particular* payload cannot go — a cluster
over a pane, which holds panes and cannot be put inside one. It is never what a hit test returns;
`useDrag` substitutes it, so that a region does not draw an insertion caret or light an edge for a
release that will be refused. Releasing on it does nothing at all, exactly like cancelling.

### `PaneTreeProps` and `FrameSlots`

`PaneTreeProps` is here rather than in `panes/PaneTree.tsx` because two regions need the shape and only
one of them draws it: `toolwindow` computes every field but must not import `panes` (§1.2), so it takes
a `renderPanes` prop typed as `(props: PaneTreeProps) => ReactNode` and `WindowRoot` — which is not a
region and may import both — supplies the `PaneTree` that consumes it.

`focusedPaneId` is the pane an open **acts on**, rather than the pane it lands in: opening an app splits
this pane along its longer axis and puts the new surface in the half that produces, rather than stacking
it in here as a tab. See `panes/splitOnOpen.ts`.

`Frame` owns the geometry — the heights, the split, the fact that only the middle row grows — and knows
nothing about what goes in the slots. That is the whole reason the regions can be built in parallel:
they are handed a box of the right size and cannot affect anyone else's.

`splitOverlay` gets its own band rather than being part of `overlay` because the two sit at different
heights and answer to different things: `overlay` is portalled over the entire frame for a drag ghost
that has to be able to cross every bar, whereas `splitOverlay` deliberately stops at the two edges it
does, so the field being typed into stays visible and the status bar keeps reporting.

## src/shell/OverlayScrollbar.tsx

### The thumb is draggable, and what cursor it rests at

The thumb is draggable — this replaces two scrollbars that were, and a fade-in indicator that
couldn't be dragged would be a regression dressed up as a redesign. Dragging writes
`targetRef.current.scrollLeft` directly rather than going through anything else that might scroll the
strip, which is also why it needs no coordination with the tab/cluster drag gesture in `useDrag.tsx`:
the two never run at once, because a pointerdown that lands on the thumb (see
`overlay-scrollbar__thumb`'s `pointer-events: auto`) is a pointerdown that never reaches a chip
underneath it, and there is no other way to start that gesture. It rests at the ordinary arrow cursor
(`cursor: default`) rather than `grab`, though, and only switches to `grabbing` once a drag actually
starts — `useDrag.tsx`'s own tab handles already claim `grab` on hover to mean "drag this tab out",
and this thumb sitting right over the bottom of the same chips cannot reuse that cursor on hover
without making the two gestures look identical before either one has started.

### The wheel redirection, and why it is wired twice

`el` also gains one behaviour that isn't the thumb's own rendering at all: a `wheel` handler that
redirects a plain mouse wheel's `deltaY` into `scrollLeft`. Native scrolling already handles a
trackpad's horizontal swipe or a held-Shift wheel (both report on `deltaX`) — this is only for the
axis nothing else drives, which is otherwise the only way a mouse (no trackpad, no shift) could ever
move these strips besides this thumb. It lives in the same effect that measures `el`, rather than in
the two callers, so neither has to remember to wire it up separately. The thumb carries the same
redirection itself, through its own `onWheel` — it is `el`'s sibling rather than its descendant, so a
wheel tick that lands on the thumb never bubbles to `el`'s listener at all, and without this a wheel
spun exactly over the visible scrollbar would do nothing.

### Hover is geometry, not hit-testing

Hover is tracked the same rect-based way `dropZones.ts` resolves a drop — `pointermove` on `window`,
checked against `el.getBoundingClientRect()` — rather than `pointerenter`/`pointerleave` on `el`
itself. Those follow real hit-testing, and the thumb sitting on top of `el`'s own bottom edge once
it's visible means the moment it mounts over the cursor, `el` stops being hit-tested and fires
`pointerleave` — which drops `hovering`, unmounts the thumb, hands the cursor back to `el`, fires
`pointerenter` again, and remounts it: a loop, several times a frame, each lap landing on a different
element with a different resting cursor. Geometry doesn't care which element is on top, so it can't
feed back on itself this way.

### What the cached rect does and does not depend on

Two cases that sound like gaps aren't, in this app specifically:

- The window moving (not resizing) doesn't change `getBoundingClientRect` at all — it's already
  viewport-relative, and moving the OS window carries the viewport, and everything positioned in it,
  along with it.
- The panel *collapsing* isn't a live reposition of this element with neither observer noticing —
  it's `SecondaryPanel` swapping `.panel__tabs-strip` out for an entirely different `CollapsedStrip`
  tree (see `SecondaryPanel.tsx`'s `if (collapsed) return <CollapsedStrip ... />`), which unmounts
  this component along with it. Restoring the panel mounts a fresh instance with a fresh `measure()`
  call; there's no live instance carrying a stale rect through the transition.

What this genuinely depends on: every bar `.panel__tabs-strip` and `.switcher__tabs` can sit in has a
*fixed* height (`--h-titlebar`/`--h-switcher`/`--h-paneltabs`, none ever changed at runtime), so
nothing in this shell repositions either strip vertically without also resizing something in the
observed chain. If that ever stops being true — a bar gains a dynamic height — this cache would need
an observer on whatever grew, not on `el`.

## src/shell/dropZones.ts

### What the registry replaced

What this replaced was a set of hardcoded DOM queries: the drag layer looked up
`[data-region="switcher"]`, `[data-region="panel"]`, and — worst of it —
`bar.querySelectorAll(".switcher__tab")`, reaching across into another region's CSS class names to
work out where a tab would land. That was survivable while there was exactly one bar and one panel.
There are now an arbitrary number of panes and tab strips, created and destroyed as the user splits
and closes things, and no query can enumerate them without knowing their markup.

So regions opt in instead. A pane registers itself as a pane; a tab strip registers itself and offers
a way to measure its tabs. The drag layer knows only the shapes in `DropZone`, and never what any
region's DOM looks like.

### Why a module singleton rather than a context

Because the scope of "one registry" is exactly one window, and a window is exactly one webview with
its own JavaScript context. There is no arrangement in which a single page hosts two independent
shells that would need separate registries — a second Veistra window is a second webview, with its own
copy of this module.

A context would also have forced an ordering problem for no benefit: `WindowRoot` both consumes the
hit-test (through `useDrag`) and renders the regions that register with it, so a provider would have
to sit *above* `WindowRoot` in `App`, where nothing else about the drag layer lives. Getting that
wrong fails silently — every drop resolves to `detach`, because an unreachable registry has no zones
and no zones means no target.

### Why the strip zone's `at` is a function of x

A function of the position rather than a fixed `paneId`, and that is a bug fix rather than a
generalisation. This used to be `paneId: dropPaneId` — the *focused* pane — for a release anywhere
over the row, so releasing a tab directly on top of a chip belonging to some other pane moved that
tab **into the focused pane**. `commit`'s `strip` branch calls `moveInstance`, so that was a real
write to the tree that persisted: the pane you were pointing at was ignored and its occupant was
replaced by whatever you had hold of.

It hid for as long as it did because it is invisible in the case it is reached most: when the tab is
already in the focused pane, "move it into the focused pane" is a reorder that changes nothing. It
only misbehaves across panes, which was a rare arrangement until opening an app started making one.

### Why a registration holds the zone's ref, not the zone

This was `zone: DropZone`, a value copied in at attach time, and the copy was a bug with teeth.
`useDropZone` returns a ref callback with a stable identity — deliberately, see that function — so
React attaches it once and never calls it again for as long as the element lives. A pane's element
outlives far more than a pane: `PaneTree` renders `<Pane>` with no key, so switching clusters hands
the same DOM node a leaf from a different tree, React reconciles by position, and the ref is not
re-invoked. The registry went on answering with the pane id the element had when it first mounted,
which after one cluster switch names a pane in a cluster that is not on screen.

What that produced: dropping a tab on a pane's edge resolved to a `pane` target whose `paneId`
belonged to another cluster, so `split_pane` either split something invisible or found nothing at all
— either way, no split where the user aimed. Reordering in the cluster bar kept working throughout,
because the bar's `paneId` comes from `dropPaneId` and its ref is an inline arrow that React
re-attaches on every render. That asymmetry is what made the fault look like "splitting is broken"
rather than "the registry is stale".

Holding the ref instead means a zone is read at the moment it is hit-tested and is therefore never
older than the render that last set it.

## src/shell/toolWindowRegistry.ts

### Why a registry at all

`ToolWindow` keeps the only trustworthy map from a window to its iframes — see that file's own header
— and until now that map was private to the component, reached only through the `ToolWindowHandle`
ref `WindowRoot.tsx` holds. That is fine for the title bar's menu commands, which are already inside
`WindowRoot`'s tree and can be handed the ref as a prop. It stops being fine the moment something
*outside* that tree needs to reach a frame — which is exactly `src/shell/search/openHit.ts`'s
situation: opening a search hit has to find the right window's Files instance and push a path into
it, and it is deliberately not a component with a ref to receive.

A window label is the address both sides already agree on — `state/shellState.ts`'s `windowLabel()`
reads it from the URL and is callable from anywhere, so a caller with no props to lean on can still
say *which* window it means. This registry is the other half: the one `ToolWindow` a window mounts
registers itself here under that same label, and a caller elsewhere looks it up the same way.

Directly under `src/shell/` rather than inside `toolwindow/` for that reason: a lookup table two
regions share is neither one's to own (STANDARDS.md §1.2).

Not exposed on `ToolWindowHandle` itself. That type is the title bar's contract — one frame,
whichever is active, a bare command string — and widening it to "any frame, any event, any payload"
would let a menu command accidentally reach a background pane. This is a narrower, separate surface
for a narrower, separate job.

`sendEventWhenReady` queues because an instance id can be minted, and handed to that call, well
before the iframe behind it has mounted; see `ToolWindow.tsx`'s `sendEventWhenReady` for the queue
itself.

## src/shell/motion.ts

### Springs rather than durations

Springs rather than durations, because every one of these can be interrupted mid-flight — a tab
switched while the rule is still sliding, a panel dragged while it is collapsing. A duration-based
tween restarts from wherever it got to and reads as a stutter; a spring carries its velocity into the
new target and reads as the thing simply changing direction.

The handoff specifies the seven moments and the two constraints but no numbers. These are ours, and
they are deliberately all in this file so they can be reviewed and replaced as one decision. High
stiffness with heavy damping is what makes a desktop shell feel immediate; anything that visibly
overshoots reads as a toy.

### Search, which is the one thing in the shell that opens in two beats

Everything else here animates one surface at a time. Search animates two, and they are meant to read
as cause and effect rather than as a pair of things that happened at once: the field flies across the
switcher bar, and *then* the overlay comes down out from under it. Closing runs the same two beats
backwards — the overlay rolls up first, and only once it is gone does the bar give the cluster chips
their room back.

That is the only reason a `delay` appears anywhere in this file. The rest of the scale is springs
precisely so nothing has to know how long anything else takes; here one beat is defined as following
another, and a follower has to wait. Both delays are named below rather than written at the call
sites, so the two halves of the handoff cannot drift apart — and so the *bar* can be told how long to
wait using the same number the overlay leaves in.

The leading beat needs nothing defined for it. The field crossing the bar is a `layoutId` morph, and
`MotionConfig` in `WindowRoot` already hands every unconfigured animation `snap` — which is the
tab-rule spring, and exactly the right character for it. Everything below is the follower.

`SEARCH_FOLLOW_DELAY` is short enough that the two beats overlap slightly at the tail of the field's
travel, which reads as one gesture; a clean stop-then-start reads as two.

### The overlay unrolls; it does not slide

The box never moves or resizes — only the visible part of it grows — and that is load-bearing rather
than aesthetic. The overlay contains a Monaco editor on `automaticLayout`, which re-measures whenever
its container's box changes; animating height or `bottom` would make it re-layout on every frame of
the reveal. A clip is paint-only, so Monaco sees its final size from the first frame and never learns
this happened.

`settle` rather than `snap` because this is the larger travel of the two.

`searchOverlayBody` offsets the contents upward at rest and settles them as the clip uncovers them.
Without this the reveal is a window opening onto something already in its final position, which reads
as a wipe. Ten pixels of catch-up is what makes it read as the panel itself coming down from behind
the bar.

### Why the bar holds its expanded state on a timer

`searchBarHoldMs` is consumed as a number of milliseconds by a timer rather than as a framer
transition, because it does not delay an *animation* — it delays the state change itself. The cluster
chips do not animate back (see `.switcher__tabs--collapsed` in switcher.css, which is explicit that
they return drawn rather than animating), so delaying only the field's morph would put the chips back
underneath a field that is still full width. The whole bar has to wait, which means the boolean has
to wait.

### Settings, which is a place rather than a mode

Search comes *down out from under* the bar you are typing into, because it is an extension of that
field: the two are one gesture and the clip is what makes the panel look attached to the thing that
spawned it.

Settings is not attached to anything. It is a screen you go to and come back from, and giving it
search's unroll would say it belongs to whatever opened it, a shortcut or a button, and neither is
a source. So it arrives the way a sheet does: the window behind dims, and the screen settles
forward out of it.

Both halves are paint-only — `opacity` on the backdrop, `opacity` and `transform` on the surface —
for the reason the search clip is: this screen contains scroll containers and a full-width form, and
animating a box would make every one of them re-layout on every frame of the reveal.

`settingsScreen` moves 1.5% and eight pixels, which is deliberately almost nothing. A full-screen
surface that visibly flies in reads as a modal interrupting you; this one should read as having been
there, one layer back, the whole time. Any more travel and the text blurs through the scale, which on
a screen made of labels is the one artefact there is no excuse for.

## src/shell/appsMenu.ts

### A terminal is one of the rows, and it is not an app

**A terminal is one of the rows, and it is not an app.** It has no frontend to mount and no Rust half
to call, so it comes from `apps::openables` — the union of the registry and a terminal — rather than
from the app list, which carries a mountable URL that a terminal cannot have. `Openable.kind` is what
`open` routes on, which is why the whole entry is handed back rather than just its id: the menu
should not have to know which magic string means "spawn a shell".

### Presets are carried on `AppsMenuHandlers`, not a menu of their own

Carried on `AppsMenuHandlers` rather than as a menu of its own, and that is the decision worth
stating. `appsMenu()` is the single definition that feeds both the title bar's Apps menu and the
switcher row's `+` — so hanging presets off it puts them in both surfaces at once, with nothing to
keep in sync, and puts "apply an arrangement" directly under "open one more app". Those are the same
question at two scales, and the `+` at the end of a cluster's own tabs is exactly where someone
stands when they ask either one.

It also means `ClusterBar` needs no change at all: it already forwards one `AppsMenuHandlers` from
`WindowRoot` to `AddAppButton` without inspecting it.

### Where Apps sits, and why the apps are a flat list

Apps sits between Edit and View, where a menu about *what is open* reads more naturally than one
buried under File. Every entry opens a new instance; none is disabled for being open already, because
"already open" stopped being a state an app can be in. They are disabled together, or not at all,
when the window has nowhere to put one — see `AppsMenuHandlers.blocked`.

The apps themselves are a flat list, and that has not changed: every entry does one thing, and
nesting a one-item branch under each would be a caret to click before the click that opens anything.

**Presets are the exception, and they are why `MenuItem` has a `submenu` at all.** There are three
built-ins and however many the user saves, they are a column of names, and flattened in here they
would put "open one more Files" and "rearrange this entire cluster" in one undifferentiated list
where a mis-click between neighbours does something very different from what was meant. Open Recent
went the other way for a reason that does not apply here — what it had to show was a path, a date,
and whether the folder still exists, which is a surface rather than a list.

### App Library sits last, and is the one row `blocked` does not reach

The list above it is what this build ships. `App Library…` is how that list gets longer, so it sits
under the rows themselves and under Presets, behind its own separator — last, because it is the only
row that opens nothing into this cluster.

It was, until it was added, reachable from exactly one place: the `Install App` card on Home. That
card is passed on the way *into* a project, which left the library unreachable from inside one
without going back — so an app you discover you need mid-session could not be installed from where
you noticed. Home's card stays; the two raise the same screen through the same
`librarySurface.openLibrary`, and neither owns it.

**It is deliberately not covered by `AppsMenuHandlers.blocked`.** Everything above it opens into a
pane and is refused by a window with no cluster; the library is a screen drawn over the band and
needs none. A window with nowhere to put an app is, if anything, the one most likely to be looking
for one to install.

It rides in `appsMenu()` rather than the title bar, so — like Presets, and for the reason that
section gives — the switcher row's `+` gained it at the same time, with nothing to keep in sync.

### Rail pages and the terminal band open instantly

A rail page, docked or expanded, is one `PageSurface` in `Frame`. It used to pull out of the rail
(a `translateX` slide docked, a clip reveal expanded) and tuck back in on close; it no longer moves
at all. Opening, closing and dock/expand all land on the frame they happen: the page is drawn at its
final geometry when it mounts and is gone the render it closes. The terminal band is the same — its
toggle sets the height outright rather than springing to it. A sliding panel takes time to reach
what was asked for and makes everything beside it re-lay-out on the way, and it read as less clean
than a panel that is simply there. Dragging either one's handle is still 1:1 with the pointer.

Switching straight from one page to another does not close and reopen: the panel stays and the new
body fades in (`instant`, opacity only). The body a page opens with is drawn at once, with no fade.
The mode is a prop rather than a key, and `WindowRoot` gives both slots the same component
(`PageShell`), because an app page's iframe is portalled into a host inside the body; a different
component type or key would remount it and reload the frame.
