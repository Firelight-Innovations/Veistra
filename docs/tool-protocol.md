# The Veistra tool protocol — v1

The wire contract between the orchestrator and a tool. This is the reference
implementations are written against; if code and this document disagree, one of
them is a bug.

It is both halves. The exact bytes and the exact field names, and — beside each
rule whose shape is not obvious from the rule itself — why it is that way and
what was rejected instead. Section 6 says which of this you may build a tool
against today, which of it may still move, and what happens to your tool if it
does.

A tool is a **Rust core** plus a **React frontend**. Under the tool's own Tauri
app those two halves talk over Tauri IPC. Under the orchestrator they don't talk
to each other at all — the frontend talks to the shell, and the shell talks to
the core. Two transports, one logical call:

```
              ┌─────────────── orchestrator (shell) ────────────────┐
  iframe      │                                                     │   child process
 ┌────────┐   │  ┌─────────┐                      ┌──────────────┐  │   ┌──────────┐
 │ tool   │◄──┼─►│ window  │◄────── broker ──────►│ stdin/stdout │◄─┼──►│ tool     │
 │ ui     │   │  │ message │   (transport B)      │  (transport A)│  │   │ core     │
 └────────┘   │  └─────────┘                      └──────────────┘  │   └──────────┘
              └─────────────────────────────────────────────────────┘
```

Both transports carry the same `method` string and the same `params`. The broker
is a relay, not a translator.

---

## 1. `veistra-tool.toml`

Lives at the root of a tool's checkout. `veistra.toml` (the stack manifest) says
*which* tools exist and at what version; `veistra-tool.toml` says *how to run* the
one it sits next to.

One file describes a **package**: an identity, at most one core process, and
zero or more **surfaces** — the things a person can put in a pane.

```toml
[tool]
id      = "echo"          # must equal the [[tool]] id in veistra.toml
version = "0.1.0"         # semver
name    = "Echo"          # optional; falls back to id
description = "Says it back."     # optional

[frontend]                # optional; omit for a package with no UI
dist    = "ui/dist"       # built bundle, relative to the checkout root
dev-url = "http://localhost:5174"   # optional; the package's own Vite server

[[surface]]               # optional, repeatable. See "Surfaces" below.
id          = "specs"     # addressed by the shell as `echo.specs`
name        = "Spec Editor"       # optional; falls back to the surface id
description = "Write and edit specs."   # optional
path        = "specs/"    # optional; where in the bundle, default its root
present     = "pane"      # optional; "pane" or "cover", default "pane"

[core]                    # optional; omit for a frontend-only package
bin  = "target/debug/veistra-echo-tool"   # relative to the checkout root
args = ["--veistra-rpc"]                  # optional, default ["--veistra-rpc"]

[permissions]             # optional; reserved, ignored by the broker today
```

Rules:

- Every path is **relative to the checkout root** (the directory holding
  `veistra-tool.toml`). Rejected: absolute paths, any `..` component, and
  anything resolving to the checkout root itself — a `dist` of `""` would
  otherwise serve the tool's whole checkout, `.git` included.
  *Known gap:* a symlink inside the checkout still escapes it, because paths
  are not canonicalized at parse time. The asset server canonicalizes before it
  serves anything (`tool_frontend::safe_join`), so the gap is in what a manifest
  is allowed to *say* rather than in what a request can reach.
- `id` matches `^[a-z][a-z0-9-]*$`, and so does every `surface.id`. Rejecting
  anything else keeps ids safe to use as URL authorities and directory names.
- `version` parses as semver.
- Unknown keys are an **error**, not a warning. A typo'd key that is silently
  ignored is a bug that only shows up at runtime.
- On Windows, `bin` may omit `.exe`; a resolver tries `bin` then `bin.exe`.
- `dev-url` is only consulted by a development build of the orchestrator.

### Surfaces

A surface is addressed as **`<package id>.<surface id>`** — `echo.specs` — and
that string goes wherever an app id goes: the switcher, the Apps menu, the saved
layout. The separator is a character neither id can contain, which is what stops
a plugin surface colliding with a first-party app.

- **A manifest with a `[frontend]` and no `[[surface]]` gets one synthesised**,
  with the id `main` and the bundle root as its path. Every manifest written
  before surfaces existed keeps working unchanged, which is what makes this an
  additive change under §6's versioning rule.
- **`dist` and `dev-url` are per package; `path` is per surface.** A `dev-url` on
  each surface would mean a dev server per surface — four of them for a package
  with four views. One server with several HTML entry points is what the
  orchestrator's own `vite.config.ts` does for Home, Files, Viewer and Tutorials,
  so a plugin repo is laid out the way the shell already is.
