//! Veistra orchestrator — the entry point that ties the multi-repo stack together.
//!
//! The Rust side owns everything that touches the machine: reading the stack
//! manifest, finding component checkouts on disk, and comparing what's there
//! against the pinned versions. The web frontend is a pure view over the
//! `StackSnapshot` this produces.

mod agent_saw;
mod apps;
mod blender;
mod boot;
mod branding;
mod cloud;
mod commands;
mod comments;
mod context;
mod context_commands;
mod copilot_key;
#[cfg(feature = "design-mode")]
mod design_comments;
mod devtools;
mod diagnostics;
mod discovery;
mod environments;
mod error;
mod exit_watchdog;
mod file_watch;
mod git;
mod git_repo;
mod github;
mod godot;
mod harness;
mod launch;
mod launch_guard;
mod layout;
mod manifest;
mod mcp;
mod pages;
mod plane_webview;
mod plugins;
mod presets;
mod project;
mod pty;
mod quoting;
mod refs;
mod review;
mod runnable;
mod search;
mod settings;
mod shell_state;
mod shell_store;
mod skills;
mod state;
mod sync;
mod telemetry;
mod tool;
mod tool_frontend;
mod updater;
mod userdata;
mod webview;
mod windows;

#[cfg(feature = "design-mode")]
use design_comments::Comments;
use project::ProjectState;
use pty::PtySessions;
use shell_state::ShellState;
use state::AppState;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WindowEvent};

/// Stop Windows putting a modal box in front of the splash for a failure it
/// could simply return.
///
/// `SEM_FAILCRITICALERRORS` turns off the *hard error* dialogs the system shows
/// on a process's behalf: no disk in the drive, and — the one that matters here
/// — an image `CreateProcess` will not load. Without it, one bad `.exe` on
/// `PATH` is an application that looks like it did not start, because the box is
/// modal and the spawn that raised it is on this thread. `runnable` stops the
/// shell candidates reaching that state; this covers everything else the
/// orchestrator or a plugin ever spawns.
///
/// Set once, before Tauri builds anything, so no other thread exists to race it.
/// The previous mask is read and kept rather than replaced: `SetErrorMode`
/// takes the whole value, and dropping whatever the loader had set would be a
/// change nobody asked for.
///
/// **Not observed to fix issue #36** — that needs a clean machine — and it is
/// here as the general form of that failure rather than as its confirmed cure.
#[cfg(windows)]
fn quiet_hard_errors() {
    use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS};

    // SAFETY: `SetErrorMode` reads and writes one process-wide bitmask and
    // touches nothing else. Called before any thread but this one exists.
    unsafe {
        let previous = SetErrorMode(0);
        SetErrorMode(previous | SEM_FAILCRITICALERRORS);
    }
}

