//! Takes: recorded runs kept on disk for review (design §5).
//!
//! A take is a folder, `.veistra/takes/<yyyy-mm-dd-hhmm>-<4 hex>/`, holding the
//! five files the design lists: `take.mp4`, `telemetry.jsonl`, `log.jsonl`,
//! `take.json` and `notes.json` (drafts, rewritten as the person types). The
//! video is written by [`super::record`]; everything else is here, and nothing
//! here needs Windows, so all of it is tested on any host.
//!
//! **The video is the last file to arrive.** It is recorded as
//! [`VIDEO_PART`] and renamed once the encoder has closed it, which can be a
//! second after the rest of the take is written: a listed take without
//! `take.mp4` is one whose video is still closing, or failed to.
//!
//! **Kept out of git through `.git/info/exclude`**, not the project's
//! `.gitignore`: a take is one person's recording, not a change to the
//! repository. A linked worktree's exclude file is the shared one.
//!
//! **Retention** is per environment ([`retain`]): the newest takes, any with
//! draft notes, and none that never got its `take.json` once it has sat for
//! [`ORPHAN_AFTER`].

use super::runner::{Level, LogLine};
use super::telemetry::{self, Line, SceneSpan};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// Takes kept per environment (open decision 7: ten).
pub const KEEP: usize = 10;

pub const VIDEO: &str = "take.mp4";
/// The video while it is being written.
pub const VIDEO_PART: &str = "take.mp4.part";
pub const SUMMARY: &str = "take.json";
pub const LOG: &str = "log.jsonl";
pub const NOTES: &str = "notes.json";

/// What `.git/info/exclude` gets, once.
const EXCLUDE_LINE: &str = ".veistra/takes/";

/// How long a take folder without `take.json` is left before it is taken for
/// the remains of a take that never finished. Far longer than closing a video
/// takes, and a take being recorded writes its video all the time.
pub const ORPHAN_AFTER: Duration = Duration::from_secs(60 * 60);

/// The empty drafts document every take starts with.
fn no_notes() -> Value {
    json!({ "version": 1, "notes": [] })
}

/// `<root>/.veistra/takes`.
pub fn dir_in(root: &Path) -> PathBuf {
    root.join(".veistra").join("takes")
}

/// A take id: the UTC minute it started and four hex digits, so two takes in
/// one minute never share a folder and ids sort the way takes were made. UTC
/// rather than local time because the id is a folder name that travels with a
/// worktree between machines; the page shows the local time from `startedAt`.
pub fn new_id(started_ms: u64, salt: u16) -> String {
    let (y, mo, d, h, mi) = utc_minute(started_ms);
    format!("{y:04}-{mo:02}-{d:02}-{h:02}{mi:02}-{salt:04x}")
}

/// Whether `id` is shaped like one [`new_id`] makes. Every id that reaches a
/// path join comes through here, so a crafted one cannot leave the folder.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 | 10 | 15 => *c == b'-',
            16..=19 => c.is_ascii_hexdigit(),
            _ => c.is_ascii_digit(),
        })
}

/// Year, month, day, hour and minute of a UTC epoch-milliseconds stamp
/// (Howard Hinnant's civil-from-days, so no date crate is needed for a name).
fn utc_minute(ms: u64) -> (i64, u32, u32, u32, u32) {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        (rem / 3_600) as u32,
        ((rem % 3_600) / 60) as u32,
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub branch: Option<String>,
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Counts {
    pub errors: u32,
    pub warnings: u32,
}

/// `take.json`, the shape in design §5.4. `number` (Take 4, Take 5), the
/// tick fields, `project` and `godotBuild` are additions: the toolbar names
/// takes by number, the acceptance checks for the capture addon read
/// `tickRate` (nine a second or more) and `tickUsP95` (500 or less when
/// `tickNodes` is 64), `project` says which Godot project of a multi-project
/// environment ran, and `godotBuild` keeps the whole version line `godot`
/// shortens to "4.5.1". `ticks` counts only the take's own, not the run's
/// before Record went on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub version: u32,
    pub id: String,
    #[serde(default)]
    pub number: u32,
    pub environment: EnvInfo,
    #[serde(default)]
    pub project: String,
    pub godot: String,
    #[serde(default)]
    pub godot_build: String,
    pub started_at: u64,
    pub duration_ms: u64,
    pub video: VideoInfo,
    pub scenes: Vec<SceneSpanJson>,
    pub marks: Vec<u64>,
    pub counts: Counts,
    #[serde(default)]
    pub ticks: u64,
    /// Ticks a second over the take, to one decimal.
    #[serde(default)]
    pub tick_rate: f64,
    /// The 95th percentile of the addon's `tickUs`.
    #[serde(default)]
    pub tick_us_p95: u32,
    /// The most nodes one tick tracked: the cost above is only the budget's
    /// answer when this reached the addon's cap of 64.
    #[serde(default)]
    pub tick_nodes: usize,
}

