//! Where the person is working, for any agent connected to Veistra.
//! An agent in a terminal pane cannot see the window around it; three tools say which
//! pane has focus, how panes are arranged, and which project each cluster is on. Three
//! more are the agent's half of Play's fix loop: the notes the person sent from a
//! recorded take, and the two writes that report on one (`list_play_notes`,
//! `start_play_note`, `resolve_play_note`; served from [`super::play_notes`],
//! which `context` shares). [`super::blender_exports`] adds `export_blend` and its list.
//!
//! **On in every build, and read-only but for the play notes and the export.** Unlike
//! [`super::debug`] there is no developer gate, because nothing here reaches past what
//! the person can see on screen: no input, no `eval`, no failures buffer, no window geometry. What
//! `shell_snapshot` carries that this leaves out (geometry, band heights,
//! restore bookkeeping, agent-finished dots) is internal to the shell.
//!
//! The layout comes from the same [`ShellSnapshot`] `shell_snapshot` reads. Focus
//! lives in the DOM, so each window's shell reports it to [`FocusState`]; `focus`
//! takes who has focus from there, asks each window's page for what only the DOM
//! knows (the way the `context` tool does), and falls back to the layout's active
//! tabs when nothing has reported. The `veistra://workspace/focus` resource serves
//! the same answer and is what a subscribed agent is told has changed.

use super::McpResource;
use crate::devtools;
use crate::layout::PaneNode;
use crate::mcp::{FocusReport, FocusState, McpServer, McpTool, ToolAnswer};
use crate::shell_state::{Cluster, ShellSnapshot, ShellState, SurfaceKind, WindowPlacement};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, METHOD_NOT_FOUND};

pub static SERVER: McpServer = McpServer {
    id: ID,
    name: "Workspace",
    description: "Where the person is working: which pane has focus, how the panes are \
                  arranged, and which project each cluster is on; and the playtest notes the \
                  person sent from Play, with the two calls that report on one.",
    tools: TOOLS,
    call,
    dev_only: false,
};

/// The server id, which the subscription table and the notifier key on.
pub const ID: &str = "workspace";

/// What an agent subscribes to in order to hear that focus moved. Reading it
/// returns exactly what the `focus` tool does.
pub const FOCUS_URI: &str = "veistra://workspace/focus";

pub static RESOURCES: &[McpResource] = &[McpResource {
    uri: FOCUS_URI,
    name: "focus",
    description: "Where the person is working right now: the same answer as the `focus` tool. \
                  Subscribe to be sent notifications/resources/updated when it changes, then \
                  read it again.",
    mime_type: "application/json",
}];

/// Answer a `resources/read`. `None` for a uri this server does not publish.
pub fn read_resource(app: &AppHandle, uri: &str) -> Option<Result<Value, RpcError>> {
    (uri == FOCUS_URI).then(|| Ok(focus_answer(app)))
}

fn focus_answer(app: &AppHandle) -> Value {
    let snapshot = app.state::<ShellState>().snapshot();
    focus_view(&snapshot, &page_contexts(app))
}

static TOOLS: &[McpTool] = &TOOL_LIST;

const TOOL_LIST: [McpTool; 8] = [
    McpTool {
        name: "focus",
        description: "What the person is looking at right now: the focused pane, the app and \
                      instance in it, the file it shows and its selection when the app reports \
                      one, plus every surface visible on screen. Call this first when the \
                      person says \"this\", \"here\" or \"the open file\". Focus is often in \
                      the terminal you are running in; `visible` then lists the apps beside it.",
        schema: no_params,
    },
    McpTool {
        name: "layout",
        description: "Every window, cluster and pane, with what each pane holds (app, \
                      instance id, title, file where known) and which tab is active. Use the \
                      instance ids with the canvas server's tools.",
        schema: no_params,
    },
    McpTool {
        name: "project",
        description: "The project each cluster is working on: the project folder, the folder \
                      its files are actually read from (a worktree's, when it has one), and \
                      the branch. Also says which cluster is active.",
        schema: no_params,
    },
    super::play_notes::TOOLS[0],
    super::play_notes::TOOLS[1],
    super::play_notes::TOOLS[2],
    // An agent exports what the person may have open in Blender (#317).
    super::blender_exports::TOOLS[0],
    super::blender_exports::TOOLS[1],
];