/// Nothing to do: the other two platforms return an error from `exec` rather
/// than showing anybody a dialog.
#[cfg(not(windows))]
fn quiet_hard_errors() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    quiet_hard_errors();

    // Bound to a name rather than written inline at `.build` below, so the
    // identifier can be read before any plugin runs. An agent build overrides
    // it on the command line, so the constant in `userdata::identity` would
    // name the wrong process there.
    let context = tauri::generate_context!();
    launch_guard::clear_hung_primary(&context.config().identifier);

    let launched = tauri::Builder::default()
        // **First, before every other plugin.** Explorer's "Open with Veistra"
        // launches this binary again, and everything registered above this
        // line would also run in the process that is about to be told to exit.
        // The callback receives the second launch's argv and this process
        // acts on it; see `launch`'s module doc for why a second *process*
        // would be a data-loss bug rather than a cosmetic one.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            launch::from_second_instance(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        // Reads `plugins.updater` out of tauri.conf.json — the endpoint and the
        // public key. Registered unconditionally, including in a debug build
        // where `updater::unsupported` refuses to use it: a plugin that is
        // absent half the time is a second configuration to keep straight, and
        // `app.updater()` failing is not the diagnostic that would explain it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Tool frontends mount as iframes on their own origin. In a release
        // build that origin is this scheme, backed by each tool's built `dist`
        // directory — see `tool_frontend`. In development the frames point at
        // the tools' own dev servers instead, so this never gets hit.
        .register_uri_scheme_protocol(tool_frontend::SCHEME, |ctx, request| {
            let (status, mime, body) = tool_frontend::serve(ctx.app_handle(), request.uri().path());
            // `serve` only ever returns a status and a mime this builder accepts,
            // so the error arm is unreachable in practice. It is answered rather
            // than panicked on anyway: one malformed asset header should cost that
            // request, not the whole webview.
            tauri::http::Response::builder()
                .status(status)
                .header(tauri::http::header::CONTENT_TYPE, mime)
                .body(body)
                .unwrap_or_else(|_| {
                    let mut fallback = tauri::http::Response::new(Vec::new());
                    *fallback.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
                    fallback
                })
        })
        // `manage` puts a value into Tauri's type-keyed state map. Any command
        // that asks for `State<'_, AppState>` gets a reference to this one
        // instance, so there's no global to thread around by hand.
        .manage(AppState::default())
        // Placement and terminal sessions, shared by every window. Separate
        // from `AppState` because they answer a different question: `AppState`
        // is what the *stack* looks like on disk, this is what the *shell*
        // currently looks like on screen.
        .manage(ShellState::default())
        // The live pseudo-terminals, keyed by the session ids `ShellState`
        // hands out. Kept apart from `ShellState` deliberately: that is small,
        // serializable, and broadcast to every window on every change, whereas
        // this holds OS handles and reader threads that must never be cloned or
        // sent anywhere near the frontend.
        .manage(PtySessions::default())
        .manage(file_watch::FileWatches::default())
        // The Recent list: every project this machine has opened. *Not* which
        // one is open — that belongs to a cluster and travels in `layout.json`
        // with the rest of the layout, so that two windows can be working on
        // two projects at once. See `project`'s module doc for the split, and
        // `project::store` for why this was the first thing here to touch the
        // disk at all.
        .manage(ProjectState::default())
        // The one counter that lets an in-flight content search notice a
        // newer one has started and abandon itself early. See
        // `search::SearchState` for why one process-wide counter is enough.
        .manage(search::SearchState::default())
        // A path handed to this launch by Explorer's context menu, parked
        // until a frontend is mounted to collect it. Empty on almost every
        // launch, because almost every launch is somebody opening the app
        // rather than opening something with it.
        .manage(launch::LaunchState::default())
        // The gcloud token cache and parsed cloud objects, for the Agents app.
        // Empty until a cloud app first asks; nothing here calls Google at
        // startup (`docs/cloud-services.md` §8).
        .manage(cloud::Cloud::default())
        // The IAP tunnel to `plane-vm`, for the Projects app. Not started here —
        // only `projects/plane-*` and `projects/wake-start` call `Tunnel::start`,
        // and only against a `Source::Live` — so nothing opens a tunnel before a
        // person has asked Plane for something. `RunEvent::Exit` below is what
        // stops it. See `cloud::tunnel`.
        .manage(cloud::tunnel::Tunnel::default())
        // Games Play started and the Godot Viewer's jobs; `RunEvent::Exit` stops the games.
        .manage(godot::Godot::default())
        // Whether the Plane child webview is open, and the wake flow's snapshot
        // for `projects/wake-status` to poll. See `plane_webview` and
        // `apps::projects::WakeManager`.
        .manage(plane_webview::PlaneWebview::default())
        .manage(apps::projects::WakeManager::default())
        .manage(blender::job::Jobs::default())
        .manage(blender::detect::VersionCache::default())
        // The New Project page's step-runner snapshot, for `home/create-
        // project-status` to poll — the same shape as `WakeManager` above.
        // See `apps::home_create`.
        .manage(apps::home_create::CreateManager::default())
        // One coding agent per agent tab; none runs until a tab sends a
        // prompt, and `RunEvent::Exit` below stops them all.
        .manage(apps::agent_tab::Sessions::default())
        // Which MCP servers this build hosts for whatever agent the user is
        // running in a terminal, and which of them are switched on. Empty until
        // something registers into it — see `mcp`'s module doc for why an app
        // does not host its own.
        .manage(mcp::Registry::default())
        // Where those servers ended up: the loopback port the listener took and
        // the token that opens it. Empty until `mcp::start` has bound, and it
        // stays empty on a machine that would not give us a socket — which
        // costs the MCP feature and nothing else.
        .manage(mcp::Endpoint::default())
        // Where the person's focus is, as each window's shell last reported it,
        // and which MCP sessions have subscribed to hear when it moves. See
        // `mcp::focus` and `mcp::subscriptions`.
        .manage(mcp::FocusState::default())
        .manage(mcp::Subscriptions::default())
        .manage(mcp::Sessions::default())
        // What can be changed, and what has been. Empty until `settings::seed`
        // registers the shell's groups and every app's — a registry with no
        // groups answers every read with "no such setting", which is why the
        // seed happens before anything on screen can ask.
        .manage(settings::Registry::default())
        // What this person has installed. Empty until `hydrate` reads
        // `plugins.json`, which happens in setup below — before the first window
        // asks for the app list, because a switcher drawn from an empty registry
        // would be missing every plugin until something else caused a redraw.
        //
        // It holds records rather than resolved surfaces on purpose: the
        // manifest is re-read off the checkout every time it is asked for, which
        // is what makes a rebuilt plugin's new surfaces appear with nothing to
        // invalidate. See `plugins`'s module doc.
        .manage(plugins::Registry::default())
        // The running plugin cores. Empty until something calls one: the broker
        // spawns lazily, so a plugin whose surfaces nobody has opened costs no
        // process — and the first call after a rebuild starts the new binary
        // with nothing to invalidate. Kept apart from the registry above for the
        // same reason `PtySessions` is kept out of `ShellState`: that is a small
        // serializable record, this holds OS handles and reader threads.
        .manage(plugins::Broker::default())
        // One filesystem watch per folder-installed plugin, so a `cargo build`
        // in a terminal beside the shell restarts that plugin's core without
        // anyone asking. Empty until `plugins::changed` syncs it, which the
        // setup below does once and every install does after.
        .manage(plugins::Watchers::default())
        // Whether a newer Veistra exists, and how far through fetching it we are.
        // One value for the process rather than one per window: two windows
        // offering two different answers to "is there an update" is a bug with
        // no correct resolution, and the event that keeps them level carries
        // this exact state.
        .manage(updater::UpdateStatus::default())
        // The usage ledger: an install id, launch and event counts, and which
        // feedback prompts have been shown. Loaded on first use; nothing in it
        // is sent anywhere by holding it. See `telemetry`.
        .manage(telemetry::Telemetry::default())
        // Every window, every navigation, one call site. The main window and
        // the splash are declared in `tauri.conf.json`, a detached one is built
        // by `windows::create` long after setup has run, and a page-load hook is
        // the only place that sees all three without each of them remembering
        // to ask. Setting it twice costs nothing — it is a property, not a
        // subscription — so `Started` is chosen only because it is the earlier
        // of the two events, not because `Finished` would be wrong.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview::suppress_default_context_menu(webview);
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                // Where a window is, so it can be put back there next launch.
                // Recorded without broadcasting or writing — these fire on
                // every frame of a drag. `windows::request_close`, below, and
                // the next real mutation are what commit them; see
                // `ShellState::set_geometry`.
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if let Some(geometry) = windows::geometry_of(window) {
                        app.state::<ShellState>()
                            .set_geometry(window.label(), geometry);
                    }
                    // `WindowEvent` has no dedicated minimize/restore variant
                    // on every platform Tauri targets — a resize is the event
                    // both fire, so this is also where the Plane webview
                    // learns the window went to (or came back from) the
                    // taskbar. `set_geometry` above never runs `mutate`, so
                    // this is the only other trigger `sync_visibility` needs
                    // beside the one inside it.
                    if window.label() == app.state::<plane_webview::PlaneWebview>().owner() {
                        plane_webview::sync_visibility(app, &app.state::<ShellState>().snapshot());
                    }
                }
                // A window has been asked to close — by our own titlebar's ×,
                // by Alt+F4, by the taskbar, or by the OS shutting down
                // gracefully. All of them reach this event identically; see
                // `windows::request_close` for why that matters and what it
                // does before letting the close proceed.
                WindowEvent::CloseRequested { .. } => {
                    windows::request_close(app, &app.state::<ShellState>(), window.label());
                }
                // A window closing on purpose must not strand what was inside
                // it, so its clusters go back to the main window. `CloseRequested`
                // above now does that fold before the window actually closes, so
                // by the time `Destroyed` lands here the marker it left is
                // already consumed and this is normally a no-op. It stays as a
                // fallback for a window the OS destroys directly, skipping
                // `CloseRequested` — which is also why it must never reclaim
                // unconditionally: at a shutdown that destroys every window that
                // way, `Destroyed` fires for every one of them, and a reclaim
                // that trusted it would collapse the whole session and save the
                // wreckage as the layout to restore. See `ShellState::closing`.
                WindowEvent::Destroyed => {
                    windows::reclaim(app, &app.state::<ShellState>(), window.label());
                    // A closed window cannot hold focus; drop its last report so
                    // the focus resource does not keep pointing at it.
                    if app.state::<mcp::FocusState>().forget(window.label()) {
                        mcp::notify_focus_changed(app);
                    }
                }
                _ => {}
            }
        })
        // `.setup` runs once, after every window declared in tauri.conf.json
        // has been created — so the splash window (`visible: true`) is
        // already on screen by the time this fires. `app.handle()` borrows
        // an `AppHandle` from the `&mut App` this closure receives; `.clone()`
        // turns that borrow into an owned handle `boot::start` can move onto
        // its own thread. `AppHandle` is cheap to clone by design — it's a
        // thin reference to the app's shared internals, not a copy of them.
        .setup(|app| {
            // Before `settings::seed` and so before anything at all reads a
            // store, because a store that has already answered "nothing here"
            // has already told a window the wrong thing. Does nothing on every
            // launch but the first after a rename — see `userdata::adopt`.
            userdata::adopt::run(app.handle());

            // First of the seeds, because everything below this line may read a
            // setting and a registry that has not been seeded answers every
            // read with "no such setting". It depends on nothing itself:
            // registration puts static descriptors on a list, and the only file
            // it touches is its own.
            settings::seed(app.handle());
            copilot_key::sync(app.handle());

            // Before the layout, because `restore_session` reads the old global
            // open project out of this store to migrate it onto a cluster. The
            // launch terminal below opens *inside* whatever cluster the main
            // window ends up showing, and the Files app takes its cluster's
            // project as its default directory — so a restore that ran after
            // either of those would leave them pointing at the stack root for
            // the rest of the session.
            project::restore(app.handle());

            // Before anything can be on screen to ask about it. Registration is
            // pure — it puts static descriptors on a list and touches no port —
            // so it is safe this early, and having the list complete before the
            // first window means the settings surface never draws an empty one
            // it then has to correct.
            mcp::seed(app.handle());

            // Before the listener below, because the design server answers out
            // of this list and a client that connected during the gap would be
            // told there were no comments rather than that they were still
            // loading. Reading one small file, on the setup thread, for the same
            // reason `project::restore` is here.
            //
            // Every comment left on an element in Design Mode. One list for the
            // process rather than one per Design Mode tab: two tabs pointed at
            // the same dev server are two views of one set of outstanding
            // requests, and the MCP server that serves them to an agent is not
            // in a tab at all. Managed here rather than on the builder so the
            // `design-mode` feature can leave it out.
            #[cfg(feature = "design-mode")]
            {
                app.manage(Comments::default());
                app.state::<Comments>().hydrate(app.handle());
            }

            // Immediately after seeding and **before any terminal is spawned**,
            // because a terminal inherits the port and token as environment
            // variables at the moment it is created — one opened first would be
            // the one shell in the session that could not reach the servers.
            //
            // Failure is not fatal and is already reported inside. A machine
            // that will not hand out a loopback socket should still get an
            // orchestrator; what it loses is agent access to Veistra's own tools.
            mcp::start(app.handle());

            // Before `restore_session`, because a restored layout may hold a
            // surface belonging to a plugin. Resolving one asks this registry
            // which package the address names, so a restore that ran first would
            // find every plugin surface unknown and drop it — silently closing
            // the tabs a person left open.
            //
            // Reading a file, and only that: the manifests behind these records
            // are opened on demand rather than here, so a plugin whose checkout
            // is unreachable costs a resolve later instead of a slow launch now.
            app.state::<plugins::Registry>().hydrate(app.handle());

            // Immediately after, so a plugin rebuilt *during* this launch is
            // noticed rather than waiting for the first install of the session
            // to sync the set as a side effect.
            app.state::<plugins::Watchers>().sync(app.handle());

            // On a machine that has never had a plugin store, install the
            // catalog's `default` apps. Returns at once and does the work on
            // its own thread — a first launch must not wait on the network to
            // put a window on screen — and every failure inside is quiet, for
            // the reasons on `seed_defaults`.
            plugins::install::seed_defaults(app.handle());

            let handle = app.handle().clone();
            restore_session(&handle);

            // After `restore_session`, because opening a project needs a
            // cluster to open it into, and before `mcp::sync_all` below so the
            // servers are written against the project this launch asked for
            // rather than the one the last session left behind. Before
            // `boot::start` for the same kind of reason: opening a project
            // applies a layout preset, and boot waits for whatever that puts
            // on screen. Does nothing at all on a launch with no path.
            launch::from_own_args(&handle);

            // After `restore_session` too, because this walks the clusters it
            // just brought back to find which projects are open — and it is what
            // writes the `.mcp.json` an agent reads to find Veistra's servers. A
            // project opened later goes through `commands::set_cluster_project`,
            // which syncs again.
            mcp::sync_all(&handle);

            // After `restore_session`, because what boot waits for is whichever
            // apps that restore actually put on screen. See `boot::EXPECTED`.
            boot::start(app.handle().clone(), apps_on_screen(&handle));

            // The launch terminal. Opened here rather than baked into
            // `ShellState::default` because a session must not exist before the
            // shell behind it does — and spawning a process is exactly the kind
            // of work a `Default` impl has no business doing.
            //
            // A failure is not fatal: a machine with no usable shell should still get an
            // orchestrator, with an empty band and a working "+". It is reported rather than
            // swallowed, though — this is the one step in a terminal's life that can fail for
            // reasons no amount of reading the code will reveal, and a silently empty band
            // gives whoever hits it nothing to go on.
            //
            // Skipped when a session was restored: it brought its own terminals
            // back, and one more every launch would grow the band by an entry a
            // day. Into `main`'s active cluster, which a terminal names now — a
            // window with no cluster gets none and needs none, no band is drawn.
            //
            // And skipped entirely when `terminal.openOnLaunch` is off. That is
            // the one setting in this build declared `Applies::Restart`, and
            // this line is why: there is no later moment at which switching it
            // on could open the launch terminal, because the launch is over.
            let want_launch_terminal =
                settings::flag(&handle, settings::keys::TERMINAL_OPEN_ON_LAUNCH);
            let none_restored = handle.state::<ShellState>().snapshot().terminals.is_empty();
            if want_launch_terminal && none_restored {
                if let Some(cluster_id) = handle.state::<ShellState>().active_cluster_of("main") {
                    if let Err(e) = commands::open_terminal(
                        &handle,
                        &handle.state::<ShellState>(),
                        &handle.state::<PtySessions>(),
                        &cluster_id,
                        80,
                        24,
                    ) {
                        crate::veistra_log!("could not open the launch terminal: {e}");
                    }
                }
            }

            // Last, and off this thread. It is a network round trip, nothing on
            // screen waits for it, and a machine with no route to GitHub must
            // reach `Ok(())` at exactly the same speed as one that does. It
            // reads `updates.checkAutomatically` and returns immediately when
            // that is off — see `updater::start`.
            updater::start(handle.clone());

            // One line in a local file. Counted whether or not usage data is
            // on, because the feedback prompts that read it are scheduled from
            // launches and a person who switches sharing on later should not
            // look brand new. It is never sent.
            telemetry::note_launch(&handle);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_stack,
            commands::cached_stack,
            commands::reveal_tool,
            commands::finish_boot,
            commands::take_launch_target,
            commands::boot_status,
            commands::app_painted,
            commands::shell_state,
            commands::open_instance,
            commands::close_instance,
            commands::list_pages,
            commands::open_page,
            commands::close_page,
            commands::set_page_mode,
            commands::set_page_width,
            commands::activate_instance,
            commands::set_instance_title,
            commands::move_instance,
            commands::split_pane,
            commands::set_pane_sizes,
            commands::add_cluster,
            commands::create_cluster_with_environment,
            commands::list_cluster_environments,
            commands::create_design_cluster,
            commands::new_cluster_for_drop,
            commands::set_active_cluster,
            commands::rename_cluster,
            commands::set_cluster_icon,
            commands::close_cluster,
            commands::set_cluster_project,
            commands::cluster_project,
            commands::list_recent_projects,
            commands::open_project_in_cluster,
            commands::project_icon,
            commands::choose_project_icon,
            commands::list_presets,
            commands::save_preset,
            commands::apply_preset,
            commands::new_window,
            commands::detach_cluster,
            commands::detach_instance,
            commands::window_at_cursor,
            commands::set_window_geometry,
            commands::close_window,
            commands::create_terminal,
            commands::open_terminal_in_pane,
            commands::close_terminal,
            commands::split_terminal,
            commands::terminal_attach,
            commands::terminal_write,
            commands::terminal_insert_paths,
            context_commands::terminal_drop_paths,
            context_commands::terminal_paste_image,
            context_commands::terminal_insert_items,
            context_commands::terminal_harness,
            context_commands::terminal_set_harness,
            context_commands::context_item_paths,
            context_commands::context_list,
            context_commands::context_remove,
            context_commands::context_thumb,
            context_commands::agent_saw_status,
            context_commands::agent_saw_enable,
            context_commands::agent_saw_disable,
            context_commands::agent_saw_list,
            context_commands::agent_saw_thumb,
            commands::terminal_resize,
            commands::terminal_busy,
            commands::move_terminal,
            commands::set_active_terminal,
            commands::set_band_height,
            commands::set_terminal_title,
            commands::tool_frontend,
            commands::list_apps,
            commands::list_openables,
            commands::list_plugins,
            commands::list_catalog,
            commands::install_plugin_repo,
            commands::has_github_token,
            commands::set_github_token,
            commands::install_plugin_folder,
            commands::choose_and_install_plugin,
            commands::uninstall_plugin,
            commands::reload_plugin,
            commands::set_plugin_enabled,
            commands::app_call,
            diagnostics::report_frontend_error,
            mcp::commands::mcp_status,
            mcp::commands::mcp_catalog,
            mcp::commands::mcp_set_server_enabled,
            mcp::commands::mcp_sync_config,
            mcp::commands::report_focus,
            settings::commands::settings_snapshot,
            settings::commands::settings_set,
            settings::commands::settings_reset,
            settings::commands::settings_reset_group,
            skills::builtin_skills,
            git::git_cluster_diff,
            git::git_cluster_stage,
            git::git_cluster_unstage,
            git::git_cluster_commit,
            git::git_worktrees,
            commands::git_repo_state,
            commands::git_default_branch,
            commands::git_init_project,
            git::git_worktree_create,
            git::git_worktree_remove,
            git::git_worktree_reconcile,
            git::git_graph,
            git::git_branches,
            git::git_checkout,
            git::git_divergence,
            git::git_divergence_diff,
            git::git_cluster_status,
            git::git_hunks,
            git::git_head_text,
            commands::review_comments,
            commands::review_comment_add,
            commands::review_comment_update,
            commands::review_comment_resolve,
            commands::review_comment_remove,
            commands::review_comments_mark_sent,
            github::github_feed,
            github::github_open_in_browser,
            cloud::hindsight::hindsight_status,
            cloud::google::google_auth_status,
            cloud::google::google_sign_in,
            cloud::google::google_cancel_sign_in,
            cloud::google::google_sign_out,
            cloud::google::set_google_client_secret,
            search::search_content,
            commands::telemetry_config,
            commands::telemetry_ledger,
            commands::telemetry_count,
            commands::telemetry_prompt,
            updater::update_state,
            updater::check_for_update,
            updater::install_update,
        ])
        // `build` + `run` rather than `run` alone, for one reason: a plugin core
        // is a **child process**, and nothing else in this application has one.
        // A pty is reaped by `PtySessions::close` when its terminal closes, and
        // the MCP listener is a task inside this process — but a plugin's core
        // outlives every window and would be orphaned by an exit that did not go
        // looking for it. `RunEvent::Exit` is the one hook that fires once, for
        // the application, rather than once per window.
        .build(context)
        .map(|app| {
            app.run(|handle, event| {
                // Every route out passes through here, including the ones
                // that never visit `windows::request_close`.
                if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                    exit_watchdog::arm();
                }
                if matches!(event, tauri::RunEvent::Exit) {
                    // Layout writes are debounced; commit one still waiting.
                    shell_store::flush_pending();
                    handle.state::<blender::job::Jobs>().stop_all();
                    handle.state::<plugins::Watchers>().stop_all();
                    handle.state::<plugins::Broker>().stop_all();
                    // Kills the `gcloud` process tree it supervises, if one is
                    // running — see `cloud::tunnel`'s doc for why this, rather
                    // than the OS cleaning up an orphan, is what makes "no
                    // gcloud process remains after exit" true.
                    handle.state::<cloud::tunnel::Tunnel>().stop();
                    handle.state::<godot::Godot>().shutdown();
                    handle.state::<apps::agent_tab::Sessions>().stop_all();
                }
            });
        });

    // A GUI process that never got a window up has nowhere to report into, so
    // this goes to stderr and takes the exit code with it. A panic here would
    // print a backtrace to a console nobody is looking at.
    if let Err(error) = launched {
        crate::veistra_log!("could not start the application: {error}");
        std::process::exit(1);
    }
}

