/**
 * The Blender app's Editor mode with Blender itself in the pane (#317, spec
 * §11.2). Veistra starts the person's own Blender as
 * `blender <file.blend> --python veistra_boot.py`, installing nothing, and the
 * embedder places its window over the box (`useNativeBox`, `embed/*` as
 * `blender`), so every menu and dialog of Blender opens inside it. Where it
 * cannot be placed (the backend's `popOut`, or a placement that failed) the
 * same Blender runs in its own window and the pane says so.
 *
 * The Veistra bar keeps the toolbar's five slots, as the Godot editor's does:
 * the mode; the environment and file; one state chip; Viewport only, Mark up
 * and Send selection, the boot script's commands; Pop out. There is no Close:
 * Blender is quit from inside it, which asks to save first. In the pane it
 * opens by itself, once per mount (the open on mount, below).
 *
 * While Blender has a file open Veistra holds its lock, and the banner under
 * the bar says what that means: the agent's export of the file lands as the
 * next version beside it (`writer.ts`). One poll drives the view,
 * `blender-viewer/editor-state` every half second, one call at a time.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { reportPainted } from "@veistra/bridge";
import type { MarkupExport } from "@veistra/markup/layer";
import { Maximize2, PenLine, PictureInPicture2, Scan, Send } from "lucide-react";
import { EditorReason } from "../../../../shared/EditorReason";
import { useEditorEvents } from "../../../../shared/editorEvents";
import { revealName, usePublishReport, type RevealRequest } from "../../../../shared/editorReveal";
import { canLaunch } from "../../../../shared/editorSurface";
import { base64Blob, BLENDER_TARGET, markupToAgent } from "../../../../shared/markupFlow";
import type { WindowRect } from "../../../../shared/nativeBox";
import { dock, embedRect, embedStill, popOut } from "../../../../shared/nativeWindow";
import { useNativeBox } from "../../../../shared/useNativeBox";
import {
  ToolbarButton,
  ToolbarEnvChip,
  ViewerToolbar,
  type ToolbarMode,
  type ToolbarStatus,
} from "../../../../shared/ViewerToolbar";
import { COMPARE_NEEDS_TWO, type BlenderMode } from "../modes";
import type { BlenderViewerState } from "../rpc";
import { resolvePins } from "./pins";
import { blenderPlace, blenderReport, revealInBlender } from "./reveal";
import {
  editorAck,
  editorCapture,
  editorPick,
  editorState,
  openEditor,
  setViewportOnly,
  type BlenderEditorState,
  type ViewReport,
} from "./rpc";
import { cameraPose, sendSelection } from "./selection";
import { conflictText, writerBanner } from "./writer";
import "./editor.css";

const ViewportMarkup = lazy(() => import("./ViewportMarkup"));

const POLL_MS = 500;
/** How long Send selection says Sent. */
const SENT_MS = 1800;

const icon = (I: typeof Scan) => <I size={16} strokeWidth={1.5} aria-hidden="true" />;

export interface EditorModeProps {
  /** Slot 1 of the toolbar. */
  modeSwitch: ToolbarMode<BlenderMode>;
  /** `blender-viewer/state`, polled by the app: the files, the surface, the versions. */
  viewer: BlenderViewerState;
  /** The `.blend` the app shows (absolute); follows the file Blender has open. */
  onPick: (blend: string) => void;
  /** Where this frame is in its window (`veistra/window-rect`); `null` until the shell says. */
  frameRect: WindowRect | null;
  /** The shell's open overlays (`veistra/overlays`). */
  overlays: WindowRect[];
  /** The banner's "Compare with v<n>": Compare mode, with that version as B. */
  onCompare?: (version: number) => void;
  /** A chip clicked in the agent tab, to show in Blender (`editorReveal.ts`). */
  reveal?: RevealRequest | null;
  onRevealHandled?: (n: number) => void;
}

interface Marking {
  url: string;
  /** The capture's own size, for picking. */
  natural: { width: number; height: number };
  view: ViewReport | null;
  file: string | null;
}

