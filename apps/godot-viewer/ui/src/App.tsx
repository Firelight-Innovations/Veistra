/**
 * The Godot app: one pane, two modes (owner decision 1 of the v0.2 design).
 * Editor shows the scene, read-only until the embedded editor arrives; Play
 * runs the game in the pane, records runs as takes and reviews them. The
 * `play` app id is this app opened in Play mode (`modes.ts`).
 *
 * This shell is what loads eagerly; each mode is loaded when it is first
 * shown. The bridge drops an event nobody listens for, and the shell sends
 * the frame's place in the window only when it changes, so the window rect,
 * the overlays and an open's payload are caught here, from the first moment,
 * and handed to whichever mode shows. A mode loaded later, or switched to in
 * place, would otherwise never hear where it is and could not place the game.
 *
 * What both modes read, or what must outlive a switch, lives here too: the
 * Godot status, the project Play chose, and the notes drawn on the live game
 * for the take being recorded, which review folds in later. The status is
 * read again whenever the cluster's project moves: it says whether this is
 * the read-only main checkout, and a move to a worktree changes that.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { OPENED_EVENT, on, session } from "@veistra/bridge";
import { errorText, getStatus, type GodotStatus } from "../../../shared/godot";
import { useShellPlacement } from "../../../shared/useNativeBox";
import { initialMode, MODES, readMode, writeMode, type GodotMode } from "./modes";
import type { LiveNote } from "./play/Review";

const SceneMode = lazy(() => import("./SceneMode"));
const PlayMode = lazy(() => import("./play/PlayMode"));

/**
 * A run for Play to start as soon as it shows: Play scene or F5 in Editor, or
 * an open's payload. With no scene, Play runs what its own F5 would.
 */
export interface RunRequest {
  /** Counts requests, so one is run once however often Play mounts. */
  n: number;
  scene?: string;
  project?: string;
}

/** The scene and project an open asks Play to run, or `null` for any other payload. */
function runPayload(p: unknown): { scene: string; project?: string } | null {
  const { scene, project } = (p ?? {}) as { scene?: unknown; project?: unknown };
  if (typeof scene !== "string" || !scene.startsWith("res://")) return null;
  return { scene, project: typeof project === "string" && project !== "" ? project : undefined };
}

export default function App() {
  /** `null` until the shell has said which pane this is. */
  const [mode, setMode] = useState<GodotMode | null>(null);
  const instance = useRef<string | null>(null);
  const [status, setStatus] = useState<GodotStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [project, setProject] = useState<string | undefined>(undefined);
  const [liveNotes, setLiveNotes] = useState<LiveNote[]>([]);
  const [runRequest, setRunRequest] = useState<RunRequest | null>(null);
  const requests = useRef(0);
  const [epoch, setEpoch] = useState(0);
  const { frameRect, overlays } = useShellPlacement();

  const switchMode = useCallback((next: GodotMode) => {
    setMode(next);
    writeMode(instance.current, next);
  }, []);

  const runInPlay = useCallback(
    (scene: string | undefined, rel?: string) => {
      // A `res://` path means nothing without its project, so the one it came
      // with is the one Play runs it in.
      if (rel !== undefined) setProject(rel);
      requests.current += 1;
      setRunRequest({ n: requests.current, scene, project: rel });
      switchMode("play");
    },
    [switchMode],
  );

  const onRunHandled = useCallback(
    (n: number) => setRunRequest((r) => (r?.n === n ? null : r)),
    [],
  );

  const reloadStatus = useCallback(async (refresh: boolean) => {
    try {
      setStatus(await getStatus(refresh));
      setStatusError(null);
    } catch (e) {
      setStatusError(errorText(e));
    }
  }, []);

  // The saved mode wins over the URL's, so a Play pane reloaded by a cluster
  // switch comes back in Play. An open that arrived first has already chosen.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        instance.current = (await session()).instanceId ?? null;
      } catch {
        // No handshake: nothing to remember the mode by.
      }
      if (!live) return;
      setMode((m) => m ?? readMode(instance.current) ?? initialMode(window.location.search));
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    void reloadStatus(false);
  }, [reloadStatus]);

  // The title bar's switcher, or an agent's `set_project`, can repoint this
  // cluster while the pane is open, from the main checkout to a worktree. The
  // backend works out read-only from the root on every call, so the answer
  // kept from before the move is wrong until it is asked again, and so is
  // whatever each mode read from the old root. The shell relays the event
  // only into frames of the cluster it names.
  useEffect(
    () =>
      on("project:changed", () => {
        setEpoch((e) => e + 1);
        void reloadStatus(false);
      }),
    [reloadStatus],
  );

  // `veistra/open` reaches this pane with a payload: Play scene from another
  // pane, or an agent, asks for a scene in a project. An open of the `play`
  // id with nothing to run still means "show Play".
  useEffect(
    () =>
      on(OPENED_EVENT, (p) => {
        const asked = runPayload(p);
        if (asked) runInPlay(asked.scene, asked.project);
        else if (initialMode(window.location.search) === "play") switchMode("play");
      }),
    [runInPlay, switchMode],
  );

  if (mode === null) return null;
  const modeSwitch = { value: mode, options: MODES, onChange: switchMode };
  const shared = { modeSwitch, status, statusError, reloadStatus, epoch };
  return (
    <Suspense fallback={null}>
      {mode === "play" ? (
        <PlayMode
          {...shared}
          frameRect={frameRect}
          overlays={overlays}
          project={project}
          onProject={setProject}
          liveNotes={liveNotes}
          setLiveNotes={setLiveNotes}
          runRequest={runRequest}
          onRunHandled={onRunHandled}
        />
      ) : (
        <SceneMode {...shared} onPlay={runInPlay} />
      )}
    </Suspense>
  );
}
