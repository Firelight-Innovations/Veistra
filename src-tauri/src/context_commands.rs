//! The shell's side of the context store: what happens when something is
//! dropped on, pasted into, or re-sent to a terminal.
//!
//! `context.rs` is the store and knows nothing of terminals; `harness.rs`
//! knows how to write a reference and nothing of files. This is the seam that
//! joins them, and the only place that both resolves a terminal's environment
//! and writes to its pty.

use crate::agent_saw;
use crate::context::{self, ContextItem, Kind, Method, Payload, PutRequest};
use crate::error::{AppError, Result};
use crate::harness::{self, Harness};
use crate::project;
use crate::pty::PtySessions;
use crate::shell_state::{ShellSnapshot, ShellState, SurfaceInstance};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// The id every terminal-originated item is stamped with as its source app.
const TERMINAL_APP_ID: &str = "terminal";

/// What an insertion did, so the frontend can report it without guessing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inserted {
    /// Exactly what was written at the prompt. Empty when nothing was.
    pub text: String,
    /// How many references `text` holds. Counted here because a quoted path can
    /// contain a space, so the frontend cannot count words.
    pub count: usize,
    pub harness: Harness,
    /// Items registered by this insertion, for the strip to show at once.
    pub items: Vec<ContextItem>,
    /// One sentence per path that was refused, for the user to read.
    pub refused: Vec<String>,
}

/// Which harness a terminal is aimed at, for the strip's label and override.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    pub effective: Harness,
    pub detected: Option<Harness>,
    pub overridden: Option<Harness>,
}

fn pty_err(id: &str, reason: impl Into<String>) -> AppError {
    AppError::Pty {
        id: id.to_string(),
        reason: reason.into(),
    }
}

/// The environment root a terminal's context lives in.
fn root_of(app: &AppHandle, id: &str) -> Result<PathBuf> {
    let shell = app.state::<ShellState>();
    let cluster = shell
        .cluster_of_terminal(id)
        .ok_or_else(|| pty_err(id, "no such terminal"))?;
    project::cluster_path(app, &cluster).ok_or_else(|| {
        pty_err(
            id,
            "this terminal's cluster has no environment to keep context in",
        )
    })
}

/// Pure core of a drop, split out so it is tested without a pty: which paths
/// end up in the reference, which items were registered, what was refused.
///
/// A plain shell is left alone entirely — a path dropped for `git add` must
/// stay the path the user meant. Only a coding harness gets files copied into
/// the store, because only there does "the agent's sandbox can read it" matter.
pub fn ingest_drop(
    root: Option<&Path>,
    harness: Harness,
    paths: &[String],
) -> (Vec<String>, Vec<ContextItem>, Vec<String>) {
    let mut out = Vec::new();
    let mut items = Vec::new();
    let mut refused = Vec::new();

    for raw in paths {
        let path = PathBuf::from(raw);
        let Some(root) = root.filter(|_| harness.is_agent() && path.is_file()) else {
            out.push(raw.clone());
            continue;
        };
        // Already in the store (a chip dragged out again): reference it, do not
        // register a second record for the same file.
        if context::inside(&context::store_dir(root), &path) {
            out.push(raw.clone());
            continue;
        }
        let too_big = !context::inside(root, &path)
            && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > context::MAX_FILE_BYTES;
        if too_big {
            // Not copied, but still useful to the agent by its own path.
            out.push(raw.clone());
            continue;
        }
        let title = path.file_name().map(|n| n.to_string_lossy().into_owned());
        match context::put(
            root,
            PutRequest {
                key: None,
                kind: None,
                title,
                payload: Payload::Path(path.clone()),
                app_id: TERMINAL_APP_ID.into(),
                label: None,
                method: Method::Drop,
                reference_in_place: true,
            },
        ) {
            Ok(item) => {
                out.push(item.path.clone());
                items.push(item);
            }
            Err(e) => refused.push(format!(
                "{}: {}",
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                e.message
            )),
        }
    }
    (out, items, refused)
}

