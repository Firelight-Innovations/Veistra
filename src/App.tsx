import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  cachedStack,
  loadStack,
  onLibraryOpen,
  onSettingsOpen,
  type StackSnapshot,
} from "./bindings";
import WindowRoot from "./shell/WindowRoot";
import SettingsScreen from "./shell/settings/SettingsScreen";
import { useSettings } from "./shell/settings/useSettings";
import { readCopilotAction } from "./shell/settings/copilotSetting";
import { useAppearance } from "./shell/settings/appearance";
import { openSettings, useSettingsSurface } from "./shell/settingsSurface";
import LibraryScreen from "./shell/library/LibraryScreen";
import { openLibrary, useLibrarySurface } from "./shell/librarySurface";
import ShortcutsScreen from "./shell/keys/ShortcutsScreen";
import { useShortcutsSurface } from "./shell/shortcutsSurface";
import FeedbackHost from "./shell/dialogs/FeedbackHost";
import { answerConsent, stopPrompts } from "./shell/telemetry/consent";
import { deliveryFor } from "./shell/telemetry/feedback";
import { useConsent, useTelemetry } from "./shell/telemetry/useTelemetry";

/**
 * Owns the stack snapshot and hands it to the shell.
 *
 * All this does is data: fetch, refresh, and error state. Everything about how
 * the app looks and what it shows lives under `shell/`. Keeping the fetch here
 * rather than inside the shell means the shell can be restyled or rearranged
 * without anything having to know how the snapshot is obtained.
 *
 * Settings is mounted here rather than in `WindowRoot` because it is the one
 * surface that is not about a window — see `docs/settings.md` §9, which also
 * says why the title bar and the status bar stay uncovered. The session is read
 * once, above the window, so the appearance settings apply whether or not the
 * screen has ever been opened.
 *
 * Usage data is wired here for the same reason: consent is a setting, and the
 * feedback surfaces are no more about a window than settings is. See
 * `docs/telemetry.md`.
 */
export default function App() {
  const [snapshot, setSnapshot] = useState<StackSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rescan = useCallback(async () => {
    setBusy(true);
    try {
      setSnapshot(await loadStack());
      setError(null);
    } catch (err) {
      // Rust `Result::Err` becomes a rejected promise. Our AppError serializes
      // to its message string, so this is already human-readable.
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // `boot::start` already read the manifest and scanned every checkout
    // once, behind the splash window, before this window was ever shown —
    // so pick up its cached result here instead of paying for a second scan
    // on every mount. `loadStack` is only the fallback for the case boot
    // has nothing cached (it failed and the user clicked "Continue anyway"
    // on the splash before a snapshot was ever stored).
    void (async () => {
      try {
        const cached = await cachedStack();
        if (cached) {
          setSnapshot(cached);
          setError(null);
          return;
        }
        await rescan();
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [rescan]);

  const settings = useSettings();
  useAppearance(settings);
  const copilotAction = readCopilotAction(settings);
  const settingsSurface = useSettingsSurface();
  const librarySurface = useLibrarySurface();
  const shortcutsSurface = useShortcutsSurface();
  const consent = useConsent(settings);
  const telemetry = useTelemetry(consent);
  const sink = telemetry.config?.sink;

  // Home's *Install App* button, arriving the only way it can: Home is an
  // iframe on another origin, so it calls its own Rust half and Rust emits.
  useEffect(() => {
    const stop = onLibraryOpen(openLibrary);
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  // An app's *Drawing style* button and the like: the app cannot reach this
  // component, so it calls Rust, which emits, and the section arrives here.
  useEffect(() => {
    const stop = onSettingsOpen((section) => openSettings(section ?? undefined));
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  return (
    <>
      <WindowRoot
        snapshot={snapshot}
        error={error}
        rescanning={busy}
        onRescan={() => void rescan()}
        copilotAction={copilotAction}
      />
      {/* Mounted only while open, so a window nobody has opened settings in
          never pays for the screen's tree — and `AnimatePresence` is what keeps
          that true through the exit, holding the subtree for exactly as long as
          the animation runs and then unmounting it for real. The same shape
          `WindowRoot` uses for the search overlay. */}
      <AnimatePresence>
        {settingsSurface.open && (
          <SettingsScreen session={settings} landOn={settingsSurface.section} />
        )}
      </AnimatePresence>
      {/* Mounted only while open, like settings and unlike the library: this one
          has nothing to report while closed. */}
      <AnimatePresence>{shortcutsSurface.open && <ShortcutsScreen />}</AnimatePresence>
      {/* Not inside `AnimatePresence`, and not conditional on being open —
          unlike settings. The first run installs the catalog's default apps
          before anybody has opened anything, and a closed screen still has to
          be able to report how that went. See its own comment. */}
      <LibraryScreen open={librarySurface.open} />
      <FeedbackHost
        askConsent={telemetry.askConsent}
        onShare={(replay) => answerConsent(settings, { share: true, replay })}
        onDecline={() => answerConsent(settings, { share: false })}
        onLater={telemetry.deferConsent}
        delivery={deliveryFor(telemetry.config, consent?.usage === "on")}
        blockedBecause={sink?.state === "off" ? sink.reason : null}
        onStopPrompts={() => stopPrompts(settings)}
      />
    </>
  );
}
