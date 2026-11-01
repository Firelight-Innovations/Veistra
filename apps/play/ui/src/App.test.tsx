// @vitest-environment jsdom
/**
 * Play's send actions live in the shared footer, and still call the same
 * `context/put` the buttons used to: the log tail, and the captured frame.
 * Then the live view's own: Record, the keys the addon reports, and the
 * game box stepping aside for an overlay.
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
}));

import App from "./App";

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

const SESSION = {
  runId: 1,
  embed: { kind: "embedded" },
  embedded: true,
  take: { state: "recording", id: "2026-10-30-1402-0f3a", number: 4, startedAt: 1000 },
  zero: 1000,
  marks: [],
  keys: [] as { seq: number; key: string; t: number }[],
  ticks: 10,
  addon: 2,
};

function liveBackend(
  over: { keys?: { seq: number; key: string; t: number }[]; record?: boolean } = {},
) {
  let stopped = false;
  bridge.invoke.mockImplementation((method: string) => {
    const session = {
      ...SESSION,
      keys: stopped ? [] : (over.keys ?? []),
      take: stopped ? { state: "saved", id: "2026-10-30-1402-0f3a", number: 4 } : SESSION.take,
    };
    const live = { record: { on: over.record ?? true, blocked: null }, session };
    switch (method) {
      case "play/state":
        return Promise.resolve({
          run: { ...RUN, state: stopped ? { kind: "stopped" } : RUN.state },
          log: { lines: [], nextSeq: 0, truncated: false },
          live,
        });
      case "play/stop":
        stopped = true;
        return Promise.resolve({
          run: { ...RUN, state: { kind: "stopped" } },
          log: null,
          live: {
            ...live,
            session: {
              ...session,
              take: { state: "saved", id: "2026-10-30-1402-0f3a", number: 4 },
            },
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
      case "play/takes":
        return Promise.resolve({ takes: [], dir: "" });
      case "play/take":
        return new Promise(() => undefined);
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

describe("Play live view", () => {
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

  it("stops and opens review when the game reports F7", async () => {
    liveBackend({ keys: [{ seq: 1, key: "F7", t: 5 }] });
    render(<App />);
    await waitFor(() => expect(calls("play/stop").length).toBeGreaterThan(0));
    await screen.findByText("Reviewing");
    await waitFor(() =>
      expect(
        calls("play/take").some((c) => (c[1] as { id: string }).id === "2026-10-30-1402-0f3a"),
      ).toBe(true),
    );
  });

  it("hides the game while a shell overlay covers its box, and shows it again", async () => {
    liveBackend();
    render(<App />);
    await screen.findByText("Playing");
    events.get("veistra/window-rect")?.({ x: 0, y: 0, width: 800, height: 600 });
    // jsdom has no layout: the box measures 0 x 0, so place a box by hand.
    const box = document.querySelector(".pl-live__box") as HTMLElement;
    box.getBoundingClientRect = () =>
      ({ left: 10, top: 50, width: 640, height: 360, right: 650, bottom: 410 }) as DOMRect;
    events.get("veistra/overlays")?.({ rects: [] });
    await waitFor(() => {
      const last = calls("play/embed-rect").slice(-1)[0]?.[1] as { visible: boolean } | undefined;
      expect(last?.visible).toBe(true);
    });
    events.get("veistra/overlays")?.({ rects: [{ x: 100, y: 100, width: 50, height: 50 }] });
    await waitFor(() => {
      const last = calls("play/embed-rect").slice(-1)[0]?.[1] as { visible: boolean; w: number };
      expect(last).toMatchObject({ visible: false, w: 640 });
    });
    await waitFor(() => expect(calls("play/still").length).toBeGreaterThan(0));
  });
});
