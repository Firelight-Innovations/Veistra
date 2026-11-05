//! The Files app's Rust half — listing a directory, reading a file, and writing
//! one back.
//!
//! There is deliberately no sandbox here. A tool is third-party code and its
//! manifest paths are validated as a security boundary (see
//! `veistra-tool-manifest`), but an app is this repository's own code running in
//! the orchestrator's own process, next to a module that spawns real shells with
//! the user's full privileges. A path check here would look like a boundary
//! while defending nothing, which is worse than not having one. `files/write`
//! does not change that argument: the terminal next door can already overwrite
//! anything this can, and a check that stopped the file editor while letting a
//! shell through would be a fence with no field behind it. If the Files app ever
//! renders paths a *tool* chose, the check belongs at that seam, and it needs to
//! be written knowing that is what it is for.

use crate::apps::CallContext;
use crate::state::AppState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// The File Explorer's own settings section.
///
/// **The worked example of an app declaring settings**, and the thing
/// `docs/settings.md` points at. A `static` here, one line in
/// `apps::settings_groups`, and the section appears on the screen under the
/// shell's own — no registration call, no ordering to negotiate, and nothing
/// this module has to know about how the screen is drawn.
///
/// The two rows are deliberately of the two different kinds, because both exist
/// and they behave differently: `readLimitKb` is read here, in Rust, when a file
/// is opened, and `confirmDelete` is read by this app's *frontend* over
/// `apps::SETTINGS_METHOD`. A section is not obliged to be one or the other.
pub static SETTINGS: crate::settings::Group = crate::settings::Group {
    id: "files",
    title: "File Explorer",
    description: "Browsing and editing the open project.",
    order: 100,
    settings: SETTINGS_ROWS,
};

static SETTINGS_ROWS: &[crate::settings::Setting] = &[
    crate::settings::Setting {
        key: KEY_READ_LIMIT_KB,
        title: "Open at most",
        description: "How much of a large text file the viewer loads. Past this it shows the \
                      first chunk and says it did, rather than holding the interface while \
                      megabytes cross the bridge.",
        control: crate::settings::Control::Number {
            default: 256,
            min: 32,
            max: 8192,
            step: 32,
            unit: "KB",
        },
        applies: crate::settings::Applies::Next {
            what: "the next file you open",
        },
    },
    crate::settings::Setting {
        key: "files.confirmDelete",
        title: "Ask before deleting",
        description: "Deleting moves to the system trash either way, so this is a speed bump \
                      rather than a safety net. Switching it off still asks when something \
                      under the target has unsaved edits — the trash holds the last saved \
                      version, so those are the one thing it cannot give back.",
        control: crate::settings::Control::Toggle { default: true },
        applies: crate::settings::Applies::Now,
    },
];

const KEY_READ_LIMIT_KB: &str = "files.readLimitKb";

/// How much of a file `files/read` will hand back, from the setting above.
///
/// A viewer that has to stay responsive cannot be handed a 400 MB log, and the
/// answer to one that big is not a slower read — it is a different feature
/// (paging, or a stream). Until that exists, this reads the first chunk and says
/// so, which is honest in a way that a spinner over a hung IPC call is not.
///
/// Read per call rather than cached, so a change reaches the next file opened
/// without the frame that opens it having to be told. `Applies::Next` on the
/// descriptor says exactly that.
fn max_read_bytes(app: &AppHandle) -> u64 {
    crate::settings::number(app, KEY_READ_LIMIT_KB).max(1) as u64 * 1024
}

/// How much of a file `files/read-bytes` will hand back — and, unlike
/// [`max_read_bytes`], a limit it *refuses* at rather than truncates to.
///
/// Half a PNG is not a smaller PNG. Everything that calls this passes the bytes
/// to a decoder, and a decoder handed a prefix either fails somewhere far from
/// the cause or, worse, renders the half it got as though that were the file.
/// Truncation is only honest when the caller can see the seam, which is true of
/// text in an editor and of nothing else here.
///
/// The name is spelled out in full rather than shortened to `MAX_BYTES_READ`,
/// which would differ from the constant above only in word order — the two caps
/// mean different things and must not be a glance apart.
const MAX_READ_BYTES_BINARY: u64 = 32 * 1024 * 1024;

/// The most `files/read-head` hands back. A head read is for a format whose
/// answer sits at the front of the file — a `.blend`'s embedded thumbnail is
/// its first block — so the caller asks for a prefix by length and is told the
/// file's real size beside it. Truncation is the request here, not a surprise.
const MAX_READ_HEAD_BYTES: u64 = 4 * 1024 * 1024;

/// The Files app's single RPC entry point, split by family so that no one
/// function carries every method.
///
/// Every family below is scoped to "the cluster the calling surface is in",
/// which is the whole of what changed when a project stopped being global. Two
/// Files side by side in two clusters root at two different folders, and neither
/// of them holds any state saying so: the answer comes in with the call, as
/// `CallContext`, resolved from the frame the message arrived on. This module
/// holds no per-instance state at all.
pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    // The Recycle Bin half of `files/delete`, in its own module because the
    // scoping rule it enforces is the whole of its design and deserves to be
    // read on its own. Dispatched from here because it is the Files app's
    // surface — one app, one `call`. First, and on its own, because it is
    // matched by *prefix* rather than by exact name, and because it is the one
    // branch that wants the params by value.
    if method.starts_with("trash/") {
        return super::trash::call(app, context, method, params);
    }

    let params = params.as_ref();

    entry_methods(app, context, method, params)
        .or_else(|| shell_methods(app, method, params))
        .or_else(|| git_methods(app, context, method, params))
        .unwrap_or_else(|| {
            Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("no such method: {method}"),
            ))
        })
}

/// The entries themselves: reading a tree, and changing one. `None` for a method
/// that is not one of these.
///
/// Every method that names a file takes an absolute path. `files/list` and
/// `files/read` accept none and fall back to the project of the cluster the
/// calling surface is in, which `files/root` reports directly; that fallback is
/// the only place this module has an opinion about *where* the user is, and
/// everything else is the frontend's to decide and pass in. The methods that
/// change something refuse a missing path instead of defaulting, because none of
/// them has a harmless thing to do to the root.
fn entry_methods(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<&Value>,
) -> Option<Result<Value, RpcError>> {
    let answer = match method {
        "files/root" => root(app, context),
        "files/watch" => watch(app, context),
        "files/list" => list(app, context, params),
        "files/stat" => required_path(params).map(|path| stat_at(&path)),
        "files/read" => read(app, context, params),
        "files/read-bytes" => {
            required_path(params).and_then(|path| read_bytes_within(&path, MAX_READ_BYTES_BINARY))
        }
        "files/read-head" => read_head(params),
        "files/write" => write(params),
        "files/create-file" => create(params, NewEntry::File),
        "files/create-dir" => create(params, NewEntry::Dir),
        "files/rename" => rename(params),
        "files/duplicate" => required_path(params).and_then(|path| duplicate_at(&path)),
        "files/save-as" => save_as(app, params),
        "files/delete" => required_path(params).and_then(|path| delete_at(&path)),
        "files/import" => import(params),
        "files/tree-size" => required_path(params).map(|path| tree_size_at(&path)),
        _ => return None,
    };
    Some(answer)
}

/// The two that hand a path to the OS rather than touching it. `None` for a
/// method that is not one of these.
///
/// Reveal and open refuse a missing path rather than defaulting to the root, for
/// the reason [`entry_methods`] gives about the methods that change something:
/// there is no harmless thing to do to the root.
fn shell_methods(
    app: &AppHandle,
    method: &str,
    params: Option<&Value>,
) -> Option<Result<Value, RpcError>> {
    let answer = match method {
        "files/reveal" => reveal(app, params),
        "files/open-external" => open_external(app, params),
        "files/open-url" => open_url(app, params),
        "files/open-in-blender" => open_in_blender(app, params),
        _ => return None,
    };
    Some(answer)
}

/// Git decoration. Each answers about the cluster this surface is in, so none of
/// them takes a cluster from the request body — same identity rule as everything
/// else here. `None` for a method that is not one of these.
fn git_methods(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<&Value>,
) -> Option<Result<Value, RpcError>> {
    let answer = match method {
        "files/git-status" => git_status(app, context),
        "files/git-ignored" => git_ignored(app, context),
        "files/git-hunks" => git_hunks(app, context, params),
        "files/git-head" => git_head(app, context, params),
        _ => return None,
    };
    Some(answer)
}

/// Every changed path in this cluster's checkout, for the explorer to mark up.
///
/// **Absolute paths, not repo-relative.** Git speaks in paths relative to the
/// repository root, and the explorer speaks in absolute ones; converting here
/// means the frontend never has to know where the repository root is, which
/// matters because it is not always the folder the tree is rooted at — a
/// project can be a subdirectory of a larger repository, and an explorer
/// matching git's relative paths against its own would then decorate the wrong
/// rows, or none.
///
/// One flat list rather than the staged/unstaged split `git status` returns. The
/// gutter and the row badge care what happened to a file, not which side of the
/// index it sits on, and a path that appears on both sides — staged, then edited
/// again — should decorate once, as the more recent of the two.
///
/// `null` for a cluster with no project or a project that is not a repository.
/// The explorer draws its ordinary undecorated tree for both.
fn git_status(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let Some(cluster) = context.cluster_id.as_deref() else {
        return Ok(Value::Null);
    };

    let Some(status) = crate::git::git_cluster_status(app.clone(), cluster.to_string())
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?
    else {
        return Ok(Value::Null);
    };

    let Some(root) = crate::project::cluster_path(app, cluster) else {
        return Ok(Value::Null);
    };

    // Against the *repository* root, not the cluster's. `git status --porcelain`
    // reports every path relative to the top of the working tree regardless of
    // which directory it was run in, so for a project that is a subdirectory of
    // a larger repository — `repo/nested/proj` open as the project — the paths
    // come back as `nested/proj/file`. Joining those onto the project directory
    // would produce `repo/nested/proj/nested/proj/file`, which matches no row in
    // the explorer, and the decoration would simply never appear rather than
    // appear wrongly. Verified against real git rather than reasoned about.
    //
    // Note this differs from `git_hunks` below, which is correct joining against
    // the cluster root: a `--` pathspec *is* interpreted relative to the current
    // directory. The two commands genuinely disagree about relativity.
    let base = crate::git::repo_root(&root).unwrap_or(root);

    // Unstaged second so that it wins on collision: a file staged and then
    // modified again is, to a reader looking at the tree, modified.
    let changes: Vec<Value> = status
        .staged
        .iter()
        .chain(status.unstaged.iter())
        .map(|change| {
            let (path, dir) = absolute(&base, &change.path);
            json!({
                "path": path,
                "kind": change.kind,
                "staged": change.staged,
                "dir": dir,
            })
        })
        .collect();

    Ok(json!({ "branch": status.branch, "changes": changes }))
}

