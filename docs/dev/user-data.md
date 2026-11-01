# User data, reinstalls and updates

Eight JSON files and a directory of plugin checkouts hold everything Veistra
remembers about a person. None of them is versioned, none of them is backed
up, all of them live at a path derived from the bundle identifier, and until
the rename nobody had to think about that. This page is the system that makes
reinstalling and updating safe: where user data lives, how a build reads a
file an older or newer build wrote, and the check that stops a path moving
without somebody deciding it should.

Written after `com.firelightinnovations.helve` became
`com.firelightinnovations.openkaava` and orphaned a live directory. That
instance is being accepted — there is one user and they can reinstall — so
this is about the second time, not the first. The second time was OpenKaava
becoming Veistra, and it went through `check-identity.mjs --adopt`: the
OpenKaava identifier and product name are in the superseded lists, so the
first launch of Veistra adopts the old config directory.

## What is actually at risk

Nine stores under the config directory, plus one inside each checkout.
Everything here is what exists today, read off `src-tauri/src/` and off this
machine.

| File | Written by | Holds | Losing it costs |
|---|---|---|---|
| `layout.json` | `shell_store.rs` | every window, its geometry, clusters, pane trees, tab order, terminal tabs | the workspace: what you had open and where |
| `projects.json` | `project/store.rs` | the Recent list, capped at 20 | the history of what you have worked on |
| `settings.json` | `settings/store.rs` | only settings changed from their default | every preference you have moved |
| `presets.json` | `presets/store.rs` | saved layout presets, not the built-ins | a library the user built by hand, one preset at a time |
| `plugins.json` | `plugins/store.rs` | one record per installed package, and its switch | which apps you installed and where from |
| `mcp.json` | `mcp/store.rs` | only server switches moved from their shipped state | which MCP servers you turned on or off |
| `tutorials.json` | `apps/tutorial.rs` | the set of completed tutorial ids | tutorials offer themselves again |
| `telemetry.json` | `telemetry.rs` | the anonymous install id, launch and event counts, which feedback prompts were shown | a new anonymous id, and a feedback question may be asked again |
| `mcp-endpoint.json` | `mcp/handoff.rs` | this launch's port, token and pid | nothing — rewritten at every launch |
| `plugins/` | `plugins/install.rs` | unpacked plugin checkouts, one directory per id | a re-download, if the source is still there |

All ten resolve through the same two lines, repeated in nine modules:

```rust
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}
```

