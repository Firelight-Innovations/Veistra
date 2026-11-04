/**
 * "Reveal in File Explorer" and "Open with the default app": the two ways to
 * hand a file to the OS. Shared by the unsupported page and by previews that
 * show only part of a file (a `.blend`'s thumbnail), where the full thing is
 * one click away in the application that owns it.
 */
import { useState } from "react";
import { describe, openExternal, reveal } from "../rpc";
import "./media.css";

export default function HandoffActions({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);

  const handoff = (method: string, call: (path: string) => Promise<null>) => () => {
    setError(null);
    // Fire and forget: both calls are "the OS now owns this", and neither has a
    // result worth waiting on. Only the failure is worth saying out loud.
    call(path).catch((err: unknown) => setError(describe(method, err)));
  };

  return (
    <>
      <div className="unsupported__actions">
        <button
          type="button"
          className="unsupported__action"
          onClick={handoff("files/reveal", reveal)}
        >
          Reveal in File Explorer
        </button>
        <button
          type="button"
          className="unsupported__action"
          onClick={handoff("files/open-external", openExternal)}
        >
          Open with the default app
        </button>
      </div>
      {error !== null && <p className="app__error">{error}</p>}
    </>
  );
}
