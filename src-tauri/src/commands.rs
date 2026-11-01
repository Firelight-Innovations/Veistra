//! The bridge between Rust and the web frontend.
//!
//! Every `#[tauri::command]` here becomes callable from TypeScript via
//! `invoke("name", { args })`. Arguments and return values cross the boundary as
//! JSON, which is why the types involved derive `Serialize`/`Deserialize`.
//!
//! Note the naming convention: Rust `snake_case` command names are invoked from
//! JS by that same snake_case string, but their *arguments* are converted to
//! camelCase. The typed wrappers in `src/bindings.ts` hide that asymmetry.

use crate::apps;
use crate::boot;
use crate::discovery::{self, StackSnapshot};
use crate::error::{AppError, Result};
use crate::launch;
use crate::layout::SplitDir;
use crate::manifest::{self, Manifest};
use crate::pages;
use crate::plugins;
use crate::presets;
use crate::project;
use crate::pty::{self, PtySessions};
use crate::review::{self, ReviewComment, ReviewDraft};
use crate::shell_state::{OpenRequest, ShellSnapshot, ShellState, SurfaceKind, WindowGeometry};
use crate::state::AppState;
use crate::tool_frontend;
use crate::windows;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Read veistra.toml, resolve every declared tool against the filesystem, cache
/// the result, and hand it to the UI.
///
/// Safe to call repeatedly — it always re-reads from disk, so this doubles as
/// the "refresh" action.
#[tauri::command]
pub fn load_stack(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<StackSnapshot> {
    let path = manifest::locate(&app)?;
    let manifest = Manifest::load(&path)?;
    let snapshot = discovery::resolve(&path, &manifest)?;

    state.store(snapshot.clone());
    Ok(snapshot)
}

/// The last snapshot without touching the disk. `None` before the first load.
#[tauri::command]
pub fn cached_stack(state: State<'_, AppState>) -> Option<StackSnapshot> {
    state.get()
}

/// Show a tool's local checkout in the OS file manager.
#[tauri::command]
pub fn reveal_tool(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let snapshot = state
        .get()
        .ok_or_else(|| AppError::UnknownTool(id.clone()))?;

    let tool = snapshot
        .tools
        .iter()
        .find(|t| t.spec.id == id)
        .ok_or_else(|| AppError::UnknownTool(id.clone()))?;

    app.opener()
        .reveal_item_in_dir(&tool.checkout_path)
        .map_err(|source| AppError::Reveal { id, source })
}

/// Show the main window and close the splash.
///
/// Called by the splash's own frontend once it has something to show for
/// (`boot:status` reaching `Ready` or `Failed`), and also by `boot::start`'s
/// watchdog if that never happens. This just forwards to `boot::finish`,
/// which is where the idempotency lives — see its doc comment. No `Result`
/// here because there is nothing a caller could usefully do with a failure
/// to show or close a window; `boot::finish` already swallows those.
#[tauri::command]
pub fn finish_boot(app: tauri::AppHandle) {
    boot::finish(&app);
}

/// The latest boot status, fetched directly rather than waited for over an
/// event.
///
/// Exists because `boot:status` events aren't replayable (see the comment on
/// `AppState::boot_status`): the splash window's own startup — webview init,
/// React mount, the effect that calls `listen` — is routinely slower than
/// `boot::start`'s filesystem work, so the frontend often mounts *after*
/// boot already reported something. This command is how it catches up.
///
/// Returns a concrete `BootStatus` rather than `Option<BootStatus>`. Before
/// `boot::start` has stored anything, `AppState::boot_status` is `None`; this
/// is the one place that turns that into the same `Working` shape step 1
/// would have reported anyway, so the frontend always deals in one
/// non-nullable type instead of adding a null check for a gap that only
/// exists for a few microseconds at process start.
#[tauri::command]
pub fn boot_status(state: State<'_, AppState>) -> boot::BootStatus {
    state.boot_status().unwrap_or(boot::BootStatus::Working {
        step: 0,
        total: boot::total_steps(),
        label: "Starting…".to_string(),
    })
}

/// The path Explorer's "Open with Veistra" was pointed at, if this launch had one.
///
/// Polled once by the shell when it mounts, for the reason `launch`'s module doc
/// gives: Tauri does not replay events, and at the moment a launch target is
/// resolved there is no window listening for one. The event exists for the
/// *second* launch, when there is.
///
/// Taking clears it, so the two delivery paths cannot open the same file twice.
///
/// Only ever answers with a file. A folder was already opened as a project by
/// `launch::apply` before this could be called.
#[tauri::command]
pub fn take_launch_target(state: State<'_, launch::LaunchState>) -> Option<launch::Target> {
    state.take()
}

/// A first-party app's UI has drawn its first meaningful frame.
///
/// Reported by the *shell*, not by the app: an app's frontend sends
/// `veistra/painted` over transport B, and `ToolWindow` — the only thing that can
/// say which mounted frame a message came from — forwards it here with the id
/// it resolved. So an app cannot report on another app's behalf, for the same
/// reason it cannot answer another app's `invoke`.
///
/// Boot holds the splash window until every app has said this, which is what
/// makes the first frame after the splash the real Home rather than the boot
/// overlay laid over it. See `boot::await_apps`.
#[tauri::command]
pub fn app_painted(id: String) {
    boot::painted(&id);
}

// --- shell state ------------------------------------------------------------
//
// Placement and terminal sessions are shared across every Veistra window, so they
// live in `ShellState` rather than in any window's React tree. Each of these
// mutators broadcasts `shell:state` on the way out — see `ShellState::mutate`.
//
// Every one takes the calling window's label explicitly rather than inferring
// it from a `Window` argument. The caller always knows which window it is (it
// was told on the URL), and passing it makes the drag commands honest: moving a
// terminal names a *destination*, which is not the window running the code.

/// The current shared state, for a window that has just mounted.
///
/// Tauri events have no replay buffer, so a window that subscribes to
/// `shell:state` after the last broadcast would sit empty until the next drag.
/// Same gap the splash window hit with `boot:status`, same fix: subscribe
/// first, then call this to catch up.
#[tauri::command]
pub fn shell_state(shell: State<'_, ShellState>) -> ShellSnapshot {
    shell.snapshot()
}

/// Open a new instance of an app or tool.
///
/// The id that comes back is an *instance* id (`files-2`), not the app id that
/// went in. Everything downstream — which frame a message came from, which tab
/// to close — is keyed on it, and the app id survives only as the thing that
/// says which code to load and where to route an `invoke`.
///
/// `dir` is the axis the caller measured `pane_id` along, and it is what makes
/// this open into a pane of its own rather than a tab beside whatever was
/// already there. It comes from the frontend because it is a fact about pixels
/// and the tree stores fractions — `PaneNode::open_into` has the whole argument,
/// and every rule about when the split is refused.
#[tauri::command]
pub fn open_instance(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    app_id: String,
    pane_id: Option<String>,
    dir: Option<SplitDir>,
) -> Result<String> {
    // A terminal is offered in the same menu as an app now (see
    // `apps::openables`) and is not one: it has no frontend to mount and no
    // `Dispatch` to route an `invoke` to. Left to fall through, it would resolve
    // as a *tool* below — `is_app` is false for it — and mint a surface pointing
    // at a checkout that does not exist, which draws as a frame that never
    // loads. Refused by name instead, and pointed at the command that does the
    // right thing, because a menu with both kinds in it is exactly where this
    // mistake gets made.
    if app_id == apps::TERMINAL_ID {
        return Err(AppError::Pty {
            id: app_id,
            reason: "a terminal is not an app surface — open one with `open_terminal_in_pane`"
                .to_string(),
        });
    }
    // A page's app is an app, and would open — as a second copy of the page,
    // loose in a pane. `open_page` (the rail button) is the only door to it;
    // see `pages`.
    if pages::is_page_app(&app_id) {
        return Err(AppError::PageApp(app_id));
    }

    // An app ships in this binary; a plugin is a checkout that may not be here.
    // The distinction decides where an `invoke` from the resulting frame is
    // answered, so it is resolved once, here, from the registry itself rather
    // than trusted from the frontend.
    let kind = if apps::is_app(&app_id) {
        SurfaceKind::App
    } else {
        SurfaceKind::Tool
    };

    let title = apps::display_name(&app, &app_id);

    shell
        .open_instance(
            &app,
            &label,
            OpenRequest {
                app_id: &app_id,
                kind,
                title: &title,
                pane_id: pane_id.as_deref(),
                dir,
            },
        )
        .ok_or_else(|| AppError::UnknownTool(app_id))
}

/// The pages this build offers, in rail order — including the disabled ones.
/// See `pages::rail`.
#[tauri::command]
pub fn list_pages() -> Vec<pages::PageInfo> {
    pages::rail()
}

/// Show a page in `label`'s window, or close it if it is already the one
/// showing. See `ShellState::open_page`.
#[tauri::command]
pub fn open_page(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    page_id: String,
) -> Result<()> {
    let page = pages::find(&page_id).ok_or_else(|| AppError::UnknownPage(page_id.clone()))?;
    if page.disabled {
        return Err(AppError::PageDisabled(page_id));
    }
    shell.open_page(&app, &label, page);
    // The title follows the active cluster's project, and a page has none.
    project::retitle(&app);
    Ok(())
}

/// Close whatever page `label`'s window is showing, returning it to its
/// panes. See `ShellState::close_page`.
#[tauri::command]
pub fn close_page(app: tauri::AppHandle, shell: State<'_, ShellState>, label: String) {
    shell.close_page(&app, &label);
    project::retitle(&app);
}

/// Dock or expand `label`'s open page in place. See `ShellState::set_page_mode`.
#[tauri::command]
pub fn set_page_mode(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    mode: pages::PageMode,
) {
    shell.set_page_mode(&app, &label, mode);
}

/// Resize `label`'s docked page. See `ShellState::set_page_width`.
#[tauri::command]
pub fn set_page_width(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    width: f32,
) {
    shell.set_page_width(&app, &label, width);
}

#[tauri::command]
pub fn close_instance(app: tauri::AppHandle, shell: State<'_, ShellState>, instance_id: String) {
    shell.close_instance(&app, &instance_id);
}

/// An app naming its own tab — "Files" becoming `client.ts`, the way an editor
/// tab says what is in it.
///
/// The same shape as `set_terminal_title` and for the same reason: a title is
/// identity, identity is Rust's because a tab can be dragged into another
/// window, and this only ever *reports* — the title to render comes back around
/// through `shell:state`. The empty and no-op guards live in `ShellState`.
#[tauri::command]
pub fn set_instance_title(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    instance_id: String,
    title: String,
) {
    shell.set_instance_title(&app, &instance_id, &title);
}

#[tauri::command]
pub fn activate_instance(app: tauri::AppHandle, shell: State<'_, ShellState>, instance_id: String) {
    shell.activate_instance(&app, &instance_id);
}

/// Move a tab into a pane — reordering within one strip, or across windows.
///
/// Reports a move that landed nowhere, for the reason `split_pane` gives below.
#[tauri::command]
pub fn move_instance(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    instance_id: String,
    cluster_id: String,
    pane_id: String,
    index: Option<usize>,
) -> Result<()> {
    match shell.move_instance(&app, &instance_id, &cluster_id, &pane_id, index) {
        true => Ok(()),
        false => Err(AppError::UnknownTool(pane_id)),
    }
}

/// Drop a tab on a pane's edge: split there and put it in the new half.
///
/// Both of these used to return `()`, throwing away a boolean that already said
/// whether anything had happened. That is how "dropping a tab on a pane's edge
/// does nothing" stayed a mystery through a whole round of investigation: the
/// call succeeded, the promise resolved, and every layer above was entitled to
/// assume the drop had worked. An `Err` here reaches the drag layer's `attempt`,
/// which puts it in the console with the pane it could not find — which is the
/// one fact needed to tell a stale drop target apart from a broken one.
#[tauri::command]
pub fn split_pane(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    pane_id: String,
    dir: SplitDir,
    instance_id: String,
    before: bool,
) -> Result<()> {
    match shell.split_with_instance(&app, &pane_id, dir, &instance_id, before) {
        true => Ok(()),
        false => Err(AppError::UnknownTool(pane_id)),
    }
}

/// What a divider drag commits on release. Weights, not pixels — see `layout`.
#[tauri::command]
pub fn set_pane_sizes(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    split_id: String,
    sizes: Vec<f32>,
) {
    shell.set_pane_sizes(&app, &split_id, sizes);
}

// --- clusters ---------------------------------------------------------------
//
// Every command in this section finishes with `project::retitle`, for the same reason: the OS
// window title names the project of the cluster its window is *showing*, so adding, closing,
// clicking a chip, or dragging a cluster elsewhere changes the title without touching a project.
// `project::open` and `project::close` cover the other half, when the cluster stays and the
// project under it moves.

/// Add a cluster, and open Home in it.
///
/// Home rather than nothing, for the reason `seed_first_run` opens it on first launch: a cluster is
/// where work starts, and Home is the one surface that can start it — where a project is opened. An
/// empty cluster would hand you a blank window and the Apps menu — a puzzle, not a starting point.
///
/// Composed here rather than folded into `ShellState::add_cluster`, which stays a primitive doing
/// exactly what its name says. That costs a second broadcast and a second `layout.json` write; both
/// cheap, and the alternative is a state method that quietly opens a surface nobody asked it for.
/// The new cluster has **no project**, and Home is what that gets you: the pick-a-project state a
/// session starts on. Deliberately not the previous cluster's project, and not a folder picker
/// raised unbidden — a new cluster is new work; guessing the project would be wrong about half the
/// time, and a picker nobody asked for is wrong about all of it.
#[tauri::command]
pub fn add_cluster(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    name: String,
) -> Option<String> {
    let cluster_id = shell.add_cluster(&app, &label, &name)?;
    // No cluster id needed: `add_cluster` has already made this one active. No direction, so no
    // split — the cluster's one pane is empty and Home fills it. `open_into` would refuse a split
    // here anyway (an empty pane is the first of the two cases it declines), but there is also
    // nothing on screen to have measured, and passing an axis nobody measured would be a lie.
    shell.open_instance(
        &app,
        &label,
        OpenRequest {
            app_id: "home",
            kind: SurfaceKind::App,
            title: "Home",
            pane_id: None,
            dir: None,
        },
    );
    project::retitle(&app);
    Some(cluster_id)
}

/// Where the New Cluster dialog's first step said this cluster's work
/// should run. Not [`crate::environments::Environment`] itself: the dialog
/// can offer "a new local worktree" before that worktree exists, and only
/// this command's own resolution step (see [`resolve_environment_choice`])
/// turns it into the real thing, by actually creating it. The other two
/// arms carry an `Environment` the dialog already had in hand — an existing
/// worktree from the environment list, or the standing Design one — and
/// need no resolution at all.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EnvironmentChoice {
    /// "New local worktree", with the name and base the dialog collected.
    /// `crate::git::validate_worktree_name` is what actually enforces the
    /// name is usable — this struct makes no claim about it.
    ///
    /// `base` is optional: absent, the repository's default branch is resolved with
    /// `git_repo::default_branch`, so a `master` repository works without the dialog
    /// having to know that.
    NewLocalWorktree {
        name: String,
        #[serde(default)]
        base: Option<String>,
    },
    /// "An existing environment" or "browse main, read-only" — anything the
    /// dialog already had a fully-formed [`crate::environments::Environment`]
    /// for, including `Environment::Main` itself.
    Existing {
        environment: crate::environments::Environment,
    },
}