/// Which apps have at least one instance in the layout, with their names.
///
/// What boot waits to hear `veistra/painted` from. Every app in the registry used
/// to be docked at startup, so the registry and "what is on screen" were the
/// same list; a restored session makes them different, and waiting on an app
/// with no frame mounted would hold the splash for the full timeout on every
/// launch that did not happen to have it open.
fn apps_on_screen(app: &tauri::AppHandle) -> Vec<(String, String)> {
    let snapshot = app.state::<ShellState>().snapshot();
    let open: std::collections::HashSet<String> = snapshot
        .instances
        .iter()
        .map(|i| i.app_id.clone())
        .collect();

    apps::roster()
        .into_iter()
        .filter(|(id, _)| open.contains(*id))
        .map(|(id, name)| (id.to_string(), name.to_string()))
        .collect()
}

/// Put the shell back the way it was left.
///
/// Runs after `project::restore`, because both branches below need the old
/// global open project: one to name the cluster a first launch seeds, the other
/// to migrate it onto the cluster that used to be showing it.
///
/// Two things deliberately do *not* come back. A pty dies with the process, so
/// a restored terminal tab gets a fresh shell rather than a dead one — a tab
/// that looks alive and silently eats keystrokes is the exact failure
/// `open_terminal`'s ordering exists to prevent, and it would be strange to
/// reintroduce it here. And a window whose monitor is no longer attached is
/// re-centred rather than restored to coordinates that now name nowhere; see
/// `shell_store::place_within`.
fn restore_session(app: &tauri::AppHandle) {
    let stored = shell_store::load(app);
    let shell = app.state::<ShellState>();

    if stored.windows.is_empty() {
        seed_first_run(app, &shell);
        // Nothing remembered, so nothing to restore: centre rather than take the OS's cascade.
        if let Some(window) = app.get_webview_window("main") {
            windows::apply_geometry(&window, None);
        }
        return;
    }

    shell.restore(shell_state::ShellSnapshot {
        windows: stored.windows,
        instances: stored.instances,
        terminals: stored.terminals,
    });

    migrate_global_project(app, &shell);

    // Geometry first, windows second. `main` already exists — it is declared in
    // tauri.conf.json — so it is moved rather than built; everything else is
    // built at the position it should already be in, because creating a window
    // and then moving it is a visible jump on screen.
    let snapshot = shell.snapshot();
    for placement in &snapshot.windows {
        let geometry = placement
            .geometry
            .and_then(|g| shell_store::clamp_to_visible(app, g));

        if placement.label == "main" {
            if let Some(window) = app.get_webview_window("main") {
                windows::apply_geometry(&window, geometry);
            }
            continue;
        }

        if let Err(e) = windows::create(app, &placement.label, geometry, false) {
            crate::veistra_log!("could not restore window {}: {e}", placement.label);
        }
    }

    respawn_terminals(app, &shell);
    project::retitle(app);
}

