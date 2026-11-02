/**
 * Play: run the environment's game inside this pane, record runs as takes,
 * mark them, review them and send the notes to an agent (design "Play, Scene
 * and Blender views", §3 to §10).
 *
 * Two views share the toolbar: live, with the game over the pane and the live
 * strip under it, and review, of one take. Where the game cannot be placed
 * (no embedder on this platform, or no window came) it runs in its own window
 * and the pane shows its log, as Play always did; nothing else changes.
 *
 * One poll loop drives the live view: `play/state` every half second, with a
 * cursor for the log and one for the keys the addon handled (F7 stops and
 * opens review; Ctrl Shift M marks up the live frame).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OPENED_EVENT, on, openIn, reportPainted } from "@veistra/bridge";
import {
  Camera,
  ExternalLink,
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
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  verdictComment,
  formatPlayTime,
  type Comment,
} from "../../../shared/comments";
import { errorText, getStatus, openInGodot, type GodotStatus } from "../../../shared/godot";
import { blobBase64, sendMarkup } from "../../../shared/markupFlow";
import { SendButton, SendFooter, useSendAction } from "../../../shared/SendFooter";
import {
  ToolbarButton,
  ToolbarChip,
  ViewerToolbar,
  type ToolbarStatus,
} from "../../../shared/ViewerToolbar";
import { clock } from "./frames";
import { isWindowRect, overlayRects, type WindowRect } from "./geometry";
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
import "./App.css";

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

/** Why a run that ended has no take: Record off, unable to record, or never in the pane. */
function notRecorded(recordOn: boolean, blocked: string | null): string {
  if (blocked) return `This run was not recorded. ${blocked}`;
  if (recordOn)
    return "Nothing was recorded: a take starts once the game's window is in the pane, and this run's never got there.";
  return "This run was not recorded, so there is no take to review. Turn on Record.";
}

/** The excalidraw pins of a markup, with where each sits on the shown frame. */
function pinCentres(json: MarkupExport["json"]): { n: number; x: number; y: number }[] {
  const out: { n: number; x: number; y: number }[] = [];
  for (const el of json.excalidraw.elements as Array<Record<string, unknown>>) {
    const v = (el.customData as { veistra?: { kind?: string; n?: number } } | undefined)?.veistra;
    if (v?.kind !== "pin" || typeof v.n !== "number") continue;
    const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(el[k]) || 0);
    out.push({ n: v.n, x: x + w / 2, y: y + h / 2 });
  }
  return out;
}

