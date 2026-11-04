/**
 * A usage event reported from Rust (`telemetry::track`), checked before it is
 * believed, the way `appTrack.ts` checks an app frame's.
 *
 * For the moments that happen only in Rust: an agent marking a play note
 * fixed over MCP is a call no webview sees. Rust names the feature itself,
 * since there is no frame to resolve one from; the feature must exist and
 * declare the event, or it is refused. Capture stays here, in the webview,
 * for the reasons in `docs/telemetry.md` §9, and the pipeline decides whether
 * it is sent at all.
 *
 * Only the main window hears these (`onBackendUsage`), so each is counted once.
 */
import type { FrameAnswer } from "./appTrack";
import { emit } from "./bus";
import type { Feature } from "./define";
import { FEATURES } from "./features";
import { featureById } from "./registry";
import { sanitize } from "./sanitize";

export function trackFromBackend(
  params: unknown,
  features: readonly Feature[] = FEATURES,
): FrameAnswer {
  const { feature, event, props } = (params ?? {}) as {
    feature?: unknown;
    event?: unknown;
    props?: unknown;
  };
  const found = typeof feature === "string" ? featureById(feature, features) : undefined;
  if (!found) {
    return { ok: false, message: `${JSON.stringify(feature)} is not a feature` };
  }
  if (typeof event !== "string" || !found.events.includes(event)) {
    return {
      ok: false,
      message: `${JSON.stringify(event)} is not one of ${found.id}'s events: ${found.events.join(", ")}`,
    };
  }
  emit({ feature: found.id, event, props: sanitize(props) });
  return { ok: true };
}
