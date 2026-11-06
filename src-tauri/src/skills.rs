//! Built-in skills: skills Veistra ships and gives to the agents it runs.
//!
//! A skill is a folder holding `SKILL.md` and whatever it points at. The
//! sources live in the repository's `skills/` and are compiled into the binary
//! with `include_bytes!`, so the copy an agent reads is always this build's.
//! Rejected: `bundle.resources` in `tauri.conf.json`. A resource has to be
//! found through `resource_dir()` with a separate dev fallback (see
//! `manifest.rs`), and the files have to be copied into each harness's layout
//! anyway, so embedding them removes a lookup without adding a copy.
//!
//! How each harness gets them is its descriptor's `SkillDelivery`:
//!
//! - **Claude**: a plugin folder under Veistra's app data, passed per session
//!   in `_meta.claudeCode.options.plugins`. Nothing touches `~/.claude` or the
//!   project.
//! - **Codex**: no per-session route exists, and `CODEX_HOME` would move the
//!   user's sign-in. So the skill is copied into `$CODEX_HOME/skills` (or
//!   `~/.codex/skills`) with a [`MARKER`] file. Veistra replaces or removes
//!   only a folder holding that marker, never a user's own skill.
//! - **Any other**: a hint in the first prompt naming the `SKILL.md` path.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use veistra_agent_host::{Harness, LaunchSpec, SkillDelivery, REGISTRY};

use crate::settings::keys;

/// The file that marks a skill folder as Veistra's copy.
pub const MARKER: &str = ".veistra-built-in";

/// What the marker says to anyone who opens it.
const MARKER_TEXT: &str = "Installed by Veistra, which replaces or removes this folder.\n\
                           Delete this file to keep the folder as your own.\n";

/// The plugin name Claude shows the skills under: `veistra:<skill>`.
const PLUGIN_NAME: &str = "veistra";

/// One file of a skill: its path inside the skill's folder, and its bytes.
pub struct File {
    pub path: &'static str,
    pub bytes: &'static [u8],
}

/// When a skill in [`Mode::Auto`] is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// The session is canvas work: see [`Signals`].
    CanvasWork,
    /// The session is Godot work: see [`Signals`].
    GodotWork,
}

/// A skill this build ships.
pub struct Bundled {
    /// Its folder's name, which is also the `name` in its frontmatter.
    pub name: &'static str,
    /// The setting holding its [`Mode`].
    pub setting: &'static str,
    /// When [`Mode::Auto`] turns it on.
    pub trigger: Trigger,
    /// Every file, `SKILL.md` first.
    pub files: &'static [File],
}

impl Bundled {
    /// The text of its `SKILL.md`.
    pub fn skill_md(&self) -> &'static str {
        self.files
            .iter()
            .find(|f| f.path == "SKILL.md")
            .and_then(|f| std::str::from_utf8(f.bytes).ok())
            .unwrap_or("")
    }
}

/// One `File`, read at compile time from `skills/<skill>/<path>`. A macro
/// because `include_bytes!` needs a literal path, and `concat!` builds one.
macro_rules! skill_file {
    ($skill:literal, $path:literal) => {
        File {
            path: $path,
            bytes: include_bytes!(concat!("../../skills/", $skill, "/", $path)),
        }
    };
}

/// The canvas skill, on for canvas work unless the user says otherwise.
pub static AGENT_READY_CANVAS: Bundled = Bundled {
    name: "agent-ready-canvas",
    setting: keys::SKILLS_AGENT_READY_CANVAS,
    trigger: Trigger::CanvasWork,
    files: &[
        skill_file!("agent-ready-canvas", "SKILL.md"),
        skill_file!("agent-ready-canvas", "references/excalidraw-structure.md"),
        skill_file!("agent-ready-canvas", "scripts/canvas_lint.py"),
        skill_file!("agent-ready-canvas", "scripts/canvas_preview.py"),
        skill_file!("agent-ready-canvas", "scripts/canvas_restructure.py"),
        skill_file!("agent-ready-canvas", "scripts/excal.py"),
        skill_file!("agent-ready-canvas", "scripts/lint_hook.py"),
    ],
};

/// The Godot skill, on for Godot work unless the user says otherwise. An agent
/// asked for a game wrote the scripts and stopped, leaving nothing that runs
/// (TODO.md, known issue 3); this is what it was missing. With it the agent
/// gets the Godot path in [`crate::godot::AGENT_ENV`] (see [`godot_path_wanted`]).
pub static FINISH_GODOT_GAME: Bundled = Bundled {
    name: "finish-godot-game",
    setting: keys::SKILLS_FINISH_GODOT_GAME,
    trigger: Trigger::GodotWork,
    files: &[
        skill_file!("finish-godot-game", "SKILL.md"),
        skill_file!("finish-godot-game", "references/godot-text-formats.md"),
        skill_file!("finish-godot-game", "scripts/check_game.gd"),
    ],
};

/// Every skill this build ships.
pub static BUNDLED: &[&Bundled] = &[&AGENT_READY_CANVAS, &FINISH_GODOT_GAME];

// --- frontmatter -----------------------------------------------------------

/// The two fields of a `SKILL.md`'s frontmatter that the settings page shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: String,
    pub description: String,
}

/// The `name` and `description` between the `---` lines that open `text`.
/// Each is one `key: value` line, which is all a skill's frontmatter holds.
pub fn frontmatter(text: &str) -> Option<Frontmatter> {
    // `lines()` drops a `\r` before each `\n`, so CRLF reads the same.
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        if line.trim() == "---" {
            return Some(Frontmatter {
                name: name?,
                description: description.unwrap_or_default(),
            });
        }
        // `split_once` gives the text before and after the first `:`.
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().trim_matches('"').to_string();
            match key.trim() {
                "name" => name = Some(value),
                "description" => description = Some(value),
                _ => {}
            }
        }
    }
    None
}

