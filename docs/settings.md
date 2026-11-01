# Settings

What Veistra lets you change, where the change is written, and what a new setting
costs to add. The implementation is `src-tauri/src/settings/`; this document is
the contract that module — and every app that registers a section against it —
is written to.

---

## 1. A setting is a decision, and something has to read it

This is the whole rule, and it belongs before any of the machinery.

**A row that writes a value nothing consumes is worse than no row at all.** It is
a promise the interface does not keep, and the person who finds out is the one
who changed it and watched nothing happen — after which every other row on the
screen is suspect too. A settings screen is trusted or it is decoration, and it
loses that in a single interaction.

So before adding a setting, name its reader. If the answer is "nothing yet, but
soon", the setting lands in the same commit as the code that reads it, or it does
not land. Every key Rust reads has a constant in `schema.rs`'s `keys` module and
a line in the test at the bottom of that file, which checks the key still
resolves to a setting of the type its reader expects.

The corollary is that a setting is not the default answer to a disagreement about
a value. A constant nobody has ever wanted to change is better left a constant:
it cannot be set to something that breaks, and it needs no key, no row, no
persistence and no migration. The three caps in `search.rs` became settings
because the right answer genuinely differs per repository — a cap that keeps a
monorepo responsive truncates a small project's honest result set, and the
response says `truncated` either way with no way for the reader to do anything
about it. That is the argument a new setting has to make.

## 2. The shape of the system

Descriptors are `&'static` Rust data. Nothing about a setting is stored anywhere
but in the code that declares it, and the file on disk holds only what somebody
disagreed with.

```
schema.rs         the shell's own groups                     ─┐
apps/*::SETTINGS  an app's own group                          │ descriptors
                  `&'static [Setting]`, no state, no I/O     ─┘
        │  settings::seed, once, before the first window paints
settings::Registry    in Tauri state — what exists, and       ─┐
                      what has been changed away from default  │ the truth
                      (sparse: a key at its default is absent)─┘
        │  every write goes through settings::commit, which does both:
        ├──► store::save   %APPDATA%/<identifier>/settings.json
        └──► app.emit      "settings:changed", the whole value map
                 │
                 ├──► useSettings()      the settings screen
                 ├──► useAppearance()    custom properties on :root
                 └──► an app's frame     not yet — see §7

settings::flag / number / text    Rust reads the Registry directly, per
                                  call, and never hears the event at all