/// Words typed on either side of a reference, so one line can be a sentence
/// ("Playtest feedback: 2 notes. Read `@…/packet.md` first.") rather than a
/// bare path. Empty for every insertion but an app's `context/insert`.
#[derive(Debug, Default)]
struct Around {
    before: String,
    after: String,
}

/// The line typed at the prompt: `before`, the reference, `after`. Control
/// characters are dropped from the words around it, so no sentence an app
/// sends can carry an Enter, and the space a harness leaves after its last
/// reference is dropped when words follow it. No reference, no line: words
/// with nothing to point at would read as a message about nothing.
pub fn compose(before: &str, reference: &str, after: &str) -> String {
    if reference.is_empty() {
        return String::new();
    }
    let clean = |s: &str| s.chars().filter(|c| !c.is_control()).collect::<String>();
    let reference = if after.is_empty() {
        reference
    } else {
        reference.trim_end()
    };
    format!("{}{reference}{}", clean(before), clean(after))
}

fn insert(
    ptys: &PtySessions,
    id: &str,
    target: &crate::pty::Target,
    paths: &[String],
    items: Vec<ContextItem>,
    refused: Vec<String>,
    around: &Around,
) -> Inserted {
    let reference = harness::reference(target.harness, target.family, target.cwd.as_deref(), paths);
    let text = compose(&around.before, &reference, &around.after);
    if !text.is_empty() {
        // Same door as a keystroke: see `PtySessions::insert_paths`.
        ptys.write(id, &text);
    }
    let count = paths
        .iter()
        .filter(|p| !p.chars().any(char::is_control))
        .count();
    Inserted {
        text,
        count,
        harness: target.harness,
        items,
        refused,
    }
}

/// Files were dropped on a terminal, from Explorer or from a Veistra app.
#[tauri::command]
pub fn terminal_drop_paths(
    app: AppHandle,
    ptys: State<'_, PtySessions>,
    id: String,
    paths: Vec<String>,
) -> Result<Inserted> {
    let target = ptys
        .target(&id)
        .ok_or_else(|| pty_err(&id, "no such terminal session to insert into"))?;
    // No root is fine for a plain shell (there is nothing to store); a harness
    // without a root just gets its paths as dropped.
    let root = root_of(&app, &id).ok();
    let (out, items, refused) = ingest_drop(root.as_deref(), target.harness, &paths);
    if let (false, Some(root)) = (items.is_empty(), root.as_deref()) {
        context::notify(&app, root);
    }
    Ok(insert(
        &ptys,
        &id,
        &target,
        &out,
        items,
        refused,
        &Around::default(),
    ))
}

/// An image was pasted into a terminal. Stored, then referenced at the prompt.
#[tauri::command]
pub fn terminal_paste_image(
    app: AppHandle,
    ptys: State<'_, PtySessions>,
    id: String,
    bytes_base64: String,
    name: Option<String>,
) -> Result<Inserted> {
    let target = ptys
        .target(&id)
        .ok_or_else(|| pty_err(&id, "no such terminal session to insert into"))?;
    let root = root_of(&app, &id)?;
    let bytes = BASE64
        .decode(bytes_base64)
        .map_err(|e| pty_err(&id, format!("the pasted image is not valid base64: {e}")))?;
    match context::put(
        &root,
        PutRequest {
            key: None,
            kind: Some(Kind::Image),
            title: Some(name.unwrap_or_else(|| "pasted image".into())),
            payload: Payload::Bytes(bytes),
            app_id: TERMINAL_APP_ID.into(),
            label: None,
            method: Method::Clipboard,
            reference_in_place: false,
        },
    ) {
        Ok(item) => {
            context::notify(&app, &root);
            let path = item.path.clone();
            Ok(insert(
                &ptys,
                &id,
                &target,
                &[path],
                vec![item],
                Vec::new(),
                &Around::default(),
            ))
        }
        // A refused paste is a message for the user, not a crash.
        Err(e) => Ok(Inserted {
            text: String::new(),
            count: 0,
            harness: target.harness,
            items: Vec::new(),
            refused: vec![e.message],
        }),
    }
}

