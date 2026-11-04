# MCP server manager

Roadmap item #4. Veistra hosts MCP servers; it never consumes them.

The clients are harnesses the user brings themselves — Claude Code, Codex, or
whatever else — running in terminals **Veistra spawned**. That is the constraint
the whole design rests on, and it is worth saying plainly before anything else:
we own the environment the client starts in. Discovery, authentication and port
assignment are all solvable by writing an environment variable, where for a
general-purpose MCP server each of them would be a support problem.

Veistra is BYOH. We are not building a harness, so nothing here may assume one.

---

## 1. The rule about what gets a server

**If the harness can already do it, it does not get an MCP server.**

No file reading, no writing, no directory listing, no search, no git. Every
coding agent worth pointing at Veistra arrives with those built in, usually better
tuned than ours would be, and wrapping them would buy an agent a second worse way
to do something it can already do — while costing us a permission surface, a
maintenance burden, and a pile of tool descriptions competing for the model's
attention against its own.

What earns a server is the opposite: **something that exists only inside Veistra.**
Schematify's design graph is the first real case. An agent cannot read a
Schematify node by opening a file, because the interesting part is not the
file — it is the model, its boundaries, and the question "does this change
violate one?". That has no filesystem equivalent, so it is worth a tool.

Apply this rule before writing any server. It is the one that keeps this feature
from turning into a reimplementation of the harness.

## 2. What we are building, and what we are not

There is no MCP server manager library in Rust. There is one protocol SDK —
[`rmcp`](https://crates.io/crates/rmcp), the official one — and everything above
it is ours: the registry of who owns what, enable and disable, health, the
settings UI. `rmcp` gives us the wire format, the transports, and a derive that
turns an argument struct into a JSON Schema. It has no opinion about a host
running several servers on behalf of several apps, because that is an application
concern and not a protocol one.

So "manager" here means **registry**, not **supervisor** — a data structure, not
a distributed systems problem. That falls out of section 3.

Right now Veistra needs no MCP server at all. Nothing in the current build does
anything a harness cannot already do, so by section 1 nothing qualifies. This
milestone therefore ships **infrastructure plus one echo server**, whose entire
job is to prove a client can discover the endpoint, authenticate, list a tool and
call it. Schematify lands on top of it within days.

## 3. Every server lives in the orchestrator

This is the decision everything else follows from, and it is worth being exact
about, because the obvious reading of "each app can have an MCP server" is wrong.

An app's MCP server is not a process, and does not live in the app. It is a
module in `src-tauri/src/mcp/servers/`, registered here, hosted here.
Schematify's server will be orchestrator code that talks to Schematify — not
code inside a separate Schematify repository, because there is not one.

Two things follow, both of them good:

**The tool broker stops being a blocker.** A tool's Rust core is a child process
reached over transport A, and `apps/mod.rs` is explicit that the broker joining
that process to the shell is not built yet. Had Schematify been expected to
serve MCP from its own process, this feature would have been stuck behind
roadmap #10. Hosting it here means it is not.

**No app or tool ever depends on `rmcp`.** The dependency is in one crate, the
handshake is implemented once, and a server author writes a tool descriptor and a
function rather than a protocol implementation.

## 4. One listener, one endpoint per server

A single HTTP listener on loopback, routing by path: `/mcp/schematify`, `/mcp/echo`.
Each registered server is its own MCP endpoint and its own entry in `.mcp.json`.

Aggregating everything behind one endpoint was considered and rejected. It made
sense only under the assumption that each server was a separate process, where
fanning out cost real machinery; with every server in-process, a second endpoint
costs a route. What separate endpoints buy is worth more than that route:

- **Namespacing we do not have to invent.** The client derives tool names from
  the server name it connected to — `mcp__veistra-schematify__validate` — instead of us
  hand-prefixing every tool inside one flat namespace and hoping nobody collides.
- **A 1:1 map to the settings UI.** "Registered server" is exactly the row the
  user toggles, which is what the roadmap asked for.
- **Scoping.** An agent working in Schematify gets Schematify's tools. It has no reason
  to see another tool's, and every tool it can see but must not use is noise in
  its context.

Enable and disable stay on our side — Veistra decides which routes are mounted and
which entries are written — rather than living in the harness's own `/mcp` panel.

## 5. Registration

A registry in `src-tauri/src/mcp/`, seeded at boot, deliberately shaped like
`apps::REGISTRY`: an id, a display name, a description, and the handler that
answers a `tools/call`.

It is a `Vec` built at startup rather than a `const` slice, because a server can
be toggled off in settings and because a future registrant may not be known at
compile time. Nothing downstream may assume the set is fixed after boot — which
is also what makes the `list_changed` notification in section 7 honest rather
than decorative.

Server ids follow the same `^[a-z][a-z0-9-]*$` rule as app ids and tool ids, for
the same reason: an id ends up in a URL path and in a config key.

## 6. Transport and discovery

**Listener.** `rmcp`'s streamable-HTTP server transport, bound to `127.0.0.1` on
a preferred port with upward fallback. Loopback only, never `0.0.0.0`: this is a
local IPC channel that happens to speak HTTP, and binding it to a routable
interface would put every registered tool on the network.

**Discovery.** Veistra writes the project's `.mcp.json`, and because Veistra owns the
pty, both the port and the token can be environment variables:

```json
{
  "mcpServers": {
    "veistra-echo": {
      "type": "http",
      "url": "http://127.0.0.1:${VEISTRA_MCP_PORT}/mcp/echo",
      "headers": { "Authorization": "Bearer ${VEISTRA_MCP_TOKEN}" }
    }
  }
}
```

Three properties fall out of that, and all three are why it is written this way
rather than with the values inlined:

- **The file is safe to commit.** No secret, no machine-specific port — the same
  file for every developer on the project.
- **The token rotates per launch** without rewriting anything on disk.
- **A terminal Veistra did not spawn cannot connect.** It inherits neither
  variable, so the URL does not resolve and the bearer is empty. That is the
  correct failure rather than an inconvenience: these tools reach into the live
  application, and a shell opened outside it should not be able to.

Veistra merges rather than clobbers — a project may already have its own servers,
and only the `veistra-*` keys are ours to write or remove.

`veistra-*` names avoid Claude Code's reserved set (`workspace`,
`claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`).

