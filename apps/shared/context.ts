/**
 * What every app that hands things to an agent shares: the slice of a
 * `ContextItem` an app reads back, the agents it can hand one to and the one
 * delivery to the agent chosen, and the press handler that turns a moved
 * press into a drag of one context item onto a terminal. The store itself
 * (`context/put`, the strip beside each terminal) is the host's; see
 * `apps/README.md`, "Context: pushing things to an agent".
 */
import { invoke } from "@veistra/bridge";

/** The slice of `ContextItem` an app reads back. */
export interface ContextRef {
  id: string;
}

/**
 * The stable key for what is being sent, `blender/<blend>/<view>` or
 * `godot/<scene>/frame`. Sending the same key again replaces the earlier item
 * (same file, same strip entry) instead of adding a copy, so a key names the
 * source and never the moment. Schemes like `res://` are dropped and empty
 * parts skipped; Rust lower-cases and sanitises the rest.
 */
export function contextKey(...parts: Array<string | null | undefined>): string {
  return parts
    .map((p) =>
      (p ?? "")
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, ""),
    )
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * An agent a page can send to, as `context/agents` lists it
 * (`context_commands::AgentTarget`): a terminal typed at with `context/insert`,
 * or an agent tab given a chip by `veistra/attach-to-agent`.
 */
export interface AgentTarget {
  kind: "terminal" | "agentTab";
  /** The terminal's id, or the agent tab's instance id. */
  id: string;
  /** What a SEND TO picker shows, e.g. "Claude Code · Terminal 2". */
  label: string;
}

/** The agents in this frame's cluster, the default (X8) first; empty when none runs. */
export const listAgents = () =>
  invoke<{ agents: AgentTarget[] }>("context/agents").then((r) => r.agents ?? []);

/** Words typed on either side of the reference, so the one line is a sentence. */
export interface Around {
  before: string;
  after: string;
}

/** What handing an item to an agent came to: there, or why not. */
export type Delivery = { delivered: true } | { delivered: false; reason: string };

/**
 * Hand context item `itemId` to `target` and to nothing else (X8): a terminal
 * has its reference typed at the prompt, an agent tab gets it as a chip
 * labelled `label`, with `around` on either side in both. Neither presses
 * Enter; the person reads the line and sends it.
 */
export async function handToAgent(
  target: AgentTarget,
  itemId: string,
  label: string,
  around: Around,
): Promise<Delivery> {
  if (target.kind === "terminal") {
    const r = await invoke<{ inserted: boolean; reason?: string }>("context/insert", {
      itemIds: [itemId],
      terminal: target.id,
      ...around,
    });
    return r.inserted
      ? { delivered: true }
      : { delivered: false, reason: r.reason ?? "the terminal did not take it" };
  }
  const r = await invoke<{ delivered?: number } | null>("veistra/attach-to-agent", {
    contextId: itemId,
    label,
    instanceId: target.id,
    ...around,
  });
  return (r?.delivered ?? 0) > 0
    ? { delivered: true }
    : { delivered: false, reason: "that agent tab is no longer open" };
}

const PRESS_THRESHOLD = 4;

function tell(phase: "begin" | "end", items: string[]): void {
  void invoke("veistra/drag", { phase, items }).catch((e: unknown) => {
    console.error(`veistra: the app could not report a ${phase} drag`, e);
  });
}

let endPrevious: (() => void) | null = null;

/**
 * Press handler that turns a moved press into a drag of one context item. The
 * item is registered lazily, when the press becomes a drag, because most
 * presses are clicks and should not fill the store. Same split as Files: this
 * half reports begin and cancel; the shell owns the drop.
 */
export function dragContext(put: () => Promise<ContextRef>) {
  return (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    endPrevious?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let began = false;
    let live = true;

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || began) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < PRESS_THRESHOLD) return;
      began = true;
      void put()
        .then((item) => {
          // Released while the put was in flight: there is nothing to drag.
          if (live) tell("begin", [item.id]);
        })
        .catch((err: unknown) => console.error("veistra: the app could not add context", err));
    };
    const detach = () => {
      live = false;
      endPrevious = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const wasDrag = began;
      detach();
      if (wasDrag) tell("end", []);
    };
    endPrevious = detach;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };
}
