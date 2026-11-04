/**
 * A read-only diff, rendered with Monaco's `DiffEditor` — two columns by
 * default, one interleaved column when `renderSideBySide` is false.
 *
 * Mounted by the source-control panel (`worktree/SourceControlView.tsx`),
 * which imports it lazily: this module pulls in Monaco and its worker chunk on
 * evaluation, and the panel is mounted for the life of the window whether or
 * not anyone opens a diff. The `lazy` boundary there keeps that cost on the
 * first click rather than on startup.
 *
 * Why the import below is `editor.api` and not `.../editor.main`, why `"toml"`
 * is consequently the only language this editor tokenizes and why that is the
 * shape of the fix rather than an oversight, and how chunks are shared with the
 * Files app's Monaco: docs/design-notes/shell-worktree.md, under this path.
 */
import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { registerLanguages } from "@veistra/monaco-languages";
import { hexWithAlpha, monacoThemeData } from "@veistra/bridge/theme";
import { onThemeChange } from "../themeBroadcast";
import { anchorFor, countLabel, markAtLine, type LineDecoration } from "./reviewComments";
import "./diff.css";

// One worker, wired here rather than in a global entry file — this module and
// its worker chunk are evaluated only once something imports `DiffView`, so
// nothing pays for Monaco until the diff view is used. `ts` / `json` / `css` /
// `html` workers are deliberately not wired: this is a read-only diff, not a
// language service, and each is its own multi-hundred-KB chunk on top of this.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// TOML, GDScript and Godot's resource format — the hand-written grammars, and
// the only languages this editor can tokenize. See the file header for why
// Monaco's bundled ones are deliberately absent.
//
// Idempotent: `search/previewMonaco.ts` calls this too and is shell-side like
// this module, so both chunks can be live in one JS context and would
// otherwise register the same id twice against one global registry. The guard
// lives in `@veistra/monaco-languages` so neither caller has to remember.
registerLanguages(monaco);

// Defined once at module scope, not per-mount — `defineTheme` writes into
// Monaco's global theme registry, so redefining it on every DiffView mount
// would be repeated work for no visual change.
//
// Every colour below is lifted from src/tokens.css, and the four diff colours
// must be 8-digit hex, never `rgba(...)`: Monaco parses a theme colour with
// `parseHex(hex) || Color.red`, so a perfectly valid CSS `rgba()` string
// silently becomes opaque red. Which token each reuses, and how that bug went
// unseen, are in the design note named in the file header.
function defineDiffTheme(): void {
  const { base, colors } = monacoThemeData();
  monaco.editor.defineTheme("veistra-dark", {
    base,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": colors["editor.background"],
      "editor.foreground": colors["editor.foreground"],
      "diffEditor.insertedLineBackground": hexWithAlpha(tokenValue("--ok"), 0.08), // --ok, wash alpha
      "diffEditor.insertedTextBackground": hexWithAlpha(tokenValue("--ok"), 0.25), // --ok
      "diffEditor.removedLineBackground": hexWithAlpha(tokenValue("--err"), 0.08), // --err, wash alpha
      "diffEditor.removedTextBackground": hexWithAlpha(tokenValue("--err"), 0.25), // --err
    },
  });
  monaco.editor.setTheme("veistra-dark");
}

function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

defineDiffTheme();
// The light/dark choice is a setting; redefine so a switch reaches open diffs.
onThemeChange(() => defineDiffTheme());

/**
 * What a caller has to supply for this diff to be annotatable, and what it gets
 * back. Absent — the default — and the editor behaves exactly as it did before
 * annotations existed: no glyph margin, no listeners, no decorations.
 *
 * Every line number here is 1-based and names the **modified** side, which is
 * the side an inline diff actually shows and the only side a note can anchor to
 * (`review::ReviewComment`).
 */
export interface DiffAnnotations {
  /** One entry per distinct annotated range — `reviewComments.decorations`. */
  marks: LineDecoration[];
  /** The range the notes panel is currently focused on, drawn stronger than the
   *  rest. `null` when nothing is selected or being composed. */
  active: { startLine: number; endLine: number } | null;
  /** The user asked to annotate a range, by clicking the margin. */
  onAnchor: (anchor: { startLine: number; endLine: number }) => void;
  /** The user clicked the marker on a range that already carries notes. */
  onPick: (mark: LineDecoration) => void;
  /** The caret or selection moved. Reported so the notes panel's own "add"
   *  button can anchor to whatever is selected without reaching into the editor
   *  — which it could not do anyway, since the editor is this module's. */
  onSelection: (anchor: { startLine: number; endLine: number }) => void;
  /** Scroll a line into view. The `nonce` is what makes asking twice for the
   *  same line work: without it, clicking the same note after scrolling away
   *  would be a no-op prop change and nothing would move. */
  reveal: { line: number; nonce: number } | null;
}

