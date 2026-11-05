import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted, session } from "@veistra/bridge";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AlertTriangle, ChevronRight, FilePlus2, Lock, Palette, SquareDashed } from "lucide-react";
import { SendButton, SendFooter } from "../../../shared/SendFooter";
import {
  dragContext,
  exportSelectionPng,
  putSelectionImage,
  putSpecCard,
  selectedCount,
  selectionElements,
} from "./sendToAgent";
import { chipToAgent } from "../../../shared/context";
import AssetList from "./AssetList";
import ObjectPanel from "./ObjectPanel";
import TypesPanel from "./TypesPanel";
import TypeIcon from "./TypeIcon";
import Sidebar, { type SideTab } from "./Sidebar";
import CommentsPanel, { type CommentTarget } from "./CommentsPanel";
import { activeHighlights, type Highlight } from "./commentHighlight";
import { setEditorHooks } from "./agentBridge";
import {
  framesIn,
  frameForKey,
  regionTarget,
  selectionTarget,
  type Box,
  type FrameRow,
} from "./review";
import {
  changeType,
  convertLegacy,
  objectOf,
  setProp,
  targetOf,
  withName,
  withObject,
  wrapSelection,
  type Target,
  type TypeDef,
} from "./objects";
import {
  createCanvas,
  deleteType,
  getState,
  isCorrupt,
  isExists,
  listCanvases,
  listRefs,
  listTypes,
  messageOf,
  openCanvasSettings,
  readCanvas,
  saveType,
  setParent,
  splitFrames,
  staleWrite,
  statCanvas,
  writeCanvas,
  type CanvasDoc,
  type CanvasState,
  type CanvasComment,
  type CanvasSummary,
  type RefRow,
} from "./rpc";
import { ancestry, childId, stillLinked, treeOrder, viewportToScene, withChild } from "./nesting";
import { Autosaver, type SaveState } from "./saver";
import { sceneVersion, splitCandidates, splitSummary } from "./subcanvas";
import {
  signature,
  slugify,
  toSaved,
  uniqueId,
  withDesign,
  type DesignOverride,
  type SceneElement,
  type SceneFile,
} from "./scene";
import DesignControl from "./DesignControl";
import { views } from "./views";
import "./App.css";

// The editor is the bulk of this app's weight; load it only once a canvas is open.
const NO_HIGHLIGHTS: Highlight[] = [];

const Editor = lazy(() => import("./Editor"));

type View = "canvas" | "assets";

const SAVE_DELAY_MS = 700;
const POLL_MS = 2000;
const LAST_KEY = "canvas.last";
const SIDE_KEY = "canvas.side";

function readSide(): { tab: SideTab; collapsed: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDE_KEY) ?? "null") as {
      tab?: unknown;
      collapsed?: unknown;
    } | null;
    const tab = raw?.tab;
    return {
      tab: tab === "diagrams" || tab === "comments" ? tab : "inspector",
      collapsed: raw?.collapsed === true,
    };
  } catch {
    return { tab: "inspector", collapsed: false };
  }
}
function writeSide(side: { tab: SideTab; collapsed: boolean }): void {
  try {
    localStorage.setItem(SIDE_KEY, JSON.stringify(side));
  } catch {
    // The panel layout is a convenience.
  }
}

/**
 * The canvas this pane instance last had open, keyed by the instance's own id.
 *
 * The key has to be per instance: every Canvas frame shares one origin and so
 * one `localStorage`, and a cluster switch unmounts the frame and loads it
 * afresh, so a single global key held whichever canvas was opened last in any
 * pane. The value is a canvas id, which is a path-like id and so names a child
 * canvas as readily as a root. Best-effort: private windows and blocked storage
 * throw.
 */
function lastKey(instanceId: string | null): string {
  return instanceId ? `${LAST_KEY}.${instanceId}` : LAST_KEY;
}
function readLast(instanceId: string | null): string | null {
  try {
    return localStorage.getItem(lastKey(instanceId));
  } catch {
    return null;
  }
}
function writeLast(instanceId: string | null, id: string): void {
  try {
    localStorage.setItem(lastKey(instanceId), id);
  } catch {
    // Remembering the last canvas is a convenience.
  }
}

/** The shell's theme, which `onThemeChanged` writes to `<html data-theme>`. */
function useTheme(): "dark" | "light" {
  const read = (): "dark" | "light" =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const STATUS_TEXT: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving...",
  conflict: "Changed on disk",
  error: "Could not save",
};

