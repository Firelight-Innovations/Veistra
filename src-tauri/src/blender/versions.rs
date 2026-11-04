//! Every export of a `.blend` is kept as a numbered version (spec §11.3, §12;
//! DECISIONS X6), whether the person pressed Export or an agent asked for one:
//!
//! ```text
//! .veistra/exports/
//!   .gitignore            "*", so none of it reaches the environment's history
//!   bed-1a2b3c4d/         blender::slug of the .blend's relative path
//!     asset.json          {blend, next}: numbers are never handed out twice
//!     v6/
//!       model.glb
//!       renders/*.png
//!       export.log
//!       export.json       written last; a folder without it is not a version
//! ```
//!
//! The last [`KEEP`] are kept. On the read-only main checkout the same tree
//! lives under the app's data, keyed by a hash of the checkout's path, as
//! Play's takes do. Renders shows the newest; Compare (#319) reads them all
//! through `blender-viewer/export-versions`.

use super::job::{self, PartEntry, RenderEntry, ScriptResult};
use crate::godot::scene::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// How many versions of one `.blend` are kept.
pub const KEEP: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Author {
    Human,
    Agent,
}

/// `export.json`: one version, everything Renders and Compare show about it.
/// File names are relative to the version's folder, so a folder can be moved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub n: u32,
    /// The `.blend`, relative to the environment.
    pub blend: String,
    pub author: Author,
    /// Epoch milliseconds the version was written.
    pub time: u64,
    pub commit: Option<String>,
    pub branch: Option<String>,
    /// Counted from the `.glb` ([`glb_triangles`]); `None` when it has none or
    /// it could not be read.
    pub triangles: Option<u64>,
    /// The `.blend`'s bytes when the export started: the proof that an export
    /// never wrote to the file.
    pub blend_sha256: String,
    /// The `.blend`'s mtime when the export started, so a save that lands
    /// mid-export still reads as stale afterwards.
    pub blend_mtime: u64,
    /// The file was open in Blender in a pane ([`super::lock`]) while this
    /// was exported, so it is the saved file, not what was on screen.
    pub source_locked: bool,
    /// That Blender's file had unsaved changes, when it said.
    pub source_dirty: Option<bool>,
    pub engine: String,
    pub resolution: u32,
    pub blender_version: String,
    pub glb: Option<String>,
    pub glb_bytes: Option<u64>,
    /// Under `renders/`.
    pub renders: Vec<RenderEntry>,
    pub parts: Vec<PartEntry>,
    /// Each material's scalar and colour values, for Compare's per-material
    /// changes (spec §12.1).
    #[serde(default)]
    pub materials: Vec<Value>,
    pub stats: Value,
    pub warnings: Vec<String>,
}

impl Version {
    /// What is known before the run: the source and the settings. The rest is
    /// filled in by [`commit`].
    pub fn template(blend: &str, author: Author, engine: &str, resolution: u32) -> Self {
        Self {
            n: 0,
            blend: blend.to_string(),
            author,
            time: 0,
            commit: None,
            branch: None,
            triangles: None,
            blend_sha256: String::new(),
            blend_mtime: 0,
            source_locked: false,
            source_dirty: None,
            engine: engine.to_string(),
            resolution,
            blender_version: String::new(),
            glb: None,
            glb_bytes: None,
            renders: vec![],
            parts: vec![],
            materials: vec![],
            stats: Value::Null,
            warnings: vec![],
        }
    }
}

