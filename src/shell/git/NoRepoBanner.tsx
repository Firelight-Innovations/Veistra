/**
 * The notice above the panes while the active cluster works directly in a project folder that
 * has no git repository (or no commit) yet. It offers to create one, since source control,
 * worktree clusters and Review all need it. A project with a repository shows nothing: the main
 * checkout is worked in like any worktree, and this used to be the banner calling it read-only.
 */
import { useCallback, useEffect, useState } from "react";
import { gitRepoState, type RepoState } from "../../bindings";
import InitGitButton from "./InitGitButton";
import { repoPrompt } from "./repoPrompt";
import "./noRepoBanner.css";

export interface NoRepoBannerProps {
  projectPath: string;
}

export default function NoRepoBanner({ projectPath }: NoRepoBannerProps) {
  const [state, setState] = useState<RepoState | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void gitRepoState(projectPath)
      .then((s) => live && setState(s))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [projectPath, nonce]);

  if (repoPrompt(state) === null) return null;

  return (
    <div className="repo-banner" role="status" data-testid="no-repo-banner">
      <span className="repo-banner__text">
        <InitGitButton
          projectPath={projectPath}
          state={state}
          onInitialised={refresh}
          className="repo-banner__button"
          errorClassName="repo-banner__error"
        />
      </span>
    </div>
  );
}
