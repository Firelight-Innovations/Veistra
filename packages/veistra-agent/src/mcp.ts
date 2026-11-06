/**
 * Veistra's MCP servers, as the host offers them in `session/new`, handed to Pi's MCP extension.
 *
 * Only these servers: the extension's default would also read `mcp.json` from the agent's home and
 * from a trusted project, and this agent reads neither. Each server's tools are `direct`, so they
 * reach the model as ordinary tools named `mcp__<server>__<tool>` and go through the same
 * permission gate as every other tool, rather than hiding inside a codemode script the gate cannot
 * see into.
 */
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

/** One entry of ACP's `mcpServers`. */
export interface AcpMcpServer {
  type?: string;
  name: string;
  url?: string;
  headers?: { name: string; value: string }[];
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
}

export interface ServerEntry {
  name: string;
  config: McpServerConfig;
  source: string;
  scope: "extension";
}

function pairs(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { name, value } = item as { name?: unknown; value?: unknown };
    if (typeof name === "string" && typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * Pi expands `${NAME}` in a value and runs one that starts with `!` as a command. The host's
 * values are literal (a bearer is URL-safe), so a server with a value Pi would expand is dropped
 * rather than passed on with a meaning the host never gave it.
 */
function literal(record: Record<string, string>): boolean {
  return Object.values(record).every((v) => !v.startsWith("!") && !v.includes("${"));
}

/** The servers in ACP's `mcpServers`, as Pi's MCP extension takes them. Malformed ones are dropped. */
export function entries(list: unknown): ServerEntry[] {
  if (!Array.isArray(list)) return [];
  const out: ServerEntry[] = [];
  for (const raw of list as AcpMcpServer[]) {
    if (typeof raw !== "object" || raw === null || typeof raw.name !== "string") continue;
    let config: McpServerConfig;
    if (typeof raw.url === "string" && (raw.type === "http" || raw.type === undefined)) {
      const headers = pairs(raw.headers);
      if (!literal(headers)) continue;
      config = { type: "http", url: raw.url, headers, exposure: "direct" };
    } else if (typeof raw.command === "string") {
      const env = pairs(raw.env);
      const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === "string") : [];
      if (!literal(env)) continue;
      config = { type: "stdio", command: raw.command, args, env, exposure: "direct" };
    } else {
      continue;
    }
    out.push({ name: raw.name, config, source: "veistra", scope: "extension" });
  }
  return out;
}
