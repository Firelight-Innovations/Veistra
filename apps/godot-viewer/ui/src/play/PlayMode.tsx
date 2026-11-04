/**
 * The Godot app's Play mode: run the environment's game inside this pane,
 * record runs as takes, mark them, review them and send the notes to an agent
 * (design "Play, Scene and Blender views", §3 to §10). The shell (`../App.tsx`)
 * hands it where the frame is, the Godot status and what outlives a switch to
 * Editor: the chosen project and the notes drawn on the live game.
 *
 * Two views share the toolbar: live, with the game over the pane and the live
 * strip under it, and review, of one take. Where the game cannot be placed
 * (no embedder on this platform, or no window came) it runs in its own window
 * and the pane shows its log, as Play always did; nothing else changes.
 *
 * One poll loop drives the live view: `play/state` every half second, with a
 * cursor for the log and one for the keys the addon handled (F7 stops and
 * opens review; Ctrl Shift M marks up the live frame).
 *
 * The toolbar keeps the board's five slots in both views, and keeps every
 * button in place: one that cannot act now (Record with capture missing, Pop
 * out with no game in the pane) is disabled and says why, rather than gone.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { reportPainted } from "@veistra/bridge";
import {
  Camera,
  Flag,
  Maximize2,
  MessageSquarePlus,
  Pause,
  PenLine,
  PictureInPicture2,
  Play as PlayIcon,
  RotateCcw,
  Square,
} from "lucide-react";
import type { MarkupExport } from "@veistra/markup/layer";
import { CommentPanel } from "../../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  verdictComment,
  formatPlayTime,
  type Comment,
} from "../../../../shared/comments";
import { errorText } from "../../../../shared/godot";
import type { WindowRect } from "../../../../shared/nativeBox";
import { blobBase64, sendMarkup } from "../../../../shared/markupFlow";
import { SendButton, SendFooter, useSendAction } from "../../../../shared/SendFooter";
import {
  ToolbarButton,
  ToolbarEnvChip,
  ToolbarReason,
  ViewerToolbar,
  type ToolbarStatus,
} from "../../../../shared/ViewerToolbar";
import { clock } from "./frames";
import { isTyping, liveAction } from "./keys";
import { LiveStrip, LiveView, LogView, type LiveMarking } from "./LiveView";
import type { Target } from "./notes";
import Review, { type LiveNote } from "./Review";
import {
  addonStatus,
  capture,
  dock,
  getState,
  installAddon,
  listTakes,
  mark,
  pick,
  popOut,
  removeAddon,
  restart,
  run,
  setPaused,
  setRecord,
  stop,
  type AddonStatus,
  type Capture,
  type ListedTake,
  type Live,
  type LogLine,
  type RunInfo,
} from "./rpc";
import { dragContext, putLog, putShot } from "./context";
import { resolvePins } from "./pins";
import type { RunRequest } from "../App";
import { focusIfDropped, type ModeProps } from "../modes";
import { getState as readScenes } from "../rpc";
import "./play.css";

/** Lines kept in the pane; the backend keeps its own, larger, bound. */
const LOG_KEEP = 2000;
const POLL_MS = 500;
/** How long F7 waits for a take the game's own exit is still writing. */
const SAVING_WAIT_MS = 5_000;
const SAVING_POLL_MS = 250;

type View = { kind: "live" } | { kind: "review"; take: string };
type Drawer = "closed" | "output" | "errors" | "notes";

const PLAY_TARGET = { app: "play", label: "Play" };

const leaf = (p: string | null | undefined) => (p ? p.slice(p.lastIndexOf("/") + 1) : "");

/** A scene as the picker lists it: its path in the project, and which is the main one. */
const sceneLabel = (scene: string, main: string | null | undefined) =>
  `${scene.replace(/^res:\/\//, "")}${scene === main ? " (main)" : ""}`;

/** Why a run that ended has no take: Record off, unable to record, or never in the pane. */
function notRecorded(recordOn: boolean, blocked: string | null): string {
  if (blocked) return `This run was not recorded. ${blocked}`;
  if (recordOn)
    return "Nothing was recorded: a take starts once the game's window is in the pane, and this run's never got there.";
  return "This run was not recorded, so there is no take to review. Turn on Record.";
}

export interface PlayModeProps extends ModeProps {
  /** Where this frame is in its window (`veistra/window-rect`); `null` until the shell says. */
  frameRect: WindowRect | null;
  /** The shell's open overlays (`veistra/overlays`). */
  overlays: WindowRect[];
  /** The project chosen in this pane, by its picker or by Play scene. */
  project: string | undefined;
  onProject: (rel: string) => void;
  /** Live mark-up notes for the take being recorded, kept by the shell across a switch. */
  liveNotes: LiveNote[];
  setLiveNotes: Dispatch<SetStateAction<LiveNote[]>>;
  /** A scene to run now, from Play scene or an open. */
  runRequest: RunRequest | null;
  onRunHandled: (n: number) => void;
}

