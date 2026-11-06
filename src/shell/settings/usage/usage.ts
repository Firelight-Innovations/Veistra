/**
 * Settings' Usage page's model: what `account/usage` and `account/runs` answer
 * (`docs/account-api.md`), and the pure pieces that turn it into the page.
 * Moved here from the retired Usage app with its tests.
 */

export type Range = "period" | "7d" | "30d";

export const RANGES: readonly { value: Range; label: string }[] = [
  { value: "period", label: "This month" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export type Source = "veistra_harness" | "cloud_worker" | "gpu_render";

/** The billed sources, in the chart's stacking order, bottom first. */
export const SOURCES: readonly Source[] = ["veistra_harness", "cloud_worker", "gpu_render"];

export interface SourceTotal {
  cost_micros: number;
  quantity: number;
  unit: string;
}

export interface Limit {
  monthly_limit_micros: number;
  spent_this_period_micros: number;
  /** `null` when the 80% email is off, which the dashboard can do. */
  alert_pct: number | null;
  pause_at_limit: boolean;
  projected_date: string | null;
}

/**
 * The workspace's plan and this month's included credits, which pay for
 * billed usage first and reset with the month. The beta plan answers zeros.
 */
export interface Plan {
  id: string;
  name: string;
  price_micros: number;
  included_micros: number;
  used_micros: number;
  remaining_micros: number;
  resets: string;
}

export interface Usage {
  range: { from: string; to: string };
  period: { from: string; to: string; resets: string };
  totals: {
    cost_micros: number;
    by_source: Partial<Record<Source, SourceTotal>>;
    unbilled_runs: { own_claude?: number; own_codex?: number };
  };
  daily: { day: string; source: string; cost_micros: number }[];
  projects?: string[];
  /** Absent from a service older than plans, which reads as no credits. */
  plan?: Plan;
  /** Caps only spend past the plan's credits. */
  limit: Limit | null;
  synced_at: string;
}

export interface Run {
  id: string;
  name: string;
  project: string;
  harness: string;
  status: string;
  started_at: string;
  tokens: number | null;
  cost_micros: number | null;
  billed: boolean;
}

export interface Runs {
  runs: Run[];
  next_cursor: string | null;
}

/** `$18.40` from micro-dollars. */
export function money(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** `4.7M`, `560K`, `61K`, `900`. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/** Days from `from` to `to`, inclusive, as `YYYY-MM-DD`. Calendar dates, no zone. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let t = start; t <= end && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export interface DayBar {
  day: string;
  bySource: Record<Source, number>;
  total: number;
}

/**
 * One bar per day of the range, stacked by source. A day with no rows is a
 * zero bar rather than a gap, so the bars stay evenly spaced in time.
 */
export function dayBars(usage: Usage): DayBar[] {
  const bars = new Map<string, DayBar>(
    daysBetween(usage.range.from, usage.range.to).map((day) => [
      day,
      { day, bySource: { veistra_harness: 0, cloud_worker: 0, gpu_render: 0 }, total: 0 },
    ]),
  );
  for (const row of usage.daily) {
    const bar = bars.get(row.day);
    if (!bar || !(SOURCES as readonly string[]).includes(row.source)) continue;
    bar.bySource[row.source as Source] += row.cost_micros;
    bar.total += row.cost_micros;
  }
  return [...bars.values()];
}

/**
 * The chart's top, in micro-dollars: the tallest day rounded up to a whole
 * even number of dollars, so the middle gridline is a whole dollar too.
 */
export function chartTop(bars: DayBar[]): number {
  const max = Math.max(0, ...bars.map((b) => b.total));
  const dollars = Math.max(2, Math.ceil(max / 1_000_000));
  return (dollars + (dollars % 2)) * 1_000_000;
}

/** `Nov 4` from `2026-11-04`. */
export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** What a source's quantity is, in the unit its card names. */
export function quantityLabel(source: Source, total: SourceTotal | undefined): string {
  const q = total?.quantity ?? 0;
  if (source === "veistra_harness") return `${compact(q)} tokens`;
  if (source === "cloud_worker") return `${(q / 3600).toFixed(1)} h`;
  return `${Math.round(q / 60)} min`;
}

export const SOURCE_NAMES: Record<Source, string> = {
  veistra_harness: "Agent tokens",
  cloud_worker: "Cloud worker",
  gpu_render: "GPU renders",
};

const HARNESS_NAMES: Record<string, string> = {
  veistra_harness: "Veistra harness",
  claude_code: "Claude Code",
  codex: "Codex",
  cloud_worker: "Cloud worker",
  gpu_render: "GPU render",
};

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness;
}

/** The badge a run's status draws with, and its word. */
export function statusBadge(status: string): { tone: "ok" | "info" | "bad"; label: string } {
  if (status === "running") return { tone: "info", label: "Running" };
  if (status === "failed") return { tone: "bad", label: "Failed" };
  return { tone: "ok", label: "Finished" };
}

/** A run's cost cell: a price, or "Your plan" for an unbilled run. */
export function costCell(run: Run): string {
  if (!run.billed) return "Your plan";
  return money(run.cost_micros ?? 0);
}

/** A run's tokens cell. */
export function tokensCell(run: Run): string {
  return run.tokens ? compact(run.tokens) : "—";
}

/** `17:42` today, `Nov 3` before today, in the reader's own time zone. */
export function startedCell(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `Synced 2 min ago`. */
export function syncedAgo(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "Synced just now" : `Synced ${minutes} min ago`;
}

/** Share of the limit spent, 0–100. */
export function spentPercent(limit: Limit): number {
  if (limit.monthly_limit_micros <= 0) return 100;
  return Math.min(100, (limit.spent_this_period_micros / limit.monthly_limit_micros) * 100);
}

/** `37% used`, whole percent; anything spent at all reads as at least 1%. */
export function usedLabel(limit: Limit): string {
  return percentUsed(spentPercent(limit));
}

function percentUsed(pct: number): string {
  const shown = pct > 0 && pct < 1 ? 1 : Math.round(pct);
  return `${shown}% used`;
}

/** The plan when it includes credits. The beta plan's zeros draw nothing. */
export function credits(usage: Usage): Plan | null {
  const plan = usage.plan;
  return plan && plan.included_micros > 0 ? plan : null;
}

/** Share of the included credits used, 0–100. */
export function creditsPercent(plan: Plan): number {
  return Math.min(100, (plan.used_micros / plan.included_micros) * 100);
}

/** `32% used` of the included credits. */
export function creditsUsedLabel(plan: Plan): string {
  return percentUsed(creditsPercent(plan));
}

/** `Alert at 80%`, or that there is none. */
export function alertTitle(limit: Limit): string {
  return limit.alert_pct === null ? "No spend alert" : `Alert at ${limit.alert_pct}%`;
}

/**
 * The one sentence under the page's header: where this month stands. With no
 * limit there is no month's figure in the reply, only the range's total, so
 * the sentence names the range unless the range is the month.
 */
export function statusSentence(usage: Usage): string {
  const limit = usage.limit;
  const plan = credits(usage);
  if (plan && plan.remaining_micros > 0) {
    return `You've used ${money(plan.used_micros)} of the ${money(plan.included_micros)} included with ${plan.name}, ${money(plan.remaining_micros)} left.`;
  }
  const gone = plan ? `Your ${plan.name} credits are used` : null;
  if (gone && limit === null) return `${gone}. No monthly limit is set.`;
  if (limit === null) {
    const spent = money(usage.totals.cost_micros);
    const when =
      usage.range.from === usage.period.from
        ? "this month"
        : `from ${shortDate(usage.range.from)} to ${shortDate(usage.range.to)}`;
    return `You've spent ${spent} ${when}. No monthly limit is set.`;
  }
  const spent = money(limit.spent_this_period_micros);
  const reached =
    spentPercent(limit) >= 100
      ? `you've reached your ${money(limit.monthly_limit_micros)} monthly limit.`
      : null;
  const left = money(Math.max(0, limit.monthly_limit_micros - limit.spent_this_period_micros));
  const sentence =
    reached ??
    `you've spent ${spent} of your ${money(limit.monthly_limit_micros)} monthly limit, ${left} left.`;
  return gone ? `${gone}, and ${sentence}` : sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
