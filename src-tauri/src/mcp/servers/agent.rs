//! The one server an agent working on Veistra connects to.
//!
//! Everything needed to drive this window behind a single endpoint: the ten
//! interaction tools [`super::ui`] owns, the three reads [`super::debug`] owns,
//! and three that had no home before — [`app_call`] reaches any app's Rust
//! half, [`open_app`] mounts one, [`set_project`] points a cluster at a folder
//! without raising a picker.
//!
//! One server rather than four because the tools are separable and the *task*
//! is not: testing an app means screenshotting it, reading the shell layout,
//! calling a method, then checking `recent_errors` — one loop, and otherwise
//! four switches to leave off. [`super::ui`] and [`super::debug`] stay
//! registered for the cases that want them alone, and [`TOOL_LIST`] composes
//! their tools rather than restating them.
//!
//! `dev_only`, for [`super::ui`]'s reason rather than a new one: this can
//! click, and `eval` reaches every `#[tauri::command]`. Gating `debug`'s reads
//! *here* is what `debug` staying registered is for — a release build that
//! misbehaves is still diagnosed through `veistra-debug`, ungated, as before.

use crate::apps;
use crate::layout::SplitDir;
use crate::mcp::{McpServer, McpTool, ToolAnswer};
use crate::shell_state::ShellState;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

pub static SERVER: McpServer = McpServer {
    id: "agent",
    name: "Agent",
    description: "Drive and inspect the running window: screenshots, input, the shell's own \
                  state, and a direct line to any app's Rust half.",
    tools: TOOLS,
    call,
    // It clicks, and `eval` reaches the whole backend. See the module doc for
    // why absorbing `debug`'s reads costs a release build nothing.
    dev_only: true,
};

static TOOLS: &[McpTool] = &TOOL_LIST;

/// The sixteen, composed rather than restated.
///
/// Indexing `ui`'s and `debug`'s const arrays is what keeps one description of
/// each tool in the codebase. The order is the order an agent uses them in:
/// look, act, read back, then the three that set a surface up.
const TOOL_LIST: [McpTool; 16] = [
    super::ui::TOOL_LIST[0],
    super::ui::TOOL_LIST[1],
    super::ui::TOOL_LIST[2],
    super::ui::TOOL_LIST[3],
    super::ui::TOOL_LIST[4],
    super::ui::TOOL_LIST[5],
    super::ui::TOOL_LIST[6],
    super::ui::TOOL_LIST[7],
    super::ui::TOOL_LIST[8],
    super::ui::TOOL_LIST[9],
    super::debug::TOOL_LIST[0],
    super::debug::TOOL_LIST[1],
    super::debug::TOOL_LIST[2],
    McpTool {
        name: "app_call",
        description: "Call an app's Rust half directly — Schematify's design model, Home's \
                      project methods, Files' reads. The same dispatch the app's own frontend \
                      reaches over `invoke`, with the calling cluster named rather than inferred.",
        schema: app_call_schema,
    },
    McpTool {
        name: "open_app",
        description: "Mount an app into a pane and return the instance id. What the Apps menu \
                      does, without needing a snapshot and two clicks to find it.",
        schema: open_app_schema,
    },
    McpTool {
        name: "set_project",
        description: "Point a cluster at a project folder. The dialog-free primitive under \
                      Home's opening methods — it moves the cluster's pointer and nothing else, \
                      touching neither the Recent list nor the pane layout.",
        schema: set_project_schema,
    },
];

/// Why `app_call` refuses `method`, for the panel.
pub fn blocked_reason(method: &str) -> Option<String> {
    if apps::agent_tab::needs_its_tab(method) {
        return Some("Acts on one agent tab's session, so only that tab may call it".to_string());
    }
    if crate::refs::is_method(method) {
        return Some(AS_THE_PERSON.to_string());
    }
    if ACTS_ON_THE_EDITOR.contains(&method) {
        return Some(
            "Acts on the person's Godot editor window, so only the Godot pane may call it; \
             `godot/editor-state`, `godot/editor-selection` and `godot/editor-capture` read it"
                .to_string(),
        );
    }
    NEEDS_A_PERSON
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, instead)| format!("Raises a native dialog, so app_call refuses it: {instead}"))
}

