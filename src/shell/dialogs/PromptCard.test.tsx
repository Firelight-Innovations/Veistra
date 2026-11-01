// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defineFeature } from "../telemetry/define";
import type { PromptRef } from "../telemetry/registry";

const answerPrompt =
  vi.fn<(ref: PromptRef, answer: { rating?: number; message: string }) => Promise<void>>();
const dismissPrompt = vi.fn<(ref: PromptRef) => void>();

vi.mock("../telemetry/pipeline", () => ({
  answerPrompt: (ref: PromptRef, answer: { rating?: number; message: string }) =>
    answerPrompt(ref, answer),
  dismissPrompt: (ref: PromptRef) => dismissPrompt(ref),
}));

const { default: PromptCard } = await import("./PromptCard");

const canvas = defineFeature({ id: "canvas", name: "Canvas", events: ["drawn"] });
const RATING: PromptRef = {
  feature: canvas,
  prompt: { id: "canvas/a", question: "How is drawing?", after: { event: "drawn", count: 1 } },
};
const TEXT: PromptRef = { ...RATING, prompt: { ...RATING.prompt, kind: "text" } };

beforeEach(() => {
  vi.clearAllMocks();
  answerPrompt.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("PromptCard", () => {
  it("asks for a rating first, then offers a comment, then sends both", () => {
    render(<PromptCard prompt={RATING} onStopAsking={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "How is drawing?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
      target: { value: "Snapping is great" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(answerPrompt).toHaveBeenCalledWith(RATING, { rating: 4, message: "Snapping is great" });
  });

  it("takes no focus when it appears", () => {
    render(<PromptCard prompt={RATING} onStopAsking={vi.fn()} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("is the comment alone for a text prompt", () => {
    render(<PromptCard prompt={TEXT} onStopAsking={vi.fn()} />);
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
      target: { value: "More shapes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(answerPrompt).toHaveBeenCalledWith(TEXT, { rating: undefined, message: "More shapes" });
  });

  it("dismisses on close, and stops all prompts on request", () => {
    const onStopAsking = vi.fn();
    render(<PromptCard prompt={RATING} onStopAsking={onStopAsking} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(dismissPrompt).toHaveBeenCalledWith(RATING);
    expect(onStopAsking).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Don't ask me again" }));
    expect(onStopAsking).toHaveBeenCalledTimes(1);
    expect(dismissPrompt).toHaveBeenCalledTimes(2);
  });
});
