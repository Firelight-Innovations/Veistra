/**
 * The source-control tab's body, composed into `WorktreePanel`, which is what
 * the rail's Git page (src/shell/rail/GitPage.tsx) shows in its `worktreeView`.
 *
 * Replaces `WorktreeView`, which rendered one flat change list from a
 * subscription and had nowhere to put the index. This is the whole MVP loop:
 * branch, staged and unstaged sections, a checkbox per file that stages or
 * unstages it, a click that shows that file's diff, and a commit box.
 *
 * The status itself is *not* owned here — see `useGitStatus.ts` for why it
 * lives in `WindowRoot` and arrives as a prop. Everything else (which file is
 * selected, its diff, the commit message) is view-local and deliberately reset
 * when the shown cluster changes: none of it means anything in another repo.
 *
 * Scoped to a cluster, not a tool — see the `clusterId` prop below.
 *
 * No motion, for the same reason `WorktreeView` had none — the handoff's
 * motion section is explicit that this list stays at native scroll speed.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { languageIdForPath } from "@veistra/monaco-languages";
import type { GitControl, GitDiff, GitFileChange, ReviewControl, ReviewSend } from "../contract";
import { GIT_KIND_LETTER, GIT_KIND_TOKEN } from "../contract";
import { READ_ONLY_HINT } from "../environment";
import { GitBranch } from "../../ui/Icon";
import { describeLineCounts, formatLineCounts, sumLineCounts } from "./lineCounts";
import { focusWithoutScrolling } from "./rowFocus";
import { followAcrossIndex, isRowSelected, selectionFor, type Selection } from "./selection";
import { gitMessage, type GitStatusHandle } from "./useGitStatus";
import "./worktree.css";

/**
 * Lazy because this reaches `DiffView`, which pulls in Monaco and its worker
 * chunk the moment the module is evaluated, and the Git page keeps this view
 * mounted for as long as it is open — a static import would make every
 * window pay for Monaco at startup to render a pane most sessions never open.
 * The import starts on the first click of a file, which is also when the diff
 * request goes out.
 *
 * The annotating wrapper rather than the bare editor, because these are the two
 * diffs a person reviews an agent's work in. The bare `DiffView` is still what
 * `CommitGraph` shows history in — a note on a commit that is already made
 * would be a note about work that is finished.
 */
const AnnotatedDiff = lazy(() => import("../diff/AnnotatedDiff"));

export interface SourceControlViewProps {
  control: GitControl;
  /**
   * `null` when no cluster is active — the empty state.
   *
   * A cluster id, not a tool id. This view used to take the latter, and every
   * call it made resolved through `git.rs`'s `repo()` — which looks an id up in
   * `StackSnapshot.tools`, the `veistra.toml` stack-component pins. Those are a
   * different id space from the shell's own apps, and `discovery.rs`'s
   * `ENABLED_TOOLS` is `&[]`, so that list is empty for every project. The
   * lookup could therefore only ever fail: every call from here came back
   * `UnknownTool`, and the panel rendered "Git unavailable" where the change
   * list should have been. A cluster id resolves through
   * `project::cluster_path` instead, which follows the worktree-or-project
   * precedence a cluster actually has.
   */
  clusterId: string | null;
  git: GitStatusHandle;
  /** The notes on this cluster's diffs. Passed down rather than reached for
   *  because this region may not import `diff/`'s state, and `WindowRoot` is
   *  where every other cluster-scoped control is assembled. */
  review: ReviewControl;
  /** Where a batch of notes goes when the user sends it. `WindowRoot` builds
   *  this: half of it is which terminal the cluster is showing, which is shell
   *  state rather than anything this view knows. */
  reviewSend: ReviewSend;
  /** The cluster is browsing main: staging and committing are disabled with
   *  `READ_ONLY_HINT`. Cosmetic — `git.rs` refuses either way. */
  readOnly?: boolean;
}

// `Selection` and the three rules over it live in `./selection.ts`. They were an
// object literal here, a boolean expression in `Section` and an `if` in the
// stage handler — three places that had to agree about what identifies a row,
// and none of them reachable by a test. The runner has no DOM and cannot press
// a button (STANDARDS.md §8.3), but it can hold the layer underneath one, and a
// row identity disagreeing with itself is exactly how a click sets state and
// the pane draws nothing.

