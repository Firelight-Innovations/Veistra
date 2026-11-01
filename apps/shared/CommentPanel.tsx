import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { anchorLabel, isActive, statusView, type Comment, type Verdict } from "./comments";
import { SendButton, SendFooter } from "./SendFooter";
import "./comment-panel.css";

/**
 * The comment list every viewer shows — board 05's Comments aside, reused
 * across the Godot Viewer, the Blender Viewer and Play rather than redrawn
 * three times. What differs between the three call sites is how a comment
 * gets *created* (a node click, a mesh-part click, Play's Capture & comment),
 * which is why this component takes comments rather than building them: each
 * app owns its own composer and calls {@link import("./comments").createComment}
 * itself, then re-lists.
 */
export interface CommentPanelProps {
  comments: Comment[];
  loading: boolean;
  error: string | null;
  onResolve: (id: string, note: string) => void | Promise<void>;
  /**
   * Looks good or Still broken on a comment an agent marked fixed. Without
   * it a fixed comment can only be resolved with a note, like an open one.
   */
  onVerdict?: (id: string, verdict: Verdict, reply?: string) => void | Promise<void>;
  /** What to say when there is nothing to show — each viewer's own honest
   *  empty-state sentence, per the workstream brief's "never leave a dead
   *  button, never fake data" rule. */
  emptyHint: string;
}

export function CommentPanel({
  comments,
  loading,
  error,
  onResolve,
  onVerdict,
  emptyHint,
}: CommentPanelProps) {
  // Fixed first: those wait on the person reading this.
  const rank = (c: Comment) => (c.status === "fixed" ? 0 : 1);
  const open = comments
    .filter((c) => c.status !== "resolved")
    .sort((a, b) => rank(a) - rank(b) || b.created - a.created);
  const resolved = comments
    .filter((c) => c.status === "resolved")
    .sort((a, b) => b.created - a.created);

  return (
    <div className="k-comment-panel">
      <div className="k-comment-panel__header">
        <span className="k-comment-panel__title">Comments</span>
        {!loading && !error && (
          <span className="k-comment-panel__count">
            {open.length} open · {resolved.length} resolved
          </span>
        )}
      </div>

      <div className="k-comment-panel__body">
        {loading && <p className="k-comment-panel__hint">Loading comments…</p>}
        {error && <p className="k-comment-panel__hint k-comment-panel__hint--error">{error}</p>}
        {!loading && !error && comments.length === 0 && (
          <p className="k-comment-panel__hint">{emptyHint}</p>
        )}
        {!loading &&
          !error &&
          [...open, ...resolved].map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              onResolve={onResolve}
              onVerdict={onVerdict}
            />
          ))}
      </div>

      <p className="k-comment-panel__footer-note">
        Comments are files in <code>.veistra/comments/</code>, inside this environment.
      </p>
      <SendFooter>
        <SendButton
          label="Send to agent now"
          disabled
          title="Nothing reads .veistra/comments/ into an agent yet — this button has nothing to nudge."
        />
      </SendFooter>
    </div>
  );
}

function CommentCard({
  comment,
  onResolve,
  onVerdict,
}: {
  comment: Comment;
  onResolve: (id: string, note: string) => void | Promise<void>;
  onVerdict?: (id: string, verdict: Verdict, reply?: string) => void | Promise<void>;
}) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onResolve(comment.id, note.trim() || "Resolved.");
      setResolving(false);
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  const verdict = async (v: Verdict) => {
    if (!onVerdict) return;
    setBusy(true);
    try {
      await onVerdict(comment.id, v, v === "broken" ? note.trim() || undefined : undefined);
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  // A viewer comment's open state reads "Open" here; "Sent" is Play's word
  // for a note that went out in a packet.
  const view = statusView(comment.status);
  const label = comment.status === "open" ? "Open" : view.label;
  const fixedByAgent = comment.status === "fixed" && comment.resolution;

  return (
    <div className={`k-comment-card k-comment-card--${comment.status}`}>
      <div className="k-comment-card__meta">
        <span className="k-comment-card__anchor">{anchorLabel(comment.anchor)}</span>
        <span className={`k-badge k-badge--${view.tone}`}>
          <span className="k-badge__dot" aria-hidden="true" />
          {label}
        </span>
      </div>
      <p className="k-comment-card__body">{comment.body}</p>

      {(comment.replies ?? []).map((r) => (
        <p key={r.at} className="k-comment-card__reply">
          <strong>{r.by === "agent" ? "Agent" : "You"}:</strong> {r.body}
        </p>
      ))}

      {(comment.status === "resolved" || fixedByAgent) && comment.resolution && (
        <p className="k-comment-card__resolution">
          <CircleCheck size={12} strokeWidth={1.5} aria-hidden="true" />
          {comment.resolution.note}
          {comment.resolution.commit ? ` (${comment.resolution.commit})` : ""}
        </p>
      )}

      {fixedByAgent && onVerdict && (
        <div className="k-comment-card__resolve-form">
          <textarea
            className="k-comment-card__resolve-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="If it is still broken, say what you saw"
            rows={2}
          />
          <div className="k-comment-card__resolve-actions">
            <button type="button" onClick={() => void verdict("broken")} disabled={busy}>
              Still broken
            </button>
            <button
              type="button"
              className="k-comment-card__resolve-confirm"
              onClick={() => void verdict("good")}
              disabled={busy}
            >
              Looks good
            </button>
          </div>
        </div>
      )}

      {(isActive(comment.status) || (comment.status === "fixed" && !onVerdict)) && !resolving && (
        <button
          type="button"
          className="k-comment-card__resolve"
          onClick={() => setResolving(true)}
        >
          Resolve with a note
        </button>
      )}

      {(isActive(comment.status) || (comment.status === "fixed" && !onVerdict)) && resolving && (
        <div className="k-comment-card__resolve-form">
          <textarea
            className="k-comment-card__resolve-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed?"
            rows={2}
            autoFocus
          />
          <div className="k-comment-card__resolve-actions">
            <button type="button" onClick={() => setResolving(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="k-comment-card__resolve-confirm"
              onClick={submit}
              disabled={busy}
            >
              {busy ? "Resolving…" : "Resolve"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
