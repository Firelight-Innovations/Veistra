/**
 * The View, Run and Help menus: every row acts, and the toggles say which state
 * the window is actually in.
 *
 * Two menus in one file because they are one claim — a row that renders live
 * does something — asserted over the two that have been reported for breaking
 * it (#41 for View, #40 for Run). Splitting them would mean two copies of the
 * `MenuHandlers` scaffolding `defaultMenus` requires.
 *
 * `defaultMenus` is a pure function of the handlers it is given, which is what
 * makes the menu testable with no DOM under it (STANDARDS.md §8.3). The bar
 * rebuilds it from live state on every render, so a `Menu[]` built here is the
 * same tree the dropdown would draw.
 *
 * The regression guarded is a row that renders live and silently does nothing —
 * a menu that lies, which `MenuItem.disabled` exists to prevent. It is asserted
 * over the whole menu rather than row by row, because it is stated once in
 * `defaultMenus`' header as a rule, and a rule nothing checks decays.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { MenuItem } from "../contract";
import {
  defaultMenus,
  type MenuHandlers,
  type RunMenuHandlers,
  type ViewMenuHandlers,
} from "./menus";

/** A `ViewMenuHandlers` whose six actions are spies, over a stated window state. */
type ViewSpies = ViewMenuHandlers & {
  commandPalette: Mock;
  toggleClusters: Mock;
  toggleTerminal: Mock;
  toggleFullscreen: Mock;
  zoomIn: Mock;
  zoomOut: Mock;
};

/**
 * The half of `ViewMenuHandlers` that is a *reading* rather than an action —
 * what the window is doing right now. Overriding only these keeps the six spies
 * spies: spreading a `Partial<ViewMenuHandlers>` over them would widen each one
 * back to a plain function and take `toHaveBeenCalled` with it.
 */
type ViewState = Pick<
  ViewMenuHandlers,
  "clustersShowing" | "terminalShowing" | "fullscreen" | "zoomInBlocked" | "zoomOutBlocked"
>;

function viewHandlers(state: Partial<ViewState> = {}): ViewSpies {
  return {
    commandPalette: vi.fn(),
    clustersShowing: false,
    toggleClusters: vi.fn(),
    terminalShowing: false,
    toggleTerminal: vi.fn(),
    fullscreen: false,
    toggleFullscreen: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    ...state,
  };
}

/**
 * The other six menus' handlers, inert. `defaultMenus` builds all seven from one
 * object, so a View test still has to hand it a whole `MenuHandlers` — none of
 * these is called, and a spy that is never invoked is the point.
 */
function otherHandlers(): Omit<MenuHandlers, "view"> {
  const commands = { run: vi.fn(), blocked: () => undefined };
  return {
    app: commands,
    edit: commands,
    apps: {
      available: [],
      open: vi.fn(),
      presets: {
        available: [],
        apply: vi.fn(),
        save: () => Promise.resolve(),
        suggestedName: "Cluster 1",
      },
    },
    file: { closeWindow: vi.fn() },
    run: { run: () => Promise.resolve(), interrupt: vi.fn() },
    terminal: {
      onNew: vi.fn(),
      onSplit: vi.fn(),
      onKill: vi.fn(),
      onClear: vi.fn(),
      enabled: true,
    },
    help: { checkForUpdates: vi.fn(), openDocumentation: vi.fn() },
  };
}

/** The View menu's rows, built against `view`. */
function viewMenu(view: ViewMenuHandlers): MenuItem[] {
  const menu = defaultMenus({ ...otherHandlers(), view }).find((one) => one.label === "View");
  if (menu === undefined) throw new Error("defaultMenus() built no View menu");
  return menu.items;
}

/** One row by label. Throws rather than returning `undefined`, so a renamed row
 *  fails on the row that is missing instead of on a null dereference later. */
function row(items: MenuItem[], label: string): MenuItem {
  const found = items.find((item) => item.label === label);
  if (found === undefined) {
    throw new Error(`no row labelled "${label}"; rows are ${labels(items).join(", ")}`);
  }
  return found;
}