/// A repo-relative path from git, as an absolute one the explorer can match a
/// row against, plus whether git named it as a whole directory.
///
/// **`PathBuf::join` is not enough, and that is the whole reason this exists.**
/// Git speaks forward slashes on every platform, and `join` appends the string
/// it is given verbatim rather than translating it, so on Windows
/// `C:\repo`.join("src/a.ts") displays as `C:\repo\src/a.ts`. `files/list`
/// builds its rows from `read_dir`, which gives `C:\repo\src\a.ts`, and the
/// frontend compares the two as strings. So every nested path missed, and
/// because the frontend derives a directory's rollup from these same strings,
/// no folder tinted either — only a change at the top level of a project could
/// ever show. Pushing one component at a time is what makes the separator the
/// platform's own.
///
/// The trailing slash is git's shorthand for "and everything under here",
/// which it uses for an untracked directory (and for an ignored one, over in
/// `git::ignored_roots`). It is stripped from the path, since no row's path
/// ends in a separator, and reported separately so the frontend can decorate
/// the subtree rather than just the folder — which is what VS Code shows: open
/// an untracked folder and every file inside is marked untracked too.
fn absolute(base: &Path, relative: &str) -> (String, bool) {
    let dir = relative.ends_with('/');

    let mut path = base.to_path_buf();
    for component in relative.split('/').filter(|part| !part.is_empty()) {
        path.push(component);
    }

    (path.display().to_string(), dir)
}

/// Every ignored path in this cluster's checkout, absolute, for the explorer to
/// grey out.
///
/// Its own method rather than a field on `files/git-status` because of what it
/// costs: see `git::ignored_roots`, which measures the two. Status is re-asked
/// every time the tree changes; this is asked once when a project opens, which
/// is the right cadence for an answer that only changes when a `.gitignore`
/// does.
///
/// An empty list — never an error — for a cluster with no project, a project
/// that is not a repository, or a checkout git could not answer about. All
/// three mean the same thing to the tree: nothing to grey.
fn git_ignored(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let Some(cluster) = context.cluster_id.as_deref() else {
        return Ok(json!([]));
    };
    let Some(root) = crate::project::cluster_path(app, cluster) else {
        return Ok(json!([]));
    };

    // Against the repository root for the same reason `git_status` is — these
    // come out of the same `git status`, relative to the same top of the
    // working tree, whichever directory it ran in.
    let base = crate::git::repo_root(&root).unwrap_or(root);

    let ignored: Vec<Value> = crate::git::ignored_roots(&base)
        .iter()
        .map(|relative| Value::String(absolute(&base, relative).0))
        .collect();

    Ok(Value::Array(ignored))
}

/// The changed line ranges of one file, against HEAD, for the editor's gutter.
///
/// Takes the same absolute `path` the explorer and the viewer already hold, and
/// makes it relative on this side for the same reason `git_status` makes them
/// absolute: the repository root is this side's business.
///
/// An empty list for an unchanged file, an untracked one, or a path outside the
/// checkout entirely — none of which is worth an error in the middle of someone
/// editing.
fn git_hunks(
    app: &AppHandle,
    context: &CallContext,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let path = required_path(params)?;

    let Some(cluster) = context.cluster_id.as_deref() else {
        return Ok(json!([]));
    };
    let Some(root) = crate::project::cluster_path(app, cluster) else {
        return Ok(json!([]));
    };

    let Ok(relative) = path.strip_prefix(&root) else {
        return Ok(json!([]));
    };

    // Git wants forward slashes whatever the platform, and `strip_prefix` hands
    // back whatever the caller's separator was.
    let relative = relative.display().to_string().replace('\\', "/");

    let hunks = crate::git::git_hunks(app.clone(), cluster.to_string(), relative)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;

    serde_json::to_value(hunks).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("the hunk list could not be serialized: {e}"),
        )
    })
}

/// One open file as HEAD has it, so the editor can show a hunk's before-and-
/// after without the frontend having to reconstruct it from line numbers.
///
/// Takes the same absolute path everything else in this app does; making it
/// repo-relative is this side's business, exactly as in `git_hunks`. Empty text
/// covers "not in a repository", "outside the checkout", and "added since the
/// last commit" alike — all three mean there is no committed version, which is
/// what a diff view draws as an addition.
fn git_head(
    app: &AppHandle,
    context: &CallContext,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let path = required_path(params)?;

    let Some(cluster) = context.cluster_id.as_deref() else {
        return Ok(json!({ "text": "" }));
    };
    let Some(root) = crate::project::cluster_path(app, cluster) else {
        return Ok(json!({ "text": "" }));
    };
    let Ok(relative) = path.strip_prefix(&root) else {
        return Ok(json!({ "text": "" }));
    };

    let relative = relative.display().to_string().replace('\\', "/");

    let text = crate::git::git_head_text(app.clone(), cluster.to_string(), relative)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))?;

    Ok(json!({ "text": text }))
}

/// Where the tree roots, for the explorer's header.
///
/// Separate from `files/list` even though the frontend could take `path` from a
/// listing, because the two answer different questions: this one is "where does
/// this app start", asked once, and the listing is "what is in here", asked on
/// every expand. A frontend that had to list the root to learn its name would be
/// reading a directory in order to read a string.
fn root(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let path = default_root(app, context)?;
    // Told to the frontend so it can grey out the write items; the write
    // methods refuse a read-only environment whether or not it listens
    // (`apps::call`). None is read-only, main included.
    let read_only = context.cluster_id.as_deref().is_some_and(|cluster| {
        app.state::<crate::shell_state::ShellState>()
            .cluster_write_environment(cluster)
            .is_some_and(|env| env.is_read_only())
    });
    Ok(json!({
        "path": path.display().to_string(),
        "name": base_name(&path),
        "readOnly": read_only,
    }))
}

/// Start watching the cluster's project folder, so the explorer hears about changes made
/// from outside. Idempotent and read-class: it changes nothing on disk, so it is allowed
/// on main too. The answer is the root being watched, which the `files:changed` event
/// then names. See `file_watch`.
fn watch(app: &AppHandle, context: &CallContext) -> Result<Value, RpcError> {
    let path = default_root(app, context)?;
    app.state::<crate::file_watch::FileWatches>()
        .ensure(app, &path);
    Ok(json!({ "root": path.display().to_string() }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    /// `"dir"`, `"file"`, or `"other"` — a pipe, a socket, a device node. The
    /// frontend needs a closed set to switch an icon on, not the whole of
    /// `std::fs::FileType`.
    kind: &'static str,
    /// `null` for anything that isn't a file. A directory's "size" would have
    /// to be either its entry count or its recursive weight, and neither is
    /// what a caller reading this field expects.
    size: Option<u64>,
    /// Milliseconds since the Unix epoch, `null` when it cannot be read. Here
    /// rather than only on `files/stat` because the frontend compares a listing
    /// against the one before it to notice what changed, and a listing without
    /// times can only compare names.
    mtime: Option<u64>,
}

/// One directory's immediate children.
fn list(app: &AppHandle, context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let dir = resolve_path(app, context, params)?;

    let reader = std::fs::read_dir(&dir).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not read {}: {e}", dir.display()),
        )
    })?;

    let mut entries: Vec<Entry> = Vec::new();
    for entry in reader {
        // One unreadable entry is not a failed listing. A directory with a
        // permission-denied child should still show every sibling, so this
        // skips what it cannot stat rather than aborting the whole call.
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let metadata = entry.metadata().ok();

        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.display().to_string(),
            kind: kind_of(metadata.as_ref()),
            mtime: metadata.as_ref().and_then(mtime_of),
            size: metadata.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
        });
    }

    // Directories first, then by name without regard to case. Sorted here
    // rather than in the frontend because every caller wants the same order,
    // and one that didn't sort would show the filesystem's own — which on
    // Windows is not the same order twice.
    entries.sort_by(|a, b| {
        let folders_first = (a.kind != "dir").cmp(&(b.kind != "dir"));
        folders_first.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(json!({
        "path": dir.display().to_string(),
        // `null` at a drive root or `/`, which is what stops the frontend
        // offering an "up" that goes nowhere.
        "parent": dir.parent().map(|p| p.display().to_string()),
        "entries": entries,
    }))
}

/// One text file's contents, up to [`max_read_bytes`].
fn read(app: &AppHandle, context: &CallContext, params: Option<&Value>) -> Result<Value, RpcError> {
    let path = resolve_path(app, context, params)?;
    let limit = max_read_bytes(app);

    let metadata = std::fs::metadata(&path).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not stat {}: {e}", path.display()),
        )
    })?;
    if metadata.is_dir() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{} is a directory, not a file", path.display()),
        ));
    }

    let truncated = metadata.len() > limit;
    let bytes = if truncated {
        use std::io::Read;
        let file = std::fs::File::open(&path).map_err(|e| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("could not open {}: {e}", path.display()),
            )
        })?;
        let mut buffer = Vec::with_capacity(limit as usize);
        file.take(limit).read_to_end(&mut buffer).map_err(|e| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("could not read {}: {e}", path.display()),
            )
        })?;
        buffer
    } else {
        std::fs::read(&path).map_err(|e| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("could not read {}: {e}", path.display()),
            )
        })?
    };

    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_string(),

        // `error_len() == None` means "the input ended mid-character", which
        // for a truncated read is this function's own doing rather than a
        // property of the file — the cut landed inside a multi-byte character.
        // Dropping that partial tail is correct; treating the file as binary
        // because of it would be a bug that only shows up on files whose
        // cap happens to fall inside a non-ASCII character.
        Err(e) if truncated && e.error_len().is_none() => {
            String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()
        }

        Err(_) => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("{} is not a UTF-8 text file", path.display()),
            ))
        }
    };

    Ok(json!({
        "path": path.display().to_string(),
        "text": text,
        "truncated": truncated,
        // The cap travels with the answer so the frontend can say how much it
        // got without knowing the number. It used to write "first 256 KiB" in
        // its own source, which is one constant spelled twice in two languages
        // — and the copy that would go stale is the one a person reads.
        "limit": limit,
        "mtime": mtime_of(&metadata),
    }))
}

// --- the filesystem, without an `AppHandle` -----------------------------------
//
// Everything from here to `resolve_path` takes a `&Path` and knows nothing about
// Tauri. The split is for the tests at the bottom of this file: constructing an
// `AppHandle` means standing up a mock runtime, and the decisions worth testing
// — the stale-write check, the binary cap, what a drive root is called — have
// nothing to do with one. What is left above is parameter resolution, which is
// thin enough to read.