export interface DiffViewProps {
  original: string;
  modified: string;
  /** Passed straight to Monaco's model, but only `@veistra/monaco-languages`'
   *  grammars (TOML, GDScript, Godot resources) tokenize here; everything else
   *  renders as plain text until someone decides this editor should carry
   *  Monaco's bundled grammars. That package's `languageIdForPath` is how a
   *  caller with a path and no Monaco import decides. */
  language?: string;
  /** Two columns, or one with removals and additions interleaved. Defaults to
   *  two because that is what a diff opened in the tool window wants. The
   *  source-control panel passes `false`: it is `--w-panel-default` (380px)
   *  wide, and two columns of code in half of that wraps every meaningful line
   *  — the same reason VS Code's SCM view flips to inline when docked narrow. */
  renderSideBySide?: boolean;
  /** Absent for a plain read-only diff, which is what every caller wanted
   *  before review notes existed and what `worktree/CommitGraph`'s history
   *  diffs still want. See [`DiffAnnotations`]. */
  annotations?: DiffAnnotations;
}

export default function DiffView({
  original,
  modified,
  language,
  renderSideBySide = true,
  annotations,
}: DiffViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * The modified-side editor, as state rather than a ref.
   *
   * A ref would be written during the creation effect and never re-render, so
   * the decoration and listener effects below would run once against `null` and
   * never again. State is what makes them run a second time with an editor in
   * hand. It is set to `null` on teardown for the same reason — those effects
   * have to know the widget they captured is gone.
   */
  const [editor, setEditor] = useState<monaco.editor.ICodeEditor | null>(null);

  /**
   * The callbacks, held in a ref so the listener effect does not re-attach on
   * every parent render. Callers pass inline arrows — `annotations` is a fresh
   * object each time — and re-attaching Monaco listeners at that rate would
   * drop a mousedown that landed mid-swap.
   */
  const handlers = useRef(annotations);
  handlers.current = annotations;

  // Re-created whenever the text changes rather than fed through `setValue` —
  // a diff view has no caret or selection worth preserving across an
  // `original`/`modified` swap, so an in-place update buys nothing.
  //
  // `annotations` is deliberately not a dependency. It changes on every note
  // added, and rebuilding the editor for that would throw away the scroll
  // position mid-review; the effects below reach the live widget instead.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const diffEditor = monaco.editor.createDiffEditor(container, {
      theme: "veistra-dark",
      readOnly: true,
      automaticLayout: true,
      renderSideBySide,
      minimap: { enabled: false },
      // The margin the note markers and the hover affordance are drawn in.
      // Always on rather than switched by `annotations`, because turning it on
      // later would resize the editor under a reader mid-scroll — and an empty
      // margin is a few pixels, which is cheaper than that.
      glyphMargin: true,
    });

    diffEditor.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    });

    setEditor(diffEditor.getModifiedEditor());

    // Disposing the diff editor does not dispose the two models it was handed
    // — Monaco assumes a model may be shared or reused elsewhere. These were
    // created fresh above for this instance alone, so they are ours to dispose
    // too, or they leak on every unmount.
    //
    // Order matters, and not subtly: the widget listens for its own models
    // being disposed, and disposing one while it is still attached throws
    // "TextModel got disposed before DiffEditorWidget model got reset" out of
    // an event handler on every close. Detaching first makes the disposals
    // below unobserved, which is what lets them be ours to make.
    return () => {
      setEditor(null);
      const model = diffEditor.getModel();
      diffEditor.setModel(null);
      model?.original.dispose();
      model?.modified.dispose();
      diffEditor.dispose();
    };
  }, [original, modified, language, renderSideBySide]);

  useNoteMarkers(editor, annotations);
  useMarginInput(editor, handlers, annotations !== undefined);
  useReveal(editor, annotations?.reveal ?? null);

  return <div ref={containerRef} className="diff" />;
}

/**
 * Draw a marker beside every annotated range, and wash the active one.
 *
 * A `DecorationsCollection` rather than the older `deltaDecorations`: the
 * collection owns its own ids, so replacing the set is one `set` call and
 * unmounting is one `clear`, with no array of stale ids to carry between
 * renders and get wrong.
 *
 * Two collections, not one. The markers change when a note is written; the wash
 * changes when the selection moves, which is far more often. Keeping them apart
 * means moving the caret does not re-issue every marker in the file.
 */
