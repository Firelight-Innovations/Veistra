//! A Claude Code workflow's run, read from the folder Claude keeps it in, so
//! the tab can show its phases and agents while it runs.
//!
//! The adapter reports a background workflow as one task: started, some
//! progress, finished. What it does not forward is which agents the workflow
//! has started and where each one is. Claude writes that down as it goes:
//!
//! - `<session>/subagents/workflows/<runId>/journal.jsonl`, one line per agent
//!   `started` (with its label and phase), `result` or `failed`;
//! - `agent-<id>.meta.json` beside it, which names the agent's model;
//! - the script, whose `meta.phases` lists the phases in order;
//! - once the run ends, `<session>/workflows/<runId>.json`, the run record,
//!   whose `workflowProgress` has every agent's timing and outcome.
//!
//! None of these formats is documented, so each is read for the few fields
//! used here and anything else is ignored; a file that does not parse adds
//! nothing rather than failing the read. Only those files are opened: never an
//! agent's own transcript, which holds what it sent the model. Every read is
//! capped, and the folder must look like a workflow run folder, since its path
//! comes from the agent's tool output.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::event::{AgentState, WorkflowAgent, WorkflowPhase, WorkflowRun};

/// The most bytes read of the journal, the script or the run record.
const FILE_LIMIT: u64 = 4 * 1024 * 1024;

/// The most bytes read of one agent's meta file.
const META_LIMIT: u64 = 64 * 1024;

/// The most agents kept for one run.
pub const MAX_AGENTS: usize = 500;

/// The most phases kept for one run.
const MAX_PHASES: usize = 64;

/// The most characters kept of an agent's answer.
const RESULT_LIMIT: usize = 400;

/// The most characters kept of a label, a title or a phase's detail.
const TEXT_LIMIT: usize = 300;

/// Where a launched workflow keeps its run, as the Workflow tool's result
/// text names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// The task id the adapter reports the workflow under.
    pub task_id: String,
    /// The run folder.
    pub dir: PathBuf,
    /// The script, when the result names it.
    pub script: Option<PathBuf>,
}

/// The run a Workflow tool's result announces, if it is one:
///
/// ```text
/// Workflow launched in background. Task ID: wxxvycvvd
/// Transcript dir: C:\…\subagents\workflows\wf_7c7c9847-fad
/// Script file: C:\…\workflows\scripts\name-wf_7c7c9847-fad.js
/// ```
pub fn launch(output: &str) -> Option<Launch> {
    let field = |name: &str| {
        output.lines().find_map(|line| {
            let at = line.find(name)?;
            let value = line[at + name.len()..].trim();
            (!value.is_empty()).then(|| value.to_string())
        })
    };
    let task_id = field("Task ID:")?;
    let dir = PathBuf::from(field("Transcript dir:")?);
    if !is_run_dir(&dir) {
        return None;
    }
    let script = field("Script file:")
        .map(PathBuf::from)
        .filter(|p| p.extension().is_some_and(|e| e == "js"));
    Some(Launch {
        task_id: task_id.split_whitespace().next()?.to_string(),
        dir,
        script,
    })
}

/// `…/subagents/workflows/wf_…`, and nothing else.
fn is_run_dir(dir: &Path) -> bool {
    let names: Vec<_> = dir
        .components()
        .rev()
        .take(3)
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    dir.is_absolute()
        && names.len() == 3
        && names[0].starts_with("wf_")
        && names[1] == "workflows"
        && names[2] == "subagents"
}

/// The run as its folder records it now. `None` when there is nothing to read
/// yet, or the folder is not a run folder.
pub fn read(launch: &Launch) -> Option<WorkflowRun> {
    let dir = &launch.dir;
    if !is_run_dir(dir) {
        return None;
    }
    let run_id = dir.file_name()?.to_string_lossy().into_owned();
    let session = dir.parent()?.parent()?.parent()?;
    // Once the run ends, its record is the whole account.
    let record = session.join("workflows").join(format!("{run_id}.json"));
    if let Some(run) = read_capped(&record, FILE_LIMIT)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|json| from_record(&run_id, &json))
    {
        return Some(run);
    }
    let script = launch.script.clone().or_else(|| {
        let scripts = session.join("workflows").join("scripts");
        let suffix = format!("-{run_id}.js");
        fs::read_dir(scripts).ok()?.flatten().find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.ends_with(&suffix).then(|| entry.path())
        })
    });
    let phases = script
        .and_then(|path| read_capped(&path, FILE_LIMIT))
        .map(|text| phases(&text))
        .unwrap_or_default();
    let journal = read_capped(&dir.join("journal.jsonl"), FILE_LIMIT).unwrap_or_default();
    let mut agents = agents(&journal);
    for agent in &mut agents {
        let meta = dir.join(format!("agent-{}.meta.json", agent.id));
        if agent.model.is_none() {
            agent.model = read_capped(&meta, META_LIMIT)
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|json| short(&json, "model"));
        }
        agent.started_at = modified_ms(&meta);
    }
    Some(WorkflowRun {
        run_id,
        phases,
        agents,
    })
}

