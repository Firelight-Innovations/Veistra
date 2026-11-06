/**
 * File Explorer — the tree, and the questions it has to ask before it changes
 * anything on disk. This file is the join: it owns where the tree is rooted and
 * the one confirmation bar the app may show, and nothing else. The tree itself
 * is `explorer/`; what a row looks like is `explorer/TreeRow.tsx`.
 *
 * This app no longer shows a file. Clicking a row asks the shell for a File
 * Viewer *in this cluster* and hands it a path (`openIn`,
 * `docs/tool-protocol.md` §3). The Explorer does not know whether a Viewer
 * exists, does not know its instance id, and cannot address one; the shell
 * finds or opens it — which is what makes the tree and the editor two surfaces
 * you can put in two panes, or on two monitors. Three things that used to be
 * answerable by reading another region's state are now facts the Viewer
 * volunteers, each documented at its subscription below.
 *
 * The splitter is gone with the editor: a pane is the shell's to divide now,
 * and it already did that better than the old one, which could only ever put
 * the tree left of the file, in one window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { on, openIn, publish, reportPainted, subscribe } from "@veistra/bridge";
import Explorer, { type ExplorerHandle } from "./explorer/Explorer";
import NoticeBar, { type Notice } from "./NoticeBar";
import { useOsDrop } from "./explorer/useOsDrop";
import { useMenuCommands } from "./commands";
import { useDelete } from "./useDelete";
import {
  ACTIVE_PATH,
  DIRTY_PATHS,
  TREE_CHANGE,
  asActivePath,
  asDirtyPaths,
  isAtOrUnder,
  type TreeChange,
} from "./topics";
import { describe, getRoot, watchRoot, type Root } from "./rpc";
import { engineOpen } from "./engineOpen";

/** The app id this app opens files into. A *kind*, never a surface — see
 *  `openIn`. Written down here rather than inlined because it is the one string
 *  in this app that names another app, and a typo in it is a click that
 *  silently does nothing. */
const VIEWER_APP = "viewer";

