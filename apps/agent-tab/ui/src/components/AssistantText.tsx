import type { AssistantTextProps } from "./types";
import "./items.css";

/**
 * The agent's reply. `html` is already sanitised, and its code blocks carry
 * the `data-copy` buttons the handlers answer, so a replacement keeps both
 * handlers on the element that holds the HTML.
 */
export function AssistantText({ html, onClick, onAuxClick, streaming }: AssistantTextProps) {
  return (
    <div
      className="at-item at-assistant"
      data-streaming={streaming ? "" : undefined}
      onClick={onClick}
      onAuxClick={onAuxClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
