/**
 * Where one of an agent tab's events goes (`apps::agent_tab`): the app frame
 * whose instance the payload names, once it has said hello, at the origin it
 * said it from. Every other frame, an agent tab for another session included,
 * gets nothing.
 */
export function agentTabFrames<W>(
  frames: Iterable<[W, { id: string; isApp: boolean; origin: string | null }]>,
  payload: unknown,
): [W, string][] {
  const instanceId = (payload as { instanceId?: unknown } | null)?.instanceId;
  const found: [W, string][] = [];
  for (const [win, frame] of frames) {
    if (frame.isApp && frame.origin !== null && frame.id === instanceId) {
      found.push([win, frame.origin]);
    }
  }
  return found;
}

/**
 * An app's `veistra/attach-to-agent`, checked: what the agent tab is sent, and
 * where. Only the item and its chip's label: an app's words for the agent go
 * in the item (`context/put`'s `prompt`), never typed at the person's prompt.
 * `kind`, when the app gives one, is the chip's glyph and colour (`godot-node`).
 */
export interface Attach {
  payload: { contextId: string; label: string; kind?: string };
  /** The one agent tab the app chose (Send's SEND TO); unset, the last one focused. */
  instanceId?: string;
}

/** `null` for a request with no `contextId` string; other fields that are not strings are dropped. */
export function attachRequest(params: unknown): Attach | null {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.contextId !== "string") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const instanceId = text(p.instanceId);
  const kind = text(p.kind);
  return {
    payload: {
      contextId: p.contextId,
      label: text(p.label) ?? p.contextId,
      ...(kind !== undefined ? { kind } : {}),
    },
    ...(instanceId !== undefined ? { instanceId } : {}),
  };
}

/**
 * The one agent tab an attach goes to, once it has said hello: the one
 * `instanceId` names when the app chose one; else `lastFocused`, the agent tab
 * the person last clicked into, while it is still open; else the first. A
 * chosen tab that has closed gets nothing, never another tab instead: the
 * person picked that agent.
 */
export function attachFrames<W>(
  frames: Iterable<[W, { id: string; appId: string; isApp: boolean; origin: string | null }]>,
  agentTabApp: string,
  instanceId?: string,
  lastFocused?: string | null,
): [W, string][] {
  const tabs: [W, string, string][] = [];
  for (const [win, frame] of frames) {
    if (!frame.isApp || frame.appId !== agentTabApp || frame.origin === null) continue;
    tabs.push([win, frame.origin, frame.id]);
  }
  const pick =
    instanceId !== undefined
      ? tabs.find(([, , id]) => id === instanceId)
      : (tabs.find(([, , id]) => id === lastFocused) ?? tabs[0]);
  return pick ? [[pick[0], pick[1]]] : [];
}
