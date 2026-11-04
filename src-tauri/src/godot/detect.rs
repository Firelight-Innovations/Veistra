//! Finding a Godot 4 executable, and the Godot projects inside an environment.
//!
//! Detection is a list of places to look in a fixed order, and the first
//! candidate that answers `--version` with a 4.x number wins. An explicit path
//! in settings is the exception to "first that works": it is authoritative, so
//! a wrong one is reported as wrong rather than quietly replaced by whatever
//! else happens to be installed.
//!
//! Everything here takes its inputs as arguments ([`Probe`], a directory)
//! rather than reading the process environment, so the tests build a tree of
//! fake installs in a tempdir and never depend on what the machine has.

use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Where a resolved executable came from, for the settings screen to say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Setting,
    Env,
    Path,
    Common,
    Steam,
}

/// Every input detection reads. [`Probe::from_system`] fills it from the real
/// machine; tests fill it by hand.
#[derive(Debug, Clone, Default)]
pub struct Probe {
    /// The `godot.executablePath` setting, empty when unset.
    pub setting: String,
    /// Values of `GODOT4` then `GODOT`, in that order, when set.
    pub env_paths: Vec<String>,
    pub path_dirs: Vec<PathBuf>,
    /// Folders people unpack or install Godot into, scanned for `Godot*`.
    pub common_dirs: Vec<PathBuf>,
    /// Steam library roots, each holding `steamapps/common/Godot Engine`.
    pub steam_libraries: Vec<PathBuf>,
}

impl Probe {
    pub fn from_system(setting: &str) -> Self {
        let env = |key: &str| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
        let home = env("USERPROFILE")
            .or_else(|| env("HOME"))
            .map(PathBuf::from);

        let mut common_dirs = Vec::new();
        let mut steam_libraries = Vec::new();
        if cfg!(windows) {
            for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
                if let Some(base) = env(var).map(PathBuf::from) {
                    common_dirs.push(base.join("Godot"));
                    common_dirs.push(base.join("Programs").join("Godot"));
                }
            }
            if let Some(local) = env("LOCALAPPDATA").map(PathBuf::from) {
                common_dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
            }
            common_dirs.push(PathBuf::from("C:/Godot"));
            common_dirs.push(PathBuf::from("C:/Tools/Godot"));
            if let Some(home) = &home {
                common_dirs.push(
                    home.join("scoop")
                        .join("apps")
                        .join("godot")
                        .join("current"),
                );
                common_dirs.push(home.join("Godot"));
                common_dirs.push(home.join("Downloads"));
                common_dirs.push(home.join("Desktop"));
            }
            for var in ["ProgramFiles(x86)", "ProgramFiles"] {
                if let Some(base) = env(var).map(PathBuf::from) {
                    steam_libraries.push(base.join("Steam"));
                }
            }
            steam_libraries.extend(steam_library_folders(Path::new(
                "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf",
            )));
        } else {
            common_dirs.push(PathBuf::from("/usr/bin"));
            common_dirs.push(PathBuf::from("/usr/local/bin"));
            common_dirs.push(PathBuf::from("/snap/bin"));
            common_dirs.push(PathBuf::from("/Applications"));
            if let Some(home) = &home {
                common_dirs.push(home.join(".local").join("bin"));
                common_dirs.push(home.join("Godot"));
                common_dirs.push(home.join("Downloads"));
                steam_libraries.push(home.join(".steam").join("steam"));
            }
        }

        Self {
            setting: setting.trim().to_string(),
            env_paths: ["GODOT4", "GODOT"].iter().filter_map(|k| env(k)).collect(),
            path_dirs: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            common_dirs,
            steam_libraries,
        }
    }
}

/// `libraryfolders.vdf` lines look like `"path" "D:\\SteamLibrary"`; that is
/// all this reads from it, so no VDF parser is needed.
pub fn steam_library_folders(vdf: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(vdf) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let mut quoted = line.split('"').skip(1).step_by(2);
            (quoted.next()? == "path").then(|| quoted.next().map(|v| v.replace("\\\\", "/")))?
        })
        .map(PathBuf::from)
        .collect()
}

/// What detection settled on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub path: PathBuf,
    pub source: Source,
    /// The line `--version` printed, e.g. `4.3.stable.official.77dcf97d8`.
    pub version: String,
    pub major: u32,
    pub minor: u32,
    /// The sibling that keeps a console attached, when the release ships one.
    /// A GUI-subsystem `godot.exe` writes nothing to a pipe, so a run whose log
    /// Veistra wants to read goes through this one instead.
    pub console: Option<PathBuf>,
}

