import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { GitStatus, UpdateNotice } from "../contract";
import type { Environment } from "../environment";
import { ENVIRONMENT_BAR_LABEL } from "../environment";
import ReviewMergeButton from "./ReviewMergeButton";
import "./statusbar.css";

export interface StatusBarProps {
  /**
   * A newer Veistra, or `null` for nothing worth a pixel — which is what this is
   * almost always. `updateNotice` in `contract.ts` decides which; this
   * component only draws what it is given.
   */
  update: UpdateNotice | null;
  /** The active cluster's project, `null` while none is open — `§1.9`'s left
   *  cluster starts here. */
  project: string | null;
  /** The active cluster's environment, on the same `null`-while-no-cluster
   *  terms as `project` — drives the branch/environment segment. See
   *  `environment.ts`. */
  environment: Environment | null;
  /**
   * One status, read for the ahead/behind upgrade to the branch segment and
   * for the diff-stat readout beside it — the same handle the source-control
   * view reads, cluster-scoped (see `useGitStatus` in `WindowRoot.tsx`).
   * `null` while the fetch has not landed yet or the environment has no
   * repository to read; the branch segment still draws from `environment`
   * alone in that case, just without the arrows.
   */
  git: GitStatus | null;
  githubOk: boolean;
  /** Opens the rail's Git page on Source Control. The "Review & merge" button
   *  is drawn for worktree and design environments only. */
  onReviewAndMerge?: () => void;
  /**
   * Opens the rail's Git page on one of its views, or shuts it with `null`. The
   * branch segment opens Source Control and the GitHub status opens GitHub.
   * Without it both are readouts rather than buttons.
   */
  onShowGit?: (view: GitView | null) => void;
  /** The Git page's view while it is open, else `null`. That view's button
   *  draws pressed, and pressing it again shuts the page. */
  gitShowing?: GitView | null;
}

/** The Git page's two views, as `rail/GitPage.tsx`'s `GitPageView` names them. */
export type GitView = "worktree" | "github";

/**
 * Left cluster, then right cluster, per §1.9: project name, branch/
 * environment and the diff-stat readout on the left; the update notice and
 * GitHub status on the right. Main used to carry a trailing "main is
 * read-only" label; it is written like a worktree now. The bar's own
 * height is `.frame__statusbar`'s — this component only lays out its
 * contents and never touches that box.
 *
 * The bar is where git lives: the branch segment opens Source Control and the
 * GitHub status opens GitHub, each on the rail's Git page. Settings is not
 * here; it opens from Ctrl+, until the title bar has its own button.
 */
export default function StatusBar({
  project,
  environment,
  git,
  githubOk,
  update,
  onReviewAndMerge,
  onShowGit,
  gitShowing = null,
}: StatusBarProps) {
  // A view's button opens the page on that view, or shuts the page when it is
  // the view already showing — the rail's own Git button toggles the same way.
  const toggle = onShowGit && ((view: GitView) => onShowGit(gitShowing === view ? null : view));

  return (
    <div className="statusbar">
      {/* The left cluster is one flex child that shrinks and clips, so a narrow
          window loses the end of the branch name before it can push the right
          cluster (Review & merge, GitHub) off the bar. */}
      <div className="statusbar__left">
        {environment !== null && (
          <>
            {project !== null && <span className="statusbar__project">{project}</span>}
            <EnvironmentChip environment={environment} />
            <BranchSegment
              environment={environment}
              git={git}
              pressed={gitShowing === "worktree"}
              onClick={toggle && (() => toggle("worktree"))}
            />
          </>
        )}
      </div>

      <div className="statusbar__spacer" />

      {update !== null && <UpdateNoticeRow notice={update} />}

      {environment !== null &&
        (environment.kind === "worktree" || environment.kind === "design") && (
          <ReviewMergeButton onClick={onReviewAndMerge} />
        )}

      <GitHubStatus
        ok={githubOk}
        pressed={gitShowing === "github"}
        onClick={toggle && (() => toggle("github"))}
      />
    </div>
  );
}