- **`present = "cover"`** takes the surface out of both menus. It stays mountable
  and stays reachable when another frame calls `veistra/open` for it — the
  behaviour Home and Tutorials have inside the orchestrator.
- **A package with no `[[surface]]` and no `[frontend]` has no UI at all**, and
  that is a supported shape rather than a broken one: a package that exists only
  to run a core. It contributes nothing to the Apps menu, which is the point —
  there is no row offering to add a backend.
- A `[[surface]]` without a `[frontend]` is an **error**: it names a document in
  a bundle the package never declared.
- Two surfaces sharing an id is an **error**. They would be two menu rows
  addressing one thing, with whichever the lookup found first silently winning.

## 2. Transport A — shell ↔ tool core (standard streams)

The orchestrator runs the core as a child process and speaks **JSON-RPC 2.0 over
newline-delimited JSON** on its standard streams.

- One JSON object per line, UTF-8, terminated by `\n`. No `Content-Length`
  framing. (Raw newlines can't appear inside a JSON string unescaped, so a line
  is always a whole message.)
- **stdout carries protocol traffic and nothing else.** A stray `println!` in a
  tool corrupts the stream. Logging goes to **stderr**, which the orchestrator
  captures and tags with the tool id.
- A whole message is written under one lock, so a tool may send notifications
  from any thread — a file watcher, a build reporter — without interleaving
  bytes into another message. That only holds for writes made through
  `veistra-rpc`; raw writes to stdout are still the tool's own problem.
- The child exits when its stdin closes. That is what makes orphan processes
  impossible: kill the orchestrator, every pipe closes, every tool exits.

### Messages

Request (host → tool, or tool → host):

```json
{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi"}}
```

Success response:

```json
{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}
```

