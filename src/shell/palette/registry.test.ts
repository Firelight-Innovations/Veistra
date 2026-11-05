/**
 * The palette's rows are the menu bar's rows, and this is what holds them to it.
 *
 * The failure worth guarding is the one a second hand-written command table
 * would have caused and this design avoids: a palette that offers something the
 * menu no longer does, or runs a row the menu has greyed out. So the assertions
 * below are all about *derivation* — what a menu tree turns into, and what it
 * refuses to turn into.
 *
 * Menus are built by hand here rather than by calling `defaultMenus`, which
 * lives in the `titlebar` region and STANDARDS.md §1.2 puts out of reach. That
 * is the better test anyway: it covers the flattening, not the current contents
 * of the File menu.
 */
import { describe, expect, it, vi } from "vitest";
import type { Menu } from "../contract";
import {
  commandsFromMenus,
  initialIndex,
  rankCommands,
  withOpenAppCommands,
  type OpenAppSource,
} from "./registry";

const noop = () => {};

/** A menu tree with one of everything the model allows. */
function menus(): Menu[] {
  return [
    {
      label: "File",
      items: [
        { label: "New File", accelerator: "Ctrl+N", onSelect: noop },
        { label: "Save", onSelect: noop, disabled: true, hint: "Nothing is open." },
        // No action and not disabled: scaffolding, the shape Help ▸
        // Documentation had before it opened Docs.
        { label: "Placeholder" },
      ],
    },
    {
      label: "Apps",
      items: [
        {
          label: "Presets",
          submenu: [
            { label: "Two Panes", onSelect: noop },
            {
              label: "Save Current Layout…",
              prompt: {
                label: "Save this cluster's panes as a preset.",
                confirmLabel: "Save",
                onSubmit: () => Promise.resolve(),
              },
            },
          ],
        },
      ],
    },
  ];
}

const labels = () => commandsFromMenus(menus()).map((command) => command.label);

