//! The Home app's Rust half — projects.
//!
//! Home is where a session starts, and what a session starts *on* is a project.
//! So this is a thin layer over `crate::project`: it picks folders, and it turns
//! that module's `Result<ProjectSnapshot>` into the JSON-RPC shape an app's
//! frontend receives. The rules about what a project is live there, not here.
//!
//! The dialogs live here, and `crate::project` never opens one. That module
//! takes paths and touches the filesystem, which makes it testable and makes
//! "open this project" a thing the rest of the orchestrator can do without a
//! human at the keyboard — a command line flag, a recent-projects jump list, a
//! `.veistra` file double-clicked in Explorer. Choosing a folder by pointing at it
//! is a *user interface* act, and this module is Home's user interface half.

use crate::apps::CallContext;
use crate::branding;
use crate::error::AppError;
use crate::git;
use crate::plugins;
use crate::project::{self, ProjectSnapshot};
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// Every method here is scoped to the cluster that called it.
///
/// A project belongs to a cluster (see `crate::project`'s module doc), and Home
/// is opened *inside* one — so picking a folder here points **this** cluster at
/// it and touches no other. That is the whole of the per-cluster feature from
/// the user's side: two Home surfaces in two clusters, two projects, at once.
///
/// The cluster is never taken from the request body. It is [`CallContext`],
/// resolved by the shell from the frame the message arrived on and then by Rust
/// from the pane tree holding that instance — the same identity rule
/// `ToolWindow` applies to everything else a frame sends. A `clusterId` in
/// `params` would be a claim, and a Home in cluster A could make it about
/// cluster B.
pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    match method {
        "home/state" => state(app, context),

        // The account panel and the sign-in screen Home stands behind.
        m if m.starts_with("account/") => crate::account::methods::call(app, m, params),

        // The Docs column: the first pages of the index the Docs app reads
        // from veistra.com, so the site decides which ones Home offers.
        // Separate from `home/state` on purpose: this one is a network read
        // that may be slow or offline, and `home/state` is the answer Home
        // cannot draw without.
        "home/docs" => Ok(super::docs::summary(app)),

        // The cluster is required *before* the picker goes up, not after. A
        // dialog raised for a cluster that is no longer there would take a
        // folder choice and then have nowhere to put it, which is a worse
        // failure than declining to ask.
        "home/new-project" => {
            let cluster = context.require_cluster()?;
            match pick(app, "Choose a folder for the new project") {
                Some(dir) => shape(project::create(app, &dir, cluster).map_err(rpc)?),
                None => state(app, context),
            }
        }

        "home/open-project" => {
            let cluster = context.require_cluster()?;
            match pick(app, &format!("Open a {} project", branding::product_name())) {
                Some(dir) => shape(project::open(app, &dir, cluster).map_err(rpc)?),
                None => state(app, context),
            }
        }

        // Stubbed on purpose. Cloning is a git operation with progress, auth
        // prompts and a partial-checkout failure mode, and this repo already has
        // git work in flight on its own branch — the real one is built on top of
        // that rather than beside it. The method exists so the seam is visible
        // from both halves; the frontend keeps the action disabled.
        "home/clone-project" => Err(RpcError::new(
            INTERNAL_ERROR,
            "cloning is not built yet — clone the repository yourself, then use Open Project",
        )),

        "home/open-recent" => shape(
            project::open(
                app,
                &path_param(params.as_ref())?,
                context.require_cluster()?,
            )
            .map_err(rpc)?,
        ),
        "home/initialize-project" => shape(
            project::initialize(
                app,
                &path_param(params.as_ref())?,
                context.require_cluster()?,
            )
            .map_err(rpc)?,
        ),
        // The one exception to the cluster scoping above, and only half of one:
        // the Recent list is global, so forgetting is global too. No
        // `require_cluster` — it works whether or not the caller is in a
        // cluster, and the context only decides whose open project the returned
        // snapshot reports, because that is what Home redraws with.
        "home/forget-recent" => shape(project::forget(
            app,
            &path_param(params.as_ref())?,
            context.cluster_id.as_deref(),
        )),
        "home/close-project" => shape(project::close(app, context.require_cluster()?)),

        // A project's `.veistra/icon.*` as a `data:` URL, or null for the letter
        // tile — the same answer the shell's `project_icon` command gives, for a
        // pane that can only reach Rust through this dispatcher. Read-only:
        // setting one needs a picker, and Home's pickers are for folders.
        "home/project-icon" => Ok(json!({
            "icon": project::icon::data_url(&path_param(params.as_ref())?),
        })),

        // Opens the shell's app library rather than a folder picker.
        //
        // A `home/*` method rather than a Tauri command, because Home is an
        // *app*: STANDARDS.md §1.4 has apps reach the shell only through
        // `@veistra/bridge`. It cannot touch the shell's React tree either, so
        // "show me the library" goes app -> Rust -> event -> shell, which is
        // the same path `veistra/open` takes and for the same reason.
        //
        // The folder picker is still reachable, from inside the library, beside
        // the other two ways in rather than being the only one.
        "home/install-plugin" => {
            let _ = app.emit(plugins::LIBRARY_OPEN_EVENT, ());
            state(app, context)
        }

        // Whether this cluster could work in a worktree, and whether it already
        // is. Home asks after every open so it knows whether to offer one, and
        // the answer is deliberately a separate round trip rather than a field
        // on the snapshot: `git rev-parse` is a process spawn, and every other
        // caller of `home/state` — every redraw of the Recent list — would pay
        // for it to render a heading.
        "home/worktree-state" => worktree_state(app, context),
        "home/worktree-create" => {
            let cluster = context.require_cluster()?;
            let name = name_param(params.as_ref())?;
            git::git_worktree_create(app.clone(), cluster.to_string(), name).map_err(rpc)?;
            worktree_state(app, context)
        }

        // The New Project page (board 14) — a view inside Home, not a
        // separate app, so its two methods dispatch through this same `call`
        // rather than getting a `REGISTRY` row of their own. The step-runner
        // itself lives in `apps::home_create`; see its module doc for why.
        "home/create-project" => super::home_create::start(app, context, params),
        "home/create-project-status" => super::home_create::status(app),

        // The New Project page's optional Browse button, for the folder and
        // clone-to fields. Reuses `pick` exactly as `home/new-project` and
        // `home/open-project` do — same modal-to-the-window folder dialog,
        // just answering with the chosen path instead of acting on it, since
        // this page decides what to do with a folder itself. `None` on a
        // cancel, same as everywhere else `pick` is used.
        "home/browse-folder" => Ok(json!({
            "path": pick(app, "Choose a folder").map(|dir| dir.display().to_string()),
        })),

        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

/// Everything Home draws, in one round trip.
///
/// One method rather than one per region, because the alternative is a page that
/// renders three times as three calls land, and there is nothing here expensive
/// enough for that to buy anything.
///
/// `open` is this cluster's project and `recents` is everyone's, which is not an
/// inconsistency in the payload but the two scopes the model actually has.
fn state(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let mut value = shape(project::snapshot(app, context.cluster_id.as_deref()))?;

    // The stack's version, for the heading. All that is left of the component
    // list Home used to draw — the shell's warning badge is where stack health
    // is reported now, and saying it twice made neither one the place to look.
    // `None` before the boot scan lands, which the heading simply omits.
    let version = app.state::<AppState>().get().map(|s| s.stack_version);
    if let Some(object) = value.as_object_mut() {
        object.insert("version".to_string(), json!(version));
    }

    Ok(value)
}

fn shape(snapshot: ProjectSnapshot) -> Result<Value, RpcError> {
    serde_json::to_value(snapshot).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the project state could not be serialized: {e}"),
        )
    })
}

