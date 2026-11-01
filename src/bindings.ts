/**
 * Typed bridge to the Rust backend.
 *
 * These types mirror the `#[derive(Serialize)]` structs in `src-tauri/src/`.
 * They are hand-maintained: change a Rust struct, change it here too. (If that
 * ever gets tedious, `tauri-specta` can generate this file from the Rust types
 * instead — worth adopting once the command surface stops moving.)
 *
 * Everything below crosses the IPC boundary as JSON, so keep it to plain data.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Mirrors `tool::ToolKind`. */
export type ToolKind = "runtime" | "dev-tool";

/**
 * Mirrors `tool::ToolStatus`.
 *
 * Rust serializes this enum with an internal `state` tag, which lands here as a
 * discriminated union — narrow on `status.state` and TypeScript gives you the
 * right extra fields.
 */
export type ToolStatus =
  | { state: "ready"; version: string }
  | { state: "mismatch"; expected: string; found: string }
  | { state: "unversioned" }
  | { state: "missing" };

/** Mirrors `tool::ResolvedTool` (with `ToolSpec` flattened into it). */
export interface ResolvedTool {
  id: string;
  name: string;
  kind: ToolKind;
  repo: string;
  /** The version pinned in veistra.toml. */
  version: string;
  description: string;
  path: string | null;
  status: ToolStatus;
  checkoutPath: string;
  isGitRepo: boolean;
}

/** Mirrors `discovery::StackSnapshot`. */
export interface StackSnapshot {
  stackName: string;
  stackVersion: string;
  manifestPath: string;
  checkoutRoot: string;
  tools: ResolvedTool[];
}

/** Re-read veistra.toml and re-scan the disk. Also serves as "refresh". */
export function loadStack(): Promise<StackSnapshot> {
  return invoke<StackSnapshot>("load_stack");
}

/** The last snapshot, without touching the disk. Null before the first load. */
export function cachedStack(): Promise<StackSnapshot | null> {
  return invoke<StackSnapshot | null>("cached_stack");
}

/** Show a tool's checkout in the OS file manager. */
export function revealTool(id: string): Promise<void> {
  return invoke<void>("reveal_tool", { id });
}

/** Mirrors `tool_frontend::ToolFrontend`. */
export type ToolFrontend =
  { state: "mountable"; url: string } | { state: "unavailable"; reason: string };

/**
 * Where a tool's iframe points. Resolved per-tool and on demand rather than
 * part of the stack snapshot, since a dev server can start or stop and a
 * checkout can be built while the shell is running.
 */
export function toolFrontend(id: string): Promise<ToolFrontend> {
  return invoke<ToolFrontend>("tool_frontend", { id });
}

/**
 * Mirrors `apps::AppInfo` — one first-party app, as the switcher needs it.
 *
 * Note what an app has that a tool doesn't, and vice versa. There is a `url`
 * here because an app's frontend is built by this repo and its address is known
 * without asking the filesystem anything; a tool's has to be resolved on demand
 * (`tool_frontend`) because its dev server can come and go. There is no
 * `status` here because an app ships in the binary — it cannot be missing, and
 * it cannot disagree with a pinned version it doesn't have.
 */
export interface AppInfo {
  id: string;
  name: string;
  description: string;
  /** Root-relative, so it resolves against whatever origin the shell is on. */
  url: string;
}

/**
 * Every app this build ships. Compiled into the binary, so unlike `loadStack`
 * this answers the same thing every time and is worth asking exactly once.
 */
export function listApps(): Promise<AppInfo[]> {
  return invoke<AppInfo[]>("list_apps");
}

/**
 * Mirrors `apps::OpenableKind`. How the shell opens the thing, in one word.
 *
 * `plugin` opens exactly as `app` does. It is a separate word because an app's
 * `invoke` is answered inside the orchestrator while a plugin's goes over the
 * broker to its own process, and its frontend address resolves on demand.
 */
export type OpenableKind = "app" | "plugin" | "terminal";

/**
 * Mirrors `apps::Openable` — one row in the Apps menu.
 *
 * **Note what is missing next to `AppInfo`: a `url`.** That absence is the
 * entire reason this is a separate type, and it is load-bearing rather than
 * tidy. A terminal has no frontend — no Vite entry point, no iframe, no origin —
 * it is an xterm canvas the shell draws itself, bound to a pty by id. And
 * `state/toolFrontend.ts` resolves a *mountable URL* by looking an id up in the
 * `AppInfo` list, so a terminal in that list with an empty `url` would mount a
 * blank iframe over every terminal in the window.
 *
 * So the two lists stay apart: `AppInfo` is "things with a frontend", this is
 * "things you can open". `kind` is what the caller routes on.
 *
 * A plugin surface has no `url` here either, for a different reason with the
 * same consequence: where its frontend is served from can change while the
 * shell runs. Its `id` is a `<package>.<surface>` address, not a bare app id.
 */
export interface Openable {
  id: string;
  name: string;
  description: string;
  kind: OpenableKind;
}

/**
 * Everything the Apps menu offers: every app, every listed plugin surface, then
 * a terminal.
 *
 * **Unlike `listApps`, this is not asked once.** Installing, removing, enabling
 * or reloading a plugin changes it, so re-ask on `PLUGINS_CHANGED_EVENT`. Each
 * call re-reads the installed manifests off disk.
 */
export function listOpenables(): Promise<Openable[]> {
  return invoke<Openable[]>("list_openables");
}

// --- plugins ----------------------------------------------------------------

/** Mirrors `plugins::ResolvedSurface`. One thing a plugin can put in a pane. */
export interface PluginSurface {
  /** `<package>.<surface>` — what goes wherever an app id goes. */
  address: string;
  name: string;
  description: string;
  /** In the Apps menu, or only reachable through `veistra/open`. */
  listed: boolean;
}

/** Mirrors `plugins::ResolvedPlugin` — a package, read off its checkout. */
export interface ResolvedPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  path: string;
  enabled: boolean;
  surfaces: PluginSurface[];
  /** Declares a core. Tells a backend-only plugin from a broken one, which
   *  otherwise look identical: no surfaces either way. */
  hasCore: boolean;
}

/**
 * Mirrors `plugins::PluginRow` — one row in the plugin management screen.
 *
 * Flat with an `error` rather than a discriminated union, deliberately against
 * STANDARDS §6.2: `id` and `path` come from the install record and are known
 * *even when the plugin will not load*, which is exactly when they are needed.
 */
export interface PluginRow {
  id: string;
  path: string;
  enabled: boolean;
  resolved: ResolvedPlugin | null;
  error: string | null;
  running: boolean;
}

/** Every installed plugin, failures kept. Re-reads every manifest off disk. */
export function listPlugins(): Promise<PluginRow[]> {
  return invoke<PluginRow[]>("list_plugins");
}

/**
 * Mirrors `plugins::catalog::CatalogRow` — one app in the library.
 *
 * The catalog half is compiled into the binary from `catalog.toml`, so it is
 * fixed for a given build; `installed` is the only field that moves, which is
 * why this is re-asked on `PLUGINS_CHANGED_EVENT` rather than fetched once.
 */
export interface CatalogRow {
  id: string;
  name: string;
  description: string;
  /** `owner/name` on GitHub. */
  repo: string;
  /** Installed on first run without being asked. */
  default: boolean;
  /** Only changes the wording when a fetch fails. GitHub decides access. */
  private: boolean;
  installed: boolean;
}

/** The app library this build ships. Answers offline. */
export function listCatalog(): Promise<CatalogRow[]> {
  return invoke<CatalogRow[]>("list_catalog");
}

/**
 * Install from a GitHub repository — a URL, or `owner/name`.
 *
 * `expectedId` comes from a library row, where the catalog already claims which
 * package this is; a release whose manifest disagrees is refused. Omit it when
 * the user typed the address themselves, since nothing has promised anything.
 *
 * Slow, and reports on `INSTALL_PROGRESS_EVENT` while it runs.
 */
export function installPluginRepo(
  input: string,
  expectedId?: string,
  privateHint?: boolean,
): Promise<PluginRow> {
  return invoke<PluginRow>("install_plugin_repo", { input, expectedId, privateHint });
}

/** Whether a GitHub token is stored. Never returns the token itself. */
export function hasGithubToken(): Promise<boolean> {
  return invoke<boolean>("has_github_token");
}

/** Store a GitHub token, or clear it with an empty string. */
export function setGithubToken(token: string): Promise<void> {
  return invoke<void>("set_github_token", { token });
}

/** Mirrors `cloud::google::Status`. Carries an email and never a token. */
export interface GoogleAuthStatus {
  /** A client ID is set and a client secret is stored. */
  configured: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  /** The signed-in Google account, or null. */
  email: string | null;
  /** A sign-in is waiting for the browser. */
  pending: boolean;
}

/** Who is signed in to Veistra's own Google sign-in. No network. */
export function googleAuthStatus(): Promise<GoogleAuthStatus> {
  return invoke<GoogleAuthStatus>("google_auth_status");
}

/** Open the system browser and wait for the approval. Resolves to the email. */
export function googleSignIn(): Promise<string> {
  return invoke<string>("google_sign_in");
}

/** Stop a sign-in that is waiting for the browser. */
export function googleCancelSignIn(): Promise<void> {
  return invoke<void>("google_cancel_sign_in");
}

/** Revoke the sign-in at Google and forget it here. */
export function googleSignOut(): Promise<void> {
  return invoke<void>("google_sign_out");
}

/** Store the OAuth client secret in the credential store, or clear it with "". */
export function setGoogleClientSecret(secret: string): Promise<void> {
  return invoke<void>("set_google_client_secret", { secret });
}

/** Mirrors `plugins::install::Phase`. */
export type InstallPhase =
  "resolving" | "downloading" | "verifying" | "unpacking" | "done" | "failed";

/** Mirrors `plugins::install::Progress`. */
export interface InstallProgress {
  /** The catalog id, or the repo address when there is none. Key rows on this. */
  key: string;
  name: string;
  phase: InstallPhase;
  received: number;
  /** 0 when the server sent no length — render indeterminate, not 0%. */
  total: number;
  /** Set only on `failed`, and it is the sentence to show. */
  error: string | null;
}

/** Mirrors `plugins::install::PROGRESS_EVENT`. */
export const INSTALL_PROGRESS_EVENT = "plugins:install-progress";

/** Mirrors `plugins::LIBRARY_OPEN_EVENT`. */
export const LIBRARY_OPEN_EVENT = "library:open";

/** Home asking the shell to show the app library. Carries nothing. */
export function onLibraryOpen(cb: () => void): Promise<UnlistenFn> {
  return listen(LIBRARY_OPEN_EVENT, () => cb());
}

/** Mirrors `apps::OPEN_SETTINGS_EVENT`. */
export const OPEN_SETTINGS_EVENT = "settings:open";

