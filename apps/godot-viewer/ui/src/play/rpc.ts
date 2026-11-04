/**
 * The wire shapes `play/*` answers with, restated from
 * `src-tauri/src/godot/runner.rs`, `rpc.rs`, `live.rs`, `session.rs` and
 * `takes.rs`. The pane polls `play/state` with a log cursor and a key cursor;
 * nothing is pushed. The game's box methods mirror the editors' `embed/*`
 * (`apps/shared/nativeWindow.ts`), with take side effects of their own.
 */
import { invoke } from "@veistra/bridge";
import type { AddonState } from "../../../../shared/godot";
import type { Comment } from "../../../../shared/comments";
import type { AgentTarget } from "../../../../shared/context";
import type { Rect } from "../../../../shared/nativeBox";
import type { EmbedState } from "../../../../shared/nativeWindow";
import type { NotesDoc } from "./notes";

export type RunState =
  { kind: "running" } | { kind: "stopped" } | { kind: "exited"; code: number | null };

export interface RunInfo {
  id: number;
  pid: number;
  state: RunState;
  startedAt: number;
  endedAt: number | null;
  scene: string | null;
  project: string;
  paused: boolean;
  /** True when the run was started with the capture addon's channel. */
  captureReady: boolean;
}

export type Level = "info" | "warning" | "error";

export interface LogLine {
  seq: number;
  stream: "stdout" | "stderr";
  level: Level;
  text: string;
  /** Wall-clock milliseconds. */
  at: number;
}

export interface LogSlice {
  lines: LogLine[];
  nextSeq: number;
  /** The cursor had fallen off the front of the bounded log. */
  truncated: boolean;
}

/** Where the game's window is (`embed::State`), with the same causes as an editor's. */
export type { EmbedCause, EmbedState } from "../../../../shared/nativeWindow";

/** Where this run's take is (`session::TakeState`). */
export type TakeState =
  | { state: "off" }
  | { state: "starting"; number: number }
  | { state: "recording"; id: string; number: number; startedAt: number | null }
  | { state: "saving"; id: string; number: number }
  | { state: "saved"; id: string; number: number }
  | { state: "failed"; reason: string };

/** A key the addon handled for Veistra: F7 or Ctrl Shift M. */
export interface KeyEvent {
  seq: number;
  key: string;
  t: number;
}

export interface Session {
  runId: number;
  embed: EmbedState;
  embedded: boolean;
  take: TakeState;
  /** Wall time zero for the live strip: the take's first frame, else the run's start. */
  zero: number;
  /** Wall-clock milliseconds, F8 and the toolbar's. */
  marks: number[];
  keys: KeyEvent[];
  ticks: number;
  /** The addon version the game reported, or null before it has. */
  addon: number | null;
  /**
   * The game holds the mouse (its last tick's mouse mode), so nothing in the
   * pane can be clicked until it lets go. Sent by capture addon v2's backend
   * (#312); absent from a backend without it, which reads as not captured.
   */
  mouseCaptured?: boolean;
  /**
   * The marks made with F8 in the game, apart from the toolbar's (#312), so
   * the page can report `mark_dropped` for them. Absent from an older backend.
   */
  f8Marks?: number;
  /** The note a Still broken run went back to (#321); absent on any other run. */
  followUp?: FollowUp | null;
}

/** Record's two qualities (`encode::Quality::named`). */
export type RecordQuality = "720p30" | "1080p60";

/**
 * Record and its settings (X9): machine-local and the project's. `dir` is
 * where takes go; `inEnvironment` says it is the environment's git-ignored
 * `.veistra/takes/`, false on read-only main, whose takes are kept outside it.
 */
export interface RecordSettings {
  on: boolean;
  blocked: string | null;
  quality?: RecordQuality;
  keep?: number;
  dir?: string | null;
  inEnvironment?: boolean;
}

export interface Live {
  record: RecordSettings;
  session: Session | null;
}

/**
 * The note a Still broken take was recorded to check (`takes::FollowUp`): its
 * comment, and the take and note number it was first sent as.
 */
export interface FollowUp {
  comment: string;
  take: string;
  n: number;
  number?: number;
}

export interface PlayState {
  run: RunInfo | null;
  log: LogSlice | null;
  live?: Live;
}

export interface Capture {
  /** Standard base64 PNG, no data-URI prefix. */
  png: string;
  width: number | null;
  height: number | null;
  /** Seconds the game had been running. */
  time: number;
  scene: string;
}

export interface AddonStatus {
  addon: AddonState;
  /** The game that is running started before the addon was installed. */
  needsRestart: boolean;
  readOnly: boolean;
}

export interface TakeSummary {
  version: number;
  id: string;
  number: number;
  environment: { branch: string | null; commit: string | null };
  project: string;
  godot: string;
  startedAt: number;
  durationMs: number;
  video: { width: number; height: number; fps: number };
  scenes: { path: string; fromMs: number; toMs: number }[];
  marks: number[];
  counts: { errors: number; warnings: number };
  ticks: number;
  /** Set on a take Still broken recorded; its notes.json starts with that note's draft. */
  followUp?: FollowUp;
}

