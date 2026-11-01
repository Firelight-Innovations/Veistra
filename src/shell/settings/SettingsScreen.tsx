import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import SettingRow from "./SettingRow";
import McpPanel from "./McpPanel";
import CloudAccountPanel from "./CloudAccountPanel";
import BuiltInSkillsPanel from "./BuiltInSkillsPanel";
import TelemetryPanel from "./TelemetryPanel";
import { settingsBackdrop, settingsScreen } from "../motion";
import { closeSettings } from "../settingsSurface";
import { X } from "lucide-react";
import { CLAIMED_FIELD_CLASS, useTitlebarSearch } from "../titlebarSearch";
import type { Setting, SettingsGroup } from "../../bindings";
import type { SettingsSession } from "./useSettings";
import "./settings.css";

/**
 * The settings screen: a header, a list of sections, and the selected one.
 *
 * ## Why it covers the band between the two bars, and not the window
 *
 * The title bar stays because it *is* the window controls: this is a frameless
 * Tauri window, so minimise, maximise and close are drawn by the shell in
 * `.frame__titlebar` rather than by the OS, and covering them would leave the
 * window unclosable for as long as settings was open.
 *
 * The status bar stays for an unrelated reason — it keeps reporting while any
 * transient surface is up, as every one of them in this shell does.
 * `settings.css` spells out both.
 *
 * Nothing below is per-setting: every row comes from the schema Rust publishes,
 * so adding a setting is a Rust-only edit. The MCP, Google account, built-in
 * skills and usage data panels are the exceptions; each file says why.
 */

/** The sections that get an extra panel. The only ids this file knows. */
const MCP_GROUP = "mcp";
const CLOUD_GROUP = "cloud";
const SKILLS_GROUP = "skills";
const TELEMETRY_GROUP = "telemetry";

