/**
 * The seam every region plugs into. Each of the sixteen regions is built against
 * this file and nothing else — a region never imports another region's source,
 * which is what lets them be built in parallel. Anything two regions need lives
 * beside this file (STANDARDS.md §1.2); the long-form argument behind several of
 * these types is in `docs/design-notes/shell-core.md`.
 *
 * Two rules enforced here rather than hoped for: no version number reaches the
 * interface (`ToolPresentation` has none; `toolPresentation()` is the only door
 * onto a `ResolvedTool`), and no backend vocabulary does either (the backend's
 * `ready | mismatch | unversioned | missing` becomes "needs update", "not
 * tracked", "not installed" once, below).
 */
import type { ReactNode } from "react";
import type {
  AppInfo,
  Cluster,
  GitBranch,
  GitChangeKind,
  GitCommit,
  GitDiff,
  GitDivergence,
  GitStatus,
  GitWorktree,
  GithubFeed,
  GithubItemState,
  GithubScope,
  Openable,
  PaneNode,
  ResolvedTool,
  ReviewComment,
  ReviewDraft,
  SplitDir,
  SurfaceKind,
  TerminalBusy,
  ToolStatus,
  UpdateState,
  WorktreeRef,
} from "../bindings";

// --- Tools ------------------------------------------------------------------

/** How a tool's resolution state appears to a person. `ok` is silent: four of six
 *  tools normally show nothing and tabs stay plain. It drives the health list
 *  behind the warning badge, and one tab rule — `not-installed` is dim and inert. */
export type ToolHealth = "ok" | "needs-update" | "not-tracked" | "not-installed";

/** The user-facing string for each. Never the backend's word for it. */
export const HEALTH_LABEL: Record<Exclude<ToolHealth, "ok">, string> = {
  "needs-update": "needs update",
  "not-tracked": "not tracked",
  "not-installed": "not installed",
};

/** The dot colour token for each, from the handoff's health-list crop. */
export const HEALTH_TOKEN: Record<Exclude<ToolHealth, "ok">, string> = {
  "needs-update": "var(--warn)",
  "not-tracked": "var(--warn)",
  "not-installed": "var(--err)",
};

/** Everything a component is allowed to know about a tool. Note what is absent:
 *  version, pinned version, repo URL, checkout path. The shell shows a name and a
 *  short description; versions live in veistra.toml and the backend, and stay there. */
export interface ToolPresentation {
  id: string;
  name: string;
  description: string;
  health: ToolHealth;
  /** `not-installed` tools render dim and cannot be selected. */
  interactive: boolean;
  /** A first-party app rather than a tool checkout: the routing decision the
   *  tool window cannot make any other way. Everything else about the two is
   *  identical here on purpose — see `docs/design-notes/shell-core.md`. */
  isApp: boolean;
  /** Rust places a native window over the pane, so the tool window pushes it
   *  `veistra/window-rect` and `veistra/overlays`. Only a first-party app can. */
  placesWindow: boolean;
}

/** The one door between the backend's tool type and the interface's. */
export function toolPresentation(tool: ResolvedTool): ToolPresentation {
  const health = healthOf(tool.status);
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    health,
    interactive: health !== "not-installed",
    isApp: false,
    placesWindow: false,
  };
}

/** The same door for a first-party app. An app has no health to map — it ships
 *  inside the binary asking about it, so `ok` is the only answer the type can
 *  carry, not an optimistic default. See `docs/design-notes/shell-core.md`. */
export function appPresentation(app: AppInfo): ToolPresentation {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    health: "ok",
    interactive: true,
    isApp: true,
    placesWindow: app.placesWindow === true,
  };
}

/** The third door: one surface of an installed plugin.
 *
 *  `isApp: false` is the load-bearing field, and the reason this cannot reuse
 *  `appPresentation` however alike the two look. It is what sends the surface's
 *  `invoke` over the broker to the plugin's own process rather than into
 *  `apps::call`, and resolves its frontend through `useToolFrontend` rather than
 *  straight off the app list.
 *
 *  `health` is `ok` because an `Openable` only ever describes a plugin that
 *  resolved: `plugins::resolve_enabled` drops the ones that will not load before
 *  the menu is built, so a row here is already a promise there is something to
 *  mount. The failures are not lost — they are what the plugin management screen
 *  draws, from `listPlugins`. */
export function pluginPresentation(surface: Openable): ToolPresentation {
  return {
    id: surface.id,
    name: surface.name,
    description: surface.description,
    health: "ok",
    interactive: true,
    isApp: false,
    placesWindow: false,
  };
}

function healthOf(status: ToolStatus): ToolHealth {
  switch (status.state) {
    case "ready":
      return "ok";
    case "mismatch":
      return "needs-update";
    case "unversioned":
      return "not-tracked";
    case "missing":
      return "not-installed";
  }
}