/// [`SceneSpan`] as `take.json` spells it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpanJson {
    pub path: String,
    pub from_ms: u64,
    pub to_ms: u64,
}

impl From<SceneSpan> for SceneSpanJson {
    fn from(s: SceneSpan) -> Self {
        Self {
            path: s.path,
            from_ms: s.from_ms,
            to_ms: s.to_ms,
        }
    }
}

/// Everything a finished run hands over to become a take.
pub struct Finish<'a> {
    pub dir: &'a Path,
    pub id: &'a str,
    pub number: u32,
    pub project: &'a str,
    pub environment: EnvInfo,
    /// The version as take.json shows it ("4.5.1"), and the line it came from.
    pub godot: &'a str,
    pub godot_build: &'a str,
    /// Wall time of the first video frame: take time zero.
    pub started_at: u64,
    pub ended_at: u64,
    pub video: VideoInfo,
    pub channel: Option<&'a Path>,
    pub log: &'a [LogLine],
    /// Marks from the toolbar, in wall time. F8 marks come from telemetry;
    /// one given here as well is still kept once.
    pub marks: &'a [u64],
}

/// How far either side of the take its telemetry copy reaches, so the tick
/// nearest a mark at either end is still in it.
const TELEMETRY_MARGIN: u64 = 200;

/// Write `telemetry.jsonl`, `log.jsonl`, an empty `notes.json` and then
/// `take.json`, last because it is what makes the folder a take to the list,
/// and answer the summary.
pub fn finish(f: &Finish) -> std::io::Result<Summary> {
    std::fs::create_dir_all(f.dir)?;
    let duration = f.ended_at.saturating_sub(f.started_at);
    let inside = |t: u64| t >= f.started_at && t <= f.ended_at;

    let lines = match f.channel {
        Some(channel) => telemetry::copy_window(
            channel,
            f.dir,
            f.started_at.saturating_sub(TELEMETRY_MARGIN),
            f.ended_at.saturating_add(TELEMETRY_MARGIN),
        )?,
        None => {
            std::fs::write(f.dir.join(telemetry::FILE), "")?;
            Vec::new()
        }
    };

    let mut marks: Vec<u64> = lines
        .iter()
        .filter_map(|l| match l {
            Line::Mark { t } => Some(*t),
            _ => None,
        })
        .chain(f.marks.iter().copied())
        .filter(|t| inside(*t))
        .map(|t| t - f.started_at)
        .collect();
    marks.sort_unstable();
    marks.dedup();

    let mut counts = Counts::default();
    let mut log = String::new();
    for line in f.log.iter().filter(|l| inside(l.at)) {
        match line.level {
            Level::Error => counts.errors += 1,
            Level::Warning => counts.warnings += 1,
            Level::Info => {}
        }
        let row = json!({
            "t": line.at,
            "ms": line.at - f.started_at,
            "level": line.level,
            "stream": line.stream,
            "text": line.text,
        });
        log.push_str(&row.to_string());
        log.push('\n');
    }
    std::fs::write(f.dir.join(LOG), log)?;
    // Never over drafts: the page may have saved some already.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(f.dir.join(NOTES))
    {
        Ok(file) => serde_json::to_writer_pretty(file, &no_notes())?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }

    let ticks = telemetry::tick_stats(&lines, f.started_at, f.ended_at);
    let summary = Summary {
        version: 1,
        id: f.id.to_string(),
        number: f.number,
        environment: f.environment.clone(),
        project: f.project.to_string(),
        godot: f.godot.to_string(),
        godot_build: f.godot_build.to_string(),
        started_at: f.started_at,
        duration_ms: duration,
        video: f.video,
        scenes: telemetry::scene_spans(&lines, f.started_at, duration)
            .into_iter()
            .map(Into::into)
            .collect(),
        marks,
        counts,
        ticks: ticks.count,
        tick_rate: (ticks.per_second * 10.0).round() / 10.0,
        tick_us_p95: ticks.tick_us_p95,
        tick_nodes: ticks.max_nodes,
    };
    write_json(&f.dir.join(SUMMARY), &summary)?;
    Ok(summary)
}

