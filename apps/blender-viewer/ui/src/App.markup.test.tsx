// @vitest-environment jsdom
/**
 * The Blender Viewer's markup: it is kept per .blend and brought back, sent
 * through the shared flow as Blender, and a file with no export (or no glb)
 * offers Export instead of an empty canvas. The 3D stage needs WebGL, so
 * `ModelPreview` is a stand-in with one button that reports a finished markup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: () => () => {},
  reportPainted: vi.fn(),
  openIn: vi.fn(),
}));

const drawn = {
  version: 1,
  source: { kind: "scene" },
  size: { width: 10, height: 10 },
  pins: [{ n: 1, note: "too tall" }],
  annotations: [],
  excalidraw: { elements: [], appState: { viewBackgroundColor: "transparent" } },
};

vi.mock("./ModelPreview", () => ({
  default: ({
    onMarkup,
    children,
  }: {
    onMarkup: (r: unknown) => void;
    children?: React.ReactNode;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onMarkup({ png: new Blob([new Uint8Array([65, 66, 67])]), json: drawn })}
      >
        Finish drawing
      </button>
      {children}
    </div>
  ),
}));

import App from "./App";

const job = {
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
};

const BASE = {
  blender: {
    found: true,
    path: "C:/b/blender.exe",
    source: "path",
    version: "4.2",
    major: 4,
    supported: true,
    configuredMissing: false,
  },
  project: true,
  readOnly: false,
  editor: { surface: "embedded", reason: null, code: null },
  environment: { kind: "localWorktree", branch: "wt/bed" },
  blends: [{ path: "C:/p/bed.blend", rel: "bed.blend", mtime: 1, size: 1 }],
  blend: "C:/p/bed.blend",
  rel: "bed.blend",
  parts: [],
  renders: [],
  job,
};

const EXPORTED = {
  ...BASE,
  model: "C:/p/.veistra/bed.glb",
  exportedAt: 1,
  parts: [
    {
      name: "Frame",
      kind: "mesh",
      parent: null,
      visible: true,
      mesh: "Frame",
      materials: [],
      verts: 8,
      polys: 6,
      tris: 12,
      dimensions: [1, 1, 1],
    },
  ],
};

function backend(
  opts: { state?: unknown; values?: Record<string, unknown>; saved?: unknown } = {},
) {
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
      case "blender-viewer/state":
        return Promise.resolve(opts.state ?? { ...EXPORTED });
      case "settings/all":
        return Promise.resolve({ groups, values: opts.values ?? {} });
      case "blender-viewer/markup":
        return Promise.resolve(opts.saved ?? null);
      case "comments/list":
        return Promise.resolve([]);
      case "context/put":
        return Promise.resolve({ id: "ctx" });
      case "context/insert":
        return Promise.resolve({ inserted: true, count: 2 });
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

beforeEach(() => {
  bridge.invoke.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:test");
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

describe("Blender Viewer markup", () => {
  it("keeps a drawing under the .blend, and waits for Send markup by default", async () => {
    backend();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish drawing" }));
    await waitFor(() => expect(calls("blender-viewer/markup-save")).toHaveLength(1));
    expect(calls("blender-viewer/markup-save")[0]![1]).toEqual({
      blend: "C:/p/bed.blend",
      pngBase64: "QUJD",
      json: JSON.stringify(drawn),
    });
    await screen.findByRole("button", { name: "Send markup" });
    expect(calls("context/insert")).toHaveLength(0);
  });

  it("sends the picture and the JSON as Blender, and types the references, on Send markup", async () => {
    backend();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish drawing" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send markup" }));
    await waitFor(() => expect(calls("context/insert")).toHaveLength(1));
    const keys = calls("context/put").map((c) => (c[1] as { key: string }).key);
    expect(keys).toEqual(["blender/bed.blend/markup", "blender/bed.blend/markup-json"]);
    expect(calls("context/insert")[0]![1]).toEqual({ itemIds: ["ctx", "ctx"] });
    // The first manual send offers to make it automatic.
    await screen.findByText(/Send automatically/);
  });

  it("sends at once on Done when the shared setting is on", async () => {
    backend({ values: { "markup.autoSend": true } });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish drawing" }));
    await waitFor(() => expect(calls("context/insert")).toHaveLength(1));
  });

  it("brings the earlier markup of this .blend back as Previous markup", async () => {
    backend({ saved: { png: "QUJD", json: JSON.stringify(drawn), savedAt: 5 } });
    render(<App />);
    await screen.findByText(/Previous markup: 1 pin/);
    expect(calls("blender-viewer/markup")[0]![1]).toEqual({ blend: "C:/p/bed.blend" });
    expect(screen.getByRole("button", { name: "Send markup" })).toBeTruthy();
  });

  it("offers Export, not an empty canvas, for a file with no export yet", async () => {
    backend({ state: { ...BASE, model: null } });
    const { container } = render(<App />);
    await screen.findByText(/has not been exported yet/);
    fireEvent.click(container.querySelector(".bv__empty--export button")!);
    await waitFor(() => expect(calls("blender-viewer/export-start")).toHaveLength(1));
    expect(calls("blender-viewer/export-start")[0]![1]).toEqual({ blend: "C:/p/bed.blend" });
    expect(screen.queryByRole("button", { name: "Finish drawing" })).toBeNull();
  });

  it("keeps the renders reachable beside the 3D model", async () => {
    backend();
    render(<App />);
    await screen.findByRole("button", { name: "Finish drawing" });
    expect(screen.getByRole("tab", { name: "Renders" })).toBeTruthy();
  });
});
