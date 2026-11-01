//! Which agent to run, and how to start it.
//!
//! Every harness Veistra can run is a [`Descriptor`] in [`REGISTRY`]: its name,
//! the program the user installs and signs in to, and the ACP adapter that
//! drives it. The host reads the registry, and the tab reads it through
//! `agent-tab/harnesses`, so a new harness needs no change to the host. How to
//! add one: `docs/agent-harnesses.md`.
//!
//! A descriptor is resolved into a [`LaunchSpec`] — a program, its arguments
//! and its extra environment — and the session runs whatever spec it is
//! handed. That is also how the tests run `src/bin/mock-agent.rs`: as a spec,
//! with no harness of its own.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::event::{HarnessInfo, Hint};
use crate::mcp::McpServer;

mod claude;
mod codex;
pub mod install;
mod managed;

pub use claude::CLAUDE;
pub use codex::CODEX;

/// An agent the tab can run. Each has one [`Descriptor`] in [`REGISTRY`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Harness {
    /// Claude, through `claude-agent-acp`.
    Claude,
    /// Codex, through `codex-acp`.
    Codex,
}

impl Harness {
    /// Its descriptor.
    pub fn descriptor(self) -> &'static Descriptor {
        match self {
            Harness::Claude => &CLAUDE,
            Harness::Codex => &CODEX,
        }
    }
}

/// The variable that stops `cmd.exe` and the Windows loader from searching the
/// current directory for a bare command name.
pub const NO_CWD_SEARCH: &str = "NoDefaultCurrentDirectoryInExePath";

/// Every harness, in the order the tab lists them. The first is the one a tab
/// runs until it chooses another.
///
/// TODO(veistra-harness): Veistra's own harness, a modified Pi, goes first
/// here once it speaks ACP. Until then the tab lists it first as "Coming soon"
/// (`apps/agent-tab/ui/src/harnesses.ts`). Its descriptor must keep `env` free
/// of credentials: the Veistra backend's token comes from the harness's own
/// sign-in, as Claude's and Codex's do. See `docs/agent-harnesses.md`.
pub static REGISTRY: &[&Descriptor] = &[&CLAUDE, &CODEX];

/// The harness a tab runs until it chooses another.
pub fn first() -> Harness {
    REGISTRY[0].harness
}

/// One harness: what the UI calls it, how to find and start it, and how the
/// user sets it up. Veistra runs the user's own binary, signed in by the user.
#[derive(Debug, PartialEq, Eq)]
pub struct Descriptor {
    /// Which harness this describes.
    pub harness: Harness,
    /// Its name in the UI: "Claude", "Codex", "Pi" (handoff §0).
    pub name: &'static str,
    /// The program the user installs and signs in to, as found on PATH.
    pub cli: &'static str,
    /// The variable that tells the adapter where `cli` is, so it never runs
    /// a copy of its own.
    pub cli_env: &'static str,
    /// The ACP adapter Veistra spawns.
    pub adapter: AcpAdapter,
    /// What the user runs in a terminal to sign in. Veistra never runs it.
    pub sign_in: &'static str,
    /// How the tab installs `cli` when the user presses Install. See
    /// [`install`].
    pub install: CliInstall,
    /// More variables for the adapter's environment. Never a credential.
    pub env: &'static [(&'static str, &'static str)],
    /// Variables the adapter must not inherit from Veistra's environment, such
    /// as one that would have it start a sign-in flow.
    pub env_remove: &'static [&'static str],
    /// What Veistra holds every session of it to.
    pub policy: Policy,
    /// How the host talks to it, which picks the [`crate::Adapter`] that runs it.
    pub protocol: Protocol,
    /// What the tab may offer for it.
    pub capabilities: Capabilities,
    /// How Veistra's built-in skills reach it. See [`SkillDelivery`].
    pub skills: SkillDelivery,
}

/// How a harness's own program is installed when the user asks the tab to.
///
/// Always the vendor's own installer, run as the vendor publishes it, and only
/// at the user's press ([`install::plan`]). Veistra never ships, mirrors or
/// patches the program, and signing in stays the user's own step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliInstall {
    /// The vendor's installer script, piped to PowerShell on Windows and to
    /// bash elsewhere.
    Script {
        /// The PowerShell command.
        windows: &'static str,
        /// The POSIX shell command.
        unix: &'static str,
    },
    /// The vendor's npm package, installed globally with its optional
    /// dependencies.
    Npm {
        /// The package name, unpinned: the user's own program, kept current
        /// as the vendor ships it.
        package: &'static str,
    },
}

