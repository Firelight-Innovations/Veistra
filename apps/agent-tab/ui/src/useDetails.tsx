/**
 * The Details panel, the agent map and the clock behind task cards: what the
 * tab shows about the session beyond the conversation itself. The numbers
 * come from `details.ts`; this hook turns them into slot props and wires each
 * row to the part of Veistra that opens it: a file to the viewer, changes to
 * the Git sidebar, connectors to Settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke, openIn } from "@veistra/bridge";
import type { Item, TaskState, ToolStatus } from "./protocol.generated";
import {
  absolute,
  changesOf,
  childrenOf,
  elapsedOf,
  isLive,
  outputsOf,
  phasesOf,
  relative,
  settled,
  stampItems,
  subagentsOf,
  taskElapsed,
  tasksOf,
  type PhaseView,
  type Stamp,
  type TaskRow,
} from "./details";
import { latestUsage } from "./meters";
import * as rpc from "./rpc";
import { strings } from "./strings";
import { useSlots } from "./components/registry";
import type {
  DetailRow,
  EnvironmentView,
  MapNode,
  TaskAgentRow,
  TaskPhaseRow,
} from "./components/types";
import type { WorkflowAgent } from "./protocol.generated";

/** What the panel says when the environment cannot be read. */
const NO_ENVIRONMENT: rpc.Environment = {
  kind: null,
  path: null,
  branch: null,
  ahead: 0,
  behind: 0,
  insertions: 0,
  deletions: 0,
  files: 0,
  remote: null,
  connectors: [],
};

export interface Details {
  /** The items nested under each subagent call, for `NestedItems`. */
  nested: ReadonlyMap<string, readonly Item[]>;
  /** How long an item has run, for task cards. */
  elapsed: (itemId: string) => number | null;
  /** Opens the panel on a task. */
  openTask: (itemId: string) => void;
  stopTask: (taskId: string) => Promise<void>;
  detailsOpen: boolean;
  toggleDetails: () => void;
  /** The panel, while open, for `Layout`. */
  panel: ReactNode;
  /** The agent map, while open, for `Layout`. */
  overlay: ReactNode;
  /** The composer's agents button, once there is a subagent or a task. */
  button: ReactNode;
}

