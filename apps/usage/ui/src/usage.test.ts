import { describe, expect, it } from "vitest";
import {
  type Run,
  type Usage,
  chartTop,
  compact,
  costCell,
  dayBars,
  daysBetween,
  quantityLabel,
  shortDate,
  statusBadge,
  syncedAgo,
} from "./usage";

const usage: Usage = {
  range: { from: "2026-11-01", to: "2026-11-04" },
  period: { from: "2026-11-01", to: "2026-11-30", resets: "2026-12-01" },
  totals: { cost_micros: 0, by_source: {}, unbilled_runs: {} },
  daily: [
    { day: "2026-11-01", source: "veistra_harness", cost_micros: 300_000 },
    { day: "2026-11-01", source: "cloud_worker", cost_micros: 100_000 },
    { day: "2026-11-03", source: "gpu_render", cost_micros: 2_600_000 },
    { day: "2026-11-03", source: "own_claude", cost_micros: 0 },
    { day: "2026-10-30", source: "veistra_harness", cost_micros: 9_000_000 },
  ],
  limit: null,
  synced_at: "2026-11-04T17:40:00Z",
};

describe("the daily chart", () => {
  it("has one bar per day of the range, gaps included", () => {
    const bars = dayBars(usage);
    expect(bars.map((b) => b.day)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(bars[0].bySource).toEqual({
      veistra_harness: 300_000,
      cloud_worker: 100_000,
      gpu_render: 0,
    });
    expect(bars[1].total).toBe(0);
  });

  it("ignores rows outside the range and unbilled sources", () => {
    const total = dayBars(usage).reduce((s, b) => s + b.total, 0);
    expect(total).toBe(3_000_000);
  });

  it("tops out at an even whole number of dollars", () => {
    expect(chartTop(dayBars(usage))).toBe(4_000_000);
    expect(chartTop([])).toBe(2_000_000);
  });

  it("spans months without a time zone shifting a day", () => {
    expect(daysBetween("2026-10-31", "2026-11-01")).toEqual(["2026-10-31", "2026-11-01"]);
    expect(shortDate("2026-11-04")).toBe("Nov 4");
  });
});

describe("cells", () => {
  it("names quantities in each card's own unit", () => {
    expect(
      quantityLabel("veistra_harness", { cost_micros: 0, quantity: 4_710_000, unit: "token" }),
    ).toBe("4.7M tokens");
    expect(
      quantityLabel("cloud_worker", { cost_micros: 0, quantity: 16_200, unit: "second" }),
    ).toBe("4.5 h");
    expect(quantityLabel("gpu_render", { cost_micros: 0, quantity: 3_600, unit: "second" })).toBe(
      "60 min",
    );
    expect(compact(560_000)).toBe("560K");
  });

  it("shows Your plan for an unbilled run instead of a price", () => {
    const run: Run = {
      id: "r1",
      name: "Fix flashlight battery drain",
      project: "Anomaly",
      harness: "claude_code",
      status: "finished",
      started_at: "2026-11-04T15:31:00Z",
      tokens: null,
      cost_micros: null,
      billed: false,
    };
    expect(costCell(run)).toBe("Your plan");
    expect(costCell({ ...run, billed: true, cost_micros: 380_000 })).toBe("$0.38");
    expect(statusBadge("failed")).toEqual({ tone: "bad", label: "Failed" });
  });

  it("says how long ago the numbers were read", () => {
    expect(syncedAgo("2026-11-04T17:40:00Z", Date.parse("2026-11-04T17:42:10Z"))).toBe(
      "Synced 2 min ago",
    );
  });
});