export default function SourceControlView({
  control,
  clusterId,
  git,
  review,
  reviewSend,
  readOnly = false,
}: SourceControlViewProps) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const { status, loading, refresh } = git;

  useEffect(() => {
    setSelected(null);
    setDiff(null);
    setMessage("");
    setFailure(null);
  }, [clusterId]);

  useEffect(() => {
    if (clusterId === null || selected === null) {
      setDiff(null);
      return;
    }

    let live = true;
    control.diff(clusterId, selected.path, selected.staged).then(
      (next) => {
        if (live) setDiff(next);
      },
      (reason: unknown) => {
        if (!live) return;
        setDiff(null);
        setFailure(gitMessage(reason));
      },
    );

    return () => {
      live = false;
    };
  }, [control, clusterId, selected]);

  /**
   * Move one side of the index — for one path, or for a whole section at once.
   *
   * A list rather than a path because `GitControl.stage`/`unstage` have always
   * taken one: staging eight files is one `git add` and one refresh, where a
   * per-file loop would be eight of each and would redraw the list under the
   * user's cursor seven times on the way.
   *
   * The open diff **follows** its row to the other list instead of closing.
   * Closing was the old behaviour, and it cost a second click in the commonest
   * sequence this panel has — read a file's diff, decide to stage it, look at
   * it again. What made closing look necessary is real: a moment later that
   * diff is the wrong side of the index. The answer to that is the other side
   * of the same file, which is precisely where the row went.
   */
  const move = useCallback(
    async (paths: string[], staged: boolean) => {
      if (clusterId === null || busy || paths.length === 0) return;
      setBusy(true);
      setFailure(null);
      try {
        if (staged) await control.unstage(clusterId, paths);
        else await control.stage(clusterId, paths);
        setSelected(followAcrossIndex(selected, paths, staged));
        refresh();
      } catch (reason: unknown) {
        setFailure(gitMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [busy, control, refresh, selected, clusterId],
  );

  const toggle = useCallback(
    (change: GitFileChange) => void move([change.path], change.staged),
    [move],
  );

  const toggleSection = useCallback(
    (changes: GitFileChange[], staged: boolean) =>
      void move(
        changes.map((change) => change.path),
        staged,
      ),
    [move],
  );

  const commit = useCallback(async () => {
    if (clusterId === null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await control.commit(clusterId, message.trim());
      setMessage("");
      setSelected(null);
      refresh();
    } catch (reason: unknown) {
      setFailure(gitMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, control, message, refresh, clusterId]);

  if (clusterId === null) return <EmptyState kind="no-cluster" />;
  if (status === null) {
    // `loading` is what keeps this from flashing between a cluster being
    // selected and its status arriving.
    if (loading) return null;
    return git.error !== null ? (
      <EmptyState kind="error" detail={git.error} />
    ) : (
      <EmptyState kind="not-a-repo" />
    );
  }

  const canCommit = !readOnly && !busy && status.staged.length > 0 && message.trim() !== "";

  return (
    <div className="worktree">
      <BranchRow
        branch={status.branch}
        ahead={status.ahead}
        behind={status.behind}
        count={changeCount(status)}
      />

      {/* The lists and the diff share one flexible box, so that the diff pane's
          height is taken out of the list rather than out of the commit box
          below — see `.worktree__body` in `worktree.css` for the failure that
          shape prevents. */}
      <div className="worktree__body">
        <div className="worktree__lists">
          <Section
            title="Staged Changes"
            changes={status.staged}
            staged
            selected={selected}
            busy={busy}
            readOnly={readOnly}
            onToggle={toggle}
            onToggleAll={toggleSection}
            onSelect={setSelected}
          />
          <Section
            title="Changes"
            changes={status.unstaged}
            staged={false}
            selected={selected}
            busy={busy}
            readOnly={readOnly}
            onToggle={toggle}
            onToggleAll={toggleSection}
            onSelect={setSelected}
          />
          {changeCount(status) === 0 && <div className="worktree__quiet">No changes</div>}
        </div>

        {selected !== null && (
          <div className="worktree__diff">
            <div className="worktree__diff-head">
              {/* Which of the two diffs this is. A path can be in both lists at
                once with different contents on each side, so the header naming
                only the file leaves the two indistinguishable — and the diff
                now follows a row across the index rather than closing, which
                makes the pane change under you without the path changing. */}
              <span className="worktree__diff-side">
                {selected.staged ? "Staged" : "Working tree"}
              </span>
              <span className="worktree__diff-path">{selected.path}</span>
              <button
                type="button"
                className="worktree__diff-close"
                onClick={() => setSelected(null)}
                aria-label="Close diff"
              >
                ×
              </button>
            </div>
            {diff === null ? (
              <div className="worktree__quiet">Loading diff…</div>
            ) : (
              <Suspense fallback={<div className="worktree__quiet">Loading diff…</div>}>
                {/* Inline rather than side by side: see `renderSideBySide` in
                  DiffViewProps for why the panel's width settles this.

                  `language` is TOML or nothing, because that is the entire set
                  `DiffView` can tokenize — its header explains why. Decided
                  here from the path rather than inside it because a path is
                  what this view has; asked of `@veistra/monaco-languages` rather
                  than answered inline because that package owns which
                  extensions its grammar claims, and it is Monaco-free, so
                  importing it does not undo the `lazy` boundary above.

                  `scope` is the pair `selected` already carries. It is part of
                  a note's identity rather than a filter — the same line of the
                  same file is different code staged and unstaged — so the two
                  lists' notes never mix. */}
                <AnnotatedDiff
                  original={diff.original}
                  modified={diff.modified}
                  language={languageIdForPath(selected.path)}
                  renderSideBySide={false}
                  path={selected.path}
                  scope={selected.staged ? "staged" : "unstaged"}
                  clusterId={clusterId}
                  control={review}
                  send={reviewSend}
                />
              </Suspense>
            )}
          </div>
        )}
      </div>

      <div className="worktree__commit">
        {failure !== null && <div className="worktree__error">{failure}</div>}
        <textarea
          className="worktree__commit-box"
          placeholder="Commit message"
          value={message}
          rows={2}
          disabled={busy || readOnly}
          title={readOnly ? READ_ONLY_HINT : undefined}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          type="button"
          className="worktree__commit-btn"
          disabled={!canCommit}
          title={readOnly ? READ_ONLY_HINT : undefined}
          onClick={() => void commit()}
        >
          Commit
        </button>
      </div>
    </div>
  );
}

function changeCount(status: { staged: GitFileChange[]; unstaged: GitFileChange[] }): number {
  return status.staged.length + status.unstaged.length;
}

/** Icon, branch name, its ahead/behind, then the total change count. Zeros are
 *  omitted rather than printed — a branch with no upstream would otherwise
 *  claim to be exactly level with one. */
function BranchRow({
  branch,
  ahead,
  behind,
  count,
}: {
  branch: string;
  ahead: number;
  behind: number;
  count: number;
}) {
  return (
    <div className="worktree__branch">
      <GitBranch size={13} />
      <span className="worktree__branch-name">{branch}</span>
      {(ahead > 0 || behind > 0) && (
        <span className="worktree__branch-track">
          ↑{ahead} ↓{behind}
        </span>
      )}
      <span className="worktree__branch-spacer" />
      <span className="worktree__branch-count">
        {count} {count === 1 ? "change" : "changes"}
      </span>
    </div>
  );
}

/**
 * One list, its header, and the header's own checkbox.
 *
 * **The header checkbox needs no indeterminate state, and that is a property of
 * the data rather than a simplification.** Every row in a section shares the
 * section's side of the index by construction — `git.rs` builds the two lists
 * by splitting each status entry's two letters — so "some of these are staged"
 * cannot arise. The box is therefore checked in Staged Changes and clear in
 * Changes, always, and clicking it moves the whole section across in one call.
 *
 * A checkbox rather than a "Stage All" button because it is the same gesture as
 * the row's, one level up: the row's box means "is this file staged", and this
 * one means the same thing about all of them. A button beside a column of
 * checkboxes would be a second vocabulary for the one action.
 */
function Section({
  title,
  changes,
  staged,
  selected,
  busy,
  readOnly,
  onToggle,
  onToggleAll,
  onSelect,
}: {
  title: string;
  changes: GitFileChange[];
  staged: boolean;
  selected: Selection | null;
  busy: boolean;
  readOnly: boolean;
  onToggle: (change: GitFileChange) => void;
  onToggleAll: (changes: GitFileChange[], staged: boolean) => void;
  onSelect: (selection: Selection) => void;
}) {
  if (changes.length === 0) return null;

  const totals = sumLineCounts(changes);
  const summary = formatLineCounts(totals.insertions, totals.deletions);

  return (
    <div className="worktree__section">
      <div className="worktree__section-head">
        <input
          type="checkbox"
          className="worktree__check worktree__check--all"
          checked={staged}
          disabled={busy || readOnly}
          title={readOnly ? READ_ONLY_HINT : undefined}
          aria-label={`${staged ? "Unstage" : "Stage"} all ${changes.length} ${
            changes.length === 1 ? "change" : "changes"
          }`}
          onChange={() => onToggleAll(changes, staged)}
        />
        <span>{title}</span>
        <span className="worktree__section-count">{changes.length}</span>
        {/* The section's own totals, not `GitStatus`'s: those measure HEAD
            against the working tree in one pass and are deliberately not the
            sum of either list (see `GitFileChange` in `bindings.ts`). */}
        {summary !== null && (
          <span className="worktree__section-delta">
            <span className="worktree__added">{summary.added}</span>
            <span className="worktree__removed">{summary.removed}</span>
          </span>
        )}
      </div>
      {changes.map((change) => (
        <ChangeRow
          key={change.path}
          change={change}
          selected={isRowSelected(selected, change)}
          busy={busy}
          readOnly={readOnly}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/**
 * One changed-file row: a checkbox that is the file's staged-ness, the status
 * letter, the file name, then the directory as its own dimmer column —
 * `GitFileChange` splits `file` and `dir` for exactly this reason, so they are
 * never concatenated back together here.
 *
 * The checkbox and the label are separate controls rather than one row-wide
 * click with a hit-test, because they do genuinely different things: one
 * mutates the index, the other only changes what the diff pane is showing.
 *
 * The `+12 −3` sits last, in its own fixed column, so the counts line up down
 * the list rather than trailing each file name at a different x. A row with no
 * counts — a binary file, an untracked file over the backend's read cap, a
 * conflict — draws nothing there rather than `+0 −0`; see `lineCounts.ts` for
 * why those are different claims.
 */
function ChangeRow({
  change,
  selected,
  busy,
  readOnly,
  onToggle,
  onSelect,
}: {
  change: GitFileChange;
  selected: boolean;
  busy: boolean;
  readOnly: boolean;
  onToggle: (change: GitFileChange) => void;
  onSelect: (selection: Selection) => void;
}) {
  const classes = ["worktree__row"];
  if (selected) classes.push("worktree__row--selected");

  const counts = formatLineCounts(change.insertions, change.deletions);
  const spoken = describeLineCounts(change.insertions, change.deletions);
  const named = change.renamedFrom ? `${change.path} (was ${change.renamedFrom})` : change.path;

  return (
    <div className={classes.join(" ")}>
      <input
        type="checkbox"
        className="worktree__check"
        checked={change.staged}
        disabled={busy || readOnly}
        title={readOnly ? READ_ONLY_HINT : undefined}
        aria-label={change.staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
        onChange={() => onToggle(change)}
      />
      <button
        type="button"
        className="worktree__rowtext"
        title={spoken === null ? named : `${named} — ${spoken}`}
        // Without this a row at either edge of the scrolling list cannot be
        // clicked at all — see `focusWithoutScrolling`.
        onMouseDown={focusWithoutScrolling}
        onClick={() => onSelect(selectionFor(change))}
      >
        <span className="worktree__kind" style={{ color: GIT_KIND_TOKEN[change.kind] }}>
          {GIT_KIND_LETTER[change.kind]}
        </span>
        <span
          className={
            change.kind === "deleted" ? "worktree__file worktree__file--deleted" : "worktree__file"
          }
        >
          {change.file}
        </span>
        <span className="worktree__dir">{change.dir}</span>
        {counts !== null && (
          // No `aria-label` here: a bare span has no role that can take a name,
          // so one would be dropped. The button's `title` above carries the
          // same counts as a sentence, which is where they are actually read.
          <span className="worktree__delta">
            <span className="worktree__added">{counts.added}</span>
            <span className="worktree__removed">{counts.removed}</span>
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * The three ways this panel has nothing to draw. The treatment is the crop's
 * (glyph, title, body — docs/handoffs/shell-spec.html ~lines 234-248); the old
 * "Add worktree" button is gone, because there is no command behind it and it
 * was already rendering inert.
 */
function EmptyState({
  kind,
  detail,
}: {
  kind: "no-cluster" | "not-a-repo" | "error";
  detail?: string;
}) {
  const { title, body } =
    kind === "no-cluster"
      ? {
          title: "No cluster selected",
          body: "Open a project in a cluster to see its source control.",
        }
      : kind === "not-a-repo"
        ? {
            title: "Not a git repository",
            body: "This cluster has no project open, or its project is not a git repository.",
          }
        : { title: "Git unavailable", body: detail ?? "" };

  return (
    <div className="worktree__empty">
      <GitBranch size={28} strokeWidth={1.6} className="worktree__empty-glyph" />
      <div className="worktree__empty-title">{title}</div>
      <div className="worktree__empty-body">{body}</div>
    </div>
  );
}
