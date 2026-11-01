/**
 * The three `telemetry.*` settings, read into one value and written back from
 * the first-run question.
 *
 * The descriptors are Rust's (`settings/schema.rs`, "usage data"); this is
 * their reader, which `docs/settings.md` §1 requires every setting to have.
 * Typed against the slice of the settings session it uses rather than the
 * session itself, which lives in the `settings` region and is not this
 * module's to import.
 */
import type { Setting, SettingValue, SettingsGroup } from "../../bindings";

export const USAGE_KEY = "telemetry.usageData";
export const REPLAY_KEY = "telemetry.sessionReplay";
export const PROMPTS_KEY = "telemetry.feedbackPrompts";

/** `ask` until somebody answers; nothing is sent in any state but `on`. */
export type UsageChoice = "ask" | "on" | "off";

export interface Consent {
  usage: UsageChoice;
  replay: boolean;
  prompts: boolean;
}

export interface SettingsReader {
  groups: SettingsGroup[];
  valueOf: (setting: Setting) => SettingValue;
  ready: boolean;
}

export interface SettingsWriter {
  groups: SettingsGroup[];
  set: (setting: Setting, value: SettingValue) => void;
}

function find(groups: SettingsGroup[], key: string): Setting | undefined {
  return groups.flatMap((group) => group.settings).find((setting) => setting.key === key);
}

/**
 * What the person has agreed to, or `null` until the settings have loaded.
 *
 * `null` rather than the defaults: the defaults say `ask`, and acting on that
 * before the real answer arrives would put the question to somebody who
 * already said no.
 */
export function readConsent(session: SettingsReader): Consent | null {
  if (!session.ready) return null;
  const usage = find(session.groups, USAGE_KEY);
  // A build whose schema lacks the group cannot have been asked. Treat it as
  // off rather than as a question, which there would be nowhere to store.
  if (!usage) return { usage: "off", replay: false, prompts: false };
  const value = session.valueOf(usage);
  const flag = (key: string) => {
    const setting = find(session.groups, key);
    return setting !== undefined && session.valueOf(setting) === true;
  };
  return {
    usage: value === "on" || value === "off" ? value : "ask",
    replay: flag(REPLAY_KEY),
    prompts: flag(PROMPTS_KEY),
  };
}

/** Store the first-run answer. Recording is its own switch, written only on a yes. */
export function answerConsent(
  session: SettingsWriter,
  answer: { share: true; replay: boolean } | { share: false },
): void {
  const usage = find(session.groups, USAGE_KEY);
  if (!usage) return;
  session.set(usage, answer.share ? "on" : "off");
  const replay = find(session.groups, REPLAY_KEY);
  if (answer.share && replay) session.set(replay, answer.replay);
}

/** Switch the corner prompts off — the card's "Don't ask me again". */
export function stopPrompts(session: SettingsWriter): void {
  const prompts = find(session.groups, PROMPTS_KEY);
  if (prompts) session.set(prompts, false);
}
