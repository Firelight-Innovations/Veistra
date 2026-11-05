// @vitest-environment jsdom
/**
 * Send to agent in the Explorer's right-click menu: drawn for a file only, and
 * an honest error in the menu when the store refuses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({
  invoke,
  VeistraRpcError: class extends Error {
    code = 0;
  },
}));

import ContextMenu, { type MenuTarget } from "./ContextMenu";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const target = (over: Partial<MenuTarget>): MenuTarget => ({
  path: "C:\\game\\src\\a.ts",
  createIn: "C:\\game\\src",
  name: "a.ts",
  kind: "file",
  x: 0,
  y: 0,
  ...over,
});

function open(t: MenuTarget, readOnly = false) {
  render(
    <ContextMenu
      target={t}
      readOnly={readOnly}
      rootPath={"C:\\game"}
      onCreate={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("Send to agent", () => {
  it("appears for a file", () => {
    open(target({}));
    expect(screen.getByRole("menuitem", { name: "Send to agent" })).toBeTruthy();
  });

  it("does not appear for a folder or blank space", () => {
    open(target({ kind: "dir", path: "C:\\game\\src" }));
    expect(screen.queryByRole("menuitem", { name: "Send to agent" })).toBeNull();
    cleanup();
    open(target({ path: null, name: null, kind: null }));
    expect(screen.queryByRole("menuitem", { name: "Send to agent" })).toBeNull();
  });

  it("puts the file by path", async () => {
    invoke.mockResolvedValue({ id: "ctx-1" });
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to agent" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(
      "context/put",
      expect.objectContaining({ kind: "file", path: "C:\\game\\src\\a.ts" }),
    );
  });

  it("leaves one chip at the last agent tab, and no words", async () => {
    const onClose = vi.fn();
    invoke.mockImplementation((method: string) =>
      Promise.resolve(
        method === "context/put"
          ? { id: "ctx-1", source: { label: "File - a.ts" } }
          : { delivered: 1 },
      ),
    );
    render(
      <ContextMenu
        target={target({})}
        readOnly={false}
        rootPath={"C:\\game"}
        onCreate={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to agent" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("veistra/attach-to-agent", {
      contextId: "ctx-1",
      label: "File - a.ts",
    });
    expect(invoke).not.toHaveBeenCalledWith("context/insert", expect.anything());
  });

  it("stays open and says so when no agent takes it", async () => {
    invoke.mockImplementation((method: string) =>
      Promise.resolve(
        method === "context/put"
          ? { id: "ctx-1" }
          : method === "context/insert"
            ? { inserted: false, reason: "no agent is running here" }
            : { delivered: 0 },
      ),
    );
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to agent" }));
    await waitFor(() => expect(screen.getByText(/no agent is running here/)).toBeTruthy());
  });

  it("says why when the store refuses", async () => {
    invoke.mockRejectedValue(new Error("over the 25 MB copy limit"));
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to agent" }));
    await waitFor(() => expect(screen.getByText(/25 MB copy limit/)).toBeTruthy());
  });
});

describe("the menu over blank space (the project root)", () => {
  const root = target({ path: "C:\\game", createIn: "C:\\game", name: null, kind: "dir" });
  const labels = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

  it("offers the folder-level items and no Rename or Delete", () => {
    open(root);
    expect(labels()).toEqual(["New File", "New Folder", "Copy path", "Reveal in File Explorer"]);
  });

  it("copies the root's own path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open(root);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("C:\\game"));
  });

  it("opens the root folder itself rather than revealing it inside its parent", async () => {
    invoke.mockResolvedValue(null);
    open(root);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in File Explorer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("files/open-external", { path: "C:\\game" }),
    );
  });

  it("still reveals an ordinary row", async () => {
    invoke.mockResolvedValue(null);
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in File Explorer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("files/reveal", { path: "C:\\game\\src\\a.ts" }),
    );
  });
});

// Blender can save into the file it opens, so the backend refuses
// `files/open-in-blender` on main as a write (#318); the menu says so first.
describe("Open in Blender", () => {
  const blend = target({ path: "C:\\game\\art\\bed.blend", name: "bed.blend" });

  it("is offered for a .blend in a worktree", () => {
    open(blend);
    const item = screen.getByRole("menuitem", { name: "Open in Blender" }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
  });

  it("is off on the read-only main checkout, with the reason", () => {
    open(blend, true);
    const item = screen.getByRole("menuitem", { name: "Open in Blender" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toMatch(/read-only/);
    fireEvent.click(item);
    expect(invoke).not.toHaveBeenCalled();
  });
});
