//! Every agent tab's session, by the tab's instance id.
//!
//! The map's lock is held for lookups, inserts and removals only. Spawning a
//! process happens outside it, and so does every kill. Closing a tab retires
//! its process on another thread; switching harnesses waits for the outgoing
//! process to exit before a replacement can write to the same worktree.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::event::{Attachment, Envelope, Event, Hint, Item, QuestionOutcome, SessionStatus};
use crate::guard::{NotAWorktree, Worktree};
use crate::harness::{Harness, LaunchSpec, Protocol};
use crate::models::MODEL_CATEGORY;
use crate::session::{Level, Log, Session, Sink, Start};
use crate::transfer;

/// How long a retired session gets to exit before its thread gives up
/// waiting. It has already been killed; this only bounds the wait.
const RETIRE_WAIT: Duration = Duration::from_secs(3);

/// One harness's session, as the host drives it — the part of handoff §3.2's
/// adapter trait this slice uses. [`Session`] implements it over ACP, for
/// every harness whose descriptor says [`Protocol::Acp`]; a harness that
/// speaks something else gets a type of its own that translates.
/// `capabilities`, `resume`, `fork`, `steer`, `set_model` and `list_commands`
/// arrive with the features that need them.
pub trait Adapter: Send + Sync {
    /// Which harness it runs.
    fn harness(&self) -> Harness;
    /// Start a turn with `text`, then the content blocks `attached`, which
    /// the agent reads and the transcript does not show.
    fn prompt(&self, text: &str, attached: Vec<Value>) -> Result<(), HostError>;
    /// Start a turn with handoff context that is not another visible user message.
    fn prompt_with_context(
        &self,
        text: &str,
        context: Option<&str>,
        attached: Vec<Value>,
    ) -> Result<(), HostError> {
        let combined = context.map(|context| format!("{context}\n\n{text}"));
        self.prompt(combined.as_deref().unwrap_or(text), attached)
    }
    /// Stop the running turn.
    fn abort(&self);
    /// Answer an approval with one of the options it offered.
    fn answer_approval(&self, item_id: &str, option_id: &str) -> Result<(), HostError>;
    /// Answer a question card, skip it, or withdraw it.
    fn answer_question(&self, item_id: &str, outcome: QuestionOutcome) -> Result<(), HostError>;
    /// Switch to one of the modes the status offers. Returns the change's
    /// number, which the status's `answered` reaches once it is answered.
    fn set_mode(&self, mode_id: &str) -> Result<u64, HostError>;
    /// Set one of the status's other options to one of its choices. Returns
    /// the change's number, as `set_mode` does.
    fn set_config(&self, config_id: &str, value: &str) -> Result<u64, HostError>;
    /// Kill the process. Returns at once.
    fn shutdown(&self);
    /// Wait for the process to have exited, up to `deadline`.
    fn wait_closed(&self, deadline: Instant) -> bool;
    /// Everything drawn so far.
    fn attach(&self) -> Attachment;
    /// Where it is: `attach`'s status, without the items.
    fn status(&self) -> SessionStatus;
    /// The items, for a session that continues this one.
    fn items(&self) -> Vec<Item>;
    /// Whether the process is still running.
    fn is_alive(&self) -> bool;
    /// Where it runs.
    fn worktree(&self) -> &Worktree;
    /// Send no more events. For a session its tab no longer shows.
    fn silence(&self);
}

impl Adapter for Session {
    fn harness(&self) -> Harness {
        Session::harness(self)
    }
    fn prompt(&self, text: &str, attached: Vec<Value>) -> Result<(), HostError> {
        Session::prompt(self, text, attached)
    }
    fn prompt_with_context(
        &self,
        text: &str,
        context: Option<&str>,
        attached: Vec<Value>,
    ) -> Result<(), HostError> {
        Session::prompt_with_context(self, text, context, attached)
    }
    fn abort(&self) {
        self.cancel();
    }
    fn answer_approval(&self, item_id: &str, option_id: &str) -> Result<(), HostError> {
        self.answer(item_id, option_id)
    }
    fn answer_question(&self, item_id: &str, outcome: QuestionOutcome) -> Result<(), HostError> {
        self.reply(item_id, outcome)
    }
    fn set_mode(&self, mode_id: &str) -> Result<u64, HostError> {
        Session::set_mode(self, mode_id)
    }
    fn set_config(&self, config_id: &str, value: &str) -> Result<u64, HostError> {
        Session::set_config(self, config_id, value)
    }
    fn shutdown(&self) {
        self.kill();
    }
    fn wait_closed(&self, deadline: Instant) -> bool {
        Session::wait_closed(self, deadline)
    }
    fn attach(&self) -> Attachment {
        Session::attach(self)
    }
    fn status(&self) -> SessionStatus {
        Session::status(self)
    }
    fn items(&self) -> Vec<Item> {
        Session::items(self)
    }
    fn is_alive(&self) -> bool {
        Session::is_alive(self)
    }
    fn worktree(&self) -> &Worktree {
        Session::worktree(self)
    }
    fn silence(&self) {
        Session::silence(self);
    }
}

