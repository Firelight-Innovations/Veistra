import { AGENT_TAB_APP } from "../state/agentTab";
import { createPortal } from "react-dom";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  DropTarget,
  PaneNode,
  PaneTreeProps,
  SurfaceInstance,
  ToolPresentation,
} from "../contract";
import { paneLeaves, paneOfTab, paneTabs } from "../contract";
import { activateInstance, openInstance, setInstanceTitle } from "../state/shellState";
import { clearsSubject, declaredSubject, getSubject, setSubject } from "../viewerSubjects";
import { resolveViewerTarget as planViewerTarget } from "../viewerTarget";
import { baseNameOf } from "../viewerTitle";
import { feedbackFromFrame, trackFromFrame, type FrameAnswer } from "../telemetry/appTrack";
import { shell } from "../telemetry/features";
// The wire types come from `@veistra/bridge`'s `protocol`/`errors` subpaths
// rather than its root entry. The root package does depend on `@veistra/bridge`
// now — the first-party apps under `apps/` import it, and they are built by
// this same Vite config — but the shell must not import the client that entry
// builds, which is the tool half of transport B and reaches for
// `window.parent` at module load. The two subpaths below are side-effect-free
// — a handful of types, two constants, and an error-code table — so they carry
// none of that risk.
import type {
  CommandMessage,
  EventMessage,
  HelloMessage,
  PublishedTopic,
  ReadyMessage,
  RequestMessage,
  ResponseMessage,
} from "@veistra/bridge/protocol";
import { relayPageEscape } from "./pageEscape";
import { relayChord } from "./relayChord";
import { agentTabFrames } from "./agentTabFrames";
import { createFrameSearch } from "./frameSearch";
import {
  OPENED_EVENT,
  SEARCH_EVENT,
  THEME_CHANGED_EVENT,
  TOPIC_EVENT_PREFIX,
} from "@veistra/bridge/protocol";
import { VeistraErrorCode } from "@veistra/bridge/errors";
import {
  AGENT_TAB_CHOSEN,
  AGENT_TAB_EVENT,
  AGENT_TAB_LOGIN,
  AGENT_TAB_MODELS,
  AGENT_TAB_RESTORED,
  appPainted,
  onAgentTabChosen,
  onAgentTabEvent,
  onAgentTabLogin,
  onAgentTabModels,
  onAgentTabRestored,
  onFilesChanged,
  onLaunchTarget,
  onProjectChanged,
  takeLaunchTarget,
} from "../../bindings";
import { instantOutCss, instantOutMs } from "../motion";
import { callApp } from "../state/apps";
import { windowLabel } from "../state/shellState";
import { currentTheme, onThemeChange, type ThemeChangedPayload } from "../themeBroadcast";
import ToolMount from "./ToolMount";
import { sameOrder, stableOrder } from "./stableOrder";
import EmptyState from "./EmptyState";
import NoClustersState from "./NoClustersState";
import {
  registerToolWindow,
  unregisterToolWindow,
  type OsFileDragMessage,
} from "../toolWindowRegistry";
import { sameWindowRect, windowRectOfPane, type WindowRect } from "./surfaceRect";
import "./toolwindow.css";

/**
 * The app a file opens in. Named here rather than passed in: the Explorer names
 * the same constant for the same reason, and a launch target is not a choice
 * the person clicking made.
 */
const VIEWER_APP = "viewer";

/** The app an operating-system file drop is handed to when it lands on one of its frames. */
const FILES_APP = "files";

/**
 * Apps whose native content Rust places directly onto the window rather than
 * drawing it in the iframe — so their instance needs its surface's true
 * window-space rect pushed down as `veistra/window-rect`, not just the
 * pane-relative geometry an iframe can already see for itself.
 *
 * `projects` (`plane_webview`) is the only one today. A second consumer is
 * the point to turn this into a declared capability on `ToolPresentation`
 * instead of growing a hardcoded list here.
 */
const NEEDS_WINDOW_RECT = new Set(["projects"]);

/**
 * The tool window — the container every docked tool mounts into, plus its boot
 * and empty states.
 *
 * Owns the shell half of transport B (docs/tool-protocol.md §3): every tool
 * iframe's `hello` lands here, and this is the only place that answers `ready`.
 * Centralising the listener (rather than one per `ToolMount`) is what makes the
 * security property possible — there is exactly one place that resolves a tool
 * id from `event.source`, and exactly one map of trusted sources to check it
 * against.
 *
 * Four directions of traffic, each argued where it is handled: a frame's
 * `request` messages and the `veistra/*` methods the shell answers itself, in
 * `onMessage`; a Tauri broadcast relayed inward, at the `project:changed`
 * effect; a menu command posted outward, at `ToolWindowHandle.send`; and the
 * sideways channel — `veistra/open` and `veistra/publish` — at `answerOpen` and
 * `answerPublish`. Only the Tauri broadcast travels through Rust; for the rest
 * both ends are already in this browser, and a round trip would buy nothing but
 * a chance for the two to disagree about which frame is which.
 */
export interface ToolWindowHandle {
  /**
   * Post a menu command — a title bar File/Edit/View item — to the frame showing
   * `instanceId`, as a transport-B `command` message. That and the Tauri event
   * relayed inward below are the only ways anything reaches a frame unprompted;
   * every other message here answers one the frame sent first.
   *
   * An *instance* id, not an app id, and that is the whole point of this
   * refactor arriving here. The old version scanned for the first frame whose
   * id matched and posted to that — which was correct only for as long as one
   * app could have one frame. With two Files open it would deliver Save to
   * whichever happened to be earlier in a `Map`, silently and about half the
   * time.
   *
   * Silent when that frame is not mounted, has not said hello, or never
   * declared the command. The menu is what stops the last of those from
   * happening — an item the active app has not declared is disabled — so
   * reaching here with an undeclared command means the two disagreed, and
   * dropping it is better than a frame acting on something it said it could not
   * do.
   */
  send(instanceId: string, command: string): void;
}

/**
 * One mounted frame, as this window knows it — never as the frame asserts it.
 *
 * Every field is the shell's own record, resolved from `event.source` against
 * the map that holds these. That is the security property: nothing a frame puts
 * in a payload can change which instance it is taken to be.
 */
interface MountedFrame {
  /** The *instance* id. Says where the code runs. */
  id: string;
  /** The *app* id. Says which code runs; `callApp` dispatches on it. */
  appId: string;
  isApp: boolean;
  /**
   * The origin to post replies at, or `null` before the frame has said hello —
   * until then there is no origin to aim at that would not be a guess.
   */
  origin: string | null;
  /**
   * What the frame last declared it can do. Empty until it says
   * `veistra/commands`, which is the honest starting point: a frame that has never
   * declared anything can do nothing the menu bar knows how to ask for.
   */
  commands: Set<string>;
}

const ToolWindow = forwardRef<
  ToolWindowHandle,
  {
    /** The active cluster's layout. Every surface's position comes from this. */
    tree: PaneNode;
    /**
     * Which cluster that layout belongs to, or `null` when this window is
     * showing none.
     *
     * Two jobs. It filters the `project:changed` relay below — a project switch
     * in another cluster must not reach the frames in this one. And `null` is
     * what tells the empty state which of the two it is: a window with no
     * clusters at all, rather than a cluster with nothing open in it.
     */
    clusterId: string | null;
    /**
     * Whether `clusterId` is an answer yet.
     *
     * `false` until the first `shell:state` lands, and the distinction is not
     * pedantic: a window that has not heard from the backend has an empty
     * cluster list for the same reason a window with nothing in it does, and
     * telling those apart is the difference between "no clusters in this
     * window" — a claim, and an alarming one on a window that has just opened —
     * and drawing nothing for the frame it takes to find out.
     */
    clustersKnown: boolean;
    /** Every live instance in this cluster, resolvable by id. */
    instances: Map<string, SurfaceInstance>;
    /** How to present the app an instance is an instance of. */
    presentationOf: (appId: string) => ToolPresentation | undefined;
    /**
     * One surface, drawn over the whole window instead of over its pane.
     *
     * What the cluster chip does with Home: every app is covered rather than
     * closed, and uncovering them is a state change here and nothing else —
     * no tab is moved, no pane is resized, and not one iframe is remounted, so
     * whatever each app had open is exactly where it was left.
     *
     * Covered rather than hidden, deliberately. A hidden frame stops being
     * given a rendering lifecycle and its tiles are dropped, so unhiding it
     * shows the bare canvas for a frame or two — see the `outgoing` comment
     * below. One drawn *over* the top costs nothing to lift.
     */
    soloInstanceId?: string | null;
    /**
     * The docked or expanded page's app, when it has one.
     *
     * Not in any pane's tree, so the surfaces list below never draws it.
     * `host` is the element `AppPage` drew for it, and the frame is portaled
     * there — through this component so it goes through the same handshake,
     * routing and theme relay as every other frame. `null` host means the
     * page body has not mounted yet.
     */
    pageSurface?: { instanceId: string; host: HTMLElement | null } | null;
    /** The pane a new surface lands in, drawn with the active-pane treatment. */
    focusedPaneId: string | null;
    onFocusPane: (paneId: string) => void;
    onResize: (splitId: string, sizes: number[]) => void;
    dropTarget?: DropTarget | null;
    /**
     * A frame's declared command set changed — it said `veistra/commands`, or it
     * went away and its declaration went with it. Keyed by *instance*, because
     * two instances of one app can have different things to offer: one Files
     * with a dirty editor can Save and one without cannot.
     */
    onCommandsChange?: (instanceId: string, commands: readonly string[]) => void;
    /** The empty state's "Open an app" button: raise the app picker. */
    onOpenAppPicker?: () => void;
    /**
     * A frame has begun, or ended, dragging file paths out of itself.
     *
     * Relayed rather than acted on. An iframe's pointer events never reach this
     * document, so a drag that starts in the Files tree is invisible out here
     * until the frame says so; from `begin` the drag layer tracks it on
     * `window`, which starts reporting the moment the cursor leaves the frame.
     * `end` is the frame's own release — the one release this document cannot
     * see, because letting go over the frame sends `pointerup` to the frame.
     *
     * Handed up as a prop rather than called directly, because the drag layer
     * is another region and §1.2 lets this one import nothing but `contract.ts`
     * — the same rule `renderPanes` answers below.
     */
    onFramePathDrag?: (drag: {
      phase: "begin" | "end";
      paths: readonly string[];
      /** Context item ids the frame is carrying, already put in the store. */
      items: readonly string[];
      /** The frame that is dragging, which decides whose store the ids are in. */
      instanceId: string;
    }) => void;
    /**
     * Draw the pane layout this window measured.
     *
     * A render prop rather than an import, because `panes` is another region and
     * §1.2 lets this one import nothing but `contract.ts`. Everything it takes is
     * computed here — `PaneTreeProps` is in the contract for exactly this reason
     * — and `WindowRoot`, which is not a region, supplies the component.
     */
    renderPanes: (props: PaneTreeProps) => ReactNode;
    /**
     * Draw the terminal emulator bound to `instanceId`'s pty.
     *
     * A render prop for the same reason as `renderPanes`, and it also takes the
     * transport with it: a terminal is bytes on a wire and this window has no
     * business holding either end. The element still sits in the same place in
     * the tree, so nothing about it remounts.
     */
    renderTerminal: (instanceId: string) => ReactNode;
  }
