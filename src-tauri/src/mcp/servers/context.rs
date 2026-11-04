//! `veistra-context`: references, both ways. The agent finds, reads and shows
//! the person files, canvas frames, comments, screenshots and assets by
//! `veistra://` reference (`docs/design/VEISTRA-CONTEXT-REFS.md`), and reads what
//! the person has selected.
//!
//! What earns it a server (see [`super`]): most of what a reference names
//! exists only inside Veistra, such as a frame, a Design Mode comment or the
//! selection, and `show` puts a reference in front of the person, which no
//! file tool does. File references are here so one scheme covers everything;
//! plain files are still better read with the agent's own tools.
//!
//! Every call answers from one cluster: the one named in `cluster`, else the
//! one the person is working in. The play-note tools are here as well as on
//! `workspace` ([`super::play_notes`] says why).

use super::{workspace, McpResource};
use crate::apps::CallContext;
use crate::mcp::{McpServer, McpTool, ToolAnswer};
use crate::refs::catalogue::{self, Component, VeistraShow};
use crate::refs::comments::{self, Wanted};
use crate::refs::fault::{Fault, Reason};
use crate::refs::live::{self, Actor};
use crate::refs::read::blocks;
use crate::refs::search::{self, Query};
use crate::refs::uri::{self, CanvasPart, Ref};
use crate::shell_state::ShellState;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The server id: the route `/mcp/context` and the key `veistra-context`.
pub const ID: &str = "context";

/// Longest note `resolve_comment` writes, in characters: a sentence or two
/// for the person, well under what a comment record may hold.
const MAX_NOTE: usize = 4_000;

pub static SERVER: McpServer = McpServer {
    id: ID,
    name: "Context",
    description: "References, both ways: find, read and show the person files, canvas frames, \
                  comments, screenshots and assets by veistra:// reference, and read what they \
                  have selected.",
    tools: TOOLS,
    call,
    dev_only: false,
};

/// An object schema with these properties, plus the `cluster` every tool takes.
fn schema(mut props: Value, required: &[&str]) -> Value {
    props["cluster"] = json!({
        "type": "string",
        "description": "The cluster to answer from. Omit it for the one the person is working in.",
    });
    json!({ "type": "object", "properties": props, "required": required })
}

fn show_schema() -> Value {
    schema(
        json!({
            "refs": {
                "type": "array", "minItems": 1, "maxItems": catalogue::MAX_SHOWN,
                "items": { "type": "string" },
                "description": "veistra:// references, shown in this order.",
            },
            "caption": { "type": "string", "description": "One line above them." },
        }),
        &["refs"],
    )
}

fn show_component_schema() -> Value {
    schema(
        json!({
            "component": { "type": "string", "enum": catalogue::NAMES },
            "props": {
                "type": "object",
                "description": "The component's props, as the tool's description lists them.",
            },
        }),
        &["component", "props"],
    )
}

fn read_schema() -> Value {
    schema(
        json!({ "uri": { "type": "string", "description": "A veistra:// reference." } }),
        &["uri"],
    )
}

fn search_schema() -> Value {
    schema(
        json!({
            "query": {
                "type": "string",
                "description": "Words in the name. Empty lists everything but files and frames.",
            },
            "kinds": {
                "type": "array",
                "items": { "type": "string", "enum": search::KINDS },
                "description": "Only these kinds. Omit for all of them.",
            },
            "limit": { "type": "integer", "minimum": 1, "maximum": search::MAX_LIMIT },
        }),
        &[],
    )
}

fn comments_schema() -> Value {
    schema(
        json!({
            "status": {
                "type": "string", "enum": ["open", "resolved", "all"],
                "description": "Which comments. Open ones unless you say.",
            },
            "sources": {
                "type": "array",
                "items": { "type": "string", "enum": comments::SOURCES },
                "description": "Only comments left here. Omit for all of them.",
            },
        }),
        &[],
    )
}

