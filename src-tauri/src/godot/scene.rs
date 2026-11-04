//! What the Godot Viewer shows: a scene's node tree, and optionally a rendered
//! frame, cached and stamped with when they were produced.
//!
//! Three sources, each labelled honestly in what it returns:
//!
//! * **headless** - `godot --headless -s dump_scene.gd` loads the scene and
//!   walks it. The truth about what the engine builds, including nodes made by
//!   scripts' `_init`. This is the primary path.
//! * **parsed** - the `.tscn` text read directly. Used only when no Godot 4 is
//!   installed or the headless run failed, and marked so, because a text scene
//!   cannot show nodes a script adds at runtime.
//! * **render** - a frame. `--headless` selects the dummy renderer and draws
//!   nothing, so a picture needs a real display driver: Movie Maker mode
//!   (`--write-movie`) opens a window for a few frames and writes PNGs. It is a
//!   separate, explicit action, and it is not headless.

use super::detect::{base_command, Found};
use super::runner::{kill_tree, now_ms};
use crate::sync::MutexExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DUMP_SCRIPT: &str = include_str!("dump_scene.gd");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub children: Vec<Node>,
    /// The `res://` script attached to this node, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    /// The scene this node is an instance of, when it is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Headless,
    Parsed,
}

/// The cached result for one scene: `scene.json` beside an optional `frame.png`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cached {
    pub rendered_at: u64,
    pub scene_path: String,
    pub source: Source,
    pub godot: Option<String>,
    pub nodes: Vec<Node>,
    pub image_at: Option<u64>,
    /// Why the headless run was not used, when this is a parse.
    #[serde(default)]
    pub note: Option<String>,
}

fn scene_dir(cache: &Path, scene: &str) -> PathBuf {
    let slug: String = scene
        .trim_start_matches("res://")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    cache.join(slug)
}

pub fn read_cached(cache: &Path, scene: &str) -> Option<Cached> {
    let text = std::fs::read_to_string(scene_dir(cache, scene).join("scene.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn read_image(cache: &Path, scene: &str) -> Option<Vec<u8>> {
    std::fs::read(scene_dir(cache, scene).join("frame.png")).ok()
}

fn write_cached(cache: &Path, scene: &str, cached: &Cached) -> Result<(), String> {
    let dir = scene_dir(cache, scene);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(cached).map_err(|e| e.to_string())?;
    let tmp = dir.join("scene.json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("scene.json")).map_err(|e| e.to_string())
}

/// The last markup drawn over a scene: the picture it was drawn on and the JSON
/// beside it. One pair per scene, overwritten in place, so marking up again
/// replaces rather than accumulates.
#[derive(Debug, PartialEq)]
pub struct Markup {
    pub png: Vec<u8>,
    pub json: String,
    /// Epoch milliseconds the picture was written.
    pub saved_at: u64,
}

/// A markup picture is a screenshot of the viewport; past this it is not one.
pub const MAX_MARKUP_PNG: usize = 8 * 1024 * 1024;

/// Temp file in the same folder, then rename over the target, so a reader (or a
/// crash) sees the old file or the new one and never half of either.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", path.display())
    })
}

pub fn write_markup(cache: &Path, scene: &str, png: &[u8], json: &str) -> Result<u64, String> {
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
    let dir = scene_dir(cache, scene);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    // JSON first: a failure between the two leaves the old picture with a newer
    // note, which `read_markup` still returns whole, rather than the reverse.
    write_atomic(&dir.join("markup.json"), json.as_bytes())?;
    write_atomic(&dir.join("markup.png"), png)?;
    Ok(now_ms())
}

