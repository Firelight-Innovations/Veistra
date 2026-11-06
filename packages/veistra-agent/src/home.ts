/**
 * The agent's home: its own folder, never Pi's `~/.pi/agent`, so a person's personal Pi setup and
 * this harness never read each other's keys, settings or extensions. `VEISTRA_AGENT_DIR` moves it,
 * for tests and for anyone who keeps tools elsewhere.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.VEISTRA_AGENT_DIR;
  return set && path.isAbsolute(set) ? set : path.join(homedir(), ".veistra", "agent");
}

/** The model runtime over the home's `auth.json` and `models.json`. */
export function modelRuntime(dir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
}

/** This package's version, which `initialize` reports and the host pins. */
export function version(): string {
  const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
