import { describe, expect, it } from "vitest";
import { harnessChoices } from "./harnesses";
import type { HarnessInfo } from "./protocol.generated";

const CLAUDE: HarnessInfo = {
  harness: "claude",
  name: "Claude",
  hint: null,
  setup: {
    cli: "claude",
    signIn: "claude",
    cliInstall: "curl -fsSL https://claude.ai/install.sh | bash",
    adapterInstall: "",
    adapterVersion: "0.90.0",
  },
  capabilities: { steer: false, fork: false, modes: true },
  models: null,
  model: null,
};
const OPUS = { value: "opus", name: "Opus 5.5", description: null };
const SONNET = { value: "sonnet", name: "Sonnet 5.5", description: null };

/** The one choice for `id`. */
function of(listed: ReturnType<typeof harnessChoices>, id: string) {
  const found = listed.find((h) => h.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

describe("harnessChoices", () => {
  it("lists Veistra, Claude and Codex, and the ones the host does not run are coming soon", () => {
    const listed = harnessChoices([CLAUDE], "claude", null);
    expect(listed.map((h) => [h.name, h.unavailable])).toEqual([
      ["Veistra", "Coming soon"],
      ["Claude", null],
      ["Codex", "Coming soon"],
    ]);
  });

  it("lists Veistra as a choice once the host reports it, signed out or not", () => {
    const veistra: HarnessInfo = {
      ...CLAUDE,
      harness: "veistra",
      name: "Veistra",
      hint: "signedOut",
      setup: { ...CLAUDE.setup, cli: "veistra-agent", signIn: "veistra-agent login" },
    };
    const listed = harnessChoices([veistra, CLAUDE], "veistra", null);
    expect(listed.map((h) => [h.id, h.unavailable])).toEqual([
      ["veistra", null],
      ["claude", null],
      ["codex", "Coming soon"],
    ]);
  });

  it("takes the models the host scanned", () => {
    const scanned = { ...CLAUDE, models: [OPUS, SONNET], model: "opus" };
    expect(of(harnessChoices([scanned], null, null), "claude")).toMatchObject({
      models: [OPUS, SONNET],
      model: "opus",
    });
  });

  it("takes the running session's models for the harness in use, over the scan", () => {
    const scanned = { ...CLAUDE, models: [OPUS], model: "opus" };
    const running = { models: [OPUS, SONNET], model: "sonnet" };
    expect(of(harnessChoices([scanned], "claude", running), "claude")).toMatchObject(running);
  });

  it("follows the three with any other harness the host reports", () => {
    const other = { harness: "pi", hint: null } as unknown as HarnessInfo;
    const ids = harnessChoices([CLAUDE, other], "claude", null).map((h) => h.id);
    expect(ids).toEqual(["veistra", "claude", "codex", "pi"]);
  });

  it("never locks the harness in use, even before the host has answered", () => {
    const running = { models: [OPUS], model: "opus" };
    expect(of(harnessChoices([], "claude", running), "claude")).toEqual({
      id: "claude",
      name: "Claude",
      models: [OPUS],
      model: "opus",
      unavailable: null,
      note: null,
    });
  });

  it("keeps a harness the host cannot start yet a choice, marked as not set up", () => {
    const codex = { harness: "codex", hint: "harnessMissing" } as unknown as HarnessInfo;
    const missing = { ...CLAUDE, hint: "harnessMissing" } as HarnessInfo;
    const listed = harnessChoices([missing, codex], "claude", null);
    expect(listed.map((h) => [h.id, h.unavailable, h.note])).toEqual([
      ["veistra", "Coming soon", null],
      ["claude", null, "Not set up"],
      ["codex", null, "Not set up"],
    ]);
    // Its models are not known until it runs, so none are offered.
    expect(of(listed, "codex").models).toEqual([]);
  });

  it("names a harness the host reports by the registry's name", () => {
    const renamed = { ...CLAUDE, name: "Claude (beta)" };
    expect(of(harnessChoices([renamed], "claude", null), "claude").name).toBe("Claude (beta)");
  });

  it("reads a scan that has not run yet as no models", () => {
    const unscanned = { ...CLAUDE, models: null, model: null };
    expect(of(harnessChoices([unscanned], "claude", null), "claude").models).toEqual([]);
  });
});
