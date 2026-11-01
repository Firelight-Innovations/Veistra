/**
 * The menu model: the command ids the shell can ask a frame for, what each menu
 * acts on, and the one function that builds all six.
 *
 * Beside `TitleBar.tsx` rather than inside it because they are two jobs. The
 * component draws a bar; this decides what is in the menus, is rebuilt on every
 * render from live state, and is consumed by `MenuBar`, `HamburgerMenu` and
 * `AddAppButton` alike. Keeping them in one file made the larger of the two
 * hard to find and gave a 400-line module two reasons to change.
 */
import type { Menu } from "../contract";
import { githubOpenInBrowser } from "../../bindings";
import { PRODUCT_NAME } from "../../branding.generated";
import { openShortcuts } from "../shortcutsSurface";
import { appsMenu } from "../appsMenu";
import type { AppsMenuHandlers } from "../appsMenu";
import { rerunLabel } from "../run";
import { openFeedback } from "../telemetry/surface";

/**
 * Every command the shell's menus can ask a mounted app frame to carry out.
 *
 * The shell knows these strings and nothing else about them. It does not know
 * that `file/save` writes a file, or that only Files can do it — it posts the
 * string to the active frame and greys the item out when that frame has not
 * declared it (see `veistra/commands` in `docs/tool-protocol.md` §3). That is
 * what keeps one app's capability list out of the title bar, so the next app to
 * arrive does not break the menu.
 *
 * The Files app restates these ids in `apps/files/ui/src/commands.ts` rather
 * than importing them, for the reason that file's header gives about an app's
 * only coupling to its host being `@veistra/bridge`. Two copies of a small table
 * is the price; the alternative is `apps/` reaching into `src/`.
 */
export const APP_COMMAND = {
  newFile: "file/new-file",
  save: "file/save",
  saveAs: "file/save-as",
  duplicate: "file/duplicate",
  delete: "file/delete",
  trash: "file/trash",
  undo: "edit/undo",
  redo: "edit/redo",
  cut: "edit/cut",
  copy: "edit/copy",
  paste: "edit/paste",
  find: "edit/find",
  replace: "edit/replace",
} as const;

/**
 * One family of menu items that act on something other than the shell itself.
 *
 * `blocked` answers both questions an item needs — whether to disable, and what
 * to say about why — from one call, so the two can never disagree. `run` is only
 * ever reached for a command `blocked` cleared.
 */
export interface CommandHandlers {
  run(command: string): void;
  /** `undefined` when the command can run now; otherwise the sentence to show. */
  blocked(command: string): string | undefined;
}

/** What the File menu's items that act on the *shell* do. */
export interface FileMenuHandlers {
  /** Open an empty window. `undefined` disables the item. */
  newWindow?: () => void;
  /**
   * Native folder picker, through Home's `home/open-project`.
   *
   * `undefined` when this window has no cluster to open a project *into* —
   * every cluster in it has been closed. A project belongs to a cluster, so
   * with none there is nowhere for the answer to go, and the backend refuses
   * the call for exactly that reason. Better to say so on the item than to
   * raise a picker whose result has nowhere to land.
   */
  openProject?: () => void;
  /**
   * Show Home, whose Recent list is the real thing being asked for.
   *
   * `undefined` when there is no cluster to show it in. `MenuItem` has no
   * submenu, and the handoff is explicit that faking one is not an option; this
   * is the other branch it offers. See the note on the item itself.
   */
  openRecent?: () => void;
  closeWindow(): void;
}

/** The View menu. Almost all of it is `WindowRoot`'s own state. */
export interface ViewMenuHandlers {
  commandPalette(): void;
  /** Whether the rail's Git page, which holds source control, is open. */
  clustersShowing: boolean;
  toggleClusters(): void;
  /** Whether the terminal band is open. */
  terminalShowing: boolean;
  toggleTerminal(): void;
  fullscreen: boolean;
  toggleFullscreen(): void;
  zoomIn(): void;
  zoomOut(): void;
  /**
   * Why zoom cannot go further in each direction, or `undefined`.
   *
   * Two fields rather than one, because the two ends of the ladder are reached
   * separately: at 250% Zoom In is done and Zoom Out is not. They also carry
   * the "there is no webview here" case, which blocks both.
   */
  zoomInBlocked?: string;
  zoomOutBlocked?: string;
}

