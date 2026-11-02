//! First-party apps — the surfaces this repo ships itself.
//!
//! To the shell an app and a tool are the same thing: a tab in the switcher bar
//! and an iframe in the tool window, speaking transport B of
//! `docs/tool-protocol.md`. What differs is where the two halves come from, and
//! that difference is the whole reason apps are their own concept.
//!
//! A **tool** is another repository: its frontend is served out of its own
//! checkout, its Rust core is a child process the shell spawns and talks to over
//! the standard streams — two processes, two transports, joined by a broker that
//! is not built yet. An **app** ships inside the orchestrator: its frontend is an
//! extra entry point in this repo's own Vite config, its Rust half a module right
//! here, reached over transport B and dispatched by [`call`] below — no child
//! process, no broker in between.

// `pub(crate)` for `lib.rs` (which manages its `Sessions`), `shell_state`
// (which stops a closed tab's agent) and the MCP panel's refusal reasons.
mod agent_cli;
mod agent_context;
mod agent_history;
mod agent_install;
pub(crate) mod agent_tab;
mod agents;
mod blender_viewer;
pub mod canvas;
mod costs;
#[cfg(feature = "design-mode")]
mod design;
mod files;
mod godot_viewer;
mod home;
pub mod method_catalog;
// `pub(crate)`, for the same reason `apps::projects` is: `lib.rs` needs
// `apps::home_create::CreateManager` to `.manage()` it. `home::call` reaches
// straight into this module's `start`/`status` for its two `home/create-
// project*` methods, rather than this having a `Dispatch` of its own — the
// New Project page is still Home, and `REGISTRY` has one row for it.
pub(crate) mod home_create;
mod play;
// `pub(crate)` rather than private: `lib.rs` needs `apps::projects::WakeManager`
// to `.manage()` it, the same reason `design_comments::Comments` lives outside
// `apps::design` altogether — this one stays nested because nothing else in
// the crate needs it, only `lib.rs`'s one setup call.
pub(crate) mod projects;
#[cfg(feature = "schematify")]
mod schematify;
mod trash;
pub mod tutorial;

use crate::plugins;
use crate::project;
use crate::shell_state::ShellState;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// One app, as the switcher bar needs to see it.
///
/// `url` is included rather than left for the frontend to construct, for the
/// same reason `tool_frontend` hands back a resolved URL: the shell mounts what
/// it is given and never builds an iframe address by hand. Today every app's
/// URL follows one pattern, but that is a fact about how this repo happens to
/// build them, not a promise to the shell.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: String,
}

/// Where a call is happening: which cluster asked, and what that cluster is
/// working on.
///
/// The thing an app's Rust half could not previously know. `app_call` used to
/// carry an *app* id and nothing else, so Files could ask "what is the open
/// project" and get one answer for the whole process — which is exactly the
/// question that stops having a single answer the moment a project belongs to a
/// cluster. Two Files in two clusters must root at two different folders, and
/// nothing in a message body could tell them apart.
///
/// A struct rather than a bare `Option<PathBuf>` because it is going to grow:
/// `Cluster::worktree` is carried in the layout already and joins this as
/// `worktree: Option<WorktreeRef>` when Braden's git work lands. Adding a field
/// then touches this declaration and [`resolve`](Self::resolve) and nothing
/// else — where widening a positional parameter would touch every `Dispatch` in
/// the registry and every call site inside them.
#[derive(Debug, Clone, Default)]
pub struct CallContext {
    /// The cluster the calling surface is in. What Home *writes* a project to.
    ///
    /// `None` is an ordinary state rather than a failure: a call can arrive with
    /// no instance id (the shell's own menu actions) or from an instance whose
    /// tab has just closed. Home draws the pick-a-project state for it.
    pub cluster_id: Option<String>,
    /// That cluster's project, already checked against the disk. What Files
    /// *reads* a root from.
    ///
    /// `None` when nobody has pointed this cluster at a project yet — again an
    /// ordinary state, and Files falls back to the stack root for it.
    pub project: Option<PathBuf>,
}

impl CallContext {
    /// Work out where a call is coming from.
    ///
    /// `instance_id` is resolved against the pane trees — an instance is in
    /// whichever cluster's tree holds its id, and no second field records that,
    /// so there is exactly one answer. It is the trustworthy input: the shell
    /// resolves it from `event.source` against its own map of mounted iframes
    /// (`ToolWindow.tsx`), never from anything a frame asserts about itself.
    ///
    /// `cluster_id` is the fallback, and it is for the shell's own calls — File
    /// \> Open…, which is a title-bar menu item rather than a frame's request.
    /// The shell knows which cluster its window is showing and has no instance
    /// to name. It loses to a resolved instance deliberately: where both are
    /// present, the one derived from the frame is the one that cannot be stale.
    pub fn resolve(app: &AppHandle, instance_id: Option<&str>, cluster_id: Option<&str>) -> Self {
        let resolved = instance_id
            .and_then(|id| app.state::<ShellState>().cluster_of_instance(id))
            .or_else(|| cluster_id.map(str::to_owned));

        let project = resolved
            .as_deref()
            .and_then(|id| project::cluster_path(app, id));

        Self {
            cluster_id: resolved,
            project,
        }
    }

    /// The cluster to write a project into, or the refusal to hand back.
    ///
    /// Home's four opening methods all need one, and none of them has anything
    /// sensible to do without it: "open this folder" with no cluster to open it
    /// in is not a smaller version of the action, it is a different one. The
    /// message names the state rather than the code path, because the only way
    /// to reach it is a surface whose cluster closed underneath it.
    pub fn require_cluster(&self) -> Result<&str, RpcError> {
        self.cluster_id.as_deref().ok_or_else(|| {
            RpcError::new(
                veistra_rpc::INTERNAL_ERROR,
                "there is no cluster to open a project in — this surface is not in one any more",
            )
        })
    }
}