/// The agents a journal records, in the order they started.
pub fn agents(journal: &str) -> Vec<WorkflowAgent> {
    let mut agents: Vec<WorkflowAgent> = Vec::new();
    for line in journal.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(id) = short(&entry, "agentId") else {
            continue;
        };
        let known = agents.iter().position(|a| a.id == id);
        match entry.get("type").and_then(Value::as_str) {
            Some("started") if known.is_none() && agents.len() < MAX_AGENTS => {
                agents.push(WorkflowAgent {
                    label: short(&entry, "label").unwrap_or_else(|| id.clone()),
                    id,
                    phase: short(&entry, "phase"),
                    state: AgentState::Running,
                    model: None,
                    started_at: None,
                    duration_ms: None,
                    result: None,
                });
            }
            Some("result") => {
                if let Some(agent) = known.map(|i| &mut agents[i]) {
                    agent.state = AgentState::Done;
                    agent.result = entry.get("result").map(preview);
                }
            }
            Some("failed") => {
                if let Some(agent) = known.map(|i| &mut agents[i]) {
                    agent.state = AgentState::Failed;
                }
            }
            _ => {}
        }
    }
    agents
}

/// A finished run's record: its phases and `workflowProgress`.
pub fn from_record(run_id: &str, record: &Value) -> Option<WorkflowRun> {
    let progress = record.get("workflowProgress")?.as_array()?;
    let phases = record
        .get("phases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(WorkflowPhase {
                title: short(p, "title")?,
                detail: short(p, "detail"),
            })
        })
        .take(MAX_PHASES)
        .collect();
    let agents = progress
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("workflow_agent"))
        .filter_map(|p| {
            let id = short(p, "agentId")?;
            Some(WorkflowAgent {
                label: short(p, "label").unwrap_or_else(|| id.clone()),
                id,
                phase: short(p, "phaseTitle"),
                state: match p.get("state").and_then(Value::as_str) {
                    Some("done") => AgentState::Done,
                    Some("failed" | "error" | "cancelled" | "killed") => AgentState::Failed,
                    _ => AgentState::Running,
                },
                model: short(p, "model"),
                started_at: p.get("startedAt").and_then(Value::as_u64),
                duration_ms: p.get("durationMs").and_then(Value::as_u64),
                result: p.get("resultPreview").map(preview),
            })
        })
        .take(MAX_AGENTS)
        .collect();
    Some(WorkflowRun {
        run_id: run_id.to_string(),
        phases,
        agents,
    })
}

/// The phases a script's `meta` declares: each `{ title, detail }` in the
/// `phases` array, read as far as their string literals. The script is
/// JavaScript, not JSON, so this scans rather than parses.
pub fn phases(script: &str) -> Vec<WorkflowPhase> {
    let Some(meta) = script.find("meta") else {
        return Vec::new();
    };
    let rest = &script[meta..];
    let Some(at) = find_key(rest, "phases") else {
        return Vec::new();
    };
    let rest = &rest[at..];
    let Some(open) = rest.find('[') else {
        return Vec::new();
    };
    objects(&rest[open..])
        .into_iter()
        .filter_map(|object| {
            Some(WorkflowPhase {
                title: cut(&string_after(object, "title")?),
                detail: string_after(object, "detail").map(|d| cut(&d)),
            })
        })
        .take(MAX_PHASES)
        .collect()
}

/// The top-level `{ … }` objects of the array `text` starts with, skipping
/// over string literals so a brace inside one does not count.
fn objects(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut start = None;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in text.char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '[' | '{' => {
                depth += 1;
                if c == '{' && depth == 2 {
                    start = Some(i);
                }
            }
            ']' | '}' => {
                if c == '}' && depth == 2 {
                    if let Some(s) = start.take() {
                        found.push(&text[s..=i]);
                    }
                }
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
    }
    found
}

/// Where `key` stands as an object key: followed, maybe after a closing
/// quote, by a colon.
fn find_key(text: &str, key: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = text[from..].find(key) {
        let end = from + at + key.len();
        let after = text[end..].trim_start_matches(['\'', '"']).trim_start();
        if after.starts_with(':') {
            return Some(end);
        }
        from = end;
    }
    None
}

