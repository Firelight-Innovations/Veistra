import { Activity, Bot, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";
import { strings } from "../strings";
import type { TaskCardProps } from "./types";
import "./details.css";

/** A glyph per kind of task; anything else is drawn as an agent. */
const GLYPH: Record<string, LucideIcon> = {
  workflow: Workflow,
  shell: SquareTerminal,
  monitor: Activity,
};

/**
 * A background task, inline where the agent started it: what it is, where
 * it is and for how long, and a workflow's phase. Details opens the panel on
 * it; Stop asks the agent to stop it.
 */
export function TaskCard({
  anchor,
  name,
  type,
  taskType,
  state,
  description,
  summary,
  elapsed,
  phase,
  progress,
  onDetails,
  onStop,
  stopping,
}: TaskCardProps) {
  const Glyph = GLYPH[taskType] ?? Bot;
  const live = state === "running" || state === "paused";
  const line = summary ?? (description && description !== name ? description : null);
  return (
    <div className="at-item at-task" data-item={anchor} data-state={state}>
      <div className="at-task__head">
        <Glyph className="at-task__glyph" size={14} strokeWidth={2} aria-hidden="true" />
        <span className="at-task__name at-shimmer" data-live={live ? "" : undefined} title={name}>
          {name}
        </span>
        <span className="at-task__type">{type}</span>
        <span className="at-task__state">
          <span className="at-dot" data-state={state} aria-hidden="true" />
          {strings.task.state[state]}
        </span>
        {elapsed && <span className="at-task__time">{elapsed}</span>}
      </div>
      {(phase || progress) && (
        <div className="at-task__progress">
          {phase && <span className="at-task__phase">{phase}</span>}
          {progress && <span>{progress}</span>}
        </div>
      )}
      {line && <div className="at-task__line">{line}</div>}
      <div className="at-task__actions">
        <button type="button" className="k-btn k-btn--secondary k-btn--sm" onClick={onDetails}>
          {strings.task.details}
        </button>
        {onStop && (
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? strings.task.stopping : strings.task.stop}
          </button>
        )}
      </div>
    </div>
  );
}