/** An app asking the shell to open Settings, on `section` when it names one. */
export function onSettingsOpen(cb: (section: string | null) => void): Promise<UnlistenFn> {
  return listen<{ section: string | null }>(OPEN_SETTINGS_EVENT, (event) =>
    cb(event.payload?.section ?? null),
  );
}

/** Every install's progress, from every window. Filter on `key`. */
export function onInstallProgress(cb: (p: InstallProgress) => void): Promise<UnlistenFn> {
  return listen<InstallProgress>(INSTALL_PROGRESS_EVENT, (event) => cb(event.payload));
}

/** Install a plugin from a folder already on this machine. */
export function installPluginFolder(path: string): Promise<PluginRow> {
  return invoke<PluginRow>("install_plugin_folder", { path });
}

/** Pick a folder and install it. `null` is a cancelled dialog, not a failure. */
export function chooseAndInstallPlugin(): Promise<PluginRow | null> {
  return invoke<PluginRow | null>("choose_and_install_plugin");
}

/** Forget a plugin and stop its core. Never deletes the folder it points at. */
export function uninstallPlugin(id: string): Promise<boolean> {
  return invoke<boolean>("uninstall_plugin", { id });
}

/** Stop a plugin's core and re-read its manifest — the watcher's manual form. */
export function reloadPlugin(id: string): Promise<boolean> {
  return invoke<boolean>("reload_plugin", { id });
}

/** Turn a plugin's surfaces on or off without forgetting it. */
export function setPluginEnabled(id: string, enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_plugin_enabled", { id, enabled });
}

/** Mirrors `plugins::CHANGED_EVENT`. */
export const PLUGINS_CHANGED_EVENT = "plugins:changed";

/**
 * The installed set moved: something was installed, removed, toggled or
 * reloaded. Carries no payload deliberately — there is more than one window,
 * and a payload assembled once would have to describe whose registry state it
 * was, so each listener re-asks instead.
 */
export function onPluginsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(PLUGINS_CHANGED_EVENT, () => cb());
}

/**
 * Forward one `invoke` from an app's iframe to that app's Rust half.
 *
 * Called by `ToolWindow`, which is the only thing that knows which mounted
 * frame a message came from, and never by an app itself — an app calls
 * `invoke` from `@veistra/bridge` and the shell relays it here. A rejection
 * carries `{ code, message, data? }`, the JSON-RPC error object the bridge
 * turns back into a `VeistraRpcError`.
 */
export function appCall(
  id: string,
  method: string,
  params?: unknown,
  scope?: CallScope,
): Promise<unknown> {
  return invoke<unknown>("app_call", {
    id,
    instanceId: scope?.instanceId ?? null,
    clusterId: scope?.clusterId ?? null,
    method,
    params,
  });
}

/**
 * Which surface a call is on behalf of — mirrors `apps::CallContext`'s two
 * inputs.
 *
 * `id` above names the app, which is the code that answers. This names *where*
 * it is answered: Rust resolves the instance to the cluster whose pane tree
 * holds it, and that cluster to its project. Two Files in two clusters are
 * indistinguishable without it, and both would root at whichever project
 * answered first.
 *
 * `instanceId` is what `ToolWindow` passes, and it is the trustworthy one — the
 * shell resolves it from `event.source` against its own map of mounted iframes,
 * never from anything a frame asserts about itself.
 *
 * `clusterId` is for the shell's own calls, which are not a frame's request at
 * all: File > Open… is a title-bar menu item with no instance behind it, and
 * the window it was clicked in knows perfectly well which cluster it is
 * showing. It loses to a resolved instance where both are given.
 */
export interface CallScope {
  instanceId?: string;
  clusterId?: string;
}

/**
 * Mirrors `project::ProjectInfo` — one project, as the shell needs to see it.
 *
 * Only the fields the shell itself reads. Home's own frontend takes the whole
 * thing over transport B and has its own copy of the shape; this is the title
 * bar's much smaller need.
 */
export interface ProjectInfo {
  name: string;
  path: string;
}

/**
 * One cluster's project, for the title bar.
 *
 * The shell's own read, where it used to borrow Home's `home/state`. That
 * method answers the *calling surface's* cluster, which is the wrong scope
 * here: the bar names whichever cluster the window is showing, and that changes
 * with a click on a chip rather than with anything a frame does.
 *
 * `null` for a cluster with no project, for a `clusterId` naming nothing, and
 * for a window showing no cluster at all. The bar draws the same thing for all
 * three, so a richer answer would be a distinction with nowhere to show.
 */
export function clusterProject(clusterId: string | null): Promise<ProjectInfo | null> {
  return invoke<ProjectInfo | null>("cluster_project", { clusterId });
}

/** One cluster's project and the global Recent list together. Mirrors
 *  `project::ProjectSnapshot` — what `openProjectInCluster` resolves to. */
export interface ProjectSnapshot {
  open: ProjectInfo | null;
  recents: ProjectInfo[];
}

/**
 * Point a cluster at a project, or at nothing, without going through Home.
 *
 * The primitive under Home's methods, which are the ones a person reaches —
 * those raise a picker, touch the Recent list, and initialize a folder that
 * needs it. Nothing in the shell calls this today; it is registered because
 * the layout has to be able to say so on its own, and because a cluster's
 * project being settable only from inside an app frame would be a strange
 * place for the authority to live.
 */
export function setClusterProject(clusterId: string, path: string | null): Promise<void> {
  return invoke("set_cluster_project", { clusterId, path });
}

/**
 * One row of the Switch Project dialog (board 08). Mirrors
 * `commands::RecentProjectRow` — see that type for why `format`/`modified`
 * are left out. `open`/`clusterCount`/`environmentCount` answer for *this
 * session* only: a project nobody has opened since launch reads as closed,
 * even if it looked busy last time — there is no persisted per-project
 * workspace yet (VEISTRA-UX-REWORK.md §6) for a closed one to draw from.
 */
export interface RecentProjectRow {
  name: string;
  path: string;
  id: string | null;
  initialized: boolean;
  exists: boolean;
  /** Milliseconds since the Unix epoch. */
  lastOpened: number | null;
  open: boolean;
  clusterCount: number;
  environmentCount: number;
}

/** Every project Veistra remembers opening, each with how much of it is
 *  live right now. See `commands::list_recent_projects`. */
export function listRecentProjects(): Promise<RecentProjectRow[]> {
  return invoke<RecentProjectRow[]>("list_recent_projects", {});
}

/**
 * Open a Recent-list project into a cluster — the Switch Project dialog's one
 * action. Mirrors `commands::open_project_in_cluster`: the real open path
 * (Recent list, retitle, preset, pinned Design cluster), not
 * `setClusterProject`'s quieter pointer move.
 */
export function openProjectInCluster(clusterId: string, path: string): Promise<ProjectSnapshot> {
  return invoke<ProjectSnapshot>("open_project_in_cluster", { clusterId, path });
}

export const PROJECT_CHANGED_EVENT = "project:changed";

/**
 * Subscribe to a project opening, closing, or changing under any cluster.
 *
 * The payload is relayed untyped — callers narrow it themselves against the
 * cluster they care about, the way `useClusterProject` and `ToolWindow` both
 * already do, rather than trusting a shape this file has never checked.
 */
export function onProjectChanged(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(PROJECT_CHANGED_EVENT, (e) => cb(e.payload));
}

/** The event Rust emits when a watched project folder changed under the explorer
 *  (`file_watch::FILES_CHANGED_EVENT`). Payload `{ root: string }`. */
export const FILES_CHANGED_EVENT = "files:changed";

/** Hear that a project folder changed on disk, from the terminal, the OS or an agent. */
export function onFilesChanged(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(FILES_CHANGED_EVENT, (e) => cb(e.payload));
}

/** The event Rust emits for every agent tab session change (`apps::agent_tab::EVENT`).
 *  Payload is an `Envelope` from `apps/agent-tab/ui/src/protocol.generated.ts`. */
export const AGENT_TAB_EVENT = "agent-tab:event";

/** Hear every agent tab's session events, to relay each one to its own tab. */
export function onAgentTabEvent(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_TAB_EVENT, (e) => cb(e.payload));
}

/** The event Rust emits when an agent tab chooses its next harness and model
 *  (`apps::agent_tab::CHOSEN`). Payload is `{ instanceId, harness, model }`. */
export const AGENT_TAB_CHOSEN = "agent-tab:chosen";

/** Hear every agent tab's choice of harness. */
export function onAgentTabChosen(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_TAB_CHOSEN, (e) => cb(e.payload));
}

/** The event Rust sends each open agent tab once a harness's agent has said
 *  which models it offers (`apps::agent_tab::MODELS`). Payload is
 *  `{ instanceId, harness }`. */
export const AGENT_TAB_MODELS = "agent-tab:models";

/** Hear that a harness's models are in, to relay to the tab each event names. */
export function onAgentTabModels(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_TAB_MODELS, (e) => cb(e.payload));
}

/** The event Rust sends an agent tab when the sign-in it started has ended
 *  (`apps::agent_tab::LOGIN`). Payload is `{ instanceId, harness, ok }`. */
export const AGENT_TAB_LOGIN = "agent-tab:login";

/** Hear that a sign-in ended, to relay to the tab that started it. */
export function onAgentTabLogin(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_TAB_LOGIN, (e) => cb(e.payload));
}

/** The event Rust sends a tab a saved session was opened in from elsewhere,
 *  such as the Agents page (`apps::agent_tab::RESTORED`). Payload is `{ instanceId }`. */
export const AGENT_TAB_RESTORED = "agent-tab:restored";

/** Hear that a saved session was opened in a tab, to relay to that tab. */
export function onAgentTabRestored(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_TAB_RESTORED, (e) => cb(e.payload));
}

/** The event Rust emits after a saved agent session was written or archived
 *  (`apps::agent_tab::HISTORY`). Payload is `{}`. */
export const AGENT_TAB_HISTORY = "agent-tab:history";

/** Hear that the saved agent sessions changed, to list them again. */
export function onAgentTabHistory(cb: () => void): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_TAB_HISTORY, () => cb());
}

/** A project's `.veistra/icon.*` as a `data:` URL, or `null` for "draw the
 *  letter tile". Mirrors `commands::project_icon`. */
export function projectIcon(path: string): Promise<string | null> {
  return invoke<string | null>("project_icon", { path });
}

/**
 * Raise the native image picker and copy the choice into the project as its
 * icon. `null` for a cancelled picker. Mirrors `commands::choose_project_icon`,
 * which also broadcasts `PROJECT_ICON_EVENT` so every other drawing of the
 * project updates. Never called from a test: the picker blocks the webview.
 */
export function chooseProjectIcon(path: string): Promise<string | null> {
  return invoke<string | null>("choose_project_icon", { path });
}

export const PROJECT_ICON_EVENT = "project:icon";

/** What `PROJECT_ICON_EVENT` carries: which project, and its new icon. */
export interface ProjectIconChanged {
  path: string;
  icon: string | null;
}

export function onProjectIconChanged(
  cb: (payload: ProjectIconChanged) => void,
): Promise<UnlistenFn> {
  return listen<ProjectIconChanged>(PROJECT_ICON_EVENT, (e) => cb(e.payload));
}

