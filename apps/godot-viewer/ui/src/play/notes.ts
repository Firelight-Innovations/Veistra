/**
 * The notes on a take, as the review page edits them (design §8.3) and as
 * `notes.json` keeps them while they are drafts. The page owns this shape;
 * `takes.rs` only checks it has a `notes` array, and Send stamps each note it
 * files with `commentId`, which is what makes a note sent rather than a draft.
 *
 * A note's number `n` is stable and never reused, the same rule as markup
 * pins: deleting note 2 leaves the next note as 3, so "note 2" means one thing
 * in every packet and every message about it.
 */
import type { MarkupJson } from "@veistra/markup";
import type { Comment, Status, TakeRef } from "../../../../shared/comments";

/** What a note is about: picked live by ray, or found in the take's recorded boxes. */
export interface Target {
  nodePath: string;
  type?: string;
  worldPoint?: number[] | null;
  script?: string;
  source: "pick" | "recorded";
}

export interface NoteDraft {
  n: number;
  kind: "frame" | "range";
  atMs: number;
  inMs?: number;
  outMs?: number;
  body: string;
  target?: Target | null;
  markup?: MarkupJson | null;
  /** The frame with its ink, base64 PNG, kept so a reload shows it again. */
  markupPng?: string | null;
  doneWhen?: string;
  /** The mark this note was made from, wall-clock-free: take milliseconds. */
  fromMark?: number;
  /** Set by Send: the comment this note became, and its packet. */
  commentId?: string;
  packet?: string;
  /**
   * On a Still broken take's draft (#321): the take note, a comment id, this
   * take was recorded to check. Send adds the take to that comment rather than
   * filing a new one, so `commentId` becomes the same id.
   */
  followUp?: string;
}

export interface NotesDoc {
  version: 1;
  notes: NoteDraft[];
  /** The next number a note gets; never goes down. */
  nextN: number;
  /** Marks the person dismissed, in take milliseconds. */
  dismissed: number[];
}

export function emptyDoc(): NotesDoc {
  return { version: 1, notes: [], nextN: 1, dismissed: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Whatever `notes.json` held, as a document; anything unreadable is left out. */
export function normalize(raw: unknown): NotesDoc {
  if (!isRecord(raw)) return emptyDoc();
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).filter(
    (n): n is NoteDraft => isRecord(n) && typeof n.n === "number" && typeof n.atMs === "number",
  );
  const highest = notes.reduce((m, n) => Math.max(m, n.n), 0);
  const next = typeof raw.nextN === "number" ? raw.nextN : 1;
  const dismissed = Array.isArray(raw.dismissed)
    ? raw.dismissed.filter((d): d is number => typeof d === "number")
    : [];
  return {
    version: 1,
    notes: notes.map((n) => ({ ...n, body: typeof n.body === "string" ? n.body : "" })),
    nextN: Math.max(next, highest + 1),
    dismissed,
  };
}

/** A range being set with I and O, either end still missing. */
export interface PendingRange {
  inMs: number | null;
  outMs: number | null;
}

export const NO_RANGE: PendingRange = { inMs: null, outMs: null };

/**
 * I at `ms`, from the key or the In button alike. An end at or before the
 * new start is let go, so the range is never backwards.
 */
export function withIn(range: PendingRange, ms: number): PendingRange {
  return { inMs: ms, outMs: range.outMs !== null && range.outMs > ms ? range.outMs : null };
}

/** O at `ms`; a start at or after it is let go. */
export function withOut(range: PendingRange, ms: number): PendingRange {
  return { inMs: range.inMs !== null && range.inMs < ms ? range.inMs : null, outMs: ms };
}

/** The range a new note covers: both ends set, in order. */
export function settledRange(range: PendingRange): { inMs: number; outMs: number } | null {
  const { inMs, outMs } = range;
  return inMs !== null && outMs !== null && outMs > inMs ? { inMs, outMs } : null;
}

/** A new note at `atMs`, over `range` when one is set. */
export function addNote(
  doc: NotesDoc,
  atMs: number,
  range?: { inMs: number; outMs: number } | null,
  extra: Partial<NoteDraft> = {},
): { doc: NotesDoc; note: NoteDraft } {
  const ranged = range && range.outMs > range.inMs;
  const note: NoteDraft = {
    n: doc.nextN,
    kind: ranged ? "range" : "frame",
    atMs: Math.round(atMs),
    ...(ranged ? { inMs: Math.round(range.inMs), outMs: Math.round(range.outMs) } : {}),
    body: "",
    ...extra,
  };
  return { doc: { ...doc, notes: [...doc.notes, note], nextN: doc.nextN + 1 }, note };
}

export function updateNote(doc: NotesDoc, n: number, patch: Partial<NoteDraft>): NotesDoc {
  return { ...doc, notes: doc.notes.map((note) => (note.n === n ? { ...note, ...patch } : note)) };
}

/** Delete a draft. A sent note is a comment now and stays. Its number stays retired. */
export function removeNote(doc: NotesDoc, n: number): NotesDoc {
  return { ...doc, notes: doc.notes.filter((note) => note.n !== n || note.commentId) };
}

export function dismissMark(doc: NotesDoc, ms: number): NotesDoc {
  return doc.dismissed.includes(ms) ? doc : { ...doc, dismissed: [...doc.dismissed, ms] };
}

export function isDraft(note: NoteDraft): boolean {
  return !note.commentId;
}

/**
 * Send's stamps on the page's copy, the same ones `play/send` writes into
 * `notes.json`: each sent note's comment, and the packet it went in. Notes Send
 * did not file, and edits made while it ran, are left as they are.
 */
export function markSent(
  doc: NotesDoc,
  comments: readonly (readonly [number, string])[],
  packet: string,
): NotesDoc {
  const ids = new Map(comments);
  return {
    ...doc,
    notes: doc.notes.map((note) => {
      const commentId = ids.get(note.n);
      return commentId ? { ...note, commentId, packet } : note;
    }),
  };
}

/**
 * The one line Send leaves at the agent's prompt (X8), around the packet's
 * reference: "Playtest feedback: 2 notes. Read <packet>/packet.md first."
 * Veistra never presses Enter; the person reads it and sends it.
 */
export function packetMessage(count: number, stillBroken = 0): { before: string; after: string } {
  const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  const before =
    stillBroken === 0
      ? `Playtest feedback: ${notes(count)}. Read `
      : stillBroken >= count
        ? `Still broken after your fix: ${notes(count)}. Read `
        : `Playtest feedback: ${notes(count)}, ${stillBroken} still broken after your fix. Read `;
  return { before, after: " first." };
}

/** Drafts with words: what Send sends. */
export function sendable(doc: NotesDoc): NoteDraft[] {
  return doc.notes.filter((n) => isDraft(n) && n.body.trim() !== "");
}

/** Marks still waiting to be made a note or dismissed. */
export function pendingMarks(marks: readonly number[], doc: NotesDoc): number[] {
  const made = new Set(doc.notes.map((n) => n.fromMark).filter((m) => m !== undefined));
  return marks.filter((m) => !made.has(m) && !doc.dismissed.includes(m));
}

/** One line of a take's `log.jsonl`. */
export interface LogRow {
  t: number;
  /** Take milliseconds. */
  ms: number;
  level: "info" | "warning" | "error";
  stream: string;
  text: string;
}

export function parseLog(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRecord(v) && typeof v.ms === "number" && typeof v.text === "string") {
        const level = v.level === "error" || v.level === "warning" ? v.level : "info";
        rows.push({
          t: typeof v.t === "number" ? v.t : 0,
          ms: v.ms,
          level,
          stream: typeof v.stream === "string" ? v.stream : "",
          text: v.text,
        });
      }
    } catch {
      // A torn line is skipped, never an error: the file is the game's output.
    }
  }
  return rows;
}

