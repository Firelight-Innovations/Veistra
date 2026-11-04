/**
 * The comment model shared by the Godot app's Editor and Play modes and the
 * Blender Viewer — one store. `docs/VEISTRA-UX-REWORK.md` §3.4: a comment anchors to
 * a node path, a mesh part plus material, or a scene plus a playhead time plus
 * a screenshot, or is a note on a recorded take, and lives as a file in
 * `.veistra/comments/` inside the calling cluster's environment.
 *
 * Their Rust halves (`godot_viewer.rs` for both of the Godot app's modes, and
 * `blender_viewer.rs`) answer the same methods below by delegating to
 * `src-tauri/src/comments.rs`, so this module — like `viewer/ui/src/rpc.ts` for
 * the Files app — *restates* the wire shapes rather than importing anything
 * from `src/`. It is the one place any of the viewers spells
 * `"comments/create"`.
 *
 * This lives under `apps/shared/` rather than in one of the apps, because
 * ESLint's app-isolation rule (`eslint.config.js`) forbids an app importing
 * another app's source — a copy per app would drift the moment one of them
 * fixed a bug the others still had. `apps/shared/` is
 * deliberately outside that rule (see `apps/README.md`'s layout note).
 */
import { invoke } from "@veistra/bridge";
import type { AgentTarget } from "./context";

// --- what the backend returns --------------------------------------------

/** A note on a recorded Play take, filed by Send (`src-tauri/src/godot/feedback.rs`). */
export interface TakeAnchor {
  kind: "take";
  take: string;
  /** The take's own number (Take 4); absent on notes sent before it was kept. */
  number?: number;
  /** The note's number in its take; never reused. */
  n: number;
  atMs: number;
  inMs?: number;
  outMs?: number;
  /** The feedback packet folder, relative to the environment. */
  packet: string;
  scene?: string;
  nodePath?: string;
}

/** Where a comment points: the three anchors the written spec names, and a note on a take. */
export type Anchor =
  | { kind: "node"; path: string }
  | { kind: "mesh"; part: string; material: string }
  | { kind: "scene"; scene: string; time: number; screenshot: boolean }
  | TakeAnchor;

/** As {@link Anchor}, minus the one field a caller never gets to assert:
 *  whether a screenshot exists is decided by whether {@link CreateCommentInput.screenshotBase64}
 *  actually wrote one, not by what a draft claims. */
export type AnchorInput =
  | { kind: "node"; path: string }
  | { kind: "mesh"; part: string; material: string }
  | { kind: "scene"; scene: string; time: number };

export type Author = "user" | "agent";

/**
 * Where a comment is in the fix loop. An agent's resolve lands on `fixed`,
 * for the person to check; only the person moves it to `resolved` (Looks
 * good) or back to `open` (Still broken). See `comments::Status` in Rust.
 */
export type Status = "open" | "working" | "fixed" | "resolved";

export interface Resolution {
  note: string;
  by: Author;
  /** Milliseconds since the Unix epoch. */
  at: number;
  commit?: string;
}

/** A message after the first: an earlier fix note, or the person's reply. */
export interface Reply {
  by: Author;
  body: string;
  at: number;
  commit?: string;
  /** On a take note: the Still broken take this reply was sent with. */
  take?: TakeRef;
}

/** One take in a take note's history (`comments::TakeRef`). */
export interface TakeRef {
  take: string;
  number?: number;
  packet: string;
  /** The note's number in that take, which a later take numbers afresh. */
  n: number;
  atMs: number;
  inMs?: number;
  outMs?: number;
}

export interface Comment {
  id: string;
  anchor: Anchor;
  author: Author;
  body: string;
  status: Status;
  /** Absent, not `null` — the Rust side skips the field entirely on an open
   *  comment (`#[serde(skip_serializing_if = "Option::is_none")]`), so an open
   *  comment's JSON simply has no `resolution` key. */
  resolution?: Resolution;
  /** Absent when empty, as `resolution` is when unset. */
  replies?: Reply[];
  /** The agent Send handed this comment to, so Still broken can go back to it. */
  sentTo?: AgentTarget;
  created: number;
  updated: number;
}

// --- the calls --------------------------------------------------------------

