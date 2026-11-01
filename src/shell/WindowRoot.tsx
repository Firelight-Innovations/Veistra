import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { openUrl } from "@tauri-apps/plugin-opener";
import { contextItemPaths, onCopilotKey, type Openable, type StackSnapshot } from "../bindings";
import Frame, { BOTTOM_DEFAULT, PROJECT_PAGE_DEFAULT } from "./frame/Frame";
import { bandGeometry, withBandGeometry, type BandGeometryByCluster } from "./frame/bandGeometry";
import {
  appPresentation,
  pluginPresentation,
  clusterRoot,
  groupTerminalTabs,
  paneLeaves,
  paneOfTab,
  paneTabs,
  toolPresentation,
  updateNotice,
  type ClusterMember,
  type PaneNode,
  type ReviewSend,
  type TerminalBusy,
  type TerminalSession,
  type TerminalTabGroup,
  type WindowKind,
} from "./contract";
import { environmentOf, environmentKey, isReadOnly } from "./environment";
import { snap } from "./motion";
import { INTERRUPT, commandLine, terminalInput } from "./run";
import ContextMenuHost from "./ContextMenuHost";
import CommandPalette, { type PalettePage } from "./palette/CommandPalette";
import ClusterIconDialog from "./dialogs/ClusterIconDialog";
import NewClusterDialog, {
  type EnvironmentKind as ClusterEnvironmentKind,
} from "./dialogs/NewClusterDialog";
import SwitchProjectDialog from "./dialogs/SwitchProjectDialog";
import CloseUnsavedDialog from "./dialogs/CloseUnsavedDialog";
import { getSubject } from "./viewerSubjects";
import { nextAddClusterStep } from "./addClusterFlow";
import { commandsFromMenus, withOpenAppCommands } from "./palette/registry";
import TitleBar from "./titlebar/TitleBar";
import { APP_COMMAND, defaultMenus, type CommandHandlers } from "./titlebar/menus";
import { editHandlers, useEditTarget } from "./titlebar/useEditTarget";
import ClusterStrip from "./rail/ClusterStrip";
import ToolHealthBadge from "./titlebar/ToolHealthBadge";
import { cycleTarget, orderClusters } from "./clusterList";
import ToolWindow, { type ToolWindowHandle } from "./toolwindow/ToolWindow";
// The two the tool window draws through a render prop rather than importing;
// see its `renderPanes`/`renderTerminal` props for why.
import PaneTree from "./panes/PaneTree";
import PaneTerminal from "./terminal/PaneTerminal";
import { splitDirOnOpen } from "./panes/splitOnOpen";
import { railKeyOf } from "./rail/railKey";
import { toggleMaximize } from "./panes/paneMaximize";
import BottomPanel from "./panel/BottomPanel";
import StatusBar from "./statusbar/StatusBar";
import SearchSlot from "./search/SearchSlot";
import TitleBarActions, { UPGRADE_URL } from "./titlebar/TitleBarActions";
import SearchOverlay from "./search/SearchOverlay";
import { useSearchSession } from "./search/useSearchSession";
import { openHitInFiles } from "./search/openHit";
import { useDrag } from "./drag/useDrag";
import { useFileDrag } from "./drag/useFileDrag";
import { useDropZone } from "./dropZones";
import { useKeyboard } from "./keys/useKeyboard";
import { useFocusReporter } from "./useFocusReporter";
import { dispatchCopilotKey, type CopilotAction, type CopilotHandlers } from "./copilotKey";
import GithubPanel from "./github/GithubPanel";
import WorktreePanel from "./worktree/WorktreePanel";
import { useGitStatus } from "./worktree/useGitStatus";
import TerminalDeck, { type TerminalDeckHandle } from "./terminal/TerminalDeck";
import { callApp, useApps, useOpenables, usePages } from "./state/apps";
import { applyPreset, savePreset, useLayoutPresets } from "./state/presets";
import { useClusterProject } from "./state/project";
import { publishAgentTabStates } from "./agentTabStates";
import {
  agentClusters,
  agentName,
  agentsDot,
  NO_SESSION,
  useAgentSessions,
} from "./state/agentSessions";
import { agentTabIn, useAgentTabRefresh } from "./state/agentTab";
import {
  emptyAgentTab,
  newAgent,
  openAgent,
  resumeAgent,
  type AgentOpeners,
} from "./state/agentOpeners";
import { openSavedSession, renameAgentTab } from "./state/savedSessions";
import { agentScopeOf, type AgentMenuActions } from "./agentMenuItems";
import { agentTab as agentTabUsage } from "./telemetry/features";
import { openFeedback } from "./telemetry/surface";
import ReadOnlyBanner from "./git/ReadOnlyBanner";
import { useProjectIcon } from "./state/projectIcon";
import { useUpdates } from "./state/updates";
import {
  activateInstance,
  addCluster,
  closeCluster,
  closeInstance,
  closePage,
  closeWindow as closeThisWindow,
  detachInstance,
  newWindow,
  openInstance,
  openPage,
  renameCluster,
  setClusterIcon,
  setActiveCluster,
  setActiveTerminal,
  setBandHeight,
  setPageMode,
  setPageWidth,
  setPaneSizes,
  splitPane,
  useShellState,
  windowLabel,
} from "./state/shellState";
import { terminalControl, terminalTransport } from "./state/terminals";
import { gitControl, worktreeControl } from "./state/git";
import { githubAuthControl, githubControl } from "./state/github";
import { copyToClipboard, reviewControl } from "./state/review";
import { isFullscreen, isTauri, nextZoom, setFullscreen, setZoom } from "./hostWindow";
import { useSettingsSurface } from "./settingsSurface";
import { gitViewShowing, showGitView } from "./gitPageDoor";
import { useLibrarySurface } from "./librarySurface";
import { useShortcutsSurface } from "./shortcutsSurface";
import { closeCoveringScreens, openSettingsOnTop } from "./coveringScreens";
import Rail from "./rail/Rail";
import PageShell from "./rail/PageShell";
import AppPage from "./rail/AppPage";
import HindsightPage from "./rail/HindsightPage";
import AgentsPage from "./rail/AgentsPage";
import GitPage, { type GitPageView } from "./rail/GitPage";

/**
 * What a window draws before the first `shell:state` arrives.
 *
 * A tree rather than `null`, so every consumer can assume there is always a
 * pane. `PaneTree` and `ToolWindow` would both otherwise need a "no layout yet"
 * branch that exists for one frame and is impossible to see.
 */
const EMPTY_TREE: PaneNode = { kind: "leaf", id: "pane-pending", tabs: [], activeTab: null };

/**
 * The apps that **cover** the cluster instead of taking a pane beside it: no
 * tab in the switcher bar, not counted by a collapsed chip, and gone the
 * instant you choose anything else. `docs/tutorials.md` §8 has the reasoning;
 * `shell_state.rs`'s `is_takeover_app` is this list's other half.
 */
const TAKEOVER_APPS = new Set(["home", "tutorial"]);

/** Whether an app id names a takeover surface. Undefined is not one. */
function isTakeover(appId: string | undefined): boolean {
  return appId !== undefined && TAKEOVER_APPS.has(appId);
}

/**
 * One Veistra window.
 *
 * Both the main window and every detached one mount this. They differ in
 * exactly one visible way — a detached window holds a single tool, so it has no
 * switcher bar — and that difference is a slot being omitted, not a second
 * component. Everything else is identical, which is what makes a detached
 * window feel like the same application rather than a stripped-down popup.
 *
 * `MotionConfig` sits here rather than at the app root so a detached window
 * gets the same scale without anything having to pass it across the window
 * boundary. `reducedMotion="user"` is honoured by every `motion` component
 * beneath it, so the seven moments collapse to state changes for anyone who
 * has asked the OS for that — no per-component opt-in, and no way to forget.
 */
const CLUSTERS_COLLAPSED_KEY = "veistra.clusters-collapsed";