impl Found {
    /// The program to run when the log matters.
    pub fn for_logging(&self) -> &Path {
        self.console.as_deref().unwrap_or(&self.path)
    }
}

/// The outcome of a search: at most one executable, and every reason the ones
/// that were tried did not qualify.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub found: Option<Found>,
    pub problems: Vec<String>,
}

/// What `--version` reports, split for the 4.x check.
pub fn parse_version(output: &str) -> Option<(u32, u32, String)> {
    output.lines().map(str::trim).find_map(|line| {
        let mut parts = line.split('.');
        let major = parts.next()?.parse::<u32>().ok()?;
        let minor = parts.next()?.parse::<u32>().ok()?;
        Some((major, minor, line.to_string()))
    })
}

/// The version number at the front of a `--version` line, as take.json
/// spells it: `4.5.1.stable.official.f62fdbde1` is `4.5.1`, and
/// `4.3.stable.official.77dcf97d8` is `4.3`. A line with no number in front
/// is kept whole rather than lost.
pub fn short_version(line: &str) -> String {
    let line = line.trim();
    let digits: Vec<&str> = line
        .split('.')
        .take_while(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        .collect();
    if digits.is_empty() {
        line.to_string()
    } else {
        digits.join(".")
    }
}

/// Run `path --version` and return what it printed. A candidate that hangs is
/// abandoned after `limit`, since a wrapper script waiting on a prompt would
/// otherwise stall the settings screen.
pub fn ask_version(path: &Path, limit: Duration) -> Result<String, String> {
    if !launchable(path) {
        return Err(format!(
            "{} is not a program Windows can run",
            path.display()
        ));
    }
    let mut child = base_command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", path.display()))?;

    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let mut bytes = Vec::new();
            let _ = out.read_to_end(&mut bytes);
            text = String::from_utf8_lossy(&bytes).into_owned();
        }
        text
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} did not answer --version in time",
                    path.display()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("could not wait for {}: {e}", path.display())),
        }
    }
    Ok(reader.join().unwrap_or_default())
}

/// A [`Command`] that will not flash a console window on Windows.
pub fn base_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// `CreateProcess` on an `.exe` that is not a real image raises a modal box
/// (see `runnable`), so `.exe` files are read before they are run. Anything
/// else - a `.cmd` shim, a unix binary - is left to fail normally.
fn launchable(path: &Path) -> bool {
    let is_exe = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    !cfg!(windows) || !is_exe || crate::runnable::is_image(path)
}

/// Find the executable. `check` answers `--version` for a path; production
/// passes [`ask_version`], tests pass a closure.
pub fn resolve(probe: &Probe, check: &dyn Fn(&Path) -> Result<String, String>) -> Resolution {
    let mut resolution = Resolution::default();

    if !probe.setting.is_empty() {
        for path in expand_entry(Path::new(&probe.setting)) {
            match accept(&path, Source::Setting, check) {
                Ok(found) => {
                    resolution.found = Some(found);
                    return resolution;
                }
                Err(problem) => resolution.problems.push(problem),
            }
        }
        if resolution.problems.is_empty() {
            resolution
                .problems
                .push(format!("{} does not exist", probe.setting));
        }
        return resolution;
    }

    let mut seen = HashSet::new();
    for (path, source) in candidates(probe) {
        if !seen.insert(path.clone()) {
            continue;
        }
        match accept(&path, source, check) {
            Ok(found) => {
                resolution.found = Some(found);
                return resolution;
            }
            Err(problem) => resolution.problems.push(problem),
        }
    }
    resolution
}

fn accept(
    path: &Path,
    source: Source,
    check: &dyn Fn(&Path) -> Result<String, String>,
) -> Result<Found, String> {
    let output = check(path)?;
    let (major, minor, version) = parse_version(&output)
        .ok_or_else(|| format!("{} did not report a Godot version", path.display()))?;
    if major < 4 {
        return Err(format!(
            "{} is Godot {version}; Veistra drives Godot 4.x",
            path.display()
        ));
    }
    Ok(Found {
        console: console_sibling(path),
        path: path.to_path_buf(),
        source,
        version,
        major,
        minor,
    })
}

