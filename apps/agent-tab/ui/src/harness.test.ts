import { describe, expect, it } from "vitest";
import { hintText, infoOf } from "./harness";
import type { HarnessInfo, Hint } from "./protocol.generated";

/**
 * A harness the registry might list one day, so no sentence can hide behind
 * Claude's words. Its id is Claude's only because `Harness` has one variant.
 */
const PI: HarnessInfo = {
  harness: "claude",
  name: "Pi",
  hint: "signedOut",
  setup: {
    cli: "pi",
    signIn: "pi login",
    cliInstall: "npm i -g pi",
    adapterInstall: "npm i -g --omit=optional pi-acp@1.2.3",
    adapterVersion: "1.2.3",
  },
  capabilities: { steer: false, fork: false, modes: true },
  models: null,
  model: null,
};

describe("hint sentences", () => {
  it("name the harness and its own setup commands", () => {
    expect(hintText("harnessMissing", PI)).toContain("Pi is not installed");
    expect(hintText("harnessMissing", PI)).toContain("`pi login`");
    expect(hintText("signedOut", PI)).toContain("Pi is not signed in. Run `pi login`");
    expect(hintText("adapterMissing", PI)).toContain("The Pi ACP adapter");
    expect(hintText("adapterMissing", PI)).toContain("`npm i -g --omit=optional pi-acp@1.2.3`");
    expect(hintText("adapterVersion", PI)).toContain("tested with adapter 1.2.3");
  });

  it("never name Claude for another harness", () => {
    for (const hint of [
      "harnessMissing",
      "adapterMissing",
      "signedOut",
      "adapterVersion",
    ] as const) {
      expect(hintText(hint, PI)).not.toMatch(/claude/i);
    }
  });

  it("stay neutral before the tab knows the harness", () => {
    expect(hintText("signedOut", undefined)).toBe("The agent is not ready to run.");
  });

  it("stay neutral for a hint this build does not know", () => {
    expect(hintText("rateLimited" as Hint, PI)).toBe("The agent is not ready to run.");
    expect(hintText("toString" as Hint, PI)).toBe("The agent is not ready to run.");
  });
});

describe("the registry's answer", () => {
  it("finds a harness's info by its id, and nothing for none", () => {
    expect(infoOf([PI], "claude")).toBe(PI);
    expect(infoOf([PI], null)).toBeUndefined();
  });
});