/// **The one-time migration** from the old global open project to a cluster.
///
/// Before this change, "the open project" was one value for the whole process, stored in
/// `projects.json`. Braden has a live session on disk right now, so a build that simply started
/// reading `Cluster::project` would open to a workspace with nothing in it and no indication that
/// anything had moved. The old value is taken and given to the first cluster of the main window —
/// the one that *was* showing it, since there was only one project to show.
///
/// Two things make this run exactly once and no more.
///
/// `take_migration_seed` **consumes** the field: it reads the path, writes
/// `None` back, and saves. So the source is gone after the first launch of this
/// build, rather than sitting there waiting to be applied again the next time
/// somebody closes a project. That is the whole reason it is a take and not a
/// read — a migration whose input survives it is a migration that re-runs.
///
/// The guard is the belt to that braces: a layout where some cluster already
/// has a project has already been through this, so the seed is still drained
/// but nothing is overwritten. Without it, a `projects.json` restored from a
/// backup could reach in and change a project the user had since chosen.
fn migrate_global_project(app: &tauri::AppHandle, shell: &ShellState) {
    let Some(seed) = project::take_migration_seed(app) else {
        return;
    };
    if shell.any_cluster_has_a_project() {
        return;
    }
    let Some(cluster_id) = shell.first_cluster_id() else {
        return;
    };

    shell.set_cluster_project(app, &cluster_id, Some(seed.display().to_string()));
}

