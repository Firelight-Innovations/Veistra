// @vitest-environment jsdom
/**
 * Reviewing a take: notes from the keyboard, a fixed note's verdict, and
 * Send, which must hand `play/send` every draft with its pictures and then
 * put `packet.md` in front of the agent. jsdom cannot decode video, so the
 * frame grabbing in `frames.ts` is replaced; its arithmetic is tested in
 * `model.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.handlers.set(event, cb);
    return () => bridge.handlers.delete(event);
  },
}));
vi.mock("./frames", async (real) => {
  const actual = await real<typeof import("./frames")>();
  const png = () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  return {
    ...actual,
    grab: vi.fn(png),
    contactSheet: vi.fn(png),
    filmstrip: vi.fn(() => Promise.resolve()),
  };
});

/**
 * The markup layer needs a canvas jsdom lacks. This one stands in: it keeps
 * the path review names the frame by, and its button drops one pin on the
 * enemy at (1000, 400) in a frame shown at the game's own 1280x720.
 */
const markup = vi.hoisted(() => ({ path: "" }));
vi.mock("./FrameMarkup", () => ({
  default: (p: {
    path: string;
    pick?: (x: number, y: number, shown: { width: number; height: number }) => object | null;
    onDone: (result: unknown, shown: { width: number; height: number }) => void;
  }) => {
    markup.path = p.path;
    const shown = { width: 1280, height: 720 };
    const pin = () => {
      const hit = p.pick?.(1000, 400, shown) ?? {};
      const json = {
        version: 1,
        pins: [{ n: 1, x: 1000, y: 400, note: "", ...hit }],
        annotations: [],
      };
      p.onDone({ json, png: new Blob([new Uint8Array([1])], { type: "image/png" }) }, shown);
    };
    return (
      <button type="button" onClick={pin}>
        Pin the enemy
      </button>
    );
  },
}));

import Review, { type ReviewProps } from "./Review";

const TAKE = {
  version: 1,
  id: "2026-10-30-1402-0f3a",
  number: 4,
  environment: { branch: "wt/enemy-chase", commit: "8c41e07" },
  project: ".",
  godot: "4.5.1",
  startedAt: 1_000_000,
  durationMs: 151_400,
  video: { width: 1280, height: 720, fps: 30 },
  scenes: [{ path: "res://levels/hallway.tscn", fromMs: 0, toMs: 151_400 }],
  marks: [72_010],
  counts: { errors: 1, warnings: 0 },
  ticks: 1500,
  path: "C:/env/.veistra/takes/2026-10-30-1402-0f3a",
  bytes: 38_000_000,
  hasVideo: true,
  drafts: 1,
};

const FIXED = {
  id: "c2",
  anchor: {
    kind: "take",
    take: TAKE.id,
    n: 2,
    atMs: 102_180,
    packet: "p",
    scene: "res://levels/hallway.tscn",
  },
  author: "user",
  body: "The enemy walks into the east wall",
  status: "fixed",
  resolution: { note: "Rebaked the nav mesh", by: "agent", at: 1, commit: "3f2a1c9" },
  created: 1,
  updated: 2,
};