fn no_params() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn call(app: &AppHandle, tool: &str, params: Option<Value>) -> Result<ToolAnswer, RpcError> {
    if super::play_notes::serves(tool) {
        return super::play_notes::call(app, tool, &params);
    }
    if super::blender_exports::serves(tool) {
        return super::blender_exports::call(app, tool, &params);
    }
    let snapshot = app.state::<ShellState>().snapshot();
    match tool {
        "focus" => Ok(focus_answer(app).into()),
        "layout" => Ok(layout_view(&snapshot, &page_contexts(app)).into()),
        "project" => Ok(project_view(&snapshot).into()),
        other => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("the workspace server has no tool named `{other}`"),
        )),
    }
}

/// What one window's page says about focus.
///
/// Evaluated in the page because the backend never learns where DOM focus is.
/// `reports` come from `window.__veistraContext`, which an app defines to say what
/// it is showing (the canvas app reports its open canvas and selection).
const FOCUS_BODY: &str = r#"
const a = deepActive();
const apps = [];
for (const f of document.querySelectorAll('iframe')) {
  let report = null;
  try { const fn = f.contentWindow.__veistraContext; report = typeof fn === 'function' ? fn() : null; } catch { report = null; }
  apps.push({ instance: instanceOf(f), title: f.getAttribute('title'), focused: f === a.frame, visible: shown(f, document), report });
}
let text = '';
try { text = String(a.doc.getSelection ? a.doc.getSelection() : ''); } catch { text = ''; }
const SELECTION_CAP = 100000;
const cutSelection = (s) => {
  if (s.length <= SELECTION_CAP) return s;
  const splitsPair = /[\ud800-\udbff]/.test(s[SELECTION_CAP - 1]);
  return s.slice(0, SELECTION_CAP - (splitsPair ? 1 : 0));
};
return JSON.stringify({
  focusIn: a.frame ? 'app' : (terminal(a.el) ? 'terminal' : (a.el ? 'shell' : 'nothing')),
  instance: instanceOf(a.frame || a.el),
  windowHasFocus: document.hasFocus(),
  apps,
  selectedText: cutSelection(text),
  selectedTextLength: text.length,
});
"#;

/// How much of the selection is handed to an agent, in UTF-16 units: the unit
/// the page's `text.length` and so `selectedTextLength` count in.
const SELECTION_LIMIT: usize = 2000;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct PageContext {
    pub focus_in: String,
    pub instance: Option<String>,
    pub window_has_focus: bool,
    pub apps: Vec<PageApp>,
    pub selected_text: String,
    pub selected_text_length: usize,
    /// The pane the shell treats as active, from the shell's focus report.
    pub pane: Option<String>,
    /// The cluster on screen, from the shell's focus report.
    pub cluster: Option<String>,
}

impl PageContext {
    /// Cut the selection to [`SELECTION_LIMIT`] without splitting a character.
    ///
    /// The page sends the selection whole (bar a transport cap that backs off
    /// from a split pair), because a cut made there counts UTF-16 units and can
    /// land between the halves of a surrogate pair: `JSON.stringify` writes the
    /// lone half as `\ud83d`, which `serde_json` refuses, and the whole page
    /// answer is lost. Here the text is already valid, so the cut falls on a
    /// char boundary and counts in the same units as `selectedTextLength`.
    fn with_clipped_selection(mut self) -> Self {
        self.selected_text = clip_utf16(&self.selected_text, SELECTION_LIMIT).to_string();
        self
    }

