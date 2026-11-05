/**
 * The command registry, and it is the menu bar.
 *
 * There is no second table of commands here, and adding one was the obvious
 * shape to reject: two lists of the same actions agree on the day they are
 * written, and then a row renamed in the menu keeps its old name in the palette
 * and nothing fails. The menu model is already rebuilt from live state every
 * render and already carries every field a palette row needs, so this flattens
 * it. One source of truth by construction rather than by discipline.
 *
 * What that costs: a command has to be *in a menu* to be in the palette — and
 * that is the right constraint, since a palette-only command would be an action
 * with no discoverable home, which is the problem a palette exists to solve.
 */
import { AppWindow, type LucideIcon } from "lucide-react";
import type { Openable } from "../../bindings";
import type { Menu, MenuItem, MenuPrompt } from "../contract";
import { iconFor } from "../PickerParts";
import { fuzzyMatch } from "./fuzzy";

/** One runnable row, flattened out of the menu tree. */
export interface Command {
  /** The menu path it came from — `"View"`, or `"Apps › Presets"`. */
  category: string;
  /** The row's own label, ellipsis and all. */
  title: string;
  /** `"View: Zoom In"`. What the field matches against and the row draws, so
   *  the two can never highlight different characters. */
  label: string;
  accelerator?: string;
  /** Carries the menu's own meaning: inert and unclickable, never dimmed but
   *  live. `hint` is the sentence saying why. */
  disabled: boolean;
  hint?: string;
  onSelect?: () => void;
  /** A command that wants one line of text first. The palette asks for it in
   *  its own field rather than sending you to the menu to find the row. */
  prompt?: MenuPrompt;
  /** Left out of the list until something is typed. The per-app "Open <App>"
   *  rows use it: one row each would bury the menus under the apps. */
  queryOnly?: boolean;
  /** Added to the fuzzy score, so a row that names exactly what was typed beats
   *  a loose subsequence hit in another row ("files" vs "File: Save"). */
  boost?: number;
  /** The row's glyph. Rows without one draw the palette's default. */
  icon?: LucideIcon;
  /** The row opens another page of the palette in place instead of running
   *  anything, and is drawn with a right-facing chevron. */
  drill?: "apps";
}

/** A command the field matched, with the characters it matched on. */
export interface RankedCommand {
  command: Command;
  /** Indices into `command.label`, for drawing the match. */
  positions: number[];
}

/** How a menu path is written when it goes more than one level deep. */
const PATH_SEPARATOR = " › ";

/**
 * Every command in the menu tree, in menu order.
 *
 * A branch row contributes its children and not itself — Apps ▸ Presets opens
 * rather than acts, so a palette entry for it would be a row that runs nothing.
 * A leaf with neither an action nor a `disabled` of its own is dropped for the
 * same reason: that is scaffolding, not a command. No row in today's tree has
 * that shape; Help ▸ Documentation, the last one that did, now opens Docs.
 */
export function commandsFromMenus(menus: Menu[]): Command[] {
  return menus.flatMap((menu) => itemsToCommands(menu.items, menu.label));
}

function itemsToCommands(items: MenuItem[], category: string): Command[] {
  return items.flatMap((item) => {
    if (item.submenu) {
      return itemsToCommands(item.submenu, `${category}${PATH_SEPARATOR}${item.label}`);
    }
    if (item.onSelect === undefined && item.prompt === undefined && item.disabled !== true) {
      return [];
    }
    return [
      {
        category,
        title: item.label,
        label: `${category}: ${item.label}`,
        accelerator: item.accelerator,
        disabled: item.disabled === true,
        hint: item.hint,
        onSelect: item.onSelect,
        prompt: item.prompt,
      },
    ];
  });
}

/**
 * The rows the field should show, best first.
 *
 * A command that cannot act is ranked and drawn like any other rather than
 * filtered out, which is the decision most likely to be argued with. VS Code
 * hides it; here the row already carries the sentence saying why, and "Save is
 * greyed out because nothing is open" beats an empty list. It stays
 * unselectable, so nothing runs by accident.
 *
 * Ties break on the label so the order is stable between keystrokes: an
 * unstable sort under a moving highlight moves the row out from under Enter.
 */
export function rankCommands(commands: Command[], query: string): RankedCommand[] {
  const needle = query.trim();
  if (needle === "") {
    return commands.filter((c) => !c.queryOnly).map((command) => ({ command, positions: [] }));
  }

  return commands
    .flatMap((command) => {
      const hit = fuzzyMatch(needle, command.label);
      return hit === null
        ? []
        : [{ command, positions: hit.positions, score: hit.score + (command.boost ?? 0) }];
    })
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .map(({ command, positions }) => ({ command, positions }));
}

/**
 * Which row the highlight starts on: the first that can actually run.
 *
 * Not simply zero, because a disabled row can outrank every live one — search
 * for "save" with nothing open and every match is greyed. Enter would then do
 * nothing on a palette that looks ready, which is the same "the menu lies"
 * failure `disabled` exists to prevent. Falls back to zero when no row can run,
 * so the list still has a highlight to read the reason off.
 */
export function initialIndex(rows: RankedCommand[]): number {
  const live = rows.findIndex((row) => !row.command.disabled);
  return live === -1 ? 0 : live;
}

/** Comfortably above the spread a single fuzzy match can score on a short label. */
const OPEN_APP_BOOST = 60;

/** What `openAppCommands` needs: the Apps menu's list, and how to open one. */
export interface OpenAppSource {
  apps: Openable[];
  /** Opens `entry` as a new tab in the focused pane. */
  open: (entry: Openable) => void;
  /** Why nothing can be opened right now, or `undefined`. */
  blocked?: string;
  /** The picker's keyboard shortcut, drawn beside "Open app…". */
  accelerator?: string;
}

/**
 * "Open app…", then one "Open <App>" per app, in front of the menu's own rows.
 *
 * They are not a second command table: the app list is the Apps menu's list,
 * handed in by the caller. What they replace is the menu's own per-app rows
 * ("Apps: Files"), which would otherwise tie with "Open Files" on the query
 * "files" and win the tie alphabetically — and those split the pane, where a
 * name typed into the palette means "here". Presets and the App Library stay.
 *
 * "Open app…" leads the list; the per-app rows show only once something is
 * typed, so the empty palette is not forty rows of apps.
 */
export function withOpenAppCommands(commands: Command[], source: OpenAppSource): Command[] {
  const names = new Set(source.apps.map((a) => a.name));
  const rest = commands.filter((c) => !(c.category === "Apps" && names.has(c.title)));
  const disabled = source.blocked !== undefined;

  const opener: Command = {
    category: "Apps",
    title: "Open app…",
    label: "Open app…",
    accelerator: source.accelerator,
    disabled,
    hint: source.blocked ?? "Pick an app to open in the focused pane.",
    drill: "apps",
    icon: AppWindow,
  };
  const perApp: Command[] = source.apps.map((entry) => ({
    category: "Apps",
    title: `Open ${entry.name}`,
    label: `Open ${entry.name}`,
    disabled,
    hint: source.blocked ?? entry.description,
    onSelect: () => source.open(entry),
    icon: iconFor(entry),
    queryOnly: true,
    boost: OPEN_APP_BOOST,
  }));

  return [opener, ...perApp, ...rest];
}