/// An app's Rust half: the function every `invoke` from its frontend lands in.
///
/// A function pointer and not a child process, deliberately, and not as a
/// shortcut. Home and Files exist to show what the orchestrator already knows —
/// the stack snapshot, the open project, the filesystem — and putting a pipe
/// between the shell and a process that would only have to ask the shell for it
/// all again ships an IPC boundary in order to talk to ourselves. A tool needs
/// that boundary because it is someone else's code on its own release cycle; an
/// app is this code.
///
/// `veistra/hello` never reaches one of these. The shell answers the handshake
/// itself in `ToolWindow.tsx` — it is the side that knows the session, and an
/// app that had to reimplement the reply could get it wrong.
type Dispatch = fn(&AppHandle, &CallContext, &str, Option<Value>) -> Result<Value, RpcError>;

struct Registered {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    call: Dispatch,
}

/// Every app this build ships, in the order they appear in the switcher bar.
///
/// Compiled in rather than declared in `veistra.toml`, because that manifest
/// answers a different question. It pins *other repositories* at versions this
/// orchestrator expects, and every state it can report — needs update, not
/// installed — is about a checkout that might not be there. An app is in the
/// binary. There is no version to disagree with and no way for it to be missing,
/// so a manifest entry for one would be a row that can only ever say "fine".
const REGISTRY: &[Registered] = &[
    Registered {
        id: "home",
        name: "Home",
        description: "Where a session starts — open a project, or pick up a recent one.",
        call: home::call,
    },
    Registered {
        id: "files",
        name: "File Explorer",
        description: "Browse the open project — its folders, and what is in them.",
        call: files::call,
    },
    Registered {
        id: "viewer",
        name: "File Viewer",
        description: "Read and edit open files, in tabs.",
        // **The same dispatch as `files` above, deliberately.**
        //
        // The two are separate *apps* — separate frontends, separate entry
        // points, separate surfaces you can put in two panes — but there is only
        // one filesystem, and `files::call` is the half that talks to it.
        // Giving the Viewer a Rust module of its own would mean a second
        // `files/read`, a second `files/write` and a second copy of the
        // `baseMtime` guard that keeps two writers from clobbering each other:
        // three chances for the pair to disagree, bought in exchange for the
        // appearance of symmetry.
        //
        // What this does *not* share is any state. `files::call` holds none —
        // every method takes its root from the [`CallContext`] the caller
        // resolved, which is a fact about where the *frame* is placed rather
        // than about which app is in it. So a Viewer and an Explorer in one
        // cluster resolve the same project, and the same worktree, while a pair
        // in the next cluster resolve theirs; see
        // `two_apps_in_one_cluster_resolve_the_same_context` below, which is
        // there to keep that true.
        call: files::call,
    },
    Registered {
        id: "godot-viewer",
        name: "Godot Viewer",
        description: "The scene an agent's headless Godot run last produced — read-only, node tree \
                      plus a viewport render.",
        // A fourth app sharing no dispatch with anything else: this is the
        // first of three (with `blender-viewer` and `play`) whose only real
        // work today is `crate::comments` — see `godot_viewer.rs`.
        call: godot_viewer::call,
    },
    Registered {
        id: "blender-viewer",
        name: "Blender Viewer",
        description: "Runs Blender headless on a .blend and shows what came out — preview renders, \
                      parts list and the .glb — with Open in Blender for the real editor.",
        call: blender_viewer::call,
    },
    Registered {
        id: "play",
        name: "Play",
        description: "Run the environment's debug build in a pane, and capture a comment on what \
                      you see.",
        call: play::call,
    },
    Registered {
        id: "canvas",
        // Shown as Design; the id, the `canvas/*` methods and `veistra://canvas/`
        // keep the old name so nothing that points at it breaks.
        name: "Design",
        description: "Draw the game's design on an Excalidraw canvas, stored in the environment's \
                      checkout as canvas/<name>.json.",
        // Not `design`: that id is the feature-gated Design Mode app, which
        // points at a running page. This is the design canvas of
        // `docs/VEISTRA-UX-REWORK.md` §5, and it is always compiled in.
        call: canvas::call_live,
    },
    Registered {
        id: "agent-tab",
        name: "Agent",
        description: "Run Claude in this cluster's worktree, and follow what it does.",
        // Reached with its instance through `call_for_instance` below; this
        // dispatch is the instance-free path, and answers one read.
        call: agent_tab::call,
    },
    Registered {
        id: "agents",
        name: "Agents",
        description: "Agent machines in Veistra Cloud, their sessions, and what each one did.",
        // Reads Google Cloud with the user's own gcloud login; see `cloud`.
        call: agents::call,
    },
    Registered {
        id: "costs",
        name: "Cost Tracker",
        description: "What Veistra Cloud has cost this month at list price, and the forecast against its budget.",
        // Read-only: inventory, Cloud Monitoring usage and the Billing Catalog.
        call: costs::call,
    },
    Registered {
        id: "projects",
        name: "Projects",
        description: "Switch between projects, and open the shared Plane workspace for one.",
        // Reads `gs://veistra-projects` the same way Agents reads Google Cloud,
        // and — once a project is picked — wakes and embeds Plane CE. See
        // `apps/projects.rs` and `VEISTRA-PLANE-DESIGN.md`.
        call: projects::call,
    },
    // Disabled by default; see `[features]` in `Cargo.toml`.
    #[cfg(feature = "design-mode")]
    Registered {
        id: "design",
        name: "Design Mode",
        description: "Point at a running page, click an element, and send it to an agent.",
        // The first app whose frontend mounts something this build did not
        // write. What it may mount, and what may be put inside it, is
        // `design::normalize` and `design::arm` — neither of which is a
        // decision the frontend is allowed to make.
        call: design::call,
    },
    // Disabled by default (ORC-SCO-001); see `[features]` in `Cargo.toml`.
    #[cfg(feature = "schematify")]
    Registered {
        id: "schematify",
        name: "Schematify",
        description: "The design layer of Veistra — draws the full-scale plan agents build from.",
        // Was going to ship as two separate repositories, each installed as a
        // tool. That plan is reversed and the two are folded into one: see
        // `apps/schematify.rs` and `docs/design/SCHEMATIFY-PRD.md` §1.3 for
        // why what it will show belongs to the orchestrator rather than to a
        // checkout beside it. This row is a skeleton — `schematify::call`
        // answers one placeholder method — registered now so the switcher, the
        // Apps menu and boot all already know its shape before anything is
        // built behind it.
        call: schematify::call,
    },
    Registered {
        id: "tutorial",
        name: "Tutorials",
        description: "Learn Veistra — short walkthroughs of the window, projects and the stack.",
        // Registered like any other app and deliberately never *listed*: the
        // frontend filters it and Home out of the Apps menu, both covering the
        // cluster rather than taking a pane. This row is still what makes
        // `veistra/open` resolve a frontend. See `docs/tutorials.md` §8.
        call: tutorial::call,
    },
];

