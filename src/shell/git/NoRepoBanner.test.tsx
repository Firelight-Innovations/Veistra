// @vitest-environment jsdom
/**
 * The banner above the panes on a main cluster. It used to call main read-only and send people
 * to a worktree cluster; main is writable now, so a project with a repository shows nothing,
 * and only a folder without one gets the offer to initialise git.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const repo = vi.hoisted(() => ({
  state: { state: "ready" } as unknown,
}));
const init = vi.hoisted(() => vi.fn());

vi.mock("../../bindings", () => ({
  gitRepoState: () => Promise.resolve(repo.state),
  gitInitProject: init,
}));

import NoRepoBanner from "./NoRepoBanner";

beforeEach(() => {
  repo.state = { state: "ready" };
  init.mockReset();
});
afterEach(cleanup);

describe("NoRepoBanner", () => {
  it("shows nothing on a main checkout with a repository: no read-only notice", async () => {
    const { container } = render(<NoRepoBanner projectPath="C:/p" />);
    // Let the repository state settle before checking.
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(screen.queryByTestId("no-repo-banner")).toBeNull();
    expect(screen.queryByText(/read-only/)).toBeNull();
    expect(screen.queryByRole("button", { name: "New worktree cluster…" })).toBeNull();
  });

  it("offers to initialise git when there is no repository", async () => {
    repo.state = { state: "notARepo" };
    init.mockResolvedValue({ branch: "main", committedEverything: true });
    render(<NoRepoBanner projectPath="C:/p" />);
    const button = await screen.findByRole("button", { name: "Initialise git repository" });
    expect(screen.getByText(/no git repository/)).toBeTruthy();
    expect(screen.queryByText(/read-only/)).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(init).toHaveBeenCalledWith("C:/p"));
  });
});
