/**
 * Agent tabs: a coding agent in the cluster's worktree.
 *
 * `prompt_sent` is reported by the app itself, through `veistra/track`, from
 * the one function every prompt leaves by (`apps/agent-tab/ui/src/rpc.ts`).
 * Its properties are the choices around the prompt, never the prompt.
 */
import { defineFeature } from "../define";

export const agentTab = defineFeature({
  id: "agent-tab",
  name: "Agent tabs",
  apps: ["agent-tab"],
  events: ["prompt_sent"],
  prompts: [
    {
      id: "agent-tab/first-impressions",
      question: "How well are agent tabs working for you?",
      after: { event: "prompt_sent", count: 15 },
      minDaysInstalled: 2,
    },
  ],
});
