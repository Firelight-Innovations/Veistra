/**
 * The Veistra account, as Home draws it: the sign-in screen and the account
 * panel. Shapes are what `account/*` answers (`src-tauri/src/account/`), and
 * `docs/account-api.md` for the parts that come from the account service.
 */

export interface AccountUser {
  name: string;
  email: string;
}

export interface Waiting {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAtMs: number;
}

export type Outcome = { kind: "denied" } | { kind: "expired" } | { kind: "failed"; detail: string };

export interface AccountStatus {
  configured: boolean;
  user: AccountUser | null;
  waiting: Waiting | null;
  outcome: Outcome | null;
  ownSignIn: boolean;
}

export interface Me {
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; plan: string };
}

export interface Limit {
  monthly_limit_micros: number;
  spent_this_period_micros: number;
  /** `null` when the 80% email is off, which the dashboard can do. */
  alert_pct: number | null;
  pause_at_limit: boolean;
  projected_date: string | null;
}

/** The part of `GET /v1/usage?range=period` the panel draws. */
export interface PeriodUsage {
  totals: { cost_micros: number };
  limit: Limit | null;
}

/**
 * Whether the sign-in screen stands in front of Home.
 *
 * Never when the account service is not set up: a build pointed at nothing
 * must not lock its user out of their own projects. Always while a sign-in is
 * under way or has just ended, so its result is seen. Otherwise only for
 * someone who is signed out and has not chosen to use their own sign-in.
 */
export function showsSignIn(status: AccountStatus | null, welcoming: boolean): boolean {
  if (status === null || !status.configured) return false;
  if (status.waiting !== null || status.outcome !== null) return true;
  if (status.user !== null) return welcoming;
  return !status.ownSignIn;
}

/** `KQ74MX` as the two groups the approve page shows: `["KQ7", "4MX"]`. */
export function codeGroups(code: string): [string, string] {
  const clean = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const half = Math.ceil(clean.length / 2);
  return [clean.slice(0, half), clean.slice(half)];
}

/** Whole minutes left, rounded up, never below zero. */
export function minutesLeft(expiresAtMs: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - now) / 60_000));
}

/** `$18.40` from micro-dollars. */
export function money(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Share of the limit spent, 0–100, for the meter. */
export function spentPercent(limit: Limit): number {
  if (limit.monthly_limit_micros <= 0) return 100;
  return Math.min(100, (limit.spent_this_period_micros / limit.monthly_limit_micros) * 100);
}

/** `Nov 14` from `2026-11-14`, read as a calendar date with no time zone. */
export function shortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** `BS` from `Braden Seaborn`; the email's first letter when there is no name. */
export function initials(user: AccountUser): string {
  const parts = user.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return (user.email.charAt(0) || "?").toUpperCase();
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

/** `Braden` from `Braden Seaborn`, for "Welcome, Braden". */
export function firstName(user: AccountUser): string {
  return user.name.trim().split(/\s+/)[0] || user.email;
}

/** `beta` → `Beta`. */
export function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
