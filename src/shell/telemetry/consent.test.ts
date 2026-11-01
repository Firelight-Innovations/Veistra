import { describe, expect, it, vi } from "vitest";
import type { Setting, SettingValue, SettingsGroup } from "../../bindings";
import {
  PROMPTS_KEY,
  REPLAY_KEY,
  USAGE_KEY,
  answerConsent,
  readConsent,
  stopPrompts,
} from "./consent";

function setting(key: string, value: boolean | string): Setting {
  const control: Setting["control"] =
    typeof value === "boolean"
      ? { kind: "toggle", default: value }
      : { kind: "select", default: value, options: [] };
  return { key, title: key, description: "", control, applies: { when: "now" } };
}

const GROUP: SettingsGroup = {
  id: "telemetry",
  title: "Usage data",
  description: "",
  order: 55,
  settings: [setting(USAGE_KEY, "ask"), setting(REPLAY_KEY, true), setting(PROMPTS_KEY, true)],
};

function session(values: Record<string, SettingValue> = {}, ready = true) {
  return {
    groups: [GROUP],
    ready,
    valueOf: (s: Setting) => values[s.key] ?? s.control.default,
    set: vi.fn(),
  };
}

describe("readConsent", () => {
  it("is null until the settings have loaded, so nobody is asked twice", () => {
    expect(readConsent(session({}, false))).toBeNull();
  });

  it("starts unasked, with both switches at their defaults", () => {
    expect(readConsent(session())).toEqual({ usage: "ask", replay: true, prompts: true });
  });

  it("reads an answer and the switches as they stand", () => {
    expect(readConsent(session({ [USAGE_KEY]: "on", [REPLAY_KEY]: false }))).toEqual({
      usage: "on",
      replay: false,
      prompts: true,
    });
  });

  it("treats a value it does not know as unasked, never as on", () => {
    expect(readConsent(session({ [USAGE_KEY]: "yes" }))?.usage).toBe("ask");
  });

  it("is off when this build's schema has no usage data group", () => {
    expect(readConsent({ groups: [], ready: true, valueOf: () => "on" })).toEqual({
      usage: "off",
      replay: false,
      prompts: false,
    });
  });
});

describe("writing the answer", () => {
  it("stores a yes with its recording choice", () => {
    const s = session();
    answerConsent(s, { share: true, replay: false });
    expect(s.set.mock.calls.map(([d, v]) => [d.key, v])).toEqual([
      [USAGE_KEY, "on"],
      [REPLAY_KEY, false],
    ]);
  });

  it("stores a no and leaves the recording switch alone", () => {
    const s = session();
    answerConsent(s, { share: false });
    expect(s.set.mock.calls.map(([d, v]) => [d.key, v])).toEqual([[USAGE_KEY, "off"]]);
  });

  it("switches the prompts off for good", () => {
    const s = session();
    stopPrompts(s);
    expect(s.set.mock.calls.map(([d, v]) => [d.key, v])).toEqual([[PROMPTS_KEY, false]]);
  });
});