Error response:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no such method: frobnicate"}}
```

Notification — no `id`, no response expected. This is how a tool pushes an event
without being asked:

```json
{"jsonrpc":"2.0","method":"file/changed","params":{"path":"a.txt"}}
```

`id` is a positive integer allocated by whichever side sends the request. A
response **must** echo the request's `id`. Ids from the two directions are
independent; they never collide because a response is always matched against the
pending table of the side that sent the request.

### Reserved methods

Every tool core must implement these. The `veistra/` prefix is reserved; tools
must not define their own methods under it.

> The methods a *first-party app* answers are not part of this protocol and are
> not listed here — this document is the transport. The Files app's surface,
> which is the one an agent is most likely to drive, is
> [`docs/files-app-methods.md`](files-app-methods.md).

| Method | Params | Result |
|---|---|---|
| `veistra/hello` | `{"protocol":1,"session":Session}` | `{"id":string,"version":string,"protocol":1}` |
| `veistra/shutdown` | none | `null` |

`veistra/hello` is the first message on the pipe, always sent by the host. The host
rejects the tool if `protocol != 1` or if `id` disagrees with `veistra-tool.toml`.

`veistra/shutdown` asks for a clean exit: reply, then exit. The host waits two
seconds after the reply and then kills the process.

### Error codes

Standard JSON-RPC, plus a Veistra range:

| Code | Meaning |
|---|---|
| `-32700` | Parse error — the line was not valid JSON |
| `-32600` | Invalid request — valid JSON, wrong shape |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error inside the handler |
| `-32000` | Tool process exited or crashed (generated by the host) |
| `-32001` | Request timed out (generated by the host) |
| `-32002` | Handshake failed (generated by the host) |

## 3. Transport B — tool frontend ↔ shell (window messages)

The frontend runs in an iframe on a different origin from the shell, so the two
talk with `postMessage`. Every message carries `veistra: 1` as a version marker and
a cheap way to ignore traffic from anything else sharing the window.

Frontend → shell:

```jsonc
{"veistra":1,"kind":"hello"}
{"veistra":1,"kind":"request","id":1,"method":"echo","params":{"text":"hi"}}
```

Shell → frontend:

```jsonc
{"veistra":1,"kind":"ready","toolId":"echo","protocol":1,"session":{...}}
{"veistra":1,"kind":"response","id":1,"result":{"text":"hi"}}
{"veistra":1,"kind":"response","id":1,"error":{"code":-32601,"message":"..."}}
{"veistra":1,"kind":"event","event":"file/changed","payload":{"path":"a.txt"}}
{"veistra":1,"kind":"command","command":"file/save"}
```

### The handshake is client-initiated, and that is load-bearing

The iframe sends `hello`; the shell answers `ready`. Not the other way around.

If the shell announced first, it would be racing the iframe's script load and
message listener registration — and a window message that arrives before a
listener exists is simply gone, with no replay. That is the same class of bug the
splash window already hit with Tauri events (see `src-tauri/src/boot.rs`). Having
the side that *knows* it is ready speak first removes the race instead of
papering over it with a poll.

The bridge queues any `invoke` made before `ready` arrives and flushes the queue
on handshake, so tool code never has to think about this.

### Reserved methods

The `veistra/` prefix is reserved on this transport too, and for the same reason:
the shell answers these itself and never forwards them to a core.

| Method | Params | Result | Meaning |
|---|---|---|---|
| `veistra/painted` | none | `null` | This frontend has drawn its first meaningful content. |
| `veistra/commands` | `{"commands":string[]}` | `null` | These are the menu commands this frontend can carry out **right now**. |
| `veistra/title` | `{"title":string}` | `null` | Call this surface's tab something other than its app's name. |
| `veistra/open` | `{"appId":string,"payload"?:any}` | `{"instanceId":string}` | Put something on screen in another app, in my cluster. |
| `veistra/publish` | `{"topic":string,"value":any}` | `null` | State a fact about myself for my cluster-mates to read. |
| `veistra/drag` | `{"phase":"begin"\|"end","paths"?:string[],"items"?:string[]}` | `null` | I have picked up these file paths and context items (ids from `context/put`), or put them down. |
| `veistra/escape` | none | `null` | I saw a bare Escape that nothing in me handled. |
| `veistra/search-claim` | `{"placeholder":string,"value":string}` | `null` | Show my filter in the title bar's search field while I am the active surface. Sending it again updates the claim. |
| `veistra/search-release` | none | `null` | I no longer have a filter to show. |
| `veistra/track` | `{"event":string,"props"?:object}` | `null` | Report a usage event for the feature that lists my app. First-party apps only; see below. |
| `veistra/feedback` | none | `null` | Open the shell's feedback dialog, about my feature. First-party apps only. |

`veistra/painted` is a report, not a request. The orchestrator holds its splash
window up until every first-party app has sent one, so that the window it hands
off to is finished rather than still filling in — see `src-tauri/src/boot.rs`.
A host with nothing waiting on it acknowledges and does nothing, which is what
a tool's own standalone Tauri app does.

Two rules make it worth trusting. It is sent *after* the content is committed
to the DOM, not when the call that fetched it resolved — a frontend that
reported on the promise would be claiming a screen that does not exist yet. And
it identifies the frontend the same way every other message here does: the shell
resolves the id from `event.source`, so a frame can only ever report about
itself.

The host may stop waiting. It does not wait forever, and a report that arrives
after it gave up is discarded rather than being an error.

`veistra/track` names an event and nothing else. Which feature it belongs to is
resolved from `event.source` against the shell's feature registry, never from
the message, and an event that feature does not declare is refused with
`InvalidParams` and a list of the ones it does. Whether anything is *sent* is the
person's choice and is not reported back: an accepted event may be dropped
because usage data is off, and the frame cannot tell. A tool is refused both
methods, with `InvalidParams`, so it does not wait out the timeout — consent to
usage data covers the shell and its own apps, not somebody else's code.
`docs/telemetry.md` §5 is the rest.

### Menu commands

The orchestrator's title bar has a menu bar, and its File, Edit and View menus
have to operate whatever is showing. The shell cannot reach into a frame to do
that — a frame is a separate document, and for a tool a separate origin — so a
menu item becomes a `command` message aimed at the **active** frame.

```jsonc
{"veistra":1,"kind":"command","command":"file/save"}
```

It is fire-and-forget. There is no `id` and no reply, because the only thing the
menu needed to know was answered before the item was ever clickable, and the
menu has closed by the time anything could come back.

A `command` is deliberately **not** an `event`. The two make opposite claims: an
event is news the frame may ignore, a command is an instruction the user just
gave. A frontend registers for one without having to filter out the other.

#### The frontend declares; the shell never assumes

`veistra/commands` is the other half, and it is the half that makes this design
work. A menu offering Save when nothing is dirty is a menu that lies — and the
shell cannot know when that is, because whether there is anything to save is a
fact about the frontend's own state.

So the direction is reversed. The frontend sends `veistra/commands` with the set
it can carry out at this moment, and the shell **disables every item not in that
set**. The last declaration replaces the previous one; it does not add to it.
A frame that has never declared anything can do nothing, which is the honest
starting point rather than an awkward default.

The consequence worth naming: **the shell holds no list of any app's
capabilities.** It knows a set of command id strings and nothing about what they
mean. That is what keeps the next surface to arrive from breaking the menu — it
declares nothing, so its menu is honestly inert, and no code in the title bar
had to be told it exists.

The shell drops a command the target has not declared, rather than sending it
anyway. Reaching that point means the two disagreed, and a frame acting on
something it said it could not do is the worse outcome.

Command ids are the host's vocabulary, not the protocol's — this document does
not enumerate them, the same way it does not enumerate an app's methods. The
orchestrator's are in `src/shell/titlebar/TitleBar.tsx` (`APP_COMMAND`).

`@veistra/bridge` exposes both halves as `onCommand` and `declareCommands`. The
declaration is de-duplicated against the last one actually sent, because the
natural place to call it is an effect that runs on every render.

### Frames talking to each other

`veistra/open` and `veistra/publish` are how one frontend reaches **another
frontend** — sideways, through the shell, without either of them learning the
other exists. Everything else on this transport goes down to a host and back.

Neither travels through a tool core or through Rust. Both frames are already in
the same browser, and the layout that decides *which* frame is a fact only the
shell holds.

#### `veistra/open` — put this on screen somewhere else

```jsonc
{"veistra":1,"kind":"request","id":7,"method":"veistra/open",
 "params":{"appId":"viewer","payload":{"path":"a.txt","preview":true}}}
