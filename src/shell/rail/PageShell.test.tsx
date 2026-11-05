// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PageShell from "./PageShell";

afterEach(cleanup);

describe("PageShell docked header", () => {
  it("offers an expand control beside close", () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    render(
      <PageShell
        mode="docked"
        pageId="git"
        title="Git"
        backLabel="main"
        onClose={onClose}
        onExpand={onExpand}
      >
        body
      </PageShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Git" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Git" })).toBeTruthy();
  });

  it("draws no expand control without a handler", () => {
    render(
      <PageShell mode="docked" pageId="git" title="Git" backLabel="main" onClose={() => {}}>
        body
      </PageShell>,
    );
    expect(screen.queryByRole("button", { name: "Expand Git" })).toBeNull();
  });
});

describe("PageShell body", () => {
  const shell = (pageId: string) => (
    <PageShell mode="docked" pageId={pageId} title={pageId} backLabel="main" onClose={() => {}}>
      <span>{pageId} body</span>
    </PageShell>
  );

  // The page opens instantly, so the body it opens with must not fade in after it.
  it("draws the body a page opens with at once, with no fade", () => {
    render(shell("git"));
    expect(screen.getByText("git body").parentElement?.style.opacity).toBe("1");
  });

  it("fades the new body in when switching straight to another page", () => {
    const { rerender } = render(shell("git"));
    rerender(shell("agents"));
    expect(screen.getByText("agents body").parentElement?.style.opacity).toBe("0");
  });
});
