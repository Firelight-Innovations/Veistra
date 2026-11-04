// @vitest-environment jsdom
/**
 * The Usage page against a stubbed bridge: what a signed-in answer draws, what
 * the range switch asks for, and the two states that draw no numbers at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Runs, Usage } from "./usage";

const bridge = vi.hoisted(() => {
  class VeistraRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  return { invoke: vi.fn(), VeistraRpcError };
});

vi.mock("@veistra/bridge", () => ({
  invoke: bridge.invoke,
  VeistraRpcError: bridge.VeistraRpcError,
  reportPainted: vi.fn(),
  openIn: vi.fn(() => Promise.resolve()),
  on: vi.fn(() => () => {}),
}));

import App from "./App";

const usage: Usage = {
  range: { from: "2026-11-01", to: "2026-11-04" },
  period: { from: "2026-11-01", to: "2026-11-30", resets: "2026-12-01" },
  totals: {
    cost_micros: 18_400_000,
    by_source: {
      veistra_harness: { cost_micros: 9_600_000, quantity: 4_710_000, unit: "token" },
      cloud_worker: { cost_micros: 4_200_000, quantity: 16_200, unit: "second" },
      gpu_render: { cost_micros: 4_600_000, quantity: 3_600, unit: "second" },
    },
    unbilled_runs: { own_claude: 31, own_codex: 14 },
  },
  daily: [{ day: "2026-11-01", source: "veistra_harness", cost_micros: 300_000 }],
  projects: ["Anomaly", "Torn Apart"],
  limit: {
    monthly_limit_micros: 50_000_000,
    spent_this_period_micros: 18_400_000,
    alert_pct: 80,
    pause_at_limit: true,
    projected_date: "2026-11-14",
  },
  synced_at: new Date().toISOString(),
};

const runs: Runs = {
  runs: [
    {
      id: "r1",
      name: "Generate crate variants",
      project: "Anomaly",
      harness: "veistra_harness",
      status: "finished",
      started_at: "2026-11-04T17:20:00Z",
      tokens: 560_000,
      cost_micros: 380_000,
      billed: true,
    },
    {
      id: "r2",
      name: "Port enemy AI to Godot 4.5",
      project: "demo-game",
      harness: "codex",
      status: "failed",
      started_at: "2026-11-04T14:07:00Z",
      tokens: null,
      cost_micros: null,
      billed: false,
    },
  ],
  next_cursor: null,
};

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

function signedIn() {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "account/usage") return Promise.resolve(usage);
    if (method === "account/runs") return Promise.resolve(runs);
    return Promise.resolve(null);
  });
}

describe("Usage", () => {
  it("draws the totals, the limit and the runs from the account service", async () => {
    signedIn();
    render(<App />);
    await screen.findByText("Generate crate variants");
    expect(screen.getAllByText("$18.40").length).toBeGreaterThan(0);
    expect(screen.getByText("4.7M tokens")).toBeTruthy();
    expect(screen.getByText("Limit reached around Nov 14")).toBeTruthy();
    expect(screen.getByText("31 runs")).toBeTruthy();
    expect(screen.getByText("Your plan")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Daily spend from Nov 1 to Nov 4/ })).toBeTruthy();
  });

  it("asks for the range and the project that are picked", async () => {
    signedIn();
    render(<App />);
    await screen.findByText("Generate crate variants");
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("account/usage", { range: "7d" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "Anomaly" },
    });
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("account/usage", {
        range: "7d",
        project: "Anomaly",
      }),
    );
  });

  it("asks someone signed out to sign in rather than showing zeros", async () => {
    bridge.invoke.mockRejectedValue(
      new bridge.VeistraRpcError(-32603, "not signed in", { reason: "signed-out" }),
    );
    render(<App />);
    await screen.findByText("Sign in on Home");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("says so when the account service is not set up", async () => {
    bridge.invoke.mockRejectedValue(
      new bridge.VeistraRpcError(-32603, "not set", { reason: "not-configured" }),
    );
    render(<App />);
    await screen.findByText(/Veistra accounts are not set up/);
  });
});
