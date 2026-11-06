import { strings } from "../strings";
import type { ThinkingProps } from "./types";
import "./items.css";

/**
 * The agent's reasoning, folded. While the agent is still thinking its label
 * shimmers and the line it is writing shows under it, so the wait reads as
 * work in progress without unfolding the whole of it.
 */
export function Thinking({ text, live = false }: ThinkingProps) {
  const latest = live ? lastLine(text) : "";
  return (
    <details className="at-item at-reasoning">
      <summary className="at-disclosure">
        <span className="at-shimmer" data-live={live ? "" : undefined}>
          {strings.thinking}
        </span>
        {latest && (
          <span key={latest} className="at-reasoning__latest" aria-hidden="true">
            {latest}
          </span>
        )}
      </summary>
      <div className="at-reasoning__text">{text}</div>
    </details>
  );
}

/** The last line with anything on it, which is the one being written. */
function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return (lines[lines.length - 1] ?? "").trim();
}
