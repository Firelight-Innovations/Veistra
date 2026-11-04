/**
 * Wire types for transport B — tool frontend <-> shell window messages.
 * Mirrors `docs/tool-protocol.md` §3 exactly; if this drifts from that file,
 * the doc wins.
 *
 * Every message carries `veistra: 1`. It's a version marker, but its real job
 * is cheaper: an iframe's `window` can receive `message` events from
 * anything, not just its host (browser extensions, embedded widgets, the
 * page's own code posting to itself) — `veistra === 1` is what lets the bridge
 * ignore all of that in one check instead of trying to prove a message is
 * safe to parse.
 */

/** Mirrors the `Session` shape shared with the tool core's `veistra/hello`. */
export interface Session {
  /** Root of the open project. Null until projects exist. */
  projectPath: string | null;
  /**
   * This frame's own instance id: stable across cluster switches (which unmount
   * the frame and reload it) and across restarts. It is a key for the frame's
   * own remembered state, never an identity claim; the shell resolves identity
   * from `event.source`. Absent outside a shell.
   */
  instanceId?: string;
}

export interface VeistraErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

// ---- Frontend -> shell ----

export interface HelloMessage {
  veistra: 1;
  kind: "hello";
}

export interface RequestMessage {
  veistra: 1;
  kind: "request";
  id: number;
  method: string;
  params?: unknown;
}

export type OutgoingMessage = HelloMessage | RequestMessage;

// ---- Shell -> frontend ----

export interface ReadyMessage {
  veistra: 1;
  kind: "ready";
  toolId: string;
  protocol: 1;
  session: Session;
}

export interface ResponseMessage {
  veistra: 1;
  kind: "response";
  id: number;
  result?: unknown;
  error?: VeistraErrorPayload;
}

export interface EventMessage {
  veistra: 1;
  kind: "event";
  event: string;
  payload: unknown;
}

/**
 * A menu command, aimed at whichever frame the shell considers active.
 *
 * Distinct from `event` rather than an event with a reserved name, because the
 * two make opposite claims. An event is news — the shell relaying something
 * that happened, which a frame may ignore. A command is an *instruction* the
 * user just gave through the shell's own chrome, and the shell only sends one
 * the frame has said it can carry out (see `veistra/commands`). Keeping them
 * apart is what lets a frontend register a handler for one without having to
 * filter the other out of the same stream.
 *
 * Fire-and-forget: there is no id and no reply. What the menu needed to know —
 * whether this command is possible at all — was answered before the item was
 * ever clickable, and a result arriving afterwards would have nowhere to go,
 * since the menu has closed by then.
 */
export interface CommandMessage {
  veistra: 1;
  kind: "command";
  command: string;
}

export type IncomingMessage = ReadyMessage | ResponseMessage | EventMessage | CommandMessage;

// ---- The sideways channel: frame -> shell -> another frame ----

/**
 * The event name a `veistra/open` is delivered under.
 *
 * One name for every kind of open, rather than a name per intent, because the
 * shell must not learn what any of them mean. What is being asked for lives in
 * the payload and is read by the app that receives it: File Explorer sends
 * `{path, preview}` and File Viewer knows that is a file to show; the source
 * control view will send something else to the same app under the same event.
 * A shell that routed on intent would need a table of every app's verbs, which
 * is the thing `veistra/commands` was shaped to avoid.
 */
export const OPENED_EVENT = "veistra:opened";

/**
 * The event prefix a published topic is delivered under.
 *
 * Prefixed rather than posted as the bare topic name, so an app's topics can
 * never collide with the shell's own push events (`project:changed`,
 * `files:open-path`). A frame subscribing to `files/active-path` is listening
 * on `veistra:topic/files/active-path`, and nothing an app can publish is able to
 * impersonate news the shell authored.
 */
export const TOPIC_EVENT_PREFIX = "veistra:topic/";

/**
 * The event `veistra:theme-changed` is delivered under — shell-authored news
 * broadcast to every app frame, so it gets a colon like `OPENED_EVENT`
 * rather than `TOPIC_EVENT_PREFIX`'s slash form. App side:
 * `packages/bridge/src/theme.ts`. Shell side: `src/shell/themeBroadcast.ts`.
 */
export const THEME_CHANGED_EVENT = "veistra:theme-changed";

/** What arrives with a `veistra:theme-changed` event: the resolved theme
 *  (never "system" — already resolved before send) and the chosen accent. */
export interface ThemeChangedPayload {
  theme: "dark" | "light";
  accent: "amber" | "blue" | "green" | "violet" | "coral";
}

/** The event carrying a titlebar-search interaction; see `veistra/search-claim`. */
export const SEARCH_EVENT = "veistra:search";

export interface SearchClaimParams {
  placeholder: string;
  value: string;
}

export interface SearchEventPayload {
  kind: "query" | "submit" | "escape";
  value: string;
}

/** `{ x, y, width, height, window }` in window CSS pixels, to apps that declare `placesWindow`. */
export const WINDOW_RECT_EVENT = "veistra/window-rect";

/**
 * `{ rects }`: the shell's open overlays in the same space, to the same apps.
 * Rects, not a flag, so a pane hides its window only for one over its box.
 */
export const OVERLAYS_EVENT = "veistra/overlays";

/** On the shell's own `window` as the first overlay opens and the last closes (§4.3.2). */
export const OVERLAY_OPEN_EVENT = "veistra:overlay-open";
export const OVERLAY_CLOSE_EVENT = "veistra:overlay-close";

/** What arrives with a `veistra:topic/*` event. */
export interface PublishedTopic {
  value: unknown;
  /**
   * The instance that published it.
   *
   * Carried because a subscriber may have several publishers — two Viewers in
   * one cluster both publish an active path — and "which one" is a question
   * only the subscriber can answer, since only it knows whether it cares. The
   * shell does not arbitrate; it delivers both.
   */
  from: string;
}

/**
 * The one check every inbound `message` event must pass before anything
 * else looks at it. Deliberately loose beyond that — `kind`-specific shape
 * is trusted once this and the `kind` narrow it, since the shell is the only
 * thing this bridge accepts messages from at all (see the `event.source`
 * check in `client.ts`).
 */
export function isVeistraMessage(data: unknown): data is IncomingMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { veistra?: unknown }).veistra === 1 &&
    typeof (data as { kind?: unknown }).kind === "string"
  );
}

export function isReadyMessage(msg: IncomingMessage): msg is ReadyMessage {
  return msg.kind === "ready";
}

export function isResponseMessage(msg: IncomingMessage): msg is ResponseMessage {
  return msg.kind === "response";
}

export function isEventMessage(msg: IncomingMessage): msg is EventMessage {
  return msg.kind === "event";
}

export function isCommandMessage(msg: IncomingMessage): msg is CommandMessage {
  return msg.kind === "command" && typeof (msg as CommandMessage).command === "string";
}
