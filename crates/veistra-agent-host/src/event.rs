//! The normalized event model every harness is translated into (handoff §3.1).
//!
//! Codex's shape: a **thread** is a session, a **turn** is one prompt's worth of
//! work, and an **item** is one thing said or done inside a turn. An item
//! arrives as `itemStarted`, then any number of `itemDelta` (text appended) or
//! `itemUpdated` (the whole item again), then `itemCompleted` — and the
//! completed item always carries its whole final state, so the host keeps
//! items rather than events (see `transcript.rs`).
//!
//! These types are the only definition. The agent tab's TypeScript is generated
//! from them into `apps/agent-tab/ui/src/protocol.generated.ts`, and the test at
//! the bottom of this file fails when the two disagree.

use serde::{Deserialize, Serialize};

use crate::harness::{Capabilities, Harness, Setup};

/// One event, addressed to one agent tab and numbered within it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// The agent tab's instance id: which tab this belongs to.
    pub instance_id: String,
    /// Strictly increasing within a tab, across its sessions. A tab that
    /// attached at `seq = n` drops every live event at or below `n`.
    pub seq: u64,
    /// What happened.
    pub event: Event,
}

/// Something the agent tab draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The session's state changed; the whole status, not a diff.
    Status {
        /// The new status.
        status: SessionStatus,
    },
    /// A prompt started a turn.
    TurnStarted {
        /// Unique within the session.
        turn_id: String,
    },
    /// A turn ended. `stop_reason` is ACP's (`end_turn`, `cancelled`,
    /// `max_tokens`, `refusal`, ...) or `error` when the prompt failed.
    TurnCompleted {
        /// The turn that ended.
        turn_id: String,
        /// Why it ended.
        stop_reason: String,
    },
    /// An item appeared.
    ItemStarted {
        /// Its state so far.
        item: Item,
    },
    /// Text was appended to an open text or reasoning item.
    ItemDelta {
        /// The item that grew.
        item_id: String,
        /// The text to append.
        text: String,
    },
    /// An open item changed; this is its whole new state.
    ItemUpdated {
        /// The item, replaced.
        item: Item,
    },
    /// An item is finished; this is its whole final state.
    ItemCompleted {
        /// The item, replaced and closed.
        item: Item,
    },
    /// The user started a new session: drop every item drawn so far.
    Reset,
}

/// One entry in the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Unique within the session. Minted by the host, never by the agent.
    pub id: String,
    /// The turn this item belongs to.
    pub turn_id: String,
    /// What kind of item, and its content.
    pub kind: ItemKind,
    /// The item it is nested under: the subagent call whose work this is.
    /// Absent for the main agent's own items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub parent: Option<String>,
}

