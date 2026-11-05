/**
 * Settings → Usage: where this month stands against the limit, what each
 * source cost, spend per day, and the runs. It replaces the Usage app.
 *
 * Every number is the account service's (`GET /v1/usage` and `GET /v1/runs`,
 * through `account/usage` and `account/runs`), the same two reads the web
 * dashboard makes, so both surfaces always agree. The shell reaches them with
 * `accountCall`, the command `account::methods::account_call` answers.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { accountCall } from "../../../bindings";
import { planLabel, reasonOf, messageOf } from "../../account/account";
import { useAccount } from "../../account/useAccount";
import SegmentedControl from "../../ui/SegmentedControl";
import SettingsSection, { useSections } from "../SettingsSection";
import {
  type DayBar,
  type Range,
  alertTitle,
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
  statusSentence,
  syncedAgo,
  tokensCell,
  usedLabel,
} from "./usage";
import "./usage.css";

/** Why the page cannot show numbers, from the `data.reason` `account/*` attaches. */
type Blocked = "not-configured" | "signed-out" | null;

const SWATCH: Record<Source, string> = {
  veistra_harness: "var(--chart-1)",
  cloud_worker: "var(--chart-3)",
  gpu_render: "var(--chart-4)",
};

const openUsageOnWeb = () => void accountCall("account/open-web", { page: "usage" });

