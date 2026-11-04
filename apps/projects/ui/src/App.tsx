import { on, reportPainted } from "@veistra/bridge";
import { WINDOW_RECT_EVENT } from "@veistra/bridge/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TroubleNote, describeFailure } from "../../../shared/trouble";
import { absoluteBounds, isFrameRect, type FrameRect } from "./frameRect";
import { projectUrl } from "./planeRoutes";
import * as rpc from "./rpc";
import type { HostsCheck, ProjectRecord, ProjectsList, WakeSnapshot } from "./rpc";

/** How often `projects/wake-status` is polled while a wake is in flight —
 * fast enough that "Starting Plane… Ns" reads as live, cheap enough that it
 * never competes with the 3 s the backend itself polls at. */
const WAKE_POLL_MS = 1000;

export default function App() {
  const [list, setList] = useState<ProjectsList | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [wake, setWake] = useState<WakeSnapshot>({ phase: "idle" });
  const [hosts, setHosts] = useState<HostsCheck | null>(null);
  const [wakeError, setWakeError] = useState<unknown>(null);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const [frameRect, setFrameRect] = useState<FrameRect | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const openedFor = useRef<string | null>(null);
  // A ref mirror of `frameRect`, read from the `ResizeObserver` callback below
  // so that effect does not need to be torn down and rebuilt every time the
  // shell reports a new one — it only cares about the *latest* value when a
  // local resize happens to fire.
  const frameRectRef = useRef<FrameRect | null>(null);

  // The shell's report of where this app's own iframe sits in the window —
  // see `WINDOW_RECT_EVENT` in `src/shell/toolwindow/ToolWindow.tsx`. Needed
  // because `paneRef`'s `getBoundingClientRect()` is relative to this iframe's
  // own viewport, not the window `add_child`/`set_position` place things in.
  useEffect(
    () =>
      on(WINDOW_RECT_EVENT, (payload) => {
        if (!isFrameRect(payload)) return;
        frameRectRef.current = payload;
        setFrameRect(payload);
      }),
    [],
  );

  const reload = useCallback(() => {
    setListError(null);
    rpc.list().then(setList).catch(setListError);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (list || listError) reportPainted();
  }, [list, listError]);

  // Close the webview behind us rather than leave it pointed at a dead pane —
  // `plane_webview::close` is a no-op if one was never opened.
  useEffect(() => () => void rpc.webviewClose().catch(() => {}), []);

  const project: ProjectRecord | null = useMemo(
    () => list?.projects.find((p) => p.slug === selected) ?? null,
    [list, selected],
  );

  // Poll `projects/wake-status` while a wake is running. `useVisiblePoll`
  // (see `apps/agents/ui`) is the wrong shape here: this is a one-shot flow
  // with its own start/stop, not a continuous refresh the tab should keep
  // alive in the background.
  useEffect(() => {
    if (wake.phase !== "waking") return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await rpc.wakeStatus();
        if (!cancelled) setWake(next);
      } catch {
        // A poll that fails to even reach the backend is not itself a wake
        // failure — leave the last known snapshot in place and try again.
      }
    }, WAKE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wake]);

  // Once healthy, open (or navigate) the webview at this project's issue
  // board. Guarded by `openedFor` so a re-render mid-wake does not re-issue
  // the same open call every poll tick. Also waits on `frameRect`: the shell
  // reports it moments after this iframe mounts, well before a wake finishes,
  // but a call landing before the first report would combine `paneRef` with
  // nothing and place the webview wrong on its very first open.
  useEffect(() => {
    if (wake.phase !== "healthy" || !project || !frameRect) return;
    if (openedFor.current === project.slug) return;
    const local = paneRef.current?.getBoundingClientRect();
    if (!local) return;
    openedFor.current = project.slug;
    const url = projectUrl(project.plane.project_id);
    rpc.webviewOpen(absoluteBounds(frameRect, local), url, frameRect.window).catch((e) => {
      setWebviewError(rpc.messageOf(e));
    });
  }, [wake, project, frameRect]);

  // Track the pane's own rect so a local resize (a split changing, the window
  // itself resizing) keeps the webview lined up. Rust places the webview
  // because its position is a platform property an iframe cannot reach across
  // the process boundary — see `plane_webview`'s module doc.
  useEffect(() => {
    const el = paneRef.current;
    if (!el || wake.phase !== "healthy") return;
    const observer = new ResizeObserver(() => {
      const frame = frameRectRef.current;
      if (!frame) return;
      void rpc.webviewBounds(absoluteBounds(frame, el.getBoundingClientRect())).catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wake.phase]);

  // The other half: a `ResizeObserver` inside this iframe never fires when the
  // iframe itself *moves* without changing size — the terminal band
  // collapsing, for instance, shifts every pane above it but resizes none of
  // them. Only the shell can see that, hence a second trigger keyed on its
  // report rather than on anything measured in here. Skipped until the first
  // open has actually happened, so this never races ahead of `openedFor`.
  useEffect(() => {
    const el = paneRef.current;
    if (!el || wake.phase !== "healthy" || !frameRect || !openedFor.current) return;
    void rpc.webviewBounds(absoluteBounds(frameRect, el.getBoundingClientRect())).catch(() => {});
  }, [frameRect, wake.phase]);

  const select = useCallback(async (record: ProjectRecord) => {
    setSelected(record.slug);
    setWebviewError(null);
    openedFor.current = null;
    setWake({ phase: "idle" });
    setWakeError(null);
    try {
      setHosts(await rpc.hostsCheck());
    } catch {
      setHosts(null);
    }
    try {
      await rpc.wakeStart();
      setWake(await rpc.wakeStatus());
    } catch (e) {
      setWakeError(e);
      setWake({ phase: "failed", detail: rpc.messageOf(e) });
    }
  }, []);

  const cancel = useCallback(() => {
    void rpc.wakeCancel();
  }, []);

  const blocking = !list && listError !== null;
  // A wake fails either at `wake-start` (thrown, such as no gateway URL) or
  // later in the backend's own loop (a `trouble` on the snapshot, such as a
  // lapsed sign-in). Both read as the same states a failed list would.
  const wakeCause =
    wakeError ?? (wake.phase === "failed" && wake.trouble ? { data: wake.trouble } : null);
  const wakeFailure = wake.phase === "failed" ? describeFailure(wakeCause, "Plane") : null;

  return (
    <div className="app">
      <header className="app__head">
        <h1 className="app__title app__title--hidden">Projects</h1>
        {list && (
          <span className="app__sub">
            {list.profile}
            {list.source === "fixture" && <span className="projects__badge">fixture</span>}
          </span>
        )}
        {!list && <span className="app__host">{blocking ? "not connected" : "connecting…"}</span>}
      </header>
      <div className="app__body projects__body">
        {blocking ? (
          <TroubleNote failure={listError} subject="Projects" onRetry={reload} />
        ) : !list ? (
          <p className="app__note">Reading the project list…</p>
        ) : (
          <div className="app__split app__split--stack projects__split">
            <nav className="app__pane" aria-label="Projects">
              <div className="app__scroll">
                {list.problems.map((message) => (
                  <p key={message} className="app__error projects__problem">
                    {message}
                  </p>
                ))}
                {list.projects.length === 0 ? (
                  <p className="app__note">
                    No projects yet. <code>veistra-project</code> writes one to{" "}
                    <code>gs://veistra-projects/{list.profile}/projects/</code> per project.
                  </p>
                ) : (
                  <ul className="app__rows">
                    {list.projects.map((p) => (
                      <li key={p.slug}>
                        <button
                          type="button"
                          className="app__row"
                          aria-current={p.slug === selected}
                          onClick={() => void select(p)}
                        >
                          <span className="app__dot" />
                          <span className="app__name">
                            {p.name}
                            {p.archived && <span className="projects__archived">archived</span>}
                          </span>
                          <span className="app__meta">{p.plane.identifier}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </nav>
            <section className="app__pane projects__plane" aria-label="Plane">
              {!project ? (
                <p className="app__note">Pick a project to open its Plane workspace.</p>
              ) : (
                <>
                  {hosts && !hosts.ok && <p className="app__error projects__fix">{hosts.fix}</p>}
                  {webviewError && <p className="app__error">{webviewError}</p>}
                  <WakeStatus wake={wake} onCancel={cancel} />
                  {wakeFailure && wakeFailure.kind !== "other" && (
                    <h2 className="app__trouble-title">{wakeFailure.heading}</h2>
                  )}
                  {wakeFailure?.steps}
                  {/* The child webview draws over this element — see
                      `plane_webview`'s module doc for why Rust, not this
                      div's own content, is what makes Plane visible here. */}
                  <div ref={paneRef} className="projects__pane-target" />
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function WakeStatus({ wake, onCancel }: { wake: WakeSnapshot; onCancel: () => void }) {
  switch (wake.phase) {
    case "idle":
      return null;
    case "waking":
      return (
        <div className="projects__waking">
          <p className="app__note">
            Starting Plane… {Math.round(wake.elapsedSeconds)}s — {wake.detail}
          </p>
          <button type="button" className="app__up" onClick={onCancel}>
            Cancel
          </button>
        </div>
      );
    case "healthy":
      return null;
    case "cancelled":
      return <p className="app__note">Cancelled.</p>;
    case "timedOut":
      return <p className="app__error">Plane did not come up in time: {wake.detail}</p>;
    case "failed":
      return <p className="app__error">Could not start Plane: {wake.detail}</p>;
  }
}