/// The Godot editor in the pane is the person's (#316): an agent may read
/// what it shows, but not open, close, save or steer it under them.
const ACTS_ON_THE_EDITOR: &[&str] = &[
    "godot/editor-open",
    "godot/editor-close",
    "godot/editor-save",
    "godot/editor-select",
    "godot/editor-open-scene",
    "godot/editor-viewport-only",
];

/// The methods that raise a native dialog, and what to reach for instead.
///
/// Refused here rather than left to fail slowly. An `rfd` dialog is modal: it
/// blocks until somebody dismisses it by hand, and nobody is going to — the
/// caller is an agent, and the window may not even be focused. The first
/// symptom is every later tool on this server timing out with no indication
/// why. A named refusal costs one round trip and says where to go.
///
/// The reason this list is needed *here* and not on `commands::app_call` is a
/// difference in what the two run on. That command moves every dispatch to
/// `spawn_blocking` — `apps/home.rs` says outright that this is what makes the
/// picker safe — whereas `mcp::listener` calls into the registry inline from an
/// async handler. So the same method that is merely slow through the frontend
/// would wedge a runtime worker through this path.
const NEEDS_A_PERSON: &[(&str, &str)] = &[
    (
        "home/new-project",
        "`set_project` points a cluster at a folder with no dialog",
    ),
    (
        "home/open-project",
        "`set_project` points a cluster at a folder with no dialog, and `home/open-recent` \
         opens one the way Home does",
    ),
    ("files/save-as", "`files/write` takes a path outright"),
];

/// The window an unqualified call is about.
///
/// The main window is the only one an agent has ever been pointed at, and
/// naming it beats picking whichever window happened to be iterated first.
const MAIN_WINDOW: &str = "main";

/// Every app this build registers, for the `app` enum.
///
/// Read from `apps::roster()` rather than written out, for the reason
/// `ui::key_schema` reads `KEYS`: the list a client picks from has to be the
/// list that will actually dispatch, or the schema becomes a second answer that
/// drifts the first time an app is added or retired.
fn app_ids() -> Vec<&'static str> {
    apps::roster().into_iter().map(|(id, _)| id).collect()
}

fn app_call_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "app": {
                "type": "string",
                "enum": app_ids(),
                "description": "Which app answers. `schematify` is the design model.",
            },
            "method": {
                "type": "string",
                "description": "The method, namespaced by app — `schematify/lint`, `home/state`. \
                                Every Schematify method except `schematify/state` needs an open \
                                project, so call `set_project` first.",
            },
            "params": {
                "type": "object",
                "description": "The method's own parameters. Schematify wants an `actor` of \
                                `human` or `agent` on all but `schematify/state`.",
            },
            "cluster": {
                "type": "string",
                "description": "Which cluster the call is about — it decides which project \
                                answers. Defaults to the main window's active cluster. \
                                `shell_snapshot` lists the ids.",
            },
            "instance": {
                "type": "string",
                "description": "A mounted surface's id, resolved to whichever cluster's pane \
                                tree holds it. Wins over `cluster` when both are given.",
            },
        },
        "required": ["app", "method"],
        "additionalProperties": false,
    })
}

fn open_app_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "appId": {
                "type": "string",
                "enum": app_ids(),
                "description": "Which app to mount. A terminal is not an app and is refused.",
            },
            "pane": {
                "type": "string",
                "description": "The pane to open into. Defaults to the active cluster's first.",
            },
            "dir": {
                "type": "string",
                "enum": ["row", "column"],
                "description": "Split the pane along this axis instead of arriving as a tab \
                                beside what is already there.",
            },
            "window": {
                "type": "string",
                "description": "Which window, by label. Defaults to `main`.",
            },
        },
        "required": ["appId"],
        "additionalProperties": false,
    })
}

fn set_project_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "An absolute path to the project folder. Pass null to point the \
                                cluster at nothing.",
            },
            "cluster": {
                "type": "string",
                "description": "Which cluster to point. Defaults to the main window's active one.",
            },
        },
        "required": ["path"],
        "additionalProperties": false,
    })
}