// --- Terminals — real PTYs, real emulation ----------------------------------
//
// A session is two separate things, and they are deliberately two interfaces:
// `TerminalSource` is identity and lifetime, which is Rust's and arrives on
// `shell:state`; `TerminalTransport` is bytes, per-session and high-volume.
// Keeping them apart is what makes the interception point in Rust worth having —
// see `docs/design-notes/shell-core.md`.

export interface TerminalSession {
  id: string;
  title: string;
  /** The dot on a terminal tab means *this agent finished*. It is not tool
   *  health, and it never appears on a tool tab. */
  agentFinished: boolean;
  /** Sessions sharing a group id render as one tab, laid out side by side in the
   *  deck by `TerminalDeck`. `null` for an ordinary, unsplit session. Owned by
   *  Rust like the rest of a session's identity — a group held together by one
   *  window's own state would come apart the moment a member of it moved. */
  groupId: string | null;
}

/** One entry in the tab row: a solo session, or every session that shares a group
 *  id, in the order they first appear in `sessions`. `id` is the tab's own
 *  identity — a session id for a solo tab, the shared group id for a split one —
 *  and is what `BottomPanel`'s `activeTabId` and `TerminalDeck`'s `activeId`
 *  compare against. Computed fresh from `sessions` rather than tracked, so no
 *  second place can drift from what Rust reports. */
export interface TerminalTabGroup {
  id: string;
  sessions: TerminalSession[];
}

export function groupTerminalTabs(sessions: TerminalSession[]): TerminalTabGroup[] {
  const tabs: TerminalTabGroup[] = [];
  const byGroupId = new Map<string, TerminalTabGroup>();

  for (const session of sessions) {
    if (session.groupId) {
      let tab = byGroupId.get(session.groupId);
      if (!tab) {
        tab = { id: session.groupId, sessions: [] };
        byGroupId.set(session.groupId, tab);
        tabs.push(tab);
      }
      tab.sessions.push(session);
    } else {
      tabs.push({ id: session.id, sessions: [session] });
    }
  }

  return tabs;
}

/* What a session is running, when it is running anything. Mirrors `pty::Busy` in
 * `bindings.ts`. Only ever asked when someone clicks close — no polling, no
 * per-session watcher. `null` means the shell is at a prompt with no child. */

/** Opening and closing sessions. There is deliberately no `subscribe`: which
 *  sessions exist is part of `shell:state`, so a second subscription would be a
 *  second answer to a question that already has one — see
 *  `docs/design-notes/shell-core.md`. */
export interface TerminalControl {
  /** A terminal in this window's **terminal band**, the band's own `+` and the
   *  default. Resolves once the shell is running and the session has an id.
   *  Addressed by window because that is what a control in a window can honestly
   *  name; Rust resolves it to whichever cluster that window is showing. See
   *  `TerminalSessionState.clusterId`. */
  create(windowLabel: string, cols: number, rows: number): Promise<string>;
  /** A terminal in a **pane of the active cluster**, from the Apps menu or the
   *  switcher's `+`. `paneId` names the pane this open is relative to; omitted,
   *  it is the active cluster's first. `dir` splits that pane and gives the
   *  terminal a pane of its own; omitted, it arrives as a tab in the named pane.
   *  Why there are two ways to make a terminal, and where the axis comes from:
   *  `docs/design-notes/shell-core.md`, `panes/splitOnOpen.ts`. */
  createInPane(windowLabel: string, paneId?: string, dir?: SplitDir): Promise<string>;
  /** Open a second pty and fold it into `sourceId`'s tab — the second half of
   *  "split terminal", the first half being `open_terminal` on the Rust side
   *  (reused, not duplicated; see `commands::split_terminal`). Grouping is decided
   *  in Rust, so this only ever *asks*; the group a caller should render comes
   *  back around through `shell:state`, same as `setTitle` below. */
  split(sourceId: string, cols: number, rows: number): Promise<string>;
  close(id: string): void;
  busy(id: string): Promise<TerminalBusy | null>;
  /** A session's own program set its title via an OSC escape sequence (`ESC ] 0 ;
   *  title BEL` / `ESC ] 2 ; title ST`), detected by the emulator that saw it.
   *  Lives here rather than on `TerminalTransport` because a title is identity,
   *  not a byte on the stream; this call only ever *reports*, and the title a
   *  caller renders comes back through `shell:state`. See
   *  `docs/design-notes/shell-core.md`. */
  setTitle(id: string, title: string): void;
}

/** One session's byte stream, in both directions. `attach` returns its own
 *  unsubscribe rather than taking an id to detach, because an id-keyed `detach`
 *  lets any caller silence someone else's terminal. */
