/**
 * The right-hand buttons collapsed into one, below `ACTIONS_COLLAPSE_BELOW`.
 *
 * The hamburger's counterpart on the other side of the bar (#336): one button,
 * and a popover holding the same actions as rows of the shared `MenuItemList`,
 * so a row reads and behaves like every other menu row in the shell, its
 * accelerator included. The window controls are never in it; they sit beside
 * it in `TitleBar`, outside anything that collapses.
 */
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Ellipsis } from "lucide-react";
import type { MenuItem } from "../contract";
import { popover } from "../motion";
import MenuItemList from "../MenuItemList";
import { useMenuDismiss } from "./useMenuDismiss";

export default function OverflowMenu({
  items,
  label,
  attention = false,
}: {
  items: MenuItem[];
  /** The button's accessible name, which says when something inside needs attention. */
  label: string;
  /** Draws a dot on the button: a row inside is a warning the bar would have shown. */
  attention?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useMenuDismiss(open, rootRef, close);

  return (
    <div className="overflowmenu" ref={rootRef}>
      <button
        type="button"
        className="titlebar__icon titlebar__overflow-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
        {attention && <span className="overflowmenu__dot" aria-hidden="true" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="overflowmenu__dropdown"
            initial={popover.initial}
            animate={popover.animate}
            exit={popover.exit}
          >
            <MenuItemList items={items} onAfterSelect={close} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