/** Slot 3: one word for where Blender is. */
export function editorChip(state: BlenderEditorState | null): ToolbarStatus {
  const editor = state?.editor;
  if (!editor) return { tone: "idle", label: "Not open" };
  const embed = editor.embed.state;
  switch (embed.kind) {
    case "waiting":
      return { tone: "info", label: "Starting", title: "It shows here once its window opens." };
    case "embedded":
      return {
        tone: "success",
        label: "Editing",
        title: editor.dirty ? "Blender has unsaved changes." : undefined,
      };
    case "poppedOut":
      return { tone: "accent", label: "Popped out", title: "Dock it to bring it back here." };
    case "ownWindow":
      return { tone: "warning", label: "Own window", title: embed.reason };
  }
}

/** The footer: which Blender, and the boot script's version once it has said hello. */
export function footerText(state: BlenderEditorState | null, found: string | null): string {
  const editor = state?.editor;
  const blender = editor?.blender ?? found;
  const parts = [blender ? `Blender ${blender}` : "Blender"];
  if (editor)
    parts.push(editor.script ? `Veistra add-on v${editor.script}` : "Veistra add-on starting");
  return parts.join(" · ");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function EditorMode(props: EditorModeProps) {
  const { modeSwitch, viewer, onPick, onCompare } = props;
  const [ed, setEd] = useState<BlenderEditorState | null>(null);
  const [ended, setEnded] = useState<BlenderEditorState["ended"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  /**
   * The open on mount has been decided: Blender was opened, or there was a
   * reason not to. It is never set back, so it happens once per mount.
   */
  const [settled, setSettled] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [marking, setMarking] = useState<Marking | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const surface = viewer.editor;
  const editor = ed?.editor ?? null;
  const embed = editor?.embed.state ?? null;
  const booted = editor?.booted === true;
  const why = editor ? editor.why : "Open Blender first.";
  const view = editor?.view ?? null;
  const open = editor !== null;

  useEffect(() => reportPainted(), []);

  const guarded = useCallback(async (run: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await run();
    } catch (e) {
      setProblem(errorText(e));
    }
  }, []);

  // Mark up, for the tab's own button as well as the bar's.
  const beginMarkup = async (): Promise<string> => {
    if (marking) return "Mark up is already open in Veistra.";
    if (!booted) throw new Error(why ?? "The Veistra script has not started in this Blender yet.");
    const cap = await editorCapture();
    setMarking({
      url: URL.createObjectURL(base64Blob(cap.pngBase64)),
      natural: { width: cap.width, height: cap.height },
      view: cap.view,
      file: cap.file,
    });
    return "Mark up is open in Veistra.";
  };

  // The presses in the editor's own Veistra tab (#320): the poll hands them
  // on, and this mode carries each out and answers it (`editorEvents.ts`).
  const tab = useEditorEvents(
    {
      tool: "blender",
      where: () => editor?.file ?? null,
      markup: beginMarkup,
      place: () => blenderPlace(editor),
    },
    editorAck,
  );
  const takeEvents = tab.take;

  // What the agent tab's @ menu lists from this Blender.
  usePublishReport("blender", blenderReport(editor));

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
  }, [tab.since]);

  // The presses the poll handed on, taken once the render that shows that
  // poll's state is in, so a press is acted on against what it saw.
  const events = ed?.editor?.events;
  useEffect(() => {
    takeEvents(events);
  }, [events, takeEvents]);

  // A lock on the picked file that is not this pane's Blender: Open would be refused.
  const heldElsewhere =
    !open && viewer.locked && viewer.locked.file === viewer.rel ? viewer.locked : null;
  // With no .blend in the environment, Open starts Blender on a new scene.
  const newScene = viewer.blends.length === 0;
  const target = newScene ? null : viewer.rel;
  // What Open in Blender needs: an environment Blender may save into, a
  // Blender, a file or a new scene to open it on, and nobody else on that file.
  const launchable =
    viewer.project &&
    !viewer.readOnly &&
    viewer.blender.found &&
    canLaunch(surface) &&
    (newScene || viewer.rel !== null) &&
    heldElsewhere === null;
  const embedsHere = launchable && surface?.surface === "embedded";
  const polled = ed !== null;

  // A press clears what the pane said before; the open on mount has nothing to clear.
  const openOn = useCallback(async (blend: string | null, pressed: boolean) => {
    if (pressed) {
      setProblem(null);
      setNotice(null);
    }
    setOpening(true);
    setEnded(null);
    try {
      setEd(await openEditor(blend));
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setOpening(false);
    }
  }, []);

  // The open on mount, as the Godot editor's: decided once the first poll has
  // said whether Blender runs, on the file shown, with no press. With no
  // .blend in the environment yet it opens on a new untitled scene, which
  // writes nothing there until the person saves it. Nothing opens by itself
  // where Blender would pop out into its own window, where the picked file is
  // open in another Blender, where the first poll finds Blender open or just
  // ended, or once it has ended in this mount, quit or crashed: the pane says
  // so and Open in Blender is a press again. There is no boot-script consent
  // to ask first: the script goes on the command line into a temporary
  // folder, and nothing into the project. The main checkout, a cloud session
  // and a missing Blender never get here; `App.tsx` shows the viewer for them.
  useEffect(() => {
    if (!polled || settled) return;
    setSettled(true);
    if (open || ended) return;
    if (embedsHere) void openOn(target, false);
  }, [polled, settled, open, ended, embedsHere, openOn, target]);

  // From mount until the open answers, the pane says Opening rather than
  // offering a press that is about to happen by itself.
  const starting = opening || (!settled && embedsHere && !open && !ended && !problem);

  // The app shows the file Blender has open, so the banner's versions are its.
  const file = editor?.file ?? null;
  const pathOf = useCallback(
    (rel: string) => viewer.blends.find((b) => b.rel === rel)?.path ?? null,
    [viewer.blends],
  );
  useEffect(() => {
    if (!file || file === viewer.rel) return;
    const path = pathOf(file);
    if (path) onPick(path);
  }, [file, viewer.rel, pathOf, onPick]);

  // A chip clicked in the agent tab: shown once the boot script can act. With
  // no Blender coming, the file it names is picked, so Open opens on it.
  const { reveal, onRevealHandled } = props;
  const revealing = useRef<number | null>(null);
  useEffect(() => {
    if (!reveal || revealing.current === reveal.n) return;
    const give = (text: string | null) => {
      if (text !== null) setNotice(text);
      onRevealHandled?.(reveal.n);
    };
    if (editor && booted) {
      revealing.current = reveal.n;
      revealInBlender(reveal, editor).then(give, (e: unknown) => {
        setProblem(errorText(e));
        give(null);
      });
    } else if (!editor && polled && settled && !starting) {
      const path = pathOf(reveal.file ?? reveal.scene ?? "");
      if (path) onPick(path);
      give(`Open Blender to show ${revealName(reveal)} in it.`);
    }
  }, [reveal, onRevealHandled, editor, booted, polled, settled, starting, pathOf, onPick]);

  const box = useNativeBox({
    frameRect: props.frameRect,
    overlays: props.overlays,
    coveredHere: pickerOpen,
    hidden: marking !== null,
    placed: embed?.kind === "embedded",
    report: (r, visible, win, dpr) => embedRect("blender", r, visible, win, dpr),
    still: () => embedStill("blender"),
    generation: editor?.pid ?? null,
  });

  const doOpen = () => void openOn(target, true);

  const doViewportOnly = () =>
    void guarded(async () => {
      const on = !(view?.fullscreen ?? false);
      await setViewportOnly(on);
      setEd((s) =>
        s?.editor?.view
          ? { ...s, editor: { ...s.editor, view: { ...s.editor.view, fullscreen: on } } }
          : s,
      );
    });

  const doSend = () =>
    void guarded(async () => {
      setSending(true);
      try {
        const cap = await editorCapture();
        if (cap.selected.length === 0) {
          setNotice("Nothing is selected in Blender. Select the objects to send, then send again.");
          return;
        }
        const { typed } = await sendSelection(cap);
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
      if (marking || !booted) return;
      await beginMarkup();
    });

  const endMarkup = () => {
    if (marking) URL.revokeObjectURL(marking.url);
    setMarking(null);
  };

  /** Done: ask Blender what each pin is on, then send it as every viewer does. */
  const doneMarkup = async (result: MarkupExport, shown: { width: number; height: number }) => {
    const m = marking;
    if (!m) return;
    await guarded(async () => {
      const json = result.json;
      await resolvePins(json, m.natural, shown, async (x, y) => (await editorPick(x, y)).hit);
      json.source = { ...json.source, engine: "blender", view: "editor", blend: m.file };
      const pose = cameraPose(m.view?.camera);
      if (pose) json.camera = pose;
      setNotice(await markupToAgent(BLENDER_TARGET, result.png, json, m.file));
    });
    endMarkup();
  };

  // Slot 2: the environment first (DECISIONS X4), then the file. The picker
  // is what Open starts Blender on, so it is fixed while Blender runs; File >
  // Open in Blender moves the file, and the subject follows.
  const subject = (
    <>
      <ToolbarEnvChip kind={viewer.environment?.kind} branch={viewer.environment?.branch} />
      {open ? (
        <span className="be__subject">
          {editor?.file ?? "unsaved file"}
          {editor?.dirty ? " •" : ""}
        </span>
      ) : viewer.blends.length > 1 ? (
        <select
          className="k-vtb__select"
          aria-label=".blend file"
          value={viewer.blend ?? ""}
          onFocus={() => setPickerOpen(true)}
          onBlur={() => setPickerOpen(false)}
          onChange={(e) => onPick(e.target.value)}
        >
          {viewer.blends.map((b) => (
            <option key={b.path} value={b.path}>
              {b.rel}
            </option>
          ))}
        </select>
      ) : (
        viewer.rel && <span className="be__subject">{viewer.rel}</span>
      )}
    </>
  );

  const selectedCount = view?.selected.length ?? 0;
  const actions = (
    <>
      <ToolbarButton
        icon={icon(Scan)}
        pressed={view?.fullscreen ?? false}
        disabled={!booted}
        title={why ?? "Show only the 3D view, filling Blender's window (Ctrl Space in Blender)"}
        onClick={doViewportOnly}
      >
        Viewport only
      </ToolbarButton>
      <ToolbarButton
        icon={icon(PenLine)}
        disabled={!booted || marking !== null || embed?.kind === "poppedOut"}
        title={
          why ??
          (embed?.kind === "poppedOut"
            ? "Mark up draws in the pane. Dock Blender first."
            : "Draw on the 3D view; pins name the object under them")
        }
        onClick={startMarkup}
      >
        Mark up
      </ToolbarButton>
      <ToolbarButton
        icon={icon(Send)}
        disabled={!booted || sending}
        title={
          why ??
          (selectedCount > 0
            ? `Send the ${selectedCount === 1 ? "selected object" : `${selectedCount} selected objects`} and the 3D view to the agent`
            : "Select objects in Blender, then send them with the 3D view to the agent")
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
    <ToolbarButton
      label={popped ? "Dock into the pane" : "Pop out into its own window"}
      disabled={!canPop}
      title={
        canPop
          ? undefined
          : open
            ? "Pop out needs Blender in the pane, and it is in its own window."
            : "Pop out needs Blender open here."
      }
      icon={icon(popped ? Maximize2 : PictureInPicture2)}
      onClick={() => void guarded(() => (popped ? dock("blender") : popOut("blender")))}
    />
  );

  const versions = viewer.rel === file ? viewer.versions : [];
  const banner = writerBanner(editor, versions);

  return (
    <div className="be" ref={root} tabIndex={-1} onKeyDown={keepReloadKeys}>
      <ViewerToolbar
        label="Blender"
        mode={modeSwitch}
        subject={subject}
        status={editorChip(ed)}
        actions={actions}
        leave={leave}
      />

      <EditorReason surface={surface} tool="blender" onError={setProblem} />

      {banner && (
        <div className="be__banner" role="note" aria-label="Who writes this file">
          <span className="be__banner-text">{banner.text}</span>
          {banner.compareWith !== null && (
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={versions.length < 2}
              title={
                versions.length < 2
                  ? COMPARE_NEEDS_TWO
                  : `What changed in v${banner.compareWith}, the newest export`
              }
              onClick={() => banner.compareWith !== null && onCompare?.(banner.compareWith)}
            >
              Compare with v{banner.compareWith}
            </button>
          )}
        </div>
      )}
      {editor?.conflict && (
        <div className="be__banner be__banner--conflict" role="note" aria-label="Open twice">
          <span className="be__banner-text">{conflictText(editor.conflict)}</span>
        </div>
      )}

      {(problem || notice) && (
        <div className="be__notices">
          {problem && <p className="be__notice be__notice--error">{problem}</p>}
          {notice && (
            <p className="be__notice">
              {notice}{" "}
              <button type="button" className="be__link" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </p>
          )}
        </div>
      )}

      <main className="be__viewport">
        <div
          className="be__box"
          ref={box.ref}
          data-embedded={embed?.kind === "embedded" || undefined}
        >
          {marking ? (
            <Suspense fallback={null}>
              <ViewportMarkup
                src={marking.url}
                path={marking.file ? `${marking.file} (Blender 3D view)` : "Blender 3D view"}
                onDone={(r, shown) => void doneMarkup(r, shown)}
                onCancel={endMarkup}
                onProblem={setProblem}
              />
            </Suspense>
          ) : !editor ? (
            <div className="be__launch">
              <p className="be__launch-title">
                {viewer.rel ? `${viewer.rel} in Blender` : "Blender"}
              </p>
              {ended && (
                <p className="be__launch-text">
                  {ended.code === null || ended.code === 0
                    ? "Blender closed."
                    : `Blender exited with code ${ended.code}.`}
                </p>
              )}
              <p className="be__launch-text">
                {!viewer.project
                  ? "Open a project to work on its .blend files in Blender."
                  : newScene
                    ? starting
                      ? "No .blend files in this environment yet, so Blender opens on a new scene. Save it here and it will appear."
                      : "No .blend files in this environment yet. Blender opens on a new scene; save it here and it will appear."
                    : heldElsewhere
                      ? `${viewer.rel} is already open in another Blender (process ${heldElsewhere.pid}). Close it there first: two Blenders on one file save over each other.`
                      : starting
                        ? "Opening it here, in this pane."
                        : surface?.surface === "popOut"
                          ? "It opens in its own window, for the reason above."
                          : "It opens here, in this pane, with its menus and dialogs inside it. Nothing is installed into your Blender."}
              </p>
              <button
                type="button"
                className="k-btn k-btn--primary"
                disabled={!launchable || starting}
                onClick={doOpen}
              >
                {starting ? "Opening…" : newScene ? "Open Blender" : "Open in Blender"}
              </button>
            </div>
          ) : embed?.kind === "embedded" ? (
            box.covered && box.stillUrl ? (
              <img className="be__still" src={box.stillUrl} alt="Blender's last frame" />
            ) : (
              <span className="be__sr">Blender is shown here.</span>
            )
          ) : (
            <p className="be__hint">
              {embed?.kind === "poppedOut"
                ? "Blender is in its own window. Dock it to bring it back here."
                : embed?.kind === "ownWindow"
                  ? surface?.surface === "embedded"
                    ? embed.reason
                    : "Blender is open in its own window."
                  : "Starting Blender…"}
            </p>
          )}
        </div>
      </main>

      <footer className="be__footer">{footerText(ed, viewer.blender.version)}</footer>
    </div>
  );
}

/**
 * F5 and Ctrl R on the pane are WebView2's reload, which would unload Editor
 * mode under a running Blender. Blender's own keys go to its window, not here.
 */
function keepReloadKeys(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
}