/// The New Cluster dialog's second step: what to put in the new cluster's
/// panes before anyone has arranged anything by hand.
///
/// `Code` and `WatchAgent` map onto app ids this build ships. `Godot` and
/// `Blender` reach for [`VIEWER_APPS`] instead — ids `ux/viewers` is
/// building, not yet on this branch. `fill_preset_gaps` degrades an
/// unregistered id to an empty pane rather than failing (see its own doc),
/// so opening either today is honest, just empty, until that branch merges.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartingLayout {
    Code,
    WatchAgent,
    Godot,
    Blender,
}

/// The pane apps a Godot or Blender starting layout wants, kept as one table
/// rather than spelled out at each call site in [`starting_layout_preset`] —
/// a different id from `ux/viewers` than the one guessed here is then a
/// one-line fix rather than a hunt through a tree of `PresetNode::Split`s.
struct ViewerApps {
    godot: &'static str,
    blender: &'static str,
    play: &'static str,
}

const VIEWER_APPS: ViewerApps = ViewerApps {
    godot: "godot-viewer",
    blender: "blender-viewer",
    play: "play",
};

fn starting_layout_preset(layout: StartingLayout) -> presets::PresetNode {
    use presets::{PresetNode, PresetSlot};
    let app_pane = |app_id: &str| PresetNode::Pane {
        slots: vec![PresetSlot::App {
            app_id: app_id.to_string(),
        }],
    };
    let terminal_pane = || PresetNode::Pane {
        slots: vec![PresetSlot::Terminal],
    };
    match layout {
        StartingLayout::Code => PresetNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.65, 0.35],
            children: vec![app_pane("files"), terminal_pane()],
        },
        StartingLayout::WatchAgent => app_pane("agents"),
        // Explorer · Godot viewer · Play · terminal — matches the New
        // Cluster dialog's own description of this layout.
        StartingLayout::Godot => PresetNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.2, 0.8],
            children: vec![
                app_pane("files"),
                PresetNode::Split {
                    dir: SplitDir::Column,
                    sizes: vec![0.7, 0.3],
                    children: vec![
                        PresetNode::Split {
                            dir: SplitDir::Row,
                            sizes: vec![0.7, 0.3],
                            children: vec![app_pane(VIEWER_APPS.godot), app_pane(VIEWER_APPS.play)],
                        },
                        terminal_pane(),
                    ],
                },
            ],
        },
        // Explorer · Blender viewer · terminal.
        StartingLayout::Blender => PresetNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.2, 0.8],
            children: vec![
                app_pane("files"),
                PresetNode::Split {
                    dir: SplitDir::Column,
                    sizes: vec![0.75, 0.25],
                    children: vec![app_pane(VIEWER_APPS.blender), terminal_pane()],
                },
            ],
        },
    }
}

/// Whether the project can have worktree clusters, for the New Cluster dialog and the
/// read-only notice to say so before anything is attempted.
#[tauri::command]
pub fn git_repo_state(project: String) -> crate::git_repo::RepoState {
    crate::git_repo::repo_state(Path::new(&project))
}

/// The branch a new worktree forks from and the read-only labels name; see
/// `git_repo::default_branch` for the order it is resolved in.
#[tauri::command]
pub fn git_default_branch(project: String) -> Option<String> {
    let root = crate::git::main_repo_root(Path::new(&project))?;
    crate::git_repo::default_branch(&root)
}

/// Give a project folder a git repository and a first commit. Refuses inside an existing
/// repository and when git has no identity to commit as, each with a sentence that says
/// what to do. Runs `git`, so it is off the async runtime's threads.
#[tauri::command]
pub async fn git_init_project(project: String) -> Result<crate::git_repo::InitOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::git_repo::init_repository(Path::new(&project))
    })
    .await
    .map_err(|e| AppError::Repo(format!("git init did not finish: {e}")))?
}

/// The New Cluster dialog's first step, the "existing environment" list —
/// see `environments::list_local_worktrees` for what it excludes and why.
#[tauri::command]
pub fn list_cluster_environments(project: String) -> Result<Vec<crate::environments::Environment>> {
    let main_repo =
        crate::git::main_repo_root(Path::new(&project)).ok_or_else(|| AppError::Git {
            op: "worktree list".to_string(),
            reason: format!("`{project}` is not inside a git repository."),
        })?;
    crate::environments::list_local_worktrees(&main_repo)
}

fn resolve_environment_choice(
    project: &str,
    choice: EnvironmentChoice,
) -> Result<crate::environments::Environment> {
    match choice {
        EnvironmentChoice::NewLocalWorktree { name, base } => {
            let not_a_repo = || {
                AppError::Repo(
                    "There is no git repository in this project yet, and a worktree cluster needs                      one. Initialise a git repository first."
                        .to_string(),
                )
            };
            let main_repo =
                crate::git::main_repo_root(Path::new(project)).ok_or_else(not_a_repo)?;
            if !crate::git_repo::has_commits_in(&main_repo) {
                return Err(AppError::Repo(
                    "This project's git repository has no commits yet, and a worktree cluster                      is forked from one. Make the first commit, or initialise the repository                      from here."
                        .to_string(),
                ));
            }
            let base = base
                .filter(|b| !b.trim().is_empty())
                .or_else(|| crate::git_repo::default_branch(&main_repo))
                .ok_or_else(|| {
                    AppError::Repo(
                        "Could not tell which branch to start the worktree from.".to_string(),
                    )
                })?;
            crate::environments::create_local_worktree(&main_repo, &name, &base)
        }
        EnvironmentChoice::Existing { environment } => Ok(environment),
    }
}

