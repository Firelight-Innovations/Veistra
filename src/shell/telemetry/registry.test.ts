import { describe, expect, it } from "vitest";
import { defineFeature, type Feature } from "./define";
import { FEATURES } from "./features";
import {
  countedEvents,
  featureForApp,
  promptById,
  promptsOnEvent,
  promptsOnLaunch,
} from "./registry";

/** The rule `telemetry::check_name` applies to a ledger key, restated. */
const LEDGER_NAME = /^[a-z0-9][a-z0-9_:/.-]{0,95}$/;

describe("the feature registry", () => {
  it("gives every feature a unique kebab-case id", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("names every event in snake_case, once per feature", () => {
    for (const feature of FEATURES) {
      expect(new Set(feature.events).size, feature.id).toBe(feature.events.length);
      for (const event of feature.events) expect(event, feature.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every prompt a unique id the ledger will accept, under its feature", () => {
    const ids = FEATURES.flatMap((f) => (f.prompts ?? []).map((p) => [f.id, p.id] as const));
    expect(new Set(ids.map(([, id]) => id)).size).toBe(ids.length);
    for (const [feature, id] of ids) {
      expect(id).toMatch(LEDGER_NAME);
      expect(id.startsWith(`${feature}/`), id).toBe(true);
    }
  });

  it("waits each prompt on an event its own feature declares, or on launches", () => {
    for (const feature of FEATURES) {
      for (const prompt of feature.prompts ?? []) {
        const after = prompt.after;
        if ("event" in after) expect(feature.events, prompt.id).toContain(after.event);
        else expect(after.launches, prompt.id).toBeGreaterThan(0);
      }
    }
  });

  it("lets no app report for two features", () => {
    const apps = FEATURES.flatMap((f) => f.apps ?? []);
    expect(new Set(apps).size).toBe(apps.length);
  });

  it("counts only the events a prompt waits on, under names the ledger will accept", () => {
    for (const key of countedEvents()) expect(key).toMatch(LEDGER_NAME);
    expect(countedEvents()).toContain("agent-tab:prompt_sent");
    expect(countedEvents()).not.toContain("shell:app_loaded");
  });
});

describe("lookups", () => {
  const canvas = defineFeature({
    id: "canvas",
    name: "Canvas",
    apps: ["canvas"],
    events: ["opened", "drawn"],
    prompts: [
      { id: "canvas/a", question: "?", after: { event: "drawn", count: 3 } },
      { id: "canvas/b", question: "?", after: { launches: 2 } },
    ],
  });
  const features: Feature[] = [canvas];

  it("finds the feature an app reports for", () => {
    expect(featureForApp("canvas", features)?.id).toBe("canvas");
    expect(featureForApp("files", features)).toBeUndefined();
  });

  it("splits prompts by what they wait on", () => {
    expect(promptsOnEvent("canvas:drawn", features).map((r) => r.prompt.id)).toEqual(["canvas/a"]);
    expect(promptsOnEvent("canvas:opened", features)).toEqual([]);
    expect(promptsOnLaunch(features).map((r) => r.prompt.id)).toEqual(["canvas/b"]);
    expect(promptById("canvas/b", features)?.feature).toBe(canvas);
  });
});
