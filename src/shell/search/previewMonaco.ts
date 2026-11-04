/**
 * The only module in this directory that touches `monaco-editor`.
 *
 * `PreviewPane.tsx` reads as a React component and a state machine; everything
 * Monaco-shaped — the worker environment, the language registrations, the
 * theme, and the handful of factory functions the pane needs — lives here,
 * mirroring the split `apps/files/ui/src/viewer/monaco.ts` draws for the same
 * reason (see that file's header).
 *
 * `docs/design-notes/shell-search.md` records what was taken from `DiffView.tsx`
 * and from Files' `monaco.ts`.
 *
 * Imported from `monaco-editor/editor/editor.api`, not `.../editor.main`, for
 * the reason DiffView's header gives: `editor.main` registers every bundled
 * language and the full IntelliSense infrastructure as an import side effect,
 * none of which a read-only preview needs.
 */
import * as monaco from "monaco-editor/editor/editor.api";

/**
 * A curated set of languages, one `register.js` each — ported from the list in
 * `apps/files/ui/src/viewer/monaco.ts`, minus two of its entries.
 *
 * Each registers an id and a *lazy* loader, so a grammar is only fetched the
 * first time a file of that language is previewed.
 *
 * Unlike Files' list there is no `features/register.all`: a read-only glance
 * pane needs no find widget, context menu, folding or multi-cursor.
 *
 * TOML, GDScript and Godot's resource format are absent because they are not
 * Monaco's — see `registerLanguages` below.
 */
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/ini/register";

/**
 * JSON, kept in even though it costs its own worker chunk. There is no
 * `languages/definitions/json` — as Files' header explains, this import *is*
 * how the `json` language id comes to exist, and it brings a real language
 * service (validation, hover, folding) with it, not just a tokenizer. More than
 * a preview needs, but there is no lighter path to JSON syntax colour in this
 * Monaco build, and `package.json`/`tsconfig.json` are common enough hits that
 * flat text would be a visible gap. The extra chunk is lazy — fetched only the
 * first time a `.json` file is previewed — so nothing pays for it until then.
 */
import { jsonDefaults } from "monaco-editor/languages/features/json/register";

import { registerLanguages } from "@veistra/monaco-languages";
import { monacoThemeData } from "@veistra/bridge/theme";
import { onThemeChange } from "../themeBroadcast";

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";

/**
 * Two workers, dispatched by label — ported verbatim from Files' `monaco.ts`.
 * Files' header explains why this can't be simplified to one worker: the moment
 * `MonacoEnvironment.getWorker` exists it wins unconditionally over whatever a
 * language service would otherwise supply, so a single generic worker doesn't
 * just skip JSON's features, it hangs the first request for one of them.
 * Module-scoped, like DiffView's, so it is set once when this chunk evaluates.
 */
self.MonacoEnvironment = {
  getWorker: (_workerId, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

/**
 * No schema fetching, ever — same setting, same reasoning, as Files' copy: a
 * desktop app previewing a JSON file should not quietly reach the network for
 * its `$schema`. Structural validation still runs; only remote resolution is
 * off.
 */
jsonDefaults.setDiagnosticsOptions({
  ...jsonDefaults.diagnosticsOptions,
  enableSchemaRequest: false,
});

/**
 * TOML, GDScript and Godot's `.tscn`/`.tres` format, which Monaco does not ship
 * at all. TOML matters more than its file count suggests: `veistra.toml` and
 * `<project>.veistra` are the format behind an entire quarter of the search
 * filter — the Veistra kind in
 * `./kinds.ts` is, today, exactly these two files — so flat grey text would
 * have made the one file type this product names after itself the one file type
 * it could not colour.
 *
 * `registerLanguages` is idempotent by design; `@veistra/monaco-languages`'s header
 * explains why that guard exists rather than being belt-and-braces:
 * `diff/DiffView.tsx` calls it too, and shares this module's JS context.
 */
registerLanguages(monaco);

/**
 * Extension → language id, restated from `LANGUAGE_BY_EXTENSION` in Files'
 * `monaco.ts` and pruned to the languages actually registered above. Keys are
 * lowercase and dot-less. Anything absent gets no language and renders as plain
 * text — a wrong grammar would be worse than none, same rule Files' table
 * states for itself.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  rs: "rust",

  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",

  md: "markdown",
  markdown: "markdown",

  py: "python",

  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",

  sh: "shell",
  bash: "shell",
  zsh: "shell",

  yml: "yaml",
  yaml: "yaml",

  json: "json",

  ini: "ini",
  cfg: "ini",

  /**
   * TOML, and Veistra's own marker with it. `<project>.veistra` *is* TOML —
   * `project/marker.rs` reads one with `raw.parse::<toml::Table>()` — so the
   * extension is Veistra's and the format is not, which is why one grammar
   * serves both rather than there being a second to keep in step.
   */
  toml: "toml",
  veistra: "toml",

  gd: "gdscript",
  tscn: "godot-resource",
  tres: "godot-resource",
  godot: "godot-resource",
  import: "godot-resource",
};

/** The Monaco language id for a file, or `undefined` for plain text. */
function languageFor(extension: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extension];
}

