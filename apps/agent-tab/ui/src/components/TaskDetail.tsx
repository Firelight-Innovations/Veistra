import { ChevronLeft } from "lucide-react";
import { strings } from "../strings";
import type { TaskAgentRow, TaskDetailProps, TaskPhaseRow } from "./types";
import "./details.css";

/**
 * One background task, opened in the Details panel: its figures and, for a
 * workflow, each phase with its agents, then the phases still to come.
 */
export function TaskDetail({
  name,
  type,
  state,
  stateLabel,
  figures,
  description,
  summary,
  lastTool,
  phases,
  upNext,
  loose,
  looseTitle,
  onBack,
  onStop,
  stopping,
}: TaskDetailProps) {
  const live = state === "running" || state === "paused";
  return (
    <div className="at-taskdetail">
      <button type="button" className="at-details__back" onClick={onBack}>
        <ChevronLeft size={14} aria-hidden="true" />
        {strings.task.back}
      </button>
      <div className="at-taskdetail__head">
        <span className="at-dot" data-state={state} aria-hidden="true" />
        <span className="at-taskdetail__name at-shimmer" data-live={live ? "" : undefined}>
          {name}
        </span>
        {onStop && (
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? strings.task.stopping : strings.task.stop}
          </button>
        )}
      </div>
      <div className="at-taskdetail__figures">
        {[type, stateLabel, figures].filter(Boolean).join(" · ")}
      </div>
      {description && description !== name && <p className="at-taskdetail__text">{description}</p>}
      {summary && <p className="at-taskdetail__text">{summary}</p>}
      {lastTool && <div className="at-taskdetail__quiet">{lastTool}</div>}
      {phases.length > 0 && (
        <ol className="at-phases">
          {phases.map((phase) => (
            <Phase key={phase.title} phase={phase} />
          ))}
        </ol>
      )}
      {loose.length > 0 && (
        <section className="at-details__section">
          <h3 className="at-details__heading">
            <span>{looseTitle}</span>
          </h3>
          <Agents agents={loose} />
        </section>
      )}
      {upNext.length > 0 && (
        <section className="at-details__section">
          <h3 className="at-details__heading">
            <span>{strings.task.upNext}</span>
          </h3>
          <ol className="at-phases at-phases--next">
            {upNext.map((phase) => (
              <Phase key={phase.title} phase={phase} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function Phase({ phase }: { phase: TaskPhaseRow }) {
  return (
    <li className="at-phase" data-state={phase.state}>
      <div className="at-phase__head">
        <span className="at-phase__marker" aria-hidden="true" />
        <span className="at-phase__title">{phase.title}</span>
        {/* Up-next phases sit under a heading that already says so. */}
        {phase.state !== "next" && <span className="at-phase__state">{phase.stateLabel}</span>}
      </div>
      {phase.detail && <div className="at-phase__detail">{phase.detail}</div>}
      {phase.agents.length > 0 && <Agents agents={phase.agents} />}
    </li>
  );
}

function Agents({ agents }: { agents: TaskAgentRow[] }) {
  return (
    <ul className="at-phase__agents">
      {agents.map((agent) => (
        <li key={agent.id} className="at-phase__agent" title={agent.result ?? undefined}>
          <span className="at-dot" data-state={agent.state} aria-hidden="true" />
          <span
            className="at-phase__label at-shimmer"
            data-live={agent.state === "running" ? "" : undefined}
          >
            {agent.label}
          </span>
          {agent.meta && <span className="at-phase__meta">{agent.meta}</span>}
          <span className="at-sr">{strings.task.agentState[agent.state]}</span>
        </li>
      ))}
    </ul>
  );
}
