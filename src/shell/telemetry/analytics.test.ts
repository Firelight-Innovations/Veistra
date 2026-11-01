import { describe, expect, it, vi } from "vitest";
import type { TelemetryConfig } from "../../bindings";
import {
  createAnalytics,
  maskAttribute,
  maskText,
  type PostHogLike,
  UNMASK_ATTRIBUTE,
} from "./analytics";
import type { Consent } from "./consent";

const READY: TelemetryConfig = {
  sink: { state: "ready", apiKey: "phc_test", host: "https://us.i.posthog.com" },
  installId: "install",
  appVersion: "0.6.2",
  os: "windows",
  arch: "x86_64",
  build: "release",
};
const OFF_BUILD: TelemetryConfig = { ...READY, sink: { state: "off", reason: "no key" } };

const consent = (usage: Consent["usage"], replay = true): Consent => ({
  usage,
  replay,
  prompts: true,
});

function fake() {
  const client = {
    capture: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
  } satisfies PostHogLike;
  const load = vi.fn(() => Promise.resolve(client));
  return { client, load, analytics: createAnalytics(load) };
}

/** Let the loader's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createAnalytics", () => {
  it("holds events until it knows both the build and the answer", async () => {
    const { client, load, analytics } = fake();
    analytics.capture("a:b");
    expect(analytics.status()).toBe("unknown");
    analytics.configure(READY);
    analytics.setConsent(consent("on"));
    await settle();
    expect(load).toHaveBeenCalledWith(READY.sink, READY, true);
    expect(client.capture).toHaveBeenCalledWith("a:b", undefined);
  });

  it("never loads the SDK for anybody who has not said yes", async () => {
    for (const usage of ["ask", "off"] as const) {
      const { load, analytics } = fake();
      analytics.capture("held");
      analytics.configure(READY);
      analytics.setConsent(consent(usage));
      analytics.capture("dropped");
      await settle();
      expect(load, usage).not.toHaveBeenCalled();
      expect(analytics.status()).toBe("off");
    }
  });

  it("never loads it in a build that cannot send, whatever the answer", async () => {
    const { load, analytics } = fake();
    analytics.configure(OFF_BUILD);
    analytics.setConsent(consent("on"));
    await settle();
    expect(load).not.toHaveBeenCalled();
  });

  it("drops what it was holding when the answer turns out to be no", async () => {
    const { client, analytics } = fake();
    analytics.capture("held");
    analytics.configure(READY);
    analytics.setConsent(consent("off"));
    analytics.setConsent(consent("on"));
    await settle();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("opts out and stops recording on a no, and back in silently on a yes", async () => {
    const { client, load, analytics } = fake();
    analytics.configure(READY);
    analytics.setConsent(consent("on"));
    await settle();
    analytics.setConsent(consent("off"));
    expect(client.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
    analytics.capture("while off");
    analytics.setConsent(consent("on"));
    expect(client.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(client.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(client.capture).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("follows the recording switch while sharing stays on", async () => {
    const { client, load, analytics } = fake();
    analytics.configure(READY);
    analytics.setConsent(consent("on", false));
    await settle();
    expect(load).toHaveBeenCalledWith(READY.sink, READY, false);
    analytics.setConsent(consent("on", true));
    analytics.setConsent(consent("on", true));
    expect(client.startSessionRecording).toHaveBeenCalledTimes(1);
    analytics.setConsent(consent("on", false));
    expect(client.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("gives up quietly when the SDK cannot load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const analytics = createAnalytics(() => Promise.reject(new Error("offline")));
    analytics.configure(READY);
    analytics.setConsent(consent("on"));
    analytics.capture("x");
    await settle();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

/** An element whose `closest` finds an unmasked ancestor, or does not. */
const inside = (unmasked: boolean) =>
  ({
    closest: (selector: string) => (unmasked && selector === `[${UNMASK_ATTRIBUTE}]` ? {} : null),
  }) as unknown as HTMLElement;

describe("maskAttribute", () => {
  it("masks attributes that are prose, wherever they are", () => {
    expect(maskAttribute("title", "client.ts — acme", inside(false))).toBe("********* * ****");
    expect(maskAttribute("aria-label", "Close plan.md")).toBe("***** *******");
    expect(maskAttribute("data-path", "src/secret.ts")).toBe("*************");
  });

  it("drops a source that points at the disk, and keeps one the app ships", () => {
    expect(maskAttribute("src", "http://asset.localhost/C%3A/work/acme/icon.png")).toBe("");
    expect(maskAttribute("src", "C:\\work\\acme\\icon.png")).toBe("");
    expect(maskAttribute("href", "file:///home/me/notes.md")).toBe("");
    expect(maskAttribute("src", "/icons/material/typescript.svg")).toBe(
      "/icons/material/typescript.svg",
    );
  });

  it("keeps what styling matches on, so a replay still looks like the window", () => {
    expect(maskAttribute("class", "pane-split__child")).toBe("pane-split__child");
    expect(maskAttribute("data-dir", "row")).toBe("row");
    expect(maskAttribute("data-state", "C:\\Users\\me")).toBe("***********");
  });

  it("leaves the product's own words alone inside an unmasked element", () => {
    expect(maskAttribute("aria-label", "Send feedback", inside(true))).toBe("Send feedback");
  });
});

describe("maskText", () => {
  it("masks everything but whitespace by default", () => {
    expect(maskText("src/secret plan.ts")).toBe("********** *******");
    expect(maskText("a b")).toBe("* *");
  });

  it("leaves text inside an unmasked element readable", () => {
    const element = {
      closest: (selector: string) => (selector === `[${UNMASK_ATTRIBUTE}]` ? {} : null),
    } as unknown as HTMLElement;
    expect(maskText("Send feedback", element)).toBe("Send feedback");
  });
});
