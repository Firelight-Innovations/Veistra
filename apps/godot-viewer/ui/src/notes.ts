/**
 * How many unresolved comments point at each node of the scene tree, for the
 * badge beside a row.
 *
 * Read defensively rather than by switching on `Anchor`'s kinds. The comment
 * model is growing: a take anchor that may name a node (`nodePath`), and
 * statuses between open and resolved. Narrowing on the two fields this needs
 * keeps this file compiling on either side of that change, and anything that
 * is not resolved still wants attention, so it counts.
 *
 * A node anchor carries a path and no scene, so two scenes that share a node
 * path share its count. That is the model's limit, not this function's; the
 * comment panel lists every comment in the environment for the same reason.
 */
import type { Comment } from "../../../shared/comments";

/** The fields read here, wide enough for anchors this file has not met yet. */
interface AnchorFields {
  kind: string;
  path?: unknown;
  nodePath?: unknown;
}

/** The scene-tree path a comment is pinned to, if it is pinned to one. */
function nodeOf(comment: Comment): string | null {
  const anchor: AnchorFields = comment.anchor;
  if (anchor.kind === "node" && typeof anchor.path === "string") return anchor.path;
  if (anchor.kind === "take" && typeof anchor.nodePath === "string") return anchor.nodePath;
  return null;
}

export function openNotesByNode(comments: readonly Comment[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    if (comment.status === "resolved") continue;
    const path = nodeOf(comment);
    if (path !== null) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}