fn resolve_schema() -> Value {
    schema(
        json!({
            "uri": { "type": "string", "description": "The comment's veistra:// reference." },
            "note": { "type": "string", "description": "What you did about it, for the person." },
        }),
        &["uri", "note"],
    )
}

fn selection_schema() -> Value {
    schema(json!({}), &[])
}

fn node_schema() -> Value {
    schema(
        json!({
            "canvas": { "type": "string", "description": "The canvas id, e.g. levels/hospital." },
            "node": { "type": "string", "description": "The frame's element id or exact name." },
        }),
        &["canvas", "node"],
    )
}

const TOOLS: &[McpTool] = &[
    McpTool {
        name: "show",
        description: "Show the person one to eight references inline, beside your reply: a file \
                      or lines of it, an image or model, a canvas frame, a comment and its \
                      screenshot. Use it when seeing the thing helps more than describing it. \
                      References look like veistra://file/src/main.gd#L10-L20.",
        schema: show_schema,
    },
    McpTool {
        name: "show_component",
        description: "Show the person a component beside your reply, when a structured view says \
                      it better than prose. `body` and `detail` are markdown; refs are veistra:// \
                      references, drawn as chips. `?` marks an optional prop.\n\
                      - callout {tone: note|tip|warning|danger, title?, body, refs?: up to 8}\n\
                      - steps {title?, steps: [{title, body?, status?: \
                      todo|doing|done|skipped, refs?: up to 4}] 1-20}\n\
                      - table {caption?, columns: [{label, align?: left|right|center, \
                      mono?}] 1-12, \
                      rows: [[string|number|boolean|null, one per column]] 1-200}\n\
                      - compare {title?, items: [{title, body?, pros?: up to 8, \
                      cons?: up to 8, refs?: up to 4}] 2-4, recommended?: an item's index}\n\
                      - diagram {format: \"mermaid\", source, title?}\n\
                      - chart {type: bar|line|area, title?, xLabels: 1-100, \
                      series: [{name, values: one per x label}] 1-8, yLabel?, unit?: up to \
                      16 characters, stacked?}\n\
                      - choice {question, options: [{id, label, detail?}] 2-8, multiple?}: the \
                      person's pick comes back as their next message, \"Chose: <label> (<id>)\", \
                      several joined by \"; \"\n\
                      - refs {refs: 1-8, caption?}: the same as `show`\n\
                      A title or label is at most 200 characters, a body 4,000, and the props \
                      64 KB of JSON.",
        schema: show_component_schema,
    },
    McpTool {
        name: "read",
        description: "Read a veistra:// reference: a file's lines, an image, a model's facts, a \
                      canvas's frames, a frame's properties and picture, a comment and its \
                      screenshot. Secrets and gitignored files are withheld and say why.",
        schema: read_schema,
    },
    McpTool {
        name: "search_context",
        description: "Find things in the person's project by name: files and folders, canvases \
                      and frames, viewer and Design Mode comments, context items and the \
                      selection. Each hit is a veistra:// reference to `read` or `show`. Names, \
                      not file contents: search inside files with your own tools. A comment is \
                      found by what it says.",
        schema: search_schema,
    },
    McpTool {
        name: "list_comments",
        description: "The comments the person left for you in the 3D and scene viewers, on \
                      canvases and in Design Mode, open ones unless you ask. Each has a \
                      veistra:// reference: `read` it for the whole comment and its screenshot.",
        schema: comments_schema,
    },
    McpTool {
        name: "resolve_comment",
        description: "Close a comment with a note saying what you did, once the work is done. \
                      Takes the comment's veistra:// reference from `list_comments`.",
        schema: resolve_schema,
    },
    McpTool {
        name: "get_selection",
        description: "What the person has selected right now: selected text, the frame or node \
                      each open app reports, and references to them. Call it when they say \
                      \"this\" or \"here\".",
        schema: selection_schema,
    },
    McpTool {
        name: "get_canvas_node",
        description: "One frame of a canvas by id or exact name: its type, properties, text and \
                      picture. The same as reading veistra://canvas/<canvas>#frame=<node>.",
        schema: node_schema,
    },
    // An agent tab's session reaches this server and not `workspace`, and
    // Send may hand it the notes; see `play_notes`.
    super::play_notes::TOOLS[0],
    super::play_notes::TOOLS[1],
    super::play_notes::TOOLS[2],
    // An agent exports what the person may have open in Blender (#317).
    super::blender_exports::TOOLS[0],
    super::blender_exports::TOOLS[1],
];

