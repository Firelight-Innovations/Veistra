/**
 * Reviewing a take (design §8): the video, the timeline, the notes, and Send.
 *
 * The take is served through the asset protocol (`play/take` hands back the
 * URLs), so the `<video>` seeks by range request and frames drawn from it can
 * be read back. Three video elements share the file and never fight: the one
 * the person watches, one that makes the filmstrip, and one that makes Send's
 * pictures. Drafts are written to the take's `notes.json` as the person
 * types, a moment after they stop, so a note survives a reload; Send and
 * leaving the take write them at once. The page's writes go one after
 * another, and none runs while Send does, so an older copy never lands on
 * top of the stamps Send writes.
 *
 * Send (§9) is in the page because the pictures are: each note's frames and
 * contact sheet are drawn here and handed to `play/send` in one call (a
 * ticked clip is cut by Rust). Then `packet.md` becomes a context item and
 * goes to the one agent SEND TO names, as one line left at its prompt, never
 * sent (X8). Each comment keeps that agent as `sentTo` (X7); `notes_sent`
 * counts the Send.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@veistra/bridge";
import { Pause, Play as PlayIcon, SkipBack, SkipForward, PenLine } from "lucide-react";
import type { MarkupExport } from "@veistra/markup/layer";
import { useCommentsChanged } from "../../../../shared/commentEvents";
import {
  takeHistory,
  verdictComment,
  type Comment,
  type Verdict,
} from "../../../../shared/comments";
import {
  contextKey,
  handToAgent,
  listAgents,
  type AgentTarget,
  type ContextRef,
  type Delivery,
} from "../../../../shared/context";
import { blobBase64 } from "../../../../shared/markupFlow";
import { errorText } from "../../../../shared/godot";
import { track } from "../../../../shared/telemetry";
import { clock, contactSheet, contactTimes, filmstrip, grab, STRIP_EVERY_MS } from "./frames";
import { reviewAction, isTyping } from "./keys";
import {
  addNote,
  checkedOf,
  dismissMark,
  markSent,
  noteName,
  normalize,
  pendingMarks,
  removeNote,
  sendable,
  settledRange,
  updateNote,
  noteStatus,
  packetMessage,
  parseLog,
  withIn,
  withOut,
  NO_RANGE,
  type LogRow,
  type NoteDraft,
  type NotesDoc,
  type PendingRange,
  type Target,
} from "./notes";
import { agentKey, NotesPanel, type SendOptions } from "./NotesPanel";
import { getTake, listNotes, saveNotes, sendNotes, deleteTake, type TakeDetail } from "./rpc";
import { nearestTick, parseTicks, recordedTarget, frameSeries, type Tick } from "./telemetry";
import { Timeline } from "./Timeline";

const FrameMarkup = lazy(() => import("./FrameMarkup"));

/** How long after the last keystroke drafts are written. */
const SAVE_AFTER_MS = 600;
/** How often notes that went to an agent are checked for news. */
const STATUS_POLL_MS = 2_000;

/** Where a new note came from, as `note_created` reports it. */
export type NoteFrom = "key" | "button" | "mark" | "markup" | "live";

/** A note was made: one usage event, its kind and where from, never its words. */
export function reportNote(kind: NoteDraft["kind"], from: NoteFrom): void {
  track("note_created", { kind, from });
}

/** A note made by live mark up during the run, folded into the take when it opens. */
export interface LiveNote {
  /** The take that was recording; only that take's review folds the note in. */
  take: string;
  atMs: number;
  body: string;
  markup: NoteDraft["markup"];
  markupPng: string | null;
  target: Target | null;
}

