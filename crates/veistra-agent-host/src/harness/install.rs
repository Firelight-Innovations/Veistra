//! Installing a harness from the tab, at the user's press.
//!
//! The tab offers an Install button when a harness's own program or its ACP
//! adapter is missing ([`crate::event::Hint::HarnessMissing`],
//! [`crate::event::Hint::AdapterMissing`]). This module decides what that
//! press runs; the app runs it. Each step is the vendor's own installer:
//!
//! - the program, by its descriptor's [`CliInstall`]: Anthropic's installer
//!   script for Claude, OpenAI's npm package for Codex, and for Veistra's own
//!   nothing apart, since it ships in the adapter's package;
//! - the adapter, by the same pinned `npm i -g --omit=optional` the hint
//!   sentences name ([`super::AcpAdapter::install`]).
//!
//! Nothing here signs in: that stays the user's `/login` or their terminal.
//!
//! A program an installer puts on the user's PATH is not on Veistra's own,
//! which was read when Veistra started. [`known_dirs`] names where the
//! installers put programs, and [`widen`] adds them to the PATH searched, so
//! the tab finds what it just installed without a restart.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::{managed, which, AcpAdapter, CliInstall, Descriptor};

/// Which part of a harness a step installs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    /// The harness's own program.
    Cli,
    /// Its ACP adapter.
    Adapter,
}

impl Part {
    /// The word the tab's events carry for it.
    pub fn id(self) -> &'static str {
        match self {
            Part::Cli => "cli",
            Part::Adapter => "adapter",
        }
    }
}

/// One process to run, in order, to install part of a harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    /// What it installs.
    pub part: Part,
    /// The program, as a full path found on the searched PATH.
    pub program: PathBuf,
    /// Its arguments.
    pub args: Vec<String>,
}

/// Why nothing can be installed yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    /// A step needs npm, and there is none: the user installs Node.js first.
    NodeMissing,
    /// The installer script needs PowerShell or bash, and there is none.
    ShellMissing,
}

/// What to run to install whatever `descriptor` is missing, program first.
/// Empty when nothing is missing. Checked whole before anything runs, so a
/// missing npm never leaves a harness half installed.
pub fn plan(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Result<Vec<Step>, Blocked> {
    plan_in(
        descriptor,
        path,
        pathext,
        cfg!(windows),
        &managed::checkout(),
    )
}

/// [`plan`] for a platform and a checkout a test names.
fn plan_in(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    windows: bool,
    checkout: &Path,
) -> Result<Vec<Step>, Blocked> {
    let npm = || which("npm", path, pathext).ok_or(Blocked::NodeMissing);
    let mut steps = Vec::new();
    let cli_missing = managed::cli_in(descriptor, path, pathext, checkout).is_none();
    if cli_missing {
        match descriptor.install {
            CliInstall::Script { windows: ps, unix } => {
                steps.push(script(ps, unix, path, pathext, windows)?);
            }
            CliInstall::Npm { package } => steps.push(Step {
                part: Part::Cli,
                program: npm()?,
                args: vec!["i".into(), "-g".into(), package.into()],
            }),
            // The adapter's step below brings it.
            CliInstall::WithAdapter => {}
        }
    }
    let with_adapter = cli_missing && descriptor.install == CliInstall::WithAdapter;
    if with_adapter || managed::adapter_in(descriptor, path, pathext, checkout).is_none() {
        let adapter = &descriptor.adapter;
        steps.push(Step {
            part: Part::Adapter,
            program: npm()?,
            args: vec![
                "i".into(),
                "-g".into(),
                "--omit=optional".into(),
                format!("{}@{}", adapter.package, adapter.version),
            ],
        });
    }
    Ok(steps)
}

/// The installer script as a step: PowerShell's `-Command` on Windows, bash
/// with `pipefail` elsewhere, so a failed download fails the step.
fn script(
    ps: &str,
    unix: &str,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    windows: bool,
) -> Result<Step, Blocked> {
    let (shell, args) = if windows {
        let args = [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
        ];
        ("powershell", [&args[..], &["-Command", ps]].concat())
    } else {
        ("bash", vec!["-o", "pipefail", "-c", unix])
    };
    Ok(Step {
        part: Part::Cli,
        program: which(shell, path, pathext).ok_or(Blocked::ShellMissing)?,
        args: args.into_iter().map(str::to_string).collect(),
    })
}

/// The command a person would type to install the program themselves, for
/// the tab's hint sentence.
pub fn cli_command(install: CliInstall, adapter: &AcpAdapter) -> String {
    match install {
        CliInstall::Script { windows, unix } => {
            if cfg!(windows) {
                windows.to_string()
            } else {
                unix.to_string()
            }
        }
        CliInstall::Npm { package } => format!("npm i -g {package}"),
        CliInstall::WithAdapter => adapter.install(),
    }
}

/// Where the installers put programs: Anthropic's native installer uses
/// `~/.local/bin` everywhere, and npm's global shims go in `%APPDATA%\npm` on
/// Windows. `home` and `appdata` are the caller's, so a test never reads the
/// machine's.
pub fn known_dirs(home: Option<&Path>, appdata: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
    }
    if let (true, Some(appdata)) = (cfg!(windows), appdata) {
        dirs.push(appdata.join("npm"));
    }
    dirs
}

