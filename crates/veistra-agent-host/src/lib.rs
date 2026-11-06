//! The Veistra agent host: runs a coding agent (Veistra's own, Claude or Codex)
//! as a child process that speaks the Agent Client Protocol on its standard
//! streams, and turns everything it says into one event model the agent tab
//! draws.
//!
//! No Tauri here. The orchestrator owns where an agent may run (a cluster's
//! local worktree or main checkout) and how events reach a window; this crate owns
//! the process, the protocol and the normalizing, so `cargo test` can drive a
//! real child — `src/bin/mock-agent.rs` — without a window.
//!
//! See `docs/handoffs/agent-host.md` for the plan this implements, and §0 of it
//! for the rules: no login token is ever read, stored or logged; the `claude`
//! binary runs unmodified with the user's own sign-in; prompts travel on stdin,
//! never on a command line; and no session starts outside a git checkout
//! ([`Worktree`]).

#![warn(missing_docs, unreachable_pub)]

pub mod config;
pub mod elicit;
pub mod event;
pub mod guard;
pub mod harness;
pub mod host;
mod job;
pub mod mask;
pub mod mcp;
pub mod models;
pub mod normalize;
pub mod session;
pub mod transcript;
mod transfer;
pub mod veistra_call;
pub mod wire;
pub mod workflow;

pub use event::{
    Attachment, ConfigChoice, ConfigOption, Envelope, Event, HarnessInfo, Hint, Item, ItemKind,
    QuestionOutcome, QuestionReply, SessionState, SessionStatus, SettingTrouble,
};
pub use guard::{NotAWorktree, Worktree};
pub use harness::{
    spec, Capabilities, Descriptor, Harness, LaunchSpec, Setup, SkillDelivery, REGISTRY,
};
pub use host::{Adapter, AgentHost, HostError};
pub use mcp::McpServer;
pub use session::{Level, Log, Sink};
