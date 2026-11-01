/**
 * Whether a feedback prompt is due, decided from the ledger alone.
 *
 * Pure, so the rules are tests rather than a week of launches. The caller
 * narrows the candidates to the moment — the prompts on the event that just
 * happened, or the launch prompts at startup — so a question is asked while
 * the thing it is about is still on screen, never about something else.
 *
 * The rules are for the person, not the dataset. One card per launch, none
 * within days of the last, an answer ends a question for good, and a dismissal
 * earns a long pause and then one more try. A prompt that nags gets answered
 * with the lowest rating there is, and that number is worse than none.
 */
import type { UsageLedger } from "../../bindings";
import { eventName } from "./define";
import type { PromptRef } from "./registry";

const DAY = 24 * 60 * 60 * 1000;

export const RULES = {
  /** No prompt within this long of the previous one, whichever it was. */
  minGapDays: 3,
  /** A dismissed prompt waits this long before it may be shown again. */
  retryAfterDays: 21,
  /** Shown this many times without an answer, a prompt is retired. */
  maxShows: 2,
} as const;

export interface DueInput {
  candidates: readonly PromptRef[];
  ledger: UsageLedger;
  now: number;
  /** Whether this window has already shown a prompt since it opened. */
  shownThisLaunch: boolean;
}

/** The first candidate that may be shown now, or `null`. */
export function duePrompt({
  candidates,
  ledger,
  now,
  shownThisLaunch,
}: DueInput): PromptRef | null {
  if (shownThisLaunch) return null;
  const lastAny = Math.max(0, ...Object.values(ledger.prompts).map((r) => r.lastShownMs ?? 0));
  if (now - lastAny < RULES.minGapDays * DAY) return null;
  return candidates.find((ref) => eligible(ref, ledger, now)) ?? null;
}

function eligible({ feature, prompt }: PromptRef, ledger: UsageLedger, now: number): boolean {
  const record = ledger.prompts[prompt.id];
  if (record?.answeredMs != null) return false;
  if ((record?.shown ?? 0) >= RULES.maxShows) return false;
  if (record?.lastShownMs != null && now - record.lastShownMs < RULES.retryAfterDays * DAY) {
    return false;
  }
  const days = prompt.minDaysInstalled ?? 0;
  if (days > 0 && (ledger.firstSeenMs === 0 || now - ledger.firstSeenMs < days * DAY)) return false;
  const after = prompt.after;
  if ("launches" in after) return ledger.launches >= after.launches;
  return (ledger.counts[eventName(feature.id, after.event)] ?? 0) >= after.count;
}
