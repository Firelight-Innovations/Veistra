/**
 * The only module in this app that touches `monaco-editor`.
 *
 * Everything Monaco-shaped is here, so `TextViewer.tsx` reads as a React
 * component and nothing else in `apps/files/` imports Monaco at all (bar a
 * type-only import in `tabs/useOpenFiles.ts`).
 *
 * Nothing may import this module statically from anything reachable at load:
 * the only runtime path is the dynamic `import()` behind the `text` viewer in
 * `registry.ts`. What it deliberately omits, and why, is in
 * `docs/design-notes/viewer-renderers.md`.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import type { GitHunk } from "./gitHunks";
import { loadSettings, type SettingsReader } from "../settings";

/**
 * Every editor contribution Monaco ships. `editor.api` alone has no
 * find/replace, no context menu, no folding, no bracket matching, no
 * multi-cursor, no comment toggle, no clipboard actions and no Alt+↑/↓ — none of
 * which are optional in a text editor.
 *
 * The whole barrel is a *measured* decision, not the lazy one. **DO NOT REDO
 * THIS EXPERIMENT**: curating the list saved 419 kB off `TextViewer` and put
 * almost exactly that much back into `jsonMode`, for +5.45 kB in total. The
 * numbers, the ten contributions dropped, the trade refused, and what would
 * actually move this figure are in `docs/design-notes/viewer-renderers.md`.
 */
import "monaco-editor/features/register.all";

/**
 * A curated set of languages, one `register.js` each. Each registers an id and a
 * *lazy* loader, so the grammar itself is a chunk fetched the first time a file
 * of that language opens: listing one here costs a few hundred bytes, not a
 * grammar, and adding a language is one line here plus one row in
 * `LANGUAGE_BY_EXTENSION`. `javascript` is its own entry — the `typescript`
 * definition registers only the `typescript` id, and a `.js` file left to it
 * gets no highlighting at all. (Verified by reading both `register.js` files.)
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
 * JSON is the exception: a real language service, not just a tokenizer. There is
 * no `languages/definitions/json` — this module *is* how the `json` id comes to
 * exist, and it brings validation, hover, completion, folding, colour decorators
 * and formatting with it. Worth its worker for a file editor whose users open
 * `package.json` and `tsconfig.json` daily.
 */
import { jsonDefaults } from "monaco-editor/languages/features/json/register";

import { registerLanguages } from "@veistra/monaco-languages";
import { monacoThemeData, onThemeChanged } from "@veistra/bridge/theme";

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";

/**
 * Two workers, dispatched by label.
 *
 * The moment `MonacoEnvironment.getWorker` exists it wins **unconditionally**:
 * `internal/common/workers.js` checks it before ever looking at the
 * `createWorker` a language service supplied. So a single-worker environment
 * does not merely skip the JSON service, it actively breaks it — the first JSON
 * hover, completion, colour decorator or folding request is handed the generic
 * editor worker, which has no `jsonWorker` module, and never settles.
 * `diagnosticsOptions.validate: false` does not prevent that; the other nine
 * `modeConfiguration` flags all default to true. The rejected one-worker
 * alternative, and why two JSON worker chunks in the build are expected rather
 * than a bug, are in `docs/design-notes/viewer-renderers.md`.
 */
