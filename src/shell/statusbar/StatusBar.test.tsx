// @vitest-environment jsdom
/**
 * The left cluster (project, branch/environment, diff stat) and the
 * environment-conditioned pieces of the right cluster: the ahead/behind
 * upgrade once `git` lands, and no "main is read-only" label, which main used
 * to carry. Then the git controls: the branch and GitHub buttons that open the
 * Git page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitStatus } from "../contract";
import type { Environment } from "../environment";
import StatusBar from "./StatusBar";

afterEach(cleanup);

function git(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "wt/flashlight-cone",
    ahead: 0,
    behind: 0,
    insertions: 0,
    deletions: 0,
    staged: [],
    unstaged: [],
    ...overrides,
  };
}

describe("StatusBar", () => {
  it("draws nothing in the left cluster while no cluster is open", () => {
    render(<StatusBar project={null} environment={null} git={null} githubOk update={null} />);
    expect(screen.queryByText(/./, { selector: ".statusbar__project" })).toBeNull();
    expect(screen.queryByText(/./, { selector: ".statusbar__branch" })).toBeNull();
  });

  it("draws the project name and a bare branch name before git lands", () => {
    const env: Environment = {
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/wt/fl",
    };
    render(<StatusBar project="Veistra" environment={env} git={null} githubOk update={null} />);

    expect(screen.getByText("Veistra")).not.toBeNull();
    expect(screen.getByText("wt/flashlight-cone")).not.toBeNull();
  });

  it("upgrades the branch segment with ahead/behind once git lands", () => {
    const env: Environment = {
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/wt/fl",
    };
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={git({ branch: "wt/flashlight-cone", ahead: 1, behind: 0 })}
        githubOk
        update={null}
      />,
    );

    expect(screen.getByText("wt/flashlight-cone")).not.toBeNull();
    expect(screen.getByText("↑1")).not.toBeNull();
    expect(screen.getByText("↓0")).not.toBeNull();
  });

  it("draws the worktree kind chip, once, with the path as its tooltip", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/repo/wt/x" };
    render(<StatusBar project="Veistra" environment={env} git={git()} githubOk update={null} />);

    const chip = screen.getByRole("button", { name: /Local worktree/ });
    expect(chip.textContent).toBe("Local worktree");
    expect(chip.getAttribute("title")).toContain("/repo/wt/x");
    expect(screen.getAllByText("wt/x")).toHaveLength(1);
  });

  it("copies the worktree path when the chip is pressed", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/repo/wt/x" };
    render(<StatusBar project="Veistra" environment={env} git={null} githubOk update={null} />);

    screen.getByRole("button", { name: /Local worktree/ }).click();
    expect(writeText).toHaveBeenCalledWith("/repo/wt/x");
  });

  it("draws Review & merge for a worktree and wires it to the handler", () => {
    const onReview = vi.fn();
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={null}
        githubOk
        update={null}
        onReviewAndMerge={onReview}
      />,
    );

    screen.getByRole("button", { name: "Review & merge" }).click();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("omits Review & merge on main, where there is nothing to merge", () => {
    render(
      <StatusBar
        project="Veistra"
        environment={{ kind: "main" }}
        git={null}
        githubOk
        update={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review & merge" })).toBeNull();
  });

  // These two used to assert a trailing "main is read-only" label. Main is
  // written like a worktree now, so the bar names the branch and says nothing
  // about read-only.
  it("reads main as a bare branch segment with no ahead/behind and no read-only label", () => {
    render(
      <StatusBar
        project="Veistra"
        environment={{ kind: "main" }}
        git={null}
        githubOk
        update={null}
      />,
    );

    expect(screen.getByText("main")).not.toBeNull();
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it("names the real branch when the repository's default is master", () => {
    render(
      <StatusBar
        project="Veistra"
        environment={{ kind: "main" }}
        git={git({ branch: "master" })}
        githubOk
        update={null}
      />,
    );

    expect(screen.getByText("master")).not.toBeNull();
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it("omits the read-only label for a worktree", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    render(<StatusBar project="Veistra" environment={env} git={null} githubOk update={null} />);

    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  it("only draws the diff stat once git reports touched files", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    const { rerender } = render(
      <StatusBar project="Veistra" environment={env} git={git()} githubOk update={null} />,
    );
    expect(screen.queryByText(/files$/)).toBeNull();

    rerender(
      <StatusBar
        project="Veistra"
        environment={env}
        git={git({
          insertions: 3,
          deletions: 1,
          staged: [
            {
              path: "a.ts",
              file: "a.ts",
              dir: "",
              kind: "modified",
              staged: true,
              insertions: 3,
              deletions: 1,
            },
          ],
        })}
        githubOk
        update={null}
      />,
    );
    expect(screen.getByText("1 file", { exact: false })).not.toBeNull();
  });
});

describe("StatusBar's git controls", () => {
  const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
  const touched = git({
    ahead: 2,
    insertions: 3,
    deletions: 1,
    unstaged: [
      {
        path: "a.ts",
        file: "a.ts",
        dir: "",
        kind: "modified",
        staged: false,
        insertions: 3,
        deletions: 1,
      },
    ],
  });

  // What the arrows and the diff stat draw, said in words.
  const touchedName =
    "Source control: wt/x, 2 ahead, 0 behind, 1 file changed, 3 insertions, 1 deletion";

  it("opens Source Control from the branch, and GitHub from its status", () => {
    const onShowGit = vi.fn();
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={touched}
        githubOk
        update={null}
        onShowGit={onShowGit}
      />,
    );

    screen.getByRole("button", { name: touchedName }).click();
    screen.getByRole("button", { name: "GitHub" }).click();
    expect(onShowGit.mock.calls).toEqual([["worktree"], ["github"]]);
  });

  it("names the branch alone before git lands, and leaves the arrows out on main", () => {
    const { rerender } = render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={null}
        githubOk
        update={null}
        onShowGit={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Source control: wt/x" })).not.toBeNull();

    rerender(
      <StatusBar
        project="Veistra"
        environment={{ kind: "main" }}
        git={git({ branch: "main", ahead: 3 })}
        githubOk
        update={null}
        onShowGit={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Source control: main" })).not.toBeNull();
  });

  it("holds the arrows and the diff stat inside the branch button, and not the chip", () => {
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={touched}
        githubOk
        update={null}
        onShowGit={() => {}}
      />,
    );

    const branch = screen.getByRole("button", { name: touchedName });
    expect(branch.textContent).toContain("↑2");
    expect(branch.textContent).toContain("+3");
    expect(branch.textContent).not.toContain("Local worktree");
    // No button inside a button: the chip copies a path, and nesting is invalid HTML.
    expect(branch.querySelector("button")).toBeNull();
  });

  it("presses the view that is showing, and shuts the page when it is pressed again", () => {
    const onShowGit = vi.fn();
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={null}
        githubOk
        update={null}
        onShowGit={onShowGit}
        gitShowing="worktree"
      />,
    );

    const branch = screen.getByRole("button", { name: "Source control: wt/x" });
    const github = screen.getByRole("button", { name: "GitHub" });
    expect(branch.getAttribute("aria-pressed")).toBe("true");
    expect(github.getAttribute("aria-pressed")).toBe("false");

    branch.click();
    github.click();
    // The showing view shuts; the other switches the page over rather than shutting it.
    expect(onShowGit.mock.calls).toEqual([[null], ["github"]]);
  });

  it("presses GitHub while its view shows, and shuts it on a second press", () => {
    const onShowGit = vi.fn();
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={null}
        githubOk
        update={null}
        onShowGit={onShowGit}
        gitShowing="github"
      />,
    );

    const branch = screen.getByRole("button", { name: "Source control: wt/x" });
    const github = screen.getByRole("button", { name: "GitHub" });
    expect(github.getAttribute("aria-pressed")).toBe("true");
    expect(branch.getAttribute("aria-pressed")).toBe("false");

    github.click();
    branch.click();
    expect(onShowGit.mock.calls).toEqual([[null], ["worktree"]]);
  });

  // `githubOk` comes from the stack scan, not from a GitHub sign-in, so the
  // label must not claim a connection state.
  it("names GitHub's button the same whether or not the dot is red", () => {
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={null}
        githubOk={false}
        update={null}
        onShowGit={() => {}}
      />,
    );
    const github = screen.getByRole("button", { name: "GitHub" });
    expect(github.querySelector<HTMLElement>(".statusbar__dot")?.style.background).toBe(
      "var(--err)",
    );
  });

  it("draws readouts, not buttons, with nowhere to open", () => {
    render(<StatusBar project="Veistra" environment={env} git={touched} githubOk update={null} />);

    expect(screen.queryByRole("button", { name: /Source control/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();
    expect(screen.getByText("wt/x")).not.toBeNull();
    expect(screen.getByText("GitHub")).not.toBeNull();
  });

  it("has no settings button", () => {
    render(
      <StatusBar
        project="Veistra"
        environment={env}
        git={touched}
        githubOk
        update={null}
        onShowGit={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });
});
