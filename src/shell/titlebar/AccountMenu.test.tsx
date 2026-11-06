// @vitest-environment jsdom
/**
 * The title bar's avatar: what it draws and is named in each account state,
 * which rows its menu has, and the keys that move through and close it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatUserCode, minutesLeft, type AccountStatus } from "../account/account";

const bindings = vi.hoisted(() => ({ accountCall: vi.fn() }));
vi.mock("../../bindings", () => ({ accountCall: bindings.accountCall }));

import AccountMenu, {
  accountLabel,
  accountMenuItems,
  type AccountMenuActions,
} from "./AccountMenu";
import { refreshAccount, resetAccountForTests } from "../account/useAccount";
import SignInCodeHost from "../account/SignInCodeDialog";

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
    showCode: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
    openWeb: vi.fn(),
  };
}

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

  it("offers the code and a cancel while a sign-in waits for the browser", () => {
    const a = actions();
    const items = accountMenuItems(waiting, a);
    expect(items.slice(0, 2).map((i) => i.label)).toEqual(["Show sign-in code…", "Cancel sign-in"]);
    items[0].onSelect?.();
    expect(a.showCode).toHaveBeenCalled();
    items[1].onSelect?.();
    expect(a.cancelSignIn).toHaveBeenCalled();
  });

  it("prints the code in the two halves the approval page shows", () => {
    expect(formatUserCode("YB2-4BR")).toBe("YB2-4BR");
    expect(formatUserCode("yb24br")).toBe("YB2-4BR");
    expect(formatUserCode("ABCD 1234")).toBe("ABCD-1234");
    expect(formatUserCode("AB12")).toBe("AB12");
  });

  it("counts the code's minutes up, and never below zero", () => {
    expect(minutesLeft(10 * 60_000, 0)).toBe(10);
    expect(minutesLeft(61_000, 0)).toBe(2);
    expect(minutesLeft(0, 5_000)).toBe(0);
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

  it("sends a sign-in that could not start to the Account page, which says why", async () => {
    bindings.accountCall.mockImplementation((method: string) =>
      method === "account/status"
        ? Promise.resolve(base)
        : Promise.reject({
            code: -32603,
            message: "Could not reach the Veistra account service.",
            data: { reason: "unreachable" },
          }),
    );
    const onOpenSettings = vi.fn();
    render(<AccountMenu onOpenSettings={onOpenSettings} />);
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in…" }));
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("account"));
  });

  it("stays put when the sign-in starts", async () => {
    bindings.accountCall.mockImplementation((method: string) =>
      Promise.resolve(method === "account/sign-in" ? waiting : base),
    );
    const onOpenSettings = vi.fn();
    render(<AccountMenu onOpenSettings={onOpenSettings} />);
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in…" }));
    await waitFor(() => expect(bindings.accountCall).toHaveBeenCalledWith("account/sign-in"));
    await act(async () => {});
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  // The menu and the dialog together, as the window mounts them.
  const both = () =>
    render(
      <>
        <AccountMenu onOpenSettings={() => {}} />
        <SignInCodeHost />
      </>,
    );
  const dialog = () => screen.queryByRole("dialog", { name: "Sign-in code" });

  it("puts the code the browser asks about in a dialog once a sign-in starts", async () => {
    bindings.accountCall.mockImplementation((method: string) =>
      Promise.resolve(method === "account/sign-in" ? waiting : base),
    );
    both();
    expect(screen.queryByRole("button", { name: /^Sign-in code/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in…" }));

    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(screen.getByRole("group", { name: "Code A B C D - 1 2 3 4" })).toBeTruthy();
    // The browser opening takes focus from the window; the dialog stays.
    fireEvent.blur(window);
    expect(dialog()).not.toBeNull();
  });

  it("hides without cancelling, and comes back from the code in the title bar", async () => {
    answer(waiting);
    both();
    fireEvent.click(await screen.findByRole("button", { name: /^Sign-in code/ }));
    expect(dialog()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(bindings.accountCall).not.toHaveBeenCalledWith("account/cancel-sign-in");
    const chip = screen.getByRole("button", { name: /^Sign-in code/ });
    expect(chip.textContent).toContain("ABCD-1234");

    fireEvent.click(chip);
    expect(dialog()).not.toBeNull();
  });

  it("hides on Escape without the Escape reaching the page behind it", async () => {
    answer(waiting);
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    both();
    fireEvent.click(await screen.findByRole("button", { name: /^Sign-in code/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener("keydown", behind);
  });

  it("copies the approval page's address for a browser that did not open", async () => {
    answer(waiting);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    both();
    fireEvent.click(await screen.findByRole("button", { name: /^Sign-in code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy sign-in link" }));
    expect(writeText).toHaveBeenCalledWith("https://veistra.com/device?code=ABCD1234");
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
  });

  it("closes by itself when the sign-in finishes", async () => {
    answer(waiting);
    both();
    fireEvent.click(await screen.findByRole("button", { name: /^Sign-in code/ }));
    expect(dialog()).not.toBeNull();
    answer(signedIn);
    await act(async () => refreshAccount());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.queryByRole("button", { name: /^Sign-in code/ })).toBeNull();
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