const labels = (items: MenuItem[]): string[] => items.map((item) => item.label);

/** Build the menu in one state, pick one row, and click it. */
function select(state: Partial<ViewState>, label: string): ViewSpies {
  const view = viewHandlers(state);
  row(viewMenu(view), label).onSelect?.();
  return view;
}

describe("the View menu", () => {
  /**
   * The whole of issue #41 in one assertion: a row with no `onSelect` renders
   * live, closes the menu when clicked, and does nothing. Zoom is the shape a
   * row that cannot act is allowed to take — `disabled` with a `hint` — and it
   * still carries its handler, so this holds for all six.
   */
  it("gives every row something to do", () => {
    const items = viewMenu(viewHandlers());
    const inert = items.filter((item) => item.onSelect === undefined).map((item) => item.label);
    expect(inert).toEqual([]);
  });

  it("has the six rows the menu declares", () => {
    expect(labels(viewMenu(viewHandlers()))).toEqual([
      "Command Palette…",
      "Show Clusters",
      "Show Terminal",
      "Enter Full Screen",
      "Zoom In",
      "Zoom Out",
    ]);
  });

  it("opens the command palette", () => {
    expect(select({}, "Command Palette…").commandPalette).toHaveBeenCalledTimes(1);
  });
});

/**
 * The three toggles name the state they will move *to*, so the menu answers
 * "is it open?" without the user having to close it to find out. That
 * makes the label the whole of the state readout, and a label that stopped
 * following the flag would be the menu quietly lying about the window.
 *
 * Source control is the rail's Git page now, not a secondary panel, so the
 * first toggle reads whether that page is open.
 */
describe("the View menu's toggles", () => {
  it("offer to hide source control while the Git page is open", () => {
    const items = viewMenu(viewHandlers({ clustersShowing: true }));
    expect(labels(items)).toContain("Hide Clusters");
    expect(labels(items)).not.toContain("Show Clusters");
  });

  it("offer to show source control while the Git page is closed", () => {
    expect(labels(viewMenu(viewHandlers({ clustersShowing: false })))).toContain("Show Clusters");
  });

  it("flip source control from either state", () => {
    expect(select({ clustersShowing: true }, "Hide Clusters").toggleClusters).toHaveBeenCalled();
    expect(select({ clustersShowing: false }, "Show Clusters").toggleClusters).toHaveBeenCalled();
  });

  it("offer to hide the terminal only while it is showing", () => {
    expect(labels(viewMenu(viewHandlers({ terminalShowing: true })))).toContain("Hide Terminal");
    expect(labels(viewMenu(viewHandlers({ terminalShowing: false })))).toContain("Show Terminal");
  });

  it("flip the terminal from either state", () => {
    expect(select({ terminalShowing: true }, "Hide Terminal").toggleTerminal).toHaveBeenCalled();
    expect(select({ terminalShowing: false }, "Show Terminal").toggleTerminal).toHaveBeenCalled();
  });

  it("offer to leave full screen only while the window is in it", () => {
    expect(labels(viewMenu(viewHandlers({ fullscreen: true })))).toContain("Exit Full Screen");
    expect(labels(viewMenu(viewHandlers({ fullscreen: false })))).toContain("Enter Full Screen");
  });

  it("flip full screen from either state", () => {
    expect(select({ fullscreen: true }, "Exit Full Screen").toggleFullscreen).toHaveBeenCalled();
    expect(select({ fullscreen: false }, "Enter Full Screen").toggleFullscreen).toHaveBeenCalled();
  });
});

/**
 * Zoom is the one pair that can be unable to act — at the ends of the ladder,
 * and in a plain browser where there is no webview to scale. `zoomInBlocked`
 * and `zoomOutBlocked` answer both questions at once, and the rows have to keep
 * them together: a row disabled with no `hint` is a dead row with no
 * explanation, and a `hint` on a live row is a reason for nothing.
 */
