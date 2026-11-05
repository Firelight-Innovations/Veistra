/**
 * One setting: what it is on the left, what it is set to on the right.
 *
 * The row is the same in a section and in a filtered flat list, which is why it
 * knows nothing about either — it takes a `Setting` and the session, and the two
 * callers arrange them.
 *
 * Anatomy: label (title, description, when it applies), the control in a
 * column of its own, and a reset slot at the right edge that is reserved even
 * when empty. A modified row gets a 6px accent dot after its title; the design
 * system forbids coloured side bars on rows.
 *
 * "When it applies" is drawn because most settings are read when something is
 * *made* (a pty spawned, an editor mounted), so a control that moves and changes
 * nothing on screen looks broken. Nothing is drawn for `now`: a note under every
 * control trains people to stop reading it.
 */
import { RotateCcw } from "lucide-react";
import ControlFor from "./controls/ControlFor";
import Highlight from "./Highlight";
import { useSections } from "./SettingsSection";
import type { Setting, SettingApplies } from "../../bindings";
import type { SettingsSession } from "./useSettings";

export default function SettingRow({
  setting,
  session,
}: {
  setting: Setting;
  session: SettingsSession;
}) {
  const changed = session.isChanged(setting.key);
  const applies = appliesNote(setting.applies);
  // The settings search, marked in the title and description while it is up.
  const { needle } = useSections();

  return (
    <div
      className="setting"
      data-kind={setting.control.kind}
      data-changed={changed || undefined}
      data-key={setting.key}
    >
      <div className="setting__label">
        <span className="setting__title">
          <Highlight text={setting.title} needle={needle} />
          {changed && <span className="setting__modified" role="img" aria-label="Modified" />}
        </span>
        {setting.description !== "" && (
          <span className="setting__description">
            <Highlight text={setting.description} needle={needle} />
          </span>
        )}
        {applies !== null && <span className="setting__applies">{applies}</span>}
      </div>

      <div className="setting__control">
        <ControlFor setting={setting} session={session} />
      </div>

      <div className="setting__reset-slot">
        {changed && (
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--icon k-btn--sm"
            title="Reset to default"
            aria-label={`Reset ${setting.title} to its default`}
            onClick={() => session.reset(setting)}
          >
            <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The sentence under the control, or null when the change is already in force. */
function appliesNote(applies: SettingApplies): string | null {
  switch (applies.when) {
    case "now":
      return null;
    case "next":
      return `Applies to ${applies.what}.`;
    case "restart":
      return "Applies after a restart.";
  }
}
