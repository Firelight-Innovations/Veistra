/**
 * The agent's modes, and what each lets a tool call do without asking.
 *
 * Pi has no permission prompts of its own (design §3.2), so this module is the whole of the
 * policy. Every session starts in {@link ASK_FIRST}, which the host requires
 * (`Policy::ask_first` in `crates/veistra-agent-host/src/harness/veistra.rs`). No mode acts without
 * the user and none hands approval to anything else, which is why the host holds none of them
 * back (`config::NOT_OFFERED`). The ids match Claude's adapter, so the tab's mode picker reads the
 * same for both.
 */

/** The ask-first mode: reads run, everything else asks. */
export const ASK_FIRST = "default";
export const ACCEPT_EDITS = "acceptEdits";
export const PLAN = "plan";

export interface Mode {
  id: string;
  name: string;
  description: string;
}

export const MODES: readonly Mode[] = [
  {
    id: ASK_FIRST,
    name: "Ask before edits",
    description: "Reads files in the worktree; asks before every edit, command and tool.",
  },
  {
    id: ACCEPT_EDITS,
    name: "Accept edits",
    description: "Edits files in the worktree without asking; asks before commands and tools.",
  },
  {
    id: PLAN,
    name: "Plan",
    description: "Reads and plans only; edits are refused and commands still ask.",
  },
];

export function isMode(id: string): boolean {
  return MODES.some((m) => m.id === id);
}

/** What a tool call is, for the policy and for ACP's `kind`. */
export type ToolClass = "read" | "search" | "edit" | "execute" | "other";

/** Pi's built-in tools by class. Anything else, an MCP tool included, is `other`. */
const CLASSES: Record<string, ToolClass> = {
  read: "read",
  ls: "read",
  grep: "search",
  find: "search",
  edit: "edit",
  write: "edit",
  bash: "execute",
  powershell: "execute",
};

export function classify(toolName: string): ToolClass {
  return CLASSES[toolName] ?? "other";
}

/** What happens to a call inside the worktree. Outside it is refused before this is asked. */
export type Decision = "run" | "ask" | "refuse";

export function decide(mode: string, kind: ToolClass): Decision {
  if (kind === "read" || kind === "search") return "run";
  if (kind === "edit") {
    if (mode === ACCEPT_EDITS) return "run";
    if (mode === PLAN) return "refuse";
    return "ask";
  }
  return "ask";
}
