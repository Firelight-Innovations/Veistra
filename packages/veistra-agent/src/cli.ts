#!/usr/bin/env node
/**
 * `veistra-agent`: sign in, sign out, and say who is signed in. The agent itself is
 * `veistra-agent-acp` (`acp.ts`); this program never speaks ACP.
 */
import { checkNode, quietPi } from "./node.js";

const USAGE = `Usage: veistra-agent <command>

  login [provider]    Save a model provider's API key for Veistra's agent
  logout [provider]   Remove a saved key (every one when no provider is named)
  status              List the providers with a saved key
  version             Print this program's version
`;

async function main(argv: string[]): Promise<number> {
  const problem = checkNode();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 1;
  }
  quietPi();
  const { agentDir, modelRuntime, version } = await import("./home.js");
  const [command, arg] = argv;
  if (command === "version" || command === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (command !== "login" && command !== "logout" && command !== "status") {
    process.stdout.write(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
  const runtime = await modelRuntime(agentDir());
  if (command === "status") {
    const saved = await runtime.listCredentials();
    if (saved.length === 0) process.stdout.write("No saved keys.\n");
    for (const c of saved) process.stdout.write(`${c.providerId} (${c.type})\n`);
    return 0;
  }
  if (command === "logout") {
    const saved = await runtime.listCredentials();
    for (const c of saved.filter((c) => !arg || c.providerId === arg)) {
      await runtime.logout(c.providerId);
      process.stdout.write(`Signed out of ${c.providerId}.\n`);
    }
    return 0;
  }
  const login = await import("./login.js");
  if (process.stdin.isTTY) {
    const name = await login.terminalLogin(runtime, arg);
    process.stdout.write(`Saved. Veistra's agent can use ${name} now.\n`);
    return 0;
  }
  const served = await login.browserLogin(runtime);
  process.stderr.write(`Open ${served.url} to sign in.\n`);
  login.openInBrowser(served.url);
  const name = await served.done;
  process.stderr.write(`Saved. Veistra's agent can use ${name} now.\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
