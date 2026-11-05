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
  title?: string;
  source?: { label?: string | null };
  /** The item's file, absolute, as `context/put` answers. */
  path?: string;
  /**
   * Items this one names in its prompt and carries with it (`putWithAttached`):
   * the agent tab gets one chip, and a terminal, which cannot read a prompt,
   * has each one's reference typed after this one's. Set here, never stored.
   */
  attached?: ContextRef[];
  /**
   * The glyph and colour the agent tab draws this item's chip in, such as
   * `godot-node`; unset, a plain context chip. Set here, never stored.
   */
  chipKind?: string;
}

/** An item another carries by reference, and what it is in a sentence ("the viewport picture"). */
export interface Attachment {
  item: ContextRef;
  what: string;
}

/** Where the agent finds an attached item: its file, else its context reference. */
export function attachedAt(item: ContextRef): string {
  return item.path || `veistra://context/${item.id}`;
}

/** `prompt`, then a sentence for each attachment naming where it is, so the agent opens it. */
export function attachedPrompt(prompt: string, attached: readonly Attachment[]): string {
  const said = attached.map(
    ({ item, what }) =>
      `${what.charAt(0).toUpperCase()}${what.slice(1)} is at ${attachedAt(item)}; open it.`,
  );
  return [prompt, ...said].join(" ");
}

/**
 * Put one item that carries others: they are stored already, and its prompt
 * names each by its file, so a Send makes one chip and the agent still reads
 * them all. Answers the item with `attached` set for `chipToAgent`.
 */
export async function putWithAttached(
  params: Record<string, unknown> & { prompt: string },
  attached: readonly Attachment[],
): Promise<ContextRef> {
  const item = await invoke<ContextRef>("context/put", {
    ...params,
    prompt: attachedPrompt(params.prompt, attached),
  });
  return { ...item, attached: attached.map((a) => a.item) };
}

/** What an item's chip says: its strip label ("Play - game output"), else its title. */
export function chipLabel(item: ContextRef): string {
  return item.source?.label || item.title || "Context";
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

/** What handing an item to an agent came to: there, or why not. */
export type Delivery = { delivered: true } | { delivered: false; reason: string };

/** The ids a terminal is given for `item`: its own, then each it carries. */
const idsOf = (item: ContextRef) => [item.id, ...(item.attached ?? []).map((a) => a.id)];

/** References typed at a terminal's prompt: `terminal` unset is the cluster's first agent. */
async function typeAt(itemIds: string[], terminal?: string): Promise<Delivery> {
  const r = await invoke<{ inserted?: boolean; reason?: string } | null>("context/insert", {
    itemIds,
    ...(terminal === undefined ? {} : { terminal }),
  });
  return r?.inserted
    ? { delivered: true }
    : { delivered: false, reason: r?.reason ?? "no agent is running here" };
}

/**
 * Hand context item `itemId` to `target` and to nothing else (X8): an agent
 * tab gets it as one chip labelled `label`, a terminal has its reference typed
 * at the prompt. Never a sentence around it: what the agent is asked to do is
 * the item's `prompt`, set when it was put. Neither presses Enter.
 */
export async function handToAgent(
  target: AgentTarget,
  itemId: string,
  label: string,
): Promise<Delivery> {
  if (target.kind === "terminal") return typeAt([itemId], target.id);
  const r = await invoke<{ delivered?: number } | null>("veistra/attach-to-agent", {
    contextId: itemId,
    label,
    instanceId: target.id,
  });
  return (r?.delivered ?? 0) > 0
    ? { delivered: true }
    : { delivered: false, reason: "that agent tab is no longer open" };
}

/**
 * Every Send button's last step: `item` as one chip on the prompt of the agent
 * tab the person last clicked into (the shell keeps track), or, with no agent
 * tab open, its reference typed at this environment's agent terminal, with
 * the references of the items it carries. Nothing else is typed and nothing
 * is sent; the person adds their words and presses Enter.
 */
export async function chipToAgent(item: ContextRef): Promise<Delivery> {
  const r = await invoke<{ delivered?: number } | null>("veistra/attach-to-agent", {
    contextId: item.id,
    label: chipLabel(item),
    ...(item.chipKind ? { kind: item.chipKind } : {}),
  });
  if ((r?.delivered ?? 0) > 0) return { delivered: true };
  return typeAt(idsOf(item));
}

/** `chipToAgent` for each item in turn; the first that is not taken says why. */
export async function chipAllToAgent(items: readonly ContextRef[]): Promise<Delivery> {
  for (const item of items) {
    const said = await chipToAgent(item);
    if (!said.delivered) return said;
  }
  return { delivered: true };
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
