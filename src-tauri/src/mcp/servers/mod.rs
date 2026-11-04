//! The MCP servers this build hosts.
//!
//! One module each, owning its tool descriptors, schemas and handler, and
//! declaring a single `pub static SERVER` for [`seed`] to register.
//!
//! **If the harness can already do it, it does not get a server.** No file
//! reading, writing or listing, no search, no git. Every agent worth pointing at
//! Veistra arrives with those, and a second worse copy costs a permission surface
//! and a pile of tool descriptions competing for the model's attention.
//!
//! What earns a server is something that exists only inside Veistra and has no
//! filesystem equivalent — Schematify's design model is the first real case, because
//! an agent cannot read a spec's *boundaries* by opening a file. [`debug`] is
//! the second, [`design`] the third and [`ui`] the fourth; each module's doc says
//! what earns its place, and what decides its gate where it writes.
//!
//! [`agent`] is the fifth and the exception, earning its place on the client's
//! axis rather than a capability's: eleven of its fourteen tools are [`ui`]'s
//! and [`debug`]'s, composed so one job needs one connection instead of four.
//! It indexes their arrays and delegates, so nothing here is a second copy.

pub mod agent;
pub mod blender_exports;
pub mod canvas;
pub mod context;
pub mod debug;
#[cfg(feature = "design-mode")]
pub mod design;
pub mod echo;
pub mod play_notes;
pub mod ui;
pub mod workspace;

use super::Registry;

/// Register every server this build hosts, in the order settings lists them.
///
/// `echo` and `debug` are registered in every build, release included, but are
/// `dev_only`: a `cfg` would put them out of reach of the build somebody most
/// needs to diagnose, so the gate is developer mode, checked at the point of use.
///
/// `design` ships for the ordinary user rather than for us — the comments it
/// serves are theirs — which is why it is the one write surface with no gate.
/// `ui` ships too and can click; what makes that safe is not a `cfg` but
/// `dev_only`, a gate the tests below can hold to account.
///
/// `agent` is last because it is the one that composes the others, and it
/// carries `ui`'s gate for `ui`'s reason: it can click too.
pub fn seed(registry: &Registry) {
    registry.register(&echo::SERVER);
    registry.register(&debug::SERVER);
    #[cfg(feature = "design-mode")]
    registry.register(&design::SERVER);
    registry.register(&canvas::SERVER);
    registry.register(&workspace::SERVER);
    registry.register(&context::SERVER);
    registry.register(&ui::SERVER);
    registry.register(&agent::SERVER);
}

/// Whether a tool is known to leave Veistra's state alone, for MCP's
/// `readOnlyHint`.
///
/// `None` means "not claimed", and is what an unlisted tool gets: the hint is
/// advertised only where somebody has read the handler and can say. A
/// `screenshot` writes a temp PNG but changes nothing the user can see, which
/// is the sense MCP means. `app_call` is `false` rather than `None` because it
/// can reach a write method (see `apps::WRITE_METHODS`).
/// `every_declared_tool_has_a_hint_entry` makes adding a tool force the question.
pub fn read_only_hint(server: &str, tool: &str) -> Option<bool> {
    let read = match (server, tool) {
        ("echo", "ping" | "echo") => true,
        ("debug", "shell_snapshot" | "recent_errors" | "boot_status") => true,
        ("design", "list_comments" | "read_comment" | "comment_screenshot") => true,
        ("design", "resolve_comment" | "ask_comment") => false,
        // `agent` composes `ui` and `debug`; one answer for each shared name.
        ("ui" | "agent", "screenshot" | "snapshot" | "context") => true,
        (
            "ui" | "agent",
            "click" | "type_text" | "fill_field" | "press_key" | "drag" | "scroll" | "eval",
        ) => false,
        ("agent", "shell_snapshot" | "recent_errors" | "boot_status") => true,
        ("agent", "app_call" | "open_app" | "set_project") => false,
        ("workspace", "focus" | "layout" | "project") => true,
        ("workspace" | context::ID, tool) if play_notes::serves(tool) => {
            return play_notes::read_only(tool)
        }
        ("workspace" | context::ID, tool) if blender_exports::serves(tool) => {
            return blender_exports::read_only(tool)
        }
        ("canvas", tool) => return canvas::read_only(tool),
        (context::ID, tool) => return context::read_only(tool),
        _ => return None,
    };
    Some(read)
}
/// One readable, subscribable thing a server publishes, beside its tools.
///
/// Resources are for state an agent wants to be *told* about rather than ask
/// for. Declared per server by [`resources`] and read by [`read_resource`],
/// matched on the server id the way [`instructions`] is, so a server with none
/// has nothing to add.
pub struct McpResource {
    pub uri: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub mime_type: &'static str,
}

