/**
 * The title bar's centred pill, and the dropdown it opens: the cluster switcher.
 *
 * This is where the row of cluster tabs went. Every cluster the window holds is
 * listed with its environment chip, its branch and (for the open one) how far
 * it is ahead of or behind its base; below them are the ways to make another,
 * and the way to change project, which the pill opened directly before it
 * became this.
 *
 * Keyboard: the pill is a real button (Enter or Space opens it), focus lands on
 * the open cluster, ArrowUp/ArrowDown/Home/End move between rows and actions,
 * Enter or Space activates, Escape closes and puts focus back on the pill. The
 * window-wide chords — Ctrl+1…9, Ctrl+Tab and Ctrl+Shift+Tab — are bound in
 * `useKeyboard.ts`; the rows show the number so the two stay discoverable
 * together.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cloud, GitBranch, Home, Pin, Plus, FolderOpen, Smile } from "lucide-react";
import type { Cluster } from "../contract";
import { environmentOf, ENVIRONMENT_LABEL, type Environment } from "../environment";
import { popover } from "../motion";
import { Close } from "../../ui/Icon";
import ClusterChip from "../ClusterChip";
import ProjectPill from "./ProjectPill";
import { branchLabel, needsAttention, type ClusterTerminal } from "../clusterList";
import "./clusterSwitcher.css";

// Main drew a lock while it was read-only. It is a branch like any other now.
const KIND_ICON = {
  worktree: GitBranch,
  design: GitBranch,
  cloud: Cloud,
  main: GitBranch,
} as const;

export interface ClusterSwitcherProps {
  /** The pill's own content — the same fields `TitleBar` always handed it. */
  project: string | null;
  projectIcon?: string | null;
  environment: Environment | null;
  environmentLabel: string | null;
  environmentCount: number;
  /** In display order (`orderClusters`), so a row's number is its Ctrl+N. */
  clusters: Cluster[];
  activeClusterId: string | null;
  /** The open cluster's divergence, when known. Nothing measures the others'. */
  ahead?: number;
  behind?: number;
  terminals: ClusterTerminal[];
  onSelect: (clusterId: string) => void;
  onClose: (clusterId: string) => void;
  /** Opens the icon picker for a cluster. */
  onChangeIcon?: (clusterId: string) => void;
  /** File > New Cluster: the dialog with its usual first choice. */
  onNewCluster: () => void;
  /** The same dialog, opened on "new local worktree". */
  onNewWorktreeCluster: () => void;
  /** Ctrl+Alt+P: the Switch project dialog the pill used to open itself. */
  onSwitchProject: () => void;
  /** Covers the window with Home, or takes it down again. */
  onHome?: () => void;
}