/// Why the host refused. [`HostError::code`] is what crosses to the tab, which
/// words it from `strings.ts`.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// A turn is running, or a prompt is waiting to start one.
    #[error("a turn is already running")]
    Busy,
    /// The process has exited.
    #[error("this session has ended")]
    Closed,
    /// No session in this tab.
    #[error("no agent is running in this tab")]
    NoSession,
    /// The tab's session runs in a different worktree from the one asked for.
    #[error("this session runs in another worktree")]
    WrongWorktree,
    /// No approval with that id is waiting.
    #[error("no such approval is waiting")]
    UnknownApproval,
    /// The option is not one the approval or the mode list offered.
    #[error("that is not one of the offered choices")]
    UnknownOption,
    /// The process could not be started.
    #[error("the agent could not be started: {message}")]
    Spawn {
        /// A known cause, if there is one.
        hint: Option<Hint>,
        /// What the OS said, masked.
        message: String,
    },
    /// The directory is not a linked worktree.
    #[error(transparent)]
    NotAWorktree(#[from] NotAWorktree),
}

impl HostError {
    /// A stable code for the error.
    pub fn code(&self) -> &'static str {
        match self {
            HostError::Busy => "busy",
            HostError::Closed => "closed",
            HostError::NoSession => "noSession",
            HostError::WrongWorktree => "wrongWorktree",
            HostError::UnknownApproval => "unknownApproval",
            HostError::UnknownOption => "unknownOption",
            HostError::Spawn { .. } => "spawn",
            HostError::NotAWorktree(_) => "notAWorktree",
        }
    }

    /// A cause the tab can explain, if there is one.
    pub fn hint(&self) -> Option<Hint> {
        match self {
            HostError::Spawn { hint, .. } => *hint,
            _ => None,
        }
    }
}

/// The host.
pub struct AgentHost {
    sessions: Mutex<HashMap<String, Arc<dyn Adapter>>>,
    /// A conversation between harness processes. No process starts just to switch.
    transfers: Mutex<HashMap<String, Transfer>>,
    /// Held across a whole send, so two sends to a tab with no session start
    /// one between them rather than one each.
    sending: Mutex<()>,
    seq: Arc<AtomicU64>,
    /// The last number given to a setting change, across every session.
    changes: Arc<AtomicU64>,
    generation: AtomicU64,
    events: Mutex<mpsc::Sender<Envelope>>,
    log: Log,
}

struct Transfer {
    items: Vec<Item>,
    worktree: Worktree,
    source: Harness,
    /// Keep the retired process until its exit has been confirmed.
    outgoing: Option<Arc<dyn Adapter>>,
}