self.MonacoEnvironment = {
  getWorker: (_workerId, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

/**
 * No schema fetching, ever. `false` is already the default, pinned here because
 * it is a network-egress property rather than a preference: a desktop file
 * editor that quietly fetched `$schema` URLs off the internet whenever someone
 * opened a JSON file would be doing something its user did not ask for.
 * Structural validation still works; only remote schema resolution is off.
 */
jsonDefaults.setDiagnosticsOptions({
  ...jsonDefaults.diagnosticsOptions,
  enableSchemaRequest: false,
});

/**
 * TOML, GDScript and Godot's scene/resource format, none of which Monaco ships.
 *
 * The grammars live in `@veistra/monaco-languages` because three editors in
 * Veistra need them and `src/` and `apps/files/` may not import each other — a
 * package is the only ground all three can stand on. Called here rather than at
 * import time inside the package, so the rule at the top of this file holds:
 * the package touches `monaco-editor` only as a type.
 */
registerLanguages(monaco);

/**
 * The editor theme. Every colour comes from the live `src/tokens.css` values
 * via `monacoThemeData` in `@veistra/bridge/theme` (base `vs` in light,
 * `vs-dark` in dark), as 8-digit `#RRGGBBAA`: `Color.fromHex` silently returns
 * opaque red for `rgba()`. Named like `src/shell/diff/DiffView.tsx`'s copy;
 * the two never load together.
 */
export const THEME = "veistra-dark";

/** Redefined on every theme or accent change; Monaco cannot take `var()`. */
function defineAccentTheme(): void {
  monaco.editor.defineTheme(THEME, {
    ...monacoThemeData(),
    inherit: true, // syntax token colours come from the vs / vs-dark base
    rules: [],
  });
  monaco.editor.setTheme(THEME);
}

defineAccentTheme();
// Redefine when the accent changes.
onThemeChanged(() => defineAccentTheme());

/** What a caller may hold without importing Monaco itself. See the header. */
export type TextModel = monaco.editor.ITextModel;
export type CodeEditor = monaco.editor.IStandaloneCodeEditor;
export type EditorViewState = monaco.editor.ICodeEditorViewState;

/**
 * Extension → language id, the one place a filename becomes a grammar. Keys are
 * lowercase and dot-less, matching `extensionOf` in `../rpc`. Anything absent
 * gets no language and renders as plain text, the correct answer for a file this
 * app has no grammar for — a wrong grammar is worse than none.
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
   * TOML, and Veistra's own two files with it. These used to point at `ini` as an
   * admitted stand-in; they now point at a real grammar.
   *
   * `veistra` is in this table rather than left to the plaintext fallback because
   * a `<project>.veistra` marker *is* TOML: `project/marker.rs` reads one with
   * `raw.parse::<toml::Table>()`, and `create` writes one with `[veistra]` and
   * `[project]` tables in it. The extension is Veistra's; the format is not, and
   * pretending otherwise would mean a second grammar to keep in step with this
   * one. It is also the pairing that makes the icon work land: `.veistra` gets the
   * Veistra glyph from `packages/file-icons/src/index.ts` *and* the colour of the
   * format it actually is.
   */
  toml: "toml",
  veistra: "toml",

  /**
   * Godot: scripts, and the one text format scenes, resources, `project.godot`
   * and `.import` sidecars share. Grammars from `@veistra/monaco-languages`.
   */
  gd: "gdscript",
  tscn: "godot-resource",
  tres: "godot-resource",
  godot: "godot-resource",
  import: "godot-resource",
};

/** The Monaco language id for a file, or `undefined` for plain text. */
export function languageFor(extension: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extension];
}

/**
 * The buffer behind one open tab, given a `file:` URI so that anything keyed on
 * document identity — JSON's `fileMatch` associations, and any future language
 * service — sees a real path rather than an anonymous `inmemory://` model. The
 * caller owns the result and must `dispose()` it; see `useOpenFiles.ts`.
 */
export function createModel(text: string, path: string, extension: string): TextModel {
  const uri = monaco.Uri.file(path);
  const language = languageFor(extension);

  // Monaco refuses to create a second model at the same URI, and would throw in
  // the middle of opening a file. That can only happen if a dispose was missed,
  // and re-using the model beats a stack trace: the text is replaced either way.
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    existing.setValue(text);
    if (language) monaco.editor.setModelLanguage(existing, language);
    return existing;
  }

  return monaco.editor.createModel(text, language, uri);
}

