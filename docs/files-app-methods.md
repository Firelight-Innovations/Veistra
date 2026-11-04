# The Files app's methods

The RPC surface a frontend — or an **agent** — uses to browse, edit and delete
files in the open project. Every method here is reached the same way any app
method is, through `invoke` from `@veistra/bridge`; `docs/tool-protocol.md`
describes that transport and does not describe these, because they are one app's
methods rather than part of the protocol.

The implementation is `src-tauri/src/apps/files.rs` and
`src-tauri/src/apps/trash.rs`. The frontend's own wrappers are
`apps/files/ui/src/rpc.ts`, which is the only file in the app that spells a
method name.

Times are **milliseconds since the Unix epoch** throughout. Paths are absolute
and in whatever form the host OS produced.

## Reading

| Method | Params | Result |
|---|---|---|
| `files/root` | none | `{path, name}` |
| `files/list` | `{path?}` | `{path, parent, entries: Entry[]}` |
| `files/stat` | `{path}` | `{path, name, kind, size, mtime, exists}` |
| `files/read` | `{path}` | `{path, text, truncated, limit, mtime}` |
| `files/read-bytes` | `{path}` | `{path, base64, size, mtime}` |
| `files/read-head` | `{path, bytes?}` | `{path, base64, size, truncated, mtime}` |

`Entry` is `{name, path, kind, size, mtime}`, where `kind` is `"dir"`, `"file"`
or `"other"` — a pipe, a socket, or a broken symlink. Listings come back sorted
directories-first then case-insensitively by name; **do not re-sort them**, or
two orderings exist and can disagree.

`path` is optional on `files/list` only. Absent or `null` means the project root.
Every other method requires it, because none of them has a harmless thing to do
to a directory nobody named.

`files/read` truncates at `limit` bytes and says so. `files/read-bytes` *refuses*
above its cap rather than truncating — half a PNG is not a smaller PNG.
`files/read-head` is the exception that asks for a prefix: the first `bytes` (at most
4 MiB, the default), with `size` the whole file's length. It exists for formats whose
answer sits at the front, such as the thumbnail in a `.blend` (`docs/design-notes/asset-previews.md`).

## Writing

| Method | Params | Result |
|---|---|---|
| `files/write` | `{path, text, baseMtime}` | `{path, mtime}` |
| `files/create-file` | `{parent, name}` | `{path, name, kind}` |
| `files/create-dir` | `{parent, name}` | `{path, name, kind}` |
| `files/rename` | `{path, name}` | `{path, name, kind}` |
| `files/duplicate` | `{path}` | `{path, name, kind}` |
| `files/save-as` | `{name, text}` | `{path, name, mtime}` or `null` |
| `files/delete` | `{path}` | `{path, kind, trashed}` |
| `files/tree-size` | `{path}` | `{path, files, dirs, truncated}` |

`baseMtime` is the mtime of the read the text was edited from. A mismatch is
refused with `INVALID_PARAMS` and `data: {kind: "stale", mtime}` — re-read
before retrying. `null` means "I have no time to compare against" and writes
unconditionally.

`name` on the create and rename methods is **one path component**, not a path. A
separator, `..`, a character Windows cannot store, a trailing dot or space it
would silently drop, or a reserved device name (`con`, `lpt1`, and with any
extension) are all refused. A create refuses a name that is taken; a rename
refuses to move onto an existing entry, and allows a change of capitalisation
only.

`files/duplicate` copies an entry to a free name beside it: `notes.txt` becomes
`notes copy.txt`, then `notes copy 2.txt`. The suffix goes **before** the
extension, and a leading dot counts as part of the name — `.gitignore` becomes
`.gitignore copy`. Folders go recursively, and a copy that fails part-way
removes what it made rather than leaving a half-filled folder behind. It never
overwrites: the destination is reserved with the same one-syscall
check-and-create the create methods use, so there is no window in which a name
that looked free stops being one. Entries that are neither a file nor a
directory after following links — a broken shortcut, a named pipe — are skipped.

`files/save-as` opens the **OS save dialog** and writes `text` to whatever the
user chooses; `name` is only the dialog's suggestion. It resolves `null` when
they cancel, which is not an error and must not be drawn as one. There is no
`baseMtime` here and that is deliberate — the user has just seen the folder's
contents, and if they picked an existing file the system dialog already asked
them about replacing it. Being a dialog, it can sit open for as long as a person
takes, so callers must pass a timeout well past `invoke`'s default thirty
seconds.

`files/delete` moves the entry to the **Recycle Bin** — it does not unlink — and
`trashed` reports that. It refuses rather than falling back to a permanent
delete when the volume has no bin. Folders go recursively; `files/tree-size`
exists to count what that would take, capped at 10,000 entries with `truncated`
saying the total is a floor.

## The Recycle Bin

| Method | Params | Result |
|---|---|---|
| `trash/list` | none | `{root, items: TrashItem[]}` |
| `trash/restore` | `{id}` | `{path, name}` |
| `trash/purge` | `{id}` | `{name, originalPath}` |

`TrashItem` is
`{id, name, originalPath, originalParent, deletedUnixMs, size, entries}`. `size`
is bytes for a file and `null` for a directory; `entries` is the immediate child
count for a directory and `null` for a file. Both are `null` when the item could
not be measured. Items come back **newest deletion first**.

`id` is opaque. Pass it back unchanged and do not parse it — on Windows it is a
shell display name, and its only guaranteed property is that it matches within a
single listing.

### Scoping — read this before using these three

`trash/list` does **not** return the system Recycle Bin. It returns only items
whose original location was inside the current project root, and `trash/restore`
and `trash/purge` look their `id` up in that same scoped set.

That is the security property of this surface, and the ordering is what makes it
one: the scope is applied before the lookup, so an id belonging to something
outside the project is simply *not found*. There is no call here that can touch a
file the project never contained. The system bin holds everything the user has
ever deleted anywhere, and an agent driving these methods can reach none of it.

A "not found" refusal deliberately does not distinguish *out of scope* from *not
there*. Saying which would confirm the existence of a file the caller is not
allowed to act on.

### Restore refuses rather than overwrites

Two ways, both `INVALID_PARAMS`, both worth showing verbatim:

- **Something already occupies the original path.** Restoring would destroy it,
  so it does not happen. Rename or move whatever is in the way and retry.
- **The original folder no longer exists.** The folder is *not* recreated —
  inventing directories on a restore is a side effect nobody asked for. Recreate
  it and retry.

There is no restore-to-a-new-name. It would need a second parameter and a second
set of collision rules, and the two refusals above already leave the caller with
a way through.

### Purge is the one thing with no way back

`files/delete` is undone by `trash/restore`. `trash/purge` is undone by nothing —
not by Veistra, not by Windows. Anything that calls it on a user's behalf owes them
a confirmation that says so in those terms.

## Platform

`trash/*` requires an enumerable trash, which Windows and Freedesktop Unix have
and **macOS does not** — it offers no API to list or restore. On macOS the three
methods refuse with a message saying that, rather than returning an empty list:
an empty list would be a claim that the project has deleted nothing, which is a
different and false statement.