// --- the rule ---------------------------------------------------------------

/// A skill's setting: on for its trigger, always, or never.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Auto,
    On,
    Off,
}

impl Mode {
    /// The setting's stored value. Anything unknown is the default, `Auto`.
    pub fn parse(value: &str) -> Mode {
        match value {
            "on" => Mode::On,
            "off" => Mode::Off,
            _ => Mode::Auto,
        }
    }
}

/// What makes a session canvas work, or Godot work. Any one of a kind's
/// signals is enough for that kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Signals {
    /// The worktree has a canvas: a `.json` under `canvas/`.
    pub canvas_files: bool,
    /// The prompt names a canvas (`veistra://canvas/...`).
    pub names_canvas: bool,
    /// A Design (canvas) pane is open in the session's cluster.
    pub canvas_open: bool,
    /// The worktree has a Godot project, script or scene
    /// ([`crate::godot::detect::has_godot_sources`]).
    pub godot_files: bool,
    /// The prompt names Godot, a scene or a script ([`names_godot`]). The
    /// only signal an empty folder can give, which is where a new game starts.
    pub names_godot: bool,
    /// The Godot app, in either mode, is open in the session's cluster.
    pub godot_open: bool,
}

impl Signals {
    pub fn canvas_work(&self) -> bool {
        self.canvas_files || self.names_canvas || self.canvas_open
    }

    pub fn godot_work(&self) -> bool {
        self.godot_files || self.names_godot || self.godot_open
    }
}

/// Whether a skill set to `mode` goes to a session with `signals`.
pub fn wanted(skill: &Bundled, mode: Mode, signals: &Signals) -> bool {
    match mode {
        Mode::On => true,
        Mode::Off => false,
        Mode::Auto => match skill.trigger {
            Trigger::CanvasWork => signals.canvas_work(),
            Trigger::GodotWork => signals.godot_work(),
        },
    }
}

/// Whether a session is handed the Godot executable: for Godot work, and
/// whenever the Godot skill is on for every session, since the skill's checks
/// need it. Independent of the skill being off: the path helps any agent that
/// works on a game, and costs nothing once Godot has been found.
pub fn godot_path_wanted(godot_skill: Mode, signals: &Signals) -> bool {
    godot_skill == Mode::On || signals.godot_work()
}

/// Whether `root` has a canvas: any `.json` file under `root/canvas/`, at
/// most a few folders down (canvas ids nest up to four segments).
pub fn has_canvas_files(root: &Path) -> bool {
    fn walk(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        // `flatten` skips the entries that could not be read.
        entries.flatten().any(|entry| {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_file() => path.extension().is_some_and(|e| e == "json"),
                Ok(t) if t.is_dir() && depth > 0 => walk(&path, depth - 1),
                _ => false,
            }
        })
    }
    walk(&root.join(crate::apps::canvas::DIR), 5)
}

/// Whether `text` names a canvas, in a chip or written out.
pub fn names_canvas(text: &str) -> bool {
    text.contains("veistra://canvas/")
}

/// Whether `text` names Godot, or a scene or script of one, in a chip or
/// written out. Any case: people write "godot" and "Godot" alike.
pub fn names_godot(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("godot")
        || lower
            // A chip is `[@x.gd](<veistra://file/x.gd>)`, so split on what
            // surrounds a path rather than on whitespace alone.
            .split(|c: char| c.is_whitespace() || "()<>[]`'\",;:".contains(c))
            // A full stop or question mark after the name is the sentence's.
            .map(|word| word.trim_end_matches(['.', '?', '!']))
            .any(|word| word.ends_with(".gd") || word.ends_with(".tscn"))
}

// --- installing -------------------------------------------------------------

/// Who owns a skill folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    /// Nothing is there.
    Absent,
    /// Veistra's copy: it holds the [`MARKER`].
    Veistra,
    /// Something without the marker, which is the user's and never touched.
    User,
}

/// Who owns `dir`.
pub fn owner(dir: &Path) -> Owner {
    if dir.join(MARKER).is_file() {
        Owner::Veistra
    } else if dir.exists() {
        Owner::User
    } else {
        Owner::Absent
    }
}

/// Whether every file of `skill` in `dir` already has this build's bytes.
fn current(dir: &Path, skill: &Bundled) -> bool {
    skill
        .files
        .iter()
        .all(|f| std::fs::read(dir.join(f.path)).is_ok_and(|bytes| bytes == f.bytes))
}

/// Write `skill` into `dir` with the marker, replacing an out-of-date copy of
/// Veistra's. The caller has checked that `dir` is not the user's.
fn write_skill(dir: &Path, skill: &Bundled) -> io::Result<()> {
    if dir.join(MARKER).is_file() && current(dir, skill) {
        return Ok(());
    }
    if dir.exists() {
        // Only ever reached for Veistra's own copy: start clean, so a file a
        // later build dropped does not linger.
        std::fs::remove_dir_all(dir)?;
    }
    for file in skill.files {
        let path = dir.join(file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, file.bytes)?;
    }
    std::fs::write(dir.join(MARKER), MARKER_TEXT)
}