/// Every app, for the switcher bar.
pub fn list() -> Vec<AppInfo> {
    REGISTRY
        .iter()
        .map(|a| AppInfo {
            id: a.id,
            name: a.name,
            description: a.description,
            url: entry_url(a.id),
        })
        .collect()
}

/// Whether an id names an app rather than a tool. `tool_frontend::resolve`
/// asks this first, so the two id spaces resolve through one door.
///
/// **[`TERMINAL_ID`] answers `false` here, and that is deliberate.** A terminal
/// is offered in the same menu as an app now (see [`openables`]) but it is not
/// one, and this function is what four separate things ask before deciding what
/// an id *is*: whether to mount a frontend, whether to look for a tool checkout,
/// whether a preset slot is valid, and which `SurfaceKind` to mint. Widening it
/// would send a terminal down every one of those paths, and each of them ends at
/// a frontend URL that does not exist.
pub fn is_app(id: &str) -> bool {
    REGISTRY.iter().any(|a| a.id == id)
}

// --- what you can open ------------------------------------------------------

/// The type name a terminal surface carries where an app surface carries its app
/// id — in `SurfaceInstance::app_id`'s position, and in an [`Openable`].
///
/// A name rather than a registry entry. It is here, beside `REGISTRY`, because
/// it has to be *excluded* from things far from here (`is_app`, `roster`, the
/// `call` dispatch) and a constant those can be checked against is better than
/// three copies of a string literal.
pub const TERMINAL_ID: &str = "terminal";

/// What kind of thing an [`Openable`] is, which is the same as saying *how the
/// shell opens it*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenableKind {
    /// Mint an instance and mount its frontend. `id` names a `REGISTRY` entry.
    App,
    /// Mint an instance and resolve its frontend *on demand*. `id` is a surface
    /// address — `<package>.<surface>` — naming something in the installed
    /// plugin registry rather than anything compiled in.
    ///
    /// Opened exactly as an `App` is, which is why this is a kind rather than a
    /// second list. What differs is where the two halves come from, and the
    /// shell needs to know: a first-party app's `invoke` is answered by [`call`]
    /// below, in this process, and a plugin's goes over the broker to its own.
    Plugin,
    /// Spawn a pty and put it in a pane. `id` is [`TERMINAL_ID`], which names no
    /// registry entry and never will.
    Terminal,
}

/// One row in the Apps menu.
///
/// **Note what is not on it: a `url`.** That is the whole reason this is not
/// [`AppInfo`]. A terminal has no frontend — no Vite entry point, no iframe, no
/// origin — it is an xterm canvas the shell draws itself, bound to a pty by id.
/// Giving it an empty or invented URL would put a blank iframe behind every
/// terminal and break the thing that actually renders it, because
/// `state/toolFrontend.ts` resolves a mountable URL straight off the app list.
///
/// A plugin surface has no `url` here for a different reason with the same
/// effect: it *has* a frontend, but where that frontend is served from can
/// change while the shell runs, so it is resolved on demand.
///
/// Owned `String`s rather than `&'static str` because a plugin's strings are
/// read from a manifest at runtime. Same wire shape either way.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Openable {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: OpenableKind,
}