impl Version {
    /// This version in the shape the viewer has always read, with absolute
    /// paths under `dir`, its folder.
    pub fn as_manifest(&self, dir: &Path) -> super::Manifest {
        super::Manifest {
            blend: self.blend.clone(),
            blend_mtime: self.blend_mtime,
            exported_at: self.time,
            engine: self.engine.clone(),
            resolution: self.resolution,
            blender_version: self.blender_version.clone(),
            glb: self.glb.as_ref().map(|g| dir.join(g).display().to_string()),
            glb_bytes: self.glb_bytes,
            renders: self.renders.clone(),
            parts: self.parts.clone(),
            stats: self.stats.clone(),
            warnings: self.warnings.clone(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Asset {
    blend: String,
    next: u32,
}

/// `<project>/.veistra/exports`, or a folder under `outside` keyed by the
/// project's path ([`super::cache_root_in`]'s rule) for the read-only main.
pub fn exports_root(project: &Path, outside: Option<&Path>) -> PathBuf {
    match outside {
        None => project.join(".veistra").join("exports"),
        Some(dir) => dir.join("exports").join(super::project_hash(project)),
    }
}

/// One `.blend`'s versions.
pub fn asset_dir(project: &Path, rel: &str, outside: Option<&Path>) -> PathBuf {
    exports_root(project, outside).join(super::slug(rel))
}

pub fn version_dir(asset: &Path, n: u32) -> PathBuf {
    asset.join(format!("v{n}"))
}

/// The number of a `v<n>` folder name.
fn number(name: &str) -> Option<u32> {
    name.strip_prefix('v')?.parse().ok().filter(|n| *n > 0)
}

/// Every `v<n>` folder, finished or not, by number.
fn folders(asset: &Path) -> Vec<(u32, PathBuf)> {
    let mut found: Vec<(u32, PathBuf)> = std::fs::read_dir(asset)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((number(&e.file_name().to_string_lossy())?, e.path())))
        .collect();
    found.sort_by_key(|(n, _)| *n);
    found
}

pub fn read(asset: &Path, n: u32) -> Option<Version> {
    let raw = std::fs::read_to_string(version_dir(asset, n).join("export.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Every finished version, newest first.
pub fn list(asset: &Path) -> Vec<Version> {
    let mut all: Vec<Version> = folders(asset)
        .into_iter()
        .filter_map(|(n, _)| read(asset, n))
        .collect();
    all.reverse();
    all
}

pub fn newest(asset: &Path) -> Option<Version> {
    folders(asset)
        .into_iter()
        .rev()
        .find_map(|(n, _)| read(asset, n))
}

/// The next number: past the counter and past every folder, so a version that
/// was pruned, or half-written before a crash, is never numbered again.
pub fn next_number(asset: &Path) -> u32 {
    let counter = std::fs::read_to_string(asset.join("asset.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Asset>(&raw).ok())
        .map_or(1, |a| a.next.max(1));
    let past_folders = folders(asset).last().map_or(1, |(n, _)| n + 1);
    counter.max(past_folders)
}

/// Keep a finished run as the next version: reserve its number, move the
/// `.glb` and renders out of `pending`, copy the run's log, and write
/// `export.json` last. Then prune to [`KEEP`].
pub fn commit(
    asset: &Path,
    pending: &Path,
    result: &ScriptResult,
    log: Option<&Path>,
    template: Version,
) -> Result<Version, String> {
    let io = |what: &str, e: std::io::Error| format!("{what}: {e}");
    std::fs::create_dir_all(asset).map_err(|e| io("could not create the exports folder", e))?;
    if let Some(root) = asset.parent() {
        let _ = std::fs::write(root.join(".gitignore"), "*\n");
    }
    let n = next_number(asset);
    let counter = Asset {
        blend: template.blend.clone(),
        next: n + 1,
    };
    // The number is taken before anything else is written, so a crash part
    // way through leaves a gap and never two versions called v6.
    write_atomic(
        &asset.join("asset.json"),
        &serde_json::to_vec_pretty(&counter).map_err(|e| e.to_string())?,
    )?;

    let dir = version_dir(asset, n);
    let renders_dir = dir.join("renders");
    std::fs::create_dir_all(&renders_dir).map_err(|e| io("could not create the version", e))?;
    for render in &result.renders {
        super::move_file(&pending.join(&render.file), &renders_dir.join(&render.file))
            .map_err(|e| io("could not keep a render", e))?;
    }
    let (glb, glb_bytes, triangles) = match &result.glb {
        Some(name) => {
            let target = dir.join("model.glb");
            super::move_file(&pending.join(name), &target)
                .map_err(|e| io("could not keep the .glb", e))?;
            let bytes = std::fs::read(&target).ok();
            (
                Some("model.glb".to_string()),
                bytes.as_ref().map(|b| b.len() as u64),
                bytes.as_deref().and_then(glb_triangles),
            )
        }
        None => (None, None, None),
    };
    if let Some(log) = log {
        let _ = std::fs::copy(log, dir.join("export.log"));
    }

    let version = Version {
        n,
        time: job::now_ms(),
        triangles,
        blender_version: result.blender_version.clone(),
        glb,
        glb_bytes,
        renders: result.renders.clone(),
        parts: result.parts.clone(),
        materials: result.materials.clone(),
        stats: result.stats.clone(),
        warnings: result.warnings.clone(),
        ..template
    };
    let json = serde_json::to_vec_pretty(&version).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("export.json"), &json)?;
    retain(asset, KEEP);
    Ok(version)
}

/// Remove all but the newest `keep` finished versions, and any unfinished
/// folder older than the newest finished one (a run that died mid-commit).
pub fn retain(asset: &Path, keep: usize) {
    let all = folders(asset);
    let finished: Vec<u32> = all
        .iter()
        .filter(|(_, dir)| dir.join("export.json").is_file())
        .map(|(n, _)| *n)
        .collect();
    let newest = finished.last().copied().unwrap_or(0);
    let cut = finished.len().saturating_sub(keep);
    let drop: Vec<u32> = finished[..cut].to_vec();
    for (n, dir) in all {
        let unfinished = !finished.contains(&n) && n < newest;
        if drop.contains(&n) || unfinished {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// The SHA-256 of a file, hex.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Triangles in a binary glTF's default scene, every mesh counted once per
/// node that places it. `None` for anything that is not a GLB with a JSON
/// chunk. Only the JSON is read: a primitive's count is its index accessor's,
/// or its positions', and the mode says how many triangles that makes.
pub fn glb_triangles(bytes: &[u8]) -> Option<u64> {
    let word = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    if bytes.get(..4)? != b"glTF" || word(4)? != 2 {
        return None;
    }
    let length = word(12)? as usize;
    if word(16)? != 0x4E4F_534A {
        return None;
    }
    let doc: Value = serde_json::from_slice(bytes.get(20..20 + length)?).ok()?;

    let accessor_count = |i: &Value| -> u64 {
        i.as_u64()
            .and_then(|i| doc["accessors"].get(i as usize))
            .and_then(|a| a["count"].as_u64())
            .unwrap_or(0)
    };
    let mesh_triangles = |m: u64| -> u64 {
        let Some(prims) = doc["meshes"][m as usize]["primitives"].as_array() else {
            return 0;
        };
        prims
            .iter()
            .map(|p| {
                let count = if p.get("indices").is_some() {
                    accessor_count(&p["indices"])
                } else {
                    accessor_count(&p["attributes"]["POSITION"])
                };
                match p["mode"].as_u64().unwrap_or(4) {
                    4 => count / 3,
                    5 | 6 => count.saturating_sub(2),
                    _ => 0,
                }
            })
            .sum()
    };

    let scene = doc["scene"].as_u64().unwrap_or(0) as usize;
    let mut stack: Vec<u64> = match doc["scenes"][scene]["nodes"].as_array() {
        Some(roots) => roots.iter().filter_map(Value::as_u64).collect(),
        // No scene: every node that holds a mesh, once.
        None => (0..doc["nodes"].as_array().map_or(0, Vec::len) as u64).collect(),
    };
    let follow_children = doc["scenes"][scene]["nodes"].is_array();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    while let Some(i) = stack.pop() {
        if !seen.insert(i) {
            continue;
        }
        let node = &doc["nodes"][i as usize];
        if let Some(m) = node["mesh"].as_u64() {
            total += mesh_triangles(m);
        }
        if follow_children {
            if let Some(children) = node["children"].as_array() {
                stack.extend(children.iter().filter_map(Value::as_u64));
            }
        }
    }
    Some(total)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A GLB holding only `json`, padded as the format asks.
    pub(crate) fn glb_of(json: &Value) -> Vec<u8> {
        let mut body = serde_json::to_vec(json).unwrap();
        while body.len() % 4 != 0 {
            body.push(b' ');
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&((20 + body.len()) as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&0x4E4F_534Au32.to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    fn result_with(pending: &Path) -> ScriptResult {
        std::fs::create_dir_all(pending).unwrap();
        std::fs::write(pending.join("model.glb"), b"glb").unwrap();
        std::fs::write(pending.join("front.png"), b"png").unwrap();
        ScriptResult {
            glb: Some("model.glb".into()),
            renders: vec![RenderEntry {
                id: "front".into(),
                label: "front".into(),
                file: "front.png".into(),
            }],
            blender_version: "4.2.1".into(),
            ..ScriptResult::default()
        }
    }

    fn export(asset: &Path, scratch: &Path, author: Author) -> Version {
        let pending = scratch.join("pending");
        let result = result_with(&pending);
        let mut template = Version::template("props/bed.blend", author, "workbench", 256);
        template.blend_sha256 = "abc".into();
        template.blend_mtime = 42;
        template.commit = Some("1234567".into());
        commit(asset, &pending, &result, None, template).unwrap()
    }

    #[test]
    fn commit_moves_files_into_the_version_and_writes_export_json_last() {
        let env = TempDir::new().unwrap();
        let asset = asset_dir(env.path(), "props/bed.blend", None);
        let pending = env.path().join("scratch/pending");
        let result = result_with(&pending);
        let log = env.path().join("scratch/export.log");
        std::fs::write(&log, "hello from blender\n").unwrap();
        let template = Version::template("props/bed.blend", Author::Human, "workbench", 256);

        let v = commit(&asset, &pending, &result, Some(&log), template).unwrap();
        let dir = version_dir(&asset, 1);
        assert_eq!(v.n, 1);
        assert_eq!(v.glb.as_deref(), Some("model.glb"));
        assert_eq!(v.glb_bytes, Some(3));
        assert!(dir.join("model.glb").is_file());
        assert!(dir.join("renders/front.png").is_file());
        assert_eq!(
            std::fs::read_to_string(dir.join("export.log")).unwrap(),
            "hello from blender\n"
        );
        assert_eq!(read(&asset, 1), Some(v));
        assert!(!pending.join("model.glb").exists());
        assert_eq!(
            std::fs::read_to_string(env.path().join(".veistra/exports/.gitignore")).unwrap(),
            "*\n"
        );
    }

    #[test]
    fn export_json_has_commit_time_author_triangles() {
        let env = TempDir::new().unwrap();
        let asset = asset_dir(env.path(), "props/bed.blend", None);
        let v = export(&asset, env.path(), Author::Agent);
        let raw: Value = serde_json::from_slice(
            &std::fs::read(version_dir(&asset, 1).join("export.json")).unwrap(),
        )
        .unwrap();
        for key in [
            "n",
            "commit",
            "time",
            "author",
            "triangles",
            "blend",
            "blendSha256",
            "sourceLocked",
        ] {
            assert!(raw.get(key).is_some(), "export.json lacks {key}: {raw}");
        }
        assert_eq!(raw["author"], "agent");
        assert_eq!(raw["blend"], "props/bed.blend");
        assert_eq!(raw["commit"], "1234567");
        assert!(v.time > 0);
    }

    #[test]
    fn a_version_lists_relative_files_only() {
        let env = TempDir::new().unwrap();
        let asset = asset_dir(env.path(), "props/bed.blend", None);
        let v = export(&asset, env.path(), Author::Human);
        let raw = std::fs::read_to_string(version_dir(&asset, v.n).join("export.json")).unwrap();
        let root = env.path().display().to_string();
        assert!(!raw.contains(&root), "{raw}");
        assert_eq!(v.renders[0].file, "front.png");
    }

    #[test]
    fn ten_versions_are_kept() {
        let env = TempDir::new().unwrap();
        let asset = asset_dir(env.path(), "props/bed.blend", None);
        for _ in 0..12 {
            export(&asset, env.path(), Author::Human);
        }
        let ns: Vec<u32> = list(&asset).iter().map(|v| v.n).collect();
        assert_eq!(ns, (3..=12).rev().collect::<Vec<_>>());
        assert!(!version_dir(&asset, 2).exists());
        assert_eq!(newest(&asset).map(|v| v.n), Some(12));
    }

    #[test]
    fn numbers_continue_from_the_counter_after_pruning() {
        let env = TempDir::new().unwrap();
        let asset = asset_dir(env.path(), "props/bed.blend", None);
        for _ in 0..3 {
            export(&asset, env.path(), Author::Human);
        }
        // Every folder gone (pruned, or deleted by hand): the counter still
        // says 4, so no new export is mistaken for the old v1.
        for n in 1..=3 {
            std::fs::remove_dir_all(version_dir(&asset, n)).unwrap();
        }
        assert_eq!(export(&asset, env.path(), Author::Human).n, 4);
        // And a lost counter is rebuilt from the folders.
        std::fs::remove_file(asset.join("asset.json")).unwrap();
        assert_eq!(export(&asset, env.path(), Author::Human).n, 5);
    }

    #[test]
    fn an_unfinished_version_is_not_listed_and_is_cleared_once_a_later_one_lands() {
        let env = TempDir::new().unwrap();
        let asset = asset_dir(env.path(), "props/bed.blend", None);
        export(&asset, env.path(), Author::Human);
        std::fs::create_dir_all(version_dir(&asset, 2).join("renders")).unwrap();
        assert_eq!(list(&asset).len(), 1, "v2 has no export.json");
        assert_eq!(export(&asset, env.path(), Author::Human).n, 3);
        assert!(!version_dir(&asset, 2).exists());
    }

    #[test]
    fn exports_on_main_are_kept_outside_the_checkout_keyed_by_it() {
        let app = Path::new("/appdata");
        let a = asset_dir(Path::new("/repo"), "bed.blend", Some(app));
        assert!(a.starts_with("/appdata/exports"), "{}", a.display());
        assert_ne!(a, asset_dir(Path::new("/other"), "bed.blend", Some(app)));
        assert_eq!(
            asset_dir(Path::new("/repo"), "bed.blend", None),
            Path::new("/repo/.veistra/exports").join(super::super::slug("bed.blend"))
        );
    }

    #[test]
    fn triangles_are_counted_from_the_glb_scene() {
        // Mesh 0: an indexed triangle list of 36 indices (12 triangles),
        // placed twice, once as a child. Mesh 1: an unindexed strip of 5
        // positions (3 triangles). Mesh 2 is in no scene and does not count.
        let json = serde_json::json!({
            "scene": 0,
            "scenes": [{ "nodes": [0, 2] }],
            "nodes": [
                { "mesh": 0, "children": [1] },
                { "mesh": 0 },
                { "mesh": 1 },
                { "mesh": 2 }
            ],
            "meshes": [
                { "primitives": [{ "attributes": { "POSITION": 1 }, "indices": 0 }] },
                { "primitives": [{ "attributes": { "POSITION": 2 }, "mode": 5 }] },
                { "primitives": [{ "attributes": { "POSITION": 1 }, "indices": 0 }] }
            ],
            "accessors": [{ "count": 36 }, { "count": 24 }, { "count": 5 }]
        });
        assert_eq!(glb_triangles(&glb_of(&json)), Some(12 + 12 + 3));
        assert_eq!(glb_triangles(b"glb\n"), None);
        assert_eq!(glb_triangles(b""), None);
    }

    #[test]
    fn a_file_s_sha256_is_its_bytes() {
        let env = TempDir::new().unwrap();
        let file = env.path().join("bed.blend");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(
            sha256_file(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