    /// Make the stored report the answer for who has focus.
    ///
    /// The page's own probe still supplies what only the DOM knows at this
    /// moment (the apps' reports, the selection); *where focus is* comes from
    /// the report, so the `focus` tool and the resource a subscriber re-reads
    /// can never disagree with the notification that sent them.
    fn with_report(mut self, report: &FocusReport) -> Self {
        self.window_has_focus = report.window_has_focus;
        self.focus_in = report.focus_in.clone();
        self.instance = report.instance.clone();
        self.pane = report.pane.clone();
        self.cluster = report.cluster.clone();
        self
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct PageApp {
    pub instance: Option<String>,
    pub focused: bool,
    pub visible: bool,
    pub report: Option<Value>,
}

/// What every window's page said, and why any of them did not.
#[derive(Debug, Clone, Default)]
pub(super) struct Pages {
    pub windows: Vec<(String, PageContext)>,
    pub errors: Vec<String>,
}

impl Pages {
    fn of(&self, window: &str) -> Option<&PageContext> {
        self.windows
            .iter()
            .find(|(l, _)| l == window)
            .map(|(_, p)| p)
    }
}

/// Ask every window. A window that will not answer costs its own entry and
/// nothing else, so one blocked webview does not blind the rest.
///
/// Where focus is comes from [`FocusState`]. A window whose probe fails still
/// answers from its report, with no app detail, rather than going missing.
pub(super) fn page_contexts(app: &AppHandle) -> Pages {
    let reports = app.state::<FocusState>();
    let mut pages = Pages::default();
    for label in devtools::window_labels(app) {
        let asked = super::ui::evaluate(
            app,
            Some(&label),
            &super::ui::script(FOCUS_BODY, &Value::Null),
        );
        let parsed = asked.and_then(|v| {
            let text = v.as_str().unwrap_or_default().to_string();
            serde_json::from_str::<PageContext>(&text)
                .map(PageContext::with_clipped_selection)
                .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("the page's answer: {e}")))
        });
        let report = reports.report_for(&label);
        match (parsed, report) {
            (Ok(page), Some(report)) => pages.windows.push((label, page.with_report(&report))),
            (Ok(page), None) => pages.windows.push((label, page)),
            (Err(_), Some(report)) => pages
                .windows
                .push((label, PageContext::default().with_report(&report))),
            (Err(e), None) => pages.errors.push(format!("{label}: {}", e.message)),
        }
    }
    pages
}

/// The longest prefix of `text` that fits in `limit` UTF-16 units and ends on a
/// char boundary. A character that would straddle the limit is left out whole.
fn clip_utf16(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > limit {
            return &text[..at];
        }
    }
    text
}

/// One pane's tab, resolved against the flat instance and terminal lists.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Surface {
    pub instance: String,
    pub app: String,
    pub kind: &'static str,
    pub title: String,
    pub window: String,
    pub cluster: String,
    pub pane: String,
    pub active_tab: bool,
    pub focused: bool,
    pub visible: bool,
    pub report: Option<Value>,
}

impl Surface {
    /// The file or canvas the app says it is showing, if it says.
    pub fn file(&self) -> Option<String> {
        let report = self.report.as_ref()?;
        ["file", "path", "canvas"]
            .iter()
            .find_map(|k| report.get(*k).and_then(Value::as_str))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    fn to_json(&self) -> Value {
        json!({
            "instance": self.instance,
            "app": self.app,
            "kind": self.kind,
            "title": self.title,
            "window": self.window,
            "cluster": self.cluster,
            "pane": self.pane,
            "activeTab": self.active_tab,
            "focused": self.focused,
            "visible": self.visible,
            "file": self.file(),
            "report": self.report,
        })
    }
}

fn kind_name(kind: SurfaceKind) -> &'static str {
    match kind {
        SurfaceKind::App => "app",
        SurfaceKind::Tool => "tool",
        SurfaceKind::Terminal => "terminal",
    }
}

/// Every leaf as `(pane id, tabs, active tab)`, in tree order.
fn leaves(node: &PaneNode) -> Vec<(&str, &[String], Option<&str>)> {
    match node {
        PaneNode::Leaf {
            id,
            tabs,
            active_tab,
        } => vec![(id.as_str(), tabs.as_slice(), active_tab.as_deref())],
        PaneNode::Split { children, .. } => children.iter().flat_map(leaves).collect(),
    }
}

/// The surface behind a tab id, from `instances` then `terminals`.
fn identify(snapshot: &ShellSnapshot, id: &str) -> Option<(String, &'static str, String)> {
    if let Some(i) = snapshot.instances.iter().find(|i| i.id == id) {
        return Some((i.app_id.clone(), kind_name(i.kind), i.title.clone()));
    }
    snapshot
        .terminals
        .iter()
        .find(|t| t.id == id)
        .map(|t| ("terminal".to_string(), "terminal", t.title.clone()))
}

