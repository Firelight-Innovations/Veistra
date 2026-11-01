/**
 * PostHog's lifecycle in this window: started on a yes, stopped on a no, and
 * never loaded at all for anybody who does not say yes.
 *
 * The SDK is a dynamic import, so the bundle a person who declines downloads
 * has none of it, and nothing reaches PostHog's servers — not even the remote
 * config request `init` makes — until consent is `on`.
 *
 * It is `posthog-js/full/no-external`: the build that inlines the session
 * recorder and has no script loader. The default build fetches `recorder.js`
 * from PostHog's CDN at run time, and this webview is created with
 * `withGlobalTauri`, so a fetched script would hold every `#[tauri::command]`
 * through `window.__TAURI__`. A bundled recorder is code we pinned and
 * reviewed; a fetched one is whatever the CDN served that day.
 *
 * `createAnalytics` is the testable core; the module exports one instance.
 */
import type { TelemetryConfig } from "../../bindings";
import type { Consent } from "./consent";
import type { PropValue } from "./define";

type ReadySink = Extract<TelemetryConfig["sink"], { state: "ready" }>;

/** The slice of the PostHog client this module calls, so a test can fake it. */
export interface PostHogLike {
  capture(event: string, properties?: Record<string, PropValue>): unknown;
  opt_in_capturing(options?: { captureEventName?: false }): void;
  opt_out_capturing(): void;
  startSessionRecording(): void;
  stopSessionRecording(): void;
}

export type Loader = (
  sink: ReadySink,
  config: TelemetryConfig,
  replay: boolean,
) => Promise<PostHogLike>;

/** `unknown` until both the build's config and the person's answer are in. */
export type Status = "unknown" | "on" | "off";

/** Events held while the status is unknown or the SDK is still loading. */
const QUEUE_CAP = 100;

export interface Analytics {
  configure(config: TelemetryConfig): void;
  setConsent(consent: Consent): void;
  capture(event: string, props?: Record<string, PropValue>): void;
  status(): Status;
  config(): TelemetryConfig | null;
}

export function createAnalytics(load: Loader): Analytics {
  let config: TelemetryConfig | null = null;
  let consent: Consent | null = null;
  let client: PostHogLike | null = null;
  let loading = false;
  let optedOut = false;
  let recording: boolean | null = null;
  const queue: Array<[string, Record<string, PropValue> | undefined]> = [];

  const status = (): Status => {
    if (config === null || consent === null) return "unknown";
    return config.sink.state === "ready" && consent.usage === "on" ? "on" : "off";
  };

  function reconcile(): void {
    const now = status();
    if (now === "unknown") return;
    if (now === "off") {
      // Held events were captured on the understanding they might be sent.
      // That understanding just ended, so they go too.
      queue.length = 0;
      if (client && !optedOut) {
        client.stopSessionRecording();
        client.opt_out_capturing();
        optedOut = true;
        recording = false;
      }
      return;
    }
    if (!client) {
      start();
      return;
    }
    if (optedOut) {
      // No `$opt_in` event: the answer is already in the settings, and an
      // event saying so would be the first thing sent after a person who had
      // said no changed their mind — about the change itself.
      client.opt_in_capturing({ captureEventName: false });
      optedOut = false;
    }
    const replay = consent?.replay === true;
    if (recording !== replay) {
      if (replay) client.startSessionRecording();
      else client.stopSessionRecording();
      recording = replay;
    }
    for (const [event, props] of queue.splice(0)) client.capture(event, props);
  }

  function start(): void {
    if (loading || config?.sink.state !== "ready") return;
    loading = true;
    const sink = config.sink;
    load(sink, config, consent?.replay === true)
      .then((loaded) => {
        client = loaded;
        recording = consent?.replay === true;
        reconcile();
      })
      .catch((err: unknown) => {
        // Nothing to show: the person agreed and nothing went wrong that they
        // can act on. `recent_errors` will have it.
        console.error("veistra: could not start usage data:", err);
        queue.length = 0;
      })
      .finally(() => {
        loading = false;
      });
  }

  return {
    configure(next) {
      config = next;
      reconcile();
    },
    setConsent(next) {
      consent = next;
      reconcile();
    },
    capture(event, props) {
      const now = status();
      if (now === "off") return;
      if (now === "unknown" || client === null) {
        if (queue.length < QUEUE_CAP) queue.push([event, props]);
        return;
      }
      client.capture(event, props);
    },
    status,
    config: () => config,
  };
}

