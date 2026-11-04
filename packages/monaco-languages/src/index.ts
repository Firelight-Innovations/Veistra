/**
 * Grammars for languages Monaco does not ship, plus the one function that installs them.
 * Nothing here imports `monaco-editor` at runtime, so a Monaco-free module can still call
 * `languageIdForPath`. Full rationale: `docs/design-notes/monaco-languages.md`.
 */
import {
  GDSCRIPT_CONFIGURATION,
  GDSCRIPT_EXTENSIONS,
  GDSCRIPT_LANGUAGE,
  GDSCRIPT_LANGUAGE_ID,
} from "./gdscript";
import {
  GODOT_RESOURCE_CONFIGURATION,
  GODOT_RESOURCE_EXTENSIONS,
  GODOT_RESOURCE_LANGUAGE,
  GODOT_RESOURCE_LANGUAGE_ID,
} from "./godotResource";
import { TOML_CONFIGURATION, TOML_EXTENSIONS, TOML_LANGUAGE, TOML_LANGUAGE_ID } from "./toml";

export { TOML_CONFIGURATION, TOML_EXTENSIONS, TOML_LANGUAGE, TOML_LANGUAGE_ID } from "./toml";
export {
  GDSCRIPT_CONFIGURATION,
  GDSCRIPT_EXTENSIONS,
  GDSCRIPT_LANGUAGE,
  GDSCRIPT_LANGUAGE_ID,
} from "./gdscript";
export {
  GODOT_RESOURCE_CONFIGURATION,
  GODOT_RESOURCE_EXTENSIONS,
  GODOT_RESOURCE_LANGUAGE,
  GODOT_RESOURCE_LANGUAGE_ID,
} from "./godotResource";

/**
 * The `monaco` namespace as `editor.api` exports it — deliberately not `editor.main`, and
 * deliberately `typeof import(...)` rather than `typeof monaco`. Design notes say why each.
 */
export type MonacoApi = typeof import("monaco-editor/editor/editor.api");

type LanguageConfiguration = Parameters<MonacoApi["languages"]["setLanguageConfiguration"]>[1];
type MonarchLanguage = Parameters<MonacoApi["languages"]["setMonarchTokensProvider"]>[1];

interface Grammar {
  id: string;
  extensions: readonly string[];
  aliases: string[];
  configuration: LanguageConfiguration;
  language: MonarchLanguage;
}

/** Every grammar this package carries. Adding one is a file beside `./toml.ts` and a row here. */
const GRAMMARS: readonly Grammar[] = [
  {
    id: TOML_LANGUAGE_ID,
    extensions: TOML_EXTENSIONS,
    aliases: ["TOML"],
    configuration: TOML_CONFIGURATION,
    language: TOML_LANGUAGE,
  },
  {
    id: GDSCRIPT_LANGUAGE_ID,
    extensions: GDSCRIPT_EXTENSIONS,
    aliases: ["GDScript"],
    configuration: GDSCRIPT_CONFIGURATION,
    language: GDSCRIPT_LANGUAGE,
  },
  {
    id: GODOT_RESOURCE_LANGUAGE_ID,
    extensions: GODOT_RESOURCE_EXTENSIONS,
    aliases: ["Godot Resource", "Godot Scene"],
    configuration: GODOT_RESOURCE_CONFIGURATION,
    language: GODOT_RESOURCE_LANGUAGE,
  },
];

/** Extension (lowercase, dot-less) → language id, for every grammar above. */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  GRAMMARS.flatMap((grammar) => grammar.extensions.map((extension) => [extension, grammar.id])),
);

function register(monaco: MonacoApi, grammar: Grammar): void {
  if (monaco.languages.getLanguages().some((language) => language.id === grammar.id)) return;

  monaco.languages.register({
    id: grammar.id,
    // Declared here as well as in each consumer's extension table: this is what
    // Monaco reads when a model is created by URI with no explicit language.
    extensions: grammar.extensions.map((extension) => `.${extension}`),
    aliases: grammar.aliases,
  });
  monaco.languages.setLanguageConfiguration(grammar.id, grammar.configuration);
  monaco.languages.setMonarchTokensProvider(grammar.id, grammar.language);
}

/**
 * Teach a Monaco instance every grammar in this package. Safe to call more than once — two
 * shell-side consumers share one global registry; the design notes say why the guard
 * sidesteps that hazard, not survives it.
 */
export function registerLanguages(monaco: MonacoApi): void {
  for (const grammar of GRAMMARS) register(monaco, grammar);
}

/**
 * The lowercase extension of a path's last segment, or `""`. Matches the last dot-segment
 * only, and only after the final path separator — a dotted directory does not make its files
 * TOML — and a leading dot (`.gitignore`) is a name, not an extension.
 */
function extensionOfPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (dot === -1 || dot <= separator + 1) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** The id of the grammar this package has for a path, or `undefined`. */
export function languageIdForPath(path: string): string | undefined {
  const extension = extensionOfPath(path);
  // Own keys only: `foo.constructor` must not find `Object.prototype.constructor`.
  return Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXTENSION, extension)
    ? LANGUAGE_BY_EXTENSION[extension]
    : undefined;
}