describe("flattening the menu tree", () => {
  it("names each command by the menu it came from", () => {
    expect(labels()).toContain("File: New File");
  });

  it("carries a submenu's path into the name", () => {
    expect(labels()).toContain("Apps › Presets: Two Panes");
  });

  it("does not offer the branch row itself, which opens rather than acts", () => {
    expect(labels()).not.toContain("Apps: Presets");
  });

  it("drops a row with no action and no reason for having none", () => {
    expect(labels()).not.toContain("File: Placeholder");
  });

  it("keeps a disabled row, and the sentence saying why", () => {
    const save = commandsFromMenus(menus()).find((c) => c.label === "File: Save");
    expect(save?.disabled).toBe(true);
    expect(save?.hint).toBe("Nothing is open.");
  });

  it("keeps the accelerator the menu draws, so both surfaces promise one keystroke", () => {
    const newFile = commandsFromMenus(menus()).find((c) => c.label === "File: New File");
    expect(newFile?.accelerator).toBe("Ctrl+N");
  });

  it("keeps a row that asks for a line of text, with its prompt", () => {
    const save = commandsFromMenus(menus()).find(
      (c) => c.label === "Apps › Presets: Save Current Layout…",
    );
    expect(save?.prompt?.confirmLabel).toBe("Save");
  });

  /** The action is the menu's own, not a copy of it — the palette runs exactly
   *  what clicking the row would. */
  it("runs the menu row's own handler", () => {
    const onSelect = vi.fn();
    const commands = commandsFromMenus([
      { label: "View", items: [{ label: "Zoom In", onSelect }] },
    ]);
    commands[0]?.onSelect?.();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("ranking against the field", () => {
  it("shows every command, in menu order, before anything is typed", () => {
    const rows = rankCommands(commandsFromMenus(menus()), "");
    expect(rows.map((row) => row.command.label)).toEqual(labels());
  });

  it("treats a field of only spaces as empty", () => {
    expect(rankCommands(commandsFromMenus(menus()), "   ")).toHaveLength(labels().length);
  });

  it("drops what does not match", () => {
    const rows = rankCommands(commandsFromMenus(menus()), "panes");
    expect(rows.map((row) => row.command.label)).toEqual(["Apps › Presets: Two Panes"]);
  });

  it("ranks the closer match first", () => {
    const rows = rankCommands(commandsFromMenus(menus()), "save");
    expect(rows[0]?.command.label).toBe("File: Save");
  });

  /** An unstable order under a moving highlight moves the row out from under
   *  Enter between one keystroke and the next. */
  it("orders identically for the same query twice", () => {
    const once = rankCommands(commandsFromMenus(menus()), "sa").map((r) => r.command.label);
    const twice = rankCommands(commandsFromMenus(menus()), "sa").map((r) => r.command.label);
    expect(once).toEqual(twice);
  });
});

/**
 * A disabled row can outrank every live one — search for "save" with nothing
 * open and every match is greyed. Starting the highlight at zero would then put
 * Enter on a row that cannot run, on a palette that looks ready.
 */
describe("where the highlight starts", () => {
  it("is the first row that can actually run", () => {
    const rows = rankCommands(commandsFromMenus(menus()), "save");
    expect(rows[0]?.command.disabled).toBe(true);
    expect(initialIndex(rows)).toBe(1);
  });

  it("is the first row when every one of them can run", () => {
    expect(initialIndex(rankCommands(commandsFromMenus(menus()), "panes"))).toBe(0);
  });

  it("falls back to the first row when none can, so the reason is still readable", () => {
    const rows = rankCommands(commandsFromMenus(menus()), "file save");
    expect(rows.every((row) => row.command.disabled)).toBe(true);
    expect(initialIndex(rows)).toBe(0);
  });
});

describe("open-app commands", () => {
  const apps = [
    { id: "files", name: "Files", description: "Browse", kind: "app" as const },
    { id: "godot-viewer", name: "Godot Viewer", description: "Watch", kind: "app" as const },
  ];
  const source = (over: Partial<OpenAppSource> = {}): OpenAppSource => ({
    apps,
    open: vi.fn(),
    ...over,
  });
  // The menu's own per-app rows, as `defaultMenus` flattens them.
  const menuCommands = () =>
    commandsFromMenus([
      { label: "Apps", items: [{ label: "Files", onSelect: noop }] },
      { label: "File", items: [{ label: "Save", onSelect: noop }] },
    ]);

  it("leads with 'Open app…' and hides the per-app rows until something is typed", () => {
    const all = withOpenAppCommands(menuCommands(), source());
    const empty = rankCommands(all, "");
    expect(empty[0]?.command.label).toBe("Open app…");
    expect(empty.map((r) => r.command.label)).not.toContain("Open Files");
  });

  it("surfaces 'Open <App>' first when its name is typed, ahead of the menu's row", () => {
    const all = withOpenAppCommands(menuCommands(), source());
    expect(rankCommands(all, "files")[0]?.command.label).toBe("Open Files");
    expect(rankCommands(all, "godot")[0]?.command.label).toBe("Open Godot Viewer");
    expect(all.some((c) => c.label === "Apps: Files")).toBe(false);
  });

  it("runs the open handler with the app, and drills into the apps page for 'Open app…'", () => {
    const s = source();
    const all = withOpenAppCommands([], s);
    rankCommands(all, "files")[0]?.command.onSelect?.();
    expect(s.open).toHaveBeenCalledWith(apps[0]);
    expect(all[0]?.drill).toBe("apps");
    expect(all[0]?.onSelect).toBeUndefined();
  });

  it("disables every row with the reason when opening is blocked", () => {
    const all = withOpenAppCommands([], source({ blocked: "No cluster." }));
    expect(all.every((c) => c.disabled && c.hint === "No cluster.")).toBe(true);
  });
});
