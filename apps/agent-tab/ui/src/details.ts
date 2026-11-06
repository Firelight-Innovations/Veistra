/**
 * What the Details panel, the agent map and the task cards show, read off the
 * transcript: the files the agent changed and made, its subagents, its
 * background tasks and a workflow's phases. Pure, so it is tested without
 * drawing anything; `App.tsx` turns it into slot props.
 */
import type {
  Item,
  ItemKind,
  TaskState,
  TaskUsage,
  ToolStatus,
  WorkflowAgent,
  WorkflowRun,
} from "./protocol.generated";
import { counts, lineDiff } from "./diff";

type Kind<K extends ItemKind["kind"]> = Extract<ItemKind, { kind: K }>;

/** When the tab first saw an item, and when it saw it finish. */
export interface Stamp {
  first: number;
  settled: number | null;
  /** It was already finished when first seen, as on a replay: its time is not known. */
  replayed: boolean;
}

/** Whether an item is something still running: a tool call or a task. */
export function settled(item: Item): boolean {
  const kind = item.kind;
  if (kind.kind === "toolCall") return kind.status === "completed" || kind.status === "failed";
  if (kind.kind === "task") return !isLive(kind.state);
  return true;
}

export function isLive(state: TaskState): boolean {
  return state === "running" || state === "paused";
}

/**
 * Notes, in `stamps`, when each item was first seen and when it finished.
 * Returns whether anything changed. The protocol carries no clock, so this
 * is how long a subagent or a task has run, as this tab watched it.
 */
export function stampItems(stamps: Map<string, Stamp>, items: readonly Item[], now: number) {
  let changed = false;
  for (const item of items) {
    const done = settled(item);
    const was = stamps.get(item.id);
    if (!was) {
      stamps.set(item.id, { first: now, settled: done ? now : null, replayed: done });
      changed = true;
    } else if (done && was.settled === null) {
      stamps.set(item.id, { ...was, settled: now });
      changed = true;
    }
  }
  return changed;
}

/** How long an item has run, in ms, or `null` when the tab does not know. */
export function elapsedOf(stamp: Stamp | undefined, now: number): number | null {
  if (!stamp || stamp.replayed) return null;
  return Math.max(0, (stamp.settled ?? now) - stamp.first);
}

/** One file the session changed, every edit to it added up. */
export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** The agent made it, rather than editing one that was there. */
  isNew: boolean;
}

/**
 * Every file the agent's finished edits touched, in the order it first
 * touched them. An edit's diff is only the stretch it replaced, so the
 * counts are each edit's own, added up.
 */
export function changesOf(items: readonly Item[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const item of items) {
    const kind = item.kind;
    if (kind.kind !== "toolCall" || kind.status === "failed") continue;
    for (const diff of kind.diffs) {
      const lines = diff.tooLarge ? null : lineDiff(diff.oldText, diff.newText);
      const tally = lines ? counts(lines) : { added: 0, removed: 0 };
      const was = byPath.get(diff.path);
      const isNew = diff.oldText === null && !diff.tooLarge;
      if (was) {
        was.added += tally.added;
        was.removed += tally.removed;
      } else {
        byPath.set(diff.path, { path: diff.path, ...tally, isNew });
      }
    }
  }
  return [...byPath.values()];
}

/** Something the agent made for the user to look at. */
export type Output =
  | { kind: "file"; path: string }
  /** A card the agent drew with one of Veistra's show tools, by its item. */
  | { kind: "show"; itemId: string; component: string };

/** New files, then the cards it showed, in the order they came. */
export function outputsOf(items: readonly Item[], changes: readonly FileChange[]): Output[] {
  const files: Output[] = changes
    .filter((c) => c.isNew)
    .map((c) => ({ kind: "file", path: c.path }));
  const shown: Output[] = [];
  for (const item of items) {
    const kind = item.kind;
    if (kind.kind === "toolCall" && kind.veistra && kind.status === "completed")
      shown.push({ kind: "show", itemId: item.id, component: kind.veistra.component });
  }
  return [...files, ...shown];
}

/** A subagent: a tool call that other items name as their parent. */
export interface Subagent {
  itemId: string;
  title: string;
  status: ToolStatus;
  /** Tool calls it has made so far. */
  toolUses: number;
  elapsed: number | null;
  /** Tokens, when it runs as a background task that reports them. */
  tokens: number | null;
}

/** The items nested under each call, by the call's item id. */
export function childrenOf(items: readonly Item[]): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.parent) continue;
    const list = out.get(item.parent);
    if (list) list.push(item);
    else out.set(item.parent, [item]);
  }
  return out;
}