**Verify before relying on it:** that `${VAR}` expansion applies to `url` and
`headers` on an `http` entry, not only to `command`/`args` on a stdio one. If it
does not, the fallback is `headersHelper` for the token and a rewritten `url` per
launch, which costs the committable-file property and nothing else.

## 7. Approval, and telling the user

A project-scoped `.mcp.json` is approved once, interactively, on first use. That
is a security feature and we should not try to defeat it silently.

What Veistra does instead:

- **Status bar indicator** with three states — connected, pending approval, off.
  Pending is the one that matters: it is a real state with a real fix, and a user
  who does not know the server is waiting on them will conclude it is broken.
- **An opt-in in settings** to write `enabledMcpjsonServers` into
  `.claude/settings.local.json`, pre-approving Veistra's servers for that project.
  Opt-in and per-project, phrased as trusting Veistra's own server rather than as
  turning off a prompt.

When the registered set changes while a client is connected, the server emits
MCP's `list_changed` notification; Claude Code honours it without a reconnect.

## 8. Dependency cost

New to the tree: `rmcp` (features `server`, `transport-streamable-http-server`,
`macros`, `schemars`), which brings an HTTP stack — `axum`/`tower`/`hyper` — and
an explicit `tokio`. Tauri already pulls tokio and hyper transitively, so the
marginal compile cost is the axum layer rather than a new async runtime.

Worth stating because it is the largest dependency addition this repo has made,
and it is load-bearing for exactly one feature.

There is deliberately **no new crate under `crates/`**. That directory holds the
protocol surface shared with tool repositories, and nothing outside the
orchestrator implements MCP. A crate for this would be a published contract with
no second party.

