/** Unresolved comments per scene-tree node, for the badge beside each row. */
import { describe, expect, it } from "vitest";
import type { Comment } from "../../../shared/comments";
import { openNotesByNode } from "./notes";

let next = 0;

/** Built loosely on purpose: anchors and statuses the model does not name yet must count. */
function comment(anchor: object, status = "open"): Comment {
  next += 1;
  return {
    id: `c${next}`,
    anchor,
    author: "user",
    body: "",
    status,
    created: 1,
    updated: 1,
  } as unknown as Comment;
}

describe("openNotesByNode", () => {
  it("counts the open comments on each node path", () => {
    const counts = openNotesByNode([
      comment({ kind: "node", path: "World/Player" }),
      comment({ kind: "node", path: "World/Player" }),
      comment({ kind: "node", path: "World" }),
    ]);
    expect(counts.get("World/Player")).toBe(2);
    expect(counts.get("World")).toBe(1);
  });

  it("leaves resolved comments out, and counts every other status", () => {
    const counts = openNotesByNode([
      comment({ kind: "node", path: "World" }, "resolved"),
      comment({ kind: "node", path: "World" }, "working"),
      comment({ kind: "node", path: "World" }, "fixed"),
    ]);
    expect(counts.get("World")).toBe(2);
  });

  it("counts a take that names a node, and nothing that names none", () => {
    const counts = openNotesByNode([
      comment({ kind: "take", take: "t1", nodePath: "World/Player" }),
      comment({ kind: "take", take: "t2" }),
      comment({ kind: "mesh", part: "World/Player", material: "none" }),
      comment({ kind: "scene", scene: "res://main.tscn", time: 1, screenshot: false }),
    ]);
    expect([...counts]).toEqual([["World/Player", 1]]);
  });
});
