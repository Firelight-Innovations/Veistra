//! The methods an agent can name in `veistra-agent`'s `app_call`, for the MCP panel.
//!
//! No app declares its methods as data: each `call` is a `match` on a string,
//! and none has a parameter schema. So there is nothing to read at runtime and
//! this module reads the one place the names are written down, the apps' own
//! source, at compile time via `include_str!`. Names come from the `match` arms
//! and `method ==` checks; the description comes from the handler's doc comment
//! when it opens with the method in backticks, and is `None` otherwise.
//!
//! **No parameter signatures are produced, because none exist.** The panel says
//! so rather than inventing one. When an app grows a real schema, it joins
//! [`AppMethod`] as a field and the panel starts drawing it.
//!
//! The scan is held to account by `every_dispatched_method_is_found`, which
//! compares it against names that must exist, and by `is_write_method`, which is
//! the authoritative write list and is used as-is.

use serde::Serialize;

/// One method an app answers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppMethod {
    pub method: String,
    /// From `apps::WRITE_METHODS`, the list the read-only-main guard uses.
    pub write: bool,
    /// The handler's doc comment, when it opens with this method's name.
    pub doc: Option<String>,
    /// Why `app_call` refuses it, when it does. Filled in by the MCP layer.
    pub blocked: Option<String>,
}

/// The methods under one prefix, which is what a caller writes before the `/`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppMethodGroup {
    pub app: String,
    pub name: String,
    pub methods: Vec<AppMethod>,
}

/// Prefix, display name, and the source files whose `match` arms answer it.
/// The `viewer` app shares `files::call`, so its methods are `files/*`.
const GROUPS: &[(&str, &str)] = &[
    ("home", "Home"),
    ("files", "File Explorer and File Viewer"),
    ("trash", "Trash"),
    ("canvas", "Design"),
    ("godot-viewer", "Godot, Editor mode"),
    ("godot", "Godot, both modes"),
    ("blender-viewer", "Blender Viewer"),
    ("play", "Godot, Play mode"),
    ("agent-tab", "Agent"),
    ("agents", "Agents"),
    ("costs", "Cost Tracker"),
    ("account", "Account (Home and Usage)"),
    ("projects", "Projects"),
    ("tutorial", "Tutorials"),
    ("comments", "Comments (shared by the viewers)"),
    ("context", "Context store (every app)"),
    ("refs", "References (every app)"),
    #[cfg(feature = "schematify")]
    ("schematify", "Schematify"),
    #[cfg(feature = "design-mode")]
    ("design", "Design Mode"),
];

fn sources() -> Vec<&'static str> {
    #[allow(unused_mut)] // Pushed to only when a feature is on.
    let mut all = vec![
        include_str!("home.rs"),
        include_str!("files.rs"),
        include_str!("trash.rs"),
        include_str!("canvas/mod.rs"),
        include_str!("blender_viewer.rs"),
        include_str!("agent_tab.rs"),
        include_str!("agents.rs"),
        include_str!("costs.rs"),
        include_str!("../account/methods.rs"),
        include_str!("projects.rs"),
        include_str!("tutorial.rs"),
        include_str!("../godot/rpc.rs"),
        // Play mode's box, takes and notes, which `godot::rpc::play` hands on.
        include_str!("../godot/live.rs"),
        include_str!("../comments.rs"),
        include_str!("../context.rs"),
        include_str!("../context_commands.rs"),
        include_str!("../refs/mod.rs"),
    ];
    #[cfg(feature = "schematify")]
    all.push(include_str!("schematify.rs"));
    #[cfg(feature = "design-mode")]
    all.push(include_str!("design.rs"));
    all
}

/// The lines before the test module, which names methods it only calls.
///
/// Stops at `#[cfg(test)]` directly above a `mod`, not at the first one: a
/// file may gate a single item for tests long before its test module.
fn production(source: &str) -> Vec<&str> {
    let mut kept = Vec::new();
    let mut gated = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if gated && trimmed.starts_with("mod ") {
            kept.pop();
            break;
        }
        gated = trimmed == "#[cfg(test)]";
        kept.push(line);
    }
    kept
}

/// The method names on one line, if it is a `match` arm or a `method ==` test.
fn names_on(line: &str) -> Vec<&str> {
    let trimmed = line.trim_start();
    if let Some(at) = trimmed.find("method == \"") {
        let rest = &trimmed[at + "method == \"".len()..];
        return rest
            .find('"')
            .map(|end| vec![&rest[..end]])
            .unwrap_or_default();
    }

    let mut found = Vec::new();
    let mut rest = trimmed;
    while let Some(quoted) = rest.strip_prefix('"') {
        let Some(end) = quoted.find('"') else {
            return Vec::new();
        };
        found.push(&quoted[..end]);
        rest = quoted[end + 1..].trim_start();
        if let Some(more) = rest.strip_prefix('|') {
            rest = more.trim_start();
        } else {
            break;
        }
    }
    if rest.starts_with("=>") {
        found
    } else {
        Vec::new()
    }
}

