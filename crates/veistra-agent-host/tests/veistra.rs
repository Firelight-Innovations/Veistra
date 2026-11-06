//! The host against Veistra's own agent: the real `packages/veistra-agent`,
//! Pi included, with only its model scripted (`scripts/scripted-agent.mjs`).
//! What `session.rs` proves with `mock-agent`, this proves with what the
//! agent actually sends: the transcript, the approval card and its diff, the
//! guard, and the model the tab chose.
//!
//! It needs the agent built and Node 22.19 or newer, as `pnpm verify` has:
//! `pnpm build` (or `pnpm build:agent`) before a bare `cargo test`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use veistra_agent_host::event::ToolStatus;
use veistra_agent_host::harness::{which, VEISTRA};
use veistra_agent_host::{
    AgentHost, Envelope, Event, Harness, Item, ItemKind, LaunchSpec, SessionState, Worktree,
};

/// Pi takes a moment to start; a turn is a few model requests to a script.
const PATIENCE: Duration = Duration::from_secs(60);
const TAB: &str = "agent-tab-veistra";

fn package() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/veistra-agent")
}

struct Rig {
    host: AgentHost,
    got: Arc<Mutex<Vec<Envelope>>>,
    dir: tempfile::TempDir,
    tree: Worktree,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("tree");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".git"), "gitdir: elsewhere\n").unwrap();
    std::fs::write(root.join("README.md"), "# Game\n").unwrap();
    let tree = Worktree::new(&root).unwrap();
    let got = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&got);
    let host = AgentHost::new(
        Arc::new(move |e| sink.lock().unwrap().push(e)),
        Arc::new(|_, _: &str| {}),
    );
    Rig {
        host,
        got,
        dir,
        tree,
    }
}

impl Rig {
    /// The agent with `script` as its model, on the model a tab would choose.
    fn spec(&self, script: Value) -> LaunchSpec {
        let entry = package().join("scripts/scripted-agent.mjs");
        assert!(
            package().join("dist/stdio.js").is_file(),
            "the agent is not built: run `pnpm build:agent` first"
        );
        let node = which(
            "node",
            std::env::var_os("PATH").as_deref(),
            std::env::var_os("PATHEXT").as_deref(),
        )
        .expect("Node.js 22.19 or newer on PATH");
        let file = self.dir.path().join("script.json");
        std::fs::write(&file, script.to_string()).unwrap();
        let home = self.dir.path().join("agent");
        LaunchSpec {
            harness: Harness::Veistra,
            program: node,
            args: vec![entry.to_string_lossy().into_owned()],
            env: vec![
                ("VEISTRA_AGENT_SCRIPT".into(), file.to_string_lossy().into()),
                ("VEISTRA_AGENT_DIR".into(), home.to_string_lossy().into()),
            ],
            env_remove: Vec::new(),
            expected_version: Some(VEISTRA.adapter.version),
            policy: VEISTRA.policy,
            setting_timeout: PATIENCE,
            mcp_servers: Vec::new(),
            model: Some("scripted/scripted-1".into()),
            effort: None,
            ultracode: false,
            mode: None,
            plugins: Vec::new(),
            preamble: None,
        }
    }

    fn send(&self, script: Value, text: &str) {
        self.host
            .send(TAB, self.spec(script), self.tree.clone(), text, Vec::new())
            .unwrap();
    }

    fn until(&self, what: &str, test: impl Fn(&[Envelope]) -> bool) {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if test(&self.got.lock().unwrap()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "timed out waiting for {what}; got {:#?}",
            self.got.lock().unwrap()
        );
    }

    fn state(&self, state: SessionState) {
        self.until(&format!("{state:?}"), |events| {
            events.iter().rev().find_map(|e| match &e.event {
                Event::Status { status } => Some(status.state),
                _ => None,
            }) == Some(state)
        });
    }

    fn turn_done(&self) {
        self.until("a finished turn", |events| {
            events
                .iter()
                .any(|e| matches!(e.event, Event::TurnCompleted { .. }))
        });
    }

    fn items(&self) -> Vec<Item> {
        self.host.attach(TAB).items
    }

