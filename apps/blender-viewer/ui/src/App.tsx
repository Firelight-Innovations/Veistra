/**
 * The Blender app, in three modes (`modes.ts`). Editor is Blender itself in the
 * pane (`editor/EditorMode.tsx`, #317) wherever the backend says it can open
 * (`blender-viewer/state`'s `editor`, `editorSurface.ts`); on main, in a cloud
 * session or with no Blender it is the read-only viewer of the last export.
 * Renders is what an export made: the preview renders, the `.glb` in 3D, the
 * wireframe pass and the parts list, with comments and markup. Compare is what
 * changed between two kept versions (`compare/CompareMode.tsx`, #319), loaded
 * lazily; it cannot be chosen until the file has two.
 *
 * The header is the shared `ViewerToolbar`, so it reads like Godot Editor and
 * Play: the environment and file, freshness, actions, leave; the backend's
 * reason is one line under it.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { reportPainted } from "@veistra/bridge";
import {
  Box,
  Copy,
  List,
  ExternalLink,
  MessageSquarePlus,
  Package,
  PenLine,
  RefreshCw,
  Square,
} from "lucide-react";
import { EditorReason } from "../../../shared/EditorReason";
import { canLaunch, editorBody, type EditorBuilt } from "../../../shared/editorSurface";
import { MarkupButton, type MarkupTrigger } from "../../../shared/MarkupTrigger";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  verdictComment,
  type Comment,
} from "../../../shared/comments";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { SendButton, SendFooter, useSendAction } from "../../../shared/SendFooter";
import { ToolbarButton, ToolbarEnvChip, ViewerToolbar } from "../../../shared/ViewerToolbar";
import { useShellPlacement } from "../../../shared/useNativeBox";
import { openEditor } from "./editor/rpc";
import {
  cancelExport,
  detectBlender,
  getImage,
  getState,
  loadMarkup,
  setExecutable,
  startExport,
  type BlenderPart,
  type BlenderViewerState,
} from "./rpc";
import ModelPreview from "./ModelPreview";
import EditorMode from "./editor/EditorMode";
import { EXPORT_VIEWS, modesFor, viewFor, type BlenderMode, type ExportView } from "./modes";
import { exportChip, hasExport } from "./chip";
import { footerIsCompact } from "./layout";
import { reconcileBlend, selectionWasDropped } from "./selection";
import {
  dragContext,
  keepMarkup,
  partSummary,
  putGlb,
  putMarkup,
  putParts,
  putRender,
} from "./context";
import { useMarkup } from "../../../shared/useMarkup";
import { AUTO_SEND_KEY, BLENDER_TARGET, TIP_KEY } from "../../../shared/markupFlow";
import { MarkupBar, MarkupTip, PreviousMarkup } from "../../../shared/MarkupPanels";
import "./App.css";

const CompareMode = lazy(() => import("./compare/CompareMode"));

/**
 * Which Editor surfaces this app draws besides the viewer. Both are
 * `EditorMode`: Blender in the pane, or the same Blender in its own window.
 */
const EDITOR_BUILT: EditorBuilt = { embedded: true, popOut: true };

/** The viewer in Editor mode keeps to the model; Renders adds the stills. */
const VIEWER_VIEWS = EXPORT_VIEWS.filter((v) => v.value !== "stills");

const AUTO_KEY = "blender-viewer.auto-export";
const POLL_IDLE_MS = 3000;
const POLL_RUNNING_MS = 700;

/** Best-effort: private windows and blocked storage throw. */
function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A footer button whose label never wraps. In a narrow pane it keeps only its
 * icon; the label moves to the tooltip and the accessible name.
 */
