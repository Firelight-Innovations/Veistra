// @vitest-environment jsdom
/**
 * Play's send actions live in the shared footer, and still call the same
 * `context/put` the buttons used to: the log tail, and the captured frame.
 * Then the live view's own: Record, the keys the addon reports, and the
 * game box stepping aside for an overlay.
 *
 * Play is a mode of the Godot app now, so each test renders the app's shell
 * the way the `play` id opens it, with `?mode=play`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  openIn: vi.fn(),
  OPENED_EVENT: "veistra:opened",
  on: (event: string, cb: (payload: unknown) => void) => {
    events.set(event, cb);
    return () => events.delete(event);
  },
  session: () => Promise.resolve({ projectPath: null, instanceId: "i1" }),
}));

import App from "../App";
// The shell loads Play lazily; loading it here keeps that import inside a
// test's first wait.
import "./PlayMode";

const RUN = {
  id: 1,
  pid: 10,
  state: { kind: "running" },
  startedAt: 0,
  endedAt: null,
  scene: "res://main.tscn",
  project: ".",
  paused: false,
  captureReady: true,
};

function backend(putResult: () => unknown = () => ({ key: "k" })) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "play/state":
        return Promise.resolve({
          run: RUN,
          log: {
            lines: [{ seq: 1, stream: "stdout", level: "info", text: "hello", at: 0 }],
            nextSeq: 2,
            truncated: false,
          },
        });
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: false },
          executable: { found: null, problems: [], setting: "" },
          projects: [],
        });
      case "comments/list":
        return Promise.resolve([]);
      case "play/capture":
        return Promise.resolve({
          png: "AAAA",
          width: 1,
          height: 1,
          time: 3,
          scene: "res://main.tscn",
        });
      case "context/put":
        return Promise.resolve(putResult());
      default:
        return Promise.resolve(null);
    }
  });
}

const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");

beforeEach(() => {
  bridge.invoke.mockReset();
  events.clear();
  localStorage.clear();
  history.replaceState({}, "", "?mode=play");
  // jsdom has no ResizeObserver; the game box only needs one to exist.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no layout, so no scrollIntoView; the log pane calls it.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("Play send footer", () => {
  it("sends the log tail from the footer and says Sent", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send log" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Sent" });
    expect(puts()).toHaveLength(1);
    expect(puts()[0][1]).toMatchObject({ kind: "text", label: "Play - game output" });
  });

  // The button was "Capture & comment" in the header; the Main board puts it
  // in the live strip as "Capture this frame". It does the same thing.
  it("offers Send frame in the footer once a frame is captured, not in the composer", async () => {
    backend();
    const { container } = render(<App />);
    expect(screen.queryByRole("button", { name: "Send frame" })).toBeNull();
    const capture = await screen.findByRole("button", { name: /Capture this frame/ });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);
    const send = await screen.findByRole("button", { name: "Send frame" });
    expect(container.querySelector(".k-send-footer")?.contains(send)).toBe(true);
    expect(container.querySelector(".pl__composer")?.contains(send)).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toMatchObject({ kind: "panel", bytesBase64: "AAAA" });
  });

  it("names what failed to send", async () => {
    backend(() => {
      throw new Error("no store");
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Send log" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Couldn't send log to the agent/);
  });
});

const TAKE_ID = "2026-10-30-1402-0f3a";
const RECORDING = { state: "recording", id: TAKE_ID, number: 4, startedAt: 1000 };
const SAVED = { state: "saved", id: TAKE_ID, number: 4 };
/** The take as `play/takes` lists it, with only what the Take menu reads. */
const LISTED = { id: TAKE_ID, number: 4, startedAt: 1000, durationMs: 5000 };

const SESSION = {
  runId: 1,
  embed: { kind: "embedded" },
  embedded: true,
  zero: 1000,
  marks: [],
  ticks: 10,
  addon: 2,
};

const project = (rel: string) => ({
  rel,
  name: rel,
  mainScene: null,
  mainScenePath: null,
  engineMajor: 4,
  addon: "yes",
});

interface Key {
  seq: number;
  key: string;
  t: number;
}

/** What the backend holds; a test changes it and the next poll sees the change. */
interface World {
  run: { id: number; state: { kind: string; code?: number | null } } | null;
  keys: Key[];
  take: { state: string; id?: string; number?: number; startedAt?: number | null };
  record: { on: boolean; blocked: string | null };
  takes: unknown[];
  projects: unknown[];
  /** Where the game's window is (`embed::State`); embedded unless a test says otherwise. */
  embed: { kind: string; reason?: string; cause?: string };
  /** While set, `play/state` answers wait here, to be let go together. */
  held: (() => void)[] | null;
}

