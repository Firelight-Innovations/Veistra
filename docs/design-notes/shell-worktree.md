# Shell worktree and diff design notes

Design rationale moved out of the source to keep comment concentration under the caps in
STANDARDS.md section 10; the source files point back here.

## src/shell/diff/DiffView.tsx

### Sharing Monaco with the Files app

Files (`apps/files`) also uses Monaco, wired separately in
`apps/files/ui/src/viewer/monaco.ts`. The two do not collide: an app runs in
its own iframe, so each has its own `self.MonacoEnvironment` and its own
theme registry. They do share chunks — both entries reach the same
`monaco-editor` modules, so Rollup hoists them into one shared dynamic
chunk. That is fine and deliberate: it is dynamic on both sides, so
`index.html` preloads none of it.

### Why `editor.api`, and why TOML is the only language

Imported from `monaco-editor/editor/editor.api`, not `.../editor.main` —
`editor.main` registers every bundled language, and the IntelliSense
infrastructure behind them, as a side effect of import. None of that is
needed to show a read-only diff.

The cost of that choice is that Monaco arrives here knowing no *bundled*
language, so `language` below is honoured only for the hand-written grammars —
`"toml"`, `"gdscript"` and `"godot-resource"` — registered by the
`registerLanguages` call further down. Every other id resolves
to nothing and renders as plain text — which is the same answer the prop gave
for every id before, so no caller regresses.

That asymmetry is not an oversight, it is the shape of the fix. TOML is
hand-written (`@veistra/monaco-languages`) precisely because Monaco does not
ship it, and a hand-written Monarch grammar can be handed to a bare
`editor.api` instance for free. Every other language would arrive by
importing its own entry under `languages/definitions/`, one lazy chunk each,
and that is a bundle decision for whoever decides a source-control diff should be
fully coloured — not a side effect of teaching this editor the one format
Veistra's own config files are written in.

(The short specifier is not a shorthand for the long one: monaco-editor
0.56's `exports` map is `"./*": "./esm/vs/*.js"`, so
`monaco-editor/esm/vs/editor/editor.api` would resolve to
`esm/vs/esm/vs/editor/editor.api.js` and fail. The code below has always been
right; this comment used to name a path that does not exist.)

### The `veistra-dark` theme's colours

Colours are lifted from src/tokens.css, not chosen here. `editor.background`
and `editor.foreground` reuse --bg and --text directly. The diff
insert/remove backgrounds reuse --ok and --err — the same pair
`CHANGE_TOKEN` in contract.ts already uses for added ("A") and deleted
("D") files — at two alphas: a low "wash" alpha for the full-line
background, matching the --accent-wash convention already in tokens.css,
and a stronger alpha for the character-level highlight within a changed
line.

The four diff colours are 8-digit hex rather than `rgba(...)`, and that is
not a style preference. Monaco parses a theme colour with `Color.fromHex`,
which is `parseHex(hex) || Color.red` (base/common/color.js:182), and
`parseHex` accepts only `#RGB`, `#RGBA`, `#RRGGBB` and `#RRGGBBAA`. A
perfectly valid CSS `rgba()` string is not rejected loudly — it silently
becomes **opaque red**. These four were written that way and did render red;
nothing mounts this component, so nobody had seen it. The alpha byte is
round(alpha * 255): 0.08 is 0x14, 0.25 is 0x40.

## src/shell/diff/reviewPrompt.ts

### The pasted format is a contract

On one side is a person writing prose in a panel; on the other is a coding
agent reading it out of a terminal or a paste buffer, with no schema between
them but the shape of these lines. It has to stay deterministic — the same
notes always produce the same string — and it has to survive being pasted into
a shell.

Surviving a shell is what `escapeBody` is for, and why the body ends up on one
line inside quotes: a newline in a pasted string is a submitted line, so an
unescaped two-paragraph note would hand the agent its first paragraph and run
the second as a command. The four replacements happen in a fixed order,
backslash first, because escaping the escape character after the others would
escape their backslashes a second time.

### Why there is a preamble and Orca has none

Orca has an agent chat pane and can put a batch of notes into it as a labelled
message. Veistra has a terminal, so this string arrives as raw typing at whatever
prompt is sitting there, with nothing around it to say that a list of
file-and-line blocks is a review rather than a paste accident. One sentence in
front of the blocks is what makes it read as an instruction.

