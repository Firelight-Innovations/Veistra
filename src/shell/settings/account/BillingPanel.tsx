/**
 * Settings → Billing: the plan card. The real plan from `account/me`, or Free,
 * its monthly limit from `account/usage`, and Upgrade, which goes where the
 * title bar's Upgrade goes (`../../upgrade.ts`).
 *
 * The account service has no billing reads yet (renewal date, payment method,
 * invoices), so there are no Payment or Invoices sections; `docs/settings.md`
 * lists what they would need.
 */
import { useEffect, useState } from "react";
import { CreditCard } from "lucide-react";
import { accountCall } from "../../../bindings";
import { accountState, planLabel } from "../../account/account";
import { useAccount } from "../../account/useAccount";
import { UPGRADE_URL, openExternal } from "../../upgrade";
import SettingsSection from "../SettingsSection";
import { money, shortDate, type Usage } from "../usage/usage";
import { Row } from "./ProfilePanel";

export default function BillingPanel() {
  const account = useAccount();
  const signedIn = accountState(account.status) === "signed-in";
  const email = account.status?.user?.email ?? null;
  const plan = planLabel(account.me?.workspace.plan);
  const free = plan === "Free";
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    if (email === null) {
      setUsage(null);
      return;
    }
    let live = true;
    accountCall<Usage>("account/usage", { range: "period" })
      .then((next) => live && setUsage(next))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, [email]);

  const limit = usage?.limit ?? null;

  return (
    <SettingsSection id="billing" title="Plan" description="The plan your workspace is on.">
      <div className="settings-plan">
        <span className="settings-plan__icon" aria-hidden="true">
          <CreditCard size={20} strokeWidth={1.5} />
        </span>
        <div className="settings-plan__text">
          <span className="settings-plan__name">{plan}</span>
          <span className="settings-plan__description">
            {!signedIn
              ? "Sign in to see your workspace's plan."
              : free
                ? "Agents on your own Claude or ChatGPT plan, and pay-as-you-go cloud runs."
                : `${account.me?.workspace.name ?? "Your workspace"} is on the ${plan} plan.`}
          </span>
        </div>
        <button
          type="button"
          className={free ? "k-btn k-btn--primary" : "k-btn k-btn--secondary"}
          onClick={() => openExternal(UPGRADE_URL)}
        >
          {free ? "Upgrade" : "Adjust plan"}
        </button>
      </div>

      {usage !== null && (
        <Row
          title="Monthly limit"
          description={`This period runs ${shortDate(usage.period.from)} – ${shortDate(usage.period.to)} and resets ${shortDate(usage.period.resets)}.`}
        >
          <span className="settings-profile__value">
            {limit ? money(limit.monthly_limit_micros) : "None set"}
          </span>
        </Row>
      )}
      {signedIn && (
        <Row title="Billing details" description="Payment method and invoices are on veistra.com.">
          <button
            type="button"
            className="k-btn k-btn--ghost"
            onClick={() => void accountCall("account/open-web", { page: "dashboard" })}
          >
            Manage on veistra.com
          </button>
        </Row>
      )}
    </SettingsSection>
  );
}
