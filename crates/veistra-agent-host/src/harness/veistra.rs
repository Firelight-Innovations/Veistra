//! Veistra's own harness (`docs/design/VEISTRA-HARNESS.md`): Pi, run through
//! its SDK with Veistra's modules around it, as one ACP agent,
//! `veistra-agent-acp`, from the npm package `@veistra/agent`
//! (`packages/veistra-agent`). The same package carries `veistra-agent`, the
//! program the user signs in with, so one install brings both.
//!
//! The agent speaks ACP itself, so there is no third-party adapter and no
//! separate binary to point it at. It keeps the user's provider key in its own
//! home through its own sign-in, and nothing here passes one. In this checkout
//! the host falls back to the agent `pnpm build` compiled
//! ([`super::managed`]).

use super::{
    AcpAdapter, Capabilities, CliInstall, Descriptor, Harness, Policy, Protocol, SkillDelivery,
};

/// Veistra, through `veistra-agent-acp`.
pub static VEISTRA: Descriptor = Descriptor {
    harness: Harness::Veistra,
    name: "Veistra",
    cli: "veistra-agent",
    cli_env: None,
    adapter: AcpAdapter {
        program: "veistra-agent-acp",
        package: "@veistra/agent",
        version: "0.1.0",
    },
    sign_in: "veistra-agent login",
    install: CliInstall::WithAdapter,
    env: &[],
    env_remove: &[],
    // `default` reads in the worktree and asks before every edit, command and
    // tool. The agent has no mode that acts without asking.
    policy: Policy {
        ask_first: "default",
    },
    protocol: Protocol::Acp,
    capabilities: Capabilities {
        steer: false,
        fork: false,
        modes: true,
    },
    skills: SkillDelivery::SessionFolder,
};
