/**
 * Godot's text resource format — `.tscn` scenes, `.tres` resources, `project.godot`
 * and `.import` sidecars are all one INI-shaped dialect. The design notes say why
 * `ini` is not close enough.
 */
import type * as monaco from "monaco-editor/editor/editor.api";

export const GODOT_RESOURCE_LANGUAGE_ID = "godot-resource";

/** Lowercase, dot-less, matching the `extensionOf` helpers on both sides. */
export const GODOT_RESOURCE_EXTENSIONS = ["tscn", "tres", "godot", "import"] as const;

export const GODOT_RESOURCE_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: ";" },
  brackets: [
    ["[", "]"],
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

/**
 * The Monarch tokenizer. A section header (`[node name="Player" type="CharacterBody2D"]`)
 * is a tag with attributes, the way Godot's own editor draws it; a property line is a
 * key and a value. Values are Variant literals — constructors such as `Vector2(1, 2)` or
 * `ExtResource("1_abc")`, strings that may span lines, `&"StringName"`, `^"NodePath"`.
 */
export const GODOT_RESOURCE_LANGUAGE: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".tscn",

  tokenizer: {
    root: [
      // Header first: a property never starts with `[`. The tag is the section
      // kind (`gd_scene`, `node`, `ext_resource`) or a `project.godot` section.
      [
        /^(\s*)(\[)([A-Za-z_][\w/.-]*)/,
        ["", "delimiter.bracket", { token: "tag", next: "@header" }],
      ],

      // `metadata/_edit_lock_ = true`, `config/name="Game"`, `0/0/terrain = 1`:
      // property paths use `/`, and `project.godot` writes no spaces round `=`.
      [/^(\s*)([\w/.:-]+)(\s*)(=)/, ["", "key", "", "delimiter"]],

      { include: "@values" },
    ],

    header: [
      [/\]/, { token: "delimiter.bracket", next: "@pop" }],
      [/([A-Za-z_][\w/]*)(\s*)(=)/, ["attribute.name", "", "delimiter"]],
      { include: "@values" },
    ],

    values: [
      [/[ \t\r\n]+/, ""],
      [/;.*$/, "comment"],

      [/[&^](?=")/, "string"],
      [/"/, { token: "string", next: "@string" }],

      [/\b(?:true|false|null)\b/, "keyword"],
      [/[+-]?(?:inf|inf_neg|nan)\b/, "number.float"],
      [/[+-]?\d+\.\d*(?:[eE][+-]?\d+)?|[+-]?\d+[eE][+-]?\d+/, "number.float"],
      [/[+-]?\d+/, "number"],

      // `Vector2(`, `ExtResource(`, `PackedStringArray(`, `Object(InputEventKey, …)`:
      // a constructor or class name, the type of the value that follows.
      [/[A-Za-z_]\w*(?=\s*\()/, "type"],
      [/[A-Z]\w*/, "type"],
      [/[A-Za-z_]\w*/, "identifier"],

      [/[{}()[\]]/, "@brackets"],
      [/[,:]/, "delimiter"],
    ],

    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string", next: "@pop" }],
    ],
  },
};
