/**
 * The relay for `comments:changed` (`comment_events.rs`): a comment was written
 * somewhere, and the app frames showing that environment should list again.
 *
 * Rust broadcasts to every window and names the clusters on that environment
 * (two can share a checkout). A window passes it to its app frames only when
 * the cluster it is showing is one of them, the same rule the `project:changed`
 * relay keeps: every mounted frame is in the shown cluster by construction, and
 * a frame in another environment re-listing for nothing is the cheap failure
 * next to one told about comments that are not its own.
 */
import type { EventMessage } from "@veistra/bridge/protocol";
import { COMMENTS_CHANGED_EVENT, onCommentsChanged } from "../../bindings";

interface Frame {
  isApp: boolean;
  origin: string | null;
}

/** Whether a `comments:changed` payload concerns the cluster this window shows. */
export function commentsChangeConcerns(payload: unknown, showing: string | null): boolean {
  if (showing === null || typeof payload !== "object" || payload === null) return false;
  const { clusters, clusterId } = payload as { clusters?: unknown; clusterId?: unknown };
  return (Array.isArray(clusters) && clusters.includes(showing)) || clusterId === showing;
}

/** The app frames to tell, each at the origin it said hello from. */
export function commentFrames<W>(
  frames: Iterable<[W, Frame]>,
  payload: unknown,
  showing: string | null,
): [W, string][] {
  if (!commentsChangeConcerns(payload, showing)) return [];
  const found: [W, string][] = [];
  for (const [win, frame] of frames) {
    if (frame.isApp && frame.origin !== null) found.push([win, frame.origin]);
  }
  return found;
}

/**
 * Listen for comment changes and post each to the frames `commentFrames` picks,
 * reading the frame map and the shown cluster at delivery time, so one listener
 * serves every cluster switch. Answers the cleanup, safe to call before Tauri
 * has finished registering the listener.
 */
export function relayCommentChanges(
  frames: () => Iterable<[Window, Frame]>,
  showing: () => string | null,
): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  void onCommentsChanged((payload) => {
    if (!live) return;
    const message: EventMessage = {
      veistra: 1,
      kind: "event",
      event: COMMENTS_CHANGED_EVENT,
      payload,
    };
    for (const [win, origin] of commentFrames(frames(), payload, showing())) {
      win.postMessage(message, origin);
    }
  })
    .then((stop) => {
      if (live) unlisten = stop;
      else stop();
    })
    .catch((err: unknown) => console.error("veistra: could not relay comment changes:", err));
  return () => {
    live = false;
    unlisten?.();
  };
}