/**
 * Point an existing model's language at a different extension.
 *
 * Exists for renames. `documents.rekey` moves a live buffer to a new path
 * without disposing it — which is what makes a rename keep unsaved changes and
 * undo history — but the model was given its language when it was created, so
 * renaming `notes.txt` to `notes.md` leaves Markdown tokenized as plain text
 * until the tab is closed and opened again. Falls back to `plaintext` rather
 * than leaving the old language in place: the same argument
 * `LANGUAGE_BY_EXTENSION` makes for a wrong grammar being worse than none. The
 * model's *URI* still says the old path, and there is no API to change it; see
 * `rekey` for why that is survivable today.
 */
export function retargetModel(model: TextModel, extension: string): void {
  monaco.editor.setModelLanguage(model, languageFor(extension) ?? "plaintext");
}

/**
 * The `editor.*` settings group, in the vocabulary Monaco takes. A value rather
 * than a live view: every row in the group is declared
 * `Applies::Next { what: "the next editor you open" }`, and the editor keeps
 * what it was built with until it is reopened; see {@link mountEditor}.
 */
export interface EditorSettings {
  fontSize: number;
  /** What the user named, with `--mono`'s stack behind it. See {@link fontStack}. */
  fontFamily: string;
  tabSize: number;
  wordWrap: "on" | "off";
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative";
  renderWhitespace: "none" | "boundary" | "all";
}

/** The two select settings' options, which are Monaco's own vocabulary. */
const LINE_NUMBER_MODES = ["on", "off", "relative"] as const;
const WHITESPACE_MODES = ["none", "boundary", "all"] as const;