/// Everything the Apps menu can open: every app, then a terminal.
///
/// A second list and not a wider `REGISTRY`, because `REGISTRY`'s definition of
/// an app is precise and load-bearing — a frontend that is an entry point of
/// this repo's own Vite build, and a Rust half in this module reached over
/// transport B — and a terminal has neither. A row there with an absent URL and
/// an absent dispatch would not be an app with two holes in it; it would be a
/// different kind of thing wearing an app's struct, and [`roster`], [`is_app`]
/// and [`call`] would each need a new branch to say so — three silent failures
/// rather than three compile errors. `docs/design-notes/backend-apps.md` spells
/// out what each of the three does today.
///
/// So the union happens here, in one function, and nowhere else. It is in this
/// file rather than in the frontend because the menu's list has always come from
/// Rust: an app added to `REGISTRY` appears in both menu surfaces without a
/// second edit in a file whose author would have no reason to look.
///
pub fn openables(app: &AppHandle) -> Vec<Openable> {
    // `resolve_enabled` has already dropped a plugin that will not load, so a
    // surface reaching here is one there is something to mount for.
    let installed = plugins::resolve_enabled(&app.state::<plugins::Registry>())
        .into_iter()
        .flat_map(|plugin| plugin.surfaces)
        // **Only what a plugin asked to have listed.** `present = "cover"` is
        // reachable by `veistra/open` and absent from both menus, as Home and
        // Tutorials already are. A package with *no* surfaces — an MCP server,
        // an indexer — contributes nothing, which is the whole answer to "there
        // should be no button offering to add a backend".
        .filter(|surface| surface.listed)
        .map(|surface| Openable {
            id: surface.address,
            name: surface.name,
            description: surface.description,
            kind: OpenableKind::Plugin,
        })
        .collect();

    compose_openables(installed)
}

/// The ordering rule on its own: apps first, plugins next, terminal always last.
///
/// The terminal comes last because the apps are the things this build is *about*
/// and the ordering should not shuffle when one is added.
///
/// Split out from [`openables`] because that one needs an `AppHandle` and this
/// needs nothing, so the rule can be tested against a synthetic plugin list
/// rather than against whatever happens to be installed on the machine running
/// `cargo test`.
fn compose_openables(installed: Vec<Openable>) -> Vec<Openable> {
    REGISTRY
        .iter()
        // A page's app is reached through its chip, never opened into a pane.
        .filter(|a| !crate::pages::is_page_app(a.id))
        .map(|a| Openable {
            id: a.id.to_string(),
            name: a.name.to_string(),
            description: a.description.to_string(),
            kind: OpenableKind::App,
        })
        .chain(installed)
        .chain(std::iter::once(Openable {
            id: TERMINAL_ID.to_string(),
            name: "Terminal".to_string(),
            // Says *where it lands*, because that is the one thing that is not
            // obvious: the panel already has a "+" that makes a terminal, and
            // this makes a different one. See `commands::open_terminal_in_pane`.
            description: "A shell in a pane of this cluster, rather than in the panel.".to_string(),
            kind: OpenableKind::Terminal,
        }))
        .collect()
}

// [`is_app`] is deliberately *not* widened to cover plugins, and the gap that
// leaves is real: `presets::PresetNode::normalized` filters a preset's slots
// through it, so **a layout preset cannot hold a plugin surface**. Not new and
// not plugin-specific — a preset could never hold a tool either, by that same
// line. Fixing it means threading an `AppHandle` into `normalized`, which is a
// pure function today and tested as one.

/// What a new instance of `id` is called, before its own frontend renames the
/// tab. Falls back to the id, which is what a surface with no registry entry
/// would have shown anyway and is better than an untitled tab.
///
/// Looks through [`openables`] rather than `REGISTRY` alone so a plugin surface
/// gets its declared name too. The fallback still matters and is now more
/// reachable than it was: a plugin whose checkout has gone missing has no
/// manifest to read a name out of, and a tab reading `acme.specs` is a better
/// answer than an empty one.
pub fn display_name(app: &AppHandle, id: &str) -> String {
    openables(app)
        .into_iter()
        .find(|o| o.id == id)
        .map(|o| o.name)
        .unwrap_or_else(|| id.to_string())
}

/// Every app's id and display name, for boot.
///
/// `list` would answer this too, but it builds a URL per app that nobody there
/// wants — and boot asks twice (once for the step count, once for the set it is
/// still waiting on), so it gets the two fields it actually reads. The name is
/// in it because the splash says "Starting Home and Files" rather than naming
/// the ids only a developer knows.
pub fn roster() -> Vec<(&'static str, &'static str)> {
    REGISTRY.iter().map(|a| (a.id, a.name)).collect()
}

/// Where an app's frontend is served from.
///
/// Root-relative on purpose, so it resolves against whatever origin the shell
/// itself is on — a Vite dev server in development, Tauri's asset host in a
/// release build — and this never has to know which of those it is. That works
/// because an app's `index.html` is an entry point of the shell's own Vite
/// build (see `vite.config.ts`), so it lands at the same path in `dist/` that it
/// occupies in the source tree.
///
/// The consequence worth naming: an app frame is *same-origin* with the shell,
/// where a tool frame deliberately is not. The protocol's identity rule does not
/// depend on that — `ToolWindow` resolves which surface sent a message from
/// `event.source` against its own map of mounted iframes, never from the
/// message body or its origin — but a tool is untrusted code and an app is not,
/// and only the first of those earns the cost of a separate origin.
pub fn entry_url(id: &str) -> String {
    format!("/apps/{id}/ui/index.html")
}

