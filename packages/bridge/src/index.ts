/**
 * `@veistra/bridge` — what a tool's `ui/` imports instead of `@tauri-apps/api`.
 * Same tool code, either host: an iframe under the orchestrator shell, or a
 * top-level window in its own standalone Tauri app. Wires `createClient` (the
 * testable core, see `client.ts`) to the real `window`. A singleton, not a
 * factory: a frontend has one host for its lifetime, decided once at load.
 */
import { createClient, type WindowLike } from "./client.js";
import { installChordForwarder } from "./chord.js";
import { installEscapeForwarder } from "./escape.js";

export type {
  Client,
  ClientOptions,
  Host,
  SearchClaim,
  SearchHandle,
  TauriCore,
  WindowLike,
} from "./client.js";
export type {
  CommandMessage,
  EventMessage,
  HelloMessage,
  VeistraErrorPayload,
  IncomingMessage,
  OutgoingMessage,
  PublishedTopic,
  ReadyMessage,
  RequestMessage,
  SearchClaimParams,
  SearchEventPayload,
  Session,
  ThemeChangedPayload,
} from "./protocol.js";
export {
  OPENED_EVENT,
  OVERLAYS_EVENT,
  OVERLAY_CLOSE_EVENT,
  OVERLAY_OPEN_EVENT,
  SEARCH_EVENT,
  THEME_CHANGED_EVENT,
  TOPIC_EVENT_PREFIX,
  WINDOW_RECT_EVENT,
} from "./protocol.js";
export { VeistraErrorCode, VeistraRpcError } from "./errors.js";

// The cast narrows `addEventListener`: `Window`'s takes any event type, an
// `EventListenerObject` alternative, capture options — `WindowLike` needs none.
const client = createClient({
  self: window as unknown as WindowLike,
  parent: window.parent as unknown as WindowLike,
});

export const invoke: <T = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number,
) => Promise<T> = client.invoke;

export const on: (event: string, cb: (payload: unknown) => void) => () => void = client.on;

/**
 * Run this when the shell's menu bar asks for a command. The other half is
 * `declareCommands`: the shell only sends what the frontend says it can do
 * right now, so a handler with no matching declaration is never called. See
 * `docs/tool-protocol.md` §3.
 */
export const onCommand: (cb: (command: string) => void) => () => void = client.onCommand;

/** Which menu commands this frontend can carry out **at this moment**. */
export const declareCommands: (commands: readonly string[]) => void = client.declareCommands;

/**
 * Put something on screen in another app, in this frame's cluster — the one way
 * an app reaches sideways rather than down. It names a *kind* of app, never an
 * instance: which surface answers is a fact about the layout that only the
 * shell can see. See `docs/tool-protocol.md` §3.
 */
export const openIn: (appId: string, payload?: unknown) => Promise<{ instanceId: string }> =
  client.openIn;

/**
 * State a fact about this frame for its cluster-mates. Retained, so a frame
 * that mounts later is told the current value rather than waiting for a change.
 */
export const publish: (topic: string, value: unknown) => void = client.publish;

/** Listen for what other frames in this cluster publish under `topic`. */
export const subscribe: (topic: string, cb: (value: unknown, from: string) => void) => () => void =
  client.subscribe;

/**
 * Claim the shell's title bar search field for this frame, so the filter is
 * typed there rather than in a bar of this app's own. Only honoured while this
 * frame is the active surface; release it when the filter goes away. Under a
 * standalone host there is no shell to claim from, so check
 * `host() === "veistra"` and draw a local input otherwise.
 */
export const claimSearch: typeof client.claimSearch = client.claimSearch;

export const session: typeof client.session = client.session;

export const host: typeof client.host = client.host;

/**
 * How long `reportPainted` waits for an animation frame before reporting anyway.
 * The fallback is not belt-and-braces but the common case at startup: under the
 * orchestrator a frontend boots in a window *hidden* behind the splash, and a
 * hidden webview stops firing `requestAnimationFrame` — so rAF alone would never
 * fire in the one case this signal exists for. 200ms is far past a frame on a
 * drawing window, small against the seconds the host will wait.
 */
const PAINT_FALLBACK_MS = 200;

/** Set once `reportPainted` has sent; every call after the first is a no-op. */
// Escape typed in a frame never reaches the shell's document; say so, so an
// expanded rail page can still be left with the key. A standalone app has no
// shell (`parent === self`) and nothing to tell.
if (typeof window !== "undefined" && window.parent !== window) {
  installEscapeForwarder(document, () => {
    void client.invoke("veistra/escape").catch(() => {});
  });
  // The same gap, for the shell's chords: Ctrl+Shift+P and Alt+1 went dead as
  // soon as an app had focus.
  installChordForwarder(document, (chord) => {
    void client.invoke("veistra/key", chord).catch(() => {});
  });
}

let painted = false;

/**
 * Tell the host this frontend has drawn its first meaningful content. The
 * orchestrator holds its splash up until every first-party app says this, so
 * nobody sees a loading state that resolves into the real thing a beat later —
 * see `src-tauri/src/boot.rs`. A host with nothing to hold acknowledges it.
 *
 * Call it when the content is *committed*, not when the fetch resolves: the
 * claim is that there is something worth looking at, a fact about the DOM, not
 * a promise. Failure and empty states count — a screen that says it could not
 * read anything is still finished, and holding a window back for one that will
 * never improve only makes the bad news slower. Safe to call twice (React's
 * StrictMode runs every effect twice in development): only the first call is
 * sent, and the host ignores a repeat anyway.
 */
export function reportPainted(): void {
  if (painted) return;
  painted = true;

  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    // Swallowed, not reported: a courtesy to the host, and a host that refuses
    // it — a tool build with no such method, a shell that stopped waiting — has
    // told us nothing we can use. What must not happen is an unhandled
    // rejection in an app whose only crime was finishing its first render.
    void client.invoke("veistra/painted").catch(() => {});
  };

  const fallback = setTimeout(send, PAINT_FALLBACK_MS);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      send();
    });
  }
}
