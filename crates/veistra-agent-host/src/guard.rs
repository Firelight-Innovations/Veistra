//! Where an agent may work (handoff §0.5 and §3.4.3).
//!
//! Two checks, both here so the host enforces them itself rather than trusting
//! the orchestrator to have:
//!
//! - [`Worktree`] is the only way to name a working directory, and it can only
//!   be built from the root of a git checkout: a linked worktree, whose `.git`
//!   is a file, or a main checkout, whose `.git` is a directory. Agents used to
//!   be kept off main; they may work there now, as in any worktree.
//! - [`escapes`] answers a permission request: every path it reaches is
//!   resolved against the worktree, symlinks followed, and any that lands
//!   outside, or that names no path at all, is grounds to refuse it without
//!   asking the user.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// A git checkout's root, canonical: a linked worktree or a main checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    root: PathBuf,
}

/// Why a directory is not a [`Worktree`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotAWorktree {
    /// There is no such directory.
    #[error("{0} does not exist")]
    Missing(PathBuf),
    /// It has no `.git` at all.
    #[error("{0} is not a git worktree")]
    NotGit(PathBuf),
}

impl Worktree {
    /// `path`, if it is the root of a git checkout. A `.git` file is a linked
    /// worktree and a `.git` directory a main checkout; either will do.
    pub fn new(path: &Path) -> Result<Self, NotAWorktree> {
        let root = path
            .canonicalize()
            .map_err(|_| NotAWorktree::Missing(path.to_path_buf()))?;
        if !root.join(".git").exists() {
            return Err(NotAWorktree::NotGit(path.to_path_buf()));
        }
        Ok(Self { root })
    }

    /// The root, canonical.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The root as a person would write it: on Windows, without the `\\?\`
    /// that canonicalizing adds. This is what the agent is handed as its
    /// working directory — `cmd.exe`, which runs an npm shim, refuses a
    /// verbatim one and silently starts in `C:\Windows` instead.
    pub fn path(&self) -> PathBuf {
        plain(&self.root)
    }

    /// `path` resolved as [`Worktree::resolve`] does, written as
    /// [`Worktree::path`] writes the root.
    pub fn display(&self, path: &str) -> String {
        plain(&self.resolve(path)).to_string_lossy().into_owned()
    }

    /// `path` resolved against the root: the longest part that exists is
    /// canonicalized first, so a symlink inside the worktree that points out
    /// of it is seen for where it points, and only then are `.` and `..` in
    /// the rest folded. Folding first would let `link/..` cancel out on paper
    /// while the kernel follows `link`.
    pub fn resolve(&self, path: &str) -> PathBuf {
        // The root is canonical, so on Windows it is verbatim (`\\?\C:\...`),
        // and a verbatim path takes `/` as part of a name rather than a
        // separator: `src/../../x` would be one harmless-looking file name.
        let path = if cfg!(windows) {
            path.replace('/', "\\")
        } else {
            path.to_string()
        };
        resolve_physical(&self.root.join(path))
    }

    /// Whether `path` resolves inside the worktree.
    pub fn contains(&self, path: &str) -> bool {
        self.resolve(path).starts_with(&self.root)
    }
}

/// Every path a `session/request_permission` names: its tool call's
/// locations, the file fields of its raw input, and its diffs. Deduplicated,
/// in the order found.
pub fn request_paths(tool_call: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    let mut push = |p: &str| add(&mut paths, p);
    for location in array(tool_call, "locations") {
        if let Some(p) = location.get("path").and_then(Value::as_str) {
            push(p);
        }
    }
    if let Some(input) = tool_call.get("rawInput") {
        for key in ["file_path", "path", "notebook_path"] {
            if let Some(p) = input.get(key).and_then(Value::as_str) {
                push(p);
            }
        }
    }
    for block in array(tool_call, "content") {
        if block.get("type").and_then(Value::as_str) == Some("diff") {
            if let Some(p) = block.get("path").and_then(Value::as_str) {
                push(p);
            }
        }
    }
    paths
}

/// Everything a `session/request_permission` reaches, as the approval card
/// shows it: [`request_paths`], the folder a command would run in, and each
/// path, pattern and named scope of any extra sandbox access it asks for.
/// Paths and patterns are written as [`Worktree::display`] writes them. A
/// command that runs in the worktree itself, as one almost always does, adds
/// nothing; a grant of the whole worktree is still shown.
pub fn request_scope(worktree: &Worktree, tool_call: &Value) -> Vec<String> {
    let root = worktree.path().to_string_lossy().into_owned();
    let mut shown = Vec::new();
    for r in reach(tool_call) {
        let text = match r.checked {
            Some(_) => worktree.display(&r.shown),
            None => r.shown,
        };
        if !(r.cwd && text == root) {
            add(&mut shown, &text);
        }
    }
    shown
}