export function subagentsOf(
  items: readonly Item[],
  children: ReadonlyMap<string, readonly Item[]>,
  stamps: ReadonlyMap<string, Stamp>,
  now: number,
): Subagent[] {
  const tokens = new Map<string, number>();
  for (const item of items) {
    const kind = item.kind;
    if (kind.kind === "task" && kind.callItem && kind.usage)
      tokens.set(kind.callItem, kind.usage.totalTokens);
  }
  const out: Subagent[] = [];
  for (const item of items) {
    const kind = item.kind;
    const nested = children.get(item.id);
    if (kind.kind !== "toolCall" || !nested) continue;
    out.push({
      itemId: item.id,
      title: kind.title,
      status: kind.status,
      toolUses: nested.filter((c) => c.kind.kind === "toolCall").length,
      elapsed: elapsedOf(stamps.get(item.id), now),
      tokens: tokens.get(item.id) ?? null,
    });
  }
  return out;
}

/** A background task, as its rows and cards show it. */
export interface TaskRow {
  itemId: string;
  task: Kind<"task">;
  /** How long it has run, in ms, or `null` when not known. */
  elapsed: number | null;
}

export function tasksOf(
  items: readonly Item[],
  stamps: ReadonlyMap<string, Stamp>,
  now: number,
): TaskRow[] {
  const out: TaskRow[] = [];
  for (const item of items) {
    if (item.kind.kind !== "task") continue;
    out.push({ itemId: item.id, task: item.kind, elapsed: taskElapsed(item, stamps, now) });
  }
  return out;
}

/** The tab's own clock while it watched; the agent's figure otherwise. */
export function taskElapsed(
  item: Item,
  stamps: ReadonlyMap<string, Stamp>,
  now: number,
): number | null {
  const watched = elapsedOf(stamps.get(item.id), now);
  const usage: TaskUsage | null = item.kind.kind === "task" ? item.kind.usage : null;
  if (watched === null) return usage?.durationMs ?? null;
  return Math.max(watched, usage?.durationMs ?? 0);
}

/** Where a workflow's phase is. */
export type PhaseState = "done" | "running" | "failed" | "next" | "skipped";

export interface PhaseView {
  title: string;
  detail: string | null;
  state: PhaseState;
  agents: WorkflowAgent[];
}

/**
 * A workflow's phases with their agents under them. A phase no agent has
 * reached is up next while the workflow runs, and skipped once it ends,
 * unless a later phase has started, in which case it went by with no agent.
 * Agents that name no declared phase are `loose`.
 */
export function phasesOf(
  run: WorkflowRun,
  live: boolean,
): { phases: PhaseView[]; loose: WorkflowAgent[] } {
  const titles = new Set(run.phases.map((p) => p.title));
  const loose = run.agents.filter((a) => a.phase === null || !titles.has(a.phase));
  const lastReached = run.phases.reduce(
    (at, p, i) => (run.agents.some((a) => a.phase === p.title) ? i : at),
    -1,
  );
  const phases = run.phases.map((p, i): PhaseView => {
    const agents = run.agents.filter((a) => a.phase === p.title);
    let state: PhaseState;
    if (agents.some((a) => a.state === "running")) state = "running";
    else if (agents.some((a) => a.state === "failed")) state = "failed";
    else if (agents.length > 0 || i < lastReached) state = "done";
    else state = live ? "next" : "skipped";
    return { title: p.title, detail: p.detail, state, agents };
  });
  return { phases, loose };
}

/** "Phase 2 of 4", and its title, for a running workflow's card; `null` without phases. */
export function currentPhase(run: WorkflowRun): { index: number; title: string } | null {
  let at = -1;
  run.phases.forEach((p, i) => {
    if (run.agents.some((a) => a.phase === p.title)) at = i;
  });
  if (at < 0) return null;
  return { index: at, title: run.phases[at].title };
}

/** How many of a run's agents are running, done and failed. */
export function agentCounts(run: WorkflowRun) {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const a of run.agents) {
    if (a.state === "running") running++;
    else if (a.state === "done") done++;
    else failed++;
  }
  return { running, done, failed };
}

/** Joins a path the agent named relative to the worktree onto it; an absolute one is kept. */
export function absolute(path: string, root: string | null): string {
  if (!root || /^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return path;
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${path}`;
}

/** The path below `root`, for showing; the whole path when it is elsewhere. */
export function relative(path: string, root: string | null): string {
  if (!root) return path;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const full = norm(path);
  if (full.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return full.slice(base.length + 1);
  return path;
}