/// One entry as it is *right now*, including the fact that it isn't.
///
/// A missing path is `exists: false` rather than an error, and that is
/// load-bearing: the frontend polls this to notice files changing underneath it,
/// and a poll that got an error could not tell "someone deleted this" from "the
/// call failed", which are opposite instructions about what to do with the tab.
fn stat_at(path: &Path) -> Value {
    // Follows symlinks, so a broken link reads as absent. That matches `list`,
    // which cannot stat one either, and the honest thing to say about a link
    // whose target is gone is that there is nothing to open.
    let metadata = std::fs::metadata(path).ok();

    json!({
        "path": path.display().to_string(),
        "name": base_name(path),
        "kind": kind_of(metadata.as_ref()),
        "size": metadata.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
        "mtime": metadata.as_ref().and_then(mtime_of),
        "exists": metadata.is_some(),
    })
}

/// One file's bytes, base64'd, or an error when it is over `cap`.
///
/// Base64 is forced by the transport. An app's `Dispatch` returns a
/// `serde_json::Value`, which has no byte variant, so the only way a PNG reaches
/// the iframe is as a string — a third larger on the wire, and copied whole
/// twice. That is a fine price for the icons and screenshots this opens today
/// and an absurd one the first time someone double-clicks a 300 MB video.
///
/// The real answer then is not a bigger cap. It is Tauri's asset protocol —
/// `tauri.conf.json` has no `assetProtocol` key at all right now, so turning it
/// on is a deliberate act with a scope to argue about — or a custom URI scheme
/// the webview streams from. Either way the frontend receives a *URL* and the
/// bytes never enter a JSON document, and this function is the seam where that
/// change lands.
///
/// `cap` is a parameter rather than [`MAX_READ_BYTES_BINARY`] read directly, so
/// a test can prove the refusal without writing 32 MiB to a disk.
/// `files/read-head`: the first `bytes` of a file (at most
/// [`MAX_READ_HEAD_BYTES`]), with the whole file's `size` and whether the
/// answer stopped short of it.
fn read_head(params: Option<&Value>) -> Result<Value, RpcError> {
    let path = required_path(params)?;
    let wanted = match params.and_then(|p| p.get("bytes")) {
        Some(value) => value.as_u64().ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                format!("bytes must be a non-negative integer, got {value}"),
            )
        })?,
        None => MAX_READ_HEAD_BYTES,
    };
    read_head_at(&path, wanted.min(MAX_READ_HEAD_BYTES))
}

fn read_head_at(path: &Path, wanted: u64) -> Result<Value, RpcError> {
    use std::io::Read as _;

    let could_not = |what: &str, e: std::io::Error| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not {what} {}: {e}", path.display()),
        )
    };
    let file = std::fs::File::open(path).map_err(|e| could_not("open", e))?;
    let metadata = file.metadata().map_err(|e| could_not("stat", e))?;
    if metadata.is_dir() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{} is a directory, not a file", path.display()),
        ));
    }

    let mut bytes = Vec::new();
    file.take(wanted)
        .read_to_end(&mut bytes)
        .map_err(|e| could_not("read", e))?;

    Ok(json!({
        "path": path.display().to_string(),
        "base64": BASE64.encode(&bytes),
        "size": metadata.len(),
        "truncated": (bytes.len() as u64) < metadata.len(),
        "mtime": mtime_of(&metadata),
    }))
}

fn read_bytes_within(path: &Path, cap: u64) -> Result<Value, RpcError> {
    let metadata = std::fs::metadata(path).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not stat {}: {e}", path.display()),
        )
    })?;
    if metadata.is_dir() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{} is a directory, not a file", path.display()),
        ));
    }
    if metadata.len() > cap {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is {} bytes, over the {cap}-byte limit for a binary read",
                path.display(),
                metadata.len()
            ),
        ));
    }

    let bytes = std::fs::read(path).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not read {}: {e}", path.display()),
        )
    })?;

    Ok(json!({
        "path": path.display().to_string(),
        "base64": BASE64.encode(&bytes),
        // The decoded length, from the bytes actually read rather than from the
        // metadata above — the file could have grown between the two calls, and
        // a caller sizing a buffer wants the number that matches the payload.
        "size": bytes.len(),
        "mtime": mtime_of(&metadata),
    }))
}

/// Overwrite `path` with `text`, refusing if it moved under the caller.
///
/// `base_mtime` is the mtime the client last read. `None` means it never got one
/// and writes unconditionally: a filesystem that cannot report modification
/// times would otherwise make the editor unusable rather than safer, and "you
/// may not save here" is a worse outcome than the race it would be avoiding.
///
/// A path that does not exist yet is written, not refused. There is no
/// create-file UI today, but a `write` that could only ever overwrite would be a
/// surprise the first time there is one.
fn write_at(path: &Path, text: &str, base_mtime: Option<u64>) -> Result<Value, RpcError> {
    let current = mtime_at(path);
    // A file *deleted* since the read also counts as changed. The client asked
    // to replace a specific version and that version is not there; quietly
    // recreating it is a different act from the one it asked for, and the
    // frontend can offer "save as new" once it knows.
    if base_mtime.is_some() && base_mtime != current {
        return Err(RpcError::with_data(
            INVALID_PARAMS,
            format!("{} changed on disk since it was read", path.display()),
            json!({ "kind": "stale", "mtime": current }),
        ));
    }

    let temp = temp_sibling(path)?;
    std::fs::write(&temp, text).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not write {}: {e}", temp.display()),
        )
    })?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not replace {}: {e}", path.display()),
        )
    })?;

    Ok(json!({
        "path": path.display().to_string(),
        "mtime": mtime_at(path),
    }))
}

/// A scratch path beside `path`, for the write-then-rename above.
///
/// Same reasoning as `project/store.rs`: truncating the real file and writing
/// into it has a window where a crash leaves half a document, and `rename` over
/// an existing file is atomic on NTFS and POSIX alike. The one difference is
/// that this cannot use `with_extension` the way that module does — it knows it
/// is writing `projects.json`, while this would turn `main.rs` into `main.tmp`.
///
/// Beside the target rather than in the temp directory, because `rename` is only
/// atomic within one filesystem, and an editor open on a network share would
/// otherwise get a cross-device copy that can fail halfway.
fn temp_sibling(path: &Path) -> Result<PathBuf, RpcError> {
    let Some(name) = path.file_name() else {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is a root, not a file that can be written",
                path.display()
            ),
        ));
    };

    let mut name = name.to_os_string();
    name.push(".veistra-tmp");
    Ok(path.with_file_name(name))
}

/// What `files/create-file` and `files/create-dir` make.
///
/// `Copy` so it can be handed down through three calls without any of them
/// taking it away from the caller; a fieldless enum is a byte, and passing it by
/// value is both cheaper and less noisy than passing a reference to one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NewEntry {
    File,
    Dir,
}

impl NewEntry {
    /// The `EntryKind` the frontend switches on — the same closed set `list`
    /// and `stat` report, so a created entry can be described the same way a
    /// listed one is.
    fn kind(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Dir => "dir",
        }
    }

    /// What to call it in a sentence aimed at a person. Not `kind()`: "could not
    /// create a dir" is the protocol's word in a place where "folder" is the
    /// user's.
    fn noun(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Dir => "folder",
        }
    }
}

/// Create one entry named `name` directly inside `parent`.
///
/// `name` is a *name* and not a path — see [`validate_component`], which is what
/// makes `parent.join(name)` unable to land anywhere but immediately inside
/// `parent`. That is not the sandbox this module's header argues against having:
/// it is the difference between a field labelled "name" meaning what it says and
/// meaning "name, or a path, or `..\..\..`, depending". A caller that genuinely
/// wants to create somewhere else passes a different `parent`, in the open.
///
/// Refuses rather than overwrites when something is already there. For a file
/// that refusal is `create_new(true)`, which asks the OS to fail if the path
/// exists — one syscall that both checks and creates, where an `exists()` test
/// followed by a create has a gap in the middle that another process can walk
/// through. `create_dir` (not `create_dir_all`) has the same property for free:
/// it declines an existing directory and will not invent missing parents.
fn create_at(parent: &Path, name: &str, what: NewEntry) -> Result<Value, RpcError> {
    validate_component(name)?;

    // Checked before the create only so the failure can say *this*. Without it,
    // a `parent` that is a file or is not there at all comes back as the same
    // generic OS error as a dozen unrelated problems.
    if !parent.is_dir() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is not a folder, so there is nothing to create a {} in",
                parent.display(),
                what.noun()
            ),
        ));
    }

    let path = parent.join(name);

    let made = match what {
        NewEntry::File => std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            // The handle is dropped immediately: this creates an empty file, and
            // whatever writes to it next goes through `files/write` like every
            // other write in this module.
            .map(|_| ()),
        NewEntry::Dir => std::fs::create_dir(&path),
    };

    made.map_err(|e| match e.kind() {
        // The one failure the user can fix by typing something else, so it is
        // their mistake rather than the machine's.
        std::io::ErrorKind::AlreadyExists => RpcError::new(
            INVALID_PARAMS,
            format!("{name} already exists in {}", parent.display()),
        ),
        std::io::ErrorKind::PermissionDenied => RpcError::new(
            INTERNAL_ERROR,
            format!(
                "no permission to create a {} in {}",
                what.noun(),
                parent.display()
            ),
        ),
        _ => RpcError::new(
            INTERNAL_ERROR,
            format!("could not create {}: {e}", path.display()),
        ),
    })?;

    Ok(json!({
        "path": path.display().to_string(),
        "name": name,
        "kind": what.kind(),
    }))
}