/// What the guard refuses in a `session/request_permission`: each part of
/// [`request_scope`] that resolves outside `worktree`, and each part it
/// cannot check at all.
pub fn escapes(worktree: &Worktree, tool_call: &Value) -> Vec<String> {
    let mut refused = Vec::new();
    for r in reach(tool_call) {
        if !r.checked.as_deref().is_some_and(|p| worktree.contains(p)) {
            add(&mut refused, &r.shown);
        }
    }
    refused
}

/// One part of what a request reaches: as the card shows it, the path the
/// guard checks for it, `None` when no path inside a worktree can stand for
/// it, and whether it is only the folder a command runs in.
struct Reach {
    shown: String,
    checked: Option<String>,
    cwd: bool,
}

/// Codex asks for sandbox access as a permission profile, with a command
/// (`additionalPermissions`) or on its own (`permissions`). An entry that
/// denies access grants nothing and is skipped. A glob pattern is checked by
/// the folder its literal start names. A named scope is checked only when it
/// is the project, which is the worktree a session runs in; the whole disk,
/// the temp folders, and any scope Codex adds later are refused.
///
/// Two parts are one only when both what is shown and what is checked match:
/// a named scope shown as `<root>` is never hidden behind a path of that name.
/// The command's folder comes last, so a grant of the same folder is kept.
fn reach(tool_call: &Value) -> Vec<Reach> {
    let mut out: Vec<Reach> = Vec::new();
    let mut push = |shown: String, checked: Option<String>, cwd: bool| {
        let seen = out.iter().any(|r| r.shown == shown && r.checked == checked);
        if !shown.is_empty() && !seen {
            out.push(Reach {
                shown,
                checked,
                cwd,
            });
        }
    };
    let input = tool_call.get("rawInput").unwrap_or(&Value::Null);
    for p in request_paths(tool_call) {
        push(p.clone(), Some(p), false);
    }
    for key in ["permissions", "additionalPermissions"] {
        let Some(files) = input.get(key).and_then(|p| p.get("fileSystem")) else {
            continue;
        };
        for access in ["read", "write"] {
            for p in array(files, access).filter_map(Value::as_str) {
                push(p.to_string(), Some(p.to_string()), false);
            }
        }
        for entry in array(files, "entries") {
            if entry.get("access").and_then(Value::as_str) == Some("deny") {
                continue;
            }
            let path = entry.get("path").unwrap_or(&Value::Null);
            let text = |key: &str| path.get(key).and_then(Value::as_str).unwrap_or_default();
            match path.get("type").and_then(Value::as_str) {
                Some("path") => push(
                    text("path").to_string(),
                    Some(text("path").to_string()),
                    false,
                ),
                Some("glob_pattern") => push(
                    text("pattern").to_string(),
                    glob_base(text("pattern")),
                    false,
                ),
                _ => {
                    let scope = path.get("value").unwrap_or(&Value::Null);
                    let kind = scope
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    if kind == "project_roots" {
                        let sub = scope
                            .get("subpath")
                            .and_then(Value::as_str)
                            .filter(|sub| !sub.is_empty())
                            .unwrap_or(".");
                        push(sub.to_string(), Some(sub.to_string()), false);
                    } else {
                        push(format!("<{kind}>"), None, false);
                    }
                }
            }
        }
    }
    if let Some(cwd) = input.get("cwd").and_then(Value::as_str) {
        push(cwd.to_string(), Some(cwd.to_string()), true);
    }
    out
}

/// The folder a glob pattern's literal start names, with a trailing separator
/// so that a bare drive (`C:`) is its root and not its current folder. `None`
/// when no folder bounds the pattern: it starts with a wildcard, which could
/// match anywhere, or with `~`, which Codex may read as the home folder, or it
/// could climb with `..` after a wildcard, as `{..,a}` does once expanded.
fn glob_base(pattern: &str) -> Option<String> {
    let wild = |part: &str| part.contains(['*', '?', '[', '{']);
    let parts: Vec<&str> = pattern.split(['/', '\\']).collect();
    let literal = parts.iter().take_while(|part| !wild(part)).count();
    match literal {
        _ if pattern.starts_with('~') => None,
        0 => None,
        n if n == parts.len() => Some(pattern.to_string()),
        n if parts[n..].iter().any(|part| part.contains("..")) => None,
        n => Some(format!("{}/", parts[..n].join("/"))),
    }
}

