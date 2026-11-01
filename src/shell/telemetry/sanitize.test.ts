import { describe, expect, it } from "vitest";
import { MAX_KEYS, MAX_STRING, sanitize } from "./sanitize";

describe("sanitize", () => {
  it("keeps flat values under snake_case keys", () => {
    expect(sanitize({ app: "files", count: 3, on: true, none: null })).toEqual({
      app: "files",
      count: 3,
      on: true,
      none: null,
    });
  });

  it("drops nested values, non-finite numbers and keys that are not snake_case", () => {
    expect(
      sanitize({
        nested: { a: 1 },
        list: [1],
        nan: Number.NaN,
        big: Number.POSITIVE_INFINITY,
        fn: () => 1,
        BadKey: "x",
        "with space": "x",
        $set: "x",
        ok: 1,
      }),
    ).toEqual({ ok: 1 });
  });

  it("cuts a long string rather than sending it whole", () => {
    const path = "C:/Users/someone/".repeat(40);
    const kept = sanitize({ path }).path as string;
    expect(kept.length).toBe(MAX_STRING + 1);
    expect(kept.endsWith("…")).toBe(true);
  });

  it("stops at the key cap", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitize(many))).toHaveLength(MAX_KEYS);
  });

  it("answers anything that is not an object with nothing", () => {
    for (const input of [undefined, null, "x", 3, [1, 2]]) expect(sanitize(input)).toEqual({});
  });
});