export interface TerminalTransport {
  /** Start receiving this session's output. `onData` replays everything the shell
   *  has already said before anything new, so an emulator that mounts late still
   *  sees the whole session — not a convenience; without it every terminal would
   *  be permanently blank. See `src-tauri/src/pty.rs` and
   *  `docs/design-notes/shell-core.md`. */
  attach(id: string, onData: (chunk: string) => void): () => void;
  write(id: string, data: string): void;
  /** Files were dropped on this session: put their paths at its prompt, and run
   *  nothing. Separate from `write` because the quoting is not this side's to
   *  decide — whether `C:\Program Files\x` needs quotes, and which kind, depends on
   *  the shell the session spawned, and only Rust knows which that is (a tab's title
   *  is the running program's to overwrite at will). Paths go over unquoted and are
   *  quoted in `src-tauri/src/quoting.rs`. Fire-and-forget, like `write`. */
  insertPaths(id: string, paths: string[]): void;
  /** Tell the PTY how big its viewport is, in character cells. Not optional and
   *  not cosmetic: a TUI asks the pty for its size and draws to exactly that, so
   *  a pty that disagrees with the emulator produces a corrupt frame rather than
   *  a scaled one. */
  resize(id: string, cols: number, rows: number): void;
}

// --- Source control — real git, one shot at a time --------------------------
//
// Request/reply, because there is no watcher — the panel re-asks after every
// mutation and when the shown tool changes, and that is the whole update model.
// What this replaced: `docs/design-notes/shell-core.md`.

/** The single letter git itself would print in a status short-format, which is
 *  also what the row's leading column draws. `untracked` is `?` rather than `U`
 *  because `U` is already git's letter for an unmerged path. */
export const GIT_KIND_LETTER: Record<GitChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "U",
};

/** The colour token for that letter. No new tokens were introduced for the three
 *  kinds the old worktree list could not express — see
 *  `docs/design-notes/shell-core.md`. */
export const GIT_KIND_TOKEN: Record<GitChangeKind, string> = {
  modified: "var(--warn)",
  added: "var(--ok)",
  deleted: "var(--err)",
  renamed: "var(--warn)",
  untracked: "var(--text-dim-3)",
  conflicted: "var(--err)",
};

/** The index, scoped to a cluster: what has changed, what is staged, commit it.
 *  Every method takes a **cluster** id — it used to be a tool id, which was a
 *  dead end rather than a near-miss, and a cluster is also the honest subject.
 *  `git.rs`'s note on `git_cluster_status` and
 *  `docs/design-notes/shell-core.md` have the full account. */
export interface GitControl {
  /** `null` when the cluster has no project open or its project is not a repo. */
  status(clusterId: string): Promise<GitStatus | null>;
  diff(clusterId: string, path: string, staged: boolean): Promise<GitDiff>;
  stage(clusterId: string, paths: string[]): Promise<void>;
  unstage(clusterId: string, paths: string[]): Promise<void>;
  commit(clusterId: string, message: string): Promise<void>;
}

// --- Review notes — what a person wrote on a line of a diff -----------------
//
// Request/reply like `GitControl`, and for a stronger version of the same reason:
// these change only when somebody types, so there is nothing to watch. The backend
// re-reads the file on every `list`, which lets another window's writes turn up on the
// next cluster switch without an event.

/** Notes on one cluster's diffs, and the five things that can happen to one. Every
 *  method takes a **cluster** id, so the frontend never names a directory for the
 *  backend to write in — `GitControl`'s rule. Mirrors `src-tauri/src/review/`. */
export interface ReviewControl {
  /** Every note for this cluster's checkout, in file-then-line order. An empty array
   *  — never a failure — for a cluster with no project or one that is not a
   *  repository, the same two states `GitControl.status` answers `null` for. */
  list(clusterId: string): Promise<ReviewComment[]>;
  /** Write a note, and hand back the stored version with the id to address it
   *  by. Rejects on an empty body or a range that is not one. */
  add(clusterId: string, draft: ReviewDraft): Promise<ReviewComment>;
  /** Rewrite a note's body. Clears its `sentAt`: the agent was given different
   *  words, so it has not seen these. */
  update(clusterId: string, id: string, body: string): Promise<ReviewComment>;
  /** The person's own mark that a note is dealt with. Nothing sets it for them
   *  — handing a note to an agent is not evidence the agent acted on it. */
  resolve(clusterId: string, id: string, resolved: boolean): Promise<ReviewComment>;
  remove(clusterId: string, id: string): Promise<void>;
  /** Stamp notes as handed to an agent, and answer how many were. Called *after* the
   *  text has reached the clipboard or a terminal, so it forgives an id that names
   *  nothing rather than reporting a send that happened as one that did not. */
  markSent(clusterId: string, ids: string[]): Promise<number>;
}