export default function App() {
  const [root, setRoot] = useState<Root | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Bumped whenever the tree's contents may have changed underneath us: the
   * project was switched, a refresh was asked for, or a Viewer reported a change
   * of its own. The explorer treats a change as "drop the cache and re-list",
   * which is the whole of the live reload — there is no filesystem watcher.
   */
  const [treeNonce, setTreeNonce] = useState(0);
  const reloadTree = useCallback(() => setTreeNonce((n) => n + 1), []);

  const loadRoot = useCallback(() => {
    void getRoot()
      .then((next) => {
        setRoot(next);
        setError(null);
      })
      .catch((err: unknown) => setError(describe("files/root", err)));
  }, []);

  useEffect(loadRoot, [loadRoot]);

  /**
   * The splash window waits for this pane before the main window is shown.
   *
   * "First meaningful frame" is *the tree having rows*, not the layout having
   * appeared, so the explorer reports it rather than this effect: `files/root`
   * coming back leaves an empty tree, and a window revealed then would still
   * visibly fill in. The one case the explorer cannot report is the root call
   * failing, since it never gets a root to list — that is this effect, and it
   * counts, because an error is a finished screen too.
   */
  useEffect(() => {
    if (error !== null) reportPainted();
  }, [error]);

  /** The project changed under us — a different folder is open. "The project"
   *  means **this surface's cluster's**: the shell relays this event only into
   *  frames in the cluster it names, so a switch in the Explorer on the next
   *  monitor does not reach here. */
  useEffect(
    () =>
      on("project:changed", () => {
        loadRoot();
        reloadTree();
      }),
    [loadRoot, reloadTree],
  );

  /**
   * Files created, dropped or deleted from outside (a terminal, the OS, an agent). The
   * backend watches the project folder once this app asks, debounces, and the shell relays
   * `files:changed` here. Re-listing also refreshes the git badges, which ride the same
   * reload. A change under some other root (another cluster's project) is not ours.
   * The ask is repeated whenever the root changes; it is idempotent on the backend.
   */
  const rootPath = root?.path ?? null;
  useEffect(() => {
    if (rootPath !== null) void watchRoot().catch(noop);
  }, [rootPath]);
  useEffect(
    () =>
      on("files:changed", (payload) => {
        const changed = (payload as { root?: unknown } | null)?.root;
        if (typeof changed !== "string" || rootPath === null) return;
        if (samePath(changed, rootPath)) reloadTree();
      }),
    [rootPath, reloadTree],
  );

  /**
   * Which file the Viewer is showing, for the row treatment.
   *
   * Retained by the shell and replayed on handshake, so an Explorer opened
   * after a Viewer is not briefly wrong about this — see `veistra/publish`.
   *
   * With two Viewers in one cluster this takes the most recent announcement
   * rather than arbitrating between them — the honest answer to a question with
   * no single one: `publish` only fires on a change, so the last to speak is
   * the last to change, the closest thing to "the editor you were just in"
   * either app can see. Briefly arbitrary on mount, when replay delivers
   * several at once, and self-correcting on the next click.
   */
  const [openPath, setOpenPath] = useState<string | null>(null);
  useEffect(() => subscribe(ACTIVE_PATH, (value) => setOpenPath(asActivePath(value))), []);

  /**
   * What every Viewer in this cluster is holding unsaved, by instance. Keyed by
   * publisher rather than merged into one set, because a Viewer that closes has
   * to take its claims with it: the shell drops a departed frame's retained
   * topics, but a Viewer that merely saved everything publishes an empty list,
   * and both have to land on the same answer here.
   */
  const [dirtyByViewer, setDirtyByViewer] = useState<ReadonlyMap<string, string[]>>(new Map());
  useEffect(
    () =>
      subscribe(DIRTY_PATHS, (value, from) =>
        setDirtyByViewer((prev) => {
          const next = new Map(prev);
          next.set(from, asDirtyPaths(value));
          return next;
        }),
      ),
    [],
  );

  /**
   * The names of open files at or under a path that hold unsaved work — the
   * question the split nearly took away. It used to be a call into the tab
   * model in the same component tree, and is now assembled from what the
   * Viewers have announced. Deduplicated by path, because two Viewers can hold
   * the same file open and the confirmation should name it once.
   */
  const unsavedUnder = useCallback(
    (path: string): string[] => {
      const names = new Set<string>();
      for (const paths of dirtyByViewer.values()) {
        for (const dirty of paths) {
          if (isAtOrUnder(dirty, path)) names.add(baseName(dirty));
        }
      }
      return [...names];
    },
    [dirtyByViewer],
  );

  /**
   * A rename or a delete landed on disk somewhere else — a Save As in a Viewer,
   * a delete confirmed from a tab. `TREE_CHANGE` is published both ways.
   *
   * Either way the tree is re-read wholesale. A delete can remove a subtree and
   * a Save As can land in a folder this app has never listed, so there is no
   * single directory to re-list and no cheaper honest answer.
   */
  useEffect(() => subscribe(TREE_CHANGE, reloadTree), [reloadTree]);

  /**
   * The delete confirmation. `dropUnder` is a publish rather than a call: the
   * tabs that have to close are in another frame, and this app can only reach
   * them by saying what happened. It fires *before* `onDeleted`, so nothing is
   * left polling a path that is gone and marking itself missing a moment after
   * the user watched it go.
   */
  const del = useDelete({
    unsavedUnder,
    dropUnder: (path) => publish(TREE_CHANGE, { kind: "deleted", path } satisfies TreeChange),
    onDeleted: reloadTree,
  });

  // Files dragged in from the OS. A problem (a name already taken, a read-only checkout)
  // is a bar with one button, the same bar delete uses.
  const [dropNotice, setDropNotice] = useState<Notice | null>(null);
  const osDrop = useOsDrop({
    root,
    onImported: reloadTree,
    onProblem: (message) =>
      setDropNotice({
        tone: "warn",
        message,
        actions: [{ label: "OK", run: () => setDropNotice(null) }],
      }),
  });

  const explorerRef = useRef<ExplorerHandle | null>(null);
  useMenuCommands({
    root,
    explorer: explorerRef,
    onError: setError,
  });

  /**
   * Open a file, somewhere that can show one.
   *
   * `preview` is the tree's report of how deliberate the gesture was — a single
   * click is a peek, a double click and a freshly created file are not. What
   * that *means* is the Viewer's business (`tabs/useOpenFiles.ts`), and this
   * app deliberately does not know: it says how the user asked, not what should
   * happen to a tab.
   *
   * The rejection is swallowed: `openIn` can fail if the cluster went away
   * between the click and the call, and a tree that raised an error bar because
   * a pane closed would be reporting the shell's business as the user's problem.
   *
   * A deliberate open of a `.blend` or a Godot scene goes to its engine
   * (`engineOpen.ts`); a peek stays a peek in the Viewer.
   */
  const openFile = useCallback(
    (path: string, preview: boolean) => {
      const engine = preview ? null : engineOpen(path, rootPath);
      const opened = engine
        ? openIn(engine.appId, engine.payload)
        : openIn(VIEWER_APP, { path, preview });
      void opened.catch(noop);
    },
    [rootPath],
  );
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  /**
   * The shell asking this app to open one path — the search overlay's Enter
   * key, relayed through `src/shell/search/openHit.ts`. A real open, not a
   * peek: someone who pressed Enter on a search hit means to work in the file.
   *
   * Forwarded rather than handled, because this app no longer shows files.
   * `openHit.ts` still addresses the Files instance by its app id, which was
   * the only surface that could show a file when that code was written; the
   * honest fix is for it to call `openIn("viewer", …)` itself and skip this hop
   * entirely, and it is left alone only because that file is being worked on
   * elsewhere. See `docs/handoffs/files-app-split.md`.
   */
  useEffect(
    () =>
      on("files:open-path", (payload) => {
        const path = (payload as { path?: unknown } | null)?.path;
        if (typeof path === "string") openFileRef.current(path, false);
      }),
    [],
  );

  const openTreatment = useMemo(() => openPath, [openPath]);

  return (
    <div className="files">
      {error && <p className="app__error files__error">{error}</p>}

      <Explorer
        ref={explorerRef}
        root={root}
        reloadNonce={treeNonce}
        selectedPath={openTreatment}
        onFirstListing={reportPainted}
        onRefresh={reloadTree}
        onOpenFile={openFile}
        // The tree has already re-listed the folder it renamed in, so this only
        // has to tell the Viewers to move their tabs. Bumping `treeNonce` here
        // as well would drop the whole cache to show a change one directory
        // already knows about.
        onRenamed={(from, to) =>
          publish(TREE_CHANGE, { kind: "renamed", from, to } satisfies TreeChange)
        }
        onDelete={del.ask}
        dropTarget={osDrop.target}
      />

      {/* The one question this app is allowed to have on screen. Escape answers
          it the same way Cancel does — see `NoticeBar`. */}
      {del.notice && <NoticeBar notice={del.notice} onEscape={del.cancel} />}
      {!del.notice && dropNotice && (
        <NoticeBar notice={dropNotice} onEscape={() => setDropNotice(null)} />
      )}
    </div>
  );
}

/** Whether two paths name one folder: separators and case (Windows) do not matter. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** The last segment of a path. Both separators, for the reason `rpc.ts` gives. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Swallow a rejection deliberately, where doing nothing is the right answer. */
function noop(): void {}
