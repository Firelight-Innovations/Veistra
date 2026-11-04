/**
 * The warning badge for tools that need an update, and its list.
 *
 * It used to sit at the right end of the cluster bar. That bar is gone, so it
 * is a title-bar control now, and it is drawn only while something is unhealthy
 * — the rest of the time it takes no width at all. In a narrow window it is a
 * row of the overflow menu instead (`TitleBarActions`). Whether a tool needs an
 * update is a property of the stack, not of the open cluster, so it reads
 * `healthOf` and nothing else.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { ToolHealth, ToolPresentation } from "../contract";
import { WarningTriangle } from "../../ui/Icon";
import HealthPopover, { type UnhealthyTool } from "./HealthPopover";

function isUnhealthy(tool: ToolPresentation): tool is UnhealthyTool {
  return tool.health !== ("ok" satisfies ToolHealth);
}

/** The tools the badge counts. Also what the overflow menu's health row lists. */
export function unhealthyTools(healthOf: ToolPresentation[]): UnhealthyTool[] {
  return healthOf.filter(isUnhealthy);
}

/** The badge's name, and the overflow menu row's label: one sentence for both. */
export function toolHealthLabel(count: number): string {
  return count === 1 ? "1 tool needs attention" : `${count} tools need attention`;
}

export default function ToolHealthBadge({
  healthOf,
  onRescan,
}: {
  healthOf: ToolPresentation[];
  onRescan: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const unhealthy = unhealthyTools(healthOf);

  // Dismiss like every other popover in the shell: a click outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (unhealthy.length === 0) return null;

  const label = toolHealthLabel(unhealthy.length);

  return (
    <div className="toolhealth" ref={wrapRef}>
      <button
        type="button"
        className="toolhealth__badge"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <WarningTriangle size={12} className="toolhealth__icon" />
        <span className="toolhealth__count">{unhealthy.length}</span>
      </button>
      <AnimatePresence>
        {open && (
          <HealthPopover
            tools={unhealthy}
            onRescan={() => {
              onRescan();
              setOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
