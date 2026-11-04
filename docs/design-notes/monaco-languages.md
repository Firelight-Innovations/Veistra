# Monaco languages design notes

Design rationale moved out of `packages/monaco-languages/src/` to keep comment
concentration under the caps in STANDARDS.md §10. The source files point back here.

## packages/monaco-languages/src/index.ts

Grammars for languages Monaco does not ship, plus the one function that installs them.

There are three languages in here today — TOML, which Veistra's own two marker formats
are written in, and GDScript and Godot's text resource format, which every Godot project
is written in (issue #341) — and the package is named for the general case because the
boundary it exists to cross is general. `src/` and `apps/files/` may not import each other, so
anything both sides of the shell need lives under `packages/`; `@veistra/file-icons` was the
first of these and this is the second. A new grammar is another file beside
`./toml.ts` and another row in `GRAMMARS`, not a second package.

**Nothing here imports `monaco-editor` at runtime.** The grammars are plain data and the
registrar takes the Monaco namespace as an argument, so this package adds no bytes to a
bundle that has not already paid for Monaco — and, more usefully, it can be imported by a
module that must stay Monaco-free. `worktree/SourceControlView.tsx` is exactly that: it
reaches `DiffView` through a `lazy(() => import(...))` so that opening the source-control
panel does not drag Monaco in, and a static import of anything that touched Monaco would
undo that. `languageIdForPath` is safe for it to call because of this rule.

### `MonacoApi`

The `monaco` namespace as `editor.api` exports it.

Written as `typeof import(...)` rather than `import type * as monaco` and `typeof monaco`,
because the latter is not legal: a type-only import binds a name in type space alone, and
`typeof` needs a value to read a type off. The import-type form is erased the same way and
needs no value binding.

`editor.api` deliberately, not `editor.main` — every consumer imports the former (each
header says why), and the three setters used below are on the `languages` namespace that
`editor.api` already exports in full. That is what makes a hand-written Monarch grammar
uniquely portable here: the diff editor has no tokenizer for any *bundled* language
precisely because it never pulled `editor.main` in, and yet it can be handed this one.

### `registerLanguages`

Teach a Monaco instance every grammar in the package. Safe to call more than once:
each grammar is registered at most once per Monaco instance.

(It was `registerToml` while TOML was the only grammar; every caller moved over when the
Godot grammars arrived, so the TOML-only entry point was removed rather than kept dead.)

The guard is not defensive padding — it is the point of routing every editor through one
function. Two of the three consumers (`search/previewMonaco.ts` and `diff/DiffView.tsx`)
are shell-side, so both chunks can be live in one JS context at once, and both would
otherwise register the same id against the same global registry. Monaco tolerates that by
merging the extension lists and letting the last tokens provider win, which is survivable
only for as long as the two registrations stay byte-identical; the theme names in those
same two files had to be pulled apart for the version of this hazard that is not
survivable. Registering once and never again sidesteps the question rather than depending
on the answer.

(Files' editor lives behind an iframe boundary and shares no registry with either, so for
it the guard is simply never true.)

The language's `extensions` are declared on the language itself as well as in each
consumer's extension table. The tables are what the apps resolve through; this declaration
is what Monaco's own machinery reads, and a model created by URI without an explicit
language would otherwise find nothing.

### `languageIdForPath`

The id of the grammar this package has for a path, or `undefined`. It replaced
`isTomlPath`, which answered the same question for TOML alone.

For callers that need to name a language without owning an extension table — the
source-control panel, which knows a file's path and must hand `DiffView` a language id,
but whose whole reason for existing lazily is that it may not import the module where such
a table would live.

Matches the last dot-segment only, looks up own keys only (so `foo.constructor` is not
`Object.prototype.constructor`), and only when there is one after the final path
separator, so a directory with a dot in it does not turn every file under it into TOML.
Same rule as the `extensionOf` helpers on both sides of the boundary, restated here
because neither is reachable from the other.

## packages/monaco-languages/src/toml.ts

### Why it was worth writing rather than aliasing again

`.veistra` is TOML. `src-tauri/src/project/marker.rs` parses a project marker with
`raw.parse::<toml::Table>()`, and `manifest.rs` does the same for `veistra.toml`. So the
three files anyone working in this product opens most — `<project>.veistra`, `veistra.toml`,
`Cargo.toml` — are all one format, and all three were being coloured by a grammar for a
different one.

The `ini` stand-in is not merely imprecise on them, it is wrong on their actual contents:

- Its key rule is `/(^\w+)(\s*)(\=)/`, and `\w` does not include `-`. Every kebab-case key
  Veistra writes — `created-with`, `created-unix-ms`, `checkout-root` — is therefore not
  highlighted as a key at all.
- Its section rule is `/^\[[^\]]*\]/`, which on `veistra.toml`'s `[[tool]]` matches
  `[[tool]` and leaves a stray `]` behind.
- Its comment rule is `/^\s*[#;].*$/`, so a comment after a value on the same line is not
  a comment.
- Arrays, inline tables, multi-line strings and datetimes are all untokenized.

Those five are the exact list the old comment admitted to, so this grammar is measured
against them rather than against TOML in the abstract.

### Why it lives in a package

It was written for the Files app and sat in `apps/files/ui/src/viewer/toml.ts` for exactly
as long as there was one editor to serve. There are now three — Files' viewer, the search
overlay's preview pane, and the source-control diff — and `src/` and `apps/files/` may not
import each other (see the repository CLAUDE.md), so the only ground all three can stand
on is `packages/`. Moving it here is what makes "TOML is highlighted in Veistra" one fact
rather than three copies drifting apart.

That move is also why `index.ts` exports a registrar rather than leaving each editor
to call the three `monaco.languages.*` setters itself. Two of the three consumers are
shell-side and can be live in the same JS context at once, where a second registration of
the same id is a real hazard — the same class of collision the editors' theme names
already had to be pulled apart to avoid.

### Token names are borrowed, not invented

Every token this emits is one `vs-dark` already colours — `key`, `metatag`, `comment`,
`string`, `number`, `number.hex`, `keyword`, `delimiter` (read out of
`editor/standalone/common/themes.js`). That is deliberate and it is what lets every Veistra
theme keep `rules: []`: the theme headers forbid inventing a token colour, on the grounds
that the handoff palette names UI surfaces rather than grammar scopes. Borrowing scopes
the base theme already styles means a `.veistra` file is coloured by exactly the machinery
that colours a `.py` or a `.md`, and this file introduces no palette of its own.

### What it deliberately does not do

No validation, no folding provider, no language service. A Monarch tokenizer is a lexer:
it says what a run of characters *looks* like, not whether the document is well-formed. A
`.veistra` with a duplicate table is coloured perfectly and is still rejected by Rust, which
is the half that gets to have an opinion — the same division every consumer of this
package draws for every other language it registers, except JSON.

### The language id and its exports

Exported rather than spelled as a literal at each call site because three editors and one
caller now name it, and one of those callers (`languageIdForPath` in `./index.ts`, used by the
source-control panel) has to agree with the extension list Monaco is given without
importing Monaco to find it out.

## packages/monaco-languages/src/gdscript.ts

GDScript is Python-shaped but not Python. Monaco's `python` grammar was the obvious alias
and it is wrong on the lines a Godot script is mostly made of:

- `@export`, `@onready`, `@tool` are annotations, not decorators on the next line, and
  `@export_range(0, 10)` sits on the same line as the `var` it annotates.
- `##` is a documentation comment (Godot 4 shows it in the inspector); Python has none.
- `$Path/To/Node`, `%UniqueName`, `&"StringName"` and `^"NodePath"` are literals. Python
  reads `$` as an error and `&`/`^` as operators.
- `func`, `extends`, `class_name`, `signal`, `var`, `const`, `enum`, `await`, `match`,
  `when`, `preload` are keywords; `def`, `lambda` and `True`/`False`/`None` are not.
- `int`, `float`, `bool` and the Variant types (`Vector2`, `PackedVector2Array`, …) are
  types. Every other capitalised identifier is coloured as a type too, which is right for
  class names (`CharacterBody2D`) and is why an all-caps name (`GRAVITY`, enum values) is
  matched first and coloured as a constant instead.

Control flow is `keyword.flow`, the rest `keyword`: the one split inside keywords, because
both base themes already colour it differently. Indentation: a line ending in `:` indents
the next, and folding is off-side (by indentation), as in Python.

Not attempted: semantic colouring (what a name refers to), the inner grammar of
`@export_*` hint strings, and `.gdshader` (a separate shading language).

## packages/monaco-languages/src/godotResource.ts

`.tscn`, `.tres`, `project.godot` and `.import` are one format — Godot's `ConfigFile`
dialect with Variant literals for values. `ini` is close in outline and wrong in detail:

- A section header carries attributes: `[node name="Player" type="CharacterBody2D" parent="."]`.
  `ini` colours the whole bracket as one run; this grammar colours it as a tag with
  attributes, which is how Godot's own script editor shows it.
- Keys are property paths with `/` in them — `metadata/_edit_lock_`, `config/name`,
  `0/0/physics_layer_0/polygon_0/points` — which `ini`'s `\w+` key rule does not match.
- Values are Variant literals: constructors (`Vector2(1, 2)`, `ExtResource("1_abc")`,
  `PackedStringArray("4.3")`), `&"StringName"`, `^"NodePath"`, `inf`/`nan`, and strings
  that span lines (a multi-line `text` property, or an inline `Dictionary` in
  `project.godot`'s `[input]` section).
- The comment character is `;`, not `#`.
