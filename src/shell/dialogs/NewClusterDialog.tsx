/**
 * The New Cluster dialog (board 04, "New cluster: where it runs") — the
 * `Ctrl Shift N` / switcher-bar `+` replacement for the old instant
 * "Cluster N" creation. Two steps behind the shared `Dialog` frame:
 *
 * 1. **Environment** — a new local worktree, an existing environment already
 *    in this project, working on main directly, or a cloud session (this
 *    build has none to offer, and says so rather than pretending).
 * 2. **Starting layout** — which pane arrangement the cluster opens with.
 *
 * WindowRoot owns the two things this dialog cannot: the window's `label`
 * and the active cluster's `project`, both handed down as props per this
 * region's usual shape. Everything else — which step, which choice, the
 * worktree name field, the in-flight request — is local state; nothing here
 * is worth lifting because nothing outside this dialog reads it.
 */
import { useEffect, useMemo, useState } from "react";
import Dialog from "./Dialog";
import "./NewClusterDialog.css";
import {
  createClusterWithEnvironment,
  gitDefaultBranch,
  gitRepoState,
  listClusterEnvironments,
  type Environment,
  type EnvironmentChoice,
  type RepoState,
  type StartingLayout,
} from "../../bindings";
import InitGitButton from "../git/InitGitButton";

export interface NewClusterDialogProps {
  /** The window the new cluster is added to. */
  label: string;
  /** The active cluster's project — every choice this dialog offers (the
   *  worktree list, "new local worktree"'s repo, "browse main") is relative
   *  to it. `WindowRoot` only opens this dialog when one is set. */
  project: { name: string; path: string };
  /** Which environment choice is selected on open. The title bar's "New worktree
   *  cluster" asks for `newLocalWorktree` by name rather than relying on it being
   *  the default, so the entry keeps meaning that if the default ever moves. */
  initialKind?: EnvironmentKind;
  onCancel: () => void;
  /** `create_cluster_with_environment` succeeded; the new cluster's id. */
  onCreated: (clusterId: string) => void;
}

export type EnvironmentKind = "newLocalWorktree" | "existing" | "cloud" | "main";

interface LayoutOption {
  value: StartingLayout;
  title: string;
  panes: string;
}

// `panes` is prose, not data the backend reads — but it describes the exact
// tree `starting_layout_preset` builds (`commands.rs`), including the
// `godot-viewer`/`blender-viewer`/`play` ids in its `VIEWER_APPS` table.
// Change one side, change the other.
const LAYOUTS: LayoutOption[] = [
  { value: "code", title: "Code", panes: "Explorer · editor · terminal" },
  { value: "godot", title: "Godot", panes: "Explorer · Godot Editor · Godot Play · terminal" },
  { value: "blender", title: "Blender", panes: "Explorer · Blender · terminal" },
  { value: "watchAgent", title: "Watch an agent", panes: "Streamed terminal · explorer · viewer" },
];

/** One pane of a layout thumbnail: left, top, width, height as percentages. */
type ThumbPane = readonly [number, number, number, number];

// Sketches of the trees `starting_layout_preset` builds, one rectangle per
// pane. The thumbnail is drawn from these; an empty icon box read as broken.
export const LAYOUT_THUMBS: Record<StartingLayout, readonly ThumbPane[]> = {
  code: [
    [0, 0, 28, 100],
    [28, 0, 72, 62],
    [28, 62, 72, 38],
  ],
  godot: [
    [0, 0, 24, 100],
    [24, 0, 46, 62],
    [70, 0, 30, 62],
    [24, 62, 76, 38],
  ],
  blender: [
    [0, 0, 28, 100],
    [28, 0, 72, 62],
    [28, 62, 72, 38],
  ],
  watchAgent: [
    [0, 0, 55, 100],
    [55, 0, 45, 50],
    [55, 50, 45, 50],
  ],
};

