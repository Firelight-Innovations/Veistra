/**
 * The place to send feedback from: Help ▸ Send Feedback, the agent menu, the
 * settings section, and any app that asks with `veistra/feedback`.
 *
 * It says how the message will travel before Send is pressed (`Delivery`), and
 * a build that cannot send at all offers the issue tracker in its place rather
 * than a Send button that would fail.
 */
import { useState } from "react";
import { githubOpenInBrowser } from "../../bindings";
import { PRODUCT_NAME } from "../../branding.generated";
import Dialog from "./Dialog";
import { UNMASK_ATTRIBUTE } from "../telemetry/analytics";
import {
  MAX_MESSAGE,
  submitFeedback,
  type Delivery,
  type FeedbackKind,
} from "../telemetry/feedback";
import { FEATURES } from "../telemetry/features";
import type { FeedbackRequest } from "../telemetry/surface";
import "./feedback.css";

/** The same address as Help ▸ Report Issue. */
const ISSUES_URL = "https://github.com/Firelight-Innovations/Veistra/issues";

const KINDS: ReadonlyArray<{ id: FeedbackKind; label: string; placeholder: string }> = [
  { id: "problem", label: "Problem", placeholder: "What happened, and what did you expect?" },
  { id: "idea", label: "Idea", placeholder: "What would make this better?" },
  { id: "praise", label: "Praise", placeholder: "What is working well?" },
];

/** Everything a person can give feedback about; the system's own bookkeeping is not. */
const SUBJECTS = FEATURES.filter((feature) => feature.id !== "feedback");

const NOTES: Record<Delivery, string> = {
  "with-session": `Sends your message, ${PRODUCT_NAME}'s version and your OS, linked to this session's usage data.`,
  alone: `Usage data is off, so only this message, ${PRODUCT_NAME}'s version and your OS are sent.`,
  nowhere: "",
};

export interface FeedbackDialogProps {
  request: FeedbackRequest;
  delivery: Delivery;
  /** Why nothing can be sent, when `delivery` is `nowhere`. */
  blockedBecause: string | null;
  onClose: () => void;
}

export default function FeedbackDialog({
  request,
  delivery,
  blockedBecause,
  onClose,
}: FeedbackDialogProps) {
  const [kind, setKind] = useState<FeedbackKind>("problem");
  const [feature, setFeature] = useState(request.feature ?? "general");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"editing" | "sending" | "sent">("editing");
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    setState("sending");
    setError(null);
    submitFeedback({
      source: request.source,
      feature,
      kind,
      message,
      contact: contact || undefined,
    })
      .then(() => setState("sent"))
      .catch((err: unknown) => {
        setState("editing");
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const placeholder = KINDS.find((k) => k.id === kind)?.placeholder;

  return (
    <Dialog label="Send feedback" onCancel={onClose} className="feedback__dialog">
      <div className="feedback__unmask" {...{ [UNMASK_ATTRIBUTE]: "" }}>
        <div className="k-dialog__header">Send feedback</div>
        {state === "sent" ? (
          <>
            <div className="k-dialog__body feedback__body">
              <p>Thank you — it is on its way, and somebody will read it.</p>
            </div>
            <div className="k-dialog__footer">
              <button type="button" className="k-btn k-btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : delivery === "nowhere" ? (
          <>
            <div className="k-dialog__body feedback__body">
              <p>This build cannot send feedback directly. {blockedBecause}</p>
              <p>An issue on GitHub reaches the same people.</p>
            </div>
            <div className="k-dialog__footer">
              <button type="button" className="k-btn k-btn--secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="k-btn k-btn--primary"
                onClick={() => {
                  void githubOpenInBrowser(ISSUES_URL).catch((err: unknown) =>
                    console.error("veistra: could not open", ISSUES_URL, err),
                  );
                  onClose();
                }}
              >
                Open an issue…
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="k-dialog__body feedback__body">
              <div className="feedback__kinds" role="radiogroup" aria-label="Kind of feedback">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.id}
                    className="feedback__kind"
                    onClick={() => setKind(k.id)}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <label className="k-field">
                <span className="k-field__label">About</span>
                <select
                  className="k-field__input"
                  value={feature}
                  onChange={(event) => setFeature(event.target.value)}
                >
                  {SUBJECTS.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="k-field">
                <span className="k-field__label">Message</span>
                <textarea
                  className="k-field__input feedback__message"
                  value={message}
                  maxLength={MAX_MESSAGE}
                  placeholder={placeholder}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <label className="k-field">
                <span className="k-field__label">Email, if you would like a reply</span>
                <input
                  className="k-field__input"
                  type="email"
                  value={contact}
                  placeholder="Optional"
                  onChange={(event) => setContact(event.target.value)}
                />
              </label>
              <p className="feedback__fine">{NOTES[delivery]}</p>
              {error && (
                <p className="feedback__error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="k-dialog__footer">
              <button type="button" className="k-btn k-btn--secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="k-btn k-btn--primary"
                disabled={message.trim() === "" || state === "sending"}
                onClick={send}
              >
                {state === "sending" ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
