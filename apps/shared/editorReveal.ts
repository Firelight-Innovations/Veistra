/**
 * The panes' half of mentions from the agent tab (`editorMention.ts`): what
 * each pane publishes about its running editor, and the reveal an open hands
 * it, held until the editor can act on it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { publish } from "@veistra/bridge";
import {
  EDITOR_TOPIC,
  revealOf,
  type EditorReport,
  type EditorTool,
  type Reveal,
} from "./editorMention";

/**
 * Publish what the running editor has open under its topic, each time that
 * changes and not on every poll; `null` once it is not running. The shell
 * drops a topic with the frame that published it.
 */
export function usePublishReport(tool: EditorTool, report: EditorReport | null): void {
  const key = JSON.stringify(report);
  useEffect(() => {
    publish(EDITOR_TOPIC[tool], JSON.parse(key) as EditorReport | null);
  }, [tool, key]);
}

/** A reveal waiting for its editor: numbered, so it is carried out once. */
export interface RevealRequest extends Reveal {
  n: number;
}

/**
 * The reveal the latest open asked for, and `handled`, which clears it once
 * carried out. A new open replaces one still waiting.
 */
export function useRevealRequest(tool: EditorTool) {
  const [request, setRequest] = useState<RevealRequest | null>(null);
  const count = useRef(0);
  const offer = useCallback(
    (payload: unknown): boolean => {
      const reveal = revealOf(payload, tool);
      if (!reveal) return false;
      count.current += 1;
      setRequest({ ...reveal, n: count.current });
      return true;
    },
    [tool],
  );
  const handled = useCallback((n: number) => setRequest((r) => (r?.n === n ? null : r)), []);
  return { request, offer, handled };
}

/** Names what a reveal is for, in a notice: `Enemy_02`, `levels/hallway.tscn`. */
export function revealName(r: Reveal): string {
  if (r.nodes?.length) return r.nodes.map((n) => n.slice(n.lastIndexOf("/") + 1)).join(", ");
  return r.file ?? r.scene ?? "it";
}
