/**
 * Which feedback surface is up in this window: the dialog, the corner card,
 * both, or neither — and the calls that change that.
 *
 * A module rather than state in `App`, for `settingsSurface.ts`'s reason: the
 * callers are a menu in the title bar, a row in the agent menu, a button in
 * settings and a message from an app frame, and none of them is a parent of
 * the component that draws the dialog.
 */
import { useEffect, useState } from "react";
import { feedback } from "./features";
import type { FeedbackSource } from "./feedback";
import type { PromptRef } from "./registry";

export interface FeedbackRequest {
  source: FeedbackSource;
  /** What to preselect in the dialog's "About" list; `null` for overall. */
  feature: string | null;
}

export interface FeedbackSurface {
  dialog: FeedbackRequest | null;
  prompt: PromptRef | null;
}

let surface: FeedbackSurface = { dialog: null, prompt: null };
const subscribers = new Set<(surface: FeedbackSurface) => void>();

function announce(next: FeedbackSurface): void {
  surface = next;
  for (const subscriber of subscribers) subscriber(surface);
}

/** Open the dialog. Opening it again replaces what it was opened about. */
export function openFeedback(request: FeedbackRequest): void {
  feedback.track("dialog_opened", { source: request.source, about: request.feature });
  announce({ ...surface, dialog: request });
}

/** Safe to call when it is already closed. */
export function closeFeedback(): void {
  if (surface.dialog) announce({ ...surface, dialog: null });
}

/** Put a prompt in the corner. The pipeline decides when; this only draws. */
export function showPrompt(ref: PromptRef): void {
  announce({ ...surface, prompt: ref });
}

export function closePrompt(): void {
  if (surface.prompt) announce({ ...surface, prompt: null });
}

/** The current value, for code that is not a component. */
export function currentSurface(): FeedbackSurface {
  return surface;
}

export function useFeedbackSurface(): FeedbackSurface {
  const [current, setCurrent] = useState(surface);
  useEffect(() => {
    subscribers.add(setCurrent);
    setCurrent(surface);
    return () => {
      subscribers.delete(setCurrent);
    };
  }, []);
  return current;
}
