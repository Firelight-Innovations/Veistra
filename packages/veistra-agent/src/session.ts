/**
 * One ACP session: a Pi `AgentSession` in the worktree, its events turned into `session/update`s,
 * and every tool call held at Pi's `tool_call` gate until the mode, the guard or the user lets it
 * through.
 */
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { Worktree } from "./guard.js";
import type { ServerEntry } from "./mcp.js";
import { ASK_FIRST, classify, decide, isMode, MODES } from "./modes.js";
import { toPi, VEISTRA_PROMPT } from "./prompt.js";
import { AUTH_REQUIRED, type Connection, INTERNAL_ERROR, INVALID_PARAMS, RpcError } from "./rpc.js";
import {
  type Diff,
  diffOf,
  kindOf,
  locationsOf,
  mcpOrigin,
  rawInputOf,
  resultText,
  titleOf,
} from "./tools.js";

export interface SessionInit {
  id: string;
  cwd: string;
  agentDir: string;
  runtime: ModelRuntime;
  conn: Connection;
  servers: ServerEntry[];
  skills: string[];
}

/** One `select` config option, as ACP's `configOptions` carries it. */
export interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

const MODEL_OPTION = "model";
const THINKING_OPTION = "thinking";

/** Whether an error means nobody is signed in to the model's provider. */
export function isAuthError(message: string): boolean {
  return /no api key|api key (is )?(missing|required|not)|\b401\b|unauthori[sz]ed|invalid.{0,20}(api.?key|x-api-key)|authentication|no model/i.test(
    message,
  );
}

export class VeistraSession {
  readonly id: string;
  mode = ASK_FIRST;
  private readonly conn: Connection;
  private readonly runtime: ModelRuntime;
  private readonly worktree: Worktree;
  private readonly serverNames: string[];
  private pi!: AgentSession;
  private running = false;
  private cancelled = false;
  private messageCount = 0;
  private messageId = "";
  /** Each edit's diff, read before it runs, for its approval card and its finished card. */
  private readonly diffs = new Map<string, Diff>();

  private constructor(init: SessionInit) {
    this.id = init.id;
    this.conn = init.conn;
    this.runtime = init.runtime;
    this.worktree = new Worktree(init.cwd);
    this.serverNames = init.servers.map((s) => s.name);
  }

  static async create(init: SessionInit): Promise<VeistraSession> {
    const session = new VeistraSession(init);
    await session.start(init);
    return session;
  }

  private async start(init: SessionInit): Promise<void> {
    const cwd = this.worktree.root;
    // In memory: the user's settings for this harness are the tab's, sent per session, and a
    // project's own Pi settings and extensions are never trusted, since nobody could answer.
    const settingsManager = SettingsManager.inMemory({
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: init.agentDir,
      settingsManager,
      additionalSkillPaths: init.skills,
      appendSystemPrompt: [VEISTRA_PROMPT],
      extensionFactories: [
        { name: "veistra-gate", factory: (pi: ExtensionAPI) => this.install(pi) },
        {
          name: "veistra-mcp",
          factory: createMcpExtension({
            loadConfig: () => ({ servers: init.servers, errors: [], autoEnableCodemode: false }),
            openUrl: () => undefined,
          }),
        },
      ],
    });
    await resourceLoader.reload();
    const extra = [
      "+grep",
      "+find",
      "+ls",
      ...(process.platform === "win32" ? ["+powershell"] : []),
    ];
    const { session } = await createAgentSession({
      cwd,
      agentDir: init.agentDir,
      modelRuntime: init.runtime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      tools: extra,
    });
    this.pi = session;
    this.pi.subscribe((event) => this.onEvent(event));
    // Emits `session_start`, which connects the MCP servers in the background.
    await this.pi.bindExtensions({});
  }

  dispose(): void {
    this.pi.dispose();
  }

  // --- what session/new and the setting requests answer ----------------------------------

  modes(): {
    currentModeId: string;
    availableModes: { id: string; name: string; description: string }[];
  } {
    return { currentModeId: this.mode, availableModes: MODES.map((m) => ({ ...m })) };
  }

