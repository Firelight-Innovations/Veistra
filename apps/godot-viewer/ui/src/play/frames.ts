/**
 * Pictures made from a take's video in the page, with no ffmpeg (design
 * §8.2.3 and §9.1): the filmstrip, a note's frames, and its contact sheet.
 *
 * Every picture comes from a `<video>` seeked to a time and drawn into a
 * canvas. That works because the take is served through Tauri's asset
 * protocol, which answers with this page's origin in CORS, and the video is
 * loaded with `crossOrigin = "anonymous"`; without both, the canvas would be
 * tainted and `toBlob` would refuse.
 *
 * The contact sheet is how an agent sees motion: agents read images, not
 * video. One frame a second from two seconds before the note to two after,
 * at most sixteen, four to a row, each with its time printed on it.
 */

/** Most frames on one contact sheet. */
export const CONTACT_MAX = 16;
export const CONTACT_COLS = 4;
/** How wide one cell of the sheet is; its height follows the take's shape. */
export const CONTACT_CELL_WIDTH = 320;
/** How long a seek may take before the picture is given up on. */
export const SEEK_TIMEOUT_MS = 5_000;

/**
 * The times on a note's contact sheet: every second from `inMs - 2 s` to
 * `outMs + 2 s`, inside the take, at most {@link CONTACT_MAX}. A longer span
 * is sampled evenly instead, so the sheet still runs end to end.
 */
export function contactTimes(inMs: number, outMs: number, durationMs: number): number[] {
  const from = Math.max(0, Math.min(inMs, outMs) - 2000);
  const to = Math.min(Math.max(0, durationMs - 1), Math.max(inMs, outMs) + 2000);
  if (to < from) return [];
  const count = Math.floor((to - from) / 1000) + 1;
  if (count <= CONTACT_MAX) {
    return Array.from({ length: count }, (_, i) => from + i * 1000);
  }
  const step = (to - from) / (CONTACT_MAX - 1);
  return Array.from({ length: CONTACT_MAX }, (_, i) => Math.round(from + i * step));
}

/**
 * The sheet's size for `count` cells of a take `aspect` (width over height)
 * wide, so a 4:3 or an ultrawide game is not squashed into 16:9 cells.
 */
export function contactLayout(
  count: number,
  aspect = 16 / 9,
): {
  cols: number;
  rows: number;
  cell: { width: number; height: number };
  width: number;
  height: number;
} {
  const cols = Math.min(CONTACT_COLS, Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / CONTACT_COLS));
  const cell = {
    width: CONTACT_CELL_WIDTH,
    height: Math.max(1, Math.round(CONTACT_CELL_WIDTH / (aspect > 0 ? aspect : 16 / 9))),
  };
  return { cols, rows, cell, width: cols * cell.width, height: rows * cell.height };
}

/** `m:ss`, or `m:ss.ss` with `precise`. */
export function clock(ms: number, precise = false): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const sec = precise ? s.toFixed(2).padStart(5, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${m}:${sec}`;
}

/**
 * Seek and wait for the frame to be there. A video that failed before the
 * seek, or one that never answers it, rejects rather than leaving Send
 * waiting for ever.
 */
export function seek(
  video: HTMLVideoElement,
  ms: number,
  timeoutMs = SEEK_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, ms / 1000);
    if (video.error) {
      reject(new Error("the take's video could not be read"));
      return;
    }
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const settle = (error: Error | null) => {
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      if (error) reject(error);
      else resolve();
    };
    const done = () => settle(null);
    const fail = () => settle(new Error("the take's video could not be read"));
    const timer = setTimeout(
      () => settle(new Error(`the take's video did not reach ${clock(ms, true)}`)),
      timeoutMs,
    );
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = target;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("the frame could not be encoded"))),
      "image/png",
    ),
  );
}

/** The frame at `ms`, at the video's own size. */
export async function grab(video: HTMLVideoElement, ms: number): Promise<Blob> {
  await seek(video, ms);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no 2D canvas");
  g.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvasBlob(canvas);
}

/** A contact sheet of `times`, each cell labelled with its take time. */
export async function contactSheet(
  video: HTMLVideoElement,
  times: readonly number[],
): Promise<Blob> {
  const shape =
    video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : undefined;
  const layout = contactLayout(times.length, shape);
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no 2D canvas");
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const { width: cw, height: ch } = layout.cell;
  for (let i = 0; i < times.length; i++) {
    await seek(video, times[i]);
    const x = (i % CONTACT_COLS) * cw;
    const y = Math.floor(i / CONTACT_COLS) * ch;
    g.drawImage(video, x, y, cw, ch);
    const label = clock(times[i], true);
    g.font = "600 14px sans-serif";
    const w = g.measureText(label).width + 10;
    g.fillStyle = "rgba(0,0,0,0.7)";
    g.fillRect(x + 4, y + ch - 24, w, 20);
    g.fillStyle = "#fff";
    g.fillText(label, x + 9, y + ch - 9);
  }
  return canvasBlob(canvas);
}

/** How far apart the filmstrip's frames are (design §8.2.3). */
export const STRIP_EVERY_MS = 2000;

/**
 * Small frames every `everyMs`, for the timeline's filmstrip, at the video's
 * own shape (`aspect`, width over height). `onFrame` sees each as it lands.
 */
export async function filmstrip(
  video: HTMLVideoElement,
  durationMs: number,
  onFrame: (index: number, url: string) => void,
  everyMs = STRIP_EVERY_MS,
  width = 96,
  cancelled: () => boolean = () => false,
  aspect = 16 / 9,
): Promise<void> {
  const height = Math.max(1, Math.round(width / (aspect > 0 ? aspect : 16 / 9)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) return;
  for (let i = 0, ms = 0; ms < durationMs; i++, ms += everyMs) {
    if (cancelled()) return;
    await seek(video, ms);
    g.drawImage(video, 0, 0, width, height);
    onFrame(i, canvas.toDataURL("image/jpeg", 0.7));
  }
}
