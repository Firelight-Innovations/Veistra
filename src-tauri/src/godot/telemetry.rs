//! What capture addon v2 writes while a game runs: one JSON object a line in
//! `telemetry.jsonl` in the run's channel folder.
//!
//! A tick ten times a second (scene, camera, player, frame time, mouse mode,
//! the screen boxes of tracked nodes, and what the addon's own work cost:
//! `tickUs`, and `refreshUs` after it read its candidates again), plus
//! events: a `mark` for F8, a `scene` when
//! the current scene changes, a `key` for F7 and Ctrl Shift M, which the addon
//! handles itself so the game never sees them. Every line carries `t`, wall
//! clock milliseconds, which is the one clock a take is built on (§5.3 of the
//! design): take time is wall time minus the first video frame's.
//!
//! Parsing is lenient on purpose. The file is appended by another process and
//! flushed once a second, so the last line is often half written, and a game
//! may add fields this build has never heard of. A line that does not parse is
//! skipped, never an error.

use serde::Deserialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const FILE: &str = "telemetry.jsonl";

/// One parsed line. Ticks keep their raw JSON beside the fields this module
/// reads, so a note's `context.json` can carry everything the game reported.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Tick(Tick),
    Mark { t: u64 },
    Scene { t: u64, scene: String },
    Key { t: u64, key: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tick {
    pub t: u64,
    pub scene: String,
    pub frame_ms: Option<f64>,
    /// `Input.mouse_mode`: 0 visible, 1 hidden, 2 captured, 3 confined.
    pub mouse: Option<u8>,
    pub raw: Value,
}

#[derive(Deserialize)]
struct Head {
    t: f64,
    kind: String,
    #[serde(default)]
    scene: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default, rename = "frameMs")]
    frame_ms: Option<f64>,
    #[serde(default)]
    mouse: Option<u8>,
}

/// One line of the file, or `None` for a line that is not one this build reads.
pub fn parse_line(text: &str) -> Option<Line> {
    let raw: Value = serde_json::from_str(text.trim()).ok()?;
    let head: Head = serde_json::from_value(raw.clone()).ok()?;
    if !head.t.is_finite() || head.t < 0.0 {
        return None;
    }
    let t = head.t.round() as u64;
    Some(match head.kind.as_str() {
        "tick" => Line::Tick(Tick {
            t,
            scene: head.scene.unwrap_or_default(),
            frame_ms: head.frame_ms,
            mouse: head.mouse,
            raw,
        }),
        "mark" => Line::Mark { t },
        "scene" => Line::Scene {
            t,
            scene: head.scene?,
        },
        "key" => Line::Key { t, key: head.key? },
        _ => return None,
    })
}

/// Every line of `text` this build reads, in file order.
pub fn parse_all(text: &str) -> Vec<Line> {
    text.lines().filter_map(parse_line).collect()
}

/// Reads a growing file from where it last stopped, handing back only whole
/// lines. The half-written tail stays in the file for the next read.
#[derive(Debug)]
pub struct Tail {
    path: PathBuf,
    offset: u64,
    /// Ticks seen so far, for the ticks-a-second check.
    pub ticks: u64,
}

impl Tail {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            ticks: 0,
        }
    }

    /// New whole lines since the last call. A file that does not exist yet is
    /// no lines; a file that shrank (a new game reusing the folder) starts over.
    pub fn read(&mut self) -> Vec<Line> {
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            self.offset = 0;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
            return Vec::new();
        };
        self.offset += end as u64 + 1;
        let lines = parse_all(&String::from_utf8_lossy(&bytes[..=end]));
        self.ticks += lines.iter().filter(|l| matches!(l, Line::Tick(_))).count() as u64;
        lines
    }
}

/// One stretch of a take spent in one scene, in take milliseconds.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpan {
    pub path: String,
    pub from_ms: u64,
    pub to_ms: u64,
}

/// The scenes a take passed through, from scene events and from the scene
/// each tick names (a game that changes scene between two ticks without the
/// addon seeing the event still shows up). `t0` is the take's start in wall
/// time and `duration` its length. An empty scene is the moment between two
/// that Godot passes through, which an earlier v2 wrote as an event; it is
/// not a span.
pub fn scene_spans(lines: &[Line], t0: u64, duration: u64) -> Vec<SceneSpan> {
    let mut spans: Vec<SceneSpan> = Vec::new();
    for line in lines {
        let (t, scene) = match line {
            Line::Tick(tick) => (tick.t, tick.scene.as_str()),
            Line::Scene { t, scene } => (*t, scene.as_str()),
            _ => continue,
        };
        if scene.is_empty() {
            continue;
        }
        let at = t.saturating_sub(t0).min(duration);
        match spans.last_mut() {
            Some(last) if last.path == scene => last.to_ms = last.to_ms.max(at),
            Some(last) => {
                last.to_ms = at;
                spans.push(SceneSpan {
                    path: scene.to_string(),
                    from_ms: at,
                    to_ms: at,
                });
            }
            None => spans.push(SceneSpan {
                path: scene.to_string(),
                from_ms: 0,
                to_ms: at,
            }),
        }
    }
    if let Some(last) = spans.last_mut() {
        last.to_ms = duration;
    }
    spans
}