/// The doc comment that opens with `` `method` ``, minus that prefix, as one
/// paragraph.
fn doc_for(sources: &[&str], method: &str) -> Option<String> {
    let opener = format!("/// `{method}`");
    for source in sources {
        let lines = production(source);
        let Some(start) = lines
            .iter()
            .position(|l| l.trim_start().starts_with(&opener))
        else {
            continue;
        };
        let mut words = Vec::new();
        for (i, line) in lines[start..].iter().enumerate() {
            let Some(text) = line.trim_start().strip_prefix("///") else {
                break;
            };
            let text = if i == 0 {
                text.trim_start().strip_prefix(&opener[4..]).unwrap_or(text)
            } else {
                text
            };
            if text.trim().is_empty() {
                break;
            }
            words.push(
                text.trim()
                    .trim_start_matches(['.', ',', ':'])
                    .trim()
                    .to_string(),
            );
        }
        let joined = words.join(" ").trim().to_string();
        return (!joined.is_empty()).then_some(joined);
    }
    None
}

/// Every method each app answers, grouped by prefix, in `GROUPS` order.
pub fn catalog() -> Vec<AppMethodGroup> {
    let sources = sources();
    let mut groups: Vec<AppMethodGroup> = GROUPS
        .iter()
        .map(|(app, name)| AppMethodGroup {
            app: (*app).to_string(),
            name: (*name).to_string(),
            methods: Vec::new(),
        })
        .collect();

    for source in &sources {
        for line in production(source) {
            for name in names_on(line) {
                let Some((prefix, rest)) = name.split_once('/') else {
                    continue;
                };
                let shaped = !rest.is_empty()
                    && rest
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
                let Some(group) = groups.iter_mut().find(|g| g.app == prefix) else {
                    continue;
                };
                if shaped && !group.methods.iter().any(|m| m.method == name) {
                    group.methods.push(AppMethod {
                        method: name.to_string(),
                        write: super::is_write_method(name),
                        doc: doc_for(&sources, name),
                        blocked: None,
                    });
                }
            }
        }
    }

    groups.retain(|g| !g.methods.is_empty());
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<AppMethod> {
        catalog().into_iter().flat_map(|g| g.methods).collect()
    }

    #[test]
    fn every_dispatched_method_is_found() {
        let found: Vec<String> = all().into_iter().map(|m| m.method).collect();
        for expected in [
            "home/state",
            "files/read",
            "files/write",
            "canvas/list-diagrams",
            "canvas/create",
            "trash/purge",
            "play/run",
            "play/record",
            "play/send",
            "godot/status",
            "godot-viewer/state",
            "blender-viewer/export-start",
            "comments/create",
            "context/put",
            "context/insert",
            "context/agents",
            "refs/resolve",
            "refs/search",
            "refs/prompt",
            "agent-tab/harnesses",
            "agent-tab/send",
        ] {
            assert!(found.iter().any(|m| m == expected), "{expected} missing");
        }
        // A mime type in a `match` is not a method.
        assert!(!found.iter().any(|m| m.starts_with("image/")));
        for host in ["refs/resolve", "refs/search", "refs/prompt"] {
            let method = all().into_iter().find(|m| m.method == host);
            assert!(
                method.and_then(|m| m.doc).is_some(),
                "the host's own methods are documented too: {host}"
            );
        }
    }

    #[test]
    fn a_method_is_listed_once() {
        let found = all();
        let mut names: Vec<&str> = found.iter().map(|m| m.method.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len());
    }

    /// The write flag is the guard's own list, not a second opinion.
    #[test]
    fn write_methods_are_the_guards_list() {
        for m in all() {
            assert_eq!(
                m.write,
                super::super::is_write_method(&m.method),
                "{}",
                m.method
            );
        }
        let write = all()
            .into_iter()
            .find(|m| m.method == "files/write")
            .unwrap();
        assert!(write.write);
        let read = all()
            .into_iter()
            .find(|m| m.method == "files/read")
            .unwrap();
        assert!(!read.write);
    }

    #[test]
    fn names_are_read_from_arms_alternations_and_equality_checks() {
        assert_eq!(names_on("    \"a/b\" => go(),"), vec!["a/b"]);
        assert_eq!(names_on("\"a/b\" | \"a/c\" => go(),"), vec!["a/b", "a/c"]);
        assert_eq!(names_on("if method == \"x/y\" {"), vec!["x/y"]);
        assert!(names_on("let s = \"a/b\";").is_empty());
        assert!(names_on("\"image/png\" => \"png\",").len() == 1);
    }

    #[test]
    fn a_doc_comment_opening_with_the_method_becomes_its_description() {
        let source = "/// `x/y`. Does a thing\n/// over two lines.\n///\n/// More.\nfn f() {}";
        assert_eq!(
            doc_for(&[source], "x/y").as_deref(),
            Some("Does a thing over two lines.")
        );
        assert_eq!(doc_for(&[source], "x/z"), None);
    }
}
