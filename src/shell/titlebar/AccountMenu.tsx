/**
 * The account's avatar at the right end of the title bar, before the window
 * controls, and the menu it opens: VS Code's Accounts menu, with the things
 * Veistra's account can actually do.
 *
 * Outside `TitleBarActions` on purpose. Those fold into one overflow button in
 * a narrow window; the avatar is who you are signed in as, which a narrow
 * window still needs to show, so it stays beside the window controls at every
 * width (`titlebarCollapse.test.ts`).
 *
 * Rows are the shared `MenuItemList`, in the overflow button's surface, so the
 * menu reads and dismisses like every other menu in the bar. Nothing here
 * invents an action: a row either calls `account/*` or opens a Settings page,
 * and a build with no account service sends Sign in to the page that says so.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MenuItem } from "../contract";
import { popover } from "../motion";
import MenuItemList from "../MenuItemList";
import Avatar from "../ui/Avatar";
import { accountCall } from "../../bindings";
import { accountState, displayName, initials, type AccountStatus } from "../account/account";
import { useAccount } from "../account/useAccount";
import { useMenuDismiss } from "./useMenuDismiss";

export interface AccountMenuActions {
  /** Open Settings on a page or section, or on its first page for `null`. */
  openSettings: (section: string | null) => void;
  signIn: () => void;
  cancelSignIn: () => void;
  signOut: () => void;
  openWeb: (page: "dashboard" | "usage") => void;
}

/** The button's accessible name: who is signed in, or just "Account". */
export function accountLabel(status: AccountStatus | null): string {
  return status?.user ? `Account: ${displayName(status.user)}` : "Account";
}

/** The menu's rows for where the person stands. Pure, so each state is tested. */
export function accountMenuItems(status: AccountStatus | null, a: AccountMenuActions): MenuItem[] {
  const state = accountState(status);
  const user = status?.user ?? null;
  const head: MenuItem[] = [];

  if (state === "signed-in" && user) {
    head.push({
      label: `${displayName(user)} (Veistra)`,
      submenu: [
        ...(user.name.trim() !== "" ? [{ label: user.email, disabled: true }] : []),
        { label: "Account settings…", onSelect: () => a.openSettings("account") },
        { label: "Manage on veistra.com", onSelect: () => a.openWeb("dashboard") },
        { label: "Sign out", onSelect: a.signOut, separatorBefore: true },
      ],
    });
  } else if (state === "waiting") {
    head.push(
      { label: "Waiting for the browser to approve…", disabled: true },
      { label: "Cancel sign-in", onSelect: a.cancelSignIn },
    );
  } else if (state === "signed-out") {
    head.push({ label: "Sign in…", onSelect: a.signIn });
  } else {
    // Not set up on this build, or not read yet: the Account page says which.
    head.push({ label: "Sign in…", onSelect: () => a.openSettings("account") });
  }

  return [
    ...head,
    { label: "Usage…", onSelect: () => a.openSettings("usage"), separatorBefore: true },
    { label: "Billing…", onSelect: () => a.openSettings("billing") },
    {
      label: "Settings",
      accelerator: "Ctrl+,",
      onSelect: () => a.openSettings(null),
      separatorBefore: true,
    },
  ];
}

/** The enabled top-level rows, in order, for the arrow keys. */
function rows(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter(
    (row) => !row.disabled,
  );
}

export default function AccountMenu({
  onOpenSettings,
}: {
  onOpenSettings: (section: string | null) => void;
}) {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useMenuDismiss(open, rootRef, close);

  // Focus moves into the menu as it opens, so the arrow keys work at once.
  useEffect(() => {
    if (open) rows(menuRef.current)[0]?.focus();
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      buttonRef.current?.focus();
      return;
    }
    const all = rows(menuRef.current);
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % all.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? all.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    if (next === null) return;
    e.preventDefault();
    all[next].focus();
  };

  const user = account.status?.user ?? null;
  const label = accountLabel(account.status);
  const items = accountMenuItems(account.status, {
    openSettings: onOpenSettings,
    signIn: () => void account.signIn(),
    cancelSignIn: () => void account.cancelSignIn(),
    signOut: () => void account.signOut(),
    openWeb: (page) => void accountCall("account/open-web", { page }).catch(() => {}),
  });

  return (
    <div className="overflowmenu accountmenu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="titlebar__icon accountmenu__button"
        aria-label={label}
        title={user ? `${displayName(user)} · ${user.email}` : label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar initials={user ? initials(user) : null} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            className="overflowmenu__dropdown accountmenu__dropdown"
            onKeyDown={onMenuKeyDown}
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