/// Where the new cluster goes and what it starts out named — the part of
/// `create_cluster_with_environment`'s payload that is about the *cluster*,
/// grouped into one struct so the command itself stays under clippy's
/// seven-argument line. `choice` and `layout` stay separate parameters
/// because they are each already their own type with their own doc; folding
/// everything into one struct would just move the crowding from the
/// function signature into that struct's field list.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClusterTarget {
    pub label: String,
    pub name: String,
    pub project: String,
}

/// The New Cluster dialog's finishing step: create the cluster, resolve
/// (and, for a new worktree, actually create) the environment it chose, and
/// arrange its one pane per the starting layout its second step chose.
///
/// Three `ShellState` mutations rather than one — `add_cluster`, then
/// `set_cluster_project`, then `set_cluster_environment` — each broadcasting
/// and persisting on its own. `project::open` already accepts this same
/// multi-step shape for the same reason: nothing here can be collapsed into
/// a single atomic write without `ShellState::mutate` growing a bespoke
/// closure for this one caller, and three ordinary calls read the whole
/// operation over the wire as three small, individually-understandable
/// state changes rather than one large exception to how everything else
/// here writes.
#[tauri::command]
pub fn create_cluster_with_environment(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    target: NewClusterTarget,
    choice: EnvironmentChoice,
    layout: StartingLayout,
) -> Result<String> {
    let NewClusterTarget {
        label,
        name,
        project,
    } = target;
    let environment = resolve_environment_choice(&project, choice)?;
    let name = cluster_name_or_environment_fallback(&name, &environment);

    let cluster_id = shell
        .add_cluster(&app, &label, &name)
        .ok_or(AppError::NoCluster("create"))?;
    shell.set_cluster_project(&app, &cluster_id, Some(project));
    shell.set_cluster_environment(&app, &cluster_id, Some(environment));

    let root = starting_layout_preset(layout);
    if let Some((label, gaps)) = shell.apply_preset_to_cluster(&app, &cluster_id, &root) {
        fill_preset_gaps(&app, &shell, &ptys, &label, &cluster_id, gaps);
    }

    project::retitle(&app);
    Ok(cluster_id)
}

/// A cluster always shows *something* in the switcher, so a blank or
/// whitespace-only `name` from the dialog falls back to a name the chosen
/// environment already carries — its branch, when it has one, and "Main" for
/// the one variant that doesn't ([`crate::environments::Environment::branch`]
/// is `None` there by design, not by omission — see that method's doc).
/// Pulled out of [`create_cluster_with_environment`] so this fallback is
/// tested directly rather than only through a command that needs a live
/// `AppHandle` to call at all.
fn cluster_name_or_environment_fallback(
    name: &str,
    environment: &crate::environments::Environment,
) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    environment.branch().unwrap_or("Main").to_string()
}

/// Create `wt/design` for a project that doesn't have one yet, and pin the
/// Design canvas cluster onto it in the calling window.
///
/// The "offered but not auto-created" half of the canvas's behaviour
/// (VEISTRA-UX-REWORK.md §5) — `project::open`'s `open_design_cluster_if_present`
/// is the *auto* half, run once at open time for a project that already has
/// `wt/design`; this is the same finish for one that doesn't, reachable
/// without closing and reopening the project to get it. `base` is the branch
/// `wt/design` forks from, same as the New Cluster dialog's own worktree step.
#[tauri::command]
pub fn create_design_cluster(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    project: String,
    base: String,
) -> Result<Option<String>> {
    let main_repo =
        crate::git::main_repo_root(Path::new(&project)).ok_or_else(|| AppError::Git {
            op: "worktree add".to_string(),
            reason: format!("`{project}` is not inside a git repository."),
        })?;
    let environment = crate::environments::create_design_environment(&main_repo, &base)?;
    Ok(shell.add_design_cluster(&app, &label, &project, environment))
}

/// Drop a tab on the switcher's empty space (VEISTRA-UX-REWORK.md §5): a
/// cluster of its own, in the same environment the tab came from, holding
/// that one tab.
///
/// `source_cluster` is the dragged tab's `fromClusterId` — see `SurfaceDrag`
/// in `src/shell/contract.ts` — and is only ever the environment source; the
/// move itself is `move_instance`'s ordinary cross-cluster path, with no
/// special case for a cluster made a moment earlier. Composed here rather
/// than folded into `ShellState::add_cluster_for_environment`, for the
/// reason `add_cluster` above already gives: that stays a primitive, this is
/// the gesture built out of it.
///
/// Fails closed: if the move is refused (the tab has vanished, or is pinned
/// to a page — `move_instance`'s own guards), the cluster this just made is
/// still there, holding nothing. That is `add_cluster`'s own steady state —
/// a cluster with an empty pane draws exactly as a fresh one does — so
/// nothing here has to clean it back up.
#[tauri::command]
pub fn new_cluster_for_drop(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    name: String,
    source_cluster: String,
    instance_id: String,
) -> Option<String> {
    let (cluster_id, pane_id) =
        shell.add_cluster_for_environment(&app, &label, &name, &source_cluster)?;
    shell.move_instance(&app, &instance_id, &cluster_id, &pane_id, None);
    project::retitle(&app);
    Some(cluster_id)
}

#[tauri::command]
pub fn set_active_cluster(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    cluster_id: Option<String>,
) {
    shell.set_active_cluster(&app, &label, cluster_id);
    project::retitle(&app);
}

#[tauri::command]
pub fn rename_cluster(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    cluster_id: String,
    name: String,
) {
    shell.rename_cluster(&app, &cluster_id, &name);
}

/// Choose the emoji a cluster wears instead of its initials; `None` resets to them.
#[tauri::command]
pub fn set_cluster_icon(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    cluster_id: String,
    icon: Option<crate::shell_state::ClusterIcon>,
) {
    shell.set_cluster_icon(&app, &cluster_id, icon);
}

/// Close a cluster and everything in it, including the last one in a window.
///
/// The ptys are killed here rather than left to be tidied later. `close_cluster`
/// hands back the session ids precisely so they cannot be forgotten: a shell
/// still running with no entry anywhere on screen is a process nobody can see,
/// stop, or find out about. Both kinds come back now — the ones in its tree and
/// the ones in its band — because a terminal names a cluster and this one is
/// going away.
///
/// Closing the last one leaves a window with no clusters, which is a legal
/// state: the app area draws an empty state. `detach_cluster` below can leave a
/// window in the same state, and no longer refuses to — see `move_cluster_pure`.
#[tauri::command]
pub fn close_cluster(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    cluster_id: String,
) {
    let (_instances, terminals) = shell.close_cluster(&app, &cluster_id);
    for id in terminals {
        ptys.close(&id);
    }
    project::retitle(&app);
}

// --- windows ----------------------------------------------------------------

/// Which Veistra window the cursor is over, or `None` if it is over none of them.
///
/// Called by the drag layer on drop, to find out which window a tab was let go
/// over. The frontend cannot answer this for itself — see `windows::at_cursor`.
#[tauri::command]
pub fn window_at_cursor(app: tauri::AppHandle) -> Option<String> {
    windows::at_cursor(&app)
}

/// File > New Window: an empty window with a cluster of its own.
///
/// Distinct from `detach_instance`, which makes a window by *moving* a surface
/// into it. This takes nothing from the window that asked, which is what the
/// menu item has always claimed and could not do while a window's label was
/// derived from the tool inside it — there was no label a second empty window
/// could have had.
///
/// `async` because it builds a window; see `windows::create`.
#[tauri::command]
pub async fn new_window(app: tauri::AppHandle, shell: State<'_, ShellState>) -> Result<()> {
    let label = shell.claim_window_label();
    // Bookkeeping first, window second, the same order `detach` uses: a window
    // on screen with no entry in the shared state would render nothing and have
    // no way to be given anything.
    shell.add_window(&app, &label);
    // And Home in the cluster that came with it, for the reason `add_cluster`
    // above gives. A new window is a new cluster; "empty" should not mean two
    // different things depending on which menu item made it. No direction, for
    // the reason `add_cluster` gives: the window it would be measured in does
    // not exist yet.
    shell.open_instance(
        &app,
        &label,
        OpenRequest {
            app_id: "home",
            kind: SurfaceKind::App,
            title: "Home",
            pane_id: None,
            dir: None,
        },
    );
    let created = windows::create(&app, &label, None, true);
    // After the window exists, not before: `retitle` sets titles on windows it
    // can look up, and one that has not been built yet is not one of them.
    project::retitle(&app);
    created
}

/// Drag a whole cluster clear of its window — the multi-monitor gesture.
///
/// `to_label` is where it lands. `Some(label)` moves it into a Veistra window that is already open,
/// which is what a release over another window means; `None` gives it a window of its own.
///
/// That first case is deliberately built here where the same thing for a single tab was
/// deliberately left out (see the `detach` case in `src/shell/drag/useDrag.tsx`). A tab could not
/// do it because `window_at_cursor` answers with a label and cannot say *where inside* the window
/// the cursor was, so a pane would have to be guessed. A cluster is not dropped into a pane: it is
/// appended to the window's cluster list, and the label is the whole of the address. There is
/// nothing left to guess, so the two gestures differing is not an inconsistency to tidy up later.
///
/// A `to_label` that names no window in the shared state falls back to making one, rather than
/// being an error: the only caller passes what `window_at_cursor` just returned, and a window that
/// has since closed should still leave the cluster somewhere on screen. The `Err` below therefore
/// says one thing only — no window holds that cluster, so it was closed between the release and
/// this call. It used to also carry "that was the last cluster in its window", a refusal that is
/// gone; see `move_cluster_pure`. The frontend reports whatever comes back rather than dropping it,
/// because a detach that quietly does nothing is the hardest failure here to diagnose.
#[tauri::command]
pub async fn detach_cluster(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    cluster_id: String,
    to_label: Option<String>,
) -> Result<()> {
    let moved = match to_label.filter(|label| shell.has_window(label)) {
        // Into a window that is already open: bookkeeping only, since the
        // window it is going to is on screen already.
        Some(label) => match shell.move_cluster(&app, &cluster_id, &label) {
            true => Ok(()),
            false => Err(AppError::UnknownTool(cluster_id)),
        },
        None => windows::detach_cluster(&app, &shell, &cluster_id),
    };

    // Two windows' titles can change here at once: the one the cluster left now
    // shows a neighbour, and the one it arrived in shows it. `retitle` walks
    // every window, so both are correct without either being named.
    project::retitle(&app);
    moved
}

