/**
 * How a Pi tool call reads as an ACP `tool_call`: its title, kind, locations and, for an edit,
 * the diff it would make. The host's normalizer (`normalize.rs`) draws these as the tab's tool
 * and approval cards, and its guard reads the same `rawInput` and `locations`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { classify } from "./modes.js";

/** The ACP tool kinds this agent reports. */
export type AcpToolKind = "read" | "edit" | "search" | "execute" | "fetch" | "other";

export interface Diff {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

const TITLE_LIMIT = 160;

function short(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

/** The path a file tool names, relative to the worktree for the title. */
function shown(root: string, input: Record<string, unknown>): string {
  const p = text(input, "path");
  if (!p) return ".";
  const rel = path.relative(root, path.resolve(root, p));
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

export function kindOf(toolName: string): AcpToolKind {
  const kind = classify(toolName);
  return kind === "other" ? "other" : kind;
}

export function titleOf(root: string, toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "read":
      return `Read ${shown(root, input)}`;
    case "write":
      return `Write ${shown(root, input)}`;
    case "edit":
      return `Edit ${shown(root, input)}`;
    case "ls":
      return `List ${shown(root, input)}`;
    case "grep":
      return short(`Search for ${JSON.stringify(text(input, "pattern"))} in ${shown(root, input)}`);
    case "find":
      return short(`Find ${text(input, "pattern")} in ${shown(root, input)}`);
    case "bash":
    case "powershell":
      return short(text(input, "command")) || toolName;
    default:
      return toolName;
  }
}

/** The files a call names, for the tab to open and the host's guard to check. */
export function locationsOf(root: string, input: Record<string, unknown>): { path: string }[] {
  const p = text(input, "path");
  return p ? [{ path: path.resolve(root, p) }] : [];
}

/**
 * What the host's guard and approval card read: the tool's own input, plus where a command runs.
 */
export function rawInputOf(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const kind = classify(toolName);
  return kind === "execute" ? { ...input, cwd: root } : { ...input };
}

function readOr(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The change an `edit` or `write` would make, read from the file as it is now. `null` when the
 * call is neither, or an edit's text is not in the file (Pi will report that error itself).
 */
export function diffOf(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): Diff | null {
  const p = text(input, "path");
  if (!p) return null;
  const file = path.resolve(root, p);
  if (toolName === "write") {
    return { type: "diff", path: file, oldText: readOr(file), newText: text(input, "content") };
  }
  if (toolName !== "edit") return null;
  const before = readOr(file);
  if (before === null) return null;
  let after = before.replace(/^\uFEFF/, "");
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  for (const edit of edits) {
    if (typeof edit !== "object" || edit === null) return null;
    const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
    if (typeof oldText !== "string" || typeof newText !== "string") return null;
    const at = after.indexOf(oldText);
    if (at < 0) return null;
    after = after.slice(0, at) + newText + after.slice(at + oldText.length);
  }
  return { type: "diff", path: file, oldText: before, newText: after };
}

/** Pi's result content as one text, cut from the front so the end of long output survives. */
export function resultText(content: unknown, limit = 16_000): string {
  if (!Array.isArray(content)) return "";
  const out = content
    .map((block: unknown) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return out.length > limit ? `…${out.slice(out.length - limit)}` : out;
}

/** An MCP server's name as Pi spells it inside a tool name. */
export function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Which configured MCP server and tool a Pi tool name (`mcp__<server>__<tool>`) is, by the names
 * the host gave. The host trusts this, not the title, to tell a `veistra-context` show call.
 */
export function mcpOrigin(
  toolName: string,
  servers: readonly string[],
): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  for (const server of servers) {
    const prefix = `${sanitize(server)}__`;
    if (rest.startsWith(prefix)) return { server, tool: rest.slice(prefix.length) };
  }
  return null;
}
