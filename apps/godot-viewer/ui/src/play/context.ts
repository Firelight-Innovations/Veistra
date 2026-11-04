/**
 * Play as a context provider: the captured frame and the log tail, sent to the
 * agent working in this environment. The store and the strip beside each
 * terminal are the host's (`context/put`); this file decides what each thing is
 * called and what it becomes, so the buttons and the drag share one path.
 */
import { invoke } from "@veistra/bridge";
import { formatPlayTime } from "../../../../shared/comments";
import { contextKey, type ContextRef } from "../../../../shared/context";
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
