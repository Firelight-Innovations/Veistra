/**
 * The right-hand cluster of the title bar, in Cursor's order: Upgrade, then
 * new agent, terminal, agents window, clusters and settings, each an icon
 * button. Below `ACTIONS_COLLAPSE_BELOW` they are one overflow button instead,
 * the way the menus become the hamburger (#336).
 *
 * Both forms are drawn from `titleBarActions`, one list, as `MenuBar` and
 * `HamburgerMenu` draw one `Menu[]`: a row cannot do something its button does
 * not, or name another shortcut, because each is defined once.
 */
import {
  MessageSquare,
  PanelBottom,
  PanelRight,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { HEALTH_LABEL, type MenuItem, type ToolPresentation } from "../contract";
import OverflowMenu from "./OverflowMenu";
import ToolHealthBadge, { toolHealthLabel, unhealthyTools } from "./ToolHealthBadge";
import type { UnhealthyTool } from "./HealthPopover";
import { useCollapsedTitlebarActions } from "./useNarrowTitlebar";

/** Where Upgrade goes; shared with Settings' Billing page (`../upgrade.ts`). */
export { UPGRADE_URL } from "../upgrade";

const MORE = "More actions";

export interface TitleBarActionsProps {
  /** Open the website. Passed in so the bar never reaches for the opener plugin itself. */
  onUpgrade: () => void;
  /** Open a new agent tab in the active cluster. Absent while there is no cluster. */
  onNewAgent?: () => void;
  /** Whether the terminal band is showing. */
  terminalOpen: boolean;
  /** Show the terminal band, opening a terminal if none exists, or fold it away. */
  onToggleTerminal: () => void;
  /** Whether the Agents page is the one docked on the right. */
  agentsOpen: boolean;
  onToggleAgents: () => void;
  /** Whether the cluster list is showing at the window's right edge (Ctrl+B). */
  clustersOpen: boolean;
  onToggleClusters: () => void;
  onOpenSettings: () => void;
  /** The stack's tools, for the warning badge (drawn only while one is unhealthy). */
  health?: { tools: ToolPresentation[]; onRescan: () => void };
}

/** One right-hand action: a button in a wide bar, a row of the overflow menu in a narrow one. */
export interface TitleBarAction {
  /** The button's accessible name. */
  name: string;
  /** The overflow row's label. A toggle says which way it will go, as the View menu's do. */
  row: string;
  /** Absent for Upgrade, the one text button. */
  icon?: LucideIcon;
  /** Bound in `useKeyboard.ts`. Shown in the button's tooltip and at the row's end. */
  accelerator?: string;
  /** A toggle's state. Absent on a button that is not a toggle. */
  pressed?: boolean;
  /** The Agents glyph fills while its page is open. */
  fillWhenPressed?: boolean;
  /** Absent: the action cannot run, and both forms render disabled. */
  onSelect?: () => void;
  /** Why it cannot run, for the row (a disabled button shows no tooltip). */
  hint?: string;
  separatorBefore?: boolean;
}

const showHide = (open: boolean, what: string) => `${open ? "Hide" : "Show"} ${what}`;

export function titleBarActions(p: TitleBarActionsProps): TitleBarAction[] {
  return [
    { name: "Upgrade", row: "Upgrade", onSelect: p.onUpgrade },
    {
      name: "New agent session",
      row: "New agent session",
      icon: Plus,
      onSelect: p.onNewAgent,
      hint: p.onNewAgent ? undefined : "There is no cluster to open it in.",
      separatorBefore: true,
    },
    {
      name: "Terminal",
      row: showHide(p.terminalOpen, "Terminal"),
      icon: PanelBottom,
      accelerator: "Ctrl+`",
      pressed: p.terminalOpen,
      onSelect: p.onToggleTerminal,
      separatorBefore: true,
    },
    {
      name: "Agents",
      row: showHide(p.agentsOpen, "Agents"),
      icon: MessageSquare,
      pressed: p.agentsOpen,
      fillWhenPressed: true,
      onSelect: p.onToggleAgents,
    },
    {
      name: "Clusters",
      row: showHide(p.clustersOpen, "Clusters"),
      icon: PanelRight,
      accelerator: "Ctrl+B",
      pressed: p.clustersOpen,
      onSelect: p.onToggleClusters,
    },
    {
      name: "Settings",
      row: "Settings",
      icon: Settings,
      accelerator: "Ctrl+,",
      onSelect: p.onOpenSettings,
      separatorBefore: true,
    },
  ];
}

/** The overflow menu's rows: the same actions, after a tool-health row when one is unhealthy. */
export function overflowItems(
  actions: TitleBarAction[],
  unhealthy: UnhealthyTool[],
  onRescan?: () => void,
): MenuItem[] {
  const rows: MenuItem[] = actions.map((a) => ({
    label: a.row,
    accelerator: a.accelerator,
    separatorBefore: a.separatorBefore,
    onSelect: a.onSelect,
    disabled: a.onSelect === undefined,
    hint: a.hint,
  }));
  if (unhealthy.length === 0 || rows.length === 0) return rows;

  // The badge's popover, as a submenu: one row per tool, then Re-scan.
  const health: MenuItem = {
    label: toolHealthLabel(unhealthy.length),
    submenu: [
      ...unhealthy.map((tool) => ({
        label: `${tool.name}: ${HEALTH_LABEL[tool.health]}`,
        disabled: true,
      })),
      {
        label: "Re-scan tools",
        accelerator: "Ctrl+R",
        onSelect: onRescan,
        disabled: onRescan === undefined,
        separatorBefore: true,
      },
    ],
  };
  return [health, { ...rows[0], separatorBefore: true }, ...rows.slice(1)];
}

function ActionButton({ action }: { action: TitleBarAction }) {
  if (!action.icon) {
    return (
      <button type="button" className="titlebar__upgrade" onClick={action.onSelect}>
        {action.name}
      </button>
    );
  }
  const Icon = action.icon;
  return (
    <button
      type="button"
      className="titlebar__icon"
      aria-label={action.name}
      title={action.accelerator ? `${action.name} (${action.accelerator})` : action.name}
      aria-keyshortcuts={action.accelerator?.replace(/^Ctrl\+/, "Control+")}
      aria-pressed={action.pressed}
      disabled={action.onSelect === undefined}
      onClick={action.onSelect}
    >
      <Icon
        size={16}
        strokeWidth={2}
        fill={action.fillWhenPressed && action.pressed ? "currentColor" : "none"}
        aria-hidden="true"
      />
    </button>
  );
}

export default function TitleBarActions(props: TitleBarActionsProps) {
  const collapsed = useCollapsedTitlebarActions();
  const actions = titleBarActions(props);
  const { health } = props;

  if (collapsed) {
    const unhealthy = unhealthyTools(health?.tools ?? []);
    return (
      <OverflowMenu
        items={overflowItems(actions, unhealthy, health?.onRescan)}
        label={unhealthy.length > 0 ? `${MORE}, ${toolHealthLabel(unhealthy.length)}` : MORE}
        attention={unhealthy.length > 0}
      />
    );
  }

  return (
    <>
      {health && <ToolHealthBadge healthOf={health.tools} onRescan={health.onRescan} />}
      {actions.map((action) => (
        <ActionButton key={action.name} action={action} />
      ))}
    </>
  );
}
