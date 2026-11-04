/**
 * The arithmetic behind a tab strip that scrolls sideways: how far one wheel
 * tick moves it, and how far it must move to show a given tab.
 */
import { describe, expect, it } from "vitest";
import { horizontalWheelDelta, revealScrollLeft } from "./stripScroll";

describe("horizontalWheelDelta", () => {
  const strip = { clientWidth: 300 };

  it("turns a vertical tick in pixels into the same number of horizontal pixels", () => {
    expect(horizontalWheelDelta(strip, 0, 100, 0)).toBe(100);
    expect(horizontalWheelDelta(strip, 0, -100, 0)).toBe(-100);
  });

  it("scales a tick in lines by 16px a line, and one in pages by the strip's width", () => {
    expect(horizontalWheelDelta(strip, 0, 3, 1)).toBe(48);
    expect(horizontalWheelDelta(strip, 0, 1, 2)).toBe(300);
  });

  it("leaves a tick that is already mostly horizontal to native scrolling", () => {
    expect(horizontalWheelDelta(strip, 40, 10, 0)).toBeNull();
    expect(horizontalWheelDelta(strip, -40, 10, 0)).toBeNull();
  });

  it("still takes a dead-even tick", () => {
    expect(horizontalWheelDelta(strip, 20, 20, 0)).toBe(20);
    expect(horizontalWheelDelta(strip, 0, 0, 0)).toBe(0);
  });
});

describe("revealScrollLeft", () => {
  // A 300px view at x=100, already scrolled 50px in.
  const view = { left: 100, right: 400, scrollLeft: 50 };

  it("stays put for a tab already wholly in view, edges included", () => {
    expect(revealScrollLeft(view, { left: 150, right: 250 })).toBe(50);
    expect(revealScrollLeft(view, { left: 100, right: 400 })).toBe(50);
  });

  it("moves just far enough to show a tab cut off at the right edge", () => {
    expect(revealScrollLeft(view, { left: 350, right: 470 })).toBe(120);
  });

  it("moves just far enough to show a tab cut off at the left edge", () => {
    expect(revealScrollLeft(view, { left: 60, right: 160 })).toBe(10);
  });

  it("lines a tab wider than the view up with the view's left edge", () => {
    expect(revealScrollLeft(view, { left: 200, right: 550 })).toBe(150);
    expect(revealScrollLeft(view, { left: 70, right: 470 })).toBe(20);
  });
});