### Why the scope line

The same path at the same line means different code in each of the three diffs
a note can be written against. An agent told only "line 12 of src/a.rs" would
go looking in the working tree even when the note was about what the branch
changed since it forked.

## src/shell/diff/AnnotatedDiff.tsx

### Why the notes are fetched per diff rather than hoisted

`useGitStatus` is hoisted into `WindowRoot` because two regions read one status
and two fetches would be two chances to disagree about the branch. None of that
applies here. Nothing else reads these notes, only one diff is open at a time,
and the whole file is a few kilobytes of JSON — so the cost of re-reading on a
file switch is a rounding error, and hoisting would put a fourth review-shaped
prop through `WindowRoot`, which is already the largest file in the tree.

Re-reading is also what makes another window's notes appear. There is no
watcher behind any of this, and a fetch on mount is the entire update model —
the same one `GitControl` uses, for the same reason.

### Why the notes list sits under the diff and not inside it

This is the one substantial departure from Orca, which floats a card in a
Monaco view zone at the commented line. In a wide editor that is plainly the
better answer: the note sits against the code it is about.

This diff is mounted in a panel whose default width is `--w-panel-default`,
380 pixels. A card of prose inserted between two lines of code at that width
pushes most of the visible diff off screen and takes the surrounding lines —
the ones that give the note its meaning — with it. A list below keeps both
readable, and the glyph-margin marker plus `DiffAnnotations.reveal` are what
keep a note and its line findable from each other.

The cost is real and worth stating: with the list scrolled and the diff
scrolled independently, a note and its line can both be visible without being
beside each other. Clicking the note's line label is what closes that gap, and
it is why that label is a button rather than text.

## src/shell/diff/reviewComments.ts

### Why `markAtLine` is a named function

Two callers in `DiffView` ask the same question and must not answer it
differently: the glyph margin's click handler asks whether a line already has a
marker, to decide between opening what is there and starting something new, and
the hover affordance asks the same thing to decide whether to draw its `+`.

They were written as two separate `.find` calls and did disagree. Monaco merges
decorations rather than letting one win, so a noted line drew both classes into
the same twelve-pixel glyph cell and grew a plus through its own dot on hover.
One function, five tests, and the two surfaces now cannot drift.

Overlapping ranges are legal — a note on 3-9 and a note on 5 are both about
line 5 — and the decorations are in file order, so the first match is the one
starting soonest.

## src/shell/worktree/rowFocus.ts

### The row that could not be clicked

Clicking a change at the top or bottom edge of the source-control list did
nothing. No diff pane, no error, nothing in the diagnostics ring buffer. The
same row opened every time from the keyboard.

Every list in this panel scrolls — `.worktree__lists`,
`.worktreepanel__divlist` and `.worktreepanel__graph-scroll` are each
`overflow-y: auto` — and every row in them is focusable. Chromium focuses a
control on `mousedown`, and focusing an element that is only partly in view
scrolls it into view. So an edge row slid out from under the cursor between the
press and the release, `mouseup` landed on a different element, and the browser
generated no `click` at all. Not swallowed, not blocked by a handler: never
created. A row in the middle of a list does not move, and always worked.

**The scroll is the browser's, not this repository's.** Nothing here calls
`scrollIntoView`, and `scroll-behavior` is set nowhere; the native focus scroll
needs no script and is instant, which is why the default behaviour is unaffected
by that property. Grepping for a scroll call finds nothing and proves nothing.
That search is what made this look impossible for a while, and it is the reason
this page exists.

The position-dependence is what identified it. Everything a reader would suspect
first had already been cleared from the source — the handler is wired
identically for both lists, the row identity round-trips, no effect resets the
selection, the pane's open condition is `selected !== null`, nothing remounts the
subtree, no overlay intercepts the pointer, and no capture-phase listener eats
the event. All of that was true, and none of it mattered.

### Why `focus({ preventScroll: true })` rather than the alternatives

`preventDefault` on `mousedown` suppresses the browser's focus and the scroll
with it; the explicit `focus` puts the focus back without one. It is mouse-only
on purpose: a row focused by Tab, or by the commit graph's arrow-key roving,
*should* scroll into view, since that is the only thing making an off-screen row
reachable, and neither path goes through the helper.

Rejected, and why:

