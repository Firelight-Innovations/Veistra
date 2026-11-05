// @vitest-environment jsdom
/**
 * Settings → Built-in skills: each skill's card, its mode, and where every
 * harness has it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BuiltinSkill, Setting, SettingsGroup, SettingValue } from "../../bindings";
import type { SettingsSession } from "./useSettings";

const builtinSkills = vi.fn<() => Promise<BuiltinSkill[]>>();

vi.mock("../../bindings", () => ({
  builtinSkills: () => builtinSkills(),
  onSettingsChanged: () => Promise.resolve(() => undefined),
  // The screen's sidebar reads the account; it never answers here.
  accountCall: () => new Promise(() => {}),
}));

const { default: BuiltInSkillsPanel } = await import("./BuiltInSkillsPanel");
const { default: SettingsScreen } = await import("./SettingsScreen");

const KEY = "skills.agent-ready-canvas";

const MODE = {
  key: KEY,
  title: "agent-ready-canvas",
  description: "Builds canvases out of named frames and groups.",
  control: {
    kind: "select",
    default: "auto",
    options: [
      { value: "auto", label: "Auto", description: "On for canvas work." },
      { value: "on", label: "On", description: "" },
      { value: "off", label: "Off", description: "" },
    ],
  },
  applies: { when: "next", what: "the next agent session" },
} as unknown as Setting;

const GROUP: SettingsGroup = {
  id: "skills",
  title: "Built-in skills",
  description: "Skills Veistra ships.",
  order: 62,
  settings: [MODE],
};

const SKILL: BuiltinSkill = {
  name: "agent-ready-canvas",
  description: "Structure every canvas so humans and agents can select whole objects.",
  settingKey: KEY,
  mode: "auto",
  installs: [
    {
      harness: "claude",
      name: "Claude",
      how: "plugin",
      path: "C:/data/built-in-skills/claude/agent-ready-canvas/skills/agent-ready-canvas",
      owner: "absent",
    },
    {
      harness: "codex",
      name: "Codex",
      how: "userSkills",
      path: "C:/Users/me/.codex/skills/agent-ready-canvas",
      owner: "veistra",
    },
  ],
};

function session(values: Record<string, SettingValue> = {}) {
  const set = vi.fn();
  const fake = {
    groups: [GROUP],
    valueOf: (setting: Setting) =>
      values[setting.key] ?? (setting.control as { default: SettingValue }).default,
    isChanged: (key: string) => key in values,
    changedIn: () => 0,
    set,
    reset: vi.fn(),
    resetGroup: vi.fn(),
    error: null,
    ready: true,
  } as unknown as SettingsSession;
  return { fake, set };
}

beforeEach(() => {
  vi.clearAllMocks();
  builtinSkills.mockResolvedValue([SKILL]);
});

afterEach(cleanup);

describe("BuiltInSkillsPanel", () => {
  it("shows each skill's name, description, mode and installs", async () => {
    const { fake } = session();
    render(<BuiltInSkillsPanel group={GROUP} session={fake} />);

    const card = await screen.findByRole("article", { name: "agent-ready-canvas" });
    expect(within(card).getByText("agent-ready-canvas")).toBeTruthy();
    expect(within(card).getByText(SKILL.description)).toBeTruthy();

    const mode = within(card).getByRole("radiogroup", { name: "agent-ready-canvas" });
    const auto = within(mode).getByRole("radio", { name: "Auto" });
    expect(auto.getAttribute("aria-checked")).toBe("true");

    const installs = within(card).getByRole("list", { name: "Where agent-ready-canvas is" });
    const rows = within(installs).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Claude");
    expect(rows[0].textContent).toContain("Plugin folder");
    expect(rows[1].textContent).toContain("Codex");
    expect(rows[1].textContent).toContain("Installed in its skills folder by Veistra");
    expect(rows[1].textContent).toContain(".codex/skills/agent-ready-canvas");
  });

  it("changes the mode through the setting", async () => {
    const { fake, set } = session();
    render(<BuiltInSkillsPanel group={GROUP} session={fake} />);

    const card = await screen.findByRole("article", { name: "agent-ready-canvas" });
    fireEvent.click(within(card).getByRole("radio", { name: "Off" }));
    expect(set).toHaveBeenCalledWith(MODE, "off");
  });

  it("says when a user's own skill of the same name is left alone", async () => {
    builtinSkills.mockResolvedValue([
      {
        ...SKILL,
        installs: [{ ...SKILL.installs[1], owner: "user" }],
      },
    ]);
    const { fake } = session();
    render(<BuiltInSkillsPanel group={GROUP} session={fake} />);
    expect(await screen.findByText(/Your own skill of this name is there/)).toBeTruthy();
  });

  it("is the section's only drawing of the mode row", async () => {
    const { fake } = session({ [KEY]: "on" });
    render(<SettingsScreen session={fake} landOn="skills" />);

    await screen.findByRole("article", { name: "agent-ready-canvas" });
    const modes = screen.getAllByRole("radiogroup", { name: "agent-ready-canvas" });
    expect(modes).toHaveLength(1);
    const on = within(modes[0]).getByRole("radio", { name: "On" });
    expect(on.getAttribute("aria-checked")).toBe("true");
  });
});