/// Send items already in the store to a terminal again (the strip's re-insert).
#[tauri::command]
pub fn terminal_insert_items(
    app: AppHandle,
    ptys: State<'_, PtySessions>,
    id: String,
    item_ids: Vec<String>,
) -> Result<Inserted> {
    insert_stored(&app, &ptys, &id, &item_ids, &Around::default())
}

/// The shared body of the strip's re-insert and [`insert_for_cluster`]: write
/// the reference to each stored item at the terminal's prompt. Never Enter.
fn insert_stored(
    app: &AppHandle,
    ptys: &PtySessions,
    id: &str,
    item_ids: &[String],
    around: &Around,
) -> Result<Inserted> {
    let target = ptys
        .target(id)
        .ok_or_else(|| pty_err(id, "no such terminal session to insert into"))?;
    let root = root_of(app, id)?;
    let mut paths = Vec::new();
    let mut refused = Vec::new();
    for item_id in item_ids {
        match context::get(&root, item_id) {
            Ok(item) if !item.missing => paths.push(item.path),
            Ok(item) => refused.push(format!("{}: the file is gone", item.title)),
            Err(e) => refused.push(e.message),
        }
    }
    Ok(insert(
        ptys,
        id,
        &target,
        &paths,
        Vec::new(),
        refused,
        around,
    ))
}

/// The first of `candidates` (the cluster's shown terminal leads) that is
/// running a coding agent. A plain shell is skipped on purpose: a markup
/// reference typed into `bash` would be a stray path, not a message.
pub fn pick_agent_terminal(
    candidates: &[String],
    runs_agent: impl Fn(&str) -> bool,
) -> Option<String> {
    candidates.iter().find(|id| runs_agent(id)).cloned()
}

/// The terminal `context/insert` types into: the one the caller chose, when it
/// is still an agent in this cluster, else the first agent there. A chosen
/// terminal that has gone, moved cluster or dropped back to a shell is a
/// refusal with a reason rather than a silent fall back to another agent: the
/// person picked that one, and a packet typed at a different prompt is a
/// message to someone they did not choose.
fn choose_terminal(
    candidates: &[String],
    wanted: Option<&str>,
    runs_agent: impl Fn(&str) -> bool,
) -> std::result::Result<String, &'static str> {
    match wanted {
        Some(id) if candidates.iter().any(|c| c == id) && runs_agent(id) => Ok(id.to_string()),
        Some(_) => Err("the terminal you chose is no longer running an agent in this environment"),
        None => pick_agent_terminal(candidates, runs_agent)
            .ok_or("no agent is running in this environment's terminals"),
    }
}

/// How a reference reaches an [`AgentTarget`]: typed at a terminal's prompt by
/// `context/insert`, or put on an agent tab's prompt as a chip by the shell's
/// `veistra/attach-to-agent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Terminal,
    AgentTab,
}

/// One agent a page can send to, as `context/agents` lists it, and what a
/// comment records as `sentTo` so a later message can go back to the same one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    pub kind: AgentKind,
    /// The terminal's id, or the agent tab's instance id.
    pub id: String,
    /// What a SEND TO picker shows, e.g. "Claude Code · Terminal 2".
    pub label: String,
}

fn harness_name(harness: Harness) -> &'static str {
    match harness {
        Harness::Claude => "Claude Code",
        Harness::Codex => "Codex",
        Harness::Gemini => "Gemini CLI",
        Harness::Shell => "Shell",
    }
}