/// Drag a tab clear of its window. The gesture that makes a second window.
///
/// `async` because it builds a window; see `windows::create`.
#[tauri::command]
pub async fn detach_instance(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    instance_id: String,
) -> Result<()> {
    let detached = windows::detach(&app, &shell, &instance_id);
    // The new window's cluster inherits the project the surface was already
    // working in (see `ShellState::detach_instance`), so it has a title to take.
    project::retitle(&app);
    detached
}

/// A window reporting where it now is, after a move or a resize.
///
/// Deliberately does not broadcast: this fires continuously while a window is
/// being dragged, and telling every other window about each frame of that would
/// be a storm none of them need. See `ShellState::set_geometry`.
#[tauri::command]
pub fn set_window_geometry(shell: State<'_, ShellState>, label: String, geometry: WindowGeometry) {
    shell.set_geometry(&label, geometry);
}

/// Close a window on purpose.
///
/// Just asks the OS to close it. That used to be enough of a lie to build a
/// whole mechanism on — the title bar's × was the *only* path that announced
/// a close as deliberate before doing it, so this command used to mark the
/// label closing and reclaim its clusters itself, right here. The trouble is
/// this is not the only way a window closes: Alt+F4, the taskbar's "Close
/// window", and a graceful OS shutdown all ask a window to close without ever
/// calling this command, and none of them were reclaiming anything, which
/// reproduced the exact "closed window comes back" bug this file's history is
/// about, just by a route the command could not see.
///
/// `WebviewWindow::close` documents the fix: it "emits `CloseRequested` first
/// like a user-initiated close request", and that event fires identically no
/// matter who asked — this command, Alt+F4, or the OS. So the bookkeeping
/// moved to `windows::request_close`, which runs from `WindowEvent::
/// CloseRequested` in `lib.rs`'s `on_window_event`, and now covers all of
/// them by construction instead of by whichever one remembered to ask
/// nicely. This command is left only because the frontend needs some command
/// to call.
#[tauri::command]
pub fn close_window(app: tauri::AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
}

/// Open a terminal: a session in the shared state, and a real shell behind it.
///
/// Both halves, in that order, because the session id is what names the pty.
/// If the shell cannot be spawned the session is rolled back rather than left
/// on screen as a tab with nothing behind it.
///
/// `cols`/`rows` are the emulator's first guess. It corrects them the moment it
/// has measured itself, so being briefly wrong here is harmless — but being
/// *absent* is not, since a pty must be created with some size and a program
/// that starts before the first resize would draw to whatever we picked.
#[tauri::command]
pub fn create_terminal(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    label: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String> {
    // The caller names its *window*, and it is right to: the band's `+` is a
    // control in one window, and that window's frontend has no business asserting
    // which cluster the backend thinks it is showing. The one place that question
    // is answered is here, against the state itself.
    let cluster_id = shell
        .active_cluster_of(&label)
        .ok_or(AppError::NoCluster("open a terminal in"))?;

    open_terminal(
        &app,
        &shell,
        &ptys,
        &cluster_id,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
    )
}

/// The one path that opens a terminal, shared by the command above and by the
/// launch terminal `lib.rs` opens at setup.
///
/// The ordering is the point: claim an id, spawn the shell, and only publish the
/// session once there is something behind it. A spawn that fails leaves nothing
/// on screen, so there is no state to roll back and no window that briefly saw a
/// tab that never worked.
pub fn open_terminal(
    app: &tauri::AppHandle,
    shell: &ShellState,
    ptys: &PtySessions,
    cluster_id: &str,
    cols: u16,
    rows: u16,
) -> Result<String> {
    let (id, title) = spawn_terminal(app, shell, ptys, cluster_id, cols, rows)?;
    shell.add_terminal(app, &id, &title, cluster_id);
    Ok(id)
}

/// Everything before a session is published: claim an id, spawn the shell, and
/// work out what the tab is called.
///
/// Split out from [`open_terminal`] so that a terminal destined for a *pane* can
/// be published straight into the tree in one mutation, rather than appearing in
/// the panel and being moved out of it a broadcast later — see
/// `ShellState::add_terminal_in_pane` for what that intermediate state looks
/// like on screen. The spawn itself is shared rather than repeated: there is one
/// thing in this application that starts a shell, and neither publishing path is
/// a second one.
fn spawn_terminal(
    app: &tauri::AppHandle,
    shell: &ShellState,
    ptys: &PtySessions,
    cluster_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(String, String)> {
    // A terminal belongs to the cluster whose band draws it — see `shell_state`'s
    // module doc for why that replaced belonging to the window, and what the
    // change costs.
    //
    // Checked rather than assumed, because an id naming no cluster would put a
    // live shell behind an entry no band draws. It is the cluster that is checked
    // even for a terminal headed into a pane: the pty's working directory and its
    // `cluster_id` are both the cluster's, whichever half of the shell ends up
    // drawing it.
    if !shell.has_cluster(cluster_id) {
        return Err(AppError::Pty {
            id: cluster_id.to_string(),
            reason: "no such cluster to open a terminal in".to_string(),
        });
    }

    let (id, ordinal) = shell.claim_terminal_id();
    let marker =
        crate::environments::read_only_env(shell.cluster_write_environment(cluster_id).as_ref());
    let name = ptys.open(
        app,
        &id,
        &terminal_cwd(app, cluster_id),
        cols,
        rows,
        &marker,
    )?;

    // "pwsh", then "pwsh 2", "pwsh 3" — the first of a kind goes unnumbered,
    // which is what the handoff's panel draws and what every terminal
    // application does.
    let title = if ordinal <= 1 {
        name
    } else {
        format!("{name} {ordinal}")
    };

    Ok((id, title))
}

/// Open a terminal **into a pane of the active cluster**, rather than into that cluster's band.
///
/// There are two ways to make a terminal, and it is not a contradiction. The band's own `+` still
/// makes one in the band, still the default and still right: it is where a shell goes when it is
/// *beside* the work rather than part of the arrangement, and can be resized, shut and pulled back
/// up without disturbing a pane. This is the other one: a terminal that is *part of an
/// arrangement* — the bottom pane of "Files & Viewer over Terminal", or wherever someone drags one
/// by hand — sized by the layout, moving when the layout does. That is VS Code's terminal panel
/// against a terminal in the editor area, answering different questions: *what am I watching*
/// against *what am I working in*. Both had to keep working, and both do. What changed is that
/// they no longer differ in **lifetime** — both belong to the cluster and close with it — so the
/// choice is only about where the thing is drawn, which is the choice it looked like all along.
///
/// It is not a third spawn path. A terminal in a pane *is* a session whose id appears in a tree —
/// there is no second representation of one, by design, so that a terminal can never draw in two
/// places at once. The shell is spawned the one way shells are spawned (`spawn_terminal`, shared
/// with the panel's route) and the session is published with its id already in the tree, which is
/// exactly what dragging a terminal's tab into a pane does; this just does it at birth. One step
/// rather than opened-then-moved because the two-step version has a visible cost — see
/// `ShellState::add_terminal_in_pane`, which is where that is written down.
fn open_terminal_into_pane(
    app: &tauri::AppHandle,
    shell: &ShellState,
    ptys: &PtySessions,
    cluster_id: &str,
    pane_id: &str,
    index: Option<usize>,
    dir: Option<SplitDir>,
) -> Result<String> {
    // 80×24 is the same placeholder the band's route uses. A pty must be created
    // with some size, and the emulator corrects it the moment it has measured
    // the pane it landed in.
    let (id, title) = spawn_terminal(app, shell, ptys, cluster_id, 80, 24)?;
    shell.add_terminal_in_pane(app, &id, &title, cluster_id, pane_id, index, dir);
    Ok(id)
}

/// The Apps menu's Terminal row, and the switcher `+`'s.
///
/// `pane_id` is the pane the open is relative to; `None` means the active
/// cluster's first pane, which is the same forgiveness `open_instance` shows and
/// for the same reason — a caller with no opinion should not have to invent one.
///
/// `dir` gets the terminal a pane of its own, exactly as it does for an app.
/// Terminal is a row in the same Apps menu as the apps, so a menu where one row
/// splits and another stacks would be two products in one list.
#[tauri::command]
pub fn open_terminal_in_pane(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    label: String,
    pane_id: Option<String>,
    dir: Option<SplitDir>,
) -> Result<String> {
    let (cluster_id, pane) = shell
        .active_pane(&label, pane_id.as_deref())
        .ok_or(AppError::NoCluster("open a terminal in"))?;

    open_terminal_into_pane(&app, &shell, &ptys, &cluster_id, &pane, None, dir)
}

/// Where a new terminal opens: its cluster's project, or the stack root when
/// that cluster has none.
///
/// The project comes first because a terminal is opened to do something to the
/// thing you are working on, and until there is a project that thing is the
/// stack itself. Not the process's working directory, which `tauri dev` sets to
/// `src-tauri/` — nobody's idea of where a terminal should start. The last two
/// fallbacks only matter when there is no manifest at all, which is a broken
/// install rather than a state worth failing a terminal over.
///
/// **Resolved from the cluster, and only at this moment.** It is still a
/// snapshot rather than a subscription: a cluster can be re-pointed at another
/// project, and a shell that followed would `cd` under the user's feet, in a
/// session they may be halfway through a command in. What changed is which
/// question the snapshot answers — where this cluster's work is, rather than
/// where its window happened to be pointed — and `cluster_path` follows the
/// worktree, so a cluster working in one starts its shells there.
///
/// Existing shells are not followed silently: a shell nobody has typed in is
/// moved by `set_cluster_project`, and one that has been used stays put.
fn terminal_cwd(app: &tauri::AppHandle, cluster_id: &str) -> PathBuf {
    pick_terminal_cwd(
        project::cluster_path(app, cluster_id),
        manifest::locate(app)
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf)),
        std::env::current_dir().ok(),
    )
}