```

The shell finds a surface of that app kind **in the calling frame's own
cluster**, brings it forward if it is already there, opens one if it is not,
and delivers the payload to it as an event:

```jsonc
{"veistra":1,"kind":"event","event":"veistra:opened","payload":{"path":"a.txt","preview":true}}
```

The result names the surface that was chosen — `{"instanceId":"viewer-2"}` —
for a caller that wants to know whether it opened something new. Most ignore it.

Three properties are load-bearing:

- **A kind, never an instance.** A frame cannot address a particular surface,
  because which surface should answer is a fact about the layout that only the
  shell can see, and a frame that could name one could name one in a cluster it
  is not in.
- **Its own cluster only.** The calling frame is resolved from `event.source`
  against the shell's map of mounted iframes, exactly as every other message
  here is, and the search for a target never leaves the cluster that frame is
  placed in.
- **One event name for every intent.** What is being asked for lives in the
  payload and is read by the app that receives it — File Explorer sends a path
  and a peek flag, the source control view will send something else to the same
  app. A shell that routed on intent would need a table of every app's verbs,
  which is the thing this transport is shaped to avoid.

The payload is **not validated by the shell**, and that is deliberate: it is the
app's vocabulary, not the protocol's. The receiving app is the first and only
place its shape is checked.

#### `veistra/publish` — state a fact for your cluster-mates

```jsonc
{"veistra":1,"kind":"request","id":8,"method":"veistra/publish",
 "params":{"topic":"files/active-path","value":{"path":"a.txt"}}}
```

Delivered to every **other** app frame in the cluster under the topic's name,
prefixed:

```jsonc
{"veistra":1,"kind":"event","event":"veistra:topic/files/active-path",
 "payload":{"value":{"path":"a.txt"},"from":"viewer-1"}}
```

The publisher is excluded from its own broadcast. A subscriber that republished
anything derived from what it heard would otherwise ping-pong with itself, and
no amount of care in one app prevents that from the other end.

**Topics are retained.** The last value published under a topic is replayed to
any frame that completes its handshake later, so a surface opened a minute after
the fact is not left blind until the next change. A publisher's topics are
dropped when its frame goes — a retained value from a surface that has closed
would be replayed to the next one as though it were current.

The `veistra:topic/` prefix is what keeps an app's topics from colliding with the
shell's own push events (`project:changed`). A frame cannot publish under a name
that would arrive looking like news the shell authored.

`value` is unvalidated, `undefined` included — publishing "there is nothing" is
a real thing to say, and narrowing it to a refusal would leave the last real
value retained and make an empty editor indistinguishable from one nobody had
heard from.

#### `veistra/drag` — I have picked up some paths

```jsonc
{"veistra":1,"kind":"request","id":9,"method":"veistra/drag",
 "params":{"phase":"begin","paths":["C:\repo\src\main.rs"]}}