/// Correct `take.json`'s video once the file is closed and its size is known
/// from the file itself rather than from what the encoder was asked for.
pub fn set_video(dir: &Path, video: VideoInfo) -> Result<(), String> {
    let path = dir.join(SUMMARY);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("no take.json: {e}"))?;
    let mut summary: Summary =
        serde_json::from_str(&text).map_err(|e| format!("take.json: {e}"))?;
    summary.video = video;
    write_json(&path, &summary).map_err(|e| format!("could not write take.json: {e}"))
}

/// Written through a temporary file of its own, so two writes of one file at
/// once each land whole rather than one renaming the other's half-written
/// temporary.
fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}-{n}.tmp", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Held across every read-change-write of a `notes.json`: the page saves
/// drafts while Send stamps the notes it filed, and either could otherwise
/// write over the other's change.
static NOTES_LOCK: Mutex<()> = Mutex::new(());

/// One take as the Take menu lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    pub summary: Summary,
    /// The take's folder.
    pub path: String,
    pub bytes: u64,
    pub has_video: bool,
    /// Notes written and not yet sent: the take is kept until they are.
    pub drafts: usize,
}

/// Every finished take under `takes`, newest first. A folder without a
/// readable `take.json` (a run still recording, a crash before stop) is left
/// out rather than failing the list.
pub fn list(takes: &Path) -> Vec<Listed> {
    let Ok(entries) = std::fs::read_dir(takes) else {
        return Vec::new();
    };
    let mut out: Vec<Listed> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !valid_id(&name) {
                return None;
            }
            read(takes, &name).ok()
        })
        .collect();
    out.sort_by_key(|t| std::cmp::Reverse(t.summary.started_at));
    out
}

/// One take.
pub fn read(takes: &Path, id: &str) -> Result<Listed, String> {
    if !valid_id(id) {
        return Err(format!("`{id}` is not a take id"));
    }
    let dir = takes.join(id);
    let text = std::fs::read_to_string(dir.join(SUMMARY))
        .map_err(|e| format!("take `{id}` has no take.json: {e}"))?;
    let summary: Summary =
        serde_json::from_str(&text).map_err(|e| format!("take `{id}`'s take.json: {e}"))?;
    let bytes = std::fs::read_dir(&dir)
        .map(|it| {
            it.flatten()
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0);
    Ok(Listed {
        summary,
        path: dir.display().to_string(),
        bytes,
        has_video: dir.join(VIDEO).is_file(),
        drafts: drafts(&load_notes(takes, id)),
    })
}

/// The number the next take gets: one past the highest kept.
pub fn next_number(takes: &Path) -> u32 {
    list(takes)
        .iter()
        .map(|t| t.summary.number)
        .max()
        .unwrap_or(0)
        + 1
}

/// Draft notes as the page wrote them, or an empty document.
pub fn load_notes(takes: &Path, id: &str) -> Value {
    if !valid_id(id) {
        return no_notes();
    }
    std::fs::read_to_string(takes.join(id).join(NOTES))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(no_notes)
}

/// Replace a take's `notes.json`. The page owns the document's shape; this
/// only checks it is an object with a `notes` array, so a bad write cannot
/// leave the take's drafts unreadable.
///
/// A note already sent keeps its `commentId` and `packet` even when the page
/// writes it without them: a save the page made from a copy older than Send
/// would otherwise turn sent notes back into drafts, which offers to send
/// them again and keeps the take from ever being retired.
pub fn save_notes(takes: &Path, id: &str, notes: &Value) -> Result<(), String> {
    let mut doc = notes.clone();
    update_notes(takes, id, |old| {
        keep_stamps(old, &mut doc);
        Some(doc)
    })
}

/// Read a take's `notes.json`, let `change` answer the document to write
/// (`None` writes nothing), and write it, with no other notes write between.
pub fn update_notes(
    takes: &Path,
    id: &str,
    change: impl FnOnce(&Value) -> Option<Value>,
) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("`{id}` is not a take id"));
    }
    let dir = takes.join(id);
    if !dir.join(SUMMARY).is_file() {
        return Err(format!("there is no take `{id}`"));
    }
    let _lock = NOTES_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(next) = change(&load_notes(takes, id)) else {
        return Ok(());
    };
    if !next.get("notes").is_some_and(Value::is_array) {
        return Err("notes.json needs a `notes` array".to_string());
    }
    write_json(&dir.join(NOTES), &next).map_err(|e| format!("could not save the notes: {e}"))
}

