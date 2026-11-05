//! Taking over the config directory a superseded identifier left behind.
//!
//! `app_config_dir()` appends the bundle identifier, so moving the identifier
//! moves the directory and every store in it goes from "the user's settings" to
//! "a folder nothing will ever open again". [`run`] is the one thing that
//! notices, at the start of the next launch: it walks
//! [`super::identity::SUPERSEDED`], newest first, and **moves** the first
//! directory it finds onto the current one.
//!
//! Move rather than copy, and that is not tidiness. The NSIS uninstaller's
//! "Delete the application data" checkbox removes `$APPDATA\<current
//! identifier>` only, so a copied-from directory would survive an uninstall the
//! user explicitly asked to take their data with it.
//!
//! Everything here is quiet on failure, on the rule every store follows: the
//! worst honest outcome is the empty directory the user would have had anyway,
//! and a launch that refuses to start is worse than one that starts without
//! last week's window layout.

use super::identity::{IDENTIFIER, SUPERSEDED};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Left in the adopted directory, naming what was taken and when.
///
/// The reason a second launch does not try again. Without it, a user who
/// adopted a directory and then deleted a file out of it would be handed the
/// superseded copy back on the next launch — which is the app overruling a
/// deliberate act.
const MARKER: &str = "adopted-from.json";

/// Files whose presence means "somebody has used this directory".
///
/// `mcp-endpoint.json` is deliberately not here even though it lives beside
/// them. `mcp::handoff` rewrites it at every launch, so it appears in a
/// directory nobody has ever changed a setting in, and counting it would make
/// adoption a first-launch-only act rather than a first-launch-*after-a-rename*
/// one. The `plugins/` directory is not here for the same reason inverted: it
/// is only ever created by an install, so it is covered by `plugins.json`.
const IN_USE: &[&str] = &[
    "layout.json",
    "projects.json",
    "settings.json",
    "presets.json",
    "plugins.json",
    "mcp.json",
];

/// Adopt a superseded config directory, if there is one and this one is unused.
///
/// Called from `lib.rs`'s setup **before `settings::seed`** — earlier than
/// anything that reads a store, because a store that has already answered
/// "nothing here" has already told a window the wrong thing.
///
/// Safe to call twice: the marker it writes is checked first.
pub fn run(app: &AppHandle) {
    let Ok(current) = app.path().app_config_dir() else {
        return;
    };

    if !derived_from_the_identifier(&current) {
        // Everything here — and the whole argument in `docs/dev/user-data.md`
        // for keeping `app_config_dir()` rather than owning a path — rests on
        // Tauri appending the identifier to `%APPDATA%`. That is a rule in
        // somebody else's crate, so the one honest thing to do is notice out
        // loud if it ever stops holding, instead of adopting a directory
        // beside the one being read.
        crate::veistra_log!(
            "{} is not named for {IDENTIFIER}; not adopting anything",
            current.display()
        );
        return;
    }

    let candidates: Vec<PathBuf> = SUPERSEDED
        .iter()
        .filter_map(|id| sibling(&current, id))
        .collect();

    let Some(adopted) = adopt(&current, &candidates) else {
        return;
    };

    crate::veistra_log!(
        "adopted the config directory of {} into {}",
        adopted.display(),
        current.display()
    );

    // The token cannot be moved with the files: `keyring::Entry` has no rename,
    // and the service name it hangs off is a hand-written copy of the
    // identifier rather than something derived from the path above.
    if let Some(id) = adopted.file_name().and_then(|n| n.to_str()) {
        crate::plugins::install::adopt_token(id);
    }
}

/// Whether the config directory is the one [`IDENTIFIER`] names.
///
/// The agent build overrides the identifier with a `.agent` suffix, and that
/// instance has its own directory on purpose — so it is accepted rather than
/// warned about. See `ui:build` in `package.json` and CLAUDE.md.
fn derived_from_the_identifier(current: &Path) -> bool {
    current
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| name == IDENTIFIER || name.starts_with(&format!("{IDENTIFIER}.")))
}

