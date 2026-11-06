/**
 * The sign-in code, in a dialog in front of the window, while a sign-in waits
 * for the browser. veistra.com asks the person to check its code against "the
 * one in the Veistra window", so this window has to put it where they look.
 *
 * Opens when this window starts a sign-in (`useAccount`'s `signIn`) and again
 * from the title bar's code chip. Hiding it does not cancel the sign-in; only
 * Cancel does. It goes away by itself when the sign-in ends either way.
 *
 * The shell's own `Dialog`, so it looks, traps focus and dims the window the
 * way Settings and search do. Home's sign-in screen draws the same code its
 * own way, for a sign-in started there.
 */
import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import Dialog from "../dialogs/Dialog";
import { formatUserCode, minutesLeft, type Waiting } from "./account";
import { showSignInCode, useAccount } from "./useAccount";
import "./signInCode.css";

export interface SignInCodeDialogProps {
  waiting: Waiting;
  busy: boolean;
  onCopyLink: () => Promise<void>;
  onCancel: () => void;
  onHide: () => void;
}

export function SignInCodeDialog({
  waiting,
  busy,
  onCopyLink,
  onCancel,
  onHide,
}: SignInCodeDialogProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // Escape hides this and nothing else. Caught on the window in the capture
  // phase so it does not also reach Settings' own Escape, which would close
  // the page the sign-in was started from.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onHide();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onHide]);

  const code = formatUserCode(waiting.userCode);
  const minutes = minutesLeft(waiting.expiresAtMs, now);

  return (
    <Dialog label="Sign-in code" onCancel={onHide} className="signincode">
      <div className="k-dialog__header">Finish signing in on veistra.com</div>
      <div className="k-dialog__body signincode__body">
        <p className="signincode__lead">
          Check that your browser shows this code, then choose Approve.
        </p>
        <div
          className="signincode__code"
          role="group"
          aria-label={`Code ${code.split("").join(" ")}`}
        >
          {code.split("").map((c, i) =>
            c === "-" ? (
              <span key={i} className="signincode__dash" aria-hidden="true" />
            ) : (
              <span key={i} className="signincode__cell" aria-hidden="true">
                {c}
              </span>
            ),
          )}
        </div>
        <p className="signincode__cap">
          {minutes > 1
            ? `The code expires in ${minutes} minutes.`
            : "The code expires in under a minute."}{" "}
          No browser? Copy the link and open it yourself.
        </p>
      </div>
      <div className="k-dialog__footer signincode__footer">
        <button
          type="button"
          className="k-btn k-btn--secondary"
          onClick={() =>
            void onCopyLink().then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Link copied" : "Copy sign-in link"}
        </button>
        <button type="button" className="k-btn k-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel sign-in
        </button>
        <span className="signincode__spacer" />
        <button type="button" className="k-btn k-btn--primary" onClick={onHide}>
          Hide
        </button>
      </div>
    </Dialog>
  );
}

const hide = () => showSignInCode(false);

/** Mounted once per window; draws the dialog while it is open and a sign-in waits. */
export default function SignInCodeHost() {
  const account = useAccount();
  const waiting = account.status?.user == null ? (account.status?.waiting ?? null) : null;
  const open = account.codeOpen && waiting !== null;
  return (
    <AnimatePresence>
      {open && waiting && (
        <SignInCodeDialog
          waiting={waiting}
          busy={account.busy}
          onCopyLink={() => navigator.clipboard.writeText(waiting.verificationUriComplete)}
          onCancel={() => void account.cancelSignIn()}
          onHide={hide}
        />
      )}
    </AnimatePresence>
  );
}
