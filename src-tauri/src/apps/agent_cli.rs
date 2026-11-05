//! Native CLI dialogs that ACP does not expose, launched only on an explicit command submission.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use veistra_agent_host::{harness, Harness, Worktree};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};

use super::CallContext;
use crate::pty::PtySessions;
use crate::quoting::{quote_all, ShellFamily};
use crate::shell_state::ShellState;

/// Open a fresh native session in this tab's worktree; the ACP conversation keeps its owner.
pub(super) fn open(
    app: &AppHandle,
    context: &CallContext,
    harness: Harness,
    command: &str,
) -> Result<Value, RpcError> {
    validate(command)?;
    if harness == Harness::Veistra {
        // Its agent has no terminal session; every command it takes, it lists.
        return Err(RpcError::new(
            INVALID_PARAMS,
            "Veistra's agent has no terminal session to run this in",
        ));
    }
    let cluster = context
        .cluster_id
        .as_deref()
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "the command needs a project cluster"))?;
    let shell = app.state::<ShellState>();
    let env = shell.cluster_write_environment(cluster);
    let path = super::agent_tab::worktree_path(env.as_ref(), context.project.as_deref()).map_err(
        |_| {
            RpcError::new(
                INVALID_PARAMS,
                "native agent commands need a local worktree or the main checkout",
            )
        },
    )?;
    Worktree::new(&path).map_err(|error| RpcError::new(INVALID_PARAMS, error.to_string()))?;
    let cli = harness::which(
        harness.descriptor().cli,
        super::agent_install::search_path().as_deref(),
        super::agent_install::pathext().as_deref(),
    )
    .ok_or_else(|| RpcError::new(INVALID_PARAMS, "the selected harness CLI is not installed"))?;
    let ptys = app.state::<PtySessions>();
    let id = crate::commands::open_terminal(app, &shell, &ptys, cluster, 100, 30)
        .map_err(|error| RpcError::new(INTERNAL_ERROR, error.to_string()))?;
    let line = ptys
        .target(&id)
        .ok_or_else(|| RpcError::new(INTERNAL_ERROR, "the terminal ended before launch"))
        .and_then(|target| invocation(target.family, &cli.to_string_lossy(), command));
    let line = match line {
        Ok(line) => line,
        Err(error) => {
            shell.close_terminal(app, &id);
            ptys.close(&id);
            return Err(error);
        }
    };
    ptys.write(&id, &line);
    Ok(json!({ "terminalId": id, "freshSession": true }))
}

/// A command is one line of native CLI input, never shell syntax or a program name.
fn validate(command: &str) -> Result<(), RpcError> {
    let name = command.trim().split_ascii_whitespace().next().unwrap_or("");
    let legal_name = name.strip_prefix('/').is_some_and(|name| {
        !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    });
    if !legal_name || command.len() > 8000 || command.chars().any(char::is_control) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "expected one slash command without control characters",
        ));
    }
    Ok(())
}

/// Quote every user-controlled argument for the shell the new terminal actually runs.
fn invocation(family: ShellFamily, cli: &str, command: &str) -> Result<String, RpcError> {
    validate(command)?;
    if cli.chars().any(char::is_control) {
        return Err(RpcError::new(INVALID_PARAMS, "invalid CLI executable path"));
    }
    // Cmd expands percent variables even inside quotes, and cannot quote a literal double quote.
    if family == ShellFamily::Cmd && [cli, command].iter().any(|s| s.contains(['%', '!', '"'])) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "use PowerShell for commands containing quotes or percent signs",
        ));
    }
    let args = [
        cli.to_string(),
        "--".to_string(),
        command.trim().to_string(),
    ];
    let prefix = if family == ShellFamily::PowerShell {
        "& "
    } else {
        ""
    };
    Ok(format!("{prefix}{}\r", quote_all(family, &args).trim_end()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_keeps_shell_syntax_inside_one_literal_cli_argument() {
        let command = "/config key='value'; $(Get-Secret) `whoami`";
        assert_eq!(
            invocation(ShellFamily::PowerShell, "C:/Program Files/Claude/claude.exe", command).unwrap(),
            "& 'C:/Program Files/Claude/claude.exe' '--' '/config key=''value''; $(Get-Secret) `whoami`'\r"
        );
    }

    #[test]
    fn posix_quotes_the_executable_and_preserves_command_text() {
        assert_eq!(
            invocation(ShellFamily::Posix, "/a path/codex", "/rename Bob's task").unwrap(),
            "'/a path/codex' '--' '/rename Bob'\\''s task'\r"
        );
    }

    #[test]
    fn cmd_rejects_unquotable_input_and_all_shells_reject_control_sequences() {
        for command in ["/rename %PATH%", "/rename !PATH!", "/rename \"task\""] {
            assert!(invocation(ShellFamily::Cmd, "codex.exe", command).is_err());
        }
        for command in [
            "/status\rwhoami",
            "/status\nwhoami",
            "/status\u{1b}[A",
            "whoami",
            "/",
        ] {
            assert!(invocation(ShellFamily::PowerShell, "codex.exe", command).is_err());
        }
        assert!(invocation(ShellFamily::Cmd, "codex.exe", "/status").is_ok());
    }
}
