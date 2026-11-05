#!/usr/bin/env node
/**
 * `veistra-agent-acp`: the agent on stdio, as the host launches it (`harness/veistra.rs`).
 * Standard output carries ACP and nothing else; see `stdio.ts`.
 */
import { checkNode, quietPi } from "./node.js";

const problem = checkNode();
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
quietPi();
const { runStdio } = await import("./stdio.js");
await runStdio();