/// Every agent in cluster `cluster`, the default first: its terminals running a
/// coding harness in `terminals` order (the shown one leads), then its agent
/// tabs, an on-screen one first. That order is the default X8 sets, the active
/// agent terminal and else the first agent tab, so a caller that has no choice
/// of its own takes the head of the list. Pure; `harness_of` is the pty side.
pub fn agents_in(
    snapshot: &ShellSnapshot,
    cluster: &str,
    terminals: &[String],
    harness_of: impl Fn(&str) -> Option<Harness>,
) -> Vec<AgentTarget> {
    let mut out: Vec<AgentTarget> = terminals
        .iter()
        .filter_map(|id| {
            let harness = harness_of(id).filter(|h| h.is_agent())?;
            let title = snapshot
                .terminals
                .iter()
                .find(|t| &t.id == id)
                .map_or(id.as_str(), |t| t.title.as_str());
            Some(AgentTarget {
                kind: AgentKind::Terminal,
                id: id.clone(),
                label: format!("{} · {title}", harness_name(harness)),
            })
        })
        .collect();
    let mut tabs: Vec<&SurfaceInstance> = snapshot
        .windows
        .iter()
        .flat_map(|w| &w.clusters)
        .filter(|c| c.id == cluster)
        .flat_map(|c| c.tree.tabs())
        .filter_map(|tab| {
            snapshot
                .instances
                .iter()
                .find(|i| i.id == tab && i.app_id == crate::apps::agent_tab::ID)
        })
        .collect();
    tabs.sort_by_key(|i| !crate::embed::host::shown(snapshot, &i.id));
    out.extend(tabs.into_iter().map(|i| AgentTarget {
        kind: AgentKind::AgentTab,
        id: i.id.clone(),
        label: format!("Agent tab · {}", i.title),
    }));
    out
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InsertParams {
    item_ids: Vec<String>,
    /// A terminal from `context/agents`; unset, the cluster's first agent.
    #[serde(default)]
    terminal: Option<String>,
    #[serde(default)]
    before: String,
    #[serde(default)]
    after: String,
}

/// The two host-answered `context/*` methods that need the terminals, which the
/// store (`context.rs`) deliberately knows nothing about. Every other
/// `context/*` method is the store's.
pub fn is_method(method: &str) -> bool {
    matches!(method, "context/insert" | "context/agents")
}

pub fn call(
    app: &AppHandle,
    cluster_id: Option<&str>,
    method: &str,
    params: Option<serde_json::Value>,
) -> std::result::Result<serde_json::Value, veistra_rpc::RpcError> {
    match method {
        "context/insert" => insert_for_cluster(app, cluster_id, params),
        "context/agents" => Ok(agents_for_cluster(app, cluster_id)),
        other => Err(veistra_rpc::RpcError::new(
            veistra_rpc::METHOD_NOT_FOUND,
            format!("`{other}` is the context store's, not the terminals'"),
        )),
    }
}

/// `context/agents`: the agents in this frame's cluster that a page can send
/// to, `{ agents: [{ kind, id, label }] }`, the default first. `kind` is
/// `terminal` (send with `context/insert` and its `terminal`) or `agentTab`
/// (send with `veistra/attach-to-agent` and its `instanceId`). Empty outside a
/// cluster or with no agent running, which a picker shows as such.
fn agents_for_cluster(app: &AppHandle, cluster_id: Option<&str>) -> serde_json::Value {
    let Some(cluster) = cluster_id else {
        return serde_json::json!({ "agents": [] });
    };
    let shell = app.state::<ShellState>();
    let ptys = app.state::<PtySessions>();
    let agents = agents_in(
        &shell.snapshot(),
        cluster,
        &shell.terminals_in_cluster(cluster),
        |id| ptys.target(id).map(|t| t.harness),
    );
    serde_json::json!({ "agents": agents })
}

/// `context/insert`: types references for items in this cluster's context store
/// at an agent terminal's prompt, with `before` and `after` around them, and
/// never presses Enter: the person reads the line and sends it. `terminal`
/// picks one from `context/agents`; unset, the cluster's first agent terminal.
/// Answers `{ inserted: false, reason }` rather than an error when there is no
/// such terminal, because the items are already attached in the strip and that
/// is a normal state, not a failure.
fn insert_for_cluster(
    app: &AppHandle,
    cluster_id: Option<&str>,
    params: Option<serde_json::Value>,
) -> std::result::Result<serde_json::Value, veistra_rpc::RpcError> {
    use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
    let p: InsertParams = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("bad params: {e}")))?;
    let declined = |reason: &str| serde_json::json!({ "inserted": false, "reason": reason });
    let Some(cluster) = cluster_id else {
        return Ok(declined("this frame is not in a cluster"));
    };
    let ptys = app.state::<PtySessions>();
    let candidates = app.state::<ShellState>().terminals_in_cluster(cluster);
    let terminal = match choose_terminal(&candidates, p.terminal.as_deref(), |id| {
        ptys.target(id).is_some_and(|t| t.harness.is_agent())
    }) {
        Ok(id) => id,
        Err(reason) => return Ok(declined(reason)),
    };
    let around = Around {
        before: p.before,
        after: p.after,
    };
    let done = insert_stored(app, &ptys, &terminal, &p.item_ids, &around)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;
    Ok(serde_json::json!({
        "inserted": done.count > 0,
        "terminal": terminal,
        "text": done.text,
        "count": done.count,
        "refused": done.refused,
    }))
}