/// The tick closest in time to `t` (wall ms), if there is one within `within`.
pub fn nearest_tick(lines: &[Line], t: u64, within: u64) -> Option<&Tick> {
    lines
        .iter()
        .filter_map(|l| match l {
            Line::Tick(tick) => Some(tick),
            _ => None,
        })
        .min_by_key(|tick| tick.t.abs_diff(t))
        .filter(|tick| tick.t.abs_diff(t) <= within)
}

/// The worst frame time between `from` and `to` (wall ms), and when.
pub fn worst_frame(lines: &[Line], from: u64, to: u64) -> Option<(u64, f64)> {
    lines
        .iter()
        .filter_map(|l| match l {
            Line::Tick(tick) if tick.t >= from && tick.t <= to => {
                tick.frame_ms.map(|ms| (tick.t, ms))
            }
            _ => None,
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// How the addon kept up between `from` and `to` (wall ms): the numbers
/// design §13 test 3 (nine ticks a second or more) and §5.5 (a tick costs
/// 0.5 ms or less at 64 nodes) are checked against.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TickStats {
    pub count: u64,
    /// Ticks a second over the whole stretch, gaps included.
    pub per_second: f64,
    /// The 95th percentile of the addon's own `tickUs`, as it reported them.
    pub tick_us_p95: u32,
    /// The most nodes one tick tracked.
    pub max_nodes: usize,
}

pub fn tick_stats(lines: &[Line], from: u64, to: u64) -> TickStats {
    let ticks: Vec<&Tick> = lines
        .iter()
        .filter_map(|l| match l {
            Line::Tick(tick) if tick.t >= from && tick.t <= to => Some(tick),
            _ => None,
        })
        .collect();
    let mut costs: Vec<u32> = ticks
        .iter()
        .filter_map(|t| t.raw["tickUs"].as_u64())
        .map(|us| u32::try_from(us).unwrap_or(u32::MAX))
        .collect();
    costs.sort_unstable();
    let seconds = to.saturating_sub(from) as f64 / 1000.0;
    TickStats {
        count: ticks.len() as u64,
        per_second: if seconds > 0.0 {
            ticks.len() as f64 / seconds
        } else {
            0.0
        },
        // Nearest rank: the smallest cost at least 95 % of ticks stay under.
        tick_us_p95: match costs.len() {
            0 => 0,
            n => costs[(n * 95).div_ceil(100) - 1],
        },
        max_nodes: ticks
            .iter()
            .filter_map(|t| t.raw["nodes"].as_array().map(Vec::len))
            .max()
            .unwrap_or(0),
    }
}

/// Copy the lines of the run's telemetry stamped `from` to `to` (wall ms) into
/// a take folder, and answer them parsed. Only the take's own: a run recorded
/// twice, or switched to Record late, holds ticks from before the take, and a
/// take that carried them showed a scene it never reached and counted ticks
/// the take's rate never had. A line kept is copied as the game wrote it,
/// fields this build does not read included. A run that wrote none leaves an
/// empty file, so every take has its telemetry file.
pub fn copy_window(
    channel: &Path,
    take_dir: &Path,
    from: u64,
    to: u64,
) -> std::io::Result<Vec<Line>> {
    use std::io::{BufRead, BufReader, BufWriter, Write};
    #[derive(Deserialize)]
    struct Stamp {
        t: f64,
    }
    let mut out = BufWriter::new(std::fs::File::create(take_dir.join(FILE))?);
    let mut kept = Vec::new();
    if let Ok(file) = std::fs::File::open(channel.join(FILE)) {
        for line in BufReader::new(file).split(b'\n') {
            let line = line?;
            let Ok(stamp) = serde_json::from_slice::<Stamp>(&line) else {
                continue;
            };
            let t = stamp.t.round();
            if !(t >= from as f64 && t <= to as f64) {
                continue;
            }
            out.write_all(&line)?;
            out.write_all(b"\n")?;
            kept.extend(parse_line(&String::from_utf8_lossy(&line)));
        }
    }
    out.flush()?;
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const TICK: &str = r#"{"t":1793398962180,"kind":"tick","scene":"res://levels/hallway.tscn","camera":{"pos":[12.1,1.6,-2.3],"target":[14.0,1.2,-6.6],"up":[0,1,0],"fov":70},"frameMs":16.4,"nodes":[{"path":"Hallway/Enemy_02","type":"CharacterBody3D","rect":[905,210,250,410]}]}"#;

    #[test]
    fn the_design_s_tick_parses_and_keeps_what_it_does_not_name() {
        let Some(Line::Tick(tick)) = parse_line(TICK) else {
            panic!("a tick");
        };
        assert_eq!(tick.t, 1_793_398_962_180);
        assert_eq!(tick.scene, "res://levels/hallway.tscn");
        assert_eq!(tick.frame_ms, Some(16.4));
        assert_eq!(tick.raw["nodes"][0]["path"], "Hallway/Enemy_02");
        assert_eq!(tick.mouse, None, "an addon that does not say");
        let captured = TICK.replacen("\"frameMs\"", "\"mouse\":2,\"frameMs\"", 1);
        let Some(Line::Tick(tick)) = parse_line(&captured) else {
            panic!("a tick");
        };
        assert_eq!(tick.mouse, Some(2));
    }

    #[test]
    fn events_parse_and_anything_else_is_skipped() {
        assert_eq!(
            parse_line(r#"{"t":5,"kind":"mark"}"#),
            Some(Line::Mark { t: 5 })
        );
        assert_eq!(
            parse_line(r#"{"t":5.6,"kind":"key","key":"F7"}"#),
            Some(Line::Key {
                t: 6,
                key: "F7".into()
            })
        );
        for bad in [
            "",
            "{",
            r#"{"kind":"mark"}"#,
            r#"{"t":5,"kind":"shrug"}"#,
            r#"{"t":5,"kind":"key"}"#,
            r#"{"t":-1,"kind":"mark"}"#,
        ] {
            assert_eq!(parse_line(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_tail_hands_back_whole_lines_and_keeps_the_half_written_one() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(FILE);
        let mut tail = Tail::new(path.clone());
        assert!(tail.read().is_empty(), "no file yet");

        std::fs::write(&path, format!("{TICK}\n{{\"t\":7,\"kind\":\"ma")).unwrap();
        let first = tail.read();
        assert_eq!(first.len(), 1);
        assert_eq!(tail.ticks, 1);

        std::fs::write(&path, format!("{TICK}\n{{\"t\":7,\"kind\":\"mark\"}}\n")).unwrap();
        assert_eq!(tail.read(), vec![Line::Mark { t: 7 }]);
        assert!(tail.read().is_empty(), "nothing new");

        std::fs::write(&path, "{\"t\":9,\"kind\":\"mark\"}\n").unwrap();
        assert_eq!(
            tail.read(),
            vec![Line::Mark { t: 9 }],
            "a shorter file starts over"
        );
    }

    fn tick(t: u64, scene: &str, frame_ms: f64) -> Line {
        Line::Tick(Tick {
            t,
            scene: scene.into(),
            frame_ms: Some(frame_ms),
            mouse: None,
            raw: Value::Null,
        })
    }

    #[test]
    fn scene_spans_run_from_the_start_to_the_end_of_the_take() {
        let lines = vec![
            tick(1_000, "res://a.tscn", 16.0),
            tick(1_100, "res://a.tscn", 16.0),
            Line::Scene {
                t: 5_000,
                scene: "res://b.tscn".into(),
            },
            tick(5_100, "res://b.tscn", 16.0),
        ];
        assert_eq!(
            scene_spans(&lines, 1_000, 9_000),
            vec![
                SceneSpan {
                    path: "res://a.tscn".into(),
                    from_ms: 0,
                    to_ms: 4_000
                },
                SceneSpan {
                    path: "res://b.tscn".into(),
                    from_ms: 4_000,
                    to_ms: 9_000
                },
            ]
        );
        assert!(scene_spans(&[], 0, 10).is_empty());
    }

    #[test]
    fn the_empty_scene_between_two_is_not_a_span() {
        let scene = |t: u64, scene: &str| Line::Scene {
            t,
            scene: scene.into(),
        };
        let lines = vec![
            scene(1_000, "res://a.tscn"),
            scene(4_000, ""),
            tick(4_050, "", 16.0),
            scene(4_100, "res://b.tscn"),
        ];
        let spans = scene_spans(&lines, 1_000, 9_000);
        let paths: Vec<&str> = spans.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(paths, ["res://a.tscn", "res://b.tscn"]);
        assert_eq!((spans[0].to_ms, spans[1].from_ms), (3_100, 3_100));
    }

    /// A tick with the addon's own cost and `nodes` tracked nodes.
    fn costed(t: u64, tick_us: u64, nodes: usize) -> Line {
        let raw = serde_json::json!({
            "t": t,
            "kind": "tick",
            "tickUs": tick_us,
            "nodes": vec![serde_json::json!({}); nodes],
        });
        parse_line(&raw.to_string()).unwrap()
    }

    #[test]
    fn tick_stats_count_only_their_window_and_take_the_95th_cost() {
        // Two seconds before the window, as when Record goes on mid-run, then
        // ten seconds of ticks every 100 ms with one slow tick in twenty.
        let mut lines: Vec<Line> = (0..20).map(|i| costed(i * 100, 900, 3)).collect();
        for i in 0..100 {
            let us = if i % 20 == 19 { 2_000 } else { 300 };
            lines.push(costed(2_000 + i * 100, us, if i == 50 { 64 } else { 12 }));
        }
        let stats = tick_stats(&lines, 2_000, 12_000);
        assert_eq!(stats.count, 100);
        assert!((stats.per_second - 10.0).abs() < 1e-9);
        assert_eq!(stats.tick_us_p95, 300, "5 slow ticks in 100 sit above it");
        assert_eq!(stats.max_nodes, 64);

        let slow = tick_stats(&lines[..60], 0, 6_000);
        assert_eq!(slow.count, 60);
        assert_eq!(slow.tick_us_p95, 900, "the costly ticks are inside now");
        assert_eq!(tick_stats(&[], 0, 1_000), TickStats::default());
        assert_eq!(tick_stats(&lines, 5_000, 5_000).per_second, 0.0);
    }

    #[test]
    fn the_nearest_tick_and_the_worst_frame_are_found_in_their_window() {
        let lines = vec![
            tick(1_000, "s", 16.0),
            tick(1_100, "s", 41.0),
            tick(1_200, "s", 17.0),
        ];
        assert_eq!(nearest_tick(&lines, 1_140, 500).map(|t| t.t), Some(1_100));
        assert_eq!(
            nearest_tick(&lines, 9_000, 500),
            None,
            "too far from any tick"
        );
        assert_eq!(worst_frame(&lines, 0, 2_000), Some((1_100, 41.0)));
        assert_eq!(worst_frame(&lines, 1_150, 2_000), Some((1_200, 17.0)));
    }

    #[test]
    fn a_take_copies_only_its_own_lines_and_keeps_what_it_does_not_read() {
        let dir = TempDir::new().unwrap();
        let channel = dir.path().join("chan");
        std::fs::create_dir_all(&channel).unwrap();
        std::fs::write(
            channel.join(FILE),
            "{\"t\":1000,\"kind\":\"tick\",\"scene\":\"res://a.tscn\"}\n\
             {\"t\":2000,\"kind\":\"mark\"}\n\
             not json\n\
             {\"t\":2500,\"kind\":\"future\",\"x\":1}\n\
             {\"t\":5000,\"kind\":\"tick\",\"scene\":\"res://b.tscn\"}\n\
             {\"t\":5100,\"kind\":\"mark\"}\n\
             {\"t\":59",
        )
        .unwrap();
        let first = dir.path().join("one");
        let second = dir.path().join("two");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();

        let kept = copy_window(&channel, &first, 900, 3_000).unwrap();
        assert_eq!(
            kept.len(),
            2,
            "the tick and the mark; the future kind is copied unread"
        );
        let text = std::fs::read_to_string(first.join(FILE)).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("\"future\""));
        assert!(!text.contains("b.tscn"), "the next take's scene");

        let kept = copy_window(&channel, &second, 4_800, 6_000).unwrap();
        assert_eq!(
            kept,
            vec![
                parse_line("{\"t\":5000,\"kind\":\"tick\",\"scene\":\"res://b.tscn\"}").unwrap(),
                Line::Mark { t: 5_100 }
            ]
        );
        assert_eq!(
            std::fs::read_to_string(second.join(FILE))
                .unwrap()
                .lines()
                .count(),
            2,
            "nor the half-written last line"
        );

        let none = dir.path().join("none");
        std::fs::create_dir_all(&none).unwrap();
        assert!(copy_window(&dir.path().join("missing"), &none, 0, 1)
            .unwrap()
            .is_empty());
        assert_eq!(std::fs::read_to_string(none.join(FILE)).unwrap(), "");
    }
}
