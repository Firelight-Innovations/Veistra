/**
 * The worktree tab's whole body: a vertically split panel with the
 * repository's history on top and this cluster's own changes on the bottom,
 * a draggable divider between them.
 *
 * Meant to become what `WindowRoot` hands `SecondaryPanel`'s `worktreeView`
 * slot in place of `SourceControlView` alone — not wired up by this file (see
 * the props note below).
 *
 * ## Why two sections instead of one
 *
 * The top is about the *repository* — `CommitGraph` over every branch,
 * whichever cluster happens to be active — and the bottom is about *this
 * cluster's own work*: what its worktree has changed since it forked, or, for
 * a cluster with no worktree, the ordinary staged/unstaged view. Switching
 * clusters on the same repository leaves the top alone and replaces the
 * bottom, which is the whole reason they are drawn as two independent
 * sections rather than one scrolling list.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { languageIdForPath } from "@veistra/monaco-languages";
import type {
  GitBranch,
  GitCommit,
  GitControl,
  GitDiff,
  GitDivergence,
  GitFileChange,
  GitWorktree,
  ReviewControl,
  ReviewSend,
  WorktreeControl,
} from "../contract";
import { GIT_KIND_LETTER, GIT_KIND_TOKEN } from "../contract";
// Aliased: `GitBranch` is already the contract's word for a branch here, and
// the glyph and the record would otherwise be the same identifier.
import { GitBranch as BranchGlyph } from "../../ui/Icon";
import { READ_ONLY_HINT } from "../environment";
import CommitGraph from "./CommitGraph";
import { beginResize } from "../resizeGate";
import { focusWithoutScrolling } from "./rowFocus";
import { clampTopRatio, clipFloorPx, type PanelSection } from "./sectionFloor";
import SourceControlView from "./SourceControlView";
import { gitMessage, type GitStatusHandle } from "./useGitStatus";
import "./worktreePanel.css";

/** Lazy for the same reason `SourceControlView` lazy-loads it: this file is
 *  mounted for the life of the window, and a static import would make every
 *  window pay for Monaco to render a tab most sessions never open.
 *
 *  The annotating wrapper, because a worktree's divergence *is* the
 *  agent-produced diff — what this branch changed since it forked is the thing
 *  a person opens this panel to review. */
const AnnotatedDiff = lazy(() => import("../diff/AnnotatedDiff"));

/** Plenty for a lane diagram a few hundred pixels tall; the graph draws
 *  whatever fits and scrolls the rest, so this only bounds how much history
 *  a `git log` has to walk. */
const GRAPH_LIMIT = 200;

const DEFAULT_TOP_RATIO = 0.45;

/** The divider's own height in the flex column, mirroring
 *  `.worktreepanel__divider`'s `height` in `worktreePanel.css`. Duplicated
 *  here because `sectionBasis` below has to subtract it and CSS cannot hand a
 *  number to JavaScript; the two are commented at both ends so a change to
 *  either is visibly a change to a pair. */
const DIVIDER_PX = 1;

/**
 * One section's `flex-basis`.
 *
 * The subtraction is the whole point. Neither section grows and only the top
 * shrinks, and only under the bottom's `min-height` — see the note in
 * `worktreePanel.css` for why — so two bases summing to a plain `100%` plus a
 * divider between them overflows the column by exactly the divider's height,
 * and the panel grows a scrollbar whose entire scrollable range is one pixel.
 * Splitting the divider between the two keeps the sum
 * exact at every ratio, which is the difference between the scrollbar not
 * being *reachable* and it not *existing*.
 */
function sectionBasis(ratio: number): string {
  return `calc(${ratio * 100}% - ${DIVIDER_PX / 2}px)`;
}

export interface WorktreePanelProps {
  /** `null` for "no cluster is active" — renders the empty state below and
   *  calls none of the RPCs, matching every other region's rule for an unset
   *  cluster. */
  clusterId: string | null;
  worktreeControl: WorktreeControl;
  /** Passed straight through to `SourceControlView` for the no-worktree case
   *  — see the `divergence === null` branch below. Cluster-scoped, like
   *  everything else here; it used to be scoped to the focused tool, which is
   *  what made this whole section render an error instead of a change list. */
  gitControl: GitControl;
  /** Passed to both diff surfaces below — this section's divergence view and
   *  the `SourceControlView` that replaces it for a cluster with no worktree. */
  reviewControl: ReviewControl;
  reviewSend: ReviewSend;
  git: GitStatusHandle;
  /**
   * Resolved by the caller, not here. `WorktreeControl.list` returns every
   * worktree of the *repository*, with no field saying which one (if any)
   * belongs to this cluster — that binding is `Cluster.worktree`, which lives
   * on the record `contract.ts` deliberately keeps out of this file (see the
   * header comment there on regions never importing each other's source). So
   * the caller resolves it — from `cluster.worktree?.branch`, falling back to
   * the checked-out branch of the project itself — and hands it down rather
   * than this component guessing at a path match that could pick the wrong one
   * when two clusters share a repo.
   */
  activeBranch: string | null;
  /** The cluster is browsing main: checkout, staging and committing are
   *  disabled with `READ_ONLY_HINT`. Rust refuses them regardless. */
  readOnly?: boolean;
  /** Where the cluster is pointed (worktree, else project). Only compared: a
   *  repointed cluster keeps its id, so without this the graph kept drawing
   *  the previous project's history until the panel was reopened. */
  root?: string | null;
}