/**
 * Where a cluster's work is happening on disk. Mirrors `shell_state::
 * WorktreeRef`.
 *
 * The *binding* — a pointer a cluster stores at a checkout — as distinct from
 * [`GitWorktree`], which is what git reports about the checkout itself. A
 * worktree exists whether or not a cluster is pointed at it, and a cluster
 * holding this is claiming one of them, not describing it.
 *
 * Re-exported from `shell/contract.ts`, which is where the shell reads it; it
 * is declared here because this is the file that mirrors Rust, and `contract`
 * imports from `bindings` rather than the other way round.
 */
export interface WorktreeRef {
  path: string;
  /** `null` for a detached HEAD — a state Veistra never creates but can find. */
  branch: string | null;
  /** The branch this one was forked from, recorded at creation. `null` for a
   *  worktree old enough to predate the field, or one this build never made. */
  base: string | null;
}

/**
 * Where a cluster's work runs: a local worktree, a cloud session, the
 * read-only main checkout, or the standing Design worktree. Mirrors
 * `environments::Environment` — see that enum for what each variant means
 * and why `Cloud` alone has no local path.
 *
 * `worktree`'s successor rather than its replacement; see `Cluster.environment`.
 */
export type Environment =
  | { kind: "localWorktree"; name: string; path: string; branch: string; base: string }
  | { kind: "cloud"; sessionId: string; vm: string; branch: string | null }
  | { kind: "main" }
  | { kind: "design"; path: string; branch: string };

/**
 * One entry from `git worktree list`. Mirrors `git::GitWorktree`.
 *
 * See [`WorktreeRef`] for the distinction between this and what a cluster
 * stores.
 */
export interface GitWorktree {
  /** Absolute, in the form git prints it — forward slashes, even on Windows. */
  path: string;
  /** Short name, `refs/heads/` already stripped. `null` for a detached HEAD. */
  branch: string | null;
  head: string;
  /** The primary checkout — the project folder itself, which git lists first. */
  isMain: boolean;
  locked: boolean;
}

/**
 * One commit, as the graph draws it. Mirrors `git::GitCommit`.
 *
 * `parents` is what makes this a graph rather than a list — the frontend works
 * out lanes and connectors from it, because where a line bends is a layout
 * question and answering it in Rust would push a rendering decision through the
 * IPC boundary.
 */
export interface GitCommit {
  sha: string;
  /** Git's own abbreviation, length-adjusted per repository to stay unambiguous. */
  short: string;
  summary: string;
  author: string;
  /** Author time, Unix **seconds** — not milliseconds. Multiply before `new Date`. */
  when: number;
  /** Empty for a root commit, one normally, two or more for a merge. */
  parents: string[];
  /** Local branch names pointing here, `refs/heads/` already stripped. */
  refs: string[];
}

/** Mirrors `git::GitChangeKind`. */
export type GitChangeKind =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

/**
 * Mirrors `git::GitFileChange` — one path, in one of `GitStatus`'s two lists.
 * `path` is repo-relative with forward slashes, the identity every other git
 * command takes back as an argument. `renamedFrom` is present only when
 * `kind` is `"renamed"`.
 *
 * `insertions`/`deletions` are this change's own counts on its own side of the
 * index — `null` together for a binary, an untracked file over 5 MiB, or a
 * conflict, a different fact from `0`. **Not** a breakdown of `GitStatus`'s
 * totals, which measure `HEAD` against the working tree in one pass.
 */
export interface GitFileChange {
  path: string;
  file: string;
  dir: string;
  kind: GitChangeKind;
  staged: boolean;
  renamedFrom?: string;
  insertions: number | null;
  deletions: number | null;
}

/**
 * Mirrors `git::GitStatus`. `insertions`/`deletions` are line-change totals
 * since `HEAD` (the empty tree for a repository with no commits yet) — what
 * the status bar's compact `+N -N · M files` readout is built from. A changed
 * binary or an untracked file over 5 MiB still appears in `staged`/`unstaged`
 * without adding to either total. `ahead`/`behind` are both `0` when there is
 * no tracking ref, which is not an error.
 */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
}

/** Mirrors `git::GitDiff` — two whole texts, not a patch. Monaco's diff editor computes its own hunks. */
export interface GitDiff {
  original: string;
  modified: string;
}

/**
 * Mirrors `git::GitDivergence` — a worktree's changes since it forked,
 * commits and uncommitted work together against the fork point rather than
 * HEAD, so committing a file neither leaves this list nor changes its diff.
 * `staged` on each `GitFileChange` here is always false; this view is not
 * the index.
 */
export interface GitDivergence {
  base: string;
  mergeBase: string;
  commits: number;
  files: GitFileChange[];
}

/**
 * The repository's local branches as one graph, newest first.
 *
 * Local only: remote-tracking refs would multiply the rows to draw history
 * nobody in this window is working on, and the drift that does matter already
 * shows as ahead/behind on the status. An empty array covers "no project", "not
 * a repository" and "no commits yet" alike.
 *
 * `limit` is a hard row cap rather than a page size — there is no cursor here,
 * and a graph is a thing you scan rather than page through.
 */
export function gitGraph(clusterId: string, limit: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_graph", { clusterId, limit });
}

/** One local branch. Mirrors `git::GitBranch`. `worktree` is the path of
 *  *another* checkout holding it, absent for a free branch and for `current` —
 *  git refuses a branch twice, and a picker wants that before the click. */
export interface GitBranch {
  name: string;
  /** Full length, so it matches `GitCommit.sha` without either side abbreviating. */
  head: string;
  current: boolean;
  worktree?: string;
}

/** Every local branch, most recently committed to first. Local only, matching
 *  `gitGraph`: these are what can be checked out, where a remote-tracking ref
 *  would detach HEAD. Empty for "no project", "not a repo" and "no commits". */
export function gitBranches(clusterId: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_branches", { clusterId });
}

/** Move the cluster's checkout onto `target`. `detach` is false with a name from
 *  `gitBranches`, true with a sha from the commit graph — told rather than
 *  inferred, since a hex string is a legal branch name. Rejects in git's own
 *  words; nothing is pre-checked, so the message is never a copy of its rules. */
export function gitCheckout(clusterId: string, target: string, detach: boolean): Promise<void> {
  return invoke("git_checkout", { clusterId, target, detach });
}

/**
 * Every worktree of a cluster's repository, the project's own checkout first.
 *
 * Cluster-scoped rather than path-scoped for the same reason the source control
 * commands are tool-scoped: the frontend never names a directory for the
 * backend to run `git` in. An empty array covers all three of "no project",
 * "project is not a repository", and "a repository with no extra worktrees" —
 * the graph draws the same thing for each, so separating them would be a
 * distinction with nowhere to show.
 */
export function gitWorktrees(clusterId: string): Promise<GitWorktree[]> {
  return invoke<GitWorktree[]>("git_worktrees", { clusterId });
}

/**
 * Cut a branch from the current HEAD, check it out into a new worktree beside
 * the project, and point the cluster at it.
 *
 * Rejects rather than overwrites when the name is taken, so a caller can offer
 * the error verbatim — the backend's messages are written to be read by whoever
 * typed the name.
 */
export function gitWorktreeCreate(clusterId: string, name: string): Promise<WorktreeRef> {
  return invoke<WorktreeRef>("git_worktree_create", { clusterId, name });
}

/**
 * Discard a cluster's worktree and return it to working in its project. The
 * branch and its commits survive; only the checkout on disk goes.
 *
 * `force` overrides git's refusal to remove a worktree holding uncommitted
 * changes. Do not pass `true` without having asked the user: that refusal is
 * the last thing between a click and work that exists in no other copy.
 */
export function gitWorktreeRemove(clusterId: string, force: boolean): Promise<void> {
  return invoke("git_worktree_remove", { clusterId, force });
}

/**
 * Drop a cluster's worktree binding if the checkout behind it is gone, and
 * report what it is bound to afterwards.
 *
 * Worth calling on a cluster switch and after anything that could have removed
 * a directory from outside Veistra. Cheap — a `is_dir` check, and a git spawn
 * only in the case where the answer turns out to be "gone".
 */
export function gitWorktreeReconcile(clusterId: string): Promise<WorktreeRef | null> {
  return invoke<WorktreeRef | null>("git_worktree_reconcile", { clusterId });
}

/** `null` when the cluster has no project open or its project is not a repo. */
export function gitClusterStatus(clusterId: string): Promise<GitStatus | null> {
  return invoke<GitStatus | null>("git_cluster_status", { clusterId });
}

/** One file's staged or unstaged diff, as two whole texts. */
export function gitClusterDiff(clusterId: string, path: string, staged: boolean): Promise<GitDiff> {
  return invoke<GitDiff>("git_cluster_diff", { clusterId, path, staged });
}

export function gitClusterStage(clusterId: string, paths: string[]): Promise<void> {
  return invoke("git_cluster_stage", { clusterId, paths });
}

export function gitClusterUnstage(clusterId: string, paths: string[]): Promise<void> {
  return invoke("git_cluster_unstage", { clusterId, paths });
}

/** Commit whatever is staged. Rejects with git's own message — nothing staged, an empty message, a failing hook. */
export function gitClusterCommit(clusterId: string, message: string): Promise<void> {
  return invoke("git_cluster_commit", { clusterId, message });
}

/** `null` for a cluster in its project folder rather than a worktree — there is no fork point to measure from. */
export function gitDivergence(clusterId: string): Promise<GitDivergence | null> {
  return invoke<GitDivergence | null>("git_divergence", { clusterId });
}

/** One file's whole divergence from `mergeBase`, taken from the `GitDivergence` the file came from rather than resolved again. */
export function gitDivergenceDiff(
  clusterId: string,
  path: string,
  mergeBase: string,
): Promise<GitDiff> {
  return invoke<GitDiff>("git_divergence_diff", { clusterId, path, mergeBase });
}

/* --- review comments ---------------------------------------------------------
 *
 * Notes a person left on lines of a diff, so an agent can be handed them.
 * Mirrors `src-tauri/src/review/`, which keeps them in `.veistra/` inside the
 * checkout — cluster-scoped for the same reason every git command is, so the
 * frontend never names a directory for the backend to write in.
 */

/** Mirrors `review::ReviewScope` — which of the three diffs a note was written against. */
export type ReviewScope = "unstaged" | "staged" | "branch";

/**
 * Mirrors `review::ReviewComment`.
 *
 * `startLine`/`endLine` are 1-based and inclusive at both ends, and both name
 * the **modified** side of the diff. A single-line note has them equal rather
 * than omitting the end, so no caller has to special-case the common shape.
 *
 * There is no `side` and no author: `review`'s module doc has why. `sentAt` is
 * absent until the note has been handed to an agent, and editing the body
 * clears it again.
 */
