/**
 * The item tree shared by both menu surfaces.
 *
 * The inline menu bar's dropdown and the hamburger's accordion render the same
 * `MenuItem[]` the same way — one list component rather than two, so the two
 * responsive states can never drift into showing different trees for the same
 * menu.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { popover } from "./motion";
import { ChevronRight } from "../ui/Icon";
import type { MenuItem, MenuPrompt } from "./contract";
import "./menuItemList.css";

/**
 * Marks every portalled menu surface, so the three hosts can tell "the pointer
 * went outside my menu" from "the pointer went into a part of my menu that is
 * not inside my DOM subtree".
 *
 * Each host dismisses on a `pointerdown` it does not recognise, and each finds
 * its own boxes with `contains` — which a portalled child is not in. Without
 * this the very click meant to choose a submenu item would unmount the submenu
 * on `pointerdown`, and the `click` that followed would land on nothing. That is
 * the same failure `AddAppButton`'s own `menuRef` check exists to prevent, one
 * level deeper.
 */
const MENU_SURFACE_ATTR = "data-menu-surface";

/** Whether a pointer event landed inside a portalled menu surface. */
export function inMenuSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${MENU_SURFACE_ATTR}]`) !== null;
}

/**
 * The submenu's narrowest width, in one place because two things need it: the
 * surface itself, and the arithmetic that decides whether it fits to the right.
 * 200px is `.menubar__dropdown`'s `min-width` — this is the same list of rows,
 * in the same typeface, at the same padding.
 */
const SUBMENU_MIN_WIDTH = 200;

/**
 * The name field's surface is wider than a submenu's, and `Beside` has to be
 * told which — the flip-to-the-left arithmetic decides whether a surface fits on
 * the right *before* it exists to be measured, so it works from a declared width
 * rather than a measured one. A prompt that flipped on a submenu's number would
 * hang 84px off the edge of the window at exactly the moment it was asked to
 * avoid doing so.
 *
 * 260px of field plus `.menu-prompt`'s 12px of padding on each side.
 */
const PROMPT_WIDTH = 284;

/** Keeps a portalled surface off the window edges. Matches `AddAppButton`. */
const EDGE_GAP = 8;

export default function MenuItemList({
  items,
  onAfterSelect,
}: {
  items: MenuItem[];
  onAfterSelect: () => void;
}) {
  // One value for both kinds of open row, because a menu shows one at a time.
  // Keyed by the same `label-index` the rows are keyed by, so two rows sharing a
  // label — which nothing produces today, but a preset named "Save" would —
  // cannot open each other.
  //
  // Two rows are no longer plain buttons — one opens a submenu, one opens a text
  // field — and both of those are *open or closed*, which is state. It lives here
  // rather than in each of the three surfaces that render this list, because all
  // three would otherwise need identical copies of it and the whole point of one
  // list component is that they do not have to agree about anything. At most one
  // of either is open at a time, so the two share one `openLabel`: opening the
  // second closes the first, which is what a menu does.
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <ul className="menu-list" role="menu">
      {items.map((item, i) => {
        const key = `${item.label}-${i}`;
        const branch = item.submenu !== undefined || item.prompt !== undefined;

        // `hint` rides on the `<li>` rather than the button for the reason the
        // contract gives: a `disabled` button takes no pointer events, so a
        // `title` on it would be readable on precisely the items that never
        // need explaining.
        return (
          <li key={key} role="none" title={item.hint}>
            {item.separatorBefore && <div className="menu-list__separator" role="separator" />}
            <MenuRow
              item={item}
              open={openKey === key}
              // A branch toggles; a leaf acts and closes the whole menu. Written
              // as one component with two behaviours rather than two components,
              // so the row's appearance cannot drift between them.
              onActivate={() => {
                if (branch) {
                  setOpenKey((current) => (current === key ? null : key));
                  return;
                }
                item.onSelect?.();
                onAfterSelect();
              }}
              onClose={() => setOpenKey(null)}
              onAfterSelect={onAfterSelect}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One row: a leaf that acts and closes the menu, or a branch that opens a
 * surface beside it.
 *
 * An item that cannot act is `disabled: true` — a real native `disabled`
 * button, which neither fires `onSelect` nor closes the menu, because a click
 * that lands on a control with nothing to do should not read as having done
 * something. That is the only inert state left worth having: no row in the
 * menus has gone without an `onSelect` since Help ▸ Documentation began
 * opening Docs.
 */
function MenuRow({
  item,
  open,
  onActivate,
  onClose,
  onAfterSelect,
}: {
  item: MenuItem;
  open: boolean;
  onActivate: () => void;
  onClose: () => void;
  onAfterSelect: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const branch = item.submenu !== undefined || item.prompt !== undefined;

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        className="menu-list__item"
        disabled={item.disabled}
        aria-haspopup={branch ? "menu" : undefined}
        aria-expanded={branch ? open : undefined}
        data-open={open || undefined}
        onClick={onActivate}
      >
        <span className="menu-list__label">{item.label}</span>
        {item.accelerator && <span className="menu-list__accel">{item.accelerator}</span>}
        {/* The caret is the only thing on the row that says it opens rather than
            acts, so it is drawn for a prompt too — the field is a surface that
            appears beside the row exactly as a submenu does. */}
        {branch && <ChevronRight size={10} className="menu-list__caret" />}
      </button>

      {open && item.submenu && (
        <Beside anchor={rowRef} width={SUBMENU_MIN_WIDTH} onEscape={onClose}>
          <MenuItemList items={item.submenu} onAfterSelect={onAfterSelect} />
        </Beside>
      )}

      {open && item.prompt && (
        <Beside anchor={rowRef} width={PROMPT_WIDTH} onEscape={onClose}>
          <PromptField prompt={item.prompt} onDone={onAfterSelect} />
        </Beside>
      )}
    </>
  );
}

/**
 * A surface portalled beside a row, flipping to its left when the right is full.
 *
 * All three hosts clip — `.menubar__dropdown` and `.addapp__menu` are both
 * `overflow: hidden`, and `.addapp__menu` additionally lives under a bar whose
 * `.switcher__tabs` is a horizontal scroll container, the problem that file's
 * header describes at length — so a submenu drawn inside one would be cut off at
 * the parent's edge. The container is `document.body` always, never a moving
 * element, so the remount-on-container-change hazard `ToolWindow` and `PaneTree`
 * document does not arise — and there is no iframe in a menu to reload if it did.
 *
 * Measured once, on open, from the row's own rectangle — and *after* layout,
 * with `useLayoutEffect`, so the first painted frame is already in the right
 * place rather than jumping there. Anything that could invalidate the
 * measurement is not chased: the hosts already close their whole menu on a
 * resize, a scroll, or focus leaving the window.
 */
function Beside({
  anchor,
  width,
  onEscape,
  children,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  /** Declared rather than measured — see `PROMPT_WIDTH`. */
  width: number;
  onEscape: () => void;
  children: React.ReactNode;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const fits = rect.right + width + EDGE_GAP <= window.innerWidth;
    setAt({
      // Lifted by the surface's own top padding, so the first row of the
      // submenu sits level with the row that opened it rather than one below.
      top: Math.max(EDGE_GAP, rect.top - 6),
      left: fits ? rect.right + 2 : Math.max(EDGE_GAP, rect.left - width - 2),
    });
  }, [anchor, width]);

  // A second pass, once the surface exists and has a height to measure.
  //
  // The horizontal flip above can be decided before the surface is drawn
  // because its width is declared; its *height* is however many rows there
  // happen to be, and a submenu opened from a row near the bottom of a short
  // window would run off the end with its last rows unreachable. This only ever
  // moves it up, and settles in one further pass — `offsetHeight` is the layout
  // box and so is unaffected by the entry animation's transform, which means the
  // corrected position measures clean and the effect returns.
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el || !at) return;
    const overflow = at.top + el.offsetHeight - (window.innerHeight - EDGE_GAP);
    if (overflow <= 0) return;
    setAt({ ...at, top: Math.max(EDGE_GAP, at.top - overflow) });
  }, [at]);

  // Escape closes this surface and stops there, rather than falling through to
  // the host's own listener and closing the entire menu. Backing out of a
  // submenu should leave you in the menu you opened it from.
  //
  // Capture on `document`, which is above all three hosts' listeners — two are
  // on `window` and one is on `document`, all bubbling — so this is the one
  // registration order that beats every one of them without depending on which
  // component mounted first. It is also above the field inside this surface,
  // which is why `PromptField` has no Escape handler of its own: it would never
  // run.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onEscape]);

  return createPortal(
    <AnimatePresence>
      {at && (
        <motion.div
          ref={surfaceRef}
          className="menu-list__beside"
          // See `MENU_SURFACE_ATTR`: this is what keeps the three hosts from
          // reading a click in here as a click outside their menu.
          {...{ [MENU_SURFACE_ATTR]: "" }}
          style={{ top: at.top, left: at.left, minWidth: width }}
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * One line of text and a button, with room under it for the reason it was
 * refused.
 *
 * The refusal is shown rather than logged because it is an answer to what was
 * just typed — "that name is one of Veistra's own" is only useful next to the
 * field holding that name. On success the whole menu closes, which is the
 * acknowledgement: the thing you asked for happened and there is nothing left to
 * confirm.
 */
function PromptField({ prompt, onDone }: { prompt: MenuPrompt; onDone: () => void }) {
  const [value, setValue] = useState(prompt.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focused and selected on open, so the suggested name can be taken with Enter
  // or replaced by typing — neither of which should cost a click first.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    prompt
      .onSubmit(value)
      .then(onDone)
      .catch((err: unknown) => {
        // Rust's `AppError` serializes to its message and arrives as a bare
        // string; anything else is a fault rather than a refusal and still has
        // to say *something* under the field, or the button would look broken.
        setError(typeof err === "string" ? err : String(err));
        setSaving(false);
        inputRef.current?.focus();
      });
  };

  return (
    <form
      className="menu-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="menu-prompt__label" htmlFor="menu-prompt-field">
        {prompt.label}
      </label>
      <input
        id="menu-prompt-field"
        ref={inputRef}
        className="menu-prompt__field"
        value={value}
        placeholder={prompt.placeholder}
        disabled={saving}
        onChange={(e) => {
          setValue(e.target.value);
          // The reason stops applying the moment the name it was about changes.
          if (error !== null) setError(null);
        }}
        // No Escape handler: `Beside` takes it in the capture phase, above this
        // element, and closes the surface. A second one here would be a handler
        // that can never run.
      />
      {error !== null && <p className="menu-prompt__error">{error}</p>}
      <button
        type="submit"
        className="menu-prompt__confirm"
        disabled={saving || value.trim() === ""}
      >
        {prompt.confirmLabel}
      </button>
    </form>
  );
}
