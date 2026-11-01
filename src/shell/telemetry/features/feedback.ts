/**
 * The feedback system reporting on itself: how often the dialog is opened,
 * and what happens to a prompt once it is on screen.
 *
 * `submitted` is the one that carries what the person wrote. The other three
 * are what make a response rate computable — prompts shown against prompts
 * answered — without which every rating is a number with no denominator.
 */
import { defineFeature } from "../define";

export const feedback = defineFeature({
  id: "feedback",
  name: "Sending feedback",
  events: ["dialog_opened", "submitted", "prompt_shown", "prompt_dismissed"],
});