export function useDetails({
  items,
  working,
  title,
  model,
  onStopFailed,
}: {
  items: readonly Item[];
  working: boolean;
  /** The conversation's name, for the map's root. */
  title: string | null;
  /** The model's name, for the map's root. */
  model: string | null;
  onStopFailed: (err: unknown) => void;
}): Details {
  const S = useSlots();

  // When each item was first seen and seen to finish. Stamping is idempotent,
  // so doing it on every draw costs a map lookup per item and nothing else.
  const stamps = useRef(new Map<string, Stamp>());
  stampItems(stamps.current, items, Date.now());
  const nested = useMemo(() => childrenOf(items), [items]);

  // A clock, ticking only while a task or a subagent runs.
  const [now, setNow] = useState(() => Date.now());
  const ticking = items.some(
    (i) =>
      (i.kind.kind === "task" && isLive(i.kind.state)) ||
      (i.kind.kind === "toolCall" && nested.has(i.id) && !settled(i)),
  );
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const elapsed = useCallback(
    (itemId: string) => {
      const item = byId.get(itemId);
      if (!item) return null;
      return item.kind.kind === "task"
        ? taskElapsed(item, stamps.current, now)
        : elapsedOf(stamps.current.get(itemId), now);
    },
    [byId, now],
  );

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [env, setEnv] = useState<rpc.Environment | null>(null);

  // Read where the agent works when the panel opens, and again whenever a
  // turn ends, since a turn is what changes the branch and its files.
  useEffect(() => {
    if (!detailsOpen || working) return;
    let live = true;
    rpc.environment().then(
      (got) => live && setEnv(got),
      () => live && setEnv((was) => was ?? NO_ENVIRONMENT),
    );
    return () => {
      live = false;
    };
  }, [detailsOpen, working]);

  const openTask = useCallback((itemId: string) => {
    setTaskOpen(itemId);
    setDetailsOpen(true);
    setMapOpen(false);
  }, []);
  const stopTask = useCallback(
    (taskId: string) =>
      rpc.stopTask(taskId).then(
        () => undefined,
        (err: unknown) => {
          onStopFailed(err);
          throw err;
        },
      ),
    [onStopFailed],
  );
  const toggleDetails = useCallback(() => {
    setDetailsOpen((was) => !was);
    setTaskOpen(null);
  }, []);

  const changes = useMemo(() => changesOf(items), [items]);
  const outputs = useMemo(() => outputsOf(items, changes), [items, changes]);
  const tasks = tasksOf(items, stamps.current, now);
  const subagents = subagentsOf(items, nested, stamps.current, now);
  const root = env?.path ?? null;

  const openPath = (path: string) =>
    void openIn("viewer", { path: absolute(path, root), preview: true }).catch(() => {});
  const openGit = () =>
    void invoke("veistra/key", { key: "1", code: "Digit1", altKey: true }).catch(() => {});
  const openConnectors = () =>
    void invoke("shell/open-settings", { section: "mcp" }).catch(() => {});

  let panel: ReactNode = null;
  if (detailsOpen) {
    const usage = latestUsage(items);
    const task = taskOpen === null ? undefined : tasks.find((t) => t.itemId === taskOpen);
    panel = (
      <S.DetailsPanel
        onClose={toggleDetails}
        environment={env && environmentView(env)}
        onOpenGit={env?.kind ? openGit : null}
        context={usage.used !== null && usage.size ? { used: usage.used, size: usage.size } : null}
        connectors={
          env &&
          env.connectors.map((c) => ({
            id: `${c.source}:${c.name}`,
            label: c.name,
            detail: strings.details.connectorSource[c.source] ?? null,
          }))
        }
        onManageConnectors={openConnectors}
        outputs={outputs.map((o): DetailRow =>
          o.kind === "file"
            ? { id: o.path, label: relative(o.path, root), onOpen: () => openPath(o.path) }
            : {
                id: o.itemId,
                label: strings.details.shown(o.component),
                onOpen: () => reveal(o.itemId),
              },
        )}
        changes={changes.map((c) => ({
          id: c.path,
          label: relative(c.path, root),
          added: c.added,
          removed: c.removed,
          isNew: c.isNew,
          onOpen: () => openPath(c.path),
        }))}
        tasks={tasks.map((t) => ({
          id: t.itemId,
          label: t.task.name || t.task.description,
          detail: taskMeta(t),
          dot: taskDot(t.task.state),
          onOpen: () => setTaskOpen(t.itemId),
        }))}
        agents={
          subagents.length + tasks.length > 0
            ? { label: strings.details.openMap, onOpen: () => setMapOpen(true) }
            : null
        }
        detail={
          task && (
            <S.TaskDetail
              {...taskDetail(task, now)}
              onBack={() => setTaskOpen(null)}
              onStop={
                isLive(task.task.state) && task.task.canStop
                  ? () => {
                      setStopping(task.task.taskId);
                      stopTask(task.task.taskId).catch(() => setStopping(null));
                    }
                  : null
              }
              stopping={stopping === task.task.taskId && isLive(task.task.state)}
            />
          )
        }
      />
    );
  }

  const overlay = mapOpen ? (
    <S.AgentMap
      main={{
        id: "main",
        label: title || strings.map.session,
        meta: strings.map.main(model, latestUsage(items).used) || null,
        state: working ? "running" : "idle",
      }}
      agents={subagents.map((a): MapNode => ({
        id: a.itemId,
        label: a.title,
        meta:
          [
            a.elapsed === null ? null : strings.activity.elapsed(a.elapsed),
            a.tokens === null ? strings.task.toolUses(a.toolUses) : strings.task.tokens(a.tokens),
          ]
            .filter(Boolean)
            .join(" · ") || null,
        state: toolDot(a.status),
        onOpen: () => {
          setMapOpen(false);
          reveal(a.itemId);
        },
      }))}
      tasks={tasks.map((t): MapNode => ({
        id: t.itemId,
        label: t.task.name || t.task.description,
        meta: taskMeta(t),
        state: taskDot(t.task.state),
        onOpen: () => openTask(t.itemId),
      }))}
      onClose={() => setMapOpen(false)}
    />
  ) : null;

  const total = subagents.length + tasks.length;
  const running =
    subagents.filter((a) => a.status === "pending" || a.status === "inProgress").length +
    tasks.filter((t) => isLive(t.task.state)).length;
  const button =
    total > 0 ? (
      <S.AgentsButton
        label={strings.map.button(running, total)}
        running={running > 0}
        onClick={() => setMapOpen(true)}
      />
    ) : null;

  return {
    nested,
    elapsed,
    openTask,
    stopTask,
    detailsOpen,
    toggleDetails,
    panel,
    overlay,
    button,
  };
}

