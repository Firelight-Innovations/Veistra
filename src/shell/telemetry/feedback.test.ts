import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryConfig } from "../../bindings";
import { analytics } from "./analytics";
import { MAX_MESSAGE, deliveryFor, feedbackProps, submitFeedback } from "./feedback";

const READY: TelemetryConfig = {
  sink: { state: "ready", apiKey: "phc_test", host: "https://eu.i.posthog.com" },
  installId: "install",
  appVersion: "0.6.2",
  os: "windows",
  arch: "x86_64",
  build: "release",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deliveryFor", () => {
  it("rides the session when sharing, goes alone when not, and nowhere without a sink", () => {
    expect(deliveryFor(READY, true)).toBe("with-session");
    expect(deliveryFor(READY, false)).toBe("alone");
    expect(deliveryFor({ ...READY, sink: { state: "off", reason: "x" } }, true)).toBe("nowhere");
    expect(deliveryFor(null, true)).toBe("nowhere");
  });
});

describe("feedbackProps", () => {
  it("keeps the whole message, up to its own cap, and a contact only if given", () => {
    const long = "x".repeat(MAX_MESSAGE + 50);
    const props = feedbackProps({ source: "help-menu", feature: null, message: `  ${long}  ` });
    expect(props.message).toHaveLength(MAX_MESSAGE);
    expect(props).toMatchObject({ feature: "feedback", about: "general" });
    expect("contact" in props).toBe(false);
    expect(
      feedbackProps({ source: "app", feature: "canvas", message: "m", contact: " a@b " }),
    ).toMatchObject({ contact: "a@b", source: "app", about: "canvas" });
  });
});

describe("submitFeedback with usage data off", () => {
  it("sends that one message, and nothing that would tie it to a session", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    analytics.configure(READY);
    analytics.setConsent({ usage: "off", replay: true, prompts: true });

    await submitFeedback({ source: "help-menu", feature: null, kind: "idea", message: "Hi" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "feedback:submitted",
      distinct_id: "install",
      properties: { message: "Hi", kind: "idea", $process_person_profile: false },
    });
    expect(JSON.stringify(body)).not.toContain("$session_id");
  });

  it("says so when the service refuses it", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 503 })));
    analytics.configure(READY);
    analytics.setConsent({ usage: "ask", replay: true, prompts: true });
    await expect(
      submitFeedback({ source: "help-menu", feature: null, message: "Hi" }),
    ).rejects.toThrow("503");
  });

  it("refuses with the build's own reason when it cannot send at all", async () => {
    analytics.configure({ ...READY, sink: { state: "off", reason: "No key in this build." } });
    await expect(
      submitFeedback({ source: "help-menu", feature: null, message: "Hi" }),
    ).rejects.toThrow("No key in this build.");
  });
});
