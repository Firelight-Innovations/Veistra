/**
 * The seam between a feature reporting an event and the pipeline that decides
 * what happens to it.
 *
 * Its own module, with no imports, because the two ends would otherwise import
 * each other: the pipeline needs the feature registry to know which events a
 * prompt waits on, and every feature needs somewhere to send its events.
 *
 * Events reported before the pipeline subscribes are held, up to a cap, and
 * handed over when it does. A frame that mounts during boot reports before
 * `App` has run a single effect, and the pipeline — not this — is what knows
 * whether they may be sent at all.
 */
import type { Props } from "./define";

export interface FeatureEvent {
  feature: string;
  event: string;
  props?: Props;
}

/** Plenty for a boot; small enough that a stuck pipeline cannot leak. */
const EARLY_CAP = 50;

let listener: ((event: FeatureEvent) => void) | null = null;
const early: FeatureEvent[] = [];

export function emit(event: FeatureEvent): void {
  if (listener) listener(event);
  else if (early.length < EARLY_CAP) early.push(event);
}

/**
 * Become the one listener, receiving anything held first. One rather than a
 * set: a window has one pipeline, and a second would send every event twice.
 */
export function listen(fn: (event: FeatureEvent) => void): () => void {
  listener = fn;
  for (const event of early.splice(0)) fn(event);
  return () => {
    if (listener === fn) listener = null;
  };
}