/// Every place worth trying, best first.
fn candidates(probe: &Probe) -> Vec<(PathBuf, Source)> {
    let mut out = Vec::new();
    for entry in &probe.env_paths {
        out.extend(
            expand_entry(Path::new(entry))
                .into_iter()
                .map(|p| (p, Source::Env)),
        );
    }
    let names: &[&str] = if cfg!(windows) {
        &["godot4.exe", "godot.exe", "godot4.cmd", "godot.cmd"]
    } else {
        &["godot4", "godot"]
    };
    for dir in &probe.path_dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                out.push((candidate, Source::Path));
            }
        }
    }
    for dir in &probe.common_dirs {
        out.extend(scan_dir(dir).into_iter().map(|p| (p, Source::Common)));
    }
    for library in &probe.steam_libraries {
        let dir = library
            .join("steamapps")
            .join("common")
            .join("Godot Engine");
        out.extend(scan_dir(&dir).into_iter().map(|p| (p, Source::Steam)));
    }
    out
}

/// A setting or environment value may name the program, a folder holding it, or
/// (macOS) the `.app` bundle.
fn expand_entry(entry: &Path) -> Vec<PathBuf> {
    if entry.is_file() {
        return vec![entry.to_path_buf()];
    }
    if entry.is_dir() {
        let is_app = entry.extension().is_some_and(|e| e == "app");
        if is_app {
            let inner = entry.join("Contents").join("MacOS").join("Godot");
            return if inner.is_file() {
                vec![inner]
            } else {
                Vec::new()
            };
        }
        return scan_dir(entry);
    }
    Vec::new()
}

/// Godot programs directly inside `dir`, newest name first so `v4.4` is tried
/// before `v4.3`.
fn scan_dir(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && looks_like_godot(p))
        .collect();
    found.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    // A macOS bundle sitting in the folder is a directory, so `is_file` skipped it.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_bundle = path.extension().is_some_and(|e| e == "app")
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().to_lowercase().starts_with("godot"));
            if is_bundle {
                found.extend(expand_entry(&path));
            }
        }
    }
    found
}

fn looks_like_godot(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !name.starts_with("godot") || name.contains("console") || name.contains("crash") {
        return false;
    }
    if cfg!(windows) {
        name.ends_with(".exe")
    } else {
        // Release binaries are `Godot_v4.3-stable_linux.x86_64`; a `.zip` or
        // `.txt` beside them must not be run.
        !["zip", "txt", "md", "gz", "tpz", "sha512"]
            .iter()
            .any(|ext| name.ends_with(&format!(".{ext}")))
    }
}

/// `..._win64.exe` ships beside `..._win64_console.exe`, and `godot.exe` beside
/// `godot.console.exe` in a few packagings.
fn console_sibling(path: &Path) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    ["_console", ".console"]
        .iter()
        .map(|suffix| path.with_file_name(format!("{stem}{suffix}.exe")))
        .find(|p| p.is_file())
}

// --- projects ---------------------------------------------------------------

/// One `project.godot` inside an environment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodotProject {
    /// Absolute folder holding `project.godot`.
    pub dir: PathBuf,
    /// The folder relative to the environment root, `.` for the root itself.
    pub rel: String,
    pub name: String,
    /// `run/main_scene` as written, which is a `uid://` reference in 4.4+.
    pub main_scene: Option<String>,
    /// The `res://` path that reference points at, when it could be worked out.
    pub main_scene_path: Option<String>,
    pub config_version: Option<u32>,
    /// 3 for `config_version` 4 and below, otherwise 4.
    pub engine_major: u32,
}

/// The fields of `project.godot` Veistra reads. It is an INI dialect, and only
/// three keys matter, so this reads lines rather than pulling in a parser.
#[derive(Debug, Default, PartialEq)]
pub struct ProjectFile {
    pub name: Option<String>,
    pub main_scene: Option<String>,
    pub config_version: Option<u32>,
}

pub fn parse_project_file(text: &str) -> ProjectFile {
    let mut file = ProjectFile::default();
    let mut section = String::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = name.to_string();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match (section.as_str(), key) {
            ("", "config_version") => file.config_version = value.parse().ok(),
            ("application", "config/name") => file.name = Some(unquote(value)),
            ("application", "run/main_scene") => file.main_scene = Some(unquote(value)),
            _ => {}
        }
    }
    file
}

