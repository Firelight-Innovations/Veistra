/**
 * Every call this app makes to its host, in one file.
 *
 * The shapes below mirror `src-tauri/src/apps/files.rs` and are *restated* here
 * rather than imported, so that nothing in an app reaches into `src/`. That
 * argument, what catches a drift, and the fuller account of most of the calls
 * below is in `docs/design-notes/viewer-app.md`. Wrapping `invoke` also means
 * the method-name strings appear exactly once — nothing outside this module
 * spells `"files/read-bytes"`.
 */
import { VeistraRpcError, invoke } from "@veistra/bridge";

// --- what the backend returns -------------------------------------------------

/** `"other"` is a pipe, a socket, a device node, or a broken symlink. */
export type EntryKind = "dir" | "file" | "other";

export interface Entry {
  name: string;
  path: string;
  kind: EntryKind;
  /** `null` for anything that is not a file — a directory has no one size. */
  size: number | null;
  /** Milliseconds since the Unix epoch, or `null` when the entry could not be
   *  stat'd. Used to notice a file changing under an open tab. */
  mtime: number | null;
}

export interface Listing {
  path: string;
  /** `null` at a drive root — there is no "up" from there. */
  parent: string | null;
  entries: Entry[];
}

export interface Root {
  path: string;
  /** The folder's last component, for the explorer header. */
  name: string;
}

export interface Stat {
  path: string;
  name: string;
  kind: EntryKind;
  size: number | null;
  mtime: number | null;
  /** `false` rather than an error, so polling for external changes can tell
   *  "deleted" apart from "the call failed". */
  exists: boolean;
}

export interface FileText {
  path: string;
  text: string;
  /** The file was longer than `limit`; this is its first part. */
  truncated: boolean;
  /** Bytes the backend is willing to return. The frontend formats it; the
   *  number lives in Rust so the two cannot drift. */
  limit: number;
  mtime: number | null;
}

export interface FileBytes {
  path: string;
  /** Standard base64, no data-URI prefix. See `toBytes`. */
  base64: string;
  /** The decoded length, so a caller can size a buffer without decoding. */
  size: number;
  mtime: number | null;
}

/** `files/read-head`: a file's first bytes, with the whole file's size beside them. */
export interface FileHead extends FileBytes {
  /** The file is longer than what came back. `size` is the whole file. */
  truncated: boolean;
}

export interface WriteResult {
  path: string;
  /** The mtime the file now has. Becomes the next write's `baseMtime`. */
  mtime: number | null;
}

/** What `files/create-file` and `files/create-dir` report making. */
export interface Created {
  path: string;
  name: string;
  kind: EntryKind;
}

// --- the calls ----------------------------------------------------------------

/** Where the tree roots: the open project, else the manifest's directory. */
export const getRoot = () => invoke<Root>("files/root");

/** One directory's immediate children, sorted directories-first by name. */
export const list = (path: string | null) => invoke<Listing>("files/list", { path });

/** One entry as it is *right now* — the external-change poll. */
export const stat = (path: string) => invoke<Stat>("files/stat", { path });

/** One text file, up to the backend's cap. Rejects non-UTF-8; see `isNotText`. */
export const readText = (path: string) => invoke<FileText>("files/read", { path });

/** A web link to the system browser. Rust accepts only http, https and mailto. */
export const openUrl = (url: string) => invoke<null>("files/open-url", { url });

/** One file's raw bytes, base64'd. Rejects rather than truncating. */
export const readBytes = (path: string) => invoke<FileBytes>("files/read-bytes", { path });

/** A file's first `bytes` (capped at 4 MiB) — for a `.blend` thumbnail, say. */
export const readHead = (path: string, bytes: number) =>
  invoke<FileHead>("files/read-head", { path, bytes });

/**
 * Overwrite a file, refusing if it changed since `baseMtime` — the mtime from
 * the read this text was edited from, passed through unchanged. `null` means no
 * readable mtime, which the backend treats as "write anyway"; why, in the notes.
 */