/** How a note leaves the panel. No agent pane exists in this shell, so these two are the
 *  whole set: the clipboard, and the cluster's active terminal when one is open with an
 *  agent at it. Deliberately *not* a new transport — `docs/design-notes/shell-worktree.md`. */
export type ReviewSendTarget = "clipboard" | "terminal";

/** Writing the notes out. Built by `WindowRoot` from the terminal transport it already
 *  owns, rather than reached for by the diff region itself: a region may not import
 *  another region's source (§1.2), and "which terminal is this cluster showing" is a
 *  fact about the shell's state rather than about a diff. */
export interface ReviewSend {
  /** The terminal a send would type into, or `null` when the cluster's band has none.
   *  The surface disables that target rather than hiding it — the action is real, and
   *  why it is unavailable is worth showing. */
  terminalId: string | null;
  /** Type `text` at that terminal. No trailing newline is added: this only ever types,
   *  and whether the agent is handed a message or has one submitted stays the person's. */
  toTerminal(id: string, text: string): void;
  /** Put `text` on the system clipboard. Rejects if the platform refuses. */
  toClipboard(text: string): Promise<void>;
}

// --- Worktrees — one cluster, one checkout of its own -----------------------
//
// A cluster can work inside a git worktree, so two clusters can hold two branches
// of one repository open at once. `git worktree list` — not anything Veistra writes
// down — is the authority on which ones exist. They are created *outside* the
// project, at `<project>/../.worktrees/<project-name>/<name>/`, and that
// placement is load-bearing: `docs/design-notes/shell-core.md`.

/** Creating, listing, and discarding a cluster's worktree. Request/reply for the
 *  same reason `GitControl` is: there is no watcher, and every one of these
 *  follows a user action or a cluster switch. */
export interface WorktreeControl {
  /** Every worktree of the cluster's repository, main checkout included. Scoped
   *  to a cluster rather than a path because the frontend never names a directory
   *  for the backend to run `git` in. Empty when the cluster has no project, or
   *  has one that is not a repository; neither is an error worth a dialog. */
  list(clusterId: string): Promise<GitWorktree[]>;
  /** The repository's local branches as one graph, newest first. Here rather than
   *  on `GitControl` because it spans every worktree of the repository — see
   *  `docs/design-notes/shell-core.md`. */
  graph(clusterId: string, limit: number): Promise<GitCommit[]>;
  /** Every local branch, newest commit first. Here rather than on `GitControl`
   *  for `graph`'s reason: a branch is a fact about the repository. */
  branches(clusterId: string): Promise<GitBranch[]>;
  /** Move this cluster's checkout onto a branch, or any commit when `detach`.
   *  Nothing is pre-checked, so a refusal arrives in git's own words. */
  checkout(clusterId: string, target: string, detach: boolean): Promise<void>;
  /** Everything this cluster's worktree has changed since it forked. `null` for a
   *  cluster working in its project folder: there is no fork point to measure
   *  from, and the panel draws its ordinary source-control view instead. */
  divergence(clusterId: string): Promise<GitDivergence | null>;
  /** One file's whole divergence, as two texts for the diff editor. Takes the
   *  `mergeBase` from the `GitDivergence` the file came from rather than letting
   *  the backend resolve it again — see `docs/design-notes/shell-core.md`. */
  divergenceDiff(clusterId: string, path: string, mergeBase: string): Promise<GitDiff>;
  /** Cut a new branch named `name` from the current HEAD, check it out into a new
   *  worktree, and point the cluster at it. One name for both the branch and the
   *  folder. Fails rather than overwrites when either already exists. */
  create(clusterId: string, name: string): Promise<WorktreeRef>;
  /** Remove the worktree and return the cluster to working in its project.
   *  Deletes the checkout on disk but never the branch. `force` is what a
   *  worktree with uncommitted changes needs, and git's refusal without it is the
   *  only thing standing between a stray click and unrecoverable work. */
  remove(clusterId: string, force: boolean): Promise<void>;
}

/** Where a cluster's work actually is: its worktree when it has one, else its
 *  project folder. The precedence lives here and nowhere else; Rust resolves the
 *  same one in `project::cluster_path`. Deliberately *not* the answer to "which
 *  project is this cluster on" — that is `Cluster.project`. Synchronous, so it
 *  cannot check the directory still exists: callers that walk the result should
 *  treat a missing directory as empty rather than as a failure. Full account in
 *  `docs/design-notes/shell-core.md`. */
export function clusterRoot(cluster: Cluster): string | null {
  return cluster.worktree?.path ?? cluster.project;
}

// --- GitHub — what is open on the repository this cluster is a checkout of ---
//
// Read-only for 0.2.0: browse, and open a worktree from an item. Nothing here
// writes to GitHub, which is why this interface has one fetch and no verbs — the
// one action a person can take is `WorktreeControl.create` above, called with a
// name the backend put on the item.