pub fn read_markup(cache: &Path, scene: &str) -> Option<Markup> {
    let dir = scene_dir(cache, scene);
    let png = std::fs::read(dir.join("markup.png")).ok()?;
    let json = std::fs::read_to_string(dir.join("markup.json")).ok()?;
    let saved_at = std::fs::metadata(dir.join("markup.png"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(Markup {
        png,
        json,
        saved_at,
    })
}

// --- parsing a .tscn --------------------------------------------------------

/// The value of `key="..."` in a header line.
pub(super) fn attr(line: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = line.find(&needle)? + needle.len();
    let end = line[start..].find('"')?;
    Some(line[start..start + end].to_string())
}

/// `ExtResource("3_abc")` -> `3_abc`; also the older `ExtResource( 3 )`.
fn ext_id(text: &str) -> Option<String> {
    let start = text.find("ExtResource(")? + "ExtResource(".len();
    let end = text[start..].find(')')?;
    Some(
        text[start..start + end]
            .trim()
            .trim_matches('"')
            .to_string(),
    )
}

struct RawNode {
    name: String,
    kind: Option<String>,
    parent: Option<String>,
    instance: Option<String>,
    script: Option<String>,
}

/// Read a scene's node tree straight from its text. Instanced sub-scenes take
/// their root's type from the scene they instance, to a bounded depth.
pub fn parse_tscn(project: &Path, scene: &str) -> Result<Vec<Node>, String> {
    parse_tscn_depth(project, scene, 0)
}

pub(super) fn res_to_path(project: &Path, res: &str) -> PathBuf {
    project.join(res.trim_start_matches("res://"))
}

fn parse_tscn_depth(project: &Path, scene: &str, depth: usize) -> Result<Vec<Node>, String> {
    let path = res_to_path(project, scene);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;

    let mut ext: HashMap<String, String> = HashMap::new();
    let mut raws: Vec<RawNode> = Vec::new();

    for line in text.lines() {
        let line = line.trim_end();
        if line.starts_with("[ext_resource") {
            if let (Some(id), Some(p)) = (attr(line, "id"), attr(line, "path")) {
                ext.insert(id, p);
            }
        } else if line.starts_with("[node ") {
            let name =
                attr(line, "name").ok_or_else(|| format!("a node in {scene} has no name"))?;
            let instance = line
                .find("instance=")
                .and_then(|i| ext_id(&line[i..]))
                .and_then(|id| ext.get(&id).cloned());
            raws.push(RawNode {
                name,
                kind: attr(line, "type"),
                parent: attr(line, "parent"),
                instance,
                script: None,
            });
        } else if line.starts_with('[') {
            // A sub_resource, connection or editable: it ends the node above.
            continue;
        } else if let Some(rest) = line.strip_prefix("script =") {
            if let (Some(raw), Some(id)) = (raws.last_mut(), ext_id(rest)) {
                raw.script = ext.get(&id).cloned();
            }
        }
    }

    let root = raws
        .iter()
        .position(|r| r.parent.is_none())
        .ok_or_else(|| format!("{scene} has no root node"))?;

    // Paths are relative to the root: `.` is the root, `A/B` is a child of A.
    let root_name = raws[root].name.clone();
    let mut built: Vec<(String, Node)> = Vec::new();
    for (i, raw) in raws.iter().enumerate() {
        let rel = match (&raw.parent, i == root) {
            (_, true) => String::new(),
            (Some(p), _) if p == "." => raw.name.clone(),
            (Some(p), _) => format!("{p}/{}", raw.name),
            (None, _) => continue,
        };
        let kind = match (&raw.kind, &raw.instance) {
            (Some(k), _) => k.clone(),
            (None, Some(inst)) if depth < 4 => parse_tscn_depth(project, inst, depth + 1)
                .ok()
                .and_then(|n| n.into_iter().next())
                .map(|n| n.kind)
                .unwrap_or_else(|| "Node".to_string()),
            (None, _) => "Node".to_string(),
        };
        let path = if rel.is_empty() {
            root_name.clone()
        } else {
            format!("{root_name}/{rel}")
        };
        built.push((
            rel,
            Node {
                path,
                name: raw.name.clone(),
                kind,
                children: Vec::new(),
                script: raw.script.clone(),
                instance: raw.instance.clone().filter(|_| i != root),
            },
        ));
    }

    // Godot writes a parent before its children, so walking backwards finishes
    // each node's own children before it is moved under its parent.
    let rels: Vec<String> = built.iter().map(|(r, _)| r.clone()).collect();
    let mut slots: Vec<Option<Node>> = built.into_iter().map(|(_, n)| Some(n)).collect();
    for i in (1..slots.len()).rev() {
        let parent_rel = rels[i].rsplit_once('/').map_or("", |(p, _)| p);
        let Some(parent) = rels[..i].iter().position(|r| r == parent_rel) else {
            continue;
        };
        if let Some(node) = slots[i].take() {
            if let Some(p) = slots[parent].as_mut() {
                p.children.insert(0, node);
            }
        }
    }
    let root_node = slots
        .first_mut()
        .and_then(Option::take)
        .ok_or_else(|| format!("{scene} has no root node"))?;
    Ok(vec![root_node])
}

// --- headless jobs ----------------------------------------------------------

/// What a refresh is doing right now, polled by the pane.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub running: bool,
    pub phase: String,
    pub error: Option<String>,
    pub scene: String,
    pub started_at: u64,
    /// The last lines Godot printed, kept so a failure can be explained.
    pub output: Vec<String>,
}

#[derive(Default)]
pub struct Jobs {
    inner: Mutex<HashMap<String, Arc<Mutex<Job>>>>,
}

impl Jobs {
    pub fn get(&self, key: &str) -> Option<Job> {
        self.inner
            .lock_or_panic()
            .get(key)
            .map(|j| j.lock_or_panic().clone())
    }

    /// Register a job, refused while one is running under the same key.
    pub fn begin(&self, key: &str, scene: &str) -> Result<Arc<Mutex<Job>>, String> {
        let mut map = self.inner.lock_or_panic();
        if map.get(key).is_some_and(|j| j.lock_or_panic().running) {
            return Err("a refresh is already running".to_string());
        }
        let job = Arc::new(Mutex::new(Job {
            running: true,
            phase: "starting".to_string(),
            scene: scene.to_string(),
            started_at: now_ms(),
            ..Job::default()
        }));
        map.insert(key.to_string(), job.clone());
        Ok(job)
    }
}

pub(super) fn set_phase(job: &Arc<Mutex<Job>>, phase: &str) {
    job.lock_or_panic().phase = phase.to_string();
}

pub(super) fn finish(job: &Arc<Mutex<Job>>, error: Option<String>) {
    let mut j = job.lock_or_panic();
    j.running = false;
    j.phase = if error.is_some() { "failed" } else { "done" }.to_string();
    j.error = error;
}

/// What one refresh should produce.
#[derive(Debug, Clone)]
pub struct Refresh {
    pub project: PathBuf,
    pub scene: String,
    pub cache: PathBuf,
    /// `None` when no Godot 4 was found: the tree is parsed and no render is possible.
    pub godot: Option<Found>,
    pub render: bool,
    /// Where the dump script is written before it is handed to Godot.
    pub scratch: PathBuf,
    pub limits: Limits,
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub import: Duration,
    pub dump: Duration,
    pub export: Duration,
    pub render: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            import: Duration::from_secs(300),
            dump: Duration::from_secs(60),
            export: Duration::from_secs(120),
            render: Duration::from_secs(90),
        }
    }
}

