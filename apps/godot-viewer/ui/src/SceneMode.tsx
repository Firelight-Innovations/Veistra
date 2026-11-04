/**
 * The Godot app's read-only viewer: a scene's node tree beside a 3D view or
 * its last rendered frame. It is Editor mode's body whenever the backend
 * answers `viewer` (main, a cloud session, no Godot: `editorSurface.ts`);
 * every other answer is the editor itself (`editor/EditorMode.tsx`). The
 * header is the shared `ViewerToolbar`, so Editor reads like Play and the
 * Blender viewer: the environment and scene, freshness, actions, leave; the
 * backend's reason for the surface is the one line under it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted } from "@veistra/bridge";
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
import { EditorReason } from "../../../shared/EditorReason";
import { canLaunch } from "../../../shared/editorSurface";
import { errorText, openInGodot } from "../../../shared/godot";
import { MarkupButton, type MarkupTrigger } from "../../../shared/MarkupTrigger";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { SendButton, SendFooter, useSendAction } from "../../../shared/SendFooter";
import { ToolbarButton, ToolbarEnvChip, ViewerToolbar } from "../../../shared/ViewerToolbar";
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
import { focusIfDropped, type ModeProps } from "./modes";
import "./SceneMode.css";

/**
 * three.js and Excalidraw live behind this import and nowhere else, so the
 * viewer's first paint does not pay for them (the Godot Viewer is the app
 * people open to read a tree; 3D is one tab of it).
 */
const Scene3D = lazy(() => import("./Scene3D"));

type View = "3d" | "render";

const VIEWS: readonly { value: View; label: string }[] = [
  { value: "3d", label: "3D" },
  { value: "render", label: "Render" },
];

const POLL_MS = 600;

export interface SceneModeProps extends ModeProps {
  /**
   * Switch this pane to Play and run `scene` in `project` (Play scene), or,
   * with no scene, whatever Play's F5 would run in it (F5 here).
   */
  onPlay: (scene: string | undefined, project: string) => void;
}