## 9. Order of work

1. `src-tauri/src/mcp/` — the registry, server descriptors, id validation.
   No I/O, no async, fully unit-testable.
2. The `rmcp` server: listener, loopback bind, token, path routing.
3. The echo server, as the thing that proves 1 and 2 end to end.
4. Env injection in `pty.rs`, and the `.mcp.json` merge on project open.
5. Status bar state and the settings surface.
6. Schematify's server, once Schematify's design graph exists.

## 10. Adding a server

Sections 1–9 are the design. This one is the recipe, and it is meant to be
followable without reading them.

**Before anything else, apply the rule in section 1**, which is restated at the
bottom of this section because it is the step people skip.

### 1. Create `src-tauri/src/mcp/servers/<id>.rs`

The id matches `^[a-z][a-z0-9-]*$`, the same rule app ids and tool ids are held
to, because it becomes the URL path `/mcp/<id>` and the `.mcp.json` key
`veistra-<id>`. `every_registered_server_id_is_url_safe` in `servers/mod.rs` holds
the shipped set to it, so a bad id fails `cargo test` rather than appearing as a
route nobody can reach. (`registry.rs` has a same-named check over its own test
doubles; that one proves the rule, not the set.)

Open the module with a doc comment saying what question this server answers that
a harness could not answer for itself. That is the same question section 1 asks,
and writing the answer down is what stops it being re-litigated later.

### 2. Declare the tools and the server

Follow `src-tauri/src/mcp/servers/echo.rs` exactly; read it before writing, and
mirror its structure rather than inventing a variation. What that file has, in
order:

- `static TOOLS: &[McpTool]`, one entry per tool. `name`, `description`, and
  `schema`.
- `schema` is a **`fn() -> Value`**, not a pre-built `Value` and not a JSON
  string. A `static` cannot hold a built `Value`, and a `&'static str` of JSON
  would move a malformed schema from a compile error to a runtime one nobody
  would see until a client asked for `tools/list`. Each returns a JSON Schema
  object with `"additionalProperties": false`.
- `pub static SERVER: McpServer`, naming `id`, `name`, `description`, `tools:
  TOOLS`, `call`, and `dev_only` (section 11 — `false` unless you have read it
  and decided otherwise).
- `fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer,
  RpcError>`, matching on the tool name. `Registry::call` checks the name against
  `TOOLS` before dispatching, so the final arm is a genuine impossibility rather
  than a second copy of that error message — say so in a comment, as `echo.rs`
  does, rather than leaving it looking like real error handling.
- A tool answering with facts returns `Ok(json!({ ... }).into())`; the `From<Value>`
  impl is what keeps `ToolAnswer` free for the ordinary case. Only a tool that
  produces a **picture** names the other variant, `ToolAnswer::Image`, and
  `servers/ui.rs`'s `screenshot` is the one that does.

Two things `echo.rs` demonstrates that are easy to skip. Refuse a missing or
mistyped parameter with `INVALID_PARAMS` and a sentence naming what was wanted,
not a category. And write descriptions for the **model**, not for a developer: a
tool with a vague description gets called speculatively, and the description is
the only thing standing between a diagnostic tool and an agent using it during
real work.

### 3. Register it

Two lines in `src-tauri/src/mcp/servers/mod.rs`:

```rust
pub mod <id>;

pub fn seed(registry: &Registry) {
    registry.register(&echo::SERVER);
    registry.register(&<id>::SERVER);   // this one
}
```

Registering an id twice replaces rather than duplicates, so `seed` is safe to
call again. `mcp::seed` in the parent module calls this and then hydrates from
`mcp.json`, so a switch somebody moved comes back where they left it.

### 4. Nothing else

That is the end of the list, and each of these is a place you might reasonably
expect an edit and will not find one:

- **No route to add.** The listener mounts every registered server at
  `/mcp/<id>` (section 4).
