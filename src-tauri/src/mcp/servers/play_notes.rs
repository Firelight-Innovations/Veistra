//! The three play-note tools (design §9.3), `list_play_notes`,
//! `start_play_note` and `resolve_play_note`, served by two servers.
//!
//! Send hands its packet to whichever agent the person uses. A terminal agent
//! holds the master token and reaches `workspace`; an agent tab's session token
//! opens only `context` and `canvas`. Both servers answer these tools, from this
//! one module, so the agent Send chose can always report on the note. Opening
//! `workspace` to session tokens instead was rejected: that server lists every
//! cluster, which the token's cluster pin would not narrow.
//!
//! The note rules are `godot::notes`'; this holds the arguments, which cluster
//! a call is about, and the refusal to write on a read-only environment (none
//! is, main included).

use super::workspace::{active_cluster, page_contexts};
use crate::apps::CallContext;
use crate::environments::Environment;
use crate::godot::notes;
use crate::mcp::{McpTool, ToolAnswer};
use crate::shell_state::{ShellSnapshot, ShellState};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

pub const TOOLS: [McpTool; 3] = [
    McpTool {
        name: "list_play_notes",
        description: "The playtest notes the person sent you from Play: each note's id, \
                      cluster, status, take, time, scene and object, and its packet.md, which \
                      holds the marked-up frame, a contact sheet of the motion and the scene \
                      data. Open ones unless you ask. Read packet.md before you start.",
        schema: list_schema,
    },
    McpTool {
        name: "start_play_note",
        description: "Say you have started on a play note, so the person sees Agent working on \
                      it. Takes the note's id and cluster from list_play_notes or packet.md.",
        schema: id_schema,
    },
    McpTool {
        name: "resolve_play_note",
        description: "Report a play note fixed: what you changed, and the commit. The note \
                      shows Completed; the person plays again and resolves it or sends it \
                      back as still broken. It does not close the note itself.",
        schema: resolve_schema,
    },
];

/// Whether `tool` is one of these.
pub fn serves(tool: &str) -> bool {
    TOOLS.iter().any(|t| t.name == tool)
}

/// MCP's `readOnlyHint` for these, `None` for any other tool.
pub fn read_only(tool: &str) -> Option<bool> {
    match tool {
        "list_play_notes" => Some(true),
        "start_play_note" | "resolve_play_note" => Some(false),
        _ => None,
    }
}

fn cluster_prop() -> Value {
    json!({
        "type": "string",
        "description": "The cluster the note was sent from, as packet.md and list_play_notes \
                        name it. Omit it for the one the person is working in.",
    })
}

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "status": {
                "type": "string", "enum": ["open", "fixed", "all"],
                "description": "open (the default) is open or being worked on; fixed waits for the person.",
            },
            "cluster": cluster_prop(),
        },
        "additionalProperties": false,
    })
}

fn id_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "From list_play_notes." },
            "cluster": cluster_prop(),
        },
        "required": ["id"],
        "additionalProperties": false,
    })
}

fn resolve_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "From list_play_notes." },
            "summary": { "type": "string", "description": "What you changed, in a sentence or two." },
            "commit": { "type": "string", "description": "The commit the fix is in." },
            "cluster": cluster_prop(),
        },
        "required": ["id", "summary"],
        "additionalProperties": false,
    })
}

fn bad(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message.into())
}

/// A string argument, refused when present and not a string.
fn arg<'a>(params: &'a Option<Value>, key: &str) -> Result<Option<&'a str>, RpcError> {
    match params.as_ref().and_then(|p| p.get(key)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(bad(format!("`{key}` is a string"))),
    }
}

fn required<'a>(params: &'a Option<Value>, key: &str) -> Result<&'a str, RpcError> {
    arg(params, key)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| bad(format!("`{key}` is required")))
}

/// Answer `tool` from the live app.
pub fn call(app: &AppHandle, tool: &str, params: &Option<Value>) -> Result<ToolAnswer, RpcError> {
    let ctx = note_context(app, params)?;
    let guard = |cluster: &str| {
        crate::environments::guard_cluster_write(app, cluster, "play notes")
            .map_err(|e| e.to_string())
    };
    run(&ctx, tool, params, &guard).map(Into::into)
}