/**
 * Masks every piece of text in a recording except what is inside an element
 * marked `data-telemetry-unmask`.
 *
 * Everything is masked by default (`maskTextSelector: "*"`) because the shell
 * shows the person's work everywhere: file names in tabs, paths in the tree,
 * code in search results, branch names, commit messages, a project's name in
 * the title bar. A list of places to mask would leak the next one somebody
 * adds; a list of places to leave readable can only be too short.
 */
export const UNMASK_ATTRIBUTE = "data-telemetry-unmask";

export function maskText(text: string, element?: HTMLElement | null): string {
  if (element?.closest?.(`[${UNMASK_ATTRIBUTE}]`)) return text;
  return stars(text);
}

const stars = (text: string) => text.replace(/\S/g, "*");

/** Attributes that hold words a person reads: a tab's tooltip names its file. */
const READABLE_ATTRIBUTES = new Set([
  "title",
  "alt",
  "placeholder",
  "label",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-placeholder",
  "aria-roledescription",
]);

/** A drive, a home directory, a UNC share, or the webview's door to the disk. */
const LOCAL_PATH = /^[a-z]:[\\/]|\\\\|^file:|asset:|asset\.localhost|\/(Users|home)\//i;

/**
 * The attribute half of `maskText`. Text masking covers text nodes only, and a
 * recording keeps every attribute, so `title="client.ts — C:\work\acme"` would
 * otherwise arrive whole.
 *
 * Masked by name for attributes that are prose, and by content for anything
 * that looks like a path — an icon's `src` pointing into a project, a
 * `data-path` on a tree row. Everything else is kept: `class`, `style` and the
 * `data-*` the stylesheets match on (`[data-dir="row"]`) are what make a
 * replay look like the window it was.
 */
export function maskAttribute(name: string, value: string, element?: Element | null): string {
  if (element?.closest?.(`[${UNMASK_ATTRIBUTE}]`)) return value;
  if (READABLE_ATTRIBUTES.has(name) || /^data-(path|file)/.test(name)) return stars(value);
  if (!LOCAL_PATH.test(value)) return value;
  // A source that cannot be loaded is a broken image; one that can is the file.
  return name === "src" || name === "href" || name === "srcset" ? "" : stars(value);
}

const loadPostHog: Loader = async (sink, config, replay) => {
  const { default: posthog } = await import("posthog-js/full/no-external");
  posthog.init(sink.apiKey, {
    api_host: sink.host,
    // Pinned rather than `latest`, so upgrading the SDK cannot change what is
    // collected without a line here changing too.
    defaults: "2026-05-30",
    bootstrap: { distinctID: config.installId },
    person_profiles: "always",
    persistence: "localStorage",
    disable_external_dependency_loading: true,
    // Clicks, with the element's tag and classes and none of its text or
    // attributes: which control was used, never what it said. An attribute is
    // as likely to name a file as a text node is (`maskAttribute`).
    autocapture: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    rageclick: true,
    capture_dead_clicks: true,
    // There are no page loads in a desktop shell; the apps are reported as
    // `shell:app_loaded` instead.
    capture_pageview: false,
    capture_pageleave: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    save_referrer: false,
    disable_session_recording: !replay,
    enable_recording_console_log: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskTextFn: maskText,
      maskAttributeFn: maskAttribute,
      // App panes are iframes on another origin. Recording them would need
      // the recorder inside each app too; until then they are blank boxes.
      recordCrossOriginIframes: false,
    },
    // Each of these would draw PostHog's own UI or fetch more code. Surveys
    // are drawn by `src/shell/dialogs/PromptCard.tsx` instead.
    disable_surveys: true,
    disable_web_experiments: true,
    disable_product_tours: true,
    disable_conversations: true,
  });
  const context = {
    app_version: config.appVersion,
    os: config.os,
    arch: config.arch,
    build: config.build,
  };
  posthog.register(context);
  posthog.setPersonProperties(context);
  return posthog;
};

export const analytics: Analytics = createAnalytics(loadPostHog);