- **No `.mcp.json` edit.** That file is generated from the registry, and only the
  `veistra-*` keys are ours to write or remove (section 6). It is gated on the
  `mcp.writeProjectConfig` setting.
- **No frontend change.** The settings screen lists whatever the registry hands
  it, including servers that are switched off — and *excluding* developer-only
  ones, which Rust filters out before the panel ever sees them.
- **No persistence to write.** Whichever way the switch is left is written to
  `mcp.json` beside `settings.json`, sparsely: only a server whose switch is away
  from the state it ships in appears in the file.
- **No `crates/` work, and no `rmcp` in your file.** The protocol is implemented
  once, a layer down (section 3).

Tests go in the server's own module, beside `echo.rs`'s: what the tools are
called, what each one refuses, and what a valid call returns.

### The rule, restated

From `src-tauri/src/mcp/servers/mod.rs`, and it decides whether steps 1–4 should
happen at all:

> **If the harness can already do it, it does not get a server.** No file
> reading, writing or listing, no search, no git. Every agent worth pointing at
> Veistra arrives with those, and a second worse copy costs a permission surface
> and a pile of tool descriptions competing for the model's attention against its
> own.
>
> What earns a server is something that exists only inside Veistra and has no
> filesystem equivalent — Schematify's design graph is the first real case,
> because an agent cannot read a node's *boundaries* by opening a file.

## 11. Developer-only servers

`echo`, `debug`, `ui` and `agent` are all `dev_only`. `design` is the only server
an ordinary build serves.

`dev_only: true` on an `McpServer` makes it **absent** until `developer.mode` is
switched on in settings. Not greyed out, not marked unavailable: no row in the
panel, no key in `.mcp.json`, nothing from `tools/list`, and a `tools/call` that
answers "no MCP server with id `<id>`" — the same thing a client is told about a
server this build was never compiled with.

**What the two input servers can do.** `ui` and `agent` both host `screenshot`,
`snapshot`, `click`, `type_text`, `fill_field`, `context`, `press_key`, `drag`,
`scroll` and `eval`. `click`, `press_key`, `drag` and `scroll` take `modifiers`
(`ctrl`, `shift`, `alt`, `meta`), which are pressed as real keys around the action;
`press_key` accepts a single character as well as the named keys, so
`{"key":"a","modifiers":["ctrl"]}` is Ctrl+A; `drag` goes from `{x,y}` or a ref to
another, in `steps` moves; `scroll` turns the wheel with `deltaX`/`deltaY`. All of it
is real input through WebView2, and none of it exists in a build without developer
mode, because the servers that carry it are `dev_only`.

One predicate on `Entry` in `registry.rs` decides all four, so a fifth surface
cannot be added and quietly forget one of them.

**What earns the flag.** Every server before `ui` was a *read*, and that was
deliberate: the endpoint is reachable by anything on the machine that holds the
token, so a leaked token should cost knowledge of a window layout and not control
of it. A server that can click cannot make that promise. `dev_only` is what keeps
it from being on the list at all for somebody who is not working on Veistra.

**Writing is not on its own what earns it.** `design` writes — a reply, a
question or a resolution on a comment thread — and ships ungated, because what a
leaked token buys there is a line of text on somebody's own screen that they can
read and undo, not their mouse. It is also the one server whose whole purpose is
to serve an ordinary user's agent in an ordinary release build, so a gate would
have taken it away from the only people it is for. `docs/design-notes/
design-comments.md` has the argument in full; the point for this section is that
the question to ask is *what the writes can reach*, not whether there are any.

Three things follow, and they matter more than the flag itself:

- **Revealing is not enabling.** `Registry::register` starts a `dev_only` server
  off. Turning developer mode on shows a switch; somebody still has to throw it.
- **Developer mode is read at the point of use**, never cached in the registry.
  Switching it off takes the server away from an already-connected client on its
  next request, with no restart and no window in which the two disagree.
- **It ships in release.** A `cfg` would put the server out of reach of exactly
  the build somebody needs to diagnose, and would trade a gate the tests can hold
  to account for one they cannot.