function useNoteMarkers(
  editor: monaco.editor.ICodeEditor | null,
  annotations: DiffAnnotations | undefined,
) {
  const marks = annotations?.marks;
  const active = annotations?.active ?? null;

  useEffect(() => {
    if (!editor || !marks) return;

    const collection = editor.createDecorationsCollection(
      marks.map((mark) => ({
        range: new monaco.Range(mark.startLine, 1, mark.endLine, 1),
        options: {
          isWholeLine: true,
          className: "diff__noted-line",
          glyphMarginClassName: "diff__noted-glyph",
          glyphMarginHoverMessage: {
            value: `${countLabel(mark.comments.length)} on ${
              mark.startLine === mark.endLine
                ? `line ${mark.startLine}`
                : `lines ${mark.startLine}-${mark.endLine}`
            }`,
          },
        },
      })),
    );

    return () => collection.clear();
  }, [editor, marks]);

  useEffect(() => {
    if (!editor || !active) return;

    const collection = editor.createDecorationsCollection([
      {
        range: new monaco.Range(active.startLine, 1, active.endLine, 1),
        options: { isWholeLine: true, className: "diff__active-line" },
      },
    ]);

    return () => collection.clear();
  }, [editor, active]);
}

/**
 * The glyph margin as an input surface: hover shows where a note would go,
 * clicking puts one there or opens the ones already on that line.
 *
 * The margin rather than a floating button over the code, which is what a wider
 * editor would use. This diff is mounted in a panel whose default width is 380
 * pixels, and a button that overlays the text at that width covers the code the
 * note is about at the exact moment somebody is reading it to decide what to
 * write.
 */
function useMarginInput(
  editor: monaco.editor.ICodeEditor | null,
  handlers: React.RefObject<DiffAnnotations | undefined>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!editor || !enabled) return;

    // Imperative rather than React state: this changes on every line the
    // pointer crosses, and a re-render of the whole panel per line would be an
    // absurd price for one glyph.
    const hover = editor.createDecorationsCollection([]);

    const showHover = (line: number | null) => {
      hover.set(
        line === null
          ? []
          : [
              {
                range: new monaco.Range(line, 1, line, 1),
                options: { isWholeLine: true, glyphMarginClassName: "diff__add-glyph" },
              },
            ],
      );
    };

    // A line that already carries a note keeps its own marker and gets no plus.
    // Monaco merges decorations rather than letting one win, so without this the
    // two glyph classes paint into the same twelve-pixel cell and a noted line
    // grows a plus through its dot on hover.
    const moved = editor.onMouseMove((event) => {
      const line = event.target.position?.lineNumber ?? null;
      const noted = line !== null && markAtLine(handlers.current?.marks ?? [], line) !== undefined;
      showHover(noted ? null : line);
    });
    const left = editor.onMouseLeave(() => showHover(null));

    const pressed = editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      const current = handlers.current;
      if (line === undefined || !current) return;

      // An existing marker opens what is already there. Adding a second note to
      // a line people have already written on is done from the notes panel,
      // where the first one is visible — offering both on one click would make
      // the commoner action (read it) a guess.
      const existing = current.marks.find((mark) => line >= mark.startLine && line <= mark.endLine);
      if (existing) {
        current.onPick(existing);
        return;
      }

      // A click inside a selection annotates the whole selection; a click
      // anywhere else annotates its own line. Without the containment test, a
      // stale selection somewhere else in the file would silently capture a
      // note the person aimed at line 12.
      const selection = editor.getSelection();
      const anchor =
        selection &&
        !selection.isEmpty() &&
        line >= selection.startLineNumber &&
        line <= selection.endLineNumber
          ? anchorFor(selection)
          : { startLine: line, endLine: line };

      current.onAnchor(anchor);
    });

    const selected = editor.onDidChangeCursorSelection((event) => {
      handlers.current?.onSelection(anchorFor(event.selection));
    });

    return () => {
      moved.dispose();
      left.dispose();
      pressed.dispose();
      selected.dispose();
      hover.clear();
    };
  }, [editor, handlers, enabled]);
}

/**
 * Scroll a line into view when the notes panel asks.
 *
 * `revealLineInCenterIfOutsideViewport`, not the unconditional centre: clicking
 * a note whose line is already on screen should leave the diff exactly where it
 * is. Jumping it to the middle would move the code out from under a reader who
 * could already see it.
 */
function useReveal(
  editor: monaco.editor.ICodeEditor | null,
  reveal: { line: number; nonce: number } | null,
) {
  const line = reveal?.line;
  const nonce = reveal?.nonce;

  useEffect(() => {
    if (!editor || line === undefined) return;
    editor.revealLineInCenterIfOutsideViewport(line);
    // `nonce` is in the dependencies and unused in the body on purpose — it is
    // what makes a repeat request for the same line run again. See
    // `DiffAnnotations.reveal`.
  }, [editor, line, nonce]);
}
