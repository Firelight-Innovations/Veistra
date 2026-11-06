//! The Veistra editor plugin: what it is, how it is installed and removed.
//!
//! **Opt-in and removable,** like the capture addon ([`super::addon`]) it sits
//! beside. Enabling writes four files into `addons/veistra/` (`plugin.cfg`,
//! `veistra_editor.gd`, the Veistra dock's `veistra_dock.gd`, #320, and the
//! right-click menus' `veistra_menu.gd`) and one entry into
//! `project.godot`'s `[editor_plugins]` list; disabling deletes
//! exactly those, plus the `.uid` file Godot 4.4 and later writes beside each
//! script. The capture addon's script and autoload line are left alone either
//! way.
//!
//! **Only while no editor holds the project.** The editor keeps its own copy
//! of `project.godot` and writes it back on its own saves, so a change made
//! under a running editor would be lost or would fight it. The methods that
//! call [`install`] and [`remove`] refuse while Veistra's editor for the
//! project runs (DECISIONS X5).
//!
//! The channel is the capture addon's: `cmd.json` in, `res-<id>.json` out, in a
//! temp folder the editor is told about with `--veistra-editor-dir=<folder>`
//! and `VEISTRA_EDITOR_DIR`. [`super::editor`] speaks it.

use super::addon::{self, Installed};
use std::path::{Path, PathBuf};

pub const SCRIPT: &str = include_str!("veistra_editor.gd");
pub const CONFIG: &str = include_str!("veistra_plugin.cfg");
pub const DOCK: &str = include_str!("veistra_dock.gd");
pub const MENU: &str = include_str!("veistra_menu.gd");

/// What each script's first line says it is, so an older copy reads as
/// partial. v2 is the first with the dock (#320); v3, with dock v2 and the
/// menus, the first with Mention in agent; v4, the first that can quit
/// without its prompt, for a cluster closed with Close.
const VERSION_MARKER: &str = "# veistra-editor v4";
const DOCK_MARKER: &str = "# veistra-dock v2";
const MENU_MARKER: &str = "# veistra-menu v1";
const SECTION: &str = "[editor_plugins]";
const KEY: &str = "enabled=";
const ENTRY: &str = "res://addons/veistra/plugin.cfg";

/// The oldest Godot the plugin runs on: `EditorInterface` became a singleton,
/// with its 3D viewports, in 4.2.
pub const MIN_MINOR: u32 = 2;

fn folder(project: &Path) -> PathBuf {
    project.join("addons").join("veistra")
}

pub fn script_path(project: &Path) -> PathBuf {
    folder(project).join("veistra_editor.gd")
}

fn dock_path(project: &Path) -> PathBuf {
    folder(project).join("veistra_dock.gd")
}

fn menu_path(project: &Path) -> PathBuf {
    folder(project).join("veistra_menu.gd")
}

fn config_path(project: &Path) -> PathBuf {
    folder(project).join("plugin.cfg")
}

