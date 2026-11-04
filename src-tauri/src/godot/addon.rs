//! The Veistra capture addon: what it is, how it is installed and removed, and
//! the file channel a running game answers on.
//!
//! **Opt-in and removable.** Nothing here runs unless someone presses Enable
//! capture in Play. Enabling writes one script into `addons/veistra/` and one
//! line into `project.godot`'s `[autoload]` section; disabling deletes exactly
//! those two things. Nothing is added to a project that was not asked to have
//! it, and a game started without the addon is unaffected.
//!
//! **Files, not sockets.** A game with the addon reads `--veistra-dir=<folder>`
//! from its user arguments and watches that folder (in the OS temp directory,
//! never in the project) for `cmd.json`. Veistra writes a command and reads
//! `res-<id>.json` back. No listener, no port, nothing reachable from the
//! network.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const SCRIPT: &str = include_str!("veistra_capture.gd");

/// The autoload's name, and the line that registers it.
const AUTOLOAD_KEY: &str = "VeistraCapture";
const SCRIPT_RES_PATH: &str = "res://addons/veistra/veistra_capture.gd";

/// The protocol the script on disk speaks, on its first line: a game whose
/// script carries it gets a channel even when the text is an earlier one.
const VERSION_MARKER: &str = "# veistra-capture v2";

/// The addon version a running game reported in its `hello.json`: 2 writes
/// telemetry and handles F7, F8 and Ctrl Shift M; 1 (or no answer yet) only
/// captures and pauses. `None` until the game has written the file.
pub fn running_version(dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(dir.join("hello.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(v["version"].as_u64().map_or(1, |n| n as u32))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Installed {
    No,
    /// The script and the autoload line are both present, and the script is
    /// this build's.
    Yes,
    /// Both present, and the script is an earlier version 2. It speaks this
    /// build's channel, so games keep their capture while the pane offers the
    /// update; it goes out as `partial` because that is the state the pane
    /// already offers Update capture for.
    #[serde(rename = "partial")]
    Outdated,
    /// One of the two is missing, or the script is from another version.
    Partial,
}

impl Installed {
    /// Whether a game started now is given a channel.
    pub fn usable(self) -> bool {
        matches!(self, Self::Yes | Self::Outdated)
    }
}

pub fn script_path(project: &Path) -> PathBuf {
    project
        .join("addons")
        .join("veistra")
        .join("veistra_capture.gd")
}

fn autoload_line() -> String {
    format!("{AUTOLOAD_KEY}=\"*{SCRIPT_RES_PATH}\"")
}

/// Where the project's addon stands. The whole text is compared, not the
/// marker: the script changes between releases without a new protocol, and a
/// marker-only check called every earlier version 2 current forever, so a
/// fix to it never reached a project that had it already.
pub fn status(project: &Path) -> Installed {
    let script = std::fs::read_to_string(script_path(project)).ok();
    let project_file = std::fs::read_to_string(project.join("project.godot")).unwrap_or_default();
    match (script.as_deref(), has_autoload(&project_file)) {
        (None, false) => Installed::No,
        (Some(text), true) if same_text(text, SCRIPT) => Installed::Yes,
        (Some(text), true) if text.starts_with(VERSION_MARKER) => Installed::Outdated,
        _ => Installed::Partial,
    }
}

/// Equal apart from line endings: Git on Windows checks a committed copy out
/// with CRLF, and that is still this build's script.
fn same_text(a: &str, b: &str) -> bool {
    a.replace("\r\n", "\n") == b.replace("\r\n", "\n")
}

fn has_autoload(project_file: &str) -> bool {
    let mut in_section = false;
    for line in project_file.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_section = t == "[autoload]";
        } else if in_section && t.starts_with(&format!("{AUTOLOAD_KEY}=")) {
            return true;
        }
    }
    false
}