On this machine that is `%APPDATA%\com.firelightinnovations.<identifier>\`, and
the directory the rename orphaned still holds `layout.json`,
`mcp-endpoint.json`, `projects.json`, `settings.json` and `tutorials.json`.

Two more things are user data and are not in that directory:

- **`.veistra/review-comments.json`**, inside each checkout. Review notes are
  about the code rather than about the machine, so they travel with the branch
  — `review/store.rs`'s module doc makes that argument in full. It is not at
  risk from a rename, and it is the only store here that already carries a
  format version.
- **The GitHub token**, in the Windows credential store under the service name
  `com.firelightinnovations.veistra` — a *hardcoded copy* of the identifier
  in `plugins/install.rs`, not the one Tauri derives paths from. It changed
  when the identifier did, so the stored token is orphaned exactly the way the
  directory is.

### Precious and cheap

The distinction matters because it decides what earns a backup and what a
migration is allowed to throw away.

**Precious** — the user typed it, and nothing can reconstruct it:
`projects.json`, `presets.json`, `settings.json`, `plugins.json`,
`.veistra/review-comments.json`.

**Reconstructible with effort** — losing it is annoying rather than
destructive: `layout.json` (rearrange the windows again), `mcp.json` (flip the
switches again), `tutorials.json`, `telemetry.json`, `plugins/` (re-download).

**Cheap** — regenerated without the user noticing: `mcp-endpoint.json`, and the
WebView2 profile under `%LOCALAPPDATA%\<identifier>\EBWebView`.

`layout.json` sits awkwardly. It is not precious by content, but it is the file
written most often — `shell_store::persist` runs inside every
`ShellState::mutate`, so a divider drag writes it — which makes it the one most
likely to be caught by a crash and the *worst* candidate for a
backup-on-every-save.

## Where user data lives, and why that is a choice

`app_config_dir()` is Tauri's, and on Windows it appends the bundle identifier
to `%APPDATA%`. That derivation is convenient right up to the moment the
identifier moves, and then it is the bug.

The tempting fix is to stop using it: give the orchestrator its own
`userdata::dir()` returning `%APPDATA%\Veistra\`, wire the eight stores
through it, and the identifier can then say whatever it likes.

**Rejected, because it fixes one consumer out of four.** The identifier is not
only a path component; four separate things are derived from it, and only the
first is ours to redirect:

| Derived | By | What a change does |
|---|---|---|
| `%APPDATA%\<identifier>\` | `app_config_dir()` | the eight stores start empty |
| `%LOCALAPPDATA%\<identifier>\EBWebView` | Tauri's WebView2 setup | every webview login and cookie is gone |
| `{identifier}-sim`, `-siw`, `-sic` | `tauri-plugin-single-instance` | two builds run at once |
| `KEYRING_SERVICE` | a literal in `plugins/install.rs` | the stored GitHub token is orphaned |

The third is the one that turns an inconvenience into data loss. The mutex name
is `format!("{id}-sim")` where `id` is `app.config().identifier` — read from
`tauri-plugin-single-instance` 2.4.3, whose `semver` feature this crate does
not enable, so nothing else is folded in. Two builds with different identifiers
hold different mutexes, both run, and both write `layout.json` and
`projects.json` over each other. That is precisely the failure `launch.rs`
registers the plugin to prevent, and its module doc says so.

Owning the config path would leave the webview profile, the mutex and the
keyring behind, so a rename would still cost the user their sessions and still
let two copies fight over one directory — a *worse* outcome than today, because
the settings surviving makes it look like the rename went fine.

**So: keep `app_config_dir()`, and make the identifier a checked constant.**
One string, pinned in one place, with a check that fails the build when it
moves without an adoption path. That fixes all four consumers at once and adds
no path resolution of our own to maintain.

The trade being made honestly: this keeps a dependency on Tauri's derivation
rule. If Tauri v2 ever changed where `app_config_dir()` points on Windows, a
pinned identifier would not save anybody. That is a real risk and it is small —
the rule is `%APPDATA%\<identifier>`, it is what every Tauri v2 app on Windows
depends on, and a change to it would be a breaking release the migration story
below would cover the same way it covers a rename.

`ui:build` in `package.json` already overrides the identifier to
`com.firelightinnovations.veistra.agent`, which is how an agent's instance
gets its own directory and its own mutex rather than fighting Braden's. That
suffix is deliberate and the check has to know about it rather than trip over
it.

## The identifier, and the check that makes a rename announce itself

`branding.toml` already says the identifier must not move. Under **What is
frozen**, beside the `veistra.toml` filename and the `veistra-tool://` scheme:

> `com.firelightinnovations.veistra` / the OS config directory holding
> `projects.json`

That is a comment. `scripts/check-branding.mjs` checks six surfaces and the
icon set; it does not check the identifier, because the identifier is not
branding — the frozen list is stated in `branding.toml` precisely to say what
`check-branding.mjs` is *not* allowed to rewrite. So the one file that declares
the identifier frozen is also the file that guarantees nothing enforces it, and
the rename went through with every check passing.

`docs/dev/releases.md` repeats the claim as fact:

> The bundle identifier does *not* change, and neither does the OS
> configuration directory Tauri derives from it, so nobody's existing projects
> or settings move.

Both halves are now false, and neither had anything watching it. **A written
promise about a value nothing checks is a value that will change.** The rest of
this section is the check.

### What actually changed, and what did not

Worth separating, because two symptoms were blamed on the identifier and only
one is its fault. Read from the generated
`src-tauri/target/release/nsis/x64/installer.nsi` and from this machine's
registry:

- `UNINSTKEY` is `Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}`,
  and the key on this machine is literally `HELVE`.
- The default install directory in `currentUser` mode is
  `$LOCALAPPDATA\${PRODUCTNAME}`, and this machine has `%LOCALAPPDATA%\HELVE`.
- The installer's "is there an existing install" probe reads `UNINSTKEY`.

So **`productName` is what put OpenKaava beside HELVE**: two install
directories, two Add/Remove entries, and an upgrade probe that looked for a key
under the new name and found nothing. The identifier is what orphaned the app
data, split the mutex, and orphaned the keyring entry. They are two independent
renames that happened in one commit, and a check that guards only one of them
would have caught half of this.

