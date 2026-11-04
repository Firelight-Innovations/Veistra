# Comments on the Godot Viewer, the Blender Viewer and Play

`src-tauri/src/comments.rs` is the shared store behind the three new viewer
apps' comment panels. This is the rationale that didn't fit in its module doc
comment.

## Why files, one per comment

`docs/VEISTRA-UX-REWORK.md` §3.4 sets the shape: a comment anchors to a node
path in the Godot Viewer, a mesh part and material in the Blender Viewer, or a
scene, a playhead time and a screenshot in Play — then it is a file in
`.veistra/comments/` *inside the environment*, so it travels with that
environment's branch and is visible to an agent as an ordinary tracked file,
the same way [`crate::design_comments`] is visible to the Design Mode MCP
server.

Two environments are two branches and rarely collide, but two comments left in
the same environment at nearly the same moment must not: a shared
array-plus-counter file makes that a merge conflict on every concurrent write,
where a directory of independently-named files makes it nothing at all.
`new_id` (hex milliseconds plus two random bytes) is why an id never has to be
reserved from a shared counter first.

Resolving a comment *does* rewrite its one file in place, which is the one
kind of collision this format still allows — two sides resolving the same
comment at once. Inside one Veistra that cannot lose a write any more: an
agent's `resolve_play_note` on the MCP listener and the person's Still broken on
an app-call worker take turns on one lock (`comments::WRITES`), held from the
read to the rename. Between two processes, or a `git checkout` mid-write, it is
accepted rather than designed around: it is rare, and unlike a status field on
a shared index it cannot happen on every build.

## Why no cache, unlike `design_comments`

This module is simpler than `design_comments` on purpose: that one holds one
book, cached in memory and hydrated once at launch, because it lives under the
app's own config directory and nothing else ever touches it between launches.
A `.veistra/comments/` file can change from outside this process at any moment —
a `git checkout`, another clone of the same worktree, an agent editing it
directly — so there is no cache here to go stale. Every call reads or writes
the file it needs and nothing else.

## The fix loop: open, working, fixed, resolved

A comment moves through four statuses. An agent can start one (`working`) and
report it done (`fixed`, with its note and commit), through the context server's
`resolve_comment` or, for Play's notes, the workspace server's
`start_play_note` and `resolve_play_note`. An agent never closes a comment:
`fixed` asks the person to check, and only the person moves it to `resolved`
(Looks good) or back to `open` (Still broken, `comments/verdict`). Still broken
keeps the thread: the agent's fix note moves into `replies`, followed by the
person's reply, so the next attempt sees what was tried.

For a Play note, Still broken also records the scene again, and the take sent
from that run joins the same comment rather than making a new one
(`comments::add_take`): it rides on a reply as `Reply.take`, and
`Comment::takes` lists the note's takes, oldest first. It goes to the agent in
the comment's `sentTo`, the one the note was sent to before (#321).

The rejected alternative was letting an agent's resolve close the comment, as
it did before. The person who saw the problem is the one who can say it is
gone, and a closed comment drops out of every list where that check would
happen.

Play's notes are comments with a `take` anchor: the take and its number, the
note's number, its time or range, the feedback packet's folder, and the scene and node when
known, so the Scene and Blender views can show a note on its node or part.

The rules are the store's, not its callers': `resolve_with_commit` refuses an
agent's resolve of a comment that is not open or working, and anyone's resolve
of a resolved one. The MCP tools still check first, for a friendlier message,
but a new caller cannot undo a person's Looks good by forgetting to.

## How a change reaches an open pane

Every write tells one observer (`comments::observe`), installed at launch by
`comment_events.rs`. It emits `comments:changed` to every window, naming each
cluster on that environment (two can share a checkout), and each window's shell
relays it into its app frames when it shows one of them. The apps re-list
through `apps/shared/commentEvents.ts`, coalesced over 100 ms because Send files
a burst. The observer runs after the write's lock is released.

The rejected alternatives: polling in every pane (Play's review polls every
2 s while a sent note is open, and stays as the fallback; the other panes never
noticed an agent's fix until they were remounted), and
the file watcher's `files:changed`, which runs only for roots a Files frame
asked to watch and fires on every write under the root, takes included.

The same observer reports `godot:note_fixed` and `godot:note_resolved` through
`telemetry::track`, so a fix counts once whichever surface or agent made it,
and whether or not a Play pane was open to see it.

## What's not wired up yet

Nothing reads `.veistra/comments/` into an agent's turn by itself: an agent
finds them with `list_comments` or `list_play_notes`. Play's Send is the one
place that also types a reference at the agent's prompt (`packet.md`).

`Anchor::Scene.screenshot` is likewise always `false` in this build: none of
the three viewers has a real frame to capture from yet (see each app's own
honest-empty-state notes), so nothing ever calls `create` with screenshot
bytes attached.