## 12. The settings section is the only custom panel in the product

Every other section of the settings screen is generated from its schema: a
`Group` of `Setting` descriptors, drawn by four generic controls, with no
per-section frontend code. `docs/settings.md` describes that, and it is the
property the whole design exists to protect.

MCP is the exception. The section is drawn with a **custom panel** above its
settings — the server list, one row per registered server, each with its own
toggle.

The reason is that the servers are not settings. They are a list the registry
owns, built at boot and allowed to change while a client is connected (section
5), and the number of rows is not a fact any schema knows. Representing them as
settings would mean inventing a control — a list-of-toggles-with-labels — that
exists to describe one thing, that no other section could use, and that would put
the registry's contents into the schema where they do not belong. A `Group` whose
rows appeared and disappeared at runtime would also break the one promise the
schema makes: that what a build declares is what the screen draws.

So the escape hatch is used once, knowingly. A second section reaching for it is
a signal that something is being modelled wrong — either it is really a list, and
belongs somewhere other than a settings screen, or it is really settings, and
should be written as some.

## 13. The servers every build ships: `canvas`, `workspace` and `context`

Everything above `dev_only` is for whoever works on Veistra. These three are for
the agent working *in* it, so none is gated: all start on, all appear with
developer mode off, and all are written into `.mcp.json` as `veistra-canvas`,
`veistra-workspace` and `veistra-context` (the committed `.mcp.json` carries them, and a
test holds it to what a fresh sync writes). Harness terminals reach them through the
same `VEISTRA_MCP_PORT` and `VEISTRA_MCP_TOKEN` as every other route; `mcp-endpoint.json`
serves the same endpoint to an agent outside Veistra, at `/mcp/canvas`,
`/mcp/workspace` and `/mcp/context`.

### `workspace`

Tells an agent where the person is working, and carries the agent's half of Play's
fix loop. The first four tools only read; it leaves out what `shell_snapshot`
carries for the shell's own sake (geometry, band heights, restore bookkeeping).

| Tool | Answers |
|---|---|
| `focus` | The focused pane: window, cluster, pane, app, instance id, title, and the file and selection the app reports. Also `visible`, every app showing in the active cluster, because focus is usually in the agent's own terminal. Falls back to each pane's active tab when no page answers. |
| `layout` | Windows, clusters, nested panes and their tabs (app, instance, title, file where known), the active tab per pane, and each cluster's terminals. |
| `project` | Per cluster: the project folder, the folder files are read from (a worktree's, when set), the environment kind and branch, and which cluster is active. |
| `list_play_notes` | The notes the person sent from a recorded Play take: id, status, take, time, scene, object, and the newest packet's `packet.md`, with `takes` listing every take of a note sent back as Still broken, oldest first. Open or working ones unless `status` says `fixed` or `all`. |
| `start_play_note` | Marks a note Agent working. Writes. |
| `resolve_play_note` | `{id, summary, commit?}`: marks a note Fixed, check it, with the summary. Writes. It never closes the note; the person does, with Looks good or Still broken. |

The play-note tools live here because the design put them here: they are about
the environment the person is working in, like `project`. `context` serves the same
three, from `src-tauri/src/mcp/servers/play_notes.rs`, because an agent tab's session
token opens `context` and not `workspace`, and Send may hand the notes to that agent.
Each row and `packet.md` name the note's cluster; a call that names no cluster and asks
about a note the person's cluster does not hold is answered from the cluster that does.
Their rules are in `src-tauri/src/godot/notes.rs`; a note is a comment with a `take`
anchor (`docs/design-notes/viewer-comments.md`). Both writes are refused on the
read-only main checkout.

The layout comes from the same `ShellState` snapshot `shell_snapshot` reads. Where
focus is comes from `mcp::FocusState`, which each window's shell keeps current (see
below); `focus` still asks each window's page for what only the DOM knows at that
moment, the way the `context` tool does. An app can say what it shows by defining
`window.__veistraContext`; Canvas reports its open canvas and selection.

