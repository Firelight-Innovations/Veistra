/**
 * The Godot app's Editor mode with the editor itself in the pane (#316, spec
 * §11.1, owner decision 6). Godot runs as `--editor --single-window` on the
 * project picked here, and the embedder places its window over the box
 * (`useNativeBox`, `embed/*` as `godotEditor`), so Project Settings, the save
 * prompt and every other dialog of the editor open inside the box. Where it
 * cannot be placed (the backend's `popOut`, or a placement that failed) the
 * same editor runs in its own window and the pane says so.
 *
 * The bar's five slots: the mode; the environment, project and scene; one
 * state chip; Viewport only, Mark up and Send selection, which need the
 * opt-in Veistra plugin (`src-tauri/src/godot/veistra_editor.gd`) and say why
 * while they cannot act; Pop out. No Close: Godot is quit from inside it,
 * which asks to save first. In the pane the editor opens by itself (`AutoOpen`).
 *
 * One poll drives the view: `godot/editor-state` every half second, one call
 * at a time. It also says when an agent works in this environment, which is
 * the banner under the bar: an agent reads the files, not the editor.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { reportPainted } from "@veistra/bridge";
import type { CameraPose } from "@veistra/markup";
import type { MarkupExport } from "@veistra/markup/layer";
import { Maximize2, PenLine, PictureInPicture2, Scan, Send } from "lucide-react";
import { EditorReason } from "../../../../shared/EditorReason";
import { useEditorEvents } from "../../../../shared/editorEvents";
import { revealName, usePublishReport, type RevealRequest } from "../../../../shared/editorReveal";
import { errorText } from "../../../../shared/godot";
import { base64Blob, GODOT_TARGET, markupToAgent } from "../../../../shared/markupFlow";
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
import PluginConsent from "./PluginConsent";
import { godotPlace, godotReport, revealInGodot } from "./reveal";
import { sendSelection } from "./selection";
import "./editor.css";

const FrameMarkup = lazy(() => import("../play/FrameMarkup"));

const POLL_MS = 500;
/** How long Send selection says Sent. */
const SENT_MS = 1800;

const icon = (I: typeof Scan) => <I size={16} strokeWidth={1.5} aria-hidden="true" />;

export interface EditorModeProps extends ModeProps {
  /** Where this frame is in its window (`veistra/window-rect`); `null` until the shell says. */
  frameRect: WindowRect | null;
  /** The shell's open overlays (`veistra/overlays`). */
  overlays: WindowRect[];
  /** A chip clicked in the agent tab, to show in the editor once it can. */
  reveal?: RevealRequest | null;
  onRevealHandled?: (n: number) => void;
}

interface Marking {
  url: string;
  /** The captured viewport's own size, for picking. */
  natural: { width: number; height: number };
  camera?: EditorCamera;
  scene: string;
}