/// Write the script and register the autoload. Idempotent: running it on an
/// installed project rewrites the script and leaves `project.godot` alone.
pub fn install(project: &Path) -> Result<(), String> {
    let project_file_path = project.join("project.godot");
    let text = std::fs::read_to_string(&project_file_path)
        .map_err(|e| format!("could not read {}: {e}", project_file_path.display()))?;

    let script = script_path(project);
    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&script, SCRIPT)
        .map_err(|e| format!("could not write {}: {e}", script.display()))?;

    if !has_autoload(&text) {
        std::fs::write(&project_file_path, with_autoload(&text))
            .map_err(|e| format!("could not update {}: {e}", project_file_path.display()))?;
    }
    Ok(())
}

/// Delete what [`install`] wrote. The `addons/veistra` folder goes only if it is
/// then empty, so anything else someone put there survives.
pub fn remove(project: &Path) -> Result<(), String> {
    let script = script_path(project);
    if script.exists() {
        std::fs::remove_file(&script)
            .map_err(|e| format!("could not delete {}: {e}", script.display()))?;
    }
    if let Some(dir) = script.parent() {
        let _ = std::fs::remove_dir(dir);
        if let Some(addons) = dir.parent() {
            let _ = std::fs::remove_dir(addons);
        }
    }

    let path = project.join("project.godot");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if has_autoload(&text) {
        std::fs::write(&path, without_autoload(&text))
            .map_err(|e| format!("could not update {}: {e}", path.display()))?;
    }
    Ok(())
}

/// `project.godot` with the autoload line added. Only the `[autoload]` section
/// is touched, and the file's line endings are kept.
pub fn with_autoload(text: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let line = autoload_line();
    let lines: Vec<&str> = text.split(nl).collect();

    if let Some(at) = lines.iter().position(|l| l.trim() == "[autoload]") {
        // After the header and the blank line Godot writes under it.
        let mut insert = at + 1;
        while lines.get(insert).is_some_and(|l| l.trim().is_empty()) {
            insert += 1;
        }
        let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        out.insert(insert, line);
        // No entries followed the header: keep a blank line before the next section.
        if lines
            .get(insert)
            .is_some_and(|l| l.trim_start().starts_with('['))
        {
            out.insert(insert + 1, String::new());
        }
        return out.join(nl);
    }

    let mut out = text.trim_end_matches(['\r', '\n']).to_string();
    out.push_str(nl);
    out.push_str(nl);
    out.push_str("[autoload]");
    out.push_str(nl);
    out.push_str(nl);
    out.push_str(&line);
    out.push_str(nl);
    out
}

/// The inverse of [`with_autoload`]: drops the line, and the `[autoload]`
/// header too when that leaves the section empty.
pub fn without_autoload(text: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<&str> = text.split(nl).collect();
    let prefix = format!("{AUTOLOAD_KEY}=");
    let mut in_section = false;
    let mut header = None;
    let mut remove_at = None;
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.starts_with('[') {
            in_section = t == "[autoload]";
            if in_section {
                header = Some(i);
            }
        } else if in_section && t.starts_with(&prefix) {
            remove_at = Some(i);
        }
    }
    let Some(at) = remove_at else {
        return text.to_string();
    };
    lines.remove(at);

    if let Some(h) = header {
        let mut end = h + 1;
        while lines.get(end).is_some_and(|l| l.trim().is_empty()) {
            end += 1;
        }
        let empty = end >= lines.len() || lines[end].trim_start().starts_with('[');
        if empty {
            let mut start = h;
            while start > 0 && lines[start - 1].trim().is_empty() {
                start -= 1;
            }
            lines.drain(start..end.min(lines.len()));
            if end < lines.len() + (end - start) && start < lines.len() {
                lines.insert(start, "");
            }
        }
    }
    let mut out = lines.join(nl);
    if !out.ends_with(nl) {
        out.push_str(nl);
    }
    out
}

// --- the channel ------------------------------------------------------------

