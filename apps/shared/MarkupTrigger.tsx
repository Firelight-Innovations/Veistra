/**
 * Mark up's place on the toolbar, slot 4, for a 3D view that is lazy-loaded.
 * `MarkupScene` reports how to start drawing through `onTrigger`; the app keeps
 * what it reported and renders `MarkupButton` in its toolbar's actions, so
 * Mark up sits where it does in Play and in every other surface (DECISIONS X4)
 * without the eager chunk reaching into three.js.
 */
import { PenLine } from "lucide-react";
import { ToolbarButton } from "./ViewerToolbar";

export interface MarkupTrigger {
  /** Start drawing: the view locks its camera until Done. */
  begin: () => void;
  /** The view is up and not already being drawn on. */
  ready: boolean;
  /** Why marking up is unavailable (the model is out of date); `null` when it is available. */
  disabled: string | null;
}

/** `trigger` is `null` while no 3D view is showing. */
export function MarkupButton({ trigger }: { trigger: MarkupTrigger | null }) {
  const usable = trigger !== null && trigger.ready && trigger.disabled === null;
  const title =
    trigger === null
      ? "Mark up draws on the 3D view. Show it first."
      : (trigger.disabled ?? "Draw on the view and pin notes to nodes, then send it to the agent");
  return (
    <ToolbarButton
      icon={<PenLine size={13} strokeWidth={1.5} aria-hidden="true" />}
      disabled={!usable}
      title={title}
      onClick={trigger?.begin}
    >
      Mark up
    </ToolbarButton>
  );
}
