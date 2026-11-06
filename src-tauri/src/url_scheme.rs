//! `veistra://`, the address veistra.com's "Open the Veistra app" button links to.
//!
//! Windows runs whatever `HKCU\Software\Classes\veistra\shell\open\command`
//! names, with the URL as its argument. That is an ordinary second launch, so
//! `launch::from_second_instance` raises the window already open; with nothing
//! open it is a first launch, which opens one. The URL names no target, and
//! `launch::first_path_arg` skips it rather than looking for a file called that.
//!
//! The installer writes the key (`installer-hooks.nsh`). A build that was never
//! installed (`pnpm app`) writes it here, but only while nothing usable holds
//! it: an installed Veistra keeps the scheme, and its launch still reaches this
//! process through single-instance because both carry the same identifier. An
//! agent's instance has its own identifier and never claims it, or the button
//! would wake the agent's window instead of the person's.

use std::path::{Path, PathBuf};

pub const SCHEME: &str = "veistra";

/// Whether `arg` is one of this scheme's URLs rather than a path.
pub fn is_url(arg: &str) -> bool {
    arg.len() > SCHEME.len() + 3
        && arg[..SCHEME.len()].eq_ignore_ascii_case(SCHEME)
        && arg[SCHEME.len()..].starts_with("://")
}

/// The command line the scheme runs: this binary, handed the URL.
fn command_for(exe: &Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

/// The program a registered command runs, quoted or not.
fn program_of(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    let program = match command.strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => command.split_whitespace().next()?,
    };
    (!program.is_empty()).then(|| PathBuf::from(program))
}

/// Claim the scheme when no key names a program that still exists.
fn should_claim(existing: Option<&str>, exists: impl Fn(&Path) -> bool) -> bool {
    match existing.and_then(program_of) {
        Some(program) => !exists(&program),
        None => true,
    }
}

/// Point `veistra://` at this binary if nothing usable already answers it.
/// Failure is logged and otherwise ignored: the button then does nothing, as
/// it did before this existed, and nothing else depends on the key.
pub fn claim_if_unclaimed(identifier: &str) {
    if identifier != crate::userdata::identity::IDENTIFIER {
        return;
    }
    let existing = registry::read_command();
    if !should_claim(existing.as_deref(), Path::exists) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if let Err(code) = registry::write(&exe, &command_for(&exe)) {
        eprintln!("[url_scheme] could not register {SCHEME}:// (error {code})");
    }
}

#[cfg(windows)]
mod registry {
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    const ROOT: &str = r"Software\Classes\veistra";
    const COMMAND: &str = r"Software\Classes\veistra\shell\open\command";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The command's default value, or `None` when the key is not there.
    pub fn read_command() -> Option<String> {
        let key = wide(COMMAND);
        let mut buffer = vec![0u16; 1024];
        let mut bytes = (buffer.len() * 2) as u32;
        // SAFETY: `key` is NUL-terminated, `buffer` holds `bytes` bytes, and a
        // null value name reads the key's default value.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                null(),
                RRF_RT_REG_SZ,
                null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let len = (bytes as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buffer[..len.min(buffer.len())]))
    }

    /// Set one string value on `subkey`, creating it. `name` "" is the default.
    fn set(subkey: &str, name: &str, value: &str) -> Result<(), u32> {
        let (subkey, name, value) = (wide(subkey), wide(name), wide(value));
        let mut key: HKEY = null_mut();
        // SAFETY: every string is NUL-terminated and outlives the call; `key`
        // is written only on success and closed below.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                null(),
                &mut key,
                null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(status);
        }
        // SAFETY: `key` is open; `value` is `value.len() * 2` bytes including
        // its NUL, which is what REG_SZ expects.
        let status = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        // SAFETY: `key` came from the successful create above.
        unsafe { RegCloseKey(key) };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(status)
        }
    }

    /// The keys the installer writes, for a binary it did not install.
    pub fn write(exe: &Path, command: &str) -> Result<(), u32> {
        set(ROOT, "", "URL:Veistra")?;
        set(ROOT, "URL Protocol", "")?;
        set(
            &format!(r"{ROOT}\DefaultIcon"),
            "",
            &format!("{},0", exe.display()),
        )?;
        set(COMMAND, "", command)
    }
}

#[cfg(not(windows))]
mod registry {
    use std::path::Path;

    pub fn read_command() -> Option<String> {
        None
    }

    /// Other platforms register a scheme in their bundle, not at runtime.
    pub fn write(_exe: &Path, _command: &str) -> Result<(), u32> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_its_own_urls_and_nothing_else() {
        assert!(is_url("veistra://open"));
        assert!(is_url("VEISTRA://open"));
        assert!(!is_url("veistra://"));
        assert!(!is_url("C:\\code\\veistra"));
        assert!(!is_url("https://veistra.com/device"));
    }

    #[test]
    fn reads_the_program_out_of_a_command() {
        let quoted = r#""C:\Program Files\Veistra\veistra.exe" "%1""#;
        assert_eq!(
            program_of(quoted),
            Some(PathBuf::from(r"C:\Program Files\Veistra\veistra.exe"))
        );
        assert_eq!(program_of(r"C:\v.exe %1"), Some(PathBuf::from(r"C:\v.exe")));
        assert_eq!(program_of("  "), None);
    }

    #[test]
    fn writes_a_command_that_reads_back_as_the_same_program() {
        let exe = Path::new(r"C:\Program Files\Veistra\veistra.exe");
        assert_eq!(program_of(&command_for(exe)).as_deref(), Some(exe));
    }

    /// An installed Veistra keeps the scheme; a key left by a deleted build
    /// is taken over, so the button never points at nothing.
    #[test]
    fn claims_only_a_missing_or_dead_registration() {
        let alive = |_: &Path| true;
        let dead = |_: &Path| false;
        assert!(should_claim(None, alive));
        assert!(!should_claim(Some(r#""C:\v.exe" "%1""#), alive));
        assert!(should_claim(Some(r#""C:\gone.exe" "%1""#), dead));
    }
}