/** `notes.json` as the backend would keep it, so a test can see what reached disk. */
interface Disk {
  notes: { notes: Record<string, unknown>[] } & Record<string, unknown>;
}

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function backend(
  notes: unknown[] = [{ n: 1, kind: "frame", atMs: 41_000, body: "The door light flickers" }],
  over: { insertMs?: number; deleteMs?: number; filed?: unknown[] } = {},
): Disk {
  const disk: Disk = {
    notes: { version: 1, notes: copy(notes) as Record<string, unknown>[], nextN: 3, dismissed: [] },
  };
  const packet = ".veistra/feedback/2026-10-30-1402-0f3a-1";
  bridge.invoke.mockImplementation((method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "play/take":
        return Promise.resolve({
          take: TAKE,
          urls: { video: "asset://v", telemetry: "asset://t", log: "asset://l" },
          notes: copy(disk.notes),
        });
      case "play/notes-save":
        disk.notes = copy(params?.notes) as Disk["notes"];
        return Promise.resolve({ saved: true });
      case "play/notes":
        return Promise.resolve({ notes: copy(over.filed ?? [FIXED]) });
      case "play/send":
        // `mark_sent`: the notes on disk that were sent get their stamps.
        disk.notes.notes = disk.notes.notes.map((n) =>
          n.n === 1 ? { ...n, commentId: "c1", packet } : n,
        );
        return Promise.resolve({
          packet,
          packetMd: "C:/env/.veistra/feedback/2026-10-30-1402-0f3a-1/packet.md",
          comments: [[1, "c1"]],
        });
      case "context/put":
        return Promise.resolve({ id: "ctx_1" });
      case "context/insert":
        return new Promise((resolve) => setTimeout(() => resolve(null), over.insertMs ?? 0));
      case "play/take-delete":
        return new Promise((resolve) =>
          setTimeout(() => resolve({ deleted: params?.id }), over.deleteMs ?? 0),
        );
      default:
        return Promise.resolve(null);
    }
  });
  return disk;
}

const calls = (m: string) => bridge.invoke.mock.calls.filter((c) => c[0] === m);
/** The usage events the page sent through `veistra/track`, by name. */
const tracked = (event: string) =>
  calls("veistra/track")
    .map((c) => c[1] as { event: string; props: Record<string, unknown> })
    .filter((t) => t.event === event)
    .map((t) => t.props);
/** The newest `notes.json` written, by note number. */
const savedNote = (n: number) =>
  (
    calls("play/notes-save").slice(-1)[0]?.[1] as { notes: { notes: Record<string, unknown>[] } }
  )?.notes.notes.find((x) => x.n === n);

/** Answer the take's telemetry and log with these files' text. */
function serve(files: { telemetry?: string; log?: string }) {
  const byUrl: Record<string, string | undefined> = {
    "asset://t": files.telemetry,
    "asset://l": files.log,
  };
  globalThis.fetch = vi.fn((url: string) =>
    Promise.resolve(new Response(byUrl[url] ?? "")),
  ) as unknown as typeof fetch;
}

/** The tick at note 1's moment: the hallway walls, Enemy_02's body and its mesh. */
const ENEMY_TICK = JSON.stringify({
  t: TAKE.startedAt + 41_000,
  kind: "tick",
  scene: "res://levels/hallway.tscn",
  viewport: [1280, 720],
  nodes: [
    { path: "Hallway/Walls", type: "StaticBody3D", rect: [0, 0, 1280, 720] },
    {
      path: "Hallway/Enemy_02",
      type: "CharacterBody3D",
      rect: [905, 210, 250, 410],
      pos: [14.2, 0, -6.8],
    },
    { path: "Hallway/Enemy_02/Mesh", type: "MeshInstance3D", rect: [915, 220, 230, 390] },
  ],
});

const keys = () => screen.getByLabelText("Notes on this take");
const press = (key: string, times = 1) => {
  for (let i = 0; i < times; i++) fireEvent.keyDown(keys(), { key });
};
/** Open a note's card, which moves the playhead to it. */
const pick = (n: number) =>
  fireEvent.click(within(screen.getByLabelText(`Note ${n}`)).getAllByRole("button")[0]);

function mount(over: Partial<ReviewProps> = {}) {
  const props = {
    takeId: TAKE.id,
    readOnly: false,
    liveNotes: [],
    onLiveNotesTaken: vi.fn(),
    onPlayScene: vi.fn(),
    onProblem: vi.fn(),
    onDeleted: vi.fn(),
    onNotice: vi.fn(),
    ...over,
  };
  const view = render(<Review {...props} />);
  return { props, ...view };
}

