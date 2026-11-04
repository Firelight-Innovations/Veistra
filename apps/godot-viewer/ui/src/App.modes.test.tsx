// @vitest-environment jsdom
/**
 * The Godot app's shell: which mode a pane opens in, what it remembers, and
 * what it catches for Play before Play is showing. The shell is the only part
 * loaded up front, so an event that arrives while Editor shows must still
 * reach Play after a switch: the bridge keeps no event nobody listened for,
 * and the shell does not send an unchanged window rect again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

import App from "./App";
// Both modes load lazily; loading them here keeps that inside a test's wait.
import "./SceneMode";
import "./play/PlayMode";

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

const project = (rel: string) => ({
  rel,
  name: rel,
  mainScene: null,
  mainScenePath: null,
  engineMajor: 4,
  addon: "yes",
});

/** A running, embedded game, a scene to read, and `projects` in the environment. */
function backend(projects: unknown[] = []) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "play/state":
      case "play/run":
        return Promise.resolve({
          run: RUN,
          log: { lines: [], nextSeq: 0, truncated: false },
          live: {
            record: { on: false, blocked: null },
            session: {
              runId: 1,
              embed: { kind: "embedded" },
              embedded: true,
              zero: 0,
              marks: [],
              ticks: 0,
              addon: 2,
              take: { state: "off" },
              keys: [],
            },
          },
        });
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: false, kind: null, branch: null },
          executable: { found: null, problems: [], setting: "" },
          projects,
          editor: {
            surface: "viewer",
            code: "noEditor",
            reason: "Godot 4 was not found on this computer. Set its path under Settings, Godot.",
          },
        });
      case "godot-viewer/state":
        return Promise.resolve({
          project: ".",
          scenes: ["res://main.tscn"],
          scene: "res://main.tscn",
          renderedAt: 1,
          scenePath: "res://main.tscn",
          nodes: [],
          source: "parsed",
          godot: null,
          note: null,
          imageAt: null,
          job: null,
          engineFound: false,
        });
      case "comments/list":
        return Promise.resolve([]);
      case "play/takes":
        return Promise.resolve({ takes: [], dir: "" });
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);
const lastParams = (method: string) =>
  calls(method).slice(-1)[0]?.[1] as Record<string, unknown> | undefined;

async function modeTab(name: "Editor" | "Play") {
  const bar = await screen.findByRole("toolbar", { name: "Godot" });
  return within(bar).getByRole("tab", { name });
}

async function showing(name: "Editor" | "Play") {
  await waitFor(async () =>
    expect((await modeTab(name)).getAttribute("aria-selected")).toBe("true"),
  );
}

const BOX = { left: 10, top: 50, width: 640, height: 360, right: 650, bottom: 410 } as DOMRect;
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  bridge.invoke.mockReset();
  events.clear();
  localStorage.clear();
  history.replaceState({}, "", "/");
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.classList.contains("pl-live__box") ? BOX : realRect.call(this);
  };
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
});

describe("The Godot app's modes", () => {
  it("opens in Editor, and in Play when the play id opens it", async () => {
    backend();
    render(<App />);
    await showing("Editor");
    cleanup();
    history.replaceState({}, "", "/?mode=play");
    render(<App />);
    await showing("Play");
  });

  it("comes back in the mode this pane last showed, over its URL's", async () => {
    backend();
    history.replaceState({}, "", "/?mode=play");
    localStorage.setItem("godot.mode.i1", "editor");
    render(<App />);
    await showing("Editor");
    fireEvent.click(await modeTab("Play"));
    await showing("Play");
    expect(localStorage.getItem("godot.mode.i1")).toBe("play");
  });

  it("places the game from a window rect that came while Editor showed", async () => {
    backend();
    render(<App />);
    await showing("Editor");
    events.get("veistra/window-rect")?.({ x: 0, y: 0, width: 800, height: 600 });
    events.get("veistra/overlays")?.({ rects: [] });
    fireEvent.click(await modeTab("Play"));
    await screen.findByText("Playing");
    await waitFor(() =>
      expect(lastParams("play/embed-rect")).toMatchObject({ visible: true, w: 640 }),
    );
  });

  it("hides the game when the pane turns to Editor", async () => {
    backend();
    history.replaceState({}, "", "/?mode=play");
    render(<App />);
    await screen.findByText("Playing");
    events.get("veistra/window-rect")?.({ x: 0, y: 0, width: 800, height: 600 });
    await waitFor(() => expect(lastParams("play/embed-rect")?.visible).toBe(true));
    fireEvent.click(await modeTab("Editor"));
    await showing("Editor");
    expect(lastParams("play/embed-rect")).toMatchObject({ visible: false });
  });

  it("turns to Play and runs the scene an open names, in its project", async () => {
    backend();
    render(<App />);
    await showing("Editor");
    events.get("veistra:opened")?.({ scene: "res://levels/hallway.tscn", project: "games/b" });
    await showing("Play");
    await waitFor(() => expect(calls("play/run")).toHaveLength(1));
    expect(calls("play/run")[0][1]).toMatchObject({
      scene: "res://levels/hallway.tscn",
      project: "games/b",
    });
    // Back and forth again runs nothing more: the open was for one run.
    fireEvent.click(await modeTab("Editor"));
    fireEvent.click(await modeTab("Play"));
    await screen.findByText("Playing");
    expect(calls("play/run")).toHaveLength(1);
  });

  it("shows Play for an open of the play id that names nothing to run", async () => {
    backend();
    history.replaceState({}, "", "/?mode=play");
    localStorage.setItem("godot.mode.i1", "editor");
    render(<App />);
    await showing("Editor");
    events.get("veistra:opened")?.(null);
    await showing("Play");
    expect(calls("play/run")).toHaveLength(0);
  });

  it("leaves a Godot pane in Editor for an open that names nothing to run", async () => {
    backend();
    render(<App />);
    await showing("Editor");
    events.get("veistra:opened")?.({ scene: "C:/elsewhere.tscn" });
    await new Promise((r) => setTimeout(r, 50));
    await showing("Editor");
  });

  // The keys are bound on each mode's root, and the tab that was pressed goes
  // with the mode it sat in; left on the page, F5 would reload the pane.
  it("gives the focus to the mode a switch brings in", async () => {
    // jsdom forgets the document had the focus when the focused element goes.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    backend();
    history.replaceState({}, "", "/?mode=play");
    const { container } = render(<App />);
    await screen.findByText("Playing");
    const editor = await modeTab("Editor");
    editor.focus();
    fireEvent.click(editor);
    await showing("Editor");
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector(".gv")));
    const play = await modeTab("Play");
    play.focus();
    fireEvent.click(play);
    await screen.findByText("Playing");
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector(".pl")));
    hasFocus.mockRestore();
  });

  it("keeps Play's project across a switch to Editor and back", async () => {
    backend([project("game"), project("demo")]);
    history.replaceState({}, "", "/?mode=play");
    render(<App />);
    const picker = await screen.findByRole("combobox", { name: "Godot project" });
    fireEvent.change(picker, { target: { value: "demo" } });
    fireEvent.click(await modeTab("Editor"));
    await showing("Editor");
    fireEvent.click(await modeTab("Play"));
    const again = (await screen.findByRole("combobox", {
      name: "Godot project",
    })) as HTMLSelectElement;
    expect(again.value).toBe("demo");
  });
});