function liveBackend(over: Partial<World> = {}): World {
  const world: World = {
    run: { id: 1, state: { kind: "running" } },
    keys: [],
    take: RECORDING,
    record: { on: true, blocked: null },
    takes: [],
    projects: [],
    embed: SESSION.embed,
    held: null,
    ...over,
  };
  const state = (keySince: number) => ({
    run: world.run && { ...RUN, ...world.run },
    log: { lines: [], nextSeq: 0, truncated: false },
    live: {
      record: world.record,
      session: world.run && {
        ...SESSION,
        embed: world.embed,
        embedded: world.embed.kind === "embedded",
        runId: world.run.id,
        take: world.take,
        // Each key once, after the pane's cursor, as `Session::keys_since` answers.
        keys: world.keys.filter((k) => k.seq > keySince),
      },
    },
  });
  // Stop, Restart and Record off end the take as `finish_take` does: a
  // take recording is saved, one still waiting for the window is dropped.
  const save = () => {
    if (world.take.state === "starting") world.take = { state: "off" };
    if (world.take.state !== "recording") return;
    world.take = SAVED;
    world.takes = [LISTED, ...world.takes];
  };
  bridge.invoke.mockImplementation((method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "play/state": {
        const keySince = Number(params?.keySince ?? 0);
        const held = world.held;
        if (held) return new Promise((answer) => held.push(() => answer(state(keySince))));
        return Promise.resolve(state(keySince));
      }
      case "play/record":
        world.record = { ...world.record, on: params?.on === true };
        if (params?.on !== true) save();
        return Promise.resolve({ on: world.record.on });
      case "play/stop":
        save();
        if (world.run) world.run = { ...world.run, state: { kind: "stopped" } };
        return Promise.resolve(state(0));
      case "play/restart":
        save();
        world.run = { id: (world.run?.id ?? 0) + 1, state: { kind: "running" } };
        world.take = { state: "starting", number: 5 };
        world.keys = [];
        return Promise.resolve(state(0));
      case "play/pause":
        return Promise.resolve(state(0));
      case "play/capture":
        return Promise.resolve({ png: "AAAA", width: 4, height: 3, time: 1, scene: "" });
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: false },
          executable: { found: null, problems: [], setting: "" },
          projects: world.projects,
        });
      case "comments/list":
        return Promise.resolve([]);
      case "play/takes":
        return Promise.resolve({ takes: world.takes, dir: "" });
      case "play/take":
        return new Promise(() => undefined);
      case "play/still":
        return Promise.resolve({ png: "AAAA", source: "capture" });
      case "play/pop-out":
        world.embed = { kind: "poppedOut" };
        return Promise.resolve({ embed: world.embed });
      case "play/dock":
        world.embed = { kind: "embedded" };
        return Promise.resolve({ embed: world.embed });
      default:
        return Promise.resolve(null);
    }
  });
  return world;
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);
const lastParams = (method: string) =>
  calls(method).slice(-1)[0]?.[1] as Record<string, unknown> | undefined;
const pane = () => document.querySelector(".pl") as HTMLElement;

const BOX = { left: 10, top: 50, width: 640, height: 360, right: 650, bottom: 410 } as DOMRect;
const realRect = Element.prototype.getBoundingClientRect;
const realRatio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
const realMatchMedia = window.matchMedia;

/**
 * jsdom has no layout, so every game box measures 0 x 0: give each one,
 * including one mounted later, a real size, and say where the iframe is.
 */
function placeBox() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.classList.contains("pl-live__box") ? BOX : realRect.call(this);
  };
  events.get("veistra/window-rect")?.({ x: 0, y: 0, width: 800, height: 600 });
  events.get("veistra/overlays")?.({ rects: [] });
}

describe("Play scene from the Godot viewer", () => {
  it("runs the scene in the project the viewer chose, not this pane's own pick", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    events.get("veistra:opened")?.({ scene: "res://levels/hallway.tscn", project: "games/b" });
    await waitFor(() => expect(calls("play/run")).toHaveLength(1));
    expect(calls("play/run")[0][1]).toMatchObject({
      project: "games/b",
      scene: "res://levels/hallway.tscn",
    });
  });

  it("ignores an open that names no res:// scene", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    events.get("veistra:opened")?.({ scene: "C:/elsewhere.tscn", project: "games/b" });
    events.get("veistra:opened")?.(null);
    expect(calls("play/run")).toHaveLength(0);
  });
});