/// The absolute paths of items, for a drag that carries item ids. `instance` is
/// the frame that began the drag; its cluster decides which store the ids
/// belong to, so a frame cannot name another environment's items.
#[tauri::command]
pub fn context_item_paths(
    app: AppHandle,
    instance: String,
    item_ids: Vec<String>,
) -> Result<Vec<String>> {
    let ctx = crate::apps::CallContext::resolve(&app, Some(&instance), None);
    let root = ctx
        .project
        .ok_or_else(|| pty_err(&instance, "no environment for that frame"))?;
    Ok(item_ids
        .iter()
        .filter_map(|id| context::get(&root, id).ok())
        .filter(|i| !i.missing)
        .map(|i| i.path)
        .collect())
}

#[tauri::command]
pub fn terminal_harness(ptys: State<'_, PtySessions>, id: String) -> Option<HarnessInfo> {
    let t = ptys.target(&id)?;
    Some(HarnessInfo {
        effective: t.harness,
        detected: t.detected,
        overridden: t.overridden,
    })
}

/// `"auto"`, `"claude"`, `"codex"`, `"gemini"` or `"shell"`.
#[tauri::command]
pub fn terminal_set_harness(
    ptys: State<'_, PtySessions>,
    id: String,
    choice: String,
) -> Result<()> {
    let parsed = match choice.as_str() {
        "auto" => None,
        other => Some(
            Harness::parse(other)
                .ok_or_else(|| pty_err(&id, format!("unknown harness `{other}`")))?,
        ),
    };
    if ptys.set_harness_override(&id, parsed) {
        Ok(())
    } else {
        Err(pty_err(&id, "no such terminal session"))
    }
}

#[tauri::command]
pub fn context_list(app: AppHandle, terminal_id: String) -> Result<Vec<ContextItem>> {
    Ok(context::list(&root_of(&app, &terminal_id)?))
}

#[tauri::command]
pub fn context_remove(app: AppHandle, terminal_id: String, item_id: String) -> Result<()> {
    let root = root_of(&app, &terminal_id)?;
    context::remove(&root, &item_id).map_err(|e| pty_err(&terminal_id, e.message))?;
    context::notify(&app, &root);
    Ok(())
}

/// `(mime, base64)` of an image item, for its thumbnail.
#[tauri::command]
pub fn context_thumb(
    app: AppHandle,
    terminal_id: String,
    item_id: String,
) -> Result<(String, String)> {
    let root = root_of(&app, &terminal_id)?;
    context::read_image(&root, &item_id).map_err(|e| pty_err(&terminal_id, e.message))
}

