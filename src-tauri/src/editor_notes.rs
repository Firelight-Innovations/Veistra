//! The Veistra tab inside the Godot editor and Blender (#320, DECISIONS X5):
//! the two channel files the Godot dock and the Blender N-panel share with
//! Veistra, beside the `cmd.json` / `res-<id>.json` pair #316 and #317 use.
//!
//! - `notes.json`, Veistra to the editor: one snapshot, replaced whole (a
//!   `.tmp`, then a rename), with a `rev` that changes with it. It holds the
//!   notes the editor can show and the answers to its own events. The editor
//!   never reads `.veistra/comments/`, which can sit above `res://`, and never
//!   writes there.
//! - `events.jsonl`, the editor to Veistra: one JSON object a line, appended,
//!   the PNG an ask names written before its line. Rust tails it, checks each
//!   line ([`parse_event`]) and numbers the good ones with a `seq` the pane
//!   polls after. The pane acts on an event through the same RPCs the cards
//!   use, then answers it with an ack that lands in the next `notes.json`.
//!
//! A line that fails the checks is answered here with a failed ack, so the
//! tab says why instead of waiting.

use crate::apps::CallContext;
use crate::comments::{self, Anchor, Comment, Status};
use crate::godot::telemetry::Tail;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const NOTES: &str = "notes.json";
pub const EVENTS: &str = "events.jsonl";
/// The longest question Ask the agent takes, in characters.
pub const MAX_TEXT: usize = 4000;
/// A line longer than this is refused unread.
const MAX_LINE: usize = 64 * 1024;
const MAX_NODES: usize = 64;
const ACKS_KEPT: usize = 20;
/// Events kept for a pane that has not polled yet; the oldest go first.
const EVENTS_KEPT: usize = 100;

/// Which notes a tab shows. Godot: notes on a node and Play's notes on a
/// take, matched by node path in the dock. Blender: notes on a part of the
/// open file (by its environment-relative path; `None` while it is unsaved).
/// Take notes are not shown in Blender: a Godot node path is not an object
/// name, and no mapping is decided (X12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope<'a> {
    Godot,
    Blender { file: Option<&'a str> },
}

/// The words a card shows for a status, as `statusView` in
/// `apps/shared/comments.ts` has them.
pub fn label(status: Status) -> &'static str {
    match status {
        Status::Open => "Sent",
        Status::Working => "Agent working",
        Status::Fixed => "Fixed, check it",
        Status::Resolved => "Resolved",
    }
}

/// One row of `notes.json`, or `None` for a note this tab does not show.
pub fn row(comment: &Comment, scope: Scope) -> Option<Value> {
    let mut row = match (&comment.anchor, scope) {
        (Anchor::Node { path, scene }, Scope::Godot) => {
            json!({ "kind": "node", "path": path, "scene": scene, "title": "Note" })
        }
        (
            Anchor::Take {
                n,
                at_ms,
                scene,
                node_path: Some(path),
                ..
            },
            Scope::Godot,
        ) => json!({
            "kind": "take", "path": path, "scene": scene,
            "title": format!("Play note {n} at {}", crate::godot::feedback::clock(*at_ms)),
        }),
        (
            Anchor::Mesh {
                part,
                material,
                blend,
                ..
            },
            Scope::Blender { file },
        ) => {
            if blend.is_some() && blend.as_deref() != file {
                return None;
            }
            json!({ "kind": "mesh", "part": part, "material": material, "title": material })
        }
        _ => return None,
    };
    let replies: Vec<Value> = comment
        .replies
        .iter()
        .map(|r| json!({ "by": r.by, "body": r.body }))
        .collect();
    let fix = comment
        .resolution
        .as_ref()
        .map(|r| json!({ "by": r.by, "note": r.note, "commit": r.commit }));
    let fields = json!({
        "id": comment.id,
        "status": comment.status.name(),
        "label": label(comment.status),
        "body": comment.body,
        "replies": replies,
        "fix": fix,
    });
    if let (Some(row), Value::Object(more)) = (row.as_object_mut(), fields) {
        row.extend(more);
    }
    Some(row)
}

pub fn rows(comments: &[Comment], scope: Scope) -> Vec<Value> {
    comments.iter().filter_map(|c| row(c, scope)).collect()
}

/// The editor's answer to one of its events, shown in the tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub n: u64,
    pub ok: bool,
    #[serde(default)]
    pub message: String,
}

/// One checked line of `events.jsonl`. `n` is the editor's own number for
/// it, which its ack carries back; `t` is wall-clock milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub enum EditorEvent {
    /// Ask the agent: the question, the scene or file, the selected nodes or
    /// objects, the view, and the picture of the viewport (`ask-<n>.png`).
    Ask {
        n: u64,
        t: u64,
        text: String,
        scene: Option<String>,
        nodes: Vec<String>,
        camera: Option<Value>,
        png: Option<String>,
    },
    /// Looks good or Still broken on a note the tab showed as fixed.
    Verdict {
        n: u64,
        t: u64,
        id: String,
        good: bool,
        reply: Option<String>,
    },
    /// Mark up the viewport, which the pane does.
    Markup { n: u64, t: u64 },
}

