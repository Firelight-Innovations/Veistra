/**
 * The six menus collapsed into one button, <1180px.
 *
 * "Opens the same menu tree" — so this renders the same six `Menu` objects
 * `MenuBar` does, through the same `MenuItemList`, just reached through one
 * button and an accordion instead of six inline labels. Only the group
 * header a person just clicked is expanded at a time, which keeps a tree of
 * six menus' worth of items from turning into an unreadable single popover.
 *
 * The popover opening is the one animated moment (shared `popover` variants,
 * same as `MenuBar`). The accordion rows inside it are a plain conditional
 * render — animating those too would be a second, uncoordinated motion inside
 * the same gesture, which is exactly what `motion.ts` warns against.
 */
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Menu } from "../contract";
import { popover } from "../motion";
import MenuItemList from "../MenuItemList";
import Hamburger from "./icons/Hamburger";
import { useMenuDismiss } from "./useMenuDismiss";

export default function HamburgerMenu({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const closeAll = () => {
    setOpen(false);
    setExpanded(null);
  };

  useMenuDismiss(open, rootRef, closeAll);

  return (
    <div className="hamburger" ref={rootRef}>
      <button
        type="button"
        className="hamburger__button"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => (open ? closeAll() : setOpen(true))}
      >
        <Hamburger />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="hamburger__dropdown"
            initial={popover.initial}
            animate={popover.animate}
            exit={popover.exit}
          >
            {menus.map((menu) => (
              <div key={menu.label} className="hamburger__group">
                <button
                  type="button"
                  className="hamburger__group-label"
                  data-open={expanded === menu.label || undefined}
                  onClick={() => setExpanded((cur) => (cur === menu.label ? null : menu.label))}
                >
                  {menu.label}
                </button>
                {expanded === menu.label && (
                  <MenuItemList items={menu.items} onAfterSelect={closeAll} />
                )}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
