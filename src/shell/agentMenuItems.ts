/**
 * The right-click menu on an agent: its groups, in order, and which of its rows
 * can act.
 *
 * The same menu serves every button that stands for an agent session (an open
 * row on the Agents page, a row under a cluster in the rail's strip, a saved
 * session under "Previous sessions"), so it is built here from a subject and a
 * bag of actions rather than inside any one of them.
 *
 * A row whose action the host did not supply, or that has nothing to act on
 * (Close Others with no other agent tab), is `disabled` with a `hint` saying
 * why. It is never a live row that does nothing.
 */
import type { SplitDir } from "../bindings";
import { paneLeaves, paneOfTab, type Cluster, type MenuItem } from "./contract";

/** What was right-clicked. */
export type AgentMenuSubject =
  /** An agent tab that is open somewhere in this window. */
  | { kind: "open"; id: string; name: string | null }
  /** A saved session of the current project, with no tab. */
  | { kind: "saved"; id: string; title: string; archived: boolean };

/** Where an open agent tab sits, for the close and split rows. */
export interface AgentScope {
  /** Every tab in the pane that holds it, in strip order. */
  paneTabs: readonly string[];
  /** The agent tabs among them, in strip order. */
  agentTabs: readonly string[];
}

/** What the menu may do. Anything left out is a disabled row. */
export interface AgentMenuActions {
  /** Name an open session. Rejects with a message to show under the field. */
  rename?: (instanceId: string, name: string) => Promise<void>;
  close?: (instanceId: string) => void;
  /** Close the other agent tabs in this one's pane. */
  closeOthers?: (instanceId: string) => void;
  /** Close the agent tabs after this one in its pane. */
  closeToRight?: (instanceId: string) => void;
  /** Close every agent tab in this one's pane. */
  closeAll?: (instanceId: string) => void;
  split?: (instanceId: string, dir: SplitDir, before: boolean) => void;
  moveToNewWindow?: (instanceId: string) => void;
  openSettings?: () => void;
  /** Open the feedback dialog about agent tabs. */
  feedback?: () => void;
  /** Where an open tab sits; `null` when it is in no pane of this window. */
  scope?: (instanceId: string) => AgentScope | null;
  /** Open a saved session. */
  resume?: (sessionId: string) => void;
  archive?: (sessionId: string, archived: boolean) => void;
}

const NO_EXPORT = "Exporting a transcript is not built yet.";
const NO_REQUEST_ID = "The agent does not report a request id to copy.";
const NO_FEEDBACK = "Feedback is not wired here.";
const NO_FORK = "Forking waits on the agent's fork support (agent-tab parity, row 25).";
const NO_REOPEN = "An agent tab has no other editor to reopen with.";
const NO_KEEP = "Agent tabs are not previews, so there is nothing to keep open.";
const NO_PIN = "Pinning tabs is not built yet.";
const NO_SAVED_CLOSE = "Agent tabs have no unsaved state, so there is no saved set to close.";

/** A row that can act when its handler exists, else one that says it cannot. */
function live(
  label: string,
  run: (() => void) | undefined,
  missing: string,
  extra: Partial<MenuItem> = {},
): MenuItem {
  if (extra.disabled === true) return { label, ...extra };
  return run
    ? { label, onSelect: run, ...extra }
    : { label, disabled: true, hint: missing, ...extra };
}

function dead(label: string, hint: string, extra: Partial<MenuItem> = {}): MenuItem {
  return { label, disabled: true, hint, ...extra };
}

/** The first row of each group opens a rule above it. */
function group(rows: MenuItem[]): MenuItem[] {
  return rows.map((row, i) => (i === 0 ? { ...row, separatorBefore: true } : row));
}

/** The menu for `subject`, groups in the order the design gives them. */
export function agentMenuItems(subject: AgentMenuSubject, actions: AgentMenuActions): MenuItem[] {
  return subject.kind === "open" ? openItems(subject, actions) : savedItems(subject, actions);
}

