/**
 * Runs the diff: in its worker where there is one, on this thread where
 * there is not. Each call has its own worker, ended when it answers or is
 * aborted, so a version picked while a diff runs simply replaces it.
 */
import { handle } from "./diff.worker";
import type { DiffReply } from "./diff.worker";
import type { DiffResult } from "./types";

export interface CompareOutcome {
  result: DiffResult;
  parseMs: number;
  /** Where it ran, for the record: a fallback is slower and blocks the pane. */
  where: "worker" | "thread";
}

function aborted(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function unwrap(reply: DiffReply, where: CompareOutcome["where"]): CompareOutcome {
  if (!reply.ok) throw new Error(reply.error);
  return { result: reply.result, parseMs: reply.parseMs, where };
}

function startWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    // Written out in full so Vite sees it and bundles the worker.
    return new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/**
 * Diffs glb `a` against glb `b`. The bytes are copied before they are sent,
 * so the caller keeps its own for drawing the versions side by side.
 */
export async function compareGlbs(
  a: ArrayBuffer,
  b: ArrayBuffer,
  signal?: AbortSignal,
): Promise<CompareOutcome> {
  if (signal?.aborted) throw aborted();
  const worker = startWorker();
  if (!worker) {
    const reply = await handle({ a, b });
    if (signal?.aborted) throw aborted();
    return unwrap(reply, "thread");
  }
  const copies = { a: a.slice(0), b: b.slice(0) };
  return new Promise<CompareOutcome>((resolve, reject) => {
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort);
    worker.onmessage = (e: MessageEvent<DiffReply>) => {
      finish();
      if (e.data.ok) resolve(unwrap(e.data, "worker"));
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      finish();
      // A worker that cannot load (a bundling or policy failure) is not a
      // reason to show no diff; this thread can still do it, slower.
      e.preventDefault();
      void handle({ a, b }).then((reply) => {
        if (signal?.aborted) reject(aborted());
        else if (reply.ok) resolve(unwrap(reply, "thread"));
        else reject(new Error(reply.error));
      });
    };
    worker.postMessage(copies, [copies.a, copies.b]);
  });
}
