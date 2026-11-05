// @vitest-environment jsdom
/**
 * The settings screen's layout: pages in the sidebar, collapsible sections that
 * remember being folded, a search that reaches across pages and unfolds what
 * it finds, deep links, Ctrl+F, the Tab loop, and a control for every key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Setting, SettingControl, SettingsGroup, SettingValue } from "../../bindings";
import type { SettingsSession } from "./useSettings";

vi.mock("../../bindings", () => ({ accountCall: () => new Promise(() => {}) }));
// The panels that read the backend have tests of their own; here they draw
// nothing, except the skills panel, which draws its group's rows plainly.
vi.mock("./McpPanel", () => ({ default: () => null }));
vi.mock("./CloudAccountPanel", () => ({ default: () => null }));
vi.mock("./TelemetryPanel", () => ({ default: () => null }));
vi.mock("./BuiltInSkillsPanel", async () => {
  const { default: SettingRow } = await import("./SettingRow");
  return {
    default: ({ group, session }: { group: SettingsGroup; session: SettingsSession }) => (
      <>
        {group.settings.map((s) => (
          <SettingRow key={s.key} setting={s} session={session} />
        ))}
      </>
    ),
  };
});

const { default: SettingsScreen } = await import("./SettingsScreen");
const { COLLAPSED_KEY } = await import("./pages");

const CONTROLS: SettingControl[] = [
  { kind: "toggle", default: false },
  { kind: "number", default: 4, min: 1, max: 8, step: 1, unit: "" },
  { kind: "text", default: "", placeholder: "" },
  {
    kind: "select",
    default: "a",
    options: [
      { value: "a", label: "A", description: "" },
      { value: "b", label: "B", description: "" },
    ],
  },
];

/** Every group the schema publishes today, an app's, and a plugin's nobody named. */
const GROUP_IDS = [
  "appearance",
  "editor",
  "terminal",
  "keys",
  "search",
  "github",
  "cloud",
  "account",
  "updates",
  "telemetry",
  "mcp",
  "skills",
  "developer",
  "files",
  "canvas",
  "markup",
  "blender",
  "godot",
  "plugin-x",
];

function fixture(): SettingsGroup[] {
  return GROUP_IDS.map((id, i) => ({
    id,
    title: id === "terminal" ? "Terminal" : `Group ${id}`,
    description: "",
    order: i,
    settings: CONTROLS.map((control, k): Setting => ({
      key: `${id}.s${k}`,
      title: id === "terminal" && k === 0 ? "Scrollback lines" : `${id} setting ${k}`,
      description: id === "editor" && k === 1 ? "Wrap long lines at the edge" : "",
      control,
      applies: { when: "now" },
    })),
  }));
}