fn unquote(value: &str) -> String {
    let inner = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    inner.replace("\\\"", "\"").replace("\\\\", "\\")
}

/// Folders never worth descending into when looking for a project.
const SKIP: &[&str] = &[
    ".git",
    ".godot",
    ".import",
    "node_modules",
    ".veistra",
    "target",
    "addons",
];

/// How far below the environment root a project may sit.
const MAX_DEPTH: usize = 4;

/// Every folder at or below `root` that holds a `project.godot`, shallowest
/// first. A project inside another project's folder is a nested project and is
/// reported too, since Godot treats it as its own.
pub fn find_projects(root: &Path) -> Vec<GodotProject> {
    let mut dirs = Vec::new();
    walk(root, 0, &mut |dir| {
        if dir.join("project.godot").is_file() {
            dirs.push(dir.to_path_buf());
        }
    });
    dirs.sort_by_key(|d| (d.components().count(), d.clone()));
    dirs.into_iter().map(|dir| describe(root, dir)).collect()
}

fn walk(dir: &Path, depth: usize, visit: &mut dyn FnMut(&Path)) {
    visit(dir);
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() && !SKIP.contains(&name.as_str()) && !name.starts_with('.') {
            walk(&path, depth + 1, visit);
        }
    }
}

fn describe(root: &Path, dir: PathBuf) -> GodotProject {
    let text = std::fs::read_to_string(dir.join("project.godot")).unwrap_or_default();
    let file = parse_project_file(&text);
    let rel = dir
        .strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let main_scene_path = file.main_scene.as_deref().and_then(|scene| {
        if scene.starts_with("res://") {
            Some(scene.to_string())
        } else {
            resolve_uid(&dir, scene)
        }
    });
    GodotProject {
        name: file
            .name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| folder_name(&dir)),
        rel: if rel.is_empty() { ".".to_string() } else { rel },
        main_scene: file.main_scene,
        main_scene_path,
        config_version: file.config_version,
        engine_major: if file.config_version.is_some_and(|v| v <= 4) {
            3
        } else {
            4
        },
        dir,
    }
}

fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string())
}

/// Godot 4.4 writes `run/main_scene="uid://..."`. The uid is in the header line
/// of the scene it names, so finding the scene is a scan of scene headers.
fn resolve_uid(project: &Path, uid: &str) -> Option<String> {
    scenes(project).into_iter().find(|scene| {
        scene_uid(&project.join(scene.trim_start_matches("res://"))).as_deref() == Some(uid)
    })
}

fn scene_uid(path: &Path) -> Option<String> {
    let mut head = [0u8; 512];
    let n = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head[..n]);
    let line = text.lines().next()?;
    let start = line.find("uid=\"")? + 5;
    let end = line[start..].find('"')?;
    Some(line[start..start + end].to_string())
}

/// Every `.tscn` in the project as a `res://` path, sorted. Capped so a project
/// with a generated asset tree cannot make this the slowest call in the pane.
pub fn scenes(project: &Path) -> Vec<String> {
    const CAP: usize = 2000;
    let mut out = Vec::new();
    collect_scenes(project, project, 0, &mut out);
    out.sort();
    out.truncate(CAP);
    out
}