/** Fetching the feed. One method, request/reply, for `GitControl`'s reason:
 *  there is nothing to watch, and a refresh follows a cluster switch or a
 *  button. */
export interface GithubControl {
  /** Every outcome is a `GithubFeed` variant rather than a rejection — a spent
   *  quota and a project that is not on GitHub are both states to draw. The
   *  promise rejecting at all means the IPC call itself failed. */
  feed(clusterId: string, scope: GithubScope): Promise<GithubFeed>;
  /** Show one item on github.com. Rejects for any other address — the check is
   *  Rust's, so the interface cannot be talked into opening something else. */
  openInBrowser(url: string): Promise<void>;
}

/** Storing a GitHub token. Separate from `GithubControl` because it is about
 *  neither a cluster nor a repository: one token serves every project, and the
 *  app library's own sign-in writes the same one. An empty string signs out.
 *
 *  There is deliberately no `isSignedIn` here even though a binding for it
 *  exists. `GithubFeed.authenticated` already says whether the request that
 *  produced the list on screen used a token, which is both the same answer and
 *  a better-sourced one — a separate query could disagree with the list beside
 *  it. And the token is only ever written: nothing reads it back, because a
 *  secret in the renderer is a secret in a devtools console. */
export interface GithubAuthControl {
  signIn(token: string): Promise<void>;
}

/** How a GitHub item's state is drawn. Backend vocabulary reaches the interface
 *  here unchanged, which is the exception §2 warns about — and it is deliberate:
 *  "open", "closed", "merged" and "draft" are GitHub's words on GitHub's own
 *  screen, and translating them would be inventing a second vocabulary for
 *  something the user already reads elsewhere in the same words. */
export const GITHUB_STATE_TOKEN: Record<GithubItemState, string> = {
  open: "var(--ok)",
  closed: "var(--err)",
  merged: "var(--accent)",
  draft: "var(--text-dim-2)",
};

/** The label under each state's dot. */
export const GITHUB_STATE_LABEL: Record<GithubItemState, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  draft: "Draft",
};

// --- Search — stubbed index, real interaction -------------------------------

export type SearchType = "content" | "scripts" | "assets" | "terminal" | "settings";

export const SEARCH_TYPE_LABEL: Record<SearchType, string> = {
  content: "Content",
  scripts: "Scripts",
  assets: "Assets",
  terminal: "Terminal output",
  settings: "Tool settings",
};

export interface SearchResult {
  /** The lowercase kind shown in the leading 58px column. */
  type: string;
  label: string;
}

export interface SearchIndex {
  query(text: string, types: SearchType[]): SearchResult[];
}

// --- Menus — every menu opens, and an item that cannot act says so ----------

export interface MenuItem {
  label: string;
  /** Shown at the trailing edge of the row, and **bound** — an accelerator on
   *  display is a promise that the keystroke does this. Either `useKeyboard.ts`
   *  binds it, or the platform already does. Nothing here is decorative; see the
   *  accelerator note in `titlebar/TitleBar.tsx`. */
  accelerator?: string;
  separatorBefore?: boolean;
  onSelect?: () => void;
  /** Renders inert and unclickable — the native `disabled` attribute, not a
   *  dimmed-but-live button. The only way an item is allowed to be unable to act:
   *  an item that renders live and silently does nothing teaches the user that
   *  the menu lies. */
  disabled?: boolean;
  /** A sentence about this row, shown as its `title`. Almost always **why it is
   *  disabled**, and rendered on the wrapping `<li>` rather than the button
   *  because a `disabled` button receives no pointer events — see
   *  `docs/design-notes/shell-core.md`. */
  hint?: string;
  /** Rows that open to the side, behind a caret. A row with a `submenu` has no
   *  `onSelect` and does not close the menu when clicked — it opens. `disabled`
   *  still applies, and disables the whole branch. Why presets are the only thing
   *  that got one: `docs/design-notes/shell-core.md`. */
  submenu?: MenuItem[];
  /** A row that asks for one line of text before it acts — the same surface the
   *  menu is already drawing, with the list swapped for a field. Why not
   *  `window.prompt`: `docs/design-notes/shell-core.md`. */
  prompt?: MenuPrompt;
}

/** One line of text, asked for inside the menu that will act on it. `onSubmit`
 *  rejects with something to *show* rather than something to log; the menu stays
 *  open on a rejection and closes on success. See
 *  `docs/design-notes/shell-core.md`. */
