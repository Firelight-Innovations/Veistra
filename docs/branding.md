# Branding

What the product is called, where that name is written down, and — the part
that matters more — which names are *not* branding and must never be changed.
The configuration is `branding.toml` at the repository root; this document is
the contract the two scripts, the Rust reader and every call site are written
to.

---

## 1. Why this exists, which is not the obvious reason

The obvious reason is "make it easy to change names and logos". That is a
convenience and it would not have earned a work package.

The real reason is that the source in this repository is Apache-2.0 while Veistra
and Schematify stay trademarks — the open-core split Rust, Docker and
Mozilla all use. That position is unenforceable, and worse than that
*unfollowable*, unless somebody who forks the source can strip the marks in one
place. Before this existed they would have had to find them by grep, and a
trademark policy nobody can comply with is a trademark policy that gets ignored
rather than one that gets respected.

So the requirement was never "support rebranding". It was: **the answer to "what
must I replace to ship an unbranded build" has to be a file and a command.** The
file is `branding.toml`. The commands are:

```sh
node scripts/check-branding.mjs --list   # everything that has to agree with it
node scripts/check-branding.mjs --fix    # write that agreement in, once
```

The second reason is smaller and was immediate. The product did not agree with
itself about its own name. `tauri.conf.json` said `Veistra`, `veistra.toml` said
`Veistra`, the splash wordmark said `VEISTRA`, the title bar and the About item
appended a second word to it, and `windows.rs` built detached windows titled
`Veistra`. Five surfaces, three answers. One source of truth forces that to be
answered once, and it is answered: **the product is Veistra**.

The title bar was not merely inconsistent, it was wrong. It named the shell as a
runtime — something other software is built on top of — which Veistra is not, and
it did so in the two most visible strings in the window.
`src-tauri/src/branding.rs` carries a test that fails if the product's name ever
contains "engine" again.

---

## 2. Three tiers, and only one of them is configurable

This distinction is the whole design. Getting it wrong does not produce a
cosmetic bug; it breaks every tool repository ever written and stops projects
already on disk from opening.

### Tier 1 — presentation

Everything a person reads or looks at. In scope, swappable, and enumerated in §5
so a fork can work through the list.

### Tier 2 — identity and compatibility. **Frozen.**

Not templated, not renamed, not made configurable, however much each of them
looks like branding:

- the `veistra.toml` filename
- the `.veistra` file extension and the `.veistra/` project directory
- the `veistra/*` RPC method namespace — `veistra/painted`, `veistra/commands`,
  `veistra/open`, `veistra/publish`
- the `veistra-tool://` URL scheme
- the `@veistra/*` npm scope
- the crate names
- the bundle identifier `com.firelightinnovations.veistra`
- the OS configuration directory that holds `projects.json`
- the `veistra-<id>` MCP server key

These are wire formats and on-disk contracts, not names. `docs/tool-protocol.md`
is a published API and half of it is spelled with these strings; a tool repo
written last year sends `veistra/painted` and will keep sending it. Renaming the
`.veistra` extension does not rebrand anything, it makes every existing project
unopenable. A branding system that reaches into this list is not a branding
system, it is a rename script with a config file, which is a different and much
worse thing.

This list has been renamed exactly once, from `kaava` to `veistra`, when
OpenKaava became Veistra. That was a deliberate clean break rather than a
branding change: a project whose directory is still `.kaava/` has to be renamed
to `.veistra/` by hand. Only the bundle identifier was carried across, by
`scripts/check-identity.mjs --adopt` (see `docs/dev/user-data.md`).

The same list is in `branding.toml`'s own header, deliberately duplicated,
because the next person to read that file will assume the opposite and will read
it before they read this.

Note what the boundary cuts through rather than around. `veistra.toml`'s
*filename* is frozen; its `[stack] name` value is tier 1 and is checked. The
bundle *identifier* is frozen; `productName` is tier 1 and is checked. Neither
file is wholly on one side.

### Tier 3 — the trademark surface

Exactly tier 1, enumerated. That correspondence is the deliverable: the tier-1
list and the answer to "what does the trademark policy cover" are the same list,
so they cannot drift apart into two documents that disagree.

