// @vitest-environment jsdom
/**
 * `NewClusterDialog`'s own logic — which step is showing, which environment
 * kind gates "Next", and what `createClusterWithEnvironment` is called with
 * per kind — rather than `Dialog`'s frame mechanics, which `Dialog.test.tsx`
 * already covers. `../../bindings` is mocked so no real `invoke` call is
 * made; `listClusterEnvironments` is deferred behind a controllable promise
 * per test, since the dialog's "Looking…" state depends on it not having
 * resolved yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewClusterDialog from "./NewClusterDialog";
import type { Environment } from "../../bindings";

const {
  createClusterWithEnvironment,
  listClusterEnvironments,
  gitRepoState,
  gitDefaultBranch,
  gitInitProject,
} = vi.hoisted(() => ({
  gitRepoState: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitInitProject: vi.fn(),
  createClusterWithEnvironment: vi.fn(),
  listClusterEnvironments: vi.fn(),
}));

vi.mock("../../bindings", () => ({
  gitRepoState,
  gitDefaultBranch,
  gitInitProject,
  createClusterWithEnvironment,
  listClusterEnvironments,
}));

beforeEach(() => {
  gitRepoState.mockResolvedValue({ state: "ready" });
  gitDefaultBranch.mockResolvedValue("main");
});

afterEach(cleanup);

const project = { name: "Veistra", path: "C:/repo" };

function renderDialog(onCreated = vi.fn(), onCancel = vi.fn()) {
  return {
    onCreated,
    onCancel,
    ...render(
      <NewClusterDialog
        label="win-1"
        project={project}
        onCancel={onCancel}
        onCreated={onCreated}
      />,
    ),
  };
}

describe("NewClusterDialog", () => {
  it("starts on step 1 with 'New local worktree' selected and Next disabled until a name is typed", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    renderDialog();
    expect(screen.getByRole("radiogroup", { name: "Environment" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "my-feature" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", false);
    });
  });

  it("rejects a taken worktree name and keeps Next disabled", async () => {
    const existing: Environment[] = [
      {
        kind: "localWorktree",
        name: "my-feature",
        path: "C:/repo-my-feature",
        branch: "wt/my-feature",
        base: "main",
      },
    ];
    listClusterEnvironments.mockResolvedValue(existing);
    renderDialog();

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "my-feature" } });
    await waitFor(() => {
      // The E2E run met the old "is already in use" and could not tell why or what to do.
      expect(
        screen.getByText(
          'A worktree named "my-feature" already exists. Reopen it under Existing environment, or choose another name.',
        ),
      ).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
  });

  // The card was "Browse main (read-only)"; main is written like a worktree now.
  it("lets 'Work on main' proceed with no extra input, and calls nothing read-only", () => {
    listClusterEnvironments.mockResolvedValue([]);
    renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /Work on main/ }));
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", false);
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it("never lets 'Cloud session' proceed, since this build has none to offer", () => {
    listClusterEnvironments.mockResolvedValue([]);
    renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /^Cloud session/ }));
    expect(screen.getByText("No cloud sessions in this build.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
  });

  it("requires picking a row before 'Existing environment' can proceed", async () => {
    const existing: Environment[] = [
      {
        kind: "localWorktree",
        name: "other",
        path: "C:/repo-other",
        branch: "wt/other",
        base: "main",
      },
    ];
    listClusterEnvironments.mockResolvedValue(existing);
    renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /^Existing environment/ }));
    expect(await screen.findByRole("button", { name: "wt/other" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "wt/other" }));
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", false);
  });

  it("moves to the layout step on Next, and Back returns to step 1", () => {
    listClusterEnvironments.mockResolvedValue([]);
    renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /Work on main/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("radiogroup", { name: "Starting layout" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radiogroup", { name: "Environment" })).toBeTruthy();
  });

  it("draws a pane thumbnail for every starting layout", () => {
    listClusterEnvironments.mockResolvedValue([]);
    renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /Work on main/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const icons = document.querySelectorAll(".new-cluster__layout-icon");
    expect(icons.length).toBe(4);
    icons.forEach((icon) => {
      expect(icon.querySelectorAll(".new-cluster__layout-pane").length).toBeGreaterThanOrEqual(3);
    });
  });

  it("submits a new-local-worktree choice with the typed name and no base (the backend resolves it)", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    createClusterWithEnvironment.mockResolvedValue("cluster-1");
    const { onCreated } = renderDialog();

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "my-feature" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create worktree and cluster" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("cluster-1"));
    expect(createClusterWithEnvironment).toHaveBeenCalledWith(
      "win-1",
      "my-feature",
      project.path,
      { kind: "newLocalWorktree", name: "my-feature" },
      "code",
    );
  });

  it("submits an existing-environment choice with that environment and an empty name", async () => {
    const existing: Environment[] = [
      {
        kind: "localWorktree",
        name: "other",
        path: "C:/repo-other",
        branch: "wt/other",
        base: "main",
      },
    ];
    listClusterEnvironments.mockResolvedValue(existing);
    createClusterWithEnvironment.mockResolvedValue("cluster-2");
    const { onCreated } = renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: /^Existing environment/ }));
    fireEvent.click(await screen.findByRole("button", { name: "wt/other" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Watch an agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open cluster" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("cluster-2"));
    expect(createClusterWithEnvironment).toHaveBeenCalledWith(
      "win-1",
      "",
      project.path,
      { kind: "existing", environment: existing[0] },
      "watchAgent",
    );
  });

  it("shows the rejection message and re-enables the button on failure, without closing", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    createClusterWithEnvironment.mockRejectedValue('branch "wt/my-feature" already exists');
    const { onCreated } = renderDialog();

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "my-feature" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create worktree and cluster" }));

    expect(await screen.findByText('branch "wt/my-feature" already exists')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create worktree and cluster" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("opens on the environment it is asked for", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    render(
      <NewClusterDialog
        label="win-1"
        project={project}
        initialKind="main"
        onCancel={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    // "Work on main" needs no name, so Next is live straight away.
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", false);
  });

  it("names the real default branch, not a hardcoded main", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    gitDefaultBranch.mockResolvedValue("master");
    renderDialog();
    expect(await screen.findByText("master")).toBeTruthy();
  });

  it("says there is no git repository, offers one button, and blocks Next until it is made", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    gitRepoState.mockResolvedValueOnce({ state: "notARepo" });
    gitInitProject.mockResolvedValue({ branch: "main", committedEverything: true });
    renderDialog();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "feat" } });
    expect(await screen.findByText(/no git repository in this project/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Initialise git repository" }));
    expect(gitInitProject).toHaveBeenCalledWith("C:/repo");
    await waitFor(() => {
      expect(screen.queryByText(/no git repository in this project/)).toBeNull();
      expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", false);
    });
  });

  it("shows the init failure as a message and offers no button for a repository in a parent folder", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    gitRepoState.mockResolvedValueOnce({ state: "noCommits", root: "C:/parent", nested: true });
    renderDialog();
    expect(await screen.findByText(/inside the git repository at C:\/parent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Initialise git repository" })).toBeNull();
  });

  it("surfaces a missing git identity as the message it is", async () => {
    listClusterEnvironments.mockResolvedValue([]);
    gitRepoState.mockResolvedValueOnce({ state: "notARepo" });
    gitInitProject.mockRejectedValue("Git does not know your name. Set it once with `git config`");
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Initialise git repository" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Git does not know your name"),
    );
  });
});
