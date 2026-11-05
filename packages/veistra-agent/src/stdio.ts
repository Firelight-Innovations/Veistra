/**
 * The agent on this process's standard streams. `prepare` lets a test give the model runtime a
 * scripted provider (`test/scripted-agent.mjs`); the shipped program passes nothing.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { serve } from "./agent.js";
import { agentDir, modelRuntime, version } from "./home.js";
import { Connection } from "./rpc.js";

export async function runStdio(
  prepare?: (runtime: ModelRuntime) => void | Promise<void>,
): Promise<void> {
  // Standard output is ACP's alone; anything printed through `console` goes to standard error.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const dir = agentDir();
  const runtime = await modelRuntime(dir);
  await prepare?.(runtime);
  const conn = new Connection(process.stdin, process.stdout);
  serve({ conn, runtime, agentDir: dir, version: version(), signIn: "veistra-agent login" });
  conn.onClose(() => process.exit(0));
}