/// The precedence `terminal_cwd` applies, on plain values so it can be tested.
fn pick_terminal_cwd(
    cluster_root: Option<PathBuf>,
    stack_root: Option<PathBuf>,
    process_dir: Option<PathBuf>,
) -> PathBuf {
    cluster_root
        .or(stack_root)
        .or(process_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
pub fn close_terminal(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    id: String,
) {
    // The tab goes first and does not depend on the process: whatever the shell does when
    // told to stop, the tab is already gone from the layout. See `PtySessions::close`.
    shell.close_terminal(&app, &id);
    ptys.close(&id);
}

/// Split a terminal: open a second pty and fold it into `id`'s tab.
///
/// Reuses `open_terminal` for the spawn itself — there is exactly one path
/// that opens a pty, splitting included. What this adds is the second step:
/// putting the new session in `id`'s group, minting one if `id` didn't have
/// one yet. That bookkeeping is `ShellState::group_with`'s, not this
/// function's, for the same reason grouping lives on `TerminalSession` at
/// all — see the doc comment there.
///
/// The new pty opens beside the one it is splitting from, in that session's
/// own cluster, read off `ShellState` rather than taken as an argument — the
/// caller already told the backend that once, when the session was created or
/// last moved, and asking it to repeat itself here would just be a second place
/// for the two to disagree.
#[tauri::command]
pub fn split_terminal(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String> {
    let cluster_id = shell
        .cluster_of_terminal(&id)
        .ok_or_else(|| AppError::Pty {
            id: id.clone(),
            reason: "no such terminal to split".to_string(),
        })?;

    let new_id = open_terminal(
        &app,
        &shell,
        &ptys,
        &cluster_id,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
    )?;
    shell.group_with(&app, &id, &new_id);
    Ok(new_id)
}

/// A keystroke on its way to the shell. High-traffic, so it returns nothing and
/// reports nothing — a write to a dead pty is not an error worth a round trip,
/// and `pty:exit` already told the frontend the session ended.
#[tauri::command]
pub fn terminal_write(ptys: State<'_, PtySessions>, id: String, data: String) {
    ptys.write(&id, &data);
}

/// Files were dropped onto this terminal. Insert their paths at its prompt.
///
/// Returns the text that was inserted, so the caller can report what happened
/// without re-deriving it — and it could not re-derive it: quoting depends on
/// which shell this session is talking to, which is a fact only this side has.
/// See `quoting`'s module doc.
///
/// Unlike [`terminal_write`] this one answers, and can fail. A drop is a
/// deliberate, low-frequency gesture aimed at a terminal the user can see, so
/// "that session is gone" is worth a round trip to say, where the same news
/// about a keystroke would be noise. `Ok("")` is the honest answer to a drop
/// carrying no paths.
///
/// It executes nothing. That is a property of how the insertion is made rather
/// than a promise kept here — `PtySessions::insert_paths` has it.
#[tauri::command]
pub fn terminal_insert_paths(
    ptys: State<'_, PtySessions>,
    id: String,
    paths: Vec<String>,
) -> Result<String> {
    ptys.insert_paths(&id, &paths).ok_or(AppError::Pty {
        id,
        reason: "no such terminal session to insert into".to_string(),
    })
}

/// An emulator has mounted and is listening. Answers with everything the shell
/// has said so far and where the live stream picks up.
///
/// Called once per emulator, right after its listener is registered, and it is
/// what makes a terminal work at all rather than an optimisation. A pty starts
/// talking the instant it is spawned — on Windows, by asking the terminal where
/// the cursor is and then waiting for the answer before printing anything else
/// — and Tauri events have no replay. Without this call, the launch terminal's
/// opening question is emitted into an empty room and the shell waits for a
/// reply that can never come.
#[tauri::command]
pub fn terminal_attach(ptys: State<'_, PtySessions>, id: String) -> Option<pty::Attachment> {
    ptys.attach(&id)
}

/// The emulator has measured itself. See `PtySessions::resize` for why this is
/// not cosmetic.
#[tauri::command]
pub fn terminal_resize(ptys: State<'_, PtySessions>, id: String, cols: u16, rows: u16) {
    ptys.resize(&id, cols, rows);
}

/// Is this terminal running something? Asked once, when its close button is
/// clicked. `None` means the shell is at a prompt and the close needs no
/// confirming.
#[tauri::command]
pub fn terminal_busy(ptys: State<'_, PtySessions>, id: String) -> Option<pty::Busy> {
    pty::busy(&ptys, &id)
}

/// Drop a terminal into the band of whatever cluster a window is showing.
/// `to_label` is the destination, which may be any Veistra window including the
/// one it is already in.
///
/// Still named by *window*, because that is what the drag layer can find out —
/// `window_at_cursor` hit-tests screen rectangles, and a cluster has none of its
/// own. The window-to-cluster step is `ShellState::move_terminal`'s, under the
/// same lock as the move; see its doc comment.
#[tauri::command]
pub fn move_terminal(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    id: String,
    to_label: String,
) {
    shell.move_terminal(&app, &id, &to_label);
}

/// Which terminal a cluster's band is showing.
#[tauri::command]
pub fn set_active_terminal(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    cluster_id: String,
    id: Option<String>,
) {
    shell.set_active_terminal(&app, &cluster_id, id);
}

/// How tall a cluster's terminal band was left, at the end of a drag on its
/// handle. The band is drawn inside the cluster's half of the window, so the
/// height is the cluster's — see `ShellState::set_band_height`.
#[tauri::command]
pub fn set_band_height(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    cluster_id: String,
    height: f32,
) {
    shell.set_band_height(&app, &cluster_id, height);
}

/// A terminal's own program set its title (an OSC `0`/`2` escape sequence),
/// and the emulator that saw it is reporting up.
///
/// Just a thin forward to `ShellState::set_terminal_title` — that's where the
/// empty/no-op guards and the path-shortening live, both explained there.
/// This command exists purely so the frontend has something to `invoke`.
#[tauri::command]
pub fn set_terminal_title(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    id: String,
    title: String,
) {
    shell.set_terminal_title(&app, &id, &title);
}

/// Where to point a tool's iframe, or why there is nothing to point it at.
///
/// The tool window calls this once per tool it mounts. Resolution is per-tool
/// and on demand rather than part of the stack snapshot: a tool's dev server
/// can come and go while the shell is running, and a checkout can be built
/// after the shell started.
#[tauri::command]
pub fn tool_frontend(app: tauri::AppHandle, id: String) -> Result<tool_frontend::ToolFrontend> {
    tool_frontend::resolve(&app, &id)
}

/// Every first-party app this build ships, for the switcher bar.
///
/// Not part of the stack snapshot, and not refreshable: apps are compiled in
/// (see `apps::REGISTRY`), so the answer cannot change while the app is running
/// the way a tool's checkout can. The frontend asks once.
///
/// **This is the list of things with a frontend**, and it is what the shell
/// resolves a mountable URL from. It is *not* the Apps menu's list — see
/// `list_openables`, which is the union of this and a terminal.
#[tauri::command]
pub fn list_apps() -> Vec<apps::AppInfo> {
    apps::list()
}

/// Everything the Apps menu offers: every app, every listed plugin surface, then
/// a terminal.
///
/// A second command rather than a wider `list_apps`, because the two answer
/// different questions and only one of them has a URL in it. `apps::openables`
/// carries the full reasoning; the short version is that a terminal has no
/// frontend, and an `AppInfo` with an empty `url` would put a blank iframe
/// behind every terminal — `state/toolFrontend.ts` resolves a mountable URL
/// straight off the app list, so an entry in it is a promise there is something
/// to mount.
///
/// **Unlike `list_apps`, this is not asked once.** Installing, removing or
/// reloading a plugin changes it, so the shell re-asks whenever
/// `plugins:changed` fires — see `plugins::CHANGED_EVENT`. Repeat calls are safe
/// and cheap; each one re-reads the installed manifests off disk, which is the
/// same read that makes a rebuilt plugin's new surfaces appear.
#[tauri::command]
pub fn list_openables(app: tauri::AppHandle) -> Vec<apps::Openable> {
    apps::openables(&app)
}

// --- plugins ----------------------------------------------------------------

/// Every installed plugin, resolved against its checkout right now.
///
/// The failures are **kept**, unlike the list the switcher is built from: this
/// is the management screen, and a plugin whose checkout has moved is exactly
/// what a person opened it to find out about. A row here is a record plus
/// either what its manifest says or why it could not be read.
///
/// Re-reads every manifest off disk on each call, which is what makes it correct
/// after a rebuild and is why it is not cached anywhere.
#[tauri::command]
pub fn list_plugins(app: tauri::AppHandle) -> Vec<plugins::PluginRow> {
    plugins::rows(&app)
}

/// Install an app from a GitHub repository — a URL, or `owner/name`.
///
/// `expected_id` is set when the install came from the library, where the
/// catalog already claims which package this is; a release whose manifest
/// disagrees is refused rather than quietly installed under another name.
///
/// `spawn_blocking` for the same reason the folder picker uses it: every call
/// inside is a blocking request, and running them on the main thread would
/// freeze the window for the length of a download. Progress arrives separately,
/// on `plugins:install-progress`.
#[tauri::command]
pub async fn install_plugin_repo(
    app: tauri::AppHandle,
    input: String,
    expected_id: Option<String>,
    private_hint: Option<bool>,
) -> Result<plugins::PluginRow> {
    let handle = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || {
        plugins::install::from_repo(
            &handle,
            &input,
            expected_id.as_deref(),
            private_hint.unwrap_or(false),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Plugin {
        action: "install",
        reason: format!("the install could not be started: {e}"),
    })?
    .map_err(|reason| AppError::Plugin {
        action: "install",
        reason,
    })?;

    Ok(plugins::PluginRow::installed(installed, &app))
}

/// Whether a GitHub token is stored. Never returns the token.
///
/// The frontend needs to know whether to offer *Sign in* or *Signed in*, and
/// has no use at all for the value — so this answers the question actually
/// being asked rather than handing over a credential to be inspected.
#[tauri::command]
pub fn has_github_token() -> bool {
    plugins::install::has_token()
}

/// Store a GitHub token, or clear it when given an empty string.
///
/// Goes to the OS credential store — Windows Credential Manager — rather than
/// to `plugins.json`, which is a plain file beside the layout and the project
/// list. A token is the one piece of per-user state here that is a secret.
#[tauri::command]
pub fn set_github_token(token: String) -> Result<()> {
    plugins::install::set_token(&token).map_err(|reason| AppError::Plugin {
        action: "sign in",
        reason,
    })
}

/// The app library: what this build offers to install, and what is already in.
///
/// Compiled in from `catalog.toml`, so this answers offline and answers the same
/// thing every time within one build. Only `installed` moves, which is why the
/// library is re-asked on `plugins:changed` rather than cached by the frontend.
#[tauri::command]
pub fn list_catalog(app: tauri::AppHandle) -> Vec<plugins::catalog::CatalogRow> {
    let registry = app.state::<plugins::Registry>();
    plugins::catalog::rows(|id| registry.contains(id))
}

/// Install a plugin from a folder already on this machine.
///
/// The development path, and in this build the only one. `path` is a directory
/// the person picked; everything about what the plugin *is* comes from the
/// `veistra-tool.toml` inside it rather than from anything the frontend asserts.
#[tauri::command]
pub fn install_plugin_folder(app: tauri::AppHandle, path: String) -> Result<plugins::PluginRow> {
    let path = PathBuf::from(path);
    plugins::install_folder(&app, &path)
        .map(|resolved| plugins::PluginRow::installed(resolved, &app))
        .map_err(|e| AppError::Plugin {
            action: "install",
            reason: e.to_string(),
        })
}

/// Pick a folder and install what is in it, in one step.
///
/// Separate from [`install_plugin_folder`] because the picker has to be opened
/// from Rust — the same reason `home/open-project` does it there. `Ok(None)` is
/// a cancelled dialog, which is an ordinary outcome and not an error.
#[tauri::command]
pub async fn choose_and_install_plugin(
    app: tauri::AppHandle,
) -> Result<Option<plugins::PluginRow>> {
    // `spawn_blocking` for the same reason `app_call` uses it: `pick_folder` is
    // a native modal that needs the main thread free to pump its events, and
    // called *from* the main thread it would wait on the thread it is occupying.
    let picked = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| AppError::Plugin {
            action: "install",
            reason: format!("the folder picker failed: {e}"),
        })?;

    let Some(path) = picked else { return Ok(None) };

    plugins::install_folder(&app, &path)
        .map(|resolved| Some(plugins::PluginRow::installed(resolved, &app)))
        .map_err(|e| AppError::Plugin {
            action: "install",
            reason: e.to_string(),
        })
}

/// Forget a plugin, stopping its core first.
///
/// The record only. A folder install points at a working tree the person already
/// had, and this never deletes what it did not create — see `plugins::Source`.
#[tauri::command]
pub fn uninstall_plugin(app: tauri::AppHandle, id: String) -> bool {
    plugins::uninstall(&app, &id)
}

/// Stop a plugin's core and have every window re-read its manifest.
///
/// The inner loop for someone building a plugin: `cargo build` in a terminal,
/// then this, and the next call reaches the new binary. The frontend half needs
/// nothing — a surface pointed at the plugin's own dev server already has Vite's
/// hot reload running inside the real shell.
///
/// Safe to call on a plugin whose core was never started; `false` means only
/// that no plugin has that id.
#[tauri::command]
pub fn reload_plugin(app: tauri::AppHandle, id: String) -> bool {
    plugins::reload(&app, &id)
}

/// Turn a plugin's surfaces on or off without forgetting it.
#[tauri::command]
pub fn set_plugin_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> bool {
    plugins::set_enabled(&app, &id, enabled)
}

/// One `invoke` from an app's frontend, routed to that app's Rust half.
///
/// This is the shell end of transport B for apps. The iframe posts a `request` message,
/// `ToolWindow` forwards it here, and the reply goes back as a `response` — so an app's UI calls
/// `invoke("files/list")` through `@veistra/bridge` exactly as a tool's UI would, and never learns
/// that its host answered in-process rather than over a pipe. The error type is `RpcError`, not
/// this crate's `AppError`: it carries the JSON-RPC `code` the bridge turns back into a
/// `VeistraRpcError`, which is what lets a frontend tell "no such method" from "that file isn't text"
/// without parsing an error string.
///
/// `id` names the app — the code that answers. `instance_id` names the surface that asked, and it
/// is what decides *which project* the answer is about now that a project belongs to a cluster:
/// Rust resolves the instance to the cluster whose pane tree holds it, and that cluster to its
/// project (see [`apps::CallContext`]). Without it two Files in two clusters would be
/// indistinguishable here and both would root at whichever project answered first. It is `Option`
/// because not every caller has one and pretending otherwise would mean inventing one: the shell's
/// own File > Open… is a title-bar menu item with no frame behind it, and passes `cluster_id`
/// instead, which is the same question answered from the other end. A call with neither gets a
/// context with no cluster and no project, which every app already has to handle — the same state
/// as a cluster nobody has opened anything in.
#[tauri::command]
pub async fn app_call(
    app: tauri::AppHandle,
    id: String,
    instance_id: Option<String>,
    cluster_id: Option<String>,
    method: String,
    params: Option<serde_json::Value>,
) -> std::result::Result<serde_json::Value, veistra_rpc::RpcError> {
    // The whole dispatch moves to a blocking worker and this command awaits it. A synchronous
    // `#[tauri::command]` runs on the **main thread**, and an app's Rust half does things that must
    // not happen there: `home/open-project` opens a native folder picker, which needs the main
    // thread to pump events while it is up — called from the main thread it would be waiting for a
    // thread it is itself occupying, and the app would hang with a dialog that never appears.
    // `files/read` is a milder case of the same thing, a quarter-megabyte read off a slow disk
    // freezing every window for as long as it takes. The cost is one thread hop per `invoke`; the
    // property bought is that an app's Rust half can do ordinary blocking work without having to
    // know it is running somewhere that forbids it.
    tauri::async_runtime::spawn_blocking(move || {
        // Resolved on the worker rather than before the hop, so the lookup sees the layout as it
        // is when the call runs. A context read on the main thread and then carried across could
        // name a cluster that closed while the call was queued.
        let context =
            apps::CallContext::resolve(&app, instance_id.as_deref(), cluster_id.as_deref());
        apps::call_for_instance(&app, &context, instance_id.as_deref(), &id, &method, params)
    })
    .await
    // The worker itself failed — it panicked, or the runtime is shutting down.
    // Neither is something the app's own error vocabulary describes, so it
    // becomes a plain internal error rather than being unwrapped into a panic
    // that would take the main thread with it.
    .unwrap_or_else(|e| {
        Err(veistra_rpc::RpcError::new(
            veistra_rpc::INTERNAL_ERROR,
            format!("the app call did not complete: {e}"),
        ))
    })
}

/// One cluster's project, for the title bar.
///
/// The shell's own read, where `home/state` used to be borrowed for it. Home's
/// method answers the *calling surface's* cluster, which is exactly the wrong
/// scope for a title bar: the bar names whichever cluster the window is
/// showing, and that changes with a click on a chip rather than with anything a
/// frame does. It is also asked on every cluster switch, and routing that
/// through an app's dispatcher to fetch the Recent list as well would be paying
/// for a list nobody in the title bar draws.
///
/// A `ProjectInfo` rather than a bare path, because the bar names the project
/// and the manifest's name wins over the folder's — see `project::describe`.
#[tauri::command]
pub fn cluster_project(
    app: tauri::AppHandle,
    cluster_id: Option<String>,
) -> Option<project::ProjectInfo> {
    project::snapshot(&app, cluster_id.as_deref()).open
}

/// Point a cluster at a project, or at nothing, without going through Home.
///
/// Home's methods are the ones a person reaches — they raise a picker, touch
/// the Recent list, and initialize a folder that needs it. This is the
/// primitive underneath: it moves the cluster's pointer and nothing else.
///
/// It exists because the layout has to be able to say so on its own. Restoring
/// a session, seeding a first run, and the migration in `lib.rs` all set a
/// cluster's project without any of them being a user opening one, and routing
/// those through Home would put a folder in the Recent list every launch.
#[tauri::command]
pub fn set_cluster_project(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    cluster_id: String,
    path: Option<String>,
) {
    let moved = shell.cluster_project(&cluster_id) != path;

    // A worktree or environment belongs to the repository it was cut from, and
    // both outrank the project in `cluster_root`. Leaving one set would keep
    // this cluster's terminals in the old project while the title named the new
    // one, the same reason `project::open` clears the worktree.
    if moved {
        shell.set_cluster_worktree(&app, &cluster_id, None);
        if shell
            .cluster_environment(&cluster_id)
            .is_some_and(|e| !e.is_main())
        {
            shell.set_cluster_environment(&app, &cluster_id, None);
        }
    }

    shell.set_cluster_project(&app, &cluster_id, path);
    project::retitle(&app);
    // A new project needs its `.mcp.json` before an agent starts in it.
    crate::mcp::sync_all(&app);

    // Shells nobody has typed in follow the project; the rest stay where their
    // owner left them. See `PtySessions::retarget_untyped`.
    if moved {
        if let Some(dir) = project::cluster_path(&app, &cluster_id) {
            let ids: Vec<String> = shell
                .snapshot()
                .terminals
                .into_iter()
                .filter(|t| t.cluster_id == cluster_id)
                .map(|t| t.id)
                .collect();
            app.state::<PtySessions>().retarget_untyped(&ids, &dir);
        }
    }
}

/// One row of the Switch Project dialog (board 08): a Recent-list entry plus
/// how much of it is live right now. Flattens `project::ProjectInfo` rather
/// than nesting it, so the frontend reads one flat object per row instead of
/// reaching through `.info.name` — this type exists for exactly one dialog
/// and has no other shape to agree with.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectRow {
    pub name: String,
    pub path: String,
    pub id: Option<String>,
    pub initialized: bool,
    pub exists: bool,
    pub last_opened: Option<u64>,
    /// Whether any cluster, in any window, has this project open right now.
    pub open: bool,
    pub cluster_count: usize,
    pub environment_count: usize,
}

/// The Switch Project dialog's row list: every Recent entry, each carrying
/// [`ShellState::project_live_counts`]'s answer for it. `format`/`modified`
/// from `project::ProjectInfo` are left out — the dialog names in board 08's
/// spec (`environmentCount`, `clusterCount`, a relative "last opened" the
/// frontend derives from `lastOpened`) don't use them, and a field with no
/// reader is a field nobody notices going stale.
#[tauri::command]
pub fn list_recent_projects(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
) -> Vec<RecentProjectRow> {
    project::snapshot(&app, None)
        .recents
        .into_iter()
        .map(|info| {
            let counts = shell.project_live_counts(&info.path);
            RecentProjectRow {
                name: info.name,
                path: info.path,
                id: info.id,
                initialized: info.initialized,
                exists: info.exists,
                last_opened: info.last_opened,
                open: counts.open,
                cluster_count: counts.cluster_count,
                environment_count: counts.environment_count,
            }
        })
        .collect()
}

/// Open a Recent-list project into a cluster, for the Switch Project dialog.
///
/// Goes through `project::open` directly rather than `set_cluster_project` —
/// this is a person choosing a project, so it belongs in the Recent list and
/// gets the pinned Design cluster and the open-preset the same way Home's own
/// "Open project" does; `set_cluster_project` is the quieter primitive under
/// that, for callers restoring or seeding a cluster rather than opening one.
#[tauri::command]
pub fn open_project_in_cluster(
    app: tauri::AppHandle,
    cluster_id: String,
    path: String,
) -> Result<project::ProjectSnapshot> {
    project::open(&app, Path::new(&path), &cluster_id)
}

/// The event [`choose_project_icon`] broadcasts, carrying [`ProjectIconChanged`].
pub const PROJECT_ICON_EVENT: &str = "project:icon";

/// Which project's icon changed, and what it is now.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIconChanged {
    pub path: String,
    pub icon: Option<String>,
}

/// A project's `.veistra/icon.*` as a `data:` URL, or `None` for the letter tile.
/// See `project::icon` for why a data URL and why the size is capped.
#[tauri::command]
pub fn project_icon(path: String) -> Option<String> {
    project::icon::data_url(Path::new(&path))
}

/// Pick an image and copy it into `path` as the project's icon.
///
/// `Ok(None)` is a cancelled picker. The picker opens from Rust, the same
/// reason `choose_and_install_plugin` gives: `tauri-plugin-dialog` cannot be
/// added to this crate (its `Cargo.toml` note on `rfd` explains why), and
/// `rfd` is what that plugin wraps anyway. `spawn_blocking` for that
/// command's reason too: the dialog needs the main thread free.
///
/// Broadcasts [`PROJECT_ICON_EVENT`] so the title bar, the Switch project
/// dialog and any other window redraw without being asked.
#[tauri::command]
pub async fn choose_project_icon(app: tauri::AppHandle, path: String) -> Result<Option<String>> {
    let parent = app.get_webview_window("main");
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_title("Choose a project icon")
            .add_filter("Image", &["png", "svg", "jpg", "jpeg", "webp"]);
        if let Some(window) = parent.as_ref() {
            dialog = dialog.set_parent(window);
        }
        dialog.pick_file()
    })
    .await
    .map_err(|e| AppError::ProjectIcon(format!("the image picker failed: {e}")))?;

    let Some(source) = picked else {
        return Ok(None);
    };

    let icon = project::icon::set(Path::new(&path), &source)?;
    let _ = tauri::Emitter::emit(
        &app,
        PROJECT_ICON_EVENT,
        &ProjectIconChanged {
            path,
            icon: Some(icon.clone()),
        },
    );
    Ok(Some(icon))
}