export interface ReviewComment {
  id: string;
  /** Repo-relative, forward slashes — the same string `GitFileChange.path` carries. */
  path: string;
  scope: ReviewScope;
  startLine: number;
  endLine: number;
  body: string;
  /** Milliseconds since the Unix epoch, like every other timestamp crossing this boundary. */
  createdAt: number;
  updatedAt?: number;
  sentAt?: number;
  resolved: boolean;
}

/** Mirrors `review::ReviewDraft` — a note before the backend gives it an id and a clock reading. */
export interface ReviewDraft {
  path: string;
  scope: ReviewScope;
  startLine: number;
  endLine: number;
  body: string;
}

/**
 * Every note stored for this cluster's checkout, in file-then-line order.
 *
 * An **empty array**, never an error, for a cluster with no project or one that
 * is not a repository — the same two states `gitClusterStatus` answers `null`
 * for. Re-read from disk on every call, so it doubles as the refresh after
 * another window has written.
 */
export function reviewComments(clusterId: string): Promise<ReviewComment[]> {
  return invoke<ReviewComment[]>("review_comments", { clusterId });
}

/** Write a note. Rejects on an empty body or a line range that is not one. */
export function reviewCommentAdd(clusterId: string, draft: ReviewDraft): Promise<ReviewComment> {
  return invoke<ReviewComment>("review_comment_add", { clusterId, draft });
}

/** Rewrite a note's body. Clears its `sentAt` — the agent was given different words. */
export function reviewCommentUpdate(
  clusterId: string,
  id: string,
  body: string,
): Promise<ReviewComment> {
  return invoke<ReviewComment>("review_comment_update", { clusterId, id, body });
}

/** Mark a note dealt with, or put it back. Nothing sets this automatically. */
export function reviewCommentResolve(
  clusterId: string,
  id: string,
  resolved: boolean,
): Promise<ReviewComment> {
  return invoke<ReviewComment>("review_comment_resolve", { clusterId, id, resolved });
}

/** Delete a note. No undo. */
export function reviewCommentRemove(clusterId: string, id: string): Promise<void> {
  return invoke("review_comment_remove", { clusterId, id });
}

/**
 * Stamp notes as handed to an agent, and answer how many were.
 *
 * Called *after* the text has reached the clipboard or a terminal, so an id
 * that names nothing is skipped rather than fatal — the send already happened,
 * and failing here would report it as though it had not. The count can be lower
 * than the ids asked for if another window deleted one in between.
 */
export function reviewCommentsMarkSent(clusterId: string, ids: string[]): Promise<number> {
  return invoke<number>("review_comments_mark_sent", { clusterId, ids });
}

/** Mirrors `github::GithubItemKind`. */
export type GithubItemKind = "issue" | "pull";

/** Mirrors `github::GithubItemState`. One union over both kinds: an issue is
 *  only ever `open` or `closed`, and `merged`/`draft` belong to a pull request.
 *  Two unions would make every renderer narrow on `kind` to read `state`. */
export type GithubItemState = "open" | "closed" | "merged" | "draft";

/** Mirrors `github::GithubItem`. */
export interface GithubItem {
  /** `issue-42` or `pull-17` — unique across both kinds, which is what a React
   *  key over the merged list needs. The numbers alone are not. */
  id: string;
  kind: GithubItemKind;
  number: number;
  title: string;
  state: GithubItemState;
  /** The `html_url`, for opening in a browser. */
  url: string;
  labels: string[];
  /** ISO-8601, unparsed — a `Date` may not cross this boundary (§2), and this
   *  format sorts correctly as a string anyway. */
  updatedAt: string;
  /** `null` for an item whose author deleted their account. */
  author: string | null;
  /** A pull request's head branch, for display. `null` for an issue, and
   *  deliberately not what opening the item checks out. */
  headBranch: string | null;
  /** What to name the worktree when this item is opened. Rust computes it so
   *  opening is the *existing* `worktreeControl.create` and nothing more. For a
   *  pull request it names a fresh branch rather than the author's head, which
   *  would need a fetch — `github.rs` records why. */
  suggestedBranch: string;
}

/** Mirrors `github::GithubTrouble`. Four cases because they need four different
 *  affordances — sign in, wait, retry, and nothing-to-be-done. One failure
 *  string would put a Sign in button under a rate limit. `missingOrPrivate` is
 *  GitHub's 404, which covers "no such repository" and "not yours to see"
 *  deliberately: it answers the same for both so the difference is not leaked. */
export type GithubTrouble =
  | { kind: "auth" }
  | { kind: "missingOrPrivate" }
  | { kind: "rateLimited"; resetsInMinutes: number | null }
  | { kind: "unreachable"; reason: string };

/** Mirrors `github::GithubFeed`. The variant is why an empty list is never
 *  ambiguous: `ready` with no items means the repository has nothing open, and
 *  every other empty list is one of the other two states with its own reason. */
export type GithubFeed =
  | { state: "notGithub" }
  | { state: "unavailable"; repo: string | null; trouble: GithubTrouble }
  | { state: "ready"; repo: string; items: GithubItem[]; authenticated: boolean };

/** Mirrors `github::GithubScope` — which items to ask GitHub for, as opposed to
 *  which to draw. A closed item is not in an `open` reply at all, so `is:closed`
 *  has to reach the fetch or it could only filter down to nothing. `merged` is
 *  absent because the endpoint does not accept it: a merged pull request arrives
 *  under `closed`, told apart by its merge date. */
export type GithubScope = "open" | "closed" | "all";

/** Issues and pull requests for the repository behind a cluster. Never rejects
 *  for a network failure, a spent quota or a non-GitHub project — all three are
 *  `GithubFeed` variants, each a state the panel draws rather than a dialog. */
export function githubFeed(clusterId: string, scope: GithubScope): Promise<GithubFeed> {
  return invoke<GithubFeed>("github_feed", { clusterId, scope });
}

/** Mirrors `cloud::hindsight::Status` (the `trouble` is `cloud::Trouble`, tagged
 *  by `kind`). Never rejects for an unreachable service: that is `trouble`. */
export type HindsightStatus =
  | { state: "connected"; url: string; latencyMs: number }
  | {
      state: "trouble";
      url: string;
      trouble: { kind: string; detail?: string; what?: string; status?: number };
    };

/** One `GET /health` against the Hindsight service. Cloud Run bills an instance
 *  for ~15 minutes per request, so call this when the page opens or on a press,
 *  never on a timer. */
export function hindsightStatus(): Promise<HindsightStatus> {
  return invoke<HindsightStatus>("hindsight_status");
}

/** Hand a github.com address to the browser. Rust re-checks it and rejects
 *  anything else, which is why this is a command of our own rather than the
 *  opener plugin's binding: the capability file can only say "may open URLs",
 *  and this needs "may open one host". */
export function githubOpenInBrowser(url: string): Promise<void> {
  return invoke<void>("github_open_in_browser", { url });
}

/**
 * Tell the backend that a first-party app's UI has drawn its first meaningful
 * frame.
 *
 * Called by `ToolWindow` when an app frame sends `veistra/painted`, and by
 * nothing else: the id is the one the shell resolved from the frame the message
 * arrived on, never one an app named for itself. Boot holds the splash window
 * until every app has reported (`src-tauri/src/boot.rs`), so this is what
 * decides that the first frame after the splash is the real Home rather than
 * the boot overlay laid over it.
 */
export function appPainted(id: string): Promise<void> {
  return invoke<void>("app_painted", { id });
}

/**
 * Mirrors `boot::BootStatus`.
 *
 * Same internally tagged shape as `ToolStatus` above, but keyed on `phase`
 * instead of `state` — this describes a phase of the whole app's startup,
 * not a single tool's discovery result, so it gets its own tag name. `Ready`
 * carries no fields: the snapshot it represents is fetched separately with
 * `cachedStack`, not sent again over the event.
 */
export type BootStatus =
  | { phase: "working"; step: number; total: number; label: string }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

/**
 * Subscribe to boot progress events emitted from the Rust side while the
 * splash window is up. `listen` itself resolves to an "unlisten" function
 * rather than unsubscribing via some separate call, so this hands that
 * function straight back — callers stash it and invoke it from a React
 * `useEffect` cleanup to stop listening on unmount.
 */
export function onBootStatus(cb: (status: BootStatus) => void): Promise<UnlistenFn> {
  return listen<BootStatus>("boot:status", (event) => cb(event.payload));
}

/**
 * Show the main window and close the splash. Safe to call more than once —
 * see `boot::finish` on the Rust side for why.
 */
export function finishBoot(): Promise<void> {
  return invoke<void>("finish_boot");
}

/**
 * The latest boot status, fetched directly instead of waited for over
 * `onBootStatus`. Tauri events have no replay buffer, so a listener
 * registered after boot already emitted something simply never sees that
 * event — the splash window's own load (webview init, React mount, the
 * effect that calls `listen`) is routinely slower than the backend's
 * filesystem work, so this gap is the common case, not an edge case. Call
 * this once on mount, *after* `onBootStatus` has already subscribed, to
 * catch up on whatever was missed. See `Splash.tsx` for how the two are
 * reconciled without trading that race for the opposite one (a late poll
 * response overwriting a newer event).
 */
export function bootStatus(): Promise<BootStatus> {
  return invoke<BootStatus>("boot_status");
}

/* --- launched with a path ----------------------------------------------------
 *
 * Explorer's "Open with Veistra". Rust has already opened a folder as a project
 * by the time either of these is called; what reaches the shell is a *file*,
 * and only `ToolWindow` can decide which viewer shows it. See `launch.rs`.
 */

/** Mirrors `launch::Target`. Only the `file` variant ever crosses. */
export type LaunchTarget =
  { kind: "project"; path: string } | { kind: "file"; path: string; parent: string | null };

/**
 * The path this launch was asked to open, taken and cleared. Polled on mount
 * for the reason [`bootStatus`] is, and the clearing is what stops this and
 * [`onLaunchTarget`] both acting on one target.
 */
export function takeLaunchTarget(): Promise<LaunchTarget | null> {
  return invoke<LaunchTarget | null>("take_launch_target");
}

/** A *second* "Open with Veistra", routed here by single-instance rather than run. */
export function onLaunchTarget(cb: () => void): Promise<UnlistenFn> {
  return listen<unknown>("veistra://launch-target", () => cb());
}

/** One webview failure into Rust's ring buffer. Swallows its own failure — the caller is an error handler. */
export function reportFrontendError(message: string): Promise<void> {
  return invoke<void>("report_frontend_error", { message }).catch(() => {});
}

/* --- host window -------------------------------------------------------------
 *
 * Tauri exposes window and webview control as objects with methods rather
 * than named commands, which is the one place §1.1's "call a typed wrapper
 * instead" cannot mean "wrap another `invoke`". Narrowed here to plain
 * function calls so this file stays the only one importing `@tauri-apps/api`.
 * `hostWindow.ts` and `WindowControls.tsx` keep their own `isTauri` guard in
 * front of each of these — both are reachable in a plain browser
 * (`pnpm dev:agent`), which has no Tauri runtime underneath to answer them.
 */

