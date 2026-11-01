/**
 * The harnesses the settings menu lists, each with the models it offers.
 * The menu shows Veistra, Claude and Codex in that order: Veistra, our own
 * harness, first. One the host does not report reads "Coming soon", as
 * Veistra does until its descriptor lands in the registry. One the host
 * reports but cannot start, such as one not installed, can still be chosen:
 * the tab then offers to install it. The harness in use is never locked, even
 * before the host's answer arrives.
 */
import type { HarnessInfo } from "./protocol.generated";
import type { HarnessChoice, PickerChoice } from "./components/types";
import { strings } from "./strings";

/** The menu's order. A harness the host reports beyond these follows them. */
export const HARNESSES = ["veistra", "claude", "codex"];

/** The running session's model setting: what it offers and what it runs. */
export interface RunningModel {
  models: PickerChoice[];
  model: string | null;
}

/**
 * Every harness, with its models. The one in use takes them from its running
 * session when there is one, since that is what the agent actually offers;
 * the rest take what the host scanned, or none.
 */
export function harnessChoices(
  reported: readonly HarnessInfo[],
  current: string | null,
  running: RunningModel | null,
): HarnessChoice[] {
  const ids = [...HARNESSES, ...reported.map((h) => h.harness as string)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  return ids.map((id) => {
    const info = reported.find((h) => h.harness === id);
    // The registry's own name for a harness it reports; the menu's for the rest.
    const name = info?.name ?? strings.harnessName[id] ?? id;
    const inUse = id === current;
    const live = inUse ? running : null;
    // The one in use is running, or about to: whatever the host has said so far.
    const unavailable = inUse || info ? null : strings.harnessSoon;
    // Not installed, or missing its adapter: still a choice, which the tab
    // follows with its install card.
    const notReady = info?.hint != null && !live;
    return {
      id,
      name,
      models: unavailable === null && !notReady ? (live?.models ?? info?.models ?? []) : [],
      model: live ? live.model : (info?.model ?? null),
      unavailable,
      note: notReady ? strings.harnessNotReady : null,
    };
  });
}