/// The selection, published so a client can subscribe to it.
pub const SELECTION_URI: &str = "veistra://selection";

pub static RESOURCES: &[McpResource] = &[McpResource {
    uri: SELECTION_URI,
    name: "selection",
    description: "What the person has selected in the cluster they are working in. \
                  Subscribe to hear when their focus moves; a selection made without moving \
                  focus is not announced, so read it again before acting on it.",
    mime_type: "text/plain",
}];

/// Every other reference reads as a resource too; these say how to write one.
pub static TEMPLATES: &[McpResource] = &[
    template(
        "veistra://file/{+path}",
        "file",
        "A file or folder in the project. Add #L10-L20 for some lines.",
    ),
    template(
        "veistra://canvas/{+id}",
        "canvas",
        "A canvas and its frames. Add #frame=<id> for one frame, #comment=<id> for a comment.",
    ),
    template(
        "veistra://comment/{id}",
        "comment",
        "A comment left in a viewer, with its screenshot.",
    ),
    template(
        "veistra://design-comment/{id}",
        "design-comment",
        "A Design Mode comment, with its screenshot.",
    ),
    template(
        "veistra://context/{id}",
        "context",
        "An item in the context store.",
    ),
];

const fn template(uri: &'static str, name: &'static str, about: &'static str) -> McpResource {
    McpResource {
        uri,
        name,
        description: about,
        mime_type: "",
    }
}

/// Read any reference as a resource, from `cluster` or the one in use.
pub fn read_resource(
    app: &AppHandle,
    uri: &str,
    cluster: Option<&str>,
) -> Result<ToolAnswer, RpcError> {
    let r = parse(uri)?;
    read(app, &context_for(app, cluster)?, &r)
}

/// Whether a tool leaves the person's work alone, for MCP's `readOnlyHint`.
pub fn read_only(tool: &str) -> Option<bool> {
    match tool {
        "read" | "search_context" | "list_comments" | "get_selection" | "get_canvas_node" => {
            Some(true)
        }
        "resolve_comment" => Some(false),
        // `show` changes nothing on disk, but it puts something in front of
        // the person, which is not what a client means by read-only.
        "show" | "show_component" => Some(false),
        _ => None,
    }
}

fn bad(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message.into())
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, RpcError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| bad(format!("`{key}` is required")))
}

/// An optional string, refused when it is there and is not one.
fn maybe_text<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, RpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(bad(format!("`{key}` is a string"))),
    }
}

/// An optional count, refused when it is there and is not one.
fn maybe_count(args: &Map<String, Value>, key: &str) -> Result<Option<usize>, RpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .map(|n| Some(usize::try_from(n).unwrap_or(usize::MAX)))
            .ok_or_else(|| bad(format!("`{key}` is a whole number"))),
    }
}

/// The note `resolve_comment` writes, trimmed and held under [`MAX_NOTE`].
fn note(args: &Map<String, Value>) -> Result<&str, RpcError> {
    let note = text(args, "note")?.trim();
    if note.chars().count() > MAX_NOTE {
        return Err(bad(format!(
            "a note is at most {MAX_NOTE} characters; say what you did in a sentence or two"
        )));
    }
    Ok(note)
}