export function closeHostWindow(): Promise<void> {
  return getCurrentWindow().close();
}

export function minimizeHostWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

export function toggleHostMaximize(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

export function hostWindowIsMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

/**
 * Calls `handler` whenever the window is resized, which is how a maximise or a
 * restore announces itself (Tauri has no dedicated event for either). Returns
 * the unlisten function.
 */
export function onHostWindowResized(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWindow().onResized(handler);
}

export function hostWindowIsFullscreen(): Promise<boolean> {
  return getCurrentWindow().isFullscreen();
}

export function setHostWindowFullscreen(on: boolean): Promise<void> {
  return getCurrentWindow().setFullscreen(on);
}

/** Scale the whole webview — title bar, switcher, panel and every app iframe together. */
export function setHostZoom(factor: number): Promise<void> {
  return getCurrentWebview().setZoom(factor);
}

/* --- shell state — placement and layout, shared across every window --------
 *
 * Mirrors `src-tauri/src/shell_state.rs` and `src-tauri/src/layout.rs`. More
 * than one window has to agree on placement and terminal sessions, so Rust
 * owns them; every mutation below broadcasts `shell:state` rather than
 * answering with the new value, so there is no local state to update
 * optimistically and no chance of a window applying a change its siblings
 * never hear about. Fire and let the event come back.
 */

/** Mirrors `layout::SplitDir`. */
export type SplitDir = "row" | "column";

/** Mirrors `shell_state::SurfaceKind`. */
export type SurfaceKind = "app" | "tool" | "terminal";

/**
 * One live surface. Mirrors `shell_state::SurfaceInstance`.
 *
 * `appId` says which code to load and where to route an `invoke`; everything
 * else — which frame a message came from, which tab to close, which iframe to
 * keep mounted — is keyed on `id`.
 */
export interface SurfaceInstance {
  id: string;
  appId: string;
  kind: SurfaceKind;
  title: string;
}

/**
 * One node of a cluster's layout. Mirrors `layout::PaneNode`.
 *
 * Discriminated on `kind`, like `ToolStatus` and `BootStatus`. `sizes` are
 * fractions of the parent, one per child, summing to 1 rather than pixels —
 * the window is resizable, and pixels would have to be recomputed on every
 * resize and would restore wrongly onto a different monitor.
 */
export type PaneNode =
  | { kind: "split"; id: string; dir: SplitDir; sizes: number[]; children: PaneNode[] }
  | { kind: "leaf"; id: string; tabs: string[]; activeTab: string | null };

/**
 * One tab in the switcher bar: a layout, the project it is about, and its
 * worktree. Mirrors `shell_state::Cluster`.
 *
 * `project` is a path, not a name — a project's name is its manifest's, and
 * only `clusterProject` has read that. `worktree` is `null` for a cluster
 * working directly in its project folder rather than one made from it.
 */
export interface Cluster {
  id: string;
  name: string;
  tree: PaneNode;
  project: string | null;
  worktree: WorktreeRef | null;
  /** Which terminal this cluster's band shows, or `null` for an empty band. */
  activeTerminal: string | null;
  /** How tall this cluster's band was left, in CSS pixels, or `null` for one
   *  nobody has dragged it in — which opens at `BOTTOM_DEFAULT`. */
  bandHeight: number | null;
  /**
   * Legacy, migration-only: the page this cluster *was* under the pre-rework
   * page-cluster model, absent for a real one. A running build never
   * produces this anymore — `right_page` on `WindowPlacement` is where a
   * page lives now — but a `layout.json` an old build wrote can still carry
   * one on the way in, which `migrate_legacy_page_clusters` converts.
   */
  page?: string | null;
  /** Where this cluster's work actually happens. `worktree`'s successor —
   *  see that field's doc and `Environment` for the precedence between them.
   *  Absent (not `null`) for the same backward-compatibility reason `page` is. */
  environment?: Environment | null;
  /** The pinned Design canvas cluster, and only it — not closable. Always
   *  present on the wire (unlike `environment`/`page`, `false` still writes),
   *  and defaults to `false` when reading a `layout.json` old enough to
   *  predate it. */
  pinned: boolean;
  /** What the user chose to draw instead of the initials chip. Absent is the
   *  default: initials, untinted. */
  icon?: ClusterIcon | null;
  /** The environment's worktree folder was not on disk when the layout was
   *  restored at launch. Recomputed by the backend at every restore, so a
   *  stale value never survives a restart. Optional so fixtures that predate
   *  it stay valid; absent means present. */
  environmentMissing?: boolean;
}

/** Mirrors `shell_state::ClusterIcon`. An empty `emoji` means "initials, on this tint". */
export interface ClusterIcon {
  emoji: string;
  /** A palette key from `clusterIcon.ts`; absent is the neutral chip. */
  color?: string | null;
}

/** Mirrors `shell_state::WindowGeometry`. Physical pixels. */
export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The normal bounds above are kept while maximized. Absent means false. */
  maximized?: boolean;
  fullscreen?: boolean;
}

/** Mirrors `pages::PageMode`. */
export type PageMode = "docked" | "expanded";

/**
 * Mirrors `shell_state::RightPage` — the page a window is showing on its
 * rail, docked beside the panes or expanded over them. `instanceId` is
 * `null` for a page the shell draws itself (Git, Hindsight, the registry);
 * present for one hosted in an iframe (Plane, Cloud agents, Cost), naming
 * its entry in `ShellSnapshot.instances`.
 */
export interface RightPage {
  id: string;
  mode: PageMode;
  width: number;
  instanceId?: string | null;
}

/** Mirrors `shell_state::WindowPlacement`. */
export interface WindowPlacement {
  label: string;
  clusters: Cluster[];
  activeClusterId: string | null;
  geometry: WindowGeometry | null;
  /** The page this window is showing on its rail, absent for none. See `pages.rs`. */
  rightPage?: RightPage | null;
}

/**
 * Mirrors `shell_state::TerminalSession`.
 *
 * `clusterId`, not a window label — the terminal band is drawn inside the
 * cluster's half of the window, so a terminal belongs to the cluster it is
 * drawn under, spawns in that cluster's project, and closes with it.
 */
export interface TerminalSessionState {
  id: string;
  title: string;
  clusterId: string;
  agentFinished: boolean;
  groupId: string | null;
}

/** Mirrors `shell_state::ShellSnapshot`. */
export interface ShellSnapshot {
  windows: WindowPlacement[];
  /** Every live app and tool surface, flat; the pane trees hold ids and resolve against this. */
  instances: SurfaceInstance[];
  terminals: TerminalSessionState[];
}

export const SHELL_STATE_EVENT = "shell:state";

/** The whole shared state, fetched once. See `useShellState` for the subscribe-then-fetch ordering this is meant to pair with. */
export function shellState(): Promise<ShellSnapshot> {
  return invoke<ShellSnapshot>("shell_state");
}

/** Subscribe to the shared state, from this window or any other. */
export function onShellStateChanged(cb: (snapshot: ShellSnapshot) => void): Promise<UnlistenFn> {
  return listen<ShellSnapshot>(SHELL_STATE_EVENT, (e) => cb(e.payload));
}

// --- instances ----------------------------------------------------------------

/**
 * Open a new instance of an app. Resolves to its *instance* id.
 *
 * `paneId` names the pane the open is relative to, not the pane the surface
 * lands in; omitted, it falls back to the active cluster's first pane. `dir`
 * is the axis to split that pane along; omitted, nothing splits and the
 * surface arrives as a tab.
 */
export function openInstance(
  label: string,
  appId: string,
  paneId?: string,
  dir?: SplitDir,
): Promise<string> {
  return invoke<string>("open_instance", {
    label,
    appId,
    paneId: paneId ?? null,
    dir: dir ?? null,
  });
}

/** Mirrors `pages::PageInfo`. `icon` keys `PAGE_ICONS` in `rail/Rail.tsx`. */
export interface PageInfo {
  id: string;
  name: string;
  /** The app that draws this page, or absent when the shell draws it itself. */
  appId?: string | null;
  icon: string;
  mode: PageMode;
  key: number;
  disabled: boolean;
}

/** The pages this build offers, in rail order — including the disabled one. */
export function listPages(): Promise<PageInfo[]> {
  return invoke<PageInfo[]>("list_pages");
}

/** Show a page in `label`'s window, or close it if it is already the one showing. */
export function openPage(label: string, pageId: string): Promise<void> {
  return invoke("open_page", { label, pageId });
}

/** Close whatever page `label`'s window is showing, returning it to its panes. */
export function closePage(label: string): Promise<void> {
  return invoke("close_page", { label });
}

/** Dock or expand `label`'s open page in place. */
export function setPageMode(label: string, mode: PageMode): Promise<void> {
  return invoke("set_page_mode", { label, mode });
}

/** Resize `label`'s docked page, clamped to the written 320-640 range. */
export function setPageWidth(label: string, width: number): Promise<void> {
  return invoke("set_page_width", { label, width });
}

export function closeInstance(instanceId: string): Promise<void> {
  return invoke("close_instance", { instanceId });
}

export function activateInstance(instanceId: string): Promise<void> {
  return invoke("activate_instance", { instanceId });
}

/** Reorder within a strip, or move a tab into another pane or window. */
export function moveInstance(
  instanceId: string,
  clusterId: string,
  paneId: string,
  index: number | null,
): Promise<void> {
  return invoke("move_instance", { instanceId, clusterId, paneId, index });
}

/** Drop a tab on a pane's edge: split there, and put it in the new half. */
export function splitPane(
  paneId: string,
  dir: SplitDir,
  instanceId: string,
  before: boolean,
): Promise<void> {
  return invoke("split_pane", { paneId, dir, instanceId, before });
}

/** What a divider drag commits on release. Weights, not pixels. */
export function setPaneSizes(splitId: string, sizes: number[]): Promise<void> {
  return invoke("set_pane_sizes", { splitId, sizes });
}

// --- clusters -------------------------------------------------------------

export function addCluster(label: string, name: string): Promise<string | null> {
  return invoke<string | null>("add_cluster", { label, name });
}

/**
 * What the New Cluster dialog's first step chose. Mirrors
 * `commands::EnvironmentChoice`. `newLocalWorktree` names a worktree that
 * does not exist yet — the backend creates it as part of resolving this —
 * where `existing` already carries a fully-formed `Environment` the dialog
 * read from `listClusterEnvironments` or built for "browse main" itself.
 */
export type EnvironmentChoice =
  | { kind: "newLocalWorktree"; name: string; base?: string }
  | { kind: "existing"; environment: Environment };

/** The New Cluster dialog's second step. Mirrors `commands::StartingLayout`. */
export type StartingLayout = "code" | "watchAgent" | "godot" | "blender";