export default function SceneMode({ modeSwitch, status, epoch, onPlay }: SceneModeProps) {
  const [state, setState] = useState<GodotViewerState | null>(null);
  const [scene, setScene] = useState<string | undefined>(undefined);
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
  const [trigger, setTrigger] = useState<MarkupTrigger | null>(null);
  const surface = status?.editor ?? null;
  // A cloud session's files are on its VM: there is nothing here to read, and
  // every read would only fail with the reason the line under the bar gives.
  const cloud = surface?.code === "cloud";
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

  // Again after the cluster's project moves: the scenes and comments are the
  // new root's.
  useEffect(() => {
    if (!cloud) void load();
  }, [load, epoch, cloud]);

  useEffect(() => {
    if (!cloud) void refreshComments();
  }, [refreshComments, epoch, cloud]);

  useEffect(() => reportPainted(), []);

  // While a refresh runs, poll for its phase; when it stops, load the result.
  const jobRunning = state?.job?.running === true;
  useEffect(() => {
    if (!jobRunning) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [jobRunning, load]);

  const wants3d =
    view === "3d" && !preview && state !== null && state.engineFound && state.scenes.length > 0;
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
  const readOnly = status?.environment.readOnly ?? false;
  const launchable = canLaunch(surface);
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

  // This pane turns to Play and runs the scene there. The project goes with
  // the scene because a `res://` path means nothing on its own: Play's picker
  // may be on another of the environment's projects.
  const playScene = () => {
    if (state?.scene) onPlay(state.scene, state.project);
  };

  // F5 is Godot's Run Project, and WebView2's reload, which would unload the
  // pane: here it turns to Play and runs, as Play's own F5 does. Shift F5,
  // Play's Stop, is a hard reload, and Ctrl R, Play's Record, a reload too, so
  // both are kept from the page and do nothing here.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "r") e.preventDefault();
    if (e.key !== "F5") return;
    e.preventDefault();
    if (!e.shiftKey && !e.ctrlKey && state) onPlay(undefined, state.project);
  };

  const root = useRef<HTMLDivElement>(null);
  // The mode tab that switched here went with Play's toolbar, so the focus
  // fell to the page, where F5 would be the reload.
  useEffect(() => focusIfDropped(root.current), []);

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
      // The scene goes with the path, so the editor's dock shows the note
      // on this scene only (#320).
      const scene = state?.scene;
      const anchor = scene
        ? { kind: "node" as const, path: selected, scene }
        : { kind: "node" as const, path: selected };
      await createComment({ anchor, body: draft.trim() });
      setDraft("");
      await refreshComments();
      setCommentsOpen(true);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setPosting(false);
    }
  };

  // The line under the bar already says Godot is missing; this is for when it
  // gives another reason first (main, say) and Godot is missing as well.
  const engineNotice =
    !preview && state !== null && !state.engineFound && surface?.code !== "noEditor";

  const sourceLabel =
    shown?.source === "headless"
      ? `Read by ${shown.godot ? `Godot ${shown.godot.split(".").slice(0, 2).join(".")}` : "Godot"} (headless)`
      : shown?.source === "parsed"
        ? "Read from the scene file - Godot did not run"
        : null;

  return (
    <div className="gv" ref={root} tabIndex={-1} onKeyDown={onKeyDown}>
      <ViewerToolbar
        label="Godot"
        mode={modeSwitch}
        subject={
          <>
            <ToolbarEnvChip kind={status?.environment.kind} branch={status?.environment.branch} />
            {!preview && state && state.scenes.length > 0 && (
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
            )}
          </>
        }
        status={sceneChip(state, preview)}
        actions={
          <>
            {/* The 3D view is lazy, so it reports how to start drawing and
                the button lives here, in slot 4, as in Play. */}
            {view === "3d" && !preview && <MarkupButton trigger={inThreeD ? trigger : null} />}
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
            disabled={!launchable}
            title={
              launchable
                ? "Open this project in the Godot editor"
                : (surface?.reason ?? "Checking for Godot...")
            }
            onClick={() => {
              setProblem(null);
              openInGodot().catch((e) => setProblem(errorText(e)));
            }}
          />
        }
      />

      <EditorReason
        surface={surface}
        tool="godot"
        detail={
          surface?.code === "noEditor"
            ? "The tree is read from the scene file, and no frame can be rendered."
            : undefined
        }
        onError={setProblem}
      />

      {(problem || job?.error || engineNotice) && (
        <div className="gv__notices">
          {problem && <p className="gv__notice gv__notice--error">{problem}</p>}
          {job?.error && (
            <p className="gv__notice gv__notice--error">
              {job.error}
              {job.output.length > 0 && <code className="gv__output">{job.output.join("\n")}</code>}
            </p>
          )}
          {engineNotice && (
            <p className="gv__notice">
              Godot 4 was not found, so the tree is read from the scene file and no frame can be
              rendered. Set its path under Settings, Godot.
            </p>
          )}
        </div>
      )}

      <div className="gv__body">
        <aside className="gv__tree">
          <div className="gv__tree-heading">
            <FolderTree size={13} strokeWidth={1.5} aria-hidden="true" />
            Scene tree
          </div>
          {nodes.length === 0 ? (
            <p className="gv__hint">
              {cloud
                ? "Nothing to read here: this session's files are on its VM."
                : noScenes
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
                  onTrigger={setTrigger}
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
          ) : view === "3d" && p3d.state.kind === "loading" ? null : shown?.scenePath == null ? (
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
                disabled={posting || !draft.trim() || readOnly}
                title={
                  readOnly
                    ? "Comments are kept in the checkout, and main is read-only. Open a worktree to comment."
                    : undefined
                }
              >
                {posting ? "Posting..." : "Comment"}
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
          <>
            <button
              type="button"
              className="gv__footer-btn"
              onClick={() => setCommentsOpen((v) => !v)}
            >
              <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
              Comments {openCount > 0 ? `· ${openCount} open` : ""}
            </button>
          </>
        }
      >
        <SendButton
          label="Send tree"
          sent={sent === "tree"}
          disabled={preview || busy || nodes.length === 0 || !state}
          title="Send the scene tree to the agent, or drag this onto a terminal"
          onClick={() => state && void send("tree", "tree", () => putTree(state))}
          onPointerDown={state ? dragContext(() => putTree(state)) : undefined}
        />
        {frameShown && shown && image && (
          <SendButton
            label="Send frame"
            sent={sent === "frame"}
            title="Send the rendered frame to the agent, or drag this onto a terminal"
            onClick={() => void send("frame", "frame", () => putFrame(image, shown.scenePath))}
            onPointerDown={dragContext(() => putFrame(image, shown.scenePath))}
          />
        )}
        {inThreeD && markup && (
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