/**
 * The branch, its ahead/behind arrows and the diff stat: one button that opens
 * Source Control, or the same three as plain readouts with nowhere to open.
 *
 * The environment chip stays outside it. That chip is its own button (it
 * copies the path), and a button inside a button is invalid HTML.
 */
function BranchSegment({
  environment,
  git,
  pressed,
  onClick,
}: {
  environment: Environment;
  git: GitStatus | null;
  pressed: boolean;
  onClick: (() => void) | undefined;
}) {
  const branch = branchName(environment, git);
  const arrows = environment.kind !== "main" && git !== null;
  const files = git === null ? 0 : filesTouched(git);
  const body = (
    <>
      <span className="statusbar__branch">{branch}</span>
      {arrows && (
        <span
          className="statusbar__ahead-behind"
          title={`${git.ahead} ahead, ${git.behind} behind`}
        >
          <span className="statusbar__ahead">↑{git.ahead}</span>{" "}
          <span className="statusbar__behind">↓{git.behind}</span>
        </span>
      )}
      {git !== null && files > 0 && <DiffStat status={git} />}
    </>
  );

  if (onClick === undefined) return <span className="statusbar__git">{body}</span>;

  // The label says in words what the arrows and the diff stat draw, since a
  // label replaces the button's content for assistive technology.
  const label = [`Source control: ${branch}`];
  if (git !== null && arrows) label.push(`${git.ahead} ahead`, `${git.behind} behind`);
  if (git !== null && files > 0) {
    label.push(
      `${files} ${files === 1 ? "file" : "files"} changed`,
      `${git.insertions} ${git.insertions === 1 ? "insertion" : "insertions"}`,
      `${git.deletions} ${git.deletions === 1 ? "deletion" : "deletions"}`,
    );
  }

  return (
    <button
      type="button"
      className="statusbar__git statusbar__git--button"
      title={`Source control: ${branch}`}
      aria-label={label.join(", ")}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <GitBranch size={12} strokeWidth={1.5} aria-hidden className="statusbar__git-icon" />
      {body}
    </button>
  );
}

/**
 * The GitHub dot and label: a button that opens the Git page's GitHub view, or
 * a readout with nowhere to open.
 *
 * The handoff only draws GitHub healthy (--ok). --err is this component's own
 * extrapolation for `ok === false` — the spec has no failure-state crop for
 * this dot to check against. The button is named "GitHub" either way:
 * `WindowRoot` passes `ok` from the stack scan, not from a GitHub sign-in, so a
 * label that said "not connected" would claim something nobody checked.
 */
function GitHubStatus({
  ok,
  pressed,
  onClick,
}: {
  ok: boolean;
  pressed: boolean;
  onClick: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="statusbar__dot" style={{ background: ok ? "var(--ok)" : "var(--err)" }} />
      <span className="statusbar__label">GitHub</span>
    </>
  );

  if (onClick === undefined) return <span className="statusbar__github">{body}</span>;

  return (
    <button
      type="button"
      className="statusbar__github statusbar__github--button"
      aria-pressed={pressed}
      onClick={onClick}
    >
      {body}
    </button>
  );
}

/**
 * The update notice: a dot, a label, and a click when there is one.
 *
 * A `<button>` only when it can act, a `<span>` otherwise. The alternative — a
 * button that is `disabled` for the four states that cannot be pressed — would
 * put four inert buttons in a bar that has one real one, and a status readout
 * that looks pressable is the same lie a live-but-dead menu item tells.
 *
 * **Deliberately not a modal, a toast or a badge with a count.** The handoff
 * has no crop for any of those, and an update is the least urgent thing a
 * developer tool can have to say: it waits in the bar until somebody is
 * between tasks and looks down.
 */
