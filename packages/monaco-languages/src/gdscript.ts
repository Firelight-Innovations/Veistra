/**
 * A GDScript grammar, because Monaco does not ship one. Godot 4 syntax; the
 * rationale and what it leaves out are in `docs/design-notes/monaco-languages.md`.
 */
import type * as monaco from "monaco-editor/editor/editor.api";

export const GDSCRIPT_LANGUAGE_ID = "gdscript";

/** Lowercase, dot-less, matching the `extensionOf` helpers on both sides. */
export const GDSCRIPT_EXTENSIONS = ["gd"] as const;

/**
 * Comment toggling, brackets, and Godot's own indent rule: a line ending in `:`
 * opens a block, as in Python, whose configuration this mirrors.
 */
export const GDSCRIPT_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  onEnterRules: [
    {
      beforeText: /:\s*(?:#.*)?$/,
      action: { indentAction: 1 /* languages.IndentAction.Indent */ },
    },
  ],
  folding: { offSide: true },
};

/**
 * The Monarch tokenizer. Token names are ones `vs`/`vs-dark` already colour, so
 * the Veistra themes keep `rules: []` — the same constraint TOML is under.
 * `keyword.flow` is the one distinction drawn inside keywords: control flow is
 * what a reader scans for, and both base themes give it its own colour.
 */
export const GDSCRIPT_LANGUAGE: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".gd",

  keywords: [
    "and",
    "as",
    "breakpoint",
    "class",
    "class_name",
    "const",
    "enum",
    "extends",
    "func",
    "in",
    "is",
    "not",
    "or",
    "preload",
    "signal",
    "static",
    "var",
    "void",
  ],

  flowKeywords: [
    "await",
    "break",
    "continue",
    "elif",
    "else",
    "for",
    "if",
    "match",
    "pass",
    "return",
    "when",
    "while",
    "yield",
    "assert",
  ],

  constants: ["true", "false", "null", "self", "super", "PI", "TAU", "INF", "NAN"],

  /**
   * Variant types plus the handful of global classes nearly every script names.
   * Any other capitalised identifier is coloured as a type too (see `root`), so
   * this list is what makes `int`, `float` and `bool` — lowercase — types.
   */
  builtinTypes: [
    "bool",
    "int",
    "float",
    "String",
    "StringName",
    "NodePath",
    "Vector2",
    "Vector2i",
    "Vector3",
    "Vector3i",
    "Vector4",
    "Vector4i",
    "Rect2",
    "Rect2i",
    "Transform2D",
    "Transform3D",
    "Plane",
    "Quaternion",
    "AABB",
    "Basis",
    "Projection",
    "Color",
    "RID",
    "Object",
    "Callable",
    "Signal",
    "Dictionary",
    "Array",
    "Variant",
  ],

  escapes: /\\(?:[abfnrtv\\"'\n]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{6})/,

  tokenizer: {
    root: [
      { include: "@whitespace" },

      // `@export_range(...)`, `@onready`, `@tool`: the name only; the arguments
      // are ordinary expressions and tokenize as such.
      [/@[A-Za-z_]\w*/, "annotation"],

      // `$Path/To/Node`, `$"Quoted Path"` and `%UniqueName` — node references
      // are strings to Godot, so they are coloured as one.
      [/\$"(?:[^"\\]|\\.)*"/, "string"],
      [/[$%][A-Za-z_][\w/]*/, "string"],

      // `&"name"` (StringName) and `^"path"` (NodePath): a prefix and a string.
      [/[&^](?=["'])/, "string"],

      [
        /[A-Za-z_]\w*/,
        {
          cases: {
            "@flowKeywords": "keyword.flow",
            "@keywords": "keyword",
            "@constants": "variable.predefined",
            "@builtinTypes": "type",
            "Packed\\w+Array": "type",
            "[A-Z][A-Z0-9_]+": "constant",
            "[A-Z]\\w*": "type",
            "@default": "identifier",
          },
        },
      ],

      // Numbers: hex and binary first, or the `0` is taken as a decimal and the
      // rest as an identifier. `_` is GDScript's digit separator.
      [/0[xX][0-9A-Fa-f_]+/, "number.hex"],
      [/0[bB][01_]+/, "number.hex"],
      [/(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][+-]?\d+)?/, "number.float"],
      [/\d[\d_]*(?:\.(?!\.))?(?:[eE][+-]?\d+)?/, "number"],

      // Triple quotes before single, or `"""` opens and closes an empty string.
      [/"""/, { token: "string", next: "@tripleDouble" }],
      [/'''/, { token: "string", next: "@tripleSingle" }],
      [/"/, { token: "string", next: "@double" }],
      [/'/, { token: "string", next: "@single" }],

      [/[{}()[\]]/, "@brackets"],
      [/->|:=|[-+*/%=<>!&|^~]=?|\*\*=?|<<=?|>>=?/, "operator"],
      [/[,.:;]/, "delimiter"],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      // `##` is a documentation comment in Godot 4; it gets the doc colour.
      [/##.*$/, "comment.doc"],
      [/#.*$/, "comment"],
    ],

    double: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string", next: "@pop" }],
    ],

    single: [
      [/[^\\']+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/'/, { token: "string", next: "@pop" }],
    ],

    tripleDouble: [
      [/"""/, { token: "string", next: "@pop" }],
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, "string"],
    ],

    tripleSingle: [
      [/'''/, { token: "string", next: "@pop" }],
      [/[^\\']+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/'/, "string"],
    ],
  },
};