/// Give the entry at `path` a new name, in the folder it is already in.
///
/// A rename and not a move: `name` goes through the same [`validate_component`]
/// as a create, so it cannot contain a separator and the result is always a
/// sibling of the original. Moving a file somewhere else is a different act with
/// a different set of ways to go wrong, and giving this one method both jobs
/// would mean a `name` parameter that is sometimes a path.
///
/// Works on directories as well as files. `std::fs::rename` makes no distinction
/// and neither does the caller — renaming a folder is the same gesture, and
/// refusing it would be inventing a limit the filesystem does not have.
///
/// The overwrite this has to prevent by hand is the one genuinely dangerous edge
/// in the module; the check for it is below, with the reasoning beside it.
fn rename_at(path: &Path, name: &str) -> Result<Value, RpcError> {
    validate_component(name)?;

    let parent = path.parent().ok_or_else(|| {
        RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is a root, and a root has no name to change",
                path.display()
            ),
        )
    })?;

    // Renaming something that is not there is a different error from every
    // other failure below, and the frontend can only say so if this does.
    if !path.exists() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{} is no longer there to rename", path.display()),
        ));
    }

    let target = parent.join(name);

    // Renaming a thing to what it is already called. Reported as success rather
    // than refused: nothing is wrong, and the caller asked for a state the disk
    // is already in.
    if target == path {
        return Ok(renamed(&target, name));
    }

    // **`std::fs::rename` replaces an existing destination without asking**, on
    // Windows and POSIX alike. That is the opposite of what `create_at` gets for
    // free from `create_new(true)`: renaming `notes.md` onto an existing
    // `todo.md` would destroy `todo.md` with no error anywhere. So the check is
    // explicit, and it is why this function is longer than it looks like it
    // should be.
    //
    // That check is not atomic, and saying so is better than implying otherwise:
    // another process could create the destination between the test and the
    // rename. Closing that gap means `MoveFileExW` *without*
    // `MOVEFILE_REPLACE_EXISTING`, which fails at the syscall the way
    // `create_new` does — a Windows-only FFI dependency this module does not
    // otherwise need. The race is a few microseconds wide and needs a second
    // writer in the same folder; the common case this does catch is the user
    // typing a name that is already taken.
    if target.exists() && !is_same_entry(path, &target) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{name} already exists in {}", parent.display()),
        ));
    }

    std::fs::rename(path, &target).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => RpcError::new(
            INTERNAL_ERROR,
            format!(
                "no permission to rename {}, or it is open in another program",
                path.display()
            ),
        ),
        _ => RpcError::new(
            INTERNAL_ERROR,
            format!("could not rename {} to {name}: {e}", path.display()),
        ),
    })?;

    Ok(renamed(&target, name))
}

/// Copy the entry at `path` to a free name beside it. Files and folders alike.
///
/// ## The collision discipline is the same one `create_at` has, not a weaker one
///
/// A duplicate must never overwrite. `std::fs::copy` *does* overwrite, silently,
/// exactly as `std::fs::rename` does — so the free name is found first and then
/// the destination is **reserved with `create_new(true)`** before a byte is
/// written, which is the same one-syscall check-and-create that makes
/// `create_at` safe. `create_dir` gives a directory the same property for free.
/// Picking a name that does not exist and then calling `copy` would have a gap
/// in the middle wide enough for the very collision this exists to prevent.
///
/// The name is `notes copy.txt`, then `notes copy 2.txt` — see [`copy_name`] for
/// why not Explorer's `notes - Copy.txt`.
fn duplicate_at(path: &Path) -> Result<Value, RpcError> {
    let parent = path.parent().ok_or_else(|| {
        RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is a root, and a root cannot be duplicated",
                path.display()
            ),
        )
    })?;

    // `symlink_metadata` would report the link rather than what it points at,
    // and duplicating a shortcut to a folder should produce a folder. Follows,
    // for the same reason `kind_of` does.
    let metadata = std::fs::metadata(path).map_err(|e| {
        RpcError::new(
            INVALID_PARAMS,
            format!("{} could not be read to duplicate it: {e}", path.display()),
        )
    })?;

    let name = base_name(path);
    let (target, target_name) = free_copy_path(parent, &name)?;

    // A folder is copied recursively, and a failure leaves nothing behind. There
    // is no atomic directory copy on any platform this runs on, so a failure
    // part-way through would otherwise leave a half-copy sitting next to the
    // original with a name that says it is a duplicate. [`copy_tree`] removes
    // what it made when it fails, so the only two outcomes are the whole thing
    // and nothing.
    let made = if metadata.is_dir() {
        copy_tree(path, &target)
    } else if metadata.is_file() {
        copy_file_new(path, &target)
    } else {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is not a file or a folder, so there is nothing to duplicate",
                path.display()
            ),
        ));
    };

    made.map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => RpcError::new(
            INTERNAL_ERROR,
            format!("no permission to write into {}", parent.display()),
        ),
        _ => RpcError::new(
            INTERNAL_ERROR,
            format!("could not duplicate {}: {e}", path.display()),
        ),
    })?;

    Ok(renamed(&target, &target_name))
}

/// How many `name copy N` attempts before giving up.
///
/// A bound rather than a `loop`, because the loop's exit depends on the
/// filesystem answering `exists()` honestly — a path that always reports taken
/// (a permission failure on the parent reads that way) would spin forever
/// inside a blocking worker with no way for the caller to cancel it.
const MAX_COPY_ATTEMPTS: u32 = 1000;

/// The first `name copy N` in `parent` that nothing occupies, and that name.
fn free_copy_path(parent: &Path, name: &str) -> Result<(PathBuf, String), RpcError> {
    for n in 1..=MAX_COPY_ATTEMPTS {
        let candidate = copy_name(name, n);
        let path = parent.join(&candidate);
        if !path.exists() {
            // Validated for the same reason a typed name is: the suffix cannot
            // make a legal name illegal, but the *original* may already be one
            // Windows would mangle, and a duplicate is not the place to find
            // that out by writing a file with a different name than reported.
            validate_component(&candidate)?;
            return Ok((path, candidate));
        }
    }

    Err(RpcError::new(
        INTERNAL_ERROR,
        format!(
            "{name} has already been duplicated {MAX_COPY_ATTEMPTS} times in {}",
            parent.display()
        ),
    ))
}

/// `notes.txt` → `notes copy.txt`, `notes copy 2.txt`, …
///
/// The suffix goes before the extension, which is the whole reason this is not
/// `format!("{name} copy")`: `notes.txt copy` would lose the file's type, its
/// icon and its editor grammar in one step.
///
/// A **leading** dot begins a name rather than an extension, so `.gitignore`
/// duplicates to `.gitignore copy` and not `. copy gitignore`. That is the same
/// rule `extensionOf` in `apps/files/ui/src/rpc.ts` applies, and the two have to
/// agree or the tree would show the copy with the wrong icon.
///
/// Not Explorer's `notes - Copy.txt`. This is a code editor: the name it
/// produces ends up in imports, in a terminal, and in git, and ` - ` needs
/// quoting in more places than a single space does. `copy` lowercase for the
/// same reason — it matches the rest of the tree rather than a shell convention.
fn copy_name(name: &str, n: u32) -> String {
    let suffix = if n == 1 {
        " copy".to_string()
    } else {
        format!(" copy {n}")
    };

    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{}{suffix}{}", &name[..dot], &name[dot..]),
        _ => format!("{name}{suffix}"),
    }
}

/// Copy one file, refusing rather than overwriting if `to` appeared meanwhile.
fn copy_file_new(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut source = std::fs::File::open(from)?;
    let mut destination = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    std::io::copy(&mut source, &mut destination)?;
    Ok(())
}

/// Copy a directory and everything under it, or leave nothing behind.
///
/// The cleanup on failure is the point. Without it a copy that ran out of disk
/// half way through would leave a folder called `assets copy` holding some
/// unknowable fraction of `assets` — which looks exactly like a folder that
/// copied fine, and is the sort of thing someone finds out about a week later.
/// `remove_dir_all` rather than the Recycle Bin: this folder existed for a few
/// milliseconds and never held anything the user made.
///
/// Entries that are neither a file nor a directory *after following links* — a
/// broken shortcut, a named pipe — are skipped rather than failing the copy.
/// There is nothing to duplicate about a pipe, and refusing the whole folder
/// because of one would make the feature unusable in any tree that has one.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir(to)?;
    match copy_children(from, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_dir_all(to);
            Err(e)
        }
    }
}

fn copy_children(from: &Path, to: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let destination = to.join(entry.file_name());

        // `entry.file_type()` does not follow links, so a shortcut to a folder
        // reports as neither. `metadata` follows, which is what "duplicate this"
        // means — the copy holds the contents, not a second pointer at them.
        let Ok(metadata) = std::fs::metadata(&source) else {
            continue;
        };

        if metadata.is_dir() {
            copy_tree(&source, &destination)?;
        } else if metadata.is_file() {
            copy_file_new(&source, &destination)?;
        }
    }
    Ok(())
}

/// What an import did, per name, so the explorer can say exactly what happened.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Imported {
    /// Names now present in the destination.
    copied: Vec<String>,
    /// Names skipped because something with that name was already there. Never overwritten.
    conflicts: Vec<String>,
    /// Names that could not be copied, with the reason in words.
    failed: Vec<ImportFailure>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct ImportFailure {
    name: String,
    reason: String,
}

/// `files/import`: copy files and folders from anywhere (a drop from the OS) into `dest`.
///
/// A write, so it is refused on main like the rest (`apps::WRITE_METHODS`). It copies and
/// never moves, never overwrites (a name already in `dest` is reported under `conflicts`
/// and left alone) and never copies a folder into itself.
fn import(params: Option<&Value>) -> Result<Value, RpcError> {
    let dest = PathBuf::from(required_string(params, "dest")?);
    let paths: Vec<PathBuf> = match params.and_then(|p| p.get("paths")) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(PathBuf::from))
            .collect(),
        _ => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                "paths must be an array of strings",
            ))
        }
    };
    let done = import_into(&dest, &paths)?;
    serde_json::to_value(done).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
}

fn import_into(dest: &Path, sources: &[PathBuf]) -> Result<Imported, RpcError> {
    if !dest.is_dir() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!(
                "{} is not a folder, so nothing can be dropped into it",
                dest.display()
            ),
        ));
    }
    let dest_real = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let mut out = Imported::default();
    for source in sources {
        let name = base_name(source);
        let target = dest.join(&name);
        let mut fail = |reason: String| {
            out.failed.push(ImportFailure {
                name: name.clone(),
                reason,
            })
        };
        let metadata = match std::fs::metadata(source) {
            Ok(m) => m,
            Err(e) => {
                fail(format!("could not be read: {e}"));
                continue;
            }
        };
        if metadata.is_dir() {
            let real = source.canonicalize().unwrap_or_else(|_| source.clone());
            if dest_real.starts_with(&real) {
                fail("a folder cannot be copied into itself".to_string());
                continue;
            }
        }
        // `symlink_metadata` so a dangling link in the way still counts as taken.
        if std::fs::symlink_metadata(&target).is_ok() {
            out.conflicts.push(name);
            continue;
        }
        let made = if metadata.is_dir() {
            copy_tree(source, &target)
        } else if metadata.is_file() {
            copy_file_new(source, &target)
        } else {
            fail("is not a file or a folder".to_string());
            continue;
        };
        match made {
            Ok(()) => out.copied.push(name),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => out.conflicts.push(name),
            Err(e) => fail(e.to_string()),
        }
    }
    Ok(out)
}