/// How a harness is given Veistra's built-in skills (`src-tauri/src/skills.rs`).
///
/// Each variant is the least invasive route that harness supports, in this
/// order of preference: something scoped to one session, then a folder the
/// harness reads for the user, then a sentence in the first prompt. The host
/// only carries the result (`LaunchSpec::plugins`, `LaunchSpec::preamble`);
/// the app decides which skills a session gets and puts the files in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillDelivery {
    /// A Claude Code plugin directory holding `skills/<name>/SKILL.md`, passed
    /// for this session only in `session/new`'s
    /// `_meta.claudeCode.options.plugins`. The adapter hands it to the SDK,
    /// which starts `claude` with `--plugin-dir`. Nothing is written into the
    /// user's `~/.claude` or the project.
    ClaudePlugin,
    /// Copied into the folder the harness reads the user's own skills from:
    /// `$<home_env>/skills`, or `~/<home_default>/skills` when the variable is
    /// unset. Used when the harness has no per-session route. The copy carries
    /// a marker file, so Veistra only ever replaces or removes copies it made.
    UserSkills {
        /// The variable that moves the harness's home, such as `CODEX_HOME`.
        home_env: &'static str,
        /// The home's folder under the user's profile when that is unset.
        home_default: &'static str,
    },
    /// Neither: the first prompt names each skill and the absolute path of its
    /// `SKILL.md`, as context the transcript does not show.
    Hint,
}

impl Descriptor {
    /// What `agent-tab/harnesses` answers for it, with `hint` saying what
    /// stands in its way. Its models are the caller's to fill in.
    pub fn info(&self, hint: Option<Hint>) -> HarnessInfo {
        HarnessInfo {
            harness: self.harness,
            name: self.name.to_string(),
            hint,
            setup: Setup {
                cli: self.cli.to_string(),
                sign_in: self.sign_in.to_string(),
                cli_install: install::cli_command(self.install),
                adapter_install: self.adapter.install(),
                adapter_version: self.adapter.version.to_string(),
            },
            capabilities: self.capabilities,
            models: None,
            model: None,
            commands: None,
            modes: None,
            ask_first: Some(self.policy.ask_first.to_string()),
        }
    }
}

/// The commands that set a harness up, for the tab's hint sentences to name.
/// The user runs each in a terminal; Veistra never does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// The harness's own program.
    pub cli: String,
    /// The command that signs in.
    pub sign_in: String,
    /// The vendor's own command that installs the program, for a person to
    /// type; the tab's Install button runs the same installer.
    pub cli_install: String,
    /// The command that installs the tested adapter.
    pub adapter_install: String,
    /// The adapter version this build was tested with.
    pub adapter_version: String,
}

/// The wire protocol between the host and a harness's process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// The Agent Client Protocol on stdio (design AGT-002), run by `Session`.
    /// A harness without it gets a translating adapter and a variant here.
    Acp,
}

/// What a harness can do beyond the basics, so the tab can hide what is `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Add to a running turn without stopping it.
    pub steer: bool,
    /// Branch a thread.
    pub fork: bool,
    /// Switch between the agent's modes.
    pub modes: bool,
}

/// What Veistra holds a harness's sessions to, whatever the user's own settings
/// for that harness would choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// The mode id every session is put in before its first prompt: the one
    /// that asks before acting. A session that will not switch to it does not
    /// run.
    pub ask_first: &'static str,
}

/// An ACP adapter, as npm installs it on PATH.
#[derive(Debug, PartialEq, Eq)]
pub struct AcpAdapter {
    /// Its program on PATH.
    pub program: &'static str,
    /// Its npm package.
    pub package: &'static str,
    /// The version this build was tested against, recorded in
    /// `docs/agent-host-versions.md`. Another version still runs, with
    /// [`Hint::AdapterVersion`] on its status.
    pub version: &'static str,
}

impl AcpAdapter {
    /// The command that installs the tested version. `--omit=optional` skips
    /// any copy of the harness bundled with it: Veistra runs the user's own.
    pub fn install(&self) -> String {
        format!("npm i -g --omit=optional {}@{}", self.package, self.version)
    }
}

/// How long an agent may take to answer a setting change. A model switch is
/// a round trip to the harness's CLI, so this is not short.
const SETTING_TIMEOUT: Duration = Duration::from_secs(30);