/**
 * What the Run menu's three items act on: the terminal the cluster is showing.
 *
 * "Run" means running a command *here*, in the cluster you are looking at,
 * rather than running a run configuration. The alternative — a saved list of
 * named tasks, which is what the menu's shape borrows from — was rejected for
 * this pass because nothing on either side of the Tauri boundary stores one:
 * there is no task type in `bindings.ts`, nothing in `shell:state` to hold it,
 * and no file on disk it would be read out of. A menu whose items name a
 * feature that does not exist is the defect #40 reported, and inventing the
 * feature is a larger decision than the bug.
 *
 * One `blocked` for the whole menu rather than a reason per row, because all
 * three rows are stopped by the same fact: a command needs a shell to be typed
 * into, and this cluster has no terminal.
 */
export interface RunMenuHandlers {
  /**
   * Run one command line in that terminal.
   *
   * Rejects with the sentence to show under the field — see `MenuPrompt`.
   * Called for the prompt row and for Re-run alike, so a command that is
   * refused is refused the same way whichever row asked.
   */
  run(command: string): Promise<void>;
  /** Ctrl+C to the same terminal. */
  interrupt(): void;
  /** The last command run from this menu in this window, or `undefined` when
   *  nothing has been run yet. Re-run's label names it. */
  last?: string;
  /** Why none of the three can act, or `undefined` when they can. */
  blocked?: string;
}

/** What the Terminal menu's four items act on. */
export interface TerminalMenuHandlers {
  onNew: () => void;
  onSplit: () => void;
  onKill: () => void;
  onClear: () => void;
  /** False when there's no session to act on — the worktree tab is active,
   *  or (momentarily) every terminal has closed. Split/Kill/Clear disable;
   *  New Terminal never needs a session, so it stays live regardless. */
  enabled: boolean;
}

/**
 * The one Help item that needs the window to act.
 *
 * Wired because it is the only way to check for an update on a machine where
 * `updates.checkAutomatically` is off, and because the answer — including "you
 * are up to date" — arrives in the status bar rather than in a dialog. See
 * `UpdateNotice` in `contract.ts`.
 *
 * Its neighbours act too now, and are deliberately *not* here: two open a fixed
 * address in the browser and one raises a screen, none of which any window
 * decides. See `HELP_LINKS` and the menu itself.
 */
export interface HelpMenuHandlers {
  checkForUpdates(): void;
}

/**
 * Where the two Help items that leave the app go.
 *
 * Constants rather than handlers threaded down from `WindowRoot`: neither
 * address depends on anything a window knows, and a callback per fixed URL is
 * two more props for every caller of `defaultMenus` to forward unchanged.
 *
 * Both are github.com pages, which is what lets them ride `githubOpenInBrowser`
 * instead of needing a command — and a widened `opener` capability — of their
 * own. Rust re-checks the host and refuses anything else; see `github.rs`.
 */
const HELP_LINKS = {
  issues: "https://github.com/Firelight-Innovations/Veistra/issues",
  readme: "https://github.com/Firelight-Innovations/Veistra/blob/main/README.md",
} as const;

/**
 * Hand one of them to the browser.
 *
 * The rejection is logged and swallowed. There is nowhere to show it: the menu
 * has closed by the time the promise settles, and a failure here means the
 * address was refused or the OS has no browser — neither of which the person
 * who clicked can do anything about from inside a menu.
 */
function openHelpLink(url: string): void {
  void githubOpenInBrowser(url).catch((err: unknown) =>
    console.error("veistra: could not open", url, err),
  );
}