/// The kinds of item in handoff §2.2 this slice draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ItemKind {
    /// What the user sent.
    UserMessage {
        /// The prompt text.
        text: String,
    },
    /// The agent's answer, as Markdown.
    AssistantText {
        /// Markdown.
        text: String,
    },
    /// The agent's visible thinking.
    Reasoning {
        /// Plain text.
        text: String,
    },
    /// A tool the agent ran or wants to run.
    ToolCall {
        /// The agent's one-line summary of the call.
        title: String,
        /// ACP's tool kind: `read`, `edit`, `execute`, `search`, ...
        tool_kind: String,
        /// Where the call is.
        status: ToolStatus,
        /// Text output, cut at [`crate::normalize::OUTPUT_LIMIT`] bytes.
        output: String,
        /// Whether `output` was cut.
        truncated: bool,
        /// Files the call reads or changes.
        paths: Vec<String>,
        /// The changes it makes, when it edits files.
        diffs: Vec<FileDiff>,
        /// What the `veistra-context` server asked the tab to draw, when this is
        /// one of its show tools and it completed (see `veistra_call.rs`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        veistra: Option<ShowMarker>,
    },
    /// The agent is waiting for the user to allow or deny something. The turn
    /// is paused until this completes.
    Approval {
        /// What the agent wants to do.
        title: String,
        /// The tool call this is about, when the agent named one.
        tool_call_id: Option<String>,
        /// The exact command, or what the agent says the call is for. Cut at
        /// 64 KiB, and `detail_truncated` says so.
        detail: Option<String>,
        /// `detail` is not all of it. The card must say so, since the user
        /// decides on what they can read.
        detail_truncated: bool,
        /// Every file the request names, resolved against the worktree.
        paths: Vec<String>,
        /// The changes it would make, when it edits files.
        diffs: Vec<FileDiff>,
        /// The choices the agent offered, in its order, without `allow_always`:
        /// a standing allow would make the agent stop asking, and the path guard
        /// only sees what it asks about.
        options: Vec<ApprovalOption>,
        /// The chosen option's id, `cancelled`, `outside` (refused by the host
        /// because a path left the worktree), or `None` while waiting.
        answer: Option<String>,
    },
    /// The agent asked the user one or more questions, each with choices or
    /// free text: ACP's form `elicitation/create`, which Claude's
    /// AskUserQuestion, Codex's `request_user_input` and any MCP server's form
    /// elicitation all arrive as. The turn is paused until this completes.
    Question {
        /// The agent's own line: for one question, the question itself.
        message: String,
        /// The tool call this is about, when the agent named one.
        tool_call_id: Option<String>,
        /// What it asks, in the agent's order.
        questions: Vec<Question>,
        /// How it was answered, or `None` while waiting.
        outcome: Option<QuestionOutcome>,
    },
    /// The agent's plan, replaced in place as it changes.
    Plan {
        /// The steps.
        entries: Vec<PlanEntry>,
    },
    /// Context use at the end of a turn.
    Usage {
        /// Tokens in the context window now.
        used: u64,
        /// The window's size.
        size: u64,
    },
    /// Something failed.
    Error {
        /// What failed, with token- and email-shaped strings masked.
        message: String,
        /// A known cause the agent tab can explain, if there is one.
        hint: Option<Hint>,
        /// The harness that failed. The hint is worded for it, even after the
        /// tab's next session runs another.
        harness: Harness,
    },
    /// Work the agent left running in the background: a workflow, a shell
    /// command, a monitor. Updated in place for as long as it runs, across
    /// turns; drawn where it started and listed under Background tasks.
    Task {
        /// The agent's id for it, which stopping it names.
        task_id: String,
        /// What it is called: a workflow's name, or the command.
        name: String,
        /// `workflow`, `shell`, `monitor`, or what else the agent says.
        task_type: String,
        /// The agent's one-line account of it.
        description: String,
        /// Where it is.
        state: TaskState,
        /// What it reported last, or how it ended.
        summary: Option<String>,
        /// The tool it ran last.
        last_tool: Option<String>,
        /// What it has used so far, once the agent says.
        usage: Option<TaskUsage>,
        /// Whether the agent will stop it on request.
        can_stop: bool,
        /// The tool call that started it, by item id, when the agent named one.
        call_item: Option<String>,
        /// A workflow's phases and agents, read from its run folder.
        run: Option<WorkflowRun>,
    },
    /// Something the agent wants the user to know that is not part of its
    /// answer: a model fallback, a mode it had to leave, a task stopped.
    Notice {
        /// `info` or `warning`.
        severity: String,
        /// The headline.
        title: String,
        /// More, when there is more.
        description: Option<String>,
    },
    /// The agent compacted the conversation to free context.
    Compaction {
        /// `inProgress`, `completed`, `failed` or `cancelled`.
        status: String,
        /// What the agent kept, as it wrote it. Cut at
        /// [`crate::normalize::TEXT_LIMIT`].
        summary: String,
        /// Why it failed, when it did.
        error: Option<String>,
    },
}

/// A background task's progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    /// Running.
    Running,
    /// Paused, and may resume.
    Paused,
    /// Finished.
    Completed,
    /// Finished with an error.
    Failed,
    /// Stopped by the user or the agent.
    Stopped,
}

/// What a background task has used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    /// Tokens, all agents together.
    pub total_tokens: u64,
    /// Tool calls, all agents together.
    pub tool_uses: u64,
    /// How long it has run.
    pub duration_ms: u64,
}

/// A workflow's run, as its folder records it: the phases its script
/// declares, and every agent it has started so far.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    /// `wf_…`.
    pub run_id: String,
    /// In the script's order. Empty when the script declares none.
    pub phases: Vec<WorkflowPhase>,
    /// In the order they started.
    pub agents: Vec<WorkflowAgent>,
}

/// One phase a workflow script declares.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase {
    /// Its title, which agents name to place themselves in it.
    pub title: String,
    /// The script's line about it.
    pub detail: Option<String>,
}

