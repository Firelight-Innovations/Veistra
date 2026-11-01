import { afterEach, describe, expect, it } from "vitest";
import { listen, type FeatureEvent } from "./bus";
import { defineFeature } from "./define";
import { trackFromFrame } from "./appTrack";

const canvas = defineFeature({
  id: "canvas",
  name: "Canvas",
  apps: ["canvas"],
  events: ["drawn"],
});

let heard: FeatureEvent[] = [];
let stop = listen((event) => heard.push(event));
afterEach(() => {
  heard = [];
  stop();
  stop = listen((event) => heard.push(event));
});

describe("trackFromFrame", () => {
  it("files an app's event under the feature that lists it, with its props cleaned", () => {
    const answer = trackFromFrame(
      "canvas",
      true,
      { event: "drawn", props: { shapes: 3, nested: { no: 1 } } },
      [canvas],
    );
    expect(answer).toEqual({ ok: true });
    expect(heard).toEqual([{ feature: "canvas", event: "drawn", props: { shapes: 3 } }]);
  });

  it("refuses a tool, whatever it claims to be", () => {
    const answer = trackFromFrame("canvas", false, { event: "drawn" }, [canvas]);
    expect(answer.ok).toBe(false);
    expect(heard).toEqual([]);
  });

  it("refuses an app no feature lists", () => {
    expect(trackFromFrame("files", true, { event: "drawn" }, [canvas]).ok).toBe(false);
  });

  it("refuses an event its feature does not declare, and says which it does", () => {
    const answer = trackFromFrame("canvas", true, { event: "erased" }, [canvas]);
    expect(answer).toEqual({ ok: false, message: expect.stringContaining("drawn") });
    expect(trackFromFrame("canvas", true, undefined, [canvas]).ok).toBe(false);
    expect(heard).toEqual([]);
  });
});