export default function SettingsScreen({
  session,
  landOn,
}: {
  session: SettingsSession;
  landOn: string | null;
}) {
  // `landOn` is read exactly here and nowhere else — an initialiser, so it is
  // seen once at mount and never again. That is the whole contract: it is a
  // *request* from whatever opened the screen (an app's own settings button, such
  // as the canvas's Drawing style), not a selection. Once the sidebar has been clicked, `picked` is
  // the answer and an unchanged prop cannot take it back. Making this controlled
  // would mean a click that the next render silently undid.
  const [picked, setPicked] = useState<string | null>(landOn);
  const [filter, setFilter] = useState("");

  // One search bar on screen: this screen's filter lives in the title bar's
  // field rather than in a second one beneath it. Escape is left to the
  // listener below, which closes the screen.
  useTitlebarSearch({ placeholder: "Search settings", value: filter, onChange: setFilter });

  // Escape closes, and this is deliberately a listener on `document` rather than
  // an entry in `../keys/useKeyboard.ts`. That hook is the *window's* accelerator
  // table — it lives in a region this one may not import (STANDARDS.md §1.2), and
  // it is scoped to a window where this screen is mounted above one. A
  // full-window surface that swallows Escape is the one case where a local
  // listener is the correct shape rather than a shortcut: the key means "leave
  // this surface", and the surface is the only thing that knows it is up.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Stopped here so it does not also reach whatever the window behind would
      // have done with it — closing a terminal's find bar, say, on the way out.
      event.stopPropagation();
      closeSettings();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focus comes into the screen when it opens. Ctrl+, can open it from a
  // terminal, a field or an app's frame, and focus left there would send typing
  // to the surface behind and keep Escape from ever reaching the listener above.
  // On the way out it goes back, unless something else took it first: a click
  // on the status bar's git controls, say, which shut this screen. The title
  // bar's field counts as the screen's own while claimed: the filter is typed
  // there, and it turns back into a button as the claim is released.
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

  const needle = filter.trim().toLowerCase();
  const filtering = needle !== "";

  // Resolving `picked` against the real groups is derived, not an effect that
  // writes it back. `groups` is empty until the first snapshot arrives, so an
  // effect would run twice and still leave one frame with no section on screen —
  // and an effect that corrected `picked` would be a second writer racing the
  // user's click. This reads the state without touching it, and does the "land
  // on the first section if that id is not registered" rule for free.
  //
  // Typed as nullable because it genuinely is: before the snapshot lands there
  // is no index 0 to fall back to.
  const selected: SettingsGroup | null =
    session.groups.find((group) => group.id === picked) ?? session.groups[0] ?? null;

  const found = useMemo(
    () => (filtering ? matching(session.groups, needle) : []),
    [session.groups, needle, filtering],
  );

  return (
    /* Two motion elements, and neither of them moves a box. The backdrop dims
       and the screen settles forward out of it — the shape a sheet arrives in,
       rather than search's unroll, because settings is a place you go to and not
       an extension of the control that opened it. Both halves are paint-only
       (`opacity` and `transform`); see the settings block in `../motion` for why
       a screen full of scroll containers must not animate its own box. */
    <motion.div
      className="settings__backdrop"
      variants={settingsBackdrop}
      initial="initial"
      animate="animate"
      exit="exit"
      // Only a click that landed on the backdrop itself. Comparing target to
      // currentTarget rather than stopping propagation on the surface, because
      // the surface is full of controls and a blanket `stopPropagation` there
      // would be a rule every one of them has to keep working around.
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
      >
        <header className="settings__header">
          <h1 className="settings__heading">Settings</h1>
          {/* The filter is typed in the title bar's search field, which this
              screen claims while it is mounted — see `useTitlebarSearch` above. */}
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--icon k-btn--lg"
            aria-label="Close settings"
            onClick={() => closeSettings()}
          >
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        {/* A refusal, not a failure to load: the value on screen has already
            been rolled back by the time this appears, so it explains a control
            that snapped back rather than warning about one that will. */}
        {session.error !== null && (
          <p className="settings__error" role="alert">
            {session.error}
          </p>
        )}

        <div className="settings__body">
          <nav
            className="settings__nav"
            role="tablist"
            aria-label="Settings sections"
            data-dimmed={filtering || undefined}
          >
            {session.groups.map((group) => {
              const changed = session.changedIn(group);
              const current = selected !== null && selected.id === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  className="settings__nav-item"
                  aria-selected={current}
                  data-current={current || undefined}
                  onClick={() => {
                    setPicked(group.id);
                    // Picking a section while a filter is up has to clear it, or
                    // the click changes the highlighted row and nothing else —
                    // the flat list is still what the pane is showing.
                    setFilter("");
                  }}
                >
                  <span className="settings__nav-title">{group.title}</span>
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
          </nav>

          <div
            className="settings__content"
            role="tabpanel"
            aria-label={filtering ? "Matching settings" : (selected?.title ?? "Settings")}
          >
            {/* Nothing at all until the first snapshot lands, and no spinner —
                the frame is already drawn, and a loader inside it for the few
                milliseconds an in-process read takes reads as a fault rather
                than as progress. The same call `SearchOverlay` makes. */}
            <div className="settings__column">
              {filtering ? (
                <Matches found={found} typed={filter.trim()} session={session} />
              ) : (
                selected !== null && <Section group={selected} session={session} />
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** One section: what it is for, a way to undo it, and everything in it. */
function Section({ group, session }: { group: SettingsGroup; session: SettingsSession }) {
  const changed = session.changedIn(group);

  return (
    <>
      <div className="settings__section-head">
        <div className="settings__section-text">
          <h2 className="settings__section-title">{group.title}</h2>
          {group.description !== "" && (
            <p className="settings__section-description">{group.description}</p>
          )}
        </div>
        {/* Disabled rather than hidden. A control that vanishes when there is
            nothing to do is a control nobody learns is there, and its disabled
            state is itself the answer to "have I changed anything in here". */}
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          disabled={changed === 0}
          onClick={() => session.resetGroup(group)}
        >
          Reset section
        </button>
      </div>

      {group.id === MCP_GROUP && <McpPanel />}
      {group.id === CLOUD_GROUP && <CloudAccountPanel />}
      {group.id === TELEMETRY_GROUP && <TelemetryPanel />}

      {/* The skills panel draws each mode row inside its skill's card. */}
      {group.id === SKILLS_GROUP ? (
        <BuiltInSkillsPanel group={group} session={session} />
      ) : (
        group.settings.map((setting) => (
          <SettingRow key={setting.key} setting={setting} session={session} />
        ))
      )}
    </>
  );
}

/**
 * Everything the filter matched, from every section at once.
 *
 * Sections become sticky headings rather than a nav selection, because the point
 * of typing is that you do not know which section it is in. The MCP panel is
 * deliberately absent: it is not a setting and has no title, description or key
 * to match against, so a filter cannot honestly say whether it belongs here.
 */
function Matches({
  found,
  typed,
  session,
}: {
  found: Match[];
  typed: string;
  session: SettingsSession;
}) {
  if (found.length === 0) {
    return <p className="settings__empty">No setting matches “{typed}”.</p>;
  }

  return (
    <>
      {found.map(({ group, settings }) => (
        <div className="settings__matches" key={group.id}>
          <h2 className="settings__matches-heading">{group.title}</h2>
          {settings.map((setting) => (
            <SettingRow key={setting.key} setting={setting} session={session} />
          ))}
        </div>
      ))}
    </>
  );
}

interface Match {
  group: SettingsGroup;
  settings: Setting[];
}

/**
 * Sections that have something matching in them, in the order they already sit.
 *
 * Matches on the key as well as the visible text, which is not a developer
 * affordance: a key is what an error message, a support answer or a colleague
 * names a setting by, and `terminal.scrollback` should find its row whether or
 * not the title happens to contain the word.
 */
function matching(groups: SettingsGroup[], needle: string): Match[] {
  const found: Match[] = [];
  for (const group of groups) {
    const settings = group.settings.filter((setting) =>
      `${setting.title} ${setting.description} ${setting.key}`.toLowerCase().includes(needle),
    );
    if (settings.length > 0) found.push({ group, settings });
  }
  return found;
}