```

A frame cannot see a drag leave it. An iframe's pointer events stop at its own
edge, so a gesture that starts in a file tree and ends on a terminal in the
shell's chrome is two halves that never meet — the frame never hears the
release, and the shell never heard the press.

This is the frame's half, and it is the whole of it. `begin` says a press has
travelled far enough to be a drag and hands over what it is carrying; `end` says
that press was released **inside the frame**, which is the one release the shell
cannot observe and therefore the only one worth reporting. A release anywhere
else is the shell's own `pointerup`, and it commits before an `end` could
arrive.

Nothing comes back but the acknowledgement, and that is the design rather than
an omission. The frame is not told where the cursor went, what it passed over,
whether anything received the paths, or that terminals exist at all — a frame
that could ask those questions could survey the window it is drawn in.

What the shell does with the paths is not the protocol's business. Today it
inserts them at the prompt of whichever terminal the release landed on, quoted
for that terminal's shell and followed by no newline; see
`docs/design-notes/drag-files-to-terminal.md`.

`paths` is validated, unlike `veistra/open`'s opaque `payload`. These strings end
up in a running program's input rather than in another app's hands, so "the
receiver knows what it means" does not apply: every entry that is not a string
is dropped, and quoting happens in Rust.

#### `veistra/escape` — Escape typed inside a frame

```jsonc
{"veistra":1,"kind":"request","id":10,"method":"veistra/escape"}
```

Keys typed in an iframe never reach the shell's `document`, so the shell's "Esc
leaves the expanded page" binding goes deaf as soon as the page has focus. The
bridge closes that gap: it listens for `keydown` on the frame's document and
sends `veistra/escape`, with no params, for each bare Escape that the app did not
claim. An Escape is forwarded only if the app left it un-`preventDefault`ed and
it was not typed into an `input`, a `textarea` or a contenteditable element,
since those want Escape for themselves (clearing, cancelling, closing a widget).
The bridge sends it fire-and-forget and ignores any failure.

The shell honours it only from the rail page's own frame. A request from a pane's
frame is acknowledged and otherwise ignored, because a pane's Escape belongs to
that pane. When honoured, the shell replays a synthetic `Escape` `keydown` on its
own document, so the same binding handles it as if the key had been typed
outside the frame. Nothing comes back but the acknowledgement.

```jsonc
{"veistra":1,"kind":"request","id":11,"method":"veistra/key","params":{"key":"P","code":"KeyP","ctrlKey":true,"shiftKey":true,"altKey":false,"metaKey":false}}
```

The same gap exists for the shell's chords. The bridge forwards `Ctrl/Meta` with
`Shift` or `Alt`, `Ctrl+,` (Settings), and `Alt+1` to `Alt+9`, that the app did
not `preventDefault`. Ordinary editing chords (Ctrl+C, Ctrl+Z, Ctrl+B) are never
forwarded. The shell replays the chord as a `keydown` on its own document, from
any frame, and refuses a payload with no Ctrl, Meta or Alt so a frame cannot type
into the shell.

#### `veistra/search-claim` — the title bar's search field

The shell has one search field, in the title bar. A frame with a filter of its own claims it
rather than drawing a second bar. The shell records the claim and shows it only while the frame
is an active surface (the focused pane's visible tab, a takeover, or the rail page). What the
user does in the field comes back as an event:

```jsonc
{"veistra":1,"kind":"event","event":"veistra:search","payload":{"kind":"query","value":"src"}}
```

`kind` is `query` (the text changed), `submit` (Enter) or `escape`. The bridge's `claimSearch`
wraps all of it. Under the Tauri host both methods are refused, and the frame draws its own
input. See `docs/design-notes/titlebar-search.md`.

#### Under the Tauri host

The sideways channel, the drag and the search claim are **refused** with `-32601`, not accepted and dropped the way
`veistra/commands` is. A tool's own standalone app is one window with one frontend
in it: there is no cluster, no second app, no shell chrome to drag into, and
nobody to deliver to. Answering "done" to an open while nothing happened would
leave a frontend believing it had put a file on screen that nothing anywhere is
showing, and answering it to a drag would say the same about paths in flight.

`publish` and `drag` are both fire-and-forget in the bridge, so those rejections
are swallowed at the call site rather than surfacing as unhandled promises.

### Origins

- The bridge posts `hello` with `targetOrigin: "*"` — it doesn't know the shell's
  origin yet, and the message carries no data worth protecting. It then reads the
  shell's origin off the `ready` message's `event.origin` and uses **that exact
  origin** as `targetOrigin` for every subsequent post.
- The bridge drops any message whose `event.source !== window.parent`.
- The shell drops any message whose `event.source` is not a mounted tool iframe's
  `contentWindow`, and resolves the tool id from that source rather than from
  anything in the message body. A tool cannot claim to be a different tool.

### Session

Handed to the frontend on `ready`, and to the core in `veistra/hello`. Same shape
both places:

```ts
interface Session {
  /** Root of the open project. Null until projects exist. */
  projectPath: string | null;
}
```

This is what the host tells a tool about the world it opened into. The single
field is null today, and stays null until projects reach tools.

## 4. The bridge package

`@veistra/bridge` is what a tool's `ui/` imports instead of `@tauri-apps/api`. Same
tool code, either host.

```ts
import {
  invoke, on, onCommand, declareCommands, session, host, reportPainted,
  openIn, publish, subscribe, OPENED_EVENT,
} from "@veistra/bridge";

