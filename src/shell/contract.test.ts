/**
 * `contract.ts`'s mapping functions — the doors between backend vocabulary and
 * what a component is allowed to know.
 *
 * `updateNotice` is the one covered so far, because its job is deciding when
 * the status bar says *nothing*, and that is the half a screenshot cannot
 * check. Every case below is a state the updater really reaches; the pairs are
 * the same state asked for and not.
 */
import { describe, expect, it, vi } from "vitest";
import { appPresentation, pluginPresentation, updateNotice } from "./contract";

const install = () => {};

describe("a check nobody asked for", () => {
  it("says nothing when there is nothing to say", () => {
    expect(updateNotice({ state: "idle" }, false, install)).toBeNull();
    expect(updateNotice({ state: "checking" }, false, install)).toBeNull();
    expect(updateNotice({ state: "up-to-date", version: "0.1.1" }, false, install)).toBeNull();
  });

  /**
   * The one that matters. A laptop opened on a train fails its launch check
   * every single time, and a bar that reported it would be teaching the user
   * to ignore the bar.
   */
  it("says nothing when it fails", () => {
    expect(updateNotice({ state: "failed", message: "offline" }, false, install)).toBeNull();
    expect(updateNotice({ state: "unsupported", reason: "dev build" }, false, install)).toBeNull();
  });

  it("still offers an update it found", () => {
    const notice = updateNotice(
      { state: "available", version: "0.2.0", notes: "Fixes the terminal." },
      false,
      install,
    );
    expect(notice?.label).toBe("Update to 0.2.0");
    expect(notice?.detail).toBe("Fixes the terminal.");
    expect(notice?.tone).toBe("offer");
  });
});

describe("a check somebody asked for", () => {
  it("answers, including when the answer is no", () => {
    expect(updateNotice({ state: "checking" }, true, install)?.label).toBe("Checking…");
    expect(updateNotice({ state: "up-to-date", version: "0.1.1" }, true, install)).toMatchObject({
      label: "Up to date",
      detail: "0.1.1 is the newest release.",
      tone: "status",
    });
  });

  it("reports a failure with the sentence Rust wrote", () => {
    const notice = updateNotice({ state: "failed", message: "Could not reach it." }, true, install);
    expect(notice?.detail).toBe("Could not reach it.");
    expect(notice?.tone).toBe("error");
  });

  /** A development build is not broken, so it must not read as an error. */
  it("does not treat an unsupported build as a failure", () => {
    expect(updateNotice({ state: "unsupported", reason: "dev build" }, true, install)?.tone).toBe(
      "status",
    );
  });
});

describe("the notice's own shape", () => {
  /** A row without `onSelect` renders as text, so this is what decides whether
   *  the bar draws something clickable. Only the offer may be. */
  it("is pressable only when there is something to press", () => {
    const onInstall = vi.fn();
    const offer = updateNotice(
      { state: "available", version: "0.2.0", notes: "" },
      true,
      onInstall,
    );
    offer?.onSelect?.();
    expect(onInstall).toHaveBeenCalledOnce();

    expect(updateNotice({ state: "checking" }, true, install)?.onSelect).toBeUndefined();
    expect(updateNotice({ state: "installing" }, true, install)?.onSelect).toBeUndefined();
    expect(
      updateNotice({ state: "downloading", received: 1, total: 2, percent: 50 }, true, install)
        ?.onSelect,
    ).toBeUndefined();
  });

  /** An empty note is the common case: `--generate-notes` writes a list, and
   *  `updater::summarise` takes the first paragraph, which can be nothing. */
  it("falls back to naming the version when the release has no note", () => {
    expect(
      updateNotice({ state: "available", version: "0.2.0", notes: "" }, true, install)?.detail,
    ).toBe("0.2.0 is available.");
  });

  /** A length nobody declared has no percentage, and inventing one would draw
   *  a bar that jumps to a number it was never at. */
  it("drops the percentage when the download has no declared length", () => {
    expect(
      updateNotice(
        { state: "downloading", received: 512, total: null, percent: null },
        true,
        install,
      )?.label,
    ).toBe("Downloading…");
  });
});

/**
 * What makes the tool window push a pane its window rect and the overlays over
 * it. Carried from the app registry, so the Godot app gets it before Play moves
 * in, and never claimed for a plugin, whose window Rust does not place.
 */
describe("placing a native window over a pane", () => {
  const app = (placesWindow: boolean) =>
    appPresentation({ id: "godot-viewer", name: "Godot", description: "", url: "/", placesWindow });

  it("is the app's own declaration", () => {
    expect(app(true).placesWindow).toBe(true);
    expect(app(false).placesWindow).toBe(false);
  });

  it("is never a plugin surface's", () => {
    const surface = { id: "p", name: "P", description: "" } as Parameters<
      typeof pluginPresentation
    >[0];
    expect(pluginPresentation(surface).placesWindow).toBe(false);
  });
});