function UpdateNoticeRow({ notice }: { notice: UpdateNotice }) {
  const dot = TONE_TOKEN[notice.tone];

  const body = (
    <>
      <span className="statusbar__dot" style={{ background: dot }} />
      <span className="statusbar__update-label">{notice.label}</span>
    </>
  );

  if (notice.onSelect === undefined) {
    return (
      <span className="statusbar__update" title={notice.detail}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="statusbar__update"
      title={notice.detail}
      onClick={notice.onSelect}
    >
      {body}
    </button>
  );
}

/** The dot's colour per tone. `--accent` is the user's, from Appearance. */
const TONE_TOKEN: Record<UpdateNotice["tone"], string> = {
  offer: "var(--accent)",
  status: "var(--text-dim-2)",
  error: "var(--err)",
};

/**
 * The branch name: `main`, or the environment's own branch, falling back to the
 * kind when a worktree or cloud session reports none yet. Ahead/behind is its
 * own segment drawn once `git` has landed; `git` is cluster-scoped
 * (`useGitStatus` in `WindowRoot.tsx`), so its numbers belong to this same
 * branch. `main` draws no arrows; it has no worktree base to be ahead of.
 */
function branchName(environment: Environment, git: GitStatus | null): string {
  // The main checkout is whatever branch the repository's primary tree has out, which is
  // `master` in older repositories; the status the bar already holds names it.
  if (environment.kind === "main") return git?.branch || "main";
  return environment.branch ?? environment.kind;
}

/**
 * The environment's kind chip ("Local worktree", "Cloud session", "Main"). When
 * the environment has an on-disk path the chip is a button: hover shows the
 * path, click copies it. The path used to sit inline in the title bar, where it
 * was the first thing truncated away; here it is always one hover off.
 */
function EnvironmentChip({ environment }: { environment: Environment }) {
  const [copied, setCopied] = useState(false);
  const label = ENVIRONMENT_BAR_LABEL[environment.kind];
  const path = environment.kind === "cloud" ? undefined : environment.path;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (path === undefined) return <span className="statusbar__kind">{label}</span>;

  const onCopy = () => {
    void navigator.clipboard?.writeText(path).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <button
      type="button"
      className="statusbar__kind statusbar__kind--button"
      title={copied ? "Copied" : `${path}\nClick to copy path`}
      aria-label={`${label}: ${path}. Copy path`}
      onClick={onCopy}
    >
      {label}
    </button>
  );
}

/**
 * How many distinct files this status touches, for the diff-stat readout's
 * `· M files`.
 *
 * Not `staged.length + unstaged.length`: a file that is staged and then
 * edited again appears once in each list (see the doc comment on
 * `GitFileChange` in `contract.ts`), and counting it twice would make this
 * number disagree with what `git status` itself would call one changed file.
 * The de-dupe is by `path` — the field every `GitFileChange` command takes
 * back as an argument, and so the one guaranteed to identify "the same file"
 * across both lists.
 */
function filesTouched(status: GitStatus): number {
  return new Set([...status.staged, ...status.unstaged].map((f) => f.path)).size;
}

/**
 * `+142 -63 · 9 files` — additions and deletions in the same green/red the
 * spec's token table already assigns an added/deleted file (`--ok`/`--err`
 * in tokens.css), the file count left in the bar's ordinary dim text rather
 * than a third colour. Classes rather than inline colours, so the branch
 * button's hover and pressed fills can swap in the text tones that stay
 * readable on them (statusbar.css).
 *
 * Only ever mounted by the caller once `filesTouched(status) > 0` — a status
 * bar is not the place to spend width saying "no changes".
 */
function DiffStat({ status }: { status: GitStatus }) {
  const files = filesTouched(status);
  return (
    <span className="statusbar__diffstat">
      <span className="statusbar__added">+{status.insertions}</span>{" "}
      <span className="statusbar__deleted">-{status.deletions}</span>
      <span className="statusbar__diffstat-files">
        {" "}
        · {files} {files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}