function FooterAction(props: {
  label: string;
  icon: ReactNode;
  compact: boolean;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const hint = props.title ? `${props.label}. ${props.title}` : props.label;
  return (
    <button
      type="button"
      className={`bv__footer-btn${props.compact ? " bv__footer-btn--icon" : ""}`}
      aria-label={props.compact ? props.label : undefined}
      title={props.compact ? hint : props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      onPointerDown={props.onPointerDown}
    >
      {props.icon}
      {!props.compact && props.label}
    </button>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function App() {
  const [mode, setMode] = useState<BlenderMode>("editor");
  const [view, setView] = useState<ExportView>(viewFor("editor"));
  const { frameRect, overlays } = useShellPlacement();
  const [state, setState] = useState<BlenderViewerState | null>(null);
  const [blend, setBlend] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [auto, setAuto] = useState(readAuto);
  const [pathDraft, setPathDraft] = useState("");
  const [selected, setSelected] = useState<BlenderPart | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [trigger, setTrigger] = useState<MarkupTrigger | null>(null);
  /** B as the Editor banner's "Compare with v<n>" asked for it. */
  const [compareB, setCompareB] = useState<number | null>(null);
  const autoStartedFor = useRef<number | null>(null);
  const lastSeenMtime = useRef<number | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);

  useEffect(() => {
    if (!root) return;
    setPaneWidth(root.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setPaneWidth(box.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [root]);
  const compact = footerIsCompact(paneWidth);

  const refreshComments = useCallback(async () => {
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      setComments(await listComments());
    } catch {
      setCommentsError("Couldn't load comments.");
    } finally {
      setCommentsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getState(blend);
      setState(next);
      // The host answers with the file it resolved. After a project switch the
      // old path no longer resolves, so drop it and everything hung off it.
      if (selectionWasDropped(blend, next)) {
        setSelected(null);
        setError(null);
      }
      setBlend((current) => reconcileBlend(current, next));
    } catch (err) {
      setError(message(err));
    }
  }, [blend]);

  // One poll, faster while an export runs. State is a stat and a JSON read, so
  // this is also what notices a `.blend` saved outside this app.
  const running = state?.job.running ?? false;
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, running]);

  useEffect(() => {
    void refreshComments();
    reportPainted();
  }, [refreshComments]);

  // Renders arrive as base64 over the bridge, one call each, only when the
  // export they belong to changes.
  const exportedAt = state?.exportedAt;
  const renderIds = state?.renders.map((r) => r.id).join(",") ?? "";
  useEffect(() => {
    const target = state?.blend;
    if (!target || !renderIds) {
      setImages({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const id of renderIds.split(",")) {
        try {
          const img = await getImage(target, id);
          next[id] = `data:${img.mime};base64,${img.base64}`;
        } catch {
          // A missing image leaves its tile in the "unavailable" state.
        }
      }
      if (!cancelled) setImages(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [state?.blend, exportedAt, renderIds]);

  const runExport = useCallback(async () => {
    if (!blend) return;
    setError(null);
    try {
      await startExport(blend);
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  }, [blend, refresh]);

  // Re-export when the .blend has changed and stopped changing: the mtime must
  // match the previous poll's, so a save in progress is not exported half-done.
  useEffect(() => {
    if (!state) return;
    const mtime = state.blendMtime ?? null;
    const settled = mtime !== null && mtime === lastSeenMtime.current;
    lastSeenMtime.current = mtime;
    if (
      auto &&
      state.stale &&
      settled &&
      !state.job.running &&
      state.blender.found &&
      autoStartedFor.current !== mtime
    ) {
      autoStartedFor.current = mtime;
      void runExport();
    }
  }, [state, auto, runExport]);

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      // Not persisted; still applies for this session.
    }
  };

  // Every comment not yet resolved, as the panel and Play count them: one an
  // agent is working on, or has fixed and left for the person to check, still
  // waits on someone.
  const openCount = useMemo(
    () => comments.filter((c) => c.status !== "resolved").length,
    [comments],
  );

  const postComment = async () => {
    if (!selected || !draft.trim()) return;
    setPosting(true);
    try {
      await createComment({
        // The file and the version it was made on, so Compare can find the
        // notes from A (#319).
        anchor: {
          kind: "mesh",
          part: selected.name,
          material: selected.materials[0] ?? "none",
          ...(state?.rel ? { blend: state.rel } : {}),
          ...(state?.version ? { version: state.version.n } : {}),
        },
        body: draft.trim(),
      });
      setDraft("");
      await refreshComments();
      setCommentsOpen(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setPosting(false);
    }
  };

  const copyGlb = async () => {
    if (!state?.model) return;
    try {
      await navigator.clipboard.writeText(state.model);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy to the clipboard.");
    }
  };

  const { sent, send } = useSendAction(setError, message);

  // The kept markup is per `.blend`: it is saved with the export cache and
  // brought back when the file is shown again. `rel` names it in the strip.
  const {
    markup,
    barOpen,
    setBarOpen,
    previousOpen,
    setPreviousOpen,
    tip,
    closeTip,
    onMarkup,
    sendKept: sendMarkup,
    flip,
  } = useMarkup({
    target: BLENDER_TARGET,
    subject: state?.rel ?? null,
    enabled: !!state?.model,
    load: () => (blend ? loadMarkup(blend) : Promise.resolve(null)),
    save: (_rel, png, json) => (blend ? keepMarkup(png, json, blend) : Promise.resolve()),
    send,
    onProblem: setError,
    describeError: message,
  });

  // A render is already in memory as a data URL; the bytes cross the bridge once.
  const renderPut = (id: string, label: string) => () => {
    const url = images[id];
    if (!url) return Promise.reject(new Error("the render has not loaded"));
    return putRender(url.slice(url.indexOf(",") + 1), label, state?.rel ?? null, id);
  };

  const saveExecutable = async () => {
    setError(null);
    try {
      await setExecutable(pathDraft);
      setPathDraft("");
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };

  // Each mode opens on its own view; a mode drawn disabled is never chosen.
  const modes = modesFor(state?.versions.length ?? 0);
  const switchMode = (next: BlenderMode) => {
    if (modes.find((m) => m.value === next)?.disabled) return;
    if (next === "compare") setCompareB(null);
    setMode(next);
    setView(viewFor(next));
  };
  const modeSwitch = { value: mode, options: modes, onChange: switchMode };

  if (!state) {
    return (
      <div className="bv" ref={setRoot}>
        <p className="bv__hint">{error ?? "Loading…"}</p>
      </div>
    );
  }

  if (mode === "compare") {
    return (
      <Suspense fallback={<p className="bv__hint">Loading Compare…</p>}>
        <CompareMode
          modeSwitch={modeSwitch}
          viewer={state}
          initialB={compareB}
          comments={comments}
          onCommentsChanged={refreshComments}
          onOpenBlend={async (path) => {
            await openEditor(path);
            switchMode("editor");
          }}
        />
      </Suspense>
    );
  }

  // Editor mode is Blender wherever the backend says it can open; the viewer
  // below is what it falls back to, and what Renders always is.
  if (mode === "editor" && editorBody(state.editor, EDITOR_BUILT) !== "viewer") {
    return (
      <EditorMode
        modeSwitch={modeSwitch}
        viewer={state}
        onPick={setBlend}
        frameRect={frameRect}
        overlays={overlays}
        onCompare={(n) => {
          setCompareB(n);
          setMode("compare");
        }}
      />
    );
  }

  // Open is a press here too: it starts Blender on this file, holding its
  // lock, and Editor mode then shows it.
  const openHere = () => {
    if (!state.rel) return;
    setError(null);
    openEditor(state.rel)
      .then(() => switchMode("editor"))
      .catch((err: unknown) => setError(message(err)));
  };

  const job = state.job;
  const exported = hasExport(state);
  const wire = state.renders.find((r) => r.id === "wire");
  const hero =
    state.renders.find((r) => r.id === "three-quarter") ??
    state.renders.find((r) => r.id !== "wire") ??
    null;
  const jobIsForThis = job.blend !== null && job.blend === state.rel;
  const surface = state.editor ?? null;
  const launchable = canLaunch(surface);
  const showModel = exported && view === "3d";
  const showJob = job.running || (jobIsForThis && job.outcome !== null && job.outcome !== "ok");

  return (
    <div className="bv" ref={setRoot}>
      {/* Export, Auto and Copy .glb path stay in the footer beside the sends
          they feed. Mark up is in slot 4: the lazy 3D view reports how to
          start drawing, and why not when the export is stale. */}
      <ViewerToolbar
        label="Blender"
        mode={modeSwitch}
        subject={
          <>
            <ToolbarEnvChip kind={state.environment?.kind} branch={state.environment?.branch} />
            {state.blends.length > 1 ? (
              <select
                className="k-vtb__select"
                aria-label=".blend file"
                value={blend ?? ""}
                onChange={(e) => {
                  setBlend(e.target.value);
                  setSelected(null);
                }}
              >
                {state.blends.map((b) => (
                  <option key={b.path} value={b.path}>
                    {b.rel}
                  </option>
                ))}
              </select>
            ) : (
              state.rel && <span className="bv__file">{state.rel}</span>
            )}
          </>
        }
        status={exportChip(state)}
        actions={
          exported ? (
            <>
              {view === "3d" && <MarkupButton trigger={showModel ? trigger : null} />}
              <SegmentedControl
                aria-label="Export view"
                value={view}
                onChange={setView}
                options={mode === "renders" ? EXPORT_VIEWS : VIEWER_VIEWS}
              />
            </>
          ) : null
        }
        leave={
          <ToolbarButton
            icon={<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />}
            label="Open in Blender"
            disabled={!state.rel || !launchable}
            title={
              launchable
                ? `Open ${state.rel ?? "the file"} in Blender ${state.blender.version ?? ""}, in Editor mode`
                : (surface?.reason ?? "Blender was not found — set it up first")
            }
            onClick={openHere}
          />
        }
      />

      {/* No Blender has its own setup panel below, with the path field, so the
          line is for the other reasons: main, a cloud session, a pop out. */}
      {surface?.code !== "noEditor" && (
        <EditorReason surface={surface} tool="blender" onError={setError} />
      )}

      {!state.blender.found && (
        <section className="bv__setup" aria-label="Blender not found">
          <p>
            <strong>Blender was not found.</strong>{" "}
            {state.blender.configuredMissing
              ? "The path in Settings points at nothing. "
              : "Looked in the BLENDER variable, PATH, Program Files and Steam. "}
            Point this at <code>blender.exe</code> (or its folder) to export and open files. Blender
            4.x or 5.x is expected.
          </p>
          <div className="bv__setup-row">
            <input
              className="k-field__input k-field__input--mono"
              placeholder="C:\Program Files\Blender Foundation\Blender 4.2\blender.exe"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              aria-label="Blender executable path"
            />
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              disabled={!pathDraft.trim()}
              onClick={saveExecutable}
            >
              Use this
            </button>
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              onClick={() => void detectBlender().then(refresh)}
            >
              Detect again
            </button>
          </div>
        </section>
      )}
      {state.blender.found && !state.blender.supported && (
        <p className="bv__notice">
          Blender {state.blender.version ?? "of unknown version"} found; the export is written for
          4.x and 5.x and may not work on this one.
        </p>
      )}
      {error && (
        <p className="bv__error" role="alert">
          {error}
        </p>
      )}

      {showJob && (
        <section className="bv__job" aria-label="Export">
          <div className="bv__job-head">
            <span>
              {job.running
                ? `Exporting ${job.blend ?? ""} — ${job.label || "starting"} (${job.step}/${job.total || "?"})`
                : job.outcome === "cancelled"
                  ? "Export cancelled. The previous export is unchanged."
                  : "Export failed. The previous export is unchanged."}
            </span>
          </div>
          {job.running && (
            <div className="bv__progress" aria-hidden="true">
              <div
                className="bv__progress-bar"
                style={{ width: `${job.total ? (job.step / job.total) * 100 : 5}%` }}
              />
            </div>
          )}
          {job.error && <pre className="bv__error-text">{job.error}</pre>}
          {job.log.length > 0 && (
            <details>
              <summary>Blender log ({job.log.length} lines)</summary>
              <pre className="bv__log">{job.log.join("\n")}</pre>
            </details>
          )}
        </section>
      )}

      <div className="bv__body">
        {!state.project ? (
          <p className="bv__hint bv__empty">Open a project to look for .blend files.</p>
        ) : state.blends.length === 0 ? (
          <p className="bv__hint bv__empty">
            No <code>.blend</code> files in this environment. Save one here and it will appear.
          </p>
        ) : !exported ? (
          <div className="bv__empty bv__empty--export">
            <p className="bv__hint">
              <code>{state.rel}</code> has not been exported yet.
              {state.blender.found
                ? " Export runs Blender headless and shows the 3D model, the renders and the parts list here."
                : " Set up Blender above, then export."}
            </p>
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              disabled={!blend || !state.blender.found || job.running}
              onClick={runExport}
            >
              <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />
              Export
            </button>
          </div>
        ) : view === "stills" ? (
          <main className="bv__renders">
            <div className="bv__renders-strip">
              {state.renders.map((r) => (
                <figure key={r.id} className="bv__render-tile">
                  {images[r.id] ? (
                    <img
                      src={images[r.id]}
                      alt={r.label}
                      draggable={false}
                      title="Drag onto a terminal to send to the agent"
                      onPointerDown={dragContext(renderPut(r.id, r.label))}
                    />
                  ) : (
                    <span className="bv__render-tile-hint">loading…</span>
                  )}
                  <figcaption>
                    {r.label}
                    {images[r.id] && (
                      <button
                        type="button"
                        className="bv__send"
                        onClick={() => void send(r.label, r.label, renderPut(r.id, r.label))}
                      >
                        {sent === r.label ? "Sent" : "Send to agent"}
                      </button>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          </main>
        ) : view === "wire" ? (
          <main className="bv__viewport">
            {wire && images.wire ? (
              <figure className="bv__hero">
                <img src={images.wire} alt="wireframe" />
                <figcaption>wire</figcaption>
              </figure>
            ) : (
              <p className="bv__hint">This export has no wireframe pass.</p>
            )}
          </main>
        ) : (
          <main className="bv__viewport bv__viewport--model">
            <div className="bv__model">
              <ModelPreview
                blend={state.blend ?? blend ?? ""}
                rel={state.rel}
                model={state.model}
                exportedAt={state.exportedAt}
                blenderVersion={state.blenderVersion}
                stale={state.stale === true}
                parts={state.parts}
                selected={selected?.name ?? null}
                onSelect={(name) => setSelected(state.parts.find((p) => p.name === name) ?? null)}
                onMarkup={onMarkup}
                onNotice={setError}
                onTrigger={setTrigger}
                canExport={state.blender.found && !job.running}
                onExport={runExport}
                fallback={
                  hero && images[hero.id] ? (
                    <figure className="bv__hero">
                      <img src={images[hero.id]} alt={hero.label} />
                      <figcaption>{hero.label}</figcaption>
                    </figure>
                  ) : null
                }
              >
                {markup && (
                  <MarkupBar
                    url={markup.url}
                    json={markup.json}
                    fresh={markup.fresh}
                    open={barOpen}
                    onOpenChange={setBarOpen}
                    onView={() => setPreviousOpen(true)}
                    onPointerDown={dragContext(() => putMarkup(markup.png, markup.json, state.rel))}
                  />
                )}
              </ModelPreview>
              <dl className="bv__facts">
                <dt>.glb</dt>
                <dd>
                  {state.model ? (
                    <>
                      <code>{state.model}</code>
                      {state.glbBytes ? ` · ${formatBytes(state.glbBytes)}` : ""}
                    </>
                  ) : (
                    "not exported — the scene has no visible meshes, or the glTF add-on is off"
                  )}
                </dd>
                {state.stats && (
                  <>
                    <dt>Scene</dt>
                    <dd>
                      {state.stats.objects ?? 0} objects · {state.stats.meshes ?? 0} meshes ·{" "}
                      {state.stats.instances ? `${state.stats.instances} instances · ` : ""}
                      {state.stats.materials ?? 0} materials ·{" "}
                      {(state.stats.tris ?? 0).toLocaleString()} triangles
                    </dd>
                  </>
                )}
                <dt>Made with</dt>
                <dd>
                  Blender {state.blenderVersion}, {state.engine} at {state.resolution}px
                </dd>
              </dl>
              {state.warnings && state.warnings.length > 0 && (
                <ul className="bv__warnings">
                  {state.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </main>
        )}

        {state.project && state.blends.length > 0 && exported && view !== "stills" && (
          <aside className="bv__parts">
            <div className="bv__parts-heading">
              <Package size={13} strokeWidth={1.5} aria-hidden="true" />
              Parts ({state.parts.length})
            </div>
            {state.parts.length === 0 ? (
              <p className="bv__hint">No objects in this scene.</p>
            ) : (
              <div className="bv__parts-list">
                {state.parts.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className={`bv__part-row${selected?.name === p.name ? " bv__part-row--selected" : ""}${p.kind !== "mesh" && p.kind !== "instance" ? " bv__part-row--other" : ""}`}
                    onClick={() => setSelected(p)}
                  >
                    <span className="bv__part-name">{p.name}</span>
                    <span className="bv__part-material">{partSummary(p)}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        )}

        {previousOpen && markup && (
          <PreviousMarkup
            url={markup.url}
            json={markup.json}
            savedAt={markup.savedAt}
            onClose={() => setPreviousOpen(false)}
          />
        )}
        {tip && (
          <MarkupTip
            onEnable={() => flip(AUTO_SEND_KEY, true)}
            onNever={() => flip(TIP_KEY, false)}
            onClose={closeTip}
          />
        )}

        {selected && (
          <div className="bv__composer">
            <div className="bv__composer-target">
              <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
              Comment on <code>{selected.name}</code> · {selected.materials[0] ?? "no material"}
            </div>
            <textarea
              className="bv__composer-input"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What should change about this part?"
            />
            <div className="bv__composer-actions">
              <button type="button" onClick={() => setSelected(null)} disabled={posting}>
                Cancel
              </button>
              <button
                type="button"
                className="bv__composer-submit"
                onClick={postComment}
                disabled={posting || !draft.trim() || state.readOnly}
                title={
                  state.readOnly
                    ? "Comments are kept in the checkout, and main is read-only. Open a worktree to comment."
                    : undefined
                }
              >
                {posting ? "Posting…" : "Comment"}
              </button>
            </div>
          </div>
        )}

        {commentsOpen && (
          <CommentPanel
            comments={comments}
            loading={commentsLoading}
            error={commentsError}
            onResolve={async (id, note) => {
              await resolveComment(id, note);
              await refreshComments();
            }}
            onVerdict={async (id, verdict, reply) => {
              await verdictComment(id, verdict, reply);
              await refreshComments();
            }}
            emptyHint="No comments on this model yet. Select a part and leave one."
          />
        )}
      </div>

      <SendFooter
        trailing={
          <>
            {job.running ? (
              <button
                type="button"
                className="bv__footer-btn"
                onClick={() => void cancelExport().then(refresh)}
              >
                <Square size={13} strokeWidth={1.5} aria-hidden="true" />
                Cancel export
              </button>
            ) : (
              <button
                type="button"
                className="bv__footer-btn"
                disabled={!blend || !state.blender.found}
                onClick={runExport}
                title={
                  state.blender.found
                    ? "Run Blender headless on this file"
                    : "Blender was not found — set it up first"
                }
              >
                <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />
                {exported ? "Re-export" : "Export"}
              </button>
            )}
            <label className="bv__auto" title="Re-export when the .blend is saved">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => toggleAuto(e.target.checked)}
              />
              Auto
            </label>
            <FooterAction
              label={`Comments${openCount > 0 ? ` · ${openCount} open` : ""}`}
              icon={<MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />}
              compact={compact}
              onClick={() => setCommentsOpen((v) => !v)}
            />
            {state.model && (
              <FooterAction
                label={copied ? "Copied" : "Copy .glb path"}
                icon={<Copy size={13} strokeWidth={1.5} aria-hidden="true" />}
                compact={compact}
                onClick={copyGlb}
              />
            )}
          </>
        }
      >
        {state.parts.length > 0 && (
          <SendButton
            label="Send parts"
            sent={sent === "parts"}
            icon={<List size={13} strokeWidth={1.5} aria-hidden="true" />}
            compact={compact}
            title="Add the parts list to the agent's context. Drag to a terminal to send it."
            onPointerDown={dragContext(() => putParts(state))}
            onClick={() => void send("parts", "parts", () => putParts(state))}
          />
        )}
        {view === "3d" && markup && (
          <SendButton
            label="Send markup"
            sent={sent === "markup"}
            icon={<PenLine size={13} strokeWidth={1.5} aria-hidden="true" />}
            compact={compact}
            title="Send the markup you drew to the agent, or drag this onto a terminal"
            onPointerDown={dragContext(() => putMarkup(markup.png, markup.json, state.rel))}
            onClick={() => void sendMarkup()}
          />
        )}
        {state.model && (
          <SendButton
            label="Send .glb"
            sent={sent === ".glb"}
            icon={<Box size={13} strokeWidth={1.5} aria-hidden="true" />}
            compact={compact}
            title="Add the .glb to the agent's context. Drag to a terminal to send it."
            onPointerDown={dragContext(() => putGlb(state))}
            onClick={() => void send(".glb", ".glb", () => putGlb(state))}
          />
        )}
      </SendFooter>
    </div>
  );
}