/**
 * The preview's theme name, deliberately not `veistra-dark`: DiffView registers
 * that one in the same JS context, and two definitions of one name would let
 * whichever evaluates second win for both.
 */
export const THEME = "veistra-preview-dark";

/** Redefined on every theme or accent change; Monaco cannot take `var()`. */
function defineAccentTheme(): void {
  monaco.editor.defineTheme(THEME, {
    ...monacoThemeData(),
    inherit: true,
    rules: [],
  });
  monaco.editor.setTheme(THEME);
}

defineAccentTheme();
// The accent is a setting; the theme above baked in whatever it was at load.
onThemeChange(() => defineAccentTheme());

/** What `PreviewPane.tsx` holds without importing Monaco itself. */
export type PreviewModel = monaco.editor.ITextModel;
export type PreviewEditor = monaco.editor.IStandaloneCodeEditor;
export type PreviewDecorations = monaco.editor.IEditorDecorationsCollection;

/**
 * A model for one file's text, keyed by its path. Ported from Files'
 * `createModel`, including its reuse guard: Monaco refuses to create a second
 * model at a URI that already has one, which would throw mid-swap if a previous
 * model's disposal were ever missed. That can only happen if a caller skips the
 * dispose step `PreviewPane.tsx`'s effect cleanup performs, so the guard is a
 * safety net, not the expected path.
 */
export function createPreviewModel(text: string, path: string, extension: string): PreviewModel {
  const uri = monaco.Uri.file(path);
  const language = languageFor(extension);

  const existing = monaco.editor.getModel(uri);
  if (existing) {
    existing.setValue(text);
    if (language) monaco.editor.setModelLanguage(existing, language);
    return existing;
  }

  return monaco.editor.createModel(text, language, uri);
}

/**
 * The model the editor is mounted over before any file has been focused, and
 * again between a new focus starting to load and its text arriving.
 *
 * Deliberately not `createPreviewModel("", "", "")` — an empty path would give
 * every unfocused pane the same `file:///` URI, and the first real file
 * previewed would collide with it under `createPreviewModel`'s reuse guard.
 * `createModel` with no URI makes an anonymous `inmemory://` model that can
 * never collide with a real path, which is what a placeholder should be.
 */
export function createEmptyPreviewModel(): PreviewModel {
  return monaco.editor.createModel("", "plaintext");
}

/**
 * Mount an editor over an existing model. The model is passed in, never built
 * from a string, so the caller decides its lifetime — see `PreviewPane.tsx`'s
 * disposal-order comment for why that matters.
 *
 * `readOnly` and `domReadOnly` both `true`, always — no path here ever sets
 * either to `false`. `domReadOnly` is the one DiffView's header need not
 * mention (a diff editor has no caret to blink); without it a read-only pane
 * still shows a blinking caret, which reads as "type here" for a pane that
 * refuses every keystroke.
 *
 * Minimap off, matching DiffView rather than Files: this pane sits in the
 * overlay's lower-right region, not a full-width tab, and a minimap is a
 * distraction at that width for a reader glancing at one match.
 */
export function mountPreviewEditor(container: HTMLElement, model: PreviewModel): PreviewEditor {
  return monaco.editor.create(container, {
    model,
    theme: THEME,
    readOnly: true,
    domReadOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: readToken("--mono") || "monospace",
    fontSize: 12,
    renderLineHighlight: "line",
    // A source file's own line breaks are information a preview must not
    // misreport by re-flowing them. Same rule, same value, as Files' editor.
    wordWrap: "off",
  });
}

/** Scroll to and highlight one match, replacing whatever the previous
 *  decoration was. `column` and `length` are 1-based and character-counted the
 *  way `SearchMatch` documents them, which is exactly what `monaco.Range`
 *  expects for a single-line range, so no translation happens here. */
export function revealMatch(
  editor: PreviewEditor,
  match: { line: number; column: number; length: number },
): PreviewDecorations {
  editor.revealLineInCenter(match.line);
  return editor.createDecorationsCollection([
    {
      range: new monaco.Range(match.line, match.column, match.line, match.column + match.length),
      options: {
        className: "preview-pane__match",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]);
}

/** Open at the top — the match-free counterpart to `revealMatch`. */
export function revealTop(editor: PreviewEditor): void {
  editor.setScrollPosition({ scrollTop: 0 });
}

/** One CSS custom property off the root element, trimmed. `""` if unset. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
