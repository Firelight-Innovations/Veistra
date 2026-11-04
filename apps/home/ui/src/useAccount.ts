import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@veistra/bridge";
import type { AccountStatus, Me } from "./account";

/** How often the status is reread while a sign-in waits for the browser. */
const WAITING_POLL_MS = 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The account as Home holds it: the status `account/status` reports, the
 * actions the sign-in screen and the panel take, and whether to show the
 * signed-in welcome (true from a sign-in completing until Continue).
 */
export function useAccount() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcoming, setWelcoming] = useState(false);
  const wasWaiting = useRef(false);

  const take = useCallback((next: AccountStatus) => {
    // A sign-in that was waiting and now has a user just finished here.
    if (wasWaiting.current && next.waiting === null && next.user !== null) setWelcoming(true);
    wasWaiting.current = next.waiting !== null;
    setStatus(next);
  }, []);

  const reread = useCallback(() => {
    void invoke<AccountStatus>("account/status")
      .then(take)
      .catch(() => {
        // An app without the account methods (an older host) shows no
        // sign-in screen and no panel content, which `null` already draws.
      });
  }, [take]);

  useEffect(reread, [reread]);

  useEffect(() => {
    if (status?.waiting == null) return;
    const timer = window.setInterval(reread, WAITING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [status?.waiting, reread]);

  useEffect(() => {
    if (!welcoming) return;
    void invoke<Me>("account/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, [welcoming]);

  const act = useCallback(
    (method: string) => {
      setBusy(true);
      setError(null);
      void invoke<AccountStatus>(method)
        .then(take)
        .catch((e: unknown) => setError(messageOf(e)))
        .finally(() => setBusy(false));
    },
    [take],
  );

  return {
    status,
    me,
    busy,
    error,
    welcoming,
    reread,
    signIn: useCallback(() => act("account/sign-in"), [act]),
    cancel: useCallback(() => act("account/cancel-sign-in"), [act]),
    useOwnSignIn: useCallback(() => act("account/use-own-sign-in"), [act]),
    signOut: useCallback(() => act("account/sign-out"), [act]),
    finishWelcome: useCallback(() => setWelcoming(false), []),
  };
}
