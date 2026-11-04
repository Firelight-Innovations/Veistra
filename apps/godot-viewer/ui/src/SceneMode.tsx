/**
 * The Godot Viewer: a scene's node tree beside a 3D view or its last rendered
 * frame, read-only. The header is the shared `ViewerToolbar`, so Scene reads
 * like Play and the Blender viewer: mode, scene, freshness, actions, leave.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openIn, reportPainted } from "@veistra/bridge";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderTree,
  Image as ImageIcon,
  MessageSquarePlus,
  Play as PlayIcon,
  RefreshCw,
} from "lucide-react";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  verdictComment,
  type Comment,
} from "../../../shared/comments";
import { formatRenderAge } from "../../../shared/age";
import { errorText, getStatus, openInGodot, type GodotStatus } from "../../../shared/godot";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { SendButton, SendFooter, useSendAction } from "../../../shared/SendFooter";
import { ToolbarButton, ViewerToolbar } from "../../../shared/ViewerToolbar";
import {
  getImage,
  getState,
  loadMarkup,
  refresh,
  type GodotNode,
  type GodotViewerState,
} from "./rpc";
import { sampleState } from "./fixtures";
import { dragContext, keepMarkup, putFrame, putMarkup, putTree } from "./context";
import { useMarkup } from "../../../shared/useMarkup";
import { AUTO_SEND_KEY, GODOT_TARGET, TIP_KEY } from "../../../shared/markupFlow";
import { MarkupBar, MarkupTip, PreviousMarkup } from "../../../shared/MarkupPanels";
import { nodeLookup } from "./preview";
import { usePreview, type PreviewState } from "./usePreview";
import { sceneChip } from "./chip";
import { openNotesByNode } from "./notes";
import "./SceneMode.css";

/**
 * three.js and Excalidraw live behind this import and nowhere else, so the
 * viewer's first paint does not pay for them (the Godot Viewer is the app
 * people open to read a tree; 3D is one tab of it).
 */
const Scene3D = lazy(() => import("./Scene3D"));

type Mode = "scene" | "play";
type View = "3d" | "render";

const MODES: readonly { value: Mode; label: string }[] = [
  { value: "scene", label: "Scene" },
  { value: "play", label: "Play" },
];

const VIEWS: readonly { value: View; label: string }[] = [
  { value: "3d", label: "3D" },
  { value: "render", label: "Render" },
];

const POLL_MS = 600;

