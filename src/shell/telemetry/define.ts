/**
 * What a feature declares about itself: its events, the apps allowed to report
 * them, and the feedback it may ask for. Consent, delivery and prompt timing are
 * the pipeline's, so a feature never learns PostHog exists. `docs/telemetry.md`
 * §4 is the walkthrough.
 *
 * Events are a closed list, not any string: the compiler catches a misspelt
 * one, and `appTrack.ts` holds an app frame to the same list at runtime.
 */
import { emit } from "./bus";

/** A property value. Flat on purpose; `sanitize.ts` says why. */
export type PropValue = string | number | boolean | null;

export type Props = Readonly<Record<string, PropValue>>;

/** When a prompt becomes due. */
export type PromptTrigger<E extends string = string> =
  /** After this feature's `event` has happened `count` times, across launches. */
  | { event: E; count: number }
  /** After this many launches of the app. */
  | { launches: number };

/**
 * One question for the corner card. An answered prompt is never shown again, so
 * a question worth asking twice gets a new `id` rather than a reset.
 */
export interface PromptSpec<E extends string = string> {
  /** The ledger key. Lower-case `a-z0-9_:/.-`; prefix it with the feature id. */
  id: string;
  /** One sentence, drawn as the card's heading. */
  question: string;
  /** `rating` is 1–5 with an optional comment; `text` is the comment alone. */
  kind?: "rating" | "text";
  after: PromptTrigger<E>;
  /** Not before the install is this many days old, however soon `after` is met. */
  minDaysInstalled?: number;
}

export interface FeatureSpec<E extends string> {
  /** Lower-case kebab; the prefix of every event, `"<id>:<event>"`. */
  id: string;
  /** What the feedback dialog's "About" list calls it. */
  name: string;
  /** snake_case verbs in the past tense: `opened`, `diagram_created`. */
  events: readonly E[];
  /** App ids whose frames may report these events through `veistra/track`. */
  apps?: readonly string[];
  prompts?: readonly PromptSpec<NoInfer<E>>[];
}

export interface Feature<E extends string = string> extends FeatureSpec<E> {
  /** Report one event. Dropped unless the person shares usage data. */
  track(event: E, props?: Props): void;
}

/** Declare a feature. `const E` keeps the events literal, so `track` is checked. */
export function defineFeature<const E extends string>(spec: FeatureSpec<E>): Feature<E> {
  return {
    ...spec,
    track: (event, props) => emit({ feature: spec.id, event, props }),
  };
}

/** The name PostHog sees: `"canvas:diagram_created"`. */
export function eventName(feature: string, event: string): string {
  return `${feature}:${event}`;
}