- **Activating on `pointerup` or `mousedown` instead of `click`.** Sidesteps the
  pairing rather than fixing it, and breaks the keyboard — neither fires for
  Enter on a focused button, so `onClick` would have to stay beside them and
  every mouse activation would then run twice.
- **Leaving focus alone and giving the rows `scroll-margin`.** Changes where a
  scroll lands, not whether one happens, so the row still moves.

### What a test covers, and what it still cannot

The defect is a `mousedown`/`mouseup` pairing inside a scroll container: it needs
layout and hit-testing to reproduce, and **that part is still not covered.** No
jsdom test can be: jsdom gives elements no size and scrolls nothing, so the
browser focus-scroll behind the bug cannot occur there, and a click on a row at
the "edge" of a list succeeds whether the fix is present or not. Only a real
browser — Vitest's browser mode, which this repository does not run — reaches
the symptom itself.

`rowFocus.test.tsx` covers the fix's **mechanism** instead, which is the strongest
claim available short of that: the row cancels `mousedown`'s default, and focuses
itself with `preventScroll`. Unwiring the handler, dropping the `preventDefault`
or dropping the `preventScroll` each turn it red, so neither half of the helper
can be deleted quietly. `selection.test.ts` sits underneath both and would not
have caught any of it.

---

## src/shell/worktree/sectionFloor.ts

### The error nobody could read

`WorktreePanel` splits its height between the commit graph and this cluster's
changes. Both halves are `overflow: hidden`, and every child of the
source-control half is `flex: none`, so a half shorter than its own chrome
neither scrolls nor squeezes — it clips, last child first. The last child is the
commit box, and the first thing inside the commit box is `.worktree__error`, the
only place a failed git operation is reported.

The floor on the divider was one constant, `MIN_SECTION_PX = 120`. With a diff
pane open the half's unshrinkable children summed to roughly 360px: the branch
row, the diff pane's own `min-height: 220px`, and the commit box. Dragged to
that floor, the commit box was entirely outside the box that clips. A commit
with nothing staged then failed, wrote its message into `failure`, rendered it,
and rendered it off-screen. The panel reported nothing, and there was no second
channel it could have reported on.

### Two floors, because they answer different questions

`clipFloorPx` is the guarantee: the sum of the children that must never be lost,
written to the section's `min-height`. `dragFloorPx` is the comfort: that plus a
list worth looking at, and it bounds the drag gesture.

They are separate because the drag clamp cannot cover every case. It runs on
`pointermove` and knows the panel's height at the moment of the gesture — it
says nothing about the ratio React starts at, or about a window shrunk after the
divider was placed. `min-height` covers both, and it is the smaller number, so
the graph is squeezed as little as the guarantee allows.

### Why the graph is the half that shrinks

A `min-height` is only honoured by taking the difference out of another flex
item. With every item `flex-shrink: 0` — which is what both sections were, and
for a good reason recorded in `worktreePanel.css` — flexbox has nowhere to take
it from, so it overflows the column instead and clips the very box the
`min-height` was protecting. `.worktreepanel__section--top` therefore takes
`flex-shrink: 1` back. Nothing shrinks in the ordinary case, because
`sectionBasis` keeps the two bases summing to the column exactly and there is no
negative free space until the `min-height` creates some. The graph is the right
half to squeeze: it scrolls its own contents and loses rows, not surfaces.

### Why the diff pane moved inside `.worktree__body`

Making the floor big enough for the diff pane's 220px would have been a floor of
roughly 360px, which is most of a panel. The alternative is to stop the diff
pane competing with the commit box at all: the lists and the diff now share one
flexible child, so the diff's height comes out of the list. The commit box's
height stops depending on whether a diff is open, which is what makes a floor
statable in the first place. The diff pane's `min-height` also became
`min(220px, 100%)`, since a floor taller than the box it stands in is not a
floor — it is an overflow with a destination.

### What is not covered by a test

The clipping itself. Reproducing it needs layout, and a DOM is not enough for
that: a test file may now ask for jsdom (STANDARDS.md §8.3), but jsdom lays
nothing out, so a clipped box and an unclipped one measure the same there — the
same wall `rowFocus.test.tsx` runs into above. `sectionFloor.test.ts` holds the
arithmetic that reaches `flex-basis` and `min-height` instead — including the
property the bug violated, that no reachable divider position leaves the bottom
section below the height its error line needs.