export default function NewClusterDialog({
  label,
  project,
  initialKind = "newLocalWorktree",
  onCancel,
  onCreated,
}: NewClusterDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<EnvironmentKind>(initialKind);
  const [worktreeName, setWorktreeName] = useState("");
  const [existing, setExisting] = useState<Environment[] | null>(null);
  const [selectedExisting, setSelectedExisting] = useState<Environment | null>(null);
  const [layout, setLayout] = useState<StartingLayout>("code");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Null until asked. A project that is not ready cannot have a worktree made from it,
  // and says so here instead of failing on submit with a raw git error.
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [repoNonce, setRepoNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([gitRepoState(project.path), gitDefaultBranch(project.path)])
      .then(([state, branch]) => {
        if (!live) return;
        setRepo(state);
        setDefaultBranch(branch);
      })
      .catch(() => {
        if (live) setRepo(null);
      });
    return () => {
      live = false;
    };
  }, [project.path, repoNonce]);

  // Fetched once, up front, rather than only when "Existing environment" is
  // chosen — the taken-name check below needs it the moment someone starts
  // typing a new worktree's name, which can happen before they ever look at
  // the existing-environment list.
  useEffect(() => {
    let live = true;
    void listClusterEnvironments(project.path)
      .then((envs) => {
        if (live) setExisting(envs);
      })
      .catch(() => {
        // Left as "none found" rather than surfacing an error here: the
        // dialog still works with an empty existing-environment list, and
        // the real failure (if this project isn't a git repository at all)
        // resurfaces on submit either way.
        if (live) setExisting([]);
      });
    return () => {
      live = false;
    };
  }, [project.path]);

  const takenWorktreeNames = useMemo(
    () => (existing ?? []).filter(isLocalWorktree).map((e) => e.name),
    [existing],
  );

  const nameProblem =
    kind === "newLocalWorktree" ? validateWorktreeName(worktreeName, takenWorktreeNames) : null;
  const needsRepo = kind === "newLocalWorktree" && repo !== null && repo.state !== "ready";

  const choice = useMemo((): EnvironmentChoice | null => {
    switch (kind) {
      case "newLocalWorktree":
        // No `base`: the backend resolves the default branch itself.
        return nameProblem || needsRepo
          ? null
          : { kind: "newLocalWorktree", name: worktreeName.trim() };
      case "existing":
        return selectedExisting ? { kind: "existing", environment: selectedExisting } : null;
      case "main":
        return { kind: "existing", environment: { kind: "main" } };
      case "cloud":
        // No cloud sessions in this build — see the radio card's own copy.
        // There is nothing this choice could resolve to.
        return null;
    }
  }, [kind, worktreeName, nameProblem, needsRepo, selectedExisting]);

  const canProceed = choice !== null;

  const submit = () => {
    if (!choice || busy) return;
    setBusy(true);
    setFailure(null);
    const name = kind === "newLocalWorktree" ? worktreeName.trim() : "";
    void createClusterWithEnvironment(label, name, project.path, choice, layout)
      .then((clusterId) => onCreated(clusterId))
      .catch((e: unknown) => {
        // Left open, not closed-and-reported — see `WorktreeDialog.tsx`'s
        // identical choice: the field that needs fixing (a taken branch
        // name the client-side check couldn't know about, say) is still
        // there to fix.
        setBusy(false);
        setFailure(describe(e));
      });
  };

  return (
    <Dialog label="New cluster" onCancel={onCancel} className="new-cluster">
      <header className="new-cluster__header">
        <h2 className="new-cluster__title">New cluster</h2>
        <p className="new-cluster__subtitle">
          {step === 1 ? "Choose where this cluster's work runs." : "Choose its starting layout."}
        </p>
      </header>

      {step === 1 ? (
        <EnvironmentStep
          projectName={project.name}
          kind={kind}
          onKind={setKind}
          worktreeName={worktreeName}
          onWorktreeName={setWorktreeName}
          nameProblem={nameProblem}
          repo={repo}
          defaultBranch={defaultBranch}
          projectPath={project.path}
          onRepoChanged={() => setRepoNonce((n) => n + 1)}
          existing={existing}
          selectedExisting={selectedExisting}
          onSelectExisting={setSelectedExisting}
        />
      ) : (
        <LayoutStep layout={layout} onLayout={setLayout} />
      )}

      {failure && <p className="new-cluster__error">{failure}</p>}

      <footer className="new-cluster__footer">
        <p className="new-cluster__note">
          Nothing in Veistra writes to {defaultBranch ?? "the default branch"}. Merges go through
          Git → PR.
        </p>
        <div className="new-cluster__actions">
          {step === 2 && (
            <button
              type="button"
              className="new-cluster__ghost"
              disabled={busy}
              onClick={() => setStep(1)}
            >
              Back
            </button>
          )}
          <button type="button" className="new-cluster__ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {step === 1 ? (
            <button
              type="button"
              className="new-cluster__primary"
              disabled={!canProceed}
              onClick={() => setStep(2)}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="new-cluster__primary"
              disabled={!canProceed || busy}
              onClick={submit}
            >
              {busy ? "Creating…" : submitLabel(kind)}
            </button>
          )}
        </div>
      </footer>
    </Dialog>
  );
}