export default function WindowRoot({
  snapshot,
  error,
  rescanning,
  onRescan,
  copilotAction,
}: {
  snapshot: StackSnapshot | null;
  /** Set when the last scan failed. Surfaces in the health list, not a banner. */
  error: string | null;
  rescanning: boolean;
  /** "Re-scan tools", from the health popover, the empty state, and Ctrl+R. */
  onRescan: () => void;
  /** What the Windows Copilot key does: the `keys.copilotAction` setting. */
  copilotAction: CopilotAction;
}) {
  const label = useMemo(() => windowLabel(), []);
  const kind: WindowKind = label === "main" ? "main" : "detached";

  // Which of the Git page's two tabs is showing. View-local: two windows on
  // two monitors can honestly be looking at two different things, and one of
  // them switching to GitHub is not a fact about the project. Source control
  // first, because it is the one that answers without a network. The page's
  // width is not here; it is the window's `rightPage.width`, persisted by Rust.
  const [gitView, setGitView] = useState<GitPageView>("worktree");

  // The terminal band's open state — shut, or pulled all the way to the top
  // with the apps minimized under it — **per cluster**, not per window.
  //
  // Per cluster because the band is drawn inside the cluster's half of the
  // window: one value for the window meant pulling the band up in one cluster
  // pulled it up in the next one you switched to. Its *height* is not here at
  // all; that one is the cluster's own and comes back from `shell:state` (see
  // `Cluster.bandHeight`), so it survives a restart the way pane sizes do.
  // These two stay in the view on purpose — `bandGeometry.ts` says why.
  //
  // Every cluster starts shut: a window that opened with an empty band every
  // launch would be spending height on nothing.
  const [bandByCluster, setBandByCluster] = useState<BandGeometryByCluster>({});

  // Registered on the band rather than taken by the band itself: `panel` is a
  // region and may not import the drag layer (STANDARDS.md §1.2). This file is
  // not a region, so the zone is made here and handed down as a ref.
  const bottomZone = useDropZone({ kind: "panel" });

  // Whether the search dialog is open. Lifted here because the cluster row's
  // trigger, Ctrl+K and the dialog mount all read it, and none owns the others.
  const [searchExpanded, setSearchExpanded] = useState(false);
  const openSearch = useCallback(() => setSearchExpanded(true), []);
  const closeSearch = useCallback(() => setSearchExpanded(false), []);

  // Two lists, and they are not the same question. `apps` is *things with a
  // frontend* — what `presentationOf` below resolves a mountable surface from —
  // and `openables` is *things the Apps menu can open*, which is those plus a
  // terminal. A terminal has no frontend to mount, so it is deliberately absent
  // from the first; see `bindings.ts`'s `Openable`.
  const apps = useApps();
  const openables = useOpenables();

  // The pinned stack components, resolved but **not openable**.
  //
  // Not the same thing as an installed plugin, and the distinction is the whole
  // reason both exist. These are the `[[tool]]` entries in `veistra.toml` — the
  // stack this build expects, at the versions it pins — and what the shell does
  // with them is *report* on them: this is what the title bar's warning badge
  // and its health list read, and the only place that says a component needs an
  // update or is not checked out. A plugin somebody installed is a different
  // question with no pinned version to disagree with, and arrives through
  // `openables` below.
  const stackTools = useMemo(
    () => (snapshot?.tools ?? []).filter((t) => t.kind === "dev-tool").map(toolPresentation),
    [snapshot],
  );

  // How to present the surface an instance is an instance of. A lookup by
  // *surface* id, because that is what decides which code to load and what to
  // call it — there is one presentation of Files however many Files are open.
  //
  // Two sources, and the order matters: a first-party app wins a collision.
  // `plugins::install_folder` already refuses a package whose id shadows an app,
  // so this cannot happen through the installer — it is here because the map is
  // also built from a *saved layout*, and a build that later added an app with a
  // plugin's name would otherwise resolve the plugin and route its calls into a
  // process that no longer owns that id.
  const presentations = useMemo(() => {
    const byId = new Map(
      openables
        .filter((o) => o.kind === "plugin")
        .map((surface) => [surface.id, pluginPresentation(surface)] as const),
    );
    for (const app of apps) byId.set(app.id, appPresentation(app));
    return byId;
  }, [apps, openables]);
  const presentationOf = useCallback((appId: string) => presentations.get(appId), [presentations]);

  const shell = useShellState();
  const placement = shell?.windows.find((w) => w.label === label) ?? null;

  // The project-page rail's own state: the six pages Rust declares
  // (`pages::rail()`, via `usePages`) and this window's `right_page`, if it
  // has one open. Independent of `clusters`/`activeClusterId` below on
  // purpose -- `shell_state.rs`'s `RightPage` no longer lives on a cluster,
  // so a docked or expanded page and a real cluster to work in coexist
  // rather than one covering the other.
  const pages = usePages();
  const rightPage = placement?.rightPage ?? null;
  const activePage = rightPage ? pages.find((p) => p.id === rightPage.id) : undefined;

  // Focus follows the rail page. Opening or switching lands focus on the page
  // (the surface is focusable; an app's iframe cannot be focused from here),
  // and closing hands it back to that page's rail button. The close half runs
  // while the page is still mounted, tucking away, so it can tell whether
  // focus was inside it; focus that is somewhere else entirely is left alone.
  const openPageId = rightPage?.id ?? null;
  const previousPageId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousPageId.current;
    previousPageId.current = openPageId;
    if (openPageId !== null) {
      if (openPageId !== previous) pageShellRef.current?.focus({ preventScroll: true });
      return;
    }
    if (previous === null) return;
    const active = document.activeElement;
    const inPage =
      active instanceof HTMLElement && active.closest(".k-docked-page, .k-expanded-page") !== null;
    if (inPage || active === document.body || active === null) {
      document
        .querySelector<HTMLElement>(`.k-rail__btn[data-page-id="${previous}"]`)
        ?.focus({ preventScroll: true });
    }
  }, [openPageId]);
  // The element an app-backed page's iframe is portaled into; `AppPage` reports
  // it. State, not a ref, so `ToolWindow` re-renders once it exists.
  const [pageHost, setPageHost] = useState<HTMLElement | null>(null);
  const pageShellRef = useRef<HTMLDivElement>(null);

  // There is no seeding effect any more, and its absence is the point.
  //
  // What used to be here docked every app into the bar on first run, because
  // `ShellState::default` deliberately held no opinion about what should be
  // open. That opinion now lives in one place, in Rust, at the only moment it
  // can be formed correctly: `lib.rs`'s `seed_first_run` opens Home and nothing
  // else, and only when there is no saved layout to restore instead. A frontend
  // effect doing it as well would fight the restore — it would re-open surfaces
  // into a session that had deliberately closed them, every launch.

  // `null` is an ordinary state now, not just the moment before the first
  // `shell:state`: closing the last cluster in a window leaves it with none.
  // The app area draws `NoClustersState` for it and the terminal panel — which
  // is the window's, not any cluster's — carries on working beside it.
  //
  // A page (Agents, Cost Tracker) is a cluster in Rust's list and not one here.
  // `shownCluster` is whatever the tool window draws, page or not; `activeCluster`
  // is the one you *work* in, and is `null` while a page is in front — so the
  // band, search, the Apps menu, presets and File > Open all read a page exactly
  // as they read a window with no cluster. `clusters` is the real ones only,
  // which is what the bar's chips, Ctrl+1…9 and the new-cluster number count.
  const allClusters = placement?.clusters;
  const clusters = useMemo(() => (allClusters ?? []).filter((c) => !c.page), [allClusters]);
  // The order every cluster surface shows and numbers them in — the dropdown,
  // the rail strip, Ctrl+1…9 and Ctrl+Tab — so Ctrl+2 is the second thing on
  // screen. See `clusterList.ts`.
  const orderedClusters = useMemo(() => orderClusters(clusters), [clusters]);
  const shownCluster =
    allClusters?.find((c) => c.id === placement?.activeClusterId) ?? clusters[0] ?? null;
  const activePageId = shownCluster?.page ?? null;
  const activeCluster = activePageId === null ? shownCluster : null;
  const activeClusterId = activeCluster?.id ?? null;

  // Read here, ahead of most of the handlers below, because `onAddCluster`
  // needs it to decide whether the New Cluster dialog has anywhere to point
  // its choices at — see that callback's own note.
  const project = useClusterProject(activeClusterId);
  const projectIcon = useProjectIcon(project?.path ?? null);

  // The band, as the cluster in front left it. Three values and two homes: the
  // height is the cluster's own — restored from the saved layout, and defaulted
  // here for one nobody has dragged the band in, so a new cluster opens at the
  // size a new window does rather than at its neighbour's — while shut and
  // maximized are this session's, keyed by cluster in `bandByCluster` above.
  const bottomHeight = activeCluster?.bandHeight ?? BOTTOM_DEFAULT;
  const { collapsed: bottomCollapsed, maximized: bottomMaximized } = bandGeometry(
    bandByCluster,
    activeClusterId,
  );

  // The three setters everything below writes through, each aimed at the
  // cluster in front rather than at the window. A window with no cluster has no
  // band on screen, so all three are no-ops for it — `withBandGeometry` absorbs
  // that for the two below, and the height guards for it here.
  const setBottomCollapsed = useCallback(
    (collapsed: boolean) => {
      setBandByCluster((band) => withBandGeometry(band, activeClusterId, { collapsed }));
    },
    [activeClusterId],
  );
  const setBottomMaximized = useCallback(
    (maximized: boolean) => {
      setBandByCluster((band) => withBandGeometry(band, activeClusterId, { maximized }));
    },
    [activeClusterId],
  );
  // Reported to Rust rather than kept here, because it outlives the session:
  // this is what `layout.json` brings back, and what follows a cluster dragged
  // into another window. One call per drag, on pointer-up — `Frame` animates
  // against a motion value while the pointer is down and reports where it was
  // let go, the same way `onResizePane` reports a pane split.
  const setBottomHeight = useCallback(
    (height: number) => {
      if (activeClusterId !== null) void setBandHeight(activeClusterId, height);
    },
    [activeClusterId],
  );

  // The search field and the search overlay are two regions in two different
  // bands of the frame, reading one query. That state lives here because this
  // is already where `searchExpanded` and the active cluster are resolved, and
  // because a cluster's project *is* the search root — switching clusters
  // therefore re-scopes search on its own, with nothing to keep in sync.
  //
  // A cluster sitting on a worktree works *in* that directory — its terminals
  // spawn there and its agents edit there — so search has to follow it, or it
  // answers about a different copy of the code than the one on screen. The rule
  // is deliberately not written out here: one function, owned by the side that
  // knows when a worktree is stale, is the difference between one precedence
  // and two that drift apart.
  const searchRoot = activeCluster ? clusterRoot(activeCluster) : null;
  const search = useSearchSession(searchRoot, activeClusterId);

  // Open one result in Files. Search closes first and the open runs unawaited,
  // so the overlay's exit and the Files frame's mount overlap rather than queue
  // — `openHitInFiles` queues its own delivery until that frame says it is
  // ready, so nothing is lost by not waiting for it here.
  const openSearchHit = useCallback(
    (path: string) => {
      setSearchExpanded(false);
      void openHitInFiles(path, activeClusterId);
    },
    [activeClusterId],
  );

  // Enter opens whatever the cursor is on, which is the one case where the
  // caller genuinely has no path to hand over — the keyboard's whole position
  // *is* `focus`.
  const onSubmitSearch = useCallback(() => {
    const path = search.focus?.path;
    if (path === undefined) return;
    openSearchHit(path);
  }, [search.focus, openSearchHit]);

  // Resolvable by id: what any tab id in any tree resolves to. Every surface in
  // every cluster, not just the active one — a drag can name a tab in a cluster
  // that is not on screen, and a `Map` missing it would draw its raw id.
  //
  // Terminals are in here too, and they have to be. A terminal dragged into the
  // layout becomes a tab in a pane tree, and `ToolWindow` mounts a surface for
  // every tab it can resolve — its `kind === "terminal"` branch is what draws
  // the emulator in the pane area instead of an iframe, and it is reachable only
  // if the id resolves at all. Rust keeps them in `terminals` rather than in
  // `instances` because a session has a pty behind it and an ordinary surface
  // does not; that distinction is about ownership, not about how a tab is drawn,
  // so it is flattened away here where the drawing happens.
  const instances = useMemo(() => {
    const map = new Map((shell?.instances ?? []).map((i) => [i.id, i]));
    for (const t of shell?.terminals ?? []) {
      // `appId` is `"terminal"` — a type name like `files` or `home`, and kept
      // out of the real app registry on purpose even though the Apps menu now
      // offers one. `apps::openables` is what puts it in that menu, and it is a
      // *second* list beside the registry precisely so this id never resolves to
      // a frontend: the terminal branch of `ToolWindow` never asks for a
      // presentation, `useApps` does not contain it, and the two places that
      // resolve an app id from the focused surface guard on `kind` first. Rust
      // holds the same line — `is_app` answers false for it, and `open_instance`
      // refuses it by name.
      map.set(t.id, { id: t.id, appId: "terminal", kind: "terminal", title: t.title });
    }
    return map;
  }, [shell?.instances, shell?.terminals]);

  // The tree this window draws. An empty leaf covers the moment before the
  // first `shell:state` lands — there is always a pane, so there is always
  // somewhere for a surface to go.
  const tree: PaneNode = shownCluster?.tree ?? EMPTY_TREE;

  // Which pane an open acts on, and which pane's tabs the menus act on. Local,
  // because "which pane you were last looking at" is a fact about this screen;
  // kept valid by the effect below rather than by every place a pane can appear
  // or vanish.
  const [activePaneId, setActivePane] = useState<string | null>(null);
  const paneIds = useMemo(() => paneLeaves(tree).map((l) => l.id), [tree]);
  useEffect(() => {
    if (activePaneId === null || !paneIds.includes(activePaneId)) {
      setActivePane(paneIds[0] ?? null);
    }
  }, [paneIds, activePaneId]);

  // Tells the backend where focus is, so an agent subscribed to
  // `veistra://workspace/focus` hears when it moves. See `focusReport.ts`.
  useFocusReporter(label, activeClusterId, activePaneId);

  // Which pane, if any, is drawn full-size with the rest hidden but still
  // mounted — VEISTRA-UX-REWORK.md §5's "double-click a tab to maximise its
  // pane." View-local for the same reason `activePaneId` is: a fact about
  // this window's screen, not the project. Reset rather than followed when
  // the maximised pane disappears out from under it (its cluster's tree
  // changed, or the cluster itself did) — a maximised id naming nothing would
  // leave `PaneTree` with every child hidden and none stretched to fill it.
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  useEffect(() => {
    if (maximizedPaneId !== null && !paneIds.includes(maximizedPaneId)) {
      setMaximizedPaneId(null);
    }
  }, [paneIds, maximizedPaneId]);
  const onToggleMaximizePane = useCallback((paneId: string) => {
    setMaximizedPaneId((current) => toggleMaximize(current, paneId));
  }, []);

  /**
   * Focus follows what you just opened, into the pane it turned out to be in.
   *
   * It has to be chased rather than set, because opening now *makes* a pane and
   * Rust is what mints its id — all the caller gets back is the instance id, and
   * the tree that says where it went arrives separately on `shell:state`. So the
   * id is parked here and the effect below claims it on whichever render the
   * tree first contains it.
   *
   * This was free while opening meant "another tab in the focused pane": the
   * focused pane was already the right answer and nothing had to move. It is not
   * free now, and getting it wrong would be quietly bad rather than obviously
   * bad — the menus, Save, and the Edit target all resolve through
   * `activeInstanceId`, which is the *focused pane's* active tab. Leaving focus
   * behind would mean opening an app and then having File > Save act on the one
   * you opened it beside. It is also what makes the split rule read the way it
   * should: a third app opened after a second splits the pane the second one is
   * in, so the arrangement grows where you are looking rather than always
   * halving the first pane again.
   */
  const [openedInstanceId, setOpenedInstance] = useState<string | null>(null);
  useEffect(() => {
    if (openedInstanceId === null) return;
    const pane = paneOfTab(tree, openedInstanceId);
    // Not yet in the tree: the broadcast for this open has not landed. Nothing
    // to do but wait — the next one re-runs this. A surface that never arrives
    // (the open failed) leaves a dead id parked here, which costs one pointless
    // lookup per tree change until the next open replaces it.
    if (pane === null) return;
    setActivePane(pane);
    setOpenedInstance(null);
  }, [openedInstanceId, tree]);

  // --- Home ------------------------------------------------------------------
  //
  // Home is a surface like any other and lives in the cluster's tree. It is
  // never *listed* — not in the bar, not in the Apps menu — because it has one
  // door instead: the chip of the cluster you are already in. What that door
  // does is cover the window with it, so every app is still mounted at the size
  // it was when Home goes away. `ToolWindow`'s `soloInstanceId` is the whole of
  // the mechanism.
  const homeInstanceId = useMemo(
    () => paneTabs(tree).find((id) => instances.get(id)?.appId === "home") ?? null,
    [tree, instances],
  );

  // The second takeover surface — see `TAKEOVER_APPS`. Being *open* is what
  // makes it cover, so unlike Home it needs no "wanted" flag: nothing opens
  // Tutorials except somebody asking to read it.
  const tutorialInstanceId = useMemo(
    () => paneTabs(tree).find((id) => instances.get(id)?.appId === "tutorial") ?? null,
    [tree, instances],
  );

  // Asked for, and separately, showing. Opening a Home for a cluster that has
  // none is a round trip through Rust, and the flag is set before it lands.
  const [homeWanted, setHomeWanted] = useState(false);
  const homeShowing = homeWanted && homeInstanceId !== null;

  // The Home this window opened to cover with, closed again on the way out. A
  // cluster that already had one keeps it; one that did not is left exactly as
  // it was found, rather than paying a permanent pane for a look at Home.
  const openedHome = useRef<string | null>(null);

  const showHome = useCallback(() => {
    // A tutorial can be in front of Home. Without this it stays there, and the
    // chip looks dead.
    if (tutorialInstanceId !== null) void closeInstance(tutorialInstanceId);
    setHomeWanted(true);
    if (homeInstanceId !== null) return;
    void openInstance(label, "home", activePaneId ?? undefined, splitDirOnOpen(activePaneId))
      .then((id) => (openedHome.current = id))
      .catch((err: unknown) => {
        setHomeWanted(false);
        console.error("veistra: could not open Home:", err);
      });
  }, [label, activePaneId, homeInstanceId, tutorialInstanceId]);

  // Take whichever takeover surface is up back down. Called by every other way
  // of choosing a surface — chip, app, tab, cluster — since uncovering is the
  // same act as choosing something else. Tutorials is *closed* where Home is
  // merely uncovered; `docs/tutorials.md` §8 says why.
  const hideTakeover = useCallback(() => {
    setHomeWanted(false);
    const ours = openedHome.current;
    openedHome.current = null;
    // Guarded: the ref can outlive the instance it names.
    if (ours !== null && instances.has(ours)) void closeInstance(ours);
    if (tutorialInstanceId !== null) void closeInstance(tutorialInstanceId);
  }, [instances, tutorialInstanceId]);

  // The surface the menus act on: the active tab of the focused pane. Not "the
  // active tab" — with several panes on screen there is no such thing, and
  // Save has to mean the editor you were typing in rather than whichever pane
  // happens to be first in the tree.
  // Whichever takeover surface covers the window wins, because that is what is
  // in front of you. Tutorials first: it opens *over* Home, so when both exist
  // it is the one on screen.
  const activeInstanceId = useMemo(() => {
    if (tutorialInstanceId !== null) return tutorialInstanceId;
    if (homeShowing) return homeInstanceId;
    const focused = paneLeaves(tree).find((l) => l.id === activePaneId);
    return focused?.activeTab ?? paneLeaves(tree)[0]?.activeTab ?? null;
  }, [tree, activePaneId, homeShowing, homeInstanceId, tutorialInstanceId]);

  const activeInstance = activeInstanceId ? instances.get(activeInstanceId) : undefined;

  // Selecting and closing a tab used to live further down, alongside the
  // switcher row's own member-tab handlers — both gone now that the switcher
  // draws cluster tabs only; see `ClusterBar.tsx`'s header for where a pane's
  // own tab selection lives instead.

  /**
   * The Apps menu, and the switcher's `+`.
   *
   * The new surface gets a **pane of its own**, splitting the focused pane along
   * its longer axis. It used to land in the focused pane as another tab, which on
   * screen looked like it had replaced what was already there — the surface you
   * were looking at went behind the one you just opened, with nothing about the
   * click to say it would. Stacking two surfaces in one pane is still a thing you
   * can do; it is now something you *ask* for, by dragging a chip into that pane.
   *
   * The axis is measured here rather than decided in Rust, and
   * `panes/splitOnOpen.ts` writes that argument down: the tree stores fractions
   * of a parent, on purpose, so it cannot know which way a pane is drawn. What
   * stops repeated opening producing slivers, and what happens once there are
   * four panes, live in `PaneNode::open_into` — one set of rules, one place.
   */
  const onOpenApp = useCallback(
    (appId: string) => {
      // Opening something is asking to look at it, so Home stops covering it.
      hideTakeover();
      void openInstance(label, appId, activePaneId ?? undefined, splitDirOnOpen(activePaneId))
        .then(setOpenedInstance)
        .catch((err: unknown) => console.error("veistra: could not open that app:", err));
    },
    [label, activePaneId, hideTakeover],
  );

  /**
   * A terminal in a **pane of this cluster**, from the Apps menu or the `+`.
   *
   * Not the same action as the panel's own `+` a few hundred lines down, and both
   * are meant to exist. That one makes a terminal in the *window's* panel, which
   * outlives every cluster switch and is what you want for a shell watching one
   * worktree while the layout in front of it is about another. This one makes a
   * terminal that is part of an arrangement — the right-hand pane of a preset, or
   * wherever you drag it — and closes with the cluster drawing it. VS Code has
   * both for the same reason; `TerminalControl.createInPane` says more.
   *
   * It cannot go through `openInstance`: an instance is an app or a tool with a
   * frontend to mount, and a terminal is a pty. Rust refuses that call by name
   * rather than letting it mint a surface pointing at nothing.
   *
   * It splits the focused pane exactly as `onOpenApp` does, and passes the same
   * measured axis — Terminal sits in the Apps menu among the apps, so a row that
   * split and a row that stacked would be two behaviours in one list.
   */
  const onOpenTerminalHere = useCallback(() => {
    hideTakeover();
    void terminalControl
      .createInPane(label, activePaneId ?? undefined, splitDirOnOpen(activePaneId))
      // A session id is a tab id in a tree like any other, so the same
      // focus-follows-open path above applies to it unchanged.
      .then(setOpenedInstance)
      .catch((err: unknown) => console.error("veistra: could not open a terminal here:", err));
  }, [label, activePaneId, hideTakeover]);

  /**
   * The Apps menu's one click handler, for a list that is no longer all apps.
   *
   * Routed on `kind` rather than on the id, so nothing here has to know that
   * `"terminal"` is the string that means "spawn a shell" — Rust says which kind
   * each row is when it hands the row over, and this switches on that. A row
   * whose kind this build has never heard of would fall to the app branch and be
   * refused by the backend, which is the right failure: loud, and in one place.
   */
  const onOpenSurface = useCallback(
    (entry: Openable) => {
      if (entry.kind === "terminal") onOpenTerminalHere();
      else onOpenApp(entry.id);
    },
    [onOpenApp, onOpenTerminalHere],
  );

  const onResizePane = useCallback((splitId: string, sizes: number[]) => {
    void setPaneSizes(splitId, sizes);
  }, []);

  // --- clusters -------------------------------------------------------------

  const onSelectCluster = useCallback(
    (clusterId: string) => {
      // The already-active chip does not re-select itself — nothing changes when
      // it does. It is the cover's switch instead: press it and Home covers the
      // window, press it again and the apps are back exactly as they were. An
      // inactive chip still only switches, and takes the cover down on its way
      // out, since what it was covering belongs to the cluster you left.
      //
      // A tutorial counts as covered too — the chip is the only way out of one
      // in a cluster holding nothing else.
      if (clusterId === activeClusterId) {
        if (homeShowing || tutorialInstanceId !== null) hideTakeover();
        else showHome();
        return;
      }
      hideTakeover();
      void setActiveCluster(label, clusterId);
    },
    [label, activeClusterId, homeShowing, tutorialInstanceId, showHome, hideTakeover],
  );

  // The page chips — and the "open this page" call they made — are gone with
  // them. `activePageId`/`shownCluster` above still read a page cluster
  // correctly if one is ever the active one (Rust still keeps them in
  // `placement.clusters`); there is simply no switcher-row UI left in this
  // rework that opens one. The rail below is where that affordance lives now
  // — see `docs/design/VEISTRA-UX-SPEC.md` §1.7.

  // --- the project-page rail --------------------------------------------
  //
  // One door in: `Rail`'s click and Alt+1…7 both call this, and Rust's
  // `open_page` toggles a second click of the *same* page shut again
  // (`shell_state.rs`'s `open_page_pure`) — so this never has to know
  // whether a given call is an open or a close, only which button fired.
  const onSelectPage = useCallback(
    (pageId: string) => {
      void openPage(label, pageId);
    },
    [label],
  );
  // The expanded header's back button and Esc both call this — "leaving" a
  // page always means closing it, not docking it; `onTogglePageMode` below
  // is the separate action for that.
  const onClosePage = useCallback(() => {
    void closePage(label);
  }, [label]);
  // Ctrl+B, View > Show/Hide Clusters, and the panel buttons in the cluster
  // list and the agent tab: fold the cluster list away and bring it back. Kept
  // across launches, but only as a convenience: unreadable storage means open.
  const [clustersCollapsed, setClustersCollapsed] = useState(() => {
    try {
      return localStorage.getItem(CLUSTERS_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const onToggleClusters = useCallback(() => {
    setClustersCollapsed((was) => {
      try {
        localStorage.setItem(CLUSTERS_COLLAPSED_KEY, was ? "0" : "1");
      } catch {
        // Not remembered; the toggle still works for this launch.
      }
      return !was;
    });
  }, []);
  const onTogglePageMode = useCallback(() => {
    if (!rightPage) return;
    void setPageMode(label, rightPage.mode === "docked" ? "expanded" : "docked");
  }, [label, rightPage]);
  const onPageWidthChange = useCallback(
    (width: number) => {
      void setPageWidth(label, width);
    },
    [label],
  );

  // Alt+1…7 (open/switch the rail's page), Esc (leave an expanded page) and
  // Ctrl+Shift+E (dock/expand whichever one is open) — kept out of
  // `useKeyboard` below rather than added to it: none of the three fit its
  // Ctrl-chord table, Alt is a different modifier, and Escape is
  // `SearchSlot`'s own key to bind (`useKeyboard.ts`'s header explains why).
  // `WindowRoot` is not a region, so three more keys wired ad hoc here is
  // cheaper than teaching the shared hook a shape it would use exactly once.
  useEffect(() => {
    function isTextEntry(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      );
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isTextEntry(e.target)) return;

      const railKey = railKeyOf(e);
      if (railKey !== null) {
        const page = pages.find((p) => p.key === railKey);
        if (page && !page.disabled) {
          e.preventDefault();
          onSelectPage(page.id);
        }
        return;
      }
      if (e.key === "Escape" && rightPage?.mode === "expanded") {
        e.preventDefault();
        onClosePage();
        return;
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e" && rightPage) {
        e.preventDefault();
        onTogglePageMode();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pages, rightPage, onSelectPage, onClosePage, onTogglePageMode]);

  /**
   * The New cluster entries — the title bar dropdown's, the rail strip's `+`,
   * and Ctrl+Shift+N — all land here. Every new cluster
   * needs a project and an environment, and `NewClusterDialog` supplies the
   * environment relative to a project — so with none set, Switch project opens
   * first and the New Cluster dialog follows once a project lands (see the
   * effect below). Only a window with no cluster at all, which has nowhere to
   * put a project, still gets a bare numbered cluster. See `nextAddClusterStep`.
   *
   * `kind` is which environment the dialog opens on; omitted, its own default.
   */
  const onAddCluster = useCallback(
    (kind?: ClusterEnvironmentKind) => {
      const step = nextAddClusterStep(project !== null, activeClusterId !== null);
      if (step === "new-cluster") {
        setNewClusterKind(kind);
        setNewClusterOpen(true);
      } else if (step === "pick-project") {
        setNewClusterKind(kind);
        setNewClusterAfterProject(true);
        setSwitchProjectOpen(true);
      } else {
        void addCluster(label, `Cluster ${clusters.length + 1}`);
      }
    },
    [label, clusters.length, project, activeClusterId],
  );

  const onCloseCluster = useCallback((clusterId: string) => {
    void closeCluster(clusterId);
  }, []);

  // The cluster whose icon picker is open. Held as an id, not a cluster, so the
  // dialog reads the live one and closes itself if the cluster is closed under it.
  const [iconClusterId, setIconClusterId] = useState<string | null>(null);
  const iconCluster =
    iconClusterId === null ? null : (clusters.find((c) => c.id === iconClusterId) ?? null);
  const onChangeClusterIcon = useCallback((clusterId: string) => setIconClusterId(clusterId), []);

  const onRenameCluster = useCallback(
    (clusterId: string, name: string) => renameCluster(clusterId, name),
    [],
  );

  /**
   * Close this window, through the backend rather than through Tauri directly.
   *
   * `hostWindow.closeWindow` calls `getCurrentWindow().close()`, which is how
   * this used to work and is now wrong. `WindowEvent::Destroyed` cannot tell a
   * deliberate close from the application shutting down, and at shutdown it
   * fires for every window — so the backend needs the close *announced* before
   * it happens. Without that, `reclaim` would fold every window into `main` on
   * the way out and the layout written to disk would be that collapsed one. You
   * would quit with three windows and reopen with one. See
   * `ShellState::closing`.
   */
  const onCloseWindow = useCallback(() => {
    void closeThisWindow(label);
  }, [label]);

  /**
   * File > New Window: an empty window with a cluster of its own.
   *
   * Built by detaching nothing — `newWindow` on the backend creates the window
   * and seeds it, rather than this reusing `detachInstance` and taking a tab out
   * of the window you are looking at. That distinction is why the item was
   * disabled before: the only window-making path used to be "drag a tab out",
   * and wiring New Window to it would have opened a window by emptying this one.
   */
  const onNewWindow = useCallback(() => {
    void newWindow();
  }, []);

  // --- terminals ------------------------------------------------------------
  //
  // Sessions come from `shell:state` and nowhere else. They have to: a terminal
  // can be dragged into another window, so the list of what this band holds is
  // a filter over shared state rather than anything this window owns. Each one
  // has a real pty behind it (src-tauri/src/pty.rs).
  //
  // Filtered by *cluster*, which is what this used to filter by window. The band
  // is drawn inside the cluster's half of the window, so switching from `auth`
  // to `billing` swaps the terminals under it along with the layout above it —
  // see `shell_state`'s module doc for why that is the arrangement now.
  //
  // A terminal dragged into the layout is excluded — against *every* cluster in
  // this window, not just the one on screen, or one in cluster B's tree would
  // reappear in a band the moment you switched to cluster A.
  const sessions = useMemo(() => {
    const inTree = new Set(clusters.flatMap((c) => paneTabs(c.tree)));
    return (shell?.terminals ?? [])
      .filter((t) => t.clusterId === activeClusterId && !inTree.has(t.id))
      .map(({ id, title, agentFinished, groupId }) => ({ id, title, agentFinished, groupId }));
  }, [shell?.terminals, activeClusterId, clusters]);

  // `activeBandTab` is stored as whatever id was last clicked or created —
  // a plain session id most of the time. A tab's own identity can move out
  // from under that value without a click, though: splitting mints a group
  // id for a session that didn't have one, and closing a pane can collapse
  // a group back down to a plain session (see `onCloseTab` below). So this
  // re-derives "which tab is that id part of *right now*" on every render
  // instead of trusting the stored value verbatim — a session found by
  // either its own id or its group id resolves to its *current* tab id
  // (`groupId ?? id`), which is what `BottomPanel` and `TerminalDeck` both
  // key their own tab/pane matching on.
  //
  // There is no `"worktree"` case any more: that id named a tab in the sidebar's
  // row, back when one row listed terminals and the change list together.
  const [activeBandTab, setActiveBandTab] = useState<string>("");
  const bandTabId = (() => {
    const owner = sessions.find((s) => s.id === activeBandTab || s.groupId === activeBandTab);
    if (owner) return owner.groupId ?? owner.id;
    return sessions[0] ? (sessions[0].groupId ?? sessions[0].id) : "";
  })();

  // The pane split/clear/kill act on: "the terminal you have open" within
  // whichever tab is active. Defaults to the tab's first session and follows
  // clicks/focus inside `TerminalDeck` from there (see `onFocusPane` below).
  // Kept valid by the effect beneath it rather than by every place the tab
  // or the session list can change — a tab switch, a split, or a close all
  // funnel through the same one check instead of three separate ones that
  // could disagree.
  const [focusedPaneId, setFocusedPaneId] = useState<string>("");
  const activeTabSessions = useMemo(
    () => sessions.filter((s) => s.id === bandTabId || s.groupId === bandTabId),
    [sessions, bandTabId],
  );
  useEffect(() => {
    if (!activeTabSessions.some((s) => s.id === focusedPaneId)) {
      setFocusedPaneId(activeTabSessions[0]?.id ?? "");
    }
  }, [activeTabSessions, focusedPaneId]);

  // The deck mounts every xterm instance; clearing one reaches into a
  // specific mounted instance from outside the deck's own tree, which is
  // what the imperative handle is for — see `TerminalDeck`'s doc comment.
  const deckRef = useRef<TerminalDeckHandle>(null);

  /**
   * Which band tab is showing — locally *and* in the window that owns it.
   *
   * Both, because the two answer different questions. The local value paints on
   * the same frame as the click; the window's is what a restart restores, and
   * what a terminal dragged in from elsewhere lands on. Reporting only locally
   * would mean a relaunch always reopened on the first terminal rather than the
   * one you were using; reporting only to Rust would make every click wait a
   * round trip.
   */
  const onSelectBandTab = useCallback(
    (id: string) => {
      setActiveBandTab(id);
      if (activeClusterId !== null) void setActiveTerminal(activeClusterId, id);
    },
    [activeClusterId],
  );

  // What the cluster says was last showing — a restore, a drop from another
  // window, a close that moved the selection, or simply switching to a cluster
  // whose band was left on a different entry than this one's.
  useEffect(() => {
    if (activeCluster?.activeTerminal) setActiveBandTab(activeCluster.activeTerminal);
  }, [activeCluster?.activeTerminal]);

  // The **band's** new terminal — its rail's `+`, View > Show Terminal, and the
  // Terminal menu's New. Distinct from `onOpenTerminalHere` above, which puts one
  // in a pane of the layout, where it is part of an arrangement and sized by it.
  // Both are meant to exist — see `TerminalControl.createInPane`.
  //
  // It opens the band as well as creating the session, and every caller wants
  // that: a terminal you cannot see is a click that reads as having missed. The
  // pull-up gesture is the mirror of this and deliberately never spawns, so the
  // band is neither revealed empty by accident nor filled invisibly.
  const onNewTerminal = useCallback(async () => {
    // 80×24 is a placeholder the emulator overwrites the moment it has measured
    // itself. A pty has to be created with *some* size, and a shell that prints
    // a banner before the first resize would otherwise wrap against nothing.
    const id = await terminalControl.create(label, 80, 24);
    setActiveBandTab(id);
    setBottomCollapsed(false);
    // `setBottomCollapsed` is a dependency now that it aims at a cluster rather
    // than at the window: captured from an earlier render it would open the
    // band of the cluster that was in front then. Same for the three callbacks
    // below.
  }, [label, setBottomCollapsed]);

  // Open a second pty beside the focused pane, under the same tab — Rust
  // decides the group (reusing one if the focused session is already split,
  // minting one otherwise; see `commands::split_terminal`), this just asks
  // and then moves focus onto the pane that just opened.
  const onSplit = useCallback(async () => {
    if (!focusedPaneId) return;
    const id = await terminalControl.split(focusedPaneId, 80, 24);
    setFocusedPaneId(id);
  }, [focusedPaneId]);

  // Clears the focused pane's emulator only — never the pty. A full-screen
  // TUI draws from its own terminal state, not from anything a shell command
  // could print, so writing `cls`/`clear` into the stream would do nothing
  // useful to it (or land as literal keystrokes in whatever prompt it's
  // showing). `TerminalDeck.clear` calls xterm's own `clear()` on exactly
  // this pane's instance.
  const onClear = useCallback(() => {
    if (focusedPaneId) deckRef.current?.clear(focusedPaneId);
  }, [focusedPaneId]);

  // Closing the tab you were looking at has to leave you somewhere. Rust drops
  // the session from the broadcast, so `panelTabId` above would fall to the
  // first remaining terminal on its own — but only after a round trip, which
  // reads as a flicker. Choosing the neighbour here means the switch happens on
  // the same frame as the click, and the broadcast then agrees with it.
  //
  // Splitting means a tab can lose a pane without losing the tab, so this isn't
  // just "closed the active tab, move on" any more:
  //   - the tab survives with 2+ panes left: its group id is unaffected and
  //     `panelTabId`'s own re-derivation above keeps pointing at it.
  //   - the tab survives with exactly 1 pane left: `close_terminal_pure` on the
  //     Rust side ungroups a lone survivor (a group of one is not a group), so
  //     the tab's id moves from the shared group id to that session's own id.
  //     Predicted here for the same reason the neighbour jump always was.
  //   - the tab itself is gone (its last/only pane closed): jump to the
  //     neighbouring *tab*, walking distinct tab ids rather than raw session
  //     ids, since a split's second pane is not "the tab" a neighbour search
  //     should land on.
  const onCloseTab = useCallback(
    (id: string) => {
      const closed = sessions.find((s) => s.id === id);
      const closedTabId = closed ? (closed.groupId ?? closed.id) : null;
      if (closedTabId !== null && closedTabId === bandTabId) {
        const remaining = sessions.filter((s) => s.id !== id && (s.groupId ?? s.id) === bandTabId);
        if (remaining.length === 0) {
          const tabIds = [...new Set(sessions.map((s) => s.groupId ?? s.id))];
          const i = tabIds.indexOf(bandTabId);
          // `""` where this used to fall back to the worktree tab: closing the
          // last terminal leaves the band empty and showing its empty state,
          // rather than switching to a neighbour that no longer exists.
          setActiveBandTab(tabIds[i + 1] ?? tabIds[i - 1] ?? "");
        } else if (remaining.length === 1) {
          setActiveBandTab(remaining[0].id);
        }
      }
      // The band goes with the last of them, un-maximized so the next terminal
      // does not open onto a band that had swallowed the window. Only for one
      // that was *in* the band: closing a terminal that had been dragged into a
      // pane says nothing about what the band still holds.
      if (closed && sessions.length === 1) {
        setBottomCollapsed(true);
        setBottomMaximized(false);
      }
      terminalControl.close(id);
    },
    [bandTabId, sessions, setBottomCollapsed, setBottomMaximized],
  );

  // The one confirmation flow for closing a session with something running
  // in it — asked once, at the moment of the request, never polled. Lives
  // here rather than inside the band because the Terminal menu's Kill item
  // has to be able to raise the exact same dialog a tab's own × does, and a
  // dialog whose state lived only in `BottomPanel` could never be reached
  // from the title bar. `BottomPanel` still renders `CloseConfirm` — the
  // dialog is visually scoped to the band — it just no longer decides when
  // to show it.
  const [pendingClose, setPendingClose] = useState<{
    id: string;
    title: string;
    busy: TerminalBusy;
  } | null>(null);
  const requestClose = useCallback(
    async (session: TerminalSession) => {
      const busy = await terminalControl.busy(session.id);
      if (busy) {
        setPendingClose({ id: session.id, title: session.title, busy });
      } else {
        onCloseTab(session.id);
      }
    },
    [onCloseTab],
  );

  // The one place "which pane does closing this tab actually mean" gets
  // decided — the tab's own × and the Terminal menu's Kill item both route
  // through this rather than each carrying its own rule. The answer is the
  // focused pane when `tab` is the tab currently on screen (Kill's only
  // possible target, since it only ever acts on the active tab) and the
  // tab's first session otherwise (the × on a tab that isn't active has no
  // focused pane to speak of — nothing in it is on screen to have been
  // clicked).
  const requestCloseTab = useCallback(
    (tab: TerminalTabGroup) => {
      const target =
        tab.id === bandTabId
          ? (tab.sessions.find((s) => s.id === focusedPaneId) ?? tab.sessions[0])
          : tab.sessions[0];
      void requestClose(target);
    },
    [bandTabId, focusedPaneId, requestClose],
  );

  // The Terminal menu's Kill item acts on the focused pane, same as Split
  // and Clear — "the terminal you have open" is a property of the pane, not
  // of the tab it happens to sit in. Built as the active tab's own group so
  // it goes through `requestCloseTab` exactly like the × does, rather than
  // duplicating that resolution here.
  const onKillTerminal = useCallback(() => {
    if (activeTabSessions.length === 0) return;
    requestCloseTab({ id: bandTabId, sessions: activeTabSessions });
  }, [activeTabSessions, bandTabId, requestCloseTab]);

  // --- the cluster's members --------------------------------------------------
  //
  // The switcher row draws cluster tabs only now — `ClusterBar`'s own doc
  // comment says why — but every tab *in the open cluster* is still flattened
  // here, because `PaneTree`'s own per-pane strip (`PaneTabStrip`, the
  // **panes** workstream's) and its drag handle both need the same list this
  // file used to hand the switcher row instead.
  //
  // The band's terminals are not in this list, and that is the change from
  // before the rework. A cluster's members are its tree's tabs — a band
  // terminal is not one, so no cluster's group can list it without claiming
  // something untrue. The band names its own contents; see `BottomPanel`. A
  // terminal *dragged into* a tree is still here, because by then it is a
  // tree tab like any other.
  //
  // Derived, never stored: a membership list kept beside the tree would be a
  // second answer that could drift. Takeover surfaces are filtered out below
  // — see the `isTakeover` skip inside `members`, and `onSelectCluster` for
  // where Home's door went instead.

  // The band's tabs, grouped so a split terminal is one entry rather than two.
  const bandTabs = useMemo(() => groupTerminalTabs(sessions), [sessions]);

  // Agent-finished state for a terminal that has been dragged *into* the layout.
  // It is no longer in `sessions` (the panel does not hold it any more), but it
  // is still a live session with a dot to draw.
  const terminalsById = useMemo(
    () => new Map((shell?.terminals ?? []).map((t) => [t.id, t])),
    [shell?.terminals],
  );

  const members: ClusterMember[] = useMemo(() => {
    const list: ClusterMember[] = [];

    // Layout order, pane by pane. A surface that is its pane's active tab is
    // `showing` — with a split that is true of more than one at once, which is
    // the honest answer: there really are two surfaces on screen.
    for (const leaf of paneLeaves(tree)) {
      for (const id of leaf.tabs) {
        const instance = instances.get(id);
        // Skipped, not removed from the tree — `ToolWindow` mounts off `tree`
        // directly, so Home keeps running behind the chip that now opens it.
        if (isTakeover(instance?.appId)) continue;
        list.push({
          id,
          dragId: id,
          // An id in the tree with no instance behind it should not happen, and
          // drawing the raw id is how you find out that it did. Skipping it
          // silently would look like a rendering bug rather than a state one.
          title: instance?.title ?? id,
          kind: instance?.kind ?? "app",
          appId: instance?.appId,
          paneId: leaf.id,
          showing: leaf.activeTab === id,
          agentFinished: terminalsById.get(id)?.agentFinished ?? false,
        });
      }
    }

    // And nothing else. The band's terminals used to be appended here; they are
    // not the cluster's tree's, so the cluster's group does not claim them.
    // `BottomPanel` lists them in its own rail.
    return list;
  }, [tree, instances, terminalsById]);

  // Each pane's real tab order, takeover surfaces included. `PaneTabStrip`
  // measures its insertion index over what it actually renders, so the index
  // needs translating back against this before it can name a real tree
  // position. See `translateStripIndex` and `useDrag` for the mechanics.
  const paneTabsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const leaf of paneLeaves(tree)) map.set(leaf.id, leaf.tabs);
    return map;
  }, [tree]);

  /** A strip drop's visible index, re-counted against `paneTabsById`'s real one. */
  const translateStripIndex = useCallback(
    (paneId: string, visibleIndex: number): number => {
      const real = paneTabsById.get(paneId) ?? [];
      const visible = real.filter((id) => !isTakeover(instances.get(id)?.appId));
      if (visibleIndex >= visible.length) return real.length;
      return real.indexOf(visible[visibleIndex]);
    },
    [paneTabsById, instances],
  );

  /**
   * Clicking a tab in a pane's own strip.
   *
   * The two halves land in different places, which is the one thing this
   * hides from the person using it. A surface is activated in the pane that
   * already holds it, and that pane becomes the focused one — so the menus
   * follow the click, the way they would have if you had clicked the surface
   * itself. A terminal is in the band, so the band is opened if it was shut
   * and switched to it; a click that revealed nothing would read as a click
   * that missed.
   */
  const onSelectMember = useCallback(
    (member: ClusterMember) => {
      // Clicking any of them is choosing what to look at, which is the other
      // way Home stops covering the window. See `showHome`.
      hideTakeover();
      if (member.paneId !== null) {
        setActivePane(member.paneId);
        void activateInstance(member.id);
        return;
      }
      setBottomCollapsed(false);
      onSelectBandTab(member.id);
    },
    [onSelectBandTab, hideTakeover, setBottomCollapsed],
  );

  /**
   * Closing one, from its ×.
   *
   * A surface goes straight away — an app has nothing running that closing it
   * would interrupt. A terminal goes through the same "still running, close
   * anyway?" path the Terminal menu's Kill item uses, because it might.
   */
  const [unsavedClose, setUnsavedClose] = useState<ClusterMember | null>(null);

  const onCloseMember = useCallback(
    (member: ClusterMember) => {
      // A terminal is a terminal wherever it is drawn. One in a pane tree must
      // still go through the "still running, close anyway?" path and still end
      // its pty — `closeInstance` only takes a tab out of the tree, which for a
      // session would leave the shell alive and drop it back into the panel a
      // frame later, looking like a × that missed.
      if (member.kind === "terminal") {
        const session = terminalsById.get(member.dragId);
        if (session) void requestClose(session);
        return;
      }
      if (member.paneId !== null) {
        // A File Viewer with unsaved edits is asked about first: closing the
        // instance destroys the only copy of them.
        if (member.appId === "viewer" && getSubject(member.id)?.dirty) {
          setUnsavedClose(member);
          return;
        }
        void closeInstance(member.id);
        return;
      }
      const tab = bandTabs.find((t) => t.id === member.id);
      if (tab) requestCloseTab(tab);
    },
    [terminalsById, requestClose, bandTabs, requestCloseTab],
  );

  // --- the menu bar ---------------------------------------------------------
  //
  // File, Edit and View operate the window and the app showing in it. Three
  // facts make that possible without the shell knowing anything about Files:
  //
  //   1. `toolRef` posts a menu command into the active frame (transport B, a
  //      `command` message — see `ToolWindow`'s header).
  //   2. `appCommands` is what each frame has said it can do *right now*, which
  //      is the only thing that decides whether an item is clickable.
  //   3. `editTarget` is where focus was before the menu opened, which decides
  //      whether Edit means the app at all.
  //
  // None of the three names an app, a method, or a file type.
  // Keyed by *instance*, not by app. Two Files can differ in what they can do
  // right now — one with a dirty editor can Save and one without cannot — so a
  // single entry per app would grey out the wrong menu about half the time.
  const toolRef = useRef<ToolWindowHandle>(null);
  const [appCommands, setAppCommands] = useState<Record<string, readonly string[]>>({});
  const onCommandsChange = useCallback((instanceId: string, commands: readonly string[]) => {
    setAppCommands((prev) =>
      sameSet(prev[instanceId], commands) ? prev : { ...prev, [instanceId]: commands },
    );
  }, []);

  const activeInstanceName = activeInstance?.title ?? "";

  /** File items that act on the surface in the focused pane. */
  const app: CommandHandlers = {
    run: (command) => {
      if (activeInstanceId) toolRef.current?.send(activeInstanceId, command);
    },
    blocked: (command) => {
      if (!activeInstanceId) return "No app is open in this pane.";
      if (appCommands[activeInstanceId]?.includes(command)) return undefined;
      // Generic on purpose. Why Save is unavailable is the *app's* knowledge —
      // nothing is dirty, no file is open — and a shell that guessed at it
      // would be inventing a reason it has no way to check.
      return `${activeInstanceName} cannot do this right now.`;
    },
  };

  const editTarget = useEditTarget();
  const edit = editHandlers(editTarget, app);

  /** Run a menu command only if the same check that greys the item out allows it. */
  const runIfAllowed = useCallback((handlers: CommandHandlers, command: string) => {
    if (handlers.blocked(command) === undefined) handlers.run(command);
  }, []);

  // A window's zoom, and whether it is full screen. Both are properties of the
  // OS window rather than of anything in React, so they are read back once on
  // mount rather than assumed — a window restored full screen would otherwise
  // have a menu item offering to enter a state it is already in.
  const [fullscreen, setFullscreenState] = useState(false);
  useEffect(() => {
    void isFullscreen()
      .then(setFullscreenState)
      .catch(() => {
        /* No window to ask. The menu item still toggles; it just starts by
           claiming the window is not full screen, which in a plain browser it
           is not. */
      });
  }, []);

  const onToggleFullscreen = useCallback(() => {
    setFullscreenState((was) => {
      const next = !was;
      // Optimistic, and rolled back if the window refuses — same shape as
      // `activeToolId` above, and for the same reason: a menu item that
      // repainted a round trip later would read as a click that missed.
      void setFullscreen(next).catch(() => setFullscreenState(was));
      return next;
    });
  }, []);

  const [zoom, setZoomState] = useState(1);
  const onZoom = useCallback((direction: 1 | -1) => {
    setZoomState((current) => {
      const next = nextZoom(current, direction);
      if (next === current) return current;
      void setZoom(next).catch(() => setZoomState(current));
      return next;
    });
  }, []);

  // The command palette. Per window, because the commands in it are this
  // window's — which cluster is active decides half of what is possible.
  //
  // Ctrl+Shift+P and View ▸ Command Palette used to expand the *search* field,
  // which was the nearest thing the shell had to one and was not one: search
  // looks inside the open project's files and can neither list nor run a
  // command. Both point here now, and Ctrl+K still opens search.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePage, setPalettePage] = useState<PalettePage>("commands");
  const openPalette = useCallback(() => {
    setPalettePage("commands");
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // The app list raised over the window, by the empty state's button and by
  // Ctrl+Shift+A: the command palette opened on its apps page, so both share
  // one panel and one scrim. The `+` on a pane's strip draws its own anchored
  // `AppPicker`.
  const openPicker = useCallback(() => {
    setPalettePage("apps");
    setPaletteOpen(true);
  }, []);

  /**
   * Opens `entry` as a **tab in `paneId`** — the picker, the strip's `+` and the
   * palette's "Open <App>" all come here. Unlike `onOpenSurface`, which splits
   * the focused pane for the Apps menu, these three are asked in the place the
   * app should land, and passing no split direction is what asks Rust to stack.
   */
  const onOpenInPane = useCallback(
    (entry: Openable, paneId: string | null) => {
      hideTakeover();
      const opened =
        entry.kind === "terminal"
          ? terminalControl.createInPane(label, paneId ?? undefined)
          : openInstance(label, entry.id, paneId ?? undefined);
      void opened
        .then(setOpenedInstance)
        .catch((err: unknown) => console.error("veistra: could not open that app:", err));
    },
    [label, hideTakeover],
  );

  // The New Cluster dialog (board 04). `onAddCluster` is the only opener —
  // see its own note on why a clusterless window skips this and falls back
  // to the old instant creation instead.
  const [newClusterOpen, setNewClusterOpen] = useState(false);
  // Which environment the dialog opens on; `undefined` is its own default.
  const [newClusterKind, setNewClusterKind] = useState<ClusterEnvironmentKind | undefined>();
  const closeNewCluster = useCallback(() => setNewClusterOpen(false), []);

  // The Switch Project dialog (board 08). The pill's own click, wherever it
  // lives, is the only opener — see `onOpenProjectSwitcher` below.
  const [switchProjectOpen, setSwitchProjectOpen] = useState(false);
  const closeSwitchProject = useCallback(() => setSwitchProjectOpen(false), []);

  // Set when the `+` had no project and opened Switch project first: once a
  // project lands, the New Cluster dialog follows. Cancelling, or handing off
  // to a native picker, drops it so a later project switch cannot pop a dialog
  // nobody asked for.
  const [newClusterAfterProject, setNewClusterAfterProject] = useState(false);
  const cancelSwitchProject = useCallback(() => {
    setNewClusterAfterProject(false);
    setSwitchProjectOpen(false);
  }, []);
  useEffect(() => {
    if (newClusterAfterProject && project && !switchProjectOpen) {
      setNewClusterAfterProject(false);
      setNewClusterOpen(true);
    }
  }, [newClusterAfterProject, project, switchProjectOpen]);

  // "The terminal is showing" is now just the band being open. It used to need
  // a second clause — the panel could be open on the worktree tab, which is an
  // open panel with no terminal in it — and the band has nothing else to show,
  // so the open state and the terminal being visible are the same fact.
  const terminalShowing = !bottomCollapsed;

  // Unlike the pull-up gesture, this one *does* spawn. "Show Terminal" has to
  // end with a terminal on screen, and a menu item that revealed an empty band
  // would be answering a different question than the one it asks.
  const onToggleTerminal = useCallback(() => {
    if (terminalShowing) {
      setBottomCollapsed(true);
      return;
    }
    if (sessions.length === 0) {
      // Opens the band itself, so there is nothing to set here.
      void onNewTerminal();
      return;
    }
    setBottomCollapsed(false);
  }, [terminalShowing, sessions.length, onNewTerminal, setBottomCollapsed]);

  // Home is where a project is opened, so File > Open… is Home's
  // `home/open-project` — the same native folder picker its own button raises,
  // rather than a second path to the same dialog.
  //
  // Scoped to this window's active cluster, and it has to be said explicitly
  // here where a frame's call says it by being a frame. This is a title-bar
  // menu item: there is no iframe behind it and so no instance for Rust to
  // resolve, but the window knows exactly which cluster it is showing. Without
  // the scope the picker would open a project into no cluster at all and be
  // refused — which is right, but a menu item that can only fail is not.
  const onOpenProject = useCallback(() => {
    if (activeClusterId === null) return;
    void callApp("home", "home/open-project", undefined, {
      clusterId: activeClusterId,
    }).catch((err: unknown) => console.error("veistra: File > Open… failed:", err));
  }, [activeClusterId]);

  // `MenuItem` has no submenu and faking one is out, so Open Recent shows the
  // surface that has the real list. It is `showHome` itself, not a second copy
  // of it — the chip is the primary route to Home and this menu item the
  // secondary one, but showing it is one rule either way. Not the toggle: a menu
  // item named Open Recent has to end with the list open, however it was left.
  const onOpenRecent = showHome;

  // Every arrangement this build ships or this machine has saved. Rust merges
  // the compiled-in built-ins with `presets.json` and broadcasts the answer, so
  // there is nothing to decide here and nothing that could go stale — a preset
  // saved in another window arrives on `presets:changed`.
  const presets = useLayoutPresets();

  const onApplyPreset = useCallback(
    (presetId: string) => {
      // Nothing to catch usefully: the two things that can fail are a preset
      // removed from the file since the menu was drawn and a window whose
      // clusters have all closed, and the second is what `blocked` below already
      // disables the row for. Reported rather than swallowed for the first —
      // a menu row that silently does nothing is the hardest failure here to see
      // from the outside.
      void applyPreset(label, presetId).catch((err: unknown) =>
        console.error("veistra: could not apply the preset:", err),
      );
    },
    [label],
  );

  // Deliberately *not* caught here. The refusals this can produce — a blank
  // name, a name one of the built-ins holds — are answers to what was just
  // typed, and the field that typed it is what shows them. See `MenuPrompt`.
  const onSavePreset = useCallback((name: string) => savePreset(label, name), [label]);

  // Everything this build can open here, from Rust rather than a literal list,
  // so a row added in `apps::openables` appears without a second edit here —
  // minus the takeover surfaces, filtered back out below. Each already has its
  // own door (the cluster chip for Home, Home's cards for Tutorials), and a
  // menu row doing the same "find it, or open one" job would be a second one
  // that could only ever agree with the first by luck. Rust's list is untouched.
  //
  // `openables` and not `apps`: a terminal is offered in this menu and is not an
  // app — it has no frontend to mount, so it is not in the list `ToolWindow`
  // resolves mountable URLs from. The two lists are deliberately separate; see
  // `bindings.ts`'s `Openable` for what merging them would break.
  //
  // One object, handed to both surfaces that offer this list — the title bar's
  // Apps menu and the switcher row's add-app button. They also share the
  // function that turns it into menu items (`appsMenu` in `TitleBar.tsx`), so
  // there is nothing about "what you can open" that either of them decides. The
  // presets branch rides along for the same reason: hanging it off this object
  // puts it in both surfaces at once, and `ClusterBar` — which forwards this
  // straight through to `AddAppButton` without looking inside it — needed no
  // change at all to gain either.
  const appsHandlers = useMemo(
    () => ({
      available: openables.filter((o) => !isTakeover(o.id)),
      open: onOpenSurface,
      // A surface opens into a pane, and a window with no clusters has none —
      // Rust refuses the open for exactly that reason. Said on the items rather
      // than left to fail, so the menu never offers something it cannot do.
      //
      // It covers the presets too, and it should: applying one rearranges the
      // active cluster and saving one captures it, so both are refused by the
      // same absence for the same reason. And the Terminal row, which lands in a
      // pane like everything else here — the *band's* `+` is a separate control
      // with its own reach, and is not governed by this.
      // A page in front reads the same way: its one pane is its app's.
      blocked:
        activePageId !== null
          ? "This opens into a cluster, and a page is not one. Pick a cluster in the bar first."
          : activeClusterId === null
            ? "This opens into a cluster, and this window has none. Make one with the + in the bar."
            : undefined,
      presets: {
        available: presets,
        apply: onApplyPreset,
        save: onSavePreset,
        // The cluster's own name, which is the name of the thing being
        // captured. Almost never the right name for the *arrangement* — but it
        // is a name, pre-selected, so taking it costs Enter and replacing it
        // costs typing, where an empty field costs typing either way.
        suggestedName: activeCluster?.name ?? "",
      },
    }),
    [
      openables,
      onOpenSurface,
      activePageId,
      activeClusterId,
      presets,
      onApplyPreset,
      onSavePreset,
      activeCluster?.name,
    ],
  );

  // The status bar and the source-control tab read one status. Two fetches
  // would be two chances to disagree about which branch is checked out, and the
  // whole point of the branch appearing in the status bar is that it is the
  // answer, not a second opinion. It also has to outlive the tab: the Git
  // page unmounts when it closes, and a status owned by the view would be
  // re-fetched on every reopening of it.
  // Keyed on the active *cluster*. This is the "where this goes next" the
  // previous note here promised, and it turned out to be load-bearing rather
  // than a refinement: keyed on the active app id, this handle could not
  // succeed. `activeAppId` is `null` for any focused terminal, and a non-null
  // one resolved through `git.rs`'s `repo()`, which searches
  // `StackSnapshot.tools` — a different id space from the shell's apps, and one
  // `discovery.rs`'s `ENABLED_TOOLS = &[]` leaves empty for every project. So
  // every call came back `UnknownTool` and both readers of this handle drew an
  // error where the branch and the change list should have been.
  //
  // `Cluster.worktree` is populated now, and `gitControl` resolves a cluster
  // through `project::cluster_path`, which follows the worktree when there is
  // one and the project when there is not. The same pair is the third argument,
  // so a repointed cluster re-asks.
  const git = useGitStatus(
    gitControl,
    activeClusterId,
    activeCluster?.worktree?.path ?? activeCluster?.project ?? null,
  );

  // Whether a newer Veistra exists. Per-window, but not a per-window *answer*:
  // the state is one value in Rust and arrives on `updater:changed`, so two
  // windows can never offer two different versions. What is genuinely local is
  // `asked` — a check started from this window's Help menu is this window's
  // question, and the other one has no reason to start narrating.
  const updates = useUpdates();

  // Which branch the graph should mark as *this* cluster's.
  //
  // It has to be resolved here rather than inside the panel, and not for
  // convenience: `WorktreeControl.list` returns every worktree of the
  // repository with nothing in it saying which one this cluster is working in.
  // That binding is `Cluster.worktree`, which lives in shell state and arrives
  // on `shell:state` — so the panel could only guess, and guessing wrong means
  // highlighting somebody else's branch as yours.
  //
  // Falling back to the status's branch covers the cluster working in its
  // project folder rather than a worktree: there is still a checked-out branch
  // to mark, it just is not one this cluster has to itself.
  const activeBranch = activeCluster?.worktree?.branch ?? git.status?.branch ?? null;

  // The two ways a batch of review notes leaves the source-control panel.
  //
  // Assembled here rather than reached for by the diff region, because half of
  // it is not a fact about a diff: which terminal is showing is `Cluster`'s,
  // which lives in shell state, and a region may not import another region's
  // source to go and find it (STANDARDS.md §1.2). `terminalTransport.write` is
  // the existing door onto a pty and nothing new was added beside it — an
  // agent reading its own review notes is the same bytes as a person typing
  // them.
  const reviewSend = useMemo<ReviewSend>(
    () => ({
      terminalId: activeCluster?.activeTerminal ?? null,
      toTerminal: (id, text) => terminalTransport.write(id, text),
      toClipboard: copyToClipboard,
    }),
    [activeCluster?.activeTerminal],
  );

  // --- the Run menu ---------------------------------------------------------
  //
  // It runs in the terminal the cluster is showing, and it does not open one
  // when there is none. Creating a pty and immediately writing into it was the
  // alternative, and it was rejected as unverifiable: whether ConPTY keeps
  // input written before its client has attached is not something this work
  // could establish without launching the app, and a Run that silently drops
  // the command on a cold terminal is worse than a Run that says it needs one.
  // `ReviewSend` above takes the same decision — no session, no action — and
  // this menu says so on the row rather than in a console line.
  const runTerminalId = activeCluster?.activeTerminal ?? null;

  const runBlocked =
    runTerminalId === null
      ? "This cluster has no terminal to run a command in. Open one with Ctrl+Shift+`."
      : undefined;

  // Per window rather than per cluster, and deliberately not persisted. It is
  // the "again" in Re-run — a fact about what you just did in front of this
  // window, with the same lifetime as the menu offering it. A last command
  // restored from disk into a session that has not run anything is a row
  // offering to repeat something nobody here did.
  const [lastCommand, setLastCommand] = useState<string | undefined>(undefined);

  const onRunCommand = useCallback(
    async (input: string) => {
      const line = commandLine(input);
      // A string, not an `Error`: `MenuPrompt.onSubmit`'s rejection is shown
      // under the field, and `PromptField` renders a bare string as the
      // sentence it is. Rust's `AppError` arrives the same way.
      if ("refused" in line) throw line.refused;
      if (runTerminalId === null) throw runBlocked;

      terminalTransport.write(runTerminalId, terminalInput(line.command));
      setLastCommand(line.command);

      // A command whose output is behind a shut band is a click that reads as
      // having missed — the same reasoning `onNewTerminal` gives for opening
      // it. Only for a band session: a terminal dragged into the pane tree is
      // already on screen, and revealing the band would show a different one.
      if (sessions.some((s) => s.id === runTerminalId)) setBottomCollapsed(false);
    },
    [runTerminalId, runBlocked, sessions, setBottomCollapsed],
  );

  const onInterrupt = useCallback(() => {
    if (runTerminalId !== null) terminalTransport.write(runTerminalId, INTERRUPT);
  }, [runTerminalId]);

  // `project` (what the title bar names, and what `onAddCluster` needs) is
  // read up near `activeClusterId` now — see the note there. It is the active
  // *cluster's* project rather than a process-wide one, which is what lets two
  // windows on two monitors say two different things.
  //
  // The title bar no longer reads `git.status` for its environment chip. That
  // was the branch of the checkout the stack manifest resolved, which was
  // never the cluster's worktree — it only looked like it while there was one
  // project in the process. `environmentOf` names it now (see `environment.ts`).
  // `useGitStatus` is still read here, by the status bar and the
  // source-control tab, which are asking their own question and not this one.

  // The pill's trailing chip (`environment`) and its idle-state count
  // (`environmentCount`), both derived through the one function every other
  // environment-aware surface in this rework uses — see `environment.ts`'s
  // header for why the derivation stays in one place. `environmentKey` is what
  // lets two clusters pointed at the same worktree count as one environment
  // rather than two.
  const environment = activeCluster ? environmentOf(activeCluster) : null;
  const environmentCount = useMemo(
    () => new Set(clusters.map((c) => environmentKey(environmentOf(c)))).size,
    [clusters],
  );
  const onOpenProjectSwitcher = useCallback(() => setSwitchProjectOpen(true), []);

  // The cluster's agent tab hears from the shell when a setting or its environment changes.
  const agentTab = useMemo(() => agentTabIn(tree, instances), [tree, instances]);
  useAgentTabRefresh(activeClusterId, environment ? environmentKey(environment) : null, agentTab);

  // The Agents page and its rail dot: the agent tabs in this window's
  // clusters, and what each session is doing, kept live whether or not the
  // page is open.
  const agentList = useMemo(
    () => agentClusters(orderedClusters, instances),
    [orderedClusters, instances],
  );
  const agentIds = useMemo(
    () => agentList.flatMap((cluster) => cluster.tabs.map((tab) => tab.id)),
    [agentList],
  );
  const agentSessions = useAgentSessions(agentIds);
  useEffect(
    () => publishAgentTabStates(new Map([...agentSessions].map(([id, s]) => [id, s.state]))),
    [agentSessions],
  );
  // Like choosing a tab from the cluster's strip: Home stops covering the
  // window, `activate_instance` brings the tab's own cluster forward, and the
  // pane holding the tab takes focus once that cluster is drawn.
  const openers = useMemo<AgentOpeners>(
    () => ({
      label,
      activeClusterId,
      activePaneId,
      hideTakeover,
      focusWhenShown: setOpenedInstance,
      activateInstance,
      setActiveCluster,
      openInstance,
      splitDirOnOpen,
      resume: openSavedSession,
      report: (message, err) => console.error(message, err),
    }),
    [label, activeClusterId, activePaneId, hideTakeover],
  );
  const onOpenAgent = useCallback(
    (instanceId: string) => void openAgent(openers, instanceId),
    [openers],
  );
  const onNewAgent = useCallback(
    (clusterId: string) => void newAgent(openers, clusterId),
    [openers],
  );
  // A previous session opens in the cluster on screen: in an agent tab there
  // that never sent a prompt, else in a new one.
  const onResumeAgent = useCallback(
    (sessionId: string) =>
      void resumeAgent(
        openers,
        sessionId,
        emptyAgentTab(
          agentList.find((cluster) => cluster.id === activeClusterId),
          agentSessions,
        ),
      ),
    [openers, agentList, activeClusterId, agentSessions],
  );

  // The agents under each cluster's row in the rail's list, from the same
  // tabs and live sessions the Agents page reads.
  const stripAgents = useMemo(
    () =>
      new Map(
        agentList.map((cluster) => [
          cluster.id,
          cluster.tabs.map((tab) => {
            const session = agentSessions.get(tab.id) ?? NO_SESSION;
            return {
              id: tab.id,
              label: agentName(tab.title) ?? session.prompt ?? (tab.title || "New session"),
              name: agentName(tab.title),
              state: session.state,
            };
          }),
        ]),
      ),
    [agentList, agentSessions],
  );

  // The right-click menu on an agent button, wherever it is drawn. Close, split
  // and move go through the same commands a tab's × and a drag do.
  const agentMenu = useMemo<AgentMenuActions>(() => {
    const scope = (id: string) =>
      agentScopeOf(orderedClusters, (tab) => instances.get(tab)?.appId, id);
    const closeAll = (ids: readonly string[]) => ids.forEach((id) => void closeInstance(id));
    return {
      scope,
      rename: (id, name) => renameAgentTab(id, name).then(() => undefined),
      close: (id) => void closeInstance(id),
      closeOthers: (id) => closeAll((scope(id)?.agentTabs ?? []).filter((tab) => tab !== id)),
      closeToRight: (id) => {
        const tabs = scope(id)?.agentTabs ?? [];
        closeAll(tabs.slice(tabs.indexOf(id) + 1));
      },
      closeAll: (id) => closeAll(scope(id)?.agentTabs ?? [id]),
      split: (id, dir, before) => {
        const pane = orderedClusters.map((c) => paneOfTab(c.tree, id)).find((p) => p !== null);
        if (pane) void splitPane(pane, dir, id, before);
      },
      moveToNewWindow: (id) => void detachInstance(id),
      openSettings: () => openSettingsOnTop("mcp"),
      feedback: () => openFeedback({ source: "agent-menu", feature: agentTabUsage.id }),
    };
  }, [orderedClusters, instances]);

  // The dialog's own "Open folder…"/"New project" buttons close it and hand
  // off to Home's pickers — the same two `home/*` methods the File menu and
  // Home's own cards already call, scoped to this window's active cluster
  // for `onOpenProject`'s reason. Both are no-ops with no cluster open,
  // which the dialog's disabled rows already assume.
  const onSwitchProjectOpenFolder = useCallback(() => {
    cancelSwitchProject();
    onOpenProject();
  }, [cancelSwitchProject, onOpenProject]);

  const onSwitchProjectNewProject = useCallback(() => {
    cancelSwitchProject();
    if (activeClusterId === null) return;
    void callApp("home", "home/new-project", undefined, { clusterId: activeClusterId }).catch(
      (err: unknown) => console.error("veistra: New Project failed:", err),
    );
  }, [cancelSwitchProject, activeClusterId]);

  // The status bar's git controls open the same Git page the rail does,
  // through the same door — `onSelectPage`, not a second path onto
  // `right_page`. `showGitView` says when to go through it, since it toggles,
  // and why a screen covering the page comes down first.
  const settingsOpen = useSettingsSurface().open;
  const libraryOpen = useLibrarySurface().open;
  const shortcutsOpen = useShortcutsSurface().open;
  const pageCovered = settingsOpen || libraryOpen || shortcutsOpen;
  const onShowGit = useCallback(
    (view: GitPageView | null) => {
      showGitView(view, rightPage?.id === "git", {
        uncover: closeCoveringScreens,
        open: () => onSelectPage("git"),
        close: onClosePage,
        setView: setGitView,
      });
    },
    [onSelectPage, onClosePage, rightPage?.id],
  );

  // "Review & merge" lands on the Source Control tab, which is where a review
  // happens, and never shuts the page.
  const onReviewAndMerge = useCallback(() => onShowGit("worktree"), [onShowGit]);

  // The drag layer is the only thing in the shell that spans regions, so it is
  // the only thing that has to be handed down rather than owned locally. The
  // regions never import it — they take a handle factory and stay ignorant of
  // what a drag is.
  //
  // It needs this window's label and active cluster because a drop names a
  // destination: a tab released over another window has to be moved *there*, and
  // a pane belongs to a cluster. `translateStripIndex` is the third thing it
  // cannot resolve on its own — see its own doc comment for why.
  const drag = useDrag(label, activeClusterId, translateStripIndex, clusters);

  /**
   * The one handle every surface drag is built from — a pane's own tab strip
   * and the switcher row both hand a member to this rather than each
   * assembling the payload again. `fromClusterId` is the active cluster: every
   * member this window can offer a handle for belongs to it, since the ones
   * drawn are always the shown cluster's own tree.
   */
  const surfaceDragHandle = useCallback(
    (member: ClusterMember) =>
      drag.tabHandle({
        what: "surface",
        instanceId: member.dragId,
        title: member.title,
        kind: member.kind,
        agentFinished: member.agentFinished,
        fromPaneId: member.paneId,
        fromClusterId: activeClusterId,
      }),
    [drag, activeClusterId],
  );

  // The other drag: files coming in from outside Veistra, which the operating
  // system is already carrying by the time we hear about it. Held here for the
  // same reason as the one above — two regions draw the answer, the band and
  // the one emulator under the cursor, and neither may import the drag layer to
  // ask on its own behalf. It takes nothing, because unlike a tab drag there is
  // no destination to resolve: a path means the same thing in every window.
  // The hook commits the drop itself; what comes back is only what to draw.
  const fileDrag = useFileDrag();
  // Which frame drag is current, so an item lookup that finishes after the
  // frame has already let go does not start a ghost nobody is holding.
  const frameDragSeq = useRef(0);

  // The Copilot key maps onto callbacks this file already owns; nothing new is
  // dispatched. "Search" expands the same field Ctrl+K does, and "Git" is the
  // rail's own toggle, which closes the page when it is already open.
  const copilotHandlers: CopilotHandlers = {
    palette: openPalette,
    search: () => setSearchExpanded(true),
    switchProject: onOpenProjectSwitcher,
    newCluster: () => onAddCluster(),
    toggleGit: () => onSelectPage("git"),
    toggleTerminal: onToggleTerminal,
  };
  const copilotKey = () => dispatchCopilotKey(copilotAction, copilotHandlers);

  // The other route to the same action: the global hook in Rust swallows the
  // key before Windows or the webview sees it, and tells this window instead.
  // A ref so the listener installs once and still runs the latest closure.
  const copilotKeyRef = useRef(copilotKey);
  copilotKeyRef.current = copilotKey;
  useEffect(() => {
    const off = onCopilotKey(() => void copilotKeyRef.current());
    return () => {
      void off.then((stop) => stop());
    };
  }, []);

  useKeyboard({
    copilotKey,
    // Ctrl+1…Ctrl+9 now select a *cluster* rather than a tool. There is no
    // longer one list of surfaces to index into — a window holds several panes,
    // each with its own tabs — and the thing a number key can still name
    // unambiguously is which cluster you are looking at.
    // Deliberately not `onSelectCluster`: that opens Home when handed the
    // cluster already active, and a number key is navigation rather than a
    // gesture aimed at a chip. Ctrl+3 means "be in cluster 3", so pressing it
    // while already there should do nothing — not pull the view off whatever is
    // on screen onto Home, which is easy to trigger by repeat and hard to undo.
    selectToolByIndex: (index) => {
      const cluster = orderedClusters[index];
      if (cluster && cluster.id !== activeClusterId) {
        hideTakeover();
        void setActiveCluster(label, cluster.id);
      }
    },
    // Ctrl+Tab and Ctrl+Shift+Tab walk the same order, wrapping. Like the number
    // keys this is navigation, not the chip's gesture, so it never toggles Home;
    // it does take a takeover down on the way out, for the reason `onSelectCluster` gives.
    cycleCluster: (step) => {
      const target = cycleTarget(orderedClusters, activeClusterId, step);
      if (target !== null) {
        hideTakeover();
        void setActiveCluster(label, target);
      }
    },
    rescan: onRescan,
    // Ctrl+. is drawn under the boot spinner, but nothing can act on it yet:
    // booting a tool is the iframe loading and running its own handshake, and
    // there is no cancel path through that. Wired as a deliberate no-op rather
    // than left unbound, so the day a cancel exists this is where it goes and
    // the accelerator does not have to be rediscovered.
    cancelBoot: () => {},

    // Every menu accelerator, routed through the same `blocked()` the menu item
    // reads. That is what makes Ctrl+S with nothing dirty do exactly what
    // clicking a greyed-out Save does — nothing — rather than posting a command
    // the app has said it cannot carry out.
    newFile: () => runIfAllowed(app, APP_COMMAND.newFile),
    newCluster: () => onAddCluster(),
    openProject: onOpenProject,
    save: () => runIfAllowed(app, APP_COMMAND.save),
    saveAs: () => runIfAllowed(app, APP_COMMAND.saveAs),
    duplicate: () => runIfAllowed(app, APP_COMMAND.duplicate),
    closeWindow: onCloseWindow,

    commandPalette: openPalette,
    openApp: openPicker,
    switchProject: onOpenProjectSwitcher,
    toggleClusters: onToggleClusters,
    toggleTerminal: onToggleTerminal,
    toggleFullscreen: onToggleFullscreen,
    zoomIn: () => onZoom(1),
    zoomOut: () => onZoom(-1),
    openSettings: () => openSettingsOnTop(),

    newTerminal: () => void onNewTerminal(),
    splitTerminal: () => {
      if (focusedPaneId) void onSplit();
    },
  });

  // A scan in flight has nowhere to show yet — the health popover renders the
  // result, not the request. Kept in the signature so the day it gets a
  // spinner, the value is already here.
  void rescanning;

  // The menu tree, built once per render and read twice: the title bar draws
  // it, and the command palette is it, flattened. Not memoized, because it was
  // already rebuilt on every render when it lived inline in the JSX below —
  // that is what makes a row that has just become possible possible in the same
  // frame — and a `useMemo` here would need every handler above in its deps,
  // most of which are fresh closures anyway.
  const menus = defaultMenus({
    app,
    edit,
    apps: appsHandlers,
    file: {
      newWindow: onNewWindow,
      // Both disabled when this window has no cluster: a project opens *into*
      // one, and Home has to be shown *in* one. The items say so rather than
      // failing silently.
      openProject: activeClusterId === null ? undefined : onOpenProject,
      openRecent: activeClusterId === null ? undefined : onOpenRecent,
      closeWindow: onCloseWindow,
    },
    view: {
      commandPalette: openPalette,
      clustersShowing: !clustersCollapsed,
      toggleClusters: onToggleClusters,
      terminalShowing,
      toggleTerminal: onToggleTerminal,
      fullscreen,
      toggleFullscreen: onToggleFullscreen,
      zoomIn: () => onZoom(1),
      zoomOut: () => onZoom(-1),
      zoomInBlocked: zoomBlocked(zoom, 1),
      zoomOutBlocked: zoomBlocked(zoom, -1),
    },
    run: {
      run: onRunCommand,
      interrupt: onInterrupt,
      last: lastCommand,
      blocked: runBlocked,
    },
    terminal: {
      onNew: onNewTerminal,
      onSplit,
      onKill: onKillTerminal,
      onClear,
      enabled: Boolean(focusedPaneId),
    },
    help: { checkForUpdates: updates.check },
  });

  // What the strips' `+` and the palette's open-app rows offer: the Apps menu's
  // own list and blocked reason, so neither can disagree with the menu.
  const paneAppPicker = {
    apps: appsHandlers.available,
    blocked: appsHandlers.blocked,
    onOpen: (entry: Openable, paneId: string) => onOpenInPane(entry, paneId),
  };
  const paletteCommands = withOpenAppCommands(commandsFromMenus(menus), {
    apps: appsHandlers.available,
    open: (entry) => onOpenInPane(entry, activePaneId),
    blocked: appsHandlers.blocked,
    accelerator: "Ctrl+Shift+A",
  });

  // The open page's body, by id. Git, Hindsight and Agents are drawn by the shell
  // itself (`pages.rs`'s `app_id: None`). Git is the window's one source
  // control and GitHub sidebar: `GitPage` holds both as tabs, where a separate
  // secondary panel used to hold them beside this column. Plane, Cloud agents
  // and Cost each host an app instead (`app_id: Some(...)`) — hosting that
  // through a second `ToolWindow` mount is next, not yet done, so this says so
  // honestly rather than drawing an empty or a faked frame.
  const pageBody = rightPage ? (
    rightPage.id === "git" ? (
      <GitPage
        view={gitView}
        onSelectView={setGitView}
        worktreeView={
          <WorktreePanel
            clusterId={activeClusterId}
            worktreeControl={worktreeControl}
            gitControl={gitControl}
            reviewControl={reviewControl}
            reviewSend={reviewSend}
            git={git}
            activeBranch={activeBranch}
            readOnly={isReadOnly(environment)}
            root={activeCluster?.worktree?.path ?? activeCluster?.project ?? null}
          />
        }
        githubView={
          <GithubPanel
            clusterId={activeClusterId}
            // Mounted while the page is open, fetching only while its tab
            // is the one showing: a hidden tab has nothing on screen to read.
            active={gitView === "github"}
            githubControl={githubControl}
            authControl={githubAuthControl}
            // The same interface source control uses. Opening an item is
            // `create` with a name the backend put on it, and passing the
            // control down rather than wrapping it keeps that visible.
            worktreeControl={worktreeControl}
            // A new worktree repoints the cluster, which arrives on
            // `shell:state` on its own. What does not is the change list,
            // which is now a different checkout's — so ask again.
            onWorktreeCreated={git.refresh}
          />
        }
      />
    ) : rightPage.id === "hindsight" ? (
      <HindsightPage />
    ) : rightPage.id === "sessions" ? (
      <AgentsPage
        clusters={agentList}
        sessions={agentSessions}
        activeClusterId={activeClusterId}
        onOpen={onOpenAgent}
        onNew={onNewAgent}
        onResume={onResumeAgent}
        agentMenu={agentMenu}
      />
    ) : (
      <AppPage page={activePage} instanceId={rightPage.instanceId} onHost={setPageHost} />
    )
  ) : null;

  return (
    <MotionConfig transition={snap} reducedMotion="user">
      {/* Not a slot: it draws nothing until somebody right-clicks, and when it
          does it portals to `document.body` from wherever it is mounted. One
          per window, beside the frame rather than inside it, because the
          gesture it answers can land on any part of the window including the
          bits `Frame` does not own. */}
      <ContextMenuHost />
      {/* Beside the frame for the same reason and by the same route: it
          portals to `document.body`, it covers whatever is on screen rather
          than occupying a band, and `Frame` has no slot it belongs in. The
          commands are the menu tree above, flattened — one source of truth for
          the bar and the palette both. */}
      <CommandPalette
        open={paletteOpen}
        page={palettePage}
        commands={paletteCommands}
        apps={appsHandlers.available}
        blocked={appsHandlers.blocked}
        onPickApp={(entry) => onOpenInPane(entry, activePaneId)}
        onClose={closePalette}
      />

      {/* Beside the frame for the same reason as the two above. `project` is
          never null while this is open — `onAddCluster` only sets
          `newClusterOpen` when it already has one, and the after-project
          effect waits for one. */}
      {newClusterOpen && project && (
        <NewClusterDialog
          label={label}
          project={project}
          initialKind={newClusterKind}
          onCancel={closeNewCluster}
          onCreated={closeNewCluster}
        />
      )}
      {iconCluster && (
        <ClusterIconDialog
          cluster={iconCluster}
          onCancel={() => setIconClusterId(null)}
          onPick={(icon) => {
            void setClusterIcon(iconCluster.id, icon);
            setIconClusterId(null);
          }}
        />
      )}
      {unsavedClose && (
        <CloseUnsavedDialog
          name={unsavedClose.title}
          onKeep={() => setUnsavedClose(null)}
          onDiscard={() => {
            void closeInstance(unsavedClose.id);
            setUnsavedClose(null);
          }}
        />
      )}
      {switchProjectOpen && (
        <SwitchProjectDialog
          clusterId={activeClusterId}
          onCancel={cancelSwitchProject}
          onOpened={closeSwitchProject}
          onOpenFolder={onSwitchProjectOpenFolder}
          onNewProject={onSwitchProjectNewProject}
        />
      )}
      {/* Mounted only while open, so a window nobody has searched in never pays
          for the dialog, and closing it genuinely discards its results —
          reopening is a fresh search rather than a stale one. `AnimatePresence`
          holds the subtree for the exit animation and then unmounts it. */}
      <AnimatePresence>
        {searchExpanded && (
          <SearchOverlay
            session={search}
            root={searchRoot}
            clusterId={activeClusterId}
            onOpen={openSearchHit}
            onSubmit={onSubmitSearch}
            onClose={closeSearch}
          />
        )}
      </AnimatePresence>
      <Frame
        kind={kind}
        bottomHeight={bottomHeight}
        bottomCollapsed={bottomCollapsed}
        bottomMaximized={bottomMaximized}
        onBottomHeightChange={setBottomHeight}
        onBottomCollapsedChange={setBottomCollapsed}
        onBottomMaximizedChange={setBottomMaximized}
        projectPageWidth={rightPage?.width ?? PROJECT_PAGE_DEFAULT}
        onProjectPageWidthChange={onPageWidthChange}
        projectPageExpanded={rightPage?.mode === "expanded"}
        slots={{
          // The centred project pill, not a plain title — `docs/design/
          // VEISTRA-UX-SPEC.md` §1.2. What the window is *pointed at* rather
          // than which surface happens to be in front, same as the old
          // three-segment title this replaces; see `TitleBar.tsx`'s header.
          titleBar: (
            <TitleBar
              kind={kind}
              project={project?.name ?? null}
              projectIcon={projectIcon}
              environment={environment}
              environmentLabel={activeCluster?.name ?? null}
              environmentCount={environmentCount}
              switcher={{
                clusters: orderedClusters,
                activeClusterId,
                ahead: git.status?.ahead,
                behind: git.status?.behind,
                terminals: shell?.terminals ?? [],
                onSelect: onSelectCluster,
                onClose: onCloseCluster,
                onChangeIcon: onChangeClusterIcon,
                onNewCluster: () => onAddCluster(),
                onNewWorktreeCluster: () => onAddCluster("newLocalWorktree"),
                onSwitchProject: onOpenProjectSwitcher,
                // The chip's other job: pressing the open cluster covers the
                // window with Home, and pressing it again takes Home down.
                onHome: () => activeClusterId !== null && onSelectCluster(activeClusterId),
              }}
              menus={menus}
              actionsSlot={
                <>
                  <ToolHealthBadge healthOf={stackTools} onRescan={onRescan} />
                  <SearchSlot open={searchExpanded} onOpen={openSearch} />
                  <TitleBarActions
                    onUpgrade={() => void openUrl(UPGRADE_URL)}
                    onNewAgent={
                      activeClusterId === null ? undefined : () => onNewAgent(activeClusterId)
                    }
                    terminalOpen={terminalShowing}
                    onToggleTerminal={onToggleTerminal}
                    agentsOpen={rightPage?.id === "sessions"}
                    onToggleAgents={() => onSelectPage("sessions")}
                    clustersOpen={!clustersCollapsed}
                    onToggleClusters={onToggleClusters}
                    onOpenSettings={() => openSettingsOnTop()}
                  />
                </>
              }
            />
          ),
          banner:
            environment?.kind === "main" && project ? (
              <ReadOnlyBanner
                projectPath={project.path}
                onNewWorktreeCluster={() => onAddCluster("newLocalWorktree")}
              />
            ) : undefined,
          toolWindow: (
            <ToolWindow
              ref={toolRef}
              tree={tree}
              // Which cluster the tree belongs to. It filters the
              // `project:changed` relay into the app frames — a switch in
              // another cluster must not reach them — and `null` is what tells
              // the empty state that this window has no clusters at all rather
              // than one with nothing open in it.
              // The *shown* cluster, a page included — a page draws its tree
              // like any cluster, and `null` here would draw `NoClustersState`.
              clusterId={shownCluster?.id ?? null}
              // Whether that `null` means anything yet. `shell` is null until
              // the first `shell:state` lands, and until then this window's
              // cluster list is empty for a reason that has nothing to do with
              // how many clusters it has.
              clustersKnown={shell !== null}
              instances={instances}
              presentationOf={presentationOf}
              // The docked or expanded page's app, mounted into `AppPage`'s box.
              pageSurface={
                rightPage?.instanceId && activePage?.appId
                  ? { instanceId: rightPage.instanceId, host: pageHost }
                  : null
              }
              // Home over the top of everything, from the cluster chip. `null`
              // whenever it is not showing, which is most of the time.
              soloInstanceId={tutorialInstanceId ?? (homeShowing ? homeInstanceId : null)}
              focusedPaneId={activePaneId}
              onFocusPane={setActivePane}
              onResize={onResizePane}
              dropTarget={drag.target}
              onCommandsChange={onCommandsChange}
              onOpenAppPicker={openPicker}
              // A frame dragging paths out of itself. The tool window only
              // relays it — see its own prop for why an iframe's gesture has
              // to be announced rather than observed.
              onFramePathDrag={(drag) => {
                const seq = ++frameDragSeq.current;
                if (drag.phase !== "begin") return fileDrag.end();
                if (drag.items.length === 0) return fileDrag.begin([...drag.paths]);
                // Context items travel as ids and are resolved to files here, in
                // the frame's own environment, so a frame cannot name another
                // environment's items. A failure drags whatever paths it had.
                const start = (extra: string[]) => {
                  if (seq === frameDragSeq.current) fileDrag.begin([...drag.paths, ...extra]);
                };
                contextItemPaths(drag.instanceId, [...drag.items]).then(start, () => start([]));
              }}
              // The two regions the tool window draws but may not import. It
              // computes every argument; this is only the wiring, and it lives
              // here because `WindowRoot` is not a region and may see both.
              renderPanes={(paneProps) => (
                <PaneTree
                  {...paneProps}
                  members={members}
                  onSelectMember={onSelectMember}
                  onCloseMember={onCloseMember}
                  dragHandleFor={surfaceDragHandle}
                  maximizedPaneId={maximizedPaneId}
                  onToggleMaximizePane={onToggleMaximizePane}
                  appPicker={paneAppPicker}
                />
              )}
              renderTerminal={(instanceId) => (
                <PaneTerminal
                  id={instanceId}
                  transport={terminalTransport}
                  onTitle={(title) => terminalControl.setTitle(instanceId, title)}
                  fileDropActive={instanceId === fileDrag.targetId}
                />
              )}
            />
          ),
          bottomPanel: (
            <BottomPanel
              sessions={sessions}
              activeTabId={bandTabId}
              onSelectTab={onSelectBandTab}
              onNewTerminal={onNewTerminal}
              onSplitTerminal={() => void onSplit()}
              onRequestClose={requestCloseTab}
              // Two drags can light this band, and it draws one highlight for
              // both. A tab released here joins the band; files released here
              // land in whichever emulator is under the cursor, which is one of
              // this band's own sessions exactly when it is not a pane's. The
              // band is not being asked to tell the two apart — only to say
              // "releasing here does something", which is true either way.
              dropActive={
                drag.target?.kind === "panel" || sessions.some((s) => s.id === fileDrag.targetId)
              }
              pendingClose={pendingClose}
              onCancelClose={() => setPendingClose(null)}
              onConfirmClose={() => {
                if (pendingClose) onCloseTab(pendingClose.id);
                setPendingClose(null);
              }}
              zoneRef={bottomZone}
              // Every session's emulator, all mounted, one visible. Passed as a
              // slot because the band owns the geometry and has no business
              // knowing that a terminal is xterm rather than anything else.
              terminalView={
                <TerminalDeck
                  ref={deckRef}
                  sessions={sessions}
                  activeId={bandTabId}
                  focusedId={focusedPaneId || null}
                  onFocusPane={setFocusedPaneId}
                  transport={terminalTransport}
                  // The title itself doesn't come back through this
                  // callback — Rust is the owner of record (a terminal can
                  // be dragged into another window), so this only reports
                  // what xterm saw, and the name a tab actually renders
                  // comes back around through `shell:state` and `sessions`
                  // above.
                  onTitle={(id, title) => terminalControl.setTitle(id, title)}
                  fileDropTargetId={fileDrag.targetId}
                />
              }
              // The same handle a pane's tab gets. A terminal and an app surface
              // drag identically, which is what lets a band terminal be dropped
              // into the layout at all — the band is where it starts, not the
              // only place it can be. `fromPaneId: null` says it is coming
              // *from* the band rather than out of a pane.
              dragHandleFor={(session) =>
                drag.tabHandle({
                  what: "surface",
                  instanceId: session.id,
                  title: session.title,
                  kind: "terminal",
                  agentFinished: session.agentFinished,
                  fromPaneId: null,
                  fromClusterId: activeClusterId,
                })
              }
            />
          ),
          // The project-page rail and, when a page is open, its body — the
          // **rail** workstream's three slots (`docs/VEISTRA-UX-REWORK.md` §4).
          // Only Agents has a dot so far: a session that needs you, or one at
          // work. The others' colours come from live data (Plane asleep or
          // running, Cost's burn against budget) that nothing reads yet — a
          // TODO here rather than an invented colour.
          //
          // The cluster strip sits at the top of it, above the page icons —
          // the cluster tab bar's replacement, with the title bar's pill
          // dropdown as the full list.
          projectRail: (
            <>
              <ClusterStrip
                clusters={orderedClusters}
                activeClusterId={activeClusterId}
                terminals={shell?.terminals ?? []}
                collapsed={clustersCollapsed}
                onToggleCollapsed={onToggleClusters}
                agents={stripAgents}
                onOpenAgent={onOpenAgent}
                agentMenu={agentMenu}
                onSelect={onSelectCluster}
                onAdd={() => onAddCluster()}
                onClose={onCloseCluster}
                onRename={onRenameCluster}
                onChangeIcon={onChangeClusterIcon}
                // A cluster drags too, and it is the one thing here that is
                // not a tab: it can only be released on a *window*, so it
                // moves into whichever one it was let go over, or takes a new
                // one — the whole point, a cluster per monitor. Same handle
                // and same press threshold as a tab, so a press that never
                // moves still selects the badge.
                dragHandleForCluster={(cluster) =>
                  drag.tabHandle({ what: "cluster", clusterId: cluster.id, name: cluster.name })
                }
              />
              <Rail
                pages={pages}
                activePageId={rightPage?.id ?? null}
                dots={{ sessions: agentsDot(agentSessions) }}
                onSelect={onSelectPage}
              />
            </>
          ),
          // Both slots are the same component type on purpose: `Frame` draws
          // one surface and swaps which slot fills it, and a page's app iframe
          // is portalled into a host inside `pageBody`. Two types would make
          // React remount that host — and reload the iframe — on every
          // dock/expand toggle.
          projectPage: rightPage && (
            <PageShell
              ref={pageShellRef}
              mode="docked"
              pageId={rightPage.id}
              title={activePage?.name ?? rightPage.id}
              backLabel={activeCluster ? activeCluster.name : "Back"}
              onClose={onClosePage}
              // Agents is a sidebar, not a workspace: it has no expanded form.
              onExpand={rightPage.id === "sessions" ? undefined : onTogglePageMode}
            >
              {pageBody}
            </PageShell>
          ),
          projectPageExpanded: rightPage && (
            <PageShell
              ref={pageShellRef}
              mode="expanded"
              pageId={rightPage.id}
              title={activePage?.name ?? rightPage.id}
              backLabel={activeCluster ? activeCluster.name : "Back"}
              onClose={onClosePage}
            >
              {pageBody}
            </PageShell>
          ),
          // Both drag layers draw into the one overlay slot. Never both at
          // once in practice — a pointer carries one gesture — but composed
          // rather than chosen between, so neither has to know about the
          // other to be drawn.
          overlay: (
            <>
              {drag.overlay}
              {fileDrag.overlay}
            </>
          ),
          statusBar: (
            // The whole status, one object, rather than a branch picked out and
            // a line-change total fetched beside it. Now that `git` asks about
            // the cluster, `git.status.branch` *is* the cluster's branch — the
            // same string `activeBranch` resolves, because both follow the
            // worktree — so passing the handle whole removes a second reading
            // of a question already answered, and the totals cannot drift out
            // of step with the change lists they are totals of.
            <StatusBar
              project={project?.name ?? null}
              environment={environment}
              git={git.status}
              githubOk={!error}
              onReviewAndMerge={onReviewAndMerge}
              onShowGit={onShowGit}
              gitShowing={gitViewShowing(rightPage?.id, pageCovered, gitView)}
              update={updateNotice(updates.state, updates.asked, updates.install)}
            />
          ),
        }}
      />
    </MotionConfig>
  );
}

/**
 * Why Zoom In or Zoom Out cannot go any further, or `undefined`.
 *
 * Two reasons, and they are different kinds of thing: there is no webview to
 * scale at all (the shell drawn in a plain browser), or the ladder has run out
 * in that direction. The second is what keeps the item honest at the ends — clicking
 * Zoom In at 250% would otherwise look like a click that did nothing.
 */
function zoomBlocked(zoom: number, direction: 1 | -1): string | undefined {
  if (!isTauri()) {
    return "Zoom scales the desktop app's webview. There is no webview to scale in a browser.";
  }
  if (nextZoom(zoom, direction) !== zoom) return undefined;
  const at = `${Math.round(zoom * 100)}%`;
  return direction === 1
    ? `Already at the largest size (${at}).`
    : `Already at the smallest size (${at}).`;
}

/**
 * Whether a frame's declaration says the same thing it said last time.
 *
 * A frontend re-declares from an effect, so the same set arrives again on every
 * render that changed anything else. Without this, each one would be a new
 * object in `appCommands` and a re-render of the whole window — for a menu that
 * is closed, describing a state that has not moved.
 *
 * Order-insensitive, because the set is assembled from conditionals on the
 * other side and the order they fall in is not a change. `undefined` (nothing
 * declared yet) is only equal to an empty list, which is the same claim.
 */
function sameSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (a === undefined) return b.length === 0;
  if (a.length !== b.length) return false;
  const have = new Set(a);
  return b.every((entry) => have.has(entry));
}
