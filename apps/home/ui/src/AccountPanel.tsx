import { useEffect, useState } from "react";
import { VeistraRpcError, invoke, openIn } from "@veistra/bridge";
import {
  type AccountStatus,
  type Me,
  type PeriodUsage,
  initials,
  money,
  planLabel,
  shortDate,
  spentPercent,
} from "./account";

const COLLAPSED_KEY = "veistra.home.accountPanel.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // A panel that opens expanded next time is not worth an error.
  }
}

/** A failed read's reason, from the `data.reason` `account/*` attaches. */
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

/**
 * Home's right-hand account region, as `AppHome.dc.html` draws it. Every
 * number is read from the account service; nothing here is a sample.
 */
export default function AccountPanel({
  status,
  busy,
  onSignIn,
  onSignOut,
  onSignedOutElsewhere,
}: {
  status: AccountStatus | null;
  busy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  /** A read found this computer signed out: Home rereads the status. */
  onSignedOutElsewhere: () => void;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [me, setMe] = useState<Me | null>(null);
  const [usage, setUsage] = useState<PeriodUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = status?.user != null;

  useEffect(() => {
    if (!signedIn) {
      setMe(null);
      setUsage(null);
      return;
    }
    let live = true;
    const read = () => {
      Promise.all([
        invoke<Me>("account/me"),
        invoke<PeriodUsage>("account/usage", { range: "period" }),
      ])
        .then(([nextMe, nextUsage]) => {
          if (!live) return;
          setMe(nextMe);
          setUsage(nextUsage);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!live) return;
          if (reasonOf(e) === "signed-out") onSignedOutElsewhere();
          else setError(messageOf(e));
        });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [signedIn, onSignedOutElsewhere]);

  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  if (collapsed) {
    return (
      <aside className="account account--collapsed" aria-label="Account">
        <button
          type="button"
          className="k-btn k-btn--ghost account__toggle"
          aria-label="Show account panel"
          aria-expanded="false"
          onClick={toggle}
        >
          <PanelIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="account" aria-label="Account">
      <div className="account__head">
        <span className="account__title">Account</span>
        <button
          type="button"
          className="k-btn k-btn--ghost account__toggle"
          aria-label="Collapse account panel"
          aria-expanded="true"
          onClick={toggle}
        >
          <PanelIcon />
        </button>
      </div>

      <div className="account__body">
        {status === null || !status.configured ? (
          <p className="account__cap">
            Veistra accounts are not set up on this build. The account service address goes in
            Settings, Account.
          </p>
        ) : status.user === null ? (
          <>
            <p className="account__cap">
              Not signed in. Sign in to use the Veistra harness, cloud workers and usage tracking.
            </p>
            <button
              type="button"
              className="k-btn k-btn--primary account__wide"
              disabled={busy}
              onClick={onSignIn}
            >
              Sign in with your browser
            </button>
          </>
        ) : (
          <>
            <div className="account__who">
              <span className="account__avatar" aria-hidden="true">
                {initials(status.user)}
              </span>
              <div className="account__names">
                <p className="account__name">{status.user.name || status.user.email}</p>
                <p className="account__cap account__email">{status.user.email}</p>
              </div>
              {me && (
                <span className="k-badge k-badge--accent">{planLabel(me.workspace.plan)}</span>
              )}
            </div>

            <section className="account__card">
              <div className="account__card-head">
                <h2 className="account__label">This month</h2>
                <button
                  type="button"
                  className="account__link"
                  onClick={() => void openIn("usage")}
                >
                  Usage details
                </button>
              </div>
              {usage === null ? (
                <p className="account__cap">{error ?? "Reading…"}</p>
              ) : (
                <ThisMonth usage={usage} />
              )}
            </section>

            <div className="account__foot">
              <button
                type="button"
                className="k-btn k-btn--secondary account__wide"
                onClick={() => void invoke("account/open-web", { page: "dashboard" })}
              >
                Manage account on veistra.com
                <ExternalIcon />
              </button>
              <button
                type="button"
                className="k-btn k-btn--ghost account__wide"
                disabled={busy}
                onClick={onSignOut}
              >
                Sign out of this computer
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function ThisMonth({ usage }: { usage: PeriodUsage }) {
  const limit = usage.limit;
  if (limit === null) {
    return (
      <>
        <p className="account__amount">
          <span>{money(usage.totals.cost_micros)}</span>
          <span className="account__cap">no monthly limit set</span>
        </p>
      </>
    );
  }
  const percent = spentPercent(limit);
  return (
    <>
      <p className="account__amount">
        <span>{money(limit.spent_this_period_micros)}</span>
        <span className="account__cap">of {money(limit.monthly_limit_micros)} limit</span>
      </p>
      <div
        className="meter"
        role="meter"
        aria-label="Spend against monthly limit"
        aria-valuemin={0}
        aria-valuemax={limit.monthly_limit_micros / 1_000_000}
        aria-valuenow={limit.spent_this_period_micros / 1_000_000}
      >
        <div className="meter__fill" style={{ width: `${percent}%` }} />
      </div>
      {limit.projected_date && (
        <p className="k-badge k-badge--warning account__badge">
          <span className="k-badge__dot" />
          Limit reached around {shortDate(limit.projected_date)} at this rate
        </p>
      )}
    </>
  );
}

function PanelIcon() {
  return (
    <svg className="signin__icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
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