#### Focus push: `veistra://workspace/focus`

Polling `focus` works, but an agent that wants to know what "this" means when the
person speaks is better told when focus moves. The server publishes one resource,
`veistra://workspace/focus` (`application/json`), and declares the `resources`
capability with `subscribe: true`. Reading it returns exactly what the `focus` tool
returns, so there is one answer however it is asked for. It lists, reads and
subscribes only while the server is switched on, like its tools.

**How an agent subscribes.** The notification carries only the uri; the agent
re-reads to see the new state.

1. `resources/list` shows `veistra://workspace/focus`.
2. `resources/subscribe` with `{"uri": "veistra://workspace/focus"}` (clients on
   protocol versions before 2026-07-28), or `subscriptions/listen` with
   `resourceSubscriptions: ["veistra://workspace/focus"]` (2026-07-28). Both are
   supported; the second holds one request open and carries the notifications on it.
3. On `notifications/resources/updated` for that uri, call `resources/read` (or the
   `focus` tool).
4. `resources/unsubscribe` to stop. A session that simply goes away is dropped the
   next time a notification is queued for it.

Whether the agent surfaces `resources/updated` to the model is up to the harness; a
client that ignores it loses nothing, since `focus` still works.

**What counts as a change.** Each window reports `{window, windowHasFocus, focusIn,
instance, pane, cluster}`, and the backend compares it with that window's last
report. Only a difference notifies: moving focus to another pane, instance or
cluster, or the window gaining or losing OS focus. With several canvases open, the
instance and pane say which one.

**How it is built.**

- *Reporter* (`src/shell/focusReport.ts`, `useFocusReporter.ts`): listens to
  `focusin`/`focusout`, window `focus`/`blur`, and changes of active pane or
  cluster; waits 150 ms for the events to stop; sends only if the reading differs
  from the last one sent.
- *State* (`src-tauri/src/mcp/focus.rs`): `FocusState` holds the latest report per
  window; the `report_focus` command updates it and says whether it was news. A
  closed window's report is dropped. A 50 ms coalescer folds the blur-then-focus
  pair of switching windows into one notification.
- *Subscriptions* (`src-tauri/src/mcp/subscriptions.rs`): a `(server, uri, session)`
  table whose entries hold a queue; the session's task forwards each queued uri down
  its event stream with `notify_resource_updated`. `Bridge` in `listener.rs`
  implements `resources/list|read|subscribe|unsubscribe` and, for the newer
  protocol, `subscriptions/listen`.

### `canvas`

One tool per Canvas method, so an agent in a release build can read and draw
without `app_call`. Every call goes out with `actor: "agent"`; the schemas do not
offer `actor`.

- **Reads:** `list_canvases`, `list_files`, `assets`, `read_canvas`, `stat_canvas`,
  `list_diagrams`, `describe_diagram`, `view_diagram`, `coverage`, `values`, `refs`,
  `checkpoints`, `list_comments`, `view_comment`, and `drawing_guide`, which returns
  `docs/canvas-drawing-guide.md`, `docs/canvas-design-prompt.md` or `docs/canvas-objects.md` (compiled in) so an agent
  with only these tools can read the manual before it draws.
- **Writes:** `create_canvas`, `write_canvas`, `save`, `add_shapes`, `import_mermaid`,
  `set_values`, `restore_checkpoint`, `create_comment`, `resolve_comment`,
  `reopen_comment`.

`canvas/state` has no tool: `list_canvases` and `workspace/project` cover it.