/// Run a refresh to completion. Blocking: the caller runs it on its own thread
/// and watches `job`.
pub fn refresh(job: &Arc<Mutex<Job>>, opts: &Refresh) {
    let outcome = refresh_inner(job, opts);
    finish(job, outcome.err());
}

fn refresh_inner(job: &Arc<Mutex<Job>>, opts: &Refresh) -> Result<(), String> {
    let previous = read_cached(&opts.cache, &opts.scene);
    let mut cached = match &opts.godot {
        Some(godot) if !opts.render || previous.is_none() => {
            match dump_headless(job, opts, godot) {
                Ok(c) => c,
                Err(why) => {
                    let mut c = parsed(opts, Some(godot))?;
                    c.note = Some(format!(
                        "The headless run failed, so this tree is read from the scene file: {why}"
                    ));
                    c
                }
            }
        }
        Some(_) => previous.clone().ok_or("no cached tree")?,
        None => {
            let mut c = parsed(opts, None)?;
            c.note = Some(
                "Godot 4 was not found, so this tree is read from the scene file.".to_string(),
            );
            c
        }
    };

    if opts.render {
        let godot = opts
            .godot
            .as_ref()
            .ok_or("Godot 4 was not found - set its path in Settings > Godot to render.")?;
        set_phase(job, "rendering");
        render_frame(job, opts, godot)?;
        cached.image_at = Some(now_ms());
    } else if let Some(prev) = previous {
        cached.image_at = prev.image_at;
    }
    write_cached(&opts.cache, &opts.scene, &cached)
}

fn parsed(opts: &Refresh, godot: Option<&Found>) -> Result<Cached, String> {
    Ok(Cached {
        rendered_at: now_ms(),
        scene_path: opts.scene.clone(),
        source: Source::Parsed,
        godot: godot.map(|g| g.version.clone()),
        nodes: parse_tscn(&opts.project, &opts.scene)?,
        image_at: None,
        note: None,
    })
}

/// Run Godot's resource import once, when the project has never been imported.
/// A project with nothing to import still exits 0; a non-zero exit here is
/// reported by whatever runs next if it actually matters.
pub(super) fn ensure_imported(
    job: &Arc<Mutex<Job>>,
    project: &Path,
    godot: &Found,
    limit: Duration,
) -> Result<(), String> {
    if project.join(".godot").join("imported").is_dir() {
        return Ok(());
    }
    set_phase(job, "importing resources (first run only)");
    let import_flag: &[&str] = if godot.major == 4 && godot.minor >= 2 {
        &["--import"]
    } else {
        &["--editor", "--quit"]
    };
    let mut args = vec!["--headless", "--path", project.to_str().unwrap_or(".")];
    args.extend_from_slice(import_flag);
    let out = run_capture(godot.for_logging(), &args, project, limit)?;
    push_output(job, &out.text);
    Ok(())
}