export interface ReviewProps {
  takeId: string;
  readOnly: boolean;
  liveNotes: LiveNote[];
  /** This take's live notes are in its notes now; the caller lets go of them. */
  onLiveNotesTaken: (take: string) => void;
  onPlayScene: (scene?: string) => void;
  /**
   * Still broken on a fixed note: Play mode gives the verdict and runs the
   * scene again to record a take for it (#321). Unset, the verdict alone.
   */
  onStillBroken?: (comment: Comment, reply?: string) => void;
  onProblem: (message: string | null) => void;
  onDeleted: () => void;
  onNotice: (message: string) => void;
  /**
   * When the person asked for this take (F7's own time, or the click's), so
   * the page can say how long review took to show its first frame.
   */
  openedAt?: number;
}

function useVideoRef() {
  return useRef<HTMLVideoElement | null>(null);
}

async function text(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

/**
 * One note as `play/send` takes it, with its pictures drawn from `video`: the
 * frame, the in and out frames of a range, and the contact sheet when
 * `contact` is on, with the times on it. A take with no video sends the
 * picture live mark up kept, and nothing drawn.
 */
async function notePayload(
  note: NoteDraft,
  video: HTMLVideoElement | null,
  contact: boolean,
  durationMs: number,
) {
  const at = async (ms: number | undefined) =>
    video && ms !== undefined ? blobBase64(await grab(video, ms)) : undefined;
  const frame = await at(note.atMs);
  const ranged = note.kind === "range" && note.inMs !== undefined && note.outMs !== undefined;
  const times = contactTimes(note.inMs ?? note.atMs, note.outMs ?? note.atMs, durationMs);
  const sheet =
    video && contact && times.length > 0
      ? await blobBase64(await contactSheet(video, times))
      : undefined;
  return {
    n: note.n,
    kind: note.kind,
    atMs: note.atMs,
    inMs: note.inMs,
    outMs: note.outMs,
    body: note.body,
    target: note.target ?? null,
    markup: note.markup ?? null,
    doneWhen: note.doneWhen?.trim() || undefined,
    images: {
      markupPng: note.markupPng ?? frame,
      notePng: frame,
      inPng: ranged ? await at(note.inMs) : undefined,
      outPng: ranged ? await at(note.outMs) : undefined,
      contactPng: sheet,
    },
    contactMs: sheet ? times : undefined,
    followUp: note.followUp,
  };
}

export default function Review(props: ReviewProps) {
  const { takeId, onProblem } = props;
  const [detail, setDetail] = useState<TakeDetail | null>(null);
  const [doc, setDoc] = useState<NotesDoc | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [range, setRange] = useState<PendingRange>(NO_RANGE);
  const [selected, setSelected] = useState<number | null>(null);
  const [marking, setMarking] = useState<{ url: string; n: number } | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [options, setOptions] = useState<SendOptions>({ contact: true, clip: false });
  const [agents, setAgents] = useState<AgentTarget[]>([]);
  /** The agent the person picked in SEND TO; unset, the listing's first. */
  const [picked, setPicked] = useState<string | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  /** The player can show a frame, so the filmstrip's seeks may start. */
  const [playerReady, setPlayerReady] = useState(false);
  /** How long review took to show its first frame, once it has. */
  const [openMs, setOpenMs] = useState<number | null>(null);
  const video = useVideoRef();
  const grabber = useVideoRef();
  const root = useRef<HTMLDivElement | null>(null);
  /** The newest notes, ahead of the render: a write must never take an older copy. */
  const docRef = useRef<NotesDoc | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The page's writes of `notes.json`, chained so they land in the order asked. */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const sendingNow = useRef(false);
  const liveTaken = useRef(false);

  const take = detail?.take ?? null;
  const duration = take?.durationMs ?? 0;
  const fps = take?.video.fps || 30;
  // A Still broken draft goes back to the agent its note was sent to, unless
  // the person picks another; that agent gone, the default as for any note.
  const checking = doc?.notes.find((n) => n.followUp && !n.commentId);
  const sentTo = checking ? checkedOf(checking, comments)?.sentTo : undefined;
  const agent =
    agents.find((a) => agentKey(a) === picked) ??
    (sentTo ? agents.find((a) => agentKey(a) === agentKey(sentTo)) : undefined) ??
    agents[0] ??
    null;

  const commit = useCallback((next: NotesDoc | null) => {
    docRef.current = next;
    setDoc(next);
  }, []);

  const keepFailed = useCallback(
    (e: unknown) => onProblem(`Couldn't keep the notes: ${errorText(e)}`),
    [onProblem],
  );

  /**
   * Write the newest notes now, after any write already on its way, and
   * settle once every write asked for so far has landed. Safe to call when
   * nothing changed: it only waits. A write that fails leaves the notes
   * dirty, so the next flush tries again.
   */
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const d = docRef.current;
    if (d && dirty.current) {
      dirty.current = false;
      saving.current = saving.current
        .catch(() => undefined)
        .then(() => saveNotes(takeId, d))
        .catch((e: unknown) => {
          dirty.current = true;
          throw e;
        });
    }
    return saving.current;
  }, [takeId]);

  /** A change the person made: kept now, written a moment after the last one. */
  const edit = useCallback(
    (next: NotesDoc) => {
      dirty.current = true;
      commit(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = undefined;
        // A Send under way writes the notes itself when it finishes.
        if (!sendingNow.current) flush().catch(keepFailed);
      }, SAVE_AFTER_MS);
    },
    [commit, flush, keepFailed],
  );

  const change = useCallback(
    (fn: (d: NotesDoc) => NotesDoc) => {
      const d = docRef.current;
      if (d) edit(fn(d));
    },
    [edit],
  );

  // Leaving the take (Back to live, another take, Play again) writes what
  // the debounce has not yet.
  useEffect(
    () => () => {
      if (!sendingNow.current) flush().catch(keepFailed);
    },
    [flush, keepFailed],
  );

  // Load the take, its notes, telemetry and log.
  useEffect(() => {
    let live = true;
    setDetail(null);
    commit(null);
    setSelected(null);
    setThumbs([]);
    getTake(takeId)
      .then(async (d) => {
        if (!live) return;
        setDetail(d);
        commit(normalize(d.notes));
        const [tele, logText] = await Promise.all([text(d.urls.telemetry), text(d.urls.log)]);
        if (!live) return;
        setTicks(parseTicks(tele));
        setLog(parseLog(logText));
      })
      .catch((e: unknown) => onProblem(`Couldn't open the take: ${errorText(e)}`));
    return () => {
      live = false;
    };
  }, [takeId, onProblem, commit]);

  // Who Send can go to, read when the take opens and again whenever the
  // window comes back, since agents start and stop in other panes.
  const refreshAgents = useCallback(() => {
    listAgents().then(setAgents, () => setAgents([]));
  }, []);
  useEffect(() => {
    refreshAgents();
    window.addEventListener("focus", refreshAgents);
    return () => window.removeEventListener("focus", refreshAgents);
  }, [refreshAgents, takeId]);

  // Notes made by live mark up during this take's run join it once it opens.
  // They are written at once: the caller has let go of its copy.
  const { liveNotes, onLiveNotesTaken } = props;
  useEffect(() => {
    const mine = liveNotes.filter((n) => n.take === takeId);
    if (!doc || liveTaken.current || mine.length === 0) return;
    liveTaken.current = true;
    let next = doc;
    for (const n of mine) {
      next = addNote(next, Math.min(Math.max(0, n.atMs), duration), null, {
        body: n.body,
        markup: n.markup,
        markupPng: n.markupPng,
        target: n.target,
      }).doc;
    }
    edit(next);
    onLiveNotesTaken(takeId);
    flush().catch(keepFailed);
  }, [doc, liveNotes, onLiveNotesTaken, duration, takeId, edit, flush, keepFailed]);

  // Review's keys work as soon as it opens. Focus is taken only from the pane
  // itself (F7 there) or from nothing (the button that opened review is
  // gone); a control that has it, the Take menu among them, keeps it.
  const ready = detail !== null && doc !== null;
  useEffect(() => {
    const el = root.current;
    const active = document.activeElement;
    if (ready && el && (!active || active.contains(el))) el.focus({ preventScroll: true });
  }, [ready]);

  // The notes Send filed. A change to one of this take's is pushed, so an
  // agent's fix shows at once; the poll while any could still change is the
  // fallback for a push that never came.
  const refreshComments = useCallback(async () => {
    try {
      setComments((await listNotes(takeId)).notes);
    } catch {
      // A failed poll is tried again on the next tick.
    }
  }, [takeId]);
  useCommentsChanged((changes) => {
    if (changes.some((c) => c.take === takeId)) void refreshComments();
  });
  const waiting =
    doc?.notes.some((n) => {
      const s = noteStatus(n, comments);
      return s !== "draft" && s !== "resolved";
    }) ?? false;
  useEffect(() => {
    void refreshComments();
    if (!waiting) return;
    const timer = setInterval(() => void refreshComments(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshComments, waiting]);

  // The filmstrip, made by a video of its own so the player is never moved.
  // It starts once the player can play: a seek every 2 s of the take, all on
  // the same file, would otherwise compete with the first frame review waits for.
  useEffect(() => {
    if (!detail || duration <= 0 || !playerReady) return;
    let cancelled = false;
    const strip = document.createElement("video");
    strip.crossOrigin = "anonymous";
    strip.muted = true;
    strip.preload = "auto";
    strip.src = detail.urls.video;
    strip.addEventListener(
      "loadeddata",
      () => {
        void filmstrip(
          strip,
          duration,
          (i, url) => {
            if (!cancelled) setThumbs((t) => Object.assign([...t], { [i]: url }));
          },
          STRIP_EVERY_MS,
          96,
          () => cancelled,
          aspect,
        ).catch(() => undefined);
      },
      { once: true },
    );
    return () => {
      cancelled = true;
      strip.removeAttribute("src");
      strip.load();
    };
  }, [detail, duration, playerReady, aspect]);

  // Review is open once its first frame shows (a take with no video: once
  // it renders). Kept on the root as `data-open-ms`, for spec test 5.
  const { openedAt } = props;
  const openedOnce = useRef(false);
  const opened = useCallback(() => {
    if (openedAt === undefined || openedOnce.current) return;
    openedOnce.current = true;
    const ms = Math.max(0, Date.now() - openedAt);
    setOpenMs(ms);
    console.info(`veistra: review of take ${takeId} opened in ${ms} ms`);
  }, [openedAt, takeId]);
  const noVideo = detail !== null && !detail.take.hasVideo;
  useEffect(() => {
    if (noVideo && doc) opened();
  }, [noVideo, doc, opened]);

  // The playhead follows the video while it plays.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const step = () => {
      const v = video.current;
      if (v) setPlayhead(v.currentTime * 1000);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, video]);

  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.min(Math.max(0, ms), Math.max(0, duration));
      setPlayhead(clamped);
      if (video.current) video.current.currentTime = clamped / 1000;
    },
    [duration, video],
  );

  const pause = useCallback(() => {
    video.current?.pause();
    setPlaying(false);
  }, [video]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      void v
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    } else {
      pause();
    }
  }, [pause, video]);

  const select = useCallback(
    (n: number) => {
      const note = doc?.notes.find((x) => x.n === n);
      setSelected(n);
      if (note) {
        pause();
        seekTo(note.atMs);
      }
    },
    [doc, pause, seekTo],
  );

  /**
   * A note at `at`, over `over` when that is a range (a pending I/O range is
   * used up by it), reported as made `from` there. A mark's note passes no
   * range, so a range set for something else stays for it.
   */
  const newNote = useCallback(
    (
      at: number,
      from: NoteFrom,
      extra: Partial<NoteDraft> = {},
      over: { inMs: number; outMs: number } | null = settledRange(range),
    ) => {
      const d = docRef.current;
      if (!d) return;
      const atMs = over && (at < over.inMs || at > over.outMs) ? (over.inMs + over.outMs) / 2 : at;
      const made = addNote(d, atMs, over, extra);
      edit(made.doc);
      setSelected(made.note.n);
      if (over) setRange(NO_RANGE);
      pause();
      reportNote(made.note.kind, from);
      return made.note;
    },
    [range, pause, edit],
  );

  const tickAt = useCallback(
    (ms: number) => (take ? nearestTick(ticks, take.startedAt + ms) : null),
    [ticks, take],
  );

  /**
   * Mark up the frame at the playhead: the selected draft's when the playhead
   * is on it, else a new note there (over the pending range only if that
   * holds the playhead, so the frame drawn on is the one on screen).
   */
  const startMarkup = useCallback(async () => {
    const v = video.current;
    if (!v || !doc) return;
    pause();
    const current = doc.notes.find(
      (n) => n.n === selected && !n.commentId && Math.abs(playhead - n.atMs) < 1000 / fps,
    );
    const r = settledRange(range);
    const holds = r && playhead >= r.inMs && playhead <= r.outMs ? r : null;
    const note = current ?? newNote(playhead, "markup", {}, holds);
    if (!note) return;
    try {
      const png = await grab(v, note.atMs);
      setMarking({ url: URL.createObjectURL(png), n: note.n });
    } catch (e) {
      onProblem(`Couldn't take the frame: ${errorText(e)}`);
    }
  }, [doc, selected, playhead, fps, range, newNote, pause, onProblem, video]);

  const endMarkup = useCallback(() => {
    setMarking((m) => {
      if (m) URL.revokeObjectURL(m.url);
      return null;
    });
  }, []);

  const doneMarkup = useCallback(
    async (result: MarkupExport) => {
      const m = marking;
      if (!m || !doc) return;
      const note = doc.notes.find((n) => n.n === m.n);
      const tick = note ? tickAt(note.atMs) : null;
      const pinned = result.json.pins.find((p) => p.nodePath);
      const target: Target | null = pinned?.nodePath
        ? {
            nodePath: pinned.nodePath,
            type: tick?.nodes.find((x) => x.path === pinned.nodePath)?.type,
            worldPoint: pinned.worldPoint ?? null,
            source: "recorded",
          }
        : (note?.target ?? null);
      const words = result.json.pins
        .map((p) => p.note)
        .filter(Boolean)
        .join("\n");
      const markupPng = await blobBase64(result.png);
      change((d) =>
        updateNote(d, m.n, {
          markup: result.json,
          markupPng,
          target,
          ...(note && !note.body.trim() && words ? { body: words } : {}),
        }),
      );
      endMarkup();
    },
    [marking, doc, tickAt, change, endMarkup],
  );

  const { onNotice } = props;
  const clipUnavailable = detail?.clipUnavailable ?? null;
  const send = useCallback(
    async (options: SendOptions, to: AgentTarget | null) => {
      const d = docRef.current;
      if (!d || !take || sendingNow.current) return;
      const notes = sendable(d);
      if (notes.length === 0) return;
      const v = take.hasVideo ? grabber.current : null;
      const bare = v ? undefined : notes.find((n) => !n.markupPng);
      if (bare) {
        onProblem(
          `This take has no video, so note ${bare.n} has no frame to send. Only a note marked up during the run has a picture of its own.`,
        );
        return;
      }
      const clip = options.clip && v !== null && clipUnavailable === null;
      // From here until `finally` no write of the notes starts but Send's own.
      sendingNow.current = true;
      setSending(true);
      onProblem(null);
      try {
        // What is sent is on disk first: `play/send` stamps the notes it finds there.
        await flush();
        const payload = [];
        for (const note of notes)
          payload.push(await notePayload(note, v, options.contact, duration));
        // Nothing picked and none listed yet (Ctrl Enter as the take opens):
        // the default is asked for now rather than told to nobody.
        const target = to ?? (await listAgents().catch(() => []))[0] ?? null;
        const sent = await sendNotes(takeId, payload, { clip, sentTo: target });
        // The page's copy is stamped the same way rather than read back from
        // disk, which would drop anything typed while Send ran.
        commit(markSent(docRef.current ?? d, sent.comments, sent.packet));
        const count = `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
        const still = notes.filter((n) => n.followUp).length;
        const checked = notes.length === 1 && still === 1 ? checkedOf(notes[0], comments) : null;
        const first = checked ? takeHistory(checked)[0] : undefined;
        const item = await invoke<ContextRef>("context/put", {
          key: contextKey("play", takeId, "feedback"),
          kind: "file",
          title: first
            ? `Still broken: ${noteName(first)}, with Take ${take.number}. Read packet.md first.`
            : `Playtest feedback: ${count}${still > 0 ? `, ${still} still broken` : ""}. Read packet.md first.`,
          label: `Play - take ${take.number} feedback`,
          path: sent.packetMd,
          // The person sees one chip; this is what the agent reads with it.
          prompt: packetMessage(notes.length, still, `${sent.packet}/packet.md`),
        });
        // The one chip, to the one agent chosen and nowhere else.
        const delivery: Delivery = target
          ? await handToAgent(target, item.id, `Take ${take.number} feedback`).catch(
              (e: unknown) => ({ delivered: false as const, reason: errorText(e) }),
            )
          : { delivered: false, reason: "no agent is running here" };
        track("notes_sent", {
          notes: notes.length,
          ranged: notes.filter((n) => n.kind === "range").length,
          markedUp: notes.filter((n) => n.markup).length,
          contact: options.contact && v !== null,
          clip,
          to: target?.kind ?? "none",
          delivered: delivery.delivered,
          // Only on a Send with a Still broken note in it (X1), so earlier counts read the same.
          ...(still > 0 ? { followUp: true } : {}),
        });
        await refreshComments();
        onNotice(
          [
            `Sent ${count}: ${sent.packet}/packet.md.`,
            delivery.delivered
              ? `It is waiting at ${target?.label ?? "the agent"}'s prompt; press Enter there to send it.`
              : `No agent was told: ${delivery.reason}. The packet is in the context strip.`,
            ...(sent.problems ?? []),
          ].join(" "),
        );
      } catch (e) {
        onProblem(`Couldn't send the notes: ${errorText(e)}`);
      } finally {
        sendingNow.current = false;
        setSending(false);
        // Edits made while sending were held back. They go now, stamped, even
        // if the person has left the take since.
        if (dirty.current) flush().catch(keepFailed);
      }
    },
    [
      take,
      duration,
      takeId,
      comments,
      clipUnavailable,
      onProblem,
      onNotice,
      refreshComments,
      grabber,
      flush,
      commit,
      keepFailed,
    ],
  );

  const verdict = useCallback(
    async (id: string, v: Verdict, reply?: string) => {
      try {
        await verdictComment(id, v, reply);
        await refreshComments();
      } catch (e) {
        onProblem(errorText(e));
      }
    },
    [refreshComments, onProblem],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (marking) return;
    const action = reviewAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      typing: isTyping(e.target),
    });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    const frameMs = 1000 / fps;
    switch (action) {
      case "play":
        togglePlay();
        break;
      case "back":
        pause();
        seekTo(playhead - frameMs);
        break;
      case "forward":
        pause();
        seekTo(playhead + frameMs);
        break;
      case "in":
        setRange((r) => withIn(r, playhead));
        break;
      case "out":
        setRange((r) => withOut(r, playhead));
        break;
      case "note":
        newNote(playhead, "key");
        break;
      case "send":
        // Main is read-only: `play/send` would be refused, so it is not tried.
        if (!props.readOnly) void send(options, agent);
        break;
    }
  };

  const madeFrom = useMemo(
    () => new Set(doc?.notes.map((n) => n.fromMark).filter((m) => m !== undefined)),
    [doc],
  );
  const selectedNote = doc?.notes.find((n) => n.n === selected) ?? null;
  const showInk =
    selectedNote?.markupPng && !playing && Math.abs(playhead - selectedNote.atMs) < 1000 / fps;

  if (!detail || !doc || !take) {
    return (
      <div className="pl-review pl-review--loading">
        <p className="pl-hint">Opening the take…</p>
      </div>
    );
  }

  // The frame being marked up is the note's, named in markup.json as the
  // take's video at that time (a media fragment), wherever the take lives.
  const markedAt = doc.notes.find((n) => n.n === marking?.n)?.atMs ?? playhead;

  return (
    <div
      className="pl-review"
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-open-ms={openMs ?? undefined}
    >
      <div className="pl-review__main">
        <div className="pl-review__tools" role="toolbar" aria-label="Markup tools">
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={marking !== null}
            title="Draw on this frame and pin what is wrong (the note at the playhead, or a new one)"
            onClick={() => void startMarkup()}
          >
            <PenLine size={13} strokeWidth={1.5} aria-hidden="true" />
            Mark up this frame
          </button>
          <span className="pl-hint">
            {marking
              ? "Pin objects and draw, then press Done."
              : "N adds a note at the playhead, I and O set a range."}
          </span>
        </div>
        <div className="pl-review__stage">
          <div className="pl-review__frame" style={{ aspectRatio: String(aspect) }}>
            {take.hasVideo ? (
              <video
                ref={video}
                className="pl-review__video"
                src={detail.urls.video}
                crossOrigin="anonymous"
                preload="auto"
                muted
                playsInline
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth > 0 && v.videoHeight > 0)
                    setAspect(v.videoWidth / v.videoHeight);
                }}
                onLoadedData={opened}
                onCanPlay={() => setPlayerReady(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onSeeked={(e) => !playing && setPlayhead(e.currentTarget.currentTime * 1000)}
              />
            ) : (
              <p className="pl-hint">This take has no video.</p>
            )}
            {showInk && (
              <img
                className="pl-review__ink"
                src={`data:image/png;base64,${selectedNote.markupPng}`}
                alt={`Note ${selectedNote.n} as marked up`}
              />
            )}
            {marking && (
              <Suspense fallback={null}>
                <FrameMarkup
                  src={marking.url}
                  path={`${take.path.replace(/\\/g, "/")}/take.mp4#t=${(markedAt / 1000).toFixed(3)}`}
                  pick={(x, y, shown) => {
                    const hit = recordedTarget(tickAt(markedAt), x, y, shown);
                    const p = hit?.worldPoint;
                    return hit && p && p.length === 3
                      ? { nodePath: hit.nodePath, worldPoint: [p[0], p[1], p[2]] }
                      : null;
                  }}
                  onDone={(result) => void doneMarkup(result)}
                  onCancel={endMarkup}
                  onProblem={(m) => onProblem(m)}
                />
              </Suspense>
            )}
          </div>
          {take.hasVideo && (
            <video
              ref={grabber}
              className="pl-review__grabber"
              src={detail.urls.video}
              crossOrigin="anonymous"
              preload="metadata"
              muted
              aria-hidden="true"
            />
          )}
        </div>
        <div className="pl-review__transport">
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--icon k-btn--sm"
            aria-label="Back one frame"
            title="Back one frame (Left)"
            onClick={() => {
              pause();
              seekTo(playhead - 1000 / fps);
            }}
          >
            <SkipBack size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pl-review__play"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={togglePlay}
          >
            {playing ? (
              <Pause size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <PlayIcon size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--icon k-btn--sm"
            aria-label="Forward one frame"
            title="Forward one frame (Right)"
            onClick={() => {
              pause();
              seekTo(playhead + 1000 / fps);
            }}
          >
            <SkipForward size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <span className="pl-review__time">
            {clock(playhead, true)} <span>/ {clock(duration, true)}</span>
          </span>
          <span className="pl-review__spacer" />
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            title="Set the range start at the playhead (I)"
            onClick={() => setRange((r) => withIn(r, playhead))}
          >
            In <kbd>I</kbd>
          </button>
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            title="Set the range end at the playhead (O)"
            onClick={() => setRange((r) => withOut(r, playhead))}
          >
            Out <kbd>O</kbd>
          </button>
          <button
            type="button"
            className="k-btn k-btn--primary k-btn--sm"
            title="Add a note at the playhead or range (N)"
            onClick={() => newNote(playhead, "button")}
          >
            Add note <kbd>N</kbd>
          </button>
        </div>
        <Timeline
          durationMs={duration}
          playheadMs={playhead}
          range={range}
          thumbs={thumbs}
          stripEveryMs={STRIP_EVERY_MS}
          notes={doc.notes.map((n) => ({
            n: n.n,
            atMs: n.atMs,
            inMs: n.inMs,
            outMs: n.outMs,
            status: noteStatus(n, comments),
          }))}
          marks={take.marks.map((ms) => ({ ms, made: madeFrom.has(ms) }))}
          log={log}
          scenes={take.scenes}
          frames={frameSeries(ticks, take.startedAt)}
          selected={selected}
          onSeek={(ms) => {
            pause();
            seekTo(ms);
          }}
          onPickNote={select}
        />
      </div>
      <NotesPanel
        take={{ id: take.id, number: take.number }}
        notes={doc.notes}
        comments={comments}
        log={log}
        pendingMarks={pendingMarks(take.marks, doc)}
        selected={selected}
        sending={sending}
        readOnly={props.readOnly}
        options={options}
        onOptions={setOptions}
        agents={agents}
        agent={agent}
        onAgent={(a) => setPicked(agentKey(a))}
        clipUnavailable={clipUnavailable}
        onSelect={select}
        onChange={(n, patch) => change((d) => updateNote(d, n, patch))}
        onDelete={(n) => {
          change((d) => removeNote(d, n));
          setSelected(null);
        }}
        onDone={() => setSelected(null)}
        onMakeNote={(ms) => {
          seekTo(ms);
          newNote(ms, "mark", { fromMark: ms }, null);
        }}
        onDismiss={(ms) => change((d) => dismissMark(d, ms))}
        onVerdict={(id, v, reply) => {
          const c = comments.find((x) => x.id === id);
          if (v === "broken" && c && props.onStillBroken) props.onStillBroken(c, reply);
          else void verdict(id, v, reply);
        }}
        onPlayScene={props.onPlayScene}
        onSend={() => void send(options, agent)}
      />
      <div className="pl-review__footer">
        <span>
          Take {take.number} · {clock(duration)} · {take.video.width} × {take.video.height} ·{" "}
          {Math.round(take.bytes / 1_000_000)} MB
        </span>
        <code>{take.path}</code>
        <span className="pl-review__spacer" />
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          onClick={() => {
            // The notes go with the take, so no write of them may start, or
            // land, after the delete; one that fails puts them back to write.
            const unsaved = dirty.current;
            dirty.current = false;
            clearTimeout(saveTimer.current);
            saving.current
              .catch(() => undefined)
              .then(() => deleteTake(takeId))
              .then(props.onDeleted)
              .catch((e: unknown) => {
                dirty.current ||= unsaved;
                onProblem(`Couldn't delete the take: ${errorText(e)}`);
              });
          }}
        >
          Delete take
        </button>
      </div>
    </div>
  );
}