/// Write a buffer to a file the user chooses, through the OS save dialog.
///
/// The one method in this module that opens a dialog, and it is here rather than
/// in the frontend for the reason `home.rs` gives about its folder picker: a
/// native dialog is an OS resource with an owner window, and the webview has
/// neither. Everything else about it follows that file too — it must not run on
/// the main thread (`commands::app_call` moves every app call to a blocking
/// worker, which is what makes this safe), and it sets a parent so the dialog is
/// modal to Veistra instead of a second top-level window that can fall behind it.
///
/// **Cancelling is not an error.** It returns `null`, the same way Home's
/// pickers return the unchanged snapshot — a JSON-RPC error would make the
/// frontend draw a failure for something the user did on purpose.
///
/// No `baseMtime` conflict check, unlike [`write_at`]. There is nothing to
/// conflict with: the user has just been shown the folder's contents and, if
/// they picked an existing file, the system dialog has already asked them
/// whether to replace it. Asking again with an mtime comparison would be
/// second-guessing an answer they gave in the OS's own words.
fn save_as(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let name = required_string(params, "name")?;
    let text = required_string(params, "text")?;

    let mut dialog = rfd::FileDialog::new()
        .set_title("Save a copy")
        .set_file_name(&name);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let Some(path) = dialog.save_file() else {
        return Ok(Value::Null);
    };

    std::fs::write(&path, text).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => RpcError::new(
            INTERNAL_ERROR,
            format!("no permission to write {}", path.display()),
        ),
        _ => RpcError::new(
            INTERNAL_ERROR,
            format!("could not write {}: {e}", path.display()),
        ),
    })?;

    Ok(json!({
        "path": path.display().to_string(),
        "name": base_name(&path),
        "mtime": mtime_at(&path),
    }))
}

/// Move an entry to the Recycle Bin. Files and folders alike.
///
/// ## Why the `trash` crate and not `std::fs::remove_*`
///
/// `remove_file` and `remove_dir_all` unlink. There is no undo, no undelete, and
/// nothing in this app that could offer one — the bytes are gone the moment the
/// call returns. For a tool people point at a game project, that is the wrong
/// default by a wide margin: the recoverable option exists on every desktop
/// this runs on and it is what a Windows user already expects from Delete.
///
/// The alternative that adds no dependency is `SHFileOperationW` with
/// `FOF_ALLOWUNDO` through the `windows-sys` already in the tree. Rejected
/// deliberately: its central detail is a **double-null-terminated** wide path
/// buffer, and a subtly wrong buffer in the one function whose job is to destroy
/// things is not a bug this codebase should be able to have. `trash` is a small
/// crate that does exactly this and is tested against exactly that footgun.
fn delete_at(path: &Path) -> Result<Value, RpcError> {
    // Read the kind *before* the delete: afterwards there is nothing to stat,
    // and the caller needs to know whether it just lost a file or a folder.
    let metadata = std::fs::metadata(path).ok();
    if metadata.is_none() {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("{} is no longer there to delete", path.display()),
        ));
    }
    let kind = kind_of(metadata.as_ref());

    // This refuses rather than falling back. A volume with no Recycle Bin — most
    // network shares, some removable drives — makes this fail, and it is left
    // failing. Quietly unlinking instead would mean the confirmation said
    // "Recycle Bin" and the disk did something permanent, which is the one
    // outcome a confirmation exists to prevent. The user can still delete such a
    // file from the OS file manager, having been told what that means.
    trash::delete(path).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            // The crate's own message carries the OS reason, which on Windows is
            // usually the one that matters: the file is open in another program,
            // or this volume has no Recycle Bin. Passing it through verbatim is
            // the difference between a user who can act and one who cannot.
            format!("could not move {} to the Recycle Bin: {e}", path.display()),
        )
    })?;

    Ok(json!({
        "path": path.display().to_string(),
        "kind": kind,
        // Stated rather than assumed by the frontend, so the copy in the
        // confirmation and what actually happened can never disagree — if this
        // ever gains a permanent-delete path, the dialog reads this.
        "trashed": true,
    }))
}

/// How many entries a recursive delete would take with it.
///
/// Exists for one sentence in the confirmation: deleting a folder is deleting
/// everything under it, and a dialog that does not say how much is asking the
/// user to approve an amount they cannot see.
///
/// Capped, and the cap is reported rather than hidden. Counting `node_modules`
/// exactly would mean walking tens of thousands of entries while someone waits
/// on a dialog, and "more than 10,000 items" is the same warning as an exact
/// number — arguably a louder one.
const TREE_SIZE_CAP: usize = 10_000;

fn tree_size_at(path: &Path) -> Value {
    let mut files = 0usize;
    let mut dirs = 0usize;
    let mut truncated = false;

    // An explicit stack rather than recursion: this walks user-supplied trees,
    // and a deep one should cost memory rather than blow the call stack.
    let mut stack = vec![path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if files + dirs >= TREE_SIZE_CAP {
            truncated = true;
            break;
        }

        // A directory that cannot be read contributes nothing rather than
        // failing the count. The number is for a warning, and a warning that
        // refused to appear because one subfolder was locked would be worse
        // than one that is slightly low.
        let Ok(reader) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in reader.flatten() {
            if files + dirs >= TREE_SIZE_CAP {
                truncated = true;
                break;
            }
            // `file_type` does not follow symlinks, so a link to a directory is
            // counted once as an entry and not descended into — which matches
            // what the delete does to it.
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    dirs += 1;
                    stack.push(entry.path());
                }
                _ => files += 1,
            }
        }
    }

    json!({
        "path": path.display().to_string(),
        "files": files,
        "dirs": dirs,
        "truncated": truncated,
    })
}

/// Whether two paths are the same entry on disk, rather than merely different.
///
/// This exists for one case, and it is a case that would otherwise be a bug on
/// the platform Veistra runs on: **changing only the capitalisation of a name**.
/// Windows filesystems are case-insensitive, so `Notes.md` and `notes.md` are
/// the same file — `target.exists()` is therefore `true` when renaming one to
/// the other, and a plain existence check would refuse a rename that is both
/// legal and common.
///
/// `canonicalize` resolves each path to what the filesystem actually holds, so
/// the two come back identical exactly when they are one entry. Both failing to
/// resolve is *not* treated as a match: that means neither is there, which is a
/// question this function was not asked.
fn is_same_entry(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The answer shape shared by `create_at` and `rename_at`, so a caller can
/// treat "here is an entry that now exists at this path" as one thing.
fn renamed(path: &Path, name: &str) -> Value {
    json!({
        "path": path.display().to_string(),
        "name": name,
        "kind": kind_of(std::fs::metadata(path).ok().as_ref()),
    })
}

/// Characters Windows will not put in a file name. `/` and `\` are handled
/// separately, because they are refused for a different reason.
const RESERVED_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// The DOS device names, still reserved by Win32 forty years on. Reserved with
/// *any* extension too, so `con.txt` is as unusable as `con`.
const RESERVED_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Whether `name` is one path component that Windows will store as written.
///
/// Every rule here refuses something the OS would otherwise accept and then
/// quietly change, or accept and then make unopenable. That is the bar: this is
/// not a taste check on names, and it does not stop anyone creating `.hidden` or
/// `weird name with spaces`. What it stops is the gap between what was typed and
/// what ends up on disk — a trailing dot is silently dropped by Win32, so
/// `notes.` becomes `notes`, and the tree would come back showing a file the
/// user did not ask for with no error anywhere.
///
/// Written for Windows because that is what Veistra runs on, and applied
/// everywhere rather than behind a `cfg`: the rules are a strict superset of
/// what POSIX refuses, and a project that syncs between the two is better served
/// by names that work in both than by names that work here.
fn validate_component(name: &str) -> Result<(), RpcError> {
    let refuse = |why: String| RpcError::new(INVALID_PARAMS, why);

    if name.is_empty() {
        return Err(refuse("a name is required".into()));
    }

    if name.contains('/') || name.contains('\\') {
        return Err(refuse(format!(
            "{name:?} contains a path separator — this creates one entry inside the folder you \
             chose, so the name may not be a path"
        )));
    }

    if name == "." || name == ".." {
        return Err(refuse(format!(
            "{name:?} is how a path refers to a folder that already exists, not a name"
        )));
    }

    if let Some(bad) = name
        .chars()
        .find(|c| RESERVED_CHARS.contains(c) || c.is_control())
    {
        // Control characters print as nothing, so they are named by their code
        // point rather than shown — a message reading `'' is not allowed` would
        // be indistinguishable from a bug in the message.
        let shown = if bad.is_control() {
            format!("U+{:04X}", bad as u32)
        } else {
            format!("{bad:?}")
        };
        return Err(refuse(format!(
            "{shown} is not allowed in a Windows file name"
        )));
    }

    if name.ends_with(' ') || name.ends_with('.') {
        return Err(refuse(format!(
            "Windows silently drops a trailing space or dot, so {name:?} would not be the name on \
             disk"
        )));
    }

    // The stem is everything before the *first* dot, which is what Win32 looks
    // at: `con.txt.bak` is still the console device.
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if RESERVED_STEMS.contains(&stem.as_str()) {
        return Err(refuse(format!(
            "{stem:?} is a reserved device name on Windows, so {name:?} cannot be created"
        )));
    }

    Ok(())
}

/// `"dir"`, `"file"`, or `"other"`, from metadata that may not have been read.
///
/// `None` is the broken-symlink and permission-denied case — `std::fs::metadata`
/// follows links, so an entry whose target is gone gives nothing to switch on.
///
/// This is as far as the module goes towards deciding what a file *is*: no MIME
/// sniffing and no content type, just the filesystem's own dir/file/other. Which
/// viewer opens a `.png` is the frontend registry's business, and keeping that
/// knowledge on one side means adding a format is a one-file change rather than
/// a change here, a change there, and a protocol between them that has to agree.
fn kind_of(metadata: Option<&std::fs::Metadata>) -> &'static str {
    match metadata.map(|m| m.file_type()) {
        Some(t) if t.is_dir() => "dir",
        Some(t) if t.is_file() => "file",
        _ => "other",
    }
}