/** Open note 1 for editing and change its words. */
async function retype(body: string) {
  const card = screen.getByLabelText("Note 1");
  fireEvent.click(within(card).getAllByRole("button")[0]);
  const box = await screen.findByRole("textbox", { name: "Note 1" });
  fireEvent.change(box, { target: { value: body } });
}

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.handlers.clear();
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(""))) as unknown as typeof fetch;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLMediaElement.prototype.pause = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:frame");
  URL.revokeObjectURL = vi.fn();
  markup.path = "";
});
afterEach(cleanup);

describe("Review", () => {
  it("lists the take's notes and the mark not yet made a note", async () => {
    backend();
    mount();
    expect(await screen.findByText("The door light flickers")).toBeTruthy();
    expect(screen.getByText("1:12 · your mark")).toBeTruthy();
    expect(screen.getByText(/Take 4 · 2:31 · 1280 × 720 · 38 MB/)).toBeTruthy();
  });

  it("adds a note at the playhead with N and saves the drafts", async () => {
    backend();
    mount();
    await screen.findByText("The door light flickers");
    fireEvent.keyDown(screen.getByLabelText("Notes on this take"), { key: "n" });
    const box = await screen.findByRole("textbox", { name: "Note 3" });
    fireEvent.change(box, { target: { value: "Fuse box prompt shows through the wall" } });
    await waitFor(() => expect(calls("play/notes-save").length).toBeGreaterThan(0), {
      timeout: 2000,
    });
    const saved = calls("play/notes-save").slice(-1)[0]?.[1] as {
      notes: { notes: { n: number }[] };
    };
    expect(saved.notes.notes.map((n) => n.n)).toEqual([1, 3]);
    // Spec §13 test 5: the usage event, with what the note is and where it came from.
    expect(tracked("note_created")).toEqual([{ kind: "frame", from: "key" }]);
  });

  it("steps one frame with the arrows, and turns I, O and N into a range note", async () => {
    backend();
    const { container } = mount();
    await screen.findByText("The door light flickers");
    press("ArrowRight");
    expect(container.querySelector(".pl-review__time")?.textContent).toMatch(/^0:00\.03 /);
    press("ArrowLeft");
    press("i");
    press("ArrowRight", 30);
    press("o");
    press("n");
    await screen.findByRole("textbox", { name: "Note 3" });
    expect(tracked("note_created")).toEqual([{ kind: "range", from: "key" }]);
    await waitFor(() => expect(savedNote(3)).toBeTruthy(), { timeout: 2000 });
    const note = savedNote(3) as { kind: string; inMs: number; outMs: number };
    expect(note.kind).toBe("range");
    expect(note.inMs).toBe(0);
    expect(note.outMs).toBeCloseTo(1000, 6);
    // The range went into the note, so the timeline shows none pending.
    expect(container.querySelector(".pl-tl__selection")).toBeNull();
  });

  // Make a note took the pending range and put the mark's note in its middle.
  it("makes a mark's note at the mark, leaving a pending range for later", async () => {
    backend();
    const { container } = mount();
    await screen.findByText("1:12 · your mark");
    press("i");
    press("ArrowRight", 3);
    press("o");
    fireEvent.click(screen.getByRole("button", { name: "Make a note" }));
    await screen.findByRole("textbox", { name: "Note 3" });
    expect(tracked("note_created")).toEqual([{ kind: "frame", from: "mark" }]);
    await waitFor(() => expect(savedNote(3)).toBeTruthy(), { timeout: 2000 });
    expect(savedNote(3)).toMatchObject({ kind: "frame", atMs: 72_010, fromMark: 72_010 });
    expect(container.querySelector(".pl-tl__selection")).not.toBeNull();
  });

  it("names a pin on the enemy's mesh Enemy_02, from the recorded tick", async () => {
    backend();
    serve({ telemetry: ENEMY_TICK });
    mount();
    await screen.findByText("The door light flickers");
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    pick(1);
    fireEvent.click(screen.getByRole("button", { name: /Mark up this frame/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Pin the enemy" }));
    await waitFor(() => expect(savedNote(1)?.target).toBeTruthy(), { timeout: 2000 });
    expect(savedNote(1)?.target).toEqual({
      nodePath: "Hallway/Enemy_02",
      type: "CharacterBody3D",
      worldPoint: [14.2, 0, -6.8],
      source: "recorded",
    });
    // The frame is named as the take's video at the note's time, wherever the take lives.
    expect(markup.path).toBe(`${TAKE.path}/take.mp4#t=41.000`);
    // The selected note was marked up, so no note was made.
    expect(tracked("note_created")).toEqual([]);
  });

  it("marks up a new note at the playhead once it has left the selected one", async () => {
    backend();
    mount();
    await screen.findByText("The door light flickers");
    pick(1);
    press("ArrowRight", 2);
    fireEvent.click(screen.getByRole("button", { name: /Mark up this frame/ }));
    await screen.findByRole("button", { name: "Pin the enemy" });
    expect(tracked("note_created")).toEqual([{ kind: "frame", from: "markup" }]);
    await waitFor(() => expect(savedNote(3)).toBeTruthy(), { timeout: 2000 });
    // Two frames on at 30 fps, kept to the millisecond.
    expect(savedNote(3)?.atMs).toBe(41_067);
  });

  it("counts the errors and warnings near a note on its card", async () => {
    backend();
    const row = (ms: number, level: string, text: string) =>
      JSON.stringify({ t: TAKE.startedAt + ms, ms, level, stream: "stderr", text });
    serve({
      log: [
        row(45_000, "error", "Invalid get index 'light'"),
        row(50_000, "warning", "Shader compile slow"),
        row(60_000, "error", "Too late to count"),
        row(42_000, "info", "door opened"),
      ].join("\n"),
    });
    mount();
    const chip = await screen.findByText("1 error · 1 warning near");
    expect(chip.getAttribute("title")).toContain("Invalid get index 'light'");
  });

  // Main is read-only: notes are written there, but `play/send` is refused.
  it("keeps notes on the read-only main checkout and does not try to send them", async () => {
    backend();
    mount({ readOnly: true });
    await screen.findByText("The door light flickers");
    fireEvent.keyDown(keys(), { key: "Enter", ctrlKey: true });
    press("n");
    await screen.findByRole("textbox", { name: "Note 3" });
    expect((screen.getByRole("button", { name: /Add note/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(calls("play/send")).toHaveLength(0);
  });

  // Spec §13 test 5 asks for review within 2 s of F7. What it waits for is
  // the first frame; the filmstrip's seeks start only once the player can play.
  it("says how long it took to show the first frame, and starts the filmstrip after it", async () => {
    backend();
    const made = vi.spyOn(document, "createElement");
    const strips = () =>
      made.mock.results
        .map((r) => r.value as unknown)
        .filter((el): el is HTMLVideoElement => el instanceof HTMLVideoElement && !el.isConnected);
    const { container } = mount({ openedAt: Date.now() - 1500 });
    await screen.findByText("The door light flickers");
    const player = container.querySelector("video.pl-review__video") as HTMLVideoElement;
    const root = container.querySelector(".pl-review") as HTMLElement;
    expect(root.dataset.openMs).toBeUndefined();
    expect(container.querySelector(".pl-review__grabber")?.getAttribute("preload")).toBe(
      "metadata",
    );
    fireEvent.loadedData(player);
    await waitFor(() => expect(Number(root.dataset.openMs)).toBeGreaterThanOrEqual(1500));
    expect(strips()).toHaveLength(0);
    fireEvent.canPlay(player);
    await waitFor(() => expect(strips()).toHaveLength(1));
    fireEvent.loadedData(strips()[0]);
    const { filmstrip } = await import("./frames");
    await waitFor(() => expect(filmstrip).toHaveBeenCalled());
    expect(vi.mocked(filmstrip).mock.calls[0].slice(1, 2)).toEqual([TAKE.durationMs]);
    expect(vi.mocked(filmstrip).mock.calls[0][3]).toBe(2000);
    made.mockRestore();
  });

  it("sends the drafts with their pictures, then puts packet.md in front of the agent", async () => {
    backend();
    const { props } = mount();
    await screen.findByText("The door light flickers");
    fireEvent.click(screen.getByRole("button", { name: "Send 1 note" }));
    await waitFor(() => expect(calls("context/insert")).toHaveLength(1));
    const [, sent] = calls("play/send")[0] as [
      string,
      { take: string; notes: Record<string, unknown>[] },
    ];
    expect(sent.take).toBe(TAKE.id);
    expect(sent.notes).toHaveLength(1);
    expect(sent.notes[0]).toMatchObject({ n: 1, atMs: 41_000, body: "The door light flickers" });
    const images = sent.notes[0].images as Record<string, string | undefined>;
    expect(images.markupPng).toBeTruthy();
    expect(images.contactPng).toBeTruthy();
    expect(images.notePng).toBeTruthy();
    expect(calls("context/put")[0][1]).toMatchObject({
      kind: "file",
      path: "C:/env/.veistra/feedback/2026-10-30-1402-0f3a-1/packet.md",
    });
    expect(props.onNotice).toHaveBeenCalled();
  });

  it("shows a fixed note's summary and sends Still broken with the reply", async () => {
    backend([
      { n: 1, kind: "frame", atMs: 41_000, body: "The door light flickers" },
      {
        n: 2,
        kind: "range",
        atMs: 102_180,
        inMs: 98_000,
        outMs: 106_000,
        body: "wall",
        commentId: "c2",
      },
    ]);
    const { props } = mount();
    expect(await screen.findByText("Rebaked the nav mesh")).toBeTruthy();
    expect(screen.getByText("Fixed, check it")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What is still broken, for note 2"), {
      target: { value: "still clips at the door" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Still broken" }));
    await waitFor(() => expect(calls("comments/verdict")).toHaveLength(1));
    expect(calls("comments/verdict")[0][1]).toMatchObject({
      id: "c2",
      verdict: "broken",
      reply: "still clips at the door",
    });
    fireEvent.click(screen.getByRole("button", { name: "Play hallway.tscn" }));
    expect(props.onPlayScene).toHaveBeenCalledWith("res://levels/hallway.tscn");
  });

  // Review saw an agent's fix only by its 2 s poll. The push comes at once,
  // and a change to another take's note lists nothing.
  it("shows a fix as soon as the change is pushed, before the poll", async () => {
    const filed: unknown[] = [{ ...FIXED, status: "working", resolution: undefined }];
    backend(
      [
        {
          n: 2,
          kind: "range",
          atMs: 102_180,
          inMs: 98_000,
          outMs: 106_000,
          body: "wall",
          commentId: "c2",
        },
      ],
      { filed },
    );
    mount();
    await screen.findByText("wall");
    await waitFor(() => expect(calls("play/notes").length).toBeGreaterThan(0));
    const listed = calls("play/notes").length;
    const push = bridge.handlers.get("comments:changed");

    push?.({ id: "x9", kind: "take", take: "2026-10-30-1500-aaaa", status: "fixed", from: "open" });
    await new Promise((r) => setTimeout(r, 250));
    expect(calls("play/notes")).toHaveLength(listed);
    filed[0] = FIXED;
    push?.({ id: "c2", kind: "take", take: TAKE.id, status: "fixed", from: "working" });
    expect(await screen.findByText("Fixed, check it", undefined, { timeout: 1000 })).toBeTruthy();
  });

  // Typing and then sending inside the debounce left a write of the
  // unstamped notes waiting; it landed after `play/send` stamped them.
  it("keeps Send's stamps when an edit was still waiting to be written", async () => {
    const disk = backend(undefined, { insertMs: 800 });
    const { props } = mount();
    await screen.findByText("The door light flickers");
    await retype("The door light flickers twice");
    fireEvent.click(screen.getByRole("button", { name: "Send 1 note" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalled(), { timeout: 2000 });
    // Past the debounce the edit started.
    await new Promise((r) => setTimeout(r, 700));
    const sent = calls("play/send")[0][1] as { notes: { body: string }[] };
    expect(sent.notes[0].body).toBe("The door light flickers twice");
    expect(disk.notes.notes[0]).toMatchObject({
      body: "The door light flickers twice",
      commentId: "c1",
    });
    expect(within(screen.getByLabelText("Note 1")).getByText("Sent")).toBeTruthy();
  });

  it("writes an edit the debounce had not yet when the take is left", async () => {
    const disk = backend();
    const { unmount } = mount();
    await screen.findByText("The door light flickers");
    await retype("The door light flickers twice");
    unmount();
    await waitFor(() => expect(disk.notes.notes[0].body).toBe("The door light flickers twice"));
  });

  // The debounce used to be cleared only once the delete answered, so a slow
  // delete let it write the notes back into the take being removed.
  it("writes nothing of the notes once the take is being deleted", async () => {
    backend(undefined, { deleteMs: 800 });
    const { props, unmount } = mount();
    await screen.findByText("The door light flickers");
    await retype("The door light flickers twice");
    fireEvent.click(screen.getByRole("button", { name: "Delete take" }));
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalled(), { timeout: 2000 });
    unmount();
    expect(calls("play/notes-save")).toHaveLength(0);
  });

  it("folds in only this take's live notes, and keeps them when the take is left at once", async () => {
    const disk = backend();
    const live = (take: string, body: string) => ({
      take,
      atMs: 5_000,
      body,
      markup: null,
      markupPng: null,
      target: null,
    });
    const { props, unmount } = mount({
      liveNotes: [
        live(TAKE.id, "The torch clips the wall"),
        live("2026-10-30-1500-aaaa", "A note on another take"),
      ],
    });
    expect(await screen.findByText("The torch clips the wall")).toBeTruthy();
    expect(screen.queryByText("A note on another take")).toBeNull();
    expect(props.onLiveNotesTaken).toHaveBeenCalledWith(TAKE.id);
    unmount();
    await waitFor(() =>
      expect(disk.notes.notes.map((n) => n.body)).toEqual([
        "The door light flickers",
        "The torch clips the wall",
      ]),
    );
  });

  it("sends from Ctrl Enter with the options the panel shows", async () => {
    backend();
    mount();
    await screen.findByText("The door light flickers");
    fireEvent.click(screen.getByRole("checkbox", { name: /Contact sheet per note/ }));
    fireEvent.keyDown(screen.getByLabelText("Notes on this take"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(calls("play/send")).toHaveLength(1));
    const [, sent] = calls("play/send")[0] as [string, { notes: Record<string, unknown>[] }];
    const images = sent.notes[0].images as Record<string, string | undefined>;
    expect(images.notePng).toBeTruthy();
    expect(images.contactPng).toBeUndefined();
  });

  it("takes the focus when the take opens, so its keys work at once", async () => {
    backend();
    const { container } = mount();
    await screen.findByText("The door light flickers");
    expect(document.activeElement).toBe(container.querySelector(".pl-review"));
    fireEvent.keyDown(document.activeElement as Element, { key: "n" });
    expect(await screen.findByRole("textbox", { name: "Note 3" })).toBeTruthy();
  });

  it("leaves the focus on a control that has it, such as the Take menu", async () => {
    backend();
    const menu = document.body.appendChild(document.createElement("select"));
    menu.focus();
    mount();
    await screen.findByText("The door light flickers");
    expect(document.activeElement).toBe(menu);
    menu.remove();
  });
});
