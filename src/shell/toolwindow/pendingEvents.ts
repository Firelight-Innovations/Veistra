/**
 * Events waiting on a frame that has not said hello yet, kept per instance in
 * the order they were sent.
 *
 * A new instance is often told two things at once: Play opened by
 * `veistra/open` is handed its `{ scene }` and, because it places a native
 * window, its `veistra/window-rect`. A single slot per instance kept whichever
 * came second, so Play either lost the scene or ran its game with nowhere to
 * put it.
 *
 * Every event is kept, because the shell routes app payloads without reading
 * them and cannot know that a second `OPENED_EVENT` makes the first moot. The
 * exceptions are the `latestOnly` events, which the shell writes itself and
 * which report a state: an older window rect is wrong, not merely early, and a
 * frame that never comes up would otherwise collect one per resize. A newer
 * one moves to the end, so a frame gets what it would have seen had it been
 * ready, less the reports that were overtaken.
 */

export interface PendingEvent {
  event: string;
  payload: unknown;
}

export class PendingEvents {
  private readonly byInstance = new Map<string, PendingEvent[]>();
  private readonly latestOnly: ReadonlySet<string>;

  constructor(latestOnly: Iterable<string> = []) {
    this.latestOnly = new Set(latestOnly);
  }

  add(instanceId: string, event: string, payload: unknown): void {
    let queue = this.byInstance.get(instanceId);
    if (!queue) {
      queue = [];
      this.byInstance.set(instanceId, queue);
    }
    if (this.latestOnly.has(event)) {
      const older = queue.findIndex((p) => p.event === event);
      if (older !== -1) queue.splice(older, 1);
    }
    queue.push({ event, payload });
  }

  /** Removes and answers one instance's events, oldest first. */
  take(instanceId: string): PendingEvent[] {
    const queue = this.byInstance.get(instanceId) ?? [];
    this.byInstance.delete(instanceId);
    return queue;
  }

  /** Removes and answers the events of every instance in `ready`, each oldest first. */
  takeReady(ready: ReadonlySet<string>): [string, PendingEvent[]][] {
    const out: [string, PendingEvent[]][] = [];
    for (const instanceId of [...this.byInstance.keys()]) {
      if (ready.has(instanceId)) out.push([instanceId, this.take(instanceId)]);
    }
    return out;
  }
}