/// The resources a server publishes; empty for every server but `workspace`
/// and `context`.
pub fn resources(id: &str) -> &'static [McpResource] {
    match id {
        "workspace" => workspace::RESOURCES,
        context::ID => context::RESOURCES,
        _ => &[],
    }
}

/// The URI templates a server reads beyond what it publishes, in
/// [`McpResource`] form with the template as `uri`. Only `context` has any: it
/// reads every `veistra://` reference.
pub fn resource_templates(id: &str) -> &'static [McpResource] {
    match id {
        context::ID => context::TEMPLATES,
        _ => &[],
    }
}

/// Whether a server reads `uri` although it does not publish it.
pub fn reads_unpublished(id: &str, uri: &str) -> bool {
    let scheme = crate::refs::uri::SCHEME;
    let head = uri.get(..scheme.len());
    id == context::ID && head.is_some_and(|h| h.eq_ignore_ascii_case(scheme))
}

/// Read one resource, from `cluster` when a session token pinned one. `None`
/// when the server has no resource at that uri.
pub fn read_resource(
    app: &tauri::AppHandle,
    id: &str,
    uri: &str,
    cluster: Option<&str>,
) -> Option<Result<super::ToolAnswer, veistra_rpc::RpcError>> {
    match id {
        "workspace" => workspace::read_resource(app, uri).map(|read| read.map(Into::into)),
        context::ID => Some(context::read_resource(app, uri, cluster)),
        _ => None,
    }
}