export interface ListedTake extends TakeSummary {
  path: string;
  bytes: number;
  hasVideo: boolean;
  drafts: number;
}

export interface TakeDetail {
  take: ListedTake;
  urls: { video: string; telemetry: string; log: string };
  notes: NotesDoc;
  /** Why "Video clip per note" cannot be ticked on this machine, or null. */
  clipUnavailable?: string | null;
}

export interface PickHit {
  nodePath: string;
  type?: string;
  worldPoint?: number[] | null;
  script?: string;
  source?: string;
}

/** What `play/send` answers: the packet, and each note's comment. */
export interface Sent {
  packet: string;
  packetMd: string;
  comments: [number, string][];
  /**
   * What was asked for and is not in the packet, one sentence each: a clip
   * not cut, a note not filed (still a draft). `packet.md` lists them too.
   */
  problems?: string[];
}

/** How long Send may take: the pictures are quick, a clip re-encodes its span. */
export function sendTimeoutMs(notes: number, clip: boolean): number {
  return 30_000 + (clip ? notes * 30_000 : 0);
}

export type { Rect } from "../../../../shared/nativeBox";

/**
 * `project` is the pane's chosen project as `godot/status` names it, undefined
 * until that has loaded. The backend judges Record against it when no game is
 * running, so the answer is about this project and not one found by walking
 * the environment on every poll.
 */
export const getState = (since: number, keySince = 0, project?: string) =>
  invoke<PlayState>("play/state", { since, keySince, project });
/**
 * `recordOnce` records this run whatever Record is set to, and leaves the
 * setting alone (X9): Play <scene> on a fixed note. `followUp` is Still
 * broken's, the note the run is recorded to check, and implies it.
 */
export const run = (
  project?: string,
  scene?: string,
  options: { recordOnce?: boolean; followUp?: string } = {},
) => invoke<PlayState>("play/run", { project, scene, ...options });
export const stop = () => invoke<PlayState>("play/stop");
export const restart = (project?: string) => invoke<PlayState>("play/restart", { project });
export const setPaused = (paused: boolean) => invoke<PlayState>("play/pause", { paused });
export const capture = () => invoke<Capture>("play/capture");
export const addonStatus = (project?: string) =>
  invoke<AddonStatus>("play/addon-status", { project });
export const installAddon = (project?: string) =>
  invoke<AddonStatus>("play/addon-install", { project });
export const removeAddon = (project?: string) =>
  invoke<AddonStatus>("play/addon-remove", { project });

/**
 * `dpr` is this page's `devicePixelRatio`, the monitor scale times the
 * WebView's zoom. It is what turns these CSS pixels into the window's physical
 * ones; the window's own scale factor misses the zoom.
 */
export const embedRect = (r: Rect, visible: boolean, window: string | undefined, dpr: number) =>
  invoke<{ ok: boolean }>("play/embed-rect", { ...r, visible, window, dpr });
export const setRecord = (on: boolean, project?: string) =>
  invoke<{ on: boolean }>("play/record", { on, project });
/** Quality or keep alone, Record left on or off: the next take begun or saved uses them. */
export const setRecordSettings = (
  settings: { quality?: RecordQuality; keep?: number },
  project?: string,
) =>
  invoke<{ on: boolean; quality: RecordQuality; keep: number }>("play/record", {
    ...settings,
    project,
  });
/** Show folder: the takes folder in the system's file manager, made first if need be. */
export const revealTakes = () => invoke<{ dir: string }>("play/takes-reveal");
export const mark = () => invoke<{ t: number; marks: number[] }>("play/mark");
export const pick = (x: number, y: number) =>
  invoke<{ hit: PickHit | null; t: number | null }>("play/pick", { x, y });
export const still = () => invoke<{ png: string; source: string }>("play/still");
export const popOut = () => invoke<{ embed: EmbedState }>("play/pop-out");
export const dock = () => invoke<{ embed: EmbedState }>("play/dock");
export const listTakes = () => invoke<{ takes: ListedTake[]; dir: string }>("play/takes");
export const getTake = (id: string) => invoke<TakeDetail>("play/take", { id });
export const deleteTake = (id: string) => invoke<{ deleted: string }>("play/take-delete", { id });
export const saveNotes = (take: string, notes: NotesDoc) =>
  invoke<{ saved: boolean }>("play/notes-save", { take, notes });
/**
 * `clip` cuts `clip.mp4` per note in Rust; `sentTo` is kept on each comment
 * (X7), so Still broken goes back to the same agent.
 */
export const sendNotes = (
  take: string,
  notes: unknown[],
  options: { clip: boolean; sentTo: AgentTarget | null },
) =>
  invoke<Sent>(
    "play/send",
    { take, notes, clip: options.clip, sentTo: options.sentTo },
    sendTimeoutMs(notes.length, options.clip),
  );
export const listNotes = (take?: string) => invoke<{ notes: Comment[] }>("play/notes", { take });