/// The paths a `PackedStringArray("a", "b")` value lists, in order.
fn entries(line: &str) -> Vec<String> {
    let value = line.trim_start_matches(KEY);
    value
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

fn enabled_line(entries: &[String]) -> String {
    let quoted: Vec<String> = entries.iter().map(|e| format!("\"{e}\"")).collect();
    format!("{KEY}PackedStringArray({})", quoted.join(", "))
}

fn is_enabled(project_file: &str) -> bool {
    addon::section_line(project_file, SECTION, KEY)
        .is_some_and(|line| entries(line).iter().any(|e| e == ENTRY))
}

pub fn status(project: &Path) -> Installed {
    let script = std::fs::read_to_string(script_path(project)).ok();
    let config = config_path(project).is_file();
    let project_file = std::fs::read_to_string(project.join("project.godot")).unwrap_or_default();
    let enabled = is_enabled(&project_file);
    let dock = std::fs::read_to_string(dock_path(project)).ok();
    let menu = std::fs::read_to_string(menu_path(project)).ok();
    let current = script
        .as_deref()
        .is_some_and(|s| s.starts_with(VERSION_MARKER))
        && dock.as_deref().is_some_and(|s| s.starts_with(DOCK_MARKER))
        && menu.as_deref().is_some_and(|s| s.starts_with(MENU_MARKER));
    match (
        script.is_some() || dock.is_some() || menu.is_some() || config,
        enabled,
    ) {
        (false, false) => Installed::No,
        (true, true) if current && config => Installed::Yes,
        _ => Installed::Partial,
    }
}

/// `project.godot` with the plugin in its `[editor_plugins]` list, beside any
/// plugin already there. Line endings are kept.
pub fn with_plugin(text: &str) -> String {
    match addon::section_line(text, SECTION, KEY) {
        Some(line) => {
            let mut list = entries(line);
            if list.iter().any(|e| e == ENTRY) {
                return text.to_string();
            }
            list.push(ENTRY.to_string());
            replace_line(text, line, &enabled_line(&list))
        }
        None => addon::with_line(text, SECTION, &enabled_line(&[ENTRY.to_string()])),
    }
}

/// The inverse of [`with_plugin`]: the entry goes, the line with it when the
/// list is then empty, and the section when that leaves it empty.
pub fn without_plugin(text: &str) -> String {
    let Some(line) = addon::section_line(text, SECTION, KEY) else {
        return text.to_string();
    };
    let list: Vec<String> = entries(line).into_iter().filter(|e| e != ENTRY).collect();
    if list.len() == entries(line).len() {
        return text.to_string();
    }
    if list.is_empty() {
        return addon::without_line(text, SECTION, KEY);
    }
    replace_line(text, line, &enabled_line(&list))
}

/// `text` with its one line that trims to `old` replaced, indentation kept.
fn replace_line(text: &str, old: &str, new: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    text.split(nl)
        .map(|l| {
            if l.trim() == old {
                l.replace(old, new)
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(nl)
}

/// Write the four files and enable the plugin. Idempotent: an installed project
/// gets fresh copies of the files and its `project.godot` is left alone.
pub fn install(project: &Path) -> Result<(), String> {
    let project_file_path = project.join("project.godot");
    let text = std::fs::read_to_string(&project_file_path)
        .map_err(|e| format!("could not read {}: {e}", project_file_path.display()))?;
    let dir = folder(project);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    for (path, body) in [
        (config_path(project), CONFIG),
        (dock_path(project), DOCK),
        (menu_path(project), MENU),
        (script_path(project), SCRIPT),
    ] {
        std::fs::write(&path, body)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    if !is_enabled(&text) {
        std::fs::write(&project_file_path, with_plugin(&text))
            .map_err(|e| format!("could not update {}: {e}", project_file_path.display()))?;
    }
    Ok(())
}

/// Delete what [`install`] wrote. `addons/veistra` goes only if it is then
/// empty, so the capture addon, or anything else someone put there, stays.
pub fn remove(project: &Path) -> Result<(), String> {
    let config = config_path(project);
    if config.exists() {
        std::fs::remove_file(&config)
            .map_err(|e| format!("could not delete {}: {e}", config.display()))?;
    }
    addon::remove_script(&dock_path(project))?;
    addon::remove_script(&menu_path(project))?;
    addon::remove_script(&script_path(project))?;
    let path = project.join("project.godot");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if is_enabled(&text) {
        std::fs::write(&path, without_plugin(&text))
            .map_err(|e| format!("could not update {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Why this engine cannot run the plugin, or `None` when it can.
pub fn too_old(major: u32, minor: u32) -> Option<String> {
    (major < 4 || (major == 4 && minor < MIN_MINOR)).then(|| {
        format!(
            "The Veistra plugin needs Godot 4.{MIN_MINOR} or later; this is Godot {major}.{minor}. \
             The editor still opens here; Mark up, Send selection and Viewport only need the plugin."
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PROJECT: &str =
        "; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name=\"G\"\n";

    fn project(text: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("project.godot"), text).unwrap();
        dir
    }

    fn read(dir: &TempDir) -> String {
        std::fs::read_to_string(dir.path().join("project.godot")).unwrap()
    }

    #[test]
    fn the_shipped_files_carry_the_marker_and_name_the_script() {
        assert!(SCRIPT.starts_with(VERSION_MARKER));
        assert!(DOCK.starts_with(DOCK_MARKER));
        assert!(MENU.starts_with(MENU_MARKER));
        assert!(CONFIG.contains("script=\"veistra_editor.gd\""));
        assert!(SCRIPT.contains("preload(\"veistra_dock.gd\")"));
    }

    #[test]
    fn a_new_section_is_appended_and_removal_restores_the_file() {
        let added = with_plugin(PROJECT);
        assert!(added.ends_with(
            "[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/veistra/plugin.cfg\")\n"
        ));
        assert_eq!(without_plugin(&added), PROJECT);
    }

    #[test]
    fn another_plugin_keeps_its_place_in_the_list() {
        let text =
            "[editor_plugins]\n\nenabled=PackedStringArray(\"res://addons/gut/plugin.cfg\")\n";
        let added = with_plugin(text);
        assert!(added.contains(
            "enabled=PackedStringArray(\"res://addons/gut/plugin.cfg\", \"res://addons/veistra/plugin.cfg\")"
        ));
        assert_eq!(with_plugin(&added), added, "enabling twice changes nothing");
        assert_eq!(without_plugin(&added), text);
    }

    #[test]
    fn crlf_files_keep_their_line_endings() {
        let text = PROJECT.replace('\n', "\r\n");
        let added = with_plugin(&text);
        assert!(!added.replace("\r\n", "").contains('\n'));
        assert_eq!(without_plugin(&added), text);
    }

    #[test]
    fn install_and_remove_are_exact_inverses_and_leave_the_capture_addon_alone() {
        let dir = project(PROJECT);
        addon::install(dir.path()).unwrap();
        let with_capture = read(&dir);
        assert_eq!(status(dir.path()), Installed::No);

        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
        assert!(dir.path().join("addons/veistra/plugin.cfg").is_file());
        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes, "idempotent");

        assert!(dir.path().join("addons/veistra/veistra_dock.gd").is_file());
        assert!(dir.path().join("addons/veistra/veistra_menu.gd").is_file());
        for uid in [
            "veistra_editor.gd.uid",
            "veistra_dock.gd.uid",
            "veistra_menu.gd.uid",
        ] {
            std::fs::write(dir.path().join("addons/veistra").join(uid), "uid://c1").unwrap();
        }
        remove(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::No);
        assert_eq!(read(&dir), with_capture);
        assert_eq!(addon::status(dir.path()), Installed::Yes);
        let left: Vec<_> = std::fs::read_dir(dir.path().join("addons/veistra"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(left, vec!["veistra_capture.gd".to_string()]);

        addon::remove(dir.path()).unwrap();
        assert!(!dir.path().join("addons").exists());
        assert_eq!(read(&dir), PROJECT);
    }

    #[test]
    fn a_stale_script_or_a_plugin_switched_off_in_godot_reads_as_partial() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("project.godot"),
            without_plugin(&read(&dir)),
        )
        .unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
        install(dir.path()).unwrap();
        std::fs::write(script_path(dir.path()), "# veistra-editor v0\n").unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
    }

    // An editor plugin from before #320 has no dock: it reads as needing a
    // reinstall, and the reinstall brings the dock.
    #[test]
    fn a_plugin_without_its_dock_reads_as_partial_until_reinstalled() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::remove_file(dock_path(dir.path())).unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
        std::fs::write(script_path(dir.path()), "# veistra-editor v1\n").unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
    }

    // The plugin from before Mention in agent (editor v2, dock v1, no menus)
    // keeps working, and the pane offers the update until it is reinstalled.
    #[test]
    fn a_plugin_from_before_mentions_reads_as_partial_until_reinstalled() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(script_path(dir.path()), "# veistra-editor v2\n").unwrap();
        std::fs::write(dock_path(dir.path()), "# veistra-dock v1\n").unwrap();
        std::fs::remove_file(menu_path(dir.path())).unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
        assert!(std::fs::read_to_string(menu_path(dir.path()))
            .unwrap()
            .starts_with(MENU_MARKER));
    }

    // Editor v3 cannot quit without its prompt, so a cluster closed with
    // Close would hand its editor back asking; the pane offers the update.
    #[test]
    fn a_plugin_that_cannot_quit_reads_as_partial_until_reinstalled() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(script_path(dir.path()), "# veistra-editor v3\n").unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
    }

    #[test]
    fn install_refuses_a_folder_that_is_not_a_project() {
        let dir = TempDir::new().unwrap();
        assert!(install(dir.path()).is_err());
        assert!(!dir.path().join("addons").exists());
    }

    #[test]
    fn godot_before_4_2_is_told_what_it_still_gets() {
        assert!(too_old(4, 1).unwrap().contains("4.2 or later"));
        assert!(too_old(3, 5).is_some());
        assert_eq!(too_old(4, 2), None);
        assert_eq!(too_old(5, 0), None);
    }
}