/** One of `options`, or `fallback` for a string that is not one of them. */
function oneOf<T extends string>(value: string, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

/**
 * The editor settings, fetched once and shared by every editor this frame mounts.
 *
 * Read here rather than threaded down from `App.tsx`: this is the only module
 * that knows what a Monaco option is called, and the alternative puts `editor.*`
 * keys in two more files with no other reason to know they exist. The caller
 * awaits this and hands the result to {@link mountEditor}, which stays
 * synchronous — an editor is created inside an effect whose cleanup disposes it,
 * and an `await` there is a mount that can outlive its unmount.
 */
export function loadEditorSettings(): Promise<EditorSettings> {
  return loadSettings().then(editorSettingsFrom);
}

/**
 * Each key with the value this pane drew before the setting existed. `fontSize`,
 * `wordWrap`, the font stack and the minimap had literals below and keep them;
 * the other three were left to Monaco's own defaults and take the schema's
 * instead, so a settings read that failed still lands somewhere the settings
 * screen would agree with — the one visible difference being `renderWhitespace`,
 * whose Monaco default `"selection"` the schema does not offer at all.
 */
function editorSettingsFrom(settings: SettingsReader): EditorSettings {
  return {
    fontSize: settings.number("editor.fontSize", 12),
    fontFamily: fontStack(settings.choice("editor.fontFamily", "")),
    tabSize: settings.number("editor.tabSize", 2),
    wordWrap: settings.toggle("editor.wordWrap", false) ? "on" : "off",
    minimap: settings.toggle("editor.minimap", true),
    lineNumbers: oneOf(settings.choice("editor.lineNumbers", "on"), LINE_NUMBER_MODES, "on"),
    renderWhitespace: oneOf(
      settings.choice("editor.renderWhitespace", "none"),
      WHITESPACE_MODES,
      "none",
    ),
  };
}

/**
 * The named font, with the product's own monospace stack behind it.
 *
 * Appended rather than substituted: a font this machine does not have has to
 * degrade to the rest of the product's monospace rather than to whatever the
 * webview would pick, the same promise the schema's description makes. The stack
 * is read from the token rather than restated — that is what the literal this
 * replaces was for — falling back to the generic family only if tokens.css
 * somehow did not load.
 */
function fontStack(named: string): string {
  const stack = readToken("--mono") || "monospace";
  if (named === "") return stack;
  // Quoted, so a family name with a space or comma cannot break the list it is
  // prepended to. Quotes and backslashes are dropped rather than escaped,
  // neither being legal inside a CSS family name in the first place.
  return `"${named.replace(/["\\]/g, "")}", ${stack}`;
}

/**
 * Mount an editor over an existing model.
 *
 * The model is passed in rather than created from `value`, which is what makes a
 * tab's undo history and view state outlive its viewer: a standalone editor
 * disposes only the model it created itself, so `dispose()` here leaves the
 * caller's model alone.
 *
 * `settings` is read at construction and never pushed at a live editor
 * afterwards. `editor.updateOptions()` would make *this* editor follow a change
 * and leave every other mounted frame on what it was built with, turning
 * "applies to the next editor you open" — the label the settings screen draws
 * under every one of these rows — into a lie for whichever pane happened to be
 * in front. When a channel exists that pushes `settings:changed` into a mounted
 * app frame, this is where it lands. Why `automaticLayout` is on, and why the
 * minimap's other three options are fixed here rather than exposed, is in
 * `docs/design-notes/viewer-renderers.md`.
 */
export function mountEditor(
  container: HTMLElement,
  model: TextModel,
  readOnly: boolean,
  settings: EditorSettings,
): CodeEditor {
  return monaco.editor.create(container, {
    model,
    theme: THEME,
    readOnly,
    // Without this a read-only editor still shows a blinking caret, which
    // reads as "type here" for a pane that will refuse every keystroke.
    domReadOnly: readOnly,
    automaticLayout: true,
    minimap: {
      enabled: settings.minimap,
      renderCharacters: false,
      maxColumn: 80,
      showSlider: "mouseover",
    },
    scrollBeyondLastLine: false,
    // Room for the floating Code | Preview | Steps switch above line 1.
    padding: { top: 36 },
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    // `detectIndentation` is left at Monaco's default `true`, which is not a
    // contradiction: it only overrides this when the file's own indentation is
    // spaces, and how wide a *tab* is drawn is the only thing this setting can
    // be about.
    tabSize: settings.tabSize,
    lineNumbers: settings.lineNumbers,
    renderWhitespace: settings.renderWhitespace,
    renderLineHighlight: "line",
    // A source file's own line breaks are information and re-flowing them
    // misreports what the file says, which is why `editor.wordWrap` ships off.
    // Same rule, and the same default, as `.app__code`.
    wordWrap: settings.wordWrap,
  });
}

/**
 * Bind Ctrl+S inside the editor. `KeyMod.CtrlCmd` is Monaco's own name for the
 * platform's primary modifier, which on Windows — the only platform Veistra ships
 * on — is Ctrl.
 *
 * Needed on top of the document-level handler in `App.tsx`: Monaco's keybinding
 * service consumes keydown at the editor's own DOM node and stops it
 * propagating, so with focus in the editor the document listener never sees it.
 * `saveDocument` de-duplicates concurrent calls anyway, so the two firing
 * together are harmless, not a double write.
 */
export function bindSave(editor: CodeEditor, run: () => void): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, run);
}

/**
 * Ctrl+Shift+V and Ctrl+K V, inside the editor, for a file that has a rendered
 * form.
 *
 * Bound on the editor rather than left to the frame's document listener because
 * Monaco takes the keystroke first: Ctrl+Shift+V would otherwise reach its
 * hidden textarea as a plain-text paste, and Ctrl+K is the prefix of its own
 * chords. Registered as *actions* rather than bare commands so they also appear
 * in the editor's context menu and F1 palette under the names VS Code uses.
 * Called only for previewable files; a `.rs` keeps Ctrl+Shift+V as paste.
 */