/// An optional list of strings.
fn strings(args: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, RpcError> {
    let not_a_list = || bad(format!("`{key}` is a list of strings"));
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(list)) => list
            .iter()
            .map(|k| k.as_str().map(String::from))
            .collect::<Option<Vec<_>>>()
            .map(Some)
            .ok_or_else(not_a_list),
        Some(_) => Err(not_a_list()),
    }
}

fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    if super::play_notes::serves(tool) {
        return super::play_notes::call(app, tool, &params);
    }
    if super::blender_exports::serves(tool) {
        return super::blender_exports::call(app, tool, &params);
    }
    let args = match params {
        Some(Value::Object(map)) => map,
        None | Some(Value::Null) => Map::new(),
        Some(_) => return Err(bad("arguments must be an object")),
    };
    let ctx = context_for(app, args.get("cluster").and_then(Value::as_str))?;
    match tool {
        "show" => show(app, &ctx, &args),
        "show_component" => {
            let props = args
                .get("props")
                .ok_or_else(|| bad("`props` is required"))?;
            let shown = Component::parse(text(&args, "component")?, props).map_err(bad)?;
            present(app, &ctx, shown)
        }
        "read" => read(app, &ctx, &parse(text(&args, "uri")?)?),
        "search_context" => find(app, &ctx, &args),
        "list_comments" => {
            let wanted = Wanted::parse(maybe_text(&args, "status")?).map_err(bad)?;
            let sources = strings(&args, "sources")?;
            let known = |s: &&String| comments::SOURCES.contains(&s.as_str());
            if let Some(stray) = sources.iter().flatten().find(|s| !known(s)) {
                let all = comments::SOURCES.join(", ");
                return Err(bad(format!("`{stray}` is not a source; use {all}")));
            }
            Ok(comments::list(app, &ctx, wanted, sources.as_deref()).into())
        }
        "resolve_comment" => {
            let (r, note) = (parse(text(&args, "uri")?)?, note(&args)?);
            let done = comments::resolve(app, &ctx, &r, note).map_err(bad)?;
            Ok(done.into())
        }
        "get_selection" => read(app, &ctx, &Ref::Selection),
        "get_canvas_node" => {
            let r = Ref::Canvas {
                id: text(&args, "canvas")?.to_string(),
                part: Some(CanvasPart::Frame(text(&args, "node")?.to_string())),
            };
            // Round-tripped so a canvas id is held to the scheme's rules.
            read(app, &ctx, &parse(&r.to_string())?)
        }
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("the context server has no tool named `{other}`"),
        )),
    }
}

fn parse(raw: &str) -> Result<Ref, RpcError> {
    uri::parse(raw).map_err(bad)
}

/// The cluster a call answers from: the one named, else the one the person
/// is working in.
fn context_for(app: &AppHandle, cluster: Option<&str>) -> Result<CallContext, RpcError> {
    if let Some(cluster) = cluster.filter(|c| !c.is_empty()) {
        return Ok(CallContext::resolve(app, None, Some(cluster)));
    }
    let snapshot = app.state::<ShellState>().snapshot();
    let pages = workspace::page_contexts(app);
    let (_, cluster) = workspace::active_cluster(&snapshot, &pages).ok_or_else(|| {
        RpcError::new(
            INTERNAL_ERROR,
            "there is no cluster to answer from; name one with `cluster`",
        )
    })?;
    Ok(CallContext::resolve(app, None, Some(&cluster)))
}

fn read(app: &AppHandle, ctx: &CallContext, r: &Ref) -> Result<ToolAnswer, RpcError> {
    let resolved = live::resolve(app, ctx, Actor::Agent, r).map_err(bad)?;
    Ok(ToolAnswer::Blocks(blocks(&resolved)))
}