/**
 * The New Cluster dialog's finishing step: create the cluster, resolve (and,
 * for a new worktree, actually create) the chosen environment, and arrange
 * the one starting pane. See `commands::create_cluster_with_environment`.
 *
 * `label`/`name`/`project` travel together as `target`, matching
 * `commands::NewClusterTarget` — grouped there to keep the Rust command
 * under clippy's argument-count lint, and carried through here as one object
 * rather than reopened into three loose parameters that would just have to
 * be regrouped on the way across.
 */
export function createClusterWithEnvironment(
  label: string,
  name: string,
  project: string,
  choice: EnvironmentChoice,
  layout: StartingLayout,
): Promise<string> {
  return invoke<string>("create_cluster_with_environment", {
    target: { label, name, project },
    choice,
    layout,
  });
}

/** Whether a project can have worktree clusters. Mirrors `git_repo::RepoState`. */
export type RepoState =
  | { state: "notARepo" }
  | { state: "noCommits"; root: string; nested: boolean }
  | { state: "ready" };

/** What `gitInitProject` did. Mirrors `git_repo::InitOutcome`. */
export interface InitOutcome {
  branch: string | null;
  committedEverything: boolean;
}

/** Ask whether `project` is a git repository with a commit to fork worktrees from. */
export function gitRepoState(project: string): Promise<RepoState> {
  return invoke<RepoState>("git_repo_state", { project });
}

/** The repository's default branch (remote HEAD, then main, master, the current one), or
 *  null when the project is not a repository. */
export function gitDefaultBranch(project: string): Promise<string | null> {
  return invoke<string | null>("git_default_branch", { project });
}

/** `git init` plus an initial commit. Rejects with a sentence to show as it is, for
 *  instance when git has no identity configured or the folder is inside another repo. */
export function gitInitProject(project: string): Promise<InitOutcome> {
  return invoke<InitOutcome>("git_init_project", { project });
}

/** The New Cluster dialog's "existing environment" list. See
 *  `commands::list_cluster_environments` for what it excludes and why. */
export function listClusterEnvironments(project: string): Promise<Environment[]> {
  return invoke<Environment[]>("list_cluster_environments", { project });
}

/**
 * Create `wt/design` for a project that doesn't have one yet, and pin the
 * Design canvas cluster onto it in the calling window — the "offered but not
 * auto-created" half of the canvas (VEISTRA-UX-REWORK.md §5). Mirrors
 * `commands::create_design_cluster`. Resolves to the new cluster's id, or
 * `null` if this window already has a pinned cluster (idempotent per window,
 * same as the auto-created path).
 */
export function createDesignCluster(
  label: string,
  project: string,
  base: string,
): Promise<string | null> {
  return invoke<string | null>("create_design_cluster", { label, project, base });
}

/**
 * Drop a tab on the switcher's empty space: a new cluster in the same
 * environment the tab came from, holding that one tab. `sourceCluster` is
 * the drag payload's `fromClusterId` — see `SurfaceDrag` in `contract.ts`.
 * Resolves to the new cluster's id, or `null` if the drop was refused (the
 * window closed underneath it).
 */
export function newClusterForDrop(
  label: string,
  name: string,
  sourceCluster: string,
  instanceId: string,
): Promise<string | null> {
  return invoke<string | null>("new_cluster_for_drop", {
    label,
    name,
    sourceCluster,
    instanceId,
  });
}

/**
 * Tell the backend where this window's focus is. Mirrors `mcp::focus::FocusReport`;
 * the backend ignores a repeat and wakes subscribed agents on a real change.
 */
export function reportFocus(report: {
  window: string;
  windowHasFocus: boolean;
  focusIn: string;
  instance: string | null;
  pane: string | null;
  cluster: string | null;
}): Promise<void> {
  return invoke("report_focus", { report });
}

export function setActiveCluster(label: string, clusterId: string | null): Promise<void> {
  return invoke("set_active_cluster", { label, clusterId });
}

/** Choose a cluster's icon, or `null` to go back to its initials. */
export function setClusterIcon(clusterId: string, icon: ClusterIcon | null): Promise<void> {
  return invoke("set_cluster_icon", { clusterId, icon });
}

export function renameCluster(clusterId: string, name: string): Promise<void> {
  return invoke("rename_cluster", { clusterId, name });
}

export function closeCluster(clusterId: string): Promise<void> {
  return invoke("close_cluster", { clusterId });
}

// --- windows ----------------------------------------------------------------

/** Drag a tab clear of its window. The gesture that makes a second window. */
export function detachInstance(instanceId: string): Promise<void> {
  return invoke("detach_instance", { instanceId });
}

/**
 * Move a whole cluster — its chip and its entire pane tree — to another
 * window. `toLabel` names a window that is already open; `null` asks for a
 * new one. Rejects when no window holds `clusterId` — it was closed between
 * the release and this call.
 */
export function detachCluster(clusterId: string, toLabel: string | null): Promise<void> {
  return invoke("detach_cluster", { clusterId, toLabel });
}

/**
 * Close this window on purpose, through the backend rather than
 * `getCurrentWindow().close()` — that indirection is load-bearing, since it
 * is the only thing separating a deliberate close from the application
 * shutting down. See `ShellState::closing`.
 */
export function closeWindow(label: string): Promise<void> {
  return invoke("close_window", { label });
}

/** Open a new, empty window. Distinct from `detachInstance`, which makes one by moving a tab into it. */
export function newWindow(): Promise<void> {
  return invoke("new_window");
}

export function setWindowGeometry(label: string, geometry: WindowGeometry): Promise<void> {
  return invoke("set_window_geometry", { label, geometry });
}

/** Which Veistra window the cursor is over, or `null` if it is over none of them. */
export function windowAtCursor(): Promise<string | null> {
  return invoke<string | null>("window_at_cursor");
}

/** Drop a terminal into any Veistra window's terminal band, including this one. */
export function moveTerminal(id: string, toLabel: string): Promise<void> {
  return invoke("move_terminal", { id, toLabel });
}

/** Which terminal a cluster's band is showing. */
export function setActiveTerminal(clusterId: string, id: string | null): Promise<void> {
  return invoke("set_active_terminal", { clusterId, id });
}

/** How tall a cluster's band was left, at the end of a drag on its handle. */
export function setBandHeight(clusterId: string, height: number): Promise<void> {
  return invoke("set_band_height", { clusterId, height });
}

/** An app naming its own tab — "Files" becoming `client.ts`. */
export function setInstanceTitle(instanceId: string, title: string): Promise<void> {
  return invoke("set_instance_title", { instanceId, title });
}

/* --- terminals ---------------------------------------------------------------
 *
 * Mirrors `src-tauri/src/pty.rs`. `terminals.ts` owns the buffering that turns
 * these into a byte stream an emulator can trust; the wrappers below only
 * cross the boundary.
 */

/**
 * What a session is running, when it is running anything. Mirrors
 * `pty::Busy`. `null` means the shell is at a prompt with no child of its own.
 */
export interface TerminalBusy {
  process: string;
}

/** Mirrors `pty::Chunk` — one emission on `pty:data:<id>`. */
export interface PtyChunk {
  seq: number;
  data: string;
}

/** Mirrors `pty::Attachment` — what `terminalAttach` answers with. */
export interface PtyAttachment {
  text: string;
  nextSeq: number;
  exited: boolean;
}

export function createTerminal(windowLabel: string, cols: number, rows: number): Promise<string> {
  return invoke<string>("create_terminal", { label: windowLabel, cols, rows });
}

/**
 * A terminal in a pane of the active cluster, from the Apps menu or the
 * switcher's `+`. No `cols`/`rows`: unlike the panel's `create`, there is no
 * deck to size this against yet, so Rust uses the same 80x24 placeholder the
 * emulator corrects the instant it has measured itself.
 */
export function openTerminalInPane(
  windowLabel: string,
  paneId?: string,
  dir?: SplitDir,
): Promise<string> {
  return invoke<string>("open_terminal_in_pane", {
    label: windowLabel,
    paneId: paneId ?? null,
    dir: dir ?? null,
  });
}

export function splitTerminal(sourceId: string, cols: number, rows: number): Promise<string> {
  return invoke<string>("split_terminal", { id: sourceId, cols, rows });
}

export function closeTerminal(id: string): Promise<void> {
  return invoke("close_terminal", { id });
}

export function terminalBusy(id: string): Promise<TerminalBusy | null> {
  return invoke<TerminalBusy | null>("terminal_busy", { id });
}

export function setTerminalTitle(id: string, title: string): Promise<void> {
  return invoke("set_terminal_title", { id, title });
}

/** Subscribe to one session's output chunks. */
export function onPtyData(id: string, cb: (chunk: PtyChunk) => void): Promise<UnlistenFn> {
  return listen<PtyChunk>(`pty:data:${id}`, (e) => cb(e.payload));
}

/** Subscribe to one session's shell exiting — `exit`, or a crash. */
export function onPtyExit(id: string, cb: () => void): Promise<UnlistenFn> {
  return listen(`pty:exit:${id}`, () => cb());
}

/** The backlog since `id` was last attached to, or `null` if the session had already closed before anyone attached. */
export function terminalAttach(id: string): Promise<PtyAttachment | null> {
  return invoke<PtyAttachment | null>("terminal_attach", { id });
}

export function terminalWrite(id: string, data: string): Promise<void> {
  return invoke("terminal_write", { id, data });
}

export function terminalResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { id, cols, rows });
}

/**
 * Files were dropped onto a terminal. Resolves with the text that was inserted.
 * The quoting is Rust's, not this side's, and that is the whole reason this is
 * not `terminalWrite` with a string built here: only the backend knows which
 * shell the session spawned. See `src-tauri/src/quoting.rs`.
 */
export function terminalInsertPaths(id: string, paths: string[]): Promise<string> {
  return invoke<string>("terminal_insert_paths", { id, paths });
}

/* --- agent context --------------------------------------------------------------
 *
 * Mirrors `src-tauri/src/context.rs` and `context_commands.rs`. Bytes cross
 * once, into Rust; everything after passes ids.
 */

export type ContextKind = "image" | "file" | "text" | "json" | "panel";
export type Harness = "claude" | "codex" | "gemini" | "shell";

export interface ContextItem {
  id: string;
  v: number;
  kind: ContextKind;
  mime: string;
  title: string;
  source: { appId: string; label?: string };
  method: "put" | "drop" | "clipboard";
  createdAt: number;
  /** Stable source key (`blender/<blend>/<view>`); a re-send replaces the item. Empty on old records. */
  key?: string;
  /** Latest send, epoch ms. Later than `createdAt` means "updated". */
  updatedAt?: number;
  sha256?: string;
  /** The file's modification time, epoch ms, when it was last written. */
  mtime?: number;
  /** Set when a locked file forced a new name for this item. */
  notice?: string;
  size: number;
  path: string;
  relPath: string;
  owned: boolean;
  image?: { width: number; height: number };
  text?: { chars: number; lines: number; truncated: boolean };
  preview?: string;
  /** The file has gone since. Computed on every read. */
  missing: boolean;
}

