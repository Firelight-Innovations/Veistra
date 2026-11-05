// @vitest-environment jsdom
/**
 * A comment the agent completed: a note that it is done and the person should
 * resolve it, with Resolve and Still broken, and no text box to fill in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@veistra/bridge", () => ({ invoke: vi.fn() }));

import { CommentPanel } from "./CommentPanel";
import type { Comment } from "./comments";

afterEach(cleanup);

const DONE = {
  id: "c1",
  anchor: { kind: "scene", scene: "res://main.tscn", time: 0 },
  author: "user",
  body: "The door light flickers",
  status: "fixed",
  resolution: { note: "Clamped the light energy", by: "agent", at: 2, commit: "3f2a1c9" },
  created: 1,
  updated: 2,
} as unknown as Comment;

function mount(onVerdict = vi.fn()) {
  render(
    <CommentPanel
      comments={[DONE]}
      loading={false}
      error={null}
      onResolve={vi.fn()}
      onVerdict={onVerdict}
      emptyHint="none"
    />,
  );
  return onVerdict;
}

describe("a comment the agent completed", () => {
  it("says it was completed and needs resolving, with no text box", () => {
    mount();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(
      "The agent completed this. Check it, then resolve it.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Fixed, check it")).toBeNull();
    expect(screen.queryByRole("button", { name: "Looks good" })).toBeNull();
  });

  it("resolves it with Resolve, and sends it back with Still broken", async () => {
    const onVerdict = mount();
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(onVerdict).toHaveBeenCalledWith("c1", "good"));
    fireEvent.click(screen.getByRole("button", { name: "Still broken" }));
    await waitFor(() => expect(onVerdict).toHaveBeenCalledWith("c1", "broken"));
  });
});