/** Everything the six menus with a live item act on. */
export interface MenuHandlers {
  /** File items that go to the active app frame as a menu command. */
  app: CommandHandlers;
  /** Edit items, which go to the app frame *or* to a focused shell field. */
  edit: CommandHandlers;
  apps: AppsMenuHandlers;
  file: FileMenuHandlers;
  view: ViewMenuHandlers;
  run: RunMenuHandlers;
  terminal: TerminalMenuHandlers;
  help: HelpMenuHandlers;
}

/**
 * All seven menus. File, Edit, View, Run and Terminal operate the app. Help has
 * one inert item left — Documentation, which has nothing published to point at
 * yet.
 *
 * ## Accelerators are bound, and that is a change
 *
 * This file used to say "accelerators are displayed only". It no longer does.
 * Every accelerator that appears below is one the keystroke actually performs,
 * by one of two routes: `keys/useKeyboard.ts` binds it — the File and View
 * menus, and Terminal's two — or the focused text surface already binds it,
 * which is the whole Edit menu, noted on that menu below.
 *
 * Anything that could be neither is not shown. New Window has no accelerator
 * because it has no action; Kill Terminal and Clear lost theirs because Ctrl+K
 * belongs to `SearchSlot`, and the rule is bind it or drop it.
 *
 * They are also Windows text — `Ctrl+N`, not a Mac Command glyph. The last of
 * those left Run with #42, and `shell/accelerators.test.ts` keeps them out.
 */
