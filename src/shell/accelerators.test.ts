/**
 * Nothing this app draws is written in Mac key glyphs.
 *
 * Veistra has never run on macOS, and the ⌘/⌥/⌃ forms it shipped with came from a
 * design handoff drawn on one. They were removed by hand; this is what keeps
 * them out, because the failure they cause is not a crash — it is a Windows
 * user reading `⌘K` and having no key to press. The two tables that hold
 * accelerators as literals (`titlebar/menus.ts`, `keys/shortcuts.ts`) are both
 * walked here rather than made to call `accelerator()`, which is the trade
 * `accelerators.ts` describes.
 *
 * Directly under `src/shell/` rather than beside either table, because it reads
 * both and §1.2 forbids one region reaching into another. `accelerators.ts` is
 * here for the same reason: four regions import it.
 */
import { describe, expect, it } from "vitest";
import { accelerator, macGlyphsIn, PRIMARY_MODIFIER } from "./accelerators";
import { SHORTCUT_GROUPS } from "./keys/shortcuts";
import { defaultMenus } from "./titlebar/menus";
import type { MenuHandlers } from "./titlebar/menus";

const noop = () => {};

/** Handlers that do nothing, so `defaultMenus` builds every row it can. */
function stubHandlers(view: Partial<MenuHandlers["view"]> = {}): MenuHandlers {
  const commands = { run: noop, blocked: () => undefined };
  return {
    app: commands,
    edit: commands,
    apps: {
      available: [],
      open: noop,
      presets: {
        available: [],
        apply: noop,
        save: () => Promise.resolve(),
        suggestedName: "Cluster 1",
      },
    },
    file: { newWindow: noop, openProject: noop, openRecent: noop, closeWindow: noop },
    view: {
      commandPalette: noop,
      clustersShowing: false,
      toggleClusters: noop,
      terminalShowing: false,
      toggleTerminal: noop,
      fullscreen: false,
      toggleFullscreen: noop,
      zoomIn: noop,
      zoomOut: noop,
      ...view,
    },
    // A `last` command, so the Re-run row is built with its label filled in
    // rather than in the state where it names nothing — that label is the one
    // string in this menu assembled from user input, which is exactly where a
    // glyph would arrive unnoticed.
    run: { run: () => Promise.resolve(), interrupt: noop, last: "pnpm verify" },
    terminal: { onNew: noop, onSplit: noop, onKill: noop, onClear: noop, enabled: true },
    help: { checkForUpdates: noop, openDocumentation: noop },
  };
}

/**
 * Every string anywhere in `value`. Deliberately blind to which field it came
 * from: a label, an accelerator, a hint and a prompt's placeholder are all text
 * that reaches the screen, and a check that names the fields it looks at is one
 * a new field escapes.
 */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** `["⌘K", "⌘"]` — the offending string and the glyph, for a readable failure. */
function offenders(strings: string[]): string[][] {
  return strings.flatMap((text) => {
    const glyphs = macGlyphsIn(text);
    return glyphs.length ? [[text, ...glyphs]] : [];
  });
}

describe("accelerator()", () => {
  it("writes the Windows modifier", () => {
    expect(PRIMARY_MODIFIER).toBe("Ctrl");
    expect(accelerator({ key: "K" })).toBe("Ctrl+K");
    expect(accelerator({ key: "S", shift: true })).toBe("Ctrl+Shift+S");
    expect(accelerator({ key: "." })).toBe("Ctrl+.");
  });

  it("renders no Mac glyph for any key it is given", () => {
    const rendered = ["K", ".", "`", "\\", "=", "-", "1"].map((key) => accelerator({ key }));
    expect(offenders(rendered)).toEqual([]);
  });
});

describe("the menu bar", () => {
  it("holds no Mac glyph, in any of its toggle states", () => {
    // Both settings of all three toggles, because each swaps the label it draws
    // and a glyph could hide in the half that is off by default.
    const off = defaultMenus(stubHandlers());
    const on = defaultMenus(
      stubHandlers({ clustersShowing: true, terminalShowing: true, fullscreen: true }),
    );
    expect(offenders(stringsIn([off, on]))).toEqual([]);
  });

  it("shows an accelerator only in Windows form", () => {
    const shown = defaultMenus(stubHandlers())
      .flatMap((menu) => menu.items)
      .flatMap((item) => item.accelerator ?? []);
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) expect(text).toMatch(/^(Ctrl\+|F\d)/);
  });
});

describe("the shortcuts screen", () => {
  it("holds no Mac glyph", () => {
    expect(offenders(stringsIn(SHORTCUT_GROUPS))).toEqual([]);
  });

  it("names its modifier chips the Windows way", () => {
    const chips = new Set(SHORTCUT_GROUPS.flatMap((g) => g.items).flatMap((item) => item.keys));
    expect(chips.has(PRIMARY_MODIFIER)).toBe(true);
    for (const banned of ["Cmd", "Command", "Meta", "Option", "Opt"]) {
      expect(chips.has(banned)).toBe(false);
    }
  });
});