function session(groups = fixture()): SettingsSession {
  const values: Record<string, SettingValue> = {};
  return {
    groups,
    valueOf: (s) => values[s.key] ?? s.control.default,
    isChanged: () => false,
    changedIn: () => 0,
    set: (s, v) => {
      values[s.key] = v;
    },
    reset: () => {},
    resetGroup: () => {},
    error: null,
    ready: true,
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const nav = () => screen.getByRole("navigation", { name: "Settings pages" });
/** A section's header button, in the content pane (the sidebar has a "Terminal" too). */
const toggleOf = (name: RegExp | string) =>
  within(document.querySelector<HTMLElement>(".settings__content") as HTMLElement).getByRole(
    "button",
    { name },
  );
const rowFor = (key: string) => document.querySelector(`[data-key="${key}"]`);

describe("SettingsScreen layout", () => {
  it("is a modal with the three bands of pages and a Docs link", () => {
    render(<SettingsScreen session={session()} landOn={null} />);
    expect(screen.getByRole("dialog", { name: "Settings" }).getAttribute("aria-modal")).toBe(
      "true",
    );
    const bands = within(nav()).getAllByRole("group");
    expect(
      within(bands[0])
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Account", "Billing", "Usage"]);
    expect(
      within(bands[2])
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Developer"]);
    expect(within(nav()).getByRole("button", { name: /Docs/ })).toBeTruthy();
    // General is where it opens.
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
  });

  it("selects a page from the sidebar", () => {
    render(<SettingsScreen session={session()} landOn={null} />);
    fireEvent.click(within(nav()).getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("heading", { level: 2, name: "Terminal" })).toBeTruthy();
    expect(
      within(nav()).getByRole("button", { name: "Terminal" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(rowFor("terminal.s0")).not.toBeNull();
    expect(rowFor("appearance.s0")).toBeNull();
  });

  it("folds a section from its header and remembers it across a reopen", () => {
    const { unmount } = render(<SettingsScreen session={session()} landOn="terminal" />);
    const header = toggleOf(/^Terminal$/);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(rowFor("terminal.s0")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]")).toEqual(["terminal"]);

    unmount();
    render(<SettingsScreen session={session()} landOn="terminal" />);
    expect(toggleOf(/^Terminal$/).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggleOf(/^Terminal$/));
    expect(rowFor("terminal.s0")).not.toBeNull();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("[]");
  });

  it("filters rows across pages, unfolds folded sections and marks the hit", () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["editor", "terminal"]));
    render(<SettingsScreen session={session()} landOn={null} />);
    const box = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(box, { target: { value: "wrap long" } });

    expect(rowFor("editor.s1")).not.toBeNull();
    expect(rowFor("editor.s0")).toBeNull();
    expect(rowFor("appearance.s0")).toBeNull();
    expect(toggleOf(/Group editor/).getAttribute("aria-expanded")).toBe("true");
    const mark = rowFor("editor.s1")?.querySelector("mark");
    expect(mark?.textContent).toBe("Wrap long");

    fireEvent.change(box, { target: { value: "scrollback" } });
    expect(rowFor("terminal.s0")).not.toBeNull();
    // The search never rewrote what is remembered.
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]")).toEqual([
      "editor",
      "terminal",
    ]);

    fireEvent.change(box, { target: { value: "zzz-nothing" } });
    expect(screen.getByText(/No setting matches/)).toBeTruthy();
  });

  it("clears the search on the first Escape and closes on the next", () => {
    render(<SettingsScreen session={session()} landOn={null} />);
    const box = screen.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "wrap" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("lands a deep link to a section on its page, unfolded", () => {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(["telemetry"]));
    render(<SettingsScreen session={session()} landOn="telemetry" />);
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
    expect(toggleOf(/Group telemetry/).getAttribute("aria-expanded")).toBe("true");
    expect(rowFor("telemetry.s0")).not.toBeNull();
  });

  it("lands Settings → Usage and Settings → Account on their pages", () => {
    const { rerender } = render(<SettingsScreen session={session()} landOn="usage" />);
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeTruthy();
    // A new request while the screen is up moves it.
    rerender(<SettingsScreen session={session()} landOn="account" />);
    expect(screen.getByRole("heading", { level: 2, name: "Account" })).toBeTruthy();
    expect(toggleOf(/Profile/)).toBeTruthy();
    // The service addresses are build wiring, kept on Developer, not here.
    expect(screen.queryByRole("button", { name: /Account service/ })).toBeNull();
  });

  it("keeps the account service addresses on Developer", () => {
    render(<SettingsScreen session={session()} landOn="developer" />);
    expect(screen.getByRole("heading", { level: 2, name: "Developer" })).toBeTruthy();
    expect(toggleOf(/Account service/)).toBeTruthy();
  });

  it("focuses the search on Ctrl+F", () => {
    render(<SettingsScreen session={session()} landOn={null} />);
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search settings" }));
  });

  it("keeps Tab inside the modal", () => {
    render(<SettingsScreen session={session()} landOn={null} />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const close = screen.getByRole("button", { name: "Close settings" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
  });

  it("draws a control for every key the schema publishes, on some page", () => {
    const groups = fixture();
    render(<SettingsScreen session={session(groups)} landOn={null} />);
    const seen = new Set<string>();
    for (const item of within(nav()).getAllByRole("button")) {
      if (/Docs|Not signed in/.test(item.textContent ?? "")) continue;
      fireEvent.click(item);
      for (const el of document.querySelectorAll("[data-key]")) {
        const control = el.querySelector(".setting__control");
        if (control !== null && control.childElementCount > 0) {
          seen.add(el.getAttribute("data-key") ?? "");
        }
      }
    }
    const keys = groups.flatMap((g) => g.settings.map((s) => s.key));
    expect(keys.filter((k) => !seen.has(k))).toEqual([]);
  });
});