### `scripts/check-identity.mjs`

In the family of `check-version.mjs` and `check-branding.mjs`, and built to
their shape: a list of surfaces, each naming its file, its field and how to
find it; a report that names every disagreement; a flag that performs the
change rather than letting the build perform it.

The pinned values live in the script as literals, the way `CONF_INDIRECTION`
does in `check-version.mjs`. Not in `branding.toml` — that file is what a fork
edits, and these are on-disk contracts rather than presentation. A fork is
still free to move both: by editing the two lines below and running `--adopt`,
which is the difference between a rename and a rename that strands data.

```js
export const IDENTITY = {
  identifier: "com.firelightinnovations.veistra",
  productName: "Veistra",
};
```

| Surface | Must be | Because |
|---|---|---|
| `tauri.conf.json` `identifier` | `IDENTIFIER` | the config dir, the webview profile and the mutex |
| `src-tauri/src/userdata/identity.rs` `IDENTIFIER` | `IDENTIFIER` | what the adoption list is written against |
| `plugins/install.rs` `KEYRING_SERVICE` | `IDENTIFIER` | the stored GitHub token |
| `package.json` `ui:build` `--config` | `IDENTIFIER + ".agent"` | an agent instance must not share a directory |
| `tauri.conf.json` `productName` | `PRODUCT_NAME` | the install dir and the Add/Remove entry |
| `installer-hooks.nsh` install key stem | `OpenWith${PRODUCT_NAME}` | see below |
| `installer-hooks.nsh` uninstall key stems | that, and every superseded name | see below |
| `identity.rs` `SUPERSEDED` | must not contain `IDENTIFIER` | a directory cannot supersede itself |

The registry check is not theoretical. `installer-hooks.nsh` writes
`Software\Classes\Directory\shell\OpenWithVeistra` — but this machine still
has `OpenWithHELVE` under that path, written by an installer whose uninstaller
is the only thing that will ever remove it. Renaming the key in both macros at
once looks correct and leaves litter in every existing install's registry, so
the uninstall macro now deletes both stems and the check requires it to.

The failure message is the whole value of the check, so it says what to do:

```
identity: 1 problem(s)

  src-tauri/tauri.conf.json identifier is "com.firelightinnovations.example",
  but the identity is "com.firelightinnovations.veistra". Changing it moves
  %APPDATA%\<identifier>\, the WebView2 profile, the single-instance mutex and
  the keyring entry.

  If the move is deliberate, set the values at the top of this script and run:

    node scripts/check-identity.mjs --adopt

  which writes them to every surface above and records what they replaced in
  SUPERSEDED, so the next launch adopts the old config directory instead of
  starting empty. See docs/dev/user-data.md.
```

`--adopt` takes no argument: what is being replaced is whatever
`tauri.conf.json` currently says, and reading it there rather than from the
command line removes the one way of getting the pair the wrong way round.

`--adopt` is one command that does the whole rename, for the reason
`check-version.mjs --set` writes both files: the two halves cannot be done apart
and end up in a state where one shipped and the other did not.

Wired as `lint:identity`, first in `pnpm lint` beside `lint:version`, so it
runs on every commit and in CI.

The pure parts export for `scripts/check-identity.test.mjs`, the way
`update-manifest.mjs` does — vitest already picks up `scripts/**/*.test.mjs`.

### Adoption, when it does change anyway

Sometimes a rename is right. `src-tauri/src/userdata/identity.rs`:

```rust
/// The bundle identifier, and every one it replaced, newest first.
pub const IDENTIFIER: &str = "com.firelightinnovations.veistra";
pub const SUPERSEDED: &[&str] = &[
    "com.firelightinnovations.openkaava",
    "com.firelightinnovations.helve",
];
```

The product name's equivalent list lives in `check-identity.mjs` instead, and
that split is deliberate rather than untidy: Rust reads `SUPERSEDED` at every
launch, and has no reader at all for the old *product* names — their only two
consumers are the uninstall macro that deletes `OpenWith<name>` and the check
that makes sure it still does. A constant in a language that never reads it is
a constant that goes stale.

At startup, before `settings::seed` in `lib.rs`'s setup — earlier than anything
that reads a store — `userdata::adopt::run` walks `SUPERSEDED` in order and
**moves** the first directory it finds into the current one.

