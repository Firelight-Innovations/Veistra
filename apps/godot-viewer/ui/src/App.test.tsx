// @vitest-environment jsdom
/**
 * The Godot Viewer's send actions live in the shared footer and call the same
 * `context/put` as before: the scene tree as text, the rendered frame as an image.
 * The markup "Send markup" button shares the footer; it needs the 3D view, which
 * needs WebGL, so it is covered by hand.
 *
 * The header is the shared viewer toolbar: mode, scene picker, a freshness
 * chip, the scene actions with Play scene, and Open in Godot to leave.
 *
 * This is the Godot app in Editor mode, rendered through the app's shell as a
 * pane opens it. Where the backend says the editor can open, Editor mode is
 * the Godot editor itself (#316, `editor/EditorMode.test.tsx`); these tests
 * use the answers that keep the scene viewer (no Godot, the main checkout, a
 * cloud session) and check which of the two each answer shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

// `openIn` sends `veistra/open` exactly as the real client does
// (`packages/bridge/src/client.ts`), so a test can assert the wire request.
vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  openIn: (appId: string, payload?: unknown) => bridge.invoke("veistra/open", { appId, payload }),
  OPENED_EVENT: "veistra:opened",
  on: (event: string, cb: (payload: unknown) => void) => {
    events.set(event, cb);
    return () => events.delete(event);
  },
  session: () => Promise.resolve({ projectPath: null, instanceId: "i1" }),
}));

import App from "./App";
// The shell loads both modes lazily; loading them here keeps those imports
// inside a test's first wait.
import "./SceneMode";
import "./editor/EditorMode";
import "./play/PlayMode";

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
  imageAt: 1,
  job: null,
  // No engine, so the 3D view is not attempted and the rendered frame shows.
  engineFound: false,
};

const MAIN_REASON =
  "This is the main checkout, which is read-only here, so Godot does not open on it. Open a worktree to edit.";
const NO_GODOT_REASON =
  "Godot 4 was not found on this computer. Set its path under Settings, Godot.";

/** A Godot 4 project at the environment root, as `godot/status` lists it. */
const HALL = {
  rel: ".",
  name: "Hall",
  mainScene: "res://main.tscn",
  mainScenePath: "main.tscn",
  engineMajor: 4,
  addon: "no",
  plugin: "no",
};

/**
 * `godot/status`'s `editor` as the backend decides it (`editor_surface.rs`),
 * from the same facts this mock answers with, unless a test names one.
 */
function surfaceFor(readOnly: boolean, found: string | null) {
  if (readOnly) return { surface: "viewer", code: "main", reason: MAIN_REASON };
  if (!found) return { surface: "viewer", code: "noEditor", reason: NO_GODOT_REASON };
  return { surface: "embedded", code: null, reason: null };
}

function backend(
  put: () => unknown = () => ({ key: "k" }),
  opts: {
    state?: object;
    comments?: unknown[];
    godotFound?: string | null;
    readOnly?: () => boolean;
    editor?: object;
    projects?: object[];
    environment?: { kind: string | null; branch?: string | null; root?: string | null };
    createComment?: () => unknown;
  } = {},
) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "godot-viewer/state":
        return Promise.resolve({ ...STATE, ...opts.state });
      case "godot-viewer/image":
        return Promise.resolve({ png: "AAAA" });
      case "godot/status": {
        const readOnly = opts.readOnly?.() ?? false;
        return Promise.resolve({
          environment: {
            root: "C:/p",
            readOnly,
            kind: readOnly ? "main" : "localWorktree",
            branch: readOnly ? "main" : "wt/hall",
            ...opts.environment,
          },
          executable: { found: opts.godotFound ?? null, problems: [], setting: "" },
          projects: opts.projects ?? [],
          editor: opts.editor ?? surfaceFor(readOnly, opts.godotFound ?? null),
          pluginProblem: null,
        });
      }
      case "godot/editor-state":
        return Promise.resolve({ editor: null, agent: false });
      case "comments/list":
        return Promise.resolve(opts.comments ?? []);
      case "comments/create":
        return Promise.resolve(opts.createComment?.() ?? null);
      case "context/put":
        return Promise.resolve(put());
      default:
        return Promise.resolve(null);
    }
  });
}

const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");
const calls = (method: string) => bridge.invoke.mock.calls.filter((c) => c[0] === method);

function comment(id: string, anchor: object, status = "open") {
  return { id, anchor, author: "user", body: id, status, created: 1, updated: 1 };
}

