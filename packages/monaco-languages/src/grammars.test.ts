// @vitest-environment jsdom
/**
 * The grammars run through Monaco's real Monarch tokenizer, not checked as regexes in
 * isolation: rule order is most of what a Monarch grammar gets wrong, and only the
 * tokenizer sees it. Samples are lifted from a real Godot 4 project (issue #341).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { languageIdForPath, registerLanguages, type MonacoApi } from "./index";

// jsdom has neither; Monaco's theme service reaches for both while it starts.
const globals = globalThis as { CSS?: { escape(value: string): string } };
globals.CSS ??= { escape: (value) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };
window.matchMedia ??= (() => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;

let monaco: MonacoApi;

// Transforming all of Monaco takes 10–12 s on a Windows dev machine, past
// Vitest's 10 s default, so the import gets a minute. The tests are unchanged.
beforeAll(async () => {
  monaco = await import("monaco-editor/editor/editor.api");
  registerLanguages(monaco);
}, 60_000);

/** Each non-blank token as `[text, type-without-postfix]`, line by line. */
function tokens(source: string, language: string): [string, string][][] {
  const lines = source.split("\n");
  return monaco.editor
    .tokenize(source, language)
    .map((line, row) =>
      line
        .map((token, i): [string, string] => [
          lines[row].slice(token.offset, line[i + 1]?.offset ?? lines[row].length),
          token.type.replace(/\.(gd|tscn)$/, ""),
        ])
        .filter(([text]) => text.trim() !== ""),
    );
}

/** The type of the first token whose text is exactly `text`. */
function typeOf(source: string, language: string, text: string): string | undefined {
  return tokens(source, language)
    .flat()
    .find(([t]) => t === text)?.[1];
}

describe("gdscript", () => {
  const script = [
    "class_name Enemy extends CharacterBody2D",
    "## All five original enemies.",
    "enum { WALK, SHELL, DEAD }",
    "const GRAVITY := 900.0",
    'const SPEEDS := {"nut": 30.0, "clam": 0x1F}',
    '@export var kind: String = "nut"',
    "@onready var _shape: CollisionShape2D = $Body/Shape",
    "var pts := PackedVector2Array() # trailing",
    "func _ready() -> void:",
    "\tif state == WALK and not active:",
    "\t\tawait get_tree().process_frame",
    "\t\treturn self",
  ].join("\n");

  it("colours declarations and control flow as keywords", () => {
    expect(typeOf(script, "gdscript", "class_name")).toBe("keyword");
    expect(typeOf(script, "gdscript", "extends")).toBe("keyword");
    expect(typeOf(script, "gdscript", "func")).toBe("keyword");
    expect(typeOf(script, "gdscript", "if")).toBe("keyword.flow");
    expect(typeOf(script, "gdscript", "await")).toBe("keyword.flow");
    expect(typeOf(script, "gdscript", "and")).toBe("keyword");
    expect(typeOf(script, "gdscript", "self")).toBe("variable.predefined");
  });

  it("tells types, constants and plain names apart", () => {
    expect(typeOf(script, "gdscript", "CharacterBody2D")).toBe("type");
    expect(typeOf(script, "gdscript", "String")).toBe("type");
    expect(typeOf(script, "gdscript", "PackedVector2Array")).toBe("type");
    expect(typeOf(script, "gdscript", "void")).toBe("keyword");
    expect(typeOf(script, "gdscript", "GRAVITY")).toBe("constant");
    expect(typeOf(script, "gdscript", "WALK")).toBe("constant");
    expect(typeOf(script, "gdscript", "state")).toBe("identifier");
  });

  it("colours literals, annotations, node paths and both comment kinds", () => {
    expect(typeOf(script, "gdscript", "900.0")).toBe("number.float");
    expect(typeOf(script, "gdscript", "0x1F")).toBe("number.hex");
    expect(typeOf(script, "gdscript", '"nut"')).toBe("string");
    expect(typeOf(script, "gdscript", "@export")).toBe("annotation");
    expect(typeOf(script, "gdscript", "@onready")).toBe("annotation");
    expect(typeOf(script, "gdscript", "$Body/Shape")).toBe("string");
    expect(typeOf(script, "gdscript", "## All five original enemies.")).toBe("comment.doc");
    expect(typeOf(script, "gdscript", "# trailing")).toBe("comment");
  });

  it("keeps a triple-quoted string open across lines", () => {
    const lines = tokens('var s := """one\n"two"\nthree"""\nvar t := 1', "gdscript");
    expect(lines[1]).toEqual([['"two"', "string"]]);
    expect(lines[3][0]).toEqual(["var", "keyword"]);
  });
});