---

## 3. The shape of the system

```
branding.toml                     the one file anybody edits
    │
    ├── src-tauri/src/branding.rs        include_str!, parsed once
    │       └── project::retitle, windows::create, apps::home's picker
    │
    ├── scripts/generate-branding.mjs    emits, on every typecheck and build:
    │       src/branding.generated.ts               the shell
    │       apps/home/ui/src/branding.generated.ts  Home
    │       apps/files/ui/src/branding.generated.ts Files
    │
    └── scripts/check-branding.mjs       `pnpm lint`; fails naming file + field
            index.html · splash.html · veistra.toml · tauri.conf.json
```

Three decisions in that picture are load-bearing.

**The frontend is generated, not fetched.** A browser cannot read TOML. The
alternative is an async fetch, which puts a request in front of the first frame
of every surface that says the product's name — including the window title,
which is exactly the thing that must not arrive late. So the strings are
compiled in.

**Rust embeds the file at compile time rather than locating it at run time**,
which is the one place this deliberately does *not* look like
`src-tauri/src/manifest.rs`. The manifest is found on disk because it points at
checkouts that differ per machine, and an installed build has to let someone
drop a replacement beside the executable. Branding is the opposite on both
counts. Tauri bakes `productName` and the window title into the bundle when it
is built; if Rust read the name at run time, the installer's name and the window
title could disagree *on one machine, at once* — which is precisely the class of
bug this whole package exists to remove. `include_str!` commits every surface at
the same moment, and cargo rebuilds when the file changes. It also means
`branding.toml` needs no entry in `bundle.resources`, unlike `veistra.toml`.

**One generated module per frontend bundle, not one shared module.**
STANDARDS.md §1.4 says an app reaches its host through `@veistra/bridge` and
nothing else, and `apps/home/ui/src/icons.tsx` already refuses to import the
shell's `Icon.tsx` for that reason. A generated file inside the app's own source
tree is the only form that survives the app being extracted to its own
repository, which `apps/README.md` says is the point of the boundary. The
rejected alternative was to send brand strings over `home/state` as RPC data;
that works, but it makes a build-time constant into runtime data and adds a
protocol field for something that cannot change while the process is running.

### Why `tauri.conf.json` and the HTML are checked rather than rewritten

Two reasons, and the second one decided it.

Tauri owns the schema of its own configuration file. Rewriting a tracked file on
every build produces diffs nobody asked for, and a `format:check` that disagrees
with the build that just ran — the same failure `src-tauri/gen/` and the
generated icon manifest are in `.prettierignore` to avoid. `splash.html` has a
stronger version of the same objection: its whole design is that it is
standalone and readable, and generating it would end that.

And a check that *names each surface it checks* is the tier-3 list. The same
work answers both questions, and the answers cannot drift apart because they are
the same code. It is also the idiom the repository already uses: the three lint
baselines report and refuse rather than quietly fixing.

The cost is that renaming the product is not one edit: `branding.toml` moves,
and then four tracked files have to be brought along. `--fix` pays that cost
without giving up the property that decided the design — **the operator asks for
the rewrite; the build never does.** The rename is one file and one command, the
diff is one commit a reviewer can read, and nothing is being rewritten
underneath a `format:check`. Each surface declares one three-group pattern that
serves both reading and rewriting, so the check and the fix cannot come to
disagree about which span of the file holds the value.

---

## 4. What is in the file, and what is not

Every field has a reader. That is the rule `docs/settings.md` §1 states for
settings and it applies here for the same reason: a value nothing consumes is a
promise the system does not keep, and the person who finds out is the one who
changed it and watched nothing happen.

| Key | Read by |
|---|---|
| `product.name` | the generated modules, `branding.rs`, and five checked files |
| `product.wordmark` | the generated modules, and `splash.html`'s check |
| `product.tagline` | Home's hero, and nothing else |
| `product.company` | nothing today; the splash used to set it beside the wordmark |
| `product.copyright` | `splash.html`'s check, the notice in its band |
| `assets.mark` | the generator, which lifts its path data into the modules |
| `assets.mark-colour` | `Mark` in `apps/home/ui/src/icons.tsx`, by hand |
| `assets.icon-source` | `pnpm tauri icon <path>`, run by a person |
| `assets.bundle-icons` | the check on `tauri.conf.json`'s `bundle.icon` |

