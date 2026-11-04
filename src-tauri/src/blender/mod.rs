//! Blender, as far as Veistra goes: find it, launch it, and run it headless.
//!
//! `docs/VEISTRA-UX-REWORK.md` §3.1: Blender is never embedded. Two things are
//! done with it. "Open in Blender" starts the real editor, detached, so closing
//! Veistra never closes a scene someone is editing. And an *export* runs
//! `blender -b` on a `.blend` with the bundled `export.py`, which writes a
//! `.glb`, a few preview renders and a parts list into a cache under
//! `<environment>/.veistra/blender/`. The viewer shows that cache and how old it
//! is; it never reads the live scene.
//!
//! The cache is Veistra state, so it is written even on a read-only `main`. A
//! `.glb` *into the checkout* (the `blender.exportDir` setting) is not, and is
//! refused there.

pub mod detect;
pub mod job;

use crate::settings::{Applies, Control, Group, SelectOption, Setting};
use job::{PartEntry, RenderEntry, ScriptResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

/// The script `blender -b` runs. Compiled in and written next to the cache on
/// every export, so the file on disk can never be older than the build.
pub const EXPORT_SCRIPT: &str = include_str!("export.py");

pub mod keys {
    pub const EXECUTABLE: &str = "blender.executable";
    pub const ENGINE: &str = "blender.engine";
    pub const RESOLUTION: &str = "blender.resolution";
    pub const EXPORT_DIR: &str = "blender.exportDir";
}

static ENGINES: &[SelectOption] = &[
    SelectOption {
        value: "workbench",
        label: "Workbench",
        description: "Fast and needs no lights. Best for checking shape and proportions.",
    },
    SelectOption {
        value: "eevee",
        label: "Eevee",
        description: "Shows materials and lighting. Slower, and adds a sun if the scene has none.",
    },
];

static SETTINGS_ROWS: &[Setting] = &[
    Setting {
        key: keys::EXECUTABLE,
        title: "Blender executable",
        description: "Leave empty to find Blender automatically (the BLENDER variable, PATH, \
                      Program Files, Steam). Set it to use a specific install; Blender 4.x is what \
                      the export is written for.",
        control: Control::Text {
            default: "",
            placeholder: "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
        },
        applies: Applies::Now,
    },
    Setting {
        key: keys::ENGINE,
        title: "Preview render engine",
        description: "How the preview images are drawn. The wireframe pass always uses Workbench.",
        control: Control::Select {
            default: "workbench",
            options: ENGINES,
        },
        applies: Applies::Next {
            what: "the next export",
        },
    },
    Setting {
        key: keys::RESOLUTION,
        title: "Preview size",
        description: "Width and height of each preview, in pixels.",
        control: Control::Number {
            default: 512,
            min: 128,
            max: 2048,
            step: 128,
            unit: "px",
        },
        applies: Applies::Next {
            what: "the next export",
        },
    },
    Setting {
        key: keys::EXPORT_DIR,
        title: "Export the .glb into",
        description: "A folder in the environment, relative to its root, for the exported .glb \
                      — a game's assets folder, say. Leave empty to keep the .glb in \
                      .veistra/blender/ with the previews. Refused on main, which is read-only.",
        control: Control::Text {
            default: "",
            placeholder: "assets/models",
        },
        applies: Applies::Next {
            what: "the next export",
        },
    },
];

pub static SETTINGS: Group = Group {
    id: "blender",
    title: "Blender",
    description: "The Blender Viewer, and how Veistra runs Blender for it.",
    order: 110,
    settings: SETTINGS_ROWS,
};

/// Keep a spawned console tool from flashing a window on Windows.
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Start the real Blender on a `.blend` and let go of it. On Windows it gets its
/// own process group and no console, so it survives Veistra and is not
/// affected by its console being closed.
pub fn launch_detached(exe: &Path, blend: &Path) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.arg(blend)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    // Reaped by a thread: a Child dropped without wait() is a zombie on unix
    // until this process exits.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// --- the cache --------------------------------------------------------------

pub fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// `<project>/.veistra/blender`.
pub fn cache_root(project: &Path) -> PathBuf {
    project.join(".veistra").join("blender")
}

/// Where a project's cache is: [`cache_root`], or, when `outside` names a
/// folder, a folder under it keyed by a hash of the project's path. The
/// read-only main checkout gets the second, as the Godot viewer's cache does:
/// nothing Veistra keeps may be written into main.
pub fn cache_root_in(project: &Path, outside: Option<&Path>) -> PathBuf {
    match outside {
        None => cache_root(project),
        Some(dir) => {
            let digest = Sha256::digest(project.to_string_lossy().as_bytes());
            let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
            dir.join("blender").join(hex)
        }
    }
}

/// The `.blend` path as written relative to the project, with forward slashes,
/// or `None` if it is not inside it. Never trusts a `..` in the input.
pub fn relative_blend(project: &Path, blend: &Path) -> Option<String> {
    let project = project.canonicalize().ok()?;
    let blend = blend.canonicalize().ok()?;
    if blend
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some("blend")
    {
        return None;
    }
    let rel = blend.strip_prefix(&project).ok()?;
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// One directory per `.blend`: readable stem, plus a hash of the relative path
/// so `a/bed.blend` and `b/bed.blend` never share a cache.
pub fn slug(rel: &str) -> String {
    let stem = Path::new(rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let digest = Sha256::digest(rel.as_bytes());
    let hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{clean}-{hash}")
}

/// One `.blend`'s cache under [`cache_root_in`].
pub fn cache_dir_in(project: &Path, rel: &str, outside: Option<&Path>) -> PathBuf {
    cache_root_in(project, outside).join(slug(rel))
}

/// What one successful export left behind: the whole of `export.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub blend: String,
    /// The `.blend`'s mtime when the export *started*, so a save that lands
    /// mid-export still reads as stale afterwards.
    pub blend_mtime: u64,
    pub exported_at: u64,
    pub engine: String,
    pub resolution: u32,
    pub blender_version: String,
    /// Absolute path of the exported `.glb`, if one was written.
    pub glb: Option<String>,
    pub glb_bytes: Option<u64>,
    pub renders: Vec<RenderEntry>,
    pub parts: Vec<PartEntry>,
    pub stats: Value,
    pub warnings: Vec<String>,
}

pub fn read_manifest(cache: &Path) -> Option<Manifest> {
    let raw = std::fs::read_to_string(cache.join("export.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The last markup drawn over a `.blend`'s 3D preview: the picture it was drawn
/// on and the JSON beside it. One pair per `.blend`, replaced each time.
pub use crate::godot::scene::Markup;

/// Keeps a markup in `cache` (`markup.png` + `markup.json`). The JSON goes
/// first so a failure between the two leaves an old picture with a newer note
/// rather than the reverse. Returns the epoch milliseconds it was written.
pub fn write_markup(cache: &Path, png: &[u8], json: &str) -> Result<u64, String> {
    use crate::godot::scene::{write_atomic, MAX_MARKUP_PNG};
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("the markup picture is not a PNG".to_string());
    }
    if png.len() > MAX_MARKUP_PNG {
        return Err(format!(
            "the markup picture is {:.1} MB; the limit is {} MB",
            png.len() as f64 / 1_048_576.0,
            MAX_MARKUP_PNG / 1024 / 1024
        ));
    }
    std::fs::create_dir_all(cache)
        .map_err(|e| format!("could not create {}: {e}", cache.display()))?;
    write_atomic(&cache.join("markup.json"), json.as_bytes())?;
    write_atomic(&cache.join("markup.png"), png)?;
    Ok(job::now_ms())
}

pub fn read_markup(cache: &Path) -> Option<Markup> {
    let png = std::fs::read(cache.join("markup.png")).ok()?;
    let json = std::fs::read_to_string(cache.join("markup.json")).ok()?;
    let saved_at = mtime_ms(&cache.join("markup.png")).unwrap_or(0);
    Some(Markup {
        png,
        json,
        saved_at,
    })
}

/// Where the `.glb` goes: `exportDir/<stem>.glb` when configured, otherwise the
/// cache. `exportDir` must stay inside the project.
pub fn glb_target(
    project: &Path,
    cache: &Path,
    rel: &str,
    export_dir: &str,
) -> Result<PathBuf, String> {
    let export_dir = export_dir.trim().trim_matches(['/', '\\']);
    if export_dir.is_empty() {
        return Ok(cache.join("model.glb"));
    }
    let dir = Path::new(export_dir);
    let escapes = dir.is_absolute()
        || dir.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        });
    if escapes {
        return Err(format!(
            "blender.exportDir `{export_dir}` must be a folder inside the environment"
        ));
    }
    let stem = Path::new(rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".into());
    Ok(project.join(dir).join(format!("{stem}.glb")))
}

/// Move a finished run's scratch output into place and write the manifest last,
/// so a reader never sees a manifest pointing at half-moved files.
pub fn commit(
    cache: &Path,
    pending: &Path,
    glb_target: &Path,
    result: &ScriptResult,
    manifest_base: Manifest,
) -> Result<Manifest, String> {
    let io = |what: &str, e: std::io::Error| format!("{what}: {e}");
    let renders_dir = cache.join("renders");
    std::fs::create_dir_all(&renders_dir).map_err(|e| io("could not create the cache", e))?;
    // Keeps the cache out of the environment's git history without touching
    // the environment's own .gitignore.
    let _ = std::fs::write(cache_root_of(cache).join(".gitignore"), "*\n");

    if let Ok(old) = std::fs::read_dir(&renders_dir) {
        for entry in old.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    for render in &result.renders {
        move_file(&pending.join(&render.file), &renders_dir.join(&render.file))
            .map_err(|e| io("could not keep a render", e))?;
    }

    let (glb, glb_bytes) = match &result.glb {
        Some(name) => {
            if let Some(dir) = glb_target.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| io("could not create the export folder", e))?;
            }
            move_file(&pending.join(name), glb_target)
                .map_err(|e| io("could not keep the .glb", e))?;
            let bytes = std::fs::metadata(glb_target).ok().map(|m| m.len());
            (Some(glb_target.display().to_string()), bytes)
        }
        None => (None, None),
    };

    let manifest = Manifest {
        glb,
        glb_bytes,
        renders: result.renders.clone(),
        parts: result.parts.clone(),
        stats: result.stats.clone(),
        warnings: result.warnings.clone(),
        blender_version: result.blender_version.clone(),
        exported_at: job::now_ms(),
        ..manifest_base
    };
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let tmp = cache.join("export.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| io("could not write the manifest", e))?;
    std::fs::rename(&tmp, cache.join("export.json"))
        .map_err(|e| io("could not write the manifest", e))?;
    Ok(manifest)
}

fn cache_root_of(cache: &Path) -> &Path {
    cache.parent().unwrap_or(cache)
}

/// `rename`, falling back to copy + remove across volumes.
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

// --- finding .blend files ---------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlendFile {
    pub path: String,
    pub rel: String,
    pub mtime: u64,
    pub size: u64,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".veistra",
    ".godot",
    "node_modules",
    "target",
    "dist",
    "build",
    "Library",
    "Intermediate",
];
const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 300;

/// Every `.blend` in the project, newest first. Bounded in depth and count so a
/// huge tree cannot hold up `blender-viewer/state`.
pub fn find_blends(project: &Path) -> Vec<BlendFile> {
    let mut found = Vec::new();
    let mut stack = vec![(project.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file() && name.to_ascii_lowercase().ends_with(".blend") {
                let Ok(meta) = entry.metadata() else { continue };
                let rel = path
                    .strip_prefix(project)
                    .map(|r| {
                        r.components()
                            .map(|c| c.as_os_str().to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                            .join("/")
                    })
                    .unwrap_or_else(|_| name.clone());
                found.push(BlendFile {
                    path: path.display().to_string(),
                    rel,
                    mtime: mtime_ms(&path).unwrap_or(0),
                    size: meta.len(),
                });
            }
        }
        if found.len() >= MAX_FILES {
            break;
        }
    }
    found.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.rel.cmp(&b.rel)));
    found.truncate(MAX_FILES);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn slugs_are_readable_and_distinguish_same_named_files() {
        let a = slug("art/bed.blend");
        let b = slug("props/bed.blend");
        assert!(a.starts_with("bed-"));
        assert_ne!(a, b);
        assert_eq!(a, slug("art/bed.blend"));
        assert!(slug("my bed (v2).blend").starts_with("my_bed__v2_-"));
    }

    #[test]
    fn a_blend_outside_the_project_or_of_another_type_has_no_relative_path() {
        let project = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        touch(&project.path().join("art/bed.blend"));
        touch(&project.path().join("art/bed.txt"));
        touch(&other.path().join("stray.blend"));

        assert_eq!(
            relative_blend(project.path(), &project.path().join("art/bed.blend")).as_deref(),
            Some("art/bed.blend")
        );
        assert_eq!(
            relative_blend(project.path(), &project.path().join("art/bed.txt")),
            None
        );
        assert_eq!(
            relative_blend(project.path(), &other.path().join("stray.blend")),
            None
        );
        assert_eq!(
            relative_blend(project.path(), &project.path().join("art/../art/bed.blend")).as_deref(),
            Some("art/bed.blend")
        );
    }

    #[test]
    fn find_blends_skips_caches_and_backups_and_sorts_newest_first() {
        let project = TempDir::new().unwrap();
        touch(&project.path().join("a.blend"));
        touch(&project.path().join("a.blend1"));
        touch(&project.path().join("node_modules/x/b.blend"));
        touch(&project.path().join(".veistra/blender/c.blend"));
        touch(&project.path().join("art/deep/d.BLEND"));
        let found = find_blends(project.path());
        let rels: Vec<_> = found.iter().map(|b| b.rel.as_str()).collect();
        assert!(rels.contains(&"a.blend") && rels.contains(&"art/deep/d.BLEND"));
        assert_eq!(rels.len(), 2, "{rels:?}");
    }

    #[test]
    fn the_glb_lands_in_the_cache_unless_an_export_folder_is_set() {
        let project = Path::new("/p");
        let cache = Path::new("/p/.veistra/blender/bed-1");
        assert_eq!(
            glb_target(project, cache, "art/bed.blend", "").unwrap(),
            cache.join("model.glb")
        );
        assert_eq!(
            glb_target(project, cache, "art/bed.blend", "assets/models/").unwrap(),
            project.join("assets/models").join("bed.glb")
        );
    }

    #[test]
    fn an_export_folder_cannot_leave_the_environment() {
        let project = Path::new("/p");
        let cache = Path::new("/p/c");
        assert!(glb_target(project, cache, "a.blend", "../outside").is_err());
        assert!(glb_target(project, cache, "a.blend", "a/../../b").is_err());
        #[cfg(windows)]
        assert!(glb_target(project, cache, "a.blend", "C:\\elsewhere").is_err());
    }

    #[test]
    fn commit_moves_files_into_place_and_writes_the_manifest_last() {
        let project = TempDir::new().unwrap();
        let cache = cache_dir_in(project.path(), "bed.blend", None);
        let pending = cache.join("pending");
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::write(pending.join("model.glb"), b"glb").unwrap();
        std::fs::write(pending.join("front.png"), b"png").unwrap();
        std::fs::create_dir_all(cache.join("renders")).unwrap();
        std::fs::write(cache.join("renders/stale.png"), b"old").unwrap();

        let result = ScriptResult {
            glb: Some("model.glb".into()),
            renders: vec![RenderEntry {
                id: "front".into(),
                label: "front".into(),
                file: "front.png".into(),
            }],
            blender_version: "4.2.1".into(),
            ..ScriptResult::default()
        };
        let base = Manifest {
            blend: "bed.blend".into(),
            blend_mtime: 42,
            exported_at: 0,
            engine: "workbench".into(),
            resolution: 256,
            blender_version: String::new(),
            glb: None,
            glb_bytes: None,
            renders: vec![],
            parts: vec![],
            stats: Value::Null,
            warnings: vec![],
        };
        let target = cache.join("model.glb");
        let manifest = commit(&cache, &pending, &target, &result, base).unwrap();

        assert_eq!(manifest.blend_mtime, 42);
        assert_eq!(manifest.glb_bytes, Some(3));
        assert!(cache.join("renders/front.png").is_file());
        assert!(!cache.join("renders/stale.png").exists());
        assert_eq!(read_manifest(&cache), Some(manifest));
        assert_eq!(
            std::fs::read_to_string(cache_root(project.path()).join(".gitignore")).unwrap(),
            "*\n"
        );
    }

    #[test]
    fn a_cache_kept_outside_is_keyed_by_the_project_and_never_inside_it() {
        let app = Path::new("/appdata");
        let a = cache_dir_in(Path::new("/repo"), "bed.blend", Some(app));
        let b = cache_dir_in(Path::new("/other"), "bed.blend", Some(app));
        assert!(a.starts_with("/appdata/blender"), "{}", a.display());
        assert!(!a.starts_with("/repo"));
        assert_ne!(a, b, "two checkouts never share one");
        assert_eq!(a, cache_dir_in(Path::new("/repo"), "bed.blend", Some(app)));
        assert_eq!(
            cache_dir_in(Path::new("/repo"), "bed.blend", None),
            cache_root(Path::new("/repo")).join(slug("bed.blend"))
        );
    }

    #[test]
    fn the_export_script_avoids_apis_blender_5_deprecates() {
        // `Material.use_nodes` warns once per material on 5.x and goes in 6.0;
        // found by running export.py in a real Blender 5.2.
        assert!(!EXPORT_SCRIPT.contains("use_nodes"));
    }
}
