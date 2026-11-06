/**
 * JSON-RPC 2.0 over newline-delimited JSON, the framing ACP uses on stdio.
 *
 * Written here rather than taken from `@agentclientprotocol/sdk` on purpose: the agent needs six
 * requests and one notification, the host's own client is the same few hundred lines in Rust
 * (`crates/veistra-agent-host/src/wire.rs`), and the SDK's 2.x API keeps session config options
 * behind its unstable entry point. A request is handled while others are in flight, because a
 * `session/prompt` stays open for the whole turn while `session/cancel` and permission answers
 * arrive.
 */
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

/** JSON-RPC's own codes, and ACP's `authRequired`. */
export const PARSE_ERROR = -32700;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const AUTH_REQUIRED = -32000;

/** An error a handler throws to answer with a specific code. */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Id = number | string;

interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export type RequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

/** One peer on one pair of streams. */
export class Connection {
  private readonly output: Writable;
  private readonly requests = new Map<string, RequestHandler>();
  private readonly notifications = new Map<string, NotificationHandler>();
  private readonly pending = new Map<Id, (message: Message) => void>();
  private nextId = 0;
  private closedFlag = false;
  private readonly closeListeners: (() => void)[] = [];

  constructor(input: Readable, output: Writable) {
    this.output = output;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    lines.on("close", () => this.close());
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler);
  }

  /** Called once, when the input ends. */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ask the peer, and wait for its answer. Rejects with an {@link RpcError} it sent back. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closedFlag) return Promise.reject(new RpcError(INTERNAL_ERROR, "connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) reject(new RpcError(message.error.code, message.error.message));
        else resolve(message.result);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.write({
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "parse error" },
      });
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (message.method === undefined) {
      if (message.id === undefined || message.id === null) return;
      const answer = this.pending.get(message.id);
      this.pending.delete(message.id);
      answer?.(message);
      return;
    }
    if (message.id === undefined || message.id === null) {
      this.notifications.get(message.method)?.(message.params);
      return;
    }
    void this.answer(message.id, message.method, message.params);
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    const handler = this.requests.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: method } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : INTERNAL_ERROR;
      const message = e instanceof Error ? e.message : String(e);
      this.write({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  private write(message: Message): void {
    if (this.closedFlag) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const answer of this.pending.values()) {
      answer({ error: { code: INTERNAL_ERROR, message: "connection closed" } });
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
