// @vitest-environment jsdom
/**
 * Editor mode with the Godot editor in the pane (#316): the Veistra bar, the
 * box the editor's window is placed over, and the three tools the plugin
 * answers. The backend is a mock that answers `godot/editor-*` as
 * `src-tauri/src/godot/editor.rs` does; what the editor itself does is in
 * `editor_tests.rs` and `plugin.gd.test.ts`. The markup layer needs a canvas
 * jsdom does not have, so it is stood in for by a Done button.
 *
 * The editor opens by itself when the mode mounts, after the plugin question
 * where the project has none; `WITH_PLUGIN` skips the question, and the pop
 * out surface opens nothing by itself, for the tests about what the pane says
 * before an editor runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GodotStatus } from "../../../../shared/godot";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  on: () => () => undefined,
  publish: vi.fn(),
}));

/** A markup with one pin, drawn on a frame shown at 640 x 360. */
const markup = vi.hoisted(() => () => ({
  png: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  json: {
    version: 1,
    source: { kind: "image" },
    size: { width: 640, height: 360 },
    pins: [{ n: 1, note: "this one" }],
    annotations: [],
    excalidraw: {
      elements: [
        { x: 20, y: 30, width: 20, height: 20, customData: { veistra: { kind: "pin", n: 1 } } },
      ],
      appState: { viewBackgroundColor: "transparent" },
    },
  },
}));