>(function ToolWindow(
  {
    tree,
    clusterId,
    clustersKnown,
    instances,
    presentationOf,
    soloInstanceId = null,
    pageSurface = null,
    focusedPaneId,
    onFocusPane,
    onResize,
    dropTarget,
    onCommandsChange,
    onOpenAppPicker,
    onFramePathDrag,
    renderPanes,
    renderTerminal,
  },
  ref,
) {
  // The only trusted map from a window to a mounted surface. Each `ToolMount`
  // registers its iframe's `contentWindow` here the moment it exists; the
  // listener below never trusts anything in a message's body for identity — a
  // tool cannot claim to be a different tool by lying in its payload. See
  // `MountedFrame` for what each field is and why it is carried rather than
  // looked up: a second lookup would be a second chance to disagree.
  const frames = useRef<Map<Window, MountedFrame>>(new Map());
  const [readyIds, setReadyIds] = useState<Set<string>>(() => new Set());

  // A stable mirror of `readyIds` for `sendEventWhenReady` below, which is
  // registered into a module-scoped map once and has to keep reading the
  // current answer rather than the one that was current when it was created.
  const readyIdsRef = useRef(readyIds);
  readyIdsRef.current = readyIds;

  // Where each pane's content sits, in this container's coordinates.
  //
  // Measured rather than used as a portal target, and that is a correctness
  // requirement rather than a style choice. `createPortal` remounts its
  // children when the container changes, so portalling a surface into whichever
  // pane currently owns it would reload the iframe on every split and every
  // drag — the Files app would lose its open file each time you rearranged
  // anything. So every surface stays a permanent sibling in one container that
  // never moves, and is *positioned* over its pane instead.
  //
  // This is `TerminalDeck`'s technique (see its doc comment on why a split must
  // not reparent a mounted `XTermView`), generalized from one row of equal
  // shares to arbitrary rectangles.
  const hosts = useRef<Map<string, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<Map<string, PaneRect>>(() => new Map());
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  // Re-measure every pane host against the container. Called on mount, on any
  // host arriving or leaving, and from a `ResizeObserver` — a divider drag and
  // an OS window resize both change these and neither goes through React.
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();

    // A container measuring zero means the window is hidden or occluded, and
    // every rect read in that state is stale. Keeping the last good geometry is
    // better than collapsing every surface to the top-left corner and then
    // having to put them back.
    if (base.width === 0 || base.height === 0) return;

    const next = new Map<string, PaneRect>();
    for (const [paneId, el] of hosts.current) {
      const r = el.getBoundingClientRect();
      next.set(paneId, {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      });
    }
    setRects((prev) => (sameRects(prev, next) ? prev : next));
  }, []);

  const onHostChange = useCallback(
    (paneId: string, el: HTMLDivElement | null) => {
      if (el) hosts.current.set(paneId, el);
      else hosts.current.delete(paneId);
      measure();
    },
    [measure],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const el of hosts.current.values()) observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [measure, tree]);

  /**
   * Which pane the user is actually working in, when the click that says so
   * happened inside an iframe.
   *
   * A pointerdown inside a frame never reaches this document, so a pane cannot
   * learn it was clicked. That used to be survivable: every pane drew a tab
   * strip, the strip is outside the frame, and clicking it focused the pane. The
   * strips are gone — every tab in the window is in the cluster bar now — so
   * without this, focus in a split could only be moved by clicking a tab, and
   * Save would go on meaning the other pane however long you had been typing in
   * this one.
   *
   * `blur` on the host window plus `document.activeElement` is the one signal a
   * parent document gets for this: when a frame takes focus, the element holding
   * it out here is the `<iframe>` itself. Alt-tabbing away fires the same event
   * with `body` active, which the type check below discards.
   */
  useEffect(() => {
    const onBlur = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLIFrameElement)) return;
      const instanceId = active.closest<HTMLElement>("[data-instance]")?.dataset.instance;
      if (!instanceId) return;
      const paneId = paneOfTab(tree, instanceId);
      if (paneId) onFocusPane(paneId);
    };

    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [tree, onFocusPane]);

  // Held in a ref for the same reason `useKeyboard` holds its actions in one:
  // the message listener below is installed once, and a prop that changes
  // identity every render would otherwise tear it down and re-add it — with a
  // window in between where a frame's `hello` would land on nothing.
  const report = useRef(onCommandsChange);
  report.current = onCommandsChange;

  // Held in a ref for the same reason, and it matters more here: this one is
  // read in the middle of a gesture, so a listener re-added mid-drag would drop
  // the frame's `end` and leave a ghost stuck to the cursor.
  const relayDrag = useRef(onFramePathDrag);
  relayDrag.current = onFramePathDrag;

  // The shell's resolved theme and accent, as `useAppearance` last computed
  // them (`src/shell/themeBroadcast.ts`) — read once for whatever frame is
  // already mounted when this component itself mounts, then kept current by
  // the subscription below. A ref because it is read from `answerHello`,
  // installed once inside the message-listener effect further down, which
  // must see the latest value rather than the one current when it subscribed.
  const lastTheme = useRef<ThemeChangedPayload | null>(currentTheme());

  // Every app frame in this window, told live. Apps only — a tool frame has
  // no use for `tokens.css`'s custom properties, and `frame.isApp` is the same
  // filter the `project:changed` relay below uses. Unlike that relay, this one
  // is not scoped to the active cluster: theme is a window-wide fact, not a
  // per-project one, so every app in every pane of every cluster this window
  // holds gets it, not only the ones currently on screen.
  useEffect(() => {
    return onThemeChange((payload) => {
      lastTheme.current = payload;
      for (const [win, frame] of frames.current) {
        if (!frame.isApp || frame.origin === null) continue;
        win.postMessage(
          { veistra: 1, kind: "event", event: THEME_CHANGED_EVENT, payload } satisfies EventMessage,
          frame.origin,
        );
      }
    });
  }, []);

  const registerFrame = useCallback(
    (instanceId: string, appId: string, isApp: boolean, win: Window) => {
      frames.current.set(win, {
        id: instanceId,
        appId,
        isApp,
        origin: null,
        commands: new Set(),
      });
    },
    [],
  );

  // Frames claiming the title bar's search field. Declared before
  // `deliverEvent` exists, so it posts through a ref that is filled in below.
  const deliverRef = useRef<(instanceId: string, event: string, payload: unknown) => void>(
    () => {},
  );
  const frameSearch = useRef(
    createFrameSearch((instanceId, payload) =>
      deliverRef.current(instanceId, SEARCH_EVENT, payload),
    ),
  );

  const unregisterFrame = useCallback((win: Window) => {
    const frame = frames.current.get(win);
    frames.current.delete(win);
    // A frame that has gone declares nothing. Said out loud rather than left
    // implicit, because the owner's copy of the set outlives this map — a menu
    // still offering Save for a surface that has unmounted would be offering to
    // post into a window that no longer exists.
    if (frame) report.current?.(frame.id, []);
    if (frame) frameSearch.current.release(frame.id);

    // And it publishes nothing. Retained topics are what a late-mounting frame
    // is told on handshake (see `topics` below), so a value left behind by a
    // surface that has closed would be replayed to the next one as though it
    // were current — an Explorer highlighting a row for a file no Viewer has
    // open, because the Viewer that had it open is gone.
    if (!frame) return;
    for (const [topic, held] of topics.current) {
      if (held.from === frame.id) topics.current.delete(topic);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      send(instanceId, command) {
        for (const [win, frame] of frames.current) {
          if (frame.id !== instanceId) continue;
          if (frame.origin === null || !frame.commands.has(command)) return;
          win.postMessage(
            { veistra: 1, kind: "command", command } satisfies CommandMessage,
            frame.origin,
          );
          return;
        }
      },
    }),
    [],
  );

  /**
   * Post a shell-authored event straight into one instance's frame, bypassing
   * the `project:changed` relay further down — that one only ever forwards a
   * Rust broadcast, filtered to the active cluster, where this is a shell-side
   * request aimed at one instance by id. `sendEventWhenReady` below is what
   * callers actually reach for; this is just the part of it that knows how to
   * post.
   */
  const deliverEvent = useCallback((instanceId: string, event: string, payload: unknown) => {
    for (const [win, frame] of frames.current) {
      if (frame.id !== instanceId || frame.origin === null) continue;
      win.postMessage(
        { veistra: 1, kind: "event", event, payload } satisfies EventMessage,
        frame.origin,
      );
      return;
    }
  }, []);

  deliverRef.current = deliverEvent;

  /**
   * Events waiting on a frame that has not said hello yet, keyed by instance —
   * at most one per instance, since a second request for the same frame
   * supersedes the first rather than queuing behind it.
   *
   * The gap this covers is real, not theoretical: `openInstance` (see
   * `state/shellState.ts`) resolves with an id the moment Rust has minted
   * one, well before `ToolMount` below has even mounted the iframe for it, let
   * alone completed its hello/ready handshake. A caller that posted
   * immediately would be posting to a frame whose `origin` is still `null` —
   * silently absorbed by `deliverEvent`'s own guard, and gone for good.
   *
   * Nothing ever prunes an entry whose instance closes before its frame
   * becomes ready — a small, bounded leak (one object per abandoned open)
   * rather than a cancellation path this has no signal to drive.
   */
  const pendingEvents = useRef<Map<string, { event: string; payload: unknown }>>(new Map());

  const sendEventWhenReady = useCallback(
    (instanceId: string, event: string, payload: unknown) => {
      if (readyIdsRef.current.has(instanceId)) {
        deliverEvent(instanceId, event, payload);
        return;
      }
      pendingEvents.current.set(instanceId, { event, payload });
    },
    [deliverEvent],
  );

  // Flush whatever was waiting the moment its frame joins `readyIds`.
  useEffect(() => {
    for (const [instanceId, msg] of pendingEvents.current) {
      if (!readyIds.has(instanceId)) continue;
      pendingEvents.current.delete(instanceId);
      deliverEvent(instanceId, msg.event, msg.payload);
    }
  }, [readyIds, deliverEvent]);

  // A File Viewer that has just come up is handed the file it was showing, if
  // the shell remembers one. This is what makes a restored layout show its
  // files again: the layout persists the instance, and `viewerSubjects` the path.
  // Once per instance; a viewer opened fresh already has its file queued above.
  const restoredViewers = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of readyIds) {
      if (restoredViewers.current.has(id)) continue;
      if (roster.current.get(id)?.appId !== VIEWER_APP) continue;
      restoredViewers.current.add(id);
      const subject = getSubject(id);
      if (subject) deliverEvent(id, OPENED_EVENT, { path: subject.path, preview: subject.preview });
    }
  }, [readyIds, deliverEvent]);

  // Push each `NEEDS_WINDOW_RECT` instance its surface's window-space rect,
  // whenever `rects` (or the tree owning it) changes. This is the only place
  // that reads the container's own `getBoundingClientRect()` — `measure()`
  // above throws its copy away once `rects` is built, since everything else
  // here only needs the pane-relative geometry.
  //
  // Sent regardless of whether this window's cluster is the one showing: a
  // page's own tool window always has exactly one active tab in its one pane
  // (`pages.rs`'s module doc), so there is no "not active" case to skip here.
  // Whether the *cluster* is the one on screen is a different question,
  // answered on the Rust side (`shell_state`) for `plane_webview::hide`/`show`
  // — this effect only ever reports geometry, never visibility.
  const lastWindowRect = useRef<Map<string, WindowRect>>(new Map());
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    if (origin.width === 0 || origin.height === 0) return;

    for (const instanceId of paneTabs(tree)) {
      const instance = instances.get(instanceId);
      if (!instance || !NEEDS_WINDOW_RECT.has(instance.appId)) continue;
      const paneId = paneOfTab(tree, instanceId);
      const rect = paneId ? rects.get(paneId) : undefined;
      if (!rect) continue;

      const next = windowRectOfPane(origin, rect);
      const prev = lastWindowRect.current.get(instanceId);
      if (prev && sameWindowRect(prev, next)) continue;
      lastWindowRect.current.set(instanceId, next);
      sendEventWhenReady(instanceId, "veistra/window-rect", { ...next, window: windowLabel() });
    }
  }, [rects, tree, instances, sendEventWhenReady]);

  // The page's own window rect, for a page app that needs one. Its box is not
  // a pane, so it is read off the host element and followed with a
  // ResizeObserver plus the window's resize (a docked page also moves when the
  // panes beside it do).
  const pageInstance = pageSurface ? instances.get(pageSurface.instanceId) : undefined;
  const pageHostEl = pageSurface?.host ?? null;
  const pageInstanceId = pageInstance?.id ?? null;
  const pageIdRef = useRef(pageInstanceId);
  pageIdRef.current = pageInstanceId;
  const pageNeedsRect = pageInstance ? NEEDS_WINDOW_RECT.has(pageInstance.appId) : false;
  useEffect(() => {
    if (!pageHostEl || !pageInstanceId || !pageNeedsRect) return;
    const send = () => {
      const r = pageHostEl.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const next = { x: r.left, y: r.top, width: r.width, height: r.height };
      const prev = lastWindowRect.current.get(pageInstanceId);
      if (prev && sameWindowRect(prev, next)) return;
      lastWindowRect.current.set(pageInstanceId, next);
      sendEventWhenReady(pageInstanceId, "veistra/window-rect", { ...next, window: windowLabel() });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(pageHostEl);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
      lastWindowRect.current.delete(pageInstanceId);
    };
  }, [pageHostEl, pageInstanceId, pageNeedsRect, sendEventWhenReady, readyIds]);

  /**
   * The last value published under each topic, and which instance published it.
   *
   * This is what makes `veistra/publish` *retained* rather than a bare relay, and
   * the retention is the point: a File Viewer publishes which file it is
   * showing once, when it changes. An Explorer opened a minute later would
   * otherwise have no way to learn that until the user clicked something else,
   * so the tree would sit with nothing highlighted while a file was plainly
   * open beside it. Replaying on handshake removes that window entirely, and it
   * removes the temptation to fix it by having every publisher re-announce on a
   * timer.
   *
   * Scoped to the cluster this window is showing, which is why it is cleared
   * below when that changes rather than keyed by cluster: `ToolWindow` mounts
   * surfaces for the active cluster's tree alone, so every frame in `frames` is
   * in that cluster by construction and a second cluster's topics could never
   * have a frame here to be delivered to.
   */
  const topics = useRef<Map<string, PublishedTopic>>(new Map());

  useEffect(() => {
    // A cluster's published facts do not travel to the next cluster. Keeping
    // them would mean a Viewer in cluster A deciding which row an Explorer in
    // cluster B highlights — the same class of leak the `project:changed`
    // filter further down exists to prevent, and just as silent.
    topics.current.clear();
  }, [clusterId]);

  // The layout and the instances in it, read by `veistra/open` to find a target.
  // Refs for the reason `report` above is one: the message listener is
  // installed once and must keep reading the current answer rather than the one
  // that was current when it was registered.
  const layout = useRef(tree);
  layout.current = tree;
  const roster = useRef(instances);
  roster.current = instances;

  /**
   * Which surface a `veistra/open` should be delivered to: an existing instance
   * of that app in this cluster, brought forward, or a new one.
   *
   * The same rule `onOpenRecent` in `WindowRoot.tsx` applies to Home, and the
   * same one `openHit.ts` applies to Files — bring the existing one forward
   * rather than accumulating a second surface for every open. Layout order
   * decides which, when a cluster has more than one; there is no
   * most-recently-focused record to prefer instead, and inventing one here
   * would make the answer depend on state nothing else in the shell keeps.
   *
   * A new instance lands as a tab in the active cluster's first pane rather
   * than splitting toward wherever the user was last looking, for the reason
   * `openHit.ts` gives: this call has no `activePaneId` to measure from.
   */
  const resolveOpenTarget = useCallback(async (appId: string): Promise<string> => {
    for (const id of paneTabs(layout.current)) {
      const instance = roster.current.get(id);
      if (instance && instance.kind !== "terminal" && instance.appId === appId) {
        void activateInstance(id);
        return id;
      }
    }
    return openInstance(windowLabel(), appId);
  }, []);

  /**
   * Which File Viewer shows `path`. One viewer is one file, so this is not
   * `resolveOpenTarget`'s "first instance of the app": `viewerTarget.ts` picks
   * the instance already showing the file, an empty one, or the cluster's peek,
   * and only otherwise opens a new viewer, in the pane that last had a viewer
   * focused and never beside the requester if another pane exists.
   *
   * The subject is recorded here, before the viewer has said anything, or two
   * quick opens of one file would both find no instance and open two.
   */
  const focusedPaneRef = useRef(focusedPaneId);
  focusedPaneRef.current = focusedPaneId;
  const lastViewerPane = useRef<string | null>(null);

  const resolveViewerTarget = useCallback(
    async (path: string, preview: boolean, sourceInstance?: string): Promise<string> => {
      const isViewer = (id: string) => {
        const instance = roster.current.get(id);
        return !!instance && instance.kind !== "terminal" && instance.appId === VIEWER_APP;
      };
      const viewerIds = paneTabs(layout.current).filter(isViewer);
      const panes = paneLeaves(layout.current).map((leaf) => {
        const rect = rectsRef.current.get(leaf.id);
        return { id: leaf.id, tabs: leaf.tabs, area: rect ? rect.width * rect.height : 0 };
      });
      const focused = panes.find((pane) => pane.id === focusedPaneRef.current);
      if (focused?.tabs.some(isViewer)) lastViewerPane.current = focused.id;
      const plan = planViewerTarget(
        {
          panes,
          viewerIds,
          subjectOf: getSubject,
          lastViewerPaneId: lastViewerPane.current,
          sourcePaneId: sourceInstance ? paneOfTab(layout.current, sourceInstance) : null,
        },
        path,
        preview,
      );
      let id: string;
      if (plan.kind === "new") {
        id = await openInstance(windowLabel(), VIEWER_APP, plan.paneId);
      } else {
        id = plan.id;
        void activateInstance(id);
      }
      const keep = plan.kind === "focus" ? getSubject(id) : undefined;
      setSubject(id, {
        path,
        // Asking again for a file that is already a settled tab does not make it a peek.
        preview: keep ? keep.preview && preview : preview,
        dirty: keep?.dirty ?? false,
      });
      void setInstanceTitle(id, baseNameOf(path));
      return id;
    },
    [],
  );

  /**
   * Explorer's "Open with Veistra", pointed at a file.
   *
   * Only the file case arrives here. A folder is already open as a project by
   * the time this runs — `launch::apply` does that in Rust, where
   * `project::open` lives — and a file is the half that needs the layout: find
   * or open a viewer, hand it the path. That is `resolveOpenTarget` plus
   * `sendEventWhenReady`, which is to say exactly what `answerOpen` does for a
   * `veistra/open` from the Explorer. The same route, reached from the launch
   * rather than from a frame.
   *
   * Both delivery paths are taken because the two launches differ. The first
   * has no listener when the target is resolved and Tauri does not replay, so
   * it is polled for; the second arrives while this window is up, and is an
   * event. `takeLaunchTarget` clears, so whichever fires first wins and the
   * file cannot open twice.
   */
  useEffect(() => {
    // The main window only. A launch opens one thing, and every window running
    // this component would otherwise race to open its own copy of it.
    if (windowLabel() !== "main") return;

    let live = true;
    let unlisten: (() => void) | undefined;

    const openPending = async () => {
      const target = await takeLaunchTarget();
      // Narrowed rather than assumed. Rust only ever parks a file, but this is
      // a wire boundary and the check costs nothing.
      if (!live || target === null || target.kind !== "file") return;
      const instanceId = await resolveViewerTarget(target.path, false);
      if (!live) return;
      // Queued if the viewer was just opened and has not finished its
      // handshake, which is the common case here — see `sendEventWhenReady`.
      sendEventWhenReady(instanceId, OPENED_EVENT, { path: target.path, preview: false });
    };

    // Same shape as the `onProjectChanged` subscription further down: the
    // listener is registered in the background because an effect's cleanup must
    // be returned synchronously, and `live` covers the gap.
    void (async () => {
      await openPending();
      const stop = await onLaunchTarget(() => {
        void openPending();
      });
      if (!live) return stop();
      unlisten = stop;
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, [resolveViewerTarget, sendEventWhenReady]);

  // Reachable from outside this component tree, by window label — see
  // `toolWindowRegistry.ts`'s header for why this exists instead of a prop.
  // The Files frame an OS drag is currently over, so it can be told when the drag leaves it.
  const osDragTarget = useRef<string | null>(null);
  const routeOsFileDrag = useCallback(
    (drag: OsFileDragMessage): boolean => {
      const previous = osDragTarget.current;
      let target: string | null = null;
      let origin = { left: 0, top: 0 };
      if (drag.phase !== "leave") {
        const wrapper = document
          .elementFromPoint(drag.x, drag.y)
          ?.closest<HTMLElement>("[data-instance]");
        const id = wrapper?.dataset.instance;
        if (wrapper && id && roster.current.get(id)?.appId === FILES_APP) {
          target = id;
          const rect = wrapper.getBoundingClientRect();
          origin = { left: rect.left, top: rect.top };
        }
      }
      if (previous !== null && previous !== target) {
        deliverEvent(previous, "files:os-drag", { phase: "leave" });
      }
      osDragTarget.current = drag.phase === "drop" ? null : target;
      if (target === null) return false;
      deliverEvent(
        target,
        "files:os-drag",
        drag.phase === "leave"
          ? drag
          : { ...drag, x: drag.x - origin.left, y: drag.y - origin.top },
      );
      return true;
    },
    [deliverEvent],
  );

  const bridge = useMemo(
    () => ({ sendEventWhenReady, routeOsFileDrag }),
    [sendEventWhenReady, routeOsFileDrag],
  );
  useEffect(() => {
    const label = windowLabel();
    registerToolWindow(label, bridge);
    return () => unregisterToolWindow(label);
  }, [bridge]);

  useEffect(() => {
    /**
     * Answer a frame's `hello`, and catch it up on what it missed.
     *
     * The shell answers; it never announces first (docs/tool-protocol.md §3 — a
     * message posted before the frame's listener exists is simply gone, with no
     * replay).
     *
     * The reply carries the *app* id for what the frame is. It also carries the
     * frame's own instance id in `session`, but only as a storage key: a cluster
     * switch unmounts the frame, and an app that wants its open document back
     * needs a name for "this copy" that survives the reload. Nothing the frame
     * sends is trusted to say it. Identity is still resolved from
     * `event.source` against `frames`, which is the security property.
     */
    function answerHello(source: Window, origin: string, frame: MountedFrame) {
      const reply: ReadyMessage = {
        veistra: 1,
        kind: "ready",
        toolId: frame.appId,
        protocol: 1,
        session: { projectPath: null, instanceId: frame.id },
      };
      source.postMessage(reply, origin);
      frame.origin = origin;

      // The shell's current theme and accent, for an app frame — before it has
      // any tab open, before it has published anything, and regardless of
      // whether a change has happened since this window opened. Without this,
      // an app that mounts after boot would draw in whatever `tokens.css`'s
      // own defaults are (Dark, Amber) until the next time the person actually
      // changes a setting. `null` only when no window in this process has run
      // `useAppearance` yet, which `App.tsx` does above everything else — so in
      // practice this is only ever unset for an instant during the very first
      // paint.
      if (frame.isApp && lastTheme.current) {
        source.postMessage(
          {
            veistra: 1,
            kind: "event",
            event: THEME_CHANGED_EVENT,
            payload: lastTheme.current,
          } satisfies EventMessage,
          origin,
        );
      }

      // Everything this frame's cluster-mates have already published, before it
      // says anything itself. A frame that mounts late is otherwise blind to
      // every fact that settled before it arrived — see `topics` above.
      //
      // Its own entries are skipped, which only matters for a frame that
      // reloaded: it published under this instance id before, and handing its
      // own claim back to it as news would be the shell telling an app something
      // the app is the authority on.
      for (const [topic, held] of topics.current) {
        if (held.from === frame.id) continue;
        source.postMessage(
          {
            veistra: 1,
            kind: "event",
            event: `${TOPIC_EVENT_PREFIX}${topic}`,
            payload: held,
          } satisfies EventMessage,
          origin,
        );
      }

      setReadyIds((prev) => (prev.has(frame.id) ? prev : new Set(prev).add(frame.id)));
    }

    /**
     * `veistra/open`: put something on screen in a cluster-mate, and tell it.
     *
     * Half of the sideways channel — one frame reaching another through this
     * component, without either of them learning the other exists. File Explorer
     * sends `veistra/open` naming the app kind `viewer`; the shell finds or opens
     * one in that cluster and delivers the payload as an `OPENED_EVENT`.
     *
     * Routed without being understood: an `appId` is matched against the layout,
     * no payload is inspected and no intent is enumerated, so adding a fifth
     * thing two apps want to say to each other is not an edit to this file. That
     * is the same discipline `veistra/commands` is built on, and what keeps the
     * shell from accumulating a table of every app's vocabulary.
     */
    function answerOpen(
      frameId: string,
      params: unknown,
      respond: (body: Omit<ResponseMessage, "veistra" | "kind">) => void,
      id: ResponseMessage["id"],
    ) {
      const target = openRequest(params);
      if (!target) {
        respond({
          id,
          error: {
            code: VeistraErrorCode.InvalidParams,
            message: "veistra/open needs an `appId` string",
          },
        });
        return;
      }
      // A file for the viewer is routed by path, not by app: see
      // `resolveViewerTarget`. The payload is still not interpreted beyond the
      // two fields that decide *which* viewer — the rest goes through as is.
      const file = viewerFileRequest(target.appId, target.payload);
      const resolved = file
        ? resolveViewerTarget(file.path, file.preview, frameId)
        : resolveOpenTarget(target.appId);
      void resolved
        .then((instanceId) => {
          // Queued if that frame has not finished its handshake, which is the
          // common case for the branch that just opened one — see
          // `sendEventWhenReady`.
          sendEventWhenReady(instanceId, OPENED_EVENT, target.payload);
          respond({ id, result: { instanceId } });
        })
        .catch((err: unknown) =>
          respond({
            id,
            error: { code: VeistraErrorCode.InternalError, message: String(err) },
          }),
        );
    }

    /**
     * `veistra/publish`: retain a fact for this cluster, and fan it out.
     *
     * The other half of the sideways channel. File Viewer publishes which file
     * it is showing; the shell retains that and relays it to its cluster-mates,
     * replaying it to any frame that mounts later. A `topic` is a `Map` key and
     * nothing more — routed without being understood, exactly as `answerOpen`
     * above is.
     */
    function answerPublish(
      params: unknown,
      respond: (body: Omit<ResponseMessage, "veistra" | "kind">) => void,
      id: ResponseMessage["id"],
      frame: MountedFrame,
    ) {
      const published = publishRequest(params);
      if (!published) {
        respond({
          id,
          error: {
            code: VeistraErrorCode.InvalidParams,
            message: "veistra/publish needs a `topic` string",
          },
        });
        return;
      }

      const held: PublishedTopic = { value: published.value, from: frame.id };
      topics.current.set(published.topic, held);
      respond({ id, result: null });

      // Every other frame in the cluster, publisher excluded. Excluded rather
      // than filtered on the receiving side because a publisher hearing its own
      // announcement back is the shape that produces loops: a subscriber that
      // republishes anything derived from what it hears would ping-pong with
      // itself, and no amount of care in one app prevents it from the other end.
      for (const [win, other] of frames.current) {
        if (other.id === frame.id || other.origin === null) continue;
        win.postMessage(
          {
            veistra: 1,
            kind: "event",
            event: `${TOPIC_EVENT_PREFIX}${published.topic}`,
            payload: held,
          } satisfies EventMessage,
          other.origin,
        );
      }
    }

    function onMessage(event: MessageEvent) {
      // Drop anything whose source isn't one of our mounted iframes — this
      // is also how the tool id is resolved, never from `event.data`.
      const source = event.source as Window | null;
      if (!source) return;
      const frame = frames.current.get(source);
      if (!frame) return;
      if (!isInboundMessage(event.data)) return;

      // `targetOrigin` is the incoming message's own origin, never "*" — for
      // every reply below, and for the same reason each time.
      const origin = event.origin;

      if (event.data.kind === "hello") {
        answerHello(source, origin, frame);
        // Counted here because every way an app reaches the screen ends in this
        // handshake. A tool is somebody else's code and is not reported on; see
        // `telemetry/appTrack.ts`.
        if (frame.isApp) shell.track("app_loaded", { app: frame.appId });
        return;
      }

      const { id, method, params } = event.data;
      const respond = (body: Omit<ResponseMessage, "veistra" | "kind">) =>
        source.postMessage(
          { veistra: 1, kind: "response", ...body } satisfies ResponseMessage,
          origin,
        );

      // `veistra/*` belongs to the host, exactly as `hello` above does — this one
      // is a frame saying it has drawn its first meaningful content, and it is
      // answered here rather than forwarded on to an app's Rust half. Not an
      // app's question to answer: the frame is claiming something about itself,
      // and only the shell can say *which* frame is claiming it.
      //
      // What the report is *for* is the splash window: boot holds it open until
      // every first-party app has said this, so that the window it hands off to
      // is finished rather than still filling in (see `src-tauri/src/boot.rs`).
      // Only an app's report travels on. A tool is a different repository's code
      // that boot is not waiting for — it still gets its answer, since a
      // frontend that asked and heard nothing back would sit through the
      // bridge's thirty-second timeout for it.
      // Reported by *app* id, not instance id, because boot's roster is one
      // entry per app — `apps::roster()` waits on Files, however many Files
      // there are. A second instance reporting is a duplicate that
      // `boot::await_apps` already ignores, which is the behaviour we want:
      // the splash lifts when each kind of app has drawn once.
      if (method === "veistra/painted") {
        respond({ id, result: null });
        if (frame.isApp) {
          void appPainted(frame.appId).catch((err: unknown) =>
            console.error(`veistra: could not report ${frame.appId} painted:`, err),
          );
        }
        return;
      }

      // A frame naming its own tab — "Files" becoming `client.ts`. Host
      // business, like the two above: which tab this is, is something only the
      // shell knows, and it knows it from `event.source` rather than from
      // anything the frame could assert about itself.
      // An app handing something already in the context store to the agent tab
      // beside it: the tab shows it as a chip on the next prompt.
      if (method === "veistra/attach-to-agent") {
        respond({ id, result: null });
        const { contextId, label } = (params ?? {}) as { contextId?: unknown; label?: unknown };
        if (typeof contextId !== "string") return;
        const payload = { contextId, label: typeof label === "string" ? label : contextId };
        for (const [win, other] of frames.current) {
          if (!other.isApp || other.appId !== AGENT_TAB_APP || other.origin === null) continue;
          win.postMessage(
            { veistra: 1, kind: "event", event: AGENT_TAB_ATTACH, payload } satisfies EventMessage,
            other.origin,
          );
        }
        return;
      }

      if (method === "veistra/title") {
        respond({ id, result: null });
        const title = declaredTitle(params);
        if (title) void setInstanceTitle(frame.id, title);
        // A File Viewer also says which file that title is, and whether it is
        // a peek or holds unsaved edits. See `viewerSubjects.ts`.
        const subject = frame.appId === VIEWER_APP ? declaredSubject(params) : null;
        if (frame.appId === VIEWER_APP && clearsSubject(params)) setSubject(frame.id, null);
        if (subject) {
          setSubject(frame.id, {
            path: subject.path,
            preview: subject.preview,
            dirty: subject.dirty,
          });
        }
        return;
      }

      // The other `veistra/*` the shell answers itself: a frame saying which menu
      // commands it can carry out right now. Host business, not an app's Rust
      // half's — the menu being greyed out is a fact about this window's title
      // bar, and the backend has no part in it.
      //
      // The shell does not know what any command *means*, and must not: it holds
      // a set of strings per frame, sends one when a menu item is chosen, and
      // greys out everything the active frame has not declared. That is what
      // keeps a list of one app's capabilities out of the shell, so the next app
      // to arrive does not break the menu.
      //
      // A tool may declare too. Its *requests* cannot be served (the broker is
      // not built), but a declaration asks nothing of a core: it is the frame
      // making a claim about itself, exactly as `veistra/painted` is, so it is
      // answered above the `isApp` refusal rather than below it.
      if (method === "veistra/commands") {
        frame.commands = new Set(declaredCommands(params));
        respond({ id, result: null });
        report.current?.(frame.id, [...frame.commands]);
        return;
      }

      // --- the sideways channel -------------------------------------------
      //
      // Both of these are host business in the same sense `veistra/commands` is,
      // and they sit above the `isApp` refusal for the same reason: neither
      // asks anything of a core. `veistra/open` is a question about the *layout*
      // — which surface of a given kind is in this cluster — and only the shell
      // can answer it. `veistra/publish` is a frame making a claim about itself
      // and asking that its neighbours hear it.
      //
      // A tool may use both, and that is deliberate rather than an oversight.
      // The promise `apps/README.md` and `apps/mod.rs` both make is that an app
      // can become a tool later, or a tool be absorbed, without its interface
      // code changing — a channel only first-party code could speak on would
      // break that on the day it mattered. What bounds it is that a frame can
      // only ever reach its own cluster, can only name a *kind* of app rather
      // than a surface, and hands over a payload the receiving app is free to
      // ignore. Per-tool permissions are a later pass; see the `[permissions]`
      // table in `docs/tool-protocol.md` §1, reserved and unenforced today.
      if (method === "veistra/open") {
        answerOpen(frame.id, params, respond, id);
        return;
      }

      // Escape typed inside a frame, forwarded by the bridge because the shell's
      // own key handler cannot hear it. Only the rail page's frame is honoured.
      if (method === "veistra/escape") {
        respond({ id, result: null });
        relayPageEscape(frame.id, pageIdRef.current, document);
        return;
      }

      // A shell chord typed inside a frame (Ctrl+Shift+P, Alt+1, ...), replayed
      // on the shell's document so the same handlers hear it as outside a frame.
      if (method === "veistra/key") {
        respond({ id, result: null });
        relayChord(params, document);
        return;
      }

      if (method === "veistra/publish") {
        answerPublish(params, respond, id, frame);
        return;
      }

      // Usage data, and the feedback dialog, asked for by a frame. Host
      // business: the shell owns consent and the feature registry, and decides
      // which feature an app may report for from `frame`, never from `params`.
      // Answered for a tool too, with a refusal, so it does not sit through the
      // bridge's timeout for an answer that was never coming.
      if (method === "veistra/track" || method === "veistra/feedback") {
        const answer: FrameAnswer =
          method === "veistra/track"
            ? trackFromFrame(frame.appId, frame.isApp, params)
            : feedbackFromFrame(frame.appId, frame.isApp);
        if (answer.ok) respond({ id, result: null });
        else {
          respond({
            id,
            error: {
              code: VeistraErrorCode.InvalidParams,
              message: `${method}: ${answer.message}`,
            },
          });
        }
        return;
      }

      // The title bar's search field. Recorded for any frame and shown only while
      // that frame is an active surface; see `frameSearch.ts`.
      if (method === "veistra/search-claim") {
        if (frameSearch.current.claim(frame.id, params)) respond({ id, result: null });
        else
          respond({
            id,
            error: {
              code: VeistraErrorCode.InvalidParams,
              message: "veistra/search-claim needs a non-empty `placeholder` string",
            },
          });
        return;
      }

      if (method === "veistra/search-release") {
        frameSearch.current.release(frame.id);
        respond({ id, result: null });
        return;
      }

      // A frame dragging file paths out of itself. Host business in the
      // strongest sense of the three above: the gesture *leaves* the frame, and
      // where it lands is a fact about this window's layout the frame cannot
      // see and must not be told. It hands over paths and says when its press
      // begins and ends; everything else is answered out here and never travels
      // back. Above the `isApp` refusal like the rest, and for the same reason:
      // nothing is asked of a core.
      if (method === "veistra/drag") {
        const drag = pathDragRequest(params);
        if (!drag) {
          respond({
            id,
            error: {
              code: VeistraErrorCode.InvalidParams,
              message: 'veistra/drag needs a `phase` of "begin" or "end"',
            },
          });
          return;
        }
        respond({ id, result: null });
        relayDrag.current?.({ ...drag, instanceId: frame.id });
        return;
      }

      // Both kinds of surface go down the same line from here — the change the
      // broker made. A plugin's call used to be refused at this exact point;
      // `apps::call` forks on the id now. `frame.isApp` still decides where the
      // *frontend* resolves from, not whether a call is answered at all.

      // Both ids, and they answer different questions. `frame.appId` says which
      // code runs: `apps::call` dispatches on the surface id, and there is one
      // entry for Files however many Files are open.
      // `frame.id` — the *instance* — says where it runs. That is the half this
      // used to be unable to send, and the half a per-cluster project needs:
      // Rust walks the pane trees to find which cluster holds the instance, and
      // answers `files/list` against that cluster's project. Without it, two
      // Files side by side in two clusters are indistinguishable in the backend
      // and both root at whichever project answered first.
      //
      // Nothing in the payload is trusted for this. `frame` came out of the map
      // above, keyed on `event.source`, so the instance id is the shell's own
      // record of which iframe this is — the same identity rule that decides
      // whether the message is listened to at all.
      void callApp(frame.appId, method, params, { instanceId: frame.id })
        .then((result) => respond({ id, result }))
        // Both hosts of `callApp` reject with a `{code, message}` envelope, so
        // the common path is to pass it straight through. Anything else that
        // reaches here is a failure of the relay rather than of the app —
        // reported as an internal error with whatever it said for itself,
        // since a call that resolved to neither a result nor an error object
        // is exactly the case a caller cannot otherwise distinguish from a
        // hang.
        .catch((err: unknown) =>
          respond({
            id,
            error: isErrorPayload(err)
              ? err
              : { code: VeistraErrorCode.InternalError, message: String(err) },
          }),
        );
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Which cluster this window is showing, for the relay below.
  //
  // A ref because the Tauri subscription is installed once and must stay
  // installed. Switching clusters is a frequent, cheap act; tearing down and
  // re-registering a backend listener on each one would leave a window — real,
  // if brief — where a project change lands on nothing and a Files never
  // redraws. Read at delivery time, which is the moment the answer matters.
  const showing = useRef(clusterId);
  showing.current = clusterId;

  // The third direction: Rust -> shell -> app frame, as a transport-B `event`
  // message. `project:changed` is the first to travel it; everything below is
  // generic about the payload — the shell relays, it does not interpret.
  //
  // Apps only. A tool frame is a separate repository's code whose core this
  // build cannot reach at all (see the `isApp` branch above, which answers its
  // requests with an error saying so). Telling it the project changed would be
  // handing it news it has no way to act on, on a channel whose whole value is
  // that everything arriving on it means something.
  //
  // **And only frames in the cluster the event names.** The event is broadcast
  // to every window in the process, and a project belongs to a cluster — so
  // relaying it unfiltered would tell every Files everywhere that "the project
  // changed", and each of them would re-root itself at a project it is not in.
  // That is the exact bug per-cluster projects exist to prevent, reintroduced
  // on the last hop. The check is against *this window's* active cluster and
  // that is sufficient rather than approximate: this component mounts surfaces
  // for the active cluster's tree only, so every frame in `frames` is in that
  // cluster by construction.
  useEffect(() => {
    // `onProjectChanged` is async and an effect's cleanup must be returned
    // synchronously, so the subscription is set up in the background and
    // `live` covers the gap — an unmount before Tauri registers the listener
    // must still end up with nothing listening.
    let live = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const stop = await onProjectChanged((payload) => {
        if (!live) return;
        // A change in a cluster this window is not showing has no frame here to
        // act on it, and telling one anyway would be telling it about somebody
        // else's project. A payload with no cluster on it is dropped for the
        // same reason: the event's whole contract is that it names one.
        if (changedCluster(payload) !== showing.current) return;
        for (const [win, frame] of frames.current) {
          if (!frame.isApp || frame.origin === null) continue;
          win.postMessage(
            {
              veistra: 1,
              kind: "event",
              event: "project:changed",
              payload,
            } satisfies EventMessage,
            frame.origin,
          );
        }
      });
      if (!live) return stop();
      unlisten = stop;
    })();

    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  // A project folder changed on disk (`file_watch`): tell every app frame in this window,
  // and let each Files compare the root to its own. Unlike `project:changed` there is no
  // cluster filter to apply here, because the payload names a folder and not a cluster;
  // a frame showing some other folder ignores it.
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const stop = await onFilesChanged((payload) => {
        if (!live) return;
        for (const [win, frame] of frames.current) {
          if (!frame.isApp || frame.origin === null) continue;
          win.postMessage(
            { veistra: 1, kind: "event", event: "files:changed", payload } satisfies EventMessage,
            frame.origin,
          );
        }
      });
      if (!live) return stop();
      unlisten = stop;
    })();
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  // An agent tab's session events, its choice of harness, and word that a harness's models
  // are in (`apps::agent_tab`), each to the one frame it names. Every other frame, an agent tab for another session included,
  // never sees them.
  useEffect(() => {
    let live = true;
    const unlisten: (() => void)[] = [];
    const relay = (event: string) => (payload: unknown) => {
      if (!live) return;
      for (const [win, origin] of agentTabFrames(frames.current, payload)) {
        win.postMessage(
          { veistra: 1, kind: "event", event, payload } satisfies EventMessage,
          origin,
        );
      }
    };
    void (async () => {
      const listeners = [
        [onAgentTabEvent, AGENT_TAB_EVENT],
        [onAgentTabChosen, AGENT_TAB_CHOSEN],
        [onAgentTabModels, AGENT_TAB_MODELS],
        [onAgentTabLogin, AGENT_TAB_LOGIN],
        [onAgentTabRestored, AGENT_TAB_RESTORED],
      ] as const;
      for (const [listen, event] of listeners) {
        const stop = await listen(relay(event));
        if (!live) return stop();
        unlisten.push(stop);
      }
    })();
    return () => {
      live = false;
      unlisten.forEach((stop) => stop());
    };
  }, []);

  // Which tab each pane is showing, so a surface can be hidden without being
  // unmounted. Derived from the tree every render rather than tracked, so there
  // is no second place it could disagree with what Rust says.
  const activeByPane = new Map(paneLeaves(tree).map((leaf) => [leaf.id, leaf.activeTab]));

  // The same answer flattened to a string, because the `Map` above is a new
  // object every render and the effect below must run when what it *says*
  // changes, not when it is rebuilt.
  const activeKey = [...activeByPane].map(([pane, tab]) => `${pane}:${tab ?? ""}`).join("|");

  // The surfaces whose search claims may show: the focused pane's visible tab,
  // a takeover, and the rail page. Said as a string for the same reason
  // `activeKey` is, and applied in an effect so a claim made earlier appears the
  // moment its pane is focused and goes the moment it is not.
  const searchActive = [
    soloInstanceId,
    pageInstanceId,
    focusedPaneId ? activeByPane.get(focusedPaneId) : null,
  ]
    .filter((id): id is string => typeof id === "string")
    .join("|");
  useEffect(() => {
    frameSearch.current.setActive(searchActive === "" ? [] : searchActive.split("|"));
  }, [searchActive]);
  useEffect(() => {
    const search = frameSearch.current;
    return () => search.setActive([]);
  }, []);

  /**
   * The surface each pane was showing a moment ago, kept over its replacement.
   *
   * This is the white flash on a tab switch. Hiding a surface with
   * `visibility: hidden` is what keeps its iframe mounted, and that part is not
   * negotiable — the alternative reloads the app and throws away its open file.
   * But a hidden frame is one the engine stops running a rendering lifecycle
   * for, and its rastered tiles are free to be dropped. Unhiding it therefore
   * does not put its content back: the frame has to be styled, laid out,
   * painted and rastered again first, and for the frame or two that takes, the
   * compositor has nothing to draw but the document's bare canvas — which, in
   * an iframe, is white unless the document says otherwise.
   *
   * Two fixes, covering different halves of it. The canvas is no longer white
   * (`apps/shared/app.css`, and the `<style>` in each app's `index.html` for the
   * window before that sheet has loaded), so the worst case is the shell's own
   * colour rather than a white slab. And the outgoing surface stays on screen
   * over the incoming one until that one has had time to draw, so in the
   * ordinary case there is nothing to see at all.
   */
  const [outgoing, setOutgoing] = useState<{ ids: ReadonlySet<string>; fading: boolean }>(() => ({
    ids: new Set<string>(),
    fading: false,
  }));

  // What each pane was showing last time this ran. A ref rather than state:
  // it is how the effect recognises a switch, and it must not itself cause a
  // render.
  const shownByPane = useRef<Map<string, string>>(new Map());

  // Noticing the switch. Nothing is scheduled here, and that split is what
  // makes this survive `StrictMode`: React runs every effect twice on mount and
  // again on every dependency change in development, and this one *mutates a
  // ref* — the second pass sees the record it just wrote, finds nothing has
  // changed, and does nothing. An effect that had also owned the timers would
  // have had them torn down by that second pass and never rebuilt, leaving the
  // outgoing surface parked on top of the window for good.
  //
  // `useLayoutEffect` rather than `useEffect`, and the whole fix depends on it.
  // A passive effect runs *after* the browser has painted, so the commit that
  // hides the outgoing surface and reveals the incoming one would get a frame
  // on screen before this ran — the exact gap this exists to cover, followed by
  // the outgoing surface flashing back in a frame later, which is worse than
  // the flash. A layout effect runs after the DOM is mutated and before paint,
  // and React flushes the state it sets synchronously, so the outgoing surface
  // is never hidden in a frame anyone sees.
  useLayoutEffect(() => {
    const leaving = new Set<string>();
    const livePanes = new Set<string>();

    for (const [paneId, active] of activeByPane) {
      livePanes.add(paneId);
      const before = shownByPane.current.get(paneId);
      if (active) shownByPane.current.set(paneId, active);
      else shownByPane.current.delete(paneId);
      if (before && active && before !== active) leaving.add(before);
    }
    // A pane that has gone takes its record with it, so a later pane reusing
    // the id cannot inherit a surface that was never in it.
    for (const paneId of [...shownByPane.current.keys()]) {
      if (!livePanes.has(paneId)) shownByPane.current.delete(paneId);
    }

    // A second switch while the first is still fading replaces the set rather
    // than adding to it, which is right: only the surface immediately behind
    // the incoming one can cover it, and the one before that is already out of
    // sight. `fading: false` restarts at full opacity, so the new outgoing
    // surface gets its two frames like any other.
    if (leaving.size > 0) setOutgoing({ ids: leaving, fading: false });
    // `activeKey` is `activeByPane` as a value; see its comment above.
  }, [activeKey]);

  // Running it. Two animation frames at full opacity — enough for the surface
  // underneath to have been rastered — then the fade, then hidden again.
  //
  // "Time to draw" is counted in animation frames, not milliseconds: two of them
  // is what it takes for a change committed now to have been rastered. Only the
  // fade that follows is a duration, taken from `instantOut`. `veistra/painted`
  // would be the exact signal to wait on instead, and it is not usable here —
  // `reportPainted` in `packages/bridge/src/index.ts` latches on first call, so
  // a frontend sends it once in its life. It answers "has this app booted",
  // which is what the splash window needs, and not "has this frame drawn since
  // you unhid it".
  //
  // Nothing here changes what is mounted. An outgoing surface is the same
  // element it always was, still holding the same iframe; the only thing that
  // moves is when it stops being visible.
  //
  // Keyed on the set itself rather than on the switch that produced it, so this
  // holds no state of its own and re-running it is free.
  useEffect(() => {
    if (outgoing.ids.size === 0) return;

    let second = 0;
    let done = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // The transition cannot be declared in the same commit that reveals the
        // incoming surface: the browser needs a frame with the outgoing one
        // opaque to transition *from*, and starting the fade there would race
        // the very gap this exists to cover.
        setOutgoing((prev) => (prev.fading ? prev : { ids: prev.ids, fading: true }));
        done = window.setTimeout(
          () => setOutgoing({ ids: new Set<string>(), fading: false }),
          instantOutMs,
        );
      });
    });

    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(done);
    };
  }, [outgoing.ids]);

  // Layout order decides where a surface is drawn, never where it sits among its siblings:
  // see `stableOrder` for why moving a keyed iframe's node reloads the app.
  const renderOrder = useRef<string[]>([]);
  const laidOut = paneTabs(tree);
  const ordered = stableOrder(renderOrder.current, laidOut);
  if (!sameOrder(ordered, renderOrder.current)) renderOrder.current = ordered;
  const tabs = renderOrder.current;
  const empty = tabs.length === 0;

  return (
    <div
      className="toolwindow"
      ref={containerRef}
      // The one number `.toolwindow__surface`'s fade needs, handed to CSS from
      // the motion scale rather than written into the stylesheet, so the shell
      // still has exactly one file that decides how long anything takes.
      style={{ "--surface-fade": instantOutCss } as CSSProperties}
    >
      {/* The layout. Draws the panes and the dividers, and reports where each
          pane's content area ended up — but holds no surfaces and, since the
          cluster bar took over every tab in the window, no tabs either. See the
          `rects` comment above for why the layout and the surfaces are
          deliberately separate trees.

          The wrapper exists for `soloInstanceId`, and only for it: the pane
          layer's dividers, focus ring and drop indicators all draw *above* a
          surface on purpose, so a surface covering the window would be crossed
          by lines belonging to panes nobody can see. `visibility` rather than
          `display`, so every pane keeps its box and the measuring above keeps
          answering — the geometry is still correct the instant it is uncovered. */}
      <div className="toolwindow__layout" data-hidden={soloInstanceId !== null || undefined}>
        {renderPanes({
          tree,
          focusedPaneId,
          onFocusPane,
          onResize,
          onHostChange,
          dropTarget,
        })}
      </div>

      {/* Every surface in the cluster, always mounted, positioned over the pane
          that owns it. Flat siblings of a container that never moves: this list
          is keyed by instance id and its order never changes with the layout,
          so no amount of splitting, resizing or dragging can make React think
          one of these unmounted. An iframe that remounts reloads the app inside
          it, and the whole point of a layout you can rearrange is that
          rearranging it costs you nothing. */}
      {tabs.map((instanceId) => {
        const instance = instances.get(instanceId);
        if (!instance) return null;

        // A terminal has no iframe and no frontend URL — it is an emulator bound
        // to a pty by id. It still belongs in this list rather than in the
        // panel's deck: once dragged into the layout it is a pane's content like
        // anything else, and mounting it here means it survives a split or a
        // move for exactly the same reason an app surface does.
        const isTerminal = instance.kind === "terminal";
        const presentation = isTerminal ? undefined : presentationOf(instance.appId);
        if (!isTerminal && !presentation) return null;

        const paneId = paneOfTab(tree, instanceId);
        const rect = paneId ? rects.get(paneId) : undefined;

        // The surface that has taken the window is drawn whether or not its own
        // pane is showing it — it is not being shown *in* that pane.
        const takeover = instanceId === soloInstanceId;
        const active = takeover || activeByPane.get(paneId ?? "") === instanceId;
        // Being active wins. An instance can be in the outgoing set and active
        // at once — a tab dragged out of one pane and into another leaves the
        // first while arriving in the second — and covering itself with itself
        // would leave a surface stuck behind a fade it can never finish.
        const leaving = !active && outgoing.ids.has(instanceId);

        return (
          <div
            key={instanceId}
            className="toolwindow__surface"
            // Read by `toolwindow.css`: on top and click-through while it
            // covers the incoming surface, then transparent. See the `outgoing`
            // comment above for why the two are separate attributes.
            data-outgoing={leaving || undefined}
            data-fading={(leaving && outgoing.fading) || undefined}
            // Read by `toolwindow.css` for the one thing this cannot say in a
            // style attribute: which layer it sits on. Above every other
            // surface, and above the pane layer's own decorations.
            data-solo={takeover || undefined}
            // Read back by the blur handler above, to resolve a focused iframe
            // to the pane holding it.
            data-instance={instanceId}
            // The other half of the same job, for a surface that is *not* a
            // frame. A terminal's emulator is in this document, so its clicks do
            // arrive — and arrive here rather than at the pane, since the
            // surfaces are positioned over the layout rather than inside it.
            onPointerDown={() => {
              if (paneId) onFocusPane(paneId);
            }}
            // Hidden rather than unmounted or `display: none`. `visibility`
            // keeps the element laid out, which matters for anything inside
            // measuring itself — the same reason `ToolMount` has always used
            // it. A pane with no rect yet is hidden too: it has nowhere to be
            // until the first measure lands, and drawing it at 0,0 first would
            // be a visible jump.
            //
            // A surface on its way out is visible as well, for the moment it
            // takes the one replacing it to draw. That is the whole of the
            // deferred hide; see the `outgoing` comment above.
            style={
              takeover
                ? { left: 0, top: 0, width: "100%", height: "100%", visibility: "visible" }
                : rect
                  ? {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                      visibility: active || leaving ? "visible" : "hidden",
                    }
                  : { visibility: "hidden" }
            }
          >
            {isTerminal ? (
              <div className="toolwindow__slot">{renderTerminal(instanceId)}</div>
            ) : (
              presentation && (
                <ToolMount
                  instanceId={instanceId}
                  tool={presentation}
                  title={instance.title}
                  ready={readyIds.has(instanceId)}
                  registerFrame={registerFrame}
                  unregisterFrame={unregisterFrame}
                />
              )
            )}
          </div>
        );
      })}

      {/* The page's app, drawn into the page body rather than over a pane. */}
      {pageSurface?.host &&
        pageInstance &&
        pageInstance.kind !== "terminal" &&
        presentationOf(pageInstance.appId) &&
        createPortal(
          <ToolMount
            instanceId={pageInstance.id}
            tool={presentationOf(pageInstance.appId)!}
            title={pageInstance.title}
            ready={readyIds.has(pageInstance.id)}
            registerFrame={registerFrame}
            unregisterFrame={unregisterFrame}
          />,
          pageSurface.host,
          pageInstance.id,
        )}

      {/* Two empty states, not one, because the way out of each is different:
          an empty cluster wants an app opened into it, an empty window has no
          cluster for an app to go into and wants one made. `clusterId` is what
          tells them apart — it is `null` only when this window holds none.

          Neither is drawn until the layout has actually arrived. Both are
          claims about what is here, and before the first `shell:state` there is
          nothing to base one on: every window looks empty at that point, so a
          window opened by a drag would flash "no clusters" on its way to
          showing the surface that was dropped into it. */}
      {empty &&
        clustersKnown &&
        (clusterId === null ? <NoClustersState /> : <EmptyState onOpenApp={onOpenAppPicker} />)}
    </div>
  );
});