`product.wordmark` is a separate field from `product.name` and is set in mixed
case, because a stylesheet that draws the wordmark may uppercase it. The markup
holds "Veistra" so a screen reader is handed a word; the screen shows "VEISTRA".
`apps/home/ui/src/home.css` makes that trade for the lockup. `splash.html` sets
the wordmark as written, with its ™ in a span of its own, and nothing beside it.

The splash while boot works, settled and a moment after it opens (672x492, the
window's size, rendered from `splash.html` in Chromium):

![The splash, settled](images/splash-working.png)
![The splash, just after it opens](images/splash-intro.png)

**Not in the file, deliberately:**

- **Colours and fonts.** They are `src/tokens.css` and they stay there. This is
  not a theming system; a branding system that grows a palette is the settings
  screen with extra steps.
- **A build flag that swaps one vocabulary for another.** A flag switching one
  word for another across the interface is a fork with extra steps, and small
  forks grow. One config, read once, one build.
- **`package.json`.** It is checked by nothing here because it holds no brand
  string. Its `name` is `veistra-orchestrator`, the npm identity of a package
  marked `private` and never published — the same category as the `@veistra/*`
  scope, which is tier 2.
- **Prose in `docs/`, and the docs on veistra.com.** They say Veistra because
  they are teaching Veistra, and docs written about a fork are docs that need
  rewriting anyway. The Docs pane draws the website's pages as they are; a fork
  points `account.webUrl` at its own site.

### The grammar `branding.toml` may use

`branding.toml` restricts itself to `[table]` headers, `key = "value"` string
entries, `#` comments and blank lines. Rust reads it with the `toml` crate and
so is unbothered, but the two Node scripts share a reader in
`scripts/read-branding.mjs` that understands only that much and refuses anything
else by line number.

Taking a TOML dependency for one file was the alternative, and so was
hand-rolling a real parser. A full parser in JavaScript would be a second
implementation that has to agree with Rust's across the whole format; a grammar
small enough to be obviously correct cannot disagree, because everything it does
not understand is an error rather than a guess.

---

## 5. What a fork replaces

`node scripts/check-branding.mjs --list` prints this. It is repeated here in
prose because the list is also the trademark surface.

**Strings.** All of them come from `branding.toml`:

| Where | What |
|---|---|
| `index.html`, `splash.html` | the page `<title>` |
| `src-tauri/tauri.conf.json` | `productName` — also the installer's filename |
| `src-tauri/tauri.conf.json` | the main window's `title` |
| `veistra.toml` | `[stack] name` |
| `splash.html` | the wordmark text node and the copyright notice |
| the title bar | the centred title, and the About item |
| Home | the lockup word and the tagline |
| Files | the purge confirmation, which names the product |
| the OS window title | `project::retitle`, per window, per project |
| a detached window | `windows::create`'s initial title |
| Home's folder picker | the dialog caption |

**Art.** `assets/` is the brand pack, and everything in it is replaceable:

- `assets/veistra-mark.svg` — the mark, as a monochrome silhouette. The generator
  lifts its `viewBox` and its single `<path>` into the frontend modules, and
  **fails the build** if the file cannot be reduced to one path. A more
  complicated mark belongs on a surface that loads it as a file. It also lifts
  `d` and nothing else, so a `fill-rule` on the source path is dropped silently:
  a counter has to work under the default nonzero rule, by winding.
- `assets/veistra-mark-colour.svg` — the same mark in brand rust, which the
  generator does not compile in. Its one reader is `Mark` in
  `apps/home/ui/src/icons.tsx`, which inlines the geometry by hand so the fill
  can be `var(--mark-rust)`. Changing the mark means changing both files; the
  silhouette is the one the generator checks.
- `assets/app-icon-source.svg` — what `pnpm tauri icon` draws the PNG set from.
- `assets/veistra-icon.svg`, `veistra-icon-256.svg` — the container-icon variants,
  the brand packet's black tile (ink ground `#0B0C0E`, paper mark `#F2F4F5`) at
  24 and at 256. The mark is 48% of the tile wide at 256 and 56% at 24, and the
  corner radius is 9% of the tile. `src-tauri/icons/` is drawn from the same
  geometry by `export_app_icons.py` in the company folder's
  `tools/brand-mark-design/scripts/`.
- `src-tauri/icons/` — the generated icon set. Every path in `bundle.icon` is
  checked to sit inside this directory and to exist.
- the typefaces, inlined as base64 woff2 subsets in `splash.html`. They are
  the one asset with no path to declare, because they are not files; the
  comment above them gives the `pyftsubset` command that regenerates them.
- the mark on the splash. `splash.html` cannot load `assets/`, so it carries its
  own copy of the geometry: the block and the two slots its art script draws
  the mark from, and the fallback SVG it shows when it cannot draw. Both are
  monochrome, in the text colour. Changing the mark means changing both copies;
  nothing checks it.

**Not replaced:** everything in §2's frozen list.

---

## 6. The mark is drawn, not loaded

`src/ui/Icon.tsx` and `apps/home/ui/src/icons.tsx` both draw the mark as an
inline `<path>`, and the geometry for both is generated out of
`assets/veistra-mark.svg`. This was the one call site that needed a decision, so
here is the decision and the reason.

Loading the branded asset as an `<img src="/veistra-mark.svg">` was the
alternative. It fails on colour. The mark is drawn on the title bar at 15px in
the title bar's own text colour, and again — larger — as the placeholder every
tool shares until it earns its own icon. `fill="currentColor"` is what makes
both of those inherit the CSS token on the parent, and an `<img>` cannot inherit
anything. Every call site would have to decide a colour, which is the exact
thing the header of `Icon.tsx` exists to prevent. A CSS mask would work and
would cost a request plus a second way of drawing one glyph.

Leaving it as a hardcoded default was the other alternative, and it is what the
code did before: the path data was copied into two files, and a comment in each
one claimed the copy was faithful. That claim was the only thing checking it.
Generating the geometry makes `assets/veistra-mark.svg` the actual source rather
than the nominal one, and a fork replaces one SVG instead of finding two string
literals.

**Home's lockup is the exception, and it is the colour that buys it.** Home
draws the mark at 52px in brand rust, where every other surface draws it in
`currentColor`. The generator carries one path and no colour decision. So `Mark`
in `apps/home/ui/src/icons.tsx` writes the geometry out with `var(--mark-rust)`,
and `assets/veistra-mark-colour.svg` is the file it is a copy of. Two files to
keep in step is the price; the argument above still holds for the silhouette,
which is what the other four call sites draw and what the generator still checks.

---

## 7. Adding a surface

If you write something that names the product:

1. Read it from the generated module (`PRODUCT_NAME`, `WORDMARK`, `TAGLINE`) or,
   in Rust, from `branding::product_name()`. Never write the name out.
2. If the surface is a file that cannot import — another HTML entry point, a
   config file some tool owns — add it to `SURFACES` in
   `scripts/check-branding.mjs` instead. One entry gets it checked, fixable and
   listed, because all three read the same declaration.
3. If it is a new frontend bundle, add its path to `OUTPUTS` in
   `scripts/generate-branding.mjs`, and to `.gitignore`, `.prettierignore` and
   the ignore lists in `eslint.config.js` and `scripts/check-comments.mjs`.

If you want to add a *field*, name its reader first. If the answer is "nothing
yet", it does not go in.

### A drawing of a surface is a surface

Prose is never templated, but a bundle that *draws* a branded surface rather
than describing it belongs in `OUTPUTS`. The bundled Tutorials app was the
example: its mocks rendered the title bar's centred caption, and drew the old
two-word product name until they were wired to `PRODUCT_NAME`. That app is gone
(its content moved to veistra.com/docs), but the rule stands. A picture that
survives a rename by not being renamed has quietly stopped being one, so
anything that redraws a branded surface reads the name the same way the surface
does.
