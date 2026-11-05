import { useState } from "react";
import { Archive, ChevronRight, MessageSquare, Search, X } from "lucide-react";
import { strings } from "../strings";
import type { Harness } from "../protocol.generated";
import type { HistoryPanelProps } from "./types";
import "./history.css";

/** One history across harnesses. Opening restores context without running an agent. */
export function HistoryPanel({
  sessions,
  loading,
  error,
  onClose,
  onRetry,
  onOpen,
  onArchive,
}: HistoryPanelProps) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [harness, setHarness] = useState<Harness | "">("");
  const matches = sessions.filter(
    (s) =>
      s.archived === archived &&
      `${s.title} ${strings.harnessName[s.harness]}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section
      className="at-history"
      role="dialog"
      aria-label={strings.history.title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="at-history__heading">
        <strong>{strings.history.title}</strong>
        <button type="button" aria-label={strings.history.close} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <label className="at-history__search">
        <Search size={14} />
        <input
          autoFocus
          aria-label={strings.history.search}
          placeholder={strings.history.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <label className="at-history__harness">
        {strings.history.continueWith}
        <select
          aria-label={strings.history.continueWith}
          value={harness}
          onChange={(e) => setHarness(e.target.value as Harness | "")}
        >
          <option value="">{strings.history.original}</option>
          {["veistra", "claude", "codex"].map((id) => (
            <option key={id} value={id}>
              {strings.harnessName[id]}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={onRetry}>
            {strings.history.retry}
          </button>
        </p>
      ) : loading ? (
        <p role="status">{strings.loading}</p>
      ) : (
        <ul className="at-history__list">
          {matches.map((s) => (
            <li key={s.id}>
              <button
                className="at-history__conversation"
                type="button"
                onClick={() => onOpen(s.id, harness || undefined)}
              >
                <MessageSquare size={14} aria-hidden="true" />
                <span>
                  <strong>{s.title}</strong>
                  <small>
                    {strings.harnessName[s.harness]} ·{" "}
                    {new Date(s.updated).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </small>
                </span>
              </button>
              <button
                className="at-history__archive"
                type="button"
                aria-label={s.archived ? strings.history.restore : strings.history.archive}
                title={s.archived ? strings.history.restore : strings.history.archive}
                onClick={() => onArchive(s.id, !s.archived)}
              >
                <Archive size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && !error && matches.length === 0 && (
        <p>{query ? strings.history.noMatches : strings.history.empty}</p>
      )}
      <button
        type="button"
        className="at-history__archived"
        aria-expanded={archived}
        onClick={() => setArchived((v) => !v)}
      >
        <ChevronRight size={14} style={{ transform: archived ? "rotate(90deg)" : undefined }} />
        {strings.history.archived}
        <span>{sessions.filter((s) => s.archived).length}</span>
      </button>
    </section>
  );
}
