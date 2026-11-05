/**
 * The skills Veistra ships, one card each: what the skill is, its mode, and
 * where every harness has it.
 *
 * A panel for the reason `McpPanel.tsx` gives: the install table is a list
 * Rust owns (`skills::list`), not a value. The mode *is* a setting, so it
 * stays one (`skills.<name>` in the schema) and is drawn here with the same
 * `SettingRow` every section uses. That keeps it searchable and resettable.
 * `SettingsScreen` leaves this section's rows to the panel so none is drawn
 * twice.
 */
import { useEffect, useState } from "react";
import SettingRow from "./SettingRow";
import {
  builtinSkills,
  onSettingsChanged,
  type BuiltinSkill,
  type SettingsGroup,
  type SkillInstall,
} from "../../bindings";
import type { SettingsSession } from "./useSettings";

export default function BuiltInSkillsPanel({
  group,
  session,
}: {
  group: SettingsGroup;
  session: SettingsSession;
}) {
  const [skills, setSkills] = useState<BuiltinSkill[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      builtinSkills()
        .then((next) => {
          if (live) setSkills(next);
        })
        .catch((err: unknown) =>
          console.error("veistra: could not read the built-in skills:", err),
        );
    void load();
    // A mode change installs or removes a copy, so the table follows it.
    const subscription = onSettingsChanged(() => void load());
    return () => {
      live = false;
      void subscription.then((unlisten) => {
        unlisten();
      });
    };
  }, []);

  if (skills === null) return null;

  return (
    <section className="settings-skills" aria-label="Built-in skills">
      {skills.map((skill) => {
        const setting = group.settings.find((s) => s.key === skill.settingKey);
        return (
          <article className="settings-skills__skill" key={skill.name} aria-label={skill.name}>
            {/* The row's title is the skill's name, so the card needs no heading. */}
            {setting === undefined ? (
              <h3 className="settings-skills__name">{skill.name}</h3>
            ) : (
              <SettingRow setting={setting} session={session} />
            )}
            <p className="settings-skills__description">{skill.description}</p>
            <ul className="settings-skills__installs" aria-label={`Where ${skill.name} is`}>
              {skill.installs.map((install) => (
                <li className="settings-skills__install" key={install.harness}>
                  <span className="settings-skills__harness">{install.name}</span>
                  <span>{installNote(install)}</span>
                  {install.path !== null && (
                    <span className="settings-skills__path">{install.path}</span>
                  )}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </section>
  );
}

/** One harness's line: how it gets the skill, and whether it has it now. */
function installNote(install: SkillInstall): string {
  switch (install.how) {
    case "plugin":
      return "Plugin folder, passed to each session that gets it";
    case "folder":
      return "Skills folder, passed to each session that gets it";
    case "hint":
      return "Named in the first prompt of each session that gets it";
    case "userSkills":
      switch (install.owner) {
        case "veistra":
          return "Installed in its skills folder by Veistra";
        case "user":
          return "Your own skill of this name is there, and Veistra leaves it alone";
        case "absent":
          return "Not installed yet; the first session that gets it installs it";
      }
  }
}
