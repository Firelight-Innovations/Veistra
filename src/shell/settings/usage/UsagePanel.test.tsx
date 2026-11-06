// @vitest-environment jsdom
/**
 * Settings → Usage against a stubbed `account_call`: what a signed-in answer
 * draws, what the range switch asks for, and the two states that draw no
 * numbers at all. Ported from the retired Usage app's tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Runs, Usage } from "./usage";

const bindings = vi.hoisted(() => ({ accountCall: vi.fn() }));
vi.mock("../../../bindings", () => ({ accountCall: bindings.accountCall }));

import UsagePanel from "./UsagePanel";
import { resetAccountForTests } from "../../account/useAccount";

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

const signedInStatus = {
  configured: true,
  user: { name: "Braden Seaborn", email: "b@example.com" },
  waiting: null,
  outcome: null,
  ownSignIn: false,
};

afterEach(() => {
  cleanup();
  bindings.accountCall.mockReset();
  resetAccountForTests();
});

function signedIn() {
  bindings.accountCall.mockImplementation((method: string) => {
    if (method === "account/usage") return Promise.resolve(usage);
    if (method === "account/runs") return Promise.resolve(runs);
    if (method === "account/status") return Promise.resolve(signedInStatus);
    if (method === "account/me") {
      return Promise.resolve({
        user: { id: "u1", email: "b@example.com", name: "Braden Seaborn" },
        workspace: { id: "w1", name: "Firelight", plan: "pro" },
      });
    }
    return Promise.resolve(null);
  });
}

/** How an `account_call` refusal arrives: the serialised `RpcError`. */
const refusal = (reason: string) => ({ code: -32603, message: reason, data: { reason } });

