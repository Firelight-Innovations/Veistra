/**
 * Usage events and the feedback dialog, for an app's frontend.
 *
 * Both go to the shell through the bridge, which decides everything an app
 * should not: whether the person shares usage data, and which feature this
 * app reports for. An app names only the event — `"prompt_sent"`, not
 * `"agent-tab:prompt_sent"` — and the shell refuses one its feature does not
 * declare (`src/shell/telemetry/features/`). `docs/telemetry.md` §5.
 *
 * Fire and forget, on purpose. Nothing an app does should wait on, or fail
 * because of, whether a usage event was accepted; a refusal is logged so the
 * author sees it in development, and is otherwise ignored.
 */
import { invoke } from "@veistra/bridge";

/** A property value. Short strings, numbers and flags — never content. */
export type UsageProp = string | number | boolean | null;

export function track(event: string, props?: Record<string, UsageProp>): void {
  void invoke("veistra/track", { event, props }).catch((err: unknown) =>
    console.warn("usage event refused:", event, err),
  );
}

/** Open the shell's feedback dialog, about this app. */
export function openFeedback(): void {
  void invoke("veistra/feedback").catch((err: unknown) =>
    console.warn("could not open the feedback dialog:", err),
  );
}
