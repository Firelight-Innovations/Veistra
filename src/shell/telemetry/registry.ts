/**
 * Questions asked of the feature list, answered in one place so the pipeline,
 * the bridge handler and the dialogs cannot disagree about the answers.
 */
import { eventName, type Feature, type PromptSpec } from "./define";
import { FEATURES } from "./features";

/** A prompt, with the feature that asks it. */
export interface PromptRef {
  feature: Feature;
  prompt: PromptSpec;
}

export function featureById(id: string, features = FEATURES): Feature | undefined {
  return features.find((feature) => feature.id === id);
}

/** The feature an app's frames report for, if any. */
export function featureForApp(appId: string, features = FEATURES): Feature | undefined {
  return features.find((feature) => feature.apps?.includes(appId) === true);
}

export function allPrompts(features = FEATURES): PromptRef[] {
  return features.flatMap((feature) =>
    (feature.prompts ?? []).map((prompt) => ({ feature, prompt })),
  );
}

export function promptById(id: string, features = FEATURES): PromptRef | undefined {
  return allPrompts(features).find((ref) => ref.prompt.id === id);
}

/**
 * The `"<feature>:<event>"` keys some prompt is waiting on — the only events
 * worth a round trip to the ledger. Everything else is sent and forgotten.
 */
export function countedEvents(features = FEATURES): Set<string> {
  const keys = new Set<string>();
  for (const { feature, prompt } of allPrompts(features)) {
    if ("event" in prompt.after) keys.add(eventName(feature.id, prompt.after.event));
  }
  return keys;
}

/** Prompts that wait on this event, in registry order. */
export function promptsOnEvent(key: string, features = FEATURES): PromptRef[] {
  return allPrompts(features).filter(
    ({ feature, prompt }) =>
      "event" in prompt.after && eventName(feature.id, prompt.after.event) === key,
  );
}

/** Prompts that wait on launches, in registry order. */
export function promptsOnLaunch(features = FEATURES): PromptRef[] {
  return allPrompts(features).filter(({ prompt }) => "launches" in prompt.after);
}
