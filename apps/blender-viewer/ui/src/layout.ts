/**
 * Below this pane width the footer's secondary actions drop their labels. The
 * full row (export, auto, comments, three send/copy buttons, open) needed
 * about 880px; measured on the pane, not the window, because the viewer lives
 * in panes of any size. Open in Blender has since moved to the toolbar, so the
 * row is shorter and this errs early. It is left as measured rather than
 * guessed down: re-measure in a real pane before lowering it.
 */
export const COMPACT_FOOTER_BELOW = 920;

export function footerIsCompact(paneWidth: number): boolean {
  return paneWidth > 0 && paneWidth < COMPACT_FOOTER_BELOW;
}
