/**
 * The bottom bar every "Send to agent" action lives in. One height, one
 * surface, one button, one alignment, so a viewer's send actions read the same
 * wherever they are. The File Viewer set the pattern: a slim strip on the
 * region's own surface with a hairline above, sends on the left. Anything else
 * the app keeps down there (Comments, Open in Blender) goes in `trailing`,
 * pushed to the right of the sends.
 */
import { useCallback, useState, type PointerEvent, type ReactNode } from "react";
import { Send } from "lucide-react";
import { chipAllToAgent, type ContextRef } from "./context";
import "./send-footer.css";

/** How long a button says "Sent" before it goes back to its label. */
const SENT_MS = 1800;

export function SendFooter({
  children,
  trailing,
  className,
}: {
  /** The send buttons, left-aligned. */
  children?: ReactNode;
  /** Other footer content, right-aligned after the sends. */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`k-send-footer${className ? ` ${className}` : ""}`}>
      <div className="k-send-footer__actions">{children}</div>
      {trailing != null && <div className="k-send-footer__trailing">{trailing}</div>}
    </div>
  );
}

export function SendButton({
  label,
  sent = false,
  icon,
  compact = false,
  title,
  disabled,
  onClick,
  onPointerDown,
}: {
  label: string;
  /** Show "Sent" in place of the label. */
  sent?: boolean;
  /** Replaces the send arrow. Only used when `compact`. */
  icon?: ReactNode;
  /** Icon only: the label moves to the tooltip and the accessible name. */
  compact?: boolean;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const shown = sent ? "Sent" : label;
  const hint = title ? `${label}. ${title}` : label;
  return (
    <button
      type="button"
      className="k-btn k-btn--secondary k-btn--sm k-send-footer__btn"
      aria-label={compact ? shown : undefined}
      title={compact ? hint : title}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      {(compact && icon) || <Send size={13} strokeWidth={1.5} aria-hidden="true" />}
      {!compact && shown}
    </button>
  );
}

/** What a send's `put` answers: the item or items it stored, each of which becomes a chip. */
function storedItems(put: unknown): ContextRef[] {
  const isItem = (v: unknown): v is ContextRef =>
    typeof v === "object" && v !== null && typeof (v as ContextRef).id === "string";
  return (Array.isArray(put) ? put : [put]).filter(isItem);
}

/**
 * Every Send button's action: `put` stores the thing in the context store, and
 * each item it answers with becomes one chip on the prompt of the agent the
 * person last worked in ({@link chipAllToAgent}). Never a sentence: what the agent
 * is asked to do is the item's `prompt`. With the shared "Sent" flash and the
 * shared failure sentence; `id` says which button flashes, `what` is what a
 * message names ("the scene tree").
 */
export function useSendAction(
  onError: (message: string | null) => void,
  describeError: (err: unknown) => string,
) {
  const [sent, setSent] = useState<string | null>(null);
  const send = useCallback(
    async (id: string, what: string, put: () => Promise<unknown>) => {
      onError(null);
      try {
        const said = await chipAllToAgent(storedItems(await put()));
        if (!said.delivered) {
          onError(
            `${capital(what)} is in the Context strip, but no agent took it: ${said.reason}.`,
          );
          return;
        }
        setSent(id);
        setTimeout(() => setSent((s) => (s === id ? null : s)), SENT_MS);
      } catch (err) {
        onError(`Couldn't send ${what} to the agent: ${describeError(err)}`);
      }
    },
    [onError, describeError],
  );
  return { sent, send };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