export default function PlayMode(props: PlayModeProps) {
  const { status, statusError, reloadStatus, epoch, frameRect, overlays, project, liveNotes } =
    props;
  const { onProject: setProject, setLiveNotes, runRequest, onRunHandled } = props;
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addon, setAddon] = useState<AddonStatus | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [shot, setShot] = useState<Capture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [view, setView] = useState<View>({ kind: "live" });
  const [takes, setTakes] = useState<ListedTake[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [marking, setMarking] = useState<
    (LiveMarking & { atWall: number; wasPaused: boolean }) | null
  >(null);
  const [drawer, setDrawer] = useState<Drawer>("closed");
  const [now, setNow] = useState(() => Date.now());
  /** The chosen project's scenes, for slot 2, and the project they are of. */
  const [scenes, setScenes] = useState<{ rel: string; list: string[] } | null>(null);
  /** What Run plays: the scene picked in slot 2, or the last one run here, with its project. */
  const [picked, setPicked] = useState<{ rel: string; scene: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cursor = useRef(0);
  const keyCursor = useRef(0);
  const runId = useRef<number | null>(null);
  /** Whether a poll has answered since this pane opened. */
  const primed = useRef(false);
  /** The last saved take the poll saw, so a take saved anywhere refreshes Takes. */
  const savedTake = useRef<string | null>(null);
  /** The chosen project, for the poll, which outlives every render. */
  const projectRel = useRef<string | undefined>(undefined);
  /** What the poll's keys do, and the run the render that made them had drawn. */
  const actions = useRef<{ run: number | null; review: () => void; markup: () => void }>({
    run: null,
    review: () => undefined,
    markup: () => undefined,
  });

  const readOnly = status?.environment.readOnly ?? false;
  // A cloud session's files, and so its game, are on its VM (`editorSurface.ts`).
  const cloud = status?.editor?.code === "cloud";
  const found = status?.executable.found ?? null;
  const projects = status?.projects ?? [];
  const chosen = projects.find((p) => p.rel === project) ?? projects[0] ?? null;
  const chosenRel = chosen?.rel;
  projectRel.current = chosenRel;
  const running = info?.state.kind === "running";
  const paused = running && info?.paused === true;
  const canRun = !cloud && found !== null && chosen !== null && chosen.engineMajor >= 4;
  const session = live?.session ?? null;
  const take = session?.take ?? null;
  const recordOn = live?.record.on ?? false;
  const recordBlocked = live?.record.blocked ?? null;

  const refreshComments = useCallback(async () => {
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      setComments(await listComments());
    } catch {
      setCommentsError("Couldn't load comments.");
    } finally {
      setCommentsLoading(false);
    }
  }, []);

  const loadAddon = useCallback(async (rel: string | undefined) => {
    try {
      setAddon(await addonStatus(rel));
    } catch {
      setAddon(null);
    }
  }, []);

  const loadTakes = useCallback(async () => {
    try {
      setTakes((await listTakes()).takes);
    } catch {
      setTakes([]);
    }
  }, []);

  useEffect(() => reportPainted(), []);

  // Again after the cluster's project moves: notes, takes and the addon are
  // the new root's.
  useEffect(() => {
    void refreshComments();
    void loadTakes();
  }, [refreshComments, loadTakes, epoch]);

  useEffect(() => {
    if (chosenRel !== undefined) void loadAddon(chosenRel);
  }, [chosenRel, loadAddon, epoch]);

  // Slot 2 lists the project's scenes. The main scene is chosen first, as
  // Godot's own F5 would run it; a pick that is still in the list is kept.
  useEffect(() => {
    if (chosenRel === undefined) return;
    let live = true;
    readScenes(undefined, chosenRel)
      .then((s) => {
        if (!live) return;
        setScenes({ rel: chosenRel, list: s.scenes });
        setPicked((p) =>
          p?.rel === chosenRel && s.scenes.includes(p.scene)
            ? p
            : s.scene
              ? { rel: chosenRel, scene: s.scene }
              : null,
        );
      })
      .catch(() => {
        if (live) setScenes({ rel: chosenRel, list: [] });
      });
    return () => {
      live = false;
    };
  }, [chosenRel, epoch]);

  // The keys are bound on the pane's root. A focused button that goes with
  // the view it sat in (Back to live, Stop and review, a mode tab) drops the
  // focus to the page, where F5 is WebView2's reload and not Play's.
  useEffect(() => focusIfDropped(root.current), [view]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // One poll loop: the run, its log after the cursor, and new keys. A tick is
  // skipped while the one before it waits for its answer. Two in flight
  // answered out of step: one sent before a run switch got past the switch's
  // cursor reset and acted on every key since zero with the last render's
  // actions (an old F7 said nothing had run while the game ran), and both
  // added the same log lines. Dropping answers sent before the latest switch
  // was the other way; it still let answers landing during the switch's own
  // refetch through, and left the doubled log.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        let s = await getState(cursor.current, keyCursor.current, projectRel.current);
        if (cancelled) return;
        const opening = !primed.current;
        primed.current = true;
        let newRun = false;
        if (s.run && runId.current !== s.run.id) {
          runId.current = s.run.id;
          cursor.current = 0;
          keyCursor.current = 0;
          setLines([]);
          s = await getState(0, 0, projectRel.current);
          if (cancelled) return;
          newRun = true;
        }
        setLive(s.live ?? null);
        // However the take was saved (Stop, the game quitting, Record off, Pop
        // out), Takes lists it. Restart's is gone from the session by now, so
        // doRestart lists its own.
        const t = s.live?.session?.take;
        if (t?.state === "saved" && t.id !== savedTake.current) {
          savedTake.current = t.id;
          void loadTakes();
        }
        // Live mark up belongs to the run it paused; once that has ended or
        // been replaced, a drawing left open would cover the next run.
        if (!s.run || newRun || s.run.state.kind !== "running") setMarking(null);
        if (!s.run) {
          setInfo(null);
          return;
        }
        setInfo(s.run);
        if (s.log && s.log.lines.length > 0) {
          cursor.current = s.log.nextSeq;
          const fresh = s.log.lines;
          setLines((prev) => [...prev, ...fresh].slice(-LOG_KEEP));
        }
        const keys = s.live?.session?.keys ?? [];
        // Keys from before this pane opened were for whoever had it then;
        // replaying an old F7 would stop the game.
        if (opening) {
          keyCursor.current = keys.reduce((m, k) => Math.max(m, k.seq), keyCursor.current);
          return;
        }
        // The actions are the last render's. Until it has drawn this run they
        // would act on the one before (F7 would find nothing running), so the
        // keys wait, the cursor left where it is, and come again next tick.
        if (actions.current.run !== s.run.id) return;
        for (const k of keys) {
          keyCursor.current = k.seq;
          if (k.key === "F7") actions.current.review();
          if (k.key === "Ctrl Shift M") actions.current.markup();
        }
      } catch {
        // A poll that fails is retried on the next tick.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadTakes]);

  // The frame live mark up drew on is let go with the drawing, however it ends.
  useEffect(() => {
    if (!marking) return;
    const url = marking.url;
    return () => URL.revokeObjectURL(url);
  }, [marking]);

  const guarded = useCallback(async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(errorText(e));
    }
  }, []);

  const start = useCallback(
    (scene?: string, projectRel?: string) =>
      guarded(async () => {
        const rel = projectRel ?? chosenRel;
        const s = await run(
          rel,
          scene ?? (picked && picked.rel === rel ? picked.scene : undefined),
        );
        // Played from elsewhere (Play scene, review), the scene is what F5 runs next.
        if (scene && rel !== undefined) setPicked({ rel, scene });
        setInfo(s.run);
        setLive(s.live ?? null);
        setShot(null);
        setMarking(null);
        setView({ kind: "live" });
      }),
    [chosenRel, guarded, picked],
  );

  // Play scene, from Editor mode or another pane, names its project: a
  // `res://` path means nothing without one, so in an environment holding
  // several, running it against whichever project this pane last picked would
  // play the wrong game. Each request runs once, however often Play mounts.
  const ranRequest = useRef(0);
  useEffect(() => {
    if (!runRequest || runRequest.n <= ranRequest.current) return;
    ranRequest.current = runRequest.n;
    onRunHandled(runRequest.n);
    void start(runRequest.scene, runRequest.project);
  }, [runRequest, onRunHandled, start]);

  const doRestart = useCallback(
    () =>
      guarded(async () => {
        setInfo((await restart(chosenRel)).run);
        setMarking(null);
        void loadAddon(chosenRel);
        // Restart saved the old run's take; the poll only sees the new run's.
        void loadTakes();
      }),
    [chosenRel, guarded, loadAddon, loadTakes],
  );

  const doStop = useCallback(
    () =>
      guarded(async () => {
        const s = await stop();
        setInfo(s.run);
        setLive(s.live ?? null);
        setMarking(null);
        void loadTakes();
      }),
    [guarded, loadTakes],
  );

  const doPause = useCallback(
    () => guarded(async () => setInfo((await setPaused(!paused)).run)),
    [guarded, paused],
  );

  const openReview = useCallback(
    (id: string) => {
      setView({ kind: "review", take: id });
      void loadTakes();
    },
    [loadTakes],
  );

  /** F7 and Stop and review: stop, and open the take this run made. */
  const stopAndReview = useCallback(
    () =>
      guarded(async () => {
        const s = running ? await stop() : null;
        if (s) {
          setInfo(s.run);
          setLive(s.live ?? null);
          setMarking(null);
        }
        let t = (s?.live ?? live)?.session?.take;
        // The game quit by itself a moment ago, and its take is being written.
        for (let waited = 0; t?.state === "saving" && waited < SAVING_WAIT_MS;) {
          await new Promise((r) => setTimeout(r, SAVING_POLL_MS));
          waited += SAVING_POLL_MS;
          t = (await getState(cursor.current, keyCursor.current, projectRel.current)).live?.session
            ?.take;
        }
        if (t?.state === "saved") openReview(t.id);
        else if (t?.state === "failed") setProblem(t.reason);
        else if (t?.state === "saving")
          setNotice("The take is still being saved. Open it from Takes in a moment.");
        else if (!t) setNotice("Nothing has run here yet, so there is no take to review.");
        else setNotice(notRecorded(recordOn, recordBlocked));
      }),
    [guarded, running, live, openReview, recordOn, recordBlocked],
  );

  const doCapture = useCallback(async () => {
    setCapturing(true);
    await guarded(async () => {
      setShot(await capture());
    });
    setCapturing(false);
  }, [guarded]);

  const doMark = useCallback(
    () =>
      guarded(async () => {
        await mark();
      }),
    [guarded],
  );

  /** Ctrl Shift M and Mark up: pause, take the frame, draw on it. */
  const startLiveMarkup = useCallback(
    () =>
      guarded(async () => {
        if (!running || !info?.captureReady || marking) return;
        const wasPaused = info.paused;
        if (!wasPaused) await setPaused(true);
        const cap = await capture();
        const bytes = Uint8Array.from(atob(cap.png), (c) => c.charCodeAt(0));
        setMarking({
          url: URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
          natural: { width: cap.width ?? 0, height: cap.height ?? 0 },
          atWall: Date.now(),
          wasPaused,
        });
      }),
    [guarded, running, info, marking],
  );

  const endLiveMarkup = useCallback(
    async (keepPaused: boolean) => {
      const m = marking;
      setMarking(null);
      if (m && !m.wasPaused && !keepPaused) await setPaused(false).catch(() => undefined);
    },
    [marking],
  );

  /**
   * Done on the live frame: ask the game what each pin is on, then either
   * keep the note for the take being recorded, or, with no take, send the
   * markup to the agent the way every viewer does.
   */
  const doneLiveMarkup = useCallback(
    async (result: MarkupExport, shown: { width: number; height: number }) => {
      const m = marking;
      if (!m) return;
      const json = result.json;
      const first = await resolvePins(
        json,
        m.natural,
        shown,
        async (x, y) => (await pick(x, y)).hit,
      );
      const target: Target | null = first ? { ...first, source: "pick" } : null;
      const words = json.pins
        .map((p) => p.note)
        .filter(Boolean)
        .join("\n");
      if (take?.state === "recording" && session) {
        const markupPng = await blobBase64(result.png);
        const atMs = m.atWall - session.zero;
        const note = { take: take.id, atMs, body: words, markup: json, markupPng, target };
        setLiveNotes((n) => [...n, note]);
        setNotice("Kept as a note on this take. It opens with the take in review.");
      } else {
        await guarded(() => sendMarkup(PLAY_TARGET, result.png, json, info?.scene ?? null));
        setNotice("Markup sent to the agent.");
      }
      await endLiveMarkup(false);
    },
    [marking, take, session, guarded, info, endLiveMarkup, setLiveNotes],
  );

  actions.current = {
    run: info?.id ?? null,
    review: () => void stopAndReview(),
    markup: () => void startLiveMarkup(),
  };

  /**
   * Record and Ctrl R. Off and blocked, Record is disabled and Ctrl R does
   * nothing; the strip says why, and Enable capture is in the footer. On, it
   * always turns off, blocked or not.
   */
  const toggleRecord = useCallback(() => {
    if (!recordOn && recordBlocked) return;
    void guarded(async () => {
      await setRecord(!recordOn, chosenRel);
      setLive((l) => (l ? { ...l, record: { ...l.record, on: !recordOn } } : l));
    });
  }, [recordOn, recordBlocked, guarded, chosenRel]);

  const onLiveNotesTaken = useCallback(
    (id: string) => setLiveNotes((notes) => notes.filter((n) => n.take !== id)),
    [setLiveNotes],
  );

  const changeAddon = async (install: boolean) => {
    await guarded(async () => {
      setAddon(install ? await installAddon(chosenRel) : await removeAddon(chosenRel));
      await reloadStatus(false);
    });
    setConsentOpen(false);
  };

  const postComment = async () => {
    if (!shot || !draft.trim()) return;
    setPosting(true);
    try {
      await createComment({
        anchor: { kind: "scene", scene: shot.scene || info?.scene || "", time: shot.time },
        body: draft.trim(),
        screenshotBase64: shot.png,
      });
      setDraft("");
      setShot(null);
      await refreshComments();
      setDrawer("notes");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setPosting(false);
    }
  };

  const { sent, send } = useSendAction(setProblem, errorText);

  const openCount = useMemo(
    () => comments.filter((c) => c.status !== "resolved").length,
    [comments],
  );
  const errors = useMemo(() => lines.filter((l) => l.level === "error"), [lines]);
  /** What the drawer's Errors tab lists: the warnings too. */
  const problems = useMemo(() => lines.filter((l) => l.level !== "info"), [lines]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = liveAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      typing: isTyping(e.target),
    });
    // Ctrl R is WebView2's reload, which would unload the pane. Typed into a
    // note it does nothing at all; anywhere else in the pane it is Record.
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "r") e.preventDefault();
    if (view.kind === "review") {
      if (action === "run-or-restart" && canRun) {
        e.preventDefault();
        void start();
      }
      return;
    }
    if (e.key.toLowerCase() === "c" && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      if (running && info?.captureReady) void doCapture();
      return;
    }
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case "run-or-restart":
        if (running) void doRestart();
        else if (canRun) void start();
        break;
      case "stop":
        if (running) void doStop();
        break;
      case "pause":
        if (running && info?.captureReady) void doPause();
        break;
      case "review":
        void stopAndReview();
        break;
      case "mark":
        if (running) void doMark();
        break;
      case "markup":
        void startLiveMarkup();
        break;
      case "record":
        toggleRecord();
        break;
      case "open-editor":
        // The editor is Editor mode's, in this pane (#316): the key goes there.
        props.modeSwitch.onChange("editor");
        break;
    }
  };

  const chip: ToolbarStatus =
    view.kind === "review"
      ? { tone: "info", label: "Reviewing" }
      : !info
        ? { tone: "idle", label: "Not running" }
        : info.state.kind === "running"
          ? paused
            ? { tone: "warning", label: "Paused" }
            : { tone: "success", label: "Playing" }
          : info.state.kind === "stopped"
            ? { tone: "idle", label: "Stopped" }
            : {
                tone: info.state.code ? "danger" : "idle",
                label: `Exited${info.state.code === null ? "" : ` (${info.state.code})`}`,
              };

  const needsAddon = "enable capture below, then restart the game.";
  const pauseTitle =
    running && !info?.captureReady
      ? `Pausing needs the capture addon - ${needsAddon}`
      : paused
        ? "Resume (F6)"
        : "Pause (F6)";

  const recording = take?.state === "recording";
  const recButton =
    take?.state === "saving" ? (
      <ToolbarButton disabled title="Review opens when the file is closed, about a second">
        Saving take…
      </ToolbarButton>
    ) : recordBlocked && !recording ? (
      // The fourth state (§5.1): disabled, with the reason as its title. Record
      // on with capture gone records nothing, so it shows as blocked too, but
      // stays clickable so that one click turns the setting off. A take
      // already going keeps its clock: removing the script does not stop it.
      <ToolbarButton
        disabled={!recordOn}
        title={
          recordOn
            ? `${recordBlocked} Record is on, but nothing is recorded until then. Click to turn Record off (Ctrl R).`
            : recordBlocked
        }
        onClick={toggleRecord}
      >
        <span className="pl-rec-ring pl-rec-ring--off" aria-hidden="true" />
        Record
      </ToolbarButton>
    ) : (
      <ToolbarButton
        pressed={recordOn}
        title={
          recordOn
            ? "Recording every run of this project. Click to stop recording (Ctrl R)"
            : "Record every run of this project (Ctrl R)"
        }
        onClick={toggleRecord}
      >
        <span className={`pl-rec-ring${recordOn ? " pl-rec-ring--on" : ""}`} aria-hidden="true" />
        {recordOn ? "Rec" : "Record"}
        {recording && take.startedAt !== null && (
          <span className="pl-rec-clock">{clock(now - take.startedAt)}</span>
        )}
      </ToolbarButton>
    );

  const embedded = session?.embed.kind === "embedded";
  const popped = session?.embed.kind === "poppedOut";

  const takeLabel = (t: ListedTake) => {
    const d = new Date(t.startedAt);
    return `Take ${t.number} · ${clock(t.durationMs)} · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  };

  const sceneList = scenes && scenes.rel === chosenRel ? scenes.list : [];
  const shownScene =
    running && info?.scene
      ? info.scene
      : picked && picked.rel === chosenRel
        ? picked.scene
        : undefined;
  const main = chosen?.mainScenePath ?? chosen?.mainScene;
  const scenePicker =
    sceneList.length > 0 ? (
      <select
        className="k-vtb__select"
        aria-label="Scene"
        value={shownScene ?? ""}
        disabled={running}
        title={
          running
            ? "The scene running now. Stop to choose another; Restart (F5) runs this one again."
            : "The scene Run (F5) plays"
        }
        onFocus={() => setPickerOpen(true)}
        onBlur={() => setPickerOpen(false)}
        onChange={(e) =>
          chosenRel !== undefined && setPicked({ rel: chosenRel, scene: e.target.value })
        }
      >
        {shownScene && !sceneList.includes(shownScene) && (
          <option value={shownScene}>{sceneLabel(shownScene, main)}</option>
        )}
        {sceneList.map((s) => (
          <option key={s} value={s}>
            {sceneLabel(s, main)}
          </option>
        ))}
      </select>
    ) : (
      <span className="pl-subject">{leaf(info?.scene ?? main) || "no scene"}</span>
    );

  // The environment first, as in every surface (DECISIONS X4): which checkout
  // a run, a take and a note belong to.
  const envChip = (
    <ToolbarEnvChip kind={status?.environment.kind} branch={status?.environment.branch} />
  );
  const picker =
    view.kind === "review" ? (
      <select
        className="k-vtb__select"
        aria-label="Take"
        value={view.take}
        onFocus={() => setPickerOpen(true)}
        onBlur={() => setPickerOpen(false)}
        onChange={(e) => setView({ kind: "review", take: e.target.value })}
      >
        {takes.map((t) => (
          <option key={t.id} value={t.id}>
            {takeLabel(t)}
          </option>
        ))}
        {!takes.some((t) => t.id === view.take) && <option value={view.take}>{view.take}</option>}
      </select>
    ) : (
      <span className="pl-pickers">
        {projects.length > 1 && (
          <select
            className="k-vtb__select"
            aria-label="Godot project"
            value={chosen?.rel ?? ""}
            disabled={running}
            onFocus={() => setPickerOpen(true)}
            onBlur={() => setPickerOpen(false)}
            onChange={(e) => setProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.rel} value={p.rel}>
                {p.name} ({p.rel})
              </option>
            ))}
          </select>
        )}
        {scenePicker}
      </span>
    );
  const subject = (
    <>
      {envChip}
      {picker}
    </>
  );

  const transport = (
    <>
      <ToolbarButton
        label={running ? "Restart" : "Run"}
        title={
          running
            ? "Restart (F5)"
            : canRun
              ? "Run the project (F5)"
              : "Nothing to run yet - see the message below."
        }
        disabled={!canRun}
        icon={
          running ? (
            <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <PlayIcon size={16} strokeWidth={1.5} aria-hidden="true" />
          )
        }
        onClick={() => void (running ? doRestart() : start())}
      />
      <ToolbarButton
        label={paused ? "Resume" : "Pause"}
        title={pauseTitle}
        disabled={!running || !info?.captureReady}
        icon={
          paused ? (
            <PlayIcon size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
          )
        }
        onClick={() => void doPause()}
      />
      <ToolbarButton
        label="Stop"
        title="Stop (Shift F5) - ends the game and everything it started"
        disabled={!running}
        icon={<Square size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void doStop()}
      />
    </>
  );

  // Keyed apart, so React does not reuse a review button for a live one: a
  // focused Back to live would otherwise become a focused Mark up, which
  // Enter then presses.
  const liveActions = (
    <Fragment key="live">
      {recButton}
      <ToolbarButton
        kbd="F8"
        disabled={!running}
        title="Drop a mark on the recording without stopping (F8)"
        icon={<Flag size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void doMark()}
      >
        Mark
      </ToolbarButton>
      <ToolbarButton
        disabled={!running || !info?.captureReady || marking !== null}
        title={
          running && !info?.captureReady
            ? `Mark up needs the capture addon - ${needsAddon}`
            : "Pause and draw on this frame (Ctrl Shift M)"
        }
        kbd="Ctrl Shift M"
        icon={<PenLine size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void startLiveMarkup()}
      >
        Mark up
      </ToolbarButton>
    </Fragment>
  );

  const reviewActions = (
    <Fragment key="review">
      <ToolbarButton
        kbd="F5"
        disabled={!canRun}
        title={
          recordOn
            ? "Run the game again (F5). Record is on, so the run is kept as a take."
            : "Run the game again (F5)"
        }
        icon={<PlayIcon size={14} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void start()}
      >
        Play again
      </ToolbarButton>
      <ToolbarButton onClick={() => setView({ kind: "live" })}>Back to live</ToolbarButton>
    </Fragment>
  );

  // Slot 5 is Pop out alone, always there. The editor is Editor mode's, and
  // Ctrl Shift O turns there.
  const canPop = view.kind === "live" && running && (embedded || popped);
  const leave = (
    <ToolbarButton
      label={popped ? "Dock into the pane" : "Pop out into its own window"}
      disabled={!canPop}
      title={
        canPop
          ? undefined
          : view.kind === "review"
            ? "Pop out is for the live game. Back to live first."
            : running
              ? "Pop out needs the game in the pane, and it is playing in its own window."
              : "Pop out needs a game in the pane. Run it first (F5)."
      }
      icon={
        popped ? (
          <Maximize2 size={16} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <PictureInPicture2 size={16} strokeWidth={1.5} aria-hidden="true" />
        )
      }
      onClick={() => void guarded(() => (popped ? dock() : popOut()))}
    />
  );

  const showNotices =
    problem !== null ||
    statusError !== null ||
    notice !== null ||
    (status !== null && !cloud && (!found || projects.length === 0));

  const hint = info
    ? "Waiting for the game to print something."
    : canRun
      ? "Press F5 to run the project. It plays here, in this pane."
      : "Nothing is running.";

  return (
    <div className="pl" ref={root} tabIndex={0} onKeyDown={onKeyDown}>
      <ViewerToolbar
        label="Godot"
        mode={props.modeSwitch}
        subject={subject}
        controls={view.kind === "live" ? transport : undefined}
        status={chip}
        actions={view.kind === "live" ? liveActions : reviewActions}
        leave={leave}
      />

      {/* Main and a cloud session are facts about the whole pane, so they are
          the one line under the bar, worded and placed as in Editor. */}
      {cloud ? (
        <ToolbarReason>
          This is a cloud session: its files are on the VM, not on this computer, so the game cannot
          run here. Open a local worktree to play it.
        </ToolbarReason>
      ) : (
        readOnly && (
          <ToolbarReason>
            This is the main checkout, which is read-only here. Play and Record still run; sending
            notes, enabling capture and Open in Godot need a worktree.
          </ToolbarReason>
        )
      )}

      {showNotices && (
        <div className="pl__notices">
          {problem && <p className="pl__notice pl__notice--error">{problem}</p>}
          {statusError && <p className="pl__notice pl__notice--error">{statusError}</p>}
          {notice && (
            <p className="pl__notice">
              {notice}{" "}
              <button type="button" className="pl__link" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </p>
          )}
          {status && !cloud && !found && (
            <p className="pl__notice">
              Godot 4 was not found.
              {status.executable.problems.length > 0 && ` ${status.executable.problems[0]}`} Set its
              path under Settings, Godot, or put it on PATH.{" "}
              <button type="button" className="pl__link" onClick={() => void reloadStatus(true)}>
                Check again
              </button>
            </p>
          )}
          {status && !cloud && projects.length === 0 && (
            <p className="pl__notice">
              No <code>project.godot</code> in this environment (looked four folders deep).
            </p>
          )}
          {chosen && chosen.engineMajor < 4 && (
            <p className="pl__notice">
              {chosen.name} is a Godot 3 project. Veistra drives Godot 4.x.
            </p>
          )}
        </div>
      )}

      {view.kind === "review" ? (
        <Review
          key={view.take}
          takeId={view.take}
          readOnly={readOnly}
          liveNotes={liveNotes}
          onLiveNotesTaken={onLiveNotesTaken}
          onPlayScene={(scene) =>
            void guarded(async () => {
              if (!recordOn && !recordBlocked) await setRecord(true, chosenRel);
              await start(scene);
            })
          }
          onProblem={setProblem}
          onNotice={setNotice}
          onDeleted={() => {
            setView({ kind: "live" });
            void loadTakes();
          }}
        />
      ) : (
        <div className="pl__body">
          <main className="pl__frame">
            <LiveView
              session={session}
              running={running}
              lines={lines}
              frameRect={frameRect}
              overlays={overlays}
              coveredHere={pickerOpen || consentOpen || shot !== null}
              marking={marking}
              hint={hint}
              onMarkupDone={(r, shown) => void doneLiveMarkup(r, shown)}
              onMarkupCancel={() => void endLiveMarkup(false)}
              onProblem={(m) => setProblem(m)}
            />
            {shot && (
              <div className="pl__composer">
                <div className="pl__composer-target">
                  <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
                  Comment at {formatPlayTime(shot.time)} in {shot.scene || "the running scene"}
                </div>
                <img
                  className="pl__shot"
                  alt="Captured frame"
                  src={`data:image/png;base64,${shot.png}`}
                  draggable={false}
                  title="Drag onto a terminal to send to the agent"
                  onPointerDown={dragContext(() => putShot(shot))}
                />
                <textarea
                  className="pl__composer-input"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="What's wrong with this moment?"
                  autoFocus
                />
                <div className="pl__composer-actions">
                  <button type="button" onClick={() => setShot(null)} disabled={posting}>
                    Discard
                  </button>
                  <button
                    type="button"
                    className="pl__composer-submit"
                    onClick={() => void postComment()}
                    disabled={posting || !draft.trim()}
                  >
                    {posting ? "Posting..." : "Comment"}
                  </button>
                </div>
              </div>
            )}
          </main>
          <LiveStrip
            session={session}
            running={running}
            recordOn={recordOn}
            recordBlocked={recordBlocked}
            errors={errors}
            now={now}
            canCapture={running && (info?.captureReady ?? false) && !capturing}
            onStopAndReview={() => void stopAndReview()}
            onCapture={() => void doCapture()}
          />
          <div className="pl-drawer">
            <div className="pl-drawer__bar">
              {(["output", "errors", "notes"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="pl-drawer__tab"
                  aria-expanded={drawer === d}
                  onClick={() => setDrawer((now) => (now === d ? "closed" : d))}
                >
                  {d === "output" ? "Output" : d === "errors" ? "Errors" : "Notes"}
                  {d === "output" && lines.length > 0 && (
                    <span className="pl-count">{lines.length}</span>
                  )}
                  {d === "errors" && problems.length > 0 && (
                    <span className={`pl-count${errors.length > 0 ? " pl-count--danger" : ""}`}>
                      {problems.length}
                    </span>
                  )}
                  {d === "notes" && openCount > 0 && <span className="pl-count">{openCount}</span>}
                </button>
              ))}
              {drawer === "closed" && lines.length > 0 && (
                <span className="pl-drawer__last">{lines[lines.length - 1].text}</span>
              )}
            </div>
            {drawer === "output" && (
              <div className="pl-drawer__body">
                <LogView lines={lines} hint={hint} />
              </div>
            )}
            {drawer === "errors" && (
              <div className="pl-drawer__body">
                <LogView lines={problems} hint="No errors or warnings." />
              </div>
            )}
            {drawer === "notes" && (
              <div className="pl-drawer__body">
                <CommentPanel
                  comments={comments}
                  loading={commentsLoading}
                  error={commentsError}
                  onResolve={async (id, note) => {
                    await resolveComment(id, note);
                    await refreshComments();
                  }}
                  onVerdict={async (id, verdict, reply) => {
                    await verdictComment(id, verdict, reply);
                    await refreshComments();
                  }}
                  emptyHint="No notes on this project yet. Record a run, mark it, and send notes from review."
                />
              </div>
            )}
          </div>
        </div>
      )}

      {consentOpen && chosen && (
        <div className="pl__consent" role="dialog" aria-label="Enable capture">
          <strong>Add capture to {chosen.name}?</strong>
          <ul>
            <li>
              One script, <code>addons/veistra/veistra_capture.gd</code>, and one autoload line in{" "}
              <code>{chosen.rel === "." ? "" : `${chosen.rel}/`}project.godot</code>.
            </li>
            <li>
              While the game runs from Veistra it writes scene data ten times a second: camera,
              player, and the screen boxes of nodes in view or in the <code>veistra_track</code>{" "}
              group.
            </li>
            <li>
              It sends F8 marks and F7 and Ctrl Shift M to Veistra through a temporary folder. No
              network port.
            </li>
            <li>It does nothing in an exported build. Remove it here at any time.</li>
          </ul>
          <div className="pl__composer-actions">
            <button type="button" onClick={() => setConsentOpen(false)}>
              Not now
            </button>
            <button
              type="button"
              className="pl__composer-submit"
              onClick={() => void changeAddon(true)}
            >
              Add to this project
            </button>
          </div>
        </div>
      )}

      <SendFooter
        trailing={
          <>
            {found && (
              <span className="pl__footer-time">
                Godot {found.version.split(".").slice(0, 2).join(".")}
              </span>
            )}
            {session?.addon && (
              <span className="pl__footer-time">Capture addon v{session.addon}</span>
            )}
            {chosen && addon && !readOnly && (
              <button
                type="button"
                className="pl__footer-btn"
                onClick={() =>
                  addon.addon === "yes" ? void changeAddon(false) : setConsentOpen(true)
                }
                title={
                  addon.addon === "yes"
                    ? "Remove the capture script and its project.godot line."
                    : addon.addon === "partial"
                      ? "Update the capture script."
                      : "Add the capture script so Play can record, mark, pause and capture the game."
                }
              >
                {addon.addon === "yes"
                  ? "Disable capture"
                  : addon.addon === "partial"
                    ? "Update capture"
                    : "Enable capture"}
                {addon.needsRestart ? " (restart the game)" : ""}
              </button>
            )}
            {view.kind === "live" && takes.length > 0 && (
              <button
                type="button"
                className="pl__footer-btn"
                onClick={() => openReview(takes[0].id)}
                title="Open the latest take for review"
              >
                <Camera size={13} strokeWidth={1.5} aria-hidden="true" />
                Takes · {takes.length}
              </button>
            )}
          </>
        }
      >
        <SendButton
          label="Send log"
          sent={sent === "log"}
          disabled={lines.length === 0}
          title="Send the last lines of the game's output to the agent, or drag this onto a terminal"
          onClick={() => void send("log", "log", () => putLog(lines, info?.scene ?? null))}
          onPointerDown={dragContext(() => putLog(lines, info?.scene ?? null))}
        />
        {shot && (
          <SendButton
            label="Send frame"
            sent={sent === "frame"}
            title="Send the captured frame to the agent, or drag this onto a terminal"
            onClick={() => void send("frame", "frame", () => putShot(shot))}
            onPointerDown={dragContext(() => putShot(shot))}
          />
        )}
      </SendFooter>
    </div>
  );
}
