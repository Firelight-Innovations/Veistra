import { SquarePen, History, MessageSquare, PanelRight, Info } from "lucide-react";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { HeaderProps } from "./types";
import "./frame.css";

/**
 * Quiet conversation actions stay available before a first prompt, including
 * saved sessions across harnesses. State changes are announced to screen readers.
 */
export function Header({
  state,
  onNewSession,
  onHistory,
  onSideChat,
  onAgents,
  onDetails,
  detailsOpen = false,
  history,
}: HeaderProps) {
  const S = useSlots();
  return (
    <header className="at-header" data-empty={state === null ? "" : undefined}>
      <span className="at-header__status">
        <S.StatusBadge state={state} />
      </span>
      {onSideChat && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={strings.btw.open}
          title={strings.btw.open}
          onClick={onSideChat}
        >
          <MessageSquare size={15} />
        </button>
      )}
      {onHistory && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={strings.history.title}
          aria-expanded={!!history}
          title={strings.history.title}
          onClick={onHistory}
        >
          <History size={15} />
        </button>
      )}
      {
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={strings.newSession}
          title={strings.newSessionHint}
          onClick={onNewSession}
        >
          <SquarePen size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      }
      {onDetails && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={detailsOpen ? strings.details.close : strings.details.open}
          aria-pressed={detailsOpen}
          title={detailsOpen ? strings.details.close : strings.details.open}
          onClick={onDetails}
        >
          <Info size={15} aria-hidden="true" />
        </button>
      )}
      {onAgents && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={strings.agentsList}
          title={strings.agentsList}
          onClick={onAgents}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
      )}
      {history}
    </header>
  );
}