pub(super) fn surfaces(snapshot: &ShellSnapshot, pages: &Pages) -> Vec<Surface> {
    let mut out = Vec::new();
    for window in &snapshot.windows {
        let page = pages.of(&window.label);
        for cluster in &window.clusters {
            let on_screen = window.active_cluster_id.as_deref() == Some(cluster.id.as_str());
            for (pane, tabs, active) in leaves(&cluster.tree) {
                for tab in tabs {
                    let Some((app, kind, title)) = identify(snapshot, tab) else {
                        continue;
                    };
                    let entry = page
                        .and_then(|p| p.apps.iter().find(|a| a.instance.as_deref() == Some(tab)));
                    let active_tab = active == Some(tab.as_str());
                    out.push(Surface {
                        instance: tab.clone(),
                        app,
                        kind,
                        title,
                        window: window.label.clone(),
                        cluster: cluster.id.clone(),
                        pane: pane.to_string(),
                        active_tab,
                        focused: page.is_some_and(|p| {
                            p.window_has_focus && p.instance.as_deref() == Some(tab)
                        }),
                        visible: entry.map_or(active_tab && on_screen, |a| a.visible),
                        report: entry.and_then(|a| a.report.clone()),
                    });
                }
            }
        }
    }
    out
}

/// The window and cluster the person is in: the window that has focus, else
/// `main`, else the first.
pub(super) fn active_cluster(snapshot: &ShellSnapshot, pages: &Pages) -> Option<(String, String)> {
    let focused = pages
        .windows
        .iter()
        .find(|(_, p)| p.window_has_focus)
        .and_then(|(label, _)| snapshot.windows.iter().find(|w| &w.label == label));
    let window = focused
        .or_else(|| snapshot.windows.iter().find(|w| w.label == "main"))
        .or_else(|| snapshot.windows.first())?;
    let cluster = window.active_cluster_id.clone()?;
    Some((window.label.clone(), cluster))
}

fn cluster_of<'a>(
    snapshot: &'a ShellSnapshot,
    id: &str,
) -> Option<(&'a WindowPlacement, &'a Cluster)> {
    snapshot
        .windows
        .iter()
        .find_map(|w| w.clusters.iter().find(|c| c.id == id).map(|c| (w, c)))
}

fn environment_json(cluster: &Cluster) -> Value {
    use crate::environments::Environment;
    match &cluster.environment {
        Some(Environment::Main) => json!({ "kind": "main", "readOnly": true }),
        Some(Environment::LocalWorktree { branch, base, .. }) => {
            json!({ "kind": "worktree", "branch": branch, "base": base, "readOnly": false })
        }
        Some(Environment::Design { branch, .. }) => {
            json!({ "kind": "design", "branch": branch, "readOnly": false })
        }
        Some(Environment::Cloud { branch, .. }) => {
            json!({ "kind": "cloud", "branch": branch, "readOnly": false })
        }
        None => Value::Null,
    }
}

/// The folder a cluster's files are read from: its environment's, else its
/// worktree's, else its project.
fn root_of(cluster: &Cluster) -> Option<String> {
    let project = cluster.project.as_deref().map(std::path::Path::new);
    cluster
        .environment
        .as_ref()
        .and_then(|e| e.root(project))
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| cluster.worktree.as_ref().map(|w| w.path.clone()))
        .or_else(|| cluster.project.clone())
}

fn cluster_json(cluster: &Cluster, active: bool) -> Value {
    json!({
        "id": cluster.id,
        "name": cluster.name,
        "icon": cluster.icon,
        "active": active,
        "project": cluster.project,
        "root": root_of(cluster),
        "environment": environment_json(cluster),
    })
}

fn tree_json(node: &PaneNode, surfaces: &[Surface]) -> Value {
    match node {
        PaneNode::Split {
            id, dir, children, ..
        } => json!({
            "kind": "split",
            "id": id,
            "dir": dir,
            "children": children.iter().map(|c| tree_json(c, surfaces)).collect::<Vec<_>>(),
        }),
        PaneNode::Leaf {
            id,
            tabs,
            active_tab,
        } => json!({
            "kind": "pane",
            "id": id,
            "activeTab": active_tab,
            "tabs": tabs
                .iter()
                .filter_map(|t| surfaces.iter().find(|s| &s.instance == t))
                .map(Surface::to_json)
                .collect::<Vec<_>>(),
        }),
    }
}

