// @vitest-environment jsdom
/**
 * The source-control panel in a read-only environment: every write affordance
 * is disabled and says why. Cosmetic only — `git.rs` refuses the same calls —
 * but a button that looks live and then errors is the failure this guards.
 * Main used to be read-only; no environment is now, main included, so the
 * `readOnly` prop is kept for the guard and `isReadOnly` answers false.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitControl, GitFileChange, GitStatus, ReviewControl, ReviewSend } from "../contract";
import { isReadOnly, READ_ONLY_HINT } from "../environment";
import SourceControlView from "./SourceControlView";
import type { GitStatusHandle } from "./useGitStatus";

afterEach(cleanup);

function change(path: string, staged: boolean): GitFileChange {
  return { path, file: path, dir: "", kind: "modified", staged, insertions: 1, deletions: 0 };
}

const STATUS: GitStatus = {
  branch: "main",
  ahead: 0,
  behind: 0,
  insertions: 2,
  deletions: 0,
  staged: [change("alpha.ts", true)],
  unstaged: [change("beta.ts", false)],
};

const REVIEW: ReviewControl = {
  list: () => Promise.resolve([]),
  add: () => Promise.reject(new Error("not used")),
  update: () => Promise.reject(new Error("not used")),
  resolve: () => Promise.reject(new Error("not used")),
  remove: () => Promise.resolve(),
  markSent: () => Promise.resolve(0),
};

const SEND: ReviewSend = {
  terminalId: null,
  toTerminal: () => {},
  toClipboard: () => Promise.resolve(),
};

function renderPanel(readOnly: boolean) {
  const stage = vi.fn(() => Promise.resolve());
  const control: GitControl = {
    status: () => Promise.resolve(STATUS),
    diff: () => new Promise(() => {}),
    stage,
    unstage: () => Promise.resolve(),
    commit: () => Promise.resolve(),
  };
  const git: GitStatusHandle = { status: STATUS, loading: false, error: null, refresh: () => {} };
  render(
    <SourceControlView
      control={control}
      clusterId="c1"
      git={git}
      review={REVIEW}
      reviewSend={SEND}
      readOnly={readOnly}
    />,
  );
  return stage;
}

describe("SourceControlView with readOnly", () => {
  it("disables staging and committing with the read-only hint", () => {
    renderPanel(true);
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
      expect(box.getAttribute("title")).toBe(READ_ONLY_HINT);
    }
    const commit = screen.getByRole("button", { name: "Commit" });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    expect(commit.getAttribute("title")).toBe(READ_ONLY_HINT);
  });

  it("leaves everything live for a worktree", () => {
    renderPanel(false);
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(false);
      expect(box.getAttribute("title")).toBeNull();
    }
  });
});

describe("isReadOnly", () => {
  // This was "is true only for main". Main is written like a worktree now.
  it("is false for every environment, main included", () => {
    expect(isReadOnly({ kind: "main" })).toBe(false);
    expect(isReadOnly({ kind: "worktree", branch: "wt/x" })).toBe(false);
    expect(isReadOnly({ kind: "design" })).toBe(false);
    expect(isReadOnly({ kind: "cloud" })).toBe(false);
    expect(isReadOnly(null)).toBe(false);
  });
});
