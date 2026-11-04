/**
 * The Godot app's Editor mode with the editor itself in the pane (#316, spec
 * §11.1, owner decision 6). Godot runs as `--editor --single-window` on the
 * project picked here, and the embedder places its window over the box
 * (`useNativeBox`, `embed/*` as `godotEditor`), so Project Settings, the save
 * prompt and every other dialog of the editor open inside the box. Where it
 * cannot be placed (the backend's `popOut`, or a placement that failed) the
 * same editor runs in its own window and the pane says so.
 *
 * The Veistra bar keeps the toolbar's five slots: the mode; the environment,
 * project and scene; one state chip; Viewport only, Mark up and Send
 * selection; Pop out and Close. The three actions need the Veistra plugin
 * (`src-tauri/src/godot/veistra_editor.gd`), which is opt-in per project, and
 * each says why while it cannot act. Opening is always a press, never a
 * mount: starting an editor behind someone's back would be a surprise.
 *
 * One poll drives the view: `godot/editor-state` every half second, one call
 * at a time. It also says when an agent works in this environment, which is
 * the banner under the bar: an agent reads the files, not the editor.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { reportPainted } from "@veistra/bridge";
import type { CameraPose } from "@veistra/markup";
import type { MarkupExport } from "@veistra/markup/layer";
import { Maximize2, PenLine, PictureInPicture2, Scan, Send, X } from "lucide-react";
import { EditorReason } from "../../../../shared/EditorReason";
import { useEditorEvents } from "../../../../shared/editorEvents";
import { errorText } from "../../../../shared/godot";
import { base64Blob, GODOT_TARGET, sendMarkup } from "../../../../shared/markupFlow";
import type { WindowRect } from "../../../../shared/nativeBox";
import { dock, embedRect, embedStill, popOut } from "../../../../shared/nativeWindow";
import { useNativeBox } from "../../../../shared/useNativeBox";
import {
  ToolbarButton,
  ToolbarEnvChip,
  ViewerToolbar,
  type ToolbarStatus,
} from "../../../../shared/ViewerToolbar";
import { focusIfDropped, type ModeProps } from "../modes";
import { resolvePins } from "../play/pins";
import { getState as readScenes } from "../rpc";
import {
  closeEditor,
  editorAck,
  editorCapture,
  editorOpenScene,
  editorPick,
  editorSelection,
  editorState,
  installPlugin,
  openEditor,
  removePlugin,
  saveAll,
  setViewportOnly,
  type EditorCamera,
  type EditorState,
} from "./rpc";
import { sendSelection } from "./selection";
import "./editor.css";

const FrameMarkup = lazy(() => import("../play/FrameMarkup"));

const POLL_MS = 500;
/**
 * How long Closing shows with the editor still running: the person may have
 * cancelled Godot's save prompt, and then the editor simply stays.
 */
const CLOSING_MS = 15_000;
/** How long Send selection says Sent. */
const SENT_MS = 1800;

const icon = (I: typeof Scan) => <I size={16} strokeWidth={1.5} aria-hidden="true" />;

export interface EditorModeProps extends ModeProps {
  /** Where this frame is in its window (`veistra/window-rect`); `null` until the shell says. */
  frameRect: WindowRect | null;
  /** The shell's open overlays (`veistra/overlays`). */
  overlays: WindowRect[];
}

interface Marking {
  url: string;
  /** The captured viewport's own size, for picking. */
  natural: { width: number; height: number };
  camera?: EditorCamera;
  scene: string;
}

/** Slot 3: one word for where the editor is. */
export function editorChip(state: EditorState | null, closing: boolean): ToolbarStatus {
  const editor = state?.editor;
  if (!editor) return { tone: "idle", label: "Not open" };
  if (closing)
    return {
      tone: "warning",
      label: "Closing",
      title: "Godot asks to save anything unsaved first. Answer it in the editor.",
    };
  const embed = editor.embed.state;
  switch (embed.kind) {
    case "waiting":
      return { tone: "info", label: "Starting", title: "It shows here once its window opens." };
    case "embedded":
      return { tone: "success", label: "Editing" };
    case "poppedOut":
      return { tone: "accent", label: "Popped out", title: "Dock it to bring it back here." };
    case "ownWindow":
      return { tone: "warning", label: "Own window", title: embed.reason };
  }
}

