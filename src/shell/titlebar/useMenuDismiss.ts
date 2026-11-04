/**
 * How a title-bar menu closes: a press outside it, Escape, or focus leaving
 * this document. Shared by the hamburger and the overflow button, which close
 * the same way for the same reasons.
 */
import { useEffect, useRef, type RefObject } from "react";
import { inMenuSurface } from "../MenuItemList";

export function useMenuDismiss(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  // The latest `close`, so the listeners are added once per opening rather
  // than again on every render the open menu goes through.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      // A submenu is portalled out of this subtree, so `contains` calls a click
      // inside it a click outside the menu. See `inMenuSurface`, and `MenuBar`'s
      // copy of this guard for what missing it costs.
      if (inMenuSurface(e.target)) return;
      if (!rootRef.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    // Focus leaving this document closes it, for the reason `MenuBar`'s copy of
    // this spells out: a click inside an app's iframe never reaches the shell's
    // `window`, so `onPointerDown` alone cannot see most of the window.
    const onBlur = () => closeRef.current();

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, rootRef]);
}
