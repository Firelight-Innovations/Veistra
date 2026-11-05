import { motion } from "framer-motion";
import { BootArc } from "../../ui/Icon";
import { spinArc } from "../motion";
import { accelerator } from "../accelerators";

/** Optional step signal. No backend reports this yet, but the shape is ready
 * for when one does: it adds a "step n of m" line under the title. */
export interface BootProgress {
  step: number;
  total: number;
}

/**
 * The boot overlay: laid over the tool window while a tool is starting.
 * Measured from the "Starting Forger" crop (docs/handoffs/shell-spec.html,
 * REGION DETAIL — "Panel, search, warnings, booting").
 *
 * One indicator, the spinning arc. There used to be a progress bar under the
 * title as well, and two indicators for one wait read as two things loading.
 * The arc is the progressbar for assistive tech; it carries no value because
 * no backend reports one, only `aria-valuetext` once a step is known.
 */
export default function BootOverlay({
  toolName,
  progress,
}: {
  toolName: string;
  progress?: BootProgress;
}) {
  return (
    <div className="boot">
      <div className="boot__inset" />
      <div className="boot__column">
        {/* The arc rotates continuously; the track circle doesn't — but it's
            a perfect circle with uniform stroke, so rotating the whole SVG
            reads identically to rotating only the arc. */}
        <motion.div
          className="boot__arc"
          role="progressbar"
          aria-label={`Starting ${toolName}`}
          aria-valuetext={progress ? `step ${progress.step} of ${progress.total}` : undefined}
          animate={{ rotate: 360 }}
          transition={spinArc}
        >
          <BootArc />
        </motion.div>
        <div className="boot__title">Starting {toolName}</div>
        {progress && (
          <div className="boot__step">
            step {progress.step} of {progress.total}
          </div>
        )}
        <div className="boot__cancel">cancel {accelerator({ key: "." })}</div>
      </div>
    </div>
  );
}
