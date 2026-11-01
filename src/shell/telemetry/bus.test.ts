import { describe, expect, it } from "vitest";
import { emit, listen, type FeatureEvent } from "./bus";

describe("the bus", () => {
  it("holds what is reported before anyone listens, and hands it over in order", () => {
    emit({ feature: "a", event: "one" });
    emit({ feature: "a", event: "two" });
    const heard: FeatureEvent[] = [];
    const stop = listen((event) => heard.push(event));
    emit({ feature: "a", event: "three" });
    expect(heard.map((e) => e.event)).toEqual(["one", "two", "three"]);
    stop();
  });

  it("stops delivering to a listener that has gone, and ignores a stale stop", () => {
    const first: FeatureEvent[] = [];
    const second: FeatureEvent[] = [];
    const stopFirst = listen((event) => first.push(event));
    const stopSecond = listen((event) => second.push(event));
    stopFirst();
    emit({ feature: "a", event: "x" });
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    stopSecond();
  });
});
