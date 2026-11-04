/**
 * The Notes side of review (the PlayReview and AgentHandoff boards): one card
 * per note, the marks not yet made notes, and Send.
 *
 * A card reads its status from the comment Send filed: Draft until then, then
 * Sent, Agent working, Fixed (with the agent's summary, Play the scene, Looks
 * good and Still broken), and Resolved, folded at the bottom. A mark close to
 * an error shows that line, because the error is the first lead for a note.
 */
import { useState } from "react";
import type { Comment, Status, Verdict } from "../../../../shared/comments";
import { statusView } from "../../../../shared/comments";
import { clock } from "./frames";
import { commentOf, errorsNear, noteStatus, span, type LogRow, type NoteDraft } from "./notes";

/** Errors this close to a mark are shown on it (design §6). */
const MARK_ERROR_MS = 2_000;
/** Errors this close to a note count as near it (design §8.3.4). */
const NOTE_ERROR_MS = 10_000;

export interface SendOptions {
  contact: boolean;
}

export interface NotesPanelProps {
  notes: NoteDraft[];
  comments: Comment[];
  log: LogRow[];
  pendingMarks: number[];
  selected: number | null;
  sending: boolean;
  readOnly: boolean;
  /** Kept by Review, because Ctrl Enter sends with them too. */
  options: SendOptions;
  onOptions: (options: SendOptions) => void;
  onSelect: (n: number) => void;
  onChange: (n: number, patch: Partial<NoteDraft>) => void;
  onDelete: (n: number) => void;
  onDone: () => void;
  onMakeNote: (ms: number) => void;
  onDismiss: (ms: number) => void;
  onVerdict: (comment: string, verdict: Verdict, reply?: string) => void;
  onPlayScene: (scene: string | undefined) => void;
  onSend: () => void;
}

function when(note: NoteDraft): string {
  const [from, to] = span(note);
  return note.kind === "range" && to > from
    ? `${clock(from)} → ${clock(to)} · ${Math.round((to - from) / 1000)} s clip`
    : `${clock(note.atMs)} · frame`;
}

function StatusWord({ status }: { status: Status | "draft" }) {
  if (status === "draft") return <span className="pl-note__draft">Draft</span>;
  const view = statusView(status);
  return (
    <span className={`k-badge k-badge--${view.tone}`}>
      <span className="k-badge__dot" aria-hidden="true" />
      {view.label}
    </span>
  );
}

