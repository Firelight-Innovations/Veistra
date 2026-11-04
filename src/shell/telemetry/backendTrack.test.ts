import { afterEach, describe, expect, it } from "vitest";
import { listen, type FeatureEvent } from "./bus";
import { defineFeature } from "./define";
import { trackFromBackend } from "./backendTrack";
import { FEATURES } from "./features";

const notes = defineFeature({
  id: "godot",
  name: "Godot",
  events: ["note_fixed", "note_resolved"],
});

let heard: FeatureEvent[] = [];
let stop = listen((event) => heard.push(event));
afterEach(() => {
  heard = [];
  stop();
  stop = listen((event) => heard.push(event));
});

describe("trackFromBackend", () => {
  it("files a Rust event under the feature it names, with its props cleaned", () => {
    const answer = trackFromBackend(
      {
        feature: "godot",
        event: "note_fixed",
        props: { attempt: 2, commit: true, path: "x".repeat(300), nested: { no: 1 } },
      },
      [notes],
    );
    expect(answer).toEqual({ ok: true });
    expect(heard).toHaveLength(1);
    expect(heard[0].feature).toBe("godot");
    expect(heard[0].event).toBe("note_fixed");
    expect(heard[0].props).toMatchObject({ attempt: 2, commit: true });
    expect(heard[0].props).not.toHaveProperty("nested");
    expect(String(heard[0].props?.path).length).toBeLessThan(300);
  });

  it("refuses a feature that does not exist", () => {
    expect(trackFromBackend({ feature: "nope", event: "note_fixed" }, [notes]).ok).toBe(false);
    expect(trackFromBackend({ event: "note_fixed" }, [notes]).ok).toBe(false);
    expect(trackFromBackend(null, [notes]).ok).toBe(false);
    expect(heard).toEqual([]);
  });

  it("refuses an event its feature does not declare, and says which it does", () => {
    const answer = trackFromBackend({ feature: "godot", event: "note_deleted" }, [notes]);
    expect(answer).toEqual({ ok: false, message: expect.stringContaining("note_resolved") });
    expect(heard).toEqual([]);
  });

  it("accepts the two play-note events Rust sends, against the real registry", () => {
    for (const event of ["note_fixed", "note_resolved"]) {
      expect(trackFromBackend({ feature: "godot", event, props: {} }, FEATURES)).toEqual({
        ok: true,
      });
    }
  });
});
