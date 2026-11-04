import { useEffect, useState } from "react";
import { TAGLINE, WORDMARK } from "./branding.generated";
import { Mark } from "./icons";
import {
  type AccountStatus,
  type Me,
  codeGroups,
  firstName,
  minutesLeft,
  planLabel,
} from "./account";

/**
 * The first-run screen: sign in through the browser, or run agents on your own
 * Claude or Codex plan. Three states, as `AppSignIn.dc.html` on the design
 * canvas draws them — start, waiting for the browser, signed in — plus the two
 * ways a sign-in can end without one (cancelled on the approve page, expired).
 */
export default function SignInScreen({
  status,
  me,
  busy,
  error,
  onSignIn,
  onCancel,
  onOwnSignIn,
  onContinue,
}: {
  status: AccountStatus;
  me: Me | null;
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
  onCancel: () => void;
  onOwnSignIn: () => void;
  onContinue: () => void;
}) {
  return (
    <main className="signin" aria-labelledby="signin-title">
      <div className="signin__inner">
        <header className="signin__brand">
          <p className="home__lockup signin__lockup" id="signin-title">
            <Mark className="home__lockup-mark" />
            <span className="home__lockup-word">{WORDMARK}</span>
          </p>
          <p className="signin__cap">{TAGLINE}</p>
        </header>

        {status.waiting ? (
          <WaitingState waiting={status.waiting} busy={busy} onCancel={onCancel} />
        ) : status.user ? (
          <>
            <p className="k-badge k-badge--success">
              <span className="k-badge__dot" />
              Signed in
            </p>
            <div className="signin__heading">
              <h1>Welcome, {firstName(status.user)}</h1>
              <p className="signin__cap">
                {me ? `${me.workspace.name} · ${planLabel(me.workspace.plan)}. ` : ""}
                Usage from this computer shows on your dashboard.
              </p>
            </div>
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--xl signin__wide"
              onClick={onContinue}
            >
              Continue to Home
            </button>
          </>
        ) : (
          <>
            {status.outcome && <Ended outcome={status.outcome} />}
            <div className="signin__stack">
              <button
                type="button"
                className="k-btn k-btn--primary k-btn--xl signin__wide"
                disabled={busy}
                onClick={onSignIn}
              >
                <ExternalIcon />
                {status.outcome ? "Try again" : "Sign in with your browser"}
              </button>
              <p className="signin__cap">
                Opens veistra.com. You come back here when you are done.
              </p>
            </div>
            <div className="signin__or" aria-hidden="true">
              <span />
              <span className="signin__label">or</span>
              <span />
            </div>
            <div className="signin__stack signin__stack--tight">
              <button
                type="button"
                className="k-btn k-btn--secondary k-btn--xl signin__wide"
                disabled={busy}
                onClick={onOwnSignIn}
              >
                Use my own Claude or Codex sign-in
              </button>
              <p className="signin__cap">
                Agents run on your own plan. The Veistra harness, cloud workers and usage tracking
                need a Veistra account.
              </p>
            </div>
          </>
        )}

        {error && (
          <p className="signin__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function Ended({ outcome }: { outcome: NonNullable<AccountStatus["outcome"]> }) {
  const [title, body] =
    outcome.kind === "denied"
      ? ["Sign-in cancelled", "The sign-in was cancelled on veistra.com."]
      : outcome.kind === "expired"
        ? ["This code expired", "Codes last 10 minutes. Start again for a new one."]
        : ["Sign-in did not finish", outcome.detail];
  return (
    <div className="signin__heading" role="status">
      <h1>{title}</h1>
      <p className="signin__cap">{body}</p>
    </div>
  );
}

function WaitingState({
  waiting,
  busy,
  onCancel,
}: {
  waiting: NonNullable<AccountStatus["waiting"]>;
  busy: boolean;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const [left, right] = codeGroups(waiting.userCode);
  const minutes = minutesLeft(waiting.expiresAtMs, now);

  const copy = () => {
    void navigator.clipboard
      .writeText(waiting.verificationUriComplete)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <>
      <p className="k-badge k-badge--info">
        <span className="k-badge__dot" />
        Waiting for your browser
      </p>
      <div className="signin__heading">
        <h1>Finish signing in on veistra.com</h1>
        <p className="signin__cap">Check that the browser shows this code, then choose Approve.</p>
      </div>
      <div
        className="signin__code"
        role="group"
        aria-label={`Sign-in code ${waiting.userCode.split("").join(" ")}`}
      >
        {left.split("").map((c, i) => (
          <span key={`l${i}`} className="signin__cell">
            {c}
          </span>
        ))}
        <span className="signin__dash" aria-hidden="true" />
        {right.split("").map((c, i) => (
          <span key={`r${i}`} className="signin__cell">
            {c}
          </span>
        ))}
      </div>
      <div className="signin__row">
        <button type="button" className="k-btn k-btn--secondary" onClick={copy}>
          <CopyIcon />
          {copied ? "Link copied" : "Copy sign-in link"}
        </button>
        <button type="button" className="k-btn k-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="signin__cap">
        {minutes > 1
          ? `The code expires in ${minutes} minutes.`
          : "The code expires in under a minute."}
      </p>
    </>
  );
}

function ExternalIcon() {
  return (
    <svg className="signin__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg className="signin__icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}