export default function UsagePanel() {
  const account = useAccount();
  const [range, setRange] = useState<Range>("period");
  const [project, setProject] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const signedInAs = account.status?.user?.email ?? null;

  const read = useCallback(() => {
    const params: Record<string, string> = project ? { range, project } : { range };
    Promise.all([
      accountCall<Usage>("account/usage", params),
      accountCall<Runs>("account/runs", project ? { project, limit: "50" } : { limit: "50" }),
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
      });
  }, [range, project]);

  // Reread when the person signs in or out, as well as when the range moves.
  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read, signedInAs]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const plan = planLabel(account.me?.workspace.plan);

  if (blocked !== null) {
    return (
      <SettingsSection id="usage" title="Your usage">
        <BlockedNote reason={blocked} onSignIn={() => void account.signIn()} busy={account.busy} />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        id="usage"
        title="Your usage"
        actions={<span className="k-badge settings-usage__plan">{plan}</span>}
      >
        {error && (
          <p className="settings-usage__error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-usage__controls">
          <SegmentedControl
            value={range}
            options={RANGES}
            onChange={setRange}
            aria-label="Date range"
          />
          <select
            className="settings-usage__select"
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
          <span className="settings-usage__spacer" />
          {usage && <span className="settings-usage__cap">{syncedAgo(usage.synced_at, now)}</span>}
          <button type="button" className="k-btn k-btn--ghost" onClick={openUsageOnWeb}>
            Open on veistra.com
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        {usage === null ? (
          !error && <p className="settings-usage__cap">Reading…</p>
        ) : (
          <Overview usage={usage} />
        )}
      </SettingsSection>

      {usage !== null && (
        <SettingsSection id="usage-daily" title="Daily spend">
          <DailyChart usage={usage} />
        </SettingsSection>
      )}

      <SettingsSection id="usage-runs" title="Runs">
        <RunsTable runs={runs} now={new Date(now)} />
      </SettingsSection>
    </>
  );
}

/** The status sentence, the limit's bar, and what each source cost. */
function Overview({ usage }: { usage: Usage }) {
  const limit = usage.limit;
  const unbilled = usage.totals.unbilled_runs;
  const rangeText = `${shortDate(usage.range.from)} – ${shortDate(usage.range.to)}`;
  return (
    <>
      <p className="settings-usage__sentence">{statusSentence(usage)}</p>

      <div className="settings-usage__meter-row">
        <div className="settings-usage__meter-label">
          <span className="setting__title">Monthly limit</span>
          <span className="setting__description">
            {limit
              ? `${money(limit.spent_this_period_micros)} of ${money(limit.monthly_limit_micros)}`
              : "No monthly limit is set"}{" "}
            · Resets {shortDate(usage.period.resets)}
          </span>
        </div>
        {limit && (
          <>
            <div
              className="settings-usage__meter"
              role="meter"
              aria-label="Spend against monthly limit"
              aria-valuemin={0}
              aria-valuemax={limit.monthly_limit_micros / 1_000_000}
              aria-valuenow={limit.spent_this_period_micros / 1_000_000}
            >
              <div style={{ width: `${spentPercent(limit)}%` }} />
            </div>
            <span className="settings-usage__used">{usedLabel(limit)}</span>
          </>
        )}
      </div>
      {limit?.projected_date && (
        <p className="k-badge k-badge--warning settings-usage__badge">
          <span className="k-badge__dot" />
          Limit reached around {shortDate(limit.projected_date)}
        </p>
      )}

      <h4 className="settings-usage__subhead">By source · {rangeText}</h4>
      <BreakdownRow name="Total" detail={rangeText} value={money(usage.totals.cost_micros)} />
      {SOURCES.map((source) => {
        const total = usage.totals.by_source[source];
        return (
          <BreakdownRow
            key={source}
            swatch={SWATCH[source]}
            name={SOURCE_NAMES[source]}
            detail={quantityLabel(source, total)}
            value={money(total?.cost_micros ?? 0)}
          />
        );
      })}
      <BreakdownRow
        name="Your Claude plan"
        detail="Runs billed to your own subscription"
        value={`${unbilled.own_claude ?? 0} runs`}
      />
      <BreakdownRow
        name="Your ChatGPT plan"
        detail="Runs billed to your own subscription"
        value={`${unbilled.own_codex ?? 0} runs`}
      />

      {limit && (
        <>
          <BreakdownRow
            name={alertTitle(limit)}
            detail={
              limit.alert_pct === null
                ? "No email is sent as spend nears the limit."
                : "An email when spend crosses it, once a month."
            }
          />
          <BreakdownRow
            name={
              limit.pause_at_limit
                ? "Billed runs pause at the limit"
                : "Billed runs keep going past the limit"
            }
            detail="Claude Code and Codex keep running. A call already in flight can carry spend a little past the limit."
          />
        </>
      )}
      <div className="settings-usage__footer">
        <button type="button" className="k-btn k-btn--secondary" onClick={openUsageOnWeb}>
          Change limit on veistra.com
        </button>
      </div>
    </>
  );
}

function BreakdownRow({
  name,
  detail,
  value,
  swatch,
}: {
  name: string;
  detail: string;
  value?: string;
  swatch?: string;
}) {
  return (
    <div className="setting settings-usage__row">
      <div className="setting__label">
        <span className="setting__title">
          {swatch && <span className="settings-usage__swatch" style={{ background: swatch }} />}
          {name}
        </span>
        <span className="setting__description">{detail}</span>
      </div>
      <div className="setting__control settings-usage__value">{value}</div>
      <div className="setting__reset-slot" />
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
    <div className="settings-usage__chart" role="img" aria-label={label}>
      <div className="settings-usage__axis" aria-hidden="true">
        <span>{money(top).replace(".00", "")}</span>
        <span>{money(top / 2).replace(".00", "")}</span>
        <span>$0</span>
      </div>
      <div className="settings-usage__plot">
        <div className="settings-usage__grid" aria-hidden="true">
          <span />
          <span />
          <span className="settings-usage__grid-base" />
        </div>
        <div
          className={`settings-usage__bars${bars.length > 10 ? " settings-usage__bars--dense" : ""}`}
        >
          {bars.map((bar) => (
            <Bar key={bar.day} bar={bar} top={top} />
          ))}
        </div>
      </div>
      <span />
      <div className="settings-usage__ticks" aria-hidden="true">
        <span>{shortDate(first)}</span>
        <span>{shortDate(last)}</span>
      </div>
    </div>
  );
}

function Bar({ bar, top }: { bar: DayBar; top: number }) {
  const height = bar.total > 0 ? Math.max(2, (bar.total / top) * 100) : 0;
  return (
    <div
      className="settings-usage__day"
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
  if (runs === null) return null;
  // Runs are the newest of every range: `/v1/runs` takes a project, not dates.
  if (runs.length === 0) return <p className="settings-usage__cap">No runs yet.</p>;
  return (
    <table className="settings-usage__table">
      <thead>
        <tr>
          <th>Run</th>
          <th>Project</th>
          <th>Harness</th>
          <th>Status</th>
          <th>Started</th>
          <th className="settings-usage__num">Tokens</th>
          <th className="settings-usage__num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const badge = statusBadge(run.status);
          const tone = badge.tone === "ok" ? "success" : badge.tone === "info" ? "info" : "danger";
          return (
            <tr key={run.id}>
              <td className="settings-usage__run-name">{run.name}</td>
              <td>{run.project}</td>
              <td>{harnessName(run.harness)}</td>
              <td>
                <span className={`k-badge k-badge--${tone}`}>
                  <span className="k-badge__dot" />
                  {badge.label}
                </span>
              </td>
              <td className="settings-usage__mono settings-usage__dim">
                {startedCell(run.started_at, now)}
              </td>
              <td className="settings-usage__num settings-usage__mono">{tokensCell(run)}</td>
              <td className="settings-usage__num settings-usage__mono settings-usage__strong">
                {costCell(run)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** What the page says instead of numbers, and the way past it. */
function BlockedNote({
  reason,
  onSignIn,
  busy,
}: {
  reason: Exclude<Blocked, null>;
  onSignIn: () => void;
  busy: boolean;
}) {
  const { go } = useSections();
  if (reason === "not-configured") {
    return (
      <div className="settings-usage__blocked">
        <p className="settings-usage__cap">
          Veistra accounts are not set up on this build: the account service address is empty. It is
          under Developer, Account service.
        </p>
        {go && (
          <button type="button" className="k-btn k-btn--secondary" onClick={() => go("developer")}>
            Open Developer
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="settings-usage__blocked">
      <p className="settings-usage__cap">
        Sign in to Veistra to see what your account has used and spent.
      </p>
      <button type="button" className="k-btn k-btn--primary" disabled={busy} onClick={onSignIn}>
        Sign in
      </button>
    </div>
  );
}