  async configOptions(): Promise<ConfigOption[]> {
    const options: ConfigOption[] = [];
    const current = this.pi.model;
    const available = await this.runtime.getAvailable();
    const models = [...available];
    if (current && !models.some((m) => m.provider === current.provider && m.id === current.id)) {
      models.unshift(current);
    }
    if (models.length > 0) {
      options.push({
        id: MODEL_OPTION,
        name: "Model",
        category: "model",
        type: "select",
        currentValue: current ? `${current.provider}/${current.id}` : "",
        options: models.map((m) => ({
          value: `${m.provider}/${m.id}`,
          name: m.name || m.id,
          description: this.runtime.getProvider(m.provider)?.name ?? m.provider,
        })),
      });
    }
    if (this.pi.supportsThinking()) {
      options.push({
        id: THINKING_OPTION,
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: this.pi.thinkingLevel,
        options: this.pi
          .getAvailableThinkingLevels()
          .map((level) => ({ value: level, name: level })),
      });
    }
    return options;
  }

  /** Each skill as a slash command, `skill:<name>`, which is how Pi invokes one by name. */
  commands(): { name: string; description: string; input: { hint: string } }[] {
    return this.pi.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      input: { hint: "what to do with it" },
    }));
  }

  setMode(modeId: string): void {
    if (!isMode(modeId)) throw new RpcError(INVALID_PARAMS, `no mode ${modeId}`);
    this.mode = modeId;
    this.update({ sessionUpdate: "current_mode_update", currentModeId: modeId });
  }

  async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
    if (configId === MODEL_OPTION) {
      const slash = value.indexOf("/");
      const model =
        slash > 0
          ? this.runtime.getModel(value.slice(0, slash), value.slice(slash + 1))
          : undefined;
      if (!model) throw new RpcError(INVALID_PARAMS, `no model ${value}`);
      await this.pi.setModel(model);
    } else if (configId === THINKING_OPTION) {
      const level = this.pi.getAvailableThinkingLevels().find((l) => l === value);
      if (!level) throw new RpcError(INVALID_PARAMS, `no thinking level ${value}`);
      this.pi.setThinkingLevel(level);
    } else {
      throw new RpcError(INVALID_PARAMS, `no option ${configId}`);
    }
    return this.configOptions();
  }

  // --- a turn ------------------------------------------------------------------------------

  async prompt(blocks: unknown): Promise<{ stopReason: string }> {
    if (this.running) throw new RpcError(INVALID_PARAMS, "a turn is already running");
    const { text, images } = toPi(blocks);
    this.running = true;
    this.cancelled = false;
    try {
      // The tab runs its own slash commands. Only a skill it was offered (`commands`) expands;
      // any other leading slash is the user's text, never a Pi command or template.
      await this.pi.prompt(text, { images, expandPromptTemplates: text.startsWith("/skill:") });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new RpcError(isAuthError(message) ? AUTH_REQUIRED : INTERNAL_ERROR, message);
    } finally {
      this.running = false;
    }
    if (this.cancelled) return { stopReason: "cancelled" };
    const last = this.lastAssistant();
    if (last?.stopReason === "error") {
      const message = last.errorMessage ?? "the model request failed";
      throw new RpcError(isAuthError(message) ? AUTH_REQUIRED : INTERNAL_ERROR, message);
    }
    if (last?.stopReason === "aborted") return { stopReason: "cancelled" };
    if (last?.stopReason === "length") return { stopReason: "max_tokens" };
    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    await this.pi.abort();
  }

  private lastAssistant(): { stopReason?: string; errorMessage?: string } | undefined {
    for (let i = this.pi.messages.length - 1; i >= 0; i--) {
      const m = this.pi.messages[i] as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (m.role === "assistant") return m;
    }
    return undefined;
  }

  // --- the gate ----------------------------------------------------------------------------

  private install(pi: ExtensionAPI): void {
    pi.on("tool_call", (event) => this.gate(event));
  }

  /** Decide one tool call. Throwing blocks it too: Pi fails closed on a handler error. */
  private async gate(
    event: ToolCallEvent,
  ): Promise<{ block: true; reason: string; terminate?: boolean } | undefined> {
    const input = event.input as Record<string, unknown>;
    const outside = this.worktree.check(event.toolName, input);
    if (outside) return { block: true, reason: `Refused: ${outside}.` };
    const diff = diffOf(this.worktree.root, event.toolName, input);
    if (diff) this.diffs.set(event.toolCallId, diff);
    const decision = decide(this.mode, classify(event.toolName));
    if (decision === "refuse") {
      return {
        block: true,
        reason:
          "Refused: the session is in Plan mode, which makes no edits. Describe the change instead, or ask the user to switch modes.",
      };
    }
    if (decision === "ask" && !(await this.ask(event, input))) {
      return { block: true, reason: "The user declined this tool call.", terminate: true };
    }
    this.update({
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      rawInput: rawInputOf(this.worktree.root, event.toolName, input),
      locations: locationsOf(this.worktree.root, input),
    });
    return undefined;
  }

  /** Ask the user through the host. Anything but a chosen allow option is a no. */
  private async ask(event: ToolCallEvent, input: Record<string, unknown>): Promise<boolean> {
    const diff = this.diffs.get(event.toolCallId);
    const answer = (await this.conn.request("session/request_permission", {
      sessionId: this.id,
      toolCall: {
        ...this.describe(event.toolCallId, event.toolName, input),
        status: "pending",
        ...(diff ? { content: [diff] } : {}),
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    })) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
    return answer?.outcome?.outcome === "selected" && answer.outcome.optionId === "allow";
  }

  // --- Pi's events, as ACP updates ---------------------------------------------------------

  private describe(toolCallId: string, toolName: string, input: Record<string, unknown>) {
    const root = this.worktree.root;
    const origin = mcpOrigin(toolName, this.serverNames);
    return {
      toolCallId,
      title: titleOf(root, toolName, input),
      kind: kindOf(toolName),
      rawInput: rawInputOf(root, toolName, input),
      locations: locationsOf(root, input),
      // The host tells a show call by this, which only this agent writes, never by the title.
      _meta: {
        veistra: { toolName, ...(origin ? { server: origin.server, tool: origin.tool } : {}) },
      },
    };
  }

  private update(update: Record<string, unknown>): void {
    this.conn.notify("session/update", { sessionId: this.id, update });
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if ((event.message as { role?: string }).role === "assistant") {
          this.messageId = `${this.id}-m${++this.messageCount}`;
        }
        break;
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta" || e.type === "thinking_delta") {
          this.update({
            sessionUpdate: e.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
            messageId: this.messageId,
            content: { type: "text", text: e.delta },
          });
        }
        break;
      }
      case "message_end":
        if ((event.message as { role?: string }).role === "assistant") this.usage();
        break;
      case "tool_execution_start":
        this.update({
          sessionUpdate: "tool_call",
          ...this.describe(
            event.toolCallId,
            event.toolName,
            (event.args ?? {}) as Record<string, unknown>,
          ),
          status: "pending",
        });
        break;
      case "tool_execution_update": {
        const partial = (event.partialResult as { content?: unknown } | undefined)?.content;
        const text = resultText(partial, 8_000);
        if (text) {
          this.update({
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text } }],
          });
        }
        break;
      }
      case "tool_execution_end":
        this.finished(event.toolCallId, event.result, event.isError);
        break;
      case "session_info_changed":
        if (event.name) this.update({ sessionUpdate: "session_info_update", title: event.name });
        break;
      default:
        break;
    }
  }

  private finished(toolCallId: string, result: unknown, isError: boolean): void {
    const content: unknown[] = [];
    const text = resultText((result as { content?: unknown } | undefined)?.content);
    if (text) content.push({ type: "content", content: { type: "text", text } });
    const diff = this.diffs.get(toolCallId);
    this.diffs.delete(toolCallId);
    if (diff && !isError) content.push(diff);
    this.update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: isError ? "failed" : "completed",
      content,
      rawOutput: (result as { content?: unknown } | undefined)?.content ?? null,
    });
  }

  private usage(): void {
    const usage = this.pi.getContextUsage();
    if (usage?.tokens != null) {
      this.update({ sessionUpdate: "usage_update", used: usage.tokens, size: usage.contextWindow });
    }
  }
}