/** Slot 3: one word for where the editor is. */
export function editorChip(state: EditorState | null): ToolbarStatus {
  const editor = state?.editor;
  if (!editor) return { tone: "idle", label: "Not open" };
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

const NOT_NOW = "godot.plugin.notNow";

const notNowKey = (root: string | null | undefined, rel: string) =>
  `${NOT_NOW}.${root ?? ""}|${rel}`;

/**
 * Whether the plugin question was answered Not now, or the plugin removed, for
 * this project in this environment. Every Godot frame shares one origin and so
 * one `localStorage`, which is what lets every pane on the project skip the
 * question. Storage can throw (blocked, private); then it is asked again.
 */
function saidNotNow(root: string | null | undefined, rel: string): boolean {
  try {
    return localStorage.getItem(notNowKey(root, rel)) === "1";
  } catch {
    return false;
  }
}

function rememberNotNow(root: string | null | undefined, rel: string): void {
  try {
    localStorage.setItem(notNowKey(root, rel), "1");
  } catch {
    // Asked again next time instead.
  }
}

/**
 * Where the editor goes in the pane, Editor mode opens it on mount, on the
 * project shown, with no press. A project with no plugin is asked about it
 * first (`PluginConsent`), and the editor opens on either answer. Nothing is
 * opened by itself where it would pop out into its own window, where the
 * first poll finds one open or just ended, or once it has ended in this
 * mount, quit or crashed: the pane says so and Open the editor is a press.
 * The read-only checkout, a cloud session and a missing Godot never get
 * here; `App.tsx` shows the viewer for them.
 *
 * `waiting` is for the first poll and the status, `asking` for the plugin
 * question, `done` once the editor was opened or there was a reason not to.
 * It is never set back, so it happens once per mount.
 */
type AutoOpen = "waiting" | "asking" | "done";

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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [marking, setMarking] = useState<Marking | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [auto, setAuto] = useState<AutoOpen>("waiting");
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
    {
      tool: "godot",
      where: () => view?.scene || null,
      markup: beginMarkup,
      place: () => godotPlace(editor, status?.environment.root ?? null),
    },
    editorAck,
  );
  // What the agent tab's @ menu lists from this editor (`editorMention.ts`).
  usePublishReport("godot", godotReport(editor));
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
  // The editor opening, or quitting, takes away what had the focus: it is put
  // back on the pane so F5 there is not the page's reload.
  useEffect(() => focusIfDropped(root.current), [open]);

  const rel = chosen?.rel;
  const envRoot = status?.environment.root;
  const pluginProblem = status?.pluginProblem ?? null;
  // What Open the editor needs: a Godot 4 project, somewhere writable, and a
  // surface that is the editor rather than the viewer.
  const launchable =
    chosen !== undefined &&
    chosen.engineMajor >= 4 &&
    status?.environment.readOnly === false &&
    surface !== undefined &&
    surface.surface !== "viewer";
  const embedsHere = launchable && surface?.surface === "embedded";
  const askFirst =
    launchable && chosen.plugin === "no" && !pluginProblem && !saidNotNow(envRoot, chosen.rel);
  const polled = ed !== null;

  // A press clears what the pane said before; the open on mount keeps it, so
  // a plugin install that failed just before is still said once Godot opens.
  const openOn = useCallback(async (project: string | undefined, pressed: boolean) => {
    if (pressed) {
      setProblem(null);
      setNotice(null);
    }
    setOpening(true);
    setEnded(null);
    try {
      setEd(await openEditor(project));
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setOpening(false);
    }
  }, []);

  // Opening on mount: decided once the first poll has said whether an editor
  // runs, and once the status has named the project. An editor already open,
  // or one that ended before this got there, settles it without opening one.
  // The plugin question comes first, and either answer lets the open go on.
  useEffect(() => {
    if (!polled || auto === "done") return;
    if (open || ended) {
      setAuto("done");
      return;
    }
    if (!launchable) return;
    if (auto === "waiting" && askFirst) {
      setAuto("asking");
      setConsentOpen(true);
      return;
    }
    if (consentOpen) return;
    setAuto("done");
    if (embedsHere) void openOn(rel, false);
  }, [polled, auto, open, ended, launchable, askFirst, consentOpen, embedsHere, openOn, rel]);

  // From mount until the open answers, the pane says Opening rather than
  // offering a press that is about to happen by itself.
  const starting =
    opening || (auto !== "done" && embedsHere && !consentOpen && !open && !ended && !problem);

  // A chip clicked in the agent tab: shown once the plugin can act, which on
  // a pane that just opened is after the editor and its plugin have started.
  // With no editor coming, or no plugin in it, the pane says so instead.
  const { reveal, onRevealHandled } = props;
  const revealing = useRef<number | null>(null);
  useEffect(() => {
    if (!reveal || revealing.current === reveal.n) return;
    const give = (text: string | null) => {
      if (text !== null) setNotice(text);
      onRevealHandled?.(reveal.n);
    };
    if (editor && pluginReady && view) {
      revealing.current = reveal.n;
      revealInGodot(reveal, editor).then(give, (e: unknown) => {
        setProblem(errorText(e));
        give(null);
      });
    } else if (editor && editor.plugin.installed === "no") {
      give(why ?? `Enable the Veistra plugin to show ${revealName(reveal)} in the editor.`);
    } else if (!editor && polled && auto === "done" && !starting) {
      give(`Open the editor to show ${revealName(reveal)} in it.`);
    }
  }, [reveal, onRevealHandled, editor, pluginReady, view, why, polled, auto, starting]);
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

  const doOpen = () => void openOn(chosen?.rel, true);

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
      setNotice(await markupToAgent(GODOT_TARGET, result.png, json, m.scene || null));
    });
    endMarkup();
  };

  // Removing the plugin is an answer to the question as well, so it is not
  // asked again on this project.
  const changePlugin = async (install: boolean) => {
    if (!chosen) return;
    const project = chosen.rel;
    setInstalling(true);
    await guarded(async () => {
      if (!install) rememberNotNow(envRoot, project);
      await (install ? installPlugin(project) : removePlugin(project));
      await reloadStatus(false);
    });
    setInstalling(false);
    setConsentOpen(false);
  };

  const notNow = useCallback(() => {
    if (rel !== undefined) rememberNotNow(envRoot, rel);
    setConsentOpen(false);
  }, [envRoot, rel]);

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
          title={open ? "Quit the editor to open another project." : undefined}
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
    </>
  );

  const plugin = chosen?.plugin ?? "no";

  return (
    <div className="ge" ref={root} tabIndex={-1} onKeyDown={keepReloadKeys}>
      <ViewerToolbar
        label="Godot"
        mode={modeSwitch}
        subject={subject}
        status={editorChip(ed)}
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
                    : starting
                      ? "Opening it here, in this pane."
                      : surface?.surface === "popOut"
                        ? "It opens in its own window, for the reason above."
                        : "It opens here, in this pane, with its own dialogs inside it."}
              </p>
              <button
                type="button"
                className="k-btn k-btn--primary"
                disabled={!chosen || chosen.engineMajor < 4 || starting}
                onClick={doOpen}
              >
                {starting ? "Opening…" : "Open the editor"}
              </button>
              {!starting && chosen && chosen.engineMajor >= 4 && (
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
        <PluginConsent
          name={chosen.name}
          rel={chosen.rel}
          busy={installing}
          onAdd={() => void changePlugin(true)}
          onNotNow={notNow}
        />
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