fn dump_headless(job: &Arc<Mutex<Job>>, opts: &Refresh, godot: &Found) -> Result<Cached, String> {
    ensure_imported(job, &opts.project, godot, opts.limits.import)?;

    set_phase(job, "reading the scene tree");
    std::fs::create_dir_all(&opts.scratch).map_err(|e| e.to_string())?;
    let script = opts.scratch.join("dump_scene.gd");
    std::fs::write(&script, DUMP_SCRIPT)
        .map_err(|e| format!("could not write the dump script: {e}"))?;
    let out_file = opts.scratch.join("tree.json");
    let _ = std::fs::remove_file(&out_file);

    let args = [
        "--headless",
        "--path",
        opts.project.to_str().unwrap_or("."),
        "-s",
        script.to_str().unwrap_or(""),
        "--",
        "--scene",
        &opts.scene,
        "--out",
        out_file.to_str().unwrap_or(""),
    ];
    let out = run_capture(godot.for_logging(), &args, &opts.project, opts.limits.dump)?;
    push_output(job, &out.text);

    let text = std::fs::read_to_string(&out_file).map_err(|_| {
        format!(
            "Godot exited ({}) without writing a tree{}",
            out.code_label(),
            tail(&out.text)
        )
    })?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("the tree was unreadable: {e}"))?;
    if v["ok"].as_bool() != Some(true) {
        return Err(v["error"]
            .as_str()
            .unwrap_or("Godot could not load the scene")
            .to_string());
    }
    let nodes: Vec<Node> = serde_json::from_value(v["nodes"].clone())
        .map_err(|e| format!("the tree had an unexpected shape: {e}"))?;
    Ok(Cached {
        rendered_at: now_ms(),
        scene_path: opts.scene.clone(),
        source: Source::Headless,
        godot: Some(godot.version.clone()),
        nodes,
        image_at: None,
        note: None,
    })
}

pub(super) fn tail(text: &str) -> String {
    let last: Vec<&str> = text.lines().rev().take(3).collect();
    if last.is_empty() {
        String::new()
    } else {
        format!(
            ": {}",
            last.into_iter().rev().collect::<Vec<_>>().join(" | ")
        )
    }
}

pub(super) fn push_output(job: &Arc<Mutex<Job>>, text: &str) {
    let mut j = job.lock_or_panic();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        j.output.push(line.to_string());
    }
    let excess = j.output.len().saturating_sub(60);
    j.output.drain(..excess);
}

fn render_frame(job: &Arc<Mutex<Job>>, opts: &Refresh, godot: &Found) -> Result<(), String> {
    let dir = opts.scratch.join("movie");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let movie = dir.join("frame.png");

    let args = [
        "--path",
        opts.project.to_str().unwrap_or("."),
        "--write-movie",
        movie.to_str().unwrap_or(""),
        "--fixed-fps",
        "10",
        "--quit-after",
        "6",
        "--resolution",
        "1280x720",
        &opts.scene,
    ];
    let out = run_capture(
        godot.for_logging(),
        &args,
        &opts.project,
        opts.limits.render,
    )?;
    push_output(job, &out.text);

    // Movie Maker appends an eight-digit frame number; the last one has had the
    // most frames to settle (lights, physics) and is the one worth keeping.
    let mut frames: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "png"))
        .collect();
    frames.sort();
    let last = frames.pop().ok_or_else(|| {
        format!(
            "Godot exited ({}) without writing a frame. Rendering needs a display and a GPU driver{}",
            out.code_label(),
            tail(&out.text)
        )
    })?;
    let target = scene_dir(&opts.cache, &opts.scene);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    std::fs::copy(&last, target.join("frame.png"))
        .map_err(|e| format!("could not keep the frame: {e}"))?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

// --- running a command to completion ---------------------------------------

pub(super) struct Captured {
    pub(super) text: String,
    code: Option<i32>,
    timed_out: bool,
}

impl Captured {
    pub(super) fn code_label(&self) -> String {
        if self.timed_out {
            "timed out".to_string()
        } else {
            self.code
                .map_or("no code".to_string(), |c| format!("code {c}"))
        }
    }
}

