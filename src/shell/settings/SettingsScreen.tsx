import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import SettingRow from "./SettingRow";
import SettingsNav from "./SettingsNav";
import SettingsSection, { SectionsContext, type SectionsState } from "./SettingsSection";
import McpPanel from "./McpPanel";
import CloudAccountPanel from "./CloudAccountPanel";
import BuiltInSkillsPanel from "./BuiltInSkillsPanel";
import TelemetryPanel from "./TelemetryPanel";
import ProfilePanel from "./account/ProfilePanel";
import BillingPanel from "./account/BillingPanel";
import UsagePanel from "./usage/UsagePanel";
import {
  DEFAULT_PAGE,
  landing,
  pages as resolvePages,
  readCollapsed,
  search,
  writeCollapsed,
  type Page,
  type PanelId,
  type Section,
} from "./pages";
import { settingsBackdrop, settingsScreen } from "../motion";
import { closeSettings } from "../settingsSurface";
import { CLAIMED_FIELD_CLASS, useTitlebarSearch } from "../titlebarSearch";
import type { Setting } from "../../bindings";
import type { SettingsSession } from "./useSettings";
import "./settings.css";

/**
 * The settings screen: a large modal over the dimmed window, with a sidebar of
 * pages on the left and the picked page's collapsible sections on the right.
 * `pages.ts` decides which section goes on which page.
 *
 * The backdrop covers the band between the title bar and the status bar, not
 * the window. The title bar *is* the window controls in this frameless window,
 * so covering it would leave the window unclosable while settings was open;
 * the status bar keeps reporting, as it does under every transient surface.
 *
 * Nothing below is per-setting: every row comes from the schema Rust publishes,
 * so adding a setting is a Rust-only edit. The panels (MCP, Google account,
 * built-in skills, telemetry, profile, billing, usage) are the exceptions;
 * each file says why.
 */
export default function SettingsScreen({
  session,
  landOn,
}: {
  session: SettingsSession;
  landOn: string | null;
}) {
  // What was asked for: a page id or a section id. Seeded from `landOn` once;
  // after that a sidebar click is the answer, and only a *new* request from
  // outside (the avatar menu while the screen is up) replaces it.
  const [request, setRequest] = useState<string | null>(landOn);
  const lastLandOn = useRef(landOn);
  useEffect(() => {
    if (landOn === lastLandOn.current) return;
    lastLandOn.current = landOn;
    if (landOn !== null) {
      setRequest(landOn);
      setFilter("");
    }
  }, [landOn]);

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storage()));
  // Folds made during a search, forgotten as the search changes, so a search
  // never rewrites what is remembered.
  const [searchFolded, setSearchFolded] = useState<Set<string>>(new Set());
  useEffect(() => setSearchFolded(new Set()), [filter]);

  useTitlebarSearch({ placeholder: "Search settings", value: filter, onChange: setFilter });

  const all = useMemo(() => resolvePages(session.groups), [session.groups]);
  const visible = useMemo(() => all.filter((p) => p.sections.length > 0), [all]);
  const landed = landing(request, visible);
  // A page with nothing on it yet (the snapshot has not landed) is not shown;
  // the first page that has something is, until it does.
  const page: Page | null =
    visible.find((p) => p.id === landed.page) ??
    visible.find((p) => p.id === DEFAULT_PAGE) ??
    visible[0] ??
    null;

  // A deep link's section is unfolded, once per request, and remembered open.
  const unfoldedFor = useRef<string | null>(null);
  useEffect(() => {
    if (landed.section === null || unfoldedFor.current === request) return;
    unfoldedFor.current = request;
    setCollapsed((prev) => {
      if (!prev.has(landed.section as string)) return prev;
      const next = new Set(prev);
      next.delete(landed.section as string);
      writeCollapsed(storage(), next);
      return next;
    });
  }, [landed.section, request]);

  const needle = filter.trim();
  const filtering = needle !== "";
  const found = useMemo(
    () => (filtering ? search(visible, needle) : []),
    [visible, needle, filtering],
  );

  const go = useCallback((next: string) => {
    setRequest(next);
    setFilter("");
  }, []);

  const sections: SectionsState = useMemo(
    () => ({
      isOpen: (id) => (filtering ? !searchFolded.has(id) : !collapsed.has(id)),
      toggle: (id) => {
        const flip = (prev: Set<string>) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        };
        if (filtering) {
          setSearchFolded(flip);
          return;
        }
        setCollapsed((prev) => {
          const next = flip(prev);
          writeCollapsed(storage(), next);
          return next;
        });
      },
      needle: filtering ? needle : "",
      landing: filtering ? null : landed.section,
      go,
    }),
    [filtering, searchFolded, collapsed, needle, landed.section, go],
  );

  // Escape closes. A listener on `document` rather than an entry in the
  // window's accelerator table (`../keys/useKeyboard.ts`), which is a region
  // this one may not import; stopped so it does not also reach the surface
  // behind (closing a terminal's find bar on the way out, say).
  // Ctrl+F is caught in the capture phase, before the window's own find.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeSettings();
    };
    const onFind = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onEscape);
    document.addEventListener("keydown", onFind, true);
    return () => {
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("keydown", onFind, true);
    };
  }, []);

  // Focus comes into the screen when it opens, so typing does not reach the
  // surface behind, and goes back on the way out unless something else took
  // it first. The title bar's claimed field counts as the screen's own.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    const node = dialog.current;
    node?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const ours =
        now === null ||
        now === document.body ||
        node?.contains(now) === true ||
        now.closest(`.${CLAIMED_FIELD_CLASS}`) !== null;
      if (ours && before instanceof HTMLElement && before.isConnected) {
        before.focus({ preventScroll: true });
      }
    };
  }, []);

  const content = useRef<HTMLDivElement>(null);
  const pick = (id: string) => {
    go(id);
    content.current?.scrollTo?.({ top: 0 });
  };

  return (
    /* Both motion elements are paint-only (`opacity`, `transform`); see the
       settings block in `../motion` for why this screen must not animate a box. */
    <motion.div
      className="settings__backdrop"
      variants={settingsBackdrop}
      initial="initial"
      animate="animate"
      exit="exit"
      // Only a click on the backdrop itself, not one that bubbled from inside.
      onClick={(event) => {
        if (event.target === event.currentTarget) closeSettings();
      }}
    >
      <motion.div
        ref={dialog}
        className="settings"
        variants={settingsScreen}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(event) => trapTab(event, dialog.current)}
      >
        <header className="settings__header">
          <h1 className="settings__heading">Settings</h1>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--icon k-btn--lg"
            aria-label="Close settings"
            onClick={() => closeSettings()}
          >
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        {/* A refusal, not a failure to load: the value has already been rolled
            back, so this explains a control that snapped back. */}
        {session.error !== null && (
          <p className="settings__error" role="alert">
            {session.error}
          </p>
        )}

        <div className="settings__body">
          <SettingsNav
            pages={visible}
            current={page?.id ?? ""}
            filter={filter}
            onFilter={setFilter}
            onPick={pick}
            session={session}
            searchRef={searchRef}
          />

          <div
            ref={content}
            className="settings__content"
            role="region"
            aria-label={filtering ? "Matching settings" : (page?.title ?? "Settings")}
          >
            <SectionsContext.Provider value={sections}>
              <div className="settings__page">
                {filtering ? (
                  <Results found={found} typed={needle} session={session} />
                ) : (
                  page !== null && (
                    <>
                      <h2 className="settings__page-title">{page.title}</h2>
                      {page.sections.map((section) => (
                        <SectionView key={section.id} section={section} session={session} />
                      ))}
                    </>
                  )
                )}
              </div>
            </SectionsContext.Provider>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** localStorage, or nothing where it cannot be reached. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Tab and Shift+Tab stay inside the modal, the loop `../dialogs/Dialog.tsx` uses. */
