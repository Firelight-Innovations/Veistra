// @vitest-environment jsdom
/**
 * Home against a stubbed bridge: when the sign-in screen stands in front of
 * Home, and each of its states. The statuses are what `account/status` answers
 * (`src-tauri/src/account/`). The account panel these tests also covered was
 * retired; the signed-in reading now lives in the shell (title-bar avatar and
 * Settings → Account / Usage), with tests of its own there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AccountStatus } from "./account";

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

const base: AccountStatus = {
  configured: true,
  user: null,
  waiting: null,
  outcome: null,
  ownSignIn: false,
};

const user = { name: "Braden Seaborn", email: "b@example.com" };

const me = {
  user: { id: "u1", ...user },
  workspace: { id: "w1", name: "Personal workspace", plan: "beta" },
};

/** Answers every method Home calls; `account` is what `account/status` says. */
function host(account: AccountStatus, actions: Record<string, AccountStatus> = {}) {
  bridge.invoke.mockImplementation((method: string) => {
    if (method === "account/status") return Promise.resolve(account);
    if (method in actions) return Promise.resolve(actions[method]);
    if (method === "account/me") return Promise.resolve(me);
    if (method === "account/usage")
      return Promise.resolve({
        totals: { cost_micros: 18_400_000 },
        limit: {
          monthly_limit_micros: 50_000_000,
          spent_this_period_micros: 18_400_000,
          alert_pct: 80,
          pause_at_limit: true,
          projected_date: "2026-11-14",
        },
      });
    if (method === "home/state") return Promise.resolve({ open: null, recents: [] });
    if (method === "home/docs")
      return Promise.resolve({
        home: "https://veistra.com/docs",
        status: "live",
        detail: null,
        cards: [],
        total: 0,
      });
    return Promise.reject(new Error(`unexpected ${method}`));
  });
}

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

describe("the sign-in screen", () => {
  it("is not shown when the account service is not set up", async () => {
    host({ ...base, configured: false });
    render(<App />);
    // Home itself, with no sign-in screen in front of it.
    await screen.findByRole("heading", { name: "Docs" });
    expect(screen.queryByText("Sign in with your browser")).toBeNull();
  });

  it("stands in front of Home for someone signed out, and steps aside for their own sign-in", async () => {
    host(base, { "account/use-own-sign-in": { ...base, ownSignIn: true } });
    render(<App />);
    fireEvent.click(await screen.findByText("Use my own Claude or Codex sign-in"));
    await screen.findByRole("heading", { name: "Docs" });
    expect(screen.queryByText("Use my own Claude or Codex sign-in")).toBeNull();
    expect(bridge.invoke).toHaveBeenCalledWith("account/use-own-sign-in");
  });

  it("shows the code in two groups while it waits for the browser", async () => {
    host({
      ...base,
      waiting: {
        userCode: "KQ74MX",
        verificationUri: "https://veistra.com/device",
        verificationUriComplete: "https://veistra.com/device?code=KQ74MX",
        expiresAtMs: Date.now() + 600_000,
      },
    });
    render(<App />);
    await screen.findByText("Finish signing in on veistra.com");
    expect(screen.getByRole("group", { name: "Sign-in code K Q 7 4 M X" })).toBeTruthy();
    expect(screen.getByText("The code expires in 10 minutes.")).toBeTruthy();
  });

  it("names a cancelled and an expired sign-in", async () => {
    host({ ...base, outcome: { kind: "denied" } });
    render(<App />);
    await screen.findByText("Sign-in cancelled");
    cleanup();

    host({ ...base, ownSignIn: true, outcome: { kind: "expired" } });
    render(<App />);
    await screen.findByText("This code expired");
    expect(screen.getByText("Try again")).toBeTruthy();
  });
});
