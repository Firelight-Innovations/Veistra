import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Pencil,
  SlidersHorizontal,
  SquarePen,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  NO_SESSION,
  agentName,
  type AgentCluster,
  type AgentSession,
  type AgentSessionState,
} from "../state/agentSessions";
import {
  SAVED_SESSIONS,
  renameAgentTab,
  useSavedSessions,
  type SavedSession,
  type SavedSessionsSource,
} from "../state/savedSessions";
import { useAgentMenu } from "../useAgentMenu";
import type { AgentMenuActions, AgentMenuSubject } from "../agentMenuItems";
import "./agentspage.css";

/** The page's words, in one place. */
const TEXT = {
  newSession: (cluster: string) => `New agent session in ${cluster}`,
  empty: "No agent sessions",
  actions: "Agent actions",
  newAgent: "New Agent",
  search: "Search",
  workflows: "Workflows",
  customize: "Customize",
  soon: "Coming soon",
  untitled: "New session",
  current: "Current cluster",
  previous: "Previous sessions",
  noPrevious: "No previous sessions",
  archivedFold: "Archived",
  archive: "Archive",
  restore: "Restore",
  rename: "Rename",
  renameSession: "Rename session",
  renameField: "Session name",
  when: (updated: number) =>
    new Date(updated).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  state: {
    none: "Not started",
    starting: "Starting",
    ready: "Ready",
    working: "Working",
    needsInput: "Needs you",
    stopped: "Stopped",
    failed: "Failed",
  } satisfies Record<AgentSessionState, string>,
  harness: { claude: "Claude", codex: "Codex", veistra: "Veistra" } as Record<string, string>,
};

const ICON: Record<AgentSessionState, LucideIcon> = {
  none: Circle,
  starting: LoaderCircle,
  ready: CircleCheck,
  working: LoaderCircle,
  needsInput: CircleAlert,
  stopped: CircleStop,
  failed: CircleX,
};

export interface AgentsPageProps {
  clusters: readonly AgentCluster[];
  sessions: ReadonlyMap<string, AgentSession>;
  activeClusterId: string | null;
  /** Bring a tab forward, in whichever cluster holds it. */
  onOpen: (instanceId: string) => void;
  /** Open a new agent tab in a cluster. */
  onNew: (clusterId: string) => void;
  /** Open a saved session of the current cluster's project in an agent tab. */
  onResume: (sessionId: string) => void;
  /** Where the saved sessions come from; tests swap it. */
  savedSessions?: SavedSessionsSource;
  /** Name an open session, as `/rename` does in its tab. A blank name takes the name back. */
  onRename?: (instanceId: string, name: string) => void;
  /** What the right-click menu on a session may do; omitted, its rows are disabled. */
  agentMenu?: AgentMenuActions;
}

/** A row's `onContextMenu`, for the subject it stands for. */
type OpenMenu = (subject: AgentMenuSubject) => (e: MouseEvent) => void;