/// Run `program args` to completion with both streams merged, killing the whole
/// tree if it outlasts `limit`. A timeout is a result rather than an error so
/// the caller can still read whatever the process wrote before it stalled.
pub(super) fn run_capture(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    limit: Duration,
) -> Result<Captured, String> {
    let mut child = base_command(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;

    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let out = child.stdout.take().map(|p| drain(Box::new(p)));
    let err = child.stderr.take().map(|p| drain(Box::new(p)));

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > limit => {
                timed_out = true;
                kill_tree(child.id());
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(format!("could not wait for {}: {e}", program.display())),
        }
    };

    let mut text = out
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    text.push_str(
        &err.map(|h| h.join().unwrap_or_default())
            .unwrap_or_default(),
    );
    Ok(Captured {
        text,
        code: status.and_then(|s| s.code()),
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const MAIN: &str = r#"[gd_scene load_steps=4 format=3 uid="uid://main"]

[ext_resource type="PackedScene" path="res://props/bed.tscn" id="2_bed"]
[ext_resource type="Script" path="res://player.gd" id="3_player"]

[sub_resource type="BoxMesh" id="BoxMesh_1"]

[node name="World" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("3_player")

[node name="Camera3D" type="Camera3D" parent="Player"]

[node name="Bed01" parent="." instance=ExtResource("2_bed")]

[node name="Lamp" type="OmniLight3D" parent="Bed01"]

[connection signal="x" from="Player" to="." method="_on_x"]
"#;

    fn project() -> TempDir {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("project.godot"), "config_version=5\n").unwrap();
        std::fs::write(dir.path().join("main.tscn"), MAIN).unwrap();
        std::fs::create_dir_all(dir.path().join("props")).unwrap();
        std::fs::write(
            dir.path().join("props/bed.tscn"),
            "[gd_scene format=3]\n\n[node name=\"Bed\" type=\"MeshInstance3D\"]\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn a_scene_file_parses_into_a_tree_with_root_prefixed_paths() {
        let dir = project();
        let tree = parse_tscn(dir.path(), "res://main.tscn").unwrap();
        let root = &tree[0];
        assert_eq!(
            (root.name.as_str(), root.kind.as_str(), root.path.as_str()),
            ("World", "Node3D", "World")
        );
        let names: Vec<&str> = root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Player", "Bed01"], "siblings keep file order");

        let player = &root.children[0];
        assert_eq!(player.script.as_deref(), Some("res://player.gd"));
        assert_eq!(player.children[0].path, "World/Player/Camera3D");
    }

    #[test]
    fn an_instanced_scene_takes_its_type_from_the_scene_it_instances() {
        let dir = project();
        let tree = parse_tscn(dir.path(), "res://main.tscn").unwrap();
        let bed = &tree[0].children[1];
        assert_eq!(bed.kind, "MeshInstance3D");
        assert_eq!(bed.instance.as_deref(), Some("res://props/bed.tscn"));
        assert_eq!(
            bed.children[0].path, "World/Bed01/Lamp",
            "nodes added under an instance keep their place"
        );
    }

    #[test]
    fn a_missing_or_rootless_scene_is_an_error_naming_it() {
        let dir = project();
        assert!(parse_tscn(dir.path(), "res://nope.tscn")
            .unwrap_err()
            .contains("nope.tscn"));
        std::fs::write(dir.path().join("empty.tscn"), "[gd_scene format=3]\n").unwrap();
        assert!(parse_tscn(dir.path(), "res://empty.tscn")
            .unwrap_err()
            .contains("no root"));
    }

    #[test]
    fn a_cyclic_instance_does_not_recurse_forever() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("a.tscn"),
            "[gd_scene format=3]\n[ext_resource type=\"PackedScene\" path=\"res://a.tscn\" id=\"1\"]\n[node name=\"A\" parent=\".\" instance=ExtResource(\"1\")]\n[node name=\"R\" type=\"Node\"]\n",
        )
        .unwrap();
        // The file above is malformed (root last); what matters is that it terminates.
        let _ = parse_tscn(dir.path(), "res://a.tscn");
    }

    fn tiny_png() -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        v.extend_from_slice(&[0, 1, 2, 3]);
        v
    }

    #[test]
    fn markup_is_kept_per_scene_and_overwritten_in_place() {
        let cache = TempDir::new().unwrap();
        assert!(read_markup(cache.path(), "res://a.tscn").is_none());
        write_markup(cache.path(), "res://a.tscn", &tiny_png(), "{\"n\":1}").unwrap();
        let mut second = tiny_png();
        second.push(9);
        write_markup(cache.path(), "res://a.tscn", &second, "{\"n\":2}").unwrap();

        let got = read_markup(cache.path(), "res://a.tscn").unwrap();
        assert_eq!(got.png, second);
        assert_eq!(got.json, "{\"n\":2}");
        assert!(read_markup(cache.path(), "res://b.tscn").is_none());

        let mut names: Vec<String> = std::fs::read_dir(scene_dir(cache.path(), "res://a.tscn"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["markup.json", "markup.png"],
            "no temp or older copies"
        );
    }

    #[test]
    fn a_markup_picture_that_is_not_a_png_or_is_too_big_is_refused() {
        let cache = TempDir::new().unwrap();
        assert!(write_markup(cache.path(), "res://a.tscn", b"hello", "{}").is_err());
        let mut big = tiny_png();
        big.resize(MAX_MARKUP_PNG + 1, 0);
        assert!(write_markup(cache.path(), "res://a.tscn", &big, "{}").is_err());
        assert!(read_markup(cache.path(), "res://a.tscn").is_none());
    }

    #[test]
    fn the_cache_round_trips_and_a_missing_entry_is_none() {
        let cache = TempDir::new().unwrap();
        assert!(read_cached(cache.path(), "res://a.tscn").is_none());
        let value = Cached {
            rendered_at: 5,
            scene_path: "res://a.tscn".to_string(),
            source: Source::Headless,
            godot: Some("4.3.stable".to_string()),
            nodes: Vec::new(),
            image_at: None,
            note: None,
        };
        write_cached(cache.path(), "res://a.tscn", &value).unwrap();
        assert_eq!(read_cached(cache.path(), "res://a.tscn"), Some(value));
        assert!(
            read_cached(cache.path(), "res://b.tscn").is_none(),
            "scenes do not share entries"
        );
    }

    /// A fake `godot` for the headless path: `--version` answers, a dump run
    /// writes the JSON named by `--out`, and a movie run writes a numbered PNG.
    fn fake(dir: &Path, tree_json: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join("fake-godot.cmd");
            let mut lines = vec![
                "@echo off".to_string(),
                "set OUT=".to_string(),
                "set MOVIE=".to_string(),
                ":loop".to_string(),
                "if \"%~1\"==\"\" goto done".to_string(),
                "if \"%~1\"==\"--version\" (echo 4.3.stable.fake& exit /b 0)".to_string(),
                "if \"%~1\"==\"--out\" set OUT=%~2".to_string(),
                "if \"%~1\"==\"--write-movie\" set MOVIE=%~2".to_string(),
                "shift".to_string(),
                "goto loop".to_string(),
                ":done".to_string(),
            ];
            if !tree_json.is_empty() {
                lines.push(format!(
                    "if not \"%OUT%\"==\"\" echo {tree_json}> \"%OUT%\""
                ));
            }
            lines.push(
                "if not \"%MOVIE%\"==\"\" echo PNG> \"%MOVIE:.png=%00000001.png\"".to_string(),
            );
            lines.push(
                "if not \"%MOVIE%\"==\"\" echo PNG> \"%MOVIE:.png=%00000002.png\"".to_string(),
            );
            lines.push("echo ran".to_string());
            lines.push("exit /b 0".to_string());
            std::fs::write(&path, lines.join("\r\n") + "\r\n").unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-godot.sh");
            let mut lines = vec![
                "#!/bin/sh".to_string(),
                "OUT=; MOVIE=".to_string(),
                "while [ $# -gt 0 ]; do".to_string(),
                " case \"$1\" in".to_string(),
                " --version) echo 4.3.stable.fake; exit 0;;".to_string(),
                " --out) OUT=\"$2\";;".to_string(),
                " --write-movie) MOVIE=\"$2\";;".to_string(),
                " esac".to_string(),
                " shift".to_string(),
                "done".to_string(),
            ];
            if !tree_json.is_empty() {
                lines.push(format!("[ -n \"$OUT\" ] && echo '{tree_json}' > \"$OUT\""));
            }
            lines.push("[ -n \"$MOVIE\" ] && echo PNG > \"${MOVIE%.png}00000001.png\"".to_string());
            lines.push("[ -n \"$MOVIE\" ] && echo PNG > \"${MOVIE%.png}00000002.png\"".to_string());
            lines.push("echo ran".to_string());
            lines.push("exit 0".to_string());
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    fn found(path: PathBuf) -> Found {
        Found {
            path,
            source: super::super::detect::Source::Setting,
            version: "4.3.stable.fake".to_string(),
            major: 4,
            minor: 3,
            console: None,
        }
    }

    fn options(project: &TempDir, work: &TempDir, godot: Option<Found>, render: bool) -> Refresh {
        Refresh {
            project: project.path().to_path_buf(),
            scene: "res://main.tscn".to_string(),
            cache: work.path().join("cache"),
            godot,
            render,
            scratch: work.path().join("scratch"),
            limits: Limits::default(),
        }
    }

    const TREE: &str =
        r#"{"ok":true,"nodes":[{"path":"World","name":"World","type":"Node3D","children":[]}]}"#;

    #[test]
    fn a_headless_refresh_reads_the_tree_godot_wrote_and_caches_it() {
        let project = project();
        std::fs::create_dir_all(project.path().join(".godot/imported")).unwrap();
        let work = TempDir::new().unwrap();
        let godot = found(fake(work.path(), TREE));
        let opts = options(&project, &work, Some(godot), false);

        let jobs = Jobs::default();
        let job = jobs.begin("c1", &opts.scene).unwrap();
        refresh(&job, &opts);

        let state = jobs.get("c1").unwrap();
        assert!(!state.running);
        assert_eq!(state.error, None, "{:?}", state.output);
        let cached = read_cached(&opts.cache, &opts.scene).unwrap();
        assert_eq!(cached.source, Source::Headless);
        assert_eq!(cached.nodes[0].name, "World");
        assert!(cached.note.is_none());
    }

    #[test]
    fn a_failed_headless_run_falls_back_to_the_scene_file_and_says_so() {
        let project = project();
        std::fs::create_dir_all(project.path().join(".godot/imported")).unwrap();
        let work = TempDir::new().unwrap();
        // A godot that answers but never writes a tree.
        let opts = options(&project, &work, Some(found(fake(work.path(), ""))), false);

        let job = Jobs::default().begin("c1", &opts.scene).unwrap();
        refresh(&job, &opts);

        let cached = read_cached(&opts.cache, &opts.scene).unwrap();
        assert_eq!(cached.source, Source::Parsed);
        assert!(cached.note.unwrap().contains("read from the scene file"));
        assert_eq!(cached.nodes[0].name, "World");
    }

    #[test]
    fn without_godot_the_tree_is_parsed_and_a_render_is_refused() {
        let project = project();
        let work = TempDir::new().unwrap();

        let opts = options(&project, &work, None, false);
        let job = Jobs::default().begin("c1", &opts.scene).unwrap();
        refresh(&job, &opts);
        let cached = read_cached(&opts.cache, &opts.scene).unwrap();
        assert_eq!(cached.source, Source::Parsed);
        assert!(cached.note.unwrap().contains("not found"));

        let opts = options(&project, &work, None, true);
        let jobs = Jobs::default();
        let job = jobs.begin("c1", &opts.scene).unwrap();
        refresh(&job, &opts);
        assert!(jobs.get("c1").unwrap().error.unwrap().contains("Settings"));
        assert!(
            read_image(&opts.cache, &opts.scene).is_none(),
            "no picture is invented"
        );
    }

    #[test]
    fn a_render_keeps_the_last_frame_and_stamps_the_image() {
        let project = project();
        std::fs::create_dir_all(project.path().join(".godot/imported")).unwrap();
        let work = TempDir::new().unwrap();
        let opts = options(&project, &work, Some(found(fake(work.path(), TREE))), true);

        let jobs = Jobs::default();
        let job = jobs.begin("c1", &opts.scene).unwrap();
        refresh(&job, &opts);

        assert_eq!(jobs.get("c1").unwrap().error, None);
        assert!(read_image(&opts.cache, &opts.scene).is_some());
        assert!(read_cached(&opts.cache, &opts.scene)
            .unwrap()
            .image_at
            .is_some());
    }

    #[test]
    fn a_second_refresh_is_refused_while_one_runs() {
        let jobs = Jobs::default();
        let _first = jobs.begin("c1", "res://a.tscn").unwrap();
        assert!(jobs.begin("c1", "res://a.tscn").is_err());
        assert!(
            jobs.begin("c2", "res://a.tscn").is_ok(),
            "another cluster is independent"
        );
    }

    // --- examples/godot-demo -------------------------------------------------
    // The game the acceptance runs use (design §13). No Godot runs in CI, so
    // these hold the hand-written scenes to what the tests name and to what
    // Godot needs to load them at all.

    fn demo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/godot-demo")
    }

    fn find<'a>(nodes: &'a [Node], path: &str) -> &'a Node {
        fn walk<'a>(nodes: &'a [Node], path: &str) -> Option<&'a Node> {
            nodes.iter().find_map(|n| {
                (n.path == path)
                    .then_some(n)
                    .or_else(|| walk(&n.children, path))
            })
        }
        walk(nodes, path).unwrap_or_else(|| panic!("{path} is missing"))
    }

    #[test]
    fn the_demo_game_names_the_enemy_the_acceptance_tests_pick() {
        let hallway = parse_tscn(&demo(), "res://levels/hallway.tscn").unwrap();
        let enemy = find(&hallway, "Hallway/Enemy_02");
        assert_eq!(enemy.kind, "CharacterBody3D");
        let parts: Vec<&str> = enemy.children.iter().map(|c| c.kind.as_str()).collect();
        assert_eq!(
            parts,
            ["CollisionShape3D", "MeshInstance3D"],
            "a ray hits its collider, and its mesh folds into it"
        );
        assert_eq!(find(&hallway, "Hallway/Player").kind, "CharacterBody3D");
        assert_eq!(find(&hallway, "Hallway/Player/Camera").kind, "Camera3D");
        let clock = find(&hallway, "Hallway/HUD/Clock");
        assert_eq!(clock.script.as_deref(), Some("res://scripts/clock.gd"));

        let arena = parse_tscn(&demo(), "res://levels/arena_2d.tscn").unwrap();
        assert_eq!(find(&arena, "Arena/Enemy_02").kind, "CharacterBody2D");
        assert_eq!(find(&arena, "Arena/Camera").kind, "Camera2D");
        let bench = parse_tscn(&demo(), "res://levels/bench.tscn").unwrap();
        assert_eq!(bench[0].script.as_deref(), Some("res://scripts/bench.gd"));

        for scene in ["hallway", "arena_2d"] {
            let text =
                std::fs::read_to_string(demo().join(format!("levels/{scene}.tscn"))).unwrap();
            assert!(
                text.contains("[node name=\"Player\" type=\"CharacterBody")
                    && text.contains("parent=\".\" groups=[\"player\"]]"),
                "{scene}: the tick's player is the first node in the group `player`"
            );
        }
    }

    /// What Godot would refuse in a hand-written scene: a resource used before
    /// it is declared, or a script that is not on disk or that extends another
    /// class than its node's. load_steps only drives the loading bar, but is
    /// held to what Godot 4.3 writes (the resources plus one) all the same.
    #[test]
    fn every_demo_scene_declares_what_it_uses_before_it_uses_it() {
        let quoted = |line: &str, call: &str| -> Vec<String> {
            line.match_indices(call)
                .filter_map(|(i, _)| line[i + call.len()..].split('"').next())
                .map(str::to_string)
                .collect()
        };
        for scene in ["hallway", "arena_2d", "bench"] {
            let text =
                std::fs::read_to_string(demo().join(format!("levels/{scene}.tscn"))).unwrap();
            let (mut ext, mut sub) = (Vec::new(), Vec::new());
            for line in text.lines() {
                for id in quoted(line, "ExtResource(\"") {
                    assert!(
                        ext.contains(&id),
                        "{scene}: ExtResource {id} is not declared above"
                    );
                }
                for id in quoted(line, "SubResource(\"") {
                    assert!(
                        sub.contains(&id),
                        "{scene}: SubResource {id} is not declared above"
                    );
                }
                if line.starts_with("[ext_resource") {
                    let path = attr(line, "path").unwrap();
                    assert!(res_to_path(&demo(), &path).is_file(), "{scene}: {path}");
                    ext.push(attr(line, "id").unwrap());
                } else if line.starts_with("[sub_resource") {
                    sub.push(attr(line, "id").unwrap());
                }
            }
            let steps = text.lines().next().and_then(|head| {
                head.split_whitespace()
                    .find_map(|w| w.strip_prefix("load_steps="))
            });
            let expected = (ext.len() + sub.len() + 1).to_string();
            assert_eq!(steps, Some(expected.as_str()), "{scene}: load_steps");

            let mut stack = parse_tscn(&demo(), &format!("res://levels/{scene}.tscn")).unwrap();
            while let Some(node) = stack.pop() {
                if let Some(script) = &node.script {
                    let source = std::fs::read_to_string(res_to_path(&demo(), script)).unwrap();
                    let extends = source.lines().find_map(|l| l.strip_prefix("extends "));
                    assert_eq!(extends, Some(node.kind.as_str()), "{scene}: {}", node.path);
                }
                stack.extend(node.children);
            }
        }
    }
}