export const write = (path: string, text: string, baseMtime: number | null) =>
  invoke<WriteResult>("files/write", { path, text, baseMtime });

/**
 * Create an empty file, or a folder, directly inside `parent`. `name` is one
 * path component and the backend refuses anything else, with a message worth
 * showing; none of it is checked here, because path semantics live on one side.
 * The list of what is refused is in the notes.
 */
export const createFile = (parent: string, name: string) =>
  invoke<Created>("files/create-file", { parent, name });

export const createDir = (parent: string, name: string) =>
  invoke<Created>("files/create-dir", { parent, name });

/**
 * Give the entry at `path` a new name, in the folder it is already in. Files and
 * folders alike; `name` is validated exactly as a create's is, so this cannot
 * move anything out of its folder — moving is a different call that does not
 * exist yet. Refuses rather than overwriting when the name is taken; why that
 * refusal is hand-written is in the notes and at `rename_at` in `files.rs`.
 */
export const rename = (path: string, name: string) =>
  invoke<Created>("files/rename", { path, name });

/**
 * Copy an entry to a free name beside it — `notes.txt` becomes `notes copy.txt`,
 * then `notes copy 2.txt`. Files and folders alike; a folder takes everything
 * under it, and a copy that fails part-way leaves nothing behind. Never
 * overwrites; the notes have what closes the window on a name that looked free.
 */
export const duplicate = (path: string) => invoke<Created>("files/duplicate", { path });

/** What `files/save-as` reports writing, or `null` when the dialog was cancelled. */
export interface SavedAs {
  path: string;
  name: string;
  mtime: number | null;
}

/**
 * Write `text` to a file the user picks in the OS save dialog. `name` is only
 * the dialog's suggestion; where it lands is entirely theirs. Resolves `null` on
 * cancel, which is not a failure and must not be drawn as one. No `baseMtime`,
 * unlike {@link write}: there is nothing to conflict with.
 *
 * The hour-long timeout is deliberate — `invoke`'s default thirty seconds would
 * reject a native dialog that is going to succeed. Argued in the notes.
 */
export const saveAs = (name: string, text: string) =>
  invoke<SavedAs | null>("files/save-as", { name, text }, 60 * 60 * 1000);

/** What `files/delete` reports removing. `trashed` says which it was. */
export interface Deleted {
  path: string;
  kind: EntryKind;
  /** The entry went to the Recycle Bin rather than being unlinked. */
  trashed: boolean;
}

/**
 * Move an entry to the Recycle Bin. Files and folders alike; a folder takes
 * everything under it. Recoverable, and the backend refuses rather than falling
 * back to a permanent unlink when the volume has no Recycle Bin — so `trashed`
 * is always true today and the caller must read it rather than assume. See
 * `delete_at` in `files.rs`, and the notes.
 */
export const remove = (path: string) => invoke<Deleted>("files/delete", { path });

/** How much a recursive delete would take with it. */
export interface TreeSize {
  path: string;
  files: number;
  dirs: number;
  /** The backend stopped counting. `files + dirs` is a floor, not a total. */
  truncated: boolean;
}

/** Count what is inside a folder, for the sentence a delete confirmation owes
 *  the user. Capped in the backend, which is what `truncated` reports. */
export const treeSize = (path: string) => invoke<TreeSize>("files/tree-size", { path });

// --- the Recycle Bin ----------------------------------------------------------
// The other half of `files/delete`. Every one of these is **scoped to the open
// project** by the backend, and nothing else in the system Recycle Bin is
// reachable from here — the notes have how, and `src-tauri/src/apps/trash.rs`
// has why that ordering matters.