impl EditorEvent {
    pub fn n(&self) -> u64 {
        match self {
            Self::Ask { n, .. } | Self::Verdict { n, .. } | Self::Markup { n, .. } => *n,
        }
    }
}

/// A line that is not an event: its number, when it had one, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub n: Option<u64>,
    pub why: String,
}

fn refuse(n: Option<u64>, why: impl Into<String>) -> Refused {
    Refused { n, why: why.into() }
}

/// A comment id as `comments::new_id` writes them, so nothing else is ever
/// looked up or named from a line.
fn is_comment_id(id: &str) -> bool {
    let b = id.as_bytes();
    let hex = |s: &[u8]| {
        s.iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    };
    b.len() == 17 && b[12] == b'-' && hex(&b[..12]) && hex(&b[13..])
}

fn text_field(v: &Value, key: &str, n: u64) -> Result<Option<String>, Refused> {
    match &v[key] {
        Value::Null => Ok(None),
        Value::String(s) if s.chars().count() <= MAX_TEXT => Ok(Some(s.clone())),
        Value::String(_) => Err(refuse(
            Some(n),
            format!("{key} is longer than {MAX_TEXT} characters"),
        )),
        _ => Err(refuse(Some(n), format!("{key} is not text"))),
    }
}

/// Check one line. The rules: a number, a known kind; an ask has a question
/// of at most [`MAX_TEXT`] characters and names no picture but its own
/// `ask-<n>.png`; a verdict names a comment id and says good or broken.
pub fn parse_event(line: &str) -> Result<EditorEvent, Refused> {
    if line.len() > MAX_LINE {
        return Err(refuse(None, "the line is too long"));
    }
    let v: Value = serde_json::from_str(line).map_err(|e| refuse(None, e.to_string()))?;
    let n = v["n"]
        .as_u64()
        .ok_or_else(|| refuse(None, "the event has no number"))?;
    let t = v["t"].as_u64().unwrap_or(0);
    match v["kind"].as_str() {
        Some("ask") => {
            let text = text_field(&v, "text", n)?.unwrap_or_default();
            if text.trim().is_empty() {
                return Err(refuse(Some(n), "write a question first"));
            }
            let png = match v["png"].as_str() {
                None => None,
                Some(name) if name == format!("ask-{n}.png") => Some(name.to_string()),
                Some(_) => return Err(refuse(Some(n), "the picture is not this ask's")),
            };
            let nodes: Vec<String> = v["nodes"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if nodes.len() > MAX_NODES {
                return Err(refuse(Some(n), "too many nodes are selected"));
            }
            Ok(EditorEvent::Ask {
                n,
                t,
                text,
                scene: text_field(&v, "scene", n)?,
                nodes,
                camera: Some(v["camera"].clone()).filter(|c| !c.is_null()),
                png,
            })
        }
        Some("verdict") => {
            let id = v["id"].as_str().unwrap_or_default();
            if !is_comment_id(id) {
                return Err(refuse(Some(n), "that is not a note"));
            }
            let good = match v["verdict"].as_str() {
                Some("good") => true,
                Some("broken") => false,
                _ => return Err(refuse(Some(n), "the verdict is neither good nor broken")),
            };
            Ok(EditorEvent::Verdict {
                n,
                t,
                id: id.to_string(),
                good,
                reply: text_field(&v, "reply", n)?,
            })
        }
        Some("markup") => Ok(EditorEvent::Markup { n, t }),
        _ => Err(refuse(Some(n), "unknown kind")),
    }
}

/// What changing the notes changes: the comment files' count, total size and
/// newest modification, and what the tab is scoped to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Sig {
    count: usize,
    bytes: u64,
    newest_ns: u128,
    scope: String,
}

fn signature(context: &CallContext, scope: Scope) -> Sig {
    let mut sig = Sig {
        scope: format!("{scope:?}"),
        ..Sig::default()
    };
    let Some(dir) = context
        .project
        .as_ref()
        .map(|p| p.join(".veistra").join("comments"))
    else {
        return sig;
    };
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        sig.count += 1;
        sig.bytes += meta.len();
        let ns = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        sig.newest_ns = sig.newest_ns.max(ns);
    }
    sig
}

fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// One editor's side of the two files: what `notes.json` was last written
/// from, and the events read so far.
#[derive(Debug)]
pub struct Channel {
    dir: PathBuf,
    written: Option<Sig>,
    rev: u64,
    acks: VecDeque<Ack>,
    acks_changed: bool,
    tail: Tail,
    events: VecDeque<(u64, EditorEvent)>,
    last_seq: u64,
}

