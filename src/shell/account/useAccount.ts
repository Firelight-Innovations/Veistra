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
import { shrink } from "./picture";

/** How often the status is reread while a sign-in waits for the browser. */
const WAITING_POLL_MS = 1000;

export interface AccountSnapshot {
  status: AccountStatus | null;
  /** `account/me`, read once per signed-in person. Null while signed out. */
  me: Me | null;
  /**
   * The profile picture as a `data:` URL, from `account/avatar`, which reads
   * it with the token an `<img>` could not send. Null with none, and while
   * it loads: the initials stand in.
   */
  picture: string | null;
  busy: boolean;
  /** The last verb's refusal, as a sentence. */
  error: string | null;
}

let snapshot: AccountSnapshot = { status: null, me: null, picture: null, busy: false, error: null };
const listeners = new Set<() => void>();
let poll: number | undefined;
let meFor: string | null = null;
/** The picture version `picture` holds, so each version is read once. */
let pictureFor: string | null = null;

/** Read the picture `me` names, unless it is the one already held. */
function takeMe(me: Me): void {
  set({ me });
  const version = me.user.avatar ?? null;
  if (version === pictureFor) return;
  pictureFor = version;
  if (version === null) {
    set({ picture: null });
    return;
  }
  accountCall<string | null>("account/avatar")
    .then((picture) => {
      if (pictureFor === version) set({ picture });
    })
    .catch(() => {
      if (pictureFor === version) set({ picture: null });
    });
}

function set(next: Partial<AccountSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function take(status: AccountStatus): void {
  set({ status });
  const email = status.user?.email ?? null;
  if (email === null) {
    meFor = null;
    pictureFor = null;
    if (snapshot.me !== null || snapshot.picture !== null) set({ me: null, picture: null });
  } else if (email !== meFor) {
    meFor = email;
    accountCall<Me>("account/me")
      .then(takeMe)
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

/** Words for a picked file the webview cannot open as a picture. */
export const NOT_A_PICTURE =
  "That file is not a picture Veistra can open. Try a PNG, JPEG or WebP.";

/**
 * Shrink a picked file and make it the profile picture. The picture drawn is
 * the one just sent, so nothing is read back; `me` takes the new version.
 */
async function setPicture(file: Blob): Promise<boolean> {
  set({ busy: true, error: null });
  try {
    const url = await shrink(file).catch(() => null);
    if (url === null) {
      set({ error: NOT_A_PICTURE });
      return false;
    }
    const image = url.slice(url.indexOf(",") + 1);
    const { avatar } = await accountCall<{ avatar: string }>("account/set-avatar", { image });
    pictureFor = avatar;
    const me = snapshot.me && { ...snapshot.me, user: { ...snapshot.me.user, avatar } };
    set({ picture: url, me });
    return true;
  } catch (e: unknown) {
    set({ error: messageOf(e) });
    return false;
  } finally {
    set({ busy: false });
  }
}

async function removePicture(): Promise<boolean> {
  set({ busy: true, error: null });
  try {
    await accountCall("account/remove-avatar");
    pictureFor = null;
    const me = snapshot.me && { ...snapshot.me, user: { ...snapshot.me.user, avatar: null } };
    set({ picture: null, me });
    return true;
  } catch (e: unknown) {
    set({ error: messageOf(e) });
    return false;
  } finally {
    set({ busy: false });
  }
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
  snapshot = { status: null, me: null, picture: null, busy: false, error: null };
  meFor = null;
  pictureFor = null;
  if (poll !== undefined) window.clearInterval(poll);
  poll = undefined;
}

export function useAccount() {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return {
    ...current,
    signIn: useCallback(() => act("account/sign-in"), []),
    cancelSignIn: useCallback(() => act("account/cancel-sign-in"), []),
    signOut: useCallback(() => act("account/sign-out"), []),
    setPicture,
    removePicture,
    reread: refreshAccount,
  };
}