/** "↑2 ↓1", or `null` when the cluster is level or nothing is known. */
export function divergence(ahead?: number, behind?: number): string | null {
  const parts = [
    ahead !== undefined && ahead > 0 ? `↑${ahead}` : null,
    behind !== undefined && behind > 0 ? `↓${behind}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

export default function ClusterSwitcher(props: ClusterSwitcherProps) {
  const {
    clusters,
    activeClusterId,
    ahead,
    behind,
    terminals,
    onSelect,
    onClose,
    onChangeIcon,
    onNewCluster,
    onNewWorktreeCluster,
    onSwitchProject,
    onHome,
  } = props;

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) pillRef.current?.focus();
  };

  // Dismissed like every other popover in the shell: a click outside, Escape,
  // or the window losing focus — which is also what a click into an app's
  // iframe looks like from here (`MenuBar` has the long version).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  // Focus goes to the open cluster (or the first row) on open, so the arrow
  // keys work immediately. After paint, because the panel mounts with the state.
  useEffect(() => {
    if (!open) return;
    const rows = navItems(panelRef.current);
    const start = rows.find((el) => el.getAttribute("aria-selected") === "true") ?? rows[0];
    start?.focus();
  }, [open]);

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const rows = navItems(panelRef.current);
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % rows.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? rows.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    if (next === null) return;
    e.preventDefault();
    rows[next].focus();
  };

  const act = (run: () => void) => () => {
    close(false);
    run();
  };

  return (
    <div className="clusterswitch" ref={wrapRef}>
      <ProjectPill
        ref={pillRef}
        project={props.project}
        icon={props.projectIcon}
        environment={props.environment}
        environmentLabel={props.environmentLabel}
        environmentCount={props.environmentCount}
        expanded={open}
        onOpenSwitcher={() => setOpen((v) => !v)}
      />

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            id={panelId}
            className="clusterswitch__panel"
            role="dialog"
            aria-label="Clusters"
            onKeyDown={onPanelKeyDown}
            initial={popover.initial}
            animate={popover.animate}
            exit={popover.exit}
          >
            <div className="clusterswitch__header">CLUSTERS</div>

            {clusters.length === 0 ? (
              <p className="clusterswitch__empty">This window has no clusters yet.</p>
            ) : (
              <ul className="clusterswitch__list" role="listbox" aria-label="Clusters">
                {clusters.map((cluster, index) => (
                  <ClusterRow
                    key={cluster.id}
                    cluster={cluster}
                    index={index}
                    active={cluster.id === activeClusterId}
                    diverged={cluster.id === activeClusterId ? divergence(ahead, behind) : null}
                    attention={needsAttention(cluster.id, activeClusterId, terminals)}
                    onSelect={() => {
                      close(true);
                      if (cluster.id !== activeClusterId) onSelect(cluster.id);
                    }}
                    onClose={() => onClose(cluster.id)}
                    onChangeIcon={
                      onChangeIcon &&
                      (() => {
                        close(false);
                        onChangeIcon(cluster.id);
                      })
                    }
                  />
                ))}
              </ul>
            )}

            <div className="clusterswitch__actions">
              <ActionRow icon={<Plus size={14} />} accel="Ctrl+Shift+N" onClick={act(onNewCluster)}>
                New cluster…
              </ActionRow>
              <ActionRow icon={<GitBranch size={14} />} onClick={act(onNewWorktreeCluster)}>
                New worktree cluster…
              </ActionRow>
              {onHome && activeClusterId !== null && (
                <ActionRow icon={<Home size={14} />} onClick={act(onHome)}>
                  Show Home
                </ActionRow>
              )}
              <ActionRow
                icon={<FolderOpen size={14} />}
                accel="Ctrl+Alt+P"
                onClick={act(onSwitchProject)}
              >
                Switch project…
              </ActionRow>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Every focusable row and action, in order. The close buttons are tab stops of their own. */
function navItems(panel: HTMLElement | null): HTMLElement[] {
  return panel ? Array.from(panel.querySelectorAll<HTMLElement>("[data-nav]")) : [];
}

function ClusterRow({
  cluster,
  index,
  active,
  diverged,
  attention,
  onSelect,
  onClose,
  onChangeIcon,
}: {
  cluster: Cluster;
  index: number;
  active: boolean;
  diverged: string | null;
  attention: boolean;
  onSelect: () => void;
  onClose: () => void;
  onChangeIcon?: () => void;
}) {
  const env = environmentOf(cluster);
  const Glyph = KIND_ICON[env.kind];
  const missing = cluster.environmentMissing === true;
  const branch = branchLabel(cluster);

  return (
    <li className="clusterswitch__row" role="presentation" data-active={active || undefined}>
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-nav
        tabIndex={-1}
        className="clusterswitch__option"
        data-cluster-id={cluster.id}
        title={missing ? `${cluster.name} — its worktree folder is missing on disk` : cluster.name}
        onClick={onSelect}
      >
        {cluster.icon && <ClusterChip cluster={cluster} className="clusterswitch__chip" />}
        <span className="clusterswitch__env" data-env-kind={env.kind}>
          <Glyph size={10} strokeWidth={1.5} aria-hidden />
          {ENVIRONMENT_LABEL[env.kind]}
        </span>
        {env.kind === "design" && (
          <Pin size={11} strokeWidth={1.5} className="clusterswitch__pin" aria-hidden />
        )}
        <span className="clusterswitch__name" data-missing={missing || undefined}>
          {cluster.name}
        </span>
        <span className="clusterswitch__branch">{branch}</span>
        {diverged && (
          <span className="clusterswitch__diverged" aria-label={`${diverged} against base`}>
            {diverged}
          </span>
        )}
        {missing && <span className="clusterswitch__flag">missing</span>}
        {attention && (
          <span
            className="clusterswitch__dot"
            role="img"
            aria-label="An agent finished in this cluster"
          />
        )}
        {index < 9 && (
          <kbd className="clusterswitch__num" aria-hidden>
            Ctrl+{index + 1}
          </kbd>
        )}
      </button>
      {onChangeIcon && (
        <button
          type="button"
          className="clusterswitch__close clusterswitch__icon-btn"
          aria-label={`Change icon for ${cluster.name}`}
          title="Change icon…"
          onClick={onChangeIcon}
        >
          <Smile size={13} aria-hidden />
        </button>
      )}
      <button
        type="button"
        className="clusterswitch__close"
        aria-label={`Close ${cluster.name}`}
        onClick={onClose}
      >
        <Close />
      </button>
    </li>
  );
}

function ActionRow({
  icon,
  accel,
  onClick,
  children,
}: {
  icon: ReactNode;
  accel?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-nav
      tabIndex={-1}
      className="clusterswitch__action"
      onClick={onClick}
    >
      <span className="clusterswitch__action-icon" aria-hidden>
        {icon}
      </span>
      <span className="clusterswitch__action-label">{children}</span>
      {accel && (
        <kbd className="clusterswitch__num" aria-hidden>
          {accel}
        </kbd>
      )}
    </button>
  );
}
