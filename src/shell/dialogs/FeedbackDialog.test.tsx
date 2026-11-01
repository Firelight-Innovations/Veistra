// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeedbackDraft } from "../telemetry/feedback";

const submitFeedback = vi.fn<(draft: FeedbackDraft) => Promise<void>>();
const githubOpenInBrowser = vi.fn<(url: string) => Promise<void>>();

vi.mock("../../bindings", () => ({
  githubOpenInBrowser: (url: string) => githubOpenInBrowser(url),
}));
vi.mock("../telemetry/feedback", async (original) => ({
  ...(await original<typeof import("../telemetry/feedback")>()),
  submitFeedback: (draft: FeedbackDraft) => submitFeedback(draft),
}));

const { default: FeedbackDialog } = await import("./FeedbackDialog");

beforeEach(() => {
  vi.clearAllMocks();
  submitFeedback.mockResolvedValue(undefined);
  githubOpenInBrowser.mockResolvedValue(undefined);
});
afterEach(cleanup);

function draw(over: Partial<Parameters<typeof FeedbackDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <FeedbackDialog
      request={{ source: "help-menu", feature: null }}
      delivery="with-session"
      blockedBecause={null}
      onClose={onClose}
      {...over}
    />,
  );
  return { onClose };
}

describe("FeedbackDialog", () => {
  it("will not send an empty message", () => {
    draw();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("sends what was typed, about what was chosen, and thanks the person", async () => {
    draw({ request: { source: "agent-menu", feature: "agent-tab" } });
    fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Let me pin a tab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/on its way/);
    expect(submitFeedback).toHaveBeenCalledWith({
      source: "agent-menu",
      feature: "agent-tab",
      kind: "idea",
      message: "Let me pin a tab",
      contact: undefined,
    });
  });

  it("keeps the message and shows why when sending fails", async () => {
    submitFeedback.mockRejectedValue(new Error("The feedback service answered 503."));
    draw();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Broken" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("503");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Broken");
  });

  it("says when only the message will go", () => {
    draw({ delivery: "alone" });
    expect(screen.getByText(/Usage data is off, so only this message/)).toBeTruthy();
  });

  it("offers the issue tracker in a build that cannot send", async () => {
    const { onClose } = draw({ delivery: "nowhere", blockedBecause: "No key in this build." });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByText(/No key in this build\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open an issue…" }));
    await waitFor(() => expect(githubOpenInBrowser).toHaveBeenCalledTimes(1));
    expect(githubOpenInBrowser.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/.+\/issues$/);
    expect(onClose).toHaveBeenCalled();
  });
});