/// The same parent as `current`, named for a superseded identifier.
///
/// Derived from the current directory rather than rebuilt from `%APPDATA%`, so
/// this holds on the two platforms where `app_config_dir()` answers something
/// else. Returns `None` for a candidate that would resolve to `current` itself.
fn sibling(current: &Path, identifier: &str) -> Option<PathBuf> {
    let candidate = current.parent()?.join(identifier);
    (candidate != current).then_some(candidate)
}

/// Move the first candidate that exists into `current`, and mark it.
///
/// Returns the directory that was adopted, or `None` when there was nothing to
/// do — which is the ordinary case on every machine that never had an older
/// build. Separate from [`run`] and taking paths rather than an `AppHandle`
/// precisely so the four rules below are testable without a running app.
fn adopt(current: &Path, candidates: &[PathBuf]) -> Option<PathBuf> {
    if current.join(MARKER).exists() || in_use(current) {
        return None;
    }

    let from = candidates.iter().find(|c| c.is_dir())?;
    if !in_use(from) {
        // A directory left behind by a build nobody changed anything in. Moving
        // it would achieve nothing and would still write a marker, which then
        // stops a *later* candidate from ever being looked at.
        return None;
    }

    move_into(from, current).ok()?;
    mark(current, from);
    Some(from.clone())
}

/// Whether a directory holds anything a person produced. See [`IN_USE`].
fn in_use(dir: &Path) -> bool {
    IN_USE.iter().any(|name| dir.join(name).exists())
}

/// Move every entry of `from` into `to`, then remove `from` if it emptied.
///
/// Entry by entry rather than one `rename` of the directory, because `to`
/// normally already exists — Tauri creates it, and so does anything that asked
/// for a path under it — and `rename` onto an existing directory fails on both
/// Windows and Unix. An entry that will not move is left where it is and the
/// rest still arrive; a half-adopted directory is worth more than none of it.
fn move_into(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;

    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if target.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(entry.path(), &target) {
            crate::veistra_log!("could not adopt {}: {e}", entry.path().display());
        }
    }

    // `remove_dir` refuses a directory that still has something in it, which is
    // exactly the behaviour wanted: whatever failed to move above stays where a
    // person can find it.
    let _ = std::fs::remove_dir(from);
    Ok(())
}

