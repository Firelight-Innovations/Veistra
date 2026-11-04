/**
 * The title bar — logo, six menus (or their hamburger collapse), a centred
 * group of the project pill (which is the cluster switcher) and search, the
 * right-hand actions (or their overflow collapse) and the three window
 * controls, which never collapse.
 *
 * Menu geometry is lifted from `docs/handoffs/shell-spec.html` (search
 * `>File<`); the pill is `docs/design/VEISTRA-UX-SPEC.md` §1.2 / board 08. The
 * environment summary (worktree kind, branch, ahead/behind, path) and Review &
 * merge live in the status bar (`StatusBar`), so each git fact is drawn once.
 * `titlebar.css` owns the collapse order; `docs/design-notes/shell-chrome.md`
 * records why it is the one it is (#336).
 *
 * This component does not set the bar's height or background: `Frame` already
 * renders it into `.frame__titlebar`. Setting either here would be two owners
 * of one property.
 */
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { Menu, WindowKind } from "../contract";
import type { Environment } from "../environment";
import { BrandGlyph } from "../../ui/Icon";
import MenuBar from "./MenuBar";
import HamburgerMenu from "./HamburgerMenu";
import WindowControls from "./WindowControls";
import { useNarrowTitlebar } from "./useNarrowTitlebar";
import ClusterSwitcher, { type ClusterSwitcherProps } from "./ClusterSwitcher";
import "./titlebar.css";

export interface TitleBarProps {
  kind: WindowKind;
  /**
   * The **active cluster's** project name, or `null` when that cluster has none
   * — or when this window has no cluster at all. A project belongs to a cluster,
   * so this is what lets two windows name two projects at once. It comes from
   * `useClusterProject`, asked about whichever cluster this window is showing.
   */
  project: string | null;
  /** That project's own icon as a `data:` URL, or `null` for its initial. */
  projectIcon?: string | null;
  /**
   * The active cluster's environment, or `null` while no cluster is open. Drives
   * the pill's trailing chip — see `ProjectPill.tsx`.
   */
  environment: Environment | null;
  /**
   * What the chip names when `environment` is not `null`: the cluster's own
   * name. `docs/design/VEISTRA-UX-SPEC.md` §1.2's own example ("godot-port") is a
   * cluster's short name rather than its full branch, which is what a person
   * actually recognises a cluster by — the branch is already on the switcher
   * tab and on the environment bar below it.
   */
  environmentLabel: string | null;
  /**
   * How many distinct environments this project's clusters cover, shown only
   * while `environment` is `null` — the pill's idle state (§1.2).
   */
  environmentCount: number;
  /**
   * Everything the pill's dropdown needs beyond what the pill itself draws: the
   * clusters and the verbs on them. The pill *is* the cluster switcher now, so
   * it is drawn whenever this is given, with a project or without, with zero
   * clusters or one.
   */
  switcher?: Omit<
    ClusterSwitcherProps,
    "project" | "projectIcon" | "environment" | "environmentLabel" | "environmentCount"
  >;
  /**
   * Built by `defaultMenus()`, wired against `WindowRoot`'s state and the active
   * app frame. Rebuilt on every render, because half the items read live state —
   * Save disables when nothing is dirty, the toggles say which way they will go.
   */
  menus: Menu[];
  /** The search field, drawn after the pill and centred with it. */
  searchSlot?: ReactNode;
  /** The right-hand actions (`TitleBarActions`), beside the window controls. */
  actionsSlot?: ReactNode;
}

/** The CSS variable the middle group reads its room from (`titlebar.css`). */
export const SIDE_RESERVE_VAR = "--titlebar-side";

/**
 * Keeps the middle group centred without letting it reach either side.
 *
 * Centred on the window, the group can be at most the bar less *twice* the
 * wider side, and which side is wider, and by how much, depends on the font
 * (Inter is not bundled, so Windows draws the menus in Segoe UI), on whether
 * the menus or the buttons have collapsed, and on whether the tool-health
 * badge is showing. So the two sides are measured, not assumed: each is as
 * wide as its content (`titlebar.css`), and the wider one is written to
 * `SIDE_RESERVE_VAR`. The collapse rules themselves stay on the window's
 * width (`useNarrowTitlebar`); this only bounds the group.
 */
function useSideReserve(
  bar: RefObject<HTMLElement | null>,
  start: RefObject<HTMLElement | null>,
  end: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const sides = [start.current, end.current];
    if (!bar.current || sides.some((side) => side === null)) return;
    const update = () => {
      const widest = Math.max(...sides.map((side) => side?.getBoundingClientRect().width ?? 0));
      bar.current?.style.setProperty(SIDE_RESERVE_VAR, `${Math.ceil(widest)}px`);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    for (const side of sides) if (side) observer.observe(side);
    return () => observer.disconnect();
  }, [bar, start, end]);
}

export default function TitleBar({
  kind,
  project,
  projectIcon = null,
  environment,
  environmentLabel,
  environmentCount,
  switcher,
  menus,
  searchSlot,
  actionsSlot,
}: TitleBarProps) {
  const narrow = useNarrowTitlebar();
  const showPill = switcher !== undefined;
  const showMiddle = showPill || searchSlot !== undefined;
  const barRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useSideReserve(barRef, startRef, endRef);

  return (
    // Three cells on a grid whose outer tracks are equal (`titlebar.css`), so
    // the middle group is centred on the window whatever the two sides hold.
    // The drag attribute is on the bar, the cells, and every non-interactive
    // element inside them: Tauri applies it to the element that was pressed,
    // not its descendants, so a button never starts a drag and the gaps between
    // controls always do.
    <div
      ref={barRef}
      className="titlebar"
      data-window-kind={kind}
      data-has-middle={showMiddle || undefined}
      data-tauri-drag-region
    >
      <div ref={startRef} className="titlebar__start" data-tauri-drag-region>
        <div className="titlebar__logo" data-tauri-drag-region>
          <BrandGlyph size={15} className="titlebar__logo-icon" />
        </div>

        {narrow ? <HamburgerMenu menus={menus} /> : <MenuBar menus={menus} />}
      </div>

      {showMiddle && (
        <div className="titlebar__middle" data-tauri-drag-region>
          {/* Always drawn: it is the cluster switcher, and the only place a
              window with no project and no clusters can start one (it reads
              "No project" and its menu carries New cluster). Hiding it at zero
              or one cluster left nothing on screen to say clusters exist. */}
          {showPill && switcher && (
            <ClusterSwitcher
              {...switcher}
              project={project}
              projectIcon={projectIcon}
              environment={environment}
              environmentLabel={environmentLabel}
              environmentCount={environmentCount}
            />
          )}
          {searchSlot}
        </div>
      )}

      {/* The window controls are outside `actionsSlot`, so nothing that
          collapses the actions can take them with it. */}
      <div ref={endRef} className="titlebar__end" data-tauri-drag-region>
        {actionsSlot}
        <WindowControls />
      </div>
    </div>
  );
}