pub(super) fn layout_view(snapshot: &ShellSnapshot, pages: &Pages) -> Value {
    let all = surfaces(snapshot, pages);
    let windows: Vec<Value> = snapshot
        .windows
        .iter()
        .map(|w| {
            let clusters: Vec<Value> = w
                .clusters
                .iter()
                .map(|c| {
                    let active = w.active_cluster_id.as_deref() == Some(c.id.as_str());
                    let mut row = cluster_json(c, active);
                    row["tree"] = tree_json(&c.tree, &all);
                    row["terminals"] = json!(snapshot
                        .terminals
                        .iter()
                        .filter(|t| t.cluster_id == c.id)
                        .map(|t| json!({
                            "id": t.id,
                            "title": t.title,
                            "active": c.active_terminal.as_deref() == Some(t.id.as_str()),
                        }))
                        .collect::<Vec<_>>());
                    row
                })
                .collect();
            json!({
                "label": w.label,
                "activeCluster": w.active_cluster_id,
                "page": w.right_page.as_ref().map(|p| p.id.clone()),
                "clusters": clusters,
            })
        })
        .collect();
    json!({ "windows": windows, "pageErrors": pages.errors })
}

pub(super) fn project_view(snapshot: &ShellSnapshot) -> Value {
    let mut clusters = Vec::new();
    for w in &snapshot.windows {
        for c in &w.clusters {
            let active = w.active_cluster_id.as_deref() == Some(c.id.as_str());
            let mut row = cluster_json(c, active);
            row["window"] = json!(w.label);
            clusters.push(row);
        }
    }
    json!({ "clusters": clusters })
}

pub(super) fn focus_view(snapshot: &ShellSnapshot, pages: &Pages) -> Value {
    let all = surfaces(snapshot, pages);
    let from_page = pages.windows.iter().find(|(_, p)| p.window_has_focus);
    let focus_in = from_page.map_or("unknown", |(_, p)| p.focus_in.as_str());

    let focused_surface = all.iter().find(|s| s.focused);
    let focused_other = from_page
        .and_then(|(_, p)| p.instance.as_deref())
        .filter(|_| focused_surface.is_none())
        .and_then(|id| identify(snapshot, id).map(|(app, kind, title)| (id, app, kind, title)));

    let located = active_cluster(snapshot, pages);
    let active = located.as_ref().and_then(|(_, cluster)| {
        cluster_of(snapshot, cluster).map(|(w, c)| {
            let mut row = cluster_json(c, true);
            row["window"] = json!(w.label);
            row
        })
    });

    let visible: Vec<Value> = all
        .iter()
        .filter(|s| s.visible && s.kind != "terminal")
        .filter(|s| located.as_ref().is_none_or(|(_, c)| &s.cluster == c))
        .map(Surface::to_json)
        .collect();

    let focused = match (focused_surface, focused_other) {
        (Some(s), _) => s.to_json(),
        (None, Some((id, app, kind, title))) => {
            json!({ "instance": id, "app": app, "kind": kind, "title": title })
        }
        _ => Value::Null,
    };

    let selected = from_page.map(|(_, p)| p.selected_text.clone());
    json!({
        "focusSource": if from_page.is_some() { "page" } else { "layout" },
        "windowHasFocus": from_page.is_some(),
        "focusIn": focus_in,
        "activePane": from_page.and_then(|(_, p)| p.pane.clone()),
        "focused": focused,
        "activeCluster": active,
        "visible": visible,
        "selectedText": selected,
        "selectedTextLength": from_page.map_or(0, |(_, p)| p.selected_text_length),
        "pageErrors": pages.errors,
        "hint": hint(focus_in, from_page.is_some()),
    })
}

/// What the person has selected in one cluster, for `veistra://selection`: the
/// surfaces showing in it (with what each app reports, such as the canvas's
/// selected shapes), the focused one, and the selected text.
pub fn selection_in(app: &AppHandle, cluster: &str) -> Value {
    let snapshot = app.state::<ShellState>().snapshot();
    selection_view(&snapshot, &page_contexts(app), cluster)
}

pub(super) fn selection_view(snapshot: &ShellSnapshot, pages: &Pages, cluster: &str) -> Value {
    let all = surfaces(snapshot, pages);
    let shown: Vec<Value> = all
        .iter()
        .filter(|s| s.cluster == cluster && s.visible && s.kind != "terminal")
        .map(Surface::to_json)
        .collect();
    let focused = all
        .iter()
        .find(|s| s.cluster == cluster && s.focused)
        .map_or(Value::Null, Surface::to_json);
    // A DOM selection belongs to a window, not to a cluster: it is this
    // cluster's only while its window is showing it.
    let page = cluster_of(snapshot, cluster)
        .filter(|(w, _)| w.active_cluster_id.as_deref() == Some(cluster))
        .and_then(|(w, _)| pages.of(&w.label))
        .filter(|p| !p.selected_text.is_empty());
    json!({
        "cluster": cluster,
        "focused": focused,
        "surfaces": shown,
        "selectedText": page.map(|p| p.selected_text.clone()),
        "selectedTextLength": page.map_or(0, |p| p.selected_text_length),
    })
}