function trapTab(event: KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== "Tab" || root === null) return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
  ).filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute("tabindex") !== "-1");
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && items.includes(active);
  if (!inside || (event.shiftKey && active === first)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function PanelFor({ id }: { id: PanelId }) {
  switch (id) {
    case "profile":
      return <ProfilePanel />;
    case "billing":
      return <BillingPanel />;
    case "usage":
      return <UsagePanel />;
  }
}

/** One section of a page: a panel draws its own; a schema group is drawn here. */
function SectionView({
  section,
  session,
  rows,
}: {
  section: Section;
  session: SettingsSession;
  /** The rows a search matched. Absent: every row, with the group's panels. */
  rows?: Setting[];
}) {
  if (section.panel !== null) return <PanelFor id={section.panel} />;
  const group = section.group;
  if (group === null) return null;
  const changed = session.changedIn(group);
  const searching = rows !== undefined;

  return (
    <SettingsSection
      id={section.id}
      title={section.title}
      description={section.description}
      actions={
        // Disabled rather than hidden: its disabled state is the answer to
        // "have I changed anything in here".
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          disabled={changed === 0}
          onClick={() => session.resetGroup(group)}
        >
          Reset
        </button>
      }
    >
      {!searching && group.id === "mcp" && <McpPanel />}
      {!searching && group.id === "cloud" && <CloudAccountPanel />}
      {!searching && group.id === "telemetry" && <TelemetryPanel />}
      {!searching && group.id === "skills" ? (
        <BuiltInSkillsPanel group={group} session={session} />
      ) : (
        (rows ?? group.settings).map((setting) => (
          <SettingRow key={setting.key} setting={setting} session={session} />
        ))
      )}
    </SettingsSection>
  );
}

/** Everything a search matched, page by page, every section open. */
function Results({
  found,
  typed,
  session,
}: {
  found: ReturnType<typeof search>;
  typed: string;
  session: SettingsSession;
}) {
  if (found.length === 0) {
    return <p className="settings__empty">No setting matches “{typed}”.</p>;
  }
  return (
    <>
      {found.map(({ page, sections }) => (
        <div className="settings__result" key={page.id}>
          <h2 className="settings__result-page">{page.title}</h2>
          {sections.map(({ section, settings }) => (
            <SectionView
              key={section.id}
              section={section}
              session={session}
              rows={settings ?? undefined}
            />
          ))}
        </div>
      ))}
    </>
  );
}
