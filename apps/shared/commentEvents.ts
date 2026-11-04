/**
 * Hearing that a comment changed, for every pane that lists comments: the
 * Godot app (Editor and Play), the Blender Viewer, and Play's review.
 *
 * Every write to the comment store (`src-tauri/src/comments.rs`) is announced
 * as `comments:changed`, and the shell relays it into the app frames of the
 * clusters on that environment (`src/shell/toolwindow/commentFrames.ts`). That
 * is how an agent's `resolve_play_note`, made over MCP with no frame involved,
 * turns a card to "Fixed, check it" in a pane that is already open. Each app
 * makes one call, {@link useCommentsChanged}, and lists again; a poll, where a
 * pane keeps one, is only the fallback.
 *
 * Coalesced: Send files one comment per note in a burst, and one re-list
 * answers them all.
 */
import { useEffect, useRef } from "react";
import { on } from "@veistra/bridge";
import type { Status } from "./comments";

/** Mirrors `comment_events::CHANGED_EVENT`. */
export const COMMENTS_CHANGED = "comments:changed";

/** How long a burst of changes is gathered before the callback runs once. */
export const COALESCE_MS = 100;

/** One write, as the push describes it. Says which comment, never what it says. */
export interface CommentsChange {
  id: string;
  /** The anchor's kind: `node`, `mesh`, `scene` or `take`. */
  kind: string;
  /** The take id, for a note on a take. */
  take: string | null;
  status: Status;
  /** The status before; `null` for a new comment. */
  from: Status | null;
}

const STATUSES: readonly string[] = ["open", "working", "fixed", "resolved"];

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && STATUSES.includes(value);
}

/** The change a payload describes, or `null` for one this build cannot read. */
export function readChange(payload: unknown): CommentsChange | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, kind, take, status, from } = payload as Record<string, unknown>;
  if (typeof id !== "string" || !isStatus(status)) return null;
  return {
    id,
    kind: typeof kind === "string" ? kind : "",
    take: typeof take === "string" ? take : null,
    status,
    from: isStatus(from) ? from : null,
  };
}

/**
 * Call `cb` with the changes heard, once per burst: `waitMs` after the first
 * of them. Answers the unsubscribe, which also drops a burst still waiting.
 */
export function onCommentsChanged(
  cb: (changes: CommentsChange[]) => void,
  waitMs = COALESCE_MS,
): () => void {
  let pending: CommentsChange[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = on(COMMENTS_CHANGED, (payload) => {
    const change = readChange(payload);
    if (!change) return;
    pending.push(change);
    timer ??= setTimeout(() => {
      timer = null;
      const burst = pending;
      pending = [];
      cb(burst);
    }, waitMs);
  });
  return () => {
    stop();
    if (timer !== null) clearTimeout(timer);
    pending = [];
  };
}

/**
 * {@link onCommentsChanged} for a component's lifetime. `refresh` may be a new
 * function every render: the latest one is called, and the subscription stays
 * the same one throughout.
 */
export function useCommentsChanged(refresh: (changes: CommentsChange[]) => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => onCommentsChanged((changes) => latest.current(changes)), []);
}