/// Install `skill` into the skills folder `parent`, unless the user has a
/// skill of that name there. Answers who owns the folder afterwards.
pub fn install(parent: &Path, skill: &Bundled) -> io::Result<Owner> {
    let dir = parent.join(skill.name);
    match owner(&dir) {
        Owner::User => Ok(Owner::User),
        Owner::Absent | Owner::Veistra => write_skill(&dir, skill).map(|()| Owner::Veistra),
    }
}

/// Remove `skill` from the skills folder `parent` if Veistra put it there.
/// Answers whether anything was removed.
pub fn uninstall(parent: &Path, skill: &Bundled) -> io::Result<bool> {
    let dir = parent.join(skill.name);
    if owner(&dir) != Owner::Veistra {
        return Ok(false);
    }
    std::fs::remove_dir_all(dir)?;
    Ok(true)
}

/// The Claude plugin folder holding exactly `skills`, under `root`, written
/// if it is missing or stale. One folder per set of skills, so two sessions
/// with different sets never share one.
pub fn claude_plugin(root: &Path, skills: &[&Bundled]) -> io::Result<PathBuf> {
    let mut names: Vec<&str> = skills.iter().map(|s| s.name).collect();
    names.sort_unstable();
    let dir = root.join(names.join("+"));
    let manifest = serde_json::json!({
        "name": PLUGIN_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Veistra's built-in skills.",
    });
    let manifest_path = dir.join(".claude-plugin").join("plugin.json");
    std::fs::create_dir_all(dir.join(".claude-plugin"))?;
    std::fs::write(&manifest_path, format!("{manifest:#}\n"))?;
    for skill in skills {
        write_skill(&dir.join("skills").join(skill.name), skill)?;
    }
    Ok(dir)
}

/// A folder of `skills`, each as `<name>/SKILL.md`, for a
/// [`SkillDelivery::SessionFolder`] harness: one folder per set of skills under
/// `root`, named like [`claude_plugin`]'s, so sessions given the same skills
/// share one. Answers the folder.
pub fn session_folder(root: &Path, skills: &[&Bundled]) -> io::Result<PathBuf> {
    let mut names: Vec<&str> = skills.iter().map(|s| s.name).collect();
    names.sort_unstable();
    let dir = root.join(names.join("+"));
    for skill in skills {
        write_skill(&dir.join(skill.name), skill)?;
    }
    Ok(dir)
}

/// The folder a [`SkillDelivery::UserSkills`] harness reads skills from:
/// `$<home_env>/skills` when that is set, else `<home>/<home_default>/skills`.
pub fn user_skills_dir(
    home_env: Option<OsString>,
    home: Option<&Path>,
    home_default: &str,
) -> Option<PathBuf> {
    let base = match home_env.filter(|v| !v.is_empty()) {
        Some(v) => PathBuf::from(v),
        None => home?.join(home_default),
    };
    Some(base.join("skills"))
}

/// The hint a [`SkillDelivery::Hint`] harness gets: each skill and the path
/// of its `SKILL.md`.
pub fn hint(skills: &[(&Bundled, PathBuf)]) -> String {
    let mut text = String::from(
        "Veistra gives this session built-in skills. Before work a skill \
                                 covers, read its SKILL.md and follow it:\n",
    );
    for (skill, skill_md) in skills {
        let about = frontmatter(skill.skill_md())
            .map(|f| f.description)
            .unwrap_or_default();
        text.push_str(&format!(
            "- {} ({}): {about}\n",
            skill.name,
            skill_md.display()
        ));
    }
    text
}

// --- equipping a launch -----------------------------------------------------

/// Where skills are put, passed in so a test never touches the real ones.
pub struct Places {
    /// Veistra's own folder for them, under its app data.
    pub data: PathBuf,
    /// The user's profile folder.
    pub home: Option<PathBuf>,
    /// Reads an environment variable.
    pub env: fn(&str) -> Option<OsString>,
}

impl Places {
    fn user_skills(&self, delivery: SkillDelivery) -> Option<PathBuf> {
        match delivery {
            SkillDelivery::UserSkills {
                home_env,
                home_default,
            } => user_skills_dir((self.env)(home_env), self.home.as_deref(), home_default),
            _ => None,
        }
    }
}

/// Give `launch` the skills in `skills`, the way its harness takes them.
/// Best effort: a skill that cannot be put in place is left out, and the
/// session starts anyway. Answers what went wrong, for the log.
pub fn equip(launch: &mut LaunchSpec, skills: &[&Bundled], places: &Places) -> Vec<String> {
    let mut problems = Vec::new();
    if skills.is_empty() {
        return problems;
    }
    let delivery = launch.harness.descriptor().skills;
    // Skills that fall back to a hint: every one for a `Hint` harness, and
    // any a `UserSkills` harness could not be given.
    let mut hinted: Vec<&Bundled> = Vec::new();
    match delivery {
        SkillDelivery::ClaudePlugin => match claude_plugin(&places.data.join("claude"), skills) {
            Ok(dir) => launch.plugins.push(dir),
            Err(e) => problems.push(format!("the Claude plugin folder: {e}")),
        },
        SkillDelivery::SessionFolder => {
            match session_folder(&places.data.join("veistra"), skills) {
                Ok(dir) => launch.plugins.push(dir),
                Err(e) => {
                    problems.push(format!("the session's skills folder: {e}"));
                    hinted.extend(skills);
                }
            }
        }
        SkillDelivery::UserSkills { .. } => {
            let Some(parent) = places.user_skills(delivery) else {
                problems.push("no profile folder to install skills into".into());
                hinted.extend(skills);
                return finish_hint(launch, &hinted, places, problems);
            };
            for &skill in skills {
                // `Owner::User` is fine too: the user's own copy is there.
                if let Err(e) = install(&parent, skill) {
                    problems.push(format!("{} into {}: {e}", skill.name, parent.display()));
                    hinted.push(skill);
                }
            }
        }
        SkillDelivery::Hint => hinted.extend(skills),
    }
    finish_hint(launch, &hinted, places, problems)
}

