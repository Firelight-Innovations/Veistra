//! Programs installed alongside this development checkout, never in the project an agent edits.
//!
//! Two fallbacks, both behind whatever is on the user's PATH:
//!
//! - Codex's adapter, from `pnpm setup:codex`.
//! - Veistra's own agent and its sign-in program, from `pnpm build`
//!   (`packages/veistra-agent/bin/`), once its `dist/` exists.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::{which, Descriptor, Harness};

/// Prefer the user's PATH; a local install is an explicit, pinned fallback.
pub(super) fn adapter(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Option<PathBuf> {
    adapter_in(descriptor, path, pathext, &checkout())
}

/// The harness's own program: PATH first, then this checkout's build of it.
pub(super) fn cli(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Option<PathBuf> {
    cli_in(descriptor, path, pathext, &checkout())
}

/// [`adapter`], with the checkout named, for a test.
pub(super) fn adapter_in(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    checkout: &Path,
) -> Option<PathBuf> {
    resolve(
        descriptor.adapter.program,
        descriptor,
        path,
        pathext,
        checkout,
    )
}

/// [`cli`], with the checkout named, for a test.
pub(super) fn cli_in(
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    checkout: &Path,
) -> Option<PathBuf> {
    resolve(descriptor.cli, descriptor, path, pathext, checkout)
}

/// The checkout this crate was built from.
pub(super) fn checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn resolve(
    program: &str,
    descriptor: &Descriptor,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
    checkout: &Path,
) -> Option<PathBuf> {
    which(program, path, pathext).or_else(|| {
        let bin = local_bin(descriptor.harness, checkout)?;
        which(program, Some(bin.as_os_str()), pathext)
    })
}

/// The checkout's folder of `harness`'s programs, if this checkout has one.
fn local_bin(harness: Harness, checkout: &Path) -> Option<PathBuf> {
    match harness {
        Harness::Codex => {
            Some(checkout.join("node_modules/.agent-adapters/codex/node_modules/.bin"))
        }
        // The launchers are checked in; the build they run is not, so they
        // count only once it exists.
        Harness::Veistra => {
            let package = checkout.join("packages/veistra-agent");
            package
                .join("dist/acp.js")
                .is_file()
                .then(|| package.join("bin"))
        }
        Harness::Claude => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{CLAUDE, CODEX, VEISTRA};

    fn touch(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        });
        std::fs::write(&file, "").unwrap();
        file
    }

    fn codex_bin(checkout: &Path) -> PathBuf {
        checkout.join("node_modules/.agent-adapters/codex/node_modules/.bin")
    }

    #[test]
    fn a_local_adapter_makes_codex_available_without_a_global_install() {
        let checkout = tempfile::tempdir().unwrap();
        let local = touch(&codex_bin(checkout.path()), "codex-acp");
        assert_eq!(
            resolve("codex-acp", &CODEX, None, None, checkout.path()),
            Some(local)
        );
    }

    #[test]
    fn an_adapter_on_path_keeps_precedence() {
        let checkout = tempfile::tempdir().unwrap();
        touch(&codex_bin(checkout.path()), "codex-acp");
        let global = tempfile::tempdir().unwrap();
        let wanted = touch(global.path(), "codex-acp");
        assert_eq!(
            resolve(
                "codex-acp",
                &CODEX,
                Some(global.path().as_os_str()),
                None,
                checkout.path()
            ),
            Some(wanted)
        );
    }

    #[test]
    fn no_fallback_is_invented_for_other_harnesses_or_an_uninstalled_codex() {
        let checkout = tempfile::tempdir().unwrap();
        touch(&codex_bin(checkout.path()), "claude-agent-acp");
        assert_eq!(
            resolve("claude-agent-acp", &CLAUDE, None, None, checkout.path()),
            None
        );
        assert_eq!(
            resolve("codex-acp", &CODEX, None, None, checkout.path()),
            None
        );
    }

    #[test]
    fn veistra_runs_the_checkouts_build_only_once_it_is_built() {
        let checkout = tempfile::tempdir().unwrap();
        let package = checkout.path().join("packages/veistra-agent");
        let acp = touch(&package.join("bin"), "veistra-agent-acp");
        let cli = touch(&package.join("bin"), "veistra-agent");
        let find = |program| resolve(program, &VEISTRA, None, None, checkout.path());
        assert_eq!(find("veistra-agent-acp"), None, "no dist/ yet");
        std::fs::create_dir_all(package.join("dist")).unwrap();
        std::fs::write(package.join("dist/acp.js"), "").unwrap();
        assert_eq!(find("veistra-agent-acp"), Some(acp));
        assert_eq!(find("veistra-agent"), Some(cli));
    }

    /// The launchers this fallback runs are checked in beside the package.
    #[test]
    fn this_checkout_has_the_veistra_launchers() {
        let bin = checkout().join("packages/veistra-agent/bin");
        for program in [VEISTRA.cli, VEISTRA.adapter.program] {
            assert!(bin.join(program).is_file(), "{program}");
            assert!(
                bin.join(format!("{program}.cmd")).is_file(),
                "{program}.cmd"
            );
        }
    }
}