export interface MenuPrompt {
  /** Above the field. A sentence, not a word: this is the only explanation. */
  label: string;
  placeholder?: string;
  /** Pre-filled and selected, so a suggested name can be taken with Enter. */
  initialValue?: string;
  confirmLabel: string;
  onSubmit: (value: string) => Promise<void>;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

// --- Updates ----------------------------------------------------------------

/**
 * What the status bar says about a newer Veistra, or `null` for the far more
 * common case of nothing worth a pixel.
 *
 * Note what is absent: the version being installed *over*, the download's byte
 * counts, the endpoint, and the plugin's own error type. A status bar shows one
 * line; everything cut here is either already on screen or was never a sentence.
 */
export interface UpdateNotice {
  /** The line in the bar. Short enough to sit beside a branch name. */
  label: string;
  /** The whole sentence, as the row's `title`. Never a repeat of `label`. */
  detail: string;
  /** How the row reads. `offer` is the only one that takes the accent — the
   *  rest are ordinary status, and an error is not an alarm. */
  tone: "offer" | "status" | "error";
  /** Present only when pressing the row would do something. A row without one
   *  renders as text, not as a button that swallows clicks. */
  onSelect?: () => void;
}

/**
 * The one door between `updater::UpdateState` and the bar — `healthOf`'s job,
 * for the updater.
 *
 * **`asked` is what keeps this quiet.** A launch check that finds nothing, or
 * that fails because the machine is on a train, has nothing to tell anybody:
 * both return `null`. The same two states after the user chose Check for
 * Updates are an answer to a question, and are shown. An offer is shown either
 * way, because that is the one thing worth interrupting a status bar for — and
 * it still interrupts nothing, being a line of text with a click on it.
 */
export function updateNotice(
  state: UpdateState,
  asked: boolean,
  onInstall: () => void,
): UpdateNotice | null {
  switch (state.state) {
    case "idle":
      return null;
    case "checking":
      return asked
        ? { label: "Checking…", detail: "Asking for a newer version.", tone: "status" }
        : null;
    case "up-to-date":
      return asked
        ? { label: "Up to date", detail: `${state.version} is the newest release.`, tone: "status" }
        : null;
    case "available":
      return {
        label: `Update to ${state.version}`,
        detail: state.notes === "" ? `${state.version} is available.` : state.notes,
        tone: "offer",
        onSelect: onInstall,
      };
    case "downloading":
      return {
        label: state.percent === null ? "Downloading…" : `Downloading ${state.percent}%`,
        detail: "Fetching the installer. Veistra restarts when it finishes.",
        tone: "status",
      };
    case "installing":
      return {
        label: "Installing…",
        detail: "Veistra closes and reopens on the new version.",
        tone: "status",
      };
    case "failed":
      return asked ? { label: "Update failed", detail: state.message, tone: "error" } : null;
    // Shown only when asked, and never as an error: a development build is not
    // broken for being unable to install a release over itself.
    case "unsupported":
      return asked ? { label: "No updates here", detail: state.reason, tone: "status" } : null;
  }
}

// --- Instances, panes, clusters — the layout --------------------------------
//
// An *app id* is a type, an *instance id* is an identity: `files` names some
// code, `files-1` and `files-2` name two live surfaces with their own open files.
// All of it is owned by Rust and arrives on `shell:state`, for the reason
// `TerminalSession.groupId` gives — see `docs/design-notes/shell-core.md`.

/** The layout itself. Mirrors Rust and is declared in `bindings.ts`. */
export type { PaneNode, SplitDir, SurfaceInstance, SurfaceKind } from "../bindings";

/** One page — a cluster kind drawn as a chip, not a cluster you work in. Mirrors
 *  `pages::PageInfo`; `Cluster.page` names one. See `src-tauri/src/pages.rs`. */
export type { PageInfo } from "../bindings";

// --- Layout presets — an arrangement, and which app belongs in each pane ----
//
// Mirrors `src-tauri/src/presets/mod.rs`: a `PaneNode` is made of *identities*, a
// `PresetNode` is the same shape with all of them removed, leaving a direction,
// the weights, and the **app ids** in each pane. Nothing in the shell draws a
// preset's shape today; the menu draws its name. `docs/design-notes/shell-core.md`.

/** Mirrors `presets::LayoutPreset` and is declared in `bindings.ts`. */
export type { LayoutPreset } from "../bindings";

/** One changed region of a file against HEAD, in lines. Mirrors `git::GitHunk`,
 *  and is what the editor's gutter draws one mark per. Against HEAD rather than
 *  the index, matching VS Code; a deletion is drawn as a wedge between two lines
 *  rather than as a bar beside one. See `docs/design-notes/shell-core.md`. */
export interface GitHunk {
  kind: "added" | "modified" | "deleted";
  /** 1-based, in the file as it is now. Already clamped to a minimum of 1. */
  start: number;
  /** How many current lines the region covers. `0` for a deletion. */
  lines: number;
  originalStart: number;
  originalLines: number;
}

/** A cluster, its layout, its git status, and the presets it can be arranged
 *  from — every type below mirrors Rust and is declared in `bindings.ts`,
 *  re-exported here because this is the file the shell reads its types from. See
 *  [`clusterRoot`] for which of a cluster's two possible roots wins. */
export type {
  Cluster,
  GitBranch,
  GitCommit,
  GitDiff,
  GitDivergence,
  GitFileChange,
  GitStatus,
  GitWorktree,
  GithubFeed,
  GithubItem,
  GithubItemKind,
  GithubItemState,
  GithubScope,
  GithubTrouble,
  ReviewComment,
  ReviewDraft,
  ReviewScope,
  TerminalBusy,
  WorktreeRef,
} from "../bindings";

// `Cluster` — one badge in the rail's strip — is re-exported above. Switching
// cluster tabs swaps the pane tree, the project underneath it, *and* the
// terminals in the band below it, which makes a chip a place rather than a
// filter. See `TerminalSessionState.clusterId` and `docs/design-notes/shell-core.md`.

/** Whichever of a cluster's surfaces and terminals a tab happens to be,
 *  flattened to the one shape a strip draws. `paneId` is the whole
 *  distinction — a surface lives in a pane, a terminal in the panel, `null`
 *  says which. Built fresh from `shell:state` every render, not tracked. */
export interface ClusterMember {
  /** The tab's own identity: an instance id, or a terminal tab's group id. */
  id: string;
  /** What the drag layer moves when this tab is dragged: the same as `id` except
   *  for a split terminal, whose tab is identified by the group and whose
   *  *sessions* are what can actually be moved. Carried explicitly so no caller
   *  has to know that a group id is not a session id. */
  dragId: string;
  title: string;
  kind: SurfaceKind;
  /** Which app this is an instance of. Absent for a terminal tab; the strip
   *  reads it to give a File Viewer its file icon. */
  appId?: string;
  /** The pane holding it, or `null` when it lives in the terminal band. */
  paneId: string | null;
  /** On screen right now — its pane's active tab, or the band's. */
  showing: boolean;
  /** Only ever true for a terminal. Drives the dot, exactly as in the band. */
  agentFinished: boolean;
}

/** Every tab in a tree, in layout order. */
export function paneTabs(node: PaneNode): string[] {
  return node.kind === "leaf" ? node.tabs : node.children.flatMap(paneTabs);
}

/** Which pane holds a tab, or `null` if this tree does not have it. */
export function paneOfTab(node: PaneNode, instanceId: string): string | null {
  if (node.kind === "leaf") return node.tabs.includes(instanceId) ? node.id : null;
  for (const child of node.children) {
    const found = paneOfTab(child, instanceId);
    if (found) return found;
  }
  return null;
}

/** Every leaf in a tree, in layout order. */
export function paneLeaves(node: PaneNode): Extract<PaneNode, { kind: "leaf" }>[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(paneLeaves);
}

// --- Drag — every interaction, one vocabulary -------------------------------

/** What is currently in the air, `what` saying which — a union so a cluster can't fall through the tab branches. */
export type DragPayload = SurfaceDrag | ClusterDrag;

/** A tab in the air — an app surface and a terminal drag identically. `kind` is carried for the ghost. */
export interface SurfaceDrag {
  what: "surface";
  instanceId: string;
  title: string;
  kind: SurfaceKind;
  /** Only ever true for a terminal. Drives the dot on the ghost. */
  agentFinished?: boolean;
  /** Where it came from, so a drop that lands nowhere can be a no-op. */
  fromPaneId: string | null;
  /** Which cluster it came from — the other half of the cluster-chip drop's
   *  environment gate. `null` only for a page's surface, never draggable. */
  fromClusterId: string | null;
}

/** A whole cluster in the air — its chip, and with it its entire pane tree. The
 *  gesture exists for a second monitor. Nothing of the cluster's contents is
 *  carried: the id is the address, and the tree travels with it in the backend. */
export interface ClusterDrag {
  what: "cluster";
  clusterId: string;
  name: string;
}

/** Where a drag would land if it were released now. `pane` with an `edge` splits
 *  that pane on that side; with no edge it appends to the tab strip. `strip` is
 *  a drop between two tabs, `index` naming the insertion point. `panel` is the
 *  terminal band. `detach` is clear of every target, and releases into a window.
 *  `none` is a release this payload cannot make — never what a hit test
 *  returns; `useDrag` substitutes it and does nothing on release. */
export type DropTarget =
  | { kind: "pane"; paneId: string; edge: SplitDir | null; before: boolean }
  | { kind: "strip"; paneId: string; index: number }
  | { kind: "panel" }
  /** A cluster's own chip — VEISTRA-UX-REWORK.md §5's same-environment move.
   *  `refused` is computed once, by `useDrag`'s `resolve`, and read by the
   *  chip, the hint bar and `commit` alike. */
  | { kind: "cluster"; clusterId: string; refused: boolean }
  /** Empty switcher space — VEISTRA-UX-REWORK.md §5's "new cluster in the same
   *  environment, holding the tab." Always allowed. */
  | { kind: "new-cluster" }
  | { kind: "detach" }
  | { kind: "none" };

export interface DragState {
  payload: DragPayload;
  /** Viewport coordinates of the pointer, for the ghost. */
  x: number;
  y: number;
  /** Where a release right now would put it. */
  target: DropTarget;
}

/** What it takes to draw a pane tree. Here rather than in `panes/PaneTree.tsx`
 *  because two regions need the shape and only one draws it — `toolwindow` must
 *  not import `panes` (§1.2). See `docs/design-notes/shell-core.md`. */
export interface PaneTreeProps {
  tree: PaneNode;
  /** The pane an open acts on, drawn with the active-pane outline — opening
   *  an app splits this pane along its longer axis. See `panes/splitOnOpen.ts`. */
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  /** Commits a divider drag. One weight per child, summing to 1. */
  onResize: (splitId: string, sizes: number[]) => void;
  /** Called as panes mount, move and unmount. See `PaneTree`'s own header. */
  onHostChange: (paneId: string, el: HTMLDivElement | null) => void;
  /** Where a drag would land right now, so the target pane can say so. */
  dropTarget?: DropTarget | null;
  /** Every tab in the tree, flat — what `ClusterBar` drew inline before the
   *  per-pane strips came back. `PaneTree` groups it by `paneId` itself. */
  members?: ClusterMember[];
  onSelectMember?: (member: ClusterMember) => void;
  onCloseMember?: (member: ClusterMember) => void;
  /** A tab's own drag handle. Omitted, a strip's tabs are not draggable. */
  dragHandleFor?: (member: ClusterMember) => DragHandleProps | undefined;
  /** The one pane drawn full-size, rest hidden but not unmounted, or `null`
   *  for the ordinary grid. VEISTRA-UX-REWORK.md §5. */
  maximizedPaneId?: string | null;
  onToggleMaximizePane?: (paneId: string) => void;
  /** What the `+` at the end of each pane's tab strip offers. Omitted, no `+`. */
  appPicker?: PaneAppPicker;
}

/** The list and the action behind a pane's `+` (add app) button. */
export interface PaneAppPicker {
  /** The same list the Apps menu is built from. */
  apps: Openable[];
  /** Why nothing can be opened right now, or `undefined`. */
  blocked?: string;
  /** Opens `entry` as a new tab in `paneId` — never a split. */
  onOpen: (entry: Openable, paneId: string) => void;
}

/** What a region spreads onto an element to make it a drag source. */
export interface DragHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  style: { cursor: string };
}