/// Whether the "Agent saw" hook is in this environment's Claude settings.
#[tauri::command]
pub fn agent_saw_status(app: AppHandle, terminal_id: String) -> Result<agent_saw::Status> {
    Ok(agent_saw::status(&root_of(&app, &terminal_id)?))
}

/// Add the hook. The frontend asks for consent first; this is what it consents to.
#[tauri::command]
pub fn agent_saw_enable(app: AppHandle, terminal_id: String) -> Result<agent_saw::Status> {
    agent_saw::enable(&root_of(&app, &terminal_id)?).map_err(|e| pty_err(&terminal_id, e))
}

#[tauri::command]
pub fn agent_saw_disable(app: AppHandle, terminal_id: String) -> Result<agent_saw::Status> {
    agent_saw::disable(&root_of(&app, &terminal_id)?).map_err(|e| pty_err(&terminal_id, e))
}

#[tauri::command]
pub fn agent_saw_list(app: AppHandle, terminal_id: String) -> Result<Vec<agent_saw::Seen>> {
    Ok(agent_saw::seen(&root_of(&app, &terminal_id)?))
}

/// `(mime, base64)` of an image the agent read.
#[tauri::command]
pub fn agent_saw_thumb(
    app: AppHandle,
    terminal_id: String,
    path: String,
) -> Result<(String, String)> {
    let (mime, bytes) = agent_saw::thumb(&root_of(&app, &terminal_id)?, &path)
        .map_err(|e| pty_err(&terminal_id, e))?;
    Ok((mime, BASE64.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn png() -> Vec<u8> {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
        b
    }

    fn strings(p: &Path) -> Vec<String> {
        vec![p.to_string_lossy().into_owned()]
    }

    #[test]
    fn the_shown_agent_terminal_is_chosen_and_a_plain_shell_never_is() {
        let ids = [
            "shell".to_string(),
            "claude-1".to_string(),
            "claude-2".to_string(),
        ];
        let picked = pick_agent_terminal(&ids, |id| id.starts_with("claude"));
        assert_eq!(picked.as_deref(), Some("claude-1"));
        assert_eq!(pick_agent_terminal(&ids, |_| false), None);
        assert_eq!(pick_agent_terminal(&[], |_| true), None);
    }

    #[test]
    fn a_chosen_terminal_is_used_only_while_it_is_an_agent_here() {
        let ids = [
            "shell".to_string(),
            "claude-1".to_string(),
            "codex-2".to_string(),
        ];
        let agent = |id: &str| id != "shell";
        assert_eq!(choose_terminal(&ids, None, agent), Ok("claude-1".into()));
        assert_eq!(
            choose_terminal(&ids, Some("codex-2"), agent),
            Ok("codex-2".into()),
            "the person's pick wins over the shown terminal"
        );
        assert!(
            choose_terminal(&ids, Some("shell"), agent).is_err(),
            "a plain shell is never typed into, even when named"
        );
        assert!(
            choose_terminal(&ids, Some("claude-9"), agent).is_err(),
            "a terminal from another cluster, or one that closed, is refused, not swapped"
        );
        assert!(choose_terminal(&ids, None, |_| false).is_err());
    }

    #[test]
    fn the_packet_sentence_goes_around_the_reference_on_one_line() {
        let reference = harness::reference(
            Harness::Claude,
            crate::quoting::ShellFamily::Posix,
            None,
            &["C:/p/.veistra/feedback/t-1/packet.md".to_string()],
        );
        assert!(reference.ends_with(' '), "{reference:?}");
        let mention = reference.trim_end();
        assert_eq!(
            compose("Playtest feedback: 2 notes. Read ", &reference, " first."),
            format!("Playtest feedback: 2 notes. Read {mention} first.")
        );
        assert_eq!(
            compose("", &reference, ""),
            reference,
            "no words, unchanged"
        );
        assert_eq!(
            compose("a\r\nb ", &reference, " c\n"),
            format!("ab {mention} c"),
            "an app's words cannot press Enter"
        );
        assert_eq!(compose("Read ", "", " first."), "", "nothing to point at");
    }

    fn agents_snapshot() -> ShellSnapshot {
        use crate::layout::PaneNode;
        let mut tree = PaneNode::leaf("pane-1".to_string());
        for tab in ["files-1", "agent-tab-1", "agent-tab-2"] {
            tree.insert_tab("pane-1", tab, None);
        }
        let mut other = PaneNode::leaf("pane-2".to_string());
        other.insert_tab("pane-2", "agent-tab-3", None);
        let cluster = |id: &str, tree: PaneNode| crate::shell_state::Cluster {
            id: id.into(),
            name: id.into(),
            tree,
            project: Some("C:/p".into()),
            worktree: None,
            active_terminal: None,
            band_height: None,
            page: None,
            environment: None,
            pinned: false,
            icon: None,
            environment_missing: false,
        };
        let instance = |id: &str, app_id: &str, title: &str| SurfaceInstance {
            id: id.into(),
            app_id: app_id.into(),
            kind: crate::shell_state::SurfaceKind::App,
            title: title.into(),
        };
        let terminal = |id: &str, title: &str| crate::shell_state::TerminalSession {
            id: id.into(),
            title: title.into(),
            cluster_id: "c1".into(),
            agent_finished: false,
            group_id: None,
        };
        ShellSnapshot {
            windows: vec![crate::shell_state::WindowPlacement {
                label: "main".into(),
                clusters: vec![cluster("c1", tree), cluster("c2", other)],
                active_cluster_id: Some("c1".into()),
                geometry: None,
                right_page: None,
            }],
            instances: vec![
                instance("files-1", "files", "Files"),
                instance("agent-tab-1", "agent-tab", "Fix the chase"),
                instance("agent-tab-2", "agent-tab", "Agent"),
                instance("agent-tab-3", "agent-tab", "Elsewhere"),
            ],
            terminals: vec![terminal("t1", "pwsh"), terminal("t2", "Terminal 2")],
        }
    }

    #[test]
    fn the_agents_are_listed_with_the_default_first() {
        let snapshot = agents_snapshot();
        let harness = |id: &str| match id {
            "t1" => Some(Harness::Shell),
            "t2" => Some(Harness::Claude),
            _ => None,
        };
        let terminals = ["t1".to_string(), "t2".to_string()];
        let agents = agents_in(&snapshot, "c1", &terminals, harness);
        let seen: Vec<(AgentKind, &str, &str)> = agents
            .iter()
            .map(|a| (a.kind, a.id.as_str(), a.label.as_str()))
            .collect();
        assert_eq!(
            seen,
            vec![
                (AgentKind::Terminal, "t2", "Claude Code · Terminal 2"),
                (AgentKind::AgentTab, "agent-tab-2", "Agent tab · Agent"),
                (
                    AgentKind::AgentTab,
                    "agent-tab-1",
                    "Agent tab · Fix the chase"
                ),
            ],
            "no plain shell, no other cluster's tab, the shown tab before the hidden one"
        );
        let no_terminals = agents_in(&snapshot, "c1", &terminals, |_| None);
        assert_eq!(
            no_terminals[0].id, "agent-tab-2",
            "with no agent terminal, the first agent tab is the default"
        );
        assert!(agents_in(&snapshot, "c9", &[], harness).is_empty());
        assert_eq!(
            serde_json::to_value(&agents[1]).unwrap(),
            serde_json::json!({ "kind": "agentTab", "id": "agent-tab-2", "label": "Agent tab · Agent" })
        );
    }

    #[test]
    fn a_typed_reference_never_presses_enter() {
        let paths = vec!["C:/p/.veistra/context/markup.png".to_string()];
        for harness in [
            Harness::Claude,
            Harness::Gemini,
            Harness::Codex,
            Harness::Shell,
        ] {
            let text = harness::reference(
                harness,
                crate::quoting::ShellFamily::Posix,
                Some(Path::new("C:/p")),
                &paths,
            );
            assert!(
                !text.chars().any(char::is_control),
                "{harness:?} wrote a line break: {text:?}"
            );
        }
        let claude = harness::reference(
            Harness::Claude,
            crate::quoting::ShellFamily::Posix,
            Some(Path::new("C:/p")),
            &paths,
        );
        assert!(claude.starts_with('@'), "{claude:?}");
    }

    #[test]
    fn a_plain_shell_drop_is_untouched_and_stores_nothing() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("a b.txt");
        std::fs::write(&f, "x").unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Shell, &strings(&f));
        assert_eq!(out, strings(&f));
        assert!(items.is_empty() && refused.is_empty());
        assert!(context::list(env.path()).is_empty());
    }

    #[test]
    fn a_harness_drop_copies_outside_files_in_and_references_the_copy() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("Shot One.png");
        std::fs::write(&f, png()).unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert!(refused.is_empty());
        assert_eq!(items.len(), 1);
        assert_eq!(out, vec![items[0].path.clone()]);
        assert!(context::inside(
            &context::store_dir(env.path()),
            Path::new(&out[0])
        ));
        assert!(f.exists());
    }

    #[test]
    fn a_harness_drop_of_a_file_already_in_the_environment_is_referenced_in_place() {
        let env = TempDir::new().unwrap();
        let f = env.path().join("design.md");
        std::fs::write(&f, "# d").unwrap();
        let (out, items, _) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert_eq!(out, strings(&f));
        assert!(!items[0].owned);
    }

    #[test]
    fn a_chip_dragged_back_out_of_the_store_is_not_registered_twice() {
        let env = TempDir::new().unwrap();
        let (out, _, _) = ingest_drop(
            Some(env.path()),
            Harness::Claude,
            &strings(&{
                let item = context::put(
                    env.path(),
                    PutRequest {
                        key: None,
                        kind: None,
                        title: None,
                        payload: Payload::Bytes(png()),
                        app_id: "x".into(),
                        label: None,
                        method: Method::Put,
                        reference_in_place: false,
                    },
                )
                .unwrap();
                PathBuf::from(item.path)
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(context::list(env.path()).len(), 1);
    }

    #[test]
    fn an_executable_is_refused_with_a_reason_and_left_out_of_the_reference() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("setup.exe");
        std::fs::write(&f, b"MZ\0\0\0\0\0\0").unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert!(out.is_empty() && items.is_empty());
        assert_eq!(refused.len(), 1);
        assert!(refused[0].starts_with("setup.exe:"));
    }

    #[test]
    fn a_secret_drop_is_refused_with_the_rule_and_nothing_is_copied() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let f = outside.path().join(".env");
        std::fs::write(&f, "TOKEN=abc").unwrap();
        let (out, items, refused) = ingest_drop(Some(env.path()), Harness::Claude, &strings(&f));
        assert!(out.is_empty() && items.is_empty());
        assert_eq!(refused.len(), 1);
        assert!(refused[0].starts_with(".env:") && refused[0].contains(".env files"));
        assert!(context::list(env.path()).is_empty());
    }

    #[test]
    fn a_directory_is_referenced_as_itself_and_never_copied() {
        let env = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let (out, items, _) =
            ingest_drop(Some(env.path()), Harness::Claude, &strings(outside.path()));
        assert_eq!(out, strings(outside.path()));
        assert!(items.is_empty());
    }

    #[test]
    fn with_no_environment_a_harness_drop_still_passes_paths_through() {
        let outside = TempDir::new().unwrap();
        let f = outside.path().join("a.png");
        std::fs::write(&f, png()).unwrap();
        let (out, items, _) = ingest_drop(None, Harness::Claude, &strings(&f));
        assert_eq!(out, strings(&f));
        assert!(items.is_empty());
    }
}
