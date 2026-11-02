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

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@veistra/bridge", () => ({ invoke: bridge.invoke }));
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
  over: { insertMs?: number; deleteMs?: number } = {},
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
        return Promise.resolve({ notes: [FIXED] });
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
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(""))) as unknown as typeof fetch;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLMediaElement.prototype.pause = vi.fn();
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