/// One agent a workflow started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgent {
    /// Claude's id for it.
    pub id: String,
    /// The label the script gave it.
    pub label: String,
    /// The phase it runs in.
    pub phase: Option<String>,
    /// Where it is.
    pub state: AgentState,
    /// The model it runs on, once known.
    pub model: Option<String>,
    /// When it started, in ms since the epoch, once known.
    pub started_at: Option<u64>,
    /// How long it ran, once finished and recorded.
    pub duration_ms: Option<u64>,
    /// The start of what it answered.
    pub result: Option<String>,
}

/// A workflow agent's progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Running.
    Running,
    /// Answered.
    Done,
    /// Failed.
    Failed,
}

/// A tool call's progress, as ACP reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    /// Not started; may be waiting for approval.
    Pending,
    /// Running.
    InProgress,
    /// Finished.
    Completed,
    /// Finished with an error, or denied.
    Failed,
}

/// One file's change, as the agent describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// The file, as the agent named it.
    pub path: String,
    /// Its text before, or `None` for a new file.
    pub old_text: Option<String>,
    /// Its text after.
    pub new_text: String,
    /// One side was over [`crate::normalize::DIFF_LIMIT`] bytes, so both
    /// texts were dropped and only the path is kept.
    pub too_large: bool,
}

/// A component the `veistra-context` server asked the tab to draw: its show
/// answer, lifted off the tool result. Checked here for shape only; the tab
/// checks `props` against the catalogue `version` it draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ShowMarker {
    /// The catalogue version the props follow.
    pub version: u32,
    /// Which component: `refs`, `callout`, `table`, ...
    pub component: String,
    /// The component's props, as the server answered them: an object.
    #[cfg_attr(test, ts(type = "unknown"))]
    pub props: serde_json::Value,
    /// The references the server dropped from `props`, and why.
    pub failed: Vec<ShowFailure>,
}

/// A reference the server could not show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ShowFailure {
    /// The reference, as the agent gave it.
    pub uri: String,
    /// A reason word: `missing`, `outside`, `secret`, ...
    pub reason: String,
    /// What went wrong, in a sentence.
    pub message: String,
}

/// One choice on an approval card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    /// What to send back to choose it.
    pub option_id: String,
    /// ACP's kind: `allow_once`, `allow_always`, `reject_once` or
    /// `reject_always`. Decides the button's style, not its label.
    pub kind: String,
    /// The agent's own label, shown as it is: only the agent knows what, say,
    /// its "always" saves to.
    pub name: String,
}

/// One question on a question card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The form field it answers. Only the host reads it.
    pub id: String,
    /// A short label above the question (Claude's `header`), if any.
    pub header: Option<String>,
    /// The question, or `None` when the card's `message` is the question.
    pub text: Option<String>,
    /// The choices, in the agent's order. Empty for a free-text question.
    pub choices: Vec<QuestionChoice>,
    /// Several choices may be picked.
    pub multi: bool,
    /// The user may type an answer of their own.
    pub other: bool,
}

/// One choice of a [`Question`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct QuestionChoice {
    /// What to send back to pick it.
    pub value: String,
    /// The agent's label for it.
    pub label: String,
    /// The agent's longer description, if it gave one.
    pub description: Option<String>,
}

/// The user's answer to one [`Question`], in the card's order.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct QuestionReply {
    /// The values of the choices picked: one at most unless `multi`.
    pub picks: Vec<String>,
    /// What the user typed instead, or as well for a multi-select.
    pub other: Option<String>,
}

/// How a question card ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QuestionOutcome {
    /// The user answered.
    Answered {
        /// One reply per question, in the card's order.
        replies: Vec<QuestionReply>,
    },
    /// The user chose not to answer. The agent is told so and carries on.
    Skipped,
    /// The turn was stopped, the agent withdrew the question, or it exited.
    Cancelled,
}

/// One step of a plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    /// What the step is.
    pub content: String,
    /// `pending`, `in_progress` or `completed`, as ACP sends it.
    pub status: String,
    /// `high`, `medium` or `low`, as ACP sends it.
    pub priority: String,
}

/// Where a session is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// The process is starting and the session is being opened.
    Starting,
    /// Idle and ready for a prompt.
    Ready,
    /// A turn is running.
    Working,
    /// A turn is paused on an approval.
    NeedsInput,
    /// The process has exited. The next prompt starts a new one.
    Stopped,
    /// The process could not be started or the session could not be opened.
    Failed,
}