// --- The frame --------------------------------------------------------------

/** Which window this is. Only the title bar's traffic-light treatment still turns
 *  on this: both kinds now have a cluster strip in the rail and a switcher in
 *  the title bar, because a detached window holds real clusters that can be
 *  added to and switched between. */
export type WindowKind = "main" | "detached";

/** The regions, as slots. `Frame` owns the geometry and knows nothing about
 *  what goes in them, which is the whole reason the regions can be built in
 *  parallel. See `docs/design-notes/shell-core.md`. */
export interface FrameSlots {
  titleBar: ReactNode;
  toolWindow: ReactNode;
  /** A notice band above the tool window, full width of the column. Omitted, nothing renders. */
  banner?: ReactNode;
  /** The terminal band, under the tool window and stopping at the docked
   *  page's edge — `.frame__main` in frame.css says why it does not span the
   *  window. Omitted, neither the band nor its handle is rendered at all. */
  bottomPanel?: ReactNode;
  /** The right-side project-page rail (`docs/VEISTRA-UX-REWORK.md` §4). Chrome owns the slot; **rail** owns what fills it. */
  projectRail?: ReactNode;
  /** A project page, docked beside the panes — Git's aside is the first. Width is `projectPageWidth`.
   *  The window's only right-hand sidebar. `null`, `false` and `undefined` all mean no page is open,
   *  and then no column, handle or border is drawn at all. */
  projectPage?: ReactNode;
  /** The same page, **expanded**: covers the tool window and docked page, while the rail stays visible. */
  projectPageExpanded?: ReactNode;
  statusBar: ReactNode;
  /** Portalled above everything: drag ghost and drop outlines. */
  overlay?: ReactNode;
  /** Covers the split row — tool window, band and docked page — while search is open,
   *  leaving the title bar above and the status bar below untouched. Its own
   *  band rather than part of `overlay`; see `docs/design-notes/shell-core.md`. */
  splitOverlay?: ReactNode;
}