/// What an MCP client is told at `initialize`, before it reads a single tool.
///
/// Said here because an agent once went looking for Veistra in a browser —
/// its global instructions named a Chrome extension for "all UI verification" —
/// and found nothing, since the app is a desktop window. The servers that can
/// see the window say so up front. Rejected: a field on `McpServer`, which
/// would put a `None` in every server that has nothing to add.
pub fn instructions(id: &str) -> Option<&'static str> {
    match id {
        "ui" | "agent" => Some(
            "This server is how you see and drive Veistra, a desktop app. It is not a web \
             page: browser and Chrome tools cannot reach it, and a dev server on localhost \
             serves the shell with no backend behind it. Use `screenshot` to look, `snapshot` \
             for clickable refs, `click`, `drag`, `scroll`, `press_key`, `fill_field` and `type_text` to act, and `context` \
             to ask what is focused and what the open app has selected. `type_text` refuses \
             to type into a terminal; that terminal is probably yours.",
        ),
        "workspace" => Some(
            "Where the person is working. Call `focus` when they say \"this\" or \"here\"; \
             it names the focused pane, the app and the file or selection it reports. `layout` and \
             `project` give the panes and the folder each cluster is on. Pass the instance ids you \
             find here to the canvas server. `export_blend` exports a .blend as its next version \
             and never writes the .blend, even one the person has open; `list_blend_exports` \
             shows the versions.",
        ),
        "canvas" => Some(
            "Design canvases. More than one can be open: call `list_canvases` to see them and which has \
             focus. Every tool takes `canvas` (id), `instance` or `cluster`; omit them and the focused \
             canvas is used, which the result's `resolved` block says. All writes are made as the agent. \
             `view_diagram` renders to a PNG file: read the path it returns. Call `drawing_guide` \
             before your first `add_shapes`: it is the manual (palette, spacing, every option) and \
             ends with the detail level and style the person chose in Settings, which you follow.",
        ),
        context::ID => Some(
            "veistra:// references to what is in the person's project: veistra://file/<path>#L10-L20, \
             veistra://canvas/<id>#frame=<frame>, veistra://comment/<id>, veistra://design-comment/<id>, \
             veistra://context/<id> and veistra://selection. `search_context` finds them by name, \
             `read` reads one, and `show` puts up to eight in front of the person beside your \
             reply. `list_comments` has what they asked of you; `resolve_comment` closes one. Call `get_selection` when they \
             say \"this\". Secrets and gitignored files are withheld and say so. Notes sent from \
             Play come with a packet.md: `list_play_notes` lists them, `start_play_note` says you \
             are on one and `resolve_play_note` reports it fixed. `export_blend` exports a .blend as \
             its next version without writing the .blend; `list_blend_exports` shows the versions.",
        ),
        "debug" => Some(
            "Read-only views of a running Veistra: its shell layout, recent errors and boot \
             progress. To see or click the window, use the `agent` server, not a browser.",
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_servers_that_see_the_window_say_a_browser_cannot() {
        for id in ["ui", "agent", "debug"] {
            let text = instructions(id).unwrap_or_default();
            assert!(text.contains("browser"), "{id}: {text}");
        }
        assert!(instructions("echo").is_none());
    }

    #[test]
    fn the_context_server_reads_every_reference_and_publishes_the_selection() {
        assert_eq!(resources(context::ID)[0].uri, "veistra://selection");
        assert!(reads_unpublished(context::ID, "veistra://file/a.gd"));
        assert!(reads_unpublished(context::ID, "VEISTRA://file/a.gd"));
        assert!(!reads_unpublished(context::ID, "file:///etc/passwd"));
        assert!(!reads_unpublished("workspace", "veistra://file/a.gd"));
        assert!(resource_templates("workspace").is_empty());
        for t in resource_templates(context::ID) {
            assert!(t.uri.starts_with("veistra://"), "{}", t.uri);
        }
    }

    /// Every declared tool has an entry in the hint table, so a new tool cannot
    /// ship without somebody deciding what to claim for it.
    #[test]
    fn every_declared_tool_has_a_hint_entry() {
        let registry = Registry::default();
        seed(&registry);
        for server in registry.catalog(true) {
            let hinted = server
                .tools
                .iter()
                .filter(|t| t.annotations.is_some())
                .count();
            assert_eq!(
                hinted,
                server.tools.len(),
                "{} has an unclaimed tool",
                server.id
            );
        }
        assert_eq!(read_only_hint("ui", "nonesuch"), None);
    }

    /// The panel's data is the data `tools/list` serves, not a copy that can
    /// drift: for every server, with everything switched on, each panel tool
    /// equals the wire shape `listener::into_rmcp_tool` produces.
    #[test]
    fn the_panel_catalog_equals_what_tools_list_serves() {
        let registry = Registry::default();
        seed(&registry);
        for server in registry.list(true) {
            registry.set_enabled(&server.id, true);
        }

        let catalog = registry.catalog(true);
        assert_eq!(catalog.len(), registry.list(true).len());
        for server in catalog {
            let served: Vec<serde_json::Value> = registry
                .tools(&server.id, true)
                .into_iter()
                .map(|d| serde_json::to_value(crate::mcp::listener::into_rmcp_tool(d)).unwrap())
                .collect();
            assert_eq!(server.tools.len(), served.len(), "{}", server.id);
            for (panel, wire) in server.tools.iter().zip(&served) {
                let panel = serde_json::to_value(panel).unwrap();
                assert_eq!(panel["name"], wire["name"]);
                assert_eq!(panel["description"], wire["description"]);
                assert_eq!(panel["inputSchema"], wire["inputSchema"]);
                assert_eq!(
                    panel["annotations"]["readOnlyHint"], wire["annotations"]["readOnlyHint"],
                    "{}/{}",
                    server.id, panel["name"]
                );
            }
        }
    }

    /// A switched-off server answers `tools/list` with nothing, but the panel
    /// still shows what it would offer.
    #[test]
    fn a_disabled_server_still_lists_its_tools_in_the_panel() {
        let registry = Registry::default();
        seed(&registry);
        assert!(registry.tools("echo", true).is_empty());
        let echo = registry
            .catalog(true)
            .into_iter()
            .find(|s| s.id == "echo")
            .unwrap();
        assert_eq!(echo.tools.len(), 2);
    }

    #[test]
    fn seeding_registers_every_server_this_build_hosts() {
        let registry = Registry::default();
        seed(&registry);

        let ids: Vec<String> = registry.list(true).into_iter().map(|s| s.id).collect();
        #[cfg(feature = "design-mode")]
        assert_eq!(
            ids,
            vec![
                "echo",
                "debug",
                "design",
                "canvas",
                "workspace",
                "context",
                "ui",
                "agent"
            ]
        );
        #[cfg(not(feature = "design-mode"))]
        assert_eq!(
            ids,
            vec![
                "echo",
                "debug",
                "canvas",
                "workspace",
                "context",
                "ui",
                "agent"
            ]
        );
    }

    /// Every ordinary server is usable the moment Veistra starts. The one that
    /// can click is not, and no amount of the rest being convenient is a reason
    /// to make it so.
    #[test]
    fn an_ordinary_server_starts_on_and_the_developer_only_one_starts_off() {
        let registry = Registry::default();
        seed(&registry);

        for server in registry.list(true) {
            assert_eq!(
                server.enabled, !server.dev_only,
                "{} starts in the wrong state",
                server.id
            );
        }
    }

    /// With developer mode off, the ordinary user sees only what is for them.
    /// `design` is meant to be here: it is the one write surface an ordinary
    /// user is supposed to have, for the reasons in its module doc. `canvas`,
    /// `workspace` and `context` are the ones agents use in a release build. `echo`, `debug`,
    /// `ui` and `agent` are all developer-only.
    #[test]
    fn a_default_install_sees_only_the_servers_that_are_not_developer_only() {
        let registry = Registry::default();
        seed(&registry);

        #[cfg(feature = "design-mode")]
        let expected: Vec<&str> = vec!["design", "canvas", "workspace", "context"];
        #[cfg(not(feature = "design-mode"))]
        let expected: Vec<&str> = vec!["canvas", "workspace", "context"];

        let ids: Vec<String> = registry.list(false).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, expected);
        assert_eq!(registry.enabled_ids(false), expected);
    }

    /// With developer mode on, echo and debug are listed and badged, but start
    /// off like `ui` and `agent`: revealing is not enabling. Once switched on
    /// they are reachable, and switching developer mode off takes them away.
    #[test]
    fn echo_and_debug_appear_with_developer_mode_and_need_their_own_switch() {
        let registry = Registry::default();
        seed(&registry);

        for id in ["echo", "debug"] {
            let row = registry
                .list(true)
                .into_iter()
                .find(|s| s.id == id)
                .unwrap_or_else(|| panic!("{id} is listed with developer mode on"));
            assert!(row.dev_only, "{id} carries the developer badge");
            assert!(!row.enabled, "{id} starts off");
            assert!(!registry.enabled_ids(true).contains(&id.to_string()));

            assert!(registry.set_enabled(id, true));
            assert!(registry.enabled_ids(true).contains(&id.to_string()));
            assert!(!registry.enabled_ids(false).contains(&id.to_string()));
            assert!(registry.tools(id, false).is_empty());
            assert!(!registry.tools(id, true).is_empty());
        }
    }

    /// The id reaches two places a typo would not be caught in: a URL path and a
    /// key in the user's own `.mcp.json`.
    #[test]
    fn each_server_gets_a_namespaced_key_and_route() {
        let registry = Registry::default();
        seed(&registry);

        for server in registry.list(true) {
            assert_eq!(server.config_key, format!("veistra-{}", server.id));
            assert_eq!(server.path, format!("/mcp/{}", server.id));
        }
    }

    /// Seeding twice is what a re-seed after a settings change would do, and it
    /// must not double the list.
    #[test]
    fn seeding_is_idempotent() {
        let registry = Registry::default();
        seed(&registry);
        let once = registry.list(true).len();
        seed(&registry);

        assert_eq!(registry.list(true).len(), once);
    }

    /// Held against the servers this build actually registers, not against a
    /// fixture. `registry.rs` has the same check over its own test doubles,
    /// which proves the rule and not the shipped set — and the shipped set is
    /// the one where an id becomes a URL path (`/mcp/<id>`) and a `.mcp.json`
    /// key (`veistra-<id>`). The same rule `veistra-tool-manifest` holds tool ids
    /// to, for the same reason.
    #[test]
    fn every_registered_server_id_is_url_safe() {
        let registry = Registry::default();
        seed(&registry);

        for server in registry.list(true) {
            let mut chars = server.id.chars();
            assert!(
                matches!(chars.next(), Some(c) if c.is_ascii_lowercase()),
                "server id {:?} must start with a lowercase letter",
                server.id
            );
            assert!(
                chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "server id {:?} must match ^[a-z][a-z0-9-]*$",
                server.id
            );
        }
    }
}
