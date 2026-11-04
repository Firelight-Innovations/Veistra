// @vitest-environment jsdom
/**
 * The Blender Viewer's send actions live in the shared footer and call the same
 * `context/put` as before: the parts list as text, the model as a file.
 *
 * The header is the shared viewer toolbar: Model · Renders, the file, a chip
 * that says whether the export still matches the .blend, the 3D · Wire switch,
 * and Open in Blender to leave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.handlers.set(event, cb);
    return () => bridge.handlers.delete(event);
  },
  reportPainted: vi.fn(),
  openIn: vi.fn(),
}));

import App from "./App";

const STATE = {
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
  model: "C:/p/.veistra/bed.glb",
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
  renders: [],
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
};

function backend(
  put: () => unknown = () => ({ key: "k" }),
  state: object = {},
  comments: unknown[] = [],
) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "blender-viewer/state") return Promise.resolve({ ...STATE, ...state });
    if (method === "comments/list") return Promise.resolve(comments);
    if (method === "context/put") return Promise.resolve(put());
    return Promise.resolve(null);
  });
}

const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");

beforeEach(() => {
  bridge.invoke.mockReset();
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

describe("Blender Viewer send footer", () => {
  it("sends the parts list from the footer", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send parts" });
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Sent" });
    expect(puts()[0][1]).toMatchObject({ kind: "text", label: "Blender - parts list" });
  });

  it("sends the .glb as a file, next to Send parts", async () => {
    backend();
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Send parts" });
    const glb = await screen.findByRole("button", { name: "Send .glb" });
    const group = container.querySelector(".k-send-footer__actions");
    expect(group?.contains(glb)).toBe(true);
    fireEvent.click(glb);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toMatchObject({ kind: "file", path: "C:/p/.veistra/bed.glb" });
  });

  it("keeps Export in the footer, after the sends", async () => {
    backend();
    const { container } = render(<App />);
    const exportButton = await screen.findByRole("button", { name: "Re-export" });
    expect(container.querySelector(".k-send-footer__trailing")?.contains(exportButton)).toBe(true);
  });

  it("names what failed to send", async () => {
    backend(() => {
      throw new Error("no store");
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send parts" }));
    await screen.findByText(/Couldn't send parts to the agent/);
  });
});

describe("Blender Viewer toolbar", () => {
  it("is one toolbar: Model · Renders, the file, the chip, the view switch and Open in Blender", async () => {
    backend();
    const { container } = render(<App />);
    const bar = await screen.findByRole("toolbar", { name: "Blender" });
    const inBar = within(bar);
    const modes = inBar.getByRole("tablist", { name: "Mode" });
    expect(
      within(modes)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Model", "Renders"]);
    expect(inBar.getByText("bed.blend")).toBeTruthy();
    const views = inBar.getByRole("tablist", { name: "Model view" });
    expect(
      within(views)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["3D", "Wire"]);
    const open = inBar.getByRole("button", { name: "Open in Blender" });
    expect(container.querySelector(".k-send-footer")?.contains(open)).toBe(false);
    expect(screen.getAllByRole("button", { name: /Open in Blender/ })).toHaveLength(1);
  });

  it("offers the .blend picker as the subject when there is more than one file", async () => {
    backend(undefined, {
      blends: [
        { path: "C:/p/bed.blend", rel: "bed.blend", mtime: 1, size: 1 },
        { path: "C:/p/chair.blend", rel: "chair.blend", mtime: 1, size: 1 },
      ],
    });
    render(<App />);
    const bar = await screen.findByRole("toolbar", { name: "Blender" });
    const picker = within(bar).getByRole("combobox", { name: ".blend file" }) as HTMLSelectElement;
    expect(picker.value).toBe("C:/p/bed.blend");
  });

  it("says Up to date when the export matches the .blend", async () => {
    backend(undefined, { stale: false, exportedAt: Date.now() });
    render(<App />);
    const chip = await screen.findByText("Up to date");
    expect(chip.getAttribute("title")).toBe("Rendered just now.");
  });

  it("says Changed after export when the .blend is newer than the export", async () => {
    backend(undefined, { stale: true });
    render(<App />);
    await screen.findByText("Changed after export");
    expect(screen.queryByText("Up to date")).toBeNull();
  });

  it("says No export for a file that has not been exported", async () => {
    backend(undefined, { model: null, parts: [], renders: [] });
    render(<App />);
    await screen.findByText(/has not been exported yet/);
    expect(screen.getByText("No export").closest(".k-vtb")).toBeTruthy();
  });

  it("counts every comment not yet resolved in the footer, as the panel does", async () => {
    const comment = (id: string, status: string) => ({
      id,
      anchor: { kind: "mesh", part: "Frame", material: "none" },
      author: "user",
      body: id,
      status,
      created: 1,
      updated: 1,
    });
    backend(undefined, {}, [
      comment("a", "open"),
      comment("b", "working"),
      comment("c", "fixed"),
      comment("d", "resolved"),
    ]);
    render(<App />);
    expect(await screen.findByText("Comments · 3 open")).toBeTruthy();
  });

  it("lists again when a comment changes in another pane or by an agent, without a reload", async () => {
    const note = (status: string) => ({
      id: "a",
      anchor: { kind: "mesh", part: "Frame", material: "none" },
      author: "user",
      body: "too tall",
      status,
      created: 1,
      updated: 1,
    });
    backend(undefined, {}, [note("open")]);
    render(<App />);
    expect(await screen.findByText("Comments · 1 open")).toBeTruthy();
    await waitFor(() => expect(bridge.handlers.has("comments:changed")).toBe(true));
    const lists = () => bridge.invoke.mock.calls.filter((c) => c[0] === "comments/list").length;
    const before = lists();

    backend(undefined, {}, [note("resolved")]);
    bridge.handlers.get("comments:changed")?.({ id: "a", kind: "mesh", status: "resolved" });
    expect(await screen.findByText("Comments")).toBeTruthy();
    expect(lists()).toBe(before + 1);
  });

  it("drops an earlier load failure once a pushed change lists fine", async () => {
    backend();
    const listed = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation((method: string, ...rest: unknown[]) =>
      method === "comments/list" ? Promise.reject(new Error("busy")) : listed(method, ...rest),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
    expect(await screen.findByText("Couldn't load comments.")).toBeTruthy();
    await waitFor(() => expect(bridge.handlers.has("comments:changed")).toBe(true));

    backend(undefined, {}, [
      {
        id: "a",
        anchor: { kind: "mesh", part: "Frame", material: "none" },
        author: "user",
        body: "too tall",
        status: "open",
        created: 1,
        updated: 1,
      },
    ]);
    bridge.handlers.get("comments:changed")?.({ id: "a", kind: "mesh", status: "open" });
    expect(await screen.findByText("1 open · 0 resolved")).toBeTruthy();
    expect(screen.getByText("too tall")).toBeTruthy();
    expect(screen.queryByText("Couldn't load comments.")).toBeNull();
  });

  it("reaches the wireframe pass from the view switch, with the parts list still beside it", async () => {
    backend();
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Wire" }));
    await screen.findByText("This export has no wireframe pass.");
    expect(screen.getByText(/Parts \(1\)/)).toBeTruthy();
  });
});

describe("Blender Viewer surface (the backend's `editor`)", () => {
  const MAIN = {
    readOnly: true,
    environment: { kind: "main", branch: null },
    editor: {
      surface: "viewer",
      code: "main",
      reason:
        "This is the main checkout, which is read-only here, so Blender does not open on it. Open a worktree to edit.",
    },
  };

  it("on the main checkout shows the reason under the toolbar and still shows the export", async () => {
    backend(undefined, MAIN);
    const { container } = render(<App />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("This is the main checkout");
    const bar = screen.getByRole("toolbar", { name: "Blender" });
    expect(bar.nextElementSibling).toBe(note);
    expect(container.querySelector(".k-vtb__env")?.textContent).toBe("main");
    const open = within(bar).getByRole("button", { name: "Open in Blender" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.title).toContain("main checkout");
    expect(screen.getByText(/Parts \(1\)/)).toBeTruthy();
  });

  it("on the main checkout will not post a comment, and says why", async () => {
    backend(undefined, MAIN);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Frame/ }));
    fireEvent.change(screen.getByPlaceholderText("What should change about this part?"), {
      target: { value: "thinner" },
    });
    const post = screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    expect(post.title).toContain("main is read-only");
  });

  it("says a refused comment instead of dropping it", async () => {
    backend();
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "blender-viewer/state") return Promise.resolve(STATE);
      if (method === "comments/list") return Promise.resolve([]);
      if (method === "comments/create") return Promise.reject(new Error("refused: read-only"));
      return Promise.resolve(null);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Frame/ }));
    fireEvent.change(screen.getByPlaceholderText("What should change about this part?"), {
      target: { value: "thinner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("refused: read-only");
  });

  it("leaves a missing Blender to its setup panel, not a second line", async () => {
    backend(undefined, {
      blender: { ...STATE.blender, found: false, path: null, configuredMissing: true },
      editor: {
        surface: "viewer",
        code: "noEditor",
        reason: "Blender was not found on this computer. Set its path under Settings, Blender.",
      },
    });
    render(<App />);
    await screen.findByRole("region", { name: "Blender not found" });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("names its own window when there is no embedder, and Open in Blender still works", async () => {
    backend(undefined, {
      editor: {
        surface: "popOut",
        code: "noEmbedder",
        reason:
          "Blender opens in its own window: Veistra cannot place it in the pane on macOS yet.",
      },
    });
    render(<App />);
    expect((await screen.findByRole("note")).textContent).toContain("its own window");
    const bar = screen.getByRole("toolbar", { name: "Blender" });
    const open = within(bar).getByRole("button", { name: "Open in Blender" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
  });

  it("puts the environment first in the subject, and Mark up in the actions before the view switch", async () => {
    backend();
    render(<App />);
    const bar = await screen.findByRole("toolbar", { name: "Blender" });
    const text = bar.textContent ?? "";
    expect(text.indexOf("wt")).toBeLessThan(text.indexOf("bed.blend"));
    const markUp = within(bar).getByRole("button", { name: /Mark up/ });
    const actions = bar.querySelector(".k-vtb__actions");
    expect(actions?.contains(markUp)).toBe(true);
    const switcher = within(bar).getByRole("tablist", { name: "Model view" });
    expect(
      markUp.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Mark up/ })).toHaveLength(1);
  });
});