/// `path` with each of `dirs` it lacks added at the end, so whatever the user
/// had first still wins. `None` only when both are empty.
pub fn widen(path: Option<&OsStr>, dirs: &[PathBuf]) -> Option<OsString> {
    let mut all: Vec<PathBuf> = path
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    for dir in dirs {
        if !all.iter().any(|d| d == dir) {
            all.push(dir.clone());
        }
    }
    if all.is_empty() {
        return None;
    }
    std::env::join_paths(all)
        .ok()
        .or_else(|| path.map(OsStr::to_os_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{CLAUDE, CODEX, VEISTRA};

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let file = dir.join(if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        });
        std::fs::write(&file, b"").unwrap();
        file
    }

    fn ext() -> Option<&'static OsStr> {
        Some(OsStr::new(".EXE;.CMD"))
    }

    /// The plan with no checkout build to fall back to.
    fn plan_for(
        descriptor: &Descriptor,
        path: Option<&OsStr>,
        pathext: Option<&OsStr>,
        windows: bool,
    ) -> Result<Vec<Step>, Blocked> {
        let checkout = tempfile::tempdir().unwrap();
        plan_in(descriptor, path, pathext, windows, checkout.path())
    }

    #[test]
    fn veistra_installs_its_one_package_pinned_in_one_step() {
        let dir = tempfile::tempdir().unwrap();
        let npm = touch(dir.path(), "npm");
        let path = Some(dir.path().as_os_str());
        let pinned = Step {
            part: Part::Adapter,
            program: npm,
            args: vec![
                "i".into(),
                "-g".into(),
                "--omit=optional".into(),
                "@veistra/agent@0.1.0".into(),
            ],
        };
        assert_eq!(
            plan_for(&VEISTRA, path, ext(), false),
            Ok(vec![pinned.clone()])
        );
        // An adapter without its sign-in program is a broken install: the
        // same one step repairs it.
        touch(dir.path(), "veistra-agent-acp");
        assert_eq!(plan_for(&VEISTRA, path, ext(), false), Ok(vec![pinned]));
        touch(dir.path(), "veistra-agent");
        assert_eq!(plan_for(&VEISTRA, path, ext(), false), Ok(vec![]));
    }

    #[test]
    fn nothing_runs_when_everything_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "claude");
        touch(dir.path(), "claude-agent-acp");
        let path = Some(dir.path().as_os_str());
        assert_eq!(plan(&CLAUDE, path, ext()), Ok(vec![]));
    }

    #[test]
    fn claude_runs_anthropics_installer_then_the_pinned_adapter() {
        let dir = tempfile::tempdir().unwrap();
        let bash = touch(dir.path(), "bash");
        let npm = touch(dir.path(), "npm");
        let path = Some(dir.path().as_os_str());
        let steps = plan_for(&CLAUDE, path, ext(), false).unwrap();
        assert_eq!(
            steps,
            vec![
                Step {
                    part: Part::Cli,
                    program: bash,
                    args: vec![
                        "-o".into(),
                        "pipefail".into(),
                        "-c".into(),
                        "curl -fsSL https://claude.ai/install.sh | bash".into()
                    ],
                },
                Step {
                    part: Part::Adapter,
                    program: npm,
                    args: vec![
                        "i".into(),
                        "-g".into(),
                        "--omit=optional".into(),
                        "@agentclientprotocol/claude-agent-acp@0.90.0".into()
                    ],
                },
            ]
        );
    }

    #[test]
    fn on_windows_the_script_goes_to_powershell() {
        let dir = tempfile::tempdir().unwrap();
        let ps = touch(dir.path(), "powershell");
        touch(dir.path(), "claude-agent-acp");
        let path = Some(dir.path().as_os_str());
        let steps = plan_for(&CLAUDE, path, ext(), true).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].program, ps);
        assert_eq!(
            steps[0].args.last().map(String::as_str),
            Some("irm https://claude.ai/install.ps1 | iex")
        );
        assert!(steps[0].args.contains(&"-NonInteractive".to_string()));
    }

    /// Codex's native binary is in the package's optional dependencies, so
    /// the program keeps them; the adapter drops them, as it always has.
    #[test]
    fn codex_installs_openais_package_with_its_binary() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "npm");
        let path = Some(dir.path().as_os_str());
        let steps = plan_for(&CODEX, path, ext(), false).unwrap();
        assert_eq!(steps[0].part, Part::Cli);
        assert_eq!(steps[0].args, ["i", "-g", "@openai/codex"]);
        assert_eq!(steps[1].part, Part::Adapter);
        assert!(steps[1].args.contains(&"--omit=optional".to_string()));
        assert_eq!(
            steps[1].args.last().map(String::as_str),
            Some("@agentclientprotocol/codex-acp@2.2.2")
        );
    }

    #[test]
    fn without_npm_nothing_runs_at_all() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "bash");
        let path = Some(dir.path().as_os_str());
        // The script alone could run, but the adapter could not follow it.
        assert_eq!(
            plan_for(&CLAUDE, path, ext(), false),
            Err(Blocked::NodeMissing)
        );
        assert_eq!(
            plan_for(&CODEX, path, ext(), false),
            Err(Blocked::NodeMissing)
        );
    }

    #[test]
    fn without_a_shell_the_script_cannot_run() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "npm");
        let path = Some(dir.path().as_os_str());
        assert_eq!(
            plan_for(&CLAUDE, path, ext(), false),
            Err(Blocked::ShellMissing)
        );
    }

    #[test]
    fn the_known_dirs_are_added_after_the_users_own() {
        let first = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let dirs = known_dirs(Some(home.path()), None);
        assert_eq!(dirs[0], home.path().join(".local").join("bin"));
        let path = std::env::join_paths([first.path()]).unwrap();
        let wide = widen(Some(&path), &dirs).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&wide).collect();
        assert_eq!(parts, [first.path().to_path_buf(), dirs[0].clone()]);
        // Added once, however often it is widened.
        let again = widen(Some(&wide), &dirs).unwrap();
        assert_eq!(again, wide);
        assert_eq!(widen(None, &[]), None);
    }

    #[test]
    fn a_program_installed_to_a_known_dir_is_found() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let claude = touch(&bin, "claude");
        let wide = widen(None, &known_dirs(Some(home.path()), None));
        assert_eq!(which("claude", wide.as_deref(), ext()), Some(claude));
    }

    #[test]
    fn the_typed_command_is_the_vendors() {
        let typed = cli_command(CLAUDE.install, &CLAUDE.adapter);
        assert!(typed.contains("https://claude.ai/install."), "{typed}");
        assert_eq!(
            cli_command(CODEX.install, &CODEX.adapter),
            "npm i -g @openai/codex"
        );
        assert_eq!(
            cli_command(VEISTRA.install, &VEISTRA.adapter),
            "npm i -g --omit=optional @veistra/agent@0.1.0"
        );
    }
}