/// Route one `invoke` from an app's frontend to that app's Rust half.
///
/// `id` still names the *app*, because that is what decides which code answers:
/// `apps::REGISTRY` has one entry for Files however many Files are open, and
/// none of them holds per-instance state. What the instance decides is not
/// which handler runs but *where* it runs — see [`CallContext`], which the
/// caller has already resolved.
///
/// This is the half an app does *not* share with a tool; the *frontend* contract
/// it does. An app's UI imports `@veistra/bridge` and calls `invoke("home/stack")`
/// exactly as a tool's UI calls `invoke("echo")`, and neither one knows which
/// kind of host answered. So an app can become a tool later — or a tool be
/// absorbed into the shell — without its interface code changing.
pub fn call(
    app: &AppHandle,
    context: &CallContext,
    id: &str,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    // Answered by the host, before the app is looked up at all. See
    // `docs/settings.md` §7 for why this is central rather than per-app.
    if method == SETTINGS_METHOD {
        return serde_json::to_value(app.state::<crate::settings::Registry>().snapshot())
            .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not read settings: {e}")));
    }

    // An app changing one of its own listed settings; see `settings::APP_WRITABLE`.
    if method == crate::settings::APP_SET_METHOD {
        return crate::settings::app_set(app, params.as_ref());
    }

    // An app asking the shell to show its section of Settings; see
    // [`OPEN_SETTINGS_METHOD`]. Host-answered because an app has no door to the
    // shell's React tree, and the section is the shell's to draw.
    if method == OPEN_SETTINGS_METHOD {
        let section = settings_section(params.as_ref())?;
        let _ = app.emit(OPEN_SETTINGS_EVENT, json!({ "section": section }));
        return Ok(json!({ "section": section }));
    }

    // Typing context references at the agent's prompt needs the terminals, which
    // the store (`context.rs`) deliberately knows nothing about.
    if method == crate::context_commands::INSERT_METHOD {
        return crate::context_commands::insert_for_cluster(
            app,
            context.cluster_id.as_deref(),
            params,
        );
    }

    // The context store, likewise answered by the host so every app (and every
    // plugin surface) reaches one implementation. Deliberately *before* the
    // write refusal: `.veistra/context/` is Veistra's own gitignored state, not the
    // checkout, so a read-only main may still collect context. See `context.rs`.
    if crate::context::is_method(method) {
        let result = crate::context::call(context.project.as_deref(), id, method, params);
        if let (Ok(_), Some(root)) = (&result, context.project.as_deref()) {
            if matches!(method, "context/put" | "context/remove") {
                crate::context::notify(app, root);
            }
        }
        return result;
    }

    // `veistra://` references, resolved by the host so the rules in
    // `refs::policy` sit in one place. Read-only, so before the write refusal.
    // First-party apps only: a plugin's method of the same name is its own.
    if crate::refs::is_method(method) && is_app(id) {
        return crate::refs::call(app, context, id, method, params);
    }

    if let Some(registered) = REGISTRY.iter().find(|a| a.id == id) {
        // One choke point for every first-party write, whoever is calling: the
        // app's own frontend, the shell's menu, or an agent over MCP `app_call`
        // all arrive here with a resolved cluster.
        if let Some(cluster) = context.cluster_id.as_deref() {
            let env = app.state::<ShellState>().cluster_write_environment(cluster);
            write_refusal(env.as_ref(), method)?;
        }
        return (registered.call)(app, context, method, params);
    }

    // Not a first-party app, so the answer is not in this process. A plugin
    // surface's call goes down the broker to its own package's core — the other
    // half of the symmetry this module's doc claims, and the path
    // `docs/tool-protocol.md` was written to describe. Until it existed this
    // line was a `METHOD_NOT_FOUND` and `ToolWindow.tsx` refused the call before
    // it ever got here.
    //
    // `CallContext` is deliberately *not* forwarded. It resolves a cluster and
    // that cluster's project — facts about this shell's layout — and a core is
    // told about the world it opened into through `session` in `veistra/hello`
    // instead. Handing a plugin the shell's internal vocabulary would make the
    // layout part of the plugin contract, which §3 of the protocol is shaped to
    // avoid; when a core needs to know about a project, `Session` is the field
    // that grows.
    if plugins::split_address(id).is_some() {
        return plugins::broker::call(app, id, method, params);
    }

    Err(RpcError::new(
        METHOD_NOT_FOUND,
        format!("no app or plugin surface with id `{id}`"),
    ))
}

/// [`call`], for a caller that knows which instance asked — the shell's
/// `app_call` command, and nothing else. The agent tab is the one app whose
/// state belongs to an instance rather than to its cluster, so it is the one
/// app that is handed it; every other call carries on through [`call`].
pub fn call_for_instance(
    app: &AppHandle,
    context: &CallContext,
    instance_id: Option<&str>,
    id: &str,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if id != agent_tab::ID || !method.starts_with("agent-tab/") {
        return call(app, context, id, method, params);
    }
    // The same choke point `call` applies to every registered app.
    if let Some(cluster) = context.cluster_id.as_deref() {
        let env = app.state::<ShellState>().cluster_write_environment(cluster);
        write_refusal(env.as_ref(), method)?;
    }
    agent_tab::call_for(app, context, instance_id, method, params)
}

/// The JSON-RPC code for a write refused because the cluster is on main.
/// Outside the range `veistra_rpc` reserves; the bridge hands it to the app
/// unchanged and the message is what gets shown.
pub const READ_ONLY: i32 = -32003;