/// Milliseconds since the Unix epoch, the way `project/mod.rs` does it.
///
/// Written out again rather than imported: that one is private, takes a `&Path`
/// where most callers here already hold the metadata, and widening another
/// module's surface for a single caller costs more than six lines do.
fn mtime_of(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// The same, for a path that may not exist — the conflict check's question.
fn mtime_at(path: &Path) -> Option<u64> {
    mtime_of(&std::fs::metadata(path).ok()?)
}

/// A path's last component, or the whole path when it has none.
///
/// A drive root like `C:\` has no `file_name()`, and calling the folder the app
/// opened in "" would be worse than calling it `C:\`. `project/mod.rs` makes the
/// same decision for the same reason; the frontend's `baseName` is the third
/// copy, and it is there because an app may not import from the shell.
fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

// --- the rest of the methods --------------------------------------------------

/// Write a file, conflict-checked. See [`write_at`] for what `baseMtime` means.
fn write(params: Option<&Value>) -> Result<Value, RpcError> {
    let path = required_path(params)?;

    let text = match params.and_then(|p| p.get("text")) {
        Some(Value::String(text)) => text,
        Some(other) => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("text must be a string, got {other}"),
            ))
        }
        None => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                "text is required — there is no method for emptying a file by omission",
            ))
        }
    };

    let base_mtime = match params.and_then(|p| p.get("baseMtime")) {
        // Absent and explicitly null are the same claim: "I have no time to
        // compare against". They arrive differently only because JSON does.
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(n.as_u64().ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                format!("baseMtime must be a whole number of milliseconds, got {n}"),
            )
        })?),
        Some(other) => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("baseMtime must be a number or null, got {other}"),
            ))
        }
    };

    write_at(&path, text, base_mtime)
}

/// Create an empty file, or a folder, inside `parent`. See [`create_at`].
///
/// Two params rather than one whole path, and that is the point of the method
/// rather than an accident of its signature: a single `path` would put the
/// splitting of "where" from "what to call it" on the frontend, which is the one
/// place in this app that is not allowed to have an opinion about path semantics
/// (see the note in `rpc.ts`). Handing over a folder and a name lets the check
/// that the name *is* a name live next to the code that joins them.
fn create(params: Option<&Value>, what: NewEntry) -> Result<Value, RpcError> {
    let parent = PathBuf::from(required_string(params, "parent")?);
    let name = required_string(params, "name")?;
    create_at(&parent, &name, what)
}

/// Rename the entry at `path` to `name`. See [`rename_at`].
fn rename(params: Option<&Value>) -> Result<Value, RpcError> {
    let path = required_path(params)?;
    let name = required_string(params, "name")?;
    rename_at(&path, &name)
}

/// One required string param, by name.
///
/// [`required_path`] is the same shape for the one param almost every method
/// here takes; this is for the two that `files/create-*` adds. Kept separate
/// rather than generalised, because `required_path` returns a `PathBuf` and a
/// name is deliberately not one.
fn required_string(params: Option<&Value>, key: &str) -> Result<String, RpcError> {
    match params.and_then(|p| p.get(key)) {
        Some(Value::String(raw)) => Ok(raw.clone()),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("{key} must be a string, got {other}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, format!("{key} is required"))),
    }
}

/// Select the item in the OS file manager.
///
/// Called through the plugin's Rust API rather than by letting the frontend
/// invoke `opener:` directly, which is why `capabilities/default.json` needs no
/// entry for it: that file gates IPC arriving from a webview, and this call
/// starts here. The app frame is same-origin with the shell, so a capability
/// granted for the Files app would be one granted to the shell's whole origin.
fn reveal(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let path = required_path(params)?;
    app.opener().reveal_item_in_dir(&path).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not reveal {}: {e}", path.display()),
        )
    })?;
    Ok(Value::Null)
}

/// Start Blender on a `.blend`, detached. Its own method rather than a case of
/// `open-external` because that hands the file to whatever the OS associates
/// with it, and this one names the program and says so when it is not installed.
fn open_in_blender(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let path = required_path(params)?;
    super::blender_viewer::open_in_blender(app, &path)
}

/// Hand the file to whatever the OS opens it with.
fn open_external(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let path = required_path(params)?;
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| {
            RpcError::new(
                INTERNAL_ERROR,
                format!("could not open {}: {e}", path.display()),
            )
        })?;
    Ok(Value::Null)
}

/// Whether a link in a rendered document may be handed to the system browser.
///
/// Only `http`, `https` and `mailto`. A Markdown preview draws links from files
/// nobody has vetted, so `file:`, `javascript:` and every custom scheme a
/// registered handler might act on are refused here, in Rust, rather than
/// trusted to whatever the webview filtered.
fn is_openable_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

/// Hand a web link to the system browser. See [`is_openable_url`].
fn open_url(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let url = match params.and_then(|p| p.get("url")) {
        Some(Value::String(raw)) => raw.trim().to_string(),
        Some(other) => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("url must be a string, got {other}"),
            ))
        }
        None => return Err(RpcError::new(INVALID_PARAMS, "url is required")),
    };
    if !is_openable_url(&url) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "only http, https and mailto links can be opened",
        ));
    }
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not open {url}: {e}")))?;
    Ok(Value::Null)
}

/// The `path` param, for the methods that have no honest default.
///
/// [`resolve_path`] falls back to the checkout root when `path` is missing, which
/// is right for browsing and wrong for everything else: a `files/write` that fell
/// back would try to overwrite the project directory, and a `files/reveal` would
/// pop open a window nobody asked for. Both should say the caller made a mistake.
fn required_path(params: Option<&Value>) -> Result<PathBuf, RpcError> {
    match params.and_then(|p| p.get("path")) {
        Some(Value::String(raw)) => Ok(PathBuf::from(raw)),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("path must be a string, got {other}"),
        )),
        None => Err(RpcError::new(INVALID_PARAMS, "path is required")),
    }
}

/// The `path` param, or this cluster's root when it is absent.
fn resolve_path(
    app: &AppHandle,
    context: &CallContext,
    params: Option<&Value>,
) -> Result<PathBuf, RpcError> {
    match params.and_then(|p| p.get("path")) {
        Some(Value::String(raw)) => Ok(PathBuf::from(raw)),
        // Absent or explicitly null both mean "wherever you'd start me".
        None | Some(Value::Null) => default_root(app, context),
        Some(other) => Err(RpcError::new(
            INVALID_PARAMS,
            format!("path must be a string, got {other}"),
        )),
    }
}

/// Where Files opens when nobody has said otherwise: **this cluster's** project,
/// or the directory holding the running manifest when the cluster has none.
///
/// The project wins because Files exists to browse the thing being worked on,
/// and once there is a project that is what it is. Which project is the caller's
/// cluster's, never a process-wide one — a Files in the cluster working on
/// `aurora` and a Files in the cluster working on `borealis` are two surfaces
/// asking the same question and entitled to two answers.
///
/// The manifest directory is the honest fallback rather than a placeholder —
/// with no project on this cluster, the stack checkout is the only tree the
/// orchestrator knows anything about. Not the process's working directory in
/// either case, which is `src-tauri/` under `tauri dev` and the install
/// directory in a release build; neither is anywhere the user would recognise.
pub(super) fn default_root(app: &AppHandle, context: &CallContext) -> Result<PathBuf, RpcError> {
    if let Some(project) = context.project.clone() {
        return Ok(project);
    }

    let snapshot = app.state::<AppState>().get().ok_or_else(|| {
        RpcError::new(
            INTERNAL_ERROR,
            "this cluster has no project and the stack has not been scanned yet, so there is no default directory",
        )
    })?;

    snapshot
        .manifest_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            RpcError::new(
                INTERNAL_ERROR,
                "the manifest path has no parent directory to open",
            )
        })
}

#[cfg(test)]
mod tests {
    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn import_copies_files_and_folders_and_leaves_the_originals() {
        let src = tmp();
        let dest = tmp();
        std::fs::write(src.path().join("a.txt"), "a").unwrap();
        std::fs::create_dir_all(src.path().join("dir/sub")).unwrap();
        std::fs::write(src.path().join("dir/sub/b.txt"), "b").unwrap();

        let done = import_into(
            dest.path(),
            &[src.path().join("a.txt"), src.path().join("dir")],
        )
        .unwrap();

        assert_eq!(done.copied, ["a.txt", "dir"]);
        assert!(done.conflicts.is_empty() && done.failed.is_empty());
        assert_eq!(
            std::fs::read_to_string(dest.path().join("dir/sub/b.txt")).unwrap(),
            "b"
        );
        assert!(src.path().join("a.txt").exists());
    }

    #[test]
    fn import_never_overwrites_and_reports_the_name() {
        let src = tmp();
        let dest = tmp();
        std::fs::write(src.path().join("a.txt"), "new").unwrap();
        std::fs::write(dest.path().join("a.txt"), "mine").unwrap();

        let done = import_into(dest.path(), &[src.path().join("a.txt")]).unwrap();

        assert_eq!(done.conflicts, ["a.txt"]);
        assert!(done.copied.is_empty());
        assert_eq!(
            std::fs::read_to_string(dest.path().join("a.txt")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn import_refuses_a_folder_into_itself_and_a_missing_source() {
        let dest = tmp();
        std::fs::create_dir(dest.path().join("inner")).unwrap();
        let done = import_into(
            &dest.path().join("inner"),
            &[dest.path().to_path_buf(), dest.path().join("gone.txt")],
        )
        .unwrap();
        assert_eq!(done.failed.len(), 2);
        assert!(done.failed[0].reason.contains("into itself"));
        assert!(done.copied.is_empty());
    }

    #[test]
    fn import_into_a_file_is_an_error_not_a_copy() {
        let dest = tmp();
        let file = dest.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(import_into(&file, &[]).is_err());
    }

    /// Still classed as a write, and main, which used to refuse it, allows it.
    #[test]
    fn import_is_a_write_method_and_main_allows_it() {
        assert!(crate::apps::is_write_method("files/import"));
        let main = crate::environments::Environment::Main;
        assert!(crate::apps::write_refusal(Some(&main), "files/import").is_ok());
    }

    use super::*;

    #[test]
    fn only_web_and_mail_links_are_openable() {
        assert!(is_openable_url("https://example.com/a?b=c"));
        assert!(is_openable_url("HTTP://example.com"));
        assert!(is_openable_url("mailto:someone@example.com"));
        assert!(!is_openable_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("ms-settings:"));
        assert!(!is_openable_url("C:\\Windows\\notepad.exe"));
        assert!(!is_openable_url(""));
    }

    /// A temp directory that cleans itself up, following `project/marker.rs` —
    /// these tests are about what a real filesystem does, and a fake one would
    /// only be testing the fake.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!("veistra-files-{tag}-{stamp}"));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn file(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, contents).expect("write fixture");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_stale_base_mtime_refuses_the_write_and_says_what_the_file_is_now() {
        let dir = TempDir::new("stale");
        let path = dir.file("notes.txt", "original");
        let actual = mtime_at(&path).expect("a fresh file has an mtime");

        // A deliberately wrong time rather than a real race: sleeping until the
        // clock ticks would make this test slow on a filesystem with coarse
        // timestamps and flaky on one without.
        let err = write_at(&path, "clobbered", Some(actual + 60_000))
            .expect_err("a write against a time the file never had must refuse");

        assert_eq!(err.code, INVALID_PARAMS);
        let data = err.data.expect("the refusal carries a data payload");
        assert_eq!(data["kind"], "stale");
        assert_eq!(
            data["mtime"].as_u64(),
            Some(actual),
            "the payload reports the time the caller lost to, so it can re-read"
        );

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "original",
            "a refused write leaves the file alone"
        );
    }

    #[test]
    fn a_matching_base_mtime_writes() {
        let dir = TempDir::new("match");
        let path = dir.file("notes.txt", "original");
        let base = mtime_at(&path);

        let result = write_at(&path, "edited", base).expect("write");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "edited");
        assert_eq!(result["path"], path.display().to_string());
        assert!(
            result["mtime"].is_number(),
            "the answer carries the next write's baseMtime"
        );
    }

