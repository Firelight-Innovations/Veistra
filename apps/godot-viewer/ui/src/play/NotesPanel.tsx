/**
 * The Notes side of review (the PlayReview and AgentHandoff boards): one card
 * per note, the marks not yet made notes, and Send with its SEND TO picker.
 *
 * A card reads its status from the comment Send filed: Draft until then, then
 * Sent, Agent working, Fixed (with the agent's summary, Play the scene, Looks
 * good and Still broken), and Resolved, folded at the bottom. A mark close to
 * an error shows that line, because the error is the first lead for a note.
 * SEND TO lists `context/agents`, the default first (X8); Review keeps the
 * choice, because Ctrl Enter sends to it too.
 */
import { useState } from "react";
import type { Comment, Status, Verdict } from "../../../../shared/comments";
import { statusView } from "../../../../shared/comments";
import type { AgentTarget } from "../../../../shared/context";
import { clock } from "./frames";
import {
  commentOf,
  errorsNear,
  nearWords,
  noteStatus,
  span,
  type LogRow,
  type NoteDraft,
} from "./notes";

/** Errors this close to a mark are shown on it (design §6). */
const MARK_ERROR_MS = 2_000;
/** Errors this close to a note count as near it (design §8.3.4). */
const NOTE_ERROR_MS = 10_000;

export interface SendOptions {
  contact: boolean;
  /** "Video clip per note": off unless ticked (X12). */
  clip: boolean;
}

/** One agent's key in the picker: its kind and id, which together are unique. */
export const agentKey = (a: AgentTarget) => `${a.kind}:${a.id}`;

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
  /** Who Send can go to, the default first, and who it goes to; null with none running. */
  agents: AgentTarget[];
  agent: AgentTarget | null;
  onAgent: (agent: AgentTarget) => void;
  /** Why a clip cannot be cut on this machine, or null when it can. */
  clipUnavailable: string | null;
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
  /** The errors and warnings within 10 s, which Send attaches to the note. */
  near: LogRow[];
  selected: boolean;
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
  const near = nearWords(props.near);
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
        {near && (
          <span
            className="pl-chip pl-chip--danger"
            title={props.near.map((r) => `${clock(r.ms)} ${r.text}`).join("\n")}
          >
            {near} near
          </span>
        )}
      </div>
      {draft && selected && (
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
              title={`Run the game in ${scene ?? "the scene it ran"} with Record on`}
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
        near={errorsNear(props.log, from, to, NOTE_ERROR_MS)}
        selected={props.selected === r.note.n}
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
        <span className="pl-notes__label" aria-hidden="true">
          SEND TO
        </span>
        <select
          className="pl-notes__to"
          aria-label="Send to"
          value={props.agent ? agentKey(props.agent) : ""}
          disabled={props.agents.length === 0}
          title={
            props.agents.length === 0
              ? "Start an agent in a terminal or an agent tab here to send to it. The packet is still written."
              : "The one agent the packet's line is left for. Nothing is sent until you press Enter there."
          }
          onChange={(e) => {
            const picked = props.agents.find((a) => agentKey(a) === e.target.value);
            if (picked) props.onAgent(picked);
          }}
        >
          {props.agents.length === 0 ? (
            <option value="">No agent running here</option>
          ) : (
            props.agents.map((a) => (
              <option key={agentKey(a)} value={agentKey(a)}>
                {a.label}
              </option>
            ))
          )}
        </select>
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
        <label
          title={
            props.clipUnavailable ??
            "An MP4 of each note, two seconds either side, for a person to watch. The agent reads the contact sheet."
          }
        >
          <input
            type="checkbox"
            disabled={props.clipUnavailable !== null}
            checked={options.clip && props.clipUnavailable === null}
            onChange={(e) => props.onOptions({ ...options, clip: e.target.checked })}
          />
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