/// `p` added to `paths` unless it is empty or already there.
fn add(paths: &mut Vec<String>, p: &str) {
    if !p.is_empty() && !paths.iter().any(|seen| seen == p) {
        paths.push(p.to_string());
    }
}

fn array<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// `path` without a leading `\\?\`, unless what follows is a UNC share.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `.` and `..` removed without touching the disk. A `..` above the root is
/// kept as the root, which is outside any worktree.
fn fold(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The longest leading run of `path`'s components that exists, canonicalized,
/// with the rest folded onto it. What does not exist holds no symlink, so
/// folding it on paper is what the kernel would do.
fn resolve_physical(path: &Path) -> PathBuf {
    let components: Vec<Component> = path.components().collect();
    for k in (1..=components.len()).rev() {
        let prefix: PathBuf = components[..k].iter().collect();
        if let Ok(real) = prefix.canonicalize() {
            return fold(&real.join(components[k..].iter().collect::<PathBuf>()));
        }
    }
    fold(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A directory laid out as a linked worktree, and one beside it.
    fn layout() -> (tempfile::TempDir, Worktree) {
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("src")).unwrap();
        std::fs::write(tree.join(".git"), "gitdir: elsewhere\n").unwrap();
        std::fs::create_dir_all(dir.path().join("main/.git")).unwrap();
        let worktree = Worktree::new(&tree).unwrap();
        (dir, worktree)
    }

    /// A main checkout used to be refused here. Agents may work on main now,
    /// so it is accepted like a linked worktree; a folder that is not git at
    /// all, or does not exist, is still refused.
    #[test]
    fn a_main_checkout_is_accepted_and_a_plain_folder_is_not() {
        let (dir, _) = layout();
        let main = dir.path().join("main");
        let tree = Worktree::new(&main).expect("a main checkout is accepted");
        assert_eq!(tree.root(), main.canonicalize().unwrap());
        assert!(tree.contains("src/new.rs"));
        assert!(!tree.contains("../tree/src/x.rs"), "still confined to it");
        let plain = dir.path();
        assert!(matches!(Worktree::new(plain), Err(NotAWorktree::NotGit(_))));
        assert!(matches!(
            Worktree::new(&dir.path().join("nope")),
            Err(NotAWorktree::Missing(_))
        ));
    }

    #[test]
    fn paths_inside_are_allowed_and_paths_outside_are_not() {
        let (dir, tree) = layout();
        let root = tree.root().to_string_lossy().into_owned();
        assert!(tree.contains("src/new.rs"), "a new file inside");
        assert!(
            tree.contains(&format!("{root}/src/lib.rs")),
            "absolute inside"
        );
        assert!(!tree.contains("../main/README.md"), "a sibling checkout");
        assert!(!tree.contains("src/../../escape.txt"), "dot-dot out");
        assert!(
            !tree.contains("nope/../../escape.txt"),
            "dot-dot out through a folder that does not exist"
        );
        assert!(tree.contains("nope/../src/ok.rs"), "and back in again");
        let main = dir.path().join("main").join("file.txt");
        assert!(!tree.contains(&main.to_string_lossy()), "absolute outside");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_worktree_is_outside() {
        let (dir, tree) = layout();
        std::os::unix::fs::symlink(dir.path().join("main"), tree.root().join("link")).unwrap();
        assert!(!tree.contains("link/file.txt"));
    }

    /// `link/..` is `main`'s parent to the kernel, not the worktree root.
    #[cfg(unix)]
    #[test]
    fn dot_dot_after_a_symlink_follows_the_symlink() {
        let (dir, tree) = layout();
        std::fs::create_dir_all(dir.path().join("main/sub")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("main/sub"), tree.root().join("link")).unwrap();
        assert!(!tree.contains("link/../x.txt"));
    }

    /// A directory junction, which needs no privilege to make and is how a
    /// repository on Windows can point out of itself.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_worktree_is_outside() {
        let (dir, tree) = layout();
        junction(&tree.path().join("link"), &dir.path().join("main"));
        assert!(!tree.contains("link/file.txt"));
        assert!(!tree.contains("link\\file.txt"));
    }

    /// Unlike a Unix kernel, Win32 folds `..` out of a path before it reaches
    /// the file system, so `link/..` is the worktree again even when `link` is
    /// a junction. The write below shows where Windows puts it; the guard must
    /// agree.
    #[cfg(windows)]
    #[test]
    fn dot_dot_after_a_junction_folds_as_windows_folds_it() {
        let (dir, tree) = layout();
        std::fs::create_dir_all(dir.path().join("main/sub")).unwrap();
        junction(
            &tree.path().join("link"),
            &dir.path().join("main").join("sub"),
        );
        let through = format!("{}\\link\\..\\x.txt", dir.path().join("tree").display());
        std::fs::write(&through, "x").unwrap();
        assert!(dir.path().join("tree").join("x.txt").exists());
        assert!(!dir.path().join("main").join("x.txt").exists());
        assert!(tree.contains("link/../x.txt"), "the guard agrees");
        assert!(
            tree.contains("src/../x.txt"),
            "and a plain folder still folds"
        );
    }

    /// The root is verbatim (`\\?\C:\...`) on Windows, where `/` is part of a
    /// name rather than a separator, so each shape of absolute path has to
    /// land where the kernel would put it.
    #[cfg(windows)]
    #[test]
    fn windows_absolute_paths_resolve_as_the_kernel_would() {
        let (_dir, tree) = layout();
        let root = tree.root().to_string_lossy().into_owned();
        let plain = root.trim_start_matches(r"\\?\").to_string();
        assert!(
            tree.contains(&format!("{plain}\\src\\lib.rs")),
            "drive path"
        );
        assert!(tree.contains(&format!("{}/src/lib.rs", plain.replace('\\', "/"))));
        assert!(
            tree.contains(&format!("{root}\\src\\lib.rs")),
            "verbatim path"
        );
        assert!(
            !tree.contains("C:/Windows/System32/x.dll"),
            "another folder"
        );
        assert!(!tree.contains(r"C:\Windows\System32\x.dll"));
        assert!(
            !tree.contains(r"\\?\C:\Windows\x.dll"),
            "verbatim elsewhere"
        );
        // A loopback address, so checking it asks no name server anything.
        assert!(!tree.contains(r"\\127.0.0.1\share\x.txt"), "a share");
        assert!(
            !tree.contains(r"\\?\UNC\127.0.0.1\share\x.txt"),
            "a verbatim share"
        );
        assert!(
            !tree.contains(&format!("{plain}\\..\\x.txt")),
            "dot-dot out of a drive path"
        );
    }

    #[test]
    fn request_paths_come_from_locations_input_and_diffs() {
        let call = json!({
            "locations": [{"path": "/w/a.rs"}, {"path": "/w/a.rs"}],
            "rawInput": {"file_path": "/w/b.rs", "command": "ls"},
            "content": [
                {"type": "diff", "path": "/w/c.rs", "newText": "x"},
                {"type": "content", "content": {"type": "text", "text": "hi"}}
            ]
        });
        assert_eq!(request_paths(&call), vec!["/w/a.rs", "/w/b.rs", "/w/c.rs"]);
        assert!(request_paths(&json!({"rawInput": {"command": "ls"}})).is_empty());
    }

    #[test]
    fn a_codex_command_is_checked_where_it_runs_and_for_what_it_asks() {
        let (_dir, tree) = layout();
        let call = json!({
            "locations": [{"path": "src/a.rs"}],
            "rawInput": {
                "command": "cargo build",
                "cwd": tree.path(),
                "additionalPermissions": {"fileSystem": {
                    "write": ["target"],
                    "entries": [
                        {"access": "write", "path": {"type": "path", "path": "out"}},
                        {"access": "read", "path": {"type": "glob_pattern", "pattern": "../**"}},
                        {"access": "write", "path": {"type": "special", "value": {"kind": "root"}}}
                    ]
                }}
            }
        });
        assert_eq!(request_paths(&call), vec!["src/a.rs"]);
        let shown = ["src/a.rs", "target", "out", "../**"].map(|p| tree.display(p));
        let mut shown = shown.to_vec();
        shown.push("<root>".to_string());
        assert_eq!(
            request_scope(&tree, &call),
            shown,
            "the worktree itself is left out"
        );
        assert_eq!(escapes(&tree, &call), vec!["../**", "<root>"]);
    }

    #[test]
    fn a_codex_sandbox_request_is_checked_for_each_path_it_grants() {
        let (_dir, tree) = layout();
        let call = json!({
            "rawInput": {
                "cwd": "src",
                "permissions": {"fileSystem": {"read": ["src/lib.rs"], "entries": [
                    {"access": "write", "path": {"type": "glob_pattern", "pattern": "../**"}}
                ]}}
            }
        });
        assert_eq!(escapes(&tree, &call), vec!["../**".to_string()]);
    }

    #[test]
    fn a_named_scope_is_refused_unless_it_is_the_project() {
        let (_dir, tree) = layout();
        let scope = |value: Value| {
            json!({"rawInput": {"permissions": {"fileSystem": {"entries": [
                {"access": "write", "path": {"type": "special", "value": value}}
            ]}}}})
        };
        for kind in [
            "root",
            "minimal",
            "tmpdir",
            "slash_tmp",
            "unknown",
            "added_later",
        ] {
            let call = scope(json!({"kind": kind}));
            assert_eq!(escapes(&tree, &call), vec![format!("<{kind}>")], "{kind}");
        }
        assert_eq!(escapes(&tree, &scope(json!(null))), vec!["<unknown>"]);
        let project = scope(json!({"kind": "project_roots", "subpath": null}));
        assert!(escapes(&tree, &project).is_empty());
        let sub = scope(json!({"kind": "project_roots", "subpath": "src"}));
        assert!(escapes(&tree, &sub).is_empty());
    }

    #[test]
    fn a_named_scope_is_not_hidden_behind_a_path_of_the_same_name() {
        let (_dir, tree) = layout();
        let call = json!({"rawInput": {"permissions": {"fileSystem": {"entries": [
            {"access": "write", "path": {"type": "special",
                "value": {"kind": "project_roots", "subpath": "<root>"}}},
            {"access": "write", "path": {"type": "path", "path": "<root>"}},
            {"access": "write", "path": {"type": "special", "value": {"kind": "root"}}}
        ]}}}});
        assert_eq!(escapes(&tree, &call), vec!["<root>"]);
    }

    #[test]
    fn a_grant_of_the_whole_worktree_is_shown_but_where_a_command_runs_is_not() {
        let (_dir, tree) = layout();
        let run = json!({"rawInput": {"command": "cargo build", "cwd": tree.path()}});
        assert!(request_scope(&tree, &run).is_empty());
        let grant = json!({"rawInput": {"command": "cargo build", "cwd": tree.path(),
        "additionalPermissions": {"fileSystem": {"entries": [
            {"access": "write", "path": {"type": "special",
                "value": {"kind": "project_roots"}}}
        ]}}}});
        assert_eq!(request_scope(&tree, &grant), vec![tree.display(".")]);
        assert!(escapes(&tree, &grant).is_empty());
        let empty = json!({"rawInput": {"permissions": {"fileSystem": {"entries": [
            {"access": "write", "path": {"type": "special",
                "value": {"kind": "project_roots", "subpath": ""}}}
        ]}}}});
        assert_eq!(request_scope(&tree, &empty), vec![tree.display(".")]);
    }

    #[test]
    fn a_glob_is_checked_by_the_folder_its_literal_start_names() {
        let (_dir, tree) = layout();
        let root = tree.path().to_string_lossy().replace('\\', "/");
        let glob = |pattern: &str| {
            json!({"rawInput": {"permissions": {"fileSystem": {"entries": [
                {"access": "write", "path": {"type": "glob_pattern", "pattern": pattern}}
            ]}}}})
        };
        for inside in ["src/**", "src/*/x.rs", &format!("{root}/**")] {
            assert!(escapes(&tree, &glob(inside)).is_empty(), "{inside}");
        }
        let mut globs = vec!["/**", "../**", "**/x", "{/etc,src}/**", "?:/Windows/**"];
        globs.extend(["src/*/../../x", "src/{..,a}/{..,b}/x", "~/**", "~/.ssh/*"]);
        if cfg!(windows) {
            globs.push("C:/**");
        }
        for outside in globs {
            assert_eq!(escapes(&tree, &glob(outside)), vec![outside], "{outside}");
        }
    }

    #[test]
    fn an_entry_that_denies_access_grants_nothing() {
        let (_dir, tree) = layout();
        let call = json!({"rawInput": {"permissions": {"fileSystem": {"entries": [
            {"access": "deny", "path": {"type": "glob_pattern", "pattern": "/**/.env"}},
            {"access": "deny", "path": {"type": "special", "value": {"kind": "root"}}}
        ]}}}});
        assert!(escapes(&tree, &call).is_empty());
        assert!(request_scope(&tree, &call).is_empty());
    }

    #[test]
    fn escapes_lists_only_what_is_outside() {
        let (_dir, tree) = layout();
        let call = json!({"locations": [{"path": "src/ok.rs"}, {"path": "../escape.rs"}]});
        assert_eq!(escapes(&tree, &call), vec!["../escape.rs".to_string()]);
    }
}