export default function App() {
  const [status, setStatus] = useState<GodotStatus | null>(null);
  const [project, setProject] = useState<string | undefined>(undefined);
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
  const [frameRect, setFrameRect] = useState<WindowRect | null>(null);
  const [overlays, setOverlays] = useState<WindowRect[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [marking, setMarking] = useState<
    (LiveMarking & { atWall: number; wasPaused: boolean }) | null
  >(null);
  const [liveNotes, setLiveNotes] = useState<LiveNote[]>([]);
  const [drawer, setDrawer] = useState<Drawer>("closed");
  const [now, setNow] = useState(() => Date.now());
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
  const found = status?.executable.found ?? null;
  const projects = status?.projects ?? [];
  const chosen = projects.find((p) => p.rel === project) ?? projects[0] ?? null;
  const chosenRel = chosen?.rel;
  projectRel.current = chosenRel;
  const running = info?.state.kind === "running";
  const paused = running && info?.paused === true;
  const canRun = found !== null && chosen !== null && chosen.engineMajor >= 4;
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

  const loadStatus = useCallback(async (refresh: boolean) => {
    try {
      setStatus(await getStatus(refresh));
      setProblem(null);
    } catch (e) {
      setProblem(errorText(e));
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

  useEffect(() => {
    void loadStatus(false);
    void refreshComments();
    void loadTakes();
    reportPainted();
  }, [loadStatus, refreshComments, loadTakes]);

  useEffect(() => {
    if (chosenRel !== undefined) void loadAddon(chosenRel);
  }, [chosenRel, loadAddon]);

  // Where this iframe is in the window, and what the shell draws over it.
  useEffect(() => {
    const offRect = on("veistra/window-rect", (p) => {
      if (isWindowRect(p)) setFrameRect(p);
    });
    const offOverlays = on("veistra/overlays", (p) => setOverlays(overlayRects(p)));
    return () => {
      offRect();
      offOverlays();
    };
  }, []);

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
        const s = await run(projectRel ?? chosenRel, scene);
        setInfo(s.run);
        setLive(s.live ?? null);
        setShot(null);
        setMarking(null);
        setView({ kind: "live" });
      }),
    [chosenRel, guarded],
  );

  // Play scene, from the Godot viewer: it opens this app with the scene and
  // the project the viewer has chosen. A `res://` path means nothing without
  // its project, so in an environment holding several, running it against
  // whichever project this pane last picked would play the wrong game.
  useEffect(
    () =>
      on(OPENED_EVENT, (p) => {
        const { scene, project: rel } = (p ?? {}) as { scene?: unknown; project?: unknown };
        if (typeof scene !== "string" || !scene.startsWith("res://")) return;
        const projectRel = typeof rel === "string" && rel !== "" ? rel : undefined;
        if (projectRel !== undefined) setProject(projectRel);
        void start(scene, projectRel);
      }),
    [start],
  );

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
      const sx = m.natural.width > 0 ? m.natural.width / shown.width : 1;
      const sy = m.natural.height > 0 ? m.natural.height / shown.height : 1;
      let target: Target | null = null;
      const json = result.json;
      for (const p of pinCentres(json)) {
        try {
          const { hit } = await pick(p.x * sx, p.y * sy);
          if (!hit) continue;
          const pin = json.pins.find((x) => x.n === p.n);
          const wp = hit.worldPoint;
          if (pin) {
            pin.nodePath = hit.nodePath;
            if (wp && wp.length === 3) pin.worldPoint = [wp[0], wp[1], wp[2]];
          }
          target ??= { ...hit, nodePath: hit.nodePath, source: "pick" };
        } catch {
          // A pick that fails leaves that pin bare; the picture still says it.
        }
      }
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
    [marking, take, session, guarded, info, endLiveMarkup],
  );

  actions.current = {
    run: info?.id ?? null,
    review: () => void stopAndReview(),
    markup: () => void startLiveMarkup(),
  };

  const canEnableCapture = addon !== null && addon.addon !== "yes" && !readOnly;

  /** Record, and the blocked Record: off and blocked offers Enable capture; on, it always turns off. */
  const toggleRecord = useCallback(() => {
    if (!recordOn && recordBlocked) {
      if (canEnableCapture) setConsentOpen(true);
      else setProblem(recordBlocked);
      return;
    }
    void guarded(async () => {
      await setRecord(!recordOn, chosenRel);
      setLive((l) => (l ? { ...l, record: { ...l.record, on: !recordOn } } : l));
    });
  }, [recordOn, recordBlocked, canEnableCapture, guarded, chosenRel]);

  const onLiveNotesTaken = useCallback(
    (id: string) => setLiveNotes((notes) => notes.filter((n) => n.take !== id)),
    [],
  );

  const doOpenEditor = useCallback(
    () => guarded(() => openInGodot(chosenRel)),
    [chosenRel, guarded],
  );

  const changeAddon = async (install: boolean) => {
    await guarded(async () => {
      setAddon(install ? await installAddon(chosenRel) : await removeAddon(chosenRel));
      await loadStatus(false);
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const action = liveAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      typing: isTyping(e.target),
    });
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
        if (found && chosen && !readOnly) void doOpenEditor();
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
      // Record on with capture gone records nothing, so it shows as blocked
      // too (§5.1), and its click turns the setting off. A take already
      // going keeps its clock: removing the script does not stop it.
      <ToolbarButton
        title={
          recordOn
            ? `${recordBlocked} Record is on, but nothing is recorded until then. Click to turn Record off (Ctrl R).`
            : canEnableCapture
              ? `${recordBlocked} Click to enable capture.`
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

  const subject =
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
    ) : projects.length > 1 ? (
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
    ) : (
      <span className="pl-subject">
        {leaf(info?.scene ?? chosen?.mainScenePath ?? chosen?.mainScene) || "no scene"}
      </span>
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

  const liveActions = (
    <>
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
        icon={<PenLine size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void startLiveMarkup()}
      >
        Mark up
      </ToolbarButton>
    </>
  );

  const reviewActions = (
    <>
      <ToolbarButton
        kbd="F5"
        disabled={!canRun}
        title="Run the game again (F5)"
        icon={<PlayIcon size={14} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void start()}
      >
        Play again
      </ToolbarButton>
      {recordOn && <ToolbarChip tone="danger" label="Record on" />}
      <ToolbarButton onClick={() => setView({ kind: "live" })}>Back to live</ToolbarButton>
    </>
  );

  const leave = (
    <>
      {view.kind === "live" && running && (embedded || popped) && (
        <ToolbarButton
          label={popped ? "Dock into the pane" : "Pop out into its own window"}
          icon={
            popped ? (
              <Maximize2 size={16} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <PictureInPicture2 size={16} strokeWidth={1.5} aria-hidden="true" />
            )
          }
          onClick={() => void guarded(() => (popped ? dock() : popOut()))}
        />
      )}
      <ToolbarButton
        label="Open in Godot (Ctrl Shift O)"
        disabled={!found || !chosen || readOnly}
        title={
          readOnly
            ? "The default branch is read-only; open a worktree to edit."
            : found
              ? "Open this project in the Godot editor (Ctrl Shift O)"
              : "Godot 4 was not found."
        }
        icon={<ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void doOpenEditor()}
      />
    </>
  );

  const showNotices =
    problem !== null ||
    notice !== null ||
    (status !== null && (!found || projects.length === 0 || readOnly));

  const hint = info
    ? "Waiting for the game to print something."
    : canRun
      ? "Press F5 to run the project. It plays here, in this pane."
      : "Nothing is running.";

  return (
    <div className="pl" tabIndex={0} onKeyDown={onKeyDown}>
      <ViewerToolbar
        label="Godot"
        mode={{
          value: "play",
          options: [
            { value: "scene", label: "Scene" },
            { value: "play", label: "Play" },
          ],
          onChange: (v) => {
            if (v === "scene") void openIn("godot-viewer", { scene: info?.scene ?? undefined });
          },
        }}
        subject={subject}
        controls={view.kind === "live" ? transport : undefined}
        status={chip}
        actions={view.kind === "live" ? liveActions : reviewActions}
        leave={leave}
      />

      {showNotices && (
        <div className="pl__notices">
          {problem && <p className="pl__notice pl__notice--error">{problem}</p>}
          {notice && (
            <p className="pl__notice">
              {notice}{" "}
              <button type="button" className="pl__link" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </p>
          )}
          {status && !found && (
            <p className="pl__notice">
              Godot 4 was not found.
              {status.executable.problems.length > 0 && ` ${status.executable.problems[0]}`} Set its
              path under Settings, Godot, or put it on PATH.{" "}
              <button type="button" className="pl__link" onClick={() => void loadStatus(true)}>
                Check again
              </button>
            </p>
          )}
          {status && projects.length === 0 && (
            <p className="pl__notice">
              No <code>project.godot</code> in this environment (looked four folders deep).
            </p>
          )}
          {chosen && chosen.engineMajor < 4 && (
            <p className="pl__notice">
              {chosen.name} is a Godot 3 project. Veistra drives Godot 4.x.
            </p>
          )}
          {readOnly && (
            <p className="pl__notice">
              This is the main checkout, which is read-only here. Play and Record still run; sending
              notes, enabling capture and Open in Godot need a worktree.
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
                  {d === "errors" && errors.length > 0 && (
                    <span className="pl-count pl-count--danger">{errors.length}</span>
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
                <LogView
                  lines={lines.filter((l) => l.level !== "info")}
                  hint="No errors or warnings."
                />
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
                      ? "Update the capture script to version 2."
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
