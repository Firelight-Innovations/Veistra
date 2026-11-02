//! Send: a take's notes as a feedback packet an agent can read (design §9).
//!
//! The page makes the pictures (markup, contact sheet, the in, note and out
//! frames) from the `<video>` it already has, and hands them over in one
//! call; this writes them, builds each note's `context.json` from the take's
//! telemetry and log, writes `packet.md` (what the agent reads first), and
//! files each note as a comment with a `take` anchor so its status can move
//! through the fix loop and the Scene and Blender views can show it.
//!
//! ```text
//! .veistra/feedback/<take id>-<send n>/
//!   packet.md  take.json
//!   notes/<n>/markup.png markup.json contact.png context.json frames/ [clip.mp4]
//! ```
//!
//! The packet holds its own copies of everything, so it outlives its take.

use super::takes::{self, Summary};
use super::telemetry::{self, Line};
use crate::apps::CallContext;
use crate::comments::{self, Anchor, Draft};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Log lines this close to a note are attached to it (§8.3.4).
const LOG_WINDOW_MS: u64 = 10_000;
/// How far from a note the nearest tick may be and still describe it.
const TICK_WINDOW_MS: u64 = 1_000;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Images {
    pub markup_png: Option<String>,
    pub contact_png: Option<String>,
    pub in_png: Option<String>,
    pub note_png: Option<String>,
    pub out_png: Option<String>,
    pub clip_mp4: Option<String>,
}

/// One note as the page sends it: the shape of §8.3, plus its pictures.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub n: u32,
    #[serde(default)]
    pub kind: String,
    pub at_ms: u64,
    #[serde(default)]
    pub in_ms: Option<u64>,
    #[serde(default)]
    pub out_ms: Option<u64>,
    pub body: String,
    #[serde(default)]
    pub target: Option<Value>,
    #[serde(default)]
    pub markup: Option<Value>,
    #[serde(default)]
    pub done_when: Option<String>,
    #[serde(default)]
    pub images: Images,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub take: String,
    pub notes: Vec<Note>,
}

/// What Send wrote.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    /// The packet folder, relative to the environment.
    pub packet: String,
    /// `packet.md`, absolute, for the message to the agent.
    pub packet_md: String,
    /// Each note's number and the comment it became.
    pub comments: Vec<(u32, String)>,
}