export default function SceneMode() {
  const [mode, setMode] = useState<Mode>("scene");
  const [state, setState] = useState<GodotViewerState | null>(null);
  const [scene, setScene] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<GodotStatus | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [view, setView] = useState<View>("3d");
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

  const load = useCallback(async () => {
    try {
      const s = await getState(scene);
      setState(s);
      setProblem(null);
      setImage(s.imageAt === null ? null : (await getImage(s.scene ?? undefined)).png);
    } catch (e) {
      setProblem(errorText(e));
    }
  }, [scene]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getStatus(false)
      .then(setStatus)
      .catch(() => setStatus(null));
    void refreshComments();
    reportPainted();
  }, [refreshComments]);

  // While a refresh runs, poll for its phase; when it stops, load the result.
  const jobRunning = state?.job?.running === true;
  useEffect(() => {
    if (!jobRunning) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [jobRunning, load]);

  const wants3d =
    mode === "scene" &&
    view === "3d" &&
    !preview &&
    state !== null &&
    state.engineFound &&
    state.scenes.length > 0;
  const p3d = usePreview(state?.scene ?? undefined, wants3d);
  const recheck3d = p3d.load;
  const lookup = useMemo(
    () => (p3d.state.kind === "ready" ? nodeLookup(p3d.state.data.nodeMap) : null),
    [p3d.state],
  );

  // A refresh that just finished may have been prompted by an edit to the
  // scene; ask again. An unchanged scene answers from cache and keeps the view.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !jobRunning && wants3d) recheck3d(false, true);
    wasRunning.current = jobRunning;
  }, [jobRunning, wants3d, recheck3d]);

  const startRefresh = async (render: boolean) => {
    setProblem(null);
    try {
      await refresh(state?.scene ?? scene, render);
      await load();
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  const shown = preview ? sampleState : state;
  const nodes = shown?.nodes ?? [];
  const found = status?.executable.found ?? null;
  const readOnly = status?.environment.readOnly ?? false;
  // Every comment not yet resolved, as the panel and Play count them: one an
  // agent is working on, or has fixed and left for the person to check, still
  // waits on someone.
  const openCount = useMemo(
    () => comments.filter((c) => c.status !== "resolved").length,
    [comments],
  );
  const notes = useMemo(() => openNotesByNode(comments), [comments]);
  const job = preview ? null : (state?.job ?? null);
  const busy = job?.running === true;
  const noScenes = !preview && state !== null && state.scenes.length === 0;
  const playable = !preview && !noScenes && !!state?.scene;

  // `openIn` is the bridge's `veistra/open` (docs/tool-protocol.md §3). Play is
  // opened, or brought forward, in this cluster and receives `{ scene, project }`
  // as the payload of `OPENED_EVENT` (`answerOpen` in
  // `src/shell/toolwindow/ToolWindow.tsx`), and runs that scene in that project.
  // The project goes with the scene because a `res://` path means nothing on
  // its own: Play's picker may be on another of the environment's projects.
  const playScene = () => {
    if (!state?.scene) return;
    setProblem(null);
    openIn("play", { scene: state.scene, project: state.project }).catch((e: unknown) =>
      setProblem(errorText(e)),
    );
  };

  const { sent, send } = useSendAction(setProblem, errorText);

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
    target: GODOT_TARGET,
    subject: state?.scene ?? null,
    enabled: !preview,
    load: (scene) => loadMarkup(scene),
    save: (scene, png, json) => keepMarkup(png, json, scene),
    send,
    onProblem: setProblem,
    describeError: errorText,
  });
  // What the pane is showing decides which send buttons the footer offers: the
  // markup only exists over the 3D view, the frame only over the rendered one.
  const inThreeD = p3d.state.kind === "ready" && lookup !== null && view === "3d";
  const frameShown =
    !inThreeD &&
    !(view === "3d" && p3d.state.kind === "loading") &&
    shown?.scenePath != null &&
    image !== null &&
    !preview;

  const postComment = async () => {
    if (!selected || !draft.trim()) return;
    setPosting(true);
    try {
      await createComment({ anchor: { kind: "node", path: selected }, body: draft.trim() });
      setDraft("");
      await refreshComments();
      setCommentsOpen(true);
    } finally {
      setPosting(false);
    }
  };

  const sourceLabel =
    shown?.source === "headless"
      ? `Read by ${shown.godot ? `Godot ${shown.godot.split(".").slice(0, 2).join(".")}` : "Godot"} (headless)`
      : shown?.source === "parsed"
        ? "Read from the scene file - Godot did not run"
        : null;

  return (
    <div className="gv">
      {/* Mark up is not here: it belongs to the 3D view and sits on that view's
          own bar (`apps/shared/MarkupScene.tsx`), which already knows when the
          view can be drawn on. A second trigger here would need a handle into
          that lazy-loaded view for no gain. */}
      <ViewerToolbar
        label="Godot"
        mode={{ value: mode, options: MODES, onChange: setMode }}
        subject={
          !preview &&
          state &&
          state.scenes.length > 0 && (
            <select
              className="k-vtb__select"
              aria-label="Scene"
              value={state.scene ?? ""}
              disabled={busy}
              onChange={(e) => {
                setScene(e.target.value);
                setSelected(null);
              }}
            >
              {state.scenes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )
        }
        status={sceneChip(state, preview)}
        actions={
          <>
            {mode === "scene" && (
              <>
                <SegmentedControl
                  aria-label="Scene view"
                  value={view}
                  onChange={setView}
                  options={VIEWS}
                />
                <ToolbarButton
                  icon={<RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />}
                  disabled={preview || busy || noScenes || !state}
                  onClick={() => void startRefresh(false)}
                >
                  Refresh tree
                </ToolbarButton>
                <ToolbarButton
                  icon={<ImageIcon size={13} strokeWidth={1.5} aria-hidden="true" />}
                  disabled={preview || busy || noScenes || !state?.engineFound}
                  title={
                    state?.engineFound === false
                      ? "Rendering needs Godot 4."
                      : "Opens a Godot window for a moment and saves one frame."
                  }
                  onClick={() => void startRefresh(true)}
                >
                  Render view
                </ToolbarButton>
              </>
            )}
            <ToolbarButton
              icon={<PlayIcon size={13} strokeWidth={1.5} aria-hidden="true" />}
              disabled={!playable}
              title={
                playable
                  ? `Run ${state?.scene ?? "this scene"} in Play`
                  : "Pick a scene in this project to play it."
              }
              onClick={playScene}
            >
              Play scene
            </ToolbarButton>
            <label className="gv__preview-toggle">
              <input
                type="checkbox"
                checked={preview}
                onChange={(e) => setPreview(e.target.checked)}
              />
              Preview with sample data
            </label>
          </>
        }
        leave={
          <ToolbarButton
            icon={<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />}
            label="Open in Godot"
            disabled={!found || readOnly}
            title={
              readOnly
                ? "The default branch is read-only; open a worktree to edit."
                : found
                  ? "Open this project in the Godot editor"
                  : "Godot 4 was not found."
            }
            onClick={() => {
              setProblem(null);
              openInGodot().catch((e) => setProblem(errorText(e)));
            }}
          />
        }
      />

      {(problem || job?.error || (!preview && state && !state.engineFound)) && (
        <div className="gv__notices">
          {problem && <p className="gv__notice gv__notice--error">{problem}</p>}
          {job?.error && (
            <p className="gv__notice gv__notice--error">
              {job.error}
              {job.output.length > 0 && <code className="gv__output">{job.output.join("\n")}</code>}
            </p>
          )}
          {!preview && state && !state.engineFound && (
            <p className="gv__notice">
              Godot 4 was not found, so the tree is read from the scene file and no frame can be
              rendered. Set its path under Settings, Godot.
            </p>
          )}
        </div>
      )}

      <div className="gv__body">
        {mode === "scene" ? (
          <>
            <aside className="gv__tree">
              <div className="gv__tree-heading">
                <FolderTree size={13} strokeWidth={1.5} aria-hidden="true" />
                Scene tree
              </div>
              {nodes.length === 0 ? (
                <p className="gv__hint">
                  {noScenes
                    ? "No .tscn scenes in this project."
                    : "Nothing read yet. Refresh the tree to load it."}
                </p>
              ) : (
                <div className="gv__tree-list">
                  {nodes.map((n) => (
                    <TreeRow
                      key={n.path}
                      node={n}
                      depth={0}
                      selected={selected}
                      onSelect={setSelected}
                      notes={notes}
                    />
                  ))}
                </div>
              )}
            </aside>

            <main className="gv__viewport">
              {/* The refresh phase is the toolbar chip now; how the tree was
                  read stays here, beside what it describes. */}
              {sourceLabel && !busy && <p className="gv__note">{sourceLabel}</p>}
              {shown?.note && !busy && <p className="gv__note">{shown.note}</p>}
              {view === "3d" && !preview && (
                <Preview3DStatus
                  state={p3d.state}
                  engineFound={state?.engineFound ?? true}
                  onRetry={() => p3d.load(true, false)}
                />
              )}
              {p3d.state.kind === "ready" && lookup && view === "3d" ? (
                <>
                  <Suspense fallback={<p className="gv__hint">Loading the 3D view...</p>}>
                    <Scene3D
                      glb={p3d.state.data.glb}
                      lookup={lookup}
                      glbPath={p3d.state.data.path}
                      scenePath={state?.scene ?? ""}
                      godot={p3d.state.data.godot}
                      selected={selected}
                      onSelect={setSelected}
                      onMarkup={onMarkup}
                      onNotice={setProblem}
                    />
                  </Suspense>
                  {markup && (
                    <MarkupBar
                      url={markup.url}
                      json={markup.json}
                      fresh={markup.fresh}
                      open={barOpen}
                      onOpenChange={setBarOpen}
                      onView={() => setPreviousOpen(true)}
                      onPointerDown={dragContext(() =>
                        putMarkup(markup.png, markup.json, state?.scene ?? null),
                      )}
                    />
                  )}
                </>
              ) : view === "3d" && p3d.state.kind === "loading" ? null : shown?.scenePath ==
                null ? (
                <p className="gv__hint">
                  {noScenes
                    ? "This project has no scenes yet."
                    : "No render yet. Refresh the tree to read this scene, or Render view for a frame."}
                </p>
              ) : (
                <div className="gv__render">
                  <span className="gv__render-path">{shown.scenePath}</span>
                  {image && !preview ? (
                    <>
                      <img
                        className="gv__frame"
                        alt="Rendered frame of the scene"
                        src={`data:image/png;base64,${image}`}
                        draggable={false}
                        title="Drag onto a terminal to send to the agent"
                        onPointerDown={dragContext(() => putFrame(image, shown.scenePath))}
                      />
                      <span className="gv__frame-age">
                        {formatRenderAge(shown.imageAt).replace("rendered", "frame rendered")}
                      </span>
                    </>
                  ) : (
                    <p className="gv__hint">
                      {preview
                        ? "Sample data - no frame."
                        : "No frame rendered. Use Render view to save one."}
                    </p>
                  )}
                </div>
              )}
            </main>

            {selected && (
              <div className="gv__composer">
                <div className="gv__composer-target">
                  <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
                  Comment on <code>{selected}</code>
                </div>
                <textarea
                  className="gv__composer-input"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="What should change about this node?"
                />
                <div className="gv__composer-actions">
                  <button type="button" onClick={() => setSelected(null)} disabled={posting}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="gv__composer-submit"
                    onClick={postComment}
                    disabled={posting || !draft.trim()}
                  >
                    {posting ? "Posting..." : "Comment"}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="gv__play-redirect">
            <p className="gv__hint">
              Play runs in its own pane, with transport controls and Capture &amp; comment. This
              viewer only shows the scene as Godot last read it.
            </p>
            <button
              type="button"
              className="gv__open-play"
              onClick={() => {
                void openIn("play");
              }}
            >
              Open Play
            </button>
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
            emptyHint="No comments on this scene yet. Select a node and leave one."
          />
        )}
      </div>

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
      <SendFooter
        trailing={
          <button
            type="button"
            className="gv__footer-btn"
            onClick={() => setCommentsOpen((v) => !v)}
          >
            <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
            Comments {openCount > 0 ? `· ${openCount} open` : ""}
          </button>
        }
      >
        {mode === "scene" && (
          <SendButton
            label="Send tree"
            sent={sent === "tree"}
            disabled={preview || busy || nodes.length === 0 || !state}
            title="Send the scene tree to the agent, or drag this onto a terminal"
            onClick={() => state && void send("tree", "tree", () => putTree(state))}
            onPointerDown={state ? dragContext(() => putTree(state)) : undefined}
          />
        )}
        {mode === "scene" && frameShown && shown && image && (
          <SendButton
            label="Send frame"
            sent={sent === "frame"}
            title="Send the rendered frame to the agent, or drag this onto a terminal"
            onClick={() => void send("frame", "frame", () => putFrame(image, shown.scenePath))}
            onPointerDown={dragContext(() => putFrame(image, shown.scenePath))}
          />
        )}
        {mode === "scene" && inThreeD && markup && (
          <SendButton
            label="Send markup"
            sent={sent === "markup"}
            title="Send the markup you drew to the agent, or drag this onto a terminal"
            onClick={() => void sendMarkup()}
            onPointerDown={dragContext(() =>
              putMarkup(markup.png, markup.json, state?.scene ?? null),
            )}
          />
        )}
      </SendFooter>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  notes,
}: {
  node: GodotNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  /** Unresolved comments per node path, from `openNotesByNode`. */
  notes: ReadonlyMap<string, number>;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const noteCount = notes.get(node.path) ?? 0;
  const noteLabel = `${noteCount} open comment${noteCount === 1 ? "" : "s"}`;

  return (
    <div className="gv__tree-node">
      <div
        className={`gv__tree-row${selected === node.path ? " gv__tree-row--selected" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        title={[node.script, node.instance].filter(Boolean).join("\n") || undefined}
        onClick={() => onSelect(node.path)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="gv__tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="gv__tree-toggle-spacer" />
        )}
        <span className="gv__tree-name">{node.name}</span>
        {noteCount > 0 && (
          <span
            className="k-badge k-badge--count gv__tree-notes"
            title={noteLabel}
            aria-label={noteLabel}
            role="img"
          >
            {noteCount}
          </span>
        )}
        <span className="gv__tree-type">{node.type}</span>
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              notes={notes}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Why the 3D view is not showing, when it is not, and what the person can do about it. */
function Preview3DStatus({
  state,
  engineFound,
  onRetry,
}: {
  state: PreviewState;
  engineFound: boolean;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return <p className="gv__hint">Exporting the scene for 3D ({state.phase})...</p>;
  }
  if (state.kind === "failed") {
    return (
      <div className="gv__notice gv__notice--error">
        <p>3D preview unavailable: {state.message} The last rendered frame is shown instead.</p>
        {state.output.length > 0 && <code className="gv__output">{state.output.join("\n")}</code>}
        <button type="button" className="gv__action" onClick={onRetry}>
          <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
  if (state.kind === "off" && !engineFound) {
    return (
      <p className="gv__notice">
        The 3D preview needs Godot 4 to export the scene. Set its path under Settings, Godot.
      </p>
    );
  }
  return null;
}