/** The editor's camera as the markup format names it, when the plugin read all of it. */
function cameraPose(c: EditorCamera | undefined): CameraPose | null {
  if (!c?.pos || !c.target || !c.up || typeof c.fov !== "number") return null;
  return { position: c.pos, target: c.target, up: c.up, fov: c.fov };
}

export default function EditorMode(props: EditorModeProps) {
  const { modeSwitch, status, statusError, reloadStatus, epoch } = props;
  const [ed, setEd] = useState<EditorState | null>(null);
  const [ended, setEnded] = useState<EditorState["ended"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [scenes, setScenes] = useState<{ rel: string; list: string[] } | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [marking, setMarking] = useState<Marking | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const surface = status?.editor;
  const projects = status?.projects ?? [];
  const editor = ed?.editor ?? null;
  const chosen =
    projects.find((p) => p.rel === (editor?.project ?? picked)) ??
    projects.find((p) => p.engineMajor >= 4) ??
    projects[0];
  const embed = editor?.embed.state ?? null;
  const pluginReady = editor?.plugin.running === true;
  const why = editor ? editor.plugin.why : "Open the editor first.";
  const view = editor?.view ?? null;

  useEffect(() => reportPainted(), []);

  const guarded = useCallback(async (run: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await run();
    } catch (e) {
      setProblem(errorText(e));
    }
  }, []);

  // Mark up, for the dock's own button as well as the bar's.
  const beginMarkup = async (): Promise<string> => {
    if (marking) return "Mark up is already open in Veistra.";
    if (!pluginReady) throw new Error(why ?? "The Veistra plugin is not running.");
    const cap = await editorCapture("viewport");
    setMarking({
      url: URL.createObjectURL(base64Blob(cap.pngBase64)),
      natural: { width: cap.width, height: cap.height },
      camera: cap.camera,
      scene: view?.scene ?? "",
    });
    return "Mark up is open in Veistra.";
  };

  // The presses in the editor's own Veistra dock (#320): the poll hands them
  // on, and this mode carries each out and answers it (`editorEvents.ts`).
  const tab = useEditorEvents(
    { tool: "godot", where: () => view?.scene || null, markup: beginMarkup },
    editorAck,
  );
  const takeEvents = tab.take;

  // The poll. One call at a time: the next is asked for only once this one
  // has answered, so a slow answer never piles up behind itself.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await editorState(tab.since.current);
        if (!live) return;
        setEd(next);
        if (next.ended) setEnded(next.ended);
      } catch (e) {
        if (live) setProblem(errorText(e));
      }
      if (live) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [epoch, tab.since]);

  // The presses the poll handed on, taken once the render that shows that
  // poll's state is in, so a press is acted on against what it saw.
  const events = ed?.editor?.events;
  useEffect(() => {
    takeEvents(events);
  }, [events, takeEvents]);

  const open = editor !== null;
  // The editor going away ends Closing, and a Closing nobody answered lapses.
  useEffect(() => {
    if (!open) setClosing(false);
  }, [open]);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), CLOSING_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  // Open the editor, and Close, go with what they changed: the focus is put
  // back on the pane so F5 there is not the page's reload.
  useEffect(() => focusIfDropped(root.current), [open]);

  const rel = chosen?.rel;
  useEffect(() => {
    if (rel === undefined) return;
    let live = true;
    readScenes(undefined, rel)
      .then((s) => live && setScenes({ rel, list: s.scenes }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rel, epoch]);

  const box = useNativeBox({
    frameRect: props.frameRect,
    overlays: props.overlays,
    coveredHere: consentOpen || pickerOpen,
    hidden: marking !== null,
    placed: embed?.kind === "embedded",
    report: (r, visible, win, dpr) => embedRect("godotEditor", r, visible, win, dpr),
    still: () => embedStill("godotEditor"),
    generation: editor?.pid ?? null,
  });

  const doOpen = () =>
    void guarded(async () => {
      setOpening(true);
      setEnded(null);
      setNotice(null);
      try {
        setEd(await openEditor(chosen?.rel));
      } finally {
        setOpening(false);
      }
    });

  const doClose = () =>
    void guarded(async () => {
      await closeEditor();
      setClosing(true);
    });

  const doViewportOnly = () =>
    void guarded(async () => {
      const on = !(view?.viewportOnly ?? false);
      await setViewportOnly(on);
      setEd((s) =>
        s?.editor?.view
          ? { ...s, editor: { ...s.editor, view: { ...s.editor.view, viewportOnly: on } } }
          : s,
      );
    });

  const doSend = () =>
    void guarded(async () => {
      setSending(true);
      try {
        const sel = await editorSelection();
        const n = sel.selected?.length ?? 0;
        if (n === 0) {
          setNotice("Nothing is selected in Godot. Select the nodes to send, then send again.");
          return;
        }
        const { typed } = await sendSelection(sel);
        setSent(true);
        setTimeout(() => setSent(false), SENT_MS);
        setNotice(
          typed
            ? null
            : "The selection is in the Context strip; no agent prompt was open to type it into.",
        );
      } finally {
        setSending(false);
      }
    });

  const startMarkup = () =>
    void guarded(async () => {
      if (marking || !pluginReady) return;
      await beginMarkup();
    });

  const endMarkup = () => {
    if (marking) URL.revokeObjectURL(marking.url);
    setMarking(null);
  };

  /** Done: ask the editor what each pin is on, then send it as every viewer does. */
  const doneMarkup = async (result: MarkupExport, shown: { width: number; height: number }) => {
    const m = marking;
    if (!m) return;
    await guarded(async () => {
      const json = result.json;
      await resolvePins(json, m.natural, shown, async (x, y) => (await editorPick(x, y)).hit);
      json.source = { ...json.source, engine: "godot", view: "editor", scene: m.scene || null };
      const pose = cameraPose(m.camera);
      if (pose) json.camera = pose;
      await sendMarkup(GODOT_TARGET, result.png, json, m.scene || null);
      setNotice("Markup sent to the agent.");
    });
    endMarkup();
  };

  const changePlugin = async (install: boolean) => {
    await guarded(async () => {
      await (install ? installPlugin(chosen?.rel) : removePlugin(chosen?.rel));
      await reloadStatus(false);
    });
    setConsentOpen(false);
  };

  // Slot 2: the environment first (DECISIONS X4), then which project, then
  // which scene. The scene picker opens a scene in the editor, so it is there
  // only while the plugin can do that.
  const sceneList = [
    ...new Set([...(view?.open ?? []), ...(scenes?.rel === rel ? scenes.list : [])]),
  ];
  const subject = (
    <>
      <ToolbarEnvChip kind={status?.environment.kind} branch={status?.environment.branch} />
      {projects.length > 1 ? (
        <select
          className="k-vtb__select"
          aria-label="Godot project"
          value={chosen?.rel ?? ""}
          disabled={open}
          title={open ? "Close the editor to open another project." : undefined}
          onFocus={() => setPickerOpen(true)}
          onBlur={() => setPickerOpen(false)}
          onChange={(e) => setPicked(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.rel} value={p.rel}>
              {p.name} ({p.rel})
            </option>
          ))}
        </select>
      ) : (
        chosen && <span className="ge__subject">{chosen.name}</span>
      )}
      {pluginReady && view && sceneList.length > 0 && (
        <select
          className="k-vtb__select"
          aria-label="Scene"
          value={view.scene}
          onFocus={() => setPickerOpen(true)}
          onBlur={() => setPickerOpen(false)}
          onChange={(e) => void guarded(() => editorOpenScene(e.target.value))}
        >
          {!view.scene && <option value="">No scene open</option>}
          {sceneList.map((s) => (
            <option key={s} value={s}>
              {s.replace(/^res:\/\//, "")}
            </option>
          ))}
        </select>
      )}
    </>
  );

  const selectedCount = view?.selected.length ?? 0;
  const actions = (
    <>
      <ToolbarButton
        icon={icon(Scan)}
        pressed={view?.viewportOnly ?? false}
        disabled={!pluginReady}
        title={
          why ?? "Show only the 3D viewport, with the docks hidden (Godot's distraction-free mode)"
        }
        onClick={doViewportOnly}
      >
        Viewport only
      </ToolbarButton>
      <ToolbarButton
        icon={icon(PenLine)}
        disabled={!pluginReady || marking !== null || embed?.kind === "poppedOut"}
        title={
          why ??
          (embed?.kind === "poppedOut"
            ? "Mark up draws in the pane. Dock the editor first."
            : "Draw on the 3D viewport; pins name the node under them")
        }
        onClick={startMarkup}
      >
        Mark up
      </ToolbarButton>
      <ToolbarButton
        icon={icon(Send)}
        disabled={!pluginReady || sending}
        title={
          why ??
          (selectedCount > 0
            ? `Send the ${selectedCount === 1 ? "selected node" : `${selectedCount} selected nodes`} and the viewport to the agent`
            : "Select nodes in Godot, then send them with the viewport to the agent")
        }
        onClick={doSend}
      >
        {sent ? "Sent" : "Send selection"}
      </ToolbarButton>
    </>
  );

  const popped = embed?.kind === "poppedOut";
  const canPop = embed?.kind === "embedded" || popped;
  const leave = (
    <>
      <ToolbarButton
        label={popped ? "Dock into the pane" : "Pop out into its own window"}
        disabled={!canPop}
        title={
          canPop
            ? undefined
            : open
              ? "Pop out needs the editor in the pane, and it is in its own window."
              : "Pop out needs the editor open here."
        }
        icon={icon(popped ? Maximize2 : PictureInPicture2)}
        onClick={() => void guarded(() => (popped ? dock("godotEditor") : popOut("godotEditor")))}
      />
      <ToolbarButton
        label="Close the editor"
        disabled={!open}
        title={
          open
            ? "Close the editor. Godot asks to save anything unsaved first."
            : "The editor is not open."
        }
        icon={icon(X)}
        onClick={doClose}
      />
    </>
  );

  const plugin = chosen?.plugin ?? "no";
  const pluginProblem = status?.pluginProblem ?? null;

  return (
    <div className="ge" ref={root} tabIndex={-1} onKeyDown={keepReloadKeys}>
      <ViewerToolbar
        label="Godot"
        mode={modeSwitch}
        subject={subject}
        status={editorChip(ed, closing)}
        actions={actions}
        leave={leave}
      />

      <EditorReason surface={surface} tool="godot" onError={setProblem} />

      {ed?.agent && open && (
        <div className="ge__banner" role="note" aria-label="An agent is working here">
          <span className="ge__banner-text">
            An agent is working in this environment. Save in Godot before you send, so it reads what
            you see.
          </span>
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={!pluginReady}
            title={
              pluginReady
                ? "Save every open scene, as Godot's Save All Scenes does"
                : `${why ?? ""} Until then, press Ctrl S in Godot.`
            }
            onClick={() => void guarded(saveAll)}
          >
            Save all
          </button>
        </div>
      )}

      {(problem || statusError || notice) && (
        <div className="ge__notices">
          {problem && <p className="ge__notice ge__notice--error">{problem}</p>}
          {statusError && <p className="ge__notice ge__notice--error">{statusError}</p>}
          {notice && (
            <p className="ge__notice">
              {notice}{" "}
              <button type="button" className="ge__link" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </p>
          )}
        </div>
      )}

      <main className="ge__viewport">
        <div
          className="ge__box"
          ref={box.ref}
          data-embedded={embed?.kind === "embedded" || undefined}
        >
          {marking ? (
            <Suspense fallback={null}>
              <FrameMarkup
                src={marking.url}
                path={marking.scene ? `${marking.scene} (editor viewport)` : "editor viewport"}
                onDone={(r, shown) => void doneMarkup(r, shown)}
                onCancel={endMarkup}
                onProblem={setProblem}
              />
            </Suspense>
          ) : !editor ? (
            <div className="ge__launch">
              <p className="ge__launch-title">
                {chosen ? `${chosen.name} in the Godot editor` : "The Godot editor"}
              </p>
              {ended && (
                <p className="ge__launch-text">
                  {ended.code === null || ended.code === 0
                    ? "The editor closed."
                    : `The editor exited with code ${ended.code}.`}
                </p>
              )}
              <p className="ge__launch-text">
                {!chosen
                  ? "No project.godot in this environment (looked four folders deep)."
                  : chosen.engineMajor < 4
                    ? `${chosen.name} is a Godot 3 project. Veistra drives Godot 4.x.`
                    : surface?.surface === "popOut"
                      ? "It opens in its own window, for the reason above."
                      : "It opens here, in this pane, with its own dialogs inside it."}
              </p>
              <button
                type="button"
                className="k-btn k-btn--primary"
                disabled={!chosen || chosen.engineMajor < 4 || opening}
                onClick={doOpen}
              >
                {opening ? "Opening…" : "Open the editor"}
              </button>
              {chosen && chosen.engineMajor >= 4 && (
                <p className="ge__launch-text ge__launch-plugin">
                  {pluginProblem ??
                    (plugin === "yes"
                      ? "The Veistra plugin is on: Mark up, Send selection and Viewport only work in the editor."
                      : plugin === "partial"
                        ? "The Veistra plugin is out of date here, or was switched off in Godot."
                        : "Mark up, Send selection and Viewport only need the Veistra plugin.")}{" "}
                  {!pluginProblem && (
                    <button
                      type="button"
                      className="ge__link"
                      onClick={() =>
                        plugin === "yes" ? void changePlugin(false) : setConsentOpen(true)
                      }
                    >
                      {plugin === "yes"
                        ? "Remove the plugin"
                        : plugin === "partial"
                          ? "Update the plugin"
                          : "Enable the plugin"}
                    </button>
                  )}
                </p>
              )}
            </div>
          ) : embed?.kind === "embedded" ? (
            box.covered && box.stillUrl ? (
              <img className="ge__still" src={box.stillUrl} alt="The Godot editor's last frame" />
            ) : (
              <span className="ge__sr">The Godot editor is shown here.</span>
            )
          ) : (
            <p className="ge__hint">
              {embed?.kind === "poppedOut"
                ? "The editor is in its own window. Dock it to bring it back here."
                : embed?.kind === "ownWindow"
                  ? surface?.surface === "embedded"
                    ? embed.reason
                    : "The Godot editor is open in its own window."
                  : "Starting the Godot editor…"}
            </p>
          )}
        </div>
      </main>

      {consentOpen && chosen && (
        <div className="ge__consent" role="dialog" aria-label="Enable the Veistra plugin">
          <strong>Add the Veistra plugin to {chosen.name}?</strong>
          <ul>
            <li>
              Three files, <code>addons/veistra/plugin.cfg</code>,{" "}
              <code>addons/veistra/veistra_editor.gd</code> and{" "}
              <code>addons/veistra/veistra_dock.gd</code>, and one <code>[editor_plugins]</code>{" "}
              line in <code>{chosen.rel === "." ? "" : `${chosen.rel}/`}project.godot</code>.
            </li>
            <li>
              While the editor runs from Veistra it reports the selected nodes, the edited scene,
              the 3D camera and a picture of the viewport. It takes three commands, select a node,
              open a scene and Viewport only, and saves or closes the editor when you press Save all
              or Close here.
            </li>
            <li>
              It adds a Veistra dock to the editor with the notes on the selected node. Its buttons
              ask Veistra to act; the dock never writes the notes itself.
            </li>
            <li>It talks to Veistra through a temporary folder. No network port.</li>
            <li>
              It does nothing in an exported build, or when you open the project in Godot yourself.
              Remove it here at any time.
            </li>
          </ul>
          <div className="ge__consent-actions">
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              onClick={() => setConsentOpen(false)}
            >
              Not now
            </button>
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              onClick={() => void changePlugin(true)}
            >
              Add to this project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * F5 and Ctrl R on the pane are WebView2's reload, which would unload Editor
 * mode under a running editor. Godot's own keys go to its window, not here.
 */
function keepReloadKeys(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
}
