// @vitest-environment jsdom
/**
 * The app against a fake backend that behaves like `canvas.rs`: which canvas it
 * opens, what read-only does, what a corrupt file shows, and that a drawing
 * change reaches `canvas/write` with the mtime it read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SceneFile } from "./scene";
import { views } from "./views";

const bridge = vi.hoisted(() => {
  class VeistraRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  return { invoke: vi.fn(), VeistraRpcError, instanceId: "inst-a" as string | undefined };
});

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  VeistraRpcError: bridge.VeistraRpcError,
  reportPainted: vi.fn(),
  session: () => Promise.resolve({ projectPath: null, instanceId: bridge.instanceId }),
}));

// Excalidraw needs a real canvas and layout; the wiring around it is what is under test.
// The fake keeps the scene it was given, so the app's `updateScene` calls land somewhere.
const live = vi.hoisted(() => ({
  elements: [] as unknown[],
  seed: null as unknown,
  selected: {} as Record<string, boolean>,
}));

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: vi.fn(async () => new Blob(["png"])),
}));

vi.mock("./Editor", () => ({
  default: ({
    initial,
    onChange,
    onApi,
    onOpenChild,
  }: {
    initial: SceneFile;
    onChange: (e: unknown[], a: Record<string, unknown>, f: Record<string, unknown>) => void;
    onApi: (api: unknown) => void;
    onOpenChild: (id: string) => void;
  }) => {
    if (live.seed !== initial) {
      live.seed = initial;
      live.elements = [...initial.elements];
    }
    onApi({
      getSceneElementsIncludingDeleted: () => live.elements,
      updateScene: ({
        elements,
        appState,
      }: {
        elements: unknown[];
        appState?: { selectedElementIds?: Record<string, boolean> };
      }) => {
        live.elements = elements;
        if (appState?.selectedElementIds) live.selected = appState.selectedElementIds;
      },
      getAppState: () => ({ viewBackgroundColor: "#ffffff", selectedElementIds: live.selected }),
      getFiles: () => ({}),
    });
    const frame = { id: "f1", type: "frame", name: "Ward B", version: 1, versionNonce: 1 };
    return (
      <div data-testid="editor">
        <span>{initial.elements.length} elements</span>
        <button
          type="button"
          onClick={() =>
            onChange(
              [...initial.elements, { id: "new", type: "rectangle", version: 1, versionNonce: 1 }],
              {},
              {},
            )
          }
        >
          draw
        </button>
        <button
          type="button"
          onClick={() => {
            // Excalidraw reports the untouched scene again after every update.
            let n = 0;
            const timer = setInterval(() => {
              onChange([...initial.elements], {}, {});
              if (++n >= 12) clearInterval(timer);
            }, 100);
          }}
        >
          echo unchanged
        </button>
        <button
          type="button"
          onClick={() => {
            live.elements = [...initial.elements, frame];
            live.selected = { f1: true };
            onChange([...initial.elements, frame], { selectedElementIds: { f1: true } }, {});
          }}
        >
          select frame
        </button>
        <button
          type="button"
          onClick={() => {
            const model = {
              id: "m1",
              type: "frame",
              name: "Gurney",
              version: 1,
              versionNonce: 1,
              customData: {
                veistra: { object: { type: "model", props: { size_m: 2, triangle_budget: 8000 } } },
              },
            };
            live.elements = [...initial.elements, model];
            live.selected = { m1: true };
            onChange([...initial.elements, model], { selectedElementIds: { m1: true } }, {});
          }}
        >
          select model frame
        </button>
        <button
          type="button"
          onClick={() => {
            live.selected = { e0: true };
            onChange([...initial.elements], { selectedElementIds: { e0: true } }, {});
          }}
        >
          select shape
        </button>
        <button
          type="button"
          onClick={() => {
            live.selected = { e0: true, e1: true };
            onChange([...initial.elements], { selectedElementIds: live.selected }, {});
          }}
        >
          select two shapes
        </button>
        <button type="button" onClick={() => onOpenChild("world/ward-b")}>
          double-click linked frame
        </button>
        <button type="button" onClick={() => onOpenChild("world/ghost")}>
          double-click dangling frame
        </button>
      </div>
    );
  },
}));

import App from "./App";

const scene = (n: number, title = "World"): SceneFile => ({
  type: "excalidraw",
  version: 2,
  elements: Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    type: "rectangle",
    version: 1,
    versionNonce: i,
  })),
  appState: {},
  files: {},
  veistra: { title },
});

const TYPES = [
  {
    id: "feature",
    name: "Feature",
    color: "#2563eb",
    icon: "star",
    builtin: true,
    fields: [{ key: "summary", label: "Summary", kind: "multiline" }],
  },
  {
    id: "model",
    name: "Model",
    color: "#d97706",
    icon: "box",
    builtin: true,
    fields: [
      { key: "size_m", label: "Size (m, largest side)", kind: "number" },
      { key: "triangle_budget", label: "Triangle budget", kind: "number" },
      { key: "style_notes", label: "Style notes", kind: "multiline" },
      { key: "reference_images", label: "Reference images", kind: "path-list" },
      {
        key: "review_state",
        label: "Review state",
        kind: "enum",
        options: ["draft", "review", "accepted", "rejected"],
        default: "draft",
      },
    ],
  },
];

interface Backend {
  readOnly: boolean;
  rows: { id: string; title: string; parent: string | null; error: string | null }[];
  reads: Record<string, SceneFile | Error>;
  assets?: unknown;
}

function fake(b: Backend) {
  bridge.invoke.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "canvas/state":
        return { hasEnvironment: true, readOnly: b.readOnly, dir: "canvas" };
      case "canvas/list":
        return b.rows.map((r) => ({ ...r, mtime: 1, path: `canvas/${r.id}.json` }));
      case "canvas/read": {
        const got = b.reads[params!.id as string]!;
        if (got instanceof Error) throw got;
        return { id: params!.id, path: `canvas/${params!.id}.json`, scene: got, mtime: 100 };
      }
      case "canvas/types":
        return { builtin: TYPES, custom: [], path: ".veistra/canvas/types.json", problem: null };
      case "canvas/set-parent":
        return { id: params!.id, parent: params!.parent };
      case "canvas/assets":
        return b.assets ?? { cards: [], canvases: b.rows.length, unreadable: [] };
      case "canvas/stat":
        return { mtime: 100 };
      case "canvas/write":
        return { id: params!.id, mtime: 200 };
      case "canvas/create":
        b.rows.push({
          id: params!.id as string,
          title: params!.title as string,
          parent: (params!.parent as string | undefined) ?? null,
          error: null,
        });
        b.reads[params!.id as string] = scene(0, params!.title as string);
        return { id: params!.id, path: "x", scene: scene(0), mtime: 100 };
      case "canvas/design-brief":
        return {
          detail: { id: "standard", from: "default" },
          style: { id: "blueprint", from: "default" },
          options: {
            detail: ["sparse", "standard", "dense"],
            style: ["blueprint", "whiteboard", "minimal", "explainer"],
            names: { whiteboard: "Whiteboard sketch", blueprint: "Technical blueprint" },
          },
        };
      case "canvas/split-frames":
        return {
          canvas: params!.id,
          split: [
            { frame: "big", diagram: "big", title: "Big", child: "world/big", elements: 1600 },
          ],
          skipped: [{ frame: "tied", reason: "it is empty" }],
          checkpoint: "cp1",
          mtime: 300,
        };
      case "context/put":
        return { id: "ctx1", source: { label: "Design - World" } };
      case "veistra/attach-to-agent":
        return { delivered: 1 };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

beforeEach(() => {
  live.selected = {};
  bridge.invoke.mockReset();
  bridge.instanceId = "inst-a";
  localStorage.clear();
});
afterEach(cleanup);

describe("Canvas app", () => {
  it("opens the first root canvas and draws it", async () => {
    fake({
      readOnly: false,
      rows: [
        { id: "levels/ward-b", title: "Ward B", parent: "world", error: null },
        { id: "world", title: "World", parent: null, error: null },
      ],
      reads: { world: scene(3), "levels/ward-b": scene(1, "Ward B") },
    });
    render(<App />);
    expect(await screen.findByText("3 elements")).toBeTruthy();
    expect(screen.getByText("canvas/world.json")).toBeTruthy();
  });

  it("summarises a split: frames split, frames skipped, and that Undo is available", async () => {
    const heavy = scene(1600);
    heavy.elements.push({ id: "big", type: "frame", version: 1, versionNonce: 1 });
    for (const el of heavy.elements.slice(0, 1600)) el.frameId = "big";
    fake({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: heavy },
    });
    render(<App />);
    fireEvent.click(await screen.findByText("draw"));
    fireEvent.click(await screen.findByText("Split into sub-canvases"));
    const note = await screen.findByTestId("split-summary");
    expect(note.textContent).toMatch(/Split 1 frame into sub-canvases/);
    expect(note.textContent).toMatch(/skipped 1/);
    expect(note.textContent).toMatch(/Undo is available/);
  });

  it("saves a drawing change with the mtime it read", async () => {
    fake({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    fireEvent.click(await screen.findByText("draw"));
    await waitFor(
      () => {
        const write = bridge.invoke.mock.calls.find((c) => c[0] === "canvas/write");
        expect(write).toBeTruthy();
        expect(write![1]).toMatchObject({ id: "world", baseMtime: 100 });
        expect(write![1].scene.elements).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    await screen.findByText("Saved");
  });

  it("saves a per-canvas style choice into veistra.design and clears it again", async () => {
    fake({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    await screen.findByText("1 elements");
    fireEvent.click(screen.getByText("Drawing style"));
    const style = (await screen.findByDisplayValue(
      "Follow Settings (Technical blueprint)",
    )) as HTMLSelectElement;
    fireEvent.change(style, { target: { value: "whiteboard" } });
    await waitFor(
      () => {
        const writes = bridge.invoke.mock.calls.filter((c) => c[0] === "canvas/write");
        expect(writes.length).toBeGreaterThan(0);
        expect(writes[writes.length - 1]![1].scene.veistra.design).toEqual({ style: "whiteboard" });
      },
      { timeout: 3000 },
    );
    fireEvent.change(screen.getByDisplayValue("Whiteboard sketch"), { target: { value: "" } });
    await waitFor(
      () => {
        const writes = bridge.invoke.mock.calls.filter((c) => c[0] === "canvas/write");
        expect(writes[writes.length - 1]![1].scene.veistra.design).toBeUndefined();
      },
      { timeout: 3000 },
    );
  });

  it("disables the per-canvas style choice on a read-only checkout", async () => {
    fake({
      readOnly: true,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    await screen.findByText("1 elements");
    fireEvent.click(screen.getByText("Drawing style"));
    const style = await screen.findByDisplayValue("Follow Settings (Technical blueprint)");
    expect((style as HTMLSelectElement).disabled).toBe(true);
  });

  it("leaves an untouched canvas Saved and writes nothing while the editor keeps reporting it", async () => {
    fake({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    fireEvent.click(await screen.findByText("echo unchanged"));
    await new Promise((r) => setTimeout(r, 1600));
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "canvas/write")).toBe(false);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("says main is read-only, disables New canvas, and never writes", async () => {
    fake({
      readOnly: true,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    await screen.findByTestId("editor");
    expect(screen.getAllByText(/read-only/i).length).toBeGreaterThan(0);
    expect((screen.getByText("New canvas").closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByText("draw"));
    await new Promise((r) => setTimeout(r, 900));
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "canvas/write")).toBe(false);
  });

  it("shows a corrupt file's message and no editor", async () => {
    fake({
      readOnly: false,
      rows: [{ id: "broken", title: "broken", parent: null, error: "x" }],
      reads: {
        broken: new bridge.VeistraRpcError(-32603, "canvas/broken.json is not valid JSON: eof", {
          kind: "corrupt",
        }),
      },
    });
    render(<App />);
    expect(await screen.findByText(/is not valid JSON/)).toBeTruthy();
    expect(screen.getByText(/file was not touched/)).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("offers to create the first canvas when there are none", async () => {
    fake({ readOnly: false, rows: [], reads: {} });
    render(<App />);
    const input = await screen.findByLabelText("Canvas name");
    fireEvent.change(input, { target: { value: "Hospital Wing" } });
    expect(screen.getByText("canvas/hospital-wing.json")).toBeTruthy();
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("canvas/create", {
        id: "hospital-wing",
        title: "Hospital Wing",
        parent: undefined,
      }),
    );
    expect(await screen.findByTestId("editor")).toBeTruthy();
  });

  describe("remembering the open canvas", () => {
    const rows = [
      { id: "balls", title: "Balls", parent: null, error: null },
      { id: "minecraft-clone", title: "Minecraft", parent: null, error: null },
    ];
    const reads = { balls: scene(1, "Balls"), "minecraft-clone": scene(4, "Minecraft") };

    it("reopens the canvas this instance had open after the frame is unmounted and reloaded", async () => {
      fake({ readOnly: false, rows, reads });
      const first = render(<App />);
      expect(await screen.findByText("1 elements")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Canvas"), { target: { value: "minecraft-clone" } });
      expect(await screen.findByText("4 elements")).toBeTruthy();
      first.unmount();

      // A cluster switch unmounts the frame; coming back loads the app afresh.
      render(<App />);
      expect(await screen.findByText("4 elements")).toBeTruthy();
      expect(screen.getByText("canvas/minecraft-clone.json")).toBeTruthy();
    });

    it("keeps each instance's canvas apart rather than sharing one last-opened", async () => {
      fake({ readOnly: false, rows, reads });
      const a = render(<App />);
      expect(await screen.findByText("1 elements")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Canvas"), { target: { value: "minecraft-clone" } });
      expect(await screen.findByText("4 elements")).toBeTruthy();
      a.unmount();

      // Another Canvas instance, in another cluster, opens its own canvas.
      bridge.instanceId = "inst-b";
      const b = render(<App />);
      expect(await screen.findByText("1 elements")).toBeTruthy();
      b.unmount();

      bridge.instanceId = "inst-a";
      render(<App />);
      expect(await screen.findByText("4 elements")).toBeTruthy();
    });
  });

  describe("nesting", () => {
    const tree = (): Backend => ({
      readOnly: false,
      rows: [
        { id: "world", title: "World", parent: null, error: null },
        { id: "world/ward-b", title: "Ward B", parent: "world", error: null },
      ],
      reads: { world: scene(2), "world/ward-b": scene(1, "Ward B") },
    });

    it("opens the child when a linked frame is double-clicked, and the breadcrumb returns", async () => {
      fake(tree());
      render(<App />);
      expect(await screen.findByText("2 elements")).toBeTruthy();
      expect(screen.queryByLabelText("Canvas path")).toBeNull();

      fireEvent.click(screen.getByText("double-click linked frame"));
      expect(await screen.findByText("1 elements")).toBeTruthy();
      const crumbs = screen.getByLabelText("Canvas path");
      expect(crumbs.textContent).toContain("World");
      expect(crumbs.textContent).toContain("Ward B");

      fireEvent.click(screen.getByText("World", { selector: "button" }));
      expect(await screen.findByText("2 elements")).toBeTruthy();
    });

    it("says so, and stays put, when the linked canvas is not in the checkout", async () => {
      fake(tree());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("double-click dangling frame"));
      expect(await screen.findByText(/"world\/ghost" does not exist/)).toBeTruthy();
      expect(screen.getByText("2 elements")).toBeTruthy();
    });

    it("creates a child canvas for a selected frame, saves the link, then opens it", async () => {
      const backend: Backend = {
        readOnly: false,
        rows: [{ id: "world", title: "World", parent: null, error: null }],
        reads: { world: scene(1) },
      };
      fake(backend);
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.click(await screen.findByText("Create child canvas"));

      await waitFor(() =>
        expect(bridge.invoke).toHaveBeenCalledWith("canvas/create", {
          id: "world/ward-b",
          title: "Ward B",
          parent: "world",
        }),
      );
      const write = bridge.invoke.mock.calls.find((c) => c[0] === "canvas/write");
      expect(write).toBeTruthy();
      const linked = (write![1].scene.elements as { id: string; customData?: unknown }[]).find(
        (e) => e.id === "f1",
      );
      expect(linked?.customData).toEqual({ veistra: { child: "world/ward-b" } });
      const order = bridge.invoke.mock.calls.map((c) => c[0]);
      expect(order.indexOf("canvas/create")).toBeLessThan(order.indexOf("canvas/write"));
      expect(await screen.findByLabelText("Canvas path")).toBeTruthy();
    });

    it("offers no linking on read-only main, but still opens an existing link", async () => {
      fake({ ...tree(), readOnly: true });
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select frame"));
      expect(screen.queryByText("Create child canvas")).toBeNull();
    });
  });

  describe("frame inspector", () => {
    const one = (): Backend => ({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(2) },
    });
    const written = (id: string) => {
      const write = bridge.invoke.mock.calls.filter((c) => c[0] === "canvas/write").slice(-1)[0];
      return (write?.[1].scene.elements as Record<string, unknown>[] | undefined)?.find(
        (e) => e.id === id,
      );
    };

    it("asks an untyped frame for a type, then saves the type with its default values", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select frame"));
      await screen.findByText("Pick a type to describe this frame for the agent.");

      fireEvent.change(screen.getByLabelText("Type"), { target: { value: "model" } });
      await waitFor(() =>
        expect(written("f1")?.customData).toMatchObject({
          veistra: { object: { type: "model", props: { review_state: "draft" } } },
        }),
      );
      expect(await screen.findByLabelText("Triangle budget")).toBeTruthy();
    });

    it("keeps a value across a type change when the new type has that field", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select model frame"));
      fireEvent.change(await screen.findByLabelText("Type"), { target: { value: "feature" } });
      await waitFor(() => expect(screen.queryByLabelText("Triangle budget")).toBeNull());
      const object = (written("m1")?.customData as { veistra: { object: { props: unknown } } })
        .veistra.object;
      expect(object.props).toMatchObject({ size_m: 2, triangle_budget: 8000 });
    });

    it("shows the exported JSON for a model frame", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select model frame"));
      await screen.findByLabelText("Triangle budget");
      const json = screen.getByLabelText("Exported JSON").textContent ?? "";
      expect(JSON.parse(json)).toMatchObject({ name: "Gurney", size_m: 2, triangle_budget: 8000 });
    });

    it("refuses a non-number in a number field and writes nothing", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select model frame"));
      const input = await screen.findByLabelText("Triangle budget");
      fireEvent.change(input, { target: { value: "lots" } });
      fireEvent.blur(input);
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(bridge.invoke.mock.calls.some((c) => c[0] === "canvas/write")).toBe(false);
    });

    it("sends a shape to its frame's summary instead of a form", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.click(screen.getByText("select shape"));
      expect(
        await screen.findByText("Wrap in a frame to describe this for the agent."),
      ).toBeTruthy();
      expect(screen.queryByLabelText("Type")).toBeNull();
    });

    it("wraps the selection in a new labelled frame and focuses its name", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select two shapes"));
      fireEvent.click(await screen.findByText("Frame selection"));

      await waitFor(() => {
        const frames = (
          bridge.invoke.mock.calls.filter((c) => c[0] === "canvas/write").slice(-1)[0]![1].scene
            .elements as Record<string, unknown>[]
        ).filter((e) => e.type === "frame");
        expect(frames).toHaveLength(1);
        expect(frames[0]!.name).toBe("New frame");
      });
      const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
      expect(name.value).toBe("New frame");
      expect(document.activeElement).toBe(name);
      const kids = (
        bridge.invoke.mock.calls.filter((c) => c[0] === "canvas/write").slice(-1)[0]![1].scene
          .elements as { id: string; frameId?: string }[]
      ).filter((e) => e.id === "e0" || e.id === "e1");
      expect(kids.every((e) => typeof e.frameId === "string")).toBe(true);
    });

    it("offers no editing on read-only main", async () => {
      fake({ ...one(), readOnly: true });
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select frame"));
      expect(screen.queryByText("Manage types")).toBeNull();
      expect(screen.queryByText("Frame selection")).toBeNull();
    });
  });

  describe("asset list", () => {
    // Hidden until it is its own app (see `views.ts`); switched on here so the view stays covered.
    beforeEach(() => {
      views.assetList = true;
    });
    afterEach(() => {
      views.assetList = false;
    });

    it("is hidden while switched off, and the canvas is the only view, so no toggle", async () => {
      views.assetList = false;
      fake({
        readOnly: false,
        rows: [{ id: "world", title: "World", parent: null, error: null }],
        reads: { world: scene(1) },
      });
      render(<App />);
      await screen.findByText("1 elements");
      expect(screen.queryByRole("tab", { name: "Asset list" })).toBeNull();
      expect(screen.queryByRole("tablist", { name: "View" })).toBeNull();
    });

    const withCards = (): Backend => ({
      readOnly: false,
      rows: [
        { id: "world", title: "World", parent: null, error: null },
        { id: "world/ward-b", title: "Ward B", parent: "world", error: null },
      ],
      reads: { world: scene(2), "world/ward-b": scene(1, "Ward B") },
      assets: {
        canvases: 2,
        unreadable: [],
        cards: [
          {
            canvas: "world",
            canvasTitle: "World",
            elementId: "a",
            status: "accepted",
            spec: { name: "Chair", size_m: 1, triangle_budget: 500 },
          },
          {
            canvas: "world/ward-b",
            canvasTitle: "Ward B",
            elementId: "b",
            status: "review",
            spec: { name: "Gurney", size_m: 2, triangle_budget: 8000 },
          },
        ],
      },
    });

    it("lists every card across canvases with its state, and filters", async () => {
      fake(withCards());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByRole("tab", { name: "Asset list" }));
      expect(await screen.findByText("Gurney")).toBeTruthy();
      expect(screen.getByText("Chair")).toBeTruthy();
      expect(screen.getByRole("button", { name: "All 2" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "review 1" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "review 1" }));
      expect(screen.queryByText("Chair")).toBeNull();
      expect(screen.getByText("Gurney")).toBeTruthy();
    });

    it("opens the canvas a card is on", async () => {
      fake(withCards());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByRole("tab", { name: "Asset list" }));
      await screen.findByText("Gurney");
      fireEvent.click(screen.getByText("Ward B", { selector: "td button" }));
      expect(await screen.findByText("1 elements")).toBeTruthy();
      expect(screen.queryByLabelText("Asset list")).toBeNull();
    });

    it("says so when there are no cards, and names a canvas it could not read", async () => {
      const b = withCards();
      b.assets = { canvases: 1, unreadable: ["broken"], cards: [] };
      fake(b);
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByRole("tab", { name: "Asset list" }));
      expect(await screen.findByText(/No spec cards yet/)).toBeTruthy();
      expect(screen.getByText(/Could not read broken/)).toBeTruthy();
    });
  });

  describe("send to agent", () => {
    const one = (readOnly = false): Backend => ({
      readOnly,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");

    it("keeps Send selection and Send card together in the shared footer", async () => {
      fake(one());
      const { container } = render(<App />);
      await screen.findByText("1 elements");
      const footer = container.querySelector(".k-send-footer") as HTMLElement;
      expect(footer.contains(screen.getByText("Send selection"))).toBe(true);
      expect(
        container.querySelector(".cv__header")?.contains(screen.getByText("Send selection")),
      ).toBe(false);
      fireEvent.click(screen.getByText("select model frame"));
      await screen.findByLabelText("Triangle budget");
      expect(footer.contains(screen.getByText("Send card"))).toBe(true);
      expect(container.querySelector(".cv__side")?.contains(screen.getByText("Send card"))).toBe(
        false,
      );
    });

    it("sends the selection as an image, even on read-only main", async () => {
      fake(one(true));
      render(<App />);
      await screen.findByText("1 elements");
      const button = screen.getByText("Send selection").closest("button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.click(screen.getByText("Send selection"));
      await screen.findByText("Sent");
      expect(puts()).toHaveLength(1);
      expect(puts()[0]![1]).toMatchObject({
        kind: "image",
        title: "Design - World, 1 element",
        bytesBase64: "cG5n",
      });
      // One chip, named as the Context strip names the item; no words typed.
      expect(bridge.invoke).toHaveBeenCalledWith("veistra/attach-to-agent", {
        contextId: "ctx1",
        label: "Design - World",
      });
    });

    it("sends a model frame's card as JSON text", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select model frame"));
      await screen.findByLabelText("Triangle budget");
      const button = screen.getByText("Send card").closest("button") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      fireEvent.click(screen.getByText("Send card"));
      await waitFor(() => expect(puts()).toHaveLength(1));
      await waitFor(() =>
        expect(bridge.invoke).toHaveBeenCalledWith("veistra/attach-to-agent", {
          contextId: "ctx1",
          label: "Design - World",
        }),
      );
      const params = puts()[0]![1] as { kind: string; title: string; text: string };
      expect(params.kind).toBe("text");
      expect(params.title).toBe("Spec - Gurney");
      expect(params.text).toContain("canvas/world.json");
      const body = params.text.split("```json\n")[1]!.split("\n```")[0]!;
      expect(JSON.parse(body)).toMatchObject({ name: "Gurney", triangle_budget: 8000 });
    });

    it("reports a refused put instead of saying Sent", async () => {
      fake(one());
      const base = bridge.invoke.getMockImplementation()!;
      bridge.invoke.mockImplementation(async (m: string, p?: Record<string, unknown>) => {
        if (m === "context/put") throw new Error("no room in the store");
        return base(m, p);
      });
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.click(screen.getByText("Send selection"));
      expect(await screen.findByText(/no room in the store/)).toBeTruthy();
      expect(screen.queryByText("Sent")).toBeNull();
    });
  });

  describe("comments", () => {
    /** The fake backend plus an in-memory comment sidecar, like `comments.rs`. */
    const withComments = () => {
      fake({
        readOnly: false,
        rows: [{ id: "world", title: "World", parent: null, error: null }],
        reads: { world: scene(1) },
      });
      const base = bridge.invoke.getMockImplementation()!;
      const store: Record<string, unknown>[] = [];
      bridge.invoke.mockImplementation(async (m: string, p?: Record<string, unknown>) => {
        switch (m) {
          case "canvas/refs":
            return { refs: [], dir: "canvas/world/refs" };
          case "canvas/list-comments":
            return {
              comments: store,
              open: store.filter((c) => c.status === "open").length,
              total: store.length,
              unreadable: [],
            };
          case "canvas/create-comment": {
            const c = {
              id: `c${store.length + 1}`,
              frameId: p!.diagram,
              elementIds: p!.elementIds ?? [],
              region: p!.region ?? null,
              text: p!.text,
              author: p!.actor,
              createdAt: "2026-09-30T10:00:00Z",
              status: "open",
              resolution: null,
            };
            store.push(c);
            return c;
          }
          case "canvas/resolve-comment": {
            const c = store.find((x) => x.id === p!.commentId)!;
            c.status = "resolved";
            c.resolution = { note: p!.note, by: p!.actor, at: "2026-09-30T11:00:00Z" };
            return c;
          }
          default:
            return base(m, p);
        }
      });
      return store;
    };

    it("posts a comment on the selection as the human, then resolves it with a note", async () => {
      const store = withComments();
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.click(screen.getByRole("tab", { name: /Comments/ }));
      fireEvent.click(await screen.findByText("On selection"));
      fireEvent.change(screen.getByLabelText("Comment"), {
        target: { value: "The ward is too narrow" },
      });
      fireEvent.click(screen.getByText("Post"));
      await waitFor(() => expect(store).toHaveLength(1));
      expect(bridge.invoke.mock.calls.find((c) => c[0] === "canvas/create-comment")![1]).toEqual({
        id: "world",
        diagram: "f1",
        elementIds: ["f1"],
        text: "The ward is too narrow",
        actor: "human",
      });
      expect(await screen.findByText("The ward is too narrow")).toBeTruthy();
      expect(screen.getByLabelText("1 open")).toBeTruthy();

      fireEvent.click(screen.getByText("Resolve"));
      fireEvent.change(screen.getByLabelText("Resolution note"), {
        target: { value: "Widened to 6 m" },
      });
      fireEvent.click(screen.getAllByText("Resolve")[0]!);
      await waitFor(() => expect(store[0]!.status).toBe("resolved"));
      await waitFor(() => expect(screen.queryByLabelText("1 open")).toBeNull());
      expect(screen.getByText("No open comments.")).toBeTruthy();
    });

    it("says why when nothing is selected", async () => {
      withComments();
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByRole("tab", { name: /Comments/ }));
      const on = (await screen.findByText("On selection")).closest("button") as HTMLButtonElement;
      expect(on.disabled).toBe(true);
      expect(screen.queryByLabelText("Comment")).toBeNull();
    });

    it("collapses the panels to a strip and remembers it", async () => {
      withComments();
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByLabelText("Hide panels"));
      expect(screen.queryByRole("tabpanel")).toBeNull();
      expect(JSON.parse(localStorage.getItem("canvas.side")!)).toMatchObject({ collapsed: true });
      fireEvent.click(screen.getByRole("tab", { name: /Diagrams/ }));
      expect(screen.getByRole("tabpanel")).toBeTruthy();
    });

    // Braden saw the hide button clipped by the panel's edge: the tabs pushed it
    // out. jsdom has no layout, so this holds the structure the CSS relies on.
    it("pins the hide button at the end of the tab row, where the tabs cannot push it", async () => {
      withComments();
      render(<App />);
      await screen.findByText("1 elements");
      const hide = screen.getByLabelText("Hide panels");
      const row = hide.parentElement as HTMLElement;
      expect(row.getAttribute("role")).toBe("tablist");
      expect(row.lastElementChild).toBe(hide);
      expect(hide.classList.contains("cv__side-toggle")).toBe(true);
      expect(row.querySelector(".cv__spacer")).toBeNull();
      const tabs = row.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBe(3);
      for (const tab of Array.from(tabs)) {
        expect(tab.querySelector(".cv__side-label")).toBeTruthy();
      }
      expect(screen.getByRole("tab", { name: /Comments/ })).toBeTruthy();
    });

    it("tells a person how to make a diagram when there are none", async () => {
      withComments();
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByRole("tab", { name: /Diagrams/ }));
      expect(await screen.findByText(/No diagrams yet\. Press F/)).toBeTruthy();
    });
  });
});
