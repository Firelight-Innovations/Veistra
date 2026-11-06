import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { strings } from "../strings";
import type { AgentMapProps, MapNode } from "./types";
import "./details.css";

/**
 * The session as a map: its own node, the subagents it started branching off
 * it, and its background tasks below. A node opens what it stands for.
 * Escape, the close button or a click outside the card closes it.
 */
export function AgentMap({ main, agents, tasks, onClose }: AgentMapProps) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="at-map__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="at-map" role="dialog" aria-modal="true" aria-label={strings.map.title}>
        <div className="at-map__head">
          <span className="at-map__title">{strings.map.title}</span>
          <button
            ref={close}
            type="button"
            className="k-btn k-btn--ghost k-btn--icon"
            aria-label={strings.map.close}
            title={strings.map.close}
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="at-map__caption">{strings.map.agents(agents.length + 1)}</div>
        <div className="at-map__tree">
          <div className="at-map__root">
            <Node node={main} />
          </div>
          {agents.length > 0 && (
            <ul className="at-map__branches">
              {agents.map((node) => (
                <li key={node.id}>
                  <Node node={node} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {tasks.length > 0 && (
          <>
            <div className="at-map__caption">{strings.map.tasks(tasks.length)}</div>
            <ul className="at-map__tasks">
              {tasks.map((node) => (
                <li key={node.id}>
                  <Node node={node} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Node({ node }: { node: MapNode }) {
  const body = (
    <>
      <span className="at-map__line">
        <span className="at-dot" data-state={node.state} aria-hidden="true" />
        <span className="at-map__label" title={node.label}>
          {node.label}
        </span>
      </span>
      {node.meta && <span className="at-map__meta">{node.meta}</span>}
    </>
  );
  return node.onOpen ? (
    <button type="button" className="at-map__node" onClick={node.onOpen}>
      {body}
    </button>
  ) : (
    <div className="at-map__node">{body}</div>
  );
}