```

Three things about that picture are load-bearing.

**Seeding is ordered.** `seed` registers the shell's groups, then every app's,
and only then reads the file — because `Registry::hydrate` drops any key no group
declares. Read the file first and every setting would be discarded.

**The event carries the whole map, not the key that moved.** It is small (only
changes are in it) and Tauri events have no replay buffer, so a window that
mounted late could never be caught up by deltas it did not hear. Same shape and
same reasoning as `presets:changed`.

**Rust readers do not subscribe.** `flag`, `number` and `text` ask the registry at
the moment they act — `pty.rs` when it spawns a shell, `search.rs` when it starts
a search, `files.rs` when it opens a file. That is what makes `Applies::Next`
truthful without any invalidation machinery, and it is also why nothing in Rust
may cache a derived value off a setting.

## 3. The four controls

A control says both what a setting is edited with and what it holds when nobody
has edited it. The default lives **inside** the control rather than beside it,
because the two are one decision: a default has to be a value its own control can
produce, and a `Number` defaulting to `"large"` is not something anyone should be
able to write. Split them and that pair becomes checkable only at runtime, and
only on the first launch that read the file.

| Control | Besides `default` | Bad value |
|---|---|---|
| `Toggle` | — | not a bool is refused |
| `Number` | `min`, `max`, `step`, `unit` | **clamped** to range; a fraction is refused |
| `Text` | `placeholder` | not a string is refused |
| `Select` | `options` | outside `options` is **refused** |

The two entries in bold are the interesting asymmetry, and it is deliberate.

**A number clamps.** A stepper held at its edge, and a hand-edited file, both land
somewhere the interface can draw. `settings_set` returns the value that was
actually stored rather than the one it was sent, so the control redraws from the
answer — which is what stops a field drifting past its maximum on screen and
being silently corrected on the next launch.

**A select refuses.** There is no nearest valid option to fall back to, and
picking one would be inventing an answer on the user's behalf. `NotAnOption` is
its own error for that reason.

A number is read with `as_i64` and not `as_f64().round()`: a fractional font size
is a different setting from the one declared, and rounding it would accept a
document that was meant to be rejected.

## 4. When a change takes effect — `Applies`

Every setting carries one of three, and the screen draws it under the control.

| `Applies` | Means |
|---|---|
| `Now` | visible without anything being reopened |
| `Next { what }` | read when the next one of something is made — `what` names it |
| `Restart` | read once, at launch |

This exists because most of these settings are read at the moment something is
*created* — a pty is spawned, a search is started, an editor is mounted — and **a
control that silently does nothing to what is already on screen is the most
common way a settings screen loses trust.** Saying so costs one line and is the
difference between a limitation and a bug.

`what` is a phrase, not an id: "the next terminal you open", "the next file you
open". It is rendered as written, so it has to read as the end of a sentence.

`Restart` has two users, and they are worth naming because they show what the
variant is for rather than what it sounds like. `terminal.openOnLaunch` is read in
`lib.rs`'s setup, at the only moment a launch terminal could be opened. There is
no later point at which switching it on could do anything — the launch is over —
so `Now` would not be a small inaccuracy, it would be a control that appears to
work and does not. `updates.checkAutomatically` is the same shape, read by
`updater::start` on the same line of the same function, and Help ▸ Check for
Updates is the way to ask without waiting for a restart.

The bar for `Restart` is that specific. A setting read on every use is `Now` or
`Next`, whatever it feels like; only a setting read *once, at startup* earns it.

## 5. Adding a setting to the shell

Everything below is one file, `src-tauri/src/settings/schema.rs`, unless it says
otherwise.

1. **Pick the group.** `appearance`, `editor`, `terminal`, `search`, `github`,
   `telemetry`, `mcp`, `developer`. If none fits, add a `static Group` and an
   entry in `GROUPS`, with an `order` in 0–99 — the shell's range (§6).
2. **Add a `Setting`** to that group's `&'static [Setting]`. The key is
   `<group id>.<camelCaseName>`, and the prefix is not optional: a test enforces
   it, and §6 explains what it is for.
3. **If Rust reads it, add a constant** to the `keys` module and use the constant
   as the `key`. A string literal at a call site that no longer names a setting
   falls back to a zero value silently; a constant that no longer names one is
   caught by step 5.
4. **Read it** with `settings::flag`, `settings::number` or `settings::text`,
   passing the `AppHandle` and the key. Read it at the point of use, per call —
   `files.rs::max_read_bytes` is the two-line shape. Do not cache it.
5. **Add the key to the test** at the bottom of `schema.rs`
   (`every_exported_key_resolves_to_a_setting_of_the_type_its_reader_expects`),
   with the type its reader expects.
6. **Set `applies` truthfully** (§4). Ask when the value is read, not when you
   would like it to take effect.
7. **Only if its reader is a file**, add the key to `settings::react`. Almost
   nothing needs this: a setting read at the point of use needs no reaction at
   all. The exception is one whose consumer is written rather than consulted —
   `.mcp.json` is the only case today, and both `mcp.writeProjectConfig` and
   `developer.mode` decide what goes in it.

**Nothing in the frontend changes, and that is the entire point of the design.**
The screen is generated from the schema: `src/bindings.ts` mirrors the four
control shapes and nothing per-setting, and `useSettings` draws whatever groups
the snapshot contains. A new setting is a Rust edit, a `pnpm test`, and done.

Four more tests in that file will fail for you rather than letting something odd
ship: two groups may not share an id, two settings may not share a key anywhere,
a description may not begin with its own title (they are drawn one under the
other and it reads as a stutter), and a default has to be a value its own control
accepts unchanged — otherwise the row would look permanently modified.

## 6. How an app registers its own section

