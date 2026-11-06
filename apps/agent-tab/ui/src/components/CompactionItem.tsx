import { strings } from "../strings";
import type { CompactionItemProps } from "./types";
import "./details.css";

/**
 * Where the agent compacted the conversation: a rule across the transcript
 * with a label, shimmering while it runs. What it kept folds out under it.
 */
export function CompactionItem({ status, summary, error }: CompactionItemProps) {
  const live = status === "inProgress";
  const label = (
    <>
      <span className="at-compaction__line" aria-hidden="true" />
      <span className="at-shimmer" data-live={live ? "" : undefined}>
        {strings.compaction[status] ?? strings.compaction.completed}
      </span>
      <span className="at-compaction__line" aria-hidden="true" />
    </>
  );
  return (
    <div className="at-item at-compaction" data-status={status}>
      {summary ? (
        <details>
          <summary className="at-compaction__rule at-disclosure">{label}</summary>
          <div className="at-compaction__summary">
            <div className="at-item__label">{strings.compaction.summary}</div>
            {summary}
          </div>
        </details>
      ) : (
        <div className="at-compaction__rule">{label}</div>
      )}
      {error && <div className="at-compaction__error">{error}</div>}
    </div>
  );
}
