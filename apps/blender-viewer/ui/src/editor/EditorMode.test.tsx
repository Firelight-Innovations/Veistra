// @vitest-environment jsdom
/**
 * Blender's Editor mode with Blender in the pane (#317). The backend is a fake
 * `invoke`: `blender-viewer/editor-state` answers whatever the test set, and
 * the boot script's commands answer as `editor.rs` relays them. Blender's
 * window itself is not here; `useNativeBox` reports its box to a fake too.
 *
 * The markup tools need a canvas, so `ViewportMarkup` is a stand-in with one
 * button that finishes a drawing with one pin, as C1's tests do for Godot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  on: () => () => undefined,
  publish: vi.fn(),
}));

vi.mock("./ViewportMarkup", () => ({
  default: ({
    onDone,
    onCancel,
  }: {
    onDone: (r: unknown, shown: { width: number; height: number }) => void;
    onCancel: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onDone(
            {
              png: new Blob([new Uint8Array([65, 66, 67])]),
              json: {
                version: 1,
                source: { kind: "image" },
                size: { width: 400, height: 300 },
                pins: [{ n: 1, note: "too tall" }],
                annotations: [],
                excalidraw: {
                  elements: [
                    {
                      x: 90,
                      y: 40,
                      width: 20,
                      height: 20,
                      customData: { veistra: { kind: "pin", n: 1 } },
                    },
                  ],
                  appState: {},
                },
              },
            },
            { width: 400, height: 300 },
          )
        }
      >
        Finish drawing
      </button>
      <button type="button" onClick={onCancel}>
        Cancel drawing
      </button>
    </div>
  ),
}));

import EditorMode, { editorChip, footerText } from "./EditorMode";
import { COMPARE_NEEDS_TWO, modesFor } from "../modes";
import type { BlenderViewerState } from "../rpc";
import type { BlenderEditorInfo, BlenderEditorState } from "./rpc";

const VIEWER = {
  blender: {
    found: true,
    path: "C:/b/blender.exe",
    source: "path",
    version: "4.2.1",
    major: 4,
    supported: true,
    configuredMissing: false,
  },
  project: true,
  readOnly: false,
  editor: { surface: "embedded", reason: null, code: null },
  environment: { kind: "localWorktree", branch: "wt/bed" },
  blends: [
    { path: "C:/p/bed.blend", rel: "bed.blend", mtime: 1, size: 1 },
    { path: "C:/p/chair.blend", rel: "chair.blend", mtime: 1, size: 1 },
  ],
  blend: "C:/p/bed.blend",
  rel: "bed.blend",
  model: null,
  parts: [],
  renders: [],
  version: null,
  versions: [5, 4, 3],
  locked: null,
  job: {
    running: false,
    blend: null,
    startedAt: null,
    finishedAt: null,
    step: 0,
    total: 0,
    label: "",
    log: [],
    outcome: null,
    error: null,
    warnings: [],
  },
} as unknown as BlenderViewerState;

const VIEW = {
  matrix: [],
  window: [],
  perspective: "PERSP",
  distance: 8,
  area: { w: 800, h: 600 },
  region: { x: 0, y: 0, w: 800, h: 600 },
  camera: { pos: [7, -7, 5], target: [0, 0, 1], up: [0, 0, 1], fov: 39.6 },
};

/** Blender here with bed.blend open, booted, in the pane, holding its lock. */
const OPEN: BlenderEditorInfo = {
  file: "bed.blend",
  opened: "bed.blend",
  pid: 4100,
  blender: "4.2.1",
  embed: { state: { kind: "embedded" }, still: false },
  booted: true,
  script: 1,
  why: null,
  dirty: false,
  lock: { file: "bed.blend", pid: 4100, since: 1 },
  conflict: null,
  view: {
    file: "C:/p/bed.blend",
    dirty: false,
    view: VIEW as never,
    fullscreen: false,
    selected: [{ name: "Frame", type: "MESH" }],
    active: "Frame",
  },
};

const CAPTURE = {
  pngBase64: "QUJD",
  width: 800,
  height: 600,
  view: VIEW,
  selected: [
    { name: "Frame", type: "MESH" },
    { name: "Lamp", type: "LIGHT" },
  ],
  active: "Frame",
  file: "bed.blend",
};