/// Ask the OS for a folder. `None` means the user cancelled.
///
/// Cancelling is not an error. Every method that opens one of these returns the
/// unchanged snapshot when the user backs out, because a JSON-RPC error would
/// make the frontend draw a failure for something the user did on purpose.
///
/// Two things here are load-bearing:
///
/// **It must not run on the main thread.** `rfd`'s synchronous picker runs its
/// own message loop, so on the main thread it would be waiting for the very
/// thread it is occupying and the app would hang with no dialog on screen.
/// `commands::app_call` moves every app call to a blocking worker — see the note
/// there — which is what makes this safe.
///
/// **The parent is set.** Without an owner window the picker is a separate
/// top-level window: it can fall behind the app, and alt-tab treats it as a
/// second application. With one it is modal to Veistra, which is what a person
/// opening a project expects. It opens where the last one did, so this passes no
/// starting directory — the OS remembers better than we would.
fn pick(app: &AppHandle, title: &str) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder()
}

/// Whether this cluster can be put on a worktree, and whether it already is.
///
/// Three fields, and the frontend needs all three to decide what to draw:
/// `isRepo` is false for a project that is not under git at all, which is the
/// case where the offer must not appear; `worktree` being set means this cluster
/// is already working in one, so the offer would be asking a second time; and
/// `taken` lets the dialog reject a duplicate name as the user types rather than
/// after a round trip that has already failed.
///
/// An unopened project answers the same as a non-repository. Both mean "there is
/// nothing to offer here", and Home draws nothing for either.
fn worktree_state(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let Some(cluster) = context.cluster_id.as_deref() else {
        return Ok(json!({ "isRepo": false, "worktree": null, "taken": [] }));
    };

    // `git_worktrees` already answers an empty list for "no project" and "not a
    // repository" alike, so the one call covers every case that is not an
    // outright git failure.
    let worktrees = git::git_worktrees(app.clone(), cluster.to_string()).map_err(rpc)?;

    let taken: Vec<&str> = worktrees
        .iter()
        .filter_map(|w| w.branch.as_deref())
        .collect();

    let current = app
        .state::<crate::shell_state::ShellState>()
        .cluster_worktree(cluster);

    Ok(json!({
        "isRepo": !worktrees.is_empty(),
        "worktree": current,
        "taken": taken,
    }))
}

/// The required `name` parameter for `home/worktree-create`.
///
/// Only checked for being a non-empty string here. What makes a name *usable* —
/// legal as both a branch and a folder on Windows — is `git::validate_worktree_
/// name`, and it stays there so that the rule has one home rather than a copy
/// on each path that can reach it.
fn name_param(params: Option<&Value>) -> Result<String, RpcError> {
    match params.and_then(|p| p.get("name")) {
        Some(Value::String(raw)) if !raw.is_empty() => Ok(raw.clone()),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("name must be a non-empty string, got {other}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "name is required")),
    }
}

/// The required `path` parameter, for the methods that act on a row the frontend
/// already has in hand rather than on a folder it has to ask for.
fn path_param(params: Option<&Value>) -> Result<PathBuf, RpcError> {
    match params.and_then(|p| p.get("path")) {
        Some(Value::String(raw)) if !raw.is_empty() => Ok(PathBuf::from(raw)),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("path must be a non-empty string, got {other}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "path is required")),
    }
}

/// `AppError` carries no JSON-RPC code, so everything it can be becomes
/// `-32603`. That is honest today — every variant reachable from here is a
/// filesystem failure the user can only react to by reading the message. When
/// one of them becomes something a frontend should *branch* on, it earns its own
/// code rather than being distinguished by parsing this string.
fn rpc(error: AppError) -> RpcError {
    RpcError::new(INTERNAL_ERROR, error.to_string())
}