/**
 * Scrolls the transcript to an item and opens it, and every fold it sits in.
 * Items mark themselves with `data-item` (`ToolCall`, `TaskCard`).
 */
function reveal(itemId: string) {
  const el = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
  if (!el) return;
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    if (at instanceof HTMLDetailsElement) at.open = true;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function environmentView(env: rpc.Environment): EnvironmentView {
  if (env.kind === null)
    return {
      kind: strings.details.noEnvironment,
      branch: null,
      path: null,
      sync: null,
      remote: null,
      uncommitted: null,
    };
  return {
    kind: env.kind === "worktree" ? strings.details.worktree : strings.details.main,
    branch: env.branch,
    path: env.path,
    sync: env.branch ? strings.details.sync(env.ahead, env.behind) : null,
    remote: env.remote,
    uncommitted:
      env.files > 0
        ? {
            label: strings.details.uncommitted(env.files),
            added: env.insertions,
            removed: env.deletions,
          }
        : null,
  };
}

function taskMeta(t: TaskRow): string {
  return [
    strings.task.type(t.task.taskType),
    t.elapsed === null ? null : strings.activity.elapsed(t.elapsed),
  ]
    .filter(Boolean)
    .join(" · ");
}

function taskDot(state: TaskState): MapNode["state"] {
  if (isLive(state)) return "running";
  if (state === "completed") return "done";
  if (state === "failed") return "failed";
  return "idle";
}

function toolDot(status: ToolStatus): MapNode["state"] {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  return "running";
}

/** One task, opened: its figures, and a workflow's phases with their agents. */
function taskDetail(row: TaskRow, now: number) {
  const { task } = row;
  const live = isLive(task.state);
  const figures = [
    row.elapsed === null ? null : strings.activity.elapsed(row.elapsed),
    task.usage && task.usage.totalTokens > 0 ? strings.task.tokens(task.usage.totalTokens) : null,
    task.usage && task.usage.toolUses > 0 ? strings.task.toolUses(task.usage.toolUses) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const agent = (a: WorkflowAgent): TaskAgentRow => {
    const ms = a.durationMs ?? (a.state === "running" && a.startedAt ? now - a.startedAt : null);
    return {
      id: a.id,
      label: a.label,
      state: a.state,
      meta:
        [a.model, ms === null ? null : strings.activity.elapsed(ms)].filter(Boolean).join(" · ") ||
        null,
      result: a.result,
    };
  };
  const phase = (p: PhaseView): TaskPhaseRow => ({
    title: p.title,
    detail: p.detail,
    state: p.state,
    stateLabel: strings.task.phaseState[p.state],
    agents: p.agents.map(agent),
  });
  const view = task.run ? phasesOf(task.run, live) : { phases: [], loose: [] };
  return {
    name: task.name || task.description,
    type: strings.task.type(task.taskType),
    state: task.state,
    stateLabel: strings.task.state[task.state],
    figures: figures || null,
    description: task.description || null,
    summary: task.summary,
    lastTool: live && task.lastTool ? strings.task.lastTool(task.lastTool) : null,
    phases: view.phases.filter((p) => p.state !== "next").map(phase),
    upNext: view.phases.filter((p) => p.state === "next").map(phase),
    loose: view.loose.map(agent),
    looseTitle: view.phases.length > 0 ? strings.task.other : strings.task.noPhases,
  };
}
