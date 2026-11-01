import { describe, expect, it } from "vitest";
import type { UsageLedger } from "../../bindings";
import { defineFeature } from "./define";
import { RULES, duePrompt } from "./prompts";
import { allPrompts } from "./registry";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const canvas = defineFeature({
  id: "canvas",
  name: "Canvas",
  events: ["drawn"],
  prompts: [
    { id: "canvas/drawn", question: "?", after: { event: "drawn", count: 3 } },
    { id: "canvas/week", question: "?", after: { launches: 5 }, minDaysInstalled: 7 },
  ],
});
const [ON_EVENT, ON_LAUNCH] = allPrompts([canvas]);

function ledger(over: Partial<UsageLedger> = {}): UsageLedger {
  return {
    installId: "id",
    firstSeenMs: NOW - 30 * DAY,
    launches: 10,
    counts: { "canvas:drawn": 3 },
    prompts: {},
    ...over,
  };
}

const due = (l: UsageLedger, shownThisLaunch = false, candidates = [ON_EVENT]) =>
  duePrompt({ candidates, ledger: l, now: NOW, shownThisLaunch })?.prompt.id ?? null;

describe("duePrompt", () => {
  it("is due once the event has happened often enough", () => {
    expect(due(ledger())).toBe("canvas/drawn");
    expect(due(ledger({ counts: { "canvas:drawn": 2 } }))).toBeNull();
  });

  it("waits on launches and on the install's age together", () => {
    expect(due(ledger(), false, [ON_LAUNCH])).toBe("canvas/week");
    expect(due(ledger({ launches: 4 }), false, [ON_LAUNCH])).toBeNull();
    expect(due(ledger({ firstSeenMs: NOW - 6 * DAY }), false, [ON_LAUNCH])).toBeNull();
    expect(due(ledger({ firstSeenMs: 0 }), false, [ON_LAUNCH])).toBeNull();
  });

  it("never asks a question that has been answered", () => {
    const answered = { shown: 1, lastShownMs: NOW - 90 * DAY, answeredMs: NOW - 90 * DAY };
    expect(due(ledger({ prompts: { "canvas/drawn": answered } }))).toBeNull();
  });

  it("asks a dismissed question again only after the pause, and only once more", () => {
    const once = (daysAgo: number, shown = 1) => ({
      prompts: { "canvas/drawn": { shown, lastShownMs: NOW - daysAgo * DAY, answeredMs: null } },
    });
    expect(due(ledger(once(RULES.retryAfterDays - 1)))).toBeNull();
    expect(due(ledger(once(RULES.retryAfterDays)))).toBe("canvas/drawn");
    expect(due(ledger(once(90, RULES.maxShows)))).toBeNull();
  });

  it("shows one card per launch, and none within days of any other", () => {
    expect(due(ledger(), true)).toBeNull();
    const other = { shown: 1, lastShownMs: NOW - DAY, answeredMs: NOW - DAY };
    expect(due(ledger({ prompts: { "general/x": other } }))).toBeNull();
    const longAgo = { ...other, lastShownMs: NOW - RULES.minGapDays * DAY };
    expect(due(ledger({ prompts: { "general/x": longAgo } }))).toBe("canvas/drawn");
  });

  it("takes candidates in order, skipping any that are not due", () => {
    const l = ledger({ counts: {} });
    expect(due(l, false, [ON_EVENT, ON_LAUNCH])).toBe("canvas/week");
  });
});