/// Every first-party app method that changes something inside the cluster's
/// checkout. A method missing from here is treated as a read, which is why
/// `every_write_shaped_method_is_listed` scans the apps' own sources.
///
/// Not listed on purpose: `home/worktree-create` (the way out of a read-only
/// main), the `home/*-project` openers (they repoint a cluster, they do not
/// write to a checkout), and everything that touches user data rather than the
/// project (`tutorial/*`, `costs/*`, `projects/*`).
pub const WRITE_METHODS: &[&str] = &[
    "files/write",
    "files/create-file",
    "files/create-dir",
    "files/rename",
    "files/duplicate",
    "files/save-as",
    "files/delete",
    "files/import",
    "trash/restore",
    "trash/purge",
    "home/initialize-project",
    "comments/create",
    "comments/resolve",
    "comments/verdict",
    "schematify/write-node",
    "schematify/write-edge",
    "schematify/write-layout",
    "schematify/write-screen",
    "schematify/write-flow",
    "schematify/write-brief",
    "schematify/write-decision",
    "schematify/supersede-decision",
    "schematify/transition",
    "schematify/ingest-run",
    "godot/open-editor",
    "play/addon-install",
    "play/addon-remove",
    "play/send",
    "canvas/create",
    "canvas/write",
    "canvas/save",
    "canvas/add-shapes",
    "canvas/import-mermaid",
    "canvas/set-values",
    "canvas/set-design",
    "canvas/restore-checkpoint",
    "canvas/create-comment",
    "canvas/resolve-comment",
    "canvas/reopen-comment",
    "canvas/save-type",
    "canvas/delete-type",
    "canvas/set-parent",
    "canvas/link-frame",
    "canvas/set-frame",
    "canvas/create-frame",
    "canvas/split-frames",
    // An agent edits the checkout it runs in, and an approval lets it; so
    // does a mode that accepts edits unasked. The model and effort are set
    // with the mode.
    "agent-tab/send",
    "agent-tab/cli-command",
    "agent-tab/btw-send",
    "agent-tab/btw-answer",
    "agent-tab/answer",
    "agent-tab/set-mode",
    "agent-tab/set-config",
];

/// Whether `method` is a write to the cluster's checkout.
pub fn is_write_method(method: &str) -> bool {
    WRITE_METHODS.contains(&method)
}

/// The refusal for an app call, or `Ok` if it may run. Pure, so it is tested
/// without an app handle; [`call`] supplies the cluster's environment.
pub fn write_refusal(
    env: Option<&crate::environments::Environment>,
    method: &str,
) -> Result<(), RpcError> {
    if !is_write_method(method) {
        return Ok(());
    }
    crate::environments::refuse_write_on_main(env, method)
        .map_err(|e| RpcError::new(READ_ONLY, e.to_string()))
}

/// What any app frontend calls to read the settings, over the ordinary bridge.
///
/// A method rather than a Tauri command because an app has no door to Tauri, and
/// because a tool in its own process will want the same call later.
pub const SETTINGS_METHOD: &str = "settings/all";

/// What an app calls to open Settings on a section, e.g. `{"section": "canvas"}`.
pub const OPEN_SETTINGS_METHOD: &str = "shell/open-settings";

/// The event the shell listens for. Mirrored by `OPEN_SETTINGS_EVENT` in
/// `src/bindings.ts`.
pub const OPEN_SETTINGS_EVENT: &str = "settings:open";

/// The section a `shell/open-settings` call names: one the registry could hold,
/// or none (open where it was last). A typo is refused here rather than landing
/// on the first section without a word.
fn settings_section(params: Option<&Value>) -> Result<Option<String>, RpcError> {
    let Some(section) = params.and_then(|p| p.get("section")) else {
        return Ok(None);
    };
    let known = |id: &str| {
        settings_groups().iter().any(|g| g.id == id)
            || crate::settings::shell_group_ids().any(|shell| shell == id)
    };
    match section.as_str() {
        Some(id) if known(id) => Ok(Some(id.to_string())),
        Some(id) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("there is no settings section `{id}`"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "`section` must be a string")),
    }
}

/// Every settings section an app declares — `docs/settings.md` §6. Deliberately
/// not a field on [`Registered`], so that a *tool* can register through this
/// same list without ever being in `REGISTRY`.
pub fn settings_groups() -> &'static [&'static crate::settings::Group] {
    APP_SETTINGS
}