The interface is two edits, and `src-tauri/src/apps/files.rs` is the worked
example — read the top of that file.

1. A `pub static SETTINGS: crate::settings::Group` in the app's own module, with
   its rows in the order its author chose.
2. One line in `APP_SETTINGS`, the list `apps::settings_groups()` returns.

There is no third step. No registration call, no ordering to negotiate, and
nothing the app has to know about how the screen is drawn.

**A group is registered whole, never one row at a time.** A section is the unit
the screen navigates by, so an app that could add a row to somebody else's
section would be able to create a section nobody owns — and the registry would
then have to invent an order for the rows inside it.

**`order`: the shell takes 0–99, an app takes 100+.** Groups sort by `(order,
id)`, so apps land under the shell however many of them there are, and an app
that registers late still lands where its author put it. Files uses 100.

**Every key must start with `<group id>.`** — `files.readLimitKb`, not
`readLimitKb`. The prefix is what makes a key readable on its own and what stops
two apps colliding on `fontSize`, and `every_key_is_prefixed_by_its_group` is
what enforces it. Note the honest limitation: `Registry::register` only prints a
line to stderr for a mismatched key and registers the group anyway, so the test
is the real gate rather than a second line of defence.

`files::SETTINGS` is deliberately not a field on `apps::Registered`. An app with
no settings should not have to write `settings: None` — and a *tool*, which is
never in `apps::REGISTRY` at all, can register through this same list later.

Files' two rows are also worth reading because they are the two different kinds:
`files.readLimitKb` is read in Rust when a file is opened, and
`files.confirmDelete` is meant for the app's own frontend (§7). A section is not
obliged to be one or the other.

## 7. How an app's frontend reads settings

An app's frontend has no door to Tauri. `@veistra/bridge` is its whole interface,
so it reads settings the same way it reads anything else:

```ts
import { invoke } from "@veistra/bridge";

const settings = await invoke("settings/all");
```

`settings/all` is answered by the **host**, in `apps::call`, before the app id is
looked up at all — the method never reaches an app's dispatch. That is central
rather than per-app for three reasons: every app needs the same values, so each
one would otherwise carry the same three lines; three copies is three places to
disagree about what a missing key means; and a tool in its own process will want
the same call later, where there is no Tauri command for it to reach.

The reply is the whole `Snapshot` — every group, and the sparse `values` map — so
a frame reads a setting the same way the screen does: look the descriptor up and
fall back to `control.default` when the key is absent. **A missing key means "at
its default", never "off".**

### The gap, plainly

**There is no push of `settings:changed` into a mounted app frame.** A frame
reads settings when it mounts and hears nothing after that. Change the editor
font size and an editor already on screen keeps the size it was built with.

That is why every `editor.*` setting is `Applies::Next { what: "the next editor
you open" }` — the descriptor is telling the truth about a limitation rather than
covering for one. It is still a limitation.

The fix is a relay in `src/shell/toolwindow/ToolWindow.tsx`, which already does
exactly this shape of work: it forwards `project:changed` from Rust to every app
frame in the matching cluster, and it retains published topics so a late frame is
told the current value on handshake. `settings:changed` needs one more listener
in the same effect and, unlike `project:changed`, no cluster filter — the values
are the same everywhere. It is not written.

## 8. Where the file lives, and what is in it

`%APPDATA%/<identifier>/settings.json` on Windows, the platform equivalent
elsewhere — beside `projects.json`, `layout.json` and `presets.json`. It is the
fourth thing in the orchestrator to touch the disk and it follows the same four
rules as the other three: never fatal, atomic write, forward-compatible, and
**outside the repo**.

Outside the repo is not an implementation detail. A `settings.json` committed
into a checkout would be one contributor's font size arriving in everybody else's
editor.

**The file is sparse.** Only what has been changed away from its default is in
it. On a machine nobody has touched the screen on the file does not exist; on one
where a single toggle moved it holds one line. Setting a value *back* to its
default removes the entry rather than storing it.

