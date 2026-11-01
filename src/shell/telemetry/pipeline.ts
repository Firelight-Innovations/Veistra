/**
 * What happens to a feature event: it is sent (or not), counted (or not), and
 * may bring a prompt with it.
 *
 * Module state, one per window, driven by `useTelemetry`. The window that
 * shows a prompt must be the one somebody is looking at, so every prompt
 * decision starts by asking `document.hasFocus()` — two windows hearing the
 * same launch would otherwise both put up the same card.
 */
import { countUsage, recordPrompt, usageLedger, type UsageLedger } from "../../bindings";
import { analytics } from "./analytics";
import type { FeatureEvent } from "./bus";
import type { Consent } from "./consent";
import { eventName } from "./define";
import { submitFeedback } from "./feedback";
import { feedback } from "./features";
import { duePrompt } from "./prompts";
import { countedEvents, promptsOnEvent, promptsOnLaunch, type PromptRef } from "./registry";
import { sanitize } from "./sanitize";
import { closePrompt, currentSurface, showPrompt } from "./surface";

const COUNTED = countedEvents();

let consent: Consent | null = null;
let shownThisLaunch = false;

export function setPipelineConsent(next: Consent | null): void {
  consent = next;
}

/** Whether prompts may be considered at all right now. */
function promptsAllowed(): boolean {
  return analytics.status() === "on" && consent?.prompts === true;
}

export function handleFeatureEvent({ feature, event, props }: FeatureEvent): void {
  const key = eventName(feature, event);
  // `feature` is the reporter and always wins, so a breakdown by it is never
  // split by a property that happened to share the name. A feedback event says
  // which feature it is *about* in `about`.
  analytics.capture(key, { ...sanitize(props), feature });
  // Counted only while sharing is on: a person who said no should not find a
  // tally of what they did in a file on their own disk, sent or not.
  if (!COUNTED.has(key) || !promptsAllowed()) return;
  void countUsage(key)
    .then((ledger) => consider(promptsOnEvent(key), ledger))
    .catch((err: unknown) => console.error("veistra: could not count", key, err));
}

/** The launch prompts, once per window, some time after it opened. */
export function considerLaunchPrompts(): void {
  if (!promptsAllowed()) return;
  void usageLedger()
    .then((ledger) => consider(promptsOnLaunch(), ledger))
    .catch((err: unknown) => console.error("veistra: could not read the usage ledger:", err));
}

function consider(candidates: PromptRef[], ledger: UsageLedger): void {
  if (!promptsAllowed() || !document.hasFocus()) return;
  const open = currentSurface();
  if (open.dialog || open.prompt) return;
  const due = duePrompt({ candidates, ledger, now: Date.now(), shownThisLaunch });
  if (!due) return;
  shownThisLaunch = true;
  void recordPrompt(due.prompt.id, "shown").catch((err: unknown) =>
    console.error("veistra: could not record a prompt:", err),
  );
  feedback.track("prompt_shown", { prompt: due.prompt.id, about: due.feature.id });
  showPrompt(due);
}

/**
 * The card's Send. The answer is sent first and recorded second, so a send
 * that fails leaves the prompt unanswered and the card open to try again.
 */
export async function answerPrompt(
  ref: PromptRef,
  answer: { rating?: number; message: string },
): Promise<void> {
  await submitFeedback({
    source: "prompt",
    feature: ref.feature.id,
    prompt: ref.prompt.id,
    rating: answer.rating,
    message: answer.message,
  });
  await recordPrompt(ref.prompt.id, "answered");
  closePrompt();
}

/** The card's close button. Nothing is recorded beyond its having been shown. */
export function dismissPrompt(ref: PromptRef): void {
  feedback.track("prompt_dismissed", { prompt: ref.prompt.id, about: ref.feature.id });
  closePrompt();
}
