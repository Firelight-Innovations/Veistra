// @vitest-environment jsdom
/**
 * The right side of the window: one sidebar, and none at all with no page open.
 *
 * Review round 1 found two sidebars (a secondary panel and the docked page)
 * and an empty bordered column whenever no page was open. These pin both.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { FrameSlots } from "../contract";
import Frame from "./Frame";
import frameCss from "./frame.css?raw";

afterEach(cleanup);

beforeAll(() => {
  // jsdom has no ResizeObserver, and `Frame` observes the band's column.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function slots(extra: Partial<FrameSlots> = {}): FrameSlots {
  return {
    titleBar: <div />,
    toolWindow: <div>tools</div>,
    statusBar: <div />,
    projectRail: <nav>rail</nav>,
    ...extra,
  };
}

describe("Frame's right side", () => {
  it("draws no docked column, handle or border when no page is open", () => {
    // `rightPage && <DockedPage/>` is `null` with no page open.
    const { container } = render(<Frame kind="main" slots={slots({ projectPage: null })} />);
    expect(container.querySelector('[data-region="page"]')).toBeNull();
    expect(container.querySelector('[data-region="pagehandle"]')).toBeNull();
    expect(container.querySelector('[data-region="rail"]')).not.toBeNull();
  });

  it("draws no separate secondary panel beside the docked page", () => {
    const { container } = render(
      <Frame kind="main" slots={slots({ projectPage: <div>git page</div> })} />,
    );
    expect(container.querySelector('[data-region="page"]')?.textContent).toBe("git page");
    expect(container.querySelector('[data-region="panel"]')).toBeNull();
    expect(container.querySelector('[data-region="handle"]')).toBeNull();
  });

  it("swaps the docked column for the expanded page", () => {
    const { container } = render(
      <Frame
        kind="main"
        projectPageExpanded
        slots={slots({ projectPage: <div />, projectPageExpanded: <div>expanded</div> })}
      />,
    );
    expect(container.querySelector('[data-region="page"]')).toBeNull();
    expect(container.querySelector('[data-region="page-expanded"]')?.textContent).toBe("expanded");
  });
});

describe("Frame's docked page handle", () => {
  it("puts the page's leading edge under the pointer, past the rail, margin and border", () => {
    const widths: number[] = [];
    const { container } = render(
      <Frame
        kind="main"
        slots={slots({ projectPage: <div>page</div> })}
        onProjectPageWidthChange={(w) => widths.push(w)}
      />,
    );
    const split = container.querySelector(".frame__split") as HTMLElement;
    split.getBoundingClientRect = () => ({ right: 1000, width: 1000 }) as DOMRect;
    const handle = container.querySelector('[data-region="pagehandle"]') as HTMLElement;

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 566 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    // 1000 (row right) - 44 (rail) - 7 (box margin + border) - 500 (pointer) = 449.
    expect(widths).toEqual([449]);
  });

  // A popped-out window is as narrow as 480px: dragging the page wide there must leave the panes
  // their minimum rather than push the rail off the edge.
  it("holds the page back in a narrow window so the panes keep their width", () => {
    const widths: number[] = [];
    const { container } = render(
      <Frame
        kind="detached"
        slots={slots({ projectPage: <div>page</div> })}
        onProjectPageWidthChange={(w) => widths.push(w)}
      />,
    );
    const split = container.querySelector(".frame__split") as HTMLElement;
    split.getBoundingClientRect = () => ({ right: 600, width: 600 }) as DOMRect;
    const handle = container.querySelector('[data-region="pagehandle"]') as HTMLElement;

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 300 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 50 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    // 600 - 44 (rail) - 7 (margin + border) - 240 (panes' minimum) = 309.
    expect(widths).toEqual([309]);
  });
});

describe("Frame's terminal band", () => {
  it("puts the band straight under the tool window", () => {
    const { container } = render(<Frame kind="main" slots={slots({ bottomPanel: <div /> })} />);
    const handle = container.querySelector('[data-region="bottomhandle"]');
    expect(handle?.previousElementSibling?.getAttribute("data-region")).toBe("toolwindow");
  });

  // Braden's report: with Files beside the editor and Agent, the band opened
  // under the Files column only, and every column right of it kept the full
  // height. The band belongs below the whole pane grid, whatever its shape.
  it("spans every pane column, as the tool window's sibling rather than inside a column", () => {
    const tree = (
      <div className="pane-split" data-dir="row">
        <div className="pane-split__child" data-testid="files">
          <div className="pane" />
        </div>
        <div className="pane-split__child" data-testid="editor">
          <div className="pane" />
        </div>
      </div>
    );
    const { container, getByTestId } = render(
      <Frame
        kind="main"
        slots={slots({ toolWindow: tree, bottomPanel: <div>band</div> })}
        bottomCollapsed={false}
        bottomHeight={260}
      />,
    );
    const main = container.querySelector(".frame__main") as HTMLElement;
    const band = container.querySelector('[data-region="bottom"]') as HTMLElement;
    const handle = container.querySelector('[data-region="bottomhandle"]') as HTMLElement;

    // Children of the column that holds the whole tool window, after it.
    expect(band.parentElement).toBe(main);
    expect(handle.parentElement).toBe(main);
    expect(band.closest(".pane-split__child")).toBeNull();
    expect(band.closest('[data-region="toolwindow"]')).toBeNull();

    // No column is singled out to sit over or beside the band.
    expect(container.querySelector("[data-band-under]")).toBeNull();
    expect(getByTestId("files").hasAttribute("data-band-under")).toBe(false);
    expect(getByTestId("editor").hasAttribute("data-band-under")).toBe(false);
    expect(main.hasAttribute("data-band-split")).toBe(false);
    expect(main.style.getPropertyValue("--band-w")).toBe("");

    // The whole tool window gives up the band's height.
    expect(main.style.getPropertyValue("--band-h")).toBe("260px");
  });

  // jsdom cannot lay the band out, so pin the declarations its width rests on:
  // pinned to both edges of `.frame__main`, with no width of its own to narrow it.
  it("pins the band and its handle to both edges of the column in the stylesheet", () => {
    const css = frameCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const decls = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const body = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      return new Map(
        body
          .split(";")
          .filter((d) => d.includes(":"))
          .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
      );
    };
    for (const selector of [".frame__bottom", ".frame__bottomhandle"]) {
      const d = decls(selector);
      expect(d.get("position"), selector).toBe("absolute");
      expect(d.get("left"), selector).toBe("0");
      expect(d.get("right"), selector).toBe("0");
      expect(d.has("width"), selector).toBe(false);
    }
    expect(decls(".frame__main").get("position")).toBe("relative");
    expect(decls(".frame__main .frame__toolwindow").get("margin-bottom")).toContain("--band-h");
    expect(css).not.toContain("data-band-under");
    expect(css).not.toContain("--band-w");
  });

  it("stops a drag where the tool window keeps its minimum", () => {
    const heights: number[] = [];
    const { container } = render(
      <Frame
        kind="main"
        slots={slots({ bottomPanel: <div>band</div> })}
        bottomCollapsed={false}
        onBottomHeightChange={(h) => heights.push(h)}
      />,
    );
    const main = container.querySelector(".frame__main") as HTMLElement;
    main.getBoundingClientRect = () => ({ height: 600, bottom: 600 }) as DOMRect;
    const handle = container.querySelector('[data-region="bottomhandle"]') as HTMLElement;
    handle.getBoundingClientRect = () => ({ height: 6 }) as DOMRect;

    // 500 asked for: past the 474 limit, short of the 60px overshoot that maximizes.
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientY: 400 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientY: 100 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    // 600 (column) - 6 (handle) - 120 (tool window minimum) = 474.
    expect(heights).toEqual([474]);
  });

  /** Every height written to `el` from now on, in order. A spring would write
   *  the heights in between; an instant toggle writes only where it lands. */
  const watchHeights = (el: HTMLElement) => {
    const written: string[] = [];
    let last = el.style.height;
    new MutationObserver(() => {
      if (el.style.height !== last) written.push((last = el.style.height));
    }).observe(el, { attributes: true, attributeFilter: ["style"] });
    return written;
  };

  // Opening and shutting from the toolbar is instant: the band jumps straight
  // to where it is going, with no spring writing the heights in between.
  it("opens the band to its height in one step, and shuts it in one step", async () => {
    const band = <div>band</div>;
    const at = (collapsed: boolean) => (
      <Frame
        kind="main"
        slots={slots({ bottomPanel: band })}
        bottomCollapsed={collapsed}
        bottomHeight={260}
      />
    );
    const { container, rerender } = render(at(true));
    const bottom = container.querySelector('[data-region="bottom"]') as HTMLElement;
    expect(bottom.style.height).toBe("0px");
    const written = watchHeights(bottom);

    rerender(at(false));
    await waitFor(() => expect(bottom.style.height).toBe("260px"));
    await new Promise((r) => setTimeout(r, 100));
    expect(written).toEqual(["260px"]);

    rerender(at(true));
    await waitFor(() => expect(bottom.style.height).toBe("0px"));
    await new Promise((r) => setTimeout(r, 100));
    expect(written).toEqual(["260px", "0px"]);
  });

  // Each observer the frame makes, with what it watches and what it runs.
  let observers: { seen: Element[]; resized: () => void }[] = [];
  const realObserver = globalThis.ResizeObserver;
  const realRect = Element.prototype.getBoundingClientRect;
  const observeByHand = () => {
    observers = [];
    globalThis.ResizeObserver = class {
      readonly seen: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        observers.push({ seen: this.seen, resized: () => callback([], this) });
      }
      observe(el: Element) {
        this.seen.push(el);
      }
      unobserve() {}
      disconnect() {}
    };
  };
  const restore = () => {
    globalThis.ResizeObserver = realObserver;
    Element.prototype.getBoundingClientRect = realRect;
  };

  it("re-fits a maximized band to the column when the column changes size", async () => {
    observeByHand();
    try {
      const { container } = render(
        <Frame
          kind="main"
          slots={slots({ bottomPanel: <div>band</div> })}
          bottomCollapsed={false}
          bottomMaximized
        />,
      );
      const main = container.querySelector(".frame__main") as HTMLElement;
      const column = observers.filter((o) => o.seen.includes(main)).pop();
      expect(column?.seen).toEqual([main]);
      // The mount lands on the fit jsdom measures, 0px.
      const band = container.querySelector('[data-region="bottom"]') as HTMLElement;
      await waitFor(() => expect(band.style.height).toBe("0px"));

      main.getBoundingClientRect = () => ({ height: 700 }) as DOMRect;
      const handle = container.querySelector('[data-region="bottomhandle"]') as HTMLElement;
      handle.getBoundingClientRect = () => ({ height: 6 }) as DOMRect;
      act(() => column?.resized());

      // 700 (column) - 6 (handle) = 694: the whole column, with no tool window left.
      await waitFor(() => expect(band.style.height).toBe("694px"));
      await new Promise((r) => setTimeout(r, 300));
      expect(band.style.height).toBe("694px");
    } finally {
      restore();
    }
  });

  it("opens a maximized band to the whole column at once, though its observer reports as it starts", async () => {
    observeByHand();
    // The column's size from the first layout on, as a browser has it before any observer starts.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains("frame__main")) return { height: 700 } as DOMRect;
      if (this.getAttribute("data-region") === "bottomhandle") return { height: 6 } as DOMRect;
      return realRect.call(this);
    };
    try {
      const band = <div>band</div>;
      const { container, rerender } = render(
        <Frame kind="main" slots={slots({ bottomPanel: band })} bottomCollapsed bottomMaximized />,
      );
      const bottom = container.querySelector('[data-region="bottom"]') as HTMLElement;
      const written = watchHeights(bottom);
      rerender(
        <Frame
          kind="main"
          slots={slots({ bottomPanel: band })}
          bottomCollapsed={false}
          bottomMaximized
        />,
      );
      const main = container.querySelector(".frame__main") as HTMLElement;
      // The observer the open started reports at once, with the height the column already had.
      act(() =>
        observers
          .filter((o) => o.seen.includes(main))
          .pop()
          ?.resized(),
      );

      // 700 (column) - 6 (handle) = 694, reached in one step from shut.
      await waitFor(() => expect(bottom.style.height).toBe("694px"));
      await new Promise((r) => setTimeout(r, 100));
      expect(bottom.style.height).toBe("694px");
      expect(written.filter((h) => h !== "694px")).toEqual([]);
    } finally {
      restore();
    }
  });
});
