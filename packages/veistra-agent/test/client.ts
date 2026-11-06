/**
 * A minimal ACP client for the end-to-end tests: starts the scripted agent, sends requests, and
 * answers its permission requests the way a test says.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTED = path.join(here, "..", "scripts", "scripted-agent.mjs");
export const ACP = path.join(here, "..", "dist", "acp.js");

export type Block = { text: string } | { thinking: string } | { tool: string; args: object };

/** One model request: its blocks, or `"echo"` to answer with what the model was sent. */
export type Step = Block[] | "echo";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A folder for one test, with symlinks resolved so paths compare as the agent reports them. */
export function scratch(prefix = "veistra-agent-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** An environment that carries no provider credential of the machine running the tests. */
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    VEISTRA_AGENT_DIR: path.join(home, "agent"),
    ...extra,
  };
}

export class Client {
  readonly updates: Record<string, unknown>[] = [];
  readonly permissions: Record<string, unknown>[] = [];
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, (m: Message) => void>();
  private next = 1;
  /**
   * How the next permission request is answered: an option id, `null` to cancel it, or `"hold"`
   * to leave it open until {@link Client.release}, as a person who has not decided yet does.
   */
  answer: string | null = "allow";
  private held: number | string | undefined;
  stderr = "";

  constructor(script: Step[] | null, home = scratch()) {
    const env = cleanEnv(home);
    let program = ACP;
    if (script) {
      const file = path.join(home, "script.json");
      writeFileSync(file, JSON.stringify(script));
      env.VEISTRA_AGENT_SCRIPT = file;
      program = SCRIPTED;
    }
    this.child = spawn(process.execPath, [program], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr!.on("data", (d: Buffer) => (this.stderr += d.toString()));
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.receive(line));
  }

  private receive(line: string): void {
    const message = JSON.parse(line) as Message;
    if (message.method === "session/update") {
      this.updates.push(message.params!.update as Record<string, unknown>);
    } else if (message.method === "session/request_permission") {
      this.permissions.push(message.params!);
      if (this.answer === "hold") {
        this.held = message.id;
        return;
      }
      const outcome =
        this.answer === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId: this.answer };
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome } });
    } else if (message.id !== undefined && !message.method) {
      this.waiting.get(Number(message.id))?.(message);
    }
  }

  /** Close a held permission request as cancelled, as the host does when a turn is stopped. */
  release(): void {
    if (this.held === undefined) return;
    this.write({ jsonrpc: "2.0", id: this.held, result: { outcome: { outcome: "cancelled" } } });
    this.held = undefined;
  }

  private write(message: object): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  /** Send a request; resolves with its result, or rejects with its error. */
  request(method: string, params: object): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => {
        if (m.error) reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else resolve(m.result ?? {});
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: object): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** `initialize`, `session/new` in `cwd`, then the scripted model. Answers the session id. */
  async open(cwd: string, extra: object = {}): Promise<string> {
    await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await this.request("session/new", { cwd, mcpServers: [], ...extra });
    const sessionId = created.sessionId as string;
    await this.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: "scripted/scripted-1",
    });
    return sessionId;
  }

  /** The text of every agent message chunk so far. */
  text(): string {
    return this.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content as { text: string }).text)
      .join("");
  }

  /** The last update for one tool call. */
  lastFor(toolCallId: string): Record<string, unknown> | undefined {
    return [...this.updates].reverse().find((u) => u.toolCallId === toolCallId);
  }

  close(): void {
    this.child.stdin!.end();
    this.child.kill();
  }
}