/** What an insertion did. `text` is exactly what was written at the prompt. */
export interface ContextInserted {
  text: string;
  /** How many references `text` holds. */
  count: number;
  harness: Harness;
  items: ContextItem[];
  refused: string[];
}

export interface HarnessInfo {
  effective: Harness;
  detected: Harness | null;
  overridden: Harness | null;
}

/** Files dropped on a terminal: copied into the context store when a coding
 *  harness is running there, inserted as themselves when it is a plain shell. */
export function terminalDropPaths(id: string, paths: string[]): Promise<ContextInserted> {
  return invoke<ContextInserted>("terminal_drop_paths", { id, paths });
}

/** An image from the clipboard: stored, then referenced at the prompt. */
export function terminalPasteImage(
  id: string,
  bytesBase64: string,
  name?: string,
): Promise<ContextInserted> {
  return invoke<ContextInserted>("terminal_paste_image", { id, bytesBase64, name });
}

/** Send items already in the store to a terminal again. */
export function terminalInsertItems(id: string, itemIds: string[]): Promise<ContextInserted> {
  return invoke<ContextInserted>("terminal_insert_items", { id, itemIds });
}

/** The absolute paths of context items a frame is dragging. */
export function contextItemPaths(instance: string, itemIds: string[]): Promise<string[]> {
  return invoke<string[]>("context_item_paths", { instance, itemIds });
}

export function terminalHarness(id: string): Promise<HarnessInfo | null> {
  return invoke<HarnessInfo | null>("terminal_harness", { id });
}

/** `"auto"` returns the terminal to detection. */
export function terminalSetHarness(id: string, choice: Harness | "auto"): Promise<void> {
  return invoke("terminal_set_harness", { id, choice });
}

/** The items in a terminal's environment, newest first. */
export function contextList(terminalId: string): Promise<ContextItem[]> {
  return invoke<ContextItem[]>("context_list", { terminalId });
}

export function contextRemove(terminalId: string, itemId: string): Promise<void> {
  return invoke("context_remove", { terminalId, itemId });
}

/** `[mime, base64]` of an image item. */
export function contextThumb(terminalId: string, itemId: string): Promise<[string, string]> {
  return invoke<[string, string]>("context_thumb", { terminalId, itemId });
}

/** A store changed. `root` is the environment root; refetch if it is yours. */
export function onContextChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("context:changed", () => cb());
}

/* --- files dragged in from outside Veistra ------------------------------------
 *
 * Not a command and not one of our own events: the operating system's own drag,
 * reported by the webview through Tauri. It is the one drag in the shell that
 * does not begin with a `pointerdown` we saw.
 */

/** Where an outside drag is, and what it is carrying once it lets go. */
export type FileDrag =
  | { kind: "over"; x: number; y: number }
  /** Absolute paths, as the operating system spells them. */
  | { kind: "drop"; x: number; y: number; paths: string[] }
  | { kind: "leave" };

/**
 * Subscribe to files being dragged over this window from outside it. Two things
 * are absorbed here so no caller has to know them.
 *
 * **`enter` and `over` are one event.** Tauri distinguishes them, and only
 * `enter` carries the paths; a drop target needs a position on both and the
 * paths on neither, so they arrive here as one `over`.
 *
 * **The position is converted to CSS pixels.** Tauri reports *physical* device
 * pixels; every rectangle the shell hit-tests against comes from
 * `getBoundingClientRect`, which is CSS pixels. The divisor is
 * `devicePixelRatio` rather than the window's `scaleFactor`, deliberately: this
 * window can be zoomed (`setWebviewZoom`), zoom moves CSS pixels without moving
 * the scale factor, and only `devicePixelRatio` accounts for both. The window
 * is undecorated, so window-relative and client-relative share an origin — a
 * titlebar would offset every y by its height.
 */
export function onFileDrag(cb: (drag: FileDrag) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const e = event.payload;
    if (e.type === "leave") return cb({ kind: "leave" });

    const ratio = window.devicePixelRatio || 1;
    const x = e.position.x / ratio;
    const y = e.position.y / ratio;

    if (e.type === "drop") return cb({ kind: "drop", x, y, paths: e.paths });
    return cb({ kind: "over", x, y });
  });
}

/* --- layout presets ----------------------------------------------------------
 *
 * Mirrors `src-tauri/src/presets/mod.rs`. A preset is a named arrangement,
 * user data living in `presets.json` and outlasting whichever layout it was
 * captured from.
 */

/** Mirrors `presets::PresetSlot`. A terminal is not an app id. */
export type PresetSlot = { kind: "app"; appId: string } | { kind: "terminal" };

/** Mirrors `presets::PresetNode`. Discriminated on `kind`, like `PaneNode`. */
export type PresetNode =
  | { kind: "split"; dir: SplitDir; sizes: number[]; children: PresetNode[] }
  | { kind: "pane"; slots: PresetSlot[] };

/** Mirrors `presets::LayoutPreset`. */
export interface LayoutPreset {
  /** Stable across renames — what the menu sends back when a row is clicked. */
  id: string;
  name: string;
  /** Computed by Rust and never trusted from the file — a built-in cannot be replaced or deleted. */
  builtin: boolean;
  root: PresetNode;
}

export const PRESETS_CHANGED_EVENT = "presets:changed";

/** Every preset: built-ins first, then what survives of `presets.json`. */
export function listPresets(): Promise<LayoutPreset[]> {
  return invoke<LayoutPreset[]>("list_presets");
}

/** Subscribe to preset list changes, from this window or any other. */
export function onPresetsChanged(cb: (presets: LayoutPreset[]) => void): Promise<UnlistenFn> {
  return listen<LayoutPreset[]>(PRESETS_CHANGED_EVENT, (e) => cb(e.payload));
}

/** Rearrange this window's active cluster to match a preset. Nothing open is closed — see `presets::plan`. */
export function applyLayoutPreset(label: string, presetId: string): Promise<void> {
  return invoke("apply_preset", { label, presetId });
}

/** Capture the active cluster's arrangement under `name`. Resolves with the updated list. */
export function saveLayoutPreset(label: string, name: string): Promise<LayoutPreset[]> {
  return invoke<LayoutPreset[]>("save_preset", { label, name });
}

/* --- settings --------------------------------------------------------------
 *
 * What can be changed, what it is worth changing to, and what has been changed.
 * The schema is Rust's — `src-tauri/src/settings/schema.rs` and every app's own
 * group — and this file mirrors it rather than restating it, which is the whole
 * reason the settings screen needs no per-setting frontend code. Adding a
 * setting is a Rust edit and nothing here changes.
 */

/** Mirrors `settings::SelectOption`. */
export interface SelectOption {
  value: string;
  label: string;
  /** A sentence under the label. Empty for an option whose label says it all. */
  description: string;
}

/**
 * Mirrors `settings::Control`. Internally tagged on `kind`, so narrowing on it
 * gives you the fields that control has and no others.
 *
 * The default is *inside* the control rather than beside it, deliberately: a
 * default has to be a value its own control can produce. See the Rust type.
 */
export type SettingControl =
  | { kind: "toggle"; default: boolean }
  | { kind: "number"; default: number; min: number; max: number; step: number; unit: string }
  | { kind: "text"; default: string; placeholder: string }
  | { kind: "select"; default: string; options: SelectOption[] };

/**
 * Mirrors `settings::Applies` — when a change takes effect.
 *
 * Drawn under the control rather than dropped, because most settings are read
 * when something is *made* (a pty spawned, an editor mounted) and a control
 * that silently does nothing to what is already on screen is how a settings
 * screen loses trust.
 */
export type SettingApplies = { when: "now" } | { when: "next"; what: string } | { when: "restart" };

/** Mirrors `settings::Setting`. */
export interface Setting {
  /** `search.maxMatches`. The part before the first dot is its group's id. */
  key: string;
  title: string;
  description: string;
  control: SettingControl;
  applies: SettingApplies;
}

/** Mirrors `settings::Group` — one section of the screen, and everything in it. */
export interface SettingsGroup {
  id: string;
  title: string;
  description: string;
  /** Lower sorts earlier. The shell takes 0–99; an app takes 100+. */
  order: number;
  settings: Setting[];
}

/**
 * Mirrors `settings::Snapshot`.
 *
 * `values` is **sparse**: a setting still at its default is absent rather than
 * present at that value. That is what lets a later build change a default and
 * have the new one reach everybody who never disagreed with the old one — so a
 * reader must fall back to `setting.control.default`, never treat a missing key
 * as unset-and-therefore-off.
 */
export interface SettingsSnapshot {
  groups: SettingsGroup[];
  values: Record<string, SettingValue>;
}

/** What a setting can hold. The three shapes the four controls produce. */
export type SettingValue = boolean | number | string;

export const SETTINGS_CHANGED_EVENT = "settings:changed";

/** Every group and every changed value. The whole screen, in one call. */
export function settingsSnapshot(): Promise<SettingsSnapshot> {
  return invoke<SettingsSnapshot>("settings_snapshot");
}

/**
 * Change one, resolving with the value that was actually stored.
 *
 * Not necessarily the one passed in — a number is clamped into its declared
 * range rather than refused — so a control should redraw from what comes back
 * rather than from what it sent.
 *
 * Rejects with a sentence meant to be shown: an unknown key, a value of the
 * wrong type, or a choice outside the options.
 */
export function setSetting(key: string, value: SettingValue): Promise<SettingValue> {
  return invoke<SettingValue>("settings_set", { key, value });
}

/** Put one back to what it ships with, resolving with that default. */
export function resetSetting(key: string): Promise<SettingValue> {
  return invoke<SettingValue>("settings_reset", { key });
}

/**
 * Put a whole section back, resolving with how many settings actually moved.
 *
 * Zero is a state, not a failure — nothing in that section had been changed.
 */
export function resetSettingsGroup(id: string): Promise<number> {
  return invoke<number>("settings_reset_group", { id });
}

/** Mirrors `skills::Mode`: a built-in skill's setting. */
export type SkillMode = "auto" | "on" | "off";

/** Mirrors `skills::How`: how one harness is given a built-in skill. */
export type SkillHow = "plugin" | "userSkills" | "hint";

/** Mirrors `skills::Owner`: who owns the folder a harness reads it from. */
export type SkillOwner = "absent" | "veistra" | "user";

/** Mirrors `skills::Install`: where one harness has a built-in skill. */
export interface SkillInstall {
  /** The agent tab's harness id (`veistra_agent_host::Harness`). */
  harness: "claude" | "codex";
  /** Its name, as the agent tab shows it. */
  name: string;
  how: SkillHow;
  path: string | null;
  owner: SkillOwner;
}

/** Mirrors `skills::SkillInfo`: one built-in skill on the settings page. */
export interface BuiltinSkill {
  name: string;
  /** From its `SKILL.md` frontmatter. */
  description: string;
  /** The setting that holds its mode, drawn inside its card. */
  settingKey: string;
  mode: SkillMode;
  installs: SkillInstall[];
}