// --- layout presets ---------------------------------------------------------
//
// A preset is a named arrangement: the split shape, and which app belongs in
// each pane. See `presets`'s module doc for the model and for why it is not a
// `PaneNode`.
//
// Every command here acts on the **calling window's active cluster**, and none
// of them takes a cluster id. That is what the menu means by "this cluster" —
// the row is drawn in the bar of the cluster you are looking at — and a cluster
// id in the arguments would be a second answer to a question the window has
// already answered, with a window able to apply a preset to a cluster it is not
// showing and cannot see the result of.

/// Every preset: the compiled-in built-ins, then whatever survives of
/// `presets.json`.
///
/// Fetched once per window, because Tauri events have no replay — the same gap
/// `shell_state` and `boot_status` both close this way. Afterwards a window
/// keeps up through `presets:changed`, which `save_preset` emits.
#[tauri::command]
pub fn list_presets(app: tauri::AppHandle) -> Vec<presets::LayoutPreset> {
    presets::list(&app)
}

/// Capture the active cluster's arrangement and save it under `name`.
///
/// Returns the whole merged list, so the window that asked repaints its menu
/// without waiting for the broadcast it is also about to receive — the same
/// double answer `project`'s mutators give Home, and for the same reason: the
/// caller has a reply to read, and everyone else needs the event.
///
/// Refuses a blank name and a built-in's name; see `presets::save` for why the
/// second one is a refusal rather than a second row with the same label.
#[tauri::command]
pub fn save_preset(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    label: String,
    name: String,
) -> Result<Vec<presets::LayoutPreset>> {
    let root = shell
        .capture_preset(&label)
        .ok_or(AppError::NoCluster("save the arrangement of"))?;
    presets::save(&app, &name, root)
}