describe("Settings → Usage", () => {
  it("draws the month, the limit, the sources and the runs from the account service", async () => {
    signedIn();
    render(<UsagePanel />);
    await screen.findByText("Generate crate variants");
    expect(
      screen.getByText("You've spent $18.40 of your $50.00 monthly limit, $31.60 left."),
    ).toBeTruthy();
    expect(screen.getByText("37% used")).toBeTruthy();
    expect(screen.getByText(/Resets Dec 1/)).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Spend against monthly limit" })).toBeTruthy();
    expect(screen.getByText("4.7M tokens")).toBeTruthy();
    expect(screen.getByText("Limit reached around Nov 14")).toBeTruthy();
    expect(screen.getByText("31 runs")).toBeTruthy();
    expect(screen.getByText("Your plan")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Daily spend from Nov 1 to Nov 4/ })).toBeTruthy();
    expect(await screen.findByText("Pro")).toBeTruthy();
  });

  it("asks for the range and the project that are picked", async () => {
    signedIn();
    render(<UsagePanel />);
    await screen.findByText("Generate crate variants");
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() =>
      expect(bindings.accountCall).toHaveBeenCalledWith("account/usage", { range: "7d" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
      target: { value: "Anomaly" },
    });
    await waitFor(() =>
      expect(bindings.accountCall).toHaveBeenCalledWith("account/usage", {
        range: "7d",
        project: "Anomaly",
      }),
    );
  });

  it("opens the usage page on the web from its link", async () => {
    signedIn();
    render(<UsagePanel />);
    await screen.findByText("Generate crate variants");
    fireEvent.click(screen.getByRole("button", { name: /Open on veistra.com/ }));
    expect(bindings.accountCall).toHaveBeenCalledWith("account/open-web", { page: "usage" });
  });

  it("asks someone signed out to sign in rather than showing zeros", async () => {
    bindings.accountCall.mockImplementation((method: string) =>
      method === "account/status"
        ? Promise.resolve({ ...signedInStatus, user: null })
        : Promise.reject(refusal("signed-out")),
    );
    render(<UsagePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.queryByText("$0.00")).toBeNull();
    await waitFor(() => expect(bindings.accountCall).toHaveBeenCalledWith("account/sign-in"));
  });

  it("says so when the account service is not set up", async () => {
    bindings.accountCall.mockRejectedValue(refusal("not-configured"));
    render(<UsagePanel />);
    await screen.findByText(/Veistra accounts are not set up/);
  });

  it("draws an empty month as zeros, with no limit and no runs", async () => {
    // What the live service answers a new account: the contract's empty shape.
    const empty: Usage = {
      ...usage,
      totals: { cost_micros: 0, by_source: {}, unbilled_runs: { own_claude: 0, own_codex: 0 } },
      daily: [],
      projects: [],
      limit: null,
    };
    bindings.accountCall.mockImplementation((method: string) => {
      if (method === "account/usage") return Promise.resolve(empty);
      if (method === "account/runs") return Promise.resolve({ runs: [], next_cursor: null });
      if (method === "account/status") return Promise.resolve(signedInStatus);
      return Promise.resolve(null);
    });
    render(<UsagePanel />);
    await screen.findByText("You've spent $0.00 this month. No monthly limit is set.");
    expect(screen.getByText("No runs yet.")).toBeTruthy();
    expect(screen.getAllByText("0 runs")).toHaveLength(2);
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("draws the plan's credits above the limit, which then counts spend past them", async () => {
    signedIn();
    const answer = bindings.accountCall.getMockImplementation()!;
    const pro: Usage = {
      ...usage,
      plan: {
        id: "pro",
        name: "Pro",
        price_micros: 10_000_000,
        included_micros: 10_000_000,
        used_micros: 10_000_000,
        remaining_micros: 0,
        resets: "2026-12-01",
      },
      limit: { ...usage.limit!, spent_this_period_micros: 8_400_000 },
    };
    bindings.accountCall.mockImplementation((method: string, params?: unknown) =>
      method === "account/usage" ? Promise.resolve(pro) : answer(method, params),
    );
    render(<UsagePanel />);
    await screen.findByText("Included with Pro");
    expect(screen.getByRole("meter", { name: "Included credits used" })).toBeTruthy();
    expect(screen.getByText("100% used")).toBeTruthy();
    expect(screen.getByText(/\$8\.40 of \$50\.00 past your credits/)).toBeTruthy();
    expect(screen.getByText("17% used")).toBeTruthy();
    expect(
      screen.getByText(
        "Your Pro credits are used, and you've spent $8.40 of your $50.00 monthly limit, $41.60 left.",
      ),
    ).toBeTruthy();
  });

  it("draws no credits for a plan that includes none", async () => {
    signedIn();
    const answer = bindings.accountCall.getMockImplementation()!;
    const beta: Usage = {
      ...usage,
      plan: {
        id: "beta",
        name: "Beta",
        price_micros: 0,
        included_micros: 0,
        used_micros: 0,
        remaining_micros: 0,
        resets: "2026-12-01",
      },
    };
    bindings.accountCall.mockImplementation((method: string, params?: unknown) =>
      method === "account/usage" ? Promise.resolve(beta) : answer(method, params),
    );
    render(<UsagePanel />);
    await screen.findByText("Generate crate variants");
    expect(screen.queryByText(/^Included with/)).toBeNull();
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(
      screen.getByText("You've spent $18.40 of your $50.00 monthly limit, $31.60 left."),
    ).toBeTruthy();
  });

  it("shows an alert the dashboard turned off as no alert", async () => {
    signedIn();
    const answer = bindings.accountCall.getMockImplementation()!;
    const quiet = { ...usage, limit: { ...usage.limit!, alert_pct: null } };
    bindings.accountCall.mockImplementation((method: string, params?: unknown) =>
      method === "account/usage" ? Promise.resolve(quiet) : answer(method, params),
    );
    render(<UsagePanel />);
    await screen.findByText("No spend alert");
    expect(screen.queryByText(/null/)).toBeNull();
  });

  it("puts an unreachable service in words, not in place of the page", async () => {
    bindings.accountCall.mockImplementation((method: string) =>
      method === "account/status"
        ? Promise.resolve(signedInStatus)
        : Promise.reject({
            code: -32603,
            message:
              "Could not reach the Veistra account service. Check the internet connection and try again.",
            data: { reason: "unreachable" },
          }),
    );
    render(<UsagePanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^Could not reach the Veistra account service/);
    expect(screen.getByRole("radio", { name: "7 days" })).toBeTruthy();
  });
});
