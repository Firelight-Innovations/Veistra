/**
 * The one button that gives a project a git repository, with the reason it is needed.
 * Shared by the New Cluster dialog and the no-repository notice so both say the same words.
 */
import { useState } from "react";
import { gitInitProject, type RepoState } from "../../bindings";
import { repoPrompt } from "./repoPrompt";

export interface InitGitButtonProps {
  projectPath: string;
  state: RepoState | null;
  /** Called after the repository exists, so the caller re-reads the state. */
  onInitialised: () => void;
  className?: string;
  errorClassName?: string;
}

export default function InitGitButton({
  projectPath,
  state,
  onInitialised,
  className,
  errorClassName,
}: InitGitButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const prompt = repoPrompt(state);
  if (!prompt) return null;

  const run = () => {
    setBusy(true);
    setFailure(null);
    void gitInitProject(projectPath)
      .then(() => {
        setBusy(false);
        onInitialised();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setFailure(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <>
      <span>{prompt.text}</span>
      {prompt.canInit && (
        <button type="button" className={className} disabled={busy} onClick={run}>
          {busy ? "Initialising…" : "Initialise git repository"}
        </button>
      )}
      {failure && (
        <span role="alert" className={errorClassName}>
          {failure}
        </span>
      )}
    </>
  );
}
