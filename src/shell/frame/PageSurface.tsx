import { useEffect, type ReactNode } from "react";
import { motion, useMotionValue, type MotionValue } from "framer-motion";

export type PageMode = "docked" | "expanded";

/**
 * The one surface a rail page lives on, docked or expanded.
 *
 * Opening, closing and a dock/expand toggle are instant: the page is at its
 * final geometry and paint on the frame it mounts, and gone on the frame it
 * closes. Nothing slides out of the rail or tucks back into it, so panes and
 * the app iframe only ever measure a settled layout. It stays mounted across a
 * dock/expand toggle (the mode is a prop, not a key) so the iframe host inside
 * is never remounted.
 */
export default function PageSurface({
  mode,
  width,
  children,
}: {
  mode: PageMode;
  /** The docked width motion value; ignored while expanded. */
  width: MotionValue<number>;
  children: ReactNode;
}) {
  // Its own motion value, never swapped for a plain style: framer keeps the
  // last inline width when a bound value is replaced or removed, so an
  // expanded page stayed at the docked 380px.
  const boxWidth = useMotionValue<number | string>(mode === "docked" ? width.get() : "auto");
  useEffect(() => {
    if (mode !== "docked") {
      boxWidth.set("auto");
      return;
    }
    boxWidth.set(width.get());
    return width.on("change", (w) => boxWidth.set(w));
  }, [mode, width, boxWidth]);

  return (
    <motion.div
      className={mode === "docked" ? "frame__page" : "frame__page-expanded"}
      data-region={mode === "docked" ? "page" : "page-expanded"}
      style={{ width: boxWidth }}
    >
      {children}
    </motion.div>
  );
}