export function defaultMenus(handlers: MenuHandlers): Menu[] {
  const { app, edit, apps, file, view, run, terminal, help } = handlers;

  /** One File/Edit row, disabled with an explanation when it cannot act. */
  const command = (
    label: string,
    handlers: CommandHandlers,
    id: string,
    extra?: Partial<Menu["items"][number]>,
  ): Menu["items"][number] => {
    const hint = handlers.blocked(id);
    return {
      label,
      onSelect: () => handlers.run(id),
      disabled: hint !== undefined,
      hint,
      ...extra,
    };
  };

  return [
    {
      label: "File",
      items: [
        command("New File", app, APP_COMMAND.newFile, { accelerator: "Ctrl+N" }),
        {
          // This was disabled, with a hint saying the build had no way to open a
          // second window — true when a window label was derived from the tool
          // inside it, so a window could only ever be made by taking a tab out
          // of another one. Labels are opaque now and `windows::create` opens a
          // window on its own terms, so the item does what it says.
          label: "New Window",
          onSelect: file.newWindow,
          disabled: file.newWindow === undefined,
          hint: file.newWindow === undefined ? "This window cannot open another." : undefined,
        },
        {
          label: "Open…",
          accelerator: "Ctrl+O",
          onSelect: file.openProject,
          disabled: file.openProject === undefined,
          hint:
            file.openProject === undefined
              ? "A project opens into a cluster, and this window has none. Make one with the + in the bar."
              : undefined,
        },
        {
          // `MenuItem` has no submenu, and the handoff forbids faking one. Of
          // the two branches it offers, this is the second: the item shows
          // Home, whose Recent list is the real, complete answer — with the
          // folder's path, when it was last opened, whether it is still there,
          // and a way to forget it. A submenu could carry at most the names.
          label: "Open Recent",
          onSelect: file.openRecent,
          disabled: file.openRecent === undefined,
          hint:
            file.openRecent === undefined
              ? "There is no cluster in this window to show Home in."
              : "Opens Home, which lists every recent project.",
        },
        command("Save", app, APP_COMMAND.save, {
          accelerator: "Ctrl+S",
          separatorBefore: true,
        }),
        command("Save As…", app, APP_COMMAND.saveAs, { accelerator: "Ctrl+Shift+S" }),
        command("Duplicate", app, APP_COMMAND.duplicate, {
          accelerator: "Ctrl+D",
          separatorBefore: true,
        }),
        command("Delete", app, APP_COMMAND.delete),
        command("Trash", app, APP_COMMAND.trash),
        {
          label: "Close Window",
          accelerator: "Ctrl+Shift+W",
          separatorBefore: true,
          onSelect: file.closeWindow,
        },
      ],
    },
    // **The focused text surface already binds every one of these.** Ctrl+Z,
    // Ctrl+X, Ctrl+F and the rest are Monaco's own keybindings inside the Files
    // iframe, and the browser's inside a shell `<input>`. A second binding in
    // `useKeyboard` would be the shell racing the surface the user is typing in
    // for a key that already works — the exact failure that hook's header was
    // written to avoid.
    {
      label: "Edit",
      items: [
        command("Undo", edit, APP_COMMAND.undo, { accelerator: "Ctrl+Z" }),
        command("Redo", edit, APP_COMMAND.redo, { accelerator: "Ctrl+Y" }),
        command("Cut", edit, APP_COMMAND.cut, { accelerator: "Ctrl+X", separatorBefore: true }),
        command("Copy", edit, APP_COMMAND.copy, { accelerator: "Ctrl+C" }),
        command("Paste", edit, APP_COMMAND.paste, { accelerator: "Ctrl+V" }),
        command("Find", edit, APP_COMMAND.find, { accelerator: "Ctrl+F", separatorBefore: true }),
        command("Replace", edit, APP_COMMAND.replace, { accelerator: "Ctrl+H" }),
      ],
    },
    // Not built here. `appsMenu` in `src/shell/appsMenu.ts` is the one
    // definition, shared with the
    // switcher row's add-app button — see its comment.
    appsMenu(apps),
    {
      label: "View",
      items: [
        { label: "Command Palette…", accelerator: "Ctrl+Shift+P", onSelect: view.commandPalette },
        // The three toggles say which way they will go rather than reading
        // "Toggle …", so the menu answers "is it open?" without the user
        // having to close it to find out.
        {
          label: view.clustersShowing ? "Hide Clusters" : "Show Clusters",
          accelerator: "Ctrl+B",
          separatorBefore: true,
          onSelect: view.toggleClusters,
        },
        {
          label: view.terminalShowing ? "Hide Terminal" : "Show Terminal",
          accelerator: "Ctrl+`",
          onSelect: view.toggleTerminal,
        },
        {
          label: view.fullscreen ? "Exit Full Screen" : "Enter Full Screen",
          accelerator: "F11",
          separatorBefore: true,
          onSelect: view.toggleFullscreen,
        },
        {
          label: "Zoom In",
          accelerator: "Ctrl+=",
          onSelect: view.zoomIn,
          disabled: view.zoomInBlocked !== undefined,
          hint: view.zoomInBlocked,
        },
        {
          label: "Zoom Out",
          accelerator: "Ctrl+-",
          onSelect: view.zoomOut,
          disabled: view.zoomOutBlocked !== undefined,
          hint: view.zoomOutBlocked,
        },
      ],
    },
    // Run acts now, and its three rows are not the three it had. "Run Active
    // Tool" is gone rather than wired: a tool is a checkout this shell *mounts*,
    // not a program it starts, so that row named an operation with nothing
    // behind it — see `RunMenuHandlers` for what replaced the run-configuration
    // reading of this menu and why. Stop and Re-run Last kept their labels and
    // gained the terminal they were always about.
    //
    // Still no accelerators, and still for the reason the header gives. The
    // Windows spellings of the two this menu lost would have been Ctrl+R and
    // Ctrl+C — already Re-scan tools and Copy — so displaying either would be
    // advertising a keystroke that does something else. Bind it or drop it.
    {
      label: "Run",
      items: [
        {
          label: "Run Command…",
          disabled: run.blocked !== undefined,
          hint: run.blocked,
          // Pre-filled with the last command and selected, so re-running it
          // with one flag changed costs an edit rather than retyping — the
          // case `MenuPrompt.initialValue` exists for. Re-run below is the
          // other half: unchanged, it costs one click.
          prompt: {
            label: "Run a command in this cluster's terminal.",
            placeholder: "pnpm verify",
            initialValue: run.last,
            confirmLabel: "Run",
            onSubmit: run.run,
          },
        },
        {
          label: rerunLabel(run.last),
          disabled: run.blocked !== undefined || run.last === undefined,
          hint: run.blocked ?? (run.last === undefined ? "Nothing has been run yet." : undefined),
          // The rejection has nowhere to go: this row is not a prompt, so there
          // is no field to show a sentence under, and the menu has closed by
          // the time the promise settles. It can only be the refusal
          // `commandLine` gives — and a command that reached `last` was
          // accepted by it once already.
          onSelect: () => {
            if (run.last !== undefined) void run.run(run.last);
          },
        },
        {
          label: "Stop",
          separatorBefore: true,
          onSelect: run.interrupt,
          disabled: run.blocked !== undefined,
          // Live whenever there is a terminal, rather than only while something
          // is running. Whether a shell has a foreground job is a process scan
          // (`pty::busy`) and an async one, which a menu built synchronously on
          // every render cannot ask — and the answer would be stale by the time
          // the row was clicked anyway. Ctrl+C at an idle prompt draws a new
          // prompt, which is what the keystroke does and so is not a lie.
          hint: run.blocked ?? "Sends Ctrl+C, exactly as pressing it in the terminal would.",
        },
      ],
    },
    {
      label: "Terminal",
      items: [
        // Ctrl+Shift+` rather than Ctrl+`, which View's Show/Hide Terminal now
        // holds — one key cannot mean both "reveal the panel" and "open another
        // pty", and VS Code splits them the same way round.
        { label: "New Terminal", accelerator: "Ctrl+Shift+`", onSelect: terminal.onNew },
        {
          label: "Split Terminal",
          accelerator: "Ctrl+\\",
          onSelect: terminal.onSplit,
          disabled: !terminal.enabled,
        },
        {
          label: "Kill Terminal",
          separatorBefore: true,
          onSelect: terminal.onKill,
          disabled: !terminal.enabled,
        },
        // No accelerator: this used to claim Ctrl+K, which `SearchSlot` binds to
        // open the search field. Two handlers for one key is the failure
        // `useKeyboard.ts`'s header exists to prevent, and search was there
        // first — so the display goes rather than the binding.
        { label: "Clear", onSelect: terminal.onClear, disabled: !terminal.enabled },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Documentation" },
        // No accelerator, and that is the "bind it or drop it" rule rather than
        // an oversight: a shortcut for the list of shortcuts is one more chord
        // to find room for, and the person looking for it is by definition
        // reaching for the menu.
        { label: "Keyboard Shortcuts", onSelect: openShortcuts },
        // The one wired item in this menu. No accelerator, because there is no
        // keystroke worth spending on something done twice a year — and the
        // rule above is bind it or drop it, not display it and hope.
        //
        // Nothing opens when this is picked. The answer, including "you are
        // already on the newest", appears in the status bar, because the
        // question is not urgent enough to take the screen away from whatever
        // it was showing.
        { label: "Check for Updates", separatorBefore: true, onSelect: help.checkForUpdates },
        // Both of these leave the app, and the ellipsis is what says so — the
        // same promise it makes on `App Library…`, which raises a screen this
        // window owns. These hand the address to whatever browser the machine
        // has and this window keeps whatever it was showing.
        // Beside Report Issue rather than replacing it. An issue is public and
        // needs a GitHub account; this needs neither, and says before sending
        // what goes with it. The ellipsis is the dialog it raises.
        {
          label: "Send Feedback…",
          separatorBefore: true,
          onSelect: () => openFeedback({ source: "help-menu", feature: null }),
        },
        {
          label: "Report Issue…",
          onSelect: () => openHelpLink(HELP_LINKS.issues),
        },
        // The one menu item that names the product. It used to append a second
        // word, naming something this shell is not. Taking the name from
        // branding.toml leaves one place that can be wrong instead of nine.
        //
        // The README rather than a dialog: a version, a licence and a line of
        // prose is what an About box holds, and all three are already written
        // down in one place that is current with the release.
        {
          label: `About ${PRODUCT_NAME}…`,
          separatorBefore: true,
          onSelect: () => openHelpLink(HELP_LINKS.readme),
        },
      ],
    },
  ];
}