export function bindPreview(
  editor: CodeEditor,
  run: { toggle: () => void; toggleSide: () => void },
): void {
  editor.addAction({
    id: "veistra.preview.toggle",
    label: "Open Preview",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.5,
    run: () => run.toggle(),
  });
  editor.addAction({
    id: "veistra.preview.side",
    label: "Open Preview to the Side",
    keybindings: [
      monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyCode.KeyV),
    ],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.6,
    run: () => run.toggleSide(),
  });
}

/**
 * The Monaco language id for a Markdown fence's info word (`ts`, `python`,
 * `sh`…), or `undefined` when none of the registered languages claims it.
 */
function languageForFence(word: string): string | undefined {
  const wanted = word.toLowerCase();
  return monaco.languages
    .getLanguages()
    .find(
      (language) =>
        language.id === wanted ||
        (language.aliases ?? []).some((alias) => alias.toLowerCase() === wanted) ||
        (language.extensions ?? []).includes(`.${wanted}`),
    )?.id;
}

/**
 * Tokenise a code block for the Markdown preview, or `null` for a language this
 * build has no grammar for.
 *
 * `colorize` is called first and its result thrown away: grammars are lazy
 * chunks, `colorize` awaits the one it needs, and `tokenize` — the call whose
 * output we want, because it is theme-free — silently returns plain text if the
 * grammar has not arrived. Priming is cheaper than reimplementing the wait.
 */
export async function tokenizeFence(
  code: string,
  fenceWord: string,
): Promise<{ lines: string[]; tokens: { offset: number; type: string }[][] } | null> {
  const id = languageForFence(fenceWord);
  if (!id || id === "plaintext") return null;
  await monaco.editor.colorize(code, id, {});
  return { lines: code.split(/\r\n|\r|\n/), tokens: monaco.editor.tokenize(code, id) };
}

/**
 * The dirty-diff gutter: a coloured bar beside every changed line, each of which
 * opens an inline peek on click. The caller holds one per mounted editor and
 * disposes it exactly where it disposes the editor — see `TextViewer.tsx`. The
 * peek's row cap and sizing are in `docs/design-notes/viewer-renderers.md`.
 */
export interface GitGutter {
  /**
   * Replace the set of hunks this editor is showing bars for, and the text of
   * HEAD they were computed against.
   *
   * `headText` is fetched once per file open and passed unchanged on every call
   * — a save changes the working copy, not HEAD. It is a parameter rather than a
   * constructor argument only so a peek opened before the first successful fetch
   * has something other than `undefined` to close over. Always closes an open
   * peek first: a peek is anchored to a line number that only means what it did
   * for the hunks it was opened against.
   */
  update(hunks: GitHunk[], headText: string): void;
  dispose(): void;
}

/**
 * Rows of vertical space one peek needs, in the editor's own line height rather
 * than a fixed pixel count — load-bearing now that `fontSize` is a setting.
 */
function peekHeightPx(editor: CodeEditor, rows: number): number {
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  return rows * lineHeight + 12;
}

/**
 * Whether `line` falls inside the current-file span a hunk covers. A deletion
 * covers no current line at all — its `lines` is 0 — so it can only ever match
 * `start`, the line its wedge is drawn against; see `hunkDecoration` below.
 */
function hunkCoversLine(hunk: GitHunk, line: number): boolean {
  if (hunk.kind === "deleted") return line === hunk.start;
  return line >= hunk.start && line <= hunk.start + hunk.lines - 1;
}

/**
 * One hunk, as a Monaco line decoration. `isWholeLine` is what makes
 * `linesDecorationsClassName` paint every line the range crosses rather than
 * only the one its column sits on. A deletion's range covers only `start`, on
 * both ends: it has no lines of its own to span, and `start` is exactly the line
 * the CSS wedge in `text.css` points at.
 */
function hunkDecoration(hunk: GitHunk): monaco.editor.IModelDeltaDecoration {
  const last = hunk.kind === "deleted" ? hunk.start : hunk.start + hunk.lines - 1;
  return {
    range: new monaco.Range(hunk.start, 1, last, 1),
    options: {
      isWholeLine: true,
      linesDecorationsClassName: `text__gitgutter text__gitgutter--${hunk.kind}`,
    },
  };
}