/// Write the marker. A failure here is logged and otherwise ignored — the files
/// have already moved, and refusing to record that would not put them back.
fn mark(current: &Path, from: &Path) {
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let json = format!("{{\n  \"identifier\": \"{name}\",\n  \"at\": {at}\n}}\n");

    if let Err(e) = std::fs::write(current.join(MARKER), json) {
        crate::veistra_log!("adopted {name} but could not record it: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory pair under the temp directory, named for the calling test so
    /// two of them never share one. The tests below are the four rules in
    /// `adopt`'s doc, one each.
    fn scratch(tag: &str) -> PathBuf {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("veistra-adopt-{tag}-{at}"));
        std::fs::create_dir_all(&dir).expect("the temp directory is writable");
        dir
    }

    fn used(dir: &Path, contents: &str) {
        std::fs::create_dir_all(dir).expect("creates");
        std::fs::write(dir.join("settings.json"), contents).expect("writes");
    }

    #[test]
    fn a_superseded_directory_is_moved_and_marked() {
        let root = scratch("moved");
        let current = root.join("com.example.new");
        let old = root.join("com.example.old");
        used(&old, r#"{"values":{"a":1}}"#);

        let adopted = adopt(&current, std::slice::from_ref(&old)).expect("adopts");

        assert_eq!(adopted, old);
        assert_eq!(
            std::fs::read_to_string(current.join("settings.json")).expect("moved"),
            r#"{"values":{"a":1}}"#
        );
        assert!(!old.exists(), "the source is moved, not copied");
        assert!(current.join(MARKER).exists(), "and the act is on disk");
    }

    /// The rule this whole module is most dangerous without. A directory with a
    /// store in it belongs to somebody who has already used this build, and
    /// moving an older one over it is the data loss adoption exists to prevent.
    #[test]
    fn adoption_is_skipped_when_the_current_directory_has_files() {
        let root = scratch("in-use");
        let current = root.join("com.example.new");
        let old = root.join("com.example.old");
        used(&current, r#"{"values":{"new":true}}"#);
        used(&old, r#"{"values":{"old":true}}"#);

        assert!(adopt(&current, std::slice::from_ref(&old)).is_none());
        assert_eq!(
            std::fs::read_to_string(current.join("settings.json")).expect("untouched"),
            r#"{"values":{"new":true}}"#
        );
        assert!(old.exists(), "and the older one is left where it was");
    }

    #[test]
    fn a_missing_superseded_directory_is_not_an_error() {
        let root = scratch("missing");
        let current = root.join("com.example.new");
        assert!(adopt(&current, &[root.join("com.example.never-existed")]).is_none());
        assert!(!current.join(MARKER).exists(), "and nothing is marked");
    }

    /// Newest first is the order `SUPERSEDED` is declared in, and it is the
    /// whole contract on a machine that has been through two renames: the
    /// newest orphan is the one holding what the user last worked in.
    #[test]
    fn the_newest_superseded_identifier_wins() {
        let root = scratch("newest");
        let current = root.join("com.example.new");
        let newer = root.join("com.example.newer");
        let older = root.join("com.example.older");
        used(&newer, r#"{"values":{"which":"newer"}}"#);
        used(&older, r#"{"values":{"which":"older"}}"#);

        assert_eq!(
            adopt(&current, &[newer.clone(), older.clone()]),
            Some(newer)
        );
        assert!(older.exists(), "the older one is not touched");
    }

    #[test]
    fn a_second_launch_does_not_adopt_again() {
        let root = scratch("once");
        let current = root.join("com.example.new");
        let old = root.join("com.example.old");
        used(&old, r#"{"values":{}}"#);

        assert!(adopt(&current, std::slice::from_ref(&old)).is_some());

        // What a person who adopted and then cleared their settings looks like.
        std::fs::remove_file(current.join("settings.json")).expect("removes");
        used(&old, r#"{"values":{}}"#);

        assert!(
            adopt(&current, std::slice::from_ref(&old)).is_none(),
            "the marker is what stops a deliberate deletion being undone"
        );
    }

    /// An empty orphan is not worth adopting, and adopting it would write the
    /// marker that stops the *next* candidate ever being looked at.
    #[test]
    fn an_unused_superseded_directory_is_passed_over() {
        let root = scratch("empty");
        let current = root.join("com.example.new");
        let empty = root.join("com.example.empty");
        std::fs::create_dir_all(&empty).expect("creates");

        assert!(adopt(&current, &[empty]).is_none());
        assert!(!current.join(MARKER).exists());
    }

    /// The one assumption this module cannot check any other way: that
    /// `app_config_dir()` still ends in the identifier. The agent build's
    /// suffixed directory is the deliberate exception.
    #[test]
    fn a_config_directory_not_named_for_the_identifier_is_noticed() {
        let parent = scratch("derivation");
        assert!(derived_from_the_identifier(&parent.join(IDENTIFIER)));
        assert!(derived_from_the_identifier(
            &parent.join(format!("{IDENTIFIER}.agent"))
        ));
        assert!(!derived_from_the_identifier(&parent.join("Veistra")));
        assert!(!derived_from_the_identifier(
            &parent.join("com.example.other")
        ));
    }

    /// Adoption must never move a directory onto itself, which is what a
    /// `SUPERSEDED` entry equal to the current identifier would ask for.
    #[test]
    fn a_candidate_equal_to_the_current_directory_is_not_offered() {
        let parent = scratch("sibling");
        let current = parent.join("com.example.same");

        assert_eq!(sibling(&current, "com.example.same"), None);
        assert_eq!(
            sibling(&current, "com.example.other"),
            Some(parent.join("com.example.other"))
        );
    }
}