static APP_SETTINGS: &[&crate::settings::Group] = &[
    &files::SETTINGS,
    &canvas::SETTINGS,
    &crate::blender::SETTINGS,
    &crate::godot::SETTINGS,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_settings_accepts_a_known_section_and_refuses_a_typo() {
        let section = |v: Value| settings_section(Some(&v));
        assert_eq!(
            section(json!({ "section": "canvas" })).unwrap().as_deref(),
            Some("canvas")
        );
        assert_eq!(
            section(json!({ "section": "appearance" }))
                .unwrap()
                .as_deref(),
            Some("appearance")
        );
        assert_eq!(settings_section(None).unwrap(), None);
        assert!(section(json!({ "section": "cnavas" })).is_err());
        assert!(section(json!({ "section": 3 })).is_err());
    }

    #[test]
    fn the_canvas_section_is_registered_with_a_select_per_knob() {
        let group = settings_groups().iter().find(|g| g.id == "canvas").unwrap();
        let keys: Vec<&str> = group.settings.iter().map(|s| s.key).collect();
        assert_eq!(keys, ["canvas.detailLevel", "canvas.style"]);
    }
    use crate::environments::Environment;

    fn worktree() -> Environment {
        Environment::LocalWorktree {
            name: "x".to_string(),
            path: "C:/wt/x".to_string(),
            branch: "wt/x".to_string(),
            base: "main".to_string(),
        }
    }

    /// Each app family that writes: Files, Trash, Schematify, viewer comments
    /// and Home's initialize. Main refuses with the read-only code; a worktree,
    /// and a cluster with no environment, allow.
    #[test]
    fn every_write_method_refuses_main_and_allows_a_worktree() {
        for method in WRITE_METHODS {
            let err = write_refusal(Some(&Environment::Main), method).unwrap_err();
            assert_eq!(err.code, READ_ONLY, "{method}");
            assert!(write_refusal(Some(&worktree()), method).is_ok(), "{method}");
            assert!(write_refusal(None, method).is_ok(), "{method}");
        }
    }

    /// Context is allowed on main by design (it is gitignored, and nothing
    /// tracked changes), so no context method may sit in the refusal list.
    #[test]
    fn context_methods_are_never_write_refused() {
        for method in [
            "context/put",
            "context/list",
            "context/get",
            "context/remove",
        ] {
            assert!(crate::context::is_method(method), "{method}");
            assert!(!WRITE_METHODS.contains(&method), "{method}");
            assert!(
                write_refusal(Some(&Environment::Main), method).is_ok(),
                "{method}"
            );
        }
    }

    #[test]
    fn reads_still_work_on_main() {
        for method in [
            "files/read",
            "files/list",
            "files/git-status",
            "trash/list",
            "comments/list",
            "schematify/load-graph",
            "schematify/lint",
            "home/worktree-create",
        ] {
            assert!(write_refusal(Some(&Environment::Main), method).is_ok());
        }
    }

    /// A ratchet on the table: any method in these apps whose verb says it
    /// writes has to be in [`WRITE_METHODS`], so a new `files/move` cannot
    /// quietly land as a read.
    #[test]
    fn every_write_shaped_method_is_listed() {
        let sources = [
            include_str!("files.rs"),
            include_str!("trash.rs"),
            include_str!("schematify.rs"),
            include_str!("home.rs"),
            include_str!("canvas/mod.rs"),
            include_str!("canvas/methods.rs"),
            include_str!("../comments.rs"),
        ];
        let verbs = [
            "write",
            "create",
            "delete",
            "rename",
            "duplicate",
            "save",
            "restore",
            "purge",
            "transition",
            "ingest",
            "supersede",
            "initialize",
            "resolve",
            "move",
            "remove",
        ];
        for source in sources {
            let production = source.split("#[cfg(test)]").next().unwrap();
            for line in production.lines() {
                let Some(start) = line.find('"') else {
                    continue;
                };
                let rest = &line[start + 1..];
                let Some(end) = rest.find('"') else { continue };
                let method = &rest[..end];
                if !line.contains("=>") || method.matches('/').count() != 1 {
                    continue;
                }
                let (app, verb) = method.split_once('/').unwrap();
                let plain = app.chars().all(|c| c.is_ascii_lowercase() || c == '-');
                let shaped = verbs.iter().any(|v| verb.starts_with(v));
                if plain && shaped && !method.contains(' ') {
                    // `create-project` builds a new folder elsewhere, and
                    // `home/open-*` opens; neither writes into the checkout.
                    if method.starts_with("home/create-project") {
                        continue;
                    }
                    assert!(is_write_method(method), "{method} looks like a write");
                }
            }
        }
    }

    /// Ids reach the frontend as URL path segments and as the key the shell
    /// routes messages by, so a duplicate would mean two surfaces answering to
    /// one name — with `find` silently picking the first.
    #[test]
    fn app_ids_are_unique() {
        let mut ids: Vec<&str> = REGISTRY.iter().map(|a| a.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(total, ids.len(), "duplicate app id in the registry");
    }

    /// The same rule `veistra-tool.toml` holds tools to (`^[a-z][a-z0-9-]*$`),
    /// applied here for the same reason: an id ends up in a URL.
    #[test]
    fn app_ids_are_url_safe() {
        for app in REGISTRY {
            let mut chars = app.id.chars();
            assert!(
                matches!(chars.next(), Some(c) if c.is_ascii_lowercase()),
                "app id {:?} must start with a lowercase letter",
                app.id
            );
            assert!(
                chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "app id {:?} must match ^[a-z][a-z0-9-]*$",
                app.id
            );
        }
    }

    #[test]
    fn an_unknown_app_id_is_method_not_found_rather_than_a_panic() {
        assert!(!is_app("nonesuch"));
    }

    /// ORC-SCO-001: a default build offers no Schematify tab.
    #[cfg(not(feature = "schematify"))]
    #[test]
    fn schematify_is_not_registered_without_its_feature() {
        assert!(!is_app("schematify"));
        assert!(list().iter().all(|a| a.id != "schematify"));
    }

    /// Design Mode is off by default; see `docs/design-notes/design-mode.md`.
    #[cfg(not(feature = "design-mode"))]
    #[test]
    fn design_mode_is_not_registered_without_its_feature() {
        assert!(!is_app("design"));
        assert!(list().iter().all(|a| a.id != "design"));
    }

    // --- the Explorer and the Viewer are answered by one filesystem ----------

    /// The two file apps dispatch to the *same* function, and that is what
    /// makes their `CallContext` provably identical rather than merely
    /// probably identical.
    ///
    /// [`CallContext::resolve`] takes the instance id the shell resolved from
    /// `event.source` and asks which cluster's pane tree holds it. Nothing on
    /// that path — not `resolve`, not `cluster_of_instance`, not
    /// `project::cluster_path` — is handed an app id, so a `viewer` frame
    /// resolves the same project, and the same worktree, as a `files` frame
    /// beside it. This test cannot reach into that path (it needs an
    /// `AppHandle`), but it guards what would make the argument stop holding:
    /// the day the Viewer gets a dispatch of its own is the day it could start
    /// resolving a root differently, and this fails then rather than silently.
    ///
    /// Why it matters: `files/git-status`, `files/git-hunks` and
    /// `files/git-head` decorate against whatever checkout the context names. A
    /// Viewer that resolved a different one would draw a dirty-diff gutter
    /// against the wrong worktree — no error, no failed call, just wrong hunks,
    /// the shape of bug that outlives everyone who could recognise it.
    #[test]
    fn two_apps_in_one_cluster_resolve_the_same_context() {
        let dispatch = |id: &str| {
            REGISTRY
                .iter()
                .find(|a| a.id == id)
                .unwrap_or_else(|| panic!("no `{id}` in the registry"))
                .call
        };

        assert_eq!(
            dispatch("files") as usize,
            dispatch("viewer") as usize,
            "the Explorer and the Viewer must be answered by one implementation — \
             two would be two chances to resolve a different root for the same cluster"
        );
    }

    /// Both file apps are real registry rows, and the Viewer is not a terminal
    /// in disguise: it has a frontend to mount and a dispatch to call, so every
    /// consumer of `REGISTRY` treats it as an app without a special case.
    #[test]
    fn the_viewer_is_an_app_like_any_other() {
        assert!(is_app("viewer"));
        assert!(is_app("files"));
        assert!(
            compose_openables(Vec::new())
                .iter()
                .any(|o| o.id == "viewer" && o.kind == OpenableKind::App),
            "the Apps menu offers it"
        );
        assert!(
            roster().iter().any(|(id, _)| *id == "viewer"),
            "boot knows it can paint — `boot::expected` narrows the roster to what is \
             actually open, so this costs a launch nothing when no Viewer is docked"
        );
    }

    // --- the terminal is offered like an app and is not one ------------------

    /// How many registry rows the Apps menu offers: all of them but the pages'.
    fn offered_apps() -> usize {
        REGISTRY
            .iter()
            .filter(|a| !crate::pages::is_page_app(a.id))
            .count()
    }

    #[test]
    fn every_app_but_a_page_is_offered_plus_a_terminal() {
        let composed = compose_openables(Vec::new());
        let offered: Vec<&str> = composed.iter().map(|o| o.id.as_str()).collect();
        for app in REGISTRY {
            assert_eq!(
                offered.contains(&app.id),
                !crate::pages::is_page_app(app.id),
                "{} is offered if and only if it is not a page",
                app.id
            );
        }
        assert_eq!(
            offered.last(),
            Some(&TERMINAL_ID),
            "the terminal comes last, after the apps"
        );
        assert_eq!(offered.len(), offered_apps() + 1);
    }

    /// Agents is a page: its chip in the cluster bar is the only way in.
    #[test]
    fn a_page_app_is_not_in_the_apps_menu() {
        assert!(is_app("agents"), "still registered, so its frame mounts");
        assert!(!compose_openables(Vec::new())
            .iter()
            .any(|o| o.id == "agents"));
    }

    // --- plugin surfaces sit between the apps and the terminal ---------------

    fn plugin_row(address: &str) -> Openable {
        Openable {
            id: address.to_string(),
            name: address.to_string(),
            description: String::new(),
            kind: OpenableKind::Plugin,
        }
    }

    /// The terminal's position is the invariant, not "last of the compiled-in
    /// things". A plugin row appended after it would put the Apps menu's one
    /// non-app entry in the middle of the list, which is exactly the shuffle
    /// [`compose_openables`] documents itself as preventing.
    #[test]
    fn the_terminal_stays_last_once_plugins_are_offered() {
        let composed = compose_openables(vec![plugin_row("acme.specs")]);

        assert_eq!(composed.last().map(|o| o.id.as_str()), Some(TERMINAL_ID));
        assert_eq!(composed.len(), offered_apps() + 2);

        let plugin_at = composed
            .iter()
            .position(|o| o.id == "acme.specs")
            .expect("the plugin surface is offered");
        assert_eq!(
            plugin_at,
            offered_apps(),
            "plugins come after every app and before the terminal"
        );
    }

    /// A plugin surface must not be mistaken for a first-party app anywhere
    /// downstream: the kind is what `open_instance` reads to decide whether an
    /// `invoke` from the frame is answered in this process or over the broker.
    #[test]
    fn a_plugin_surface_is_not_an_app() {
        let composed = compose_openables(vec![plugin_row("acme.specs")]);
        let row = composed
            .iter()
            .find(|o| o.id == "acme.specs")
            .expect("offered");

        assert_eq!(row.kind, OpenableKind::Plugin);
        assert!(!is_app("acme.specs"), "and `is_app` stays narrow");
    }

    /// The boot roster is what the splash blocks on until each app reports a
    /// painted frame. A terminal has no frame to report, so a terminal in here
    /// is a launch that waits out the full timeout every single time.
    #[test]
    fn the_terminal_is_not_in_the_boot_roster() {
        assert!(
            !roster().iter().any(|(id, _)| *id == TERMINAL_ID),
            "boot would wait for a paint that can never come"
        );
    }

    /// `is_app` gates `tool_frontend::resolve`, the `SurfaceKind` an instance is
    /// minted with, and whether a preset slot is valid. A `true` here would send
    /// a terminal looking for a frontend URL it does not have.
    #[test]
    fn the_terminal_is_not_an_app_however_it_is_offered() {
        assert!(!is_app(TERMINAL_ID));
    }

    /// A terminal has no Rust half. Reaching the dispatcher with its id has to
    /// be an ordinary method-not-found, not a panic and not the wrong row.
    #[test]
    fn calling_the_terminal_id_is_method_not_found() {
        let registered = REGISTRY.iter().find(|a| a.id == TERMINAL_ID);
        assert!(
            registered.is_none(),
            "`call` finds no row, so it answers METHOD_NOT_FOUND like any unknown id"
        );
    }
}