/// A cause the agent tab can explain in a sentence. `strings.ts` holds the
/// sentences; these are only the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Hint {
    /// The harness's own program is not on PATH.
    HarnessMissing,
    /// Its ACP adapter is not on PATH.
    AdapterMissing,
    /// The harness reports nobody signed in.
    SignedOut,
    /// The adapter is not the version this build was tested with.
    AdapterVersion,
    /// A request named a file outside the worktree, and the host refused it.
    OutsideWorktree,
}

/// What `agent-tab/attach` answers: everything drawn so far, and where the
/// live stream picks up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// The session's status, or `None` before the first prompt.
    pub status: Option<SessionStatus>,
    /// Every item, each in its latest state, oldest first.
    pub items: Vec<Item>,
    /// The last sequence number these reflect. Live envelopes at or below it
    /// are already in `items`.
    pub seq: u64,
}

/// One registered harness, as the agent tab sees it: whether it can
/// start here, and what to say about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    /// Which harness.
    pub harness: Harness,
    /// Its name in the UI.
    pub name: String,
    /// Why it cannot start, or `None` when it can.
    pub hint: Option<Hint>,
    /// The commands a hint's sentence names.
    pub setup: Setup,
    /// What the tab may offer for it.
    pub capabilities: Capabilities,
    /// The models its agent offers, as its `model` option lists them, or
    /// `None` until the host has asked it.
    pub models: Option<Vec<ConfigChoice>>,
    /// The value of the model its next session starts on: the tab's choice,
    /// else the agent's default. `None` when neither is known.
    pub model: Option<String>,
    /// Commands advertised during discovery, before the tab starts its own session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub commands: Option<Vec<AgentCommand>>,
    /// The modes its agent offers, as discovery found them, less those held
    /// back (`config::NOT_OFFERED`); `None` until the host has asked it. The
    /// tab can pick one before the session exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub modes: Option<Vec<ConfigChoice>>,
    /// The mode each of its sessions starts in, its policy's ask-first mode,
    /// until a pick from `modes` switches it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub ask_first: Option<String>,
}

/// A session's whole status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// Where it is.
    pub state: SessionState,
    /// Which harness.
    pub harness: Harness,
    /// The working directory: the cluster's worktree.
    pub cwd: String,
    /// The agent's current mode id (Claude: `default` is ask-before-acting),
    /// as the agent reports it, even one the tab does not offer. Empty until
    /// the handshake has switched the agent to ask-first.
    pub mode: Option<String>,
    /// The modes the tab may switch to, in the agent's order. Bypass, and
    /// Codex's auto review and full access, are never among them
    /// (`config::NOT_OFFERED`).
    pub modes: Vec<ConfigChoice>,
    /// The agent's other session settings — model, effort, fast mode — as it
    /// last reported them. Filled from the `session/new` reply, so a session
    /// that fails later in its handshake still carries them.
    pub config: Vec<ConfigOption>,
    /// The slash commands the agent last offered, in its order. Empty until it
    /// reports any; a later report replaces the list.
    pub commands: Vec<AgentCommand>,
    /// The number of the last setting change the agent answered. Changing a
    /// setting returns the change's number, and numbers only grow, so the tab
    /// knows which status answers the choice it is showing. A new session
    /// starts past every change made before it.
    pub answered: u64,
    /// What went wrong with the last setting change, until the next one is
    /// answered. Drawn beside the setting, never in the transcript, so
    /// nothing offers to retry it as a prompt.
    pub setting_trouble: Option<SettingTrouble>,
    /// The adapter's own version, as it reported it at `initialize`.
    pub adapter_version: Option<String>,
    /// The process's exit code, once it has exited. Never its output: what an
    /// adapter prints on stderr goes to the log, masked, and nowhere else.
    pub exit_code: Option<i32>,
    /// A known cause, if there is one.
    pub hint: Option<Hint>,
    /// A prompt the host has accepted but not yet started, because the agent is
    /// still starting. The transcript draws a prompt only when its turn
    /// begins, so this is how the tab shows it meanwhile, and Stop withdraws it.
    pub pending_prompt: Option<String>,
    /// The name the agent gave the conversation, as `session_info_update`
    /// reported it. Absent until it does; a later report replaces it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub session_title: Option<String>,
}

/// A setting change the agent has not settled.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SettingTrouble {
    /// No reply within the harness's `setting_timeout`. The host still waits
    /// for one, and later changes wait behind it.
    Unanswered {
        /// The change's number.
        ticket: u64,
    },
    /// The agent refused the change.
    Refused {
        /// The change's number.
        ticket: u64,
        /// The agent's reason, masked.
        message: String,
    },
}