function NoteCard(props: {
  note: NoteDraft;
  comment: Comment | undefined;
  status: Status | "draft";
  near: number;
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<NoteDraft>) => void;
  onDelete: () => void;
  onDone: () => void;
  onVerdict: (verdict: Verdict, reply?: string) => void;
  onPlayScene: () => void;
}) {
  const { note, comment, status, selected } = props;
  const [reply, setReply] = useState("");
  const draft = status === "draft";
  const scene = comment?.anchor.kind === "take" ? comment.anchor.scene : undefined;
  return (
    <div
      className={`pl-note${selected ? " pl-note--selected" : ""} pl-note--${status}`}
      aria-label={`Note ${note.n}`}
    >
      <button
        type="button"
        className="pl-note__head"
        onClick={props.onSelect}
        aria-pressed={selected}
      >
        <span className="pl-note__n">{note.n}</span>
        <span className="pl-note__when">{when(note)}</span>
        <span className="pl-note__spacer" />
        <StatusWord status={status} />
      </button>
      {draft && selected ? (
        <>
          <label className="pl-sr" htmlFor={`note-${note.n}`}>
            Note {note.n}
          </label>
          <textarea
            id={`note-${note.n}`}
            className="pl-note__body-input"
            rows={3}
            value={note.body}
            placeholder="What is wrong here, and what should happen instead?"
            onChange={(e) => props.onChange({ body: e.target.value })}
            autoFocus
          />
          <input
            className="pl-note__done-when"
            aria-label={`Done when, for note ${note.n}`}
            placeholder="Done when (optional): a test passes, or what you will check"
            value={note.doneWhen ?? ""}
            onChange={(e) => props.onChange({ doneWhen: e.target.value })}
          />
        </>
      ) : (
        <p className="pl-note__body">{note.body || <em>No words yet.</em>}</p>
      )}
      <div className="pl-note__chips">
        {note.target && (
          <span
            className="pl-chip"
            title={
              note.target.source === "pick"
                ? "Picked in the running game"
                : "Picked from the take's recorded scene data"
            }
          >
            {note.target.nodePath}
            {note.target.type ? ` · ${note.target.type}` : ""}
          </span>
        )}
        {note.markupPng && <span className="pl-chip">marked up</span>}
        {props.near > 0 && (
          <span className="pl-chip pl-chip--danger">
            {props.near} {props.near === 1 ? "error" : "errors"} near
          </span>
        )}
      </div>
      {draft && selected && !props.readOnly && (
        <div className="pl-note__actions">
          <button type="button" className="k-btn k-btn--ghost k-btn--sm" onClick={props.onDelete}>
            Delete
          </button>
          <button type="button" className="k-btn k-btn--secondary k-btn--sm" onClick={props.onDone}>
            Done
          </button>
        </div>
      )}
      {comment && (comment.replies ?? []).length > 0 && (
        <div className="pl-note__thread">
          {(comment.replies ?? []).map((r) => (
            <p key={r.at}>
              <strong>{r.by === "agent" ? "Agent" : "You"}:</strong> {r.body}
            </p>
          ))}
        </div>
      )}
      {comment && status === "fixed" && comment.resolution && (
        <div className="pl-note__fix">
          <span className="pl-note__fix-by">AGENT</span>
          <p>{comment.resolution.note}</p>
          {comment.resolution.commit && (
            <code className="pl-note__commit">commit {comment.resolution.commit}</code>
          )}
          <input
            aria-label={`What is still broken, for note ${note.n}`}
            placeholder="If it is still broken, say what you saw"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="pl-note__actions">
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              onClick={props.onPlayScene}
            >
              Play {scene ? scene.slice(scene.lastIndexOf("/") + 1) : "again"}
            </button>
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              onClick={() => props.onVerdict("good")}
            >
              Looks good
            </button>
            <button
              type="button"
              className="k-btn k-btn--ghost k-btn--sm pl-note__broken"
              onClick={() => {
                props.onVerdict("broken", reply.trim() || undefined);
                setReply("");
              }}
            >
              Still broken
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function NotesPanel(props: NotesPanelProps) {
  const { options } = props;
  const [showResolved, setShowResolved] = useState(false);
  const rows = props.notes.map((note) => ({
    note,
    status: noteStatus(note, props.comments),
    comment: commentOf(note, props.comments),
  }));
  const open = rows.filter((r) => r.status !== "resolved");
  const resolved = rows.filter((r) => r.status === "resolved");
  const drafts = rows.filter((r) => r.status === "draft" && r.note.body.trim() !== "");
  const card = (r: (typeof rows)[number]) => {
    const [from, to] = span(r.note);
    return (
      <NoteCard
        key={r.note.n}
        note={r.note}
        comment={r.comment}
        status={r.status}
        near={errorsNear(props.log, from, to, NOTE_ERROR_MS).length}
        selected={props.selected === r.note.n}
        readOnly={props.readOnly}
        onSelect={() => props.onSelect(r.note.n)}
        onChange={(patch) => props.onChange(r.note.n, patch)}
        onDelete={() => props.onDelete(r.note.n)}
        onDone={props.onDone}
        onVerdict={(v, reply) => r.comment && props.onVerdict(r.comment.id, v, reply)}
        onPlayScene={() =>
          props.onPlayScene(r.comment?.anchor.kind === "take" ? r.comment.anchor.scene : undefined)
        }
      />
    );
  };

  return (
    <aside className="pl-notes" aria-label="Notes on this take">
      <div className="pl-notes__head">
        <h2>Notes</h2>
        <span>
          {props.notes.length} {props.notes.length === 1 ? "note" : "notes"}
          {props.pendingMarks.length > 0 &&
            ` · ${props.pendingMarks.length} ${props.pendingMarks.length === 1 ? "mark" : "marks"} left`}
        </span>
      </div>
      <div className="pl-notes__list">
        {props.notes.length === 0 && props.pendingMarks.length === 0 && (
          <p className="pl-hint">
            No notes yet. Pause where something is wrong and press N, or set a range with I and O.
          </p>
        )}
        {open.map(card)}
        {props.pendingMarks.map((ms) => {
          const error = errorsNear(props.log, ms, ms, MARK_ERROR_MS).find(
            (r) => r.level === "error",
          );
          return (
            <div key={ms} className="pl-mark-card">
              <span className="pl-note__when">{clock(ms)} · your mark</span>
              {error && (
                <span className="pl-mark-card__error">
                  An error printed at the same moment: <code>{error.text}</code>
                </span>
              )}
              <span className="pl-note__actions">
                <button
                  type="button"
                  className="k-btn k-btn--secondary k-btn--sm"
                  onClick={() => props.onMakeNote(ms)}
                >
                  Make a note
                </button>
                <button
                  type="button"
                  className="k-btn k-btn--ghost k-btn--sm"
                  onClick={() => props.onDismiss(ms)}
                >
                  Dismiss
                </button>
              </span>
            </div>
          );
        })}
        {resolved.length > 0 && (
          <button
            type="button"
            className="pl-notes__folded"
            onClick={() => setShowResolved((v) => !v)}
          >
            {resolved.length} resolved
          </button>
        )}
        {showResolved && resolved.map(card)}
      </div>
      <div className="pl-notes__send">
        <span className="pl-notes__label">SEND TO</span>
        <span className="pl-notes__to">The agent in this environment</span>
        <label>
          <input
            type="checkbox"
            checked={options.contact}
            onChange={(e) => props.onOptions({ ...options, contact: e.target.checked })}
          />
          Contact sheet per note, 1 frame a second
        </label>
        <span className="pl-notes__always">
          Log and scene data around each note always go: they are what the agent works from.
        </span>
        <label title="Not built yet: a clip needs encoding in the page, and the agent reads the contact sheet instead.">
          <input type="checkbox" disabled checked={false} onChange={() => undefined} />
          Video clip per note, for people
        </label>
        <button
          type="button"
          className="k-btn k-btn--primary pl-notes__send-btn"
          disabled={drafts.length === 0 || props.sending || props.readOnly}
          title={
            props.readOnly
              ? "This is the main checkout, which is read-only; open a worktree to send notes."
              : "Write the feedback packet and tell the agent (Ctrl Enter)"
          }
          onClick={props.onSend}
        >
          {props.sending
            ? "Sending…"
            : `Send ${drafts.length} ${drafts.length === 1 ? "note" : "notes"}`}
        </button>
      </div>
    </aside>
  );
}
