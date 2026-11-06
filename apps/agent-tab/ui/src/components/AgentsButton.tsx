import { Network } from "lucide-react";
import type { AgentsButtonProps } from "./types";
import "./details.css";

/** "2 agents running", in the composer's toolbar; opens the agent map. */
export function AgentsButton({ label, running, onClick }: AgentsButtonProps) {
  return (
    <button
      type="button"
      className="at-agents-button"
      data-running={running ? "" : undefined}
      onClick={onClick}
    >
      <Network size={13} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