Move rather than copy, and that is not tidiness. The NSIS uninstaller's
"Delete the application data" checkbox deletes `$APPDATA\${BUNDLEID}` and
`$LOCALAPPDATA\${BUNDLEID}` — the *current* identifier's directories only. A
copied-from directory would survive an uninstall that the user explicitly asked
to take their data with it, which is a data-retention bug rather than a
data-loss one, but is still the app doing something other than what it was
told.

Four rules, each of which is a test below:

1. **It runs only when the current directory holds none of the eight stores.**
   Adoption is a first-launch-after-rename act. A directory with a
   `layout.json` in it is a directory somebody has already used, and moving an
   older one over it would be the data loss this whole page is about.

   Seven of the eight, in fact: `mcp-endpoint.json` is excluded, because
   `mcp::handoff` rewrites it at every launch and it therefore appears in a
   directory nobody has ever changed a setting in. Counting it would have made
   adoption a first-*launch* act rather than a first-launch-after-a-rename one,
   and the rename is usually noticed on the second launch or the tenth.
2. **A missing superseded directory is not an error.** Every machine that never
   had the old build is in that state, which is most of them. An *empty* one is
   passed over for a sharper reason: adopting it would write the marker below,
   and the marker is what stops the next candidate ever being looked at.
3. **It leaves a marker.** `adopted-from.json`, naming the identifier it took
   and when, so the act is visible on disk and a second launch does not try
   again after the user has deleted something.
4. **Failure is not fatal.** Every store already degrades to its default; an
   adoption that cannot move a directory logs through `veistra_log!` and lets
   that happen, on the same rule the eight stores follow.

The keyring entry cannot be moved this way — `keyring::Entry` has no rename —
so adoption reads the token from the superseded service name, writes it under
the new one, and deletes the old. Same rules, same non-fatal handling, plus one
of its own: it refuses to overwrite a token already stored under the current
name, because a credential this build was given is newer than one an older name
was left holding.

`plugins::install::adopt_token` is the one piece here with no test, and that is
a limit rather than an omission: `keyring` talks to the real Windows credential
store, so a test would either write a credential onto the machine running
`cargo test` or assert nothing.

## Versioning and migration

### What exists

Two files already carry a format version, and both state the same bump rule.
`project/marker.rs`:

```rust
/// Bumped when a change would make an *older* build misread the file, not
/// merely miss part of it. Adding a key is not a bump; changing what an
/// existing key means is.
pub const FORMAT: i64 = 1;
```

`review/store.rs` repeats it, and wraps its notes in a `Document { format,
comments }` rather than writing a bare array — its doc says why: "An array has
no room for one, and discovering that after people have files on disk is how a
format ends up with a sidecar."

**The eight config-directory stores have none of this.** Every one of them is a
bare `Stored` struct with `#[serde(rename_all = "camelCase", default)]`, and
their forward-compatibility story is entirely serde's: unknown fields are
ignored, missing fields default. That is genuinely most of what is needed, and
`shell_store.rs` has two tests proving a `layout.json` from two earlier shapes
still loads.

### What it does not survive: a downgrade

Serde's ignore-unknown-fields is not a read-only operation here. Consider a
`layout.json` written by a build that added a field, opened by a build that has
not heard of it:

1. `shell_store::load` parses it, silently dropping the field.
2. The user drags a divider.
3. `ShellState::mutate` calls `persist`, which serializes the struct **without
   the dropped field** and renames it over the original.

The newer build's data is gone, permanently, from one drag. Nothing logged,
nothing to recover. This is the single worst failure in the current design and
it needs no rename to trigger — only an update followed by a downgrade, which
`releases.md` already says people do by hand from `/releases`.

### What replaced it

A `format` field on all eight, read through one shared helper rather than
copied nine times.

```rust
// src-tauri/src/userdata/store.rs
pub const FORMAT: i64 = 1;

#[derive(Deserialize)]
struct Envelope {
    #[serde(default = "format_one")]
    format: i64,
}
```

Reading is two passes over the same text. First parse the envelope and look at
nothing but `format`; then decide:

| `format` | What happens |
|---|---|
| absent | read as 1 — every file on disk today, and no rewrite needed to make it so |
| `== FORMAT` | parse normally, exactly as before |
| `< FORMAT` | back up, run the migration chain, parse, write the result back |
| `> FORMAT` | **do not parse.** Set the file aside and start from the default |

