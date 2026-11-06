/**
 * The settings sidebar: who is signed in, the search, the pages in their
 * three bands, and the Docs link pinned at the bottom, which opens the Docs app.
 *
 * The nav *selects* a page rather than scrolling one long column: each page is
 * short enough to read whole, and a search is what reaches across them.
 */
import type { RefObject } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  ChartColumn,
  Cloud,
  Code,
  CreditCard,
  GitBranch,
  LayoutGrid,
  Plug,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Avatar from "../ui/Avatar";
import { initials, planLabel } from "../account/account";
import { useAccount } from "../account/useAccount";
import { openDocs } from "../docsSurface";
import { closeSettings } from "../settingsSurface";
import type { Page } from "./pages";
import type { SettingsSession } from "./useSettings";

const ICONS: Record<string, LucideIcon> = {
  account: UserRound,
  billing: CreditCard,
  usage: ChartColumn,
  general: SlidersHorizontal,
  editor: Code,
  terminal: SquareTerminal,
  agents: Bot,
  mcp: Plug,
  apps: LayoutGrid,
  "source-control": GitBranch,
  cloud: Cloud,
  developer: Wrench,
};

export default function SettingsNav({
  pages,
  current,
  filter,
  onFilter,
  onPick,
  session,
  searchRef,
}: {
  pages: Page[];
  current: string;
  filter: string;
  onFilter: (next: string) => void;
  onPick: (page: string) => void;
  session: SettingsSession;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const account = useAccount();
  const user = account.status?.user ?? null;
  const filtering = filter.trim() !== "";
  const bands = [0, 1, 2].map((band) => pages.filter((p) => p.band === band));

  return (
    <nav className="settings__nav" aria-label="Settings pages">
      <button type="button" className="settings__account" onClick={() => onPick("account")}>
        <Avatar
          initials={user ? initials(user) : null}
          src={user ? account.picture : null}
          size={28}
        />
        <span className="settings__account-text">
          <span className="settings__account-email">{user ? user.email : "Not signed in"}</span>
          <span className="settings__account-plan">
            {user ? `${planLabel(account.me?.workspace.plan)} plan` : "Sign in to Veistra"}
          </span>
        </span>
      </button>

      <label className="settings__search">
        <Search size={14} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          className="settings__search-input"
          placeholder="Search settings"
          aria-label="Search settings"
          aria-keyshortcuts="Control+F"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={(e) => {
            // The first Escape clears the search; the next one closes the screen.
            if (e.key === "Escape" && filter !== "") {
              e.stopPropagation();
              onFilter("");
            }
          }}
        />
        <kbd className="settings__search-hint">Ctrl+F</kbd>
      </label>

      <div className="settings__nav-list" data-dimmed={filtering || undefined}>
        {bands.map((band, i) =>
          band.length === 0 ? null : (
            <div className="settings__nav-band" key={i} role="group">
              {band.map((page) => {
                const Icon = ICONS[page.id] ?? LayoutGrid;
                const changed = page.sections.reduce(
                  (n, s) => n + (s.group ? session.changedIn(s.group) : 0),
                  0,
                );
                const selected = !filtering && page.id === current;
                return (
                  <button
                    key={page.id}
                    type="button"
                    className="settings__nav-item"
                    aria-current={selected ? "page" : undefined}
                    data-current={selected || undefined}
                    onClick={() => onPick(page.id)}
                  >
                    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="settings__nav-title">{page.title}</span>
                    {changed > 0 && (
                      <span
                        className="k-badge k-badge--count"
                        title={`${changed} changed from the default`}
                      >
                        {changed}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ),
        )}
      </div>

      <div className="settings__nav-foot">
        {/* The Docs app, as Help ▸ Documentation opens it. Settings shuts
            first, or the modal would sit over the page it just opened. */}
        <button
          type="button"
          className="settings__nav-item"
          onClick={() => {
            closeSettings();
            openDocs();
          }}
          aria-label="Docs"
        >
          <BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="settings__nav-title">Docs</span>
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
