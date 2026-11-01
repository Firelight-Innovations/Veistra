/**
 * The product as a whole: no events of its own, one question about all of it.
 *
 * Launch-triggered rather than event-triggered, so it reaches somebody whatever
 * they use. Five launches and a week is after the first impression and before
 * habits set — the point where "what gets in your way" still has an answer.
 */
import { PRODUCT_NAME } from "../../../branding.generated";
import { defineFeature } from "../define";

export const general = defineFeature({
  id: "general",
  name: `${PRODUCT_NAME} in general`,
  events: [],
  prompts: [
    {
      id: "general/first-week",
      question: `How is ${PRODUCT_NAME} working for you so far?`,
      after: { launches: 5 },
      minDaysInstalled: 7,
    },
  ],
});
