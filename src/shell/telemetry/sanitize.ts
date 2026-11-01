/**
 * What an event's properties are cut down to before anything sees them.
 *
 * Flat values only, a bounded number of keys, and short strings. The limit is
 * the point: a property is for a category — which app, which section, which
 * kind — and a long string is almost always something that should not leave
 * the machine at all, a path or a selection or a file's first line. Cutting it
 * here means a feature that passes one by mistake sends a stub rather than the
 * thing itself.
 *
 * Feedback text is the exception, and does not come through here: a message
 * the person typed into a box labelled "send" is meant to be sent whole.
 */
import type { PropValue, Props } from "./define";

export const MAX_KEYS = 20;
export const MAX_STRING = 200;

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Keep what is safe to send; drop the rest without complaint.
 *
 * Silent because the caller is usually an app frame, and a frame that sent a
 * bad property has nowhere to show an error. Dropped keys are the visible
 * symptom in PostHog, which is where someone would look.
 */
export function sanitize(input: unknown): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Props)) {
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (!KEY.test(key)) continue;
    const kept = keep(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

function keep(value: unknown): PropValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  return undefined;
}
