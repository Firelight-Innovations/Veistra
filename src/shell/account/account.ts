/**
 * The Veistra account, as the shell draws it: the title bar's avatar and the
 * Account, Billing and Usage pages of Settings. Shapes are what `account/*`
 * answers (`src-tauri/src/account/`); `docs/account-api.md` has the parts that
 * come from the account service. Home keeps its own copy for its sign-in
 * screen, because an app may not import the shell's source.
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

/** `account/status`. `configured` is false while the service address is unset. */
export interface AccountStatus {
  configured: boolean;
  user: AccountUser | null;
  waiting: Waiting | null;
  outcome: Outcome | null;
  ownSignIn: boolean;
}

/** `account/me`, which is `GET /v1/me`. */
export interface Me {
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; plan: string };
}

/** Where the person stands, which is what every account surface branches on. */
export type AccountState = "unknown" | "not-configured" | "signed-out" | "waiting" | "signed-in";

export function accountState(status: AccountStatus | null): AccountState {
  if (status === null) return "unknown";
  if (!status.configured) return "not-configured";
  if (status.user !== null) return "signed-in";
  if (status.waiting !== null) return "waiting";
  return "signed-out";
}

/** `BS` from `Braden Seaborn`; the email's first letter when there is no name. */
export function initials(user: AccountUser): string {
  const parts = user.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return (user.email.charAt(0) || "?").toUpperCase();
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

/**
 * `YB2-4BR` from `yb24br`, `YB2 4BR` or `YB2-4BR`: the two halves the
 * approval page prints, so the person can match them by eye. Home's
 * `codeGroups` splits the same way.
 */
export function formatUserCode(code: string): string {
  const clean = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const half = Math.ceil(clean.length / 2);
  return clean.length > 4 ? `${clean.slice(0, half)}-${clean.slice(half)}` : clean;
}

/** Whole minutes until `expiresAtMs`, rounded up, never below zero. */
export function minutesLeft(expiresAtMs: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - now) / 60_000));
}

/** The name to show, or the email when the account has no name. */
export function displayName(user: AccountUser): string {
  return user.name.trim() || user.email;
}

/** `beta` → `Beta`. An empty plan reads as Free, which is what no plan is. */
export function planLabel(plan: string | null | undefined): string {
  const p = (plan ?? "").trim();
  if (p === "") return "Free";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Why a read could not be made, from the `data.reason` `account/*` attaches to
 * its error: `not-configured`, `signed-out`, `unreachable` or `failed`.
 */
export function reasonOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data === "object" && data !== null && "reason" in data) {
    const reason = (data as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

/** A rejection's sentence: the RPC error's `message`, an `Error`'s, or the value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
