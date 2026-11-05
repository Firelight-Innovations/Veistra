// @vitest-environment jsdom
/**
 * What happens after Done: the drawing is always kept, sending is manual unless
 * the setting is on, and the first manual send offers to make it automatic.
 * The 3D view itself needs WebGL, so `Scene3D` is a stand-in with one button
 * that reports a finished markup the way the real one does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  openIn: vi.fn(),
  OPENED_EVENT: "veistra:opened",
  on: () => () => undefined,
  session: () => Promise.resolve({ projectPath: null, instanceId: "i1" }),
  publish: vi.fn(),
}));

vi.mock("./usePreview", () => ({
  usePreview: () => ({
    state: {
      kind: "ready",
      data: {
        glb: new ArrayBuffer(0),
        nodeMap: {},
        path: "C:/p/.veistra/x.glb",
        exportedAt: 1,
        godot: null,
      },
    },
    load: vi.fn(),
  }),
}));

const drawn = {
  version: 1,
  source: { kind: "scene" },
  size: { width: 10, height: 10 },
  pins: [{ n: 1, note: "too tall" }],
  annotations: [],
  excalidraw: { elements: [], appState: { viewBackgroundColor: "transparent" } },
};

vi.mock("./Scene3D", () => ({
  default: ({ onMarkup }: { onMarkup: (r: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onMarkup({ png: new Blob([new Uint8Array([65, 66, 67])]), json: drawn })}
    >
      Finish drawing
    </button>
  ),
}));

import App from "./App";
// The shell loads Editor mode lazily; loading it here keeps that import
// inside a test's first wait.
import "./SceneMode";

const STATE = {
  project: ".",
  scenes: ["res://main.tscn"],
  scene: "res://main.tscn",
  renderedAt: 1,
  scenePath: "res://main.tscn",
  nodes: [{ path: "Main", name: "Main", type: "Node3D", children: [] }],
  source: "parsed",
  godot: null,
  note: null,
  imageAt: null,
  job: null,
  engineFound: true,
};

function backend(opts: { values?: Record<string, unknown>; saved?: unknown } = {}) {
  const groups = [
    {
      settings: [
        { key: "markup.autoSend", control: { default: false } },
        { key: "markup.tip", control: { default: true } },
      ],
    },
  ];
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "godot-viewer/state":
        return Promise.resolve(STATE);
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: false, kind: null, branch: null },
          executable: { found: null, problems: [], setting: "" },
          projects: [],
          editor: {
            surface: "viewer",
            code: "noEditor",
            reason: "Godot 4 was not found on this computer. Set its path under Settings, Godot.",
          },
        });
      case "settings/all":
        return Promise.resolve({ groups, values: opts.values ?? {} });
      case "godot-viewer/markup":
        return Promise.resolve(opts.saved ?? null);
      case "comments/list":
        return Promise.resolve([]);
      case "context/put":
        return Promise.resolve({ id: "ctx" });
      case "veistra/attach-to-agent":
        return Promise.resolve({ delivered: 1 });
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

async function finishDrawing() {
  // The scene is known once the tree is: the real view only mounts after that.
  const tree = await screen.findByRole("button", { name: "Send tree" });
  await waitFor(() => expect((tree as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(await screen.findByRole("button", { name: "Finish drawing" }));
}

beforeEach(() => {
  bridge.invoke.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("after Done", () => {
  it("keeps the drawing but does not send it while sending is manual", async () => {
    backend();
    render(<App />);
    await finishDrawing();
    await waitFor(() => expect(calls("godot-viewer/markup-save")).toHaveLength(1));
    expect(calls("godot-viewer/markup-save")[0]![1]).toMatchObject({
      scene: "res://main.tscn",
      pngBase64: "QUJD",
    });
    await screen.findByText(/Markup ready: 1 pin/);
    expect(calls("context/put")).toHaveLength(0);
  });

  it("sends at once, as a JSON item, when sending is automatic", async () => {
    backend({ values: { "markup.autoSend": true } });
    render(<App />);
    await finishDrawing();
    await waitFor(() => expect(calls("context/put")).toHaveLength(2));
    expect(calls("context/put")[0]![1]).toMatchObject({ kind: "json" });
    expect(screen.queryByText(/make this automatic/)).toBeNull();
  });

  it("leaves one chip, the picture's, when sending is automatic, and types nothing", async () => {
    backend({ values: { "markup.autoSend": true } });
    render(<App />);
    await finishDrawing();
    await waitFor(() => expect(calls("veistra/attach-to-agent")).toHaveLength(1));
    expect(calls("context/put")).toHaveLength(2);
    expect(calls("context/insert")).toHaveLength(0);
    // A chip is the whole of it: no method that submits the line exists to call.
    expect(bridge.invoke.mock.calls.map((c) => c[0])).not.toContain("terminal/write");
  });

  it("leaves the same one chip when Send markup is pressed by hand", async () => {
    backend();
    render(<App />);
    await finishDrawing();
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    await waitFor(() => expect(calls("veistra/attach-to-agent")).toHaveLength(1));
    expect(calls("context/put")).toHaveLength(2);
  });

  it("says the markup is in the Context strip when no agent takes it", async () => {
    backend();
    const base = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation((m: string, p: unknown) =>
      m === "veistra/attach-to-agent"
        ? Promise.resolve({ delivered: 0 })
        : m === "context/insert"
          ? Promise.resolve({ inserted: false, reason: "no agent is running here" })
          : base(m, p),
    );
    render(<App />);
    await finishDrawing();
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    await screen.findByText(/in the Context strip, but no agent took it: no agent is running here/);
  });
});

describe("the offer to make it automatic", () => {
  it("shows after the first manual send and turns sending on from its button", async () => {
    backend();
    render(<App />);
    await finishDrawing();
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    await screen.findByText(/make this automatic/);
    fireEvent.click(screen.getByRole("button", { name: "Send automatically" }));
    await waitFor(() =>
      expect(calls("settings/set")[0]![1]).toEqual({ key: "markup.autoSend", value: true }),
    );
    await waitFor(() => expect(screen.queryByText(/make this automatic/)).toBeNull());
  });

  it("remembers Don't show again, and stays quiet once that is stored", async () => {
    backend();
    render(<App />);
    await finishDrawing();
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don't show again" }));
    await waitFor(() =>
      expect(calls("settings/set")[0]![1]).toEqual({ key: "markup.tip", value: false }),
    );
    cleanup();

    backend({ values: { "markup.tip": false } });
    render(<App />);
    await finishDrawing();
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    await waitFor(() => expect(calls("context/put").length).toBeGreaterThan(0));
    expect(screen.queryByText(/make this automatic/)).toBeNull();
  });

  it("does not appear when the send failed", async () => {
    backend();
    const base = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation((m: string, p: unknown) =>
      m === "context/put" ? Promise.reject(new Error("no store")) : base(m, p),
    );
    render(<App />);
    await finishDrawing();
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    await screen.findByText(/Couldn't send markup to the agent/);
    expect(screen.queryByText(/make this automatic/)).toBeNull();
  });
});

describe("previous markup", () => {
  it("comes back from where it was kept and can be opened", async () => {
    backend({ saved: { png: "QUJD", json: JSON.stringify(drawn), savedAt: 1700000000000 } });
    render(<App />);
    await screen.findByText(/Previous markup: 1 pin/);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByRole("dialog", { name: "Previous markup" })).toBeTruthy();
    expect(screen.getByText("too tall")).toBeTruthy();
  });
});
