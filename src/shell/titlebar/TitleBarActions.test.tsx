// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ToolPresentation } from "../contract";

// Which form the bar is in. The width it switches at is
// `useNarrowTitlebar.test.ts`'s to check; this file checks the two forms.
const layout = vi.hoisted(() => ({ collapsed: false }));
vi.mock("./useNarrowTitlebar", () => ({
  useCollapsedTitlebarActions: () => layout.collapsed,
}));

import TitleBarActions from "./TitleBarActions";

beforeEach(() => {
  layout.collapsed = false;
});

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof TitleBarActions>[0]> = {}) {
  const props = {
    onUpgrade: vi.fn(),
    onNewAgent: vi.fn(),
    terminalOpen: false,
    onToggleTerminal: vi.fn(),
    agentsOpen: false,
    onToggleAgents: vi.fn(),
    clustersOpen: true,
    onToggleClusters: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  };
  render(<TitleBarActions {...props} />);
  return props;
}

describe("TitleBarActions", () => {
  it("wires each button to its own action", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    fireEvent.click(screen.getByRole("button", { name: "New agent session" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(p.onUpgrade).toHaveBeenCalledTimes(1);
    expect(p.onNewAgent).toHaveBeenCalledTimes(1);
    expect(p.onToggleTerminal).toHaveBeenCalledTimes(1);
    expect(p.onToggleAgents).toHaveBeenCalledTimes(1);
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("has a Clusters button that toggles the list and shows its state", () => {
    const p = setup({ clustersOpen: false });
    const button = screen.getByRole("button", { name: /^Clusters/ });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(p.onToggleClusters).toHaveBeenCalledTimes(1);
  });

  it("shows the Clusters button pressed while the list is open", () => {
    setup({ clustersOpen: true });
    expect(screen.getByRole("button", { name: /^Clusters/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("disables New agent session when there is no cluster to open it in", () => {
    setup({ onNewAgent: undefined });
    expect(screen.getByRole("button", { name: "New agent session" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows the Agents button pressed while its page is open", () => {
    setup({ agentsOpen: true });
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("draws the tool-health badge before the buttons while a tool is unhealthy", () => {
    setup({ health: { tools: [tool("Godot", "needs-update")], onRescan: vi.fn() } });
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names[0]).toBe("1 tool needs attention");
  });
});

/** Each button, the overflow row standing for it in `setup`'s default state, and its handler. */
const ACTIONS = [
  { button: "Upgrade", row: "Upgrade", handler: "onUpgrade" },
  { button: "New agent session", row: "New agent session", handler: "onNewAgent" },
  { button: "Terminal", row: "Show Terminal", handler: "onToggleTerminal" },
  { button: "Agents", row: "Show Agents", handler: "onToggleAgents" },
  { button: "Clusters", row: "Hide Clusters", handler: "onToggleClusters" },
  { button: "Settings", row: "Settings", handler: "onOpenSettings" },
] as const;

/** How many times each action's handler has run. */
function calls(props: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    ACTIONS.map(({ handler }) => [
      handler,
      (props[handler] as Mock | undefined)?.mock.calls.length ?? 0,
    ]),
  );
}

function tool(name: string, health: ToolPresentation["health"]): ToolPresentation {
  return {
    id: name.toLowerCase(),
    name,
    description: "",
    health,
    interactive: true,
    isApp: false,
    placesWindow: false,
  };
}

function openOverflow() {
  fireEvent.click(screen.getByRole("button", { name: /^More actions/ }));
}

/** The menu row whose label is `label`, ignoring the shortcut drawn after it. */
function rowNamed(label: string): HTMLButtonElement {
  const rows = screen.getAllByRole("menuitem");
  const row = rows.find((r) => r.querySelector(".menu-list__label")?.textContent === label);
  if (!row) throw new Error(`no row "${label}" in: ${rows.map((r) => r.textContent).join(", ")}`);
  return row as HTMLButtonElement;
}

/** The shortcut a button names in its tooltip ("Clusters (Ctrl+B)"), or null. */
function buttonShortcut(name: string): string | null {
  return /\((.+)\)$/.exec(screen.getByRole("button", { name }).title)?.[1] ?? null;
}

describe("TitleBarActions in a narrow window", () => {
  beforeEach(() => {
    layout.collapsed = true;
  });

  it("draws one overflow button in place of the six", () => {
    setup();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["More actions"]);
    expect(buttons[0].getAttribute("aria-haspopup")).toBe("menu");
  });

  it("lists the six actions in the bar's order", () => {
    setup();
    openOverflow();
    const labels = screen
      .getAllByRole("menuitem")
      .map((r) => r.querySelector(".menu-list__label")?.textContent);
    expect(labels).toEqual(ACTIONS.map((a) => a.row));
  });

  it.each(ACTIONS)(
    "gives the $row row what the $button button does",
    ({ button, row, handler }) => {
      layout.collapsed = false;
      const wide = setup();
      fireEvent.click(screen.getByRole("button", { name: button }));
      cleanup();

      layout.collapsed = true;
      const narrow = setup();
      openOverflow();
      fireEvent.click(rowNamed(row));

      expect(calls(narrow)).toEqual(calls(wide));
      expect(calls(narrow)[handler]).toBe(1);
    },
  );

  it("shows each row's shortcut as its button does", () => {
    layout.collapsed = false;
    setup();
    const onButtons = Object.fromEntries(ACTIONS.map((a) => [a.row, buttonShortcut(a.button)]));
    cleanup();

    layout.collapsed = true;
    setup();
    openOverflow();
    const onRows = Object.fromEntries(
      ACTIONS.map((a) => [
        a.row,
        rowNamed(a.row).querySelector(".menu-list__accel")?.textContent ?? null,
      ]),
    );

    expect(onRows).toEqual(onButtons);
    // Not equal because both are empty: the three with a shortcut show it in both.
    expect(onRows).toMatchObject({
      "Show Terminal": "Ctrl+`",
      "Hide Clusters": "Ctrl+B",
      Settings: "Ctrl+,",
    });
  });

  it("says which way each toggle will go, as the View menu does", () => {
    setup({ terminalOpen: true, agentsOpen: true, clustersOpen: false });
    openOverflow();
    expect(rowNamed("Hide Terminal")).toBeTruthy();
    expect(rowNamed("Hide Agents")).toBeTruthy();
    expect(rowNamed("Show Clusters")).toBeTruthy();
  });

  it("disables New agent session when there is no cluster, and says why", () => {
    setup({ onNewAgent: undefined });
    openOverflow();
    const row = rowNamed("New agent session");
    expect(row.disabled).toBe(true);
    expect(row.closest("li")?.title).toBe("There is no cluster to open it in.");
  });

  it("carries the tool-health badge into the menu, with its Re-scan", () => {
    const onRescan = vi.fn();
    setup({
      health: { tools: [tool("Godot", "needs-update"), tool("Git", "ok")], onRescan },
    });
    const button = screen.getByRole("button", { name: "More actions, 1 tool needs attention" });
    expect(button.querySelector(".overflowmenu__dot")).not.toBeNull();

    openOverflow();
    const health = rowNamed("1 tool needs attention");
    expect(health.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(health);

    expect(rowNamed("Godot: needs update").disabled).toBe(true);
    expect(screen.queryByText(/^Git:/)).toBeNull();
    const rescan = rowNamed("Re-scan tools");
    expect(rescan.querySelector(".menu-list__accel")?.textContent).toBe("Ctrl+R");
    fireEvent.click(rescan);
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it("draws no health row and no dot while every tool is healthy", () => {
    setup({ health: { tools: [tool("Git", "ok")], onRescan: vi.fn() } });
    const button = screen.getByRole("button", { name: "More actions" });
    expect(button.querySelector(".overflowmenu__dot")).toBeNull();
    openOverflow();
    expect(screen.queryByText(/needs? attention/)).toBeNull();
  });
});
