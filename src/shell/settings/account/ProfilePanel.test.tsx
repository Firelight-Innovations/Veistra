// @vitest-environment jsdom
/**
 * Settings → Account → Profile's photo: read with the account's token and
 * drawn in place of the initials, then changed and removed, against a
 * stubbed `account_call`. jsdom has no canvas, so `shrink` is stubbed too;
 * what reaches `account/set-avatar` is the point.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccountStatus, Me } from "../../account/account";

const bindings = vi.hoisted(() => ({ accountCall: vi.fn() }));
vi.mock("../../../bindings", () => ({ accountCall: bindings.accountCall }));
const picture = vi.hoisted(() => ({ shrink: vi.fn() }));
vi.mock("../../account/picture", () => picture);

import ProfilePanel from "./ProfilePanel";
import AccountMenu from "../../titlebar/AccountMenu";
import { NOT_A_PICTURE, resetAccountForTests } from "../../account/useAccount";

const status: AccountStatus = {
  configured: true,
  user: { name: "Braden Seaborn", email: "b@example.com" },
  waiting: null,
  outcome: null,
  ownSignIn: false,
};
const me = (avatar: string | null): Me => ({
  user: { id: "u1", email: "b@example.com", name: "Braden Seaborn", avatar },
  workspace: { id: "w1", name: "Personal workspace", plan: "beta" },
});
const STORED = "data:image/webp;base64,UklGRnN0b3JlZA==";
const PICKED = "data:image/webp;base64,UklGRnBpY2tlZA==";

function service(avatar: string | null, extra: Record<string, unknown> = {}) {
  bindings.accountCall.mockImplementation((method: string) => {
    if (method === "account/status") return Promise.resolve(status);
    if (method === "account/me") return Promise.resolve(me(avatar));
    if (method === "account/avatar") return Promise.resolve(avatar ? STORED : null);
    if (method in extra) return Promise.resolve(extra[method]);
    return Promise.reject({ code: -32601, message: `no ${method}` });
  });
}

const photo = () =>
  screen.getByText("Profile photo").closest(".setting")!.querySelector("img.k-avatar--photo");
const pick = (file = new File(["x"], "me.png", { type: "image/png" })) =>
  fireEvent.change(screen.getByLabelText("Profile photo file"), { target: { files: [file] } });

afterEach(() => {
  cleanup();
  bindings.accountCall.mockReset();
  picture.shrink.mockReset();
  resetAccountForTests();
});

describe("Settings → Account → Profile photo", () => {
  it("draws the photo the account has, in the panel and the title bar", async () => {
    service("3f9a2c41d0e8b7a6");
    render(
      <>
        <AccountMenu onOpenSettings={() => {}} />
        <ProfilePanel />
      </>,
    );
    await waitFor(() => expect(photo()?.getAttribute("src")).toBe(STORED));
    const avatar = screen.getByRole("button", { name: /^Account:/ }).querySelector("img");
    expect(avatar?.getAttribute("src")).toBe(STORED);
    expect(screen.getByRole("button", { name: "Change photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(bindings.accountCall.mock.calls.filter(([m]) => m === "account/avatar")).toHaveLength(1);
  });

  it("draws the initials and reads no photo when the account has none", async () => {
    service(null);
    render(<ProfilePanel />);
    await screen.findByRole("button", { name: "Add photo" });
    expect(photo()).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(bindings.accountCall).not.toHaveBeenCalledWith("account/avatar");
  });

  it("sends a picked file, shrunk, as base64, and draws it without reading it back", async () => {
    service(null, { "account/set-avatar": { avatar: "00000000000000aa" } });
    picture.shrink.mockResolvedValue(PICKED);
    render(<ProfilePanel />);
    await screen.findByRole("button", { name: "Add photo" });
    pick();
    await waitFor(() => expect(photo()?.getAttribute("src")).toBe(PICKED));
    expect(bindings.accountCall).toHaveBeenCalledWith("account/set-avatar", {
      image: "UklGRnBpY2tlZA==",
    });
    expect(bindings.accountCall).not.toHaveBeenCalledWith("account/avatar");
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("removes it, and the initials come back", async () => {
    service("3f9a2c41d0e8b7a6", { "account/remove-avatar": null });
    render(<ProfilePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await screen.findByRole("button", { name: "Add photo" });
    expect(bindings.accountCall).toHaveBeenCalledWith("account/remove-avatar");
    expect(photo()).toBeNull();
  });

  it("says so when the file is no picture, and sends nothing", async () => {
    service(null);
    picture.shrink.mockRejectedValue(new Error("decode"));
    render(<ProfilePanel />);
    await screen.findByRole("button", { name: "Add photo" });
    pick(new File(["%PDF"], "cv.pdf", { type: "application/pdf" }));
    expect((await screen.findByRole("alert")).textContent).toBe(NOT_A_PICTURE);
    expect(bindings.accountCall).not.toHaveBeenCalledWith("account/set-avatar", expect.anything());
  });

  it("shows the service's words when it refuses the picture", async () => {
    service(null);
    bindings.accountCall.mockImplementation((method: string) => {
      if (method === "account/status") return Promise.resolve(status);
      if (method === "account/me") return Promise.resolve(me(null));
      return Promise.reject({ code: -32603, message: "Send one of 128 KB or less." });
    });
    picture.shrink.mockResolvedValue(PICKED);
    render(<ProfilePanel />);
    await screen.findByRole("button", { name: "Add photo" });
    pick();
    expect((await screen.findByRole("alert")).textContent).toBe("Send one of 128 KB or less.");
    expect(photo()).toBeNull();
  });
});
