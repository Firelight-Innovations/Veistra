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
 * This is the Godot app in Editor mode, which is the scene view until the
 * editor can open in the pane, rendered through the app's shell as a pane
 * opens it.
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

function backend(
  put: () => unknown = () => ({ key: "k" }),
  opts: {
    state?: object;
    comments?: unknown[];
    godotFound?: string | null;
    readOnly?: () => boolean;
  } = {},
) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "godot-viewer/state":
        return Promise.resolve({ ...STATE, ...opts.state });
      case "godot-viewer/image":
        return Promise.resolve({ png: "AAAA" });
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: opts.readOnly?.() ?? false },
          executable: { found: opts.godotFound ?? null, problems: [], setting: "" },
          projects: [],
        });
      case "comments/list":
        // A new array each time, as the bridge's decoded answer is.
        return Promise.resolve([...(opts.comments ?? [])]);
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
    backend(undefined, { godotFound: "C:/godot.exe" });
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
  it("enables Open in Godot once the cluster moves to a worktree", async () => {
    let readOnly = true;
    backend(undefined, { godotFound: "C:/godot.exe", readOnly: () => readOnly });
    render(<App />);
    const open = (await screen.findByRole("button", {
      name: "Open in Godot",
    })) as HTMLButtonElement;
    await waitFor(() => expect(open.title).toMatch(/read-only/));
    expect(open.disabled).toBe(true);
    readOnly = false;
    events.get("project:changed")?.({ clusterId: "c1" });
    await waitFor(() => expect(open.disabled).toBe(false));
    expect(open.title).not.toMatch(/read-only/);
    expect(calls("godot-viewer/state").length).toBeGreaterThan(1);
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

  it("says the editor opens in its own window until it is embedded", async () => {
    backend();
    render(<App />);
    expect(
      await screen.findByText(/The Godot editor opens in its own window for now/),
    ).toBeTruthy();
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

  // The list was read when the pane opened and after its own writes, so a fix
  // an agent made over MCP left the count where it was until a reload.
  it("counts again when a comment change is pushed", async () => {
    const list = [
      comment("a", { kind: "node", path: "Main" }, "fixed"),
      comment("b", { kind: "node", path: "Main" }),
    ];
    backend(undefined, { comments: list });
    render(<App />);
    await screen.findByRole("button", { name: "Comments · 2 open" });
    list[0] = comment("a", { kind: "node", path: "Main" }, "resolved");
    events.get("comments:changed")?.({ id: "a", kind: "node", status: "resolved", from: "fixed" });
    await screen.findByRole("button", { name: "Comments · 1 open" });
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
