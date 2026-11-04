/**
 * The box arithmetic every pane that places a native window shares (the
 * game, the Godot editor, Blender). Moved here from Play's own `geometry.ts`
 * with the module.
 */
import { describe, expect, it } from "vitest";
import { boxInWindow, covered, isWindowRect, overlayRects, sameRect } from "./nativeBox";

describe("a pane's native box", () => {
  it("places the box in window space and sees what covers it", () => {
    const frame = { x: 400, y: 120, width: 900, height: 700 };
    const box = boxInWindow(frame, { left: 16, top: 60, width: 640, height: 360 });
    expect(box).toEqual({ x: 416, y: 180, w: 640, h: 360 });
    expect(covered(box, [{ x: 1000, y: 500, width: 200, height: 200 }])).toBe(true);
    expect(covered(box, [{ x: 0, y: 0, width: 400, height: 100 }])).toBe(false);
    expect(sameRect(box, { ...box })).toBe(true);
    expect(isWindowRect({ x: 1, y: 2, width: 3, height: 4, window: "main" })).toBe(true);
    expect(isWindowRect({ x: 1 })).toBe(false);
    expect(overlayRects({ rects: [{ x: 0, y: 0, width: 1, height: 1 }, "bad"] })).toHaveLength(1);
  });

  // Touching edges share no pixel: a menu that ends where the box starts
  // must not hide the window.
  it("does not count an overlay that only touches the box's edge", () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    expect(covered(box, [{ x: 0, y: 0, width: 100, height: 300 }])).toBe(false);
    expect(covered(box, [{ x: 100, y: 200, width: 50, height: 50 }])).toBe(false);
    expect(covered(box, [{ x: 299, y: 199, width: 5, height: 5 }])).toBe(true);
  });

  it("refuses a rect with a non-number side or a non-string window", () => {
    expect(isWindowRect({ x: 1, y: 2, width: Number.NaN, height: 4 })).toBe(false);
    expect(isWindowRect({ x: 1, y: 2, width: 3, height: 4, window: 7 })).toBe(false);
    expect(isWindowRect(null)).toBe(false);
    expect(overlayRects(null)).toEqual([]);
    expect(overlayRects({ rects: "no" })).toEqual([]);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect({ x: 0, y: 0, w: 1, h: 1 }, null)).toBe(false);
  });
});