/// The tool itself, apart from the app. `guard` refuses a write to a
/// read-only environment and runs before either write: starting a note
/// rewrites its comment file as much as resolving one does.
pub fn run(
    ctx: &CallContext,
    tool: &str,
    params: &Option<Value>,
    guard: &dyn Fn(&str) -> Result<(), String>,
) -> Result<Value, RpcError> {
    let answer = |r: Result<Value, String>| r.map_err(bad);
    if tool != "list_play_notes" {
        if let Some(cluster) = ctx.cluster_id.as_deref() {
            guard(cluster).map_err(bad)?;
        }
    }
    match tool {
        "list_play_notes" => {
            let wanted = notes::Wanted::parse(arg(params, "status")?).map_err(bad)?;
            answer(notes::list(ctx, wanted))
        }
        "start_play_note" => answer(notes::start(ctx, required(params, "id")?)),
        "resolve_play_note" => answer(notes::resolve(
            ctx,
            required(params, "id")?,
            required(params, "summary")?,
            arg(params, "commit")?,
        )),
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no play-note tool named `{other}`"),
        )),
    }
}

/// The cluster a call is about: the one named, else the one the person is
/// in. For a call about one note, when the person's cluster has no such note,
/// the cluster that does: the person often moves on while an agent works,
/// and an agent in a terminal has no other way to learn its cluster.
fn note_context(app: &AppHandle, params: &Option<Value>) -> Result<CallContext, RpcError> {
    if let Some(named) = arg(params, "cluster")?.filter(|c| !c.is_empty()) {
        return Ok(CallContext::resolve(app, None, Some(named)));
    }
    let snapshot = app.state::<ShellState>().snapshot();
    let active = active_cluster(&snapshot, &page_contexts(app)).map(|(_, c)| c);
    let cluster = match arg(params, "id")? {
        Some(id) => {
            let has = |cluster: &str| {
                let ctx = CallContext::resolve(app, None, Some(cluster));
                crate::comments::get(&ctx, id).is_ok()
            };
            cluster_for_note(active.as_deref(), &clusters(&snapshot), &has)
        }
        None => active,
    };
    let cluster = cluster.ok_or_else(|| {
        RpcError::new(
            INTERNAL_ERROR,
            "there is no cluster to answer from; name one with `cluster`",
        )
    })?;
    Ok(CallContext::resolve(app, None, Some(&cluster)))
}

/// Every cluster, and whether it is the main checkout, whose copy of a note
/// is the one merged in with its branch rather than the one being worked on.
fn clusters(snapshot: &ShellSnapshot) -> Vec<(String, bool)> {
    snapshot
        .windows
        .iter()
        .flat_map(|w| &w.clusters)
        .map(|c| {
            let main = c.environment.as_ref().is_some_and(Environment::is_main);
            (c.id.clone(), main)
        })
        .collect()
}