export default function App() {
  const theme = useTheme();
  const instanceRef = useRef<string | null>(null);
  const [state, setState] = useState<CanvasState | null>(null);
  const [list, setList] = useState<CanvasSummary[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  /** The open canvas's own detail level and style, kept beside `doc` so the picker redraws. */
  const [design, setDesign] = useState<DesignOverride | undefined>(undefined);
  /** Bumped to remount the editor with a freshly loaded scene. */
  const [loadKey, setLoadKey] = useState(0);
  const [loadError, setLoadError] = useState<{ message: string; corrupt: boolean } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveDetail, setSaveDetail] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  /** Heavy frames the open canvas could split into sub-canvases; 0 hides the offer. */
  const [splitOffer, setSplitOffer] = useState(0);
  const [splitting, setSplitting] = useState(false);
  /** The result of the last split; informational, unlike `notice`. */
  const [splitNote, setSplitNote] = useState<string | null>(null);
  /** Canvases whose split offer was turned down this session. */
  const declinedSplit = useRef(new Set<string>());
  const [sendSlot, setSendSlot] = useState<HTMLElement | null>(null);
  /** What the Inspector describes: the selected frame, shape or shapes. */
  const [target, setTarget] = useState<Target>({ kind: "none" });
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [managing, setManaging] = useState(false);
  /** A frame just made from a selection: its name field takes focus once. */
  const [focusFrame, setFocusFrame] = useState<string | null>(null);
  const [view, setView] = useState<View>("canvas");
  /** How many elements are selected: what "Send selection" would send. */
  const [selectedN, setSelectedN] = useState(0);
  const [sentSelection, setSentSelection] = useState(false);
  /** Bumped when a card is saved, so the asset list reads disk again. */
  const [assetsKey, setAssetsKey] = useState(0);
  const [side, setSide] = useState(readSide);
  const [frames, setFrames] = useState<FrameRow[]>([]);
  const [refs, setRefs] = useState<RefRow[]>([]);
  const [openComments, setOpenComments] = useState(0);
  const [commentsKey, setCommentsKey] = useState(0);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [hoveredComment, setHoveredComment] = useState<CanvasComment | null>(null);
  /** The area picker: null when off, else the drag so far in stage pixels. */
  const [picking, setPicking] = useState<
    { from: [number, number]; to: [number, number] } | "idle" | null
  >(null);
  /** The editor's last report, for the agent hooks and the comment targets. */
  const lastChangeRef = useRef<{
    elements?: unknown;
    version?: number;
    selected?: unknown;
    files?: unknown;
    background?: unknown;
    grid?: unknown;
  }>({});
  const liveRef = useRef<{
    elements: readonly SceneElement[];
    selected: Record<string, unknown> | undefined;
  }>({ elements: [], selected: undefined });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const saverRef = useRef<Autosaver | null>(null);
  const docRef = useRef<CanvasDoc | null>(null);
  docRef.current = doc;
  const readOnly = state?.readOnly ?? false;

  const refreshList = useCallback(async () => {
    try {
      const next = await listCanvases();
      setList(next);
      return next;
    } catch (err) {
      setLoadError({ message: messageOf(err), corrupt: false });
      setList((prev) => prev ?? []);
      return null;
    }
  }, []);

  const loadTypes = useCallback(async () => {
    try {
      const got = await listTypes();
      setTypes([...got.builtin, ...got.custom]);
    } catch {
      // Without types a frame can still be named and linked; the picker is empty.
    }
  }, []);

  // First contact: the environment's state and the canvases in it.
  useEffect(() => {
    void (async () => {
      try {
        instanceRef.current = (await session()).instanceId ?? null;
      } catch {
        // No handshake: fall back to the shared key.
      }
      try {
        setState(await getState());
      } catch (err) {
        setLoadError({ message: messageOf(err), corrupt: false });
      }
      void loadTypes();
      const rows = await refreshList();
      if (rows && rows.length > 0) {
        const remembered = readLast(instanceRef.current);
        const pick =
          rows.find((r) => r.id === remembered && !r.error) ??
          rows.find((r) => !r.parent && !r.error) ??
          rows.find((r) => !r.error) ??
          rows[0]!;
        setCurrent(pick.id);
      }
      reportPainted();
    })();
  }, [refreshList, loadTypes]);

  // Load the chosen canvas and start a saver whose base is what was just read.
  const load = useCallback(async (id: string) => {
    saverRef.current?.dispose();
    saverRef.current = null;
    setLoadError(null);
    try {
      const next = await readCanvas(id);
      const saver = new Autosaver({
        delay: SAVE_DELAY_MS,
        write: async (scene, base) => (await writeCanvas(id, scene, base)).mtime,
        isStale: (err) => staleWrite(err) !== null,
        onState: (s, detail) => {
          setSaveState(s);
          setSaveDetail(detail);
        },
      });
      const s = next.scene;
      saver.setBase(next.mtime, signature(toSaved(s.elements, s.appState, s.files, s.veistra)));
      saverRef.current = saver;
      setDoc(next);
      setDesign(s.veistra?.design);
      setFrames(framesIn(s.elements));
      setCommentTarget(null);
      setTargetError(null);
      setPicking(null);
      setTarget({ kind: "none" });
      setManaging(false);
      setSelectedN(0);
      setNotice(null);
      setSplitNote(null);
      setLoadKey((k) => k + 1);
      writeLast(instanceRef.current, id);
    } catch (err) {
      setDoc(null);
      setLoadError({ message: messageOf(err), corrupt: isCorrupt(err) });
    }
  }, []);

  useEffect(() => {
    if (current) void load(current);
  }, [current, load]);

  // Leaving a canvas, or the window, must not lose the last edit.
  useEffect(() => {
    const flush = () => void saverRef.current?.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // Notice edits made outside this pane: a `git pull`, or an agent writing the
  // file. Unchanged since our own last write means nothing to do; changed with
  // no unsaved work means reload; changed with unsaved work is left to the
  // saver, whose next write is refused as stale and raises the conflict banner.
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const saver = saverRef.current;
      if (!saver) return;
      void statCanvas(current)
        .then(({ mtime }) => {
          if (saverRef.current !== saver || mtime === saver.mtime) return;
          if (saver.hasUnsaved) return;
          void refreshList();
          void load(current);
        })
        .catch(() => {
          // A failed stat is retried on the next tick.
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [current, load, refreshList]);

  const onEditorChange = useCallback(
    (
      elements: Parameters<typeof toSaved>[0],
      appState: Record<string, unknown>,
      files: Record<string, unknown>,
    ) => {
      liveRef.current = {
        elements: elements as readonly SceneElement[],
        selected: appState.selectedElementIds as Record<string, unknown> | undefined,
      };
      // Scrolling and zooming report the same elements, selection and files;
      // everything below builds strings over the whole scene, so a pan skips
      // it rather than paying it on every frame. Excalidraw mutates elements
      // in place, so the array alone is no proof: the version sum is.
      const key = lastChangeRef.current;
      const version = sceneVersion(elements as readonly SceneElement[]);
      const same =
        key.elements === elements &&
        key.version === version &&
        key.selected === appState.selectedElementIds &&
        key.files === files &&
        key.background === appState.viewBackgroundColor &&
        key.grid === appState.gridSize;
      lastChangeRef.current = {
        elements,
        version,
        selected: appState.selectedElementIds,
        files,
        background: appState.viewBackgroundColor,
        grid: appState.gridSize,
      };
      if (same) return;
      const rows = framesIn(elements as readonly SceneElement[]);
      setFrames((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
      const next = targetOf(
        elements as readonly SceneElement[],
        appState.selectedElementIds as Record<string, unknown> | undefined,
      );
      setTarget((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setSelectedN(
        selectedCount(appState.selectedElementIds as Record<string, unknown> | undefined),
      );
      const saver = saverRef.current;
      const open = docRef.current;
      const offer =
        open && !readOnly && !declinedSplit.current.has(open.id)
          ? splitCandidates(elements as readonly SceneElement[])
          : 0;
      setSplitOffer((prev) => (prev === offer ? prev : offer));
      if (!saver || !open || readOnly) return;
      const scene = toSaved(elements, appState, files, open.scene.veistra);
      saver.schedule(scene, signature(scene));
    },
    [readOnly],
  );

  /** Move the open canvas's heavy frames into sub-canvases (`canvas/split-frames`),
   *  after saving what is on screen, then reopen it with their pictures. */
  const splitHeavyFrames = useCallback(async () => {
    const open = docRef.current;
    if (!open) return;
    setSplitting(true);
    try {
      await saverRef.current?.flush();
      const out = await splitFrames(open.id);
      setSplitOffer(0);
      void refreshList();
      await load(open.id);
      setSplitNote(splitSummary(out));
    } catch (err) {
      setNotice(`Couldn't split the frames: ${messageOf(err)}`);
    } finally {
      setSplitting(false);
    }
  }, [load, refreshList]);

  const switchTo = useCallback(async (id: string) => {
    await saverRef.current?.flush();
    setCurrent(id);
  }, []);

  /** Open a linked canvas, if it exists; a link to one that is not there
   *  (deleted, or not pulled yet) says so and leaves the drawing where it is. */
  const openChild = useCallback(
    async (id: string) => {
      const rows = (await refreshList()) ?? list ?? [];
      if (!rows.some((r) => r.id === id)) {
        setNotice(
          `The linked canvas "${id}" does not exist in this checkout. Pull, or unlink the frame.`,
        );
        return;
      }
      setNotice(null);
      await switchTo(id);
    },
    [list, refreshList, switchTo],
  );

  /** Put `elements` in the live scene and write it now, so an edit that the
   *  agent or a child canvas depends on is on disk before the view moves. */
  const commitElements = useCallback(
    async (elements: SceneElement[], appState?: Record<string, unknown>) => {
      const api = apiRef.current;
      const saver = saverRef.current;
      const open = docRef.current;
      if (!api || !saver || !open) return;
      api.updateScene({ elements: elements as never, ...(appState ? { appState } : {}) } as never);
      const scene = toSaved(
        elements,
        api.getAppState() as unknown as Record<string, unknown>,
        api.getFiles() as unknown as Record<string, unknown>,
        open.scene.veistra,
      );
      saver.schedule(scene, signature(scene));
      await saver.flush();
      const state = api.getAppState() as unknown as Record<string, unknown>;
      setTarget(targetOf(elements, state.selectedElementIds as Record<string, unknown>));
    },
    [],
  );

  /** Give the open canvas its own detail level or style, or clear it (`null`) to follow
   *  Settings. It lives in the file's `veistra.design`, so it is saved like any edit and
   *  is what `canvas/design-brief` and `add_shapes` read. */
  const chooseDesign = useCallback(
    async (key: keyof DesignOverride, choice: string | null) => {
      const api = apiRef.current;
      const open = docRef.current;
      if (!api || !open || readOnly) return;
      // The saver's next write reads `open.scene.veistra`; replacing it here rather than
      // calling `setDoc` keeps the editor's `initial` prop, and so its scene, untouched.
      open.scene.veistra = withDesign(open.scene.veistra, key, choice);
      setDesign(open.scene.veistra.design);
      await commitElements(api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]);
    },
    [commitElements, readOnly],
  );

  const patchElement = useCallback(
    async (id: string, edit: (el: SceneElement) => SceneElement) => {
      const api = apiRef.current;
      if (!api) return;
      const elements = (api.getSceneElementsIncludingDeleted() as unknown as SceneElement[]).map(
        (el) => (el.id === id ? edit(el) : el),
      );
      await commitElements(elements);
    },
    [commitElements],
  );

  const frameId = target.kind === "frame" ? target.id : null;
  const frameName = target.kind === "frame" ? target.name : "";

  const createChild = useCallback(
    async (name: string) => {
      const open = docRef.current;
      if (!frameId || !open) return;
      const title = (name.trim() || frameName || "Child canvas").trim();
      const taken = new Set((list ?? []).map((r) => r.id));
      const id = uniqueId(childId(open.id, slugify(title) || "canvas"), taken);
      try {
        await createCanvas(id, title, open.id);
        await patchElement(frameId, (el) => withChild(el, id));
        await refreshList();
        await switchTo(id);
      } catch (err) {
        setNotice(messageOf(err));
      }
    },
    [frameId, frameName, list, patchElement, refreshList, switchTo],
  );

  /** A canvas that no frame here links to any more is a root again. The frame is
   *  saved first, so the backend finds nothing of ours left to clear in this file. */
  const releaseChild = useCallback(
    async (child: string) => {
      const api = apiRef.current;
      const open = docRef.current;
      if (!api || !open) return;
      const elements = api.getSceneElements() as unknown as SceneElement[];
      if (stillLinked(elements, child)) return;
      const row = (list ?? []).find((r) => r.id === child);
      if (row && row.parent === open.id) await setParent(child, null);
    },
    [list],
  );

  /** What a frame's link badge calls the child canvas: its title, else its id. */
  const titleOf = useCallback(
    (id: string) => (list ?? []).find((r) => r.id === id)?.title || id.split("/").pop() || id,
    [list],
  );

  const linkExisting = useCallback(
    async (child: string) => {
      const open = docRef.current;
      if (!frameId || !open) return;
      const previous = target.kind === "frame" ? target.child : null;
      try {
        await setParent(child, open.id);
        await patchElement(frameId, (el) => withChild(el, child));
        if (previous && previous !== child) await releaseChild(previous);
        await refreshList();
      } catch (err) {
        setNotice(messageOf(err));
      }
    },
    [frameId, patchElement, refreshList, releaseChild, target],
  );

  const unlinkChild = useCallback(async () => {
    if (!frameId) return;
    const previous = target.kind === "frame" ? target.child : null;
    try {
      await patchElement(frameId, (el) => withChild(el, null));
      if (previous) await releaseChild(previous);
      await refreshList();
    } catch (err) {
      setNotice(messageOf(err));
    }
  }, [frameId, patchElement, refreshList, releaseChild, target]);

  const renameFrame = useCallback(
    async (name: string) => {
      if (!frameId) return;
      setFocusFrame(null);
      await patchElement(frameId, (el) => withName(el, name));
    },
    [frameId, patchElement],
  );

  const retype = useCallback(
    async (typeId: string) => {
      const def = types.find((t) => t.id === typeId);
      if (!frameId || !def) return;
      await patchElement(frameId, (el) => withObject(el, changeType(objectOf(el), def)));
      setAssetsKey((k) => k + 1);
    },
    [frameId, patchElement, types],
  );

  const setField = useCallback(
    async (key: string, value: unknown) => {
      if (!frameId) return;
      await patchElement(frameId, (el) => {
        const current = objectOf(el);
        return current ? withObject(el, setProp(current, key, value)) : el;
      });
      setAssetsKey((k) => k + 1);
    },
    [frameId, patchElement],
  );

  /** Wrap the selected shapes in a new labelled frame: the way to cluster them
   *  into one object the agent can name, search and look at. */
  const frameSelection = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    const state = api.getAppState() as unknown as Record<string, unknown>;
    const got = wrapSelection(
      api.getSceneElementsIncludingDeleted() as unknown as SceneElement[],
      state.selectedElementIds as Record<string, unknown> | undefined,
    );
    if (!got.ok) {
      setNotice(got.error);
      return;
    }
    setNotice(null);
    setFocusFrame(got.frameId);
    await commitElements(got.elements, { selectedElementIds: { [got.frameId]: true } });
  }, [commitElements]);

  const convertCard = useCallback(
    async (id: string) => {
      const api = apiRef.current;
      if (!api) return;
      const got = convertLegacy(
        api.getSceneElementsIncludingDeleted() as unknown as SceneElement[],
        id,
      );
      if (!got.ok) {
        setNotice(got.error);
        return;
      }
      await commitElements(got.elements, { selectedElementIds: { [got.frameId]: true } });
      setAssetsKey((k) => k + 1);
    },
    [commitElements],
  );

  const saveTypeDef = useCallback(
    async (def: Omit<TypeDef, "builtin">) => {
      try {
        await saveType(def);
        await loadTypes();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },
    [loadTypes],
  );

  const deleteTypeDef = useCallback(
    async (id: string) => {
      try {
        await deleteType(id);
        await loadTypes();
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },
    [loadTypes],
  );

  /** The selection rendered as a PNG and put in the agent's context. */
  const putSelection = useCallback(async () => {
    const api = apiRef.current;
    const open = docRef.current;
    if (!api || !open) throw new Error("no canvas is open");
    const state = api.getAppState() as unknown as Record<string, unknown>;
    const elements = selectionElements(
      api.getSceneElementsIncludingDeleted() as unknown as SceneElement[],
      state.selectedElementIds as Record<string, unknown> | undefined,
    );
    if (elements.length === 0) throw new Error("nothing is selected");
    const png = await exportSelectionPng({
      elements,
      appState: state,
      files: api.getFiles() as unknown as Record<string, unknown>,
      dark: theme === "dark",
    });
    return putSelectionImage(png, open.scene.veistra?.title || open.id, elements.length);
  }, [theme]);

  const sendSelection = useCallback(() => {
    setNotice(null);
    putSelection()
      // One chip on the prompt of the agent tab last worked in; no words.
      .then((item) => chipToAgent(item))
      .then(
        (said) => {
          if (!said.delivered) {
            setNotice(
              `The selection is in the Context strip, but no agent took it: ${said.reason}.`,
            );
            return;
          }
          setSentSelection(true);
          setTimeout(() => setSentSelection(false), 1800);
        },
        (err: unknown) => setNotice(`Couldn't send the selection to the agent: ${messageOf(err)}`),
      );
  }, [putSelection]);

  const putCard = useCallback(
    (name: string, json: string) => putSpecCard(name, docRef.current?.path ?? "", json),
    [],
  );

  const showAssets = useCallback(async () => {
    await saverRef.current?.flush();
    setAssetsKey((k) => k + 1);
    setView("assets");
  }, []);

  const openFromList = useCallback(
    async (id: string) => {
      setView("canvas");
      if (id !== current) await switchTo(id);
    },
    [current, switchTo],
  );

  const chain = useMemo(() => (current ? ancestry(list ?? [], current) : []), [current, list]);

  const takenIds = useMemo(() => new Set((list ?? []).map((r) => r.id)), [list]);

  const create = useCallback(async () => {
    const title = draftName.trim();
    if (!title) return;
    const id = uniqueId(slugify(title), takenIds);
    setCreateError(null);
    try {
      await saverRef.current?.flush();
      await createCanvas(id, title);
      await refreshList();
      setCreating(false);
      setDraftName("");
      setCurrent(id);
    } catch (err) {
      setCreateError(isExists(err) ? "A canvas with that name already exists." : messageOf(err));
    }
  }, [draftName, refreshList, takenIds]);

  const reloadFromDisk = useCallback(() => {
    if (current) void load(current);
  }, [current, load]);

  const keepMine = useCallback(async () => {
    if (!current) return;
    try {
      const { mtime } = await statCanvas(current);
      await saverRef.current?.overwrite(mtime);
    } catch (err) {
      setSaveDetail(messageOf(err));
    }
  }, [current]);

  const setSideTab = useCallback((tab: SideTab) => {
    setSide((s) => {
      const next = { ...s, tab };
      writeSide(next);
      return next;
    });
  }, []);
  const setSideCollapsed = useCallback((collapsed: boolean) => {
    setSide((s) => {
      const next = { ...s, collapsed };
      writeSide(next);
      return next;
    });
  }, []);

  // What the panels list besides the drawing: stored reference images, and
  // how many comments are open (for the tab's badge).
  useEffect(() => {
    if (!doc) return;
    let stale = false;
    listRefs(doc.id).then(
      (r) => !stale && setRefs(r.refs),
      () => !stale && setRefs([]),
    );
    setCommentsKey((k) => k + 1);
    return () => {
      stale = true;
    };
  }, [doc]);

  /** Scroll the editor to some elements and select them. */
  const reveal = useCallback((ids: string[], fit: string[] = ids) => {
    const api = apiRef.current;
    if (!api) return;
    const all = api.getSceneElements() as unknown as SceneElement[];
    const targets = all.filter((e) => fit.includes(e.id));
    if (ids.length) {
      api.updateScene({
        appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) } as never,
      });
    }
    if (targets.length)
      api.scrollToContent(targets as never, { fitToContent: true, animate: true });
  }, []);

  const goToFrame = useCallback((elementId: string) => reveal([elementId]), [reveal]);

  const openDiagram = useCallback(
    (id: string) => {
      const api = apiRef.current;
      const el = api ? frameForKey(api.getSceneElements() as unknown as SceneElement[], id) : null;
      if (el) reveal([el.id]);
      else setNotice(`There is no diagram "${id}" on this canvas.`);
    },
    [reveal],
  );

  const frameTitle = useCallback(
    (key: string) => {
      const row = frames.find((f) => f.diagramId === key || f.elementId === key);
      return row?.title ?? key;
    },
    [frames],
  );

  const commentOnSelection = useCallback(() => {
    const got = selectionTarget(liveRef.current.elements, liveRef.current.selected);
    if ("error" in got) {
      setTargetError(got.error);
      setCommentTarget(null);
    } else {
      setTargetError(null);
      setCommentTarget(got);
    }
  }, []);

  const showComment = useCallback(
    (c: CanvasComment) => {
      const api = apiRef.current;
      if (!api) return;
      const all = api.getSceneElements() as unknown as SceneElement[];
      const frameEl = frameForKey(all, c.frameId);
      const present = c.elementIds.filter((id) => all.some((e) => e.id === id));
      if (present.length) reveal(present);
      else if (frameEl) reveal([], [frameEl.id]);
      else setNotice(`The frame this comment is on ("${c.frameId}") is no longer on the canvas.`);
    },
    [reveal],
  );

  // Only on the Comments tab: elsewhere the draft and hover are not on screen to explain.
  const highlights = useMemo(
    () =>
      side.tab !== "comments"
        ? NO_HIGHLIGHTS
        : activeHighlights(
            commentTarget,
            hoveredComment
              ? {
                  id: hoveredComment.id,
                  status: hoveredComment.status,
                  spec: hoveredComment.region
                    ? { frameId: hoveredComment.frameId, region: hoveredComment.region }
                    : { frameId: hoveredComment.frameId, elementIds: hoveredComment.elementIds },
                }
              : null,
          ),
    [side.tab, commentTarget, hoveredComment],
  );

  const flushNow = useCallback(async () => {
    await saverRef.current?.flush();
  }, []);

  /** The dragged box, from stage pixels to a frame and a frame-relative region. */
  const finishPick = useCallback((from: [number, number], to: [number, number]) => {
    const api = apiRef.current;
    const stage = stageRef.current;
    setPicking(null);
    if (!api || !stage) return;
    const view = api.getAppState() as unknown as Parameters<typeof viewportToScene>[2];
    const rect = stage.getBoundingClientRect();
    const a = viewportToScene(rect.left + from[0], rect.top + from[1], view);
    const b = viewportToScene(rect.left + to[0], rect.top + to[1], view);
    const drag: Box = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    const got = regionTarget(liveRef.current.elements, drag);
    if ("error" in got) {
      setTargetError(got.error);
      setCommentTarget(null);
    } else {
      setTargetError(null);
      setCommentTarget(got);
    }
  }, []);

  // Escape leaves the area picker.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  // What Rust's canvas methods and the agent server's `context` tool ask the
  // open editor: which canvas, flush now, and what is selected.
  useEffect(() => {
    setEditorHooks({
      currentId: () => docRef.current?.id ?? null,
      flush: async () => {
        const saver = saverRef.current;
        if (!saver) return { saved: false, mtime: null };
        await saver.flush();
        return { saved: !saver.hasUnsaved, mtime: saver.mtime ?? null };
      },
      selection: () => {
        const { elements, selected } = liveRef.current;
        const ids = Object.keys(selected ?? {}).filter((k) => selected?.[k]);
        const got = selectionTarget(elements, selected);
        const frameEl = "error" in got ? null : elements.find((e) => e.id === got.frameId);
        const diagram = frameEl ? (framesIn([frameEl])[0]?.diagramId ?? frameEl.id) : null;
        return { elementIds: ids, diagram };
      },
    });
    return () => setEditorHooks(null);
  }, []);

  const empty = list !== null && list.length === 0;
  const createForm = (
    <form
      className="cv__create"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <input
        className="cv__input"
        autoFocus
        placeholder="Canvas name, e.g. Hospital wing"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        aria-label="Canvas name"
      />
      <code className="cv__path">
        {state?.dir ?? "canvas"}/{uniqueId(slugify(draftName), takenIds)}.json
      </code>
      <button type="submit" className="k-btn k-btn--primary k-btn--sm" disabled={!draftName.trim()}>
        Create
      </button>
      {!empty && (
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          onClick={() => {
            setCreating(false);
            setCreateError(null);
          }}
        >
          Cancel
        </button>
      )}
      {createError && (
        <span className="cv__error" role="alert">
          {createError}
        </span>
      )}
    </form>
  );

  return (
    <div className="app cv">
      <header className="cv__header">
        <select
          className="cv__select"
          aria-label="Canvas"
          value={current ?? ""}
          disabled={!list || list.length === 0}
          onChange={(e) => void switchTo(e.target.value)}
        >
          {treeOrder(list ?? []).map(({ row, depth }) => (
            <option key={row.id} value={row.id}>
              {"  ".repeat(depth)}
              {row.error ? `${row.title} (unreadable)` : row.title}
            </option>
          ))}
          {empty && <option value="">No canvases yet</option>}
        </select>
        {/* With the asset list off (see `views.ts`) the canvas is the only view, so no toggle. */}
        {views.assetList && (
          <div className="cv__tabs" role="tablist" aria-label="View">
            <button
              type="button"
              role="tab"
              aria-selected={view === "canvas"}
              className={`cv__tab${view === "canvas" ? " is-on" : ""}`}
              onClick={() => setView("canvas")}
            >
              Canvas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "assets"}
              className={`cv__tab${view === "assets" ? " is-on" : ""}`}
              onClick={() => void showAssets()}
            >
              Asset list
            </button>
          </div>
        )}
        {chain.length > 1 && (
          <nav className="cv__crumbs" aria-label="Canvas path">
            {chain.map((row, i) => (
              <span key={row.id} className="cv__crumb">
                {i > 0 && <ChevronRight size={12} aria-hidden />}
                {i === chain.length - 1 ? (
                  <span aria-current="page">{row.title}</span>
                ) : (
                  <button
                    type="button"
                    className="cv__crumb-link"
                    onClick={() => void switchTo(row.id)}
                  >
                    {row.title}
                  </button>
                )}
              </span>
            ))}
          </nav>
        )}
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={() => setCreating((c) => !c)}
          disabled={readOnly || !state?.hasEnvironment}
          title={
            readOnly ? "The default branch is read-only. Open a worktree to draw." : "New canvas"
          }
        >
          <FilePlus2 size={14} aria-hidden /> New canvas
        </button>
        {doc ? (
          <DesignControl
            canvasId={doc.id}
            override={design}
            readOnly={readOnly}
            onChange={(key, choice) => void chooseDesign(key, choice)}
          />
        ) : (
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => void openCanvasSettings().catch(() => undefined)}
            title="Detail level and drawing style for agents (opens Settings)"
          >
            <Palette size={14} aria-hidden /> Drawing style
          </button>
        )}
        {doc && <code className="cv__path">{doc.path}</code>}
        <span className="cv__spacer" />
        {readOnly ? (
          <span className="k-badge k-badge--idle">
            <Lock size={12} aria-hidden /> Read-only
          </span>
        ) : (
          doc && (
            <span
              className={`cv__status cv__status--${saveState}`}
              role="status"
              title={saveDetail}
            >
              {STATUS_TEXT[saveState]}
            </span>
          )
        )}
      </header>

      {creating && !empty && createForm}

      {readOnly && (
        <p className="cv__notice">
          This is the main checkout, which is read-only here. You can look at canvases; drawing
          needs a worktree.
        </p>
      )}

      {saveState === "conflict" && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>
            This canvas changed on disk (a pull, or another writer) while you were editing.
          </span>
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            onClick={reloadFromDisk}
          >
            Load the disk version
          </button>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => void keepMine()}
          >
            Keep mine
          </button>
        </div>
      )}
      {saveState === "error" && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>Could not save: {saveDetail}. Your next change will try again.</span>
        </div>
      )}

      {splitOffer > 0 && doc && view === "canvas" && (
        <div className="cv__notice" role="status">
          <span>
            This canvas is large: {splitOffer} frame(s) hold enough to slow panning down. Each can
            become its own sub-canvas, shown here as a picture; double-click one to edit it.
          </span>
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={splitting}
            onClick={() => void splitHeavyFrames()}
          >
            {splitting ? "Splitting..." : "Split into sub-canvases"}
          </button>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => {
              declinedSplit.current.add(doc.id);
              setSplitOffer(0);
            }}
          >
            Not now
          </button>
        </div>
      )}

      {splitNote && (
        <div className="cv__notice" role="status" data-testid="split-summary">
          <span>{splitNote}</span>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => setSplitNote(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{notice}</span>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {view === "assets" && (
        <AssetList refreshKey={assetsKey} onOpen={(id) => void openFromList(id)} />
      )}

      <main className="cv__body" hidden={view !== "canvas"}>
        <div className="cv__stage" ref={stageRef}>
          {loadError ? (
            <div className="cv__empty" role="alert">
              <AlertTriangle size={20} aria-hidden />
              <p>{loadError.message}</p>
              {loadError.corrupt && (
                <p className="cv__hint">
                  The file was not touched. Fix or restore it in git, or pick another canvas.
                </p>
              )}
            </div>
          ) : empty ? (
            <div className="cv__empty">
              <p>
                {readOnly
                  ? "There are no canvases in this checkout, and the default branch is read-only."
                  : "No canvases in this environment yet."}
              </p>
              {!readOnly && state?.hasEnvironment && createForm}
              {!state?.hasEnvironment && state && <p className="cv__hint">Open a project first.</p>}
            </div>
          ) : doc ? (
            <Suspense fallback={<div className="cv__empty">Loading the editor...</div>}>
              <Editor
                key={`${doc.id}:${loadKey}`}
                canvasId={doc.id}
                initial={doc.scene as SceneFile}
                theme={theme}
                readOnly={readOnly}
                onChange={onEditorChange}
                onApi={(api) => {
                  apiRef.current = api;
                }}
                onOpenChild={(id) => void openChild(id)}
                titleOf={titleOf}
                onOpenDiagram={openDiagram}
                highlights={highlights}
              />
            </Suspense>
          ) : (
            <div className="cv__empty">Loading...</div>
          )}
          {picking && (
            <div
              className="cv__pick"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const p: [number, number] = [e.clientX - r.left, e.clientY - r.top];
                e.currentTarget.setPointerCapture(e.pointerId);
                setPicking({ from: p, to: p });
              }}
              onPointerMove={(e) => {
                if (picking === "idle") return;
                const r = e.currentTarget.getBoundingClientRect();
                setPicking({ from: picking.from, to: [e.clientX - r.left, e.clientY - r.top] });
              }}
              onPointerUp={() => {
                if (picking !== "idle") finishPick(picking.from, picking.to);
              }}
            >
              <span className="cv__pick-hint">
                Drag a box around what the comment is about. Esc cancels.
              </span>
              {picking !== "idle" && (
                <span
                  className="cv__pick-box"
                  style={{
                    left: Math.min(picking.from[0], picking.to[0]),
                    top: Math.min(picking.from[1], picking.to[1]),
                    width: Math.abs(picking.to[0] - picking.from[0]),
                    height: Math.abs(picking.to[1] - picking.from[1]),
                  }}
                />
              )}
            </div>
          )}
        </div>
        {doc && !loadError && (
          <Sidebar
            tab={side.tab}
            onTab={setSideTab}
            collapsed={side.collapsed}
            onCollapsed={setSideCollapsed}
            openComments={openComments}
          >
            {side.tab === "diagrams" && (
              <section className="cv__side-section" aria-label="Diagrams">
                {frames.length === 0 ? (
                  <p className="cv__hint">
                    No diagrams yet. Press F and drag around a drawing to make it one, or ask an
                    agent to draw one.
                  </p>
                ) : (
                  <ul className="cv__list">
                    {frames.map((f) => (
                      <li key={f.elementId}>
                        <button
                          type="button"
                          className="cv__list-item"
                          onClick={() => goToFrame(f.elementId)}
                        >
                          <span>{f.title}</span>
                          <span className="cv__meta">
                            {[f.level, f.diagramId ?? "unnamed frame"].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {side.tab === "comments" && (
              <CommentsPanel
                canvasId={doc.id}
                readOnly={readOnly}
                refreshKey={commentsKey}
                target={commentTarget}
                targetError={targetError}
                canUseSelection={selectedN > 0}
                onUseSelection={commentOnSelection}
                onPickArea={() => {
                  setTargetError(null);
                  setPicking("idle");
                }}
                onClearTarget={() => {
                  setCommentTarget(null);
                  setTargetError(null);
                }}
                frameTitle={frameTitle}
                flush={flushNow}
                onShow={showComment}
                onHover={setHoveredComment}
                onCounts={setOpenComments}
              />
            )}
            {side.tab === "inspector" && managing && (
              <TypesPanel
                types={types}
                readOnly={readOnly}
                onSave={saveTypeDef}
                onDelete={deleteTypeDef}
                onClose={() => setManaging(false)}
              />
            )}
            {side.tab === "inspector" && !managing && (
              <>
                {target.kind === "frame" && (
                  <ObjectPanel
                    key={`${doc.id}:${loadKey}:${target.id}`}
                    frame={target}
                    types={types}
                    readOnly={readOnly}
                    refs={refs.map((r) => ({ name: r.name, path: r.path }))}
                    focusName={focusFrame === target.id}
                    canvases={list ?? []}
                    current={doc.id}
                    onName={(name) => void renameFrame(name)}
                    onType={(id) => void retype(id)}
                    onProp={(key, value) => void setField(key, value)}
                    onOpenChild={(id) => void openChild(id)}
                    onUnlink={() => void unlinkChild()}
                    onCreateChild={(name) => void createChild(name)}
                    onLinkExisting={(id) => void linkExisting(id)}
                    onManageTypes={() => setManaging(true)}
                    putCard={putCard}
                    onSendError={setNotice}
                    sendSlot={sendSlot}
                  />
                )}
                {target.kind === "shape" && (
                  <section className="cv__object cv__side-section" aria-label="Shape">
                    {target.frame ? (
                      <>
                        <h3>In a frame</h3>
                        <p className="cv__hint">Detail lives on the frame, not on each shape.</p>
                        <span className="cv__typechip">
                          {(() => {
                            const def = types.find((t) => t.id === target.frame!.type);
                            return def ? (
                              <>
                                <TypeIcon icon={def.icon} color={def.color} size={12} /> {def.name}
                              </>
                            ) : (
                              "No type"
                            );
                          })()}
                          {" - "}
                          {target.frame.name || "unnamed frame"}
                        </span>
                        <button
                          type="button"
                          className="k-btn k-btn--secondary k-btn--sm"
                          onClick={() => reveal([target.frame!.id])}
                        >
                          Select frame
                        </button>
                      </>
                    ) : (
                      <>
                        <h3>Not in a frame</h3>
                        <p className="cv__hint">Wrap in a frame to describe this for the agent.</p>
                        {!readOnly && (
                          <button
                            type="button"
                            className="k-btn k-btn--secondary k-btn--sm"
                            onClick={() => void frameSelection()}
                          >
                            <SquareDashed size={14} aria-hidden /> Frame selection
                          </button>
                        )}
                      </>
                    )}
                    {target.legacy && (
                      <>
                        <p className="cv__hint">
                          This shape carries a spec card
                          {target.legacy.name ? ` (${target.legacy.name})` : ""} from before frames
                          held the detail.
                        </p>
                        {!readOnly && (
                          <button
                            type="button"
                            className="k-btn k-btn--secondary k-btn--sm"
                            onClick={() => void convertCard(target.id)}
                          >
                            Convert to a Model frame
                          </button>
                        )}
                      </>
                    )}
                  </section>
                )}
                {target.kind === "many" && (
                  <section className="cv__object cv__side-section" aria-label="Selection">
                    <h3>{target.count} shapes selected</h3>
                    {target.wrappable ? (
                      <>
                        <p className="cv__hint">
                          Wrap them in one labelled frame to make a single object the agent can
                          name, search and look at.
                        </p>
                        {!readOnly && (
                          <button
                            type="button"
                            className="k-btn k-btn--secondary k-btn--sm"
                            onClick={() => void frameSelection()}
                          >
                            <SquareDashed size={14} aria-hidden /> Frame selection
                          </button>
                        )}
                      </>
                    ) : (
                      <p className="cv__hint">
                        The selection includes a frame, and frames cannot nest. Select the shapes
                        alone to frame them.
                      </p>
                    )}
                  </section>
                )}
                {target.kind === "none" && (
                  <p className="cv__hint">
                    Select a frame to describe it. To describe loose shapes, select them and wrap
                    them in a frame.
                  </p>
                )}
                <section className="cv__side-section" aria-label="Reference images">
                  <h3>Reference images</h3>
                  {refs.length === 0 ? (
                    <p className="cv__hint">
                      None stored. Drop or insert an image on the canvas and it is saved beside the
                      file, not inside it.
                    </p>
                  ) : (
                    <ul className="cv__list">
                      {refs.map((r) => (
                        <li key={r.ref}>
                          <button
                            type="button"
                            className="cv__list-item"
                            title={r.path}
                            onClick={() => {
                              const api = apiRef.current;
                              const placed = api
                                ? (api.getSceneElements() as unknown as SceneElement[]).filter(
                                    (e) => e.type === "image" && e.fileId === r.fileId,
                                  )
                                : [];
                              if (placed.length) reveal(placed.map((e) => e.id));
                            }}
                          >
                            <span>{r.name}</span>
                            <span className="cv__meta">
                              {r.fileId ? "placed · show" : "not placed"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </Sidebar>
        )}
      </main>

      {/* Send to agent sits below the whole body, drawing and side panel alike,
          so it takes its own height instead of covering the canvas. The spec
          card's Send card button portals into the empty slot after Send
          selection: the card's draft lives in the side panel. */}
      {doc && view === "canvas" && (
        <SendFooter>
          <SendButton
            label="Send selection"
            sent={sentSelection}
            disabled={selectedN === 0}
            title="Add the selection, as an image, to the agent's context. Drag to a terminal to send it."
            onPointerDown={selectedN > 0 ? dragContext(() => putSelection()) : undefined}
            onClick={sendSelection}
          />
          <span className="cv__send-slot" ref={setSendSlot} />
        </SendFooter>
      )}
    </div>
  );
}