/// Rearrange the active cluster to match a preset.
///
/// Two phases, and the split is forced rather than chosen. `ShellState` does the
/// rearranging in one mutation — every surface already open is moved into the
/// slot that matches it, and everything the preset did not mention is left in
/// the last pane, **with nothing closed** — and hands back the slots it had
/// nothing to fill. Filling those is this function's half, because a slot may
/// want a terminal, and a terminal is a pty: it comes from `PtySessions` through
/// `open_terminal`, which is the one path in the app that spawns a shell and is
/// not about to become two.
///
/// Each fill is its own broadcast and its own write of `layout.json`. That is
/// the same trade `add_cluster` makes a few sections up and for the same reason:
/// both are cheap, and the alternative is a `ShellState` primitive that quietly
/// opens surfaces nobody asked it for.
///
/// A gap that cannot be filled is skipped rather than failing the whole apply.
/// The arrangement is already on screen by then, and refusing it because one
/// shell would not spawn would undo work the user can see in front of them.
#[tauri::command]
pub fn apply_preset(
    app: tauri::AppHandle,
    shell: State<'_, ShellState>,
    ptys: State<'_, PtySessions>,
    label: String,
    preset_id: String,
) -> Result<()> {
    let preset = presets::find(&app, &preset_id)
        .ok_or_else(|| AppError::UnknownPreset(preset_id.clone()))?;

    let (cluster_id, gaps) = shell
        .apply_preset(&app, &label, &preset.root)
        .ok_or(AppError::NoCluster("apply a preset to"))?;

    fill_preset_gaps(&app, &shell, &ptys, &label, &cluster_id, gaps);
    Ok(())
}

/// The gap-filling half of `apply_preset` above, split out so
/// `project::open`'s automatic layout can share it rather than reimplement
/// it — a preset applied by a click and one applied because a folder was just
/// opened fill their gaps exactly the same way. See `apply_preset`'s own doc
/// comment for the rest of the reasoning; it still applies unchanged.
fn fill_preset_gaps(
    app: &tauri::AppHandle,
    shell: &ShellState,
    ptys: &PtySessions,
    label: &str,
    cluster_id: &str,
    gaps: Vec<presets::Gap>,
) {
    for gap in gaps {
        match gap.slot {
            presets::PresetSlot::App { app_id } => {
                // Resolved from the registry rather than trusted from the
                // preset, exactly as `open_instance` above resolves it: the
                // registry is what decides where an `invoke` from the resulting
                // frame is answered. `normalized` has already dropped any slot
                // naming something outside it, so this is `App` in practice —
                // spelled out anyway, because a preset file is user-editable
                // input and this is the door it comes through.
                let kind = if apps::is_app(&app_id) {
                    SurfaceKind::App
                } else {
                    SurfaceKind::Tool
                };
                let title = apps::display_name(app, &app_id);
                // **No direction, so no split.** The apply has already built
                // the tree the preset describes and named the pane each gap
                // belongs to; an open that split that pane would rearrange
                // the arrangement being restored, one surface at a time. The
                // whole feature depends on this staying `None`.
                let Some(instance_id) = shell.open_instance(
                    app,
                    label,
                    OpenRequest {
                        app_id: &app_id,
                        kind,
                        title: &title,
                        pane_id: Some(&gap.pane_id),
                        dir: None,
                    },
                ) else {
                    crate::veistra_log!("could not open `{app_id}` for a preset slot");
                    continue;
                };
                // Only when appending would have put it in the wrong place,
                // which is only ever a pane holding more than one slot. See
                // `presets::Gap::index`: the common pane costs one mutation, not
                // two.
                if let Some(index) = gap.index {
                    shell.move_instance(app, &instance_id, cluster_id, &gap.pane_id, Some(index));
                }
            }
            presets::PresetSlot::Terminal => {
                // The same path the Apps menu's Terminal row takes — see
                // `open_terminal_into_pane`, which is where the spawn-then-move
                // and the two-kinds-of-terminal reasoning are written down. A
                // preset slot and a menu click asking for the same thing must
                // not be able to produce two different kinds of terminal.
                if let Err(e) = open_terminal_into_pane(
                    app,
                    shell,
                    ptys,
                    cluster_id,
                    &gap.pane_id,
                    gap.index,
                    // No direction, for the reason the app branch above gives:
                    // the preset already decided the shape.
                    None,
                ) {
                    crate::veistra_log!("could not open a terminal for a preset slot: {e}");
                }
            }
        }
    }
}

// --- review comments ---------------------------------------------------------
//
// Six commands over `crate::review`, all cluster-scoped for `git`'s reason: the frontend never
// names a directory for the backend to write in. Each is a call into `review` and nothing else —
// the read-modify-write, the lock and the file are all that module's, and none of it is testable
// from here.

/// Every note stored for this cluster's checkout, in file-then-line order.
///
/// An **empty list**, not an error, for a cluster with no project or one that is not a repository.
/// The panel calls this on every cluster switch, and both of those are ordinary states rather than
/// something to put a message on screen about — `git_cluster_status` answers its own `None` to the
/// same two.
///
/// Re-read from disk on every call, so it doubles as the refresh after another window has written.
#[tauri::command]
pub fn review_comments(app: tauri::AppHandle, cluster_id: String) -> Vec<ReviewComment> {
    review::checkout(&app, &cluster_id)
        .map(|root| review::load(&root))
        .unwrap_or_default()
}