describe("the View menu's zoom rows", () => {
  it("zoom the window when the ladder has somewhere to go", () => {
    const view = viewHandlers();
    const items = viewMenu(view);
    row(items, "Zoom In").onSelect?.();
    row(items, "Zoom Out").onSelect?.();
    expect(view.zoomIn).toHaveBeenCalledTimes(1);
    expect(view.zoomOut).toHaveBeenCalledTimes(1);
  });

  it("stay live while nothing blocks them", () => {
    const items = viewMenu(viewHandlers());
    for (const label of ["Zoom In", "Zoom Out"]) {
      expect(row(items, label).disabled).not.toBe(true);
      expect(row(items, label).hint).toBeUndefined();
    }
  });

  it("disable each direction independently, carrying its reason", () => {
    const items = viewMenu(viewHandlers({ zoomInBlocked: "Already at the largest size (250%)." }));
    expect(row(items, "Zoom In").disabled).toBe(true);
    expect(row(items, "Zoom In").hint).toBe("Already at the largest size (250%).");
    expect(row(items, "Zoom Out").disabled).toBe(false);
  });

  it("disable both when there is no webview to scale", () => {
    const nothing = "Zoom scales the desktop app's webview.";
    const items = viewMenu(viewHandlers({ zoomInBlocked: nothing, zoomOutBlocked: nothing }));
    expect(row(items, "Zoom In").disabled).toBe(true);
    expect(row(items, "Zoom Out").disabled).toBe(true);
  });
});

describe("the View menu's accelerators", () => {
  /**
   * Half of "bind it or drop it": every View row displays a keystroke. The
   * other half — that `useKeyboard` fires the row's action for it — cannot be
   * asserted from here. `CHORDS` lives in the `keys` region and STANDARDS.md
   * §1.2 forbids `titlebar` from reaching into it, in either direction. What
   * covers that edge instead is `keys/shortcuts.test.ts`, which holds the
   * shortcuts screen's View group against `CHORDS`; between the two, an
   * accelerator drawn here that nothing binds shows up as a row the screen
   * cannot account for.
   */
  it("are on every row, since each one has a keystroke", () => {
    const bare = viewMenu(viewHandlers())
      .filter((item) => item.accelerator === undefined)
      .map((item) => item.label);
    expect(bare).toEqual([]);
  });
});

/**
 * The Run menu, which is the whole of issue #40: three rows that opened a
 * dropdown and did nothing.
 *
 * Two invariants are worth more than the individual assertions. Every row that
 * renders live carries an `onSelect` or a `prompt` — the same "a menu must not
 * lie" rule the View suite opens with — and every row that cannot act is
 * `disabled` *with* a sentence saying why, because a dead row with no
 * explanation is the state this menu was reported in.
 */
type RunSpies = RunMenuHandlers & { run: Mock; interrupt: Mock };

function runHandlers(state: Partial<Pick<RunMenuHandlers, "last" | "blocked">> = {}): RunSpies {
  return {
    run: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(),
    ...state,
  };
}

/** The Run menu's rows, built against `run`. */
function runMenu(run: RunMenuHandlers): MenuItem[] {
  const menu = defaultMenus({ ...otherHandlers(), run, view: viewHandlers() }).find(
    (one) => one.label === "Run",
  );
  if (menu === undefined) throw new Error("defaultMenus() built no Run menu");
  return menu.items;
}

/** The one row that carries no `hint`, whatever state the menu is in. */
const NO_TERMINAL = "This cluster has no terminal to run a command in.";

