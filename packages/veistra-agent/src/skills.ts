/**
 * Veistra's built-in skills for one session (`SkillDelivery::SessionFolder` in the host).
 *
 * The app writes the skills a session gets into a folder under its own data directory and the host
 * names that folder in `session/new` as `_meta.veistra.skills`. Pi reads each as an extra skill
 * path, for this session only: nothing is written into the user's profile or the project.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** The skill folders `session/new`'s `_meta` names, kept only when each is an absolute folder. */
export function skillPaths(meta: unknown): string[] {
  if (typeof meta !== "object" || meta === null) return [];
  const veistra = (meta as { veistra?: unknown }).veistra;
  if (typeof veistra !== "object" || veistra === null) return [];
  const list = (veistra as { skills?: unknown }).skills;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (p): p is string =>
      typeof p === "string" && path.isAbsolute(p) && existsSync(p) && statSync(p).isDirectory(),
  );
}