fn find(
    app: &AppHandle,
    ctx: &CallContext,
    args: &Map<String, Value>,
) -> Result<ToolAnswer, RpcError> {
    if ctx.project.is_none() {
        return Err(bad(
            "this cluster has no project open, so there is nothing to find",
        ));
    }
    let words = maybe_text(args, "query")?.unwrap_or("");
    let kinds = strings(args, "kinds")?;
    let limit = maybe_count(args, "limit")?;
    let q = Query::new(words, kinds, limit).map_err(bad)?;
    let hits = search::run(app, ctx, Actor::Agent, &q);
    Ok(json!({ "query": words, "hits": hits }).into())
}

/// `show` is the `refs` component, with its props as the tool's own arguments.
fn show(
    app: &AppHandle,
    ctx: &CallContext,
    args: &Map<String, Value>,
) -> Result<ToolAnswer, RpcError> {
    let refs = strings(args, "refs")?
        .filter(|refs| !refs.is_empty())
        .ok_or_else(|| bad("`refs` needs at least one veistra:// reference"))?;
    let props = json!({ "refs": refs, "caption": args.get("caption") });
    present(app, ctx, Component::parse("refs", &props).map_err(bad)?)
}

/// Check every reference in the props, then answer with the marker the agent
/// tab draws from (see [`show_answer`]).
fn present(
    app: &AppHandle,
    ctx: &CallContext,
    mut shown: Component,
) -> Result<ToolAnswer, RpcError> {
    let mut failed = Vec::new();
    for list in shown.refs_mut() {
        list.retain_mut(|given| match checked(app, ctx, given) {
            Ok(r) => {
                *given = r.to_string();
                true
            }
            Err(why) => {
                failed.push(why);
                false
            }
        });
    }
    shown.check_size().map_err(bad)?;
    show_answer(shown, failed).map(ToolAnswer::Json)
}

/// A reference that parses and can be shown, in its canonical form; else the
/// reference as given and why not.
fn checked(app: &AppHandle, ctx: &CallContext, given: &str) -> Result<Ref, (String, Fault)> {
    let r =
        uri::parse(given).map_err(|why| (given.to_string(), Fault::new(Reason::BadUri, why)))?;
    live::check(app, ctx, &r).map_err(|why| (r.to_string(), why))?;
    Ok(r)
}