**Several canvases at once.** Each canvas tool takes `canvas` (the id, a path under
`canvas/`), `instance` (a pane's instance id) and `cluster`. They resolve as follows:

1. `instance` wins: its canvas and cluster are used.
2. Else `canvas` as named, in the cluster it is open in, or `cluster`, or the active
   one. An id open in two clusters is an error that lists both.
3. Else the focused canvas, or the only one open. Two or more open with none focused
   is an error listing them; nothing open is an error too.

Every answer carries a `resolved` block (`canvas`, `instance`, `cluster`, `how`, and a
note when a default was used), so a default is never silent. `list_canvases` also
reports what a call that names nothing would use.

**Frames and types.** A frame is the unit of meaning on a canvas (a labelled, typed
object); see `docs/canvas-objects.md`. Twelve tools expose it:

- **Reads:** `list_types`, `list_frames`, `search_frames`, `get_frame`, `frame_image`,
  `canvas_tree`.
- **Writes:** `save_type`, `delete_type`, `set_parent`, `link_frame`, `set_frame`, `create_frame`.

The intended order is `list_frames` or `search_frames` first, then `get_frame` and
`frame_image` for detail, and `create_frame` to group elements into a labelled typed
object. `frame_image` returns the PNG's path and size and does not attach the image:
the path is what the caller needs. `veistra-context`'s `get_canvas_node` attaches it.

Scope differs per tool. The project-wide ones (`list_types`, `list_frames`,
`search_frames`, `canvas_tree`, `save_type`, `delete_type`) use `Scope::Project`: they
resolve only a cluster, and an optional `canvas` is a filter handed to the method
untouched, so omitting it means the whole project and never the focused canvas. The
per-canvas ones (`get_frame`, `frame_image`, `set_frame`, `create_frame`) use the
resolution above. `set_parent` and `link_frame` do too, but require `canvas`, and the
server refuses the call with `canvas-required` when it is missing, so neither can
touch the focused canvas by accident. `link_frame` links a frame to an existing child
canvas (or unlinks it with `child: null`) and keeps the child's `parent` in step. The frame methods read the canvas as `canvas` and the
older ones as `id`; the server sends the resolved canvas under whichever the method
expects.

**Adding a tool** is one row in the `canvas_tools!` table in
`src-tauri/src/mcp/servers/canvas.rs`: tool name, app method, `Scope`, read-only
flag, description, schema. The tool list, dispatch and `readOnlyHint` come from it.

Rendering (`view_diagram`, `view_comment`, `add_shapes`, `import_mermaid`) runs in a
Canvas pane's webview, so one must be open somewhere; the error says how to open one.

**Which canvas a render or write lands on.** `view_diagram`, `add_shapes`,
`import_mermaid` and `view_comment` always read and write the file of the canvas they
resolve to. The Canvas pane is only an engine for fonts, Excalidraw and Mermaid: the
pane showing that canvas is preferred, but with several canvases open any pane may
do the drawing, and the file written is still the named one. If no Canvas pane is open
anywhere the error names the canvas and says to open one. `describe_diagram` and
`view_diagram` take `frame` as an alias for `diagram`.

**Inactive clusters.** A pane learns its canvas from the page's `__veistraContext`, which
only exists for a mounted pane, so a pane in an inactive cluster reports `canvas: null`.
`list_canvases` flags these with `canvasKnown: false` and a `note`. When a call names no
canvas and some pane's canvas is unknown, it is refused (`canvas-unknown` when no
canvas is known at all, otherwise an ambiguity listing every pane, including the ones
with no file) rather than guessed. Name `canvas` or `instance` to be certain.

### `context`

References, both ways: the agent finds, reads and shows the person files, frames,
comments, screenshots and assets by `veistra://` reference, and reads the selection.
Tools: `show`, `read`, `search_context`, `list_comments`, `resolve_comment`,
`get_selection` and `get_canvas_node`. It publishes `veistra://selection`, which
notifies alongside `veistra://workspace/focus`, and reads every other reference as an
unlisted resource, with templates that say how to write one. An agent the host
launches for one cluster gets a token that opens `/mcp/context` only and answers
from that cluster. The scheme, the security rules and each tool are in
`docs/design/VEISTRA-CONTEXT-REFS.md`.

**Transport.** Every route here, `context` included, is streamable HTTP. It requires
an `initialize` call and the returned `mcp-session-id` header on later requests; a
bare `tools/call` returns 422.