/// Give every restored terminal tab a live shell.
///
/// A tab whose shell will not start is closed rather than left on screen. The
/// alternative is a tab that draws, accepts focus, and swallows every keystroke
/// with nothing to send them to — which looks like Veistra being broken rather
/// than like one shell being unavailable.
///
/// Each one respawns in **its own cluster's** project, resolved at this moment
/// the same way `commands::terminal_cwd` resolves it for a fresh terminal.
/// There is no working directory stored with a session to restore; what there is
/// instead is the project its cluster is pointed at now, which is the same answer
/// opening a terminal there would give. Two clusters on two projects therefore
/// come back with their shells in the right two directories rather than all of
/// them in one — which is a sharper answer than this could give while a terminal
/// named a window, since one window can hold both of those clusters.
fn respawn_terminals(app: &tauri::AppHandle, shell: &ShellState) {
    let ptys = app.state::<PtySessions>();

    for terminal in shell.snapshot().terminals {
        // A shell in a worktree that is gone would start in the process's own
        // directory and run commands somewhere the tab does not say. The
        // cluster stays and is drawn as missing; only its shells are dropped.
        if shell.cluster_environment_missing(&terminal.cluster_id) {
            crate::veistra_log!(
                "not restoring {}: the worktree of cluster {} is missing",
                terminal.id,
                terminal.cluster_id
            );
            shell.close_terminal(app, &terminal.id);
            continue;
        }
        let cwd = project::cluster_path(app, &terminal.cluster_id)
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        let marker = crate::environments::read_only_env(
            shell
                .cluster_write_environment(&terminal.cluster_id)
                .as_ref(),
        );
        if let Err(e) = ptys.open(app, &terminal.id, &cwd, 80, 24, &marker) {
            crate::veistra_log!("could not restore the shell behind {}: {e}", terminal.id);
            shell.close_terminal(app, &terminal.id);
        }
    }
}

