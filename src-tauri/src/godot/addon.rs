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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
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
    section_line(project_file, "[autoload]", &format!("{AUTOLOAD_KEY}=")).is_some()
}

/// The line in `section` that starts with `prefix`, trimmed.
pub(super) fn section_line<'a>(text: &'a str, section: &str, prefix: &str) -> Option<&'a str> {
    let mut in_section = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_section = t == section;
        } else if in_section && t.starts_with(prefix) {
            return Some(t);
        }
    }
    None
}

/// Delete `script` and the `.uid` file Godot 4.4 and later writes beside
/// every script, then `addons/veistra` and `addons` if that leaves them
/// empty, so anything else someone put there survives.
pub(super) fn remove_script(script: &Path) -> Result<(), String> {
    let uid = PathBuf::from(format!("{}.uid", script.display()));
    for file in [script, uid.as_path()] {
        if file.exists() {
            std::fs::remove_file(file)
                .map_err(|e| format!("could not delete {}: {e}", file.display()))?;
        }
    }
    if let Some(dir) = script.parent() {
        let _ = std::fs::remove_dir(dir);
        if let Some(addons) = dir.parent() {
            let _ = std::fs::remove_dir(addons);
        }
    }
    Ok(())
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

/// Delete what [`install`] wrote, and the `.uid` file Godot made for it. The
/// `addons/veistra` folder goes only if it is then empty, so anything else
/// someone put there, the editor plugin included, survives.
pub fn remove(project: &Path) -> Result<(), String> {
    remove_script(&script_path(project))?;

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
    with_line(text, "[autoload]", &autoload_line())
}

/// The inverse of [`with_autoload`]: drops the line, and the `[autoload]`
/// header too when that leaves the section empty.
pub fn without_autoload(text: &str) -> String {
    without_line(text, "[autoload]", &format!("{AUTOLOAD_KEY}="))
}

/// `text` with `line` first in `section`, which is added at the end when the
/// file has none. Shared with the editor plugin's `[editor_plugins]` entry.
pub(super) fn with_line(text: &str, section: &str, line: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let line = line.to_string();
    let lines: Vec<&str> = text.split(nl).collect();

    if let Some(at) = lines.iter().position(|l| l.trim() == section) {
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
    out.push_str(section);
    out.push_str(nl);
    out.push_str(nl);
    out.push_str(&line);
    out.push_str(nl);
    out
}

/// The inverse of [`with_line`]: drops the line in `section` that starts with
/// `prefix`, and the header too when that leaves the section empty.
pub(super) fn without_line(text: &str, section: &str, prefix: &str) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<&str> = text.split(nl).collect();
    let mut in_section = false;
    let mut header = None;
    let mut remove_at = None;
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.starts_with('[') {
            in_section = t == section;
            if in_section {
                header = Some(i);
            }
        } else if in_section && t.starts_with(prefix) {
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

/// What a game that does not answer is told to do.
const GAME_SILENT: &str =
    "the game did not answer. It may have been started before capture was enabled - restart it.";

/// The turn of one channel. The game reads a single `cmd.json`, so a second
/// command renamed into place before it read the first would replace it, and
/// the first would wait out its timeout as if the game were gone; Stop's
/// flush can arrive while the pane waits on a pick. Entries no sender holds
/// are dropped as others are added, so the map stays as small as the runs
/// going.
fn channel_turn(dir: &Path) -> Arc<Mutex<()>> {
    static TURNS: Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());
    let mut turns = TURNS.lock().unwrap_or_else(PoisonError::into_inner);
    turns.retain(|_, turn| Arc::strong_count(turn) > 1);
    turns.entry(dir.to_path_buf()).or_default().clone()
}

/// [`send`] with fields beside `id` and `action`, such as `pick`'s `x` and `y`.
/// Commands to one game go one at a time ([`channel_turn`]); `wait` counts
/// from this command's own turn.
pub fn send_with(
    dir: &Path,
    id: u64,
    action: &str,
    extra: serde_json::Value,
    wait: Duration,
) -> Result<Reply, String> {
    exchange(dir, id, action, extra, wait, GAME_SILENT, parse_reply)
}

/// One round trip on a channel folder, read by `parse`: the capture addon's,
/// and the editor plugin's, which answers in the same files. `silent` is the
/// error when nothing answers within `wait`. Commands on one folder take
/// turns ([`channel_turn`]), whichever of the two is listening.
pub(super) fn exchange<T>(
    dir: &Path,
    id: u64,
    action: &str,
    extra: serde_json::Value,
    wait: Duration,
    silent: &str,
    parse: impl Fn(&Path, &str) -> Result<T, String>,
) -> Result<T, String> {
    let turn = channel_turn(dir);
    let _turn = turn.lock().unwrap_or_else(PoisonError::into_inner);
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
            match parse(dir, &text) {
                Ok(reply) => return Ok(reply),
                Err(e) => unreadable = Some(e),
            }
        }
        if started.elapsed() > wait {
            let _ = std::fs::remove_file(dir.join("cmd.json"));
            if let Some(e) = unreadable {
                return Err(e);
            }
            return Err(silent.to_string());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// The picture a reply names, read from the channel folder. A name with a
/// separator in it is ignored, so a reply cannot point outside the folder.
pub(super) fn png_in(dir: &Path, reply: &serde_json::Value) -> std::io::Result<Option<Vec<u8>>> {
    match reply["png"].as_str() {
        Some(name) if !name.contains(['/', '\\']) => std::fs::read(dir.join(name)).map(Some),
        _ => Ok(None),
    }
}

/// Ids for commands Veistra sends on its own rather than for the pane. The
/// pane's count up from 1 ([`super::Godot::next_command_id`]) and each id is
/// answered in a file of its own, so these start far above anything that
/// count reaches, and below 2^53, where the game's JSON reader stays exact.
const OWN_IDS: u64 = 1 << 40;

/// Have a running game write out the telemetry it is holding: it flushes
/// once a second, and a take copies the file the moment it stops, so its
/// last second of ticks was missing. A game that does not answer within
/// `wait` (an earlier script, a frame that hangs) costs only the wait.
pub fn flush(dir: &Path, wait: Duration) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(OWN_IDS);
    let reply = send(dir, NEXT.fetch_add(1, Ordering::Relaxed), "flush", wait)?;
    match reply.ok {
        true => Ok(()),
        false => Err(reply
            .error
            .unwrap_or_else(|| "the game did not flush".into())),
    }
}

fn parse_reply(dir: &Path, text: &str) -> Result<Reply, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("unreadable reply: {e}"))?;
    let png = png_in(dir, &v).map_err(|e| format!("the game wrote no image: {e}"))?;
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
    use serde_json::{json, Value};
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
    fn remove_takes_the_uid_file_godot_wrote_and_then_the_empty_folders() {
        let dir = project(PROJECT);
        install(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("addons/veistra/veistra_capture.gd.uid"),
            "uid://b1",
        )
        .unwrap();
        remove(dir.path()).unwrap();
        assert!(
            !dir.path().join("addons").exists(),
            "a 4.4 project is left as it was"
        );
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

    /// Answers the next command in `dir` with `reply`, and hands back the command.
    fn answer_once(dir: &Path, reply: Value) -> std::thread::JoinHandle<Value> {
        let game = dir.to_path_buf();
        std::thread::spawn(move || {
            let cmd = game.join("cmd.json");
            for _ in 0..200 {
                if let Ok(text) = std::fs::read_to_string(&cmd) {
                    let v: Value = serde_json::from_str(&text).unwrap();
                    std::fs::remove_file(&cmd).unwrap();
                    let mut reply = reply.clone();
                    reply["id"] = v["id"].clone();
                    let id = v["id"].as_u64().unwrap();
                    std::fs::write(game.join(format!("res-{id}.json")), reply.to_string()).unwrap();
                    return v;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no command arrived");
        })
    }

    #[test]
    fn a_flush_uses_ids_the_pane_never_does_and_an_earlier_script_refuses_it() {
        let dir = TempDir::new().unwrap();
        let game = answer_once(dir.path(), json!({ "ok": true }));
        flush(dir.path(), Duration::from_secs(5)).unwrap();
        let sent = game.join().unwrap();
        assert_eq!(sent["action"], "flush");
        assert!(sent["id"].as_u64().unwrap() >= OWN_IDS);

        let game = answer_once(
            dir.path(),
            json!({ "ok": false, "error": "unknown action" }),
        );
        let err = flush(dir.path(), Duration::from_secs(5)).unwrap_err();
        let again = game.join().unwrap();
        assert_eq!(err, "unknown action");
        assert_ne!(sent["id"], again["id"], "a stale answer is never read back");
    }

    #[test]
    fn two_commands_at_once_both_reach_a_game_that_reads_one_file() {
        let dir = TempDir::new().unwrap();
        // A game that looks for cmd.json five times a second, as slowly as a
        // busy frame might: two commands written inside one look would leave
        // only the second.
        let game = dir.path().to_path_buf();
        let reader = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..50 {
                std::thread::sleep(Duration::from_millis(200));
                let Ok(text) = std::fs::read_to_string(game.join("cmd.json")) else {
                    continue;
                };
                std::fs::remove_file(game.join("cmd.json")).unwrap();
                let v: Value = serde_json::from_str(&text).unwrap();
                let id = v["id"].as_u64().unwrap();
                let reply = json!({ "id": id, "ok": true });
                std::fs::write(game.join(format!("res-{id}.json")), reply.to_string()).unwrap();
                seen.push(v["action"].as_str().unwrap().to_string());
                if seen.len() == 2 {
                    break;
                }
            }
            seen
        });
        let pane = {
            let dir = dir.path().to_path_buf();
            std::thread::spawn(move || send(&dir, 7, "pause", Duration::from_secs(2)))
        };
        std::thread::sleep(Duration::from_millis(20));
        flush(dir.path(), Duration::from_secs(2)).unwrap();
        assert!(pane.join().unwrap().unwrap().ok);
        let mut seen = reader.join().unwrap();
        seen.sort();
        assert_eq!(seen, ["flush", "pause"]);
    }

    // --- the script ----------------------------------------------------------
    // No Godot runs in CI. These pin the mechanism each of the script's fixes
    // uses, as apps/godot-viewer/ui/src/play/capture.gd.test.ts does for the older ones;
    // what the engine does with it rests on the API facts the script names.

    /// One function of the shipped script without its comment lines, from its
    /// `func` line to the next line that starts at column zero.
    fn script_fn(name: &str) -> String {
        let head = format!("func {name}(");
        let mut lines = SCRIPT.lines().skip_while(|l| !l.starts_with(&head));
        let first = lines
            .next()
            .unwrap_or_else(|| panic!("func {name} is missing"));
        std::iter::once(first)
            .chain(lines.take_while(|l| l.is_empty() || l.starts_with(char::is_whitespace)))
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn script_code() -> String {
        SCRIPT
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Where `needle` is in `hay`, which must hold it.
    fn at(hay: &str, needle: &str) -> usize {
        hay.find(needle)
            .unwrap_or_else(|| panic!("`{needle}` is missing"))
    }

    #[test]
    fn the_script_answers_every_action_this_build_sends() {
        let poll = script_fn("_poll_command");
        for action in ["capture", "pause", "resume", "pick", "flush"] {
            assert!(poll.contains(&format!("\"{action}\":")), "{action}");
        }
        assert!(poll.contains("_log.flush()"));
    }

    #[test]
    fn an_exported_build_never_reads_the_channel_argument() {
        let ready = script_fn("_ready");
        assert!(
            at(&ready, "OS.has_feature(\"template\")") < at(&ready, "_arg_dir()"),
            "the guard comes first"
        );
        assert_eq!(
            script_code().matches("get_cmdline_user_args").count(),
            1,
            "nothing else reads the arguments"
        );
        assert!(script_fn("_arg_dir").contains("get_cmdline_user_args"));
        for off in ["set_process(false)", "set_physics_process(false)"] {
            assert!(ready.contains(off), "{off}");
        }
    }

    #[test]
    fn a_pick_s_physics_query_runs_in_the_physics_frame_only() {
        assert!(!script_fn("_poll_command").contains("_pick("));
        assert!(script_fn("_physics_process").contains("_pick("));
        let code = script_code();
        assert_eq!(
            code.matches("_pick(").count(),
            2,
            "defined once and called once, from _physics_process"
        );
        let pick = script_fn("_pick");
        assert!(pick.contains("intersect_ray(") && pick.contains("intersect_point("));
        assert_eq!(code.matches("intersect_ray(").count(), 1);
        assert_eq!(code.matches("intersect_point(").count(), 1);
    }

    #[test]
    fn a_body_s_own_mesh_folds_into_the_body_and_lights_are_not_tracked() {
        let defaults = script_fn("_default_candidates");
        for class in [
            "GeometryInstance3D",
            "AnimatedSprite2D",
            "CollisionObject3D",
        ] {
            assert!(defaults.contains(&format!("\"{class}\"")), "{class}");
        }
        assert!(!defaults.contains("\"VisualInstance3D\""));
        assert!(defaults.contains("_in_body("));
        assert!(
            defaults.contains("get_tree().root"),
            "a tree with no current scene is still searched"
        );
        let refresh = script_fn("_refresh_candidates");
        assert!(
            at(&refresh, "get_nodes_in_group(TRACK_GROUP)") < at(&refresh, "_default_candidates()"),
            "group members do not wait for a current scene"
        );
        assert!(
            !refresh.contains("return"),
            "nothing returns before the group is read"
        );
    }

    #[test]
    fn the_frustum_test_uses_the_box_centre_stored_at_refresh() {
        assert!(script_fn("_refresh_candidates").contains("box.get_center()"));
        let rects = script_fn("_tracked_rects");
        assert!(rects.contains("var at: Vector3 = n3.global_transform * c[5]"));
        assert!(rects.contains("is_position_in_frustum(at)"));
    }

    #[test]
    fn a_tick_reports_the_mouse_mode_and_what_a_refresh_cost() {
        let tick = script_fn("_tick");
        assert!(tick.contains("\"mouse\": Input.mouse_mode"));
        assert!(tick.contains("data[\"refreshUs\"] = _refresh_usec"));
        assert!(
            at(&tick, "_refresh_candidates()") < at(&tick, "var started := Time.get_ticks_usec()"),
            "a refresh is not counted in tickUs"
        );
    }

    #[test]
    fn the_scene_godot_passes_through_between_two_is_not_an_event() {
        let tick = script_fn("_tick");
        assert!(at(&tick, "if scene != \"\":") < at(&tick, "\"kind\": \"scene\""));
    }

    #[test]
    fn a_handled_key_s_release_and_bound_actions_are_kept_from_the_game() {
        let input = script_fn("_input");
        assert!(input.contains("_held.has(key.keycode)"));
        assert_eq!(
            input
                .matches("get_viewport().set_input_as_handled()")
                .count(),
            2,
            "the press, and its repeats and release"
        );
        assert!(input.contains("_release_actions(key)"));
        assert!(script_fn("_release_actions").contains("Input.action_release(action)"));
        let fresh = input.rfind("_held.erase(key.keycode)").unwrap();
        assert!(
            fresh < at(&input, "_veistra_key(key)"),
            "a fresh press forgets a release lost to a change of focus"
        );
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
