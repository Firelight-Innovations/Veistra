/**
 * Play as a context provider: the captured frame and the log tail, sent to the
 * agent working in this environment. The store and the strip beside each
 * terminal are the host's (`context/put`); this file decides what each thing is
 * called and what it becomes, so the buttons and the drag share one path.
 */
import { invoke } from "@veistra/bridge";
import { formatPlayTime, takeHistory, type Comment } from "../../../../shared/comments";
import { contextKey, type ContextRef } from "../../../../shared/context";
import { noteName } from "./notes";
import type { Capture, LogLine } from "./rpc";

export { dragContext } from "../../../../shared/context";

/** Lines of the log an agent gets; enough for a stack trace, not a session. */
export const LOG_TAIL = 300;

const TAGS = { info: "", warning: "[warning] ", error: "[error] " } as const;

/** The log tail as the plain text an agent reads, with levels spelled out. */
export function logText(lines: LogLine[], scene: string | null, tail = LOG_TAIL): string {
  const kept = lines.slice(-tail);
  const head = `Godot output${scene ? ` for ${scene}` : ""} (last ${kept.length} of ${lines.length} lines)`;
  return [head, ...kept.map((l) => `${TAGS[l.level]}${l.text}`)].join("\n");
}

function leaf(scene: string): string {
  return scene.slice(scene.lastIndexOf("/") + 1) || scene;
}

export function putShot(shot: Capture) {
  const scene = shot.scene || "the running scene";
  return invoke<ContextRef>("context/put", {
    key: contextKey("play", scene, "frame"),
    kind: "panel",
    title: `Play - ${scene} at ${formatPlayTime(shot.time)}`,
    label: `Play - ${leaf(scene)} ${formatPlayTime(shot.time)}`,
    bytesBase64: shot.png,
  });
}

export function putLog(lines: LogLine[], scene: string | null) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("play", scene ?? "game", "log"),
    kind: "text",
    title: `Play - output${scene ? ` of ${leaf(scene)}` : ""}`,
    label: "Play - game output",
    text: logText(lines, scene),
  });
}

/**
 * Still broken where Record cannot run (#321): there is no new take to send,
 * so the agent that had the note gets the person's words, the fix they
 * checked and the packet it worked from, as one text item. `comment` is the
 * note as it stood before the verdict, with the agent's fix still on it.
 */
export function stillBrokenText(
  comment: Comment,
  reply: string | undefined,
  blocked: string,
): string {
  const first = takeHistory(comment)[0];
  const fix = comment.resolution;
  return [
    `Still broken after your fix: ${first ? noteName(first) : "a note"}. ${comment.body}`,
    reply ? `They said: ${reply}` : "",
    fix ? `Your fix: ${fix.note}${fix.commit ? ` (commit ${fix.commit})` : ""}` : "",
    first ? `The packet you worked from: ${first.packet}/packet.md` : "",
    `No new take was recorded: ${blocked}`,
    `The note is ${comment.id}; list_play_notes has its history.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function putStillBroken(comment: Comment, reply: string | undefined, blocked: string) {
  return invoke<ContextRef>("context/put", {
    key: contextKey("play", comment.id, "still-broken"),
    kind: "text",
    title: "Play - still broken after your fix",
    label: "Play - still broken",
    text: stillBrokenText(comment, reply, blocked),
  });
}