/** A pane's content area, in the tool window's own coordinates. */
interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Whether two measurements are the same, so an unchanged one does not re-render
 * every surface in the window.
 *
 * A `ResizeObserver` fires for reasons that change nothing here — a scrollbar
 * appearing inside a pane, a font loading — and every one of those would
 * otherwise produce a new `Map`, a new state value, and a full re-render of the
 * whole cluster.
 */
function sameRects(a: Map<string, PaneRect>, b: Map<string, PaneRect>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, rect] of a) {
    const other = b.get(id);
    if (!other) return false;
    if (
      rect.left !== other.left ||
      rect.top !== other.top ||
      rect.width !== other.width ||
      rect.height !== other.height
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The `clusterId` off a `project:changed` payload, or `null` for anything that
 * is not one.
 *
 * Defensive because the payload is `unknown` at this boundary — it is relayed
 * without ever being typed. `null` from a malformed event means the relay drops
 * it, which is the safe direction: a frame told nothing redraws nothing, where
 * a frame told about the wrong cluster re-roots itself at the wrong project.
 */
function changedCluster(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { clusterId } = payload as { clusterId?: unknown };
  return typeof clusterId === "string" ? clusterId : null;
}

/** `{path, preview}` when this is a request to show a file in the viewer, else `null`. */
function viewerFileRequest(
  appId: string,
  payload: unknown,
): { path: string; preview: boolean } | null {
  if (appId !== VIEWER_APP || typeof payload !== "object" || payload === null) return null;
  const { path, preview } = payload as { path?: unknown; preview?: unknown };
  return typeof path === "string" && path !== "" ? { path, preview: preview === true } : null;
}

/** The event an app's `veistra/attach-to-agent` becomes, for the agent tab. */
const AGENT_TAB_ATTACH = "agent-tab:attach";

/**
 * The `title` off a `veistra/title` request, or `null` for anything that is not a
 * non-empty string.
 *
 * Validated for the same reason `declaredCommands` below is: this decides what
 * a tab says, and a frame that sent a number or an object should narrow to "no
 * title reported" rather than put a non-string where one is expected.
 */
function declaredTitle(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const { title } = params as { title?: unknown };
  return typeof title === "string" && title.trim() !== "" ? title : null;
}

export default ToolWindow;

/**
 * The `commands` array off a `veistra/commands` request, with anything that is
 * not a string dropped.
 *
 * Validated rather than trusted even though every app in this build is
 * first-party: a declaration decides which menu items become clickable, and a
 * malformed one must narrow the menu rather than put a non-string into a `Set`
 * that is later compared against command ids. Absent or wrong-shaped params
 * declare nothing, which disables everything — the safe direction.
 */
function declaredCommands(params: unknown): string[] {
  if (typeof params !== "object" || params === null) return [];
  const list = (params as { commands?: unknown }).commands;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The `appId` and `payload` off a `veistra/open` request, or `null` if there is
 * no usable app id.
 *
 * Only `appId` is validated. The payload is opaque by design — it is the app's
 * vocabulary, not the protocol's, and the shell checking its shape would mean
 * the shell knowing what an open *means* for each app it can route to. That is
 * exactly the coupling `veistra/commands` was designed to avoid, and it would
 * make every new intent an edit to this file.
 */
function openRequest(params: unknown): { appId: string; payload: unknown } | null {
  if (typeof params !== "object" || params === null) return null;
  const { appId, payload } = params as { appId?: unknown; payload?: unknown };
  if (typeof appId !== "string" || appId === "") return null;
  return { appId, payload };
}

/**
 * The `topic` and `value` off a `veistra/publish` request, or `null` for anything
 * without a usable topic.
 *
 * `value` is deliberately unchecked, including when it is `undefined` —
 * publishing "there is nothing" is a real thing to say, and the honest way for
 * a Viewer with no tab open to report its active path. Narrowing that to a
 * refusal would leave the last real value retained and make an empty editor
 * indistinguishable from one nobody had heard from.
 */
/**
 * The `phase` and `paths` off a `veistra/drag` request, or `null` for a phase
 * this shell does not know. `end` carries no paths and need not.
 *
 * Unlike `openRequest`'s payload, `paths` is validated down to dropping every
 * non-string entry. It is not the frame's own vocabulary here — these strings
 * end up in a shell's input, and "opaque, the receiver knows what it means"
 * cannot apply when the receiver is a running program. Rust's quoting is the
 * real guard; this is the cheap one before it.
 */
function pathDragRequest(
  params: unknown,
): { phase: "begin" | "end"; paths: string[]; items: string[] } | null {
  if (typeof params !== "object" || params === null) return null;
  const { phase, paths, items } = params as { phase?: unknown; paths?: unknown; items?: unknown };
  if (phase !== "begin" && phase !== "end") return null;
  const strings = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter((p): p is string => typeof p === "string");
  return { phase, paths: strings(paths), items: strings(items) };
}

function publishRequest(params: unknown): { topic: string; value: unknown } | null {
  if (typeof params !== "object" || params === null) return null;
  const { topic, value } = params as { topic?: unknown; value?: unknown };
  if (typeof topic !== "string" || topic === "") return null;
  return { topic, value };
}

/**
 * `isVeistraMessage` in the bridge package is typed for the frontend's inbound
 * direction (`ReadyMessage | ResponseMessage | EventMessage`) — we are the
 * shell, receiving the other direction, so reusing it would narrow to the
 * wrong union. The runtime check is the same two fields either way; this just
 * types it correctly for what we actually receive, and rejects any third
 * `kind` a frame might invent.
 */
function isInboundMessage(data: unknown): data is HelloMessage | RequestMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as { veistra?: unknown; kind?: unknown; id?: unknown; method?: unknown };
  if (message.veistra !== 1) return false;
  if (message.kind === "hello") return true;
  // A request without a numeric id could never be answered — there would be
  // nothing to echo back — and one without a method names nothing to call.
  return (
    message.kind === "request" &&
    typeof message.id === "number" &&
    typeof message.method === "string"
  );
}

/** A rejection that already carries a JSON-RPC error object. */
function isErrorPayload(err: unknown): err is NonNullable<ResponseMessage["error"]> {
  if (typeof err !== "object" || err === null) return false;
  const payload = err as { code?: unknown; message?: unknown };
  return typeof payload.code === "number" && typeof payload.message === "string";
}