/// A reply from the game to a command.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub ok: bool,
    pub error: Option<String>,
    pub time: f64,
    pub scene: String,
    pub paused: bool,
    pub png: Option<Vec<u8>>,
    pub size: Option<(u64, u64)>,
    /// Wall-clock milliseconds when the game answered (v2 only).
    pub t: Option<u64>,
    /// `pick`'s answer: `{nodePath, type, worldPoint, source}`, or null.
    pub hit: Option<serde_json::Value>,
}

/// Send `action` to the game listening in `dir` and wait for its answer.
/// The command file is written and then renamed into place, so the game never
/// reads half of one.
pub fn send(dir: &Path, id: u64, action: &str, wait: Duration) -> Result<Reply, String> {
    send_with(dir, id, action, serde_json::Value::Null, wait)
}

/// [`send`] with fields beside `id` and `action`, such as `pick`'s `x` and `y`.
pub fn send_with(
    dir: &Path,
    id: u64,
    action: &str,
    extra: serde_json::Value,
    wait: Duration,
) -> Result<Reply, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let tmp = dir.join("cmd.json.tmp");
    let mut cmd = serde_json::json!({ "id": id, "action": action });
    if let (Some(into), serde_json::Value::Object(more)) = (cmd.as_object_mut(), extra) {
        for (k, v) in more {
            into.entry(k).or_insert(v);
        }
    }
    std::fs::write(&tmp, cmd.to_string()).map_err(|e| format!("could not write a command: {e}"))?;
    std::fs::rename(&tmp, dir.join("cmd.json"))
        .map_err(|e| format!("could not send a command: {e}"))?;

    let reply_path = dir.join(format!("res-{id}.json"));
    let started = Instant::now();
    let mut unreadable = None;
    loop {
        if let Ok(text) = std::fs::read_to_string(&reply_path) {
            // A reply seen half-written parses badly; look again until the wait ends.
            match parse_reply(dir, &text) {
                Ok(reply) => return Ok(reply),
                Err(e) => unreadable = Some(e),
            }
        }
        if started.elapsed() > wait {
            let _ = std::fs::remove_file(dir.join("cmd.json"));
            if let Some(e) = unreadable {
                return Err(e);
            }
            return Err(
                "the game did not answer. It may have been started before capture was enabled - restart it."
                    .to_string(),
            );
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn parse_reply(dir: &Path, text: &str) -> Result<Reply, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("unreadable reply: {e}"))?;
    let png = match v["png"].as_str() {
        Some(name) if !name.contains(['/', '\\']) => Some(
            std::fs::read(dir.join(name)).map_err(|e| format!("the game wrote no image: {e}"))?,
        ),
        _ => None,
    };
    let size = match (v["width"].as_u64(), v["height"].as_u64()) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    };
    Ok(Reply {
        ok: v["ok"].as_bool().unwrap_or(false),
        error: v["error"].as_str().map(str::to_string),
        time: v["time"].as_f64().unwrap_or(0.0),
        scene: v["scene"].as_str().unwrap_or("").to_string(),
        paused: v["paused"].as_bool().unwrap_or(false),
        png,
        size,
        t: v["t"].as_f64().map(|t| t.max(0.0) as u64),
        hit: v.get("hit").filter(|h| !h.is_null()).cloned(),
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

    #[test]
    fn the_shipped_script_carries_the_version_marker_status_checks_for() {
        assert!(SCRIPT.starts_with(VERSION_MARKER));
    }

    #[test]
    fn a_new_autoload_section_is_appended_and_removal_restores_the_file() {
        let added = with_autoload(PROJECT);
        assert!(added.ends_with(
            "[autoload]\n\nVeistraCapture=\"*res://addons/veistra/veistra_capture.gd\"\n"
        ));
        assert!(added.starts_with(PROJECT.trim_end()));
        assert!(has_autoload(&added));
        assert_eq!(without_autoload(&added), PROJECT);
    }

    #[test]
    fn an_existing_autoload_section_gets_the_line_beside_the_others() {
        let text = "config_version=5\n\n[autoload]\n\nGlobal=\"*res://global.gd\"\n\n[display]\n\nwindow/size/width=800\n";
        let added = with_autoload(text);
        assert!(added.contains(
            "[autoload]\n\nVeistraCapture=\"*res://addons/veistra/veistra_capture.gd\"\nGlobal="
        ));
        assert!(added.contains("[display]"));
        assert_eq!(without_autoload(&added), text);
    }

    #[test]
    fn crlf_files_keep_their_line_endings() {
        let text = PROJECT.replace('\n', "\r\n");
        let added = with_autoload(&text);
        assert!(!added.replace("\r\n", "").contains('\n'));
        assert_eq!(without_autoload(&added), text);
    }

    #[test]
    fn a_line_in_another_section_is_not_mistaken_for_the_autoload() {
        let text = "[application]\nVeistraCapture=1\n";
        assert!(!has_autoload(text));
        assert_eq!(without_autoload(text), text);
    }

    #[test]
    fn install_and_remove_are_exact_inverses_and_status_tracks_them() {
        let dir = project(PROJECT);
        assert_eq!(status(dir.path()), Installed::No);

        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
        assert!(script_path(dir.path()).is_file());
        install(dir.path()).unwrap();
        let once = std::fs::read_to_string(dir.path().join("project.godot")).unwrap();
        assert_eq!(
            once.matches(AUTOLOAD_KEY).count(),
            1,
            "installing twice registers once"
        );

        remove(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::No);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("project.godot")).unwrap(),
            PROJECT
        );
        assert!(
            !dir.path().join("addons").exists(),
            "empty folders are cleaned up"
        );
    }

    #[test]
    fn remove_keeps_a_folder_that_holds_someone_elses_files() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(dir.path().join("addons/veistra/mine.txt"), "x").unwrap();
        remove(dir.path()).unwrap();
        assert!(dir.path().join("addons/veistra/mine.txt").is_file());
    }

    #[test]
    fn a_stale_script_or_a_missing_line_reads_as_partial() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(script_path(dir.path()), "# something else\n").unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);

        install(dir.path()).unwrap();
        std::fs::write(dir.path().join("project.godot"), PROJECT).unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
    }

    #[test]
    fn install_refuses_a_folder_that_is_not_a_project() {
        let dir = TempDir::new().unwrap();
        assert!(install(dir.path()).is_err());
        assert!(
            !dir.path().join("addons").exists(),
            "nothing is written before the project file is read"
        );
    }

    #[test]
    fn a_command_round_trips_through_the_channel_with_a_png() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().to_path_buf();

        let game = channel.clone();
        let responder = std::thread::spawn(move || {
            let cmd = game.join("cmd.json");
            for _ in 0..200 {
                if let Ok(text) = std::fs::read_to_string(&cmd) {
                    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(v["action"], "capture");
                    std::fs::remove_file(&cmd).unwrap();
                    std::fs::write(game.join("cap-7.png"), [0x89, b'P', b'N', b'G']).unwrap();
                    std::fs::write(
                        game.join("res-7.json"),
                        r#"{"id":7,"ok":true,"png":"cap-7.png","width":4,"height":3,"time":12.5,"scene":"res://main.tscn","paused":false}"#,
                    )
                    .unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no command arrived");
        });

        let reply = send(&channel, 7, "capture", Duration::from_secs(5)).unwrap();
        responder.join().unwrap();
        assert!(reply.ok);
        assert_eq!(reply.scene, "res://main.tscn");
        assert_eq!(reply.time, 12.5);
        assert_eq!(reply.size, Some((4, 3)));
        assert_eq!(reply.png, Some(vec![0x89, b'P', b'N', b'G']));
    }

    #[test]
    fn a_pick_carries_its_point_and_brings_back_what_was_hit() {
        let dir = TempDir::new().unwrap();
        let game = dir.path().to_path_buf();
        let responder = std::thread::spawn(move || {
            let cmd = game.join("cmd.json");
            for _ in 0..200 {
                if let Ok(text) = std::fs::read_to_string(&cmd) {
                    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(
                        (v["action"].as_str(), v["x"].as_i64()),
                        (Some("pick"), Some(640))
                    );
                    assert_eq!(v["id"], 3, "an extra field never replaces the id");
                    std::fs::remove_file(&cmd).unwrap();
                    std::fs::write(
                        game.join("res-3.json"),
                        r#"{"id":3,"ok":true,"t":1793398962180,"hit":{"nodePath":"Hallway/Enemy_02","type":"CharacterBody3D","worldPoint":[14.2,0,-6.8],"source":"ray"}}"#,
                    )
                    .unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no command arrived");
        });
        let extra = serde_json::json!({ "x": 640, "y": 360, "id": 99 });
        let reply = send_with(dir.path(), 3, "pick", extra, Duration::from_secs(5)).unwrap();
        responder.join().unwrap();
        assert_eq!(reply.t, Some(1_793_398_962_180));
        assert_eq!(reply.hit.unwrap()["nodePath"], "Hallway/Enemy_02");
    }

    #[test]
    fn the_running_version_comes_from_hello_and_v1_wrote_none() {
        let dir = TempDir::new().unwrap();
        assert_eq!(running_version(dir.path()), None);
        std::fs::write(dir.path().join("hello.json"), r#"{"pid":1}"#).unwrap();
        assert_eq!(running_version(dir.path()), Some(1));
        std::fs::write(dir.path().join("hello.json"), r#"{"pid":1,"version":2}"#).unwrap();
        assert_eq!(running_version(dir.path()), Some(2));
    }

    #[test]
    fn a_project_holding_the_v1_script_is_offered_the_update() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(
            script_path(dir.path()),
            "# veistra-capture v1\nextends Node\n",
        )
        .unwrap();
        assert_eq!(status(dir.path()), Installed::Partial);
        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
    }

    #[test]
    fn an_earlier_v2_is_offered_the_update_and_keeps_its_capture_meanwhile() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        let earlier = SCRIPT.replacen("const TICK_SEC := 0.1", "const TICK_SEC := 0.2", 1);
        assert_ne!(earlier, SCRIPT);
        std::fs::write(script_path(dir.path()), &earlier).unwrap();

        let found = status(dir.path());
        assert_eq!(found, Installed::Outdated);
        assert!(found.usable(), "an earlier v2 still speaks the channel");
        assert_eq!(
            serde_json::to_value(found).unwrap(),
            "partial",
            "the pane offers Update capture for it"
        );
        assert!(!Installed::Partial.usable() && !Installed::No.usable());

        install(dir.path()).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
    }

    #[test]
    fn a_crlf_copy_of_the_shipped_script_is_current() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        let crlf = SCRIPT.replace("\r\n", "\n").replace('\n', "\r\n");
        std::fs::write(script_path(dir.path()), crlf).unwrap();
        assert_eq!(status(dir.path()), Installed::Yes);
    }

    #[test]
    fn a_silent_game_times_out_with_advice_and_leaves_no_command_behind() {
        let dir = TempDir::new().unwrap();
        let err = send(dir.path(), 1, "pause", Duration::from_millis(150)).unwrap_err();
        assert!(err.contains("restart"));
        assert!(!dir.path().join("cmd.json").exists());
    }

    #[test]
    fn a_reply_may_not_point_outside_its_folder() {
        let dir = TempDir::new().unwrap();
        let reply = parse_reply(dir.path(), r#"{"ok":true,"png":"../secret.png"}"#).unwrap();
        assert_eq!(reply.png, None);
    }
}