beforeEach(() => {
  bridge.invoke.mockReset();
  events.clear();
  localStorage.clear();
  history.replaceState({}, "", "/");
  // Play's game box needs a ResizeObserver to exist and its log pane calls
  // scrollIntoView; jsdom has neither.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("Godot Viewer send footer", () => {
  it("sends the scene tree from the footer, not the toolbar", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send tree" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    expect(screen.getByRole("toolbar", { name: "Godot" }).contains(button)).toBe(false);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Sent" });
    expect(puts()[0][1]).toMatchObject({ kind: "text", label: "Godot - scene tree" });
  });

  it("sends the rendered frame from the footer", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send frame" });
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toMatchObject({ kind: "image", bytesBase64: "AAAA" });
  });

  it("names what failed to send", async () => {
    backend(() => {
      throw new Error("no store");
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Send tree" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Couldn't send tree to the agent/);
  });
});

describe("Godot Viewer toolbar", () => {
  it("is one toolbar: mode, the scene picker, the chip, the actions and Open in Godot", async () => {
    backend();
    const { container } = render(<App />);
    const bar = await screen.findByRole("toolbar", { name: "Godot" });
    const inBar = within(bar);
    expect(inBar.getByRole("tab", { name: "Editor" }).getAttribute("aria-selected")).toBe("true");
    expect(inBar.getByRole("tab", { name: "Play" })).toBeTruthy();
    const picker = (await inBar.findByRole("combobox", { name: "Scene" })) as HTMLSelectElement;
    expect(picker.value).toBe("res://main.tscn");
    expect(inBar.getByRole("tab", { name: "3D" })).toBeTruthy();
    expect(inBar.getByRole("button", { name: "Refresh tree" })).toBeTruthy();
    expect(inBar.getByRole("button", { name: "Render view" })).toBeTruthy();
    const open = inBar.getByRole("button", { name: "Open in Godot" });
    expect(container.querySelector(".k-send-footer")?.contains(open)).toBe(false);
    expect(screen.getAllByRole("button", { name: /Open in Godot/ })).toHaveLength(1);
  });

  // Read once at mount, the status kept the main checkout's read-only answer
  // after the cluster moved to a worktree, and Open in Godot stayed disabled.
  // On a worktree with Godot, Editor mode is now the editor itself.
  it("turns to the editor once the cluster moves to a worktree", async () => {
    let readOnly = true;
    backend(undefined, {
      godotFound: "C:/godot.exe",
      readOnly: () => readOnly,
      projects: [HALL],
    });
    render(<App />);
    const open = (await screen.findByRole("button", {
      name: "Open in Godot",
    })) as HTMLButtonElement;
    await waitFor(() => expect(open.title).toMatch(/read-only/));
    expect(open.disabled).toBe(true);
    const reads = calls("godot/status").length;
    readOnly = false;
    events.get("project:changed")?.({ clusterId: "c1" });
    const launch = (await screen.findByRole("button", {
      name: "Open the editor",
    })) as HTMLButtonElement;
    expect(launch.disabled).toBe(false);
    expect(calls("godot/status").length).toBeGreaterThan(reads);
    expect(screen.queryByRole("button", { name: "Open in Godot" })).toBeNull();
  });

  it("says when the tree was read in the chip", async () => {
    backend(undefined, { state: { renderedAt: Date.now() } });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Read just now"));
  });

  it("says Not read yet before the first refresh", async () => {
    backend(undefined, { state: { renderedAt: null, scenePath: null, nodes: [], imageAt: null } });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Not read yet"));
  });

  // Play scene opened the separate Play app with `veistra/open` while there
  // were two apps; with one (owner decision 1), this pane turns to Play.
  it("plays the selected scene, in this pane's project, by turning to Play", async () => {
    // A project other than the environment root, so the run cannot be right
    // by Play falling back to the first project it finds.
    backend(undefined, { state: { project: "games/hall" } });
    render(<App />);
    const play = await screen.findByRole("button", { name: "Play scene" });
    await waitFor(() => expect((play as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(play);
    await waitFor(() => expect(calls("play/run")).toHaveLength(1));
    expect(calls("play/run")[0]![1]).toMatchObject({
      scene: "res://main.tscn",
      project: "games/hall",
    });
    const bar = await screen.findByRole("toolbar", { name: "Godot" });
    expect(within(bar).getByRole("tab", { name: "Play" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(calls("veistra/open")).toHaveLength(0);
  });

  // F5 is WebView2's reload, which unloaded the pane; Shift F5 a hard one,
  // and Ctrl R a reload too.
  it("turns to Play and runs the project on F5, and keeps the reload keys from the page", async () => {
    backend(undefined, { state: { project: "games/hall" } });
    const { container } = render(<App />);
    await screen.findByRole("combobox", { name: "Scene" });
    const root = container.querySelector(".gv") as HTMLElement;
    expect(fireEvent.keyDown(root, { key: "F5", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(root, { key: "r", ctrlKey: true })).toBe(false);
    expect(calls("play/run")).toHaveLength(0);
    expect(calls("play/record")).toHaveLength(0);
    expect(fireEvent.keyDown(root, { key: "F5" })).toBe(false);
    await waitFor(() => expect(calls("play/run")).toHaveLength(1));
    expect(calls("play/run")[0]![1]).toMatchObject({ project: "games/hall" });
    const bar = await screen.findByRole("toolbar", { name: "Godot" });
    expect(within(bar).getByRole("tab", { name: "Play" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  // The editor was in its own window, and the pane showed the viewer with a
  // footer saying so, until #316 put it in the pane.
  it("shows the editor's box on an embedder's answer, and opens it only on a press", async () => {
    backend(undefined, { godotFound: "C:/godot.exe", projects: [HALL] });
    render(<App />);
    const launch = await screen.findByRole("button", { name: "Open the editor" });
    expect(screen.getByText(/It opens here, in this pane/)).toBeTruthy();
    // The viewer is not under it: no tree, no footer.
    expect(screen.queryByRole("button", { name: "Send tree" })).toBeNull();
    expect(calls("godot/editor-open")).toHaveLength(0);
    fireEvent.click(launch);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(calls("godot/editor-open")[0]![1]).toEqual({ project: "." });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("will not play sample data", async () => {
    backend();
    render(<App />);
    await screen.findByRole("combobox", { name: "Scene" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Preview with sample data" }));
    expect(screen.getByRole("status").textContent).toBe("Sample data");
    const play = screen.getByRole("button", { name: "Play scene" }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
  });

  it("badges a tree row with the comments still open on that node", async () => {
    backend(undefined, {
      comments: [
        comment("a", { kind: "node", path: "Main" }),
        comment("b", { kind: "node", path: "Main" }),
        comment("c", { kind: "node", path: "Main" }, "resolved"),
        // The take anchor and the statuses between open and resolved are
        // arriving in the comment model; the count must already include them.
        comment("d", { kind: "take", take: "t1", nodePath: "Main" }, "working"),
        comment("e", { kind: "mesh", part: "Main", material: "none" }),
      ],
    });
    render(<App />);
    const badge = await screen.findByRole("img", { name: "3 open comments" });
    expect(badge.textContent).toBe("3");
  });

  it("counts every comment not yet resolved in the footer, as the panel does", async () => {
    backend(undefined, {
      comments: [
        comment("a", { kind: "node", path: "Main" }),
        comment("b", { kind: "node", path: "Main" }, "working"),
        comment("c", { kind: "node", path: "Main" }, "fixed"),
        comment("d", { kind: "node", path: "Main" }, "resolved"),
      ],
    });
    render(<App />);
    await screen.findByRole("button", { name: "Comments · 3 open" });
  });

  it("draws no badge on a node with nothing open", async () => {
    backend(undefined, {
      comments: [
        comment("a", { kind: "node", path: "Main" }, "resolved"),
        // Open, but on a Play moment rather than a node: it shows in the
        // footer's count, which is how this test knows the list has landed.
        comment("b", { kind: "scene", scene: "res://main.tscn", time: 1, screenshot: false }),
      ],
    });
    render(<App />);
    await screen.findByText("Node3D");
    await screen.findByRole("button", { name: /Comments · 1 open/ });
    expect(screen.queryByRole("img", { name: /open comment/ })).toBeNull();
  });
});

describe("Godot Editor surface (the backend's `editor`)", () => {
  const toolbar = () => screen.getByRole("toolbar", { name: "Godot" });

  // #318: opening the Godot app on the main checkout shows the read-only
  // viewer and the reason, as one line under the toolbar.
  it("on the main checkout shows the read-only viewer and the reason under the bar", async () => {
    backend(undefined, { godotFound: "C:/godot.exe", readOnly: () => true });
    render(<App />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("This is the main checkout, which is read-only here");
    expect(toolbar().nextElementSibling).toBe(note);
    // A fact, not a problem with a way out: nothing to press.
    expect(within(note).queryByRole("button")).toBeNull();
    // The viewer itself: the tree is read and shown.
    await screen.findByText("Node3D");
    const open = within(toolbar()).getByRole("button", {
      name: "Open in Godot",
    }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.title).toBe(MAIN_REASON);
    const env = toolbar().querySelector(".k-vtb__env");
    expect(env?.getAttribute("data-env-kind")).toBe("main");
    // Editor mode's label stays Editor (DECISIONS X4), whatever it shows.
    expect(within(toolbar()).getByRole("tab", { name: "Editor" })).toBeTruthy();
  });

  it("will not post a comment into the main checkout", async () => {
    backend(undefined, { godotFound: "C:/godot.exe", readOnly: () => true });
    render(<App />);
    fireEvent.click(await screen.findByText("Node3D"));
    fireEvent.change(screen.getByPlaceholderText("What should change about this node?"), {
      target: { value: "brighter" },
    });
    const post = screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    expect(post.title).toMatch(/main is read-only/);
  });

  // A refused comment was an unhandled rejection: the draft stayed and nothing
  // said why.
  it("says why a comment was refused", async () => {
    backend(undefined, {
      createComment: () => {
        throw new Error("the store is locked");
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByText("Node3D"));
    fireEvent.change(screen.getByPlaceholderText("What should change about this node?"), {
      target: { value: "brighter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText(/the store is locked/)).toBeTruthy();
  });

  // The editor's Veistra dock shows a node note on the scene it was written
  // on only (#320), so the scene goes with the path.
  it("writes a node note with the scene it is on", async () => {
    backend(undefined, { createComment: () => ({ id: "c1" }) });
    render(<App />);
    fireEvent.click(await screen.findByText("Node3D"));
    fireEvent.change(screen.getByPlaceholderText("What should change about this node?"), {
      target: { value: "brighter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(calls("comments/create")).toHaveLength(1));
    expect(calls("comments/create")[0]![1]).toEqual({
      anchor: { kind: "node", path: "Main", scene: "res://main.tscn" },
      body: "brighter",
    });
  });

  it("names a missing Godot once, with Open Settings on its section", async () => {
    backend();
    render(<App />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("Godot 4 was not found on this computer");
    expect(note.textContent).toContain("The tree is read from the scene file");
    await screen.findByText("Node3D");
    // The old notice said the same thing again below.
    expect(screen.queryByText(/Godot 4 was not found, so the tree/)).toBeNull();
    const open = within(toolbar()).getByRole("button", {
      name: "Open in Godot",
    }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(within(note).getByRole("button", { name: "Open Settings" }));
    await waitFor(() => expect(calls("shell/open-settings")).toHaveLength(1));
    expect(calls("shell/open-settings")[0]![1]).toEqual({ section: "godot" });
  });

  it("still names a missing Godot when main is the reason given", async () => {
    backend(undefined, { readOnly: () => true });
    render(<App />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("main checkout");
    expect(await screen.findByText(/Godot 4 was not found, so the tree/)).toBeTruthy();
  });

  // Pop out: no embedder here (macOS, Linux, Wayland). The editor still opens
  // from the pane, in its own window, and the line says why.
  it("pops out where there is no embedder, with the reason and Open the editor", async () => {
    backend(undefined, {
      godotFound: "/usr/bin/godot",
      projects: [HALL],
      editor: {
        surface: "popOut",
        code: "noEmbedder",
        reason:
          "Godot opens in its own window: Veistra cannot place it in the pane on Linux with Wayland yet.",
      },
    });
    render(<App />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("Linux with Wayland");
    expect(toolbar().nextElementSibling).toBe(note);
    expect(screen.getByText(/It opens in its own window, for the reason above/)).toBeTruthy();
    const launch = screen.getByRole("button", { name: "Open the editor" }) as HTMLButtonElement;
    expect(launch.disabled).toBe(false);
    fireEvent.click(launch);
    await waitFor(() => expect(calls("godot/editor-open")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Open in Godot" })).toBeNull();
  });

  // A cloud session's files are on its VM: nothing here can read them, so
  // nothing is asked for, and the line says why.
  it("reads nothing on a cloud session and says why", async () => {
    backend(undefined, {
      godotFound: "C:/godot.exe",
      environment: { kind: "cloud", branch: "wt/cloud", root: null },
      editor: {
        surface: "viewer",
        code: "cloud",
        reason:
          "This is a cloud session: its files are on the VM, not on this computer, so Godot cannot open them here. Open a local worktree to edit.",
      },
    });
    render(<App />);
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("cloud session");
    expect(await screen.findByText(/this session's files are on its VM/)).toBeTruthy();
    expect(toolbar().querySelector(".k-vtb__env")?.getAttribute("data-env-kind")).toBe("cloud");
    expect(calls("godot-viewer/state")).toHaveLength(0);
    expect(calls("comments/list")).toHaveLength(0);
  });

  it("names the environment first in the subject, before the scene", async () => {
    backend();
    render(<App />);
    const picker = await screen.findByRole("combobox", { name: "Scene" });
    const env = toolbar().querySelector(".k-vtb__env")!;
    expect(env.textContent).toBe("wtwt/hall");
    expect(env.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Mark up was on the 3D view's own bar; it is slot 4 here, as in Play.
  it("puts Mark up in the toolbar's actions, before the view switch", async () => {
    backend();
    render(<App />);
    await screen.findByRole("combobox", { name: "Scene" });
    const actions = toolbar().querySelector(".k-vtb__actions")!;
    const markup = within(actions as HTMLElement).getByRole("button", { name: "Mark up" });
    const threeD = within(toolbar()).getByRole("tab", { name: "3D" });
    expect(markup.compareDocumentPosition(threeD) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Mark up" })).toHaveLength(1);
  });
});
