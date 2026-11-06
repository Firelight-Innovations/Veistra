import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { shareOf, toneOf } from "../meters";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { DetailRow, DetailsPanelProps } from "./types";
import "./details.css";

/**
 * The Details panel, laid out as Claude's own app lays it out: where the
 * session works, how full its context is, what it can reach, what it made
 * and changed, and what runs in the background. Every row that names a file
 * or a task opens it. Escape closes the panel.
 */
export function DetailsPanel({
  onClose,
  environment,
  onOpenGit,
  context,
  connectors,
  onManageConnectors,
  outputs,
  changes,
  tasks,
  agents,
  detail,
}: DetailsPanelProps) {
  const S = useSlots();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !panel.current?.contains(document.activeElement)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const added = changes.reduce((n, c) => n + (c.added ?? 0), 0);
  const removed = changes.reduce((n, c) => n + (c.removed ?? 0), 0);
  return (
    <aside className="at-details" ref={panel} aria-label={strings.details.title}>
      <div className="at-details__head">
        <span className="at-details__title">{strings.details.title}</span>
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--icon"
          aria-label={strings.details.close}
          title={strings.details.close}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="at-details__body">
        {detail ?? (
          <>
            <Section title={strings.details.environment}>
              {environment === null ? (
                <Quiet text={strings.details.loading} />
              ) : (
                <dl className="at-details__facts">
                  <Fact term={environment.kind} value={environment.path} mono />
                  {environment.branch && (
                    <Fact term={strings.details.branch} value={environment.branch} mono />
                  )}
                  {environment.sync && <Fact term="" value={environment.sync} />}
                  {environment.remote && (
                    <Fact term={strings.details.remote} value={environment.remote} mono />
                  )}
                  {environment.uncommitted && (
                    <div className="at-details__fact">
                      <dt />
                      <dd>
                        {environment.uncommitted.label}{" "}
                        <Counts
                          added={environment.uncommitted.added}
                          removed={environment.uncommitted.removed}
                        />
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {onOpenGit && <Action label={strings.details.openGit} onClick={onOpenGit} />}
            </Section>
            <Section title={strings.details.context}>
              {context ? (
                <div className="at-details__context">
                  <S.Ring
                    share={shareOf(context.used, context.size)}
                    tone={toneOf(shareOf(context.used, context.size))}
                  />
                  <span>{strings.usage(context.used, context.size)}</span>
                </div>
              ) : (
                <Quiet text={strings.details.noContext} />
              )}
            </Section>
            <Section title={strings.details.connectors}>
              {connectors === null ? (
                <Quiet text={strings.details.loading} />
              ) : (
                <Rows rows={connectors} empty={strings.details.noConnectors} />
              )}
              {onManageConnectors && (
                <Action label={strings.details.manageConnectors} onClick={onManageConnectors} />
              )}
            </Section>
            <Section title={strings.details.outputs}>
              <Rows rows={outputs} empty={strings.details.noOutputs} />
            </Section>
            <Section
              title={strings.details.changes}
              aside={
                changes.length > 0 ? (
                  <>
                    {strings.details.changeTotals(changes.length)}{" "}
                    <Counts added={added} removed={removed} />
                  </>
                ) : null
              }
            >
              <Rows rows={changes} empty={strings.details.noChanges} />
            </Section>
            <Section title={strings.details.tasks}>
              <Rows rows={tasks} empty={strings.details.noTasks} />
            </Section>
            {agents && (
              <Section title={strings.details.agents}>
                <Action label={agents.label} onClick={agents.onOpen} />
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="at-details__section">
      <h3 className="at-details__heading">
        <span>{title}</span>
        {aside && <span className="at-details__aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function Fact({ term, value, mono }: { term: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="at-details__fact">
      <dt>{term}</dt>
      <dd className={mono ? "at-mono" : undefined} title={value}>
        {value}
      </dd>
    </div>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  if (added + removed === 0) return null;
  return (
    <span className="at-details__counts">
      <span className="at-diff__add">{strings.diffAdded(added)}</span>{" "}
      <span className="at-diff__del">{strings.diffRemoved(removed)}</span>
    </span>
  );
}

function Quiet({ text }: { text: string }) {
  return <div className="at-details__quiet">{text}</div>;
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="at-details__action" onClick={onClick}>
      {label}
    </button>
  );
}

function Rows({ rows, empty }: { rows: DetailRow[]; empty: string }) {
  if (rows.length === 0) return <Quiet text={empty} />;
  return (
    <ul className="at-details__rows">
      {rows.map((row) => {
        const body = (
          <>
            {row.dot && <span className="at-dot" data-state={row.dot} aria-hidden="true" />}
            <span className="at-details__label" title={row.label}>
              {row.label}
            </span>
            {row.isNew && <span className="at-details__new">{strings.newFile}</span>}
            {row.detail && <span className="at-details__detail">{row.detail}</span>}
            <Counts added={row.added ?? 0} removed={row.removed ?? 0} />
          </>
        );
        return (
          <li key={row.id}>
            {row.onOpen ? (
              <button type="button" className="at-details__row" onClick={row.onOpen}>
                {body}
              </button>
            ) : (
              <div className="at-details__row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
