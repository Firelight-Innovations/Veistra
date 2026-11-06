/**
 * The account, held once for the whole window: what `account/status` and
 * `account/me` last said, and the verbs that change it.
 *
 * A module-level store rather than a hook per caller, because the title bar's
 * avatar and the Settings pages are mounted independently and both want the
 * same answer. One read on focus and one poll while a sign-in waits for the
 * browser, however many places draw the account.
 */
import { useCallback, useSyncExternalStore } from "react";
import { accountCall } from "../../bindings";
import { messageOf, type AccountStatus, type Me } from "./account";

/** How often the status is reread while a sign-in waits for the browser. */
const WAITING_POLL_MS = 1000;

export interface AccountSnapshot {
  status: AccountStatus | null;
  /** `account/me`, read once per signed-in person. Null while signed out. */
  me: Me | null;
  busy: boolean;
  /** The last verb's refusal, as a sentence. */
  error: string | null;
  /** Whether the sign-in code dialog is up. Only while a sign-in waits. */
  codeOpen: boolean;
}

let snapshot: AccountSnapshot = {
  status: null,
  me: null,
  busy: false,
  error: null,
  codeOpen: false,
};
const listeners = new Set<() => void>();
let poll: number | undefined;
let meFor: string | null = null;

function set(next: Partial<AccountSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function take(status: AccountStatus): void {
  // A sign-in that ended, however it ended, takes its code dialog with it.
  set(status.waiting === null ? { status, codeOpen: false } : { status });
  const email = status.user?.email ?? null;
  if (email === null) {
    meFor = null;
    if (snapshot.me !== null) set({ me: null });
  } else if (email !== meFor) {
    meFor = email;
    accountCall<Me>("account/me")
      .then((me) => set({ me }))
      .catch(() => set({ me: null }));
  }
  schedulePoll();
}

function schedulePoll(): void {
  const waiting = snapshot.status?.waiting != null && listeners.size > 0;
  if (waiting && poll === undefined) {
    poll = window.setInterval(refreshAccount, WAITING_POLL_MS);
  } else if (!waiting && poll !== undefined) {
    window.clearInterval(poll);
    poll = undefined;
  }
}

/** Reread the status. A host without the account command leaves it `null`. */
export function refreshAccount(): void {
  accountCall<AccountStatus>("account/status")
    .then(take)
    .catch(() => {});
}

/**
 * Run a verb. Resolves to whether it was accepted, so a caller that draws no
 * error of its own (the title bar's menu) can send the person to one that does.
 */
/**
 * Show or hide the sign-in code dialog. Hiding it leaves the sign-in running;
 * the title bar's code chip brings it back.
 */
export function showSignInCode(open: boolean): void {
  if (open !== snapshot.codeOpen) set({ codeOpen: open && snapshot.status?.waiting != null });
}

function act(method: string): Promise<boolean> {
  set({ busy: true, error: null });
  return accountCall<AccountStatus>(method)
    .then((status) => {
      take(status);
      return true;
    })
    .catch((e: unknown) => {
      set({ error: messageOf(e) });
      return false;
    })
    .finally(() => set({ busy: false }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    refreshAccount();
    window.addEventListener("focus", refreshAccount);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("focus", refreshAccount);
    schedulePoll();
  };
}

/** Forget everything, for tests: each starts from a window that has read nothing. */
export function resetAccountForTests(): void {
  snapshot = { status: null, me: null, busy: false, error: null, codeOpen: false };
  meFor = null;
  if (poll !== undefined) window.clearInterval(poll);
  poll = undefined;
}

export function useAccount() {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return {
    ...current,
    // A sign-in this window starts puts its code in front of the person, since
    // the browser that just opened asks them to match it.
    signIn: useCallback(
      () =>
        act("account/sign-in").then((ok) => {
          if (ok) showSignInCode(true);
          return ok;
        }),
      [],
    ),
    cancelSignIn: useCallback(() => act("account/cancel-sign-in"), []),
    signOut: useCallback(() => act("account/sign-out"), []),
    reread: refreshAccount,
  };
}
