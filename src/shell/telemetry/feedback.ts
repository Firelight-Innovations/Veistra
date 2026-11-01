/**
 * Sending what somebody typed into a feedback box.
 *
 * Three cases, and the dialog says which one applies before Send is pressed:
 *
 * - **Usage data is on.** The message goes the way every event does, and
 *   carries this session's id, so it opens beside the recording of what led
 *   up to it.
 * - **Usage data is off, but this build can send.** Pressing Send is consent
 *   to send *that message*, and nothing else: one request carrying the text,
 *   the version and the OS, sent without loading the SDK, so no session, no
 *   recording and no identity beyond the install id ride along.
 * - **This build cannot send** (no key; a development or agent build). The
 *   dialog offers the issue tracker instead and never calls this.
 */
import type { TelemetryConfig } from "../../bindings";
import { analytics } from "./analytics";
import { eventName, type PropValue } from "./define";
import { sanitize } from "./sanitize";

/** Where the dialog was opened from — part of every submission. */
export type FeedbackSource = "help-menu" | "settings" | "agent-menu" | "app" | "prompt";

export type FeedbackKind = "problem" | "idea" | "praise";

export interface FeedbackDraft {
  source: FeedbackSource;
  /** The registry id of what it is about, or `null` for the product overall. */
  feature: string | null;
  /** Set when it answers a corner prompt. */
  prompt?: string;
  kind?: FeedbackKind;
  /** 1–5, from a rating prompt. */
  rating?: number;
  message: string;
  /** An address to reply to, only if the person typed one. */
  contact?: string;
}

/** Long enough for a real report; short enough that a paste of a log is cut. */
export const MAX_MESSAGE = 5000;

const SUBMITTED = eventName("feedback", "submitted");

/** How a submission can go, for the dialog to say. */
export type Delivery = "with-session" | "alone" | "nowhere";

export function deliveryFor(config: TelemetryConfig | null, sharing: boolean): Delivery {
  if (config?.sink.state !== "ready") return "nowhere";
  return sharing ? "with-session" : "alone";
}

/** The event's properties: the draft, trimmed and bounded. */
export function feedbackProps(draft: FeedbackDraft): Record<string, PropValue> {
  const extra: Record<string, PropValue> = {
    message: draft.message.trim().slice(0, MAX_MESSAGE),
  };
  const contact = draft.contact?.trim();
  if (contact) extra.contact = contact.slice(0, 200);
  return {
    ...sanitize({
      // The same two the pipeline gives every event it sends: the reporter in
      // `feature`, and what the feedback concerns in `about`.
      feature: "feedback",
      about: draft.feature ?? "general",
      source: draft.source,
      prompt: draft.prompt ?? null,
      kind: draft.kind ?? null,
      rating: draft.rating ?? null,
    }),
    ...extra,
  };
}

/**
 * Send it. Resolves once it has gone, or — with usage data on — once the SDK
 * has it, which sends within seconds and retries on its own. Rejects with a
 * sentence when it cannot be sent at all.
 */
export async function submitFeedback(draft: FeedbackDraft): Promise<void> {
  const config = analytics.config();
  const props = feedbackProps(draft);
  switch (deliveryFor(config, analytics.status() === "on")) {
    case "with-session":
      analytics.capture(SUBMITTED, props);
      return;
    case "alone": {
      const sink = config?.sink;
      if (config && sink?.state === "ready") await sendAlone(sink, config, props);
      return;
    }
    case "nowhere":
      throw new Error(
        config?.sink.state === "off"
          ? config.sink.reason
          : "Feedback cannot be sent until the app has finished starting.",
      );
  }
}

/**
 * One event, one request, PostHog's single-event capture endpoint. Used only
 * for a message somebody pressed Send on while usage data is off.
 */
async function sendAlone(
  sink: Extract<TelemetryConfig["sink"], { state: "ready" }>,
  config: TelemetryConfig,
  props: Record<string, PropValue>,
): Promise<void> {
  const response = await fetch(`${sink.host}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: sink.apiKey,
      event: SUBMITTED,
      distinct_id: config.installId,
      properties: {
        ...props,
        app_version: config.appVersion,
        os: config.os,
        // Tells PostHog not to make or update a person for this one event.
        $process_person_profile: false,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`The feedback service answered ${response.status}. Try again in a moment.`);
  }
}