/// Copy Send's stamps from `old` onto the same notes in `new`.
fn keep_stamps(old: &Value, new: &mut Value) {
    let Some(old) = old["notes"].as_array() else {
        return;
    };
    let Some(notes) = new.get_mut("notes").and_then(Value::as_array_mut) else {
        return;
    };
    for note in notes.iter_mut().filter(|n| n.is_object()) {
        if note.get("commentId").and_then(Value::as_str).is_some() {
            continue;
        }
        let sent = old
            .iter()
            .find(|o| o["n"] == note["n"] && o["commentId"].is_string());
        if let Some(sent) = sent {
            note["commentId"] = sent["commentId"].clone();
            if !sent["packet"].is_null() {
                note["packet"] = sent["packet"].clone();
            }
        }
    }
}

/// Notes not sent yet: those without the comment id Send gives each one.
pub fn drafts(notes: &Value) -> usize {
    notes["notes"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|n| n.get("commentId").and_then(Value::as_str).is_none())
                .count()
        })
        .unwrap_or(0)
}

/// Delete a take. The video goes first: it is the file another program (a
/// player that opened it without sharing delete) is likely to hold, and
/// failing on it before anything else is gone leaves the take whole and
/// listed, so retention tries it again. Failing after `take.json` had gone
/// would hide the folder from every later listing and leak the video.
pub fn delete(takes: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("`{id}` is not a take id"));
    }
    let dir = takes.join(id);
    if !dir.is_dir() {
        return Err(format!("there is no take `{id}`"));
    }
    let failed = |e: std::io::Error| format!("could not delete take `{id}`: {e}");
    match std::fs::remove_file(dir.join(VIDEO)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(failed(e)),
        _ => {}
    }
    std::fs::remove_dir_all(&dir).map_err(failed)
}

/// Keep the newest `keep` takes, plus any older one with drafts, and remove
/// what is left of takes that never finished. Answers the ids it deleted. A
/// take that will not delete (a file open in a player) is skipped and tried
/// again next time.
pub fn retain(takes: &Path, keep: usize) -> Vec<String> {
    retain_at(takes, keep, SystemTime::now())
}

fn retain_at(takes: &Path, keep: usize, now: SystemTime) -> Vec<String> {
    let mut gone = Vec::new();
    for old in list(takes).into_iter().skip(keep) {
        if old.drafts > 0 {
            continue;
        }
        if delete(takes, &old.summary.id).is_ok() {
            gone.push(old.summary.id);
        }
    }
    let Ok(entries) = std::fs::read_dir(takes) else {
        return gone;
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        let dir = entry.path();
        if !valid_id(&id) || dir.join(SUMMARY).exists() {
            continue;
        }
        let idle = now
            .duration_since(last_written(&dir))
            .unwrap_or(Duration::ZERO);
        if idle >= ORPHAN_AFTER && std::fs::remove_dir_all(&dir).is_ok() {
            gone.push(id);
        }
    }
    gone
}