/**
 * HEAD's text, split into lines. `\r?\n` and not a plain `"\n"`: this project is
 * developed on Windows, and git hands back whichever line ending `core.autocrlf`
 * produced. A trailing `\r` renders as an invisible difference between two peek
 * lines that look identical.
 */
function headLines(headText: string): string[] {
  return headText === "" ? [] : headText.split(/\r?\n/);
}

/**
 * One row of the peek, coloured by which side of the diff it came from. A `div`
 * rather than a line inside one shared `<pre>`: a background painted per line is
 * what makes this read as a diff instead of two blocks of plain text.
 */
function peekRow(kind: "removed" | "added", text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = `text__gitpeek-row text__gitpeek-row--${kind}`;
  row.textContent = text;
  return row;
}

/**
 * The most rows a peek will draw, across both of its blocks.
 *
 * A ceiling rather than a preference. The peek is a view zone, so its height is
 * real document flow: an uncapped one scrolls the gutter bar that closes it far
 * off screen — one click, stuck editor. Forty is chosen for what this view is
 * for, glancing at what changed rather than reading the file; anything longer is
 * a job for the diff view.
 */
const PEEK_MAX_ROWS = 40;

/**
 * How many rows each side of the peek may draw.
 *
 * Split rather than first-come, because a hunk that removed three thousand lines
 * and added five would otherwise spend the entire budget on the removed side and
 * show none of what replaced it. Each side is guaranteed half, and whatever the
 * other does not need is handed back, so a small hunk is capped by nothing.
 */
function peekBudget(removed: number, added: number): [number, number] {
  if (removed + added <= PEEK_MAX_ROWS) return [removed, added];

  const half = Math.floor(PEEK_MAX_ROWS / 2);
  const forRemoved = Math.min(removed, Math.max(half, PEEK_MAX_ROWS - added));
  return [forRemoved, PEEK_MAX_ROWS - forRemoved];
}

/**
 * A dim row standing in for what the cap left out, so a truncated peek cannot be
 * mistaken for the whole change: a reader who saw forty rows and no marker would
 * reasonably conclude that was all of it, a worse failure than showing nothing.
 */
function peekMore(count: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "text__gitpeek-row text__gitpeek-row--more";
  row.textContent = `… ${count.toLocaleString()} more line${count === 1 ? "" : "s"}`;
  return row;
}

/**
 * The peek's content: HEAD's lines for this hunk, then the current file's, each
 * read straight from its source rather than cached anywhere.
 *
 * HEAD's side comes from `headText`, fetched once when the file opened —
 * `originalStart` is 1-based like the rest of `GitHunk`, so the slice below
 * subtracts 1 before indexing. The current side is read off the model itself
 * rather than off the last `files/read`, so a peek can never disagree with an
 * edit typed since the last save. Both slices fall out of one rule with no
 * per-`kind` branching; see `docs/design-notes/viewer-renderers.md`.
 */
function buildPeek(hunk: GitHunk, model: TextModel, headText: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "text__gitpeek";

  const before = headLines(headText).slice(
    hunk.originalStart - 1,
    hunk.originalStart - 1 + hunk.originalLines,
  );

  // The model is the authority on how many lines are actually there. `lines`
  // comes from a diff taken against the file as it was on disk, and the user
  // may have deleted lines since without saving — reading past the end would
  // throw inside `getLineContent` and take the whole peek with it.
  const after = Math.min(hunk.lines, model.getLineCount() - hunk.start + 1);

  const [removedRows, addedRows] = peekBudget(before.length, Math.max(after, 0));

  for (const line of before.slice(0, removedRows)) root.appendChild(peekRow("removed", line));
  if (before.length > removedRows) root.appendChild(peekMore(before.length - removedRows));

  for (let i = 0; i < addedRows; i += 1) {
    root.appendChild(peekRow("added", model.getLineContent(hunk.start + i)));
  }
  if (after > addedRows) root.appendChild(peekMore(after - addedRows));

  return root;
}

