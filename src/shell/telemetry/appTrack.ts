/**
 * `veistra/track` and `veistra/feedback`, the two calls an app frame makes into
 * this system, checked before anything is believed.
 *
 * Called by `ToolWindow`, which has already resolved *which* app is asking from
 * `event.source`; nothing in the message is trusted to say. An app may report
 * only the events of the feature that lists it in `apps`, which is what stops
 * a frame filing events under another feature's name.
 *
 * Tools are refused outright. A person who shares usage data agreed to report
 * on the shell and its own apps; a tool is somebody else's code, and nobody
 * agreed to report on that.
 */
import { emit } from "./bus";
import type { Feature } from "./define";
import { FEATURES } from "./features";
import { featureForApp } from "./registry";
import { sanitize } from "./sanitize";
import { openFeedback } from "./surface";

export type FrameAnswer = { ok: true } | { ok: false; message: string };

const TOOLS_REFUSED = "only first-party apps may report usage";

export function trackFromFrame(
  appId: string,
  isApp: boolean,
  params: unknown,
  features: readonly Feature[] = FEATURES,
): FrameAnswer {
  if (!isApp) return { ok: false, message: TOOLS_REFUSED };
  const feature = featureForApp(appId, features);
  if (!feature) {
    return {
      ok: false,
      message: `no feature lists the ${appId} app in its \`apps\`, so it has no events to report`,
    };
  }
  const { event, props } = (params ?? {}) as { event?: unknown; props?: unknown };
  if (typeof event !== "string" || !feature.events.includes(event)) {
    return {
      ok: false,
      message: `${JSON.stringify(event)} is not one of ${feature.id}'s events: ${feature.events.join(", ")}`,
    };
  }
  emit({ feature: feature.id, event, props: sanitize(props) });
  return { ok: true };
}

/** Open the feedback dialog about the asking app's feature. */
export function feedbackFromFrame(appId: string, isApp: boolean): FrameAnswer {
  if (!isApp) return { ok: false, message: TOOLS_REFUSED };
  openFeedback({ source: "app", feature: featureForApp(appId)?.id ?? null });
  return { ok: true };
}
