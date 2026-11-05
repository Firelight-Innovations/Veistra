// @vitest-environment jsdom
/**
 * The rail page's surface: that it opens and closes instantly, with nothing
 * slid or faded, and that it never remounts what is inside it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import type { FrameSlots } from "../contract";
import Frame from "./Frame";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const mounts = { count: 0 };
function Probe() {
  useEffect(() => {
    mounts.count += 1;
  }, []);
  return <div data-testid="host">host</div>;
}

function slots(page: ReactNode): FrameSlots {
  return {
    titleBar: <div />,
    toolWindow: <div>tools</div>,
    statusBar: <div />,
    projectRail: <nav>rail</nav>,
    projectPage: page,
    projectPageExpanded: page,
  };
}

/** Nothing on the surface that a slide, a clip reveal or a fade would set. */
function expectSettled(el: HTMLElement | null) {
  expect(el).not.toBeNull();
  expect(el?.style.transform ?? "").toBe("");
  expect(el?.style.clipPath ?? "").toBe("");
  expect(el?.style.opacity ?? "").toBe("");
}

describe("Frame's rail page", () => {
  it("opens docked at its final paint, with nothing sliding in from the rail", () => {
    const { container } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    expectSettled(container.querySelector<HTMLElement>('[data-region="page"]'));
  });

  it("opens expanded at its final paint, and hides the panes on the same render", () => {
    const { container } = render(
      <Frame kind="main" projectPageExpanded slots={slots(<Probe />)} />,
    );
    expectSettled(container.querySelector<HTMLElement>('[data-region="page-expanded"]'));
    expect(container.querySelector(".frame__workspace-body")?.hasAttribute("data-hidden")).toBe(
      true,
    );
  });

  it("unmounts on close at once, with no exit to wait for", () => {
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    expect(container.querySelector('[data-region="page"]')).not.toBeNull();
    rerender(<Frame kind="main" slots={slots(null)} />);
    expect(container.querySelector('[data-region="page"]')).toBeNull();
    expect(container.querySelector('[data-region="pagehandle"]')).toBeNull();
  });

  it("shows the panes again on the render an expanded page closes", () => {
    const { container, rerender } = render(
      <Frame kind="main" projectPageExpanded slots={slots(<Probe />)} />,
    );
    rerender(<Frame kind="main" slots={slots(null)} />);
    expect(container.querySelector('[data-region="page-expanded"]')).toBeNull();
    expect(container.querySelector(".frame__workspace-body")?.hasAttribute("data-hidden")).toBe(
      false,
    );
  });

  it("does not remount the page's content across open, expand and dock", () => {
    mounts.count = 0;
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    const host = container.querySelector('[data-testid="host"]');
    rerender(<Frame kind="main" projectPageExpanded slots={slots(<Probe />)} />);
    expectSettled(container.querySelector<HTMLElement>('[data-region="page-expanded"]'));
    expect(container.querySelector('[data-testid="host"]')).toBe(host);
    rerender(<Frame kind="main" slots={slots(<Probe />)} />);
    expectSettled(container.querySelector<HTMLElement>('[data-region="page"]'));
    expect(container.querySelector('[data-testid="host"]')).toBe(host);
    expect(mounts.count).toBe(1);
  });

  it("clears the docked inline width once the page is expanded", async () => {
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    const docked = container.querySelector<HTMLElement>('[data-region="page"]');
    expect(docked?.style.width).not.toBe("auto");
    rerender(<Frame kind="main" projectPageExpanded slots={slots(<Probe />)} />);
    const expanded = container.querySelector<HTMLElement>('[data-region="page-expanded"]');
    await waitFor(() => expect(expanded?.style.width).toBe("auto"));
  });
});