/// Write each hinted skill under Veistra's own folder and add the hint.
fn finish_hint(
    launch: &mut LaunchSpec,
    hinted: &[&Bundled],
    places: &Places,
    mut problems: Vec<String>,
) -> Vec<String> {
    let mut named = Vec::new();
    for &skill in hinted {
        let dir = places.data.join("files").join(skill.name);
        match write_skill(&dir, skill) {
            Ok(()) => named.push((skill, dir.join("SKILL.md"))),
            Err(e) => problems.push(format!("{} into {}: {e}", skill.name, dir.display())),
        }
    }
    if !named.is_empty() {
        launch.preamble = Some(hint(&named));
    }
    problems
}

// --- the app's side ---------------------------------------------------------

/// Where skills go on this machine.
fn places(app: &AppHandle) -> Option<Places> {
    Some(Places {
        data: app.path().app_data_dir().ok()?.join("built-in-skills"),
        home: app.path().home_dir().ok(),
        env: |name| std::env::var_os(name),
    })
}

/// A skill's mode, from its setting.
pub fn mode(app: &AppHandle, skill: &Bundled) -> Mode {
    Mode::parse(&crate::settings::text(app, skill.setting))
}

/// The skills a session with `signals` gets, by their settings.
pub fn for_session(app: &AppHandle, signals: &Signals) -> Vec<&'static Bundled> {
    BUNDLED
        .iter()
        .copied()
        .filter(|skill| wanted(skill, mode(app, skill), signals))
        .collect()
}

/// Give `launch` what [`for_session`] picks, logging anything that failed.
pub fn equip_live(app: &AppHandle, launch: &mut LaunchSpec, signals: &Signals) {
    let skills = for_session(app, signals);
    let Some(places) = places(app) else {
        return;
    };
    for problem in equip(launch, &skills, &places) {
        crate::veistra_log!("built-in skills: could not install {problem}");
    }
}

/// Bring the user-level copies in line with the settings: `On` installs into
/// every harness that takes skills that way, `Off` removes Veistra's copies,
/// and `Auto` leaves them for the next canvas session to install.
pub fn sync(app: &AppHandle) {
    let Some(places) = places(app) else {
        return;
    };
    for skill in BUNDLED {
        for problem in sync_one(skill, mode(app, skill), &places) {
            crate::veistra_log!("built-in skills: {problem}");
        }
    }
}

fn sync_one(skill: &Bundled, mode: Mode, places: &Places) -> Vec<String> {
    let mut problems = Vec::new();
    for descriptor in REGISTRY {
        let Some(parent) = places.user_skills(descriptor.skills) else {
            continue;
        };
        let done = match mode {
            Mode::On => install(&parent, skill).map(|_| ()),
            Mode::Off => uninstall(&parent, skill).map(|_| ()),
            Mode::Auto => Ok(()),
        };
        if let Err(e) = done {
            problems.push(format!("{} in {}: {e}", skill.name, parent.display()));
        }
    }
    problems
}

// --- the settings page ------------------------------------------------------

/// How a harness gets a skill, for the settings page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum How {
    /// A plugin folder passed per session.
    Plugin,
    /// A folder of skills passed per session.
    Folder,
    /// A copy in the harness's user skills folder.
    UserSkills,
    /// A hint in the first prompt.
    Hint,
}

/// Where one harness has a skill.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub harness: Harness,
    /// The harness's name, as the agent tab shows it.
    pub name: String,
    pub how: How,
    /// The folder the harness reads the skill from, if there is one.
    pub path: Option<String>,
    /// Who owns that folder now. `Absent` for a per-session route until a
    /// session has written it.
    pub owner: Owner,
}

/// One skill on the settings page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// The setting holding its mode, which the page draws inside its card.
    pub setting_key: String,
    pub mode: Mode,
    pub installs: Vec<Install>,
}

/// Every bundled skill and where each harness has it.
pub fn list(modes: impl Fn(&Bundled) -> Mode, places: &Places) -> Vec<SkillInfo> {
    BUNDLED
        .iter()
        .map(|skill| {
            let front = frontmatter(skill.skill_md());
            let installs = REGISTRY
                .iter()
                .map(|d| {
                    let (how, dir) = match d.skills {
                        SkillDelivery::ClaudePlugin => (
                            How::Plugin,
                            Some(
                                places
                                    .data
                                    .join("claude")
                                    .join(skill.name)
                                    .join("skills")
                                    .join(skill.name),
                            ),
                        ),
                        SkillDelivery::SessionFolder => (
                            How::Folder,
                            Some(
                                places
                                    .data
                                    .join("veistra")
                                    .join(skill.name)
                                    .join(skill.name),
                            ),
                        ),
                        SkillDelivery::UserSkills { .. } => (
                            How::UserSkills,
                            places.user_skills(d.skills).map(|p| p.join(skill.name)),
                        ),
                        SkillDelivery::Hint => {
                            (How::Hint, Some(places.data.join("files").join(skill.name)))
                        }
                    };
                    Install {
                        harness: d.harness,
                        name: d.name.to_string(),
                        how,
                        owner: dir.as_deref().map_or(Owner::Absent, owner),
                        path: dir.map(|p| p.to_string_lossy().into_owned()),
                    }
                })
                .collect();
            SkillInfo {
                name: front
                    .as_ref()
                    .map_or_else(|| skill.name.to_string(), |f| f.name.clone()),
                description: front.map(|f| f.description).unwrap_or_default(),
                setting_key: skill.setting.to_string(),
                mode: modes(skill),
                installs,
            }
        })
        .collect()
}