describe("Play live view", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:frame");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    if (realRatio) Object.defineProperty(window, "devicePixelRatio", realRatio);
    window.matchMedia = realMatchMedia;
  });

  it("draws the shared toolbar with the run's state and Rec on", async () => {
    liveBackend();
    render(<App />);
    expect(await screen.findByRole("toolbar", { name: "Godot" })).toBeTruthy();
    await screen.findByText("Playing");
    const rec = await screen.findByRole("button", { name: /^Rec/ });
    expect(rec.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(rec);
    await waitFor(() => expect(calls("play/record")).toHaveLength(1));
    expect(calls("play/record")[0][1]).toMatchObject({ on: false });
  });

  it("polls play/state with the project the pane has chosen", async () => {
    liveBackend({
      run: null,
      take: { state: "off" },
      projects: [project("game"), project("demo")],
    });
    // The shell reads the status now, often before Play has mounted, so it is
    // held here to see the poll Play sends before it knows any project.
    const answer = bridge.invoke.getMockImplementation()!;
    let releaseStatus = () => undefined as void;
    bridge.invoke.mockImplementation((method: string, params?: unknown) =>
      method === "godot/status"
        ? new Promise((r) => (releaseStatus = () => r(answer(method, params))))
        : answer(method, params),
    );
    render(<App />);
    await waitFor(() => expect(calls("play/state").length).toBeGreaterThan(0));
    expect(calls("play/state")[0][1]).not.toHaveProperty("project", expect.anything());
    releaseStatus();
    const picker = await screen.findByRole("combobox", { name: "Godot project" });
    await waitFor(() => expect(lastParams("play/state")?.project).toBe("game"), { timeout: 2000 });
    fireEvent.change(picker, { target: { value: "demo" } });
    await waitFor(() => expect(lastParams("play/state")?.project).toBe("demo"), { timeout: 2000 });
  });

  // The key is delivered once, as the backend does, and only after the pane
  // has seen the run. The old mock sent it on every poll, which hid both of
  // the cases after this one.
  it("stops and opens review when the game reports F7", async () => {
    const world = liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    world.keys = [{ seq: 1, key: "F7", t: 5 }];
    await waitFor(() => expect(calls("play/stop")).toHaveLength(1), { timeout: 2000 });
    await screen.findByText("Reviewing");
    await waitFor(() =>
      expect(calls("play/take").some((c) => (c[1] as { id: string }).id === TAKE_ID)).toBe(true),
    );
    expect(calls("play/stop")).toHaveLength(1);
  });

  it("does not act on keys the session had before the pane opened", async () => {
    liveBackend({ keys: [{ seq: 3, key: "F7", t: 5 }] });
    render(<App />);
    await screen.findByText("Playing");
    await waitFor(() => expect(calls("play/state").length).toBeGreaterThanOrEqual(4), {
      timeout: 2000,
    });
    expect(calls("play/stop")).toHaveLength(0);
    expect(screen.queryByText(/not recorded/)).toBeNull();
    expect(lastParams("play/state")?.keySince).toBe(3);
  });

  it("acts on a new run's first keys once the pane has drawn that run", async () => {
    const world = liveBackend({ run: null, take: { state: "off" } });
    render(<App />);
    await waitFor(() => expect(calls("play/state").length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    world.run = { id: 2, state: { kind: "running" } };
    world.take = RECORDING;
    world.keys = [{ seq: 1, key: "F7", t: 5 }];
    await waitFor(() => expect(calls("play/stop")).toHaveLength(1), { timeout: 2000 });
    expect(screen.queryByText(/not recorded/)).toBeNull();
  });

  it("hides the game while a shell overlay covers its box, and shows it again", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    placeBox();
    await waitFor(() => expect(lastParams("play/embed-rect")?.visible).toBe(true));
    events.get("veistra/overlays")?.({ rects: [{ x: 100, y: 100, width: 50, height: 50 }] });
    await waitFor(() =>
      expect(lastParams("play/embed-rect")).toMatchObject({ visible: false, w: 640 }),
    );
    await waitFor(() => expect(calls("play/still").length).toBeGreaterThan(0));
    events.get("veistra/overlays")?.({ rects: [] });
    await waitFor(() =>
      expect(lastParams("play/embed-rect")).toMatchObject({ visible: true, w: 640 }),
    );
  });

  // Spec §13 test 2: what covers the box is the game's last frame, not a hole.
  it("shows the game's last frame in the box while an overlay covers it", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    placeBox();
    await waitFor(() => expect(lastParams("play/embed-rect")?.visible).toBe(true));
    expect(screen.queryByRole("img", { name: "The game's last frame" })).toBeNull();
    events.get("veistra/overlays")?.({ rects: [{ x: 100, y: 100, width: 50, height: 50 }] });
    const img = await screen.findByRole("img", { name: "The game's last frame" });
    expect(img.getAttribute("src")).toBe("blob:frame");
    events.get("veistra/overlays")?.({ rects: [] });
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "The game's last frame" })).toBeNull(),
    );
  });

  // Spec §13 test 9: the reason Rust gives is the strip's line, and the box
  // shows the game's output rather than an empty frame.
  it("says the game is playing in its own window when it could not be placed", async () => {
    const reason =
      "Playing in its own window: placing it in the pane is switched off (VEISTRA_EMBED).";
    liveBackend({ take: { state: "off" }, embed: { kind: "ownWindow", reason, cause: "forced" } });
    render(<App />);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pop out into its own window" })).toBeNull();
    placeBox();
    await waitFor(() => expect(calls("play/embed-rect").length).toBeGreaterThan(0));
    events.get("veistra/overlays")?.({ rects: [{ x: 100, y: 100, width: 50, height: 50 }] });
    await waitFor(() => expect(lastParams("play/embed-rect")?.visible).toBe(false));
    expect(calls("play/still")).toHaveLength(0);
  });

  it("pops the game out into its own window and docks it back", async () => {
    liveBackend({ take: { state: "off" } });
    render(<App />);
    await screen.findByText("Playing");
    fireEvent.click(await screen.findByRole("button", { name: "Pop out into its own window" }));
    await waitFor(() => expect(calls("play/pop-out")).toHaveLength(1));
    await screen.findByText("Popped out into its own window. Dock brings it back.");
    fireEvent.click(await screen.findByRole("button", { name: "Dock into the pane" }));
    await waitFor(() => expect(calls("play/dock")).toHaveLength(1));
    await screen.findByRole("button", { name: "Pop out into its own window" });
    expect(calls("play/pop-out")).toHaveLength(1);
  });

  it("hides the game when review takes its box, and shows it again back in live", async () => {
    liveBackend({ takes: [LISTED] });
    render(<App />);
    await screen.findByText("Playing");
    placeBox();
    await waitFor(() =>
      expect(lastParams("play/embed-rect")).toMatchObject({ visible: true, w: 640 }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Takes · 1/ }));
    await screen.findByText("Reviewing");
    expect(lastParams("play/embed-rect")).toMatchObject({ visible: false, w: 640 });
    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    await waitFor(
      () => expect(lastParams("play/embed-rect")).toMatchObject({ visible: true, w: 640 }),
      { timeout: 2000 },
    );
  });

  it("sends the page's devicePixelRatio with the box, and again when it changes", async () => {
    let ratio = 1.5;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ratio });
    const changes: (() => void)[] = [];
    window.matchMedia = vi.fn(() => ({
      addEventListener: (_: string, cb: () => void) => changes.push(cb),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    placeBox();
    await waitFor(() =>
      expect(lastParams("play/embed-rect")).toMatchObject({ visible: true, w: 640, dpr: 1.5 }),
    );
    // A move to a monitor of another scale: no CSS pixel moves, only the ratio.
    ratio = 2;
    changes[changes.length - 1]();
    await waitFor(() =>
      expect(lastParams("play/embed-rect")).toMatchObject({ visible: true, w: 640, dpr: 2 }),
    );
  });

  it("shows Record blocked while it is on with capture gone, and turns it off", async () => {
    const blocked =
      "Recording needs the capture addon, version 2. Enable capture, then run the game.";
    liveBackend({ take: { state: "off" }, record: { on: true, blocked } });
    render(<App />);
    expect(await screen.findByText(blocked)).toBeTruthy();
    expect(screen.queryByText("Record is on; the next run is recorded.")).toBeNull();
    const rec = screen.getByRole("button", { name: /^Record/ });
    expect(rec.getAttribute("aria-pressed")).not.toBe("true");
    expect(rec.getAttribute("title")).toContain(blocked);
    fireEvent.click(rec);
    await waitFor(() => expect(calls("play/record")).toHaveLength(1));
    expect(calls("play/record")[0][1]).toMatchObject({ on: false });
  });

  it("ends live mark up when the run it paused is stopped", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    fireEvent.click(screen.getByRole("button", { name: "Mark up" }));
    // The markup layer is loaded on first use, which can take a while in jsdom.
    await screen.findByAltText("The frame being marked up", undefined, { timeout: 5000 });
    fireEvent.keyDown(pane(), { key: "F5", shiftKey: true });
    await waitFor(() => expect(calls("play/stop")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByAltText("The frame being marked up")).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame");
  });

  it("waits for a take the game's own exit is still saving, then opens it", async () => {
    const world = liveBackend({
      run: { id: 1, state: { kind: "exited", code: 0 } },
      take: { state: "saving", id: TAKE_ID, number: 4 },
    });
    render(<App />);
    await screen.findByText("Exited (0)");
    await screen.findAllByText("Saving take…");
    fireEvent.keyDown(pane(), { key: "F7" });
    setTimeout(() => {
      world.take = SAVED;
    }, 400);
    await screen.findByText("Reviewing", undefined, { timeout: 2000 });
    expect(screen.queryByText(/not recorded/)).toBeNull();
    expect(calls("play/take").some((c) => (c[1] as { id: string }).id === TAKE_ID)).toBe(true);
  });

  it("lists a take the game's own exit saved", async () => {
    const world = liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    expect(screen.queryByRole("button", { name: /Takes ·/ })).toBeNull();
    world.run = { id: 1, state: { kind: "exited", code: 0 } };
    world.take = SAVED;
    world.takes = [LISTED];
    await screen.findByRole("button", { name: /Takes · 1/ }, { timeout: 2000 });
  });

  it("lists the take a restart saved", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    fireEvent.keyDown(pane(), { key: "F5" });
    await waitFor(() => expect(calls("play/restart")).toHaveLength(1));
    await screen.findByRole("button", { name: /Takes · 1/ }, { timeout: 2000 });
  });

  it("lists the take that turning Record off saved", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    fireEvent.click(screen.getByRole("button", { name: /^Rec/ }));
    await waitFor(() => expect(calls("play/record")).toHaveLength(1));
    await screen.findByRole("button", { name: /Takes · 1/ }, { timeout: 2000 });
  });

  // This replaces "acts once on a key that two overlapping polls both carry":
  // polls no longer overlap, so that case cannot arise, and what keeps it
  // from arising is checked here instead.
  it("sends no poll while one waits for its answer, then acts once on its key", async () => {
    const world = liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    const held: (() => void)[] = [];
    world.held = held;
    await waitFor(() => expect(held).toHaveLength(1), { timeout: 2000 });
    const sent = calls("play/state").length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(calls("play/state")).toHaveLength(sent);
    world.keys = [{ seq: 1, key: "F7", t: 5 }];
    world.held = null;
    held[0]();
    await screen.findByText("Reviewing");
    expect(calls("play/stop")).toHaveLength(1);
  });

  // The first answer is late, so the interval fires while it waits. A second
  // poll sent then answered during the first one's refetch, past the opening
  // guard, and acted on the old F7 with the first render's actions.
  it("ignores keys from before the pane opened when its first poll answers late", async () => {
    const held: (() => void)[] = [];
    const world = liveBackend({ keys: [{ seq: 3, key: "F7", t: 5 }], held });
    render(<App />);
    await waitFor(() => expect(held.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 1200));
    world.held = null;
    for (const answer of held) answer();
    await screen.findByText("Playing");
    await waitFor(() => expect(lastParams("play/state")?.keySince).toBe(3), { timeout: 2000 });
    expect(calls("play/stop")).toHaveLength(0);
    expect(screen.queryByText(/Nothing has run here yet/)).toBeNull();
    expect(screen.queryByText(/not recorded/)).toBeNull();
  });

  it("says the window never reached the pane when F7 ends a take still starting", async () => {
    liveBackend({ take: { state: "starting", number: 4 } });
    render(<App />);
    await screen.findByText("Playing");
    fireEvent.keyDown(pane(), { key: "F7" });
    await waitFor(() => expect(calls("play/stop")).toHaveLength(1));
    expect(await screen.findByText(/Nothing was recorded: a take starts once/)).toBeTruthy();
    expect(screen.queryByText(/Turn on Record/)).toBeNull();
  });

  it("says nothing has run yet when F7 comes before any run", async () => {
    liveBackend({ run: null, take: { state: "off" } });
    render(<App />);
    await waitFor(() => expect(calls("play/state").length).toBeGreaterThanOrEqual(1));
    fireEvent.keyDown(pane(), { key: "F7" });
    expect(await screen.findByText(/Nothing has run here yet/)).toBeTruthy();
  });

  it("keeps the Rec clock while a take records, even once capture is gone", async () => {
    const blocked = "Recording needs the capture addon, version 2.";
    liveBackend({ record: { on: true, blocked } });
    render(<App />);
    await screen.findByText("Playing");
    const rec = await screen.findByRole("button", { name: /^Rec(?!ord)/ });
    await waitFor(() => expect(rec.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByText(blocked)).toBeNull();
  });
});
