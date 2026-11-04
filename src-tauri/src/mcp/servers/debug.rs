//! What Veistra looks like from the inside, for the agent working on it.
//!
//! [`servers`](super)'s rule is that a server answers what no harness could
//! answer for itself. An agent can read every file in this repo and still not
//! know whether the window it just changed drew two panes or four, or that a
//! store failed to write forty seconds ago. `layout.json` is the closest thing
//! on disk and it lags the screen and is silent about every failure.
//!
//! **Every tool here is a read**, and that boundary is deliberate rather than a
//! matter of what got built first: the endpoint is reachable by anything on the
//! machine holding the token, so a leaked token should cost knowledge of a
//! window layout and not control of it.
//!
//! Full argument, including why this ships in release builds:
//! `docs/design-notes/agent-debugging.md`.
//!
//! [`super::agent`] hosts these three by delegation, next to the tools that
//! drive the window; prefer it while *working on* Veistra. This module is what
//! diagnoses a build with only the reads. Both need developer mode, and both
//! are registered rather than one replacing the other.

use crate::diagnostics::diagnostics;
use crate::mcp::{McpServer, McpTool, ToolAnswer};
use crate::shell_state::ShellState;
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR};

pub static SERVER: McpServer = McpServer {
    id: "debug",
    name: "Debug",
    description: "Read the running shell: its layout, its recent failures, and how boot went.",
    tools: TOOLS,
    call,
    // Read-only, but a diagnostic surface for whoever is working on Veistra, so
    // it sits behind developer mode with `ui` and `agent`. See the module doc.
    dev_only: true,
};

/// How many records [`recent_errors`] returns when it is not told.
const DEFAULT_ERROR_LIMIT: usize = 100;

/// The most it will return however large a `limit` it is handed.
///
/// A cap rather than a rejection: a model asking for a thousand wants "all of
/// them", and a truncated answer serves that better than an error does.
const MAX_ERROR_LIMIT: usize = 500;

static TOOLS: &[McpTool] = &TOOL_LIST;

/// The same three reads, as a const array the `agent` server can index. See
/// [`super::ui::TOOL_LIST`] for why the array is named rather than inlined.
pub(super) const TOOL_LIST: [McpTool; 3] = [
    McpTool {
        name: "shell_snapshot",
        description: "The live shell layout: every window, cluster, pane tree, mounted surface \
                      and terminal tab, as the running app holds it, plus `embeds`: every native \
                      window placed over a pane, with its box and how long its last move took. \
                      This is what is on screen now, which layout.json on disk is not.",
        schema: no_params,
    },
    McpTool {
        name: "recent_errors",
        description: "Failures Veistra has recorded since it started, from both the Rust backend \
                      and the webview. These are not written to any file — in a release build \
                      they are not written anywhere at all — so this is the only way to read \
                      them back.",
        schema: recent_errors_schema,
    },
    McpTool {
        name: "boot_status",
        description: "How far startup got, and whether it failed. Answers whether the window is \
                      empty because boot is still working or because it gave up.",
        schema: no_params,
    },
];

fn no_params() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
}

fn recent_errors_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "after": {
                "type": "integer",
                "minimum": 0,
                "description": "Only records with a higher `seq` than this. Pass back the \
                                `latestSeq` from a previous call to poll for what is new.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "description": "How many records to return, oldest first. Defaults to 100, \
                                capped at 500.",
            },
        },
        "additionalProperties": false,
    })
}

/// An unknown tool cannot arrive here — `Registry::call` checks the name against
/// `TOOLS` first — so the final arm is a genuine impossibility rather than a
/// second copy of that error message.
///
/// `pub(super)` so [`super::agent`] can hand its three borrowed tool names
/// straight through rather than keeping a second copy of these three reads.
pub(super) fn call(
    app: &AppHandle,
    tool: &str,
    params: Option<Value>,
) -> Result<ToolAnswer, RpcError> {
    match tool {
        "shell_snapshot" => shell_snapshot(app).map(Into::into),
        "recent_errors" => Ok(recent_errors(params.as_ref()).into()),
        "boot_status" => boot_status(app).map(Into::into),
        other => Err(RpcError::new(
            veistra_rpc::METHOD_NOT_FOUND,
            format!("the debug server has no tool named `{other}`"),
        )),
    }
}

/// The same snapshot the frontend gets over `shell:state`.
///
/// Taken through `ShellState` rather than read from `layout.json`, which is the
/// whole point of the tool: the file lags the screen and omits everything that
/// does not survive a restart.
///
/// `embeds` is every native window placed over a pane (`crate::embed::host`):
/// its pane instance, state, box, last placement and how long that move took
/// to land (`lastPlaceMs`), which is how a Windows pass reads §13 test 1.
fn shell_snapshot(app: &AppHandle) -> Result<Value, RpcError> {
    let snapshot = app.state::<ShellState>().snapshot();

    let mut value = serde_json::to_value(&snapshot).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the shell snapshot would not serialize: {e}"),
        )
    })?;
    value["embeds"] = app.state::<crate::embed::host::Hosts>().report();
    Ok(value)
}

