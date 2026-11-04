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

/** An app's `veistra/attach-to-agent`, checked: what the agent tab is sent, and where. */
export interface Attach {
  payload: { contextId: string; label: string; before?: string; after?: string };
  /** The one agent tab the app chose (Send's SEND TO); unset, every agent tab. */
  instanceId?: string;
}

/** `null` for a request with no `contextId` string; other fields that are not strings are dropped. */
export function attachRequest(params: unknown): Attach | null {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.contextId !== "string") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const before = text(p.before);
  const after = text(p.after);
  const instanceId = text(p.instanceId);
  return {
    payload: {
      contextId: p.contextId,
      label: text(p.label) ?? p.contextId,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    },
    ...(instanceId !== undefined ? { instanceId } : {}),
  };
}

/**
 * The agent tabs an attach goes to, once each has said hello: the one
 * `instanceId` names when the app chose one, and else all of them. A chosen
 * tab that has closed gets nothing, never every other tab instead: the person
 * picked that agent.
 */
export function attachFrames<W>(
  frames: Iterable<[W, { id: string; appId: string; isApp: boolean; origin: string | null }]>,
  agentTabApp: string,
  instanceId?: string,
): [W, string][] {
  const found: [W, string][] = [];
  for (const [win, frame] of frames) {
    if (!frame.isApp || frame.appId !== agentTabApp || frame.origin === null) continue;
    if (instanceId === undefined || frame.id === instanceId) found.push([win, frame.origin]);
  }
  return found;
}