function submitLabel(kind: EnvironmentKind): string {
  switch (kind) {
    case "newLocalWorktree":
      return "Create worktree and cluster";
    case "existing":
      return "Open cluster";
    case "cloud":
      return "Open cluster";
    case "main":
      return "Work on main";
  }
}

interface EnvironmentStepProps {
  projectName: string;
  kind: EnvironmentKind;
  onKind: (kind: EnvironmentKind) => void;
  worktreeName: string;
  onWorktreeName: (name: string) => void;
  nameProblem: string | null;
  repo: RepoState | null;
  defaultBranch: string | null;
  projectPath: string;
  onRepoChanged: () => void;
  existing: Environment[] | null;
  selectedExisting: Environment | null;
  onSelectExisting: (env: Environment) => void;
}

function EnvironmentStep({
  projectName,
  kind,
  onKind,
  worktreeName,
  onWorktreeName,
  nameProblem,
  repo,
  defaultBranch,
  projectPath,
  onRepoChanged,
  existing,
  selectedExisting,
  onSelectExisting,
}: EnvironmentStepProps) {
  return (
    <div className="new-cluster__environment" role="radiogroup" aria-label="Environment">
      <label className={`new-cluster__card${kind === "newLocalWorktree" ? " is-selected" : ""}`}>
        <input
          type="radio"
          name="environment"
          checked={kind === "newLocalWorktree"}
          onChange={() => onKind("newLocalWorktree")}
        />
        <span className="new-cluster__card-title">New local worktree</span>
        <span className="new-cluster__card-text">
          A fresh checkout of {projectName}, on its own branch. Nothing here touches{" "}
          {defaultBranch ?? "the default branch"}.
        </span>
        {kind === "newLocalWorktree" && (
          <div className="new-cluster__worktree-detail">
            <label className="new-cluster__field-label" htmlFor="new-cluster-name">
              Name
            </label>
            <input
              id="new-cluster-name"
              className="new-cluster__field"
              type="text"
              value={worktreeName}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onWorktreeName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
            <p className="new-cluster__branch-preview">
              Branch: <code>wt/{worktreeName.trim() || "…"}</code> · From{" "}
              <code>{defaultBranch ?? "the default branch"}</code>
            </p>
            {nameProblem && <p className="new-cluster__error">{nameProblem}</p>}
            {repo !== null && repo.state !== "ready" && (
              <div className="new-cluster__repo" onClick={(e) => e.stopPropagation()}>
                <InitGitButton
                  projectPath={projectPath}
                  state={repo}
                  onInitialised={onRepoChanged}
                  className="new-cluster__primary"
                  errorClassName="new-cluster__error"
                />
              </div>
            )}
          </div>
        )}
      </label>

      <label className={`new-cluster__card${kind === "existing" ? " is-selected" : ""}`}>
        <input
          type="radio"
          name="environment"
          checked={kind === "existing"}
          onChange={() => onKind("existing")}
        />
        <span className="new-cluster__card-title">Existing environment</span>
        <span className="new-cluster__card-text">Reopen a worktree already in this project.</span>
        {kind === "existing" && (
          <div className="new-cluster__existing-list" onClick={(e) => e.stopPropagation()}>
            {existing === null ? (
              <p className="new-cluster__empty">Looking…</p>
            ) : existing.length === 0 ? (
              <p className="new-cluster__empty">No other worktrees in this project yet.</p>
            ) : (
              existing.map((env) => (
                <button
                  key={environmentKey(env)}
                  type="button"
                  className={`new-cluster__existing-row${
                    selectedExisting !== null &&
                    environmentKey(selectedExisting) === environmentKey(env)
                      ? " is-selected"
                      : ""
                  }`}
                  onClick={() => onSelectExisting(env)}
                >
                  {environmentLabel(env)}
                </button>
              ))
            )}
          </div>
        )}
      </label>

      <label className={`new-cluster__card${kind === "cloud" ? " is-selected" : ""}`}>
        <input
          type="radio"
          name="environment"
          checked={kind === "cloud"}
          onChange={() => onKind("cloud")}
        />
        <span className="new-cluster__card-title">Cloud session</span>
        <span className="new-cluster__card-text">Runs on a worker VM, not on this machine.</span>
        {kind === "cloud" && <p className="new-cluster__empty">No cloud sessions in this build.</p>}
      </label>

      <label className={`new-cluster__card${kind === "main" ? " is-selected" : ""}`}>
        <input
          type="radio"
          name="environment"
          checked={kind === "main"}
          onChange={() => onKind("main")}
        />
        <span className="new-cluster__card-title">Work on {defaultBranch ?? "main"}</span>
        <span className="new-cluster__card-text">
          Edits land in the main checkout itself, with no branch to merge.
        </span>
      </label>
    </div>
  );
}