/// `m:ss`, the way the timeline and the board show take time.
pub fn clock(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

fn leaf(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn vec3(v: &Value) -> Option<String> {
    let a = v.as_array()?;
    let parts: Vec<String> = a
        .iter()
        .map(|x| x.as_f64().map(|f| format!("{f:.1}").replace('-', "−")))
        .collect::<Option<_>>()?;
    Some(format!("({})", parts.join(", ")))
}

fn decode(b64: &Option<String>, what: &str) -> Result<Option<Vec<u8>>, String> {
    b64.as_deref()
        .map(|s| {
            BASE64
                .decode(s)
                .map_err(|e| format!("{what} is not base64: {e}"))
        })
        .transpose()
}

/// The note's span: its range, or the moment itself.
fn span(note: &Note) -> (u64, u64) {
    let from = note.in_ms.unwrap_or(note.at_ms).min(note.at_ms);
    let to = note.out_ms.unwrap_or(note.at_ms).max(note.at_ms);
    (from, to)
}

/// Log rows near a note, from the take's `log.jsonl`.
fn log_near(log: &[Value], note: &Note, all_levels: bool) -> Vec<Value> {
    let (from, to) = span(note);
    let lo = from.saturating_sub(LOG_WINDOW_MS);
    let hi = to + LOG_WINDOW_MS;
    log.iter()
        .filter(|row| {
            let ms = row["ms"].as_u64().unwrap_or(u64::MAX);
            let level = row["level"].as_str().unwrap_or("info");
            ms >= lo && ms <= hi && (all_levels || level != "info")
        })
        .cloned()
        .collect()
}

/// A note's `context.json`: scene, target, camera, player, log lines and
/// frame time, all from what the take recorded around it.
pub fn context(summary: &Summary, lines: &[Line], log: &[Value], note: &Note) -> Value {
    let wall = |ms: u64| summary.started_at + ms;
    let tick = telemetry::nearest_tick(lines, wall(note.at_ms), TICK_WINDOW_MS);
    let (from, to) = span(note);
    let worst = telemetry::worst_frame(lines, wall(from.saturating_sub(2_000)), wall(to + 2_000))
        .map(|(t, ms)| json!({ "ms": ms, "atMs": t.saturating_sub(summary.started_at) }));
    let scene = tick.map(|t| t.scene.clone()).or_else(|| {
        summary
            .scenes
            .iter()
            .find(|s| s.from_ms <= note.at_ms && note.at_ms <= s.to_ms)
            .map(|s| s.path.clone())
    });
    json!({
        "version": 1,
        "take": summary.id,
        "n": note.n,
        "kind": note.kind,
        "atMs": note.at_ms,
        "inMs": note.in_ms,
        "outMs": note.out_ms,
        "scene": scene,
        "target": note.target,
        "camera": tick.map(|t| t.raw["camera"].clone()),
        "player": tick.map(|t| t.raw["player"].clone()),
        "viewport": tick.map(|t| t.raw["viewport"].clone()),
        "frameMs": tick.and_then(|t| t.frame_ms),
        "worstFrame": worst,
        "log": log_near(log, note, true),
        "doneWhen": note.done_when,
    })
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The packet folder for this send: `<take>-<n>`, one past the last.
fn next_packet(feedback: &Path, take: &str) -> PathBuf {
    let mut n = 1;
    while feedback.join(format!("{take}-{n}")).exists() {
        n += 1;
    }
    feedback.join(format!("{take}-{n}"))
}

/// What the agent reads first. The wording follows the AgentHandoff board.
/// It names only the files Send wrote (a contact sheet is the person's
/// choice), and the cluster the notes came from, which the note tools need
/// once the person has moved on to another.
pub fn packet_md(
    summary: &Summary,
    notes: &[(&Note, &Value, &str)],
    project: &str,
    cluster: Option<&str>,
) -> String {
    let mut md = String::new();
    let count = notes.len();
    let _ = writeln!(md, "# Playtest feedback · Take {}\n", summary.number.max(1));
    let env = &summary.environment;
    let mut meta = vec![project.to_string()];
    match (&env.branch, &env.commit) {
        (Some(b), Some(c)) => meta.push(format!("{b} @ {c}")),
        (Some(b), None) => meta.push(b.clone()),
        (None, Some(c)) => meta.push(c.clone()),
        (None, None) => {}
    }
    meta.push(format!("take {}", summary.id));
    if !summary.godot.is_empty() {
        meta.push(format!("Godot {}", summary.godot));
    }
    meta.push(clock(summary.duration_ms));
    let _ = writeln!(md, "{}\n", meta.join(" · "));
    let sheets = notes
        .iter()
        .filter(|(n, _, _)| n.images.contact_png.is_some())
        .count();
    let motion = match sheets {
        0 => "",
        s if s == count => {
            "then `contact.png` for the motion (one frame a second, the time printed on each), "
        }
        _ => {
            "then `contact.png`, where a note has one, for the motion (one frame a second, the \
              time printed on each), "
        }
    };
    let pass = cluster
        .map(|c| format!(" Pass `cluster: \"{c}\"` to both: these notes came from that cluster."))
        .unwrap_or_default();
    let _ = writeln!(
        md,
        "{count} {}. For each note, open `markup.png` first, {motion}then read the note. Prefer \
         the object path to the pixel position. When you start on a note, call \
         `start_play_note` with its id; when it is fixed, call `resolve_play_note` with the id, \
         what you changed, and the commit.{pass} Both are on the veistra-workspace server, and \
         on veistra-context for an agent in an agent tab. The person checks the fix and closes \
         the note.\n",
        if count == 1 { "note" } else { "notes" }
    );
    for (note, ctx, id) in notes {
        let when = match (note.in_ms, note.out_ms) {
            (Some(i), Some(o)) if o > i => format!("{} → {}", clock(i), clock(o)),
            _ => clock(note.at_ms),
        };
        let scene = ctx["scene"].as_str().map(leaf).unwrap_or("");
        let _ = writeln!(
            md,
            "## Note {} · {when}{}\n",
            note.n,
            if scene.is_empty() {
                String::new()
            } else {
                format!(" · {scene}")
            }
        );
        for line in note.body.trim().lines() {
            let _ = writeln!(md, "> {line}");
        }
        md.push('\n');
        let mut row = |k: &str, v: String| {
            let _ = writeln!(md, "- **{k}:** {v}");
        };
        row("Note id", format!("`{id}`"));
        if let Some(t) = note.target.as_ref().filter(|t| t.is_object()) {
            let path = t["nodePath"].as_str().unwrap_or("?");
            let mut what = format!("`{path}`");
            if let Some(ty) = t["type"].as_str() {
                let _ = write!(what, " ({ty})");
            }
            if let Some(p) = vec3(&t["worldPoint"]) {
                let _ = write!(what, ", world {p}");
            }
            let _ = write!(what, " at {}", clock(note.at_ms));
            if t["source"] == "recorded" {
                what.push_str(", from the take's recorded scene data");
            }
            row("Object", what);
            if let Some(script) = t["script"].as_str() {
                row("Script", format!("`{script}`"));
            }
        }
        let cam = &ctx["camera"];
        if let (Some(pos), Some(target)) = (vec3(&cam["pos"]), vec3(&cam["target"])) {
            let fov = cam["fov"]
                .as_f64()
                .map(|f| format!(", fov {f:.0}"))
                .unwrap_or_default();
            row("Camera", format!("pos {pos} → target {target}{fov}"));
        }
        let player = &ctx["player"];
        if let (Some(path), Some(pos)) = (player["path"].as_str(), vec3(&player["pos"])) {
            row("Player", format!("`{path}` at {pos}"));
        }
        let near: Vec<String> = ctx["log"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|l| l["level"] != "info")
            .take(8)
            .map(|l| {
                let tag = if l["level"] == "error" { "E" } else { "W" };
                format!(
                    "{} {tag} {}",
                    clock(l["ms"].as_u64().unwrap_or(0)),
                    l["text"].as_str().unwrap_or("").trim()
                )
            })
            .collect();
        row(
            "Log, ±10 s",
            if near.is_empty() {
                "no errors or warnings".to_string()
            } else {
                format!("\n  - `{}`", near.join("`\n  - `"))
            },
        );
        if let Some(ms) = ctx["worstFrame"]["ms"].as_f64() {
            let at = clock(ctx["worstFrame"]["atMs"].as_u64().unwrap_or(0));
            row("Frame time", format!("worst {ms:.0} ms at {at}"));
        }
        let images = &note.images;
        let mut files = vec![format!("`notes/{}/markup.png`", note.n)];
        if images.contact_png.is_some() {
            files.push("`contact.png`".into());
        }
        if images.in_png.is_some() || images.note_png.is_some() || images.out_png.is_some() {
            files.push("`frames/`".into());
        }
        if images.clip_mp4.is_some() {
            files.push("`clip.mp4`".into());
        }
        files.push("`context.json`".into());
        row("Files", files.join(" · "));
        if let Some(done) = note.done_when.as_deref().filter(|d| !d.trim().is_empty()) {
            row("Done when", done.trim().to_string());
        }
        md.push('\n');
    }
    md
}

/// Write the packet and file the notes. `takes_dir` holds the take;
/// `project` is the environment, where the packet and the comments go.
pub fn send(
    ctx: &CallContext,
    takes_dir: &Path,
    project_name: &str,
    req: &Request,
) -> Result<Sent, String> {
    let root = ctx
        .project
        .clone()
        .ok_or("this cluster has no environment to send from")?;
    if req.notes.is_empty() {
        return Err("there are no notes to send".into());
    }
    if req.notes.iter().any(|n| n.body.trim().is_empty()) {
        return Err("every note needs words before it is sent".into());
    }
    if let Some(bare) = req
        .notes
        .iter()
        .find(|n| n.images.markup_png.is_none() && n.images.note_png.is_none())
    {
        return Err(format!("note {} has no picture", bare.n));
    }
    let listed = takes::read(takes_dir, &req.take)?;
    let summary = listed.summary;
    let take_dir = takes_dir.join(&req.take);
    let lines = telemetry::parse_all(
        &std::fs::read_to_string(take_dir.join(telemetry::FILE)).unwrap_or_default(),
    );
    let log: Vec<Value> = std::fs::read_to_string(take_dir.join(takes::LOG))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    let feedback = root.join(".veistra").join("feedback");
    let packet = next_packet(&feedback, &req.take);
    let packet_rel = packet
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| packet.display().to_string());
    std::fs::create_dir_all(&packet).map_err(|e| format!("could not create the packet: {e}"))?;
    std::fs::copy(take_dir.join(takes::SUMMARY), packet.join(takes::SUMMARY))
        .map_err(|e| format!("could not copy take.json: {e}"))?;

    let mut contexts = Vec::new();
    for note in &req.notes {
        let dir = packet.join("notes").join(note.n.to_string());
        let markup = decode(&note.images.markup_png, "markupPng")?;
        let frame = decode(&note.images.note_png, "notePng")?;
        let picture = markup
            .as_ref()
            .or(frame.as_ref())
            .ok_or_else(|| format!("note {} has no picture", note.n))?;
        write(&dir.join("markup.png"), picture)?;
        let markup_json = note.markup.clone().unwrap_or_else(|| {
            json!({ "version": 1, "pins": [], "annotations": [], "note": "no ink on this frame" })
        });
        write(
            &dir.join("markup.json"),
            serde_json::to_string_pretty(&markup_json)
                .unwrap_or_default()
                .as_bytes(),
        )?;
        for (b64, name) in [
            (&note.images.contact_png, "contact.png"),
            (&note.images.in_png, "frames/in.png"),
            (&note.images.note_png, "frames/note.png"),
            (&note.images.out_png, "frames/out.png"),
            (&note.images.clip_mp4, "clip.mp4"),
        ] {
            if let Some(bytes) = decode(b64, name)? {
                write(&dir.join(name), &bytes)?;
            }
        }
        let c = context(&summary, &lines, &log, note);
        write(
            &dir.join("context.json"),
            serde_json::to_string_pretty(&c)
                .unwrap_or_default()
                .as_bytes(),
        )?;
        contexts.push(c);
    }

    let mut ids = Vec::new();
    for (note, c) in req.notes.iter().zip(&contexts) {
        let node_path = note
            .target
            .as_ref()
            .and_then(|t| t["nodePath"].as_str())
            .map(str::to_string);
        let made = comments::create(
            ctx,
            Draft {
                anchor: Anchor::Take {
                    take: req.take.clone(),
                    n: note.n,
                    at_ms: note.at_ms,
                    in_ms: note.in_ms,
                    out_ms: note.out_ms,
                    packet: packet_rel.clone(),
                    scene: c["scene"].as_str().map(str::to_string),
                    node_path,
                },
                body: note.body.trim().to_string(),
                screenshot_png: None,
            },
        )
        .map_err(|e| e.message)?;
        ids.push((note.n, made.id));
    }

    let rows: Vec<(&Note, &Value, &str)> = req
        .notes
        .iter()
        .zip(&contexts)
        .zip(&ids)
        .map(|((n, c), (_, id))| (n, c, id.as_str()))
        .collect();
    let md = packet_md(&summary, &rows, project_name, ctx.cluster_id.as_deref());
    write(&packet.join("packet.md"), md.as_bytes())?;

    mark_sent(takes_dir, &req.take, &ids, &packet_rel);
    Ok(Sent {
        packet: packet_rel,
        packet_md: packet.join("packet.md").display().to_string(),
        comments: ids,
    })
}

/// Stamp each sent note in the take's `notes.json` with its comment, so the
/// draft count drops and the take can be retired like any other.
fn mark_sent(takes_dir: &Path, take: &str, ids: &[(u32, String)], packet: &str) {
    let stamped = takes::update_notes(takes_dir, take, |doc| {
        let mut doc = doc.clone();
        for note in doc["notes"].as_array_mut()?.iter_mut() {
            let n = note["n"].as_u64().unwrap_or(0) as u32;
            if let Some((_, id)) = ids.iter().find(|(m, _)| *m == n) {
                note["commentId"] = json!(id);
                note["packet"] = json!(packet);
            }
        }
        Some(doc)
    });
    if let Err(e) = stamped {
        crate::veistra_log!("play: could not mark the sent notes in take {take}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::super::runner::{Level, LogLine};
    use super::super::takes::{EnvInfo, Finish, VideoInfo};
    use super::*;
    use tempfile::TempDir;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G'];

    fn note(n: u32, at: u64, range: Option<(u64, u64)>, body: &str) -> Note {
        Note {
            n,
            kind: if range.is_some() { "range" } else { "frame" }.into(),
            at_ms: at,
            in_ms: range.map(|r| r.0),
            out_ms: range.map(|r| r.1),
            body: body.into(),
            target: Some(json!({
                "nodePath": "Hallway/Enemy_02",
                "type": "CharacterBody3D",
                "worldPoint": [14.2, 0.0, -6.8],
                "source": "recorded",
            })),
            markup: None,
            done_when: Some("tests/chase_wall.gd passes".into()),
            images: Images {
                markup_png: Some(BASE64.encode(PNG)),
                contact_png: Some(BASE64.encode(PNG)),
                in_png: Some(BASE64.encode(PNG)),
                note_png: Some(BASE64.encode(PNG)),
                out_png: Some(BASE64.encode(PNG)),
                clip_mp4: None,
            },
        }
    }

    fn take(root: &Path) -> (PathBuf, String) {
        let takes = takes::dir_in(root);
        let id = "2026-10-30-1402-0f3a".to_string();
        let started = 1_793_368_920_000;
        let channel = root.join("chan");
        std::fs::create_dir_all(&channel).unwrap();
        std::fs::write(
            channel.join(telemetry::FILE),
            format!(
                "{{\"t\":{},\"kind\":\"tick\",\"scene\":\"res://levels/hallway.tscn\",\"frameMs\":41,\
                 \"camera\":{{\"pos\":[12.1,1.6,-2.3],\"target\":[14.0,1.2,-6.6],\"up\":[0,1,0],\"fov\":70}},\
                 \"player\":{{\"path\":\"Hallway/Player\",\"pos\":[12.1,0,-2.3]}}}}\n",
                started + 102_000
            ),
        )
        .unwrap();
        let log = [LogLine {
            seq: 0,
            stream: "out",
            level: Level::Warning,
            text: "WARNING: path recomputed 6x in 1 s".into(),
            at: started + 95_000,
        }];
        takes::finish(&Finish {
            dir: &takes.join(&id),
            id: &id,
            number: 4,
            project: ".",
            environment: EnvInfo {
                branch: Some("wt/enemy-chase".into()),
                commit: Some("8c41e07".into()),
            },
            godot: "4.5.1",
            started_at: started,
            ended_at: started + 151_400,
            video: VideoInfo::default(),
            channel: Some(&channel),
            log: &log,
            marks: &[],
        })
        .unwrap();
        takes::save_notes(
            &takes,
            &id,
            &json!({ "version": 1, "notes": [{ "n": 1 }, { "n": 2 }] }),
        )
        .unwrap();
        (takes, id)
    }

    #[test]
    fn send_writes_the_packet_files_and_files_each_note_as_a_comment() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let (takes_dir, id) = take(&root);
        let ctx = CallContext {
            cluster_id: Some("c1".into()),
            project: Some(root.clone()),
        };
        let req = Request {
            take: id.clone(),
            notes: vec![
                note(1, 41_000, None, "The door light flickers"),
                note(
                    2,
                    102_180,
                    Some((98_000, 106_000)),
                    "The enemy walks into the east wall",
                ),
            ],
        };
        let sent = send(&ctx, &takes_dir, "Anomaly", &req).unwrap();
        assert_eq!(sent.packet, format!(".veistra/feedback/{id}-1"));
        let packet = root.join(&sent.packet);
        for f in [
            "packet.md",
            "take.json",
            "notes/1/markup.png",
            "notes/1/markup.json",
            "notes/1/contact.png",
            "notes/1/context.json",
            "notes/2/frames/in.png",
            "notes/2/frames/note.png",
            "notes/2/frames/out.png",
        ] {
            assert!(packet.join(f).is_file(), "{f}");
        }
        assert!(
            !packet.join("notes/1/clip.mp4").exists(),
            "no clip unless asked"
        );

        let c: Value = serde_json::from_str(
            &std::fs::read_to_string(packet.join("notes/2/context.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(c["scene"], "res://levels/hallway.tscn");
        assert_eq!(c["camera"]["fov"], 70);
        assert_eq!(
            c["log"][0]["level"], "warning",
            "lines within 10 s come along"
        );
        assert_eq!(c["worstFrame"]["ms"], 41.0);

        let md = std::fs::read_to_string(packet.join("packet.md")).unwrap();
        assert!(md.starts_with("# Playtest feedback · Take 4"));
        assert!(md.contains("wt/enemy-chase @ 8c41e07"));
        assert!(md.contains("## Note 2 · 1:38 → 1:46 · hallway.tscn"));
        assert!(md.contains("> The enemy walks into the east wall"));
        assert!(
            md.contains("`Hallway/Enemy_02` (CharacterBody3D), world (14.2, 0.0, −6.8) at 1:42")
        );
        assert!(md.contains("resolve_play_note"));
        assert!(
            md.contains("`cluster: \"c1\"`"),
            "the agent is told which cluster to ask"
        );
        assert!(md.contains("veistra-context"));
        assert!(md.contains("then `contact.png` for the motion"));
        assert!(md.contains("tests/chase_wall.gd passes"));
        assert!(
            md.contains(&format!("`{}`", sent.comments[1].1)),
            "each note names its id"
        );

        let all = comments::list(&ctx).unwrap();
        assert_eq!(all.len(), 2);
        let Anchor::Take {
            n,
            packet: p,
            node_path,
            ..
        } = &all[1].anchor
        else {
            panic!("a take anchor");
        };
        assert_eq!((*n, p.as_str()), (2, sent.packet.as_str()));
        assert_eq!(node_path.as_deref(), Some("Hallway/Enemy_02"));

        assert_eq!(
            takes::read(&takes_dir, &id).unwrap().drafts,
            0,
            "both notes are sent"
        );
        let again = send(&ctx, &takes_dir, "Anomaly", &req).unwrap();
        assert_eq!(
            again.packet,
            format!(".veistra/feedback/{id}-2"),
            "a second send is a new packet"
        );
    }

    #[test]
    fn a_note_with_no_words_or_no_picture_is_refused_before_anything_is_written() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let (takes_dir, id) = take(&root);
        let ctx = CallContext {
            cluster_id: None,
            project: Some(root.clone()),
        };
        let empty = Request {
            take: id.clone(),
            notes: vec![note(1, 0, None, "  ")],
        };
        assert!(send(&ctx, &takes_dir, "x", &empty).is_err());
        let mut bare = note(1, 0, None, "words");
        bare.images = Images::default();
        let none = Request {
            take: id,
            notes: vec![bare],
        };
        assert!(send(&ctx, &takes_dir, "x", &none).is_err());
        assert!(comments::list(&ctx).unwrap().is_empty());
        assert!(send(
            &ctx,
            &takes_dir,
            "x",
            &Request {
                take: "nope".into(),
                notes: vec![note(1, 0, None, "w")]
            }
        )
        .is_err());
    }

    #[test]
    fn a_note_sent_without_a_contact_sheet_is_not_pointed_at_one() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        let (takes_dir, id) = take(&root);
        let ctx = CallContext {
            cluster_id: Some("c1".into()),
            project: Some(root.clone()),
        };
        let mut bare = note(1, 41_000, None, "The door light flickers");
        bare.images.contact_png = None;
        let sent = send(
            &ctx,
            &takes_dir,
            "Anomaly",
            &Request {
                take: id,
                notes: vec![bare],
            },
        )
        .unwrap();
        let packet = root.join(&sent.packet);
        assert!(!packet.join("notes/1/contact.png").exists());
        let md = std::fs::read_to_string(packet.join("packet.md")).unwrap();
        assert!(!md.contains("contact.png"), "{md}");
        assert!(md.contains("`notes/1/markup.png` · `frames/` · `context.json`"));
    }

    #[test]
    fn clock_is_minutes_and_seconds() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(102_180), "1:42");
        assert_eq!(clock(3_725_000), "62:05");
    }
}