/**
 * What a note's chip says about the lines near it, `1 error · 2 warnings`,
 * since Send attaches both; `null` when there are none.
 */
export function nearWords(rows: readonly LogRow[]): string | null {
  const errors = rows.filter((r) => r.level === "error").length;
  const warnings = rows.length - errors;
  const words = [
    errors > 0 ? `${errors} ${errors === 1 ? "error" : "errors"}` : "",
    warnings > 0 ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : "",
  ].filter(Boolean);
  return words.length > 0 ? words.join(" · ") : null;
}

/** Errors and warnings within `windowMs` of the span `fromMs` to `toMs`. */
export function errorsNear(
  log: readonly LogRow[],
  fromMs: number,
  toMs: number,
  windowMs: number,
): LogRow[] {
  return log.filter(
    (r) => r.level !== "info" && r.ms >= fromMs - windowMs && r.ms <= toMs + windowMs,
  );
}

/** A note's span, its range or the moment itself. */
export function span(note: Pick<NoteDraft, "atMs" | "inMs" | "outMs">): [number, number] {
  return [
    Math.min(note.inMs ?? note.atMs, note.atMs),
    Math.max(note.outMs ?? note.atMs, note.atMs),
  ];
}

/** A note's place in the loop: a draft, or its comment's status. */
export function noteStatus(note: NoteDraft, comments: readonly Comment[]): Status | "draft" {
  if (!note.commentId) return "draft";
  return comments.find((c) => c.id === note.commentId)?.status ?? "open";
}

export function commentOf(note: NoteDraft, comments: readonly Comment[]): Comment | undefined {
  return note.commentId ? comments.find((c) => c.id === note.commentId) : undefined;
}

/** "note 2 of Take 4", or "note 2" for a note sent before takes kept their number. */
export function noteName(ref: Pick<TakeRef, "n" | "number">): string {
  return `note ${ref.n}${ref.number !== undefined ? ` of Take ${ref.number}` : ""}`;
}

/**
 * The take note a Still broken draft checks, before Send and after it (when
 * it is `commentOf` too). `play/notes` lists it with the take, so it is found.
 */
export function checkedOf(note: NoteDraft, comments: readonly Comment[]): Comment | undefined {
  return note.followUp ? comments.find((c) => c.id === note.followUp) : undefined;
}
