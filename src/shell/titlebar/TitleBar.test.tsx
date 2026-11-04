// @vitest-environment jsdom
/**
 * The title bar's cells: the cluster switcher pill is always drawn, with zero
 * clusters and with one; it and search are one middle group at every collapse
 * step; and the window controls stay out of whatever collapses (#336).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Cluster } from "../contract";

// The menus are `menus.test.ts`'s; here they only need to be somewhere.
vi.mock("./MenuBar", () => ({ default: () => <nav aria-label="Menus" /> }));
vi.mock("./HamburgerMenu", () => ({ default: () => <button type="button">Menu</button> }));

// Which collapse step the window is at. The widths are `useNarrowTitlebar.test.ts`'s.
const layout = vi.hoisted(() => ({ narrow: false, collapsed: false }));
vi.mock("./useNarrowTitlebar", () => ({
  useNarrowTitlebar: () => layout.narrow,
  useCollapsedTitlebarActions: () => layout.collapsed,
}));

import TitleBar, { SIDE_RESERVE_VAR } from "./TitleBar";
import TitleBarActions from "./TitleBarActions";

beforeEach(() => {
  layout.narrow = false;
  layout.collapsed = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const handlers = () => ({
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNewCluster: vi.fn(),
  onNewWorktreeCluster: vi.fn(),
  onSwitchProject: vi.fn(),
  onHome: vi.fn(),
});

function mount(
  clusters: Cluster[],
  project: string | null,
  slots: { searchSlot?: ReactNode; actionsSlot?: ReactNode } = {},
) {
  const h = handlers();
  const view = render(
    <TitleBar
      kind="main"
      project={project}
      environment={null}
      environmentLabel={null}
      environmentCount={0}
      menus={[]}
      switcher={{
        clusters,
        activeClusterId: clusters[0]?.id ?? null,
        ahead: 0,
        behind: 0,
        terminals: [],
        ...h,
      }}
      {...slots}
    />,
  );
  return { ...h, bar: view.container.querySelector<HTMLElement>(".titlebar")! };
}

const one = {
  id: "a",
  name: "one",
  tree: { kind: "leaf", tabs: [], active: null },
  project: "C:/p",
  worktree: null,
  activeTerminal: null,
  bandHeight: null,
  pinned: false,
} as unknown as Cluster;

describe("the cluster switcher pill", () => {
  it("is drawn with no project and no clusters, and can start one", () => {
    const h = mount([], null);
    fireEvent.click(screen.getByRole("button", { name: /^Switch cluster/ }));
    expect(screen.getByText("This window has no clusters yet.")).toBeTruthy();
    fireEvent.click(screen.getByText("New cluster…"));
    expect(h.onNewCluster).toHaveBeenCalled();
  });

  it("is drawn with a single cluster", () => {
    mount([one], "proj");
    expect(screen.getByRole("button", { name: /^Switch cluster/ })).toBeTruthy();
  });
});

const search = <button type="button" aria-label="Search project files" />;

const actions = (
  <TitleBarActions
    onUpgrade={vi.fn()}
    onNewAgent={vi.fn()}
    terminalOpen={false}
    onToggleTerminal={vi.fn()}
    agentsOpen={false}
    onToggleAgents={vi.fn()}
    clustersOpen
    onToggleClusters={vi.fn()}
    onOpenSettings={vi.fn()}
  />
);

/** The three collapse steps: wide, buttons folded, buttons and menus folded. */
const STEPS = [
  { narrow: false, collapsed: false },
  { narrow: false, collapsed: true },
  { narrow: true, collapsed: true },
];

const CONTROLS = ["Minimise", "Maximise", "Close"];

describe("the title bar's middle group", () => {
  it.each(STEPS)(
    "holds the pill and search together, between the sides (menus folded: $narrow, buttons folded: $collapsed)",
    (step) => {
      Object.assign(layout, step);
      const { bar } = mount([one], "proj", { searchSlot: search, actionsSlot: actions });

      const cells = [...bar.children].map((c) => c.className);
      expect(cells).toEqual(["titlebar__start", "titlebar__middle", "titlebar__end"]);
      expect(bar.hasAttribute("data-has-middle")).toBe(true);

      const middle = bar.querySelector(".titlebar__middle")!;
      const pill = screen.getByRole("button", { name: /^Switch cluster/ });
      const field = screen.getByRole("button", { name: "Search project files" });
      expect(middle.contains(pill)).toBe(true);
      expect(middle.contains(field)).toBe(true);
      // Pill first, then search, as one group.
      expect(pill.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  it.each(STEPS)(
    "keeps the window controls in the bar and out of the overflow menu (menus folded: $narrow, buttons folded: $collapsed)",
    (step) => {
      Object.assign(layout, step);
      const { bar } = mount([one], "proj", { searchSlot: search, actionsSlot: actions });
      const end = bar.querySelector(".titlebar__end")!;

      if (step.collapsed) {
        fireEvent.click(screen.getByRole("button", { name: "More actions" }));
        const rows = screen.getAllByRole("menuitem").map((r) => r.textContent ?? "");
        expect(rows.length).toBeGreaterThan(0);
        for (const control of CONTROLS) expect(rows.some((r) => r.includes(control))).toBe(false);
      }

      for (const control of CONTROLS) {
        const button = screen.getByRole("button", { name: control });
        expect(end.contains(button)).toBe(true);
        expect(button.closest(".overflowmenu")).toBeNull();
      }
    },
  );
});

describe("the middle group's bound", () => {
  /** Lays the two sides out at these widths; everything else at zero. */
  function sidesAt(widths: { start: number; end: number }) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const width = this.classList.contains("titlebar__start")
        ? widths.start
        : this.classList.contains("titlebar__end")
          ? widths.end
          : 0;
      return { x: 0, y: 0, top: 0, left: 0, width, height: 0, right: width, bottom: 0 } as DOMRect;
    });
  }

  it("reserves the wider side's width, read from the sides themselves", () => {
    sidesAt({ start: 360.4, end: 182 });
    const { bar } = mount([one], "proj", { searchSlot: search, actionsSlot: actions });
    expect(bar.style.getPropertyValue(SIDE_RESERVE_VAR)).toBe("361px");
  });

  it("is measured again when a side changes width", () => {
    let observed: ResizeObserverCallback = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          observed = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const widths = { start: 65, end: 182 };
    sidesAt(widths);
    const { bar } = mount([one], "proj", { searchSlot: search, actionsSlot: actions });
    expect(bar.style.getPropertyValue(SIDE_RESERVE_VAR)).toBe("182px");

    // The buttons unfold: the right side grows and the group's room shrinks.
    widths.end = 445.7;
    observed([], {} as ResizeObserver);
    expect(bar.style.getPropertyValue(SIDE_RESERVE_VAR)).toBe("446px");
  });
});