The third row has no code behind it yet and deliberately so: at `FORMAT = 1`
the only file that can be *below* the current format is one with no field at
all, which row one already covers. An empty migration chain is a shape to
maintain rather than a behaviour, and the first bump is what earns it.

The last row is the downgrade fix. "Set aside" means moving the file into
`backups/` as `layout.format-3.<unix-ms>.json`, intact, and `veistra_log!` says
which file and which format so `pnpm probe recent_errors` can answer why the
workspace came back empty.

Beside the original was the first shape and it was half a fix. Nothing ever
looked at a suffixed name, so "the next launch of the newer build finds it" was
only true if the user renamed it back by hand. It is in `backups/` because that
directory has a retention policy — a downgrade repeated across two versions
would otherwise leave `projects.json.corrupt-<ms>` files accumulating with
nothing to trim them — and because `store::read` now takes one back: on a file
that is **missing**, it looks for the newest backup labelled with *this* build's
format and restores it. That can never overwrite live data, since it only runs
when there is none, and it is what makes "lost for the duration of the
downgrade" true rather than aspirational.

The bump rule stays `project::marker`'s, verbatim: a bump is for a change that
would make an older build *misread* the file, not merely miss part of it.
Adding a field is not a bump — serde already handles that in both directions,
and bumping for it would set aside a file over a change that costs nothing.

### Corrupt and partially written

The degradation is unchanged, and it was right. Every one of the eight `load`
functions used to end in the same shape, and `userdata::store::read` now ends
in it once:

```rust
serde_json::from_str(&raw).unwrap_or_else(|e| {
    crate::veistra_log!("{} is not readable, starting fresh: {e}", path.display());
    Stored::default()
})
```

`project/store.rs`'s doc has the argument: "the worst honest outcome of a
corrupt file is an empty Recent list, and that is a great deal better than an
app that will not open." That holds. What changes is that a corrupt *precious*
file is set aside before the default is written over it, on the same mechanism
as a future format — `backups/projects.corrupt.<unix-ms>.json` — so a person who
can read JSON can get their Recent list back out of it by hand. A corrupt
`layout.json` is not worth the copy.

`review/store.rs` is the deliberate exception in the other direction: its
`save` returns a `Result` because it holds prose somebody just typed, and a
silent failure would leave a note on screen that is not on disk. Nothing here
changes that.

## Atomic writes

All eight stores already wrote temp-then-rename, and `shell_store.rs` states
the reason: "A crash mid-write leaves the previous layout intact rather than
half of two." That is real and it is the important half. Two gaps remained, and
both are closed in `userdata::store::write_raw`.

**No `sync_all`.** `std::fs::write` opens, writes and closes; it does not flush
the file to the physical device. `rename` then replaces the directory entry.
The ordering of the data write and the rename record reaching the disk is up to
NTFS and the drive, and on a power loss the observed result can be a correctly
named file that is empty or short. The rename protects against a *crash* — the
process dying between two writes — and does not protect against power loss. The
fix is four lines:

```rust
let mut file = std::fs::File::create(&temp)?;
file.write_all(json.as_bytes())?;
file.sync_all()?;
drop(file);
std::fs::rename(&temp, &path)?;
```

Worth doing for the precious stores, and arguably not for `layout.json`, which
is written on every divider drag and would pay a device flush for each one. It
is paid for that one too rather than made conditional: the write is a few
kilobytes, and the file rewritten most often being the one file *not* committed
is exactly backwards. If it ever measures as a problem the answer is to debounce
the layout write, not to skip the flush — and that measurement has not been
taken, which is a claim this page should not pretend otherwise about.

**The temp name is fixed.** Every store computed
`path.with_extension("json.tmp")`, so two processes writing the same store
wrote the same temp path and interleaved into one file. That needs the
single-instance mutex to have failed — which is exactly what an identifier
change does. The temp file now carries the pid: `layout.json.<pid>.tmp`. It
costs nothing and it removes the coupling between a naming mistake and a
corrupt file.

`std::fs::rename` on Windows goes through `MoveFileEx` with
`MOVEFILE_REPLACE_EXISTING`, so replacing an existing file is fine and the
existing code correctly relies on it. It can still fail with a sharing
violation if a reader holds the destination open, which is why every store
already has a branch that removes the temp file and logs.