fn hint(focus_in: &str, has_page: bool) -> &'static str {
    match (has_page, focus_in) {
        (false, _) => {
            "Veistra is not the foreground window (or no page answered), so `focused` is \
             empty. `visible` is each pane's active tab in the active cluster: the person's \
             last view."
        }
        (true, "terminal") => {
            "Focus is in a terminal, probably the one you run in. The person is most likely \
             talking about one of the `visible` apps beside it."
        }
        (true, "app") => "`focused` is the app the person is working in; its `file` is what they mean by \"this\".",
        _ => "Nothing app-level has focus; see `visible` for what is on screen.",
    }
}

#[cfg(test)]
pub(super) mod fixtures {
    use super::*;
    use crate::layout::SplitDir;
    use crate::shell_state::{Cluster, SurfaceInstance, TerminalSession, WindowPlacement};

    pub fn cluster(id: &str, project: Option<&str>, tree: PaneNode) -> Cluster {
        Cluster {
            id: id.to_string(),
            name: id.to_string(),
            tree,
            project: project.map(str::to_owned),
            worktree: None,
            active_terminal: None,
            band_height: Some(240.0),
            page: None,
            environment: None,
            pinned: false,
            icon: None,
            environment_missing: false,
        }
    }

    pub fn leaf(id: &str, tabs: &[&str], active: Option<&str>) -> PaneNode {
        PaneNode::Leaf {
            id: id.to_string(),
            tabs: tabs.iter().map(|t| (*t).to_string()).collect(),
            active_tab: active.map(str::to_owned),
        }
    }

    /// One window, one active cluster: `canvas-1` and `canvas-2` side by side,
    /// and a terminal pane. A second cluster holds `canvas-3`.
    pub fn snapshot() -> ShellSnapshot {
        let tree = PaneNode::Split {
            id: "split-1".into(),
            dir: SplitDir::Row,
            sizes: vec![0.4, 0.3, 0.3],
            children: vec![
                leaf("pane-1", &["canvas-1"], Some("canvas-1")),
                leaf("pane-2", &["canvas-2"], Some("canvas-2")),
                leaf("pane-3", &["term-1"], Some("term-1")),
            ],
        };
        let instance = |id: &str, app: &str| SurfaceInstance {
            id: id.to_string(),
            app_id: app.to_string(),
            kind: SurfaceKind::App,
            title: id.to_string(),
        };
        ShellSnapshot {
            windows: vec![WindowPlacement {
                label: "main".into(),
                clusters: vec![
                    cluster("cluster-1", Some("C:/work/game"), tree),
                    cluster(
                        "cluster-2",
                        Some("C:/work/other"),
                        leaf("pane-9", &["canvas-3"], Some("canvas-3")),
                    ),
                ],
                active_cluster_id: Some("cluster-1".into()),
                geometry: None,
                right_page: None,
            }],
            instances: vec![
                instance("canvas-1", "canvas"),
                instance("canvas-2", "canvas"),
                instance("canvas-3", "canvas"),
            ],
            terminals: vec![TerminalSession {
                id: "term-1".into(),
                title: "claude".into(),
                cluster_id: "cluster-1".into(),
                agent_finished: false,
                group_id: None,
            }],
        }
    }

    pub fn page(window_has_focus: bool, instance: Option<&str>, focus_in: &str) -> PageContext {
        let app = |id: &str, canvas: &str, visible: bool| PageApp {
            instance: Some(id.to_string()),
            focused: instance == Some(id),
            visible,
            report: Some(
                json!({ "app": "canvas", "canvas": canvas, "elementIds": [], "diagram": null }),
            ),
        };
        PageContext {
            focus_in: focus_in.to_string(),
            instance: instance.map(str::to_owned),
            window_has_focus,
            apps: vec![
                app("canvas-1", "levels/one", true),
                app("canvas-2", "levels/two", true),
            ],
            selected_text: String::new(),
            selected_text_length: 0,
            pane: None,
            cluster: None,
        }
    }