/// An unknown tool cannot arrive here — `Registry::call` checks the name against
/// `TOOLS` first — so the final arm is a genuine impossibility.
fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    match tool {
        // Handed back to the modules that own them. See the module doc.
        "screenshot" | "snapshot" | "click" | "type_text" | "fill_field" | "context"
        | "press_key" | "drag" | "scroll" | "eval" => super::ui::call(app, tool, params),
        "shell_snapshot" | "recent_errors" | "boot_status" => super::debug::call(app, tool, params),
        "app_call" => app_call(app, params.as_ref()).map(Into::into),
        "open_app" => open_app(app, params.as_ref()).map(Into::into),
        "set_project" => set_project(app, params.as_ref()).map(Into::into),
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("the agent server has no tool named `{other}`"),
        )),
    }
}

/// A string parameter the schema marks required, refused by name if it is not
/// there. The schema should have caught it; not every client enforces one.
fn required<'a>(params: Option<&'a Value>, name: &str) -> Result<&'a str, RpcError> {
    params
        .and_then(|p| p.get(name))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{name}` is required, as a string")))
}

/// Refuse a method that would raise a native dialog.
///
/// Split out from [`app_call`] so it can be tested without an `AppHandle`,
/// which is the only thing standing between this rule and a test. An exact
/// match rather than a prefix: `home/open-recent` opens a project too, takes a
/// path, raises nothing, and is one of the methods the refusal points at.
/// Why `app_call` refuses a `refs/*` method.
const AS_THE_PERSON: &str = "Resolves a reference as the person looking at it, and every canvas \
                             call it makes is recorded as theirs, so an agent may not call it";

/// Refuse a reference method. `refs::call` answers as the person, since the
/// shell asks it to draw a chip they see; through `app_call` the caller is an
/// agent, which would be recorded as them.
fn guard_refs(method: &str) -> Result<(), RpcError> {
    if !crate::refs::is_method(method) {
        return Ok(());
    }
    Err(RpcError::new(
        INVALID_PARAMS,
        format!(
            "`{method}`: {AS_THE_PERSON}. `read` on the veistra-context server resolves a \
             reference as the agent."
        ),
    ))
}

fn guard_dialog(method: &str) -> Result<(), RpcError> {
    let Some((_, instead)) = NEEDS_A_PERSON.iter().find(|(name, _)| *name == method) else {
        return Ok(());
    };

    Err(RpcError::new(
        INVALID_PARAMS,
        format!(
            "`{method}` raises a native dialog, which blocks this window and every tool on this \
             server until somebody dismisses it by hand — and nobody is at the keyboard. \
             Instead: {instead}."
        ),
    ))
}

/// The `path` a [`set_project`] call is asking for.
///
/// Three states rather than two, and the middle one is not a mistake: a JSON
/// null clears the cluster's pointer, which is a thing `set_cluster_project`
/// already does and a caller may well want. Anything that is neither a string
/// nor null is refused rather than silently read as "clear it", because a
/// number here is a caller that thinks it sent a path.
fn path_param(params: Option<&Value>) -> Result<Option<String>, RpcError> {
    match params.and_then(|p| p.get("path")) {
        Some(Value::String(path)) => Ok(Some(path.clone())),
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err(RpcError::new(
            INVALID_PARAMS,
            "`path` must be a string, or null to point the cluster at nothing",
        )),
    }
}

/// Which cluster an unqualified call is about.
///
/// `None` rather than an error: `CallContext` treats an absent cluster as an
/// ordinary state, and the app being called is the one that knows whether it can
/// answer without one — `schematify/state` can, the other seventeen cannot, and
/// each already has the right message for it.
fn default_cluster(app: &AppHandle) -> Option<String> {
    app.state::<ShellState>().active_cluster_of(MAIN_WINDOW)
}

/// Route a call into an app's Rust half, the way `commands::app_call` does for
/// the app's own frontend.
///
/// The context is resolved here rather than taken from the caller for the same
/// reason the Tauri command resolves it on its worker: it has to see the layout
/// as it is when the call runs, not as it was when the request was parsed.
///
/// What this gives up against that command is the `spawn_blocking` hop. A slow
/// app method — a quarter-megabyte `files/read` off a cold disk — occupies a
/// runtime worker here for its duration, because `mcp::listener::call_tool`
/// calls `Registry::call` inline. Survivable, where a modal dialog is not: a
/// worker busy for 200ms comes back, and one parked on a picker waits for a
/// person who is not there. If a tool grows genuinely slow the fix is to make
/// `Call` async, not to widen [`NEEDS_A_PERSON`].
fn app_call(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let id = required(params, "app")?;
    let method = required(params, "method")?;

    guard_dialog(method)?;
    guard_refs(method)?;

    let cluster = params
        .and_then(|p| p.get("cluster"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| default_cluster(app));

    let instance = params
        .and_then(|p| p.get("instance"))
        .and_then(Value::as_str);

    let context = apps::CallContext::resolve(app, instance, cluster.as_deref());

    apps::call(
        app,
        &context,
        id,
        method,
        params.and_then(|p| p.get("params")).cloned(),
    )
}

/// Mount an app and answer with the instance id the caller will need to address
/// it — the same id `app_call`'s `instance` takes and `close_instance` wants.
fn open_app(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let app_id = required(params, "appId")?.to_owned();

    let label = params
        .and_then(|p| p.get("window"))
        .and_then(Value::as_str)
        .unwrap_or(MAIN_WINDOW)
        .to_owned();

    let pane = params
        .and_then(|p| p.get("pane"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    // Deserialized through serde rather than matched by hand, so the accepted
    // spellings stay whatever `SplitDir` says they are.
    let dir = match params.and_then(|p| p.get("dir")) {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            serde_json::from_value::<SplitDir>(value.clone()).map_err(|e| {
                RpcError::new(
                    INVALID_PARAMS,
                    format!("`dir` is not a split direction: {e}"),
                )
            })?,
        ),
    };

    let instance = crate::commands::open_instance(
        app.clone(),
        app.state::<ShellState>(),
        label,
        app_id,
        pane,
        dir,
    )
    .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;

    Ok(json!({ "instance": instance }))
}

/// Point a cluster at a project, through the primitive underneath Home rather
/// than through Home.
///
/// `path` is required by the schema but may be JSON null, which clears the
/// pointer — the same two-state argument `set_cluster_project` already takes.
fn set_project(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let path = path_param(params)?;

    // Checked here, because `set_cluster_project` does not check and the
    // failure it produces otherwise arrives two calls later wearing a
    // disguise: `project::cluster_path` filters a non-directory back out, so
    // the pointer reads as unset and the next `schematify/*` call answers "no
    // project is open in this cluster" — which is true, and says nothing about
    // the typo that caused it.
    if let Some(path) = path.as_deref() {
        if !Path::new(path).is_dir() {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("`{path}` is not a folder that exists, so no cluster can be pointed at it"),
            ));
        }
    }

    let cluster = params
        .and_then(|p| p.get("cluster"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| default_cluster(app))
        .ok_or_else(|| {
            RpcError::new(
                INTERNAL_ERROR,
                "there is no cluster to point at a project — name one with `cluster`, and see \
                 `shell_snapshot` for the ids",
            )
        })?;

    crate::commands::set_cluster_project(
        app.clone(),
        app.state::<ShellState>(),
        cluster.clone(),
        path.clone(),
    );

    Ok(json!({ "cluster": cluster, "project": path }))
}

/// What is provable without an `AppHandle`, which is all of it bar the three
/// handlers — `registry.rs` says plainly that a test cannot construct one. So:
/// the tool list, the schemas, and the two pure guards. The handlers are
/// acceptance-tested against a launched instance instead:
///
/// ```sh
/// pnpm probe --agent --server agent set_project '{"path":"…/fixtures/saas-backend"}'
/// pnpm probe --agent --server agent open_app    '{"appId":"schematify"}'
/// pnpm probe --agent --server agent app_call    '{"app":"schematify","method":"schematify/state"}'
/// pnpm probe --agent --server agent app_call    '{"app":"home","method":"home/open-project"}'
/// ```
///
/// The last must come back refused rather than hanging, and is worth running
/// every time this file changes.
#[cfg(test)]
mod tests {
    use super::*;

    fn names(tools: &[McpTool]) -> Vec<&'static str> {
        tools.iter().map(|t| t.name).collect()
    }

    /// The assertion that earns this module's claim to compose rather than copy.
    ///
    /// It fails the moment somebody adds a seventh tool to `ui` or a fourth to
    /// `debug` without extending [`TOOL_LIST`] — which is the whole failure
    /// mode a hand-written second list would have had, now caught at `cargo
    /// test` instead of by an agent wondering where a tool went.
    #[test]
    fn every_tool_ui_and_debug_host_is_hosted_here_too() {
        let mine = names(TOOLS);

        for borrowed in names(&super::super::ui::TOOL_LIST)
            .into_iter()
            .chain(names(&super::super::debug::TOOL_LIST))
        {
            assert!(
                mine.contains(&borrowed),
                "`{borrowed}` is hosted by ui or debug but not by agent"
            );
        }
    }

    /// The other direction: everything here is either borrowed or one of the
    /// three this server exists to add. A fourth would be a decision, and this
    /// is where it gets made rather than noticed.
    #[test]
    fn the_only_tools_beyond_the_borrowed_ones_are_the_three_that_needed_a_home() {
        let borrowed: Vec<&str> = names(&super::super::ui::TOOL_LIST)
            .into_iter()
            .chain(names(&super::super::debug::TOOL_LIST))
            .collect();

        let own: Vec<&str> = names(TOOLS)
            .into_iter()
            .filter(|name| !borrowed.contains(name))
            .collect();

        assert_eq!(own, vec!["app_call", "open_app", "set_project"]);
    }

    /// A duplicate is what a mistyped index in [`TOOL_LIST`] produces —
    /// `TOOL_LIST[1]` twice compiles, lists eleven distinct tools, and silently
    /// drops one. Nothing else in this file would notice.
    #[test]
    fn no_tool_is_listed_twice() {
        let mut seen = names(TOOLS);
        let count = seen.len();
        seen.sort_unstable();
        seen.dedup();

        assert_eq!(seen.len(), count, "a tool name appears more than once");
    }

    /// Every tool the server advertises has to answer `tools/list` with a
    /// schema a client can read. A `json!` that is accidentally an array or a
    /// bare string would pass compilation and fail at the protocol.
    #[test]
    fn every_schema_is_an_object_schema() {
        for tool in TOOLS {
            let schema = (tool.schema)();
            assert_eq!(
                schema.get("type").and_then(Value::as_str),
                Some("object"),
                "{}'s schema is not an object schema",
                tool.name
            );
        }
    }

    /// Every entry is refused, and every refusal carries its own replacement —
    /// not a generic one. `files/save-as` is on this list too, and pointing it
    /// at `set_project` would be worse than saying nothing.
    #[test]
    fn a_method_that_raises_a_dialog_is_refused_and_names_its_replacement() {
        for (method, instead) in NEEDS_A_PERSON {
            let refusal = guard_dialog(method).expect_err("should be refused");

            assert_eq!(refusal.code, INVALID_PARAMS);
            assert!(
                refusal.message.contains(instead),
                "the refusal for `{method}` does not say what to use instead: {}",
                refusal.message
            );
        }
    }

    /// A reference resolves as the person, so an agent cannot reach one by
    /// naming any app it likes. The panel says so too.
    #[test]
    fn a_reference_method_is_refused_and_the_panel_says_why() {
        let refusal = guard_refs(crate::refs::RESOLVE_METHOD).expect_err("should be refused");
        assert_eq!(refusal.code, INVALID_PARAMS);
        assert!(
            refusal.message.contains("as the person"),
            "{}",
            refusal.message
        );
        assert!(
            refusal.message.contains("veistra-context"),
            "names what to use instead: {}",
            refusal.message
        );
        assert!(guard_refs("canvas/frames").is_ok());
        assert!(guard_refs("refs/sync").is_ok(), "a plugin's own method");
        assert_eq!(
            blocked_reason(crate::refs::RESOLVE_METHOD).as_deref(),
            Some(AS_THE_PERSON)
        );
    }

    #[test]
    fn an_agent_reads_the_godot_editor_but_does_not_steer_it() {
        for method in ACTS_ON_THE_EDITOR {
            let reason = blocked_reason(method).unwrap_or_default();
            assert!(reason.contains("Godot editor window"), "{method}");
        }
        for method in [
            "godot/editor-state",
            "godot/editor-selection",
            "godot/editor-capture",
            "godot/editor-pick",
        ] {
            assert_eq!(blocked_reason(method), None, "{method}");
        }
    }

    /// The list has to hold every method that actually raises one. This is the
    /// half a reader can check: `rfd` is the crate, so a method that reaches it
    /// is a method that blocks. `files/save-as` was missing from the first
    /// draft of this list and is the reason the test exists.
    #[test]
    fn the_dialog_list_names_every_method_this_build_knows_raises_one() {
        let listed: Vec<&str> = NEEDS_A_PERSON.iter().map(|(name, _)| *name).collect();

        for expected in ["home/new-project", "home/open-project", "files/save-as"] {
            assert!(listed.contains(&expected), "`{expected}` is not refused");
        }
    }

    /// The enum a client picks from is the list that will actually dispatch.
    /// Hardcoding it would pass today and go stale the first time an app is
    /// registered or retired — which has already happened twice, to Forger and
    /// Journeyman.
    #[test]
    fn the_app_enum_offers_exactly_the_apps_this_build_registers() {
        let registered: Vec<String> = apps::roster()
            .into_iter()
            .map(|(id, _)| id.to_string())
            .collect();

        for schema in [app_call_schema(), open_app_schema()] {
            let offered: Vec<String> = schema["properties"]
                .as_object()
                .and_then(|p| p.values().find_map(|v| v.get("enum")))
                .and_then(Value::as_array)
                .expect("an app enum")
                .iter()
                .map(|v| v.as_str().expect("a string").to_string())
                .collect();

            assert_eq!(offered, registered);
        }
    }

    /// Asserted rather than trusted: the two spellings in `open_app`'s schema
    /// have to be the two `SplitDir` deserializes, or a client following the
    /// schema gets refused by serde. `vertical` and `Row` are the plausible
    /// typos this catches.
    #[test]
    fn the_split_enum_is_what_split_dir_accepts() {
        let schema = open_app_schema();
        let offered = schema["properties"]["dir"]["enum"]
            .as_array()
            .expect("a dir enum");

        assert!(!offered.is_empty());

        for spelling in offered {
            serde_json::from_value::<SplitDir>(spelling.clone())
                .unwrap_or_else(|e| panic!("SplitDir does not accept {spelling}: {e}"));
        }
    }

    /// The near miss, and the reason the guard matches exactly rather than on a
    /// `home/` prefix or a `open` substring. This method opens a project too,
    /// takes a path, and raises nothing — refusing it would remove the one
    /// route the refusal above recommends.
    #[test]
    fn the_dialog_free_way_to_open_a_project_is_not_refused() {
        for method in [
            "home/open-recent",
            "home/initialize-project",
            "home/state",
            "schematify/lint",
        ] {
            assert!(
                guard_dialog(method).is_ok(),
                "`{method}` raises no dialog and must not be refused"
            );
        }
    }

    #[test]
    fn a_path_arrives_as_a_string() {
        let params = json!({ "path": "C:/projects/saas-backend" });

        assert_eq!(
            path_param(Some(&params)).expect("a string path is valid"),
            Some("C:/projects/saas-backend".to_string())
        );
    }

    /// Null and absent both mean "point this cluster at nothing", which is a
    /// state `set_cluster_project` already has a spelling for.
    #[test]
    fn a_null_or_missing_path_clears_the_pointer() {
        assert_eq!(
            path_param(Some(&json!({ "path": null }))).expect("valid"),
            None
        );
        assert_eq!(path_param(Some(&json!({}))).expect("valid"), None);
        assert_eq!(path_param(None).expect("valid"), None);
    }

    /// Refused rather than read as a clear. A caller sending a number thinks it
    /// sent a path, and silently unsetting its project is the worst available
    /// answer to that.
    #[test]
    fn a_path_that_is_neither_a_string_nor_null_is_refused() {
        let refusal = path_param(Some(&json!({ "path": 7 }))).expect_err("should be refused");

        assert_eq!(refusal.code, INVALID_PARAMS);
    }

    #[test]
    fn a_required_string_is_refused_by_name_when_it_is_missing() {
        let refusal = required(Some(&json!({ "method": "home/state" })), "app")
            .expect_err("should be refused");

        assert_eq!(refusal.code, INVALID_PARAMS);
        assert!(
            refusal.message.contains("`app`"),
            "the refusal does not name the parameter: {}",
            refusal.message
        );
    }

    /// The gate, asserted here as well as in `servers/mod.rs`, because this is
    /// the file somebody edits when they want the server to be more convenient.
    #[test]
    fn the_server_that_can_click_is_developer_only() {
        assert!(SERVER.dev_only);
    }
}