describe("godot-resource", () => {
  const scene = [
    '[gd_scene load_steps=3 format=3 uid="uid://b1x"]',
    "",
    '[ext_resource type="Script" path="res://scripts/main.gd" id="1_abc"]',
    "",
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1_abc")',
    "metadata/_edit_lock_ = true",
    "position = Vector2(-12.5, 3)",
    'text = "two',
    'lines"',
    "; a comment",
  ].join("\n");

  it("draws a section header as a tag with attributes", () => {
    const header = tokens(scene, "godot-resource")[0];
    expect(header[1]).toEqual(["gd_scene", "tag"]);
    expect(header).toContainEqual(["load_steps", "attribute.name"]);
    expect(header).toContainEqual(['"uid://b1x"', "string"]);
    expect(header.at(-1)).toEqual(["]", "delimiter.bracket"]);
  });

  it("colours property paths, constructors and values", () => {
    expect(typeOf(scene, "godot-resource", "metadata/_edit_lock_")).toBe("key");
    expect(typeOf(scene, "godot-resource", "ExtResource")).toBe("type");
    expect(typeOf(scene, "godot-resource", "Vector2")).toBe("type");
    expect(typeOf(scene, "godot-resource", "-12.5")).toBe("number.float");
    expect(typeOf(scene, "godot-resource", "true")).toBe("keyword");
    expect(typeOf(scene, "godot-resource", "; a comment")).toBe("comment");
  });

  it("keeps a string open across lines", () => {
    const lines = tokens(scene, "godot-resource");
    expect(lines[9]).toEqual([['lines"', "string"]]);
    expect(lines[10]).toEqual([["; a comment", "comment"]]);
  });

  it("reads project.godot, which writes no spaces round `=`", () => {
    const project = '[application]\nconfig/name="Game"\nconfig/features=PackedStringArray("4.3")';
    expect(typeOf(project, "godot-resource", "application")).toBe("tag");
    expect(typeOf(project, "godot-resource", "config/name")).toBe("key");
    expect(typeOf(project, "godot-resource", "PackedStringArray")).toBe("type");
  });
});

describe("languageIdForPath", () => {
  it("maps every grammar's extensions, by the last segment only", () => {
    expect(languageIdForPath("game/scripts/enemy.gd")).toBe("gdscript");
    expect(languageIdForPath("C:\\game\\main.tscn")).toBe("godot-resource");
    expect(languageIdForPath("game/theme.TRES")).toBe("godot-resource");
    expect(languageIdForPath("game/project.godot")).toBe("godot-resource");
    expect(languageIdForPath("game/icon.svg.import")).toBe("godot-resource");
    expect(languageIdForPath("Cargo.toml")).toBe("toml");
    expect(languageIdForPath("demo.veistra")).toBe("toml");
  });

  it("answers undefined for no extension, a dotted directory, or a prototype key", () => {
    expect(languageIdForPath("game/enemy.gd.uid")).toBeUndefined();
    expect(languageIdForPath("dir.gd/README")).toBeUndefined();
    expect(languageIdForPath(".gd")).toBeUndefined();
    expect(languageIdForPath("weird.constructor")).toBeUndefined();
  });
});