interface RepoData {
  commits: GitCommit[];
  /** Why the history could not be read, when `git log` failed. The rest of the
   *  panel still works, so this is drawn in the graph's place rather than
   *  failing the whole panel — and never as an empty "No commits". */
  graphError: string | null;
  worktrees: GitWorktree[];
  /** Every local branch, most recently committed to first — what `CheckoutBar`
   *  offers. Fetched alongside the graph rather than on opening the menu, so
   *  the button can say which branch is current without a round trip and the
   *  list is already there when the menu opens. */
  branches: GitBranch[];
  /** `null` means this cluster works in its project folder, not a worktree —
   *  see `WorktreeControl.divergence`. */
  divergence: GitDivergence | null;
}

export default function WorktreePanel({
  clusterId,
  worktreeControl,
  gitControl,
  reviewControl,
  reviewSend,
  git,
  activeBranch,
  readOnly = false,
  root = null,
}: WorktreePanelProps) {
  const [data, setData] = useState<RepoData | null>(null);
  const [loading, setLoading] = useState(clusterId !== null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to re-ask, the same shape `useGitStatus` uses. A checkout is the
   *  only thing that turns it: nothing else in this panel changes which commit
   *  is HEAD, and there is no watcher behind any of these calls. */
  const [nonce, setNonce] = useState(0);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

  useEffect(() => {
    if (clusterId === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Guards the same race `useGitStatus` guards: switching clusters twice
    // quickly leaves two requests in flight, and the slower one resolving
    // last must not overwrite the newer cluster's data with the older one's.
    let live = true;
    setLoading(true);

    Promise.all([
      worktreeControl.graph(clusterId, GRAPH_LIMIT).then(
        (commits) => ({ commits, graphError: null as string | null }),
        (reason: unknown) => ({ commits: [] as GitCommit[], graphError: gitMessage(reason) }),
      ),
      worktreeControl.list(clusterId),
      worktreeControl.branches(clusterId),
      worktreeControl.divergence(clusterId),
    ]).then(
      ([{ commits, graphError }, worktrees, branches, divergence]) => {
        if (!live) return;
        setData({ commits, graphError, worktrees, branches, divergence });
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setData(null);
        setError(gitMessage(reason));
        setLoading(false);
      },
    );

    return () => {
      live = false;
    };
    // `git.status` is a fresh object after every status fetch, which happens on
    // a repoint and after every commit, stage or checkout — so keying on it
    // re-reads the history whenever the branch picker's own data moved.
  }, [clusterId, worktreeControl, nonce, root, git.status]);

  // A commit selected in one repository means nothing in another's graph.
  useEffect(() => setSelectedSha(null), [clusterId]);

  /**
   * Everything a checkout invalidates, re-asked.
   *
   * Both halves, and neither is optional. This panel's own data moves because
   * HEAD did — the graph's badges, the worktree list, the divergence. The
   * change list moves too and lives in `useGitStatus`, one level up, because
   * the status bar names the same branch (see that module's header): a
   * checkout that refreshed only this panel would leave the status bar naming
   * the branch the user just left.
   *
   * Keyed on `git.refresh` rather than on `git`, which is a fresh object on
   * every render of `WindowRoot` — `useGitStatus` builds its handle inline. The
   * function inside it is a stable `useCallback`, so naming it directly is what
   * keeps this identity from churning down through `CheckoutBar`.
   */
  const refreshStatus = git.refresh;
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
    refreshStatus();
  }, [refreshStatus]);

  // --- the divider ---------------------------------------------------------
  // Same pattern as `PaneTree.tsx`'s `Split` and `Frame.tsx`'s panel handle:
  // write the two sections' sizes straight to the DOM for the whole gesture
  // and only tell React once, on pointer-up. A divider that set state on
  // every pointermove would judder — seeing a re-render (and everything
  // downstream of one, here including a mounted Monaco diff editor measuring
  // itself) on every pixel of motion cannot promise 1:1 tracking with the
  // cursor.

  const containerRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [topRatio, setTopRatio] = useState(DEFAULT_TOP_RATIO);

  // Which view the bottom section is drawing, which is what its floor is
  // derived from: only `SourceControlView` has a commit box, and only a commit
  // box can push `.worktree__error` out of an `overflow: hidden` section. The
  // stricter of the two while the first fetch is outstanding, since the answer
  // arriving cannot then make the floor jump upward under a divider already
  // dragged.
  const bottomSection: PanelSection =
    data === null || data.divergence === null ? "source-control" : "divergence";

  const onDividerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;

      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // A pointer id the browser no longer considers active throws here;
        // see the identical guard in `PaneTree.tsx`'s `onDividerDown`.
      }

      const rect = container.getBoundingClientRect();
      const total = rect.height;
      if (total <= 0) return;

      const startY = e.clientY;
      const startRatio = topRatio;
      let nextRatio = startRatio;
      const endResize = beginResize();

      const onMove = (ev: PointerEvent) => {
        const delta = (ev.clientY - startY) / total;
        nextRatio = clampTopRatio(startRatio + delta, total, bottomSection);
        if (topRef.current) topRef.current.style.flexBasis = sectionBasis(nextRatio);
        if (bottomRef.current) bottomRef.current.style.flexBasis = sectionBasis(1 - nextRatio);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        // The only place `topRatio` reaches React state — see the header
        // note above. This is view-local, same as `WindowRoot`'s
        // `panelWidth`: a split ratio between two sections of one window's
        // panel means nothing in another window and has no business in
        // Rust's `shell:state`.
        setTopRatio(nextRatio);
        endResize();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [bottomSection, topRatio],
  );

  if (clusterId === null) {
    return (
      <div className="worktreepanel">
        <div className="worktreepanel__quiet">No cluster selected.</div>
      </div>
    );
  }

  if (data === null) {
    // Mirrors `SourceControlView`'s empty state: nothing drawn while the
    // first fetch for a cluster is outstanding, so switching clusters
    // doesn't flash an empty panel before the RPCs resolve. A refetch after
    // the first one leaves the previous cluster's data on screen until the
    // new answer lands — also matching `SourceControlView`/`useGitStatus`,
    // and safe here because of the stale-response guard above.
    if (loading) return null;
    return (
      <div className="worktreepanel">
        <div className="worktreepanel__error">{error}</div>
      </div>
    );
  }

  return (
    <div className="worktreepanel" ref={containerRef}>
      <div
        className="worktreepanel__section worktreepanel__section--top"
        ref={topRef}
        style={{ flexBasis: sectionBasis(topRatio) }}
      >
        <CheckoutBar
          clusterId={clusterId}
          worktreeControl={worktreeControl}
          branches={data.branches}
          activeBranch={activeBranch}
          selected={data.commits.find((c) => c.sha === selectedSha) ?? null}
          readOnly={readOnly}
          onCheckedOut={reload}
        />

        <div className="worktreepanel__graph-scroll">
          <CommitGraph
            commits={data.commits}
            error={data.graphError}
            worktrees={data.worktrees}
            activeBranch={activeBranch}
            selected={selectedSha}
            onSelect={setSelectedSha}
          />
        </div>
      </div>

      <div
        className="worktreepanel__divider"
        onPointerDown={onDividerDown}
        role="separator"
        aria-orientation="horizontal"
      />

      <div
        className="worktreepanel__section worktreepanel__section--bottom"
        ref={bottomRef}
        // The floor the divider's clamp cannot reach: the ratio React starts
        // at, and a window shrunk after the divider was placed. Flexbox
        // enforces it over the basis and takes the difference out of the top,
        // which is the only section here that shrinks.
        style={{ flexBasis: sectionBasis(1 - topRatio), minHeight: clipFloorPx(bottomSection) }}
      >
        {data.divergence === null ? (
          <SourceControlView
            control={gitControl}
            clusterId={clusterId}
            git={git}
            review={reviewControl}
            reviewSend={reviewSend}
            readOnly={readOnly}
          />
        ) : (
          <DivergenceView
            clusterId={clusterId}
            worktreeControl={worktreeControl}
            divergence={data.divergence}
            review={reviewControl}
            reviewSend={reviewSend}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Moving the checkout: the branch picker and the selected commit's action
// ---------------------------------------------------------------------------

/**
 * The strip above the graph: which branch this cluster is on, a menu of the
 * others, and — once a commit is selected in the graph below — a button that
 * checks that commit out detached.
 *
 * **Above the graph rather than inside the source-control view below it**, and
 * that placement is the decision worth recording. Switching branches reads as
 * an operation on the change list, so the branch row in `SourceControlView` is
 * where it first went — but that view is only mounted for a cluster working in
 * its project folder. A cluster on a worktree gets `DivergenceView` instead and
 * would have had no way to switch at all.
 *
 * Nothing here guards the checkout. Uncommitted work in the way, a branch
 * another worktree holds, a target that stopped resolving between the fetch and
 * the click: git refuses each with a sentence written to be read, and that
 * sentence is what lands in `failure`. See `git_checkout` in `git.rs`.
 */
function CheckoutBar({
  clusterId,
  worktreeControl,
  branches,
  activeBranch,
  selected,
  readOnly,
  onCheckedOut,
}: {
  readOnly: boolean;
  clusterId: string;
  worktreeControl: WorktreeControl;
  branches: GitBranch[];
  activeBranch: string | null;
  /** The commit selected in the graph, or `null` when none is. */
  selected: GitCommit | null;
  onCheckedOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on a pointerdown outside, matching every other menu in the shell.
  // `pointerdown` rather than `click`, so a press that begins outside closes
  // the menu before whatever it lands on can act.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const checkout = useCallback(
    async (target: string, detach: boolean) => {
      if (busy) return;
      setBusy(true);
      setFailure(null);
      setOpen(false);
      try {
        await worktreeControl.checkout(clusterId, target, detach);
        onCheckedOut();
      } catch (reason: unknown) {
        setFailure(gitMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [busy, clusterId, onCheckedOut, worktreeControl],
  );

  // The tip of the branch already checked out is not somewhere to go, and
  // offering it would detach HEAD at the exact commit the user is standing on.
  const detachable =
    selected !== null && !branches.some((b) => b.current && b.head === selected.sha);

  return (
    <div className="worktreepanel__head" ref={menuRef}>
      <button
        type="button"
        className="worktreepanel__branchbtn"
        disabled={busy || readOnly || branches.length === 0}
        title={readOnly ? READ_ONLY_HINT : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BranchGlyph size={12} />
        <span className="worktreepanel__branchname">{activeBranch ?? "detached"}</span>
        <span className="worktreepanel__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {detachable && (
        <button
          type="button"
          className="worktreepanel__detachbtn"
          disabled={busy || readOnly}
          title={readOnly ? READ_ONLY_HINT : `Check out ${selected.short} — ${selected.summary}`}
          onClick={() => void checkout(selected.sha, true)}
        >
          Check out {selected.short}
        </button>
      )}

      {open && (
        <div className="worktreepanel__branchmenu" role="menu">
          {branches.map((branch) => (
            <BranchOption
              key={branch.name}
              branch={branch}
              busy={busy}
              onPick={() => void checkout(branch.name, false)}
            />
          ))}
        </div>
      )}

      {failure !== null && (
        <div className="worktreepanel__error worktreepanel__error--head">{failure}</div>
      )}
    </div>
  );
}

/** One row of the branch menu. The branch already checked out here is inert
 *  rather than hidden — a menu that dropped it would leave the reader working
 *  out which one they are on — and so is one another worktree holds, which git
 *  would refuse anyway; saying whose it is beats reporting the refusal after
 *  the click. */
function BranchOption({
  branch,
  busy,
  onPick,
}: {
  branch: GitBranch;
  busy: boolean;
  onPick: () => void;
}) {
  const held = branch.worktree !== undefined;
  const classes = ["worktreepanel__branchopt"];
  if (branch.current) classes.push("worktreepanel__branchopt--current");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      role="menuitem"
      disabled={busy || branch.current || held}
      title={held ? `Checked out in ${branch.worktree}` : branch.name}
      onClick={onPick}
    >
      <span className="worktreepanel__branchopt-name">{branch.name}</span>
      {branch.current ? (
        <span className="worktreepanel__branchopt-note">current</span>
      ) : held ? (
        <span className="worktreepanel__branchopt-note">in use</span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The bottom section's non-empty case: a cluster with a worktree
// ---------------------------------------------------------------------------

interface Selection {
  path: string;
}

/**
 * "N files changed since `base` · N commits", the file list, and a diff pane
 * that opens below it on a click — the same click-to-diff shape
 * `SourceControlView` already has, but there is no index here (`staged` is
 * always false on every `GitFileChange` `divergence` returns) so there is no
 * checkbox column and no commit box.
 */
function DivergenceView({
  clusterId,
  worktreeControl,
  divergence,
  review,
  reviewSend,
}: {
  clusterId: string;
  worktreeControl: WorktreeControl;
  divergence: GitDivergence;
  review: ReviewControl;
  reviewSend: ReviewSend;
}) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  // A file selected in one cluster's divergence means nothing in another's —
  // and the merge base backing it may have moved, since `divergenceDiff`
  // takes a `mergeBase` rather than resolving one fresh (see the contract
  // doc on why: a base recomputed between the list and the diff could
  // disagree with what the list was built from).
  useEffect(() => {
    setSelected(null);
    setDiff(null);
    setDiffError(null);
  }, [clusterId]);

  useEffect(() => {
    if (selected === null) {
      setDiff(null);
      return;
    }

    let live = true;
    setDiffError(null);
    worktreeControl.divergenceDiff(clusterId, selected.path, divergence.mergeBase).then(
      (next) => {
        if (live) setDiff(next);
      },
      (reason: unknown) => {
        if (!live) return;
        setDiff(null);
        setDiffError(gitMessage(reason));
      },
    );

    return () => {
      live = false;
    };
  }, [clusterId, worktreeControl, selected, divergence.mergeBase]);

  return (
    <div className="worktreepanel__divergence">
      <div className="worktreepanel__divhead">
        <span className="worktreepanel__divhead-count">
          {divergence.files.length} {divergence.files.length === 1 ? "file" : "files"} changed
        </span>{" "}
        since <span className="worktreepanel__divhead-base">{divergence.base}</span> ·{" "}
        {divergence.commits} {divergence.commits === 1 ? "commit" : "commits"}
      </div>

      <div className="worktreepanel__divlist">
        {divergence.files.length === 0 ? (
          <div className="worktreepanel__quiet">No changes since {divergence.base}</div>
        ) : (
          divergence.files.map((change) => (
            <DivFileRow
              key={change.path}
              change={change}
              selected={selected?.path === change.path}
              onSelect={() => setSelected({ path: change.path })}
            />
          ))
        )}
      </div>

      {selected !== null && (
        <div className="worktreepanel__divdiff">
          <div className="worktreepanel__divdiff-head">
            <span className="worktreepanel__divdiff-path">{selected.path}</span>
            <button
              type="button"
              className="worktreepanel__divdiff-close"
              onClick={() => setSelected(null)}
              aria-label="Close diff"
            >
              ×
            </button>
          </div>
          {diffError !== null ? (
            <div className="worktreepanel__error">{diffError}</div>
          ) : diff === null ? (
            <div className="worktreepanel__quiet">Loading diff…</div>
          ) : (
            <Suspense fallback={<div className="worktreepanel__quiet">Loading diff…</div>}>
              {/* `scope` is "branch" and is fixed rather than derived: every
                  file in a divergence is measured from the fork point, so
                  there is no staged/unstaged distinction here to carry (see
                  `GitDivergence`, whose `staged` is always false). */}
              <AnnotatedDiff
                original={diff.original}
                modified={diff.modified}
                language={languageIdForPath(selected.path)}
                renderSideBySide={false}
                path={selected.path}
                scope="branch"
                clusterId={clusterId}
                control={review}
                send={reviewSend}
              />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}

/** One row of `divergence.files`. Kind letter, file, directory — the same
 *  three columns `SourceControlView`'s `ChangeRow` draws, minus the checkbox
 *  it has no index to back. */
function DivFileRow({
  change,
  selected,
  onSelect,
}: {
  change: GitFileChange;
  selected: boolean;
  onSelect: () => void;
}) {
  const classes = ["worktreepanel__divrow"];
  if (selected) classes.push("worktreepanel__divrow--selected");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      title={change.renamedFrom ? `${change.path} (was ${change.renamedFrom})` : change.path}
      // `.worktreepanel__divlist` scrolls exactly as the source-control lists
      // do, so an edge row here had the same unclickable defect — see
      // `focusWithoutScrolling`.
      onMouseDown={focusWithoutScrolling}
      onClick={onSelect}
    >
      <span className="worktreepanel__divkind" style={{ color: GIT_KIND_TOKEN[change.kind] }}>
        {GIT_KIND_LETTER[change.kind]}
      </span>
      <span
        className={
          change.kind === "deleted"
            ? "worktreepanel__divfile worktreepanel__divfile--deleted"
            : "worktreepanel__divfile"
        }
      >
        {change.file}
      </span>
      <span className="worktreepanel__divdir">{change.dir}</span>
    </button>
  );
}