vi.mock("../play/FrameMarkup", () => ({
  default: (p: {
    path: string;
    onDone: (r: unknown, shown: { width: number; height: number }) => void;
    onCancel: () => void;
  }) => (
    <div role="dialog" aria-label="Mark up">
      <span>{p.path}</span>
      <button type="button" onClick={() => p.onDone(markup(), { width: 640, height: 360 })}>
        Done
      </button>
      <button type="button" onClick={p.onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

import EditorMode, { editorChip, type EditorModeProps } from "./EditorMode";
import { MODES } from "../modes";

const WHY =
  "Send selection needs the Veistra plugin in this project: close the editor, enable the plugin here, then open it again.";

const HALL = {
  rel: ".",
  name: "Hall",
  mainScene: "res://main.tscn",
  mainScenePath: "main.tscn",
  engineMajor: 4,
  addon: "no",
  plugin: "no",
} as const;

const STATUS: GodotStatus = {
  environment: { root: "C:/p", readOnly: false, kind: "localWorktree", branch: "wt/hall" },
  executable: { found: null, problems: [], setting: "" },
  projects: [HALL],
  editor: { surface: "embedded", reason: null, code: null },
  pluginProblem: null,
};

/** A project with the plugin in already, so nothing is asked before the editor opens. */
const WITH_PLUGIN: GodotStatus = { ...STATUS, projects: [{ ...HALL, plugin: "yes" }] };

/** No embedder: the editor opens in its own window, and only on a press. */
const POP_OUT = {
  surface: "popOut" as const,
  code: "noEmbedder" as const,
  reason: "Godot opens in its own window: Veistra cannot place it on macOS yet.",
};

const VIEW = {
  scene: "res://main.tscn",
  open: ["res://main.tscn"],
  screen: "3D",
  selected: [{ path: "Main/Enemy", type: "CharacterBody3D", script: "" }],
  viewportOnly: false,
};

const CAMERA = { pos: [0, 2, 5], target: [0, 2, 4], up: [0, 1, 0], fov: 75 };

/** `godot/editor-state`'s `editor`, with the plugin running unless a test says not. */
function editorInfo(over: { embed?: object; running?: boolean; view?: object | null } = {}) {
  const running = over.running ?? true;
  return {
    project: ".",
    pid: 42,
    godot: "C:/godot.exe",
    embed: { state: over.embed ?? { kind: "embedded" }, still: true },
    plugin: {
      installed: running ? "yes" : "no",
      running,
      problem: null,
      why: running ? null : WHY,
    },
    view: over.view !== undefined ? over.view : running ? VIEW : null,
  };
}

interface World {
  editor: ReturnType<typeof editorInfo> | null;
  agent: boolean;
  ended: { project: string; code: number | null } | null;
  selection: object;
  /** Presses in the editor's Veistra dock, handed on until answered (#320). */
  events: { seq: number; n: number; [k: string]: unknown }[];
  /** What `godot/editor-open` fails with, or `null` to start the editor. */
  openError: string | null;
  /** Held until it settles, so a test can see the pane while Godot starts. */
  openGate: Promise<void> | null;
}

function backend(over: Partial<World> = {}): World {
  const world: World = {
    editor: null,
    agent: false,
    ended: null,
    selection: { pngBase64: "AAAA", width: 1280, height: 720, camera: CAMERA, ...VIEW },
    events: [],
    openError: null,
    openGate: null,
    ...over,
  };
  let item = 0;
  bridge.invoke.mockImplementation((method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "godot/editor-state": {
        const ended = world.ended;
        world.ended = null;
        const since = Number(params?.eventsSince ?? 0);
        const events = world.events.filter((e) => e.seq > since);
        return Promise.resolve({
          editor: world.editor && { ...world.editor, events },
          agent: world.agent,
          ...(ended ? { ended } : {}),
        });
      }
      case "godot/editor-ack":
        world.events = world.events.filter((e) => e.n !== params?.n);
        return Promise.resolve({ acked: params?.n });
      case "godot/editor-open":
        if (world.openError) return Promise.reject(new Error(world.openError));
        return (world.openGate ?? Promise.resolve()).then(() => {
          world.editor = editorInfo({ embed: { kind: "waiting" } });
          return { editor: world.editor, agent: world.agent };
        });
      case "godot/editor-selection":
        return Promise.resolve(world.selection);
      case "godot/editor-capture":
        return Promise.resolve({ pngBase64: "AAAA", width: 1280, height: 720, camera: CAMERA });
      case "godot/editor-pick":
        return Promise.resolve({
          hit: { nodePath: "Main/Enemy", worldPoint: [1, 2, 3], source: "editor" },
        });
      case "godot/editor-viewport-only":
        return Promise.resolve({ viewportOnly: params?.on });
      case "godot/editor-open-scene":
        return Promise.resolve({ scene: params?.scene });
      case "godot/editor-save":
        return Promise.resolve({ saved: true });
      case "godot/plugin-install":
        return Promise.resolve({
          plugin: "yes",
          problem: null,
          editorOpen: false,
          readOnly: false,
        });
      case "godot-viewer/state":
        return Promise.resolve({ scenes: ["res://main.tscn", "res://levels/b.tscn"] });
      case "context/put":
        return Promise.resolve({ id: `item${++item}` });
      case "veistra/attach-to-agent":
        return Promise.resolve({ delivered: 1 });
      case "embed/still":
        return Promise.resolve({ png: "AAAA", source: "window" });
      default:
        return Promise.resolve(null);
    }
  });
  return world;
}

const reloadStatus = vi.fn(() => Promise.resolve());

function props(over: Partial<EditorModeProps> = {}): EditorModeProps {
  return {
    modeSwitch: { value: "editor", options: MODES, onChange: vi.fn() },
    status: STATUS,
    statusError: null,
    reloadStatus,
    epoch: 0,
    frameRect: { x: 0, y: 0, width: 800, height: 600 },
    ...over,
  };
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);
/** The items left as chips at the agent's prompt, in order. */
const chipped = () =>
  calls("veistra/attach-to-agent").map((c) => (c[1] as { contextId: string }).contextId);
const lastParams = (method: string) =>
  calls(method).slice(-1)[0]?.[1] as Record<string, unknown> | undefined;
/** Where each method was first called, to check what came before what. */
const order = (method: string) => bridge.invoke.mock.calls.findIndex((c) => c[0] === method);
const bar = () => screen.getByRole("toolbar", { name: "Godot" });
const button = (name: string | RegExp) =>
  within(bar()).getByRole("button", { name }) as HTMLButtonElement;
const question = () => screen.getByRole("dialog", { name: "Enable the Veistra plugin" });
/** Waits for `n` more answers to the poll, for "and nothing happened since". */
async function polls(n = 2) {
  const at = calls("godot/editor-state").length;
  await waitFor(() => expect(calls("godot/editor-state").length).toBeGreaterThanOrEqual(at + n), {
    timeout: 3000,
  });
}

const BOX = { left: 10, top: 50, width: 640, height: 360, right: 650, bottom: 410 } as DOMRect;
const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  bridge.invoke.mockReset();
  reloadStatus.mockClear();
  localStorage.clear();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.classList.contains("ge__box") ? BOX : realRect.call(this);
  };
  URL.createObjectURL = vi.fn(() => "blob:frame");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
});

describe("the editor's state chip", () => {
  it("says one word for where the editor is", () => {
    const at = (embed: object) => ({ editor: editorInfo({ embed }), agent: false }) as never;
    expect(editorChip(null).label).toBe("Not open");
    expect(editorChip(at({ kind: "waiting" })).label).toBe("Starting");
    expect(editorChip(at({ kind: "embedded" }))).toMatchObject({
      tone: "success",
      label: "Editing",
    });
    expect(editorChip(at({ kind: "poppedOut" })).label).toBe("Popped out");
    const own = editorChip(at({ kind: "ownWindow", reason: "Placing is off.", cause: "forced" }));
    expect(own).toMatchObject({ label: "Own window", title: "Placing is off." });
  });
});

describe("Editor mode before the editor opens", () => {
  // The plugin question is up, so nothing has opened behind it yet.
  it("draws the bar's slots in order, with every tool saying why it waits", async () => {
    backend();
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("godot/editor-state").length).toBeGreaterThan(0));
    expect(within(bar()).getByRole("tab", { name: "Editor" })).toBeTruthy();
    const env = bar().querySelector(".k-vtb__env")!;
    expect(env.getAttribute("data-env-kind")).toBe("localWorktree");
    const name = within(bar()).getByText("Hall");
    expect(env.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bar()).getByRole("status").textContent).toBe("Not open");
    const actions = bar().querySelector(".k-vtb__actions") as HTMLElement;
    const tools = ["Viewport only", "Mark up", "Send selection"].map(
      (n) => within(actions).getByRole("button", { name: n }) as HTMLButtonElement,
    );
    for (const t of tools) {
      expect(t.disabled).toBe(true);
      expect(t.title).toBe("Open the editor first.");
    }
    expect(button("Pop out into its own window").disabled).toBe(true);
    // Godot is quit from inside Godot; the bar has no Close.
    expect(within(bar()).queryByRole("button", { name: /Close/ })).toBeNull();
    expect(calls("godot/editor-open")).toHaveLength(0);
  });

  it("opens the editor by itself on the project shown, with no press", async () => {
    let let_go = () => undefined as void;
    backend({ openGate: new Promise<void>((r) => (let_go = r)) });
    render(<EditorMode {...props({ status: WITH_PLUGIN })} />);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(lastParams("godot/editor-open")).toEqual({ project: "." });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Opening, not the prompt, while Godot starts.
    const opening = screen.getByRole("button", { name: "Opening…" }) as HTMLButtonElement;
    expect(opening.disabled).toBe(true);
    expect(screen.queryByText(/It opens here, in this pane/)).toBeNull();
    let_go();
    await waitFor(() => expect(within(bar()).getByRole("status").textContent).toBe("Starting"));
    await polls();
    expect(calls("godot/editor-open")).toHaveLength(1);
  });

  it("starts the editor on a scene opened from the Explorer, and takes the reveal as done", async () => {
    backend();
    const onRevealHandled = vi.fn();
    const reveal = { n: 4, tool: "godot" as const, file: "levels/hall.tscn" };
    render(<EditorMode {...props({ status: WITH_PLUGIN, reveal, onRevealHandled })} />);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(lastParams("godot/editor-open")).toEqual({
      project: ".",
      scene: "res://levels/hall.tscn",
    });
    expect(onRevealHandled).toHaveBeenCalledWith(4);
  });

  it("says why when the editor would not open, and offers Open the editor again", async () => {
    const world = backend({ openError: "Godot did not start: the file is not an executable." });
    render(<EditorMode {...props({ status: WITH_PLUGIN })} />);
    expect(await screen.findByText(/Godot did not start/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Open the editor" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    // It does not try again by itself.
    await polls();
    expect(calls("godot/editor-open")).toHaveLength(1);
    world.openError = null;
    fireEvent.click(retry);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(2));
    await waitFor(() => expect(within(bar()).getByRole("status").textContent).toBe("Starting"));
    expect(screen.queryByText(/Godot did not start/)).toBeNull();
  });

  // The box reports where it is before the launch, so Godot starts at the
  // pane's size and place rather than jumping into it.
  it("tells the backend where the box is, as the editor's", async () => {
    backend();
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("embed/rect").length).toBeGreaterThan(0));
    expect(lastParams("embed/rect")).toMatchObject({ kind: "godotEditor", w: 640, h: 360 });
  });

  it("asks about the plugin first, as a modal, says what it adds, adds it, then opens", async () => {
    backend();
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(question()).toBeTruthy());
    const dialog = question();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.parentElement?.className).toBe("ge__scrim");
    expect(dialog.textContent).toContain("Add the Veistra plugin to Hall?");
    expect(dialog.textContent).toContain("addons/veistra/plugin.cfg");
    expect(dialog.textContent).toContain("addons/veistra/veistra_editor.gd");
    expect(dialog.textContent).toContain("addons/veistra/veistra_dock.gd");
    expect(dialog.textContent).toContain("Veistra dock");
    expect(dialog.textContent).toContain("[editor_plugins]");
    expect(dialog.textContent).toContain("the selected nodes, the edited scene");
    expect(dialog.textContent).toContain("saves the editor when you press Save all");
    expect(dialog.textContent).toContain("No network port");
    expect(dialog.textContent).toContain("does nothing in an exported build");
    const add = within(dialog).getByRole("button", { name: "Add to this project" });
    expect(document.activeElement).toBe(add);
    await polls();
    expect(calls("godot/plugin-install")).toHaveLength(0);
    expect(calls("godot/editor-open")).toHaveLength(0);
    fireEvent.click(add);
    await waitFor(() => expect(calls("godot/plugin-install")).toHaveLength(1));
    expect(lastParams("godot/plugin-install")).toEqual({ project: "." });
    await waitFor(() => expect(reloadStatus).toHaveBeenCalledWith(false));
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(order("godot/plugin-install")).toBeLessThan(order("godot/editor-open"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the editor on Not now too, and does not ask again on this project", async () => {
    backend();
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(question()).toBeTruthy());
    fireEvent.click(within(question()).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(calls("godot/plugin-install")).toHaveLength(0);
    cleanup();
    bridge.invoke.mockReset();
    backend();
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the question, and Escape is Not now", async () => {
    backend();
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(question()).toBeTruthy());
    const notNow = within(question()).getByRole("button", { name: "Not now" });
    const add = within(question()).getByRole("button", { name: "Add to this project" });
    expect(document.activeElement).toBe(add);
    fireEvent.keyDown(add, { key: "Tab" });
    expect(document.activeElement).toBe(notNow);
    fireEvent.keyDown(notNow, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(add);
    fireEvent.keyDown(add, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(calls("godot/plugin-install")).toHaveLength(0);
  });

  it("asks nothing and opens nothing on a read-only checkout", async () => {
    backend();
    const status = { ...STATUS, environment: { ...STATUS.environment, readOnly: true } };
    render(<EditorMode {...props({ status })} />);
    await polls();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("godot/editor-open")).toHaveLength(0);
  });

  it("offers to remove the plugin where it is on, without asking first", async () => {
    backend();
    const status = { ...WITH_PLUGIN, editor: POP_OUT };
    render(<EditorMode {...props({ status })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove the plugin" }));
    await waitFor(() => expect(calls("godot/plugin-remove")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why this Godot cannot run the plugin, with nothing to press or answer", async () => {
    backend();
    const problem = "The Veistra plugin needs Godot 4.2 or later; this is 4.1.3.";
    render(
      <EditorMode {...props({ status: { ...STATUS, editor: POP_OUT, pluginProblem: problem } })} />,
    );
    expect(await screen.findByText(problem)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /the plugin$/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Only the pane opens by itself: an editor in its own window is a press.
  it("says where it opens when nothing can place it, and waits for the press", async () => {
    backend();
    render(<EditorMode {...props({ status: { ...WITH_PLUGIN, editor: POP_OUT } })} />);
    expect(
      await screen.findByText(/It opens in its own window, for the reason above/),
    ).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("macOS");
    await polls();
    expect(calls("godot/editor-open")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open the editor" }));
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
  });
});

describe("Editor mode with the editor open", () => {
  // A shell menu over the editor no longer hides it: the backend cuts the
  // editor away under the menu (`embed_overlays`, `embed::holes`), because a
  // child window has no still and hiding it blanked the whole pane.
  it("shows nothing of its own over the editor, and keeps it shown", async () => {
    backend({ editor: editorInfo() });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(within(bar()).getByRole("status").textContent).toBe("Editing"));
    expect(screen.getByText("The Godot editor is shown here.").className).toBe("ge__sr");
    await waitFor(() => expect(lastParams("embed/rect")?.visible).toBe(true));
    expect(lastParams("embed/still")).toBeUndefined();
  });

  it("says why each tool waits while the plugin is not running", async () => {
    backend({ editor: editorInfo({ running: false }) });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(button("Send selection").title).toBe(WHY));
    for (const name of ["Viewport only", "Mark up", "Send selection"]) {
      expect(button(name).disabled).toBe(true);
      expect(button(name).title).toBe(WHY);
    }
    expect(within(bar()).queryByRole("combobox", { name: "Scene" })).toBeNull();
  });

  // Spec §13 test 11: the nodes and the viewport, in one message.
  it("sends the selection and the viewport as one message", async () => {
    backend({ editor: editorInfo() });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(button("Send selection").disabled).toBe(false));
    fireEvent.click(button("Send selection"));
    // One chip, the selection's; the picture rides in its hidden prompt.
    await waitFor(() => expect(chipped()).toEqual(["item2"]));
    expect(calls("context/insert")).toHaveLength(0);
    const puts = calls("context/put");
    expect(puts.map((c) => (c[1] as { kind: string }).kind)).toEqual(["image", "text"]);
    expect((puts[1]![1] as { text: string }).text).toContain("- Main/Enemy (CharacterBody3D)");
    expect(calls("godot/editor-selection")).toHaveLength(1);
    expect(order("godot/editor-selection")).toBeLessThan(order("context/put"));
    expect(await within(bar()).findByRole("button", { name: "Sent" })).toBeTruthy();
  });

  it("says so when nothing is selected, and sends nothing", async () => {
    backend({
      editor: editorInfo(),
      selection: { pngBase64: "AAAA", width: 1, height: 1, ...VIEW, selected: [] },
    });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(button("Send selection").disabled).toBe(false));
    fireEvent.click(button("Send selection"));
    expect(await screen.findByText(/Nothing is selected in Godot/)).toBeTruthy();
    expect(calls("context/put")).toHaveLength(0);
  });

  it("marks up a still of the viewport, and names the node under each pin", async () => {
    backend({ editor: editorInfo() });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(button("Mark up").disabled).toBe(false));
    fireEvent.click(button("Mark up"));
    const layer = await screen.findByRole("dialog", { name: "Mark up" });
    expect(lastParams("godot/editor-capture")).toEqual({ what: "viewport" });
    expect(layer.textContent).toContain("res://main.tscn (editor viewport)");
    // The editor's window is out of the way while the pane draws.
    await waitFor(() => expect(lastParams("embed/rect")?.visible).toBe(false));
    fireEvent.click(within(layer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(chipped()).toHaveLength(1));
    // The pin's centre on the 640 x 360 frame, in the 1280 x 720 capture.
    expect(calls("godot/editor-pick").map((c) => c[1])).toEqual([{ x: 60, y: 80 }]);
    expect(order("godot/editor-pick")).toBeLessThan(order("context/put"));
    const [notes, image] = calls("context/put").map((c) => c[1] as Record<string, string>);
    expect(image).toMatchObject({ kind: "image", key: "godot/main.tscn/markup" });
    const json = JSON.parse(notes!.text) as Record<string, never>;
    expect(json.source).toMatchObject({
      engine: "godot",
      view: "editor",
      scene: "res://main.tscn",
    });
    expect(json.pins).toEqual([
      { n: 1, note: "this one", nodePath: "Main/Enemy", worldPoint: [1, 2, 3] },
    ]);
    expect(json.camera).toEqual({ position: [0, 2, 5], target: [0, 2, 4], up: [0, 1, 0], fov: 75 });
    expect(await screen.findByText("Markup sent to the agent.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Mark up" })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame");
  });

  it("turns Viewport only on in the editor and shows it pressed", async () => {
    backend({ editor: editorInfo() });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(button("Viewport only").disabled).toBe(false));
    expect(button("Viewport only").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("Viewport only"));
    await waitFor(() => expect(lastParams("godot/editor-viewport-only")).toEqual({ on: true }));
    await waitFor(() => expect(button("Viewport only").getAttribute("aria-pressed")).toBe("true"));
  });

  it("opens a scene in the editor from the picker", async () => {
    backend({ editor: editorInfo() });
    render(<EditorMode {...props()} />);
    const picker = (await within(bar()).findByRole("combobox", {
      name: "Scene",
    })) as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(2));
    fireEvent.change(picker, { target: { value: "res://levels/b.tscn" } });
    await waitFor(() =>
      expect(lastParams("godot/editor-open-scene")).toEqual({ scene: "res://levels/b.tscn" }),
    );
  });

  // Godot is quit from inside Godot now; the pane says so and leaves it shut.
  it("says the editor closed when Godot is quit, and does not open it again", async () => {
    const world = backend({ editor: editorInfo() });
    render(<EditorMode {...props({ status: WITH_PLUGIN })} />);
    await waitFor(() => expect(within(bar()).getByRole("status").textContent).toBe("Editing"));
    world.editor = null;
    world.ended = { project: ".", code: 0 };
    expect(await screen.findByText("The editor closed.")).toBeTruthy();
    expect(within(bar()).getByRole("status").textContent).toBe("Not open");
    const open = screen.getByRole("button", { name: "Open the editor" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    await polls();
    expect(calls("godot/editor-open")).toHaveLength(0);
  });

  // The open on mount is once: an editor it opened that then quits, or
  // crashes, stays shut until Open the editor is pressed.
  it("does not open again an editor it opened by itself, once that has ended", async () => {
    const world = backend();
    render(<EditorMode {...props({ status: WITH_PLUGIN })} />);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    await waitFor(() => expect(within(bar()).getByRole("status").textContent).toBe("Starting"));
    world.editor = null;
    world.ended = { project: ".", code: 1 };
    expect(await screen.findByText("The editor exited with code 1.")).toBeTruthy();
    await polls();
    expect(calls("godot/editor-open")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open the editor" }));
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(2));
  });

  // An editor that ended just before the pane looked is not started again either.
  it("says the exit code when the editor did not close cleanly, and leaves it shut", async () => {
    backend({ ended: { project: ".", code: 3 } });
    render(<EditorMode {...props()} />);
    expect(await screen.findByText("The editor exited with code 3.")).toBeTruthy();
    await polls();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("godot/editor-open")).toHaveLength(0);
  });

  it("pops the editor out and docks it back", async () => {
    const world = backend({ editor: editorInfo() });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(button("Pop out into its own window").disabled).toBe(false));
    fireEvent.click(button("Pop out into its own window"));
    await waitFor(() => expect(lastParams("embed/pop-out")).toEqual({ kind: "godotEditor" }));
    world.editor = editorInfo({ embed: { kind: "poppedOut" } });
    fireEvent.click(await within(bar()).findByRole("button", { name: "Dock into the pane" }));
    await waitFor(() => expect(lastParams("embed/dock")).toEqual({ kind: "godotEditor" }));
    expect(button("Mark up").disabled).toBe(true);
    expect(button("Mark up").title).toMatch(/Dock the editor first/);
  });

  it("says why it is in its own window when it could not be placed", async () => {
    const reason = "Godot is in its own window: its window did not appear in time.";
    backend({ editor: editorInfo({ embed: { kind: "ownWindow", reason, cause: "timeout" } }) });
    render(<EditorMode {...props()} />);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(button("Pop out into its own window").disabled).toBe(true);
  });
});

