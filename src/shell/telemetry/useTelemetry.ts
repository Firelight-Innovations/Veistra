/**
 * Wires this window into the usage data system. Called once, from `App`.
 *
 * Fetches what Rust decided about this build, hands the person's consent to
 * PostHog's lifecycle as it changes, becomes the bus's listener, and decides
 * when the first-run question and the launch prompts are due. Everything it
 * decides is in a pure module beside it; this is the part with timers.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { telemetryConfig, type TelemetryConfig } from "../../bindings";
import { analytics } from "./analytics";
import { listen } from "./bus";
import { readConsent, type Consent, type SettingsReader } from "./consent";
import { considerLaunchPrompts, handleFeatureEvent, setPipelineConsent } from "./pipeline";

/**
 * How long after the window is up before the first-run question. Long enough
 * that it is not the first thing on screen, short enough that it is asked
 * before somebody is deep in something.
 */
const ASK_AFTER_MS = 4_000;

/** How long after sharing is on before a launch prompt may appear. */
const LAUNCH_PROMPT_AFTER_MS = 90_000;

export interface TelemetryState {
  /** `null` until Rust has answered. */
  config: TelemetryConfig | null;
  /** Whether to put the first-run question on screen now. */
  askConsent: boolean;
  /** "Not now": hide the question until the next launch, recording nothing. */
  deferConsent: () => void;
}

export function useTelemetry(consent: Consent | null): TelemetryState {
  const [config, setConfig] = useState<TelemetryConfig | null>(null);
  const [due, setDue] = useState(false);
  const [deferred, setDeferred] = useState(false);

  useEffect(() => listen(handleFeatureEvent), []);

  useEffect(() => {
    let live = true;
    telemetryConfig()
      .then((next) => {
        if (!live) return;
        analytics.configure(next);
        setConfig(next);
      })
      .catch((err: unknown) => console.error("veistra: could not read the usage config:", err));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setPipelineConsent(consent);
    if (consent) analytics.setConsent(consent);
  }, [consent]);

  const unasked = consent?.usage === "ask" && config?.sink.state === "ready" && !deferred;
  useEffect(() => {
    if (!unasked) {
      setDue(false);
      return;
    }
    // Asked in the window that has focus. A second window opening at launch
    // would otherwise ask the same question twice, side by side; an answer in
    // either reaches both through `settings:changed`.
    const timer = window.setTimeout(() => setDue(document.hasFocus()), ASK_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [unasked]);

  const sharing = consent?.usage === "on" && consent.prompts && config?.sink.state === "ready";
  useEffect(() => {
    if (!sharing) return;
    const timer = window.setTimeout(considerLaunchPrompts, LAUNCH_PROMPT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [sharing]);

  const deferConsent = useCallback(() => setDeferred(true), []);
  return { config, askConsent: due && unasked, deferConsent };
}

/**
 * `readConsent`, held steady across renders: a new object only when one of the
 * three answers actually moves, so the effects keyed on it do not re-run on
 * every unrelated settings change.
 */
export function useConsent(session: SettingsReader): Consent | null {
  const read = readConsent(session);
  const usage = read?.usage;
  const replay = read?.replay === true;
  const prompts = read?.prompts === true;
  return useMemo(
    () => (usage === undefined ? null : { usage, replay, prompts }),
    [usage, replay, prompts],
  );
}
