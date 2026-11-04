//! The two Blender export tools (#317, DECISIONS X6), `export_blend` and
//! `list_blend_exports`, served by `workspace` and `context` as the play-note
//! tools are ([`super::play_notes`] says why both).
//!
//! An agent exports a `.blend` while the person may have it open in Blender
//! in a pane. The export only reads the file and lands as the next numbered
//! version under `.veistra/exports/`, so nothing the person is editing is
//! written. `export_blend` answers once the export has started, never waiting
//! for Blender: a tool call runs on the server's async worker, and an export
//! can take minutes. `list_blend_exports` shows it once it lands.

use super::workspace::{active_cluster, page_contexts};
use crate::apps::blender_viewer;
use crate::apps::CallContext;
use crate::mcp::{McpTool, ToolAnswer};
use crate::shell_state::ShellState;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

pub const TOOLS: [McpTool; 2] = [
    McpTool {
        name: "export_blend",
        description: "Export a .blend as its next version: a .glb with modifiers applied, \
                      preview renders, a parts list and per-material values, in \
                      .veistra/exports/<asset>/v<n>/ beside an export.json. Never writes the \
                      .blend, even while the person has it open in Blender; the last ten \
                      versions are kept. Answers as soon as it starts, with the version number.",
        schema: blend_schema,
    },
    McpTool {
        name: "list_blend_exports",
        description: "A .blend's export versions, newest first: each one's number, author, \
                      time, commit, triangle count and files, whether Blender in a pane has the \
                      file open now, and the export running, if any.",
        schema: blend_schema,
    },
];

/// Whether `tool` is one of these.
pub fn serves(tool: &str) -> bool {
    TOOLS.iter().any(|t| t.name == tool)
}

/// MCP's `readOnlyHint` for these, `None` for any other tool.
pub fn read_only(tool: &str) -> Option<bool> {
    match tool {
        "list_blend_exports" => Some(true),
        "export_blend" => Some(false),
        _ => None,
    }
}

fn blend_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "blend": {
                "type": "string",
                "description": "The .blend, relative to the project, such as props/bed.blend.",
            },
            "cluster": {
                "type": "string",
                "description": "The cluster whose project holds it. Omit it for the one the \
                                person is working in.",
            },
        },
        "required": ["blend"],
        "additionalProperties": false,
    })
}

fn arg<'a>(params: &'a Option<Value>, key: &str) -> Result<Option<&'a str>, RpcError> {
    match params.as_ref().and_then(|p| p.get(key)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{key}` is a string"),
        )),
    }
}

/// Answer `tool` from the live app.
pub fn call(app: &AppHandle, tool: &str, params: &Option<Value>) -> Result<ToolAnswer, RpcError> {
    let blend = arg(params, "blend")?
        .filter(|b| !b.trim().is_empty())
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "`blend` is required"))?;
    let cluster = match arg(params, "cluster")?.filter(|c| !c.is_empty()) {
        Some(named) => named.to_string(),
        None => {
            let snapshot = app.state::<ShellState>().snapshot();
            active_cluster(&snapshot, &page_contexts(app))
                .map(|(_, c)| c)
                .ok_or_else(|| {
                    RpcError::new(
                        INTERNAL_ERROR,
                        "there is no cluster to export from; name one with `cluster`",
                    )
                })?
        }
    };
    let ctx = CallContext::resolve(app, None, Some(&cluster));
    blender_viewer::with_services(app, &ctx, |services| run(&ctx, services, tool, blend))
        .map(Into::into)
}

/// The tool itself, apart from the app.
pub fn run(
    ctx: &CallContext,
    services: &blender_viewer::Services,
    tool: &str,
    blend: &str,
) -> Result<Value, RpcError> {
    match tool {
        "export_blend" => blender_viewer::agent_export(ctx, services, blend),
        "list_blend_exports" => blender_viewer::agent_exports(ctx, services, blend),
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no Blender export tool named `{other}`"),
        )),
    }
}
