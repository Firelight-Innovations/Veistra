// @vitest-environment jsdom
/**
 * The title bar's avatar: what it draws and is named in each account state,
 * which rows its menu has, and the keys that move through and close it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccountStatus } from "../account/account";

const bindings = vi.hoisted(() => ({ accountCall: vi.fn() }));
vi.mock("../../bindings", () => ({ accountCall: bindings.accountCall }));

import AccountMenu, {
  accountLabel,
  accountMenuItems,
  type AccountMenuActions,
} from "./AccountMenu";
import { resetAccountForTests } from "../account/useAccount";

const base: AccountStatus = {
  configured: true,
  user: null,
  waiting: null,
  outcome: null,
  ownSignIn: false,
};
const signedIn: AccountStatus = {
  ...base,
  user: { name: "Braden Seaborn", email: "b@example.com" },
};
const waiting: AccountStatus = {
  ...base,
  waiting: {
    userCode: "ABCD1234",
    verificationUri: "https://veistra.com/device",
    verificationUriComplete: "https://veistra.com/device?code=ABCD1234",
    expiresAtMs: Date.now() + 600_000,
  },
};

function actions(): AccountMenuActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    openSettings: vi.fn(),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
    openWeb: vi.fn(),
  };
}

const labels = (status: AccountStatus | null) =>
  accountMenuItems(status, actions()).map((i) => i.label);

afterEach(() => {
  cleanup();
  bindings.accountCall.mockReset();
  resetAccountForTests();
});

describe("accountMenuItems", () => {
  it("offers the signed-in person their account, usage, billing and sign out", () => {
    const a = actions();
    const items = accountMenuItems(signedIn, a);
    expect(items.map((i) => i.label)).toEqual([
      "Braden Seaborn (Veistra)",
      "Usage…",
      "Billing…",
      "Settings",
    ]);
    const sub = items[0].submenu ?? [];
    expect(sub.map((i) => i.label)).toEqual([
      "b@example.com",
      "Account settings…",
      "Manage on veistra.com",
      "Sign out",
    ]);
    sub[1].onSelect?.();
    expect(a.openSettings).toHaveBeenCalledWith("account");
    sub[3].onSelect?.();
    expect(a.signOut).toHaveBeenCalled();
    items[1].onSelect?.();
    expect(a.openSettings).toHaveBeenCalledWith("usage");
    items[3].onSelect?.();
    expect(a.openSettings).toHaveBeenCalledWith(null);
  });

  it("signs a signed-out person in from the menu", () => {
    const a = actions();
    const items = accountMenuItems(base, a);
    expect(items[0].label).toBe("Sign in…");
    items[0].onSelect?.();
    expect(a.signIn).toHaveBeenCalled();
  });

  it("sends Sign in to Settings → Account when accounts are not set up", () => {
    const a = actions();
    const items = accountMenuItems({ ...base, configured: false }, a);
    items[0].onSelect?.();
    expect(a.signIn).not.toHaveBeenCalled();
    expect(a.openSettings).toHaveBeenCalledWith("account");
  });

  it("offers to cancel a sign-in waiting for the browser", () => {
    expect(labels(waiting).slice(0, 2)).toEqual([
      "Waiting for the browser to approve…",
      "Cancel sign-in",
    ]);
  });

  it("names the button after the account, or just Account", () => {
    expect(accountLabel(signedIn)).toBe("Account: Braden Seaborn");
    expect(accountLabel(base)).toBe("Account");
    expect(accountLabel(null)).toBe("Account");
  });
});

describe("AccountMenu", () => {
  function answer(status: AccountStatus) {
    bindings.accountCall.mockImplementation((method: string) =>
      method === "account/status" ? Promise.resolve(status) : new Promise(() => {}),
    );
  }

  it("draws initials when signed in and a person glyph when not", async () => {
    answer(signedIn);
    render(<AccountMenu onOpenSettings={() => {}} />);
    const button = await screen.findByRole("button", { name: "Account: Braden Seaborn" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.textContent).toBe("BS");
    cleanup();
    resetAccountForTests();

    answer(base);
    render(<AccountMenu onOpenSettings={() => {}} />);
    const anon = await screen.findByRole("button", { name: "Account" });
    await waitFor(() => expect(anon.querySelector("svg")).not.toBeNull());
    expect(anon.textContent).toBe("");
  });

  it("opens on click, moves with the arrows and closes on Escape", async () => {
    answer(base);
    const onOpenSettings = vi.fn();
    render(<AccountMenu onOpenSettings={onOpenSettings} />);
    const button = screen.getByRole("button", { name: "Account" });
    await act(async () => {});
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    const rows = screen.getAllByRole("menuitem");
    expect(rows.map((r) => r.textContent?.replace("Ctrl+,", ""))).toEqual([
      "Sign in…",
      "Usage…",
      "Billing…",
      "Settings",
    ]);
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(document.activeElement).toBe(rows[3]);
    fireEvent.keyDown(rows[3], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(rows[0], { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("opens Settings on Usage from its row", async () => {
    answer(signedIn);
    const onOpenSettings = vi.fn();
    render(<AccountMenu onOpenSettings={onOpenSettings} />);
    fireEvent.click(await screen.findByRole("button", { name: "Account: Braden Seaborn" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Usage…" }));
    expect(onOpenSettings).toHaveBeenCalledWith("usage");
  });
});