describe("the agent banner", () => {
  it("shows while an agent works here, and Save all asks the editor to save", async () => {
    const world = backend({ editor: editorInfo(), agent: true });
    render(<EditorMode {...props()} />);
    const banner = await screen.findByRole("note", { name: "An agent is working here" });
    expect(banner.textContent).toContain("Save in Godot before you send");
    fireEvent.click(within(banner).getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(calls("godot/editor-save")).toHaveLength(1));
    world.agent = false;
    await waitFor(() => expect(screen.queryByRole("note", { name: /agent/ })).toBeNull());
  });

  it("says how to save by hand while the plugin is not running", async () => {
    backend({ editor: editorInfo({ running: false }), agent: true });
    render(<EditorMode {...props()} />);
    const banner = await screen.findByRole("note", { name: "An agent is working here" });
    const save = within(banner).getByRole("button", { name: "Save all" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toContain("press Ctrl S in Godot");
  });

  it("is not shown with no editor open", async () => {
    backend({ agent: true });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("godot/editor-state").length).toBeGreaterThan(0));
    await screen.findByRole("button", { name: "Open the editor" });
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("the editor's Veistra dock (#320)", () => {
  const ASK = {
    seq: 1,
    n: 1730000000001,
    t: 1730000000001,
    kind: "ask",
    text: "Why does it float?",
    scene: "res://main.tscn",
    nodes: ["Main/Enemy_02"],
    camera: CAMERA,
    pngBase64: "BBBB",
    pngProblem: null,
  };

  // Done when: Ask sends the text, the node path and a viewport image in one message.
  it("sends the dock's question with its nodes and picture in one message, then answers it", async () => {
    backend({ editor: editorInfo(), events: [ASK] });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("godot/editor-ack")).toHaveLength(1));
    expect(lastParams("godot/editor-ack")).toEqual({
      n: ASK.n,
      ok: true,
      message: "Sent to the agent.",
    });
    const puts = calls("context/put").map((c) => c[1] as Record<string, string>);
    expect(puts.map((p) => p.kind)).toEqual(["image", "text"]);
    expect(puts[1]!.text).toContain("Why does it float?");
    expect(puts[1]!.text).toContain("Main/Enemy_02");
    expect(puts[0]!.bytesBase64).toBe("BBBB");
    expect(chipped()).toEqual(["item2"]);
    // The next poll asks only for what came after it.
    await waitFor(() => expect(lastParams("godot/editor-state")).toEqual({ eventsSince: 1 }));
    expect(chipped()).toHaveLength(1);
  });

  // The same path as Blender's Mention in agent, which added no chip there.
  it("makes one chip of the nodes a dock mention names, and answers the dock", async () => {
    const mention = {
      seq: 1,
      n: 1730000000009,
      t: 1730000000009,
      kind: "mention" as const,
      what: "selection" as const,
      scene: "res://main.tscn",
      nodes: ["Main/Enemy"],
      path: null,
      pngBase64: null,
      pngProblem: null,
    };
    backend({ editor: editorInfo(), events: [mention] });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("godot/editor-ack")).toHaveLength(1));
    expect(lastParams("godot/editor-ack")).toEqual({
      n: mention.n,
      ok: true,
      message: "In the agent's prompt.",
    });
    const puts = calls("context/put").map((c) => c[1] as Record<string, string>);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ kind: "json", label: "Godot · Enemy" });
    expect(chipped()).toEqual(["item1"]);
  });

  it("opens Mark up for the dock's button, and refuses it while the plugin is not running", async () => {
    backend({ editor: editorInfo(), events: [{ seq: 1, n: 7, t: 7, kind: "markup" }] });
    render(<EditorMode {...props()} />);
    expect(await screen.findByRole("dialog", { name: "Mark up" })).toBeTruthy();
    await waitFor(() =>
      expect(lastParams("godot/editor-ack")).toEqual({
        n: 7,
        ok: true,
        message: "Mark up is open in Veistra.",
      }),
    );
    cleanup();
    bridge.invoke.mockReset();
    backend({
      editor: editorInfo({ running: false }),
      events: [{ seq: 1, n: 8, t: 8, kind: "markup" }],
    });
    render(<EditorMode {...props()} />);
    await waitFor(() =>
      expect(lastParams("godot/editor-ack")).toEqual({ n: 8, ok: false, message: WHY }),
    );
    expect(screen.queryByRole("dialog", { name: "Mark up" })).toBeNull();
  });

  it("carries a verdict from the dock to the note, expecting it fixed", async () => {
    const verdict = { seq: 1, n: 9, t: 9, kind: "verdict", id: "c1", verdict: "good", reply: null };
    backend({ editor: editorInfo(), events: [verdict] });
    render(<EditorMode {...props()} />);
    await waitFor(() => expect(calls("godot/editor-ack")).toHaveLength(1));
    expect(lastParams("comments/verdict")).toEqual({
      id: "c1",
      verdict: "good",
      reply: undefined,
      expect: "fixed",
    });
    expect(lastParams("godot/editor-ack")).toEqual({ n: 9, ok: true, message: "Marked resolved." });
  });
});