    pub fn pages(page: PageContext) -> Pages {
        Pages {
            windows: vec![("main".to_string(), page)],
            errors: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn the_server_is_ordinary_and_only_the_play_note_reports_and_the_export_write() {
        assert!(!SERVER.dev_only, "workspace ships to everyone");
        let names: Vec<&str> = SERVER.tools.iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            vec![
                "focus",
                "layout",
                "project",
                "list_play_notes",
                "start_play_note",
                "resolve_play_note",
                "export_blend",
                "list_blend_exports"
            ]
        );
        for tool in SERVER.tools {
            let writes = matches!(
                tool.name,
                "start_play_note" | "resolve_play_note" | "export_blend"
            );
            assert_eq!(
                super::super::read_only_hint("workspace", tool.name),
                Some(!writes),
                "{} is advertised as it behaves",
                tool.name
            );
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false);
        }
    }

    #[test]
    fn a_selection_ending_in_an_emoji_at_the_cut_is_not_split() {
        let text = format!("{}😀tail", "a".repeat(SELECTION_LIMIT - 1));
        assert_eq!(
            clip_utf16(&text, SELECTION_LIMIT).encode_utf16().count(),
            SELECTION_LIMIT - 1
        );
        assert!(!clip_utf16(&text, SELECTION_LIMIT).contains('😀'));

        let fits = format!("{}😀", "a".repeat(SELECTION_LIMIT - 2));
        assert_eq!(clip_utf16(&fits, SELECTION_LIMIT), fits);
    }

    #[test]
    fn the_cut_counts_utf16_units_and_survives_multibyte_text() {
        let text = "é".repeat(SELECTION_LIMIT + 10);
        assert_eq!(
            clip_utf16(&text, SELECTION_LIMIT).chars().count(),
            SELECTION_LIMIT
        );
        assert_eq!(clip_utf16("short", SELECTION_LIMIT), "short");
        assert_eq!(clip_utf16("😀", 1), "");
    }

    #[test]
    fn the_page_answer_is_clipped_and_keeps_the_full_length() {
        let text = format!("{}😀tail", "a".repeat(SELECTION_LIMIT - 1));
        let units = text.encode_utf16().count();
        let answer = json!({ "selectedText": text, "selectedTextLength": units }).to_string();
        let page = serde_json::from_str::<PageContext>(&answer)
            .unwrap()
            .with_clipped_selection();
        assert_eq!(page.selected_text, "a".repeat(SELECTION_LIMIT - 1));
        assert_eq!(page.selected_text_length, units);
    }

    /// The page half of the fix. `scripts/workspace-selection.test.mjs` runs the
    /// `cutSelection` helper itself; this keeps the probe from drifting back to
    /// a cut of its own that the helper no longer guards.
    #[test]
    fn the_probe_sends_the_selection_through_the_pair_safe_cut() {
        assert!(FOCUS_BODY.contains("selectedText: cutSelection(text),"));
        assert!(
            !FOCUS_BODY.contains(&format!("slice(0, {SELECTION_LIMIT})")),
            "a cut at the clip limit in the page counts UTF-16 units and can split a pair"
        );
    }

    #[test]
    fn focus_in_an_app_names_the_instance_pane_and_file() {
        let pages = pages(page(true, Some("canvas-2"), "app"));
        let out = focus_view(&snapshot(), &pages);
        assert_eq!(out["focusSource"], "page");
        assert_eq!(out["focusIn"], "app");
        assert_eq!(out["focused"]["instance"], "canvas-2");
        assert_eq!(out["focused"]["pane"], "pane-2");
        assert_eq!(out["focused"]["cluster"], "cluster-1");
        assert_eq!(out["focused"]["file"], "levels/two");
        assert_eq!(out["activeCluster"]["project"], "C:/work/game");
    }

    /// The common case: the agent's own terminal has focus, so the answer has to
    /// say that and still hand back the apps the person is looking at.
    #[test]
    fn focus_in_a_terminal_still_lists_the_visible_apps() {
        let pages = pages(page(true, Some("term-1"), "terminal"));
        let out = focus_view(&snapshot(), &pages);
        assert_eq!(out["focusIn"], "terminal");
        assert_eq!(out["focused"]["app"], "terminal");
        let visible: Vec<&str> = out["visible"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["instance"].as_str().unwrap())
            .collect();
        assert_eq!(visible, vec!["canvas-1", "canvas-2"]);
        assert!(out["hint"].as_str().unwrap().contains("terminal"));
    }