/// Write a new note, and hand back the stored version of it — with the id the caller needs to
/// address it by afterwards.
#[tauri::command]
pub fn review_comment_add(
    app: tauri::AppHandle,
    cluster_id: String,
    draft: ReviewDraft,
) -> Result<ReviewComment> {
    let now = review::now_ms();
    review::edit(&app, &cluster_id, |comments| {
        review::add(comments, draft, now)
    })
}

/// Rewrite a note's body. Clears its sent stamp — see `review::ReviewComment::sent_at`.
#[tauri::command]
pub fn review_comment_update(
    app: tauri::AppHandle,
    cluster_id: String,
    id: String,
    body: String,
) -> Result<ReviewComment> {
    let now = review::now_ms();
    review::edit(&app, &cluster_id, |comments| {
        review::update(comments, &id, &body, now)
    })
}

/// Mark a note dealt with, or put it back.
#[tauri::command]
pub fn review_comment_resolve(
    app: tauri::AppHandle,
    cluster_id: String,
    id: String,
    resolved: bool,
) -> Result<ReviewComment> {
    let now = review::now_ms();
    review::edit(&app, &cluster_id, |comments| {
        review::set_resolved(comments, &id, resolved, now)
    })
}

/// Delete a note. No undo, and none is offered: the body is one sentence a person just wrote, and
/// an undo stack for it would be more machinery than the thing it protects.
#[tauri::command]
pub fn review_comment_remove(app: tauri::AppHandle, cluster_id: String, id: String) -> Result<()> {
    review::edit(&app, &cluster_id, |comments| review::remove(comments, &id))
}

/// Stamp notes as handed to an agent, and say how many were.
///
/// Called *after* the frontend has put the text in the clipboard or the terminal, which is why
/// unknown ids are skipped rather than fatal — see `review::mark_sent`. The count is what the
/// caller confirms with; it can be lower than the ids asked for if another window deleted one in
/// between.
#[tauri::command]
pub fn review_comments_mark_sent(
    app: tauri::AppHandle,
    cluster_id: String,
    ids: Vec<String>,
) -> Result<usize> {
    let now = review::now_ms();
    review::edit(&app, &cluster_id, |comments| {
        Ok(review::mark_sent(comments, &ids, now))
    })
}

/// Arrange a freshly opened project onto [`presets::PROJECT_OPEN_PRESET_ID`]
/// — see that constant's doc comment — called once, from `project::open`.
///
/// Every failure here gives up quietly rather than surfacing an error: the
/// project has already opened and is on screen by the time this runs, and
/// refusing to finish over a layout that could not be arranged would be worse
/// than leaving it unarranged.
pub(crate) fn apply_project_open_preset(app: &tauri::AppHandle, cluster_id: &str) {
    let Some(preset) = presets::find(app, presets::PROJECT_OPEN_PRESET_ID) else {
        crate::veistra_log!("the built-in project-open preset is missing");
        return;
    };

    let shell = app.state::<ShellState>();
    let Some((label, gaps)) = shell.apply_preset_to_cluster(app, cluster_id, &preset.root) else {
        return;
    };

    let ptys = app.state::<PtySessions>();
    fill_preset_gaps(app, &shell, &ptys, &label, cluster_id, gaps);
}

// --- usage data -------------------------------------------------------------
//
// Four thin calls over `crate::telemetry`. None of them sends anything: what
// leaves the machine leaves from the webview, and only after the person has
// said yes. See `docs/telemetry.md`.

/// Whether this build can send, where to, and the install id to send as.
/// Mints the id on first call; safe to call from every window.
#[tauri::command]
pub fn telemetry_config(app: tauri::AppHandle) -> crate::telemetry::TelemetryConfig {
    crate::telemetry::config(&app)
}

/// The usage ledger: launches, counted events and prompt history. Re-read on
/// every call, so it doubles as the refresh after another window counted.
#[tauri::command]
pub fn telemetry_ledger(app: tauri::AppHandle) -> crate::telemetry::Ledger {
    crate::telemetry::ledger(&app)
}

/// Add one to a counter, answering with the whole ledger. Refuses a name that
/// is not lower-case `a-z0-9_:/.-`, or a new counter past the cap.
#[tauri::command]
pub fn telemetry_count(app: tauri::AppHandle, key: String) -> Result<crate::telemetry::Ledger> {
    crate::telemetry::count(&app, &key)
}

/// Record that a feedback prompt was shown or answered. Answering twice keeps
/// the first date.
#[tauri::command]
pub fn telemetry_prompt(
    app: tauri::AppHandle,
    id: String,
    outcome: crate::telemetry::PromptOutcome,
) -> Result<crate::telemetry::Ledger> {
    crate::telemetry::record_prompt(&app, &id, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environments::Environment;

    /// A synchronous command runs on the main thread, and building a window
    /// there can deadlock it for good; `windows::create` says how. The hang
    /// needs a second window to be closing at that instant, so no test can
    /// reproduce it. This reads the source and holds the rule instead.
    #[test]
    fn every_command_that_builds_a_window_is_async() {
        let source = include_str!("commands.rs");
        let commands = source.split("#[cfg(test)]").next().unwrap_or_default();
        let builders = [
            "windows::create(",
            "windows::detach(",
            "windows::detach_cluster(",
        ];

        let mut checked = 0;
        for command in commands.split("#[tauri::command]").skip(1) {
            if !builders.iter().any(|call| command.contains(call)) {
                continue;
            }
            let signature = command
                .lines()
                .find(|l| l.starts_with("pub "))
                .unwrap_or_default();
            assert!(
                signature.starts_with("pub async fn "),
                "a command that builds a window must be async: `{signature}`"
            );
            checked += 1;
        }
        assert_eq!(checked, 3, "new_window, detach_cluster and detach_instance");
    }

    fn new_worktree(name: &str, base: Option<&str>) -> EnvironmentChoice {
        EnvironmentChoice::NewLocalWorktree {
            name: name.to_string(),
            base: base.map(str::to_string),
        }
    }

    #[test]
    fn a_new_worktree_in_a_plain_folder_says_there_is_no_repository() {
        let dir = tempfile::tempdir().unwrap();
        let err =
            resolve_environment_choice(dir.path().to_str().unwrap(), new_worktree("feat", None))
                .unwrap_err()
                .to_string();
        assert!(err.contains("no git repository"), "{err}");
        assert!(!err.contains("fatal"), "{err}");
    }

    #[test]
    fn a_new_worktree_in_an_empty_repository_says_there_are_no_commits() {
        let dir = tempfile::tempdir().unwrap();
        let out = crate::git::git_command()
            .current_dir(dir.path())
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(out.status.success());
        let err =
            resolve_environment_choice(dir.path().to_str().unwrap(), new_worktree("feat", None))
                .unwrap_err()
                .to_string();
        assert!(err.contains("no commits yet"), "{err}");
    }

    #[test]
    fn a_new_worktree_without_a_base_forks_from_master_when_that_is_the_only_branch() {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "-q", "-b", "master"],
            vec![
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "first",
            ],
        ] {
            let out = crate::git::git_command()
                .current_dir(dir.path())
                .args(&args)
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}");
        }
        let env =
            resolve_environment_choice(dir.path().to_str().unwrap(), new_worktree("feat", None))
                .expect("a master-only repository can have a worktree");
        let Environment::LocalWorktree { base, branch, .. } = env else {
            panic!("expected a local worktree");
        };
        assert_eq!(base, "master");
        assert_eq!(branch, "wt/feat");
    }

    #[test]
    fn a_terminal_starts_in_the_cluster_root_before_any_fallback() {
        let p = |s: &str| Some(PathBuf::from(s));
        assert_eq!(
            pick_terminal_cwd(p("/wt"), p("/stack"), p("/proc")),
            PathBuf::from("/wt")
        );
        assert_eq!(
            pick_terminal_cwd(None, p("/stack"), p("/proc")),
            PathBuf::from("/stack")
        );
        assert_eq!(
            pick_terminal_cwd(None, None, p("/proc")),
            PathBuf::from("/proc")
        );
        assert_eq!(pick_terminal_cwd(None, None, None), PathBuf::from("."));
    }

    fn local_worktree() -> Environment {
        Environment::LocalWorktree {
            name: "feat-x".to_string(),
            path: "C:/proj/.veistra/worktrees/feat-x".to_string(),
            branch: "wt/feat-x".to_string(),
            base: "main".to_string(),
        }
    }

    /// Every `PresetSlot::App`'s `app_id`, in tree order — what the
    /// `starting_layout_preset` tests below check against [`VIEWER_APPS`]
    /// without caring how deeply the split nests.
    fn app_ids(node: &presets::PresetNode) -> Vec<String> {
        use presets::{PresetNode, PresetSlot};
        match node {
            PresetNode::Pane { slots } => slots
                .iter()
                .filter_map(|s| match s {
                    PresetSlot::App { app_id } => Some(app_id.clone()),
                    PresetSlot::Terminal => None,
                })
                .collect(),
            PresetNode::Split { children, .. } => children.iter().flat_map(app_ids).collect(),
        }
    }

    #[test]
    fn godot_layout_references_the_viewer_app_table() {
        let ids = app_ids(&starting_layout_preset(StartingLayout::Godot));
        assert_eq!(ids, vec!["files", VIEWER_APPS.godot, VIEWER_APPS.play]);
    }

    #[test]
    fn blender_layout_references_the_viewer_app_table() {
        let ids = app_ids(&starting_layout_preset(StartingLayout::Blender));
        assert_eq!(ids, vec!["files", VIEWER_APPS.blender]);
    }

    #[test]
    fn a_typed_name_is_kept_as_is() {
        assert_eq!(
            cluster_name_or_environment_fallback("Flashlight", &local_worktree()),
            "Flashlight"
        );
    }

    #[test]
    fn a_blank_name_falls_back_to_the_environments_branch() {
        assert_eq!(
            cluster_name_or_environment_fallback("", &local_worktree()),
            "wt/feat-x"
        );
        assert_eq!(
            cluster_name_or_environment_fallback("   ", &local_worktree()),
            "wt/feat-x",
            "whitespace-only counts as blank too"
        );
    }

    #[test]
    fn a_blank_name_on_main_falls_back_to_main_itself() {
        assert_eq!(
            cluster_name_or_environment_fallback("", &Environment::Main),
            "Main",
            "Main has no branch of its own — see Environment::branch's doc"
        );
    }
}
