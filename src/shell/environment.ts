/**
 * The environment model — display side only. Every cluster is exactly one of
 * a local worktree, a cloud session, the standing design-canvas worktree, or
 * main itself (`docs/VEISTRA-UX-REWORK.md` §1-2). [`environmentOf`]
 * reads `Cluster.environment` when the backend has set it, falling back to
 * the older `worktree`/`project` fields for a cluster that predates it.
 * Every caller goes through it rather than either field directly.
 *
 * This file's `Environment` is a display type, not `bindings.Environment`
 * re-exported — it adds `ahead`/`behind` divergence nothing on the wire fills
 * in yet, and a cloud session's `sessionId`/`vm` for the environment bar.
 *
 * `sameEnvironment` below is the **panes** workstream's own, narrower
 * question, kept on `clusterRoot` rather than on `Environment` — see its own
 * doc comment for why.
 */
import { clusterRoot, type Cluster } from "./contract";
import type { Environment as RustEnvironment } from "../bindings";

export type EnvironmentKind = "worktree" | "cloud" | "main" | "design";

export interface Environment {
  kind: EnvironmentKind;
  /** Absent for `main`, which has no branch of its own. */
  branch?: string;
  /** `main@<hash>`. No source populates this yet; a caller with it separately may merge it in. */
  base?: string;
  /** On-disk path, for a worktree or the design canvas. */
  path?: string;
  /** Commits ahead of / behind `base`. Omitted, not `0` — nothing has
   *  measured it yet. */
  ahead?: number;
  behind?: number;
  /** A cloud session's id and VM name (`RustEnvironment`'s `cloud` variant).
   *  Absent for every other kind. */
  sessionId?: string;
  vm?: string;
}

/**
 * `cluster.environment`'s kind names, translated to this file's own —
 * `localWorktree` is this model's plain `worktree`; the rest already agree.
 * Kept as one table rather than inlined in [`environmentOf`] so the mapping
 * cannot silently drift if either enum grows a variant the other does not.
 */
function fromRustEnvironment(env: RustEnvironment): Environment {
  switch (env.kind) {
    case "localWorktree":
      return { kind: "worktree", branch: env.branch, base: env.base, path: env.path };
    case "cloud":
      return {
        kind: "cloud",
        sessionId: env.sessionId,
        vm: env.vm,
        ...(env.branch !== null && { branch: env.branch }),
      };
    case "main":
      return { kind: "main" };
    case "design":
      return { kind: "design", branch: env.branch, path: env.path };
  }
}

/**
 * The branch name of the standing design-canvas worktree
 * (`docs/VEISTRA-UX-REWORK.md` §5) — a worktree checked out to exactly this
 * branch is the design canvas, independent of `Cluster.pinned`.
 */
export const DESIGN_WORKTREE_BRANCH = "wt/design";

/**
 * A cluster's environment. `cluster.environment` (see the file header) wins
 * when the backend has set it. Otherwise this falls back to the legacy
 * derivation from `worktree`: a worktree on `wt/design` reads as `design`;
 * any other worktree reads as `worktree`; a cluster with no worktree at all
 * is working directly in the project folder, which this model calls `main`
 * and which is written like any worktree. `cloud`
 * cannot come out of the fallback path — nothing in the legacy fields names
 * a cloud session — only out of a real `cluster.environment`.
 */
export function environmentOf(cluster: Cluster): Environment {
  if (cluster.environment) return fromRustEnvironment(cluster.environment);

  const worktree = cluster.worktree;
  if (worktree === null) return { kind: "main" };

  const kind: EnvironmentKind = worktree.branch === DESIGN_WORKTREE_BRANCH ? "design" : "worktree";
  return {
    kind,
    ...(worktree.branch !== null && { branch: worktree.branch }),
    path: worktree.path,
  };
}

/** A stable key for "same environment as that one" — used to count distinct
 *  environments in the title bar's `· N environments` segment. A worktree
 *  path, not a branch, since a branch name is not guaranteed unique. */
export function environmentKey(env: Environment): string {
  if (env.kind === "main") return "main";
  return `${env.kind}:${env.path ?? env.branch ?? ""}`;
}

/**
 * Whether a tab dragged out of `from` may land in `to` (`docs/VEISTRA-UX-
 * REWORK.md` §5). On `clusterRoot`, not [`environmentKey`] — that keys every
 * `main` cluster alike, which is wrong here: two clusters each working
 * directly in a different project share no root and must refuse. A `null`
 * root (nothing opened yet) refuses too, same reason.
 */
export function sameEnvironment(from: Cluster | null, to: Cluster | null): boolean {
  if (from === null || to === null) return false;
  const a = clusterRoot(from);
  const b = clusterRoot(to);
  return a !== null && a === b;
}

/** The kind chip's label, shared by the cluster tab and the environment bar. */
export const ENVIRONMENT_LABEL: Record<EnvironmentKind, string> = {
  worktree: "wt",
  cloud: "cloud",
  main: "main",
  design: "design",
};

/** The environment bar's longer form of the same label. */
export const ENVIRONMENT_BAR_LABEL: Record<EnvironmentKind, string> = {
  worktree: "Local worktree",
  cloud: "Cloud session",
  main: "Main",
  design: "Design canvas",
};

/** The sentence every disabled write affordance carries as its tooltip. The
 *  backend's refusal (`AppError::ReadOnly`) says the same thing. */
export const READ_ONLY_HINT = "This environment is read-only — open a worktree to edit";

/** Whether writes are refused in this environment. Cosmetic: Rust is the
 *  authority (`environments::refuse_read_only_write`), this only stops the UI
 *  offering what will be refused. Main used to be read-only; it is written
 *  like a worktree now, so no environment is, and this mirrors
 *  `Environment::is_read_only` on the Rust side. */
export function isReadOnly(_env: Environment | null): boolean {
  return false;
}