const reply = await invoke<{ text: string }>("echo", { text: "hi" });
const off   = on("file/changed", (p) => console.log(p));
const s     = await session();   // resolves after handshake
host();                          // "veistra" | "tauri"
reportPainted();                 // "there is something on screen now"

// The menu bar. `declareCommands` is what makes the items clickable; call it
// again whenever the answer changes, and pass the whole set each time.
declareCommands(dirty ? ["file/save", "edit/undo"] : ["edit/undo"]);
const stop = onCommand((command) => run(command));

// Reaching another app in this cluster. `openIn` names a kind, never a surface.
await openIn("viewer", { path: "a.txt", preview: true });
on(OPENED_EVENT, (payload) => show(payload));   // the receiving end

// Facts your cluster-mates may care about. Retained, so a frame that mounts
// later is told the current value rather than waiting for the next change.
publish("files/active-path", { path: "a.txt" });
const off = subscribe("files/active-path", (value, from) => highlight(value, from));
```

`publish` de-duplicates against the last value sent for the same topic, because
the natural place to call it is an effect that runs on every render — the same
reasoning `declareCommands` is built on.

`reportPainted` sends `veistra/painted` once, from a `requestAnimationFrame` so
the browser has laid the content out first — with a short timer racing it,
because a webview in a window that is still hidden stops firing animation
frames entirely, and that is exactly the case this signal exists for. Every
call after the first is a no-op, so it is safe from an effect that runs twice.

### Host detection

```
window.parent !== window   →  "veistra"
otherwise                  →  "tauri"
```

A tool's standalone Tauri app is a top level window; inside the orchestrator the
tool is always framed. This is a structural fact checked once at load, not a
timing guess — there is no probe, no timeout, and no ambiguous middle state.

### Under the Tauri host

- `invoke(method, params)` forwards to `@tauri-apps/api/core`'s `invoke`, with
  the method name passed through unchanged.
- `veistra/*` methods are handled **inside the bridge** and never reach Tauri —
  they aren't valid Tauri command names anyway (`/` is not allowed). `veistra/hello`
  resolves locally; `veistra/shutdown`, `veistra/painted` and `veistra/commands` all
  resolve to null. A tool's own app draws its own chrome, so there is no menu bar
  for a declaration to grey out — it is accepted and dropped rather than refused,
  so a frontend that supports menu commands does not log an error on a host where
  the feature does not apply. `onCommand` registers a handler nothing will ever
  call there, and its unsubscribe is real either way.
- `session()` resolves immediately to `{projectPath: null}`.
- `@tauri-apps/api` is imported dynamically, so a tool built for the orchestrator
  alone doesn't have to ship it.

### Timeouts

Every `invoke` rejects after 30 seconds by default. A pending request whose tool
process dies rejects with `-32000`. Both surface as a `VeistraRpcError` carrying
`code`, `message`, and optional `data`.

## 5. What a tool repository ships

1. `veistra-tool.toml` at the checkout root.
2. A headless binary that speaks transport A when passed `--veistra-rpc` — unless
   the package declares no `[core]`, in which case it ships no binary at all.
3. A frontend bundle whose only host coupling is `@veistra/bridge`, holding one
   document per `[[surface]]` — unless the package declares no `[frontend]`.

`examples/echo-tool` in this repo is the reference implementation, and is what
the protocol's tests run against.

### Installing one

The orchestrator installs a package from a **folder on this machine**: Home's
*Install App*, which takes the directory holding `veistra-tool.toml`. The record
is kept in `plugins.json` beside the other per-user state; the directory is
never copied and never deleted, because it is a working tree the person already
had.

Nothing is required to be *built* at install time. An unbuilt checkout is the
normal state while writing one, and each half reports its own absence when it
matters — a surface says the frontend has not been built, a call says the core
has not.

**Rebuild and it reloads.** A folder install is watched: when `veistra-tool.toml`
or the built `core.bin` stops changing, the core is stopped and every window
re-reads the manifest, so a new `[[surface]]` appears without a restart. A
surface pointed at `dev-url` needs nothing at all — its own dev server's hot
reload runs inside the real shell.

## 6. Stability

The protocol is at v1 and most of what is above is running code. **The broker is
built**, so the one path this whole document exists to describe — a tool's
frontend asking a question its own core answers — now runs end to end:
`src-tauri/src/plugins/broker.rs` spawns a package's core on the first call from
any of its surfaces, completes `veistra/hello`, and relays every non-`veistra/*`
method to it. This section is still the map, because not all of it is settled:
what to build against, what is still moving, and what happens to your tool when
it moves.

### What is settled

Implemented, covered by tests, and not changing shape under v1.

- **`veistra-tool.toml` (§1)** — every key, the path rules, and unknown keys being
  an error. `crates/veistra-tool-manifest` is the only parser there is;
  `examples/echo-tool/veistra-tool.toml` is the file its tests read.
- **Transport A (§2)** — the framing, the three message shapes, `veistra/shutdown`,
  and the error codes. `crates/veistra-rpc` is *both* halves of the pipe, which is
  what stops a host and a tool drifting apart, and
  `examples/echo-tool/tests/roundtrip.rs` drives a real child process through
  handshake, call, bad params, unknown method, notification, and death.
- **Transport B (§3)** — the `veistra: 1` envelope, the five message kinds, the
  client-initiated handshake, the five reserved `veistra/*` methods, and the
  origin rules. All of it runs on every launch: the orchestrator's own Home and
  Files are not special-cased anywhere, they are frames speaking this transport
  through this bridge.
- **`@veistra/bridge` (§4)** — the exported names, the thirty-second default
  timeout, `VeistraRpcError`'s `code`, `message` and `data`, and host detection.

Both caveats that used to sit here are closed, and it is worth saying which,
because a tool author reading an older copy of this file would plan around them.
Transport B is exercised by third-party frames now and not only by the shell's
own. And the host half of the `veistra/hello` check in §2 — reject the tool if
`protocol != 1` or if `id` disagrees with the manifest — is **enforced**;
`HANDSHAKE_FAILED` is raised by `plugins::broker::handshake`, which is the code
that used to be missing. A tool must answer `veistra/hello` correctly, and is now
refused if it does not.

### What may still move

- **The broker's edges.** The relay itself is settled, and no message shape above
  changed when it landed — specifying both transports around one `method` and one
  `params` is what bought that. Two things around it are not settled. A core's
  **notifications** are collected by `ToolProcess` and read by nobody, so a core
  pushing an event today is talking to a queue with no reader. And a frame
  reaches **only its own package's core**: the package id is taken from the
  frame's identity rather than from anything in the message, so a cross-plugin
  call is not merely unimplemented but unaddressable. Widening that is where
  `[permissions]` stops being reserved space.
- **`[permissions]`.** The table is accepted and its contents are never looked
  at: the manifest crate types it as an opaque `toml::Value` so that reserving
  the space costs nothing today. Anything written in it is a note to yourself.
  What it will actually mean is the second open question below.
- **`Session`.** Its one field is null in every build that exists. It carried a
  second, `engineEndpoint`, removed rather than carried forward: it named a
  component that is not part of this stack, it was null everywhere, and it had
  no specification past "a named pipe or socket path". Removing it while the
  protocol has no third-party implementors costs nothing — keeping it would have
  meant documenting a field nobody could fill.
- **Path safety.** §1 names the known gap: paths are not canonicalized, so a
  symlink inside a checkout still escapes it. Closing that can only make a
  manifest that parses today start failing, which is the direction a security
  fix is allowed to move in.
- **Command ids and app methods** are declared in §3 not to be part of this
  protocol, and that is the point rather than an omission. A host adds, renames
  and drops its own vocabulary without the protocol version moving.

### The versioning rule

Both transports carry an integer — `protocol` in `veistra/hello`, `veistra` on every
window message — and **that integer is the only breaking-change lever.** It goes
to 2 when something that already exists stops meaning what it meant: a field
removed, a type changed, a result reshaped, a handshake reversed.

Additive change leaves it at 1. A new reserved `veistra/*` method, a new optional
key in `veistra-tool.toml`, a new field on `Session`, a new code in the Veistra error
range. A tool written against v1 keeps working across every one of those, and
that is the entire promise the number is making.

One asymmetry inside that, because it will otherwise be found the hard way. A
new optional manifest key is additive for *tool authors* — every existing
`veistra-tool.toml` still parses — and is not additive for *hosts*, because
unknown keys are a hard error. A manifest using a key added in a later shell is
rejected by an earlier one, by name. That trade is deliberate and §1 already
argues it: a key silently ignored is the worse failure. The consequence is that
a tool adopting a new key has declared a minimum shell version, and should say
so somewhere its users will read.

`veistra/hello` is specified to **reject a mismatch rather than negotiate down.**
A shell and a tool from two majors half-working is a worse day than either of
them stopping at the handshake.

The crates and `@veistra/bridge` carry ordinary semver, independent of this
number. `@veistra/bridge` 0.2.0 still speaks protocol 1. A package version is not
a protocol version.

And the rule this file lives under: a change to §1 through §4 lands in the same
commit as the code that makes it true, and the commit message says the format
moved. The line at the top is not decoration — if the code and this document
disagree, one of them is a bug, and which one is a question with an answer.

### Two security questions this document does not answer

Both are open, both are Braden's, and both are written out here rather than
deferred because they are free to answer on paper now and expensive to retrofit
through a resolver later. A tool author's threat model depends on the answers.

#### Open: does the shell clone a repository, or fetch a signed artifact?

Nothing above says how a tool's checkout arrived on disk, and today nothing puts
one there — `checkout-root` in `veistra.toml` points at directories a person
cloned by hand. The question becomes real the moment the shell does the
fetching, which is the reason to answer it before it does.

Cloning a repository named by a URL in a TOML file and running its `core.bin` is
arbitrary code execution authorized by a line of configuration. It also needs
`git` on the user's machine, and a version pin that resolves to a tag is a
pointer somebody can move: the pin reads as reproducible and is not.

A signed release artifact with a checksum is a fixed set of bytes that can be
verified before anything executes, needs no `git`, and gives a pin that names
one build permanently. It costs a release pipeline in every tool repository.

**Recommendation: signed artifacts for anything the shell fetches itself, with
the hand-cloned local checkout kept as the development path.** Those two are
already separate in `veistra-tool.toml` — `dist` is a built bundle, `dev-url` is a
live server — so the cost lands on distribution rather than on a tool author's
inner loop, which is the half that has to stay fast.

**Decided, 2026-08-20, as recommended.** The shell will fetch a **release
artifact verified against a checksum**, never a clone; the local folder install
that exists today stays the development path and is the only path that exists so
far. The consequence for a tool author is a release pipeline in the tool's own
repository, and it is worth knowing before writing one. Nothing about the
fetching half is built yet.

#### Open: what is a mounted tool permitted to do?

The protocol bounds the frontend, and it is worth being exact about how far,
because it stops well short of where a reader will assume it reaches. A tool
frontend is an iframe on its own origin — `src-tauri/src/tool_frontend.rs` has
why that is `veistra-tool://` and not `file://`, and the answer is that `file://`
would put every tool on one opaque origin and dissolve the checks below. The
shell resolves who is speaking from `event.source` rather than from anything in
the message body, so a tool cannot claim to be another tool. `veistra/open`
reaches only app *kinds*, and only inside the calling frame's own cluster.

None of that touches the core. **A tool's core is a child process holding the
user's full privileges, and nothing in this protocol constrains it** — the
filesystem, the network, and everything else the user has. Tauri's capability
system governs a webview; a core is not one.

Prompting at install time is the obvious lever and a weak one alone. It is the
only moment a person has the context to answer, and a prompt nobody understands
is a prompt everybody accepts. `[permissions]` as it stands is a declaration by
the tool's own author, which makes it a statement of intent; it becomes a
constraint only where a host enforces it.

**Recommendation: give `[permissions]` a real schema before the broker ships
rather than after** — retrofitting it means breaking tools that already exist —
**deny by default on the tool window's Tauri capability set**, since a tool
frontend needs nothing from Tauri directly and talks to the shell for
everything, **and say plainly in this document that a core is unsandboxed under
v1** rather than letting the frontend's isolation imply a guarantee that does
not extend to it.

**Partly answered, and not in the order recommended.** The third part is done and
is the paragraph above: a core is unsandboxed under v1, and this document says
so rather than leaving the frontend's isolation to imply otherwise. The first
part is not — the broker shipped before `[permissions]` had a schema, which is
the ordering this section argued against. That was a deliberate trade rather
than an oversight, and the reason it is affordable is that the population of
tools written against v1 is currently one, in this repository: retrofitting a
schema breaks nobody today and will break somebody the moment that stops being
true. **It is the thing to do before a second person writes a plugin.**

Until then, the honest statement of the security model is one sentence:
**installing a plugin runs its code with your privileges, and nothing in the
shell limits what that code can do.** The frontend's origin isolation is real
and bounds only the frontend.