/// The person's cluster when it holds the note; else the first that does,
/// a writable one before main, which can hold a copy merged with its branch;
/// else the person's, whose answer then says the note is not there.
pub fn cluster_for_note(
    active: Option<&str>,
    clusters: &[(String, bool)],
    has: &dyn Fn(&str) -> bool,
) -> Option<String> {
    if let Some(active) = active.filter(|a| has(a)) {
        return Some(active.to_string());
    }
    let holding: Vec<&(String, bool)> = clusters
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != active && has(id))
        .collect();
    holding
        .iter()
        .find(|(_, main)| !main)
        .or_else(|| holding.first())
        .map(|(id, _)| id.clone())
        .or_else(|| active.map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::{self, Anchor, Draft};
    use tempfile::TempDir;

    fn note(ctx: &CallContext) -> String {
        comments::create(
            ctx,
            Draft {
                anchor: Anchor::Take {
                    take: "2026-10-30-1402-0f3a".into(),
                    number: None,
                    n: 1,
                    at_ms: 1_000,
                    in_ms: None,
                    out_ms: None,
                    packet: ".veistra/feedback/2026-10-30-1402-0f3a-1".into(),
                    scene: None,
                    node_path: None,
                },
                body: "the door flickers".into(),
                screenshot_png: None,
            },
        )
        .unwrap()
        .id
    }

    fn ctx(dir: &TempDir) -> CallContext {
        CallContext {
            cluster_id: Some("cluster-2".into()),
            project: Some(dir.path().to_path_buf()),
        }
    }

    /// The guard's refusal, injected: no environment refuses today (main
    /// used to), but when the guard says no, neither write lands.
    #[test]
    fn neither_write_gets_past_a_refusing_guard_and_listing_still_does() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let id = note(&ctx);
        let file = std::fs::read_dir(dir.path().join(".veistra/comments"))
            .unwrap()
            .flatten()
            .next()
            .unwrap()
            .path();
        let before = std::fs::read_to_string(&file).unwrap();
        let refuse = |_: &str| Err("this environment is read-only".to_string());
        let id_only = Some(json!({ "id": id }));
        let err = run(&ctx, "start_play_note", &id_only, &refuse).unwrap_err();
        assert!(err.message.contains("read-only"), "{}", err.message);
        let resolve = Some(json!({ "id": id, "summary": "fixed" }));
        assert!(run(&ctx, "resolve_play_note", &resolve, &refuse).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before, "untouched");
        let listed = run(&ctx, "list_play_notes", &None, &refuse).unwrap();
        assert_eq!(listed["total"], 1);
        assert_eq!(listed["notes"][0]["cluster"], "cluster-2");
    }

    #[test]
    fn the_loop_runs_through_the_shared_tools() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        let id = note(&ctx);
        let fine = |_: &str| Ok(());
        let id_only = Some(json!({ "id": id }));
        assert_eq!(
            run(&ctx, "start_play_note", &id_only, &fine).unwrap()["status"],
            "working"
        );
        let resolve =
            Some(json!({ "id": id, "summary": "Rebaked the light", "commit": "3f2a1c9" }));
        assert_eq!(
            run(&ctx, "resolve_play_note", &resolve, &fine).unwrap()["status"],
            "fixed"
        );
        assert!(
            run(&ctx, "resolve_play_note", &id_only, &fine).is_err(),
            "no summary"
        );
        assert_eq!(
            run(&ctx, "nope", &None, &fine).unwrap_err().code,
            METHOD_NOT_FOUND
        );
    }

    #[test]
    fn a_note_is_found_in_the_cluster_that_holds_it_writable_first() {
        let all = [
            ("c1".to_string(), false),
            ("main".to_string(), true),
            ("c3".to_string(), false),
        ];
        let in_ = |held: &'static [&'static str]| move |c: &str| held.contains(&c);
        assert_eq!(
            cluster_for_note(Some("c1"), &all, &in_(&["c1", "c3"])).as_deref(),
            Some("c1"),
            "the person's own cluster first"
        );
        assert_eq!(
            cluster_for_note(Some("c1"), &all, &in_(&["main", "c3"])).as_deref(),
            Some("c3"),
            "a worktree before main"
        );
        assert_eq!(
            cluster_for_note(Some("c1"), &all, &in_(&["main"])).as_deref(),
            Some("main")
        );
        assert_eq!(
            cluster_for_note(Some("c1"), &all, &in_(&[])).as_deref(),
            Some("c1"),
            "nowhere: the person's cluster says so"
        );
        assert_eq!(cluster_for_note(None, &all, &in_(&[])), None);
    }

    #[test]
    fn the_tools_are_advertised_as_they_behave() {
        for tool in &TOOLS {
            assert!(serves(tool.name));
            let writes = tool.name != "list_play_notes";
            assert_eq!(read_only(tool.name), Some(!writes), "{}", tool.name);
            let schema = (tool.schema)();
            assert_eq!(schema["additionalProperties"], false);
            assert!(schema["properties"]["cluster"].is_object());
        }
        assert!(!serves("focus"));
    }
}