    /// The promise in [`write_at`]'s doc: no readable mtime must not mean no
    /// saving.
    #[test]
    fn a_null_base_mtime_writes_anyway() {
        let dir = TempDir::new("nobase");
        let path = dir.file("notes.txt", "original");

        write_at(&path, "edited", None).expect("a write with no base time must succeed");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "edited");
    }

    #[test]
    fn writing_a_path_that_does_not_exist_yet_creates_it() {
        let dir = TempDir::new("create");
        let path = dir.0.join("new.txt");

        write_at(&path, "hello", None).expect("create");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    }

    /// The temp file is a sibling and it does not survive the write — a stray
    /// `main.rs.veistra-tmp` in a source tree would end up in someone's commit.
    #[test]
    fn the_write_leaves_no_temp_file_behind() {
        let dir = TempDir::new("tmp");
        let path = dir.file("main.rs", "fn main() {}");

        write_at(&path, "fn main() { todo!() }", None).expect("write");

        let left: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(left, vec!["main.rs".to_string()]);
    }

    #[test]
    fn a_binary_read_over_the_cap_errors_rather_than_truncating() {
        let dir = TempDir::new("cap");
        let path = dir.file("big.bin", "0123456789");

        let err = read_bytes_within(&path, 4).expect_err("over the cap must not return a prefix");

        assert_eq!(err.code, INVALID_PARAMS);
        assert!(
            err.message.contains("limit"),
            "the message must name the cap, not just fail: {}",
            err.message
        );
    }

    #[test]
    fn a_binary_read_under_the_cap_round_trips() {
        let dir = TempDir::new("bytes");
        let path = dir.file("small.bin", "hello");

        let value = read_bytes_within(&path, MAX_READ_BYTES_BINARY).expect("read");

        assert_eq!(value["base64"], BASE64.encode("hello"));
        assert_eq!(value["size"], 5);
    }

    #[test]
    fn a_head_read_returns_the_prefix_and_the_whole_size() {
        let dir = TempDir::new("head");
        let path = dir.file("model.blend", "BLENDER-v402rest");

        let value = read_head_at(&path, 12).expect("read");

        assert_eq!(value["base64"], BASE64.encode("BLENDER-v402"));
        assert_eq!(value["size"], 16);
        assert_eq!(value["truncated"], true);
    }

    #[test]
    fn a_head_read_longer_than_the_file_is_the_whole_file() {
        let dir = TempDir::new("head-short");
        let path = dir.file("tiny.bin", "abc");

        let value = read_head_at(&path, 1024).expect("read");

        assert_eq!(value["base64"], BASE64.encode("abc"));
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn a_head_read_caps_the_length_and_rejects_a_bad_one() {
        let dir = TempDir::new("head-params");
        let path = dir.file("a.bin", "abc");
        let raw = path.display().to_string();

        let capped = read_head(Some(&json!({ "path": raw, "bytes": u64::MAX }))).expect("read");
        assert_eq!(capped["base64"], BASE64.encode("abc"));

        let err = read_head(Some(&json!({ "path": raw, "bytes": -1 }))).expect_err("negative");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn stat_reports_a_missing_path_as_absent_rather_than_failing() {
        let dir = TempDir::new("gone");
        let path = dir.0.join("deleted.txt");

        let value = stat_at(&path);

        assert_eq!(value["exists"], false);
        assert_eq!(value["size"], Value::Null);
        assert_eq!(value["mtime"], Value::Null);
        assert_eq!(value["name"], "deleted.txt", "a gone file still has a name");
    }

    #[test]
    fn stat_reports_a_directory_with_no_size() {
        let dir = TempDir::new("dir");

        let value = stat_at(&dir.0);

        assert_eq!(value["exists"], true);
        assert_eq!(value["kind"], "dir");
        assert_eq!(value["size"], Value::Null, "a directory has no one size");
    }

    /// The suffix goes before the extension, or a duplicate would lose the
    /// file's type — and with it its icon and its editor grammar.
    #[test]
    fn copy_name_keeps_the_extension() {
        assert_eq!(copy_name("notes.txt", 1), "notes copy.txt");
        assert_eq!(copy_name("notes.txt", 2), "notes copy 2.txt");
        assert_eq!(copy_name("archive.tar.gz", 1), "archive.tar copy.gz");
    }

    /// A leading dot begins a *name*, not an extension — the same rule
    /// `extensionOf` in `apps/files/ui/src/rpc.ts` applies. The two have to
    /// agree or the tree would show the copy with the wrong icon.
    #[test]
    fn copy_name_treats_a_leading_dot_as_part_of_the_name() {
        assert_eq!(copy_name(".gitignore", 1), ".gitignore copy");
        assert_eq!(copy_name("Makefile", 1), "Makefile copy");
        assert_eq!(copy_name("src", 3), "src copy 3");
    }

    #[test]
    fn duplicating_a_file_copies_its_contents_beside_it() {
        let dir = TempDir::new("dup-file");
        let path = dir.file("notes.txt", "hello");

        let value = duplicate_at(&path).expect("duplicate");

        assert_eq!(value["name"], "notes copy.txt");
        assert_eq!(value["kind"], "file");
        let copied = dir.0.join("notes copy.txt");
        assert_eq!(std::fs::read_to_string(&copied).expect("read"), "hello");
        assert!(path.exists(), "the original is not moved");
    }

    /// The collision rule `create_at` has, applied here: a second duplicate
    /// takes the next free name rather than overwriting the first.
    #[test]
    fn duplicating_twice_numbers_the_second_copy() {
        let dir = TempDir::new("dup-twice");
        let path = dir.file("notes.txt", "hello");

        duplicate_at(&path).expect("first");
        let value = duplicate_at(&path).expect("second");

        assert_eq!(value["name"], "notes copy 2.txt");
        assert_eq!(
            std::fs::read_to_string(dir.0.join("notes copy.txt")).expect("read"),
            "hello",
            "the first copy is untouched"
        );
    }

    #[test]
    fn duplicating_a_folder_takes_everything_under_it() {
        let dir = TempDir::new("dup-tree");
        let src = dir.0.join("src");
        std::fs::create_dir(&src).expect("mkdir");
        std::fs::create_dir(src.join("nested")).expect("mkdir");
        std::fs::write(src.join("a.rs"), "fn a() {}").expect("write");
        std::fs::write(src.join("nested/b.rs"), "fn b() {}").expect("write");

        let value = duplicate_at(&src).expect("duplicate");

        assert_eq!(value["name"], "src copy");
        assert_eq!(value["kind"], "dir");
        let copied = dir.0.join("src copy");
        assert_eq!(
            std::fs::read_to_string(copied.join("a.rs")).expect("read"),
            "fn a() {}"
        );
        assert_eq!(
            std::fs::read_to_string(copied.join("nested/b.rs")).expect("read"),
            "fn b() {}"
        );
    }

    #[test]
    fn duplicating_something_that_is_not_there_says_so() {
        let dir = TempDir::new("dup-gone");
        let err = duplicate_at(&dir.0.join("nope.txt")).expect_err("refused");
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn base_name_takes_the_last_component() {
        assert_eq!(base_name(Path::new(r"C:\code\MyGame")), "MyGame");
        assert_eq!(base_name(Path::new("/home/braden/notes.txt")), "notes.txt");
    }

    /// `files/root` reports this as the header of the whole tree. A drive root
    /// has no file name at all, and an explorer headed "" would be worse than
    /// one headed `C:\`.
    #[test]
    fn base_name_of_a_drive_root_falls_back_to_the_path() {
        assert_eq!(base_name(Path::new(r"C:\")), r"C:\");
        assert!(!base_name(Path::new("/")).is_empty());
    }

    #[test]
    fn creating_makes_an_empty_file_and_reports_where() {
        let dir = TempDir::new("new-file");

        let value = create_at(&dir.0, "notes.md", NewEntry::File).expect("create");

        let path = dir.0.join("notes.md");
        assert_eq!(value["path"], path.display().to_string());
        assert_eq!(value["kind"], "file");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "",
            "a new file is empty, not a template"
        );
    }

    #[test]
    fn creating_makes_a_folder() {
        let dir = TempDir::new("new-dir");

        let value = create_at(&dir.0, "assets", NewEntry::Dir).expect("create");

        assert_eq!(value["kind"], "dir");
        assert!(dir.0.join("assets").is_dir());
    }

    /// The whole reason `create_new(true)` is used instead of a plain write: a
    /// name that is already taken must not quietly empty the file that has it.
    #[test]
    fn creating_over_an_existing_name_refuses_and_leaves_it_alone() {
        let dir = TempDir::new("collide");
        let path = dir.file("notes.md", "work in progress");

        let err = create_at(&dir.0, "notes.md", NewEntry::File)
            .expect_err("a name that is taken must refuse");

        assert_eq!(err.code, INVALID_PARAMS);
        assert!(
            err.message.contains("already exists"),
            "the message must say why: {}",
            err.message
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "work in progress");
    }

    /// A folder colliding with a *file* of the same name is the same refusal —
    /// the namespace is shared, and `create_dir` reports it the same way.
    #[test]
    fn a_folder_cannot_take_a_name_a_file_already_has() {
        let dir = TempDir::new("collide-kind");
        dir.file("build", "not a folder");

        let err = create_at(&dir.0, "build", NewEntry::Dir).expect_err("taken");

        assert_eq!(err.code, INVALID_PARAMS);
    }

    /// `name` is one component. Nothing here is a sandbox — see `create_at`'s
    /// doc — but a separator in a *name* is a mistake in every case, and the
    /// side effect is that a create can only ever land inside the folder the
    /// caller named.
    #[test]
    fn a_name_may_not_be_a_path() {
        let dir = TempDir::new("traversal");

        for name in [
            "../escaped.txt",
            r"..\escaped.txt",
            "sub/nested.txt",
            "..",
            ".",
        ] {
            let err = match create_at(&dir.0, name, NewEntry::File) {
                Ok(_) => panic!("{name} must be refused"),
                Err(err) => err,
            };
            assert_eq!(err.code, INVALID_PARAMS, "{name}");
        }
    }

    #[test]
    fn windows_reserved_characters_and_device_names_are_refused() {
        let dir = TempDir::new("reserved");

        for name in ["what?.txt", "a:b", "pipe|d", "con", "CON.txt", "lpt9.log"] {
            let err = create_at(&dir.0, name, NewEntry::File)
                .expect_err("a name Windows cannot store must be refused before it is tried");
            assert_eq!(err.code, INVALID_PARAMS, "{name}");
        }
    }

    /// The subtle one. Win32 drops these itself, so accepting the name would
    /// create a file with a *different* name and report success.
    #[test]
    fn a_trailing_space_or_dot_is_refused_rather_than_silently_dropped() {
        let dir = TempDir::new("trailing");

        for name in ["notes.", "notes ", "folder."] {
            let err = create_at(&dir.0, name, NewEntry::File).expect_err("must refuse");
            assert_eq!(err.code, INVALID_PARAMS, "{name}");
            assert!(
                !dir.0.join("notes").exists(),
                "nothing may be created under a name the user did not type"
            );
        }
    }

    #[test]
    fn a_dotfile_is_a_perfectly_good_name() {
        let dir = TempDir::new("dotfile");

        create_at(&dir.0, ".gitignore", NewEntry::File).expect("a leading dot is a name");
        create_at(&dir.0, ".veistra", NewEntry::Dir).expect("and so is Veistra's own folder");

        assert!(dir.0.join(".gitignore").is_file());
        assert!(dir.0.join(".veistra").is_dir());
    }

    #[test]
    fn creating_inside_something_that_is_not_a_folder_says_so() {
        let dir = TempDir::new("not-a-dir");
        let file = dir.file("notes.md", "text");

        let err = create_at(&file, "child.txt", NewEntry::File).expect_err("a file has no inside");

        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("not a folder"), "{}", err.message);
    }

    #[test]
    fn renaming_moves_the_contents_to_the_new_name() {
        let dir = TempDir::new("rename");
        let path = dir.file("notes.md", "the text");

        let value = rename_at(&path, "journal.md").expect("rename");

        assert_eq!(value["name"], "journal.md");
        assert_eq!(value["kind"], "file");
        assert!(!path.exists(), "the old name is gone");
        assert_eq!(
            std::fs::read_to_string(dir.0.join("journal.md")).unwrap(),
            "the text",
            "a rename moves the bytes, it does not copy or truncate them"
        );
    }

    /// The dangerous one. `std::fs::rename` silently replaces its destination,
    /// so without the explicit check this would destroy `todo.md`.
    #[test]
    fn renaming_onto_an_existing_name_refuses_and_destroys_nothing() {
        let dir = TempDir::new("clobber");
        let source = dir.file("notes.md", "source");
        let victim = dir.file("todo.md", "MUST SURVIVE");

        let err = rename_at(&source, "todo.md").expect_err("renaming onto a live file must refuse");

        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("already exists"), "{}", err.message);
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "MUST SURVIVE",
            "the file that was already there is untouched"
        );
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "source",
            "and so is the one that was being renamed"
        );
    }

    /// The Windows one. `Notes.md` and `notes.md` are the same file on a
    /// case-insensitive filesystem, so a plain `exists()` check would refuse a
    /// legal rename — see `is_same_entry`.
    #[test]
    fn changing_only_the_capitalisation_is_allowed() {
        let dir = TempDir::new("case");
        let path = dir.file("Notes.md", "the text");

        let value = rename_at(&path, "notes.md").expect("a case-only rename is a real rename");

        assert_eq!(value["name"], "notes.md");
        assert_eq!(
            std::fs::read_to_string(dir.0.join("notes.md")).unwrap(),
            "the text"
        );
    }

    #[test]
    fn renaming_to_the_same_name_succeeds_and_changes_nothing() {
        let dir = TempDir::new("noop");
        let path = dir.file("notes.md", "the text");

        let value = rename_at(&path, "notes.md").expect("a no-op rename is not an error");

        assert_eq!(value["name"], "notes.md");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "the text");
    }

    #[test]
    fn a_folder_can_be_renamed_with_its_contents() {
        let dir = TempDir::new("renamedir");
        let folder = dir.0.join("assets");
        std::fs::create_dir(&folder).expect("mkdir");
        std::fs::write(folder.join("logo.png"), "bytes").expect("write");

        let value = rename_at(&folder, "art").expect("a folder renames like anything else");

        assert_eq!(value["kind"], "dir");
        assert_eq!(
            std::fs::read_to_string(dir.0.join("art").join("logo.png")).unwrap(),
            "bytes",
            "the children come with it"
        );
    }

    /// A rename takes a *name*, so the same rule as create: no separators, and
    /// therefore no way to move an entry out of its folder through this method.
    #[test]
    fn a_rename_target_may_not_be_a_path_or_an_unstorable_name() {
        let dir = TempDir::new("renamebad");
        let path = dir.file("notes.md", "the text");

        for name in [
            "../escaped.md",
            r"..\escaped.md",
            "sub/nested.md",
            "what?.md",
            "con",
            "notes.",
        ] {
            let err = match rename_at(&path, name) {
                Ok(_) => panic!("{name} must be refused"),
                Err(err) => err,
            };
            assert_eq!(err.code, INVALID_PARAMS, "{name}");
        }

        assert!(path.exists(), "every refusal left the original alone");
    }

    #[test]
    fn renaming_something_that_is_gone_says_so() {
        let dir = TempDir::new("renamegone");
        let path = dir.0.join("never-existed.md");

        let err = rename_at(&path, "whatever.md").expect_err("nothing to rename");

        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("no longer there"), "{}", err.message);
    }

    /// Deleting really does remove the entry from its folder. Deliberately not
    /// asserting *where* it went: this test would then depend on the machine
    /// having a Recycle Bin, and the promise the app makes is only that the
    /// file leaves the project — recovering it is the OS's business.
    #[test]
    fn deleting_removes_the_entry_and_reports_what_it_was() {
        let dir = TempDir::new("delete");
        let path = dir.file("notes.md", "the text");

        let value = delete_at(&path).expect("delete");

        assert_eq!(value["kind"], "file");
        assert_eq!(value["trashed"], true);
        assert!(!path.exists(), "the entry is gone from the folder");
    }

    #[test]
    fn deleting_something_that_is_gone_says_so() {
        let dir = TempDir::new("deletegone");
        let path = dir.0.join("never-existed.md");

        let err = delete_at(&path).expect_err("nothing to delete");

        assert_eq!(err.code, INVALID_PARAMS);
        assert!(err.message.contains("no longer there"), "{}", err.message);
    }

    #[test]
    fn deleting_a_folder_takes_its_contents_and_says_it_was_a_folder() {
        let dir = TempDir::new("deletedir");
        let folder = dir.0.join("assets");
        std::fs::create_dir(&folder).expect("mkdir");
        std::fs::write(folder.join("logo.png"), "bytes").expect("write");

        let value = delete_at(&folder).expect("delete");

        assert_eq!(
            value["kind"], "dir",
            "the caller has to know it lost a tree"
        );
        assert!(!folder.exists());
    }

    /// The number the confirmation puts in front of the user before a recursive
    /// delete. Counts everything underneath, not just the direct children.
    #[test]
    fn tree_size_counts_the_whole_subtree() {
        let dir = TempDir::new("treesize");
        let root = dir.0.join("src");
        std::fs::create_dir_all(root.join("engine").join("render")).expect("mkdir");
        std::fs::write(root.join("main.rs"), "").expect("write");
        std::fs::write(root.join("engine").join("scene.rs"), "").expect("write");
        std::fs::write(root.join("engine").join("render").join("pass.rs"), "").expect("write");

        let value = tree_size_at(&root);

        assert_eq!(value["files"], 3, "every file, however deep");
        assert_eq!(value["dirs"], 2, "engine and engine/render");
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn tree_size_of_an_empty_folder_is_zero_rather_than_an_error() {
        let dir = TempDir::new("treeempty");
        let empty = dir.0.join("empty");
        std::fs::create_dir(&empty).expect("mkdir");

        let value = tree_size_at(&empty);

        assert_eq!(value["files"], 0);
        assert_eq!(value["dirs"], 0);
    }

    /// The bug this whole helper exists for. `join` would leave git's forward
    /// slashes in the middle of a Windows path, and the explorer — which
    /// compares these against `read_dir` output as plain strings — would then
    /// match nothing below the top level.
    #[test]
    fn a_git_path_takes_the_platform_separator() {
        let base = PathBuf::from("base");
        let (path, dir) = absolute(&base, "src/shell/foo.ts");

        assert!(!dir);
        assert_eq!(
            path,
            base.join("src")
                .join("shell")
                .join("foo.ts")
                .display()
                .to_string()
        );
        // The point of the assertion above, stated the other way round: no
        // separator from git survives into the result.
        assert!(!path.trim_start_matches("base").contains('/'));
    }

    /// An untracked or ignored directory. The slash is git saying "and
    /// everything under here", which the explorer needs as a flag rather than
    /// as a character on the end of a path no row has.
    #[test]
    fn a_trailing_slash_becomes_the_directory_flag() {
        let base = PathBuf::from("base");
        let (path, dir) = absolute(&base, "node_modules/");

        assert!(dir);
        assert_eq!(path, base.join("node_modules").display().to_string());
    }

    #[test]
    fn a_top_level_git_path_is_unchanged_by_any_of_this() {
        let base = PathBuf::from("base");
        let (path, dir) = absolute(&base, "Cargo.toml");

        assert!(!dir);
        assert_eq!(path, base.join("Cargo.toml").display().to_string());
    }

    #[test]
    fn a_path_param_is_required_where_there_is_no_default() {
        let err = required_path(Some(&json!({}))).expect_err("no path");
        assert_eq!(err.code, INVALID_PARAMS);

        // Null is a mistake here even though `resolve_path` accepts it: nothing
        // sensible happens when a write is told to fall back to the root.
        let err = required_path(Some(&json!({ "path": null }))).expect_err("null path");
        assert_eq!(err.code, INVALID_PARAMS);
    }
}