/**
 * How tall the peek's view zone has to be, in editor lines. Derived from what
 * `buildPeek` will actually draw rather than from the hunk's own counts, because
 * the two stopped agreeing the moment the cap above existed — a zone sized to
 * four thousand lines around forty rows is the same stuck editor by another
 * route. The `+1` covers a truncation marker; a clipped last line looks broken.
 */
function peekHeight(hunk: GitHunk, model: TextModel, headText: string): number {
  const before = Math.min(
    hunk.originalLines,
    Math.max(headLines(headText).length - (hunk.originalStart - 1), 0),
  );
  const after = Math.max(Math.min(hunk.lines, model.getLineCount() - hunk.start + 1), 0);
  const [removedRows, addedRows] = peekBudget(before, after);

  const markers = (before > removedRows ? 1 : 0) + (after > addedRows ? 1 : 0);
  return Math.max(removedRows + addedRows + markers, 1);
}

/**
 * Mount the gutter and its click-to-peek behaviour over an already-mounted
 * editor.
 *
 * A decorations *collection* rather than the older `deltaDecorations(old, new)`
 * call: `.set()` replaces the whole set in one step and `.clear()` is the
 * teardown, which is exactly update/dispose and one fewer id to track by hand.
 * The mouse listener is registered once, for the life of the editor, and reads
 * `hunks` out of a closure variable `update` reassigns — cheaper than rebuilding
 * the listener on every save, which is when `update` is called a second time.
 */
export function createGitGutter(editor: CodeEditor): GitGutter {
  const decorations = editor.createDecorationsCollection();
  let hunks: GitHunk[] = [];
  let headText = "";
  let peek: { index: number; zoneId: string } | null = null;

  function closePeek(): void {
    if (!peek) return;
    const zoneId = peek.zoneId;
    peek = null;
    editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
  }

  function openPeek(index: number): void {
    const hunk = hunks[index];
    const model = editor.getModel();
    if (!hunk || !model) return;

    const dom = buildPeek(hunk, model, headText);
    // Asked of the same rules `buildPeek` draws by, not of the hunk's raw
    // counts — see `peekHeight`. Sizing this from `originalLines + lines` would
    // reintroduce the multi-screen zone the row cap exists to prevent.
    const rows = peekHeight(hunk, model, headText);
    editor.changeViewZones((accessor) => {
      const zoneId = accessor.addZone({
        // A deletion has no lines of its own to sit after, so its peek opens
        // directly above the line its wedge points at — line 0 is a legal
        // `afterLineNumber` and means "before the first line".
        afterLineNumber:
          hunk.kind === "deleted" ? Math.max(hunk.start - 1, 0) : hunk.start + hunk.lines - 1,
        heightInPx: peekHeightPx(editor, rows),
        domNode: dom,
      });
      peek = { index, zoneId };
    });
  }

  const click = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const line = e.target.position?.lineNumber;
    if (line === undefined) return;

    const index = hunks.findIndex((hunk) => hunkCoversLine(hunk, line));
    if (index === -1) return;

    // A second click on the same bar is the toggle closed — without it there
    // would be no way to dismiss a peek short of scrolling it out of view.
    if (peek?.index === index) {
      closePeek();
      return;
    }
    closePeek();
    openPeek(index);
  });

  return {
    update(next, nextHeadText) {
      hunks = next;
      headText = nextHeadText;
      closePeek();
      decorations.set(next.map(hunkDecoration));
    },
    dispose() {
      closePeek();
      decorations.clear();
      click.dispose();
    },
  };
}

/** One CSS custom property off the root element, trimmed. `""` if unset. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
