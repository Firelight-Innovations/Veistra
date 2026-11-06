/**
 * The ACP agent: `initialize`, `session/new`, the setting requests, `session/prompt` and
 * `session/cancel`, each handed to the {@link VeistraSession} it names.
 *
 * `session/new` refuses with ACP's `authRequired` when no model provider has a credential, as a
 * signed-out Codex does, so the tab shows its sign-in hint (`Hint::SignedOut`) before any prompt.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { entries } from "./mcp.js";
import { AUTH_REQUIRED, type Connection, INVALID_PARAMS, RpcError } from "./rpc.js";
import { VeistraSession } from "./session.js";
import { skillPaths } from "./skills.js";

/** ACP's protocol version this agent speaks. */
export const PROTOCOL_VERSION = 1;

export interface AgentOptions {
  conn: Connection;
  runtime: ModelRuntime;
  agentDir: string;
  version: string;
  /** What `authRequired` tells the user to run. */
  signIn: string;
}

function record(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null) {
    throw new RpcError(INVALID_PARAMS, "params must be an object");
  }
  return params as Record<string, unknown>;
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new RpcError(INVALID_PARAMS, `${key} must be a string`);
  return value;
}

export function serve(options: AgentOptions): void {
  const { conn, runtime, agentDir } = options;
  const sessions = new Map<string, VeistraSession>();
  const find = (params: Record<string, unknown>): VeistraSession => {
    const session = sessions.get(str(params, "sessionId"));
    if (!session) throw new RpcError(INVALID_PARAMS, "no such session");
    return session;
  };

  conn.onRequest("initialize", async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
    },
    agentInfo: { name: "veistra-agent", title: "Veistra", version: options.version },
    authMethods: [
      {
        id: "veistra-agent-login",
        name: "Sign in",
        description: `Run \`${options.signIn}\` to save a model provider's API key.`,
      },
    ],
  }));

  conn.onRequest("authenticate", async () => {
    throw new RpcError(AUTH_REQUIRED, `Run \`${options.signIn}\` in a terminal to sign in.`);
  });

  conn.onRequest("session/new", async (raw) => {
    const params = record(raw);
    const cwd = str(params, "cwd");
    if (!path.isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new RpcError(INVALID_PARAMS, "cwd must be an absolute path to a folder");
    }
    if ((await runtime.getAvailable()).length === 0) {
      throw new RpcError(
        AUTH_REQUIRED,
        `No model provider is signed in. Run \`${options.signIn}\`, or set a provider's API key in your environment.`,
      );
    }
    const id = randomUUID();
    const session = await VeistraSession.create({
      id,
      cwd,
      agentDir,
      runtime,
      conn,
      servers: entries(params.mcpServers),
      skills: skillPaths(params._meta),
    });
    sessions.set(id, session);
    // After the reply, so the client knows the session the update names.
    setImmediate(() =>
      conn.notify("session/update", {
        sessionId: id,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: session.commands(),
        },
      }),
    );
    return { sessionId: id, modes: session.modes(), configOptions: await session.configOptions() };
  });

  conn.onRequest("session/set_mode", async (raw) => {
    const params = record(raw);
    find(params).setMode(str(params, "modeId"));
    return {};
  });

  conn.onRequest("session/set_config_option", async (raw) => {
    const params = record(raw);
    const configOptions = await find(params).setConfigOption(
      str(params, "configId"),
      str(params, "value"),
    );
    return { configOptions };
  });

  conn.onRequest("session/prompt", async (raw) => {
    const params = record(raw);
    return find(params).prompt(params.prompt);
  });

  conn.onNotification("session/cancel", (raw) => {
    const id =
      typeof raw === "object" && raw !== null ? (raw as { sessionId?: unknown }).sessionId : null;
    if (typeof id === "string") void sessions.get(id)?.cancel();
  });

  conn.onClose(() => {
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  });
}