interface LayoutStepProps {
  layout: StartingLayout;
  onLayout: (layout: StartingLayout) => void;
}

function LayoutStep({ layout, onLayout }: LayoutStepProps) {
  return (
    <div className="new-cluster__layout" role="radiogroup" aria-label="Starting layout">
      {LAYOUTS.map((option) => (
        <label
          key={option.value}
          className={`new-cluster__layout-row${layout === option.value ? " is-selected" : ""}`}
        >
          <input
            type="radio"
            name="layout"
            checked={layout === option.value}
            onChange={() => onLayout(option.value)}
          />
          <span className="new-cluster__layout-icon" aria-hidden="true">
            {LAYOUT_THUMBS[option.value].map(([x, y, w, h], i) => (
              <span
                key={i}
                className="new-cluster__layout-pane"
                style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
              />
            ))}
          </span>
          <span className="new-cluster__layout-text">
            <span className="new-cluster__layout-title">{option.title}</span>
            <span className="new-cluster__layout-panes">{option.panes}</span>
          </span>
        </label>
      ))}
      <p className="new-cluster__caption">
        You can rearrange panes later. The layout is saved with the cluster.
      </p>
    </div>
  );
}

function isLocalWorktree(env: Environment): env is Extract<Environment, { kind: "localWorktree" }> {
  return env.kind === "localWorktree";
}

/** A stable key for one `existing` row, so React can key the list and a
 *  selection can be compared by identity across a re-render. Mirrors
 *  `environments::Environment::identity` on the Rust side; kept as its own
 *  small function here rather than imported, since the two are read by
 *  different languages for different reasons (React reconciliation here,
 *  live-count dedup there) and have no shared caller to justify one module. */
function environmentKey(env: Environment): string {
  switch (env.kind) {
    case "localWorktree":
      return `worktree:${env.path}`;
    case "design":
      return `design:${env.path}`;
    case "cloud":
      return `cloud:${env.sessionId}`;
    case "main":
      return "main";
  }
}

function environmentLabel(env: Environment): string {
  switch (env.kind) {
    case "localWorktree":
      return env.branch;
    case "design":
      return env.branch;
    case "cloud":
      return env.branch ?? env.vm;
    case "main":
      return "Main";
  }
}

/**
 * Mirrors `git::validate_worktree_name`'s rules closely enough to catch a
 * bad name before it leaves this dialog — the backend is still the
 * authority and re-checks all of this itself in its own words on submit.
 * See `apps/home/ui/src/WorktreeDialog.tsx`'s `validate`, which this is
 * deliberately kept in step with.
 */
function validateWorktreeName(name: string, taken: string[]): string | null {
  const trimmed = name;
  if (trimmed.length === 0) return "A worktree needs a name.";
  if (trimmed.trim() !== trimmed) return "A worktree name cannot start or end with a space.";
  if (trimmed.length > 100) return "A worktree name has to be shorter than 100 characters.";
  if (trimmed.startsWith(".") || trimmed.startsWith("-")) {
    return "A worktree name cannot start with a dot or a dash.";
  }
  if (trimmed.endsWith(".") || trimmed.endsWith(".lock")) {
    return "A worktree name cannot end with a dot, or with “.lock”.";
  }
  if (taken.includes(trimmed)) {
    return `A worktree named "${trimmed}" already exists. Reopen it under Existing environment, or choose another name.`;
  }
  return null;
}

/** `create_cluster_with_environment` rejects with `AppError`'s `Display`
 *  message, serialized as a plain string (see `error.rs`'s `Serialize`
 *  impl) — not a `VeistraRpcError` the way `@veistra/bridge` calls reject,
 *  since this dialog goes through `@tauri-apps/api/core`'s `invoke`
 *  directly via `bindings.ts`, not through the bridge. */
function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