/** One item sitting in the Recycle Bin that came from this project. */
export interface TrashItem {
  /** Opaque, and only meaningful to the backend. Pass it back unchanged. */
  id: string;
  name: string;
  /** Where it was when it was deleted, and where a restore puts it back. */
  originalPath: string;
  originalParent: string;
  /** Milliseconds since the Unix epoch. */
  deletedUnixMs: number;
  /** Bytes, for a file. `null` for a directory, which has no one size. */
  size: number | null;
  /** Immediate children, for a directory. `null` for a file. */
  entries: number | null;
}

export interface TrashListing {
  /** The project the list is scoped to, so the view can say what it is showing. */
  root: string;
  /** Newest deletion first. Ordered by the backend; do not re-sort. */
  items: TrashItem[];
}

/** Everything this project has deleted that is still recoverable. */
export const trashList = () => invoke<TrashListing>("trash/list");

/**
 * Put one item back where it came from. Refuses rather than overwriting when
 * something occupies the original path, and refuses when the folder it came from
 * no longer exists — that one asks the user to recreate the folder rather than
 * inventing directories for them. Both are rejections worth showing verbatim.
 */
export const trashRestore = (id: string) =>
  invoke<{ path: string; name: string }>("trash/restore", { id });

/**
 * Destroy one item permanently. The only call in this app with no recovery path
 * at all — `files/delete` is undone by `trashRestore`, and this is undone by
 * nothing. Everything that calls it owes the user a confirmation that says so.
 */
export const trashPurge = (id: string) =>
  invoke<{ name: string; originalPath: string }>("trash/purge", { id });

/** Select the item in the OS file manager. */
export const reveal = (path: string) => invoke<null>("files/reveal", { path });

/** Hand the file to whatever the OS opens it with. */
export const openExternal = (path: string) => invoke<null>("files/open-external", { path });

// --- reading the errors -------------------------------------------------------

/**
 * A `files/write` that lost a race, and the mtime it lost to. The backend
 * refuses with `INVALID_PARAMS` and a `data` payload rather than a new error
 * code, so this is the only place that knows the payload's shape. `null` for
 * every other failure, including one the user cannot resolve by reloading.
 */
export function staleWrite(err: unknown): { mtime: number | null } | null {
  if (!(err instanceof VeistraRpcError)) return null;
  const data = err.data as { kind?: unknown; mtime?: unknown } | undefined;
  if (!data || data.kind !== "stale") return null;
  return { mtime: typeof data.mtime === "number" ? data.mtime : null };
}

/**
 * Whether a `files/read` failed because the file is not UTF-8 text. This is what
 * lets the text viewer be the *fallback* for unknown extensions rather than a
 * list of them: "is this text" is not knowable from a name, so the app tries and
 * hands off to the unsupported viewer on this one error. Matched on the message
 * rather than on a code of its own, for the reason in the notes.
 */
export function isNotText(err: unknown): boolean {
  return err instanceof VeistraRpcError && err.message.includes("not a UTF-8 text file");
}

/** The failing method, plus whatever the host said about why. */
export function describe(method: string, err: unknown): string {
  if (err instanceof VeistraRpcError) return `${method} — [${err.code}] ${err.message}`;
  return `${method} — ${String(err)}`;
}

// --- helpers ------------------------------------------------------------------

/**
 * Base64 back to bytes, through `atob` — see the notes for why that decoder.
 * Callers that pass the result to something which *transfers* the buffer
 * (pdf.js does) must copy first; see `PdfViewer`.
 */
export function toBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Bytes as a person reads them. Binary units, since these are file sizes. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10, none above — enough to tell 1.2 MiB from 1.9 MiB
  // without printing a precision the number doesn't carry.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A path's last component, with the separator guessed from the path itself —
 * both are checked, because a Windows path can contain either. Nothing here
 * parses paths beyond this: the backend owns path semantics. See the notes.
 */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The extension, lowercased, without the dot; `""` when there is none. A leading
 * dot does not start one: `.gitignore` is a *name*, not an extension-less file
 * of type "gitignore". The icon resolver and the viewer registry depend on that.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}