/// How to start one agent process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    /// Which harness this is, for the status line.
    pub harness: Harness,
    /// The program, as a full path. Never resolved again at spawn.
    pub program: PathBuf,
    /// Its arguments. Empty for every real harness: a Windows `.cmd` shim
    /// goes through `cmd.exe`, and with no arguments there is nothing for its
    /// quoting rules to get wrong.
    pub args: Vec<String>,
    /// Variables added to the inherited environment.
    pub env: Vec<(String, String)>,
    /// Variables removed from it, after `env` is added.
    pub env_remove: Vec<String>,
    /// The adapter version this build expects, if it checks one.
    pub expected_version: Option<&'static str>,
    /// What the session is held to.
    pub policy: Policy,
    /// How long the agent may take to answer a setting change before the tab
    /// is told it has not. The change keeps its place in the queue either way.
    pub setting_timeout: Duration,
    /// Veistra's own MCP servers, offered to the agent in `session/new`.
    /// Empty unless the caller fills it in.
    pub mcp_servers: Vec<McpServer>,
    /// The model the session switches to once it is open, by value: the
    /// tab's choice. `None` leaves the agent on its own default.
    pub model: Option<String>,
    /// Effort requested before the first prompt; applied only if the model offers it.
    pub effort: Option<String>,
    /// Claude's workflow orchestration setting, scoped to this session's SDK options.
    pub ultracode: bool,
    /// The mode the session switches to once it has asked first: the tab's
    /// pick before the session existed. Only a mode the agent offers is sent,
    /// never one held back (`config::NOT_OFFERED`); `None` stays ask-first.
    pub mode: Option<String>,
    /// Claude Code plugin directories for this session only
    /// ([`SkillDelivery::ClaudePlugin`]). Ignored by every other harness.
    pub plugins: Vec<PathBuf>,
    /// Context sent ahead of the first prompt of a new process, which the
    /// agent reads and the transcript does not show ([`SkillDelivery::Hint`]).
    pub preamble: Option<String>,
}

