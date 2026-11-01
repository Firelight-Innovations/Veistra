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
import type { Comment, Status } from "../../../shared/comments";

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