/// One slash command the agent offers, as `available_commands_update` lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// What follows the slash.
    pub name: String,
    /// The agent's one-line description.
    pub description: String,
    /// What the argument looks like, when the command takes one.
    pub hint: Option<String>,
}

/// One session setting the agent offers: ACP's select config option. Every
/// name and value is the agent's own; the tab hardcodes none of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    /// What to send back to change it: `model`, `effort`, `fast`, ...
    pub id: String,
    /// The agent's label for it.
    pub name: String,
    /// The agent's longer description, if it gave one.
    pub description: Option<String>,
    /// ACP's category (`model`, `thought_level`, `model_config`, ...), if any.
    pub category: Option<String>,
    /// The value in use.
    pub value: String,
    /// The values on offer, in the agent's order, groups flattened.
    pub choices: Vec<ConfigChoice>,
}

/// One value a [`ConfigOption`] or the mode can take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    /// What to send back to choose it.
    pub value: String,
    /// The agent's label for it.
    pub name: String,
    /// The agent's longer description, if it gave one.
    pub description: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::{Config, TS};

    /// Every type the agent tab reads, in the order the file declares them.
    fn generated() -> String {
        let cfg = Config::new().with_large_int("number");
        let decls = [
            Harness::decl(&cfg),
            Capabilities::decl(&cfg),
            Setup::decl(&cfg),
            Envelope::decl(&cfg),
            Event::decl(&cfg),
            Item::decl(&cfg),
            ItemKind::decl(&cfg),
            ToolStatus::decl(&cfg),
            FileDiff::decl(&cfg),
            ShowMarker::decl(&cfg),
            ShowFailure::decl(&cfg),
            ApprovalOption::decl(&cfg),
            Question::decl(&cfg),
            QuestionChoice::decl(&cfg),
            QuestionReply::decl(&cfg),
            QuestionOutcome::decl(&cfg),
            PlanEntry::decl(&cfg),
            TaskState::decl(&cfg),
            TaskUsage::decl(&cfg),
            WorkflowRun::decl(&cfg),
            WorkflowPhase::decl(&cfg),
            WorkflowAgent::decl(&cfg),
            AgentState::decl(&cfg),
            SessionState::decl(&cfg),
            Hint::decl(&cfg),
            SessionStatus::decl(&cfg),
            SettingTrouble::decl(&cfg),
            ConfigOption::decl(&cfg),
            ConfigChoice::decl(&cfg),
            AgentCommand::decl(&cfg),
            Attachment::decl(&cfg),
            HarnessInfo::decl(&cfg),
        ];
        let mut out = String::from(
            "// Generated from crates/veistra-agent-host/src/event.rs by ts-rs. Do not edit.\n\
             // Regenerate: VEISTRA_BLESS=1 cargo test -p veistra-agent-host generated_types\n\n",
        );
        for decl in decls {
            out.push_str("export ");
            out.push_str(&decl);
            out.push_str("\n\n");
        }
        out.truncate(out.trim_end().len());
        out.push('\n');
        out
    }

    /// Resolved at run time: a target directory shared between worktrees can
    /// hold a test binary compiled in another checkout.
    fn generated_path() -> std::path::PathBuf {
        let crate_dir = std::env::var("CARGO_MANIFEST_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        std::path::Path::new(&crate_dir).join("../../apps/agent-tab/ui/src/protocol.generated.ts")
    }

    #[test]
    fn generated_types_match_the_checked_in_file() {
        let path = generated_path();
        let want = generated();
        if std::env::var("VEISTRA_BLESS").as_deref() == Ok("1") {
            std::fs::write(&path, &want).unwrap();
        }
        let have = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            want.contains("seq: number"),
            "a u64 must reach TypeScript as number"
        );
        assert!(
            have == want,
            "{} is stale. Regenerate it with:\n  VEISTRA_BLESS=1 cargo test -p veistra-agent-host generated_types",
            path.display()
        );
    }

    #[test]
    fn an_event_serializes_in_the_shape_the_tab_reads() {
        let envelope = Envelope {
            instance_id: "agent-tab-1".into(),
            seq: 3,
            event: Event::ItemDelta {
                item_id: "i2".into(),
                text: "Hel".into(),
            },
        };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "instanceId": "agent-tab-1",
                "seq": 3,
                "event": { "type": "itemDelta", "itemId": "i2", "text": "Hel" }
            })
        );
    }
}