## Backups

**Not on every save.** `layout.json` is rewritten hundreds of times a session;
a copy per save is a garbage generator with a rotation policy bolted on.

A backup is taken at exactly the two moments the file is about to be replaced
by something derived rather than by something the user just did:

1. before a migration runs, and
2. when a file is set aside as corrupt or future-format.

The second turned out to be the *whole* of setting aside rather than something
extra beside it, which is why there is no `projects.json.corrupt-<ms>` next to
`projects.json` any more: one mechanism, one directory, one retention policy.

They go to `%APPDATA%\<identifier>\backups\`, named
`<stem>.<label>.<unix-ms>.json` where the label is `format-<n>` or `corrupt` —
so a person reading the directory can tell which build wrote which and why it
was kept. **Three per stem**, oldest deleted first, and the labels share one
budget per file: a store that has been corrupt twice and from the future once
has had three interesting moments, not three of each. Three because the
interesting one is almost always the most
recent, and the second and third exist for the case where a migration was wrong
and shipped in two consecutive versions.

The `backups/` directory is inside the config directory deliberately, not
beside it: it is user data, adoption should move it with everything else, and
the uninstall checkbox should take it when the user asks for their data to go.

## Install and uninstall

What NSIS does today, read from the generated template rather than from
memory:

- Installs to `$LOCALAPPDATA\${PRODUCTNAME}`, currentUser, no Administrator.
- Writes `Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}`.
- On uninstall, offers a **"Delete the application data"** checkbox on the
  confirm page. It is created with no `BM_SETCHECK`, so it starts unchecked —
  the default is to keep user data, which is the right default and needs no
  change.
- When checked, it removes `$APPDATA\${BUNDLEID}` and
  `$LOCALAPPDATA\${BUNDLEID}` — the identifier's directories, including
  `backups/` and the `plugins/` checkouts. Not the keyring entry, and not
  anything under `.veistra/` in a checkout.
- The confirm page carries `un.SkipIfPassive`, and `plugins.updater.windows.installMode`
  is `passive`. **An update can therefore never reach the checkbox**, which is
  exactly right: an update is not a moment at which anybody agreed to lose
  anything.

Three changes:

1. **The uninstaller should say what it is deleting.** "Delete the application
   data" does not distinguish a window layout from a Recent list and a plugin
   library. The `deleteAppData` LangString is Tauri's, but
   `installer-hooks.nsh` can add a line to the confirm page naming the
   directory and the fact that projects themselves are untouched. A person who
   is uninstalling to fix something needs to know that leaving it unchecked is
   safe.
2. **The uninstall macro should remove the keyring entry**, or the app should.
   Today an uninstall with the box checked leaves a GitHub token in the Windows
   credential store forever. NSIS has no clean way to reach it, so the
   honest version is a `--uninstall-credentials` argument on the binary that
   the uninstall macro invokes, and which fails quietly.
3. **`installer-hooks.nsh`'s uninstall macro should delete the superseded key
   names too** — `OpenWithHELVE` alongside `OpenWithVeistra` — for the same
   reason `SUPERSEDED` exists in Rust. A rename otherwise leaves a context-menu
   entry pointing at a binary that is no longer there.

An **uninstall must never delete `.veistra/` inside a checkout**, and today it
cannot, since it only knows about `$APPDATA` and `$LOCALAPPDATA`. Worth writing
down anyway: review notes are inside the user's own repository, and an
uninstaller that reached into a source tree would be doing something no
uninstaller is allowed to do.

## The plan

Four stages, ordered by what stops the next loss soonest. Each ships on its
own; none needs the one after it. Test names are the ones written, in
`#[cfg(test)]` beside the code per STANDARDS.md §8.

The plan opened with five, keeping adoption for last on the grounds that it is
the only stage not needed until the *next* rename. It is stage 1's other half
instead, and for a plain reason: `SUPERSEDED` with nothing reading it is dead
code, so the pinned constant and the thing that acts on it either land together
or the first of them does not compile clean.

### 1. The check, the identity constant, and adoption

`scripts/check-identity.mjs`, `src-tauri/src/userdata/identity.rs`,
`src-tauri/src/userdata/adopt.rs`, the superseded keys in
`installer-hooks.nsh`, and `lint:identity` in `pnpm lint`. First because it is
the only stage that prevents rather than repairs.