impl Channel {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            tail: Tail::new(dir.join(EVENTS)),
            dir,
            written: None,
            rev: 0,
            acks: VecDeque::new(),
            acks_changed: false,
            events: VecDeque::new(),
            last_seq: 0,
        }
    }

    /// Rewrite `notes.json` when the notes, the scope or the acks changed
    /// since the last write. `Ok(true)` when it wrote. A rename refused while
    /// the editor has the file open (Windows) is tried again next time.
    pub fn sync(&mut self, context: &CallContext, scope: Scope) -> Result<bool, String> {
        let sig = signature(context, scope);
        if self.written.as_ref() == Some(&sig) && !self.acks_changed {
            return Ok(false);
        }
        let notes = comments::list(context).map(|all| rows(&all, scope));
        let rev = self.rev + 1;
        let body = json!({
            "version": 1,
            "rev": rev,
            "notes": notes.as_ref().unwrap_or(&Vec::new()),
            "problem": notes.as_ref().err().map(|e| e.message.clone()),
            "acks": self.acks,
        });
        write_whole(&self.dir.join(NOTES), &body.to_string())
            .map_err(|e| format!("could not write {NOTES}: {e}"))?;
        self.rev = rev;
        self.written = Some(sig);
        self.acks_changed = false;
        Ok(true)
    }

    /// Record the answer to event `n`; its picture is no longer needed.
    pub fn ack(&mut self, ack: Ack) {
        if let Some((_, EditorEvent::Ask { png: Some(png), .. })) =
            self.events.iter().find(|(_, e)| e.n() == ack.n)
        {
            let _ = std::fs::remove_file(self.dir.join(png));
        }
        self.events.retain(|(_, e)| e.n() != ack.n);
        self.acks.retain(|a| a.n != ack.n);
        self.acks.push_back(ack);
        while self.acks.len() > ACKS_KEPT {
            self.acks.pop_front();
        }
        self.acks_changed = true;
    }

    /// Read the lines appended since the last call: each good one gets the
    /// next seq, each refused one a failed ack.
    pub fn poll(&mut self) {
        for line in self.tail.read_lines() {
            if line.trim().is_empty() {
                continue;
            }
            match parse_event(&line) {
                Ok(event) => {
                    self.last_seq += 1;
                    self.events.push_back((self.last_seq, event));
                    while self.events.len() > EVENTS_KEPT {
                        self.events.pop_front();
                    }
                }
                Err(Refused { n: Some(n), why }) => self.ack(Ack {
                    n,
                    ok: false,
                    message: why,
                }),
                Err(Refused { n: None, why }) => eprintln!("veistra: editor event refused: {why}"),
            }
        }
    }

    /// The events after `since` that have no answer yet, for the pane, each
    /// ask's picture inlined.
    pub fn since(&self, since: u64) -> Vec<Value> {
        self.events
            .iter()
            .filter(|(seq, _)| *seq > since)
            .map(|(seq, e)| event_json(&self.dir, *seq, e))
            .collect()
    }
}

/// An event as the pane reads it: `seq`, the line's fields, and for an ask
/// `pngBase64` (null, with `pngProblem`, when the picture is missing or larger
/// than a context item takes).
pub fn event_json(dir: &Path, seq: u64, event: &EditorEvent) -> Value {
    match event {
        EditorEvent::Ask {
            n,
            t,
            text,
            scene,
            nodes,
            camera,
            png,
        } => {
            let (b64, problem) = match png {
                None => (None, Some("the editor sent no picture".to_string())),
                Some(name) => match std::fs::read(dir.join(name)) {
                    Ok(bytes) if bytes.len() <= crate::context::MAX_IMAGE_BYTES => {
                        (Some(BASE64.encode(bytes)), None)
                    }
                    Ok(_) => (None, Some("the picture is too large to send".to_string())),
                    Err(e) => (None, Some(format!("the picture could not be read: {e}"))),
                },
            };
            json!({
                "seq": seq, "n": n, "t": t, "kind": "ask", "text": text, "scene": scene,
                "nodes": nodes, "camera": camera, "pngBase64": b64, "pngProblem": problem,
            })
        }
        EditorEvent::Verdict {
            n,
            t,
            id,
            good,
            reply,
        } => json!({
            "seq": seq, "n": n, "t": t, "kind": "verdict", "id": id,
            "verdict": if *good { "good" } else { "broken" }, "reply": reply,
        }),
        EditorEvent::Markup { n, t } => json!({ "seq": seq, "n": n, "t": t, "kind": "markup" }),
    }
}

#[cfg(test)]
#[path = "editor_notes_tests.rs"]
mod tests;
