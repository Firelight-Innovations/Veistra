/**
 * What to tell someone whose project cannot have worktree clusters yet, as plain words.
 * Pure so the dialog and the no-repository notice say the same thing and a test can pin it.
 */
import type { RepoState } from "../../bindings";

export interface RepoPrompt {
  /** The sentence shown. */
  text: string;
  /** Whether "Initialise git repository" can fix it. A repository that already
   *  exists in a parent folder is never initialised again; the user decides there. */
  canInit: boolean;
}

/** `null` when the project is ready, or the state is not known yet. */
export function repoPrompt(state: RepoState | null): RepoPrompt | null {
  if (state === null || state.state === "ready") return null;
  if (state.state === "notARepo") {
    return {
      text: "There is no git repository in this project, and a worktree cluster needs one.",
      canInit: true,
    };
  }
  if (state.nested) {
    return {
      text: `This folder is inside the git repository at ${state.root}, which has no commits yet. Make its first commit there; a second repository is not created inside it.`,
      canInit: false,
    };
  }
  return {
    text: "This project's git repository has no commits yet, and a worktree cluster is forked from one.",
    canInit: true,
  };
}