/// The very first launch, or one after the layout file was lost.
///
/// Home, and nothing else. Not every app: opening a surface the user did not
/// ask for is the thing this whole feature exists to stop doing, and Home is
/// the one place a session with no project has anywhere to go from.
///
/// The migration applies here too, and it has to. Losing `layout.json` while
/// keeping `projects.json` is an ordinary way to arrive here — the layout file
/// is the newer of the two and the one a bad shutdown can truncate — and a
/// first run that threw the remembered project away would be a data loss with
/// a plausible-looking cause. The seeded cluster takes it, and takes its name
/// from it as it always has.
fn seed_first_run(app: &tauri::AppHandle, shell: &ShellState) {
    let seed = project::take_migration_seed(app);

    if let Some(cluster_id) = shell.first_cluster_id() {
        if let Some(path) = seed.as_deref() {
            if let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) {
                shell.rename_cluster(app, &cluster_id, &name);
            }
            shell.set_cluster_project(app, &cluster_id, Some(path.display().to_string()));
        }
    }

    // No pane preference and no split direction: there is one empty pane and
    // no window drawn yet to have measured it in. See `PaneNode::open_into`.
    shell.open_instance(
        app,
        "main",
        shell_state::OpenRequest {
            app_id: "home",
            kind: shell_state::SurfaceKind::App,
            title: "Home",
            pane_id: None,
            dir: None,
        },
    );

    project::retitle(app);
}
