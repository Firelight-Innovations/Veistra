import { useSlots } from "./registry";
import type { SetupCardProps } from "./types";
import "./items.css";

/**
 * What a harness still needs before its first prompt, with the buttons that
 * do it: install it, get Node.js, sign in. While a step runs it says so and
 * offers nothing to press.
 */
export function SetupCard({ title, body, typed, detail, actions, busy }: SetupCardProps) {
  const S = useSlots();
  return (
    <div className="at-setup" role="status" aria-busy={busy}>
      <div className="at-setup__title">{title}</div>
      {body && <div className="at-setup__body">{body}</div>}
      {actions.length > 0 && (
        <div className="at-setup__actions">
          {actions.map((action, i) => (
            <button
              key={action.label}
              type="button"
              className={
                i === 0 ? "k-btn k-btn--primary k-btn--sm" : "k-btn k-btn--secondary k-btn--sm"
              }
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {typed && <S.Note text={typed} />}
      {detail && (
        <details className="at-setup__detail">
          <summary>{detail.label}</summary>
          <pre>{detail.text}</pre>
        </details>
      )}
    </div>
  );
}
