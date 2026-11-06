import type { BlenderViewerState } from "./rpc";

/**
 * Which .blend the viewer should treat as selected after a poll. The host
 * answers with the file it actually resolved; when the project changed under
 * an open viewer that differs from what was asked for, and the old choice must
 * go rather than be re-sent on every poll.
 */
export function reconcileBlend(
  current: string | null,
  next: Pick<BlenderViewerState, "blend">,
): string | null {
  if (current === null) return next.blend;
  return next.blend === current ? current : next.blend;
}

/** True when a poll replaced the file the viewer had asked for. */
export function selectionWasDropped(
  current: string | null,
  next: Pick<BlenderViewerState, "blend">,
): boolean {
  return current !== null && next.blend !== current;
}

/** The file off an open's `{ blend }` payload, else `null`. */
export function openedBlend(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { blend } = payload as { blend?: unknown };
  return typeof blend === "string" && blend !== "" ? blend : null;
}
