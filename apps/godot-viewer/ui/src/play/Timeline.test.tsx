// @vitest-environment jsdom
/**
 * The review timeline's layout (design §8.2): the lanes in the board's order,
 * filmstrip frames over the time each stands for, and a lone In shown before
 * Out is set. Positions are percentages, so they are read from `style`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Timeline, type TimelineProps } from "./Timeline";

afterEach(cleanup);

function draw(over: Partial<TimelineProps> = {}) {
  const props: TimelineProps = {
    durationMs: 5_000,
    playheadMs: 0,
    range: { inMs: null, outMs: null },
    thumbs: [],
    stripEveryMs: 2_000,
    notes: [],
    marks: [],
    log: [],
    scenes: [],
    frames: [],
    selected: null,
    onSeek: vi.fn(),
    onPickNote: vi.fn(),
    ...over,
  };
  return render(<Timeline {...props} />).container;
}

describe("Timeline", () => {
  it("names the lanes top to bottom as the board does", () => {
    const labels = [...draw().querySelectorAll(".pl-tl__label")].map((l) => l.textContent);
    expect(labels.filter(Boolean)).toEqual([
      "FRAMES",
      "NOTES",
      "MARKS",
      "LOG",
      "SCENES",
      "FRAME TIME",
    ]);
  });

  // Laid out by flex, frames sat side by side from the left, so while the
  // strip was still being made the first frame covered the whole take.
  it("puts each filmstrip frame over the 2 s it stands for, holes included", () => {
    const slots = [
      ...draw({ thumbs: ["data:image/jpeg;base64,AA"] }).querySelectorAll<HTMLElement>(
        ".pl-tl__thumb",
      ),
    ];
    expect(slots.map((s) => [s.style.left, s.style.width])).toEqual([
      ["0%", "40%"],
      ["40%", "40%"],
      ["80%", "20%"],
    ]);
    expect(slots.map((s) => s.querySelector("img") !== null)).toEqual([true, false, false]);
  });

  it("shows In alone until Out is set, then the range", () => {
    const lone = draw({ range: { inMs: 1_000, outMs: null } });
    expect(lone.querySelector<HTMLElement>(".pl-tl__in")?.style.left).toBe("20%");
    expect(lone.querySelector(".pl-tl__selection")).toBeNull();
    cleanup();
    const both = draw({ range: { inMs: 1_000, outMs: 3_000 } });
    expect(both.querySelector(".pl-tl__in")).toBeNull();
    const sel = both.querySelector<HTMLElement>(".pl-tl__selection");
    expect([sel?.style.left, sel?.style.width]).toEqual(["20%", "40%"]);
  });
});
