/**
 * A feedback prompt: a small card in the bottom-right corner, above the status
 * bar.
 *
 * Deliberately not a dialog. It takes no focus, traps nothing and dims
 * nothing, so it can arrive while somebody is typing without the next
 * keystroke landing in it — the pipeline already waited for a quiet moment,
 * and this is the second half of that courtesy. Escape is not bound for the
 * same reason: whatever has focus owns Escape, and it is not this.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { popover } from "../motion";
import { UNMASK_ATTRIBUTE } from "../telemetry/analytics";
import { answerPrompt, dismissPrompt } from "../telemetry/pipeline";
import type { PromptRef } from "../telemetry/registry";
import "./feedback.css";

const SCALE = [1, 2, 3, 4, 5] as const;

export interface PromptCardProps {
  prompt: PromptRef;
  /** "Don't ask me again": switches the prompts setting off. */
  onStopAsking: () => void;
}

export default function PromptCard({ prompt, onStopAsking }: PromptCardProps) {
  const rating = (prompt.prompt.kind ?? "rating") === "rating";
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A rating prompt asks for the number first and offers the comment after;
  // a text prompt is the comment alone.
  const ready = rating ? score !== null : comment.trim() !== "";

  const send = () => {
    setSending(true);
    setError(null);
    answerPrompt(prompt, { rating: score ?? undefined, message: comment }).catch((err: unknown) => {
      setSending(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <motion.section
      className="feedback__card"
      role="dialog"
      aria-modal="false"
      aria-label="Feedback"
      variants={popover}
      initial="initial"
      animate="animate"
      exit="exit"
      {...{ [UNMASK_ATTRIBUTE]: "" }}
    >
      <header className="feedback__card-head">
        <h2 className="feedback__question">{prompt.prompt.question}</h2>
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon k-btn--sm"
          aria-label="Not now"
          title="Not now"
          onClick={() => dismissPrompt(prompt)}
        >
          <X size={14} />
        </button>
      </header>
      {rating && (
        <div className="feedback__scale" role="radiogroup" aria-label="Rating, 1 to 5">
          {SCALE.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={score === n}
              className="feedback__score"
              onClick={() => setScore(n)}
            >
              {n}
            </button>
          ))}
          <span className="feedback__anchor">Not well</span>
          <span className="feedback__anchor feedback__anchor--end">Very well</span>
        </div>
      )}
      {(!rating || score !== null) && (
        <textarea
          className="k-field__input feedback__comment"
          value={comment}
          placeholder={rating ? "Anything to add? (optional)" : "Your answer"}
          aria-label="Comment"
          onChange={(event) => setComment(event.target.value)}
        />
      )}
      {error && (
        <p className="feedback__error" role="alert">
          {error}
        </p>
      )}
      <footer className="feedback__card-foot">
        <button
          type="button"
          className="feedback__stop"
          onClick={() => {
            onStopAsking();
            dismissPrompt(prompt);
          }}
        >
          Don&apos;t ask me again
        </button>
        <button
          type="button"
          className="k-btn k-btn--primary k-btn--sm"
          disabled={!ready || sending}
          onClick={send}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </footer>
    </motion.section>
  );
}