    fn file(&self, name: &str) -> PathBuf {
        self.tree.path().join(name)
    }
}

fn texts(items: &[Item]) -> String {
    items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::AssistantText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn tools(items: &[Item]) -> Vec<(String, ToolStatus, String)> {
    items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::ToolCall {
                tool_kind,
                status,
                output,
                ..
            } => Some((tool_kind.clone(), *status, output.clone())),
            _ => None,
        })
        .collect()
}

fn approvals(items: &[Item]) -> Vec<Item> {
    items
        .iter()
        .filter(|i| matches!(i.kind, ItemKind::Approval { .. }))
        .cloned()
        .collect()
}

#[test]
fn an_edit_waits_on_the_card_with_its_diff_and_runs_once_allowed() {
    let rig = rig();
    rig.send(
        json!([
            [{"text": "Writing it."}, {"tool": "write", "args": {"path": "hello.txt", "content": "hi\n"}}],
            [{"text": " Done."}]
        ]),
        "write hello.txt",
    );
    rig.state(SessionState::NeedsInput);
    let status = rig.host.attach(TAB).status.unwrap();
    assert_eq!(status.harness, Harness::Veistra);
    assert_eq!(status.mode.as_deref(), Some("default"), "ask-first");
    let model = status.config.iter().find(|o| o.id == "model").unwrap();
    assert_eq!(model.value, "scripted/scripted-1", "the tab's model");

    let card = approvals(&rig.items()).pop().unwrap();
    let ItemKind::Approval {
        options,
        diffs,
        paths,
        ..
    } = &card.kind
    else {
        unreachable!()
    };
    let ids: Vec<&str> = options.iter().map(|o| o.option_id.as_str()).collect();
    assert_eq!(ids, ["allow", "reject"]);
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].old_text, None, "a new file");
    assert_eq!(diffs[0].new_text, "hi\n");
    assert_eq!(paths.len(), 1);
    assert!(
        !rig.file("hello.txt").exists(),
        "nothing runs before the answer"
    );

    rig.host.answer(TAB, &card.id, "allow").unwrap();
    rig.turn_done();
    assert_eq!(
        std::fs::read_to_string(rig.file("hello.txt")).unwrap(),
        "hi\n"
    );
    let items = rig.items();
    assert_eq!(texts(&items), "Writing it. Done.");
    let (kind, status, _) = tools(&items).pop().unwrap();
    assert_eq!((kind.as_str(), status), ("edit", ToolStatus::Completed));
}

#[test]
fn a_rejected_edit_fails_its_tool_and_writes_nothing() {
    let rig = rig();
    rig.send(
        json!([
            [{"tool": "write", "args": {"path": "hello.txt", "content": "hi\n"}}],
            [{"text": "never"}]
        ]),
        "write hello.txt",
    );
    rig.state(SessionState::NeedsInput);
    let card = approvals(&rig.items()).pop().unwrap();
    rig.host.answer(TAB, &card.id, "reject").unwrap();
    rig.turn_done();
    assert!(!rig.file("hello.txt").exists());
    let (_, status, _) = tools(&rig.items()).pop().unwrap();
    assert_eq!(status, ToolStatus::Failed);
}

#[test]
fn a_read_inside_runs_unasked_and_one_outside_is_refused_unasked() {
    let rig = rig();
    std::fs::write(rig.dir.path().join("secret.txt"), "TOP-SECRET-42").unwrap();
    rig.send(
        json!([
            [{"tool": "read", "args": {"path": "README.md"}}],
            [{"tool": "read", "args": {"path": "../secret.txt"}}],
            [{"text": "ok"}]
        ]),
        "read",
    );
    rig.turn_done();
    let items = rig.items();
    assert!(approvals(&items).is_empty());
    let calls = tools(&items);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].1, ToolStatus::Completed);
    assert!(calls[0].2.contains("# Game"), "{:?}", calls[0]);
    assert_eq!(calls[1].1, ToolStatus::Failed);
    assert!(
        calls[1].2.contains("outside the worktree"),
        "{:?}",
        calls[1]
    );
    assert!(
        !calls[1].2.contains("TOP-SECRET-42"),
        "the secret was never read"
    );
}
