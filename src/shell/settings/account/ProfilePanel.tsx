/**
 * Settings → Account → Profile: who this computer is signed in to Veistra as,
 * and the way in or out.
 *
 * Only what `account/status` and `account/me` answer is drawn. The account
 * service has no photo, no way to change a name, and no list of signed-in
 * devices yet, so the photo row shows initials and cannot be clicked, the name
 * is text rather than a field, and there is no "Where you're logged in" table.
 * `docs/settings.md` lists the endpoints those would need.
 */
import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import Avatar from "../../ui/Avatar";
import { accountCall } from "../../../bindings";
import {
  accountState,
  displayName,
  initials,
  planLabel,
  type Outcome,
} from "../../account/account";
import { useAccount } from "../../account/useAccount";
import SettingsSection from "../SettingsSection";

export default function ProfilePanel() {
  const account = useAccount();
  const state = accountState(account.status);
  const user = account.status?.user ?? null;
  const me = account.me;

  return (
    <SettingsSection
      id="profile"
      title="Profile"
      description="Who this computer is signed in to Veistra as."
    >
      {account.error !== null && (
        <p className="settings-profile__error" role="alert">
          {account.error}
        </p>
      )}

      {user !== null && (
        <>
          <Row
            title="Profile photo"
            description="Your initials, until Veistra accounts carry a photo."
          >
            <Avatar initials={initials(user)} size={40} />
          </Row>
          <Row title="Full name" description="As your Veistra account has it.">
            <span className="settings-profile__value">{user.name.trim() || "Not set"}</span>
          </Row>
          <Row title="Email">
            <span className="settings-profile__value">{user.email}</span>
          </Row>
          {me !== null && (
            <>
              <Row title="Workspace" description={`${planLabel(me.workspace.plan)} plan`}>
                <span className="settings-profile__value">{me.workspace.name}</span>
              </Row>
              <Row title="Account ID">
                <CopyValue value={me.user.id} label="account ID" />
              </Row>
              <Row title="Workspace ID">
                <CopyValue value={me.workspace.id} label="workspace ID" />
              </Row>
            </>
          )}
        </>
      )}

      <SignInRow
        state={state}
        name={user ? displayName(user) : null}
        outcome={account.status?.outcome ?? null}
        code={account.status?.waiting?.userCode ?? null}
        busy={account.busy}
        onSignIn={() => void account.signIn()}
        onCancel={() => void account.cancelSignIn()}
        onSignOut={() => void account.signOut()}
      />
    </SettingsSection>
  );
}

/** One display row in the `.setting` anatomy, with no reset. */
export function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting">
      <div className="setting__label">
        <span className="setting__title">{title}</span>
        {description !== undefined && <span className="setting__description">{description}</span>}
      </div>
      <div className="setting__control">{children}</div>
      <div className="setting__reset-slot" />
    </div>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="settings-profile__copy">
      <code className="settings-profile__id">{value}</code>
      <button
        type="button"
        className="k-btn k-btn--ghost k-btn--icon k-btn--sm"
        aria-label={`Copy ${label}`}
        title={copied ? "Copied" : `Copy ${label}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {copied ? (
          <Check size={14} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

function ended(outcome: Outcome | null): string | null {
  if (outcome === null) return null;
  if (outcome.kind === "denied") return "The sign-in was cancelled on veistra.com.";
  if (outcome.kind === "expired") return "The sign-in code expired. Start again for a new one.";
  return `Sign-in did not finish: ${outcome.detail}`;
}

function SignInRow(p: {
  state: ReturnType<typeof accountState>;
  name: string | null;
  outcome: Outcome | null;
  code: string | null;
  busy: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  switch (p.state) {
    case "unknown":
      return null;
    case "not-configured":
      return (
        <Row title="Sign in" description="Veistra accounts are not set up on this build.">
          <button type="button" className="k-btn k-btn--secondary" disabled>
            Sign in
          </button>
        </Row>
      );
    case "waiting":
      return (
        <Row
          title="Waiting for the browser"
          description={
            p.code ? `Approve code ${p.code} on veistra.com to finish.` : "Approve on veistra.com."
          }
        >
          <button
            type="button"
            className="k-btn k-btn--secondary"
            disabled={p.busy}
            onClick={p.onCancel}
          >
            Cancel sign-in
          </button>
        </Row>
      );
    case "signed-out":
      return (
        <Row
          title="Sign in"
          description={
            ended(p.outcome) ?? "Sign in with your browser to see usage, billing and your plan."
          }
        >
          <button
            type="button"
            className="k-btn k-btn--primary"
            disabled={p.busy}
            onClick={p.onSignIn}
          >
            {p.outcome ? "Try again" : "Sign in"}
          </button>
        </Row>
      );
    case "signed-in":
      return (
        <Row title="Sign out" description={`Signed in as ${p.name ?? "you"} on this computer.`}>
          <span className="settings-profile__actions">
            <button
              type="button"
              className="k-btn k-btn--ghost"
              onClick={() => void accountCall("account/open-web", { page: "dashboard" })}
            >
              Manage on veistra.com
            </button>
            <button
              type="button"
              className="k-btn k-btn--secondary"
              disabled={p.busy}
              onClick={p.onSignOut}
            >
              Sign out
            </button>
          </span>
        </Row>
      );
  }
}