function openItems(
  subject: Extract<AgentMenuSubject, { kind: "open" }>,
  actions: AgentMenuActions,
): MenuItem[] {
  const { id } = subject;
  const scope = actions.scope?.(id) ?? null;
  const agents = scope?.agentTabs ?? [];
  const at = agents.indexOf(id);
  const others = agents.filter((tab) => tab !== id).length;
  const right = at < 0 ? 0 : agents.length - at - 1;
  const alone = "It is the only agent tab in its pane.";
  const last = "It is the last agent tab in its pane.";
  const splittable = scope !== null && scope.paneTabs.length > 1;
  const crowded = "A pane's only tab has nothing to split away from.";
  const split = (label: string, dir: SplitDir, before: boolean): MenuItem =>
    live(
      label,
      actions.split && (() => actions.split?.(id, dir, before)),
      "Splitting is not wired.",
      {
        ...(splittable ? {} : { disabled: true, hint: crowded }),
      },
    );

  const rename: MenuItem = actions.rename
    ? {
        label: "Rename Chat",
        prompt: {
          label: "Rename chat",
          initialValue: subject.name ?? "",
          confirmLabel: "Rename",
          placeholder: "Name this chat",
          onSubmit: async (value: string) => {
            await actions.rename?.(id, value.trim());
          },
        },
      }
    : dead("Rename Chat", "Renaming is not wired here.");

  return [
    // Group 1: the chat itself.
    dead("Export Transcript", NO_EXPORT),
    dead("Copy Request ID", NO_REQUEST_ID),
    live("Give Feedback", actions.feedback, NO_FEEDBACK),
    rename,
    dead("Fork Chat", NO_FORK),
    // Group 2: closing.
    ...group([
      live("Close", actions.close && (() => actions.close?.(id)), "Closing is not wired."),
      live(
        "Close Others",
        actions.closeOthers && (() => actions.closeOthers?.(id)),
        "Closing is not wired.",
        others === 0 ? { disabled: true, hint: alone } : {},
      ),
      live(
        "Close to the Right",
        actions.closeToRight && (() => actions.closeToRight?.(id)),
        "Closing is not wired.",
        right === 0 ? { disabled: true, hint: last } : {},
      ),
      dead("Close Saved", NO_SAVED_CLOSE),
      live(
        "Close All",
        actions.closeAll && (() => actions.closeAll?.(id)),
        "Closing is not wired.",
      ),
    ]),
    // Group 3.
    ...group([dead("Reopen Editor With…", NO_REOPEN)]),
    // Group 4.
    ...group([
      live(
        "Agent Settings",
        actions.openSettings && (() => actions.openSettings?.()),
        "Settings are not wired here.",
      ),
    ]),
    // Group 5.
    ...group([dead("Keep Open", NO_KEEP), dead("Pin", NO_PIN)]),
    // Group 6.
    ...group([
      split("Split Up", "column", true),
      split("Split Down", "column", false),
      split("Split Left", "row", true),
      split("Split Right", "row", false),
    ]),
    // Group 7.
    ...group([
      live(
        "Move into New Window",
        actions.moveToNewWindow && (() => actions.moveToNewWindow?.(id)),
        "Moving to a window is not wired.",
      ),
    ]),
  ];
}

/**
 * A saved session has no tab, so it has no pane to close, split or move. What
 * is left is opening it and the rows that belong to the chat; each of those
 * that has no backing action says so.
 */
function savedItems(
  subject: Extract<AgentMenuSubject, { kind: "saved" }>,
  actions: AgentMenuActions,
): MenuItem[] {
  const { id } = subject;
  return [
    live("Open Session", actions.resume && (() => actions.resume?.(id)), "Opening is not wired."),
    ...group([
      dead("Export Transcript", NO_EXPORT),
      dead("Rename Chat", "Only an open session can be renamed. Open it first."),
      dead("Fork Chat", NO_FORK),
    ]),
    ...group([
      live(
        subject.archived ? "Restore" : "Archive",
        actions.archive && (() => actions.archive?.(id, !subject.archived)),
        "Archiving is not wired.",
      ),
    ]),
  ];
}

/** Which tabs share an agent tab's pane, from a window's clusters. */
export function agentScopeOf(
  clusters: readonly Pick<Cluster, "tree">[],
  appOf: (instanceId: string) => string | undefined,
  instanceId: string,
): AgentScope | null {
  for (const cluster of clusters) {
    if (paneOfTab(cluster.tree, instanceId) === null) continue;
    const leaf = paneLeaves(cluster.tree).find((pane) => pane.tabs.includes(instanceId));
    if (!leaf) continue;
    return {
      paneTabs: leaf.tabs,
      agentTabs: leaf.tabs.filter((tab) => appOf(tab) === "agent-tab"),
    };
  }
  return null;
}