That sparseness is the property that pays for itself later: **it is what lets a
build change a default and have the new one reach everyone who never disagreed
with the old one.** A file holding every key at its shipped value would freeze one
build's opinions onto every machine that ever opened the screen once.

**The schema is not in the file.** What settings exist, what they are called and
what they accept is code, so a document written by a newer build degrades to "the
keys this build still knows" rather than teaching this build about settings it
cannot draw. `Registry::hydrate` applies both filters on load and logs what it
dropped: a key no group declares (added by a later build, or removed by this one)
and a value the control refuses (a hand-edited file) both fall back to the
default rather than putting the UI in a state its own controls cannot represent.

Hand-editing the file works, because everything in it is validated on load. There
is nothing in the interface that points at it, though — see below.

## 9. Where the screen lives, and why it is not in `WindowRoot`

The settings screen is mounted in `src/App.tsx`, as a **sibling** of
`WindowRoot` rather than a child of it, and it covers the band between the title
bar and the status bar.

Search is the surface it most resembles, and the comparison is what settles it.
Search is a mode a **window** is in: it is scoped to the active cluster's
project, its field lives in that window's own switcher bar, and two windows can
honestly be searching two different things. So `searchExpanded` is a flag in
`WindowRoot`, handed down as a prop, and that is right.

Settings is none of that. One set of values, identical in every window, nothing
scoped to the cluster you happen to be looking at. A flag owned by a window would
be a per-window answer to a question that has one — and `WindowRoot` would gain a
piece of state it never reads, purely to pass it from one child to another.

So the flag lives in `src/shell/settingsSurface.ts`, a shared leaf directly under
`src/shell/` alongside `motion.ts` and `hostWindow.ts`. Regions may import those
(`eslint.config.js` says so explicitly). `App.tsx` draws the screen, above
`WindowRoot`. `WindowRoot` opens it from Ctrl+, and its status-bar git controls
close it. Apps reach it through `onSettingsOpen`. None
of those callers imports the screen.

A React context was considered and rejected: it would have to be provided in
`App.tsx`, which is where this module already effectively sits, and it would buy
nothing back — one boolean, no derived state, and no consumer that re-renders for
any reason other than the boolean itself.

### Why the two bars stay uncovered

Neither is an oversight, and they are two different arguments.

The **title bar** carries a frameless window's minimize, maximize and close
controls. Covering it would leave the window unclosable for as long as settings
was open.

The **status bar** keeps reporting while a transient surface is up. That is what
every other one in this shell does — `searchOverlay.css` states it for the search
overlay. Its git controls stay live too: one pressed while settings is up closes
settings and opens the Git page it names.

## 10. What this does not do yet

Blunt list, because an undocumented absence reads as an oversight.

- **No live push into a mounted app frame** (§7). The relay is one listener in
  `ToolWindow.tsx` and it is not written.
  Every `editor.*` setting is therefore read at editor *construction* — see
  `apps/viewer/ui/src/viewer/monaco.ts` — which is why the whole group is
  `Applies::Next`. Changing one does nothing to a tab already open.
- **Per-machine only.** There are no per-project, per-workspace or per-cluster
  settings. A project that wants a different tab width cannot have one, and two
  clusters side by side share every value on the screen.
- **No import, no export, no sync.** Copying `settings.json` between machines by
  hand works and is the whole story.
- **No JSON editor, and no "reveal settings.json".** Nothing in the interface
  names the file or its location.
- **No settings-changed hook for Rust.** Modules read on demand (§2), which is
  correct for everything that exists today because each of them reads at the
  moment it acts. Anything that later wants to hold a value derived from a
  setting would need a hook, and there is none.
- **Reset is per setting and per group.** There is no "reset everything".
- **No conditional rows.** Every setting is drawn regardless of what any other
  setting holds, so a row that is irrelevant given another's value is still
  drawn, still editable and still stored.
- **`terminal.*` has two rows.** The shell picker and the launch terminal, and
  nothing else, because `src/shell/terminal/` was owned by another workstream
  when this landed. Font size, cursor style and scrollback are the obvious next
  three, and all three are frontend settings the emulator reads — none of them
  needs anything in this module to change.
