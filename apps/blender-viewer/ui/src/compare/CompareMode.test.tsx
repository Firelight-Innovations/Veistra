// @vitest-environment jsdom
/**
 * Compare mode over the real diff: the bridge serves the cube pair Blender
 * made (`packages/scene-view/fixtures`, spec §13 test 13) as two versions, and
 * `useCompare` diffs them on this thread, since jsdom has no Worker. Only the
 * canvas is stood in for, as WebGL is not here; it records what it is told
 * to draw and frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
const view = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  frameBox: vi.fn(),
}));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  on: () => () => undefined,
}));

vi.mock("@veistra/scene-view", async (importOriginal) => {
  const real = await importOriginal<typeof import("@veistra/scene-view")>();
  const { useImperativeHandle } = await import("react");
  function CompareView(props: Record<string, unknown> & { children?: ReactNode }) {
    view.props = props;
    useImperativeHandle(props.ref as never, () => ({ frameBox: view.frameBox, frameAll: vi.fn() }));
    return <div data-testid="compare-view">{props.children}</div>;
  }
  return { ...real, CompareView };
});

import cubeA from "../../../../../packages/scene-view/fixtures/cube-a.glb?inline";
import cubeB from "../../../../../packages/scene-view/fixtures/cube-b.glb?inline";
import CompareMode from "./CompareMode";
import { modesFor } from "../modes";
import type { Comment } from "../../../../shared/comments";
import type { BlenderViewerState, VersionEntry } from "../rpc";

// `?inline` rather than node:fs: the app tsconfig carries no Node types.
const base64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);
const GLB: Record<number, string> = { 1: base64(cubeA), 2: base64(cubeB) };

const cube = (materials: string[]) => ({
  name: "Cube",
  kind: "mesh",
  parent: null,
  visible: true,
  mesh: "Cube",
  materials,
  verts: 8,
  polys: 6,
  tris: 12,
  dimensions: [1, 1, 1],
});

function version(n: number, extra: Partial<VersionEntry> = {}): VersionEntry {
  return {
    n,
    author: n === 2 ? "agent" : "human",
    time: n * 1000,
    commit: null,
    branch: null,
    triangles: n === 2 ? 20 : 12,
    sourceLocked: false,
    parts: [cube(["Material"])],
    materials: [{ name: "Material", color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 }],
    model: `C:/p/.veistra/exports/bed/v${n}/model.glb`,
    blendCopy: null,
    ...extra,
  };
}

let versions: VersionEntry[] = [];
let kept: number | null = null;

function backend() {
  bridge.invoke.mockImplementation((method: string, params?: { version?: number }) => {
    switch (method) {
      case "blender-viewer/export-versions":
        return Promise.resolve({ rel: "bed.blend", keep: 10, kept, locked: null, versions });
      case "blender-viewer/glb":
        return Promise.resolve({ base64: GLB[params?.version ?? 0], size: 1 });
      case "blender-viewer/version-keep":
        kept = params?.version ?? null;
        return Promise.resolve({ rel: "bed.blend", kept });
      case "comments/verdict":
        return Promise.resolve({});
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

const VIEWER = {
  blend: "C:/p/bed.blend",
  rel: "bed.blend",
  readOnly: false,
  versions: [2, 1],
  editor: { surface: "embedded", reason: null, code: null },
  environment: { kind: "localWorktree", branch: "wt/bed" },
} as unknown as BlenderViewerState;

function show(
  props: { comments?: Comment[]; viewer?: Partial<BlenderViewerState>; initialB?: number } = {},
) {
  const onCommentsChanged = vi.fn();
  const onOpenBlend = vi.fn(() => Promise.resolve());
  const { container } = render(
    <CompareMode
      modeSwitch={{ value: "compare", options: modesFor(2), onChange: vi.fn() }}
      viewer={{ ...VIEWER, ...props.viewer }}
      initialB={props.initialB ?? null}
      comments={props.comments ?? []}
      onCommentsChanged={onCommentsChanged}
      onOpenBlend={onOpenBlend}
    />,
  );
  const root = container.querySelector<HTMLElement>(".cmp");
  if (!root) throw new Error("Compare mode drew no root");
  return { onCommentsChanged, onOpenBlend, root };
}

const legend = () => screen.findByRole("group", { name: "Change classes" });

beforeEach(() => {
  bridge.invoke.mockReset();
  view.props = null;
  view.frameBox.mockReset();
  versions = [version(2), version(1)];
  kept = null;
  backend();
});
afterEach(cleanup);

describe("Compare mode", () => {
  it("opens on the newest two and counts 8 added, 2 changed, 0 removed and 10 unchanged", async () => {
    show();
    const classes = within(await legend());
    expect(classes.getByRole("button", { name: /^Added 8/ })).toBeTruthy();
    expect(classes.getByRole("button", { name: /^Changed 2/ })).toBeTruthy();
    expect(classes.getByRole("button", { name: /^Removed 0/ })).toBeTruthy();
    expect(classes.getByRole("button", { name: /^Unchanged 10/ })).toBeTruthy();
    expect(screen.getByText("v1 → v2")).toBeTruthy();
    const a = screen.getByRole("combobox", { name: "Version A" }) as HTMLSelectElement;
    const b = screen.getByRole("combobox", { name: "Version B" }) as HTMLSelectElement;
    expect([a.value, b.value]).toEqual(["1", "2"]);
    expect(calls("blender-viewer/glb").map((c) => c[1])).toEqual([
      { blend: "C:/p/bed.blend", version: 1 },
      { blend: "C:/p/bed.blend", version: 2 },
    ]);
    expect(view.props?.mode).toBe("changes");
  });

  it("hides a class with its toggle, and shows it again", async () => {
    show();
    const added = within(await legend()).getByRole("button", { name: /^Added/ });
    expect(added.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(added);
    expect(added.getAttribute("aria-pressed")).toBe("false");
    expect(view.props?.shown).toEqual({
      added: false,
      changed: true,
      removed: true,
      unchanged: true,
    });
    fireEvent.click(added);
    expect((view.props?.shown as Record<string, boolean>).added).toBe(true);
  });

  it("frames the next change on N, wraps, and leaves N alone in a picker", async () => {
    const { root } = show();
    await legend();
    fireEvent.keyDown(root, { key: "n" });
    expect(view.frameBox).toHaveBeenCalledTimes(1);
    const [min, max] = view.frameBox.mock.calls[0] as [number[], number[]];
    expect(max[1]).toBeCloseTo(0.52, 5);
    expect(min[1]).toBeCloseTo(0.5, 5);
    expect(screen.getByText("1 of 1")).toBeTruthy();
    fireEvent.keyDown(root, { key: "N", shiftKey: true });
    expect(view.frameBox).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Version A" }), { key: "n" });
    expect(view.frameBox).toHaveBeenCalledTimes(2);
    // Bound on the mode, not the page: a key the mode never sees does nothing.
    fireEvent.keyDown(window, { key: "n" });
    expect(view.frameBox).toHaveBeenCalledTimes(2);
  });

  it("switches to Split in the toolbar, and swaps A and B", async () => {
    show();
    await legend();
    fireEvent.click(screen.getByRole("tab", { name: "Split" }));
    expect(view.props?.mode).toBe("split");
    fireEvent.click(screen.getByRole("button", { name: "Swap A and B" }));
    await screen.findByText("v2 → v1");
    expect(view.props?.labels).toEqual({ a: "A · v2", b: "B · v1" });
  });

  it("lists each part with its counts and material changes, and frames the one clicked", async () => {
    versions = [
      version(2, {
        materials: [{ name: "Material", color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.2 }],
      }),
      version(1),
    ];
    show();
    await legend();
    const row = screen.getByRole("button", { name: /Cube/ });
    expect(row.textContent).toContain("8 added · 2 changed");
    expect(row.textContent).toContain("Material: roughness 0.5 → 0.2");
    fireEvent.click(row);
    const [min, max] = view.frameBox.mock.calls[0] as [number[], number[]];
    [-0.5, -0.5, -0.5].forEach((v, i) => expect(min[i]).toBeCloseTo(v, 5));
    [0.5, 0.52, 0.5].forEach((v, i) => expect(max[i]).toBeCloseTo(v, 5));
  });

  it("lists the notes from A, and answers one with Looks good or Still broken", async () => {
    const note = (id: string, anchor: object) =>
      ({
        id,
        anchor: { kind: "mesh", part: "Cube", material: "Material", blend: "bed.blend", ...anchor },
        author: "user",
        body: `note ${id}`,
        status: "open",
        created: 1,
        updated: 1,
      }) as Comment;
    const { onCommentsChanged } = show({
      comments: [
        note("a", { version: 1 }),
        note("b", { version: 2 }),
        note("c", { blend: "x.blend" }),
      ],
    });
    await legend();
    expect(screen.getByText("Notes from v1 (1)")).toBeTruthy();
    expect(screen.getByText("note a")).toBeTruthy();
    expect(screen.queryByText("note b")).toBeNull();
    expect(screen.queryByText("note c")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Looks good" }));
    await waitFor(() => expect(onCommentsChanged).toHaveBeenCalled());
    expect(calls("comments/verdict")[0][1]).toEqual({ id: "a", verdict: "good", reply: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Still broken" }));
    await waitFor(() => expect(calls("comments/verdict")).toHaveLength(2));
    expect(calls("comments/verdict")[1][1]).toMatchObject({ id: "a", verdict: "broken" });
  });

  it("keeps B as the person's version, and then says so", async () => {
    show();
    await legend();
    fireEvent.click(screen.getByRole("button", { name: "Keep v2" }));
    const done = await screen.findByRole("button", { name: "v2 kept" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(calls("blender-viewer/version-keep")[0][1]).toEqual({
      blend: "C:/p/bed.blend",
      version: 2,
      actor: "human",
    });
  });

  it("says why Go back to A is unavailable when A kept no .blend, and opens the copy when it did", async () => {
    show();
    await legend();
    const none = screen.getByRole("button", { name: "Go back to v1" }) as HTMLButtonElement;
    expect(none.disabled).toBe(true);
    expect(none.title).toBe(
      "v1 kept no copy of its .blend, so there is nothing to go back to. Your file is unchanged.",
    );
    cleanup();

    versions = [version(2), version(1, { blendCopy: "C:/p/.veistra/exports/bed/v1/source.blend" })];
    const { onOpenBlend } = show();
    await legend();
    fireEvent.click(screen.getByRole("button", { name: "Go back to v1" }));
    await waitFor(() =>
      expect(onOpenBlend).toHaveBeenCalledWith("C:/p/.veistra/exports/bed/v1/source.blend"),
    );
  });

  it("keeps nothing and answers no note on main, and says why", async () => {
    const note = {
      id: "a",
      anchor: { kind: "mesh", part: "Cube", material: "Material", blend: "bed.blend", version: 1 },
      author: "user",
      body: "note a",
      status: "fixed",
      created: 1,
      updated: 1,
    } as Comment;
    show({ viewer: { readOnly: true }, comments: [note] });
    await legend();
    for (const name of ["Keep v2", "Go back to v1", "Looks good", "Still broken"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/^main is read-only/);
    }
  });

  it("opens on the B the Editor banner asked for", async () => {
    versions = [version(3), version(2), version(1)];
    show({ initialB: 2, viewer: { versions: [3, 2, 1] } });
    await legend();
    expect(screen.getByText("v1 → v2")).toBeTruthy();
  });
});
