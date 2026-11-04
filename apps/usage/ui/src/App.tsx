import { useCallback, useEffect, useState } from "react";
import { VeistraRpcError, invoke, openIn, reportPainted } from "@veistra/bridge";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import {
  type DayBar,
  type Limit,
  type Range,
  type Run,
  type Runs,
  type Source,
  type Usage,
  RANGES,
  SOURCES,
  SOURCE_NAMES,
  chartTop,
  costCell,
  dayBars,
  harnessName,
  money,
  quantityLabel,
  shortDate,
  spentPercent,
  startedCell,
  statusBadge,
  syncedAgo,
  tokensCell,
} from "./usage";

/** Why the page cannot show numbers, from the `data.reason` `account/*` attaches. */
type Blocked = "not-configured" | "signed-out" | null;

function reasonOf(error: unknown): string | null {
  if (!(error instanceof VeistraRpcError)) return null;
  const data = error.data;
  if (typeof data === "object" && data !== null && "reason" in data) {
    return typeof data.reason === "string" ? data.reason : null;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SWATCH: Record<Source, string> = {
  veistra_harness: "var(--chart-1)",
  cloud_worker: "var(--chart-3)",
  gpu_render: "var(--chart-4)",
};

/**
 * The Usage app, as `AppUsage.dc.html` draws it: totals by source, spend per
 * day, the runs, and the monthly limit. Every number is the account service's
 * (`GET /v1/usage` and `GET /v1/runs`), the same two reads the web dashboard
 * makes, so both surfaces always agree.
 */
export default function App() {
  const [range, setRange] = useState<Range>("period");
  const [project, setProject] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const read = useCallback(() => {
    const params = project ? { range, project } : { range };
    Promise.all([
      invoke<Usage>("account/usage", params),
      invoke<Runs>("account/runs", project ? { project, limit: "50" } : { limit: "50" }),
    ])
      .then(([nextUsage, nextRuns]) => {
        setUsage(nextUsage);
        setRuns(nextRuns.runs);
        setBlocked(null);
        setError(null);
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        const reason = reasonOf(e);
        if (reason === "not-configured" || reason === "signed-out") setBlocked(reason);
        else setError(messageOf(e));
      })
      .finally(reportPainted);
  }, [range, project]);

  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (blocked !== null) return <BlockedPage reason={blocked} />;

  return (
    <div className="usage">
      <main className="usage__main">
        <header className="usage__bar">
          <h1 className="usage__title">Usage</h1>
          <SegmentedControl
            value={range}
            options={RANGES}
            onChange={setRange}
            aria-label="Date range"
          />
          <select
            className="usage__select"
            aria-label="Project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">All projects</option>
            {(usage?.projects ?? []).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="usage__spacer" />
          {usage && <span className="usage__cap">{syncedAgo(usage.synced_at, now)}</span>}
          <button
            type="button"
            className="k-btn k-btn--ghost"
            onClick={() => void invoke("account/open-web", { page: "usage" })}
          >
            Open on veistra.com
            <ExternalIcon />
          </button>
        </header>

        <div className="usage__body">
          {error && (
            <p className="usage__error" role="alert">
              {error}
            </p>
          )}
          {usage === null ? (
            !error && <p className="usage__cap">Reading…</p>
          ) : (
            <>
              <Stats usage={usage} />
              <DailyChart usage={usage} />
            </>
          )}
          <RunsTable runs={runs} now={new Date(now)} />
        </div>
      </main>

      <LimitPanel usage={usage} />
    </div>
  );
}

function Stats({ usage }: { usage: Usage }) {
  const rangeText = `${shortDate(usage.range.from)} – ${shortDate(usage.range.to)}`;
  return (
    <div className="usage__stats">
      <section className="usage__card">
        <h2 className="usage__label">Total</h2>
        <p className="usage__big">{money(usage.totals.cost_micros)}</p>
        <p className="usage__cap">{rangeText}</p>
      </section>
      {SOURCES.map((source) => {
        const total = usage.totals.by_source[source];
        return (
          <section key={source} className="usage__card">
            <h2 className="usage__label">
              <span className="usage__swatch" style={{ background: SWATCH[source] }} />
              {SOURCE_NAMES[source]}
            </h2>
            <p className="usage__big">{money(total?.cost_micros ?? 0)}</p>
            <p className="usage__cap">{quantityLabel(source, total)}</p>
          </section>
        );
      })}
    </div>
  );
}

function DailyChart({ usage }: { usage: Usage }) {
  const bars = dayBars(usage);
  const top = chartTop(bars);
  const total = bars.reduce((s, b) => s + b.total, 0);
  const first = bars[0]?.day ?? usage.range.from;
  const last = bars[bars.length - 1]?.day ?? usage.range.to;
  const label = `Daily spend from ${shortDate(first)} to ${shortDate(last)}, total ${money(total)}.`;
  return (
    <section className="usage__chart" role="img" aria-label={label}>
      <div className="usage__axis" aria-hidden="true">
        <span>{money(top).replace(".00", "")}</span>
        <span>{money(top / 2).replace(".00", "")}</span>
        <span>$0</span>
      </div>
      <div className="usage__plot">
        <div className="usage__grid" aria-hidden="true">
          <span />
          <span />
          <span className="usage__grid-base" />
        </div>
        <div className={`usage__bars${bars.length > 10 ? " usage__bars--dense" : ""}`}>
          {bars.map((bar) => (
            <Bar key={bar.day} bar={bar} top={top} />
          ))}
        </div>
      </div>
      <span />
      <div className="usage__ticks" aria-hidden="true">
        <span>{shortDate(first)}</span>
        <span>{shortDate(last)}</span>
      </div>
    </section>
  );
}

function Bar({ bar, top }: { bar: DayBar; top: number }) {
  const height = bar.total > 0 ? Math.max(2, (bar.total / top) * 100) : 0;
  return (
    <div
      className="usage__day"
      title={`${shortDate(bar.day)} · ${money(bar.total)}`}
      style={{ height: `${height}%` }}
    >
      {SOURCES.map((source) => (
        <span key={source} style={{ flexGrow: bar.bySource[source], background: SWATCH[source] }} />
      ))}
    </div>
  );
}

function RunsTable({ runs, now }: { runs: Run[] | null; now: Date }) {
  return (
    <section className="usage__runs">
      <h2 className="usage__label">Runs</h2>
      {runs === null ? null : runs.length === 0 ? (
        <p className="usage__cap">No runs in this range yet.</p>
      ) : (
        <table className="usage__table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Project</th>
              <th>Harness</th>
              <th>Status</th>
              <th>Started</th>
              <th className="usage__num">Tokens</th>
              <th className="usage__num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const badge = statusBadge(run.status);
              const tone =
                badge.tone === "ok" ? "success" : badge.tone === "info" ? "info" : "danger";
              return (
                <tr key={run.id}>
                  <td className="usage__run-name">{run.name}</td>
                  <td>{run.project}</td>
                  <td>{harnessName(run.harness)}</td>
                  <td>
                    <span className={`k-badge k-badge--${tone}`}>
                      <span className="k-badge__dot" />
                      {badge.label}
                    </span>
                  </td>
                  <td className="usage__mono usage__dim">{startedCell(run.started_at, now)}</td>
                  <td className="usage__num usage__mono">{tokensCell(run)}</td>
                  <td className="usage__num usage__mono usage__strong">{costCell(run)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LimitPanel({ usage }: { usage: Usage | null }) {
  const limit: Limit | null = usage?.limit ?? null;
  const unbilled = usage?.totals.unbilled_runs ?? {};
  return (
    <aside className="usage__aside" aria-label="Limit">
      <div className="usage__aside-head">Monthly limit</div>
      <div className="usage__aside-body">
        {usage === null ? (
          <p className="usage__cap">Reading…</p>
        ) : (
          <>
            <div className="usage__group">
              {limit ? (
                <>
                  <p className="usage__amount">
                    <span className="usage__big">{money(limit.spent_this_period_micros)}</span>
                    <span className="usage__cap">of {money(limit.monthly_limit_micros)}</span>
                  </p>
                  <div
                    className="usage__meter"
                    role="meter"
                    aria-label="Spend against monthly limit"
                    aria-valuemin={0}
                    aria-valuemax={limit.monthly_limit_micros / 1_000_000}
                    aria-valuenow={limit.spent_this_period_micros / 1_000_000}
                  >
                    <div style={{ width: `${spentPercent(limit)}%` }} />
                  </div>
                </>
              ) : (
                <p className="usage__cap">No monthly limit is set.</p>
              )}
              <p className="usage__cap">
                {shortDate(usage.period.from)} – {shortDate(usage.period.to)} · resets{" "}
                {shortDate(usage.period.resets)}
              </p>
              {limit?.projected_date && (
                <p className="k-badge k-badge--warning usage__badge">
                  <span className="k-badge__dot" />
                  Limit reached around {shortDate(limit.projected_date)}
                </p>
              )}
            </div>

            <div className="usage__group usage__group--ruled">
              <h2 className="usage__label">Billed by</h2>
              <p className="usage__line">
                <span>Veistra</span>
                <span className="usage__mono usage__strong">{money(usage.totals.cost_micros)}</span>
              </p>
              <p className="usage__line">
                <span>Your Claude plan</span>
                <span className="usage__cap">{unbilled.own_claude ?? 0} runs</span>
              </p>
              <p className="usage__line">
                <span>Your ChatGPT plan</span>
                <span className="usage__cap">{unbilled.own_codex ?? 0} runs</span>
              </p>
            </div>

            {limit && (
              <div className="usage__group usage__group--ruled">
                <p className="usage__setting">
                  <span className="usage__strong">Alert at {limit.alert_pct}%</span>
                  <span className="usage__cap">An email when spend crosses it, once a month.</span>
                </p>
                <p className="usage__setting">
                  <span className="usage__strong">
                    {limit.pause_at_limit
                      ? "Billed runs pause at the limit"
                      : "Billed runs keep going past the limit"}
                  </span>
                  <span className="usage__cap">
                    Claude Code and Codex keep running. A call already in flight can carry spend a
                    little past the limit.
                  </span>
                </p>
              </div>
            )}

            <button
              type="button"
              className="k-btn k-btn--secondary usage__wide"
              onClick={() => void invoke("account/open-web", { page: "usage" })}
            >
              Change limit on veistra.com
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function BlockedPage({ reason }: { reason: Exclude<Blocked, null> }) {
  useEffect(reportPainted, []);
  return (
    <div className="usage usage--blocked">
      <div className="usage__blocked">
        <h1 className="usage__title">Usage</h1>
        {reason === "not-configured" ? (
          <p className="usage__cap">
            Veistra accounts are not set up on this build. The account service address goes in
            Settings, Account.
          </p>
        ) : (
          <>
            <p className="usage__cap">
              Sign in to Veistra to see what your account has used and spent.
            </p>
            <button
              type="button"
              className="k-btn k-btn--primary"
              onClick={() => void openIn("home")}
            >
              Sign in on Home
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg className="usage__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
