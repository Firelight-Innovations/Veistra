/**
 * The diff's worker (spec §12.1: "the diff runs in a Web Worker"). It parses
 * both glbs and diffs them off the main thread, so a 200,000-triangle pair
 * never stalls the pane. Each class's triangles go back as transferred
 * buffers, not copies.
 */
import { diffParts } from "./parts";
import { parseParts } from "./triangles";
import type { DiffResult } from "./types";

export interface DiffRequest {
  a: ArrayBuffer;
  b: ArrayBuffer;
}

export type DiffReply =
  { ok: true; result: DiffResult; parseMs: number } | { ok: false; error: string };

/** The worker's whole job, exported so a test and the in-thread fallback can call it. */
export async function handle(request: DiffRequest): Promise<DiffReply> {
  try {
    const started = performance.now();
    const [a, b] = await Promise.all([parseParts(request.a), parseParts(request.b)]);
    const parseMs = performance.now() - started;
    return { ok: true, result: diffParts(a, b), parseMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function transferables(reply: DiffReply): ArrayBuffer[] {
  if (!reply.ok) return [];
  return Object.values(reply.result.geometry).map((g) => g.buffer as ArrayBuffer);
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<DiffRequest>) => void) | null;
  postMessage(message: DiffReply, transfer: ArrayBuffer[]): void;
}

// Only inside a worker: importing this module anywhere else must not answer messages.
declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== "undefined") {
  const scope = self as unknown as WorkerScope;
  scope.onmessage = (e) => {
    void handle(e.data).then((reply) => scope.postMessage(reply, transferables(reply)));
  };
}
