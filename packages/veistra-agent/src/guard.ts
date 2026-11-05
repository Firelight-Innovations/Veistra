/**
 * The agent's own worktree guard: a file tool may not reach outside the worktree, in any mode.
 *
 * The host checks every permission request too (`guard::escapes` in veistra-agent-host), but a
 * read never asks, so a read outside would never reach the host. This check runs first, for every
 * file tool, and fails closed: a path it cannot resolve is outside.
 *
 * A checked path is written back into the tool's input as an absolute path, so Pi opens exactly
 * the path that was checked rather than resolving the model's text a second time its own way.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pi's file tools, and the input key that names the path each touches. */
const PATH_KEYS: Record<string, string> = {
  read: "path",
  write: "path",
  edit: "path",
  ls: "path",
  grep: "path",
  find: "path",
};

/** The same spaces Pi folds to an ASCII space before it resolves a path. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** A path as Pi's tools read it: `@` dropped, `~` expanded, `file://` and MSYS drives undone. */
export function expand(input: string, home = homedir(), platform = process.platform): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(p);
    if (msys) p = `${msys[1]!.toUpperCase()}:\\${p.slice(3)}`;
  }
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) {
    return path.join(home, p.slice(2));
  }
  if (p.startsWith("file://")) return fileURLToPath(p);
  return p;
}

/** `p` with symlinks resolved, for a path whose tail may not exist yet. */
function real(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...rest);
}

function same(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class Worktree {
  readonly root: string;
  private readonly realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = real(this.root);
  }

  /** The absolute path `input` names, or `null` when it is outside the worktree. */
  resolve(input: string): string | null {
    const absolute = path.resolve(this.root, expand(input));
    let resolved: string;
    try {
      resolved = real(absolute);
    } catch {
      return null;
    }
    const relative = path.relative(this.realRoot, resolved);
    const inside =
      same(resolved, this.realRoot) ||
      (relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative));
    return inside ? absolute : null;
  }

  /**
   * Check one tool call's input, rewriting its path to the one checked. Answers why the call is
   * refused, or `null` when it may go on. Tools that name no path pass.
   */
  check(toolName: string, input: Record<string, unknown>): string | null {
    const key = PATH_KEYS[toolName];
    if (!key) return null;
    const given = input[key];
    if (given !== undefined) {
      if (typeof given !== "string") return `${toolName}: the path is not text`;
      const resolved = this.resolve(given);
      if (resolved === null) return `${given} is outside the worktree ${this.root}`;
      input[key] = resolved;
    }
    // `find` matches a glob under its folder; one that climbs out names files outside.
    if (toolName === "find" && typeof input.pattern === "string" && climbs(input.pattern)) {
      return `the pattern ${input.pattern} reaches outside the worktree`;
    }
    return null;
  }
}

/** Whether a glob could match outside the folder it starts in. */
export function climbs(pattern: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  return (
    p.startsWith("/") ||
    p.startsWith("~") ||
    /^[a-zA-Z]:/.test(p) ||
    p.split("/").some((part) => part === "..")
  );
}