impl AgentHost {
    /// A host sending every envelope to `sink`, from one thread of its own,
    /// in the order they were numbered.
    pub fn new(sink: Sink, log: Log) -> Self {
        let (events, envelopes) = mpsc::channel::<Envelope>();
        let _ = thread::Builder::new()
            .name("agent-emitter".to_string())
            .spawn(move || {
                for envelope in envelopes {
                    sink(envelope);
                }
            });
        Self {
            sessions: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            sending: Mutex::new(()),
            seq: Arc::new(AtomicU64::new(0)),
            changes: Arc::new(AtomicU64::new(0)),
            generation: AtomicU64::new(0),
            events: Mutex::new(events),
            log,
        }
    }

    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<dyn Adapter>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, instance_id: &str) -> Option<Arc<dyn Adapter>> {
        self.map().get(instance_id).cloned()
    }

    /// Send `text`, then the content blocks `attached`, to the tab's session,
    /// starting one in `worktree` first if it has none or its last one has
    /// exited. A session that exited hands its items to the next, so the
    /// tab's conversation carries on.
    pub fn send(
        &self,
        instance_id: &str,
        spec: LaunchSpec,
        worktree: Worktree,
        text: &str,
        attached: Vec<Value>,
    ) -> Result<(), HostError> {
        let _one_at_a_time = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        let mut existing = self.get(instance_id);
        if let Some(session) = &existing {
            if session.worktree() != &worktree {
                return Err(HostError::WrongWorktree);
            }
            if session.harness() != spec.harness {
                self.transfer_locked(instance_id, spec.harness)?;
                existing = None;
            }
        }
        if let Some(session) = &existing {
            if session.is_alive() {
                return session.prompt(text, attached);
            }
        }
        let (prior, context) =
            {
                let transfers = self.transfers.lock().unwrap_or_else(|e| e.into_inner());
                match transfers.get(instance_id) {
                    Some(transfer) => {
                        if transfer.worktree != worktree {
                            return Err(HostError::WrongWorktree);
                        }
                        if transfer.outgoing.as_ref().is_some_and(|outgoing| {
                            !outgoing.wait_closed(Instant::now() + RETIRE_WAIT)
                        }) {
                            return Err(HostError::Busy);
                        }
                        let prior = existing
                            .as_ref()
                            .map(|s| s.items())
                            .unwrap_or_else(|| transfer.items.clone());
                        let context = transfer::context(&prior, transfer.source);
                        (prior, context)
                    }
                    None => (existing.map(|s| s.items()).unwrap_or_default(), None),
                }
            };
        // A new process gets the spec's preamble (the built-in skill hint)
        // ahead of any handoff, both as context the transcript does not show.
        let context = join_context(spec.preamble.as_deref(), context.as_deref());
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let events = self
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let start = Start {
            instance_id: instance_id.to_string(),
            prefix: format!("s{generation}"),
            spec,
            worktree,
            prior,
            seq: Arc::clone(&self.seq),
            changes: Arc::clone(&self.changes),
            events,
            log: Arc::clone(&self.log),
        };
        let session: Arc<dyn Adapter> = match start.spec.harness.descriptor().protocol {
            Protocol::Acp => Arc::new(Session::start(start)?),
        };
        let replaced = self
            .map()
            .insert(instance_id.to_string(), Arc::clone(&session));
        if let Some(old) = replaced {
            retire(old);
        }
        session.prompt_with_context(text, context.as_deref(), attached)?;
        // Keep the handoff marker across a failed startup so Retry also receives
        // real context. Live turns use their process's existing conversation.
        Ok(())
    }

    /// Change harness without starting an inference. The old process is stopped first;
    /// the next prompt carries the conversation into the new harness's real context.
    pub fn transfer(&self, instance_id: &str, target: Harness) -> Result<Attachment, HostError> {
        let _one_at_a_time = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        self.transfer_locked(instance_id, target)?;
        Ok(self.attach(instance_id))
    }

    fn transfer_locked(&self, instance_id: &str, target: Harness) -> Result<(), HostError> {
        let Some(session) = self.get(instance_id) else {
            return Ok(());
        };
        if session.harness() == target {
            return Ok(());
        }
        // Silence before cancelling: no late answer can be drawn after the switch.
        session.silence();
        let pending = session.status().pending_prompt;
        session.abort();
        session.shutdown();
        let mut items = session.items();
        transfer::settle(&mut items);
        if let Some(text) = pending {
            let id = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            items.push(Item {
                id: format!("handoff{id}:pending"),
                turn_id: format!("handoff{id}"),
                kind: crate::event::ItemKind::UserMessage { text },
            });
        }
        let closed = session.wait_closed(Instant::now() + RETIRE_WAIT);
        self.map().remove(instance_id);
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                instance_id.to_string(),
                Transfer {
                    items,
                    worktree: session.worktree().clone(),
                    source: session.harness(),
                    outgoing: Some(session),
                },
            );
        if !closed {
            return Err(HostError::Busy);
        }
        Ok(())
    }

    /// Import a saved conversation into this project worktree without running a
    /// model. Its next prompt receives the same bounded context as a live handoff.
    pub fn restore(
        &self,
        instance_id: &str,
        items: Vec<Item>,
        harness: Harness,
        worktree: Worktree,
    ) -> Result<Attachment, HostError> {
        let _one_at_a_time = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        let outgoing = self
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(instance_id)
            .and_then(|transfer| transfer.outgoing.clone());
        if outgoing.is_some_and(|session| !session.wait_closed(Instant::now() + RETIRE_WAIT)) {
            return Err(HostError::Busy);
        }
        if let Some(session) = self.get(instance_id) {
            session.silence();
            session.abort();
            session.shutdown();
            if !session.wait_closed(Instant::now() + RETIRE_WAIT) {
                return Err(HostError::Busy);
            }
            self.map().remove(instance_id);
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut items = crate::transcript::Transcript::from_items(items).items();
        transfer::settle(&mut items);
        // Disk history may come from another host whose s1 IDs overlap ours.
        let ids: HashMap<String, String> = items
            .iter()
            .enumerate()
            .map(|(index, item)| (item.id.clone(), format!("history{generation}:i{index}")))
            .collect();
        let mut turns = HashMap::new();
        for (index, item) in items.iter_mut().enumerate() {
            item.id = format!("history{generation}:i{index}");
            let next_turn = turns.len();
            item.turn_id = turns
                .entry(item.turn_id.clone())
                .or_insert_with(|| format!("history{generation}:t{next_turn}"))
                .clone();
            if let crate::event::ItemKind::Approval {
                tool_call_id: Some(id),
                ..
            }
            | crate::event::ItemKind::Question {
                tool_call_id: Some(id),
                ..
            } = &mut item.kind
            {
                if let Some(replacement) = ids.get(id) {
                    *id = replacement.clone();
                }
            }
        }
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                instance_id.to_string(),
                Transfer {
                    items,
                    worktree,
                    source: harness,
                    outgoing: None,
                },
            );
        Ok(self.attach(instance_id))
    }

    /// Everything the tab should draw, and the `seq` live events pick up after.
    pub fn attach(&self, instance_id: &str) -> Attachment {
        match self.get(instance_id) {
            Some(session) => session.attach(),
            None => {
                let transfers = self.transfers.lock().unwrap_or_else(|e| e.into_inner());
                Attachment {
                    status: None,
                    items: transfers
                        .get(instance_id)
                        .map(|t| t.items.clone())
                        .unwrap_or_default(),
                    seq: self.seq.load(Ordering::SeqCst),
                }
            }
        }
    }

    /// Stop the tab's running turn.
    pub fn cancel(&self, instance_id: &str) -> Result<(), HostError> {
        self.get(instance_id).ok_or(HostError::NoSession)?.abort();
        Ok(())
    }

    /// Answer an approval in the tab's session.
    pub fn answer(
        &self,
        instance_id: &str,
        item_id: &str,
        option_id: &str,
    ) -> Result<(), HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .answer_approval(item_id, option_id)
    }

    /// Answer a question card in the tab's session.
    pub fn answer_question(
        &self,
        instance_id: &str,
        item_id: &str,
        outcome: QuestionOutcome,
    ) -> Result<(), HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .answer_question(item_id, outcome)
    }

    /// Switch the tab's session to another of its modes. Returns the
    /// change's number (see [`crate::SessionStatus::answered`]).
    pub fn set_mode(&self, instance_id: &str, mode_id: &str) -> Result<u64, HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .set_mode(mode_id)
    }

    /// Set one of the tab's session settings other than the mode, such as
    /// the model or effort: any option the status lists, to a value it
    /// offers. Returns the change's number, as [`AgentHost::set_mode`] does.
    pub fn set_config(
        &self,
        instance_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<u64, HostError> {
        self.get(instance_id)
            .ok_or(HostError::NoSession)?
            .set_config(config_id, value)
    }

    /// Kill the tab's agent, keeping its conversation: the next prompt starts
    /// a new process that carries on from it.
    pub fn stop(&self, instance_id: &str) {
        if let Some(session) = self.get(instance_id) {
            session.shutdown();
        }
    }

    /// Kill the tab's agent and forget its conversation.
    pub fn reset(&self, instance_id: &str) {
        let _one_at_a_time = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(instance_id);
        let removed = self.map().remove(instance_id);
        if let Some(session) = removed {
            retire(session);
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self
            .events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(Envelope {
                instance_id: instance_id.to_string(),
                seq,
                event: Event::Reset,
            });
    }

    /// The worktree the tab's session runs in, if it has one.
    pub fn worktree(&self, instance_id: &str) -> Option<Worktree> {
        self.get(instance_id)
            .map(|s| s.worktree().clone())
            .or_else(|| {
                self.transfers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(instance_id)
                    .map(|t| t.worktree.clone())
            })
    }

    /// Where the tab's session is, while its process lives. Cheaper than
    /// [`Self::attach`], which copies every item.
    pub fn state(&self, instance_id: &str) -> Option<crate::SessionState> {
        self.get(instance_id)
            .filter(|s| s.is_alive())
            .map(|s| s.status().state)
    }

    /// The harness the tab's agent runs, while its process lives.
    pub fn running(&self, instance_id: &str) -> Option<Harness> {
        self.get(instance_id)
            .filter(|s| s.is_alive())
            .map(|s| s.harness())
    }

    /// The name of the model the tab's agent runs, while its process lives.
    pub fn model(&self, instance_id: &str) -> Option<String> {
        model_name(self.get(instance_id).filter(|s| s.is_alive())?.status())
    }

    /// Kill every session whose tab `keep` does not name. Returns at once.
    pub fn retain(&self, keep: impl Fn(&str) -> bool) {
        let _one_at_a_time = self.sending.lock().unwrap_or_else(|e| e.into_inner());
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, _| keep(id));
        let gone: Vec<Arc<dyn Adapter>> = {
            let mut map = self.map();
            let ids: Vec<String> = map.keys().filter(|id| !keep(id)).cloned().collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for session in gone {
            (self.log)(Level::Info, "agent-host: a closed tab's agent was stopped");
            retire(session);
        }
    }

    /// Kill every session and wait for them, all against one deadline. For
    /// the app's exit.
    pub fn stop_all(&self, wait: Duration) {
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let all: Vec<Arc<dyn Adapter>> = self.map().drain().map(|(_, s)| s).collect();
        for session in &all {
            session.shutdown();
        }
        let deadline = Instant::now() + wait;
        for session in &all {
            session.wait_closed(deadline);
        }
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        self.stop_all(RETIRE_WAIT);
    }
}

/// Silence `session` now, then kill it and wait for it on a thread of its
/// own.
fn retire(session: Arc<dyn Adapter>) {
    session.silence();
    let _ = thread::Builder::new()
        .name("agent-retire".to_string())
        .spawn(move || {
            session.shutdown();
            session.wait_closed(Instant::now() + RETIRE_WAIT);
        });
}

/// The preamble and the handoff context as one block, preamble first, or
/// `None` when there is neither.
fn join_context(preamble: Option<&str>, handoff: Option<&str>) -> Option<String> {
    match (preamble, handoff) {
        (Some(p), Some(h)) => Some(format!("{p}\n\n{h}")),
        (Some(one), None) | (None, Some(one)) => Some(one.to_string()),
        (None, None) => None,
    }
}

/// The agent's label for the value of its option in ACP's `model` category,
/// or the bare value when it offers none. `None` before the agent reports one.
fn model_name(status: SessionStatus) -> Option<String> {
    let option = status
        .config
        .into_iter()
        .find(|o| o.category.as_deref() == Some(MODEL_CATEGORY))?;
    let label = option.choices.into_iter().find(|c| c.value == option.value);
    Some(label.map_or(option.value, |c| c.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{ConfigChoice, ConfigOption, SessionState};

    fn status(config: Vec<ConfigOption>) -> SessionStatus {
        SessionStatus {
            state: SessionState::Ready,
            harness: Harness::Claude,
            cwd: "C:/wt/x".into(),
            mode: None,
            modes: Vec::new(),
            config,
            commands: Vec::new(),
            answered: 0,
            setting_trouble: None,
            adapter_version: None,
            exit_code: None,
            hint: None,
            pending_prompt: None,
            session_title: None,
        }
    }

    fn option(category: &str, value: &str) -> ConfigOption {
        ConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some(category.into()),
            value: value.into(),
            choices: vec![ConfigChoice {
                value: "opus".into(),
                name: "Opus".into(),
                description: None,
            }],
        }
    }

    #[test]
    fn a_preamble_goes_ahead_of_a_handoff() {
        assert_eq!(join_context(None, None), None);
        assert_eq!(join_context(Some("p"), None).as_deref(), Some("p"));
        assert_eq!(join_context(None, Some("h")).as_deref(), Some("h"));
        assert_eq!(
            join_context(Some("p"), Some("h")).as_deref(),
            Some("p\n\nh")
        );
    }

    #[test]
    fn a_model_is_named_by_the_agents_label_else_its_value() {
        assert_eq!(
            model_name(status(vec![option("model", "opus")])).as_deref(),
            Some("Opus")
        );
        assert_eq!(
            model_name(status(vec![option("model", "haiku")])).as_deref(),
            Some("haiku")
        );
        assert_eq!(
            model_name(status(vec![option("thought_level", "opus")])),
            None
        );
        assert_eq!(model_name(status(Vec::new())), None);
    }
}