/// The answer: `{veistraShow: {version, component, props}}`, which the agent
/// host lifts off this server's tool result for the tab to draw, and the
/// references dropped from the props, each with its reason word and why.
/// A `refs` component left with none is refused; any other is still shown.
fn show_answer(shown: Component, failed: Vec<(String, Fault)>) -> Result<Value, RpcError> {
    if matches!(&shown, Component::Refs(p) if p.refs.is_empty()) {
        let reasons: Vec<String> = failed
            .iter()
            .map(|(uri, why)| format!("{uri}: {why}"))
            .collect();
        return Err(bad(format!("nothing to show. {}", reasons.join("; "))));
    }
    let marker = VeistraShow {
        version: catalogue::VERSION,
        shown,
    };
    let mut answer = json!({ "veistraShow": marker });
    if !failed.is_empty() {
        let failed: Vec<Value> = failed
            .iter()
            .map(|(uri, why)| json!({ "uri": uri, "reason": why.reason, "message": why.message }))
            .collect();
        answer["failed"] = json!(failed);
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::catalogue::RefsProps;

    /// A `refs` component holding what survived its check.
    fn refs(shown: &[&str], caption: Option<&str>) -> Component {
        Component::Refs(RefsProps {
            refs: shown.iter().map(|r| r.to_string()).collect(),
            caption: caption.map(String::from),
        })
    }

    fn missing() -> Vec<(String, Fault)> {
        let why = Fault::new(Reason::Missing, "no such file");
        vec![("veistra://file/gone.gd".to_string(), why)]
    }

    #[test]
    fn show_answers_with_the_marker_the_tab_draws_from() {
        let shown = refs(
            &["veistra://file/a.gd", "veistra://selection"],
            Some("Here"),
        );
        let answer = show_answer(shown, Vec::new()).unwrap();
        assert_eq!(
            answer,
            json!({ "veistraShow": {
                "component": "refs",
                "version": 1,
                "props": { "refs": ["veistra://file/a.gd", "veistra://selection"], "caption": "Here" },
            }})
        );
    }

    #[test]
    fn show_draws_what_it_can_and_names_what_it_cannot() {
        let answer = show_answer(refs(&["veistra://file/a.gd"], None), missing()).unwrap();
        assert_eq!(
            answer["veistraShow"]["props"]["refs"],
            json!(["veistra://file/a.gd"])
        );
        assert!(answer["veistraShow"]["props"].get("caption").is_none());
        assert_eq!(answer["failed"][0]["reason"], "missing");
        assert_eq!(answer["failed"][0]["message"], "no such file");
        let none = show_answer(refs(&[], None), missing()).unwrap_err();
        assert!(
            none.message.contains("gone.gd: no such file"),
            "{}",
            none.message
        );
    }

    #[test]
    fn any_other_component_is_shown_without_the_references_that_failed() {
        let props = json!({ "tone": "warning", "body": "Check these.", "refs": [] });
        let shown = Component::parse("callout", &props).unwrap();
        let answer = show_answer(shown, missing()).unwrap();
        assert_eq!(answer["veistraShow"]["component"], "callout");
        assert_eq!(answer["veistraShow"]["props"]["refs"], json!([]));
        assert_eq!(answer["failed"][0]["uri"], "veistra://file/gone.gd");
    }

    #[test]
    fn show_component_lists_every_component_it_draws() {
        let tool = TOOLS.iter().find(|t| t.name == "show_component").unwrap();
        for name in catalogue::NAMES {
            assert!(tool.description.contains(&format!("- {name} {{")), "{name}");
        }
        assert_eq!(
            (tool.schema)()["properties"]["component"]["enum"],
            json!(catalogue::NAMES)
        );
    }

    #[test]
    fn an_agent_tab_s_session_can_work_through_its_play_notes() {
        // A session token opens this server and no other that has them.
        assert!(crate::mcp::session::SERVER_IDS.contains(&ID));
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        for tool in ["list_play_notes", "start_play_note", "resolve_play_note"] {
            assert!(names.contains(&tool), "{tool}");
            assert_eq!(
                super::super::read_only_hint(ID, tool),
                Some(tool == "list_play_notes"),
                "{tool}"
            );
        }
    }

    #[test]
    fn an_agent_tab_s_session_can_export_a_blend_without_touching_it() {
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        for tool in ["export_blend", "list_blend_exports"] {
            assert!(names.contains(&tool), "{tool}");
            assert_eq!(
                super::super::read_only_hint(ID, tool),
                Some(tool == "list_blend_exports"),
                "{tool}"
            );
        }
    }

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn an_argument_of_the_wrong_type_is_refused_not_replaced() {
        let given = args(json!({ "query": 7, "limit": "ten", "status": null, "n": 3 }));
        assert!(maybe_text(&given, "query").is_err());
        assert!(maybe_count(&given, "limit").is_err());
        assert_eq!(maybe_text(&given, "status").unwrap(), None);
        assert_eq!(maybe_text(&given, "absent").unwrap(), None);
        assert_eq!(maybe_count(&given, "n").unwrap(), Some(3));
        assert!(maybe_count(&args(json!({ "n": -1 })), "n").is_err());
    }

    #[test]
    fn a_note_is_trimmed_and_held_under_the_cap() {
        assert_eq!(note(&args(json!({ "note": "  done \n" }))).unwrap(), "done");
        let longest = "é".repeat(MAX_NOTE);
        assert!(
            note(&args(json!({ "note": longest }))).is_ok(),
            "counted in characters"
        );
        let over = "x".repeat(MAX_NOTE + 1);
        let err = note(&args(json!({ "note": over }))).unwrap_err();
        assert_eq!(err.code, veistra_rpc::INVALID_PARAMS);
        assert!(note(&args(json!({ "note": "   " }))).is_err());
    }
}