/// The settings page's Built-in skills section.
#[tauri::command]
pub fn builtin_skills(app: AppHandle) -> Vec<SkillInfo> {
    let Some(places) = places(&app) else {
        return Vec::new();
    };
    list(|skill| mode(&app, skill), &places)
}

#[cfg(test)]
mod tests {
    use super::*;
    use veistra_agent_host::{spec, Harness};

    /// A launch for `harness` without needing it on PATH: `spec` refuses
    /// one that is missing, so the fields that matter are set by hand.
    fn launch(harness: Harness) -> LaunchSpec {
        let dir = tempfile::tempdir().unwrap();
        let exe = |name: &str| {
            let file = dir.path().join(if cfg!(windows) {
                format!("{name}.cmd")
            } else {
                name.to_string()
            });
            std::fs::write(&file, b"").unwrap();
        };
        let d = harness.descriptor();
        exe(d.cli);
        exe(d.adapter.program);
        spec(
            harness,
            Some(dir.path().as_os_str()),
            Some(std::ffi::OsStr::new(".CMD")),
        )
        .unwrap()
    }

    fn places(root: &Path, codex_home: bool) -> Places {
        Places {
            data: root.join("data"),
            home: Some(root.join("home")),
            env: if codex_home {
                |name| (name == "CODEX_HOME").then(|| OsString::from("C:/nonexistent-codex"))
            } else {
                |_| None
            },
        }
    }

    /// The real folder, read at test time rather than baked in at compile
    /// time, so a shared target dir cannot point at another worktree.
    fn skills_source() -> PathBuf {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        Path::new(&manifest).join("..").join("skills")
    }