let editor: BlenderEditorState = { editor: null };
let capture: unknown = CAPTURE;
/** What `blender-viewer/editor-open` fails with, or `null` to start Blender. */
let openFails: string | null = null;

function backend() {
  let n = 0;
  bridge.invoke.mockImplementation((method: string, params?: { blend?: string }) => {
    switch (method) {
      case "blender-viewer/editor-state":
        return Promise.resolve(editor);
      case "blender-viewer/editor-open":
        if (openFails) return Promise.reject(new Error(openFails));
        editor = {
          editor: {
            ...OPEN,
            // A new scene has no file, and so no lock, until it is saved.
            ...(params?.blend ? {} : { file: null, opened: "", lock: null }),
            embed: { state: { kind: "waiting" }, still: false },
            booted: false,
            script: null,
            why: "Blender is starting.",
            view: null,
          },
        };
        return Promise.resolve(editor);
      case "blender-viewer/editor-viewport-only":
        return Promise.resolve({ viewportOnly: true });
      case "blender-viewer/editor-capture":
        return Promise.resolve(capture);
      case "blender-viewer/editor-pick":
        return Promise.resolve({
          hit: { object: "Headboard", type: "MESH", worldPoint: [0, 1, 2] },
        });
      case "context/put":
        n += 1;
        return Promise.resolve({ id: `ctx${n}`, key: "k" });
      case "veistra/attach-to-agent":
        return Promise.resolve({ delivered: 1 });
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);
/** The items left as chips at the agent's prompt, in order. */
const chipped = () =>
  calls("veistra/attach-to-agent").map((c) => (c[1] as { contextId: string }).contextId);

function show(viewer: Partial<BlenderViewerState> = {}, onPick = vi.fn(), onCompare = vi.fn()) {
  const modeSwitch = { value: "editor" as const, options: modesFor(3), onChange: vi.fn() };
  const utils = render(
    <EditorMode
      modeSwitch={modeSwitch}
      viewer={{ ...VIEWER, ...viewer }}
      onPick={onPick}
      frameRect={null}
      overlays={[]}
      onCompare={onCompare}
    />,
  );
  return { ...utils, onPick, onCompare };
}

const bar = () => screen.getByRole("toolbar", { name: "Blender" });

beforeEach(() => {
  bridge.invoke.mockReset();
  editor = { editor: null };
  capture = CAPTURE;
  openFails = null;
  backend();
  URL.createObjectURL = vi.fn(() => "blob:capture");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A few more polls than it takes to have acted on one, at 500 ms each. */
async function pollsGoBy(n = 3) {
  const seen = calls("blender-viewer/editor-state").length;
  await waitFor(
    () => expect(calls("blender-viewer/editor-state").length).toBeGreaterThan(seen + n),
    {
      timeout: 4000,
    },
  );
}

const POP_OUT = {
  editor: {
    surface: "popOut",
    code: "noEmbedder",
    reason: "Blender opens in its own window here.",
  },
} as Partial<BlenderViewerState>;

describe("Blender's Editor mode opens Blender by itself", () => {
  it("opens Blender on the picked file with no press, saying Opening while it starts", async () => {
    show();
    // From mount, before the first poll has answered: no press is offered.
    const button = screen.getByRole("button", { name: "Opening…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
    expect(calls("blender-viewer/editor-open")[0]![1]).toEqual({ blend: "bed.blend" });
    await screen.findByText("Starting");
  });

  it("opens once per mount, however often the app's state comes again", async () => {
    const { rerender, onPick, onCompare } = show();
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
    const modeSwitch = { value: "editor" as const, options: modesFor(3), onChange: vi.fn() };
    rerender(
      <EditorMode
        modeSwitch={modeSwitch}
        viewer={{ ...VIEWER, versions: [6, 5, 4, 3] }}
        onPick={onPick}
        frameRect={null}
        overlays={[]}
        onCompare={onCompare}
      />,
    );
    await pollsGoBy();
    expect(calls("blender-viewer/editor-open")).toHaveLength(1);
  });

  it("does not start a second Blender when the first poll finds one open", async () => {
    editor = { editor: OPEN };
    show();
    await screen.findByText("Editing");
    await pollsGoBy(1);
    expect(calls("blender-viewer/editor-open")).toHaveLength(0);
  });

  it("does not open it again when Blender exits by itself, and offers the press instead", async () => {
    show();
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
    await screen.findByText("Starting");
    // The person quits inside Blender, or it crashes.
    editor = { editor: null, ended: { file: "bed.blend", code: 1 } };
    await screen.findByText("Blender exited with code 1.");
    await pollsGoBy();
    expect(calls("blender-viewer/editor-open")).toHaveLength(1);
    const open = screen.getByRole("button", { name: "Open in Blender" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(2));
  });

  it("says why when it fails, and Open in Blender tries again", async () => {
    openFails = "could not start Blender: access denied";
    show();
    await screen.findByText("could not start Blender: access denied");
    const open = screen.getByRole("button", { name: "Open in Blender" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect(calls("blender-viewer/editor-open")).toHaveLength(1);
    openFails = null;
    fireEvent.click(open);
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(2));
    await screen.findByText("Starting");
    expect(screen.queryByText("could not start Blender: access denied")).toBeNull();
  });

  it("says Blender closed when the last one ended before the pane opened, and opens nothing", async () => {
    editor = { editor: null, ended: { file: "bed.blend", code: 0 } };
    show();
    await screen.findByText("Blender closed.");
    await pollsGoBy(1);
    expect(calls("blender-viewer/editor-open")).toHaveLength(0);
  });
});

describe("Blender's Editor mode where it cannot open by itself", () => {
  it("keeps the boot script's tools off until Blender is open, and says why", async () => {
    show(POP_OUT);
    await screen.findByText("Not open");
    for (const name of ["Viewport only", "Mark up", "Send selection"]) {
      const b = within(bar()).getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe("Open Blender first.");
    }
  });

  it("waits for a press where Blender would open in its own window", async () => {
    show(POP_OUT);
    const open = await screen.findByRole("button", { name: "Open in Blender" });
    expect(screen.getByText("It opens in its own window, for the reason above.")).toBeTruthy();
    await pollsGoBy(1);
    expect(calls("blender-viewer/editor-open")).toHaveLength(0);
    fireEvent.click(open);
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
  });

  it("refuses to open a file another Blender holds, and names it", async () => {
    show({ locked: { file: "bed.blend", pid: 777, since: 1, cluster: "c2" } });
    const open = (await screen.findByRole("button", {
      name: "Open in Blender",
    })) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(screen.getByText(/already open in another Blender \(process 777\)/)).toBeTruthy();
    await pollsGoBy(1);
    expect(calls("blender-viewer/editor-open")).toHaveLength(0);
  });

  it("opens nothing without a Blender to open, or on a read-only checkout", async () => {
    show({ blender: { ...VIEWER.blender, found: false, path: null } });
    expect(
      ((await screen.findByRole("button", { name: "Open in Blender" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await pollsGoBy(1);
    cleanup();
    show({ readOnly: true });
    expect(
      ((await screen.findByRole("button", { name: "Open in Blender" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await pollsGoBy(1);
    expect(calls("blender-viewer/editor-open")).toHaveLength(0);
  });
});

describe("Blender's Editor mode with no .blend in the environment", () => {
  const EMPTY = { blends: [], blend: null, rel: null, versions: [] } as Partial<BlenderViewerState>;

  it("opens Blender on a new scene by itself, naming no file and writing none", async () => {
    show(EMPTY);
    await screen.findByText(
      /No \.blend files in this environment yet, so Blender opens on a new scene/,
    );
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
    // No `blend`: the backend starts Blender on its own untitled startup scene.
    expect(calls("blender-viewer/editor-open")[0]![1]).toEqual({});
    await screen.findByText("Starting");
    expect(within(bar()).getByText("unsaved file")).toBeTruthy();
    // An unsaved scene holds no lock, so there is no one-writer banner.
    expect(screen.queryByRole("note", { name: "Who writes this file" })).toBeNull();
  });

  it("offers Open Blender as a press again once that Blender has closed", async () => {
    show(EMPTY);
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
    editor = { editor: null, ended: { file: null, code: 0 } };
    await screen.findByText("Blender closed.");
    expect(
      screen.getByText(
        "No .blend files in this environment yet. Blender opens on a new scene; save it here and it will appear.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Blender" }));
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(2));
    expect(calls("blender-viewer/editor-open")[1]![1]).toEqual({});
  });

  it("follows the scene once it is saved into the environment", async () => {
    const { rerender, onPick, onCompare } = show(EMPTY);
    await waitFor(() => expect(calls("blender-viewer/editor-open")).toHaveLength(1));
    editor = {
      editor: {
        ...OPEN,
        file: "chair.blend",
        opened: "",
        lock: { ...OPEN.lock!, file: "chair.blend" },
      },
    };
    // The app's next state lists the file just saved.
    const modeSwitch = { value: "editor" as const, options: modesFor(0), onChange: vi.fn() };
    rerender(
      <EditorMode
        modeSwitch={modeSwitch}
        viewer={{
          ...VIEWER,
          ...EMPTY,
          blends: [{ path: "C:/p/chair.blend", rel: "chair.blend", mtime: 2, size: 1 }],
        }}
        onPick={onPick}
        frameRect={null}
        overlays={[]}
        onCompare={onCompare}
      />,
    );
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("C:/p/chair.blend"));
  });
});

describe("Blender's Editor mode, with Blender open in the pane", () => {
  beforeEach(() => {
    editor = { editor: OPEN };
  });

  it("says Editing, names the file and the add-on, and keeps the five slots", async () => {
    show();
    await screen.findByText("Editing");
    expect(within(bar()).getByText("bed.blend")).toBeTruthy();
    expect(within(bar()).getByRole("tablist", { name: "Mode" })).toBeTruthy();
    expect(screen.getByText("Blender 4.2.1 · Veistra add-on v1")).toBeTruthy();
    // The picker is fixed while Blender runs; File > Open moves the file instead.
    expect(screen.queryByRole("combobox", { name: ".blend file" })).toBeNull();
  });

  it("says who writes the file: the agent's next export is v6, and Compare opens on v5", async () => {
    const { onCompare } = show();
    const banner = await screen.findByRole("note", { name: "Who writes this file" });
    expect(banner.textContent).toContain(
      "You have bed.blend open. The agent's next export goes to v6 beside it and never overwrites your file.",
    );
    fireEvent.click(within(banner).getByRole("button", { name: "Compare with v5" }));
    expect(onCompare).toHaveBeenCalledWith(5);
  });

  it("draws Compare with v1 disabled while v1 is the only version, and says why", async () => {
    const { onCompare } = show({ versions: [1] });
    const banner = await screen.findByRole("note", { name: "Who writes this file" });
    const compare = within(banner).getByRole("button", { name: "Compare with v1" });
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    expect(compare.getAttribute("title")).toBe(COMPARE_NEEDS_TWO);
    fireEvent.click(compare);
    expect(onCompare).not.toHaveBeenCalled();
  });

  it("marks unsaved changes in the subject and the chip", async () => {
    editor = { editor: { ...OPEN, dirty: true } };
    show();
    await screen.findByText("bed.blend •");
    expect(screen.getByText("Editing").closest("[title]")?.getAttribute("title")).toBe(
      "Blender has unsaved changes.",
    );
  });

  it("says so when another Blender holds the file this one opened, with no banner of its own", async () => {
    editor = { editor: { ...OPEN, lock: null, conflict: "bed.blend" } };
    show();
    const note = await screen.findByRole("note", { name: "Open twice" });
    expect(note.textContent).toContain("bed.blend is open in another Blender too");
    expect(screen.queryByRole("note", { name: "Who writes this file" })).toBeNull();
  });

  it("follows the file Blender has open, so the versions shown are its", async () => {
    editor = {
      editor: { ...OPEN, file: "chair.blend", lock: { ...OPEN.lock!, file: "chair.blend" } },
    };
    const { onPick } = show();
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("C:/p/chair.blend"));
  });

  it("has no Close button: Blender is quit from inside it; Pop out stays the last button", async () => {
    show();
    await screen.findByText("Editing");
    expect(within(bar()).queryByRole("button", { name: /close/i })).toBeNull();
    const buttons = within(bar()).getAllByRole("button");
    expect(buttons[buttons.length - 1]!.getAttribute("aria-label")).toBe(
      "Pop out into its own window",
    );
    expect(calls("blender-viewer/editor-close")).toHaveLength(0);
  });

  it("turns Viewport only on through the boot script", async () => {
    show();
    await screen.findByText("Editing");
    fireEvent.click(within(bar()).getByRole("button", { name: "Viewport only" }));
    await waitFor(() => expect(calls("blender-viewer/editor-viewport-only")).toHaveLength(1));
    expect(calls("blender-viewer/editor-viewport-only")[0]![1]).toEqual({ on: true });
  });

  it("sends the selection and the 3D view as two items and one chip, never Enter", async () => {
    show();
    await screen.findByText("Editing");
    fireEvent.click(within(bar()).getByRole("button", { name: "Send selection" }));
    await within(bar()).findByRole("button", { name: "Sent" });
    const puts = calls("context/put").map((c) => c[1] as Record<string, unknown>);
    expect(puts.map((p) => [p.kind, p.key])).toEqual([
      ["image", "blender/bed/editor-viewport"],
      ["text", "blender/bed/selection"],
    ]);
    expect(puts[1]!.text).toContain("- Frame (mesh, active)");
    expect(puts[1]!.text).toContain("- Lamp (light)");
    expect(puts[0]!.bytesBase64).toBe("QUJD");
    expect(chipped()).toEqual(["ctx2"]);
    expect(calls("context/insert")).toHaveLength(0);
  });

  it("says nothing is selected rather than sending an empty selection", async () => {
    capture = { ...CAPTURE, selected: [], active: null };
    show();
    await screen.findByText("Editing");
    fireEvent.click(within(bar()).getByRole("button", { name: "Send selection" }));
    await screen.findByText(/Nothing is selected in Blender/);
    expect(calls("context/put")).toHaveLength(0);
  });

  it("marks up a capture of the 3D view and names the object under each pin", async () => {
    show();
    await screen.findByText("Editing");
    fireEvent.click(within(bar()).getByRole("button", { name: "Mark up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish drawing" }));
    await screen.findByText("Markup sent to the agent.");
    // The pin's centre (100, 50) on the shown 400x300 is (200, 100) on the 800x600 capture.
    expect(calls("blender-viewer/editor-pick")[0]![1]).toEqual({ x: 200, y: 100 });
    const puts = calls("context/put").map((c) => c[1] as Record<string, unknown>);
    expect(puts.map((p) => p.key)).toEqual([
      "blender/bed.blend/markup-json",
      "blender/bed.blend/markup",
    ]);
    const json = JSON.parse(String(puts[0]!.text)) as {
      pins: { nodePath?: string; worldPoint?: number[] }[];
      source: Record<string, unknown>;
      camera?: { fov: number };
    };
    expect(json.pins[0]).toMatchObject({ nodePath: "Headboard", worldPoint: [0, 1, 2] });
    expect(json.source).toMatchObject({ engine: "blender", view: "editor", blend: "bed.blend" });
    expect(json.camera?.fov).toBe(39.6);
    // One chip, the picture's; its prompt names the JSON.
    expect(chipped()).toEqual(["ctx2"]);
  });
});

describe("Blender's Editor mode while the boot script starts", () => {
  it("keeps its tools off with the backend's reason, and says the add-on is starting", async () => {
    editor = {
      editor: {
        ...OPEN,
        booted: false,
        script: null,
        why: "Blender is still starting.",
        view: null,
      },
    };
    show();
    await screen.findByText("Blender 4.2.1 · Veistra add-on starting");
    const send = within(bar()).getByRole("button", { name: "Send selection" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Blender is still starting.");
  });
});

describe("editorChip", () => {
  const with_ = (state: BlenderEditorInfo["embed"]["state"]) => ({
    editor: { ...OPEN, embed: { state, still: false } },
  });

  it("names each place Blender can be in one word", () => {
    expect(editorChip(null).label).toBe("Not open");
    expect(editorChip(with_({ kind: "waiting" })).label).toBe("Starting");
    expect(editorChip(with_({ kind: "embedded" })).label).toBe("Editing");
    expect(editorChip(with_({ kind: "poppedOut" })).label).toBe("Popped out");
    const own = editorChip(
      with_({ kind: "ownWindow", reason: "Open in its own window: no pane.", cause: "noPane" }),
    );
    expect(own).toMatchObject({ label: "Own window", title: "Open in its own window: no pane." });
  });
});

describe("footerText", () => {
  it("names the Blender found before one is open, and the add-on once it said hello", () => {
    expect(footerText(null, "4.2.1")).toBe("Blender 4.2.1");
    expect(footerText(null, null)).toBe("Blender");
    expect(footerText({ editor: OPEN }, null)).toBe("Blender 4.2.1 · Veistra add-on v1");
  });
});

describe("Blender's own Veistra tab (#320)", () => {
  const ASK = {
    seq: 4,
    n: 1730000000004,
    t: 1730000000004,
    kind: "ask" as const,
    text: "Is the frame too thin?",
    scene: "C:/p/bed.blend",
    nodes: ["Frame"],
    camera: null,
    pngBase64: "WFla",
    pngProblem: null,
  };
  const params = (method: string) => calls(method).map((c) => c[1] as Record<string, unknown>);

  // Done when: Ask sends the text, the object and a 3D view image in one message.
  it("sends the tab's question with the selection and the 3D view in one message, once", async () => {
    editor = { editor: { ...OPEN, events: [ASK] } };
    show();
    await waitFor(() => expect(calls("blender-viewer/editor-ack")).toHaveLength(1));
    expect(params("blender-viewer/editor-ack")[0]).toEqual({
      n: ASK.n,
      ok: true,
      message: "Sent to the agent.",
    });
    const puts = params("context/put");
    expect(puts.map((p) => p.kind)).toEqual(["image", "text"]);
    expect(puts[1]!.text).toContain("Is the frame too thin?");
    expect(puts[1]!.text).toContain("Selected objects: Frame");
    expect(puts[1]!.text).toContain("File: bed.blend");
    expect(puts[0]!.bytesBase64).toBe("WFla");
    expect(chipped()).toEqual(["ctx2"]);
    // The poll goes on handing the same press on until the backend drops it;
    // the pane takes it once, and asks only for what came after it.
    await waitFor(() =>
      expect(params("blender-viewer/editor-state").slice(-1)[0]).toEqual({ eventsSince: 4 }),
    );
    expect(chipped()).toHaveLength(1);
  });

  // Braden's report: Mention in agent on Crate added no chip, because this
  // pane refused every mention. It now makes one chip of the object.
  it("makes one chip of the object a tab mention names, and answers the tab", async () => {
    const mention = {
      seq: 5,
      n: 1730000000005,
      t: 1730000000005,
      kind: "mention" as const,
      what: "selection" as const,
      scene: "C:/p/bed.blend",
      nodes: ["Frame"],
      path: null,
      pngBase64: null,
      pngProblem: null,
    };
    editor = { editor: { ...OPEN, events: [mention] } };
    show();
    await waitFor(() => expect(calls("blender-viewer/editor-ack")).toHaveLength(1));
    expect(params("blender-viewer/editor-ack")[0]).toEqual({
      n: mention.n,
      ok: true,
      message: "In the agent's prompt.",
    });
    const [put] = params("context/put");
    expect(put).toMatchObject({ kind: "json", label: "Blender · Frame" });
    expect(JSON.parse(String(put!.text))).toMatchObject({
      tool: "blender",
      scene: "bed.blend",
      nodes: [{ path: "Frame", type: "MESH" }],
    });
    expect(chipped()).toEqual(["ctx1"]);
  });

  it("refuses the tab's Mark up while the boot script starts, with the reason", async () => {
    const starting = { ...OPEN, booted: false, script: null, why: "Blender is still starting." };
    editor = { editor: { ...starting, events: [{ seq: 1, n: 2, t: 2, kind: "markup" }] } };
    show();
    await waitFor(() => expect(calls("blender-viewer/editor-ack")).toHaveLength(1));
    expect(params("blender-viewer/editor-ack")[0]).toEqual({
      n: 2,
      ok: false,
      message: "Blender is still starting.",
    });
    expect(calls("blender-viewer/editor-capture")).toHaveLength(0);
  });

  it("carries Still broken and its reply to the note, expecting it fixed", async () => {
    const verdict = {
      seq: 1,
      n: 3,
      t: 3,
      kind: "verdict" as const,
      id: "c9",
      verdict: "broken" as const,
      reply: "the leg still clips",
    };
    editor = { editor: { ...OPEN, events: [verdict] } };
    show();
    await waitFor(() => expect(calls("blender-viewer/editor-ack")).toHaveLength(1));
    expect(params("comments/verdict")).toEqual([
      { id: "c9", verdict: "broken", reply: "the leg still clips", expect: "fixed" },
    ]);
    expect(params("blender-viewer/editor-ack")[0]).toMatchObject({ ok: true });
  });
});