- `scripts/check-identity.test.mjs` — `it("rejects an identifier that does not
  match the pinned identity")`, `it("accepts the agent suffix on ui:build")`,
  `it("rejects an identity that is also in the superseded list")`.
- `identity::tests::the_identifier_is_not_also_superseded`
- `identity::tests::the_keyring_service_is_the_identifier` — the literal in
  `plugins/install.rs` and this constant, asserted equal in Rust as well as in
  the script, so the two languages have to agree.
- `adopt::tests::a_superseded_directory_is_moved_and_marked`
- `adopt::tests::adoption_is_skipped_when_the_current_directory_has_files`
- `adopt::tests::a_missing_superseded_directory_is_not_an_error`
- `adopt::tests::the_newest_superseded_identifier_wins`
- `adopt::tests::a_second_launch_does_not_adopt_again`
- `adopt::tests::an_unused_superseded_directory_is_passed_over`

Also: correct the false claim in `docs/dev/releases.md` and point it here.

### 2. Downgrade safety and the format field

`src-tauri/src/userdata/store.rs` with the shared envelope read, the
set-aside path, and the eight stores wired through it. Second because the
downgrade case loses precious data with no rename involved and no way to get it
back.

- `store::tests::a_file_with_no_format_field_is_read_as_format_one`
- `store::tests::a_file_from_a_newer_format_is_set_aside_rather_than_parsed`
- `store::tests::a_set_aside_file_keeps_every_byte_it_had`
- `store::tests::a_corrupt_precious_store_is_set_aside_before_the_default_replaces_it`
- `store::tests::a_corrupt_layout_is_not_copied` — the deliberate asymmetry,
  asserted so nobody "fixes" it later.
- `store::tests::a_file_set_aside_by_an_older_build_is_taken_back` — the
  downgrade and the return from it, end to end. Written after stage 4 made the
  return possible; it is the half that turns "lost forever" into "lost for the
  duration".

### 3. Durable writes

`sync_all` and the pid in the temp name, in the shared helper from stage 2 —
which is why it comes after rather than being eight edits.

- `store::tests::two_writers_do_not_share_a_temp_file`
- `store::tests::a_failed_rename_leaves_the_previous_file_intact`
- `store::tests::a_failed_write_removes_its_own_temp_file`

Power loss is not testable in `cargo test`. The tests above cover the
mechanism; the flush is a code review matter and should be called out as such
in the commit message rather than dressed up in a test that does not prove it.

### 4. Backups

`userdata::backup`, called from the two paths in stage 2 and from nowhere else.

- `backup::tests::only_three_backups_are_kept_per_stem`
- `backup::tests::the_oldest_is_the_one_deleted`
- `backup::tests::an_ordinary_save_takes_no_backup` — the whole point, and the
  regression somebody will introduce.
- `backup::tests::a_backup_names_the_format_it_came_from`
- `backup::tests::labels_share_one_budget_per_file`
- `backup::tests::the_newest_backup_under_a_label_is_the_one_found` — what
  `store::restored` reads, and the reason this stage swallowed the set-aside
  path rather than sitting beside it.

### Still open

Two items from **Install and uninstall** above have not been done, and neither
is a data-loss path:

- the uninstaller's confirm page still says only "Delete the application data",
  without naming the directory or saying that projects are untouched;
- an uninstall with that box ticked still leaves the GitHub token in the Windows
  credential store, because NSIS has no clean way to reach it and the honest
  version is a `--uninstall-credentials` argument on the binary.

## Other platforms

Nothing above is Windows-only by design, and two pieces are Windows-only by
accident and should not be made worse.

`app_config_dir()` answers `~/Library/Application Support/<identifier>` on
macOS and `~/.config/<identifier>` on Linux, so the store layer, the format
field, the set-aside path, the backups and adoption all work unchanged — they
are `PathBuf` and `serde` and nothing else.

The two that are genuinely platform-shaped: `installer-hooks.nsh` is NSIS and
has no counterpart elsewhere, and the single-instance mutex is
`tauri-plugin-single-instance`'s problem rather than ours on every platform.
Neither is made harder by anything here. `sync_all` is `std` and does the right
thing on all three.