/// Recent failures, with the counts that say whether the list is complete.
///
/// Bad parameter types are ignored rather than refused. `after` and `limit` are
/// both hints about how much to return, and a caller that sends a string for
/// `limit` is better served by the default than by an error that tells it
/// nothing about the shell.
fn recent_errors(params: Option<&Value>) -> Value {
    let after = params.and_then(|p| p.get("after")).and_then(Value::as_u64);

    let limit = params
        .and_then(|p| p.get("limit"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).min(MAX_ERROR_LIMIT))
        .unwrap_or(DEFAULT_ERROR_LIMIT);

    let snapshot = diagnostics().since(after, limit);

    json!({
        "records": snapshot.records,
        "dropped": snapshot.dropped,
        "latestSeq": snapshot.latest_seq,
        // Said out loud because an empty list is ambiguous and a model will
        // otherwise read it as "nothing has gone wrong". Errors inside an app's
        // iframe never reach the buffer at all; see `src/shell/diagnostics.ts`.
        "covers": "The shell window and the Rust backend. Errors raised inside an app's \
                   iframe are not captured yet.",
    })
}

/// Where boot got to, or the same "starting" placeholder the frontend is given
/// before the first real report lands.
fn boot_status(app: &AppHandle) -> Result<Value, RpcError> {
    let status = app.state::<AppState>().boot_status();

    serde_json::to_value(status).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the boot status would not serialize: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::Origin;

    #[test]
    fn the_server_declares_exactly_the_three_read_tools() {
        let names: Vec<&str> = SERVER.tools.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            vec!["shell_snapshot", "recent_errors", "boot_status"]
        );
    }

    /// The listener hands `rmcp` a map for `inputSchema`, so a schema that were
    /// an array or a string would have nowhere to go.
    #[test]
    fn every_schema_is_an_object() {
        for tool in SERVER.tools {
            assert!(
                (tool.schema)().is_object(),
                "schema for {:?} must be a JSON object",
                tool.name
            );
        }
    }

    #[test]
    fn a_limit_above_the_cap_is_clamped_rather_than_refused() {
        let answer = recent_errors(Some(&json!({ "limit": 100_000 })));
        let returned = answer["records"].as_array().expect("records is a list");
        assert!(returned.len() <= MAX_ERROR_LIMIT);
    }

    /// Both parameters are hints, so a caller that gets their types wrong gets
    /// the default rather than an error that says nothing about the shell.
    #[test]
    fn mistyped_parameters_fall_back_to_the_defaults() {
        for bad in [
            json!({ "limit": "lots" }),
            json!({ "after": "recently" }),
            json!({}),
        ] {
            let answer = recent_errors(Some(&bad));
            assert!(answer["records"].is_array());
            assert!(answer["latestSeq"].is_u64());
        }
    }

    #[test]
    fn no_parameters_at_all_is_a_valid_call() {
        let answer = recent_errors(None);
        assert!(answer["records"].is_array());
    }

    /// An empty list has to say what it covers, or it reads as "nothing went
    /// wrong anywhere" when it means "nothing went wrong in the two places this
    /// can see".
    #[test]
    fn the_answer_admits_what_it_does_not_capture() {
        let answer = recent_errors(None);
        let covers = answer["covers"].as_str().expect("covers is a string");
        assert!(covers.contains("iframe"));
    }

    /// The cursor is what makes polling work: a record written after a read has
    /// to show up in the next one, and a record written before it must not.
    ///
    /// Asserts on membership rather than on an exact count. This reads the
    /// process-wide buffer, which every other test in this binary shares, so any
    /// of them recording a failure of its own would break a length assertion
    /// here for reasons that have nothing to do with cursors.
    #[test]
    fn a_cursor_from_one_answer_selects_only_what_came_after_it() {
        let before = "debug.rs test: recorded before the cursor";
        let after = "debug.rs test: recorded after the cursor";

        let log = diagnostics();
        log.record(Origin::Backend, before);

        let first = recent_errors(None);
        let cursor = first["latestSeq"].as_u64().expect("a sequence number");

        log.record(Origin::Backend, after);

        let second = recent_errors(Some(&json!({ "after": cursor })));
        let messages: Vec<&str> = second["records"]
            .as_array()
            .expect("records is a list")
            .iter()
            .filter_map(|r| r["message"].as_str())
            .collect();

        assert!(messages.contains(&after), "the later record should be here");
        assert!(
            !messages.contains(&before),
            "the earlier record is below the cursor and should not be"
        );
    }
}
