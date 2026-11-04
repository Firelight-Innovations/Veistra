/** The Split view's divider: its buttons move it this far, within these bounds. */
export const SPLIT_STEP = 0.15;
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

/** "Show more of B" moves the divider left; "Show more of A", right. */
export function nudgeSplit(split: number, towards: "a" | "b"): number {
  const next = towards === "b" ? split - SPLIT_STEP : split + SPLIT_STEP;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next)) * 100) / 100;
}