function PreviousRow({
  session,
  onResume,
  onArchive,
  openMenu,
}: {
  session: SavedSession;
  onResume: () => void;
  onArchive: () => void;
  openMenu: OpenMenu;
}) {
  const harness = TEXT.harness[session.harness] ?? session.harness;
  const label = session.archived ? TEXT.restore : TEXT.archive;
  const Toggle = session.archived ? ArchiveRestore : Archive;
  return (
    <li className="k-agents__saved">
      <button
        type="button"
        className="k-agents__row"
        onClick={onResume}
        onContextMenu={openMenu({
          kind: "saved",
          id: session.id,
          title: session.title,
          archived: session.archived,
        })}
      >
        <MessageSquare className="k-agents__glyph" size={14} strokeWidth={2} aria-hidden />
        <span className="k-agents__text">
          <span className="k-agents__title" title={session.title}>
            {session.title || TEXT.untitled}
          </span>
          <span className="k-agents__meta">{`${harness} · ${TEXT.when(session.updated)}`}</span>
        </span>
      </button>
      <button
        type="button"
        className="k-agents__archive"
        aria-label={`${label} ${session.title}`}
        title={label}
        onClick={onArchive}
      >
        <Toggle size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

/**
 * The current cluster's project's saved sessions, newest first, as the agent
 * tab's history popover lists them, with the archived ones folded away.
 * Drawn only while the page is, so it asks only while it can be seen.
 */
function PreviousSessions({
  clusterId,
  needle,
  onResume,
  source,
  openMenu,
}: {
  clusterId: string | null;
  needle: string;
  onResume: (sessionId: string) => void;
  source: SavedSessionsSource;
  openMenu: (subject: AgentMenuSubject, more?: AgentMenuActions) => (e: MouseEvent) => void;
}) {
  const { sessions, failed, archive } = useSavedSessions(clusterId, source);
  const openRowMenu: OpenMenu = (subject) => openMenu(subject, { resume: onResume, archive });
  const [showArchived, setShowArchived] = useState(false);
  // A cluster with no worktree has no history to show, so it shows none.
  if (sessions === null || failed || clusterId === null) return null;
  const matches = sessions.filter((s) =>
    `${s.title} ${TEXT.harness[s.harness] ?? s.harness}`.toLowerCase().includes(needle),
  );
  const open = matches.filter((s) => !s.archived);
  const archived = matches.filter((s) => s.archived);
  const row = (s: SavedSession) => (
    <PreviousRow
      key={s.id}
      session={s}
      onResume={() => onResume(s.id)}
      onArchive={() => archive(s.id, !s.archived)}
      openMenu={openRowMenu}
    />
  );
  return (
    <section className="k-agents__previous" aria-labelledby="k-agents-previous">
      <header className="k-agents__head">
        <h3 id="k-agents-previous" className="k-agents__name">
          {TEXT.previous}
        </h3>
      </header>
      {open.length === 0 ? (
        <p className="k-agents__empty">{TEXT.noPrevious}</p>
      ) : (
        <ul className="k-agents__list">{open.map(row)}</ul>
      )}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            className="k-agents__fold"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((was) => !was)}
          >
            <ChevronRight
              className="k-agents__chevron"
              size={14}
              strokeWidth={2}
              aria-hidden
              data-open={showArchived ? "" : undefined}
            />
            {`${TEXT.archivedFold} (${archived.length})`}
          </button>
          {showArchived && <ul className="k-agents__list">{archived.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

/**
 * A prompt as its tab is named: each `[@label](<uri>)` reference the agent tab
 * sends reads as `@label`, and runs of whitespace close up.
 */
export function plainPrompt(prompt: string): string {
  return prompt
    .replace(/\[(@[^\]]*)\]\(<[^>]*>\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The name of an open session, as an input over its row, until Enter, Esc or a click away. */
function RenameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const settled = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  };
  return (
    <input
      ref={field}
      className="k-agents__rename"
      type="text"
      defaultValue={initial}
      aria-label={TEXT.renameField}
      maxLength={100}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function Row({
  id,
  title,
  session,
  onOpen,
  onRename,
  openMenu,
}: {
  id: string;
  title: string;
  session: AgentSession;
  onOpen: () => void;
  onRename: (instanceId: string, name: string) => void;
  openMenu: OpenMenu;
}) {
  const [renaming, setRenaming] = useState(false);
  const Icon = ICON[session.state];
  const harness =
    session.harness === null ? null : (TEXT.harness[session.harness] ?? session.harness);
  const state = TEXT.state[session.state];
  const prompt = session.prompt === null ? null : plainPrompt(session.prompt);
  const name = agentName(title);
  const label = name ?? (prompt || title || TEXT.untitled);
  return (
    <li className="k-agents__open">
      {renaming ? (
        <div className="k-agents__row k-agents__row--editing" data-state={session.state}>
          <Icon className="k-agents__glyph" size={14} strokeWidth={2} aria-hidden />
          <RenameField
            initial={name ?? ""}
            onDone={(next) => {
              setRenaming(false);
              if (next !== null && next.trim() !== (name ?? "")) onRename(id, next);
            }}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            className="k-agents__row"
            data-state={session.state}
            onClick={onOpen}
            onDoubleClick={() => setRenaming(true)}
            onContextMenu={openMenu({ kind: "open", id, name })}
          >
            <Icon className="k-agents__glyph" size={14} strokeWidth={2} aria-hidden />
            <span className="k-agents__text">
              <span className="k-agents__title" title={label}>
                {label}
              </span>
              <span className="k-agents__meta">{harness ? `${harness} · ${state}` : state}</span>
            </span>
          </button>
          <button
            type="button"
            className="k-agents__archive"
            aria-label={TEXT.renameSession}
            title={TEXT.rename}
            onClick={() => setRenaming(true)}
          >
            <Pencil size={13} strokeWidth={1.75} aria-hidden />
          </button>
        </>
      )}
    </li>
  );
}

/**
 * The Agents page: the agent sessions in this window's clusters, live. Another
 * window's clusters are on its own page. A row brings its tab forward, in its
 * own cluster; a cluster's `+` opens a new agent tab there. Below them, the
 * current cluster's project's previous sessions, each opened by `onResume`.
 * The shell draws it (`pages.rs`'s `app_id: None`), from `useAgentSessions`.
 */
export default function AgentsPage({
  clusters,
  sessions,
  activeClusterId,
  onOpen,
  onNew,
  onResume,
  savedSessions = SAVED_SESSIONS,
  onRename = (instanceId, name) => void renameAgentTab(instanceId, name).catch(() => {}),
  agentMenu,
}: AgentsPageProps) {
  // The page's own rename is the one the menu uses, so both go the same way.
  const menu = useAgentMenu({
    ...agentMenu,
    rename: async (instanceId, name) => onRename(instanceId, name),
  });
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = clusters.map((cluster) => ({
    ...cluster,
    tabs:
      needle === ""
        ? cluster.tabs
        : cluster.tabs.filter((tab) => {
            const prompt = plainPrompt(sessions.get(tab.id)?.prompt ?? "");
            return `${tab.title} ${prompt}`.toLowerCase().includes(needle);
          }),
  }));
  return (
    <div className="k-agents">
      <nav className="k-agents__actions" aria-label={TEXT.actions}>
        <button
          type="button"
          className="k-agents__action"
          disabled={activeClusterId === null}
          onClick={() => activeClusterId !== null && onNew(activeClusterId)}
        >
          <SquarePen size={14} strokeWidth={2} aria-hidden />
          {TEXT.newAgent}
        </button>
        <label className="k-agents__action k-agents__search">
          <Search size={14} strokeWidth={2} aria-hidden />
          <input
            type="text"
            value={query}
            spellCheck={false}
            placeholder={TEXT.search}
            aria-label={TEXT.search}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="k-agents__action" disabled title={TEXT.soon}>
          <Workflow size={14} strokeWidth={2} aria-hidden />
          {TEXT.workflows}
        </button>
        <button type="button" className="k-agents__action" disabled title={TEXT.soon}>
          <SlidersHorizontal size={14} strokeWidth={2} aria-hidden />
          {TEXT.customize}
        </button>
      </nav>
      {visible.map((cluster) => (
        <section
          key={cluster.id}
          className="k-agents__cluster"
          aria-labelledby={`k-agents-${cluster.id}`}
          data-active={cluster.id === activeClusterId ? "" : undefined}
        >
          <header className="k-agents__head">
            <h3 id={`k-agents-${cluster.id}`} className="k-agents__name">
              {cluster.name}
            </h3>
            {cluster.id === activeClusterId && (
              <span className="k-agents__current">{TEXT.current}</span>
            )}
            <button
              type="button"
              className="k-agents__new"
              aria-label={TEXT.newSession(cluster.name)}
              title={TEXT.newSession(cluster.name)}
              onClick={() => onNew(cluster.id)}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </header>
          {cluster.tabs.length === 0 ? (
            <p className="k-agents__empty">{TEXT.empty}</p>
          ) : (
            <ul className="k-agents__list">
              {cluster.tabs.map((tab) => (
                <Row
                  key={tab.id}
                  id={tab.id}
                  title={tab.title}
                  session={sessions.get(tab.id) ?? NO_SESSION}
                  onOpen={() => onOpen(tab.id)}
                  onRename={onRename}
                  openMenu={menu.open}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      <PreviousSessions
        clusterId={activeClusterId}
        needle={needle}
        onResume={onResume}
        source={savedSessions}
        openMenu={menu.open}
      />
      {menu.menu}
    </div>
  );
}