fn collect_scenes(project: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 12 || out.len() > 4000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !SKIP.contains(&name.as_str()) && !name.starts_with('.') {
                collect_scenes(project, &path, depth + 1, out);
            }
        } else if name.ends_with(".tscn") {
            if let Ok(rel) = path.strip_prefix(project) {
                out.push(format!(
                    "res://{}",
                    rel.to_string_lossy().replace('\\', "/")
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    fn answers(version: &'static str) -> impl Fn(&Path) -> Result<String, String> {
        move |_| Ok(version.to_string())
    }

    #[test]
    fn version_lines_parse_and_noise_before_them_is_skipped() {
        assert_eq!(
            parse_version("4.3.stable.official.77dcf97d8\n"),
            Some((4, 3, "4.3.stable.official.77dcf97d8".to_string()))
        );
        assert_eq!(
            parse_version("warning\n3.5.2.stable\n").map(|v| v.0),
            Some(3)
        );
        assert_eq!(parse_version("not a version"), None);
    }

    #[test]
    fn an_explicit_setting_wins_and_a_bad_one_is_reported_not_replaced() {
        let dir = TempDir::new().unwrap();
        let mine = dir.path().join("mine").join("godot-x");
        touch(&mine);
        let other = dir.path().join("bin");
        touch(&other.join(if cfg!(windows) { "godot.exe" } else { "godot" }));

        let mut probe = Probe {
            setting: mine.display().to_string(),
            path_dirs: vec![other.clone()],
            ..Probe::default()
        };
        let got = resolve(&probe, &answers("4.2.1.stable"));
        assert_eq!(got.found.as_ref().map(|f| f.source), Some(Source::Setting));

        let got = resolve(&probe, &answers("3.5.stable"));
        assert!(got.found.is_none(), "the setting is authoritative");
        assert!(got.problems[0].contains("Veistra drives Godot 4.x"));

        probe.setting = dir.path().join("missing").display().to_string();
        let got = resolve(&probe, &answers("4.2.stable"));
        assert!(got.found.is_none());
        assert!(got.problems[0].contains("does not exist"));
    }

    #[test]
    fn env_then_path_then_common_dirs_are_tried_in_that_order() {
        let dir = TempDir::new().unwrap();
        let name = if cfg!(windows) { "godot.exe" } else { "godot" };
        let on_path = dir.path().join("path");
        let from_env = dir.path().join("env").join("godot-env");
        let common = dir.path().join("common");
        touch(&on_path.join(name));
        touch(&from_env);
        touch(&common.join(if cfg!(windows) {
            "Godot_v4.3.exe"
        } else {
            "Godot_v4.3"
        }));

        let mut probe = Probe {
            env_paths: vec![from_env.display().to_string()],
            path_dirs: vec![on_path],
            common_dirs: vec![common],
            ..Probe::default()
        };
        let got = resolve(&probe, &answers("4.3.stable")).found.unwrap();
        assert_eq!(got.source, Source::Env);

        probe.env_paths.clear();
        assert_eq!(
            resolve(&probe, &answers("4.3.stable"))
                .found
                .unwrap()
                .source,
            Source::Path
        );

        probe.path_dirs.clear();
        assert_eq!(
            resolve(&probe, &answers("4.3.stable"))
                .found
                .unwrap()
                .source,
            Source::Common
        );
    }

    #[test]
    fn a_godot_3_install_is_skipped_for_a_later_godot_4_one() {
        let dir = TempDir::new().unwrap();
        let ext = if cfg!(windows) { ".exe" } else { "" };
        touch(&dir.path().join(format!("Godot_v4.3{ext}")));
        touch(&dir.path().join(format!("Godot_v3.5{ext}")));
        let probe = Probe {
            common_dirs: vec![dir.path().to_path_buf()],
            ..Probe::default()
        };
        let check = |p: &Path| {
            Ok(if p.to_string_lossy().contains("v3.5") {
                "3.5.stable"
            } else {
                "4.3.stable"
            }
            .to_string())
        };
        let got = resolve(&probe, &check);
        assert!(got.found.unwrap().path.to_string_lossy().contains("v4.3"));
        assert_eq!(
            got.problems.len(),
            0,
            "v4.3 sorts first and wins before v3.5 is asked"
        );
    }

    #[test]
    fn a_steam_library_is_scanned_for_the_engine_folder() {
        let dir = TempDir::new().unwrap();
        let ext = if cfg!(windows) { ".exe" } else { "" };
        touch(
            &dir.path()
                .join("steamapps")
                .join("common")
                .join("Godot Engine")
                .join(format!("godot.windows.opt.tools.64{ext}")),
        );
        let probe = Probe {
            steam_libraries: vec![dir.path().to_path_buf()],
            ..Probe::default()
        };
        assert_eq!(
            resolve(&probe, &answers("4.4.stable"))
                .found
                .map(|f| f.source),
            Some(Source::Steam)
        );
    }

    #[test]
    fn steam_library_folders_reads_path_lines() {
        let dir = TempDir::new().unwrap();
        let vdf = dir.path().join("libraryfolders.vdf");
        std::fs::write(
            &vdf,
            "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t\t\"label\"\t\t\"\"\n\t}\n}\n",
        )
        .unwrap();
        assert_eq!(
            steam_library_folders(&vdf),
            vec![PathBuf::from("D:/SteamLibrary")]
        );
    }

    #[test]
    fn a_missing_install_yields_no_executable_and_no_crash() {
        let got = resolve(&Probe::default(), &answers("4.3.stable"));
        assert!(got.found.is_none());
    }

    #[test]
    fn project_files_parse_name_main_scene_and_config_version() {
        let file = parse_project_file(
            "; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name=\"Hospital \\\"Wing\\\"\"\nrun/main_scene=\"res://scenes/main.tscn\"\n\n[rendering]\nrun/main_scene=\"nope\"\n",
        );
        assert_eq!(file.config_version, Some(5));
        assert_eq!(file.name.as_deref(), Some("Hospital \"Wing\""));
        assert_eq!(file.main_scene.as_deref(), Some("res://scenes/main.tscn"));
    }

    #[test]
    fn projects_are_found_at_the_root_and_below_but_not_in_skipped_folders() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("project.godot"),
            "config_version=5\n[application]\nconfig/name=\"Root\"\n",
        )
        .unwrap();
        for sub in [
            "game",
            "tools/editor-plugin",
            ".godot/inner",
            "node_modules/x",
            "addons/y",
        ] {
            touch(&dir.path().join(sub).join("project.godot"));
        }
        let found = find_projects(dir.path());
        let rels: Vec<&str> = found.iter().map(|p| p.rel.as_str()).collect();
        assert_eq!(rels, vec![".", "game", "tools/editor-plugin"]);
        assert_eq!(found[0].name, "Root");
        assert_eq!(
            found[1].name, "game",
            "a project with no name takes its folder's"
        );
    }

    #[test]
    fn a_uid_main_scene_resolves_through_scene_headers_and_godot_3_is_flagged() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("project.godot"),
            "config_version=5\n[application]\nrun/main_scene=\"uid://abc123\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("levels")).unwrap();
        std::fs::write(
            dir.path().join("levels/one.tscn"),
            "[gd_scene load_steps=2 format=3 uid=\"uid://abc123\"]\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("other.tscn"),
            "[gd_scene format=3 uid=\"uid://zzz\"]\n",
        )
        .unwrap();

        let project = &find_projects(dir.path())[0];
        assert_eq!(
            project.main_scene_path.as_deref(),
            Some("res://levels/one.tscn")
        );
        assert_eq!(project.engine_major, 4);

        std::fs::write(dir.path().join("project.godot"), "config_version=4\n").unwrap();
        assert_eq!(find_projects(dir.path())[0].engine_major, 3);
    }

    /// examples/godot-demo, the game the design's acceptance runs use, is
    /// found the way Play finds any project, from the checkout's root too.
    #[test]
    fn the_demo_game_is_a_godot_4_project_that_starts_in_the_hallway() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let demo = repo.join("examples/godot-demo");
        let found = find_projects(&demo);
        assert_eq!(found.len(), 1);
        let project = &found[0];
        assert_eq!(project.rel, ".");
        assert_eq!(project.name, "Godot demo");
        assert_eq!(project.config_version, Some(5));
        assert_eq!(project.engine_major, 4);
        assert_eq!(
            project.main_scene_path.as_deref(),
            Some("res://levels/hallway.tscn")
        );
        assert_eq!(
            scenes(&demo),
            [
                "res://levels/arena_2d.tscn",
                "res://levels/bench.tscn",
                "res://levels/hallway.tscn"
            ]
        );
        assert!(
            find_projects(&repo)
                .iter()
                .any(|p| p.rel == "examples/godot-demo"),
            "a pane open on Veistra's own checkout lists it"
        );
    }

    #[test]
    fn scenes_are_listed_as_res_paths() {
        let dir = TempDir::new().unwrap();
        touch(&dir.path().join("a/b.tscn"));
        touch(&dir.path().join("main.tscn"));
        touch(&dir.path().join("addons/x/skip.tscn"));
        touch(&dir.path().join(".godot/skip.tscn"));
        assert_eq!(
            scenes(dir.path()),
            vec!["res://a/b.tscn", "res://main.tscn"]
        );
    }

    #[test]
    fn a_take_names_the_version_number_and_keeps_the_build_apart() {
        assert_eq!(short_version("4.5.1.stable.official.f62fdbde1"), "4.5.1");
        assert_eq!(short_version("4.3.stable.official.77dcf97d8"), "4.3");
        assert_eq!(short_version(" 4.4.1.rc2.mono.official.x\n"), "4.4.1");
        assert_eq!(short_version("4.6.dev.custom_build"), "4.6");
        assert_eq!(short_version("custom"), "custom");
        assert_eq!(short_version(""), "");
    }
}