/// When anything in a take folder was last written: the folder's own time,
/// or a newer one of a file in it (a video being recorded). Each file is
/// asked itself: Windows's listing can lag behind a file still open.
fn last_written(dir: &Path) -> SystemTime {
    let modified = |m: std::fs::Metadata| m.modified().ok();
    let files = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| std::fs::metadata(e.path()).ok().and_then(modified));
    std::fs::metadata(dir)
        .ok()
        .and_then(modified)
        .into_iter()
        .chain(files)
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Make sure the repository at `root` ignores takes, through its
/// `info/exclude`. No repository, or one already excluding them, is fine.
pub fn ensure_excluded(root: &Path) -> std::io::Result<()> {
    let Some(file) = crate::refs::policy::exclude_file(root) else {
        return Ok(());
    };
    let now = std::fs::read_to_string(&file).unwrap_or_default();
    if now.lines().any(|l| l.trim() == EXCLUDE_LINE) {
        return Ok(());
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = now;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("# Veistra's Play recordings, local to this machine\n");
    text.push_str(EXCLUDE_LINE);
    text.push('\n');
    std::fs::write(file, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ids_name_the_utc_minute_and_four_hex_digits() {
        // 2026-10-30 14:02 UTC.
        let id = new_id(1_793_368_920_000, 0x0f3a);
        assert_eq!(id, "2026-10-30-1402-0f3a");
        assert!(valid_id(&id));
        assert_eq!(new_id(0, 1), "1970-01-01-0000-0001");
        assert_eq!(utc_minute(951_782_400_000).1, 2, "29 Feb 2000 is February");
        assert_eq!(utc_minute(951_782_400_000).2, 29);
    }

    #[test]
    fn an_id_that_could_leave_the_folder_is_refused() {
        for bad in [
            "",
            "../2026-10-30-1402-0f",
            "2026-10-30-1402-0f3",
            "2026-10-30-1402-zzzz",
            "2026/10-30-1402-0f3a",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    fn log_line(seq: u64, at: u64, level: Level, text: &str) -> LogLine {
        LogLine {
            seq,
            stream: "out",
            level,
            text: text.to_string(),
            at,
        }
    }

    fn finish_one(takes: &Path, id: &str, started: u64, number: u32) -> Summary {
        let channel = takes.join(format!("chan-{id}"));
        std::fs::create_dir_all(&channel).unwrap();
        std::fs::write(
            channel.join(telemetry::FILE),
            format!(
                "{{\"t\":{early},\"kind\":\"tick\",\"scene\":\"res://a.tscn\",\"tickUs\":9000,\"nodes\":[{{}},{{}},{{}}]}}\n\
                 {{\"t\":{a},\"kind\":\"tick\",\"scene\":\"res://a.tscn\",\"frameMs\":16,\"tickUs\":310,\"nodes\":[{{}}]}}\n\
                 {{\"t\":{b},\"kind\":\"mark\"}}\n\
                 {{\"t\":{c},\"kind\":\"tick\",\"scene\":\"res://a.tscn\",\"frameMs\":16,\"tickUs\":420}}\n",
                early = started - 3_000,
                a = started + 100,
                b = started + 41_060,
                c = started + 50_000,
            ),
        )
        .unwrap();
        let log = [
            log_line(0, started - 500, Level::Error, "before the take"),
            log_line(1, started + 2_000, Level::Error, "ERROR: bad"),
            log_line(2, started + 3_000, Level::Warning, "WARNING: hmm"),
            log_line(3, started + 4_000, Level::Info, "hello"),
        ];
        finish(&Finish {
            dir: &takes.join(id),
            id,
            number,
            project: ".",
            environment: EnvInfo {
                branch: Some("wt/enemy-chase".into()),
                commit: Some("8c41e07".into()),
            },
            godot: "4.5.1",
            godot_build: "4.5.1.stable.official.f62fdbde1",
            started_at: started,
            ended_at: started + 151_400,
            video: VideoInfo {
                width: 1280,
                height: 720,
                fps: 30,
            },
            channel: Some(&channel),
            log: &log,
            marks: &[started + 72_010, started + 999_999],
        })
        .unwrap()
    }

    #[test]
    fn finishing_writes_the_design_s_take_json_and_both_logs() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().join("takes");
        let started = 1_793_398_920_000;
        let s = finish_one(&takes, "2026-10-30-1402-0f3a", started, 4);
        assert_eq!(s.duration_ms, 151_400);
        assert_eq!(
            s.marks,
            vec![41_060, 72_010],
            "F8 and toolbar marks, in take time"
        );
        assert_eq!(
            s.counts,
            Counts {
                errors: 1,
                warnings: 1
            },
            "only lines inside the take count"
        );
        assert_eq!(s.ticks, 2, "a tick from before the take is not the take's");
        assert_eq!(s.tick_rate, 0.0, "two ticks in 151 s round to nothing");
        assert_eq!(s.tick_us_p95, 420, "the early tick's cost is not counted");
        assert_eq!(s.tick_nodes, 1, "nor its three nodes");
        assert_eq!(s.scenes.len(), 1);
        assert_eq!(s.scenes[0].to_ms, 151_400);

        let take = takes.join("2026-10-30-1402-0f3a");
        let json: Value =
            serde_json::from_str(&std::fs::read_to_string(take.join(SUMMARY)).unwrap()).unwrap();
        for key in [
            "version",
            "id",
            "environment",
            "godot",
            "godotBuild",
            "startedAt",
            "durationMs",
            "video",
            "scenes",
            "marks",
            "counts",
            "ticks",
            "tickRate",
            "tickUsP95",
            "tickNodes",
        ] {
            assert!(json.get(key).is_some(), "take.json has `{key}`");
        }
        assert_eq!(json["scenes"][0]["fromMs"], 0);
        let log = std::fs::read_to_string(take.join(LOG)).unwrap();
        assert_eq!(log.lines().count(), 3);
        let first: Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert_eq!(first["ms"], 2_000);
        assert_eq!(first["level"], "error");
        let telemetry = std::fs::read_to_string(take.join(telemetry::FILE)).unwrap();
        assert_eq!(
            telemetry.lines().count(),
            3,
            "the tick from before the take is not copied"
        );
        assert_eq!(load_notes(&takes, "2026-10-30-1402-0f3a"), no_notes());
        assert!(
            !take.join(VIDEO).exists(),
            "the video is the recorder's, renamed in once it is closed"
        );
    }

    #[test]
    fn finishing_again_keeps_drafts_already_written() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().join("takes");
        let id = "2026-10-30-1402-0f3a";
        finish_one(&takes, id, 1_000_000, 1);
        let draft = json!({ "version": 1, "notes": [{ "n": 1, "body": "door" }] });
        save_notes(&takes, id, &draft).unwrap();
        finish_one(&takes, id, 1_000_000, 1);
        assert_eq!(load_notes(&takes, id), draft);
    }

    #[test]
    fn two_takes_of_one_run_each_keep_only_their_own_telemetry() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().join("chan");
        std::fs::create_dir_all(&channel).unwrap();
        let tick = |t: u64, scene: &str| {
            format!(
                "{{\"t\":{t},\"kind\":\"tick\",\"scene\":\"res://{scene}.tscn\",\"tickUs\":300}}\n"
            )
        };
        let text: String = (0..20)
            .map(|i| tick(10_000 + i * 100, "a"))
            .chain((0..30).map(|i| tick(20_000 + i * 100, "b")))
            .collect();
        std::fs::write(channel.join(telemetry::FILE), text).unwrap();
        let take = |id: &str, started: u64, ended: u64| {
            finish(&Finish {
                dir: &dir.path().join(id),
                id,
                number: 1,
                project: ".",
                environment: EnvInfo::default(),
                godot: "4.5.1",
                godot_build: "4.5.1.stable",
                started_at: started,
                ended_at: ended,
                video: VideoInfo::default(),
                channel: Some(&channel),
                log: &[],
                marks: &[],
            })
            .unwrap()
        };
        let one = take("2026-10-30-1402-0001", 10_000, 11_900);
        let two = take("2026-10-30-1403-0002", 20_000, 22_900);
        assert_eq!((one.ticks, two.ticks), (20, 30));
        assert_eq!(one.scenes.len(), 1);
        assert_eq!(one.scenes[0].path, "res://a.tscn");
        assert_eq!(
            two.scenes[0].path, "res://b.tscn",
            "not the first take's scene"
        );
        let lines = |id: &str| {
            std::fs::read_to_string(dir.path().join(id).join(telemetry::FILE))
                .unwrap()
                .lines()
                .count()
        };
        assert_eq!(lines("2026-10-30-1402-0001"), 20);
        assert_eq!(lines("2026-10-30-1403-0002"), 30);
    }

    #[test]
    fn the_video_size_is_corrected_from_the_closed_file() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        let id = "2026-10-30-1402-0f3a";
        finish_one(&takes, id, 1_000_000, 1);
        let video = VideoInfo {
            width: 1280,
            height: 718,
            fps: 30,
        };
        set_video(&takes.join(id), video).unwrap();
        let listed = read(&takes, id).unwrap();
        assert_eq!(listed.summary.video, video);
        assert_eq!(
            listed.summary.marks,
            vec![41_060, 72_010],
            "the rest is kept"
        );
        assert!(set_video(&takes.join("2026-10-30-1402-ffff"), video).is_err());
    }

    #[test]
    fn listing_is_newest_first_and_numbers_count_up() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        assert_eq!(next_number(&takes), 1);
        finish_one(&takes, "2026-10-30-1402-0001", 1_000_000, 1);
        finish_one(&takes, "2026-10-30-1403-0002", 2_000_000, 2);
        std::fs::create_dir_all(takes.join("2026-10-30-1404-0003")).unwrap();
        let listed = list(&takes);
        assert_eq!(
            listed.len(),
            2,
            "a folder with no take.json is still recording"
        );
        assert_eq!(listed[0].summary.id, "2026-10-30-1403-0002");
        assert!(!listed[0].has_video);
        assert!(listed[0].bytes > 0);
        assert_eq!(next_number(&takes), 3);
    }

    #[test]
    fn retention_keeps_the_newest_and_any_take_with_drafts() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        let ids: Vec<String> = (0..5u16)
            .map(|i| new_id(1_000_000 + u64::from(i) * 60_000, i))
            .collect();
        for (i, id) in ids.iter().enumerate() {
            finish_one(&takes, id, 1_000_000 + i as u64 * 60_000, i as u32 + 1);
        }
        let draft = json!({ "version": 1, "notes": [{ "n": 1, "body": "door" }] });
        save_notes(&takes, &ids[0], &draft).unwrap();
        let sent = json!({ "version": 1, "notes": [{ "n": 1, "commentId": "c1" }] });
        save_notes(&takes, &ids[1], &sent).unwrap();

        let gone = retain(&takes, 2);
        assert_eq!(gone, vec![ids[2].clone(), ids[1].clone()]);
        let left: Vec<String> = list(&takes).into_iter().map(|t| t.summary.id).collect();
        assert_eq!(left, vec![ids[4].clone(), ids[3].clone(), ids[0].clone()]);
        assert_eq!(read(&takes, &ids[0]).unwrap().drafts, 1);
    }

    #[test]
    fn a_take_that_never_finished_is_removed_once_it_has_sat_for_an_hour() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        finish_one(&takes, "2026-10-30-1402-0001", 1_000_000, 1);
        let orphan = takes.join("2026-10-30-1403-0002");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join(VIDEO_PART), b"half a video").unwrap();
        std::fs::create_dir_all(takes.join("not-a-take")).unwrap();

        let now = SystemTime::now();
        assert!(
            retain_at(&takes, 10, now).is_empty(),
            "it may still be recording"
        );
        assert!(orphan.is_dir());
        let later = now + ORPHAN_AFTER + Duration::from_secs(60);
        assert_eq!(
            retain_at(&takes, 10, later),
            vec!["2026-10-30-1403-0002".to_string()]
        );
        assert!(!orphan.exists());
        assert!(
            takes.join("not-a-take").is_dir(),
            "only take folders are touched"
        );
        assert_eq!(list(&takes).len(), 1, "a finished take is not an orphan");
    }

    #[test]
    fn notes_must_be_a_document_with_a_notes_array_on_a_real_take() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        let id = "2026-10-30-1402-0f3a";
        assert!(
            save_notes(&takes, id, &json!({ "notes": [] })).is_err(),
            "no take yet"
        );
        finish_one(&takes, id, 1_000_000, 1);
        assert!(save_notes(&takes, id, &json!({ "notes": 3 })).is_err());
        assert!(save_notes(&takes, "../x", &json!({ "notes": [] })).is_err());
        save_notes(&takes, id, &json!({ "version": 1, "notes": [] })).unwrap();
        assert_eq!(load_notes(&takes, id)["notes"], json!([]));
        assert_eq!(
            load_notes(&takes, "2026-10-30-1402-ffff")["notes"],
            json!([])
        );
    }

    #[test]
    fn takes_are_excluded_through_info_exclude_once() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::write(root.join(".git/info/exclude"), "*.log").unwrap();
        ensure_excluded(root).unwrap();
        ensure_excluded(root).unwrap();
        let text = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(text.starts_with("*.log\n"));
        assert_eq!(text.matches(EXCLUDE_LINE).count(), 1);
        assert!(
            !root.join(".gitignore").exists(),
            "the project's own files are untouched"
        );

        let bare = TempDir::new().unwrap();
        ensure_excluded(bare.path()).unwrap();
    }

    /// The same, against git itself: a take folder in a linked worktree, and
    /// one in the main tree, are both left out of `git status`.
    #[test]
    fn takes_in_a_linked_worktree_are_left_out_of_git_status_in_every_tree() {
        let dir = TempDir::new().unwrap();
        let main = dir.path().join("main");
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&main).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let out = crate::git::git_command()
                .current_dir(cwd)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success(), "git {args:?}: {stderr}");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        git(&main, &["init", "-q"]);
        std::fs::write(main.join("project.godot"), "").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-qm", "init"]);
        git(&main, &["worktree", "add", "-q", &wt.to_string_lossy()]);

        ensure_excluded(&wt).unwrap();
        ensure_excluded(&wt).unwrap();
        for root in [&main, &wt] {
            let take = dir_in(root).join("2026-10-30-1402-0f3a");
            std::fs::create_dir_all(&take).unwrap();
            std::fs::write(take.join(SUMMARY), "{}").unwrap();
            std::fs::write(take.join(VIDEO_PART), "").unwrap();
        }
        assert_eq!(git(&wt, &["status", "--porcelain"]), "");
        assert_eq!(git(&main, &["status", "--porcelain"]), "");
        let exclude = std::fs::read_to_string(main.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches(EXCLUDE_LINE).count(), 1);
    }

    #[test]
    fn delete_removes_only_a_take_folder() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        finish_one(&takes, "2026-10-30-1402-0f3a", 1_000_000, 1);
        assert!(delete(&takes, "..").is_err());
        assert!(delete(&takes, "2026-10-30-1402-ffff").is_err());
        delete(&takes, "2026-10-30-1402-0f3a").unwrap();
        assert!(list(&takes).is_empty());
    }

    #[test]
    fn a_video_that_will_not_delete_leaves_the_take_whole_for_next_time() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        let id = "2026-10-30-1402-0f3a";
        finish_one(&takes, id, 1_000_000, 1);
        // A folder where the video should be: `remove_file` refuses it the
        // way Windows refuses a file a player holds open.
        std::fs::create_dir_all(takes.join(id).join(VIDEO).join("held")).unwrap();
        assert!(delete(&takes, id).is_err());
        assert!(
            takes.join(id).join(SUMMARY).is_file(),
            "take.json is still there"
        );
        assert_eq!(list(&takes).len(), 1, "so retention sees it again");
    }

    #[test]
    fn a_mark_given_twice_is_kept_once() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().join("chan");
        std::fs::create_dir_all(&channel).unwrap();
        std::fs::write(
            channel.join(telemetry::FILE),
            "{\"t\":1500,\"kind\":\"mark\"}\n",
        )
        .unwrap();
        let s = finish(&Finish {
            dir: &dir.path().join("take"),
            id: "2026-10-30-1402-0f3a",
            number: 1,
            project: ".",
            environment: EnvInfo::default(),
            godot: "4.5.1",
            godot_build: "4.5.1.stable.official.f62fdbde1",
            started_at: 1_000,
            ended_at: 9_000,
            video: VideoInfo::default(),
            channel: Some(&channel),
            log: &[],
            marks: &[1_500, 4_000],
        })
        .unwrap();
        assert_eq!(s.marks, vec![500, 3_000]);
    }

    #[test]
    fn a_save_from_before_send_does_not_turn_sent_notes_back_into_drafts() {
        let dir = TempDir::new().unwrap();
        let takes = dir.path().to_path_buf();
        let id = "2026-10-30-1402-0f3a";
        finish_one(&takes, id, 1_000_000, 1);
        let before = json!({ "version": 1, "notes": [{ "n": 1, "body": "door" }, { "n": 2, "body": "wall" }] });
        save_notes(&takes, id, &before).unwrap();
        update_notes(&takes, id, |doc| {
            let mut doc = doc.clone();
            doc["notes"][0]["commentId"] = json!("c1");
            doc["notes"][0]["packet"] = json!("p1");
            Some(doc)
        })
        .unwrap();
        let stale = json!({ "version": 1, "notes": [{ "n": 1, "body": "door!" }, { "n": 2, "body": "wall!" }] });
        save_notes(&takes, id, &stale).unwrap();
        let now = load_notes(&takes, id);
        assert_eq!(now["notes"][0]["commentId"], "c1");
        assert_eq!(now["notes"][0]["packet"], "p1");
        assert_eq!(now["notes"][0]["body"], "door!", "the newer words are kept");
        assert_eq!(drafts(&now), 1, "only note 2 is a draft");
        let leftovers: Vec<_> = std::fs::read_dir(takes.join(id))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