    #[test]
    fn every_bundled_skill_lists_exactly_the_files_in_its_folder() {
        for skill in BUNDLED {
            let root = skills_source().join(skill.name);
            let mut on_disk = Vec::new();
            let mut stack = vec![root.clone()];
            while let Some(dir) = stack.pop() {
                for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else {
                        let rel = path.strip_prefix(&root).unwrap();
                        on_disk.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            on_disk.sort();
            let mut listed: Vec<String> = skill.files.iter().map(|f| f.path.into()).collect();
            listed.sort();
            assert_eq!(listed, on_disk, "{}'s file list is out of date", skill.name);
            assert_eq!(skill.files[0].path, "SKILL.md");
        }
    }

    #[test]
    fn a_bundled_skill_has_frontmatter_naming_its_folder() {
        for skill in BUNDLED {
            let front = frontmatter(skill.skill_md()).expect("frontmatter");
            assert_eq!(front.name, skill.name);
            // Claude reads the frontmatter as YAML, where an unquoted value
            // holding ": " is a second key and the skill fails to load.
            assert!(!front.description.contains(": "), "{front:?}");
            assert!(!front.description.is_empty(), "{front:?}");
        }
        let description = |skill: &Bundled| frontmatter(skill.skill_md()).unwrap().description;
        assert!(description(&AGENT_READY_CANVAS).starts_with("Structure every"));
        assert!(description(&FINISH_GODOT_GAME).starts_with("Deliver a Godot game"));
    }

    #[test]
    fn the_godot_skill_md_makes_the_agent_finish_and_check_the_game() {
        let text = FINISH_GODOT_GAME.skill_md();
        // Finished: scenes use the scripts and one of them is the main scene.
        assert!(text.contains("run/main_scene"));
        assert!(text.contains("Do not stop when the scripts are written"));
        // Run with the executable Veistra hands over, under the name it uses.
        assert!(text.contains(crate::godot::AGENT_ENV));
        assert!(text.contains("--import"));
        assert!(text.contains("scripts/check_game.gd"));
        // Godot exits 0 after a script error, so the output has to be read.
        assert!(text.contains("SCRIPT ERROR"));
        assert!(text.contains("not just the exit code"));
        // Looked at, not only run, with the folder made first.
        assert!(text.contains("--write-movie"));
        assert!(text.contains("mkdir -p"));
        // And the person is told how to play it in Veistra.
        assert!(text.contains("F5"));
        assert!(text.contains("references/godot-text-formats.md"));
    }

    #[test]
    fn the_godot_checker_reports_problems_and_a_verdict() {
        let file = FINISH_GODOT_GAME
            .files
            .iter()
            .find(|f| f.path == "scripts/check_game.gd")
            .unwrap();
        let text = std::str::from_utf8(file.bytes).unwrap();
        assert!(text.starts_with("## "), "a doc comment, then the script");
        assert!(text.contains("extends SceneTree"), "it runs with -s");
        // The lines SKILL.md tells the agent to look for.
        for line in ["PROBLEM: ", "CHECK PASSED", "CHECK FAILED"] {
            assert!(text.contains(line), "{line}");
        }
        assert!(text.contains("application/run/main_scene"));
        assert!(text.contains("quit(1)"));
        // Godot before 4.5 has no Logger, and a script naming an unknown
        // class fails to parse there; so it is looked up, and the class
        // that extends it is source text compiled only when it exists.
        assert!(text.contains("ClassDB.class_exists(\"Logger\")"));
        assert!(!text
            .lines()
            .any(|l| l.trim_start().starts_with("extends Logger")));
    }

    #[test]
    fn frontmatter_reads_crlf_and_needs_a_name_and_a_close() {
        let text = "---\r\nname: x\r\ndescription: \"Does y: z\"\r\n---\r\nbody";
        assert_eq!(
            frontmatter(text),
            Some(Frontmatter {
                name: "x".into(),
                description: "Does y: z".into(),
            })
        );
        assert_eq!(frontmatter("name: x\n"), None, "no opening line");
        assert_eq!(frontmatter("---\nname: x\n"), None, "never closed");
        assert_eq!(frontmatter("---\ndescription: y\n---\n"), None, "no name");
    }

    #[test]
    fn the_skill_md_prefers_the_lint_canvas_tool() {
        let text = AGENT_READY_CANVAS.skill_md();
        assert!(text.contains("`lint_canvas`"));
        assert!(text.contains("`veistra-canvas`"));
        assert!(
            text.contains("canvas_lint.py"),
            "the script stays as a fallback"
        );
    }

    #[test]
    fn auto_is_on_for_godot_work_from_files_a_prompt_or_an_open_pane() {
        let none = Signals::default();
        let skill = &FINISH_GODOT_GAME;
        assert!(!wanted(skill, Mode::Auto, &none));
        let canvas = Signals {
            canvas_files: true,
            names_canvas: true,
            canvas_open: true,
            ..none
        };
        assert!(
            !wanted(skill, Mode::Auto, &canvas),
            "canvas work is not Godot"
        );
        assert!(!wanted(
            &AGENT_READY_CANVAS,
            Mode::Auto,
            &Signals {
                godot_files: true,
                names_godot: true,
                godot_open: true,
                ..none
            }
        ));
        for one in [
            Signals {
                godot_files: true,
                ..none
            },
            Signals {
                names_godot: true,
                ..none
            },
            Signals {
                godot_open: true,
                ..none
            },
        ] {
            assert!(wanted(skill, Mode::Auto, &one), "{one:?}");
            assert!(!wanted(skill, Mode::Off, &one));
        }
        assert!(wanted(skill, Mode::On, &none));
    }

    #[test]
    fn the_godot_path_goes_with_godot_work_or_the_skill_switched_on() {
        let none = Signals::default();
        let godot = Signals {
            names_godot: true,
            ..none
        };
        assert!(!godot_path_wanted(Mode::Auto, &none));
        assert!(godot_path_wanted(Mode::Auto, &godot));
        assert!(godot_path_wanted(Mode::On, &none), "the skill needs it");
        assert!(
            godot_path_wanted(Mode::Off, &godot),
            "any agent on a game can use it"
        );
        assert!(!godot_path_wanted(Mode::Off, &none));
    }

    #[test]
    fn a_prompt_names_godot_by_name_or_by_a_scene_or_script() {
        // Elijah's prompt named Godot, in an empty folder.
        assert!(names_godot("Make me a platformer in Godot"));
        assert!(names_godot("use GODOT 4"));
        assert!(names_godot(
            "Fix [@player.gd](<veistra://file/scripts/player.gd>)"
        ));
        assert!(names_godot("why does levels/one.tscn crash?"));
        assert!(names_godot("Look at main.tscn."));
        assert!(!names_godot("Make me a todo app"));
        assert!(!names_godot("the .gdignore file and the gds report"));
    }

    #[test]
    fn auto_is_on_for_canvas_work_and_the_others_are_fixed() {
        let none = Signals::default();
        let skill = &AGENT_READY_CANVAS;
        assert!(!wanted(skill, Mode::Auto, &none));
        for one in [
            Signals {
                canvas_files: true,
                ..none
            },
            Signals {
                names_canvas: true,
                ..none
            },
            Signals {
                canvas_open: true,
                ..none
            },
        ] {
            assert!(wanted(skill, Mode::Auto, &one), "{one:?}");
            assert!(!wanted(skill, Mode::Off, &one));
        }
        assert!(wanted(skill, Mode::On, &none));
        assert_eq!(Mode::parse("on"), Mode::On);
        assert_eq!(Mode::parse("off"), Mode::Off);
        assert_eq!(Mode::parse("auto"), Mode::Auto);
        assert_eq!(Mode::parse("bogus"), Mode::Auto);
    }

    #[test]
    fn canvas_files_are_json_under_canvas() {
        let root = tempfile::tempdir().unwrap();
        assert!(!has_canvas_files(root.path()));
        std::fs::create_dir_all(root.path().join("canvas/levels")).unwrap();
        std::fs::write(root.path().join("canvas/notes.txt"), "").unwrap();
        assert!(!has_canvas_files(root.path()), "only .json counts");
        std::fs::write(root.path().join("canvas/levels/one.json"), "{}").unwrap();
        assert!(has_canvas_files(root.path()));
        assert!(names_canvas("Fix [@Hub](<veistra://canvas/hub>)"));
        assert!(!names_canvas("Fix the canvas"));
    }

    #[test]
    fn install_writes_a_marked_copy_and_uninstall_removes_only_that() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("agent-ready-canvas");
        assert_eq!(
            install(parent.path(), &AGENT_READY_CANVAS).unwrap(),
            Owner::Veistra
        );
        assert!(dir.join(MARKER).is_file());
        assert!(dir.join("scripts/canvas_lint.py").is_file());
        assert!(current(&dir, &AGENT_READY_CANVAS));

        // A stale copy of Veistra's is replaced, and a dropped file goes.
        std::fs::write(dir.join("SKILL.md"), "old").unwrap();
        std::fs::write(dir.join("gone.md"), "old").unwrap();
        install(parent.path(), &AGENT_READY_CANVAS).unwrap();
        assert!(current(&dir, &AGENT_READY_CANVAS));
        assert!(!dir.join("gone.md").exists());

        assert!(uninstall(parent.path(), &AGENT_READY_CANVAS).unwrap());
        assert!(!dir.exists());
        assert!(!uninstall(parent.path(), &AGENT_READY_CANVAS).unwrap());
    }

    #[test]
    fn a_users_own_skill_of_the_same_name_is_never_touched() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("agent-ready-canvas");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "mine").unwrap();
        assert_eq!(
            install(parent.path(), &AGENT_READY_CANVAS).unwrap(),
            Owner::User
        );
        assert!(!uninstall(parent.path(), &AGENT_READY_CANVAS).unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "mine"
        );
        assert!(!dir.join(MARKER).exists());
    }

    #[test]
    fn claude_gets_a_plugin_folder_and_nothing_is_installed() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        let mut spec = launch(Harness::Claude);
        assert!(equip(&mut spec, &[&AGENT_READY_CANVAS], &places).is_empty());
        assert_eq!(spec.plugins.len(), 1);
        let plugin = &spec.plugins[0];
        assert!(plugin.starts_with(&places.data));
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "veistra");
        assert!(plugin.join("skills/agent-ready-canvas/SKILL.md").is_file());
        assert_eq!(spec.preamble, None);
        assert!(
            !root.path().join("home").exists(),
            "the profile is untouched"
        );
    }

    #[test]
    fn veistra_gets_a_folder_of_skills_for_the_session_and_nothing_is_installed() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        let mut spec = launch(Harness::Veistra);
        assert!(equip(&mut spec, &[&AGENT_READY_CANVAS], &places).is_empty());
        assert_eq!(spec.plugins.len(), 1);
        let folder = &spec.plugins[0];
        assert_eq!(
            folder,
            &places.data.join("veistra").join("agent-ready-canvas")
        );
        assert!(folder.join("agent-ready-canvas/SKILL.md").is_file());
        assert!(
            !folder.join(".claude-plugin").exists(),
            "not a Claude plugin"
        );
        assert_eq!(spec.preamble, None);
        assert!(
            !root.path().join("home").exists(),
            "the profile is untouched"
        );
        let listed = list(|_| Mode::Auto, &places);
        let install = listed[0]
            .installs
            .iter()
            .find(|i| i.harness == Harness::Veistra)
            .unwrap();
        assert_eq!(install.how, How::Folder);
        assert_eq!(
            install.path.as_deref(),
            Some(folder.join("agent-ready-canvas").to_string_lossy().as_ref())
        );
        assert_eq!(
            install.owner,
            Owner::Veistra,
            "written by the session above"
        );
    }

    #[test]
    fn codex_gets_a_marked_copy_in_its_user_skills_folder() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        let mut spec = launch(Harness::Codex);
        assert!(equip(&mut spec, &[&AGENT_READY_CANVAS], &places).is_empty());
        let dir = root.path().join("home/.codex/skills/agent-ready-canvas");
        assert!(dir.join("SKILL.md").is_file());
        assert!(dir.join(MARKER).is_file());
        assert!(spec.plugins.is_empty());
        assert_eq!(spec.preamble, None);
    }

    #[test]
    fn codex_home_moves_the_folder() {
        let dir = user_skills_dir(Some("D:/codex".into()), Some(Path::new("C:/u")), ".codex");
        assert_eq!(dir, Some(PathBuf::from("D:/codex").join("skills")));
        let dir = user_skills_dir(Some("".into()), Some(Path::new("C:/u")), ".codex");
        assert_eq!(dir, Some(Path::new("C:/u").join(".codex").join("skills")));
        assert_eq!(user_skills_dir(None, None, ".codex"), None);
        // `places` with CODEX_HOME set reads it.
        let root = tempfile::tempdir().unwrap();
        let with = places(root.path(), true);
        assert_eq!(
            with.user_skills(veistra_agent_host::harness::CODEX.skills),
            Some(PathBuf::from("C:/nonexistent-codex").join("skills"))
        );
    }

    #[test]
    fn a_hint_harness_gets_the_skill_md_path_in_its_preamble() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        let mut spec = launch(Harness::Claude);
        // No registered harness takes a hint yet, so the fallback is driven
        // directly, as `equip` does for a `Hint` harness.
        let problems = finish_hint(&mut spec, &[&AGENT_READY_CANVAS], &places, Vec::new());
        assert!(problems.is_empty(), "{problems:?}");
        let skill_md = places
            .data
            .join("files")
            .join("agent-ready-canvas")
            .join("SKILL.md");
        assert!(skill_md.is_file());
        let preamble = spec.preamble.unwrap();
        assert!(preamble.contains("agent-ready-canvas"), "{preamble}");
        assert!(
            preamble.contains(&skill_md.display().to_string()),
            "{preamble}"
        );
    }

    #[test]
    fn no_skills_leaves_the_launch_alone() {
        let root = tempfile::tempdir().unwrap();
        let mut spec = launch(Harness::Claude);
        assert!(equip(&mut spec, &[], &places(root.path(), false)).is_empty());
        assert!(spec.plugins.is_empty());
        assert!(!root.path().join("data").exists());
    }

    #[test]
    fn off_removes_veistras_copy_and_on_puts_it_back() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        let dir = root.path().join("home/.codex/skills/agent-ready-canvas");
        assert!(sync_one(&AGENT_READY_CANVAS, Mode::On, &places).is_empty());
        assert!(dir.join(MARKER).is_file());
        assert!(sync_one(&AGENT_READY_CANVAS, Mode::Auto, &places).is_empty());
        assert!(dir.exists(), "auto leaves it");
        assert!(sync_one(&AGENT_READY_CANVAS, Mode::Off, &places).is_empty());
        assert!(!dir.exists());
    }

    /// The checker against a real Godot 4: a game it passes, then the two
    /// ways Elijah's project could fail. CI has no Godot, so this runs only
    /// with `VEISTRA_TEST_GODOT` naming one (`cargo test -- --ignored`).
    #[test]
    #[ignore = "needs Godot 4: set VEISTRA_TEST_GODOT and run with --ignored"]
    fn the_godot_checker_passes_a_game_and_fails_scripts_without_a_main_scene() {
        let godot = PathBuf::from(std::env::var_os("VEISTRA_TEST_GODOT").expect("a Godot 4"));
        let dir = tempfile::tempdir().unwrap();
        let checker = dir.path().join("check_game.gd");
        let source = FINISH_GODOT_GAME
            .files
            .iter()
            .find(|f| f.path == "scripts/check_game.gd");
        std::fs::write(&checker, source.unwrap().bytes).unwrap();
        let game = dir.path().join("game");
        std::fs::create_dir_all(&game).unwrap();
        let write = |name: &str, text: &str| std::fs::write(game.join(name), text).unwrap();
        let project = "config_version=5\n\n[application]\n\nconfig/name=\"Dodge\"\n";
        write(
            "project.godot",
            &format!("{project}run/main_scene=\"res://main.tscn\"\n"),
        );
        write(
            "player.gd",
            "extends Node2D\n\nfunc _process(d: float) -> void:\n\tposition.x += d\n",
        );
        write(
            "main.tscn",
            "[gd_scene load_steps=2 format=3]\n\n\
             [ext_resource type=\"Script\" path=\"res://player.gd\" id=\"1\"]\n\n\
             [node name=\"Main\" type=\"Node2D\"]\n\n\
             [node name=\"Player\" type=\"Node2D\" parent=\".\"]\nscript = ExtResource(\"1\")\n",
        );
        let run = |args: &[&str]| {
            let out = std::process::Command::new(&godot)
                .args(["--headless", "--path"])
                .arg(&game)
                .args(args)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).into_owned()
                + &String::from_utf8_lossy(&out.stderr);
            (out.status.code(), text)
        };
        let check = || run(&["-s", checker.to_str().unwrap(), "--", "--frames", "10"]);
        assert_eq!(run(&["--import"]).0, Some(0));

        let (code, text) = check();
        assert_eq!(code, Some(0), "{text}");
        assert!(text.contains("ran res://main.tscn for 10 frames"), "{text}");
        assert!(text.contains("CHECK PASSED"), "{text}");

        write(
            "player.gd",
            "extends Node2D\n\nfunc _ready() -> void:\n\tprint(SPED)\n",
        );
        let (code, text) = check();
        assert_eq!(code, Some(1), "{text}");
        assert!(
            text.contains("PROBLEM: res://player.gd does not parse"),
            "{text}"
        );

        write("project.godot", project);
        let (code, text) = check();
        assert_eq!(code, Some(1), "{text}");
        assert!(text.contains("PROBLEM: no main scene"), "{text}");
        assert!(text.contains("CHECK FAILED"), "{text}");
    }

    #[test]
    fn claude_gets_one_plugin_folder_holding_both_skills() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        let mut spec = launch(Harness::Claude);
        let both = [&AGENT_READY_CANVAS, &FINISH_GODOT_GAME];
        assert!(equip(&mut spec, &both, &places).is_empty());
        assert_eq!(spec.plugins.len(), 1);
        let plugin = &spec.plugins[0];
        assert!(plugin.join("skills/agent-ready-canvas/SKILL.md").is_file());
        let godot = plugin.join("skills/finish-godot-game");
        assert!(godot.join("SKILL.md").is_file());
        assert!(godot.join("scripts/check_game.gd").is_file());
        assert!(godot.join("references/godot-text-formats.md").is_file());
    }

    #[test]
    fn the_listing_names_each_harness_and_its_folder() {
        let root = tempfile::tempdir().unwrap();
        let places = places(root.path(), false);
        install(&root.path().join("home/.codex/skills"), &AGENT_READY_CANVAS).unwrap();
        let list = list(|_| Mode::Auto, &places);
        let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["agent-ready-canvas", "finish-godot-game"]);
        let godot = &list[1];
        assert_eq!(godot.setting_key, keys::SKILLS_FINISH_GODOT_GAME);
        assert!(godot.description.starts_with("Deliver a Godot game"));
        let codex = godot.installs.iter().find(|i| i.harness == Harness::Codex);
        assert_eq!(
            codex.unwrap().owner,
            Owner::Absent,
            "only the canvas skill was installed"
        );
        let skill = &list[0];
        assert_eq!(skill.name, "agent-ready-canvas");
        assert_eq!(skill.setting_key, keys::SKILLS_AGENT_READY_CANVAS);
        assert_eq!(skill.mode, Mode::Auto);
        let claude = skill.installs.iter().find(|i| i.harness == Harness::Claude);
        let claude = claude.unwrap();
        assert_eq!((claude.how, claude.owner), (How::Plugin, Owner::Absent));
        let codex = skill.installs.iter().find(|i| i.harness == Harness::Codex);
        let codex = codex.unwrap();
        assert_eq!((codex.how, codex.owner), (How::UserSkills, Owner::Veistra));
        assert!(codex
            .path
            .as_deref()
            .unwrap()
            .ends_with("agent-ready-canvas"));
    }
}
