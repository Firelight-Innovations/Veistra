import { describe, expect, it } from "vitest";
import {
  type AccountStatus,
  codeGroups,
  firstName,
  initials,
  minutesLeft,
  money,
  shortDate,
  showsSignIn,
  spentPercent,
} from "./account";

const signedOut: AccountStatus = {
  configured: true,
  user: null,
  waiting: null,
  outcome: null,
  ownSignIn: false,
};

describe("showsSignIn", () => {
  it("never stands in front of Home when the account service is not set up", () => {
    expect(showsSignIn({ ...signedOut, configured: false }, false)).toBe(false);
    expect(showsSignIn(null, false)).toBe(false);
  });

  it("shows for someone signed out who has not chosen their own sign-in", () => {
    expect(showsSignIn(signedOut, false)).toBe(true);
    expect(showsSignIn({ ...signedOut, ownSignIn: true }, false)).toBe(false);
  });

  it("stays up while a sign-in waits, and to show how one ended", () => {
    const waiting = {
      userCode: "KQ74MX",
      verificationUri: "https://veistra.com/device",
      verificationUriComplete: "https://veistra.com/device?code=KQ74MX",
      expiresAtMs: 0,
    };
    expect(showsSignIn({ ...signedOut, ownSignIn: true, waiting }, false)).toBe(true);
    expect(showsSignIn({ ...signedOut, ownSignIn: true, outcome: { kind: "denied" } }, false)).toBe(
      true,
    );
  });

  it("shows the signed-in state only right after signing in", () => {
    const user = { name: "Braden Seaborn", email: "b@example.com" };
    expect(showsSignIn({ ...signedOut, user }, true)).toBe(true);
    expect(showsSignIn({ ...signedOut, user }, false)).toBe(false);
  });
});

describe("formatting", () => {
  it("splits the code the way the approve page shows it", () => {
    expect(codeGroups("KQ74MX")).toEqual(["KQ7", "4MX"]);
    expect(codeGroups("kq7-4mx")).toEqual(["KQ7", "4MX"]);
  });

  it("counts minutes left up, and never below zero", () => {
    expect(minutesLeft(600_000, 0)).toBe(10);
    expect(minutesLeft(61_000, 0)).toBe(2);
    expect(minutesLeft(0, 5_000)).toBe(0);
  });

  it("prints micro-dollars as dollars and cents", () => {
    expect(money(18_400_000)).toBe("$18.40");
    expect(money(0)).toBe("$0.00");
  });

  it("caps the meter at the limit", () => {
    const limit = {
      monthly_limit_micros: 50_000_000,
      spent_this_period_micros: 18_400_000,
      alert_pct: 80,
      pause_at_limit: true,
      projected_date: null,
    };
    expect(spentPercent(limit)).toBeCloseTo(36.8);
    expect(spentPercent({ ...limit, spent_this_period_micros: 90_000_000 })).toBe(100);
  });

  it("reads a projected date as a calendar day in any time zone", () => {
    expect(shortDate("2026-11-14")).toBe("Nov 14");
  });

  it("names people by initials and first name", () => {
    const user = { name: "Braden Seaborn", email: "b@example.com" };
    expect(initials(user)).toBe("BS");
    expect(firstName(user)).toBe("Braden");
    expect(initials({ name: "", email: "b@example.com" })).toBe("B");
  });
});