/// The spec for `harness`, or the reason there is none. `path` and `pathext`
/// are the caller's `PATH` and `PATHEXT`, passed in so a test never reads the
/// machine's.
pub fn spec(
    harness: Harness,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Result<LaunchSpec, Hint> {
    resolve_spec(harness, path, pathext, false)
}

/// Resolve an installed harness, including the build checkout's explicitly installed Codex adapter.
/// Unlike [`spec`], this may fall back to `pnpm setup:codex`'s local install.
pub fn installed_spec(
    harness: Harness,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Result<LaunchSpec, Hint> {
    resolve_spec(harness, path, pathext, true)
}

fn resolve_spec(
    harness: Harness,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    local: bool,
) -> Result<LaunchSpec, Hint> {
    let descriptor = harness.descriptor();
    let cli = which(descriptor.cli, path, pathext).ok_or(Hint::HarnessMissing)?;
    let adapter = if local {
        managed::adapter(descriptor, path, pathext)
    } else {
        which(descriptor.adapter.program, path, pathext)
    }
    .ok_or(Hint::AdapterMissing)?;
    Ok(LaunchSpec {
        harness,
        program: adapter,
        args: Vec::new(),
        env: launch_env(descriptor.env, descriptor.cli_env, &cli),
        env_remove: descriptor
            .env_remove
            .iter()
            .map(|k| k.to_string())
            .collect(),
        expected_version: Some(descriptor.adapter.version),
        policy: descriptor.policy,
        setting_timeout: SETTING_TIMEOUT,
        mcp_servers: Vec::new(),
        model: None,
        effort: None,
        ultracode: false,
        mode: None,
        plugins: Vec::new(),
        preamble: None,
    })
}

/// The variables added to the adapter's environment: the descriptor's own
/// `env` first, then `cli_env` naming `cli`, then [`NO_CWD_SEARCH`].
/// `Command::envs` lets a later entry win, so no registry row can undo the
/// two that come last.
fn launch_env(env: &[(&str, &str)], cli_env: &str, cli: &Path) -> Vec<(String, String)> {
    let mut all: Vec<(String, String)> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    all.push((cli_env.to_string(), cli.to_string_lossy().into_owned()));
    // The adapter runs in the user's worktree, which is untrusted repository
    // content. An npm shim ends in a bare `node`, and `cmd.exe` looks in the
    // current directory before PATH for a bare name unless this is set, so a
    // `node.cmd` at a repository's root would run the moment the user pressed
    // Send, before any permission request could stop it. Every harness's
    // adapter is an npm shim.
    all.push((NO_CWD_SEARCH.to_string(), "1".to_string()));
    all
}

/// The first file named `name` on `path`, trying each `pathext` extension on
/// Windows (`.COM;.EXE;.BAT;.CMD` when unset) and the bare name elsewhere.
pub fn which(name: &str, path: Option<&OsStr>, pathext: Option<&OsStr>) -> Option<PathBuf> {
    let path = path?;
    let extensions = extensions(pathext);
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .find_map(|dir| {
            extensions
                .iter()
                .map(|ext| candidate(&dir, name, ext))
                .find(|file| file.is_file())
        })
}

fn candidate(dir: &Path, name: &str, ext: &OsStr) -> PathBuf {
    let mut file = OsString::from(name);
    file.push(ext);
    dir.join(file)
}

fn extensions(pathext: Option<&OsStr>) -> Vec<OsString> {
    if !cfg!(windows) {
        return vec![OsString::new()];
    }
    let list = pathext
        .and_then(OsStr::to_str)
        .unwrap_or(".COM;.EXE;.BAT;.CMD");
    list.split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| OsString::from(ext.to_ascii_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, file: &str) -> PathBuf {
        let path = dir.join(file);
        std::fs::write(&path, b"").unwrap();
        path
    }

    fn exe(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        }
    }

    #[test]
    fn claude_needs_both_the_binary_and_the_adapter() {
        let dir = tempfile::tempdir().unwrap();
        let path = Some(dir.path().as_os_str());
        let ext = Some(OsStr::new(".EXE;.CMD"));
        assert_eq!(spec(Harness::Claude, path, ext), Err(Hint::HarnessMissing));

        let claude = touch(dir.path(), &exe("claude"));
        assert_eq!(spec(Harness::Claude, path, ext), Err(Hint::AdapterMissing));

        let adapter = touch(dir.path(), &exe("claude-agent-acp"));
        let spec = spec(Harness::Claude, path, ext).unwrap();
        assert_eq!(spec.program, adapter);
        assert!(spec.args.is_empty(), "a .cmd shim must get no arguments");
        assert_eq!(
            spec.env,
            vec![
                (
                    "CLAUDE_CODE_EXECUTABLE".to_string(),
                    claude.to_string_lossy().into_owned()
                ),
                (
                    "NoDefaultCurrentDirectoryInExePath".to_string(),
                    "1".to_string()
                ),
            ],
            "the worktree is never searched for the `node` a shim runs"
        );
        assert_eq!(spec.expected_version, Some("0.90.0"));
        assert_eq!(spec.policy.ask_first, "default");
    }

    #[test]
    fn a_descriptor_cannot_undo_the_variables_spec_relies_on() {
        let env = launch_env(
            &[
                (NO_CWD_SEARCH, "0"),
                ("CLAUDE_CODE_EXECUTABLE", "C:/elsewhere/claude.cmd"),
                ("OTHER", "kept"),
            ],
            "CLAUDE_CODE_EXECUTABLE",
            Path::new("C:/bin/claude.cmd"),
        );
        // The child sees the last entry for each name.
        let seen = |name: &str| {
            env.iter()
                .rev()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(seen(NO_CWD_SEARCH), Some("1"));
        assert_eq!(seen("CLAUDE_CODE_EXECUTABLE"), Some("C:/bin/claude.cmd"));
        assert_eq!(seen("OTHER"), Some("kept"));
    }

    /// A row that set either would be silently ignored, and one that removed
    /// either would undo it, so none may. Windows reads variable names without
    /// regard to case, and so does the check.
    #[test]
    fn no_descriptor_sets_a_variable_spec_relies_on() {
        for descriptor in REGISTRY {
            let keys = descriptor.env.iter().map(|(k, _)| k);
            for key in keys.chain(descriptor.env_remove) {
                for reserved in [NO_CWD_SEARCH, descriptor.cli_env] {
                    assert!(
                        !key.eq_ignore_ascii_case(reserved),
                        "{:?} sets or removes {key}, which spec sets itself",
                        descriptor.harness
                    );
                }
            }
        }
    }

    #[test]
    fn codex_runs_the_users_own_binary_and_starts_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = Some(dir.path().as_os_str());
        let ext = Some(OsStr::new(".EXE;.CMD"));
        let codex = touch(dir.path(), &exe("codex"));
        assert_eq!(spec(Harness::Codex, path, ext), Err(Hint::AdapterMissing));

        let adapter = touch(dir.path(), &exe("codex-acp"));
        let spec = spec(Harness::Codex, path, ext).unwrap();
        assert_eq!(spec.harness, Harness::Codex);
        assert_eq!(spec.program, adapter);
        assert!(spec.args.is_empty(), "a .cmd shim must get no arguments");
        assert_eq!(
            spec.env,
            vec![
                ("INITIAL_AGENT_MODE".to_string(), "read-only".to_string()),
                (
                    "CODEX_PATH".to_string(),
                    codex.to_string_lossy().into_owned()
                ),
                (
                    "NoDefaultCurrentDirectoryInExePath".to_string(),
                    "1".to_string()
                ),
            ]
        );
        assert_eq!(
            spec.env_remove,
            ["DEFAULT_AUTH_REQUEST"],
            "it would sign in"
        );
        assert_eq!(spec.expected_version, Some("2.2.2"));
        assert_eq!(spec.policy.ask_first, "read-only");
        assert_eq!(
            CODEX.adapter.install(),
            "npm i -g --omit=optional @agentclientprotocol/codex-acp@2.2.2"
        );
        assert_eq!(CODEX.info(None).setup.sign_in, "codex login");
    }

    #[test]
    fn no_harness_starts_in_a_mode_veistra_holds_back() {
        for d in REGISTRY {
            let held = |m: &str| crate::config::NOT_OFFERED.contains(&m);
            assert!(
                !held(d.policy.ask_first),
                "{} asks first in a held-back mode",
                d.name
            );
            for &(key, value) in d.env {
                assert!(!held(value), "{} sets {key} to a held-back mode", d.name);
            }
        }
    }

    #[test]
    fn every_harness_has_one_descriptor_that_names_it() {
        assert_eq!(first(), Harness::Claude);
        for descriptor in REGISTRY {
            assert_eq!(descriptor.harness.descriptor(), *descriptor);
            let same = REGISTRY.iter().filter(|d| d.harness == descriptor.harness);
            assert_eq!(
                same.count(),
                1,
                "{:?} is registered twice",
                descriptor.harness
            );
        }
    }

    /// Every variant of [`Harness`], read off the type itself rather than a
    /// list kept by hand. ts-rs writes a unit enum as a union of its serde
    /// names, and serde reads each name back.
    fn every_variant() -> Vec<Harness> {
        <Harness as ts_rs::TS>::inline(&ts_rs::Config::new())
            .split('|')
            .map(|name| serde_json::from_str(name.trim()).unwrap())
            .collect()
    }

    #[test]
    fn every_variant_has_a_row_in_the_registry() {
        let variants = every_variant();
        assert!(variants.contains(&Harness::Claude), "{variants:?}");
        for harness in variants {
            assert!(
                REGISTRY.iter().any(|d| d.harness == harness),
                "{harness:?} has a descriptor but no row in REGISTRY"
            );
        }
    }

    #[test]
    fn a_name_is_the_short_one() {
        for d in REGISTRY {
            assert!(!d.name.contains(' '), "handoff §0: {} is too long", d.name);
        }
    }

    #[test]
    fn info_carries_what_the_hint_sentences_name() {
        let info = CLAUDE.info(Some(Hint::SignedOut));
        assert_eq!(info.harness, Harness::Claude);
        assert_eq!(info.name, "Claude");
        assert_eq!(info.hint, Some(Hint::SignedOut));
        assert_eq!(info.setup.cli, "claude");
        assert_eq!(info.setup.sign_in, "claude");
        assert_eq!(info.setup.adapter_install, CLAUDE.adapter.install());
        assert_eq!(info.setup.adapter_version, "0.90.0");
        assert_eq!(info.capabilities, CLAUDE.capabilities);
    }

    #[test]
    fn the_adapter_installs_pinned_without_its_bundled_harness() {
        assert_eq!(
            CLAUDE.adapter.install(),
            "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0"
        );
    }

    #[test]
    fn nothing_is_found_without_a_path() {
        assert_eq!(which("claude", None, None), None);
        assert_eq!(spec(Harness::Claude, None, None), Err(Hint::HarnessMissing));
    }

    #[test]
    fn the_first_directory_on_the_path_wins() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let want = touch(first.path(), &exe("claude"));
        touch(second.path(), &exe("claude"));
        let path = std::env::join_paths([first.path(), second.path()]).unwrap();
        assert_eq!(
            which("claude", Some(&path), Some(OsStr::new(".CMD"))),
            Some(want)
        );
    }
}