/** A node note that names the scene it was written on, so the Godot editor's
 *  Veistra dock shows it on that scene only (#320). The backend keeps
 *  `scene` on the stored anchor; notes from before it have none. */
export interface NodeInScene {
  kind: "node";
  path: string;
  scene: string;
}

export interface CreateCommentInput {
  anchor: AnchorInput | NodeInScene;
  body: string;
  /** Standard base64, no data-URI prefix — see `viewer/ui/src/rpc.ts`'s
   *  `toBytes` for the decoding half of this convention. Only meaningful when
   *  `anchor.kind === "scene"`; the backend ignores it otherwise. */
  screenshotBase64?: string;
}

/** Every comment in this cluster's environment, oldest first. */
export const listComments = () => invoke<Comment[]>("comments/list");

/** Write a new comment down and get back what was stored, id included. */
export const createComment = (input: CreateCommentInput) =>
  invoke<Comment>("comments/create", input);

/** Close a comment with a note — "Resolve with a note" in every comment panel. */
export const resolveComment = (id: string, note: string) =>
  invoke<Comment>("comments/resolve", { id, note });

export type Verdict = "good" | "broken";

/**
 * The person's answer to a fixed comment: Looks good, or Still broken with a
 * reply. With `expect`, the backend refuses it unless the comment is in that
 * status still, for an answer given somewhere that may be out of date.
 */
export const verdictComment = (id: string, verdict: Verdict, reply?: string, expect?: Status) =>
  invoke<Comment>("comments/verdict", { id, verdict, reply, expect });

/**
 * A take note's takes, oldest first: the one it was sent from, then each
 * Still broken take (#321). Empty for any other comment. The same list as
 * `Comment::takes` in Rust.
 */
export function takeHistory(comment: Comment): TakeRef[] {
  const a = comment.anchor;
  if (a.kind !== "take") return [];
  const first: TakeRef = {
    take: a.take,
    number: a.number,
    packet: a.packet,
    n: a.n,
    atMs: a.atMs,
    inMs: a.inMs,
    outMs: a.outMs,
  };
  return [first, ...(comment.replies ?? []).flatMap((r) => (r.take ? [r.take] : []))];
}

/** Still the agent's to work on. */
export function isActive(status: Status): boolean {
  return status === "open" || status === "working";
}

/** How a status reads on a card or in a lane: the board's words and badge tones. */
export function statusView(status: Status): {
  label: string;
  tone: "info" | "warning" | "accent" | "success";
} {
  switch (status) {
    case "open":
      return { label: "Sent", tone: "info" };
    case "working":
      return { label: "Agent working", tone: "warning" };
    case "fixed":
      return { label: "Fixed, check it", tone: "accent" };
    case "resolved":
      return { label: "Resolved", tone: "success" };
  }
}

// --- display --------------------------------------------------------------

/**
 * The one-line description a comment card or pin shows beside its badge —
 * board 05's "Play · 00:42.8 · hospital_wing" / "Scene · Player/Flashlight"
 * shape, generalised: what kind of thing this is, then the detail that tells
 * two comments of the same kind apart.
 */
export function anchorLabel(anchor: Anchor): string {
  switch (anchor.kind) {
    case "node":
      return `Node · ${anchor.path}`;
    case "mesh":
      return `${anchor.part} · ${anchor.material}`;
    case "scene":
      return anchor.scene
        ? `Play · ${formatPlayTime(anchor.time)} · ${anchor.scene}`
        : `Play · ${formatPlayTime(anchor.time)}`;
    case "take": {
      const where = anchor.nodePath ?? anchor.scene ?? "";
      const when = formatPlayTime(anchor.atMs / 1000);
      return `Note ${anchor.n} · ${when}${where ? ` · ${where}` : ""}`;
    }
  }
}

/**
 * Seconds as Play's footer and comment cards show a playhead: `mm:ss.s`, one
 * decimal place — `42.8` becomes `"00:42.8"`, matching board 05's `t=00:42.8`.
 * Negative input is clamped to zero; a playhead never runs backwards, and a
 * caller passing a bad value deserves `00:00.0` rather than a minus sign no
 * one asked to render.
 */
export function formatPlayTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}