describe("the Run menu", () => {
  it("has the three rows the menu declares, and no Run Active Tool", () => {
    expect(labels(runMenu(runHandlers()))).toEqual(["Run Command…", "Re-run Last", "Stop"]);
  });

  it("gives every live row something to do", () => {
    const inert = runMenu(runHandlers({ last: "pnpm verify" }))
      .filter((item) => item.disabled !== true)
      .filter((item) => item.onSelect === undefined && item.prompt === undefined)
      .map((item) => item.label);
    expect(inert).toEqual([]);
  });

  it("explains every row it disables", () => {
    for (const state of [{}, { blocked: NO_TERMINAL }]) {
      const unexplained = runMenu(runHandlers(state))
        .filter((item) => item.disabled === true && item.hint === undefined)
        .map((item) => item.label);
      expect(unexplained).toEqual([]);
    }
  });

  it("asks for the command in the menu rather than acting blind", () => {
    const prompt = row(runMenu(runHandlers()), "Run Command…").prompt;
    expect(prompt?.confirmLabel).toBe("Run");
    expect(prompt?.onSubmit).toBeDefined();
  });

  it("offers the last command back, so a re-run with an edit costs one keystroke", () => {
    const items = runMenu(runHandlers({ last: "cargo test" }));
    expect(row(items, "Run Command…").prompt?.initialValue).toBe("cargo test");
  });

  it("runs the command the field was submitted with", async () => {
    const run = runHandlers();
    await runMenu(run)
      .find((item) => item.prompt)
      ?.prompt?.onSubmit("pnpm build");
    expect(run.run).toHaveBeenCalledWith("pnpm build");
  });

  it("interrupts on Stop", () => {
    const run = runHandlers();
    row(runMenu(run), "Stop").onSelect?.();
    expect(run.interrupt).toHaveBeenCalledTimes(1);
  });
});

/**
 * Re-run is the row with two ways to be unable to act — no terminal, and
 * nothing run yet — and it has to stay honest about both. The second is the
 * state every window starts in, so a Re-run that rendered live there would be
 * the reported bug all over again in one row.
 */
describe("the Run menu's Re-run row", () => {
  it("names the command it would repeat", () => {
    expect(labels(runMenu(runHandlers({ last: "pnpm verify" })))).toContain("Re-run: pnpm verify");
  });

  it("re-runs it without asking again", () => {
    const run = runHandlers({ last: "pnpm verify" });
    row(runMenu(run), "Re-run: pnpm verify").onSelect?.();
    expect(run.run).toHaveBeenCalledWith("pnpm verify");
  });

  it("is disabled, with a reason, before anything has been run", () => {
    const item = row(runMenu(runHandlers()), "Re-run Last");
    expect(item.disabled).toBe(true);
    expect(item.hint).toBe("Nothing has been run yet.");
  });

  it("does nothing when clicked with no last command", () => {
    const run = runHandlers();
    row(runMenu(run), "Re-run Last").onSelect?.();
    expect(run.run).not.toHaveBeenCalled();
  });
});

/**
 * With no terminal in the cluster there is nowhere for a command to go, and
 * every row says so rather than one of them failing after the click.
 */
describe("the Run menu with no terminal", () => {
  it("disables all three rows and gives each the same reason", () => {
    const items = runMenu(runHandlers({ last: "pnpm verify", blocked: NO_TERMINAL }));
    expect(items.map((item) => item.disabled)).toEqual([true, true, true]);
    for (const item of items) expect(item.hint).toBe(NO_TERMINAL);
  });
});

/**
 * Help ▸ Documentation was the last inert row in any menu. It now opens Docs,
 * which reads veistra.com/docs live (`docs/docs-app.md`).
 */
describe("the Help menu", () => {
  const helpMenu = (help: MenuHandlers["help"]): MenuItem[] => {
    const menu = defaultMenus({ ...otherHandlers(), help, view: viewHandlers() }).find(
      (one) => one.label === "Help",
    );
    if (menu === undefined) throw new Error("defaultMenus() built no Help menu");
    return menu.items;
  };

  it("opens Docs from Documentation", () => {
    const help = { checkForUpdates: vi.fn(), openDocumentation: vi.fn() };
    row(helpMenu(help), "Documentation").onSelect?.();
    expect(help.openDocumentation).toHaveBeenCalledOnce();
    expect(help.checkForUpdates).not.toHaveBeenCalled();
  });

  it("gives every row something to do", () => {
    const items = helpMenu({ checkForUpdates: vi.fn(), openDocumentation: vi.fn() });
    const inert = items.filter((item) => item.onSelect === undefined).map((item) => item.label);
    expect(inert).toEqual([]);
  });
});