    #[test]
    fn a_selection_belongs_to_the_cluster_its_window_is_showing() {
        let mut shown = page(true, Some("canvas-2"), "app");
        shown.selected_text = "door".into();
        shown.selected_text_length = 4;
        let pages = pages(shown);
        let here = selection_view(&snapshot(), &pages, "cluster-1");
        assert_eq!(here["focused"]["instance"], "canvas-2");
        assert_eq!(here["selectedText"], "door");
        assert_eq!(here["surfaces"].as_array().unwrap().len(), 2);
        let away = selection_view(&snapshot(), &pages, "cluster-2");
        assert_eq!(away["selectedText"], Value::Null);
        assert_eq!(away["focused"], Value::Null);
        assert!(away["surfaces"].as_array().unwrap().is_empty());
    }

    #[test]
    fn without_a_page_focus_falls_back_to_the_active_tabs() {
        let out = focus_view(&snapshot(), &Pages::default());
        assert_eq!(out["focusSource"], "layout");
        assert_eq!(out["focused"], Value::Null);
        let visible = out["visible"].as_array().unwrap();
        assert_eq!(visible.len(), 2, "terminals are not listed as visible apps");
        assert!(visible.iter().all(|v| v["cluster"] == "cluster-1"));
    }

    #[test]
    fn layout_nests_panes_and_leaves_out_dev_internals() {
        let out = layout_view(&snapshot(), &pages(page(false, None, "nothing")));
        let window = &out["windows"][0];
        assert_eq!(window["activeCluster"], "cluster-1");
        let first = &window["clusters"][0];
        assert_eq!(first["tree"]["kind"], "split");
        assert_eq!(
            first["tree"]["children"][1]["tabs"][0]["file"],
            "levels/two"
        );
        assert_eq!(first["terminals"][0]["id"], "term-1");
        let text = out.to_string();
        assert!(
            !text.contains("bandHeight") && !text.contains("geometry"),
            "{text}"
        );
    }

    #[test]
    fn project_lists_every_cluster_with_its_folder() {
        let out = project_view(&snapshot());
        let clusters = out["clusters"].as_array().unwrap();
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0]["project"], "C:/work/game");
        assert_eq!(clusters[0]["active"], true);
        assert_eq!(clusters[1]["root"], "C:/work/other");
        assert_eq!(clusters[1]["active"], false);
    }

    fn report(window_has_focus: bool, instance: Option<&str>, focus_in: &str) -> FocusReport {
        FocusReport {
            window: "main".into(),
            window_has_focus,
            focus_in: focus_in.into(),
            instance: instance.map(str::to_owned),
            pane: Some("pane-2".into()),
            cluster: Some("cluster-1".into()),
        }
    }

    /// One source of truth: whatever the page probe saw, the stored report wins
    /// for who has focus, and the probe's app detail survives.
    #[test]
    fn a_report_overrides_the_probe_for_where_focus_is() {
        let probed = page(false, None, "nothing");
        let merged = probed.with_report(&report(true, Some("canvas-2"), "app"));
        let out = focus_view(&snapshot(), &pages(merged));

        assert_eq!(out["focusIn"], "app");
        assert_eq!(out["focused"]["instance"], "canvas-2");
        assert_eq!(out["activePane"], "pane-2");
        assert_eq!(
            out["focused"]["file"], "levels/two",
            "the app report from the probe is kept"
        );
    }

    /// A window whose probe fails still answers from its report.
    #[test]
    fn a_report_alone_is_enough_to_answer_focus() {
        let only = PageContext::default().with_report(&report(true, Some("term-1"), "terminal"));
        let out = focus_view(&snapshot(), &pages(only));

        assert_eq!(out["focusSource"], "page");
        assert_eq!(out["focusIn"], "terminal");
        assert_eq!(out["focused"]["app"], "terminal");
    }

    #[test]
    fn the_focus_resource_is_published_and_readable_as_json() {
        assert_eq!(RESOURCES.len(), 1);
        assert_eq!(RESOURCES[0].uri, FOCUS_URI);
        assert_eq!(RESOURCES[0].mime_type, "application/json");
        assert_eq!(super::super::resources(ID).len(), 1);
        assert!(super::super::resources("echo").is_empty());
    }

    #[test]
    fn the_active_cluster_follows_the_focused_window() {
        let found = active_cluster(&snapshot(), &Pages::default());
        assert_eq!(found, Some(("main".to_string(), "cluster-1".to_string())));
    }
}