/** Every skill Veistra ships, and where each harness has it. */
export function builtinSkills(): Promise<BuiltinSkill[]> {
  return invoke<BuiltinSkill[]>("builtin_skills");
}

/**
 * Subscribe to settings changes, from this window or any other.
 *
 * The payload is the whole `values` map rather than the key that moved, for
 * `presets:changed`'s reason: it is small, and a window that mounted late could
 * never have heard the deltas it missed since Tauri events have no replay.
 */
export function onSettingsChanged(
  cb: (values: Record<string, SettingValue>) => void,
): Promise<UnlistenFn> {
  return listen<Record<string, SettingValue>>(SETTINGS_CHANGED_EVENT, (e) => cb(e.payload));
}

/**
 * The Windows Copilot key, caught below the webview by the global hook
 * (`copilot_key.rs`). Sent only to the window that should act on it, and only
 * while `keys.copilotGlobal` is on; otherwise the page's own `keydown` sees it.
 */
export const COPILOT_KEY_EVENT = "copilot-key:pressed";

export function onCopilotKey(cb: () => void): Promise<UnlistenFn> {
  return listen(COPILOT_KEY_EVENT, () => cb());
}

/* --- updates ---------------------------------------------------------------
 *
 * Mirrors `src-tauri/src/updater.rs`, which runs the check, the download and
 * the installer — STANDARDS.md §1, and that module's header says why
 * `@tauri-apps/plugin-updater` is deliberately not a dependency here.
 */

/**
 * Mirrors `updater::UpdateState`. Internally tagged, so narrowing on `state`
 * gives you the fields that variant carries. `percent` is sent rather than
 * derived because `total` can be null — a release asset served without a
 * `Content-Length` leaves nothing to derive it from.
 */
export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date"; version: string }
  | { state: "available"; version: string; notes: string }
  | { state: "downloading"; received: number; total: number | null; percent: number | null }
  | { state: "installing" }
  | { state: "failed"; message: string }
  | { state: "unsupported"; reason: string };

export const UPDATE_CHANGED_EVENT = "updater:changed";

/**
 * Where the updater is, without touching the network. Asked once on mount, for
 * `bootStatus`'s reason: Tauri events have no replay, so a window created after
 * the launch check would otherwise never learn its result.
 */
export function updateState(): Promise<UpdateState> {
  return invoke<UpdateState>("update_state");
}

/** Ask the releases endpoint now, resolving with the state it settled in. */
export function checkForUpdate(): Promise<UpdateState> {
  return invoke<UpdateState>("check_for_update");
}

/**
 * Download the standing offer and run its installer. **This promise does not
 * resolve on Windows** — the installer ends the process awaiting it, so treat
 * it as a one-way door. Rejects with a sentence meant to be shown when there is
 * no offer standing, or when the download or the signature check failed.
 */
export function installUpdate(): Promise<void> {
  return invoke<void>("install_update");
}

/** Subscribe to every transition, from the launch check or from any window. */
export function onUpdateChanged(cb: (state: UpdateState) => void): Promise<UnlistenFn> {
  return listen<UpdateState>(UPDATE_CHANGED_EVENT, (e) => cb(e.payload));
}

/* --- MCP -------------------------------------------------------------------
 *
 * The servers Veistra hosts for whatever coding agent is running in one of its
 * terminals. Design and the rule about what may be added are in
 * `docs/mcp-server-manager.md`.
 */

/** Mirrors `mcp::ServerInfo`. */
export interface McpServerInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** The route it answers on, `/mcp/<id>`. Shown so a connection can be checked by hand. */
  path: string;
  /** The key it takes in a project's `.mcp.json`, `veistra-<id>`. */
  configKey: string;
  toolCount: number;
  /** Only `developer.mode` reveals this one. Rust has already filtered the list; this marks it. */
  devOnly: boolean;
}

/**
 * Mirrors `mcp::commands::EndpointStatus`.
 *
 * `port` is `null` when the listener never bound — a machine that would not
 * hand out a loopback socket — and the UI has to say so rather than draw a
 * connected state over nothing. **There is deliberately no token field**, here
 * or on the Rust side: nothing on screen needs it, and a secret that crosses
 * into a renderer is a secret in a devtools console.
 */
export interface McpStatus {
  port: number | null;
  servers: McpServerInfo[];
}

export function mcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_status");
}

/** Mirrors `mcp::registry::PanelTool`: one tool spelled as `tools/list` spells it. */
export interface McpToolInfo {
  name: string;
  description: string;
  /** A JSON Schema object, exactly what the server advertises as `inputSchema`. */
  inputSchema: unknown;
  /** Present only where the backend knows. Absent means "not claimed", not "writes". */
  annotations?: { readOnlyHint: boolean };
}

/** Mirrors `mcp::registry::ServerCatalog`. */
export interface McpServerTools {
  id: string;
  tools: McpToolInfo[];
}

/** Mirrors `apps::method_catalog::AppMethod`. There is no parameter schema: apps declare none. */
export interface McpAppMethod {
  method: string;
  write: boolean;
  doc: string | null;
  blocked: string | null;
}

/** Mirrors `apps::method_catalog::AppMethodGroup`. */
export interface McpAppMethodGroup {
  app: string;
  name: string;
  methods: McpAppMethod[];
}

/** Mirrors `mcp::commands::McpCatalog`. */
export interface McpCatalog {
  servers: McpServerTools[];
  appMethods: McpAppMethodGroup[];
}

export function mcpCatalog(): Promise<McpCatalog> {
  return invoke<McpCatalog>("mcp_catalog");
}

/**
 * Switch a server on or off, resolving with whether anything changed.
 *
 * Rewrites every open project's `.mcp.json` on the way out — that file is what
 * a client reads, so a toggle that changed only our own state would leave the
 * two disagreeing until the next launch.
 */
export function setMcpServerEnabled(id: string, enabled: boolean): Promise<boolean> {
  return invoke<boolean>("mcp_set_server_enabled", { id, enabled });
}

/** Rewrite `.mcp.json` for every open project. The file is the user's, and they
 *  may have edited or deleted it. */
export function syncMcpConfig(): Promise<void> {
  return invoke<void>("mcp_sync_config");
}

/* --- search ------------------------------------------------------------------
 *
 * Mirrors `src-tauri/src/search.rs`. `search/searchSource.ts` owns the query
 * grammar (globs, `path:`/`ext:` filters) and the kind-filtering built on top
 * of this; the wrapper below only crosses the boundary.
 */

/** Mirrors `search::SearchMatch` — one line a query matched, within a file. */
export interface SearchMatch {
  /** 1-based, matching what Monaco's `revealLineInCenter` expects. */
  line: number;
  /** 1-based column of the first matched character. */
  column: number;
  /** The matched line's full text, for the row's preview snippet. */
  text: string;
  /** Length of the match within `text`, so the row can mark it. */
  length: number;
}

/** Mirrors `search::SearchFileHit`. */
export interface SearchFileHit {
  /** However `Path::display` renders it on this platform — backslashed on Windows. */
  path: string;
  matches: SearchMatch[];
}

/**
 * Mirrors `search::SearchResponse`. `truncated` is true when the backend's
 * own caps (`MAX_MATCHES`/`MAX_HITS`) cut the walk short, or a newer search
 * superseded this one before it finished.
 */
export interface SearchResponse {
  hits: SearchFileHit[];
  truncated: boolean;
}

export function searchContent(
  clusterId: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  regex: boolean,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_content", {
    clusterId,
    query,
    caseSensitive,
    wholeWord,
    regex,
  });
}

/** Whether Veistra's "Agent saw" hook is in this environment's Claude settings. */
export interface AgentSawStatus {
  installed: boolean;
  /** The settings file that is, or would be, edited. */
  settingsPath: string;
}

/** An image file the agent read. */
export interface AgentSeen {
  path: string;
  name: string;
  mime: string;
  missing: boolean;
  /** Milliseconds since the epoch; changes when the file is rewritten. */
  modified: number;
}

export function agentSawStatus(terminalId: string): Promise<AgentSawStatus> {
  return invoke<AgentSawStatus>("agent_saw_status", { terminalId });
}

/** Adds the hook to `.claude/settings.local.json`. Ask the person first. */
export function agentSawEnable(terminalId: string): Promise<AgentSawStatus> {
  return invoke<AgentSawStatus>("agent_saw_enable", { terminalId });
}

export function agentSawDisable(terminalId: string): Promise<AgentSawStatus> {
  return invoke<AgentSawStatus>("agent_saw_disable", { terminalId });
}

export function agentSawList(terminalId: string): Promise<AgentSeen[]> {
  return invoke<AgentSeen[]>("agent_saw_list", { terminalId });
}

/** `[mime, base64]` of an image the agent read. */
export function agentSawThumb(terminalId: string, path: string): Promise<[string, string]> {
  return invoke<[string, string]>("agent_saw_thumb", { terminalId, path });
}

/* --- usage data ------------------------------------------------------------
 *
 * Mirrors `src-tauri/src/telemetry.rs`. None of these sends anything: Rust
 * decides whether this *build* may send and keeps the local ledger, and the
 * shell's `src/shell/telemetry/` does the sending once a person has said yes.
 * `docs/telemetry.md` is the contract.
 */

/**
 * Mirrors `telemetry::Sink`. Narrow on `state`: the key exists only on the arm
 * that can use it, and `reason` is a sentence written to be shown.
 */
export type TelemetrySink =
  { state: "ready"; apiKey: string; host: string } | { state: "off"; reason: string };

/** Mirrors `telemetry::TelemetryConfig`. */
export interface TelemetryConfig {
  sink: TelemetrySink;
  /** One anonymous id per machine, minted on the first call. */
  installId: string;
  appVersion: string;
  os: string;
  arch: string;
  build: "release" | "debug";
}

/** Mirrors `telemetry::PromptRecord`. */
export interface PromptRecord {
  shown: number;
  lastShownMs: number | null;
  /** Set by the first answer; an answered prompt is never shown again. */
  answeredMs: number | null;
}

/** Mirrors `telemetry::Ledger`. */
export interface UsageLedger {
  installId: string;
  firstSeenMs: number;
  launches: number;
  /** Keyed `"<feature>:<event>"`, and only for events a prompt waits on. */
  counts: Record<string, number>;
  prompts: Record<string, PromptRecord>;
}

/** Mirrors `telemetry::PromptOutcome`. */
export type PromptOutcome = "shown" | "answered";

export function telemetryConfig(): Promise<TelemetryConfig> {
  return invoke<TelemetryConfig>("telemetry_config");
}

export function usageLedger(): Promise<UsageLedger> {
  return invoke<UsageLedger>("telemetry_ledger");
}

/** Add one to a counter; resolves with the whole ledger, already counted. */
export function countUsage(key: string): Promise<UsageLedger> {
  return invoke<UsageLedger>("telemetry_count", { key });
}

export function recordPrompt(id: string, outcome: PromptOutcome): Promise<UsageLedger> {
  return invoke<UsageLedger>("telemetry_prompt", { id, outcome });
}
