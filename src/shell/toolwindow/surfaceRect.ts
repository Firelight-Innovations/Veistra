/** A surface's rect in the main window's own coordinates — what Tauri's
 * `add_child` and `set_position` take. Logical pixels throughout, matching
 * `getBoundingClientRect()`: neither side of this converts for DPI. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Turn a pane's container-relative rect into a window-relative one, for an app
 * whose native content Rust places directly onto the window rather than
 * drawing inside the iframe (`plane_webview` — see `placesWindow` in
 * `ToolWindow.tsx`).
 *
 * `containerOrigin` is `ToolWindow`'s own container, measured in the document
 * it is part of — the shell's top-level document, where `decorations: false`
 * (`tauri.conf.json`) means that document's coordinates already equal the
 * window's content area, with no native chrome to offset for. `paneRect` is
 * already container-relative (see `measure()` in `ToolWindow.tsx`), so this is
 * only addition, never a second measurement.
 */
export function windowRectOfPane(
  containerOrigin: { left: number; top: number },
  paneRect: { left: number; top: number; width: number; height: number },
): WindowRect {
  return {
    x: containerOrigin.left + paneRect.left,
    y: containerOrigin.top + paneRect.top,
    width: paneRect.width,
    height: paneRect.height,
  };
}

/** Whether two window rects agree closely enough to skip resending one — a
 * `getBoundingClientRect()` read is a float, and a pane that has not actually
 * moved can still read back a value a fraction of a pixel off from the last
 * one. */
export function sameWindowRect(a: WindowRect, b: WindowRect): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.width, b.width) && close(a.height, b.height);
}