/// The string literal `key:` is set to in `object`, if it is one.
fn string_after(object: &str, key: &str) -> Option<String> {
    let at = find_key(object, key)?;
    let rest = object[at..].trim_start_matches(['\'', '"']).trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let quote = rest
        .chars()
        .next()
        .filter(|c| matches!(c, '\'' | '"' | '`'))?;
    let mut out = String::new();
    let mut escaped = false;
    for c in rest[1..].chars() {
        if escaped {
            out.push(match c {
                'n' => '\n',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            return Some(out);
        } else {
            out.push(c);
        }
    }
    None
}

fn short(value: &Value, key: &str) -> Option<String> {
    let s = value.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| cut(s))
}

/// An agent's answer, as the start of its text: a string as it is, anything
/// else as JSON.
fn preview(value: &Value) -> String {
    let text = match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    text.chars().take(RESULT_LIMIT).collect()
}

fn cut(s: &str) -> String {
    s.chars().take(TEXT_LIMIT).collect()
}

fn read_capped(path: &Path, limit: u64) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    u64::try_from(ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_workflow_result_names_its_task_and_folder() {
        let dir = if cfg!(windows) {
            r"C:\u\.claude\projects\p\s1\subagents\workflows\wf_7c7c9847-fad"
        } else {
            "/u/.claude/projects/p/s1/subagents/workflows/wf_7c7c9847-fad"
        };
        let text = format!(
            "Workflow launched in background. Task ID: wxxvycvvd\n\
             Summary: research\nTranscript dir: {dir}\nScript file: {dir}.js\n"
        );
        let found = launch(&text).expect("a launch");
        assert_eq!(found.task_id, "wxxvycvvd");
        assert_eq!(found.dir, PathBuf::from(dir));
        assert!(found.script.is_some());
    }

    #[test]
    fn a_folder_that_is_not_a_run_folder_is_refused() {
        let text = "Task ID: x\nTranscript dir: /etc\n";
        assert_eq!(launch(text), None);
        assert_eq!(launch("Workflow failed to start"), None);
    }

    #[test]
    fn the_journal_lists_agents_in_the_order_they_started() {
        let journal = [
            json!({"type": "launched"}),
            json!({"type": "started", "agentId": "a1", "label": "research:a", "phase": "Research"}),
            json!({"type": "started", "agentId": "a2", "label": "research:b", "phase": "Research"}),
            json!({"type": "result", "agentId": "a1", "result": {"path": "a.md"}}),
            json!({"type": "failed", "agentId": "a2"}),
            json!({"type": "started", "agentId": "a3", "label": "verify", "phase": "Verify"}),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        let agents = agents(&format!("{journal}\nnot json\n"));
        let states: Vec<_> = agents.iter().map(|a| (a.label.as_str(), a.state)).collect();
        assert_eq!(
            states,
            [
                ("research:a", AgentState::Done),
                ("research:b", AgentState::Failed),
                ("verify", AgentState::Running)
            ]
        );
        assert_eq!(agents[0].result.as_deref(), Some(r#"{"path":"a.md"}"#));
        assert_eq!(agents[2].phase.as_deref(), Some("Verify"));
    }

    #[test]
    fn the_scripts_meta_names_the_phases() {
        let script = r#"
export const meta = {
  name: 'review',
  description: 'Review it, {carefully}',
  phases: [
    { title: 'Review', detail: "one agent per file, it's quick" },
    { title: `Verify` },
  ],
}
const phases = ['not', 'these']
"#;
        let found = phases(script);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].title, "Review");
        assert_eq!(
            found[0].detail.as_deref(),
            Some("one agent per file, it's quick")
        );
        assert_eq!(found[1].title, "Verify");
        assert_eq!(found[1].detail, None);
        assert!(phases("export const meta = { name: 'x' }").is_empty());
    }

    #[test]
    fn a_finished_runs_record_has_every_agents_timing() {
        let record = json!({
            "phases": [{"title": "Research", "detail": "eight briefs"}],
            "workflowProgress": [
                {"type": "workflow_phase", "index": 1, "title": "Research"},
                {"type": "workflow_agent", "label": "research:a", "phaseTitle": "Research",
                 "agentId": "a1", "model": "claude-haiku-5-5", "state": "done",
                 "startedAt": 1_000, "durationMs": 5_000, "resultPreview": "done"}
            ]
        });
        let run = from_record("wf_1", &record).expect("a run");
        assert_eq!(run.phases[0].detail.as_deref(), Some("eight briefs"));
        let agent = &run.agents[0];
        assert_eq!(agent.state, AgentState::Done);
        assert_eq!(agent.started_at, Some(1_000));
        assert_eq!(agent.duration_ms, Some(5_000));
        assert_eq!(agent.model.as_deref(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn a_live_run_is_read_from_its_folder() {
        let root = tempfile::tempdir().expect("tempdir");
        let session = root.path().join("s1");
        let dir = session.join("subagents").join("workflows").join("wf_1");
        fs::create_dir_all(&dir).expect("dir");
        fs::create_dir_all(session.join("workflows").join("scripts")).expect("scripts");
        fs::write(
            session
                .join("workflows")
                .join("scripts")
                .join("review-wf_1.js"),
            "export const meta = { phases: [{ title: 'Review' }] }",
        )
        .expect("script");
        fs::write(
            dir.join("journal.jsonl"),
            r#"{"type":"started","agentId":"a1","label":"r","phase":"Review"}"#,
        )
        .expect("journal");
        fs::write(dir.join("agent-a1.meta.json"), r#"{"model":"haiku"}"#).expect("meta");
        let run = read(&Launch {
            task_id: "t".into(),
            dir,
            script: None,
        })
        .expect("a run");
        assert_eq!(run.run_id, "wf_1");
        assert_eq!(run.phases[0].title, "Review");
        assert_eq!(run.agents[0].model.as_deref(), Some("haiku"));
        assert!(run.agents[0].started_at.is_some());
    }
}
