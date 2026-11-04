/**
 * The title bar's centred pill: which project, and which environment.
 *
 * `docs/design/VEISTRA-UX-SPEC.md` §1.2. A 16×16 tile (the project's own icon,
 * or its initial), the project's
 * name, then either `· N environments` (no cluster active — U-Anatomy and
 * U-Workspace's idle state) or a mono chip naming the active cluster's
 * environment, then a chevron. Clicking it opens the cluster switcher's
 * dropdown (`ClusterSwitcher`), which this button is only the trigger for.
 */
import { forwardRef } from "react";
import { ChevronDown, Cloud, GitBranch, Lock } from "lucide-react";
import type { Environment, EnvironmentKind } from "../environment";
import ProjectTile from "../ProjectTile";
import "./projectPill.css";

const KIND_ICON: Record<EnvironmentKind, typeof GitBranch> = {
  worktree: GitBranch,
  design: GitBranch,
  cloud: Cloud,
  main: Lock,
};

interface ProjectPillProps {
  /** The active cluster's project, or `null` for a window whose cluster has none. */
  project: string | null;
  /** The project's own icon as a `data:` URL; `null` draws the initial. */
  icon?: string | null;
  environment: Environment | null;
  environmentLabel: string | null;
  environmentCount: number;
  /** Whether the dropdown this opens is showing. */
  expanded?: boolean;
  onOpenSwitcher?: () => void;
}

const ProjectPill = forwardRef<HTMLButtonElement, ProjectPillProps>(function ProjectPill(
  {
    project,
    environment,
    environmentLabel,
    environmentCount,
    icon = null,
    expanded = false,
    onOpenSwitcher,
  },
  ref,
) {
  const name = project ?? "No project";
  const Glyph = environment ? KIND_ICON[environment.kind] : null;

  return (
    <button
      ref={ref}
      type="button"
      className="projectpill"
      aria-haspopup="listbox"
      aria-expanded={expanded}
      aria-label={`Switch cluster. Current: ${name}${
        environment ? `, ${environmentLabel ?? environment.branch ?? environment.kind}` : ""
      }`}
      data-open={expanded || undefined}
      onClick={onOpenSwitcher}
      title={`${name} · Switch cluster (Ctrl+Tab)`}
    >
      <ProjectTile name={name} icon={icon} className="projectpill__tile" />
      <span className="projectpill__name">{name}</span>

      {environment === null ? (
        environmentCount > 0 && (
          <span className="projectpill__count">
            · {environmentCount} {environmentCount === 1 ? "environment" : "environments"}
          </span>
        )
      ) : (
        <span className="projectpill__chip">
          {Glyph && <Glyph size={11} strokeWidth={1.5} className="projectpill__chip-icon" />}
          <span className="projectpill__chip-label">
            {environmentLabel ?? environment.branch ?? environment.kind}
          </span>
        </span>
      )}

      <ChevronDown size={12} strokeWidth={1.5} className="projectpill__chevron" />
    </button>
  );
});

export default ProjectPill;
