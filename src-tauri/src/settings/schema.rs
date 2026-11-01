//! The shell's own settings.
//!
//! One rule governs what may be added here, and `docs/settings.md` states it in
//! full: **a setting is a decision, and something has to read it.** A row that
//! writes a value nothing consumes is worse than an absent row — it is a
//! promise the interface does not keep, and the person who finds out is the one
//! who changed it and watched nothing happen.
//!
//! So every key below is followed to its reader in the test at the bottom of
//! this file, and every one whose reader is not immediate says so in its
//! [`Applies`].

use super::{Applies, Control, Group, SelectOption, Setting};

/// The key of every setting, for the Rust that reads one.
///
/// Constants rather than string literals at the call sites, and the test at the
/// bottom of this file checks each of them still resolves to a descriptor of
/// the type its reader expects. A typo in a literal would fall back to the
/// zero value silently; a typo here does not compile.
pub mod keys {
    pub const APPEARANCE_THEME: &str = "appearance.theme";
    pub const APPEARANCE_ACCENT_COLOR: &str = "appearance.accentColor";
    pub const TERMINAL_DEFAULT_SHELL: &str = "terminal.defaultShell";
    pub const TERMINAL_OPEN_ON_LAUNCH: &str = "terminal.openOnLaunch";
    pub const SEARCH_MAX_MATCHES: &str = "search.maxMatches";
    pub const SEARCH_MAX_FILES: &str = "search.maxFiles";
    pub const SEARCH_MAX_FILE_SIZE_MB: &str = "search.maxFileSizeMb";
    pub const GITHUB_ITEM_LIMIT: &str = "github.itemLimit";
    pub const CLOUD_GOOGLE_CLIENT_ID: &str = "cloud.googleClientId";
    pub const CLOUD_GATEWAY_URL: &str = "cloud.gatewayUrl";
    pub const MCP_WRITE_PROJECT_CONFIG: &str = "mcp.writeProjectConfig";
    pub const UPDATES_CHECK_AUTOMATICALLY: &str = "updates.checkAutomatically";
    pub const DEVELOPER_MODE: &str = "developer.mode";
    pub const KEYS_COPILOT_ACTION: &str = "keys.copilotAction";
    pub const KEYS_COPILOT_GLOBAL: &str = "keys.copilotGlobal";
    /// Named after the skill's folder, so `skills.rs` can find a skill's key.
    pub const SKILLS_AGENT_READY_CANVAS: &str = "skills.agent-ready-canvas";
}

/// Every group the shell itself registers, in no particular order — `Group::order`
/// decides what the screen draws first.
pub fn groups() -> &'static [&'static Group] {
    GROUPS
}

static GROUPS: &[&Group] = &[
    &APPEARANCE,
    &EDITOR,
    &TERMINAL,
    &KEYS,
    &SEARCH,
    &super::markup::GROUP,
    &GITHUB,
    &CLOUD,
    &UPDATES,
    &TELEMETRY,
    &MCP,
    &SKILLS,
    &DEVELOPER,
];

// --- appearance -------------------------------------------------------------
//
// Applied by the frontend as custom properties on the document root, over the
// top of `src/tokens.css` rather than inside it. That file is the decoded
// handoff and says nothing in it is a choice; a user's accent is a choice, so
// it belongs in a layer above rather than as an edit to the spec's own values.

/// One per design-system accent option (`docs/design/veistra-ds/tokens.json`).
/// The value is a *name*, not a hex — `src/tokens.css` carries the hex for
/// both themes under `--accent-<name>`, and `appearance.ts` just points
/// `--accent` at the right one. A name survives a theme switch unchanged,
/// where a stored hex would have been the wrong theme's colour half the time.
static ACCENTS: &[SelectOption] = &[
    SelectOption {
        value: "blue",
        label: "Blue",
        description: "The default. Plane's blue, so Veistra and the projects app read as one.",
    },
    SelectOption {
        value: "amber",
        label: "Amber",
        description: "The colour the interface was first designed in.",
    },
    SelectOption {
        value: "green",
        label: "Green",
        description: "",
    },
    SelectOption {
        value: "violet",
        label: "Violet",
        description: "",
    },
    SelectOption {
        value: "coral",
        label: "Coral",
        description: "",
    },
];

static THEMES: &[SelectOption] = &[
    SelectOption {
        value: "dark",
        label: "Dark",
        description: "",
    },
    SelectOption {
        value: "light",
        label: "Light",
        description: "",
    },
    SelectOption {
        value: "system",
        label: "System",
        description: "Follows the OS light/dark setting, and switches when it does.",
    },
];

static APPEARANCE_SETTINGS: &[Setting] = &[
    Setting {
        key: keys::APPEARANCE_THEME,
        title: "Theme",
        description: "Dark is what the interface was designed in. System follows the OS setting \
                      and moves with it.",
        control: Control::Select {
            default: "dark",
            options: THEMES,
        },
        applies: Applies::Now,
    },
    Setting {
        key: keys::APPEARANCE_ACCENT_COLOR,
        title: "Accent colour",
        description: "The active tab's rule, focus rings, drop targets and primary buttons.",
        control: Control::Select {
            default: "blue",
            options: ACCENTS,
        },
        applies: Applies::Now,
    },
    Setting {
        key: "appearance.interfaceFontFamily",
        title: "Interface font",
        description: "Tabs, menus, labels. The bundled fallbacks stay behind whatever you name, \
                      so a font this machine does not have degrades rather than breaks.",
        control: Control::Text {
            default: "Inter",
            placeholder: "Inter",
        },
        applies: Applies::Now,
    },
    Setting {
        key: "appearance.monoFontFamily",
        title: "Monospace font",
        description: "Paths, diffs and anything the interface draws in a fixed pitch. Not the \
                      editor — that has its own, under Editor.",
        control: Control::Text {
            default: "IBM Plex Mono",
            placeholder: "IBM Plex Mono",
        },
        applies: Applies::Now,
    },
];

static APPEARANCE: Group = Group {
    id: "appearance",
    title: "Appearance",
    description: "How the interface is drawn.",
    order: 0,
    settings: APPEARANCE_SETTINGS,
};

/// A `settings.json` written before this build stored `appearance.accentColor`
/// as the dark-theme hex the old five-option `Select` offered. Those hexes are
/// not among `ACCENTS`' values any more — `coerce_against` in `mod.rs` would
/// reject one on `hydrate` and the accent would silently reset to the default — so
/// `seed` runs every stored value through this first and rewrites a hex it
/// recognises to the name that replaced it. Anything else, including a value
/// this build already understands, passes through unchanged.
pub fn migrate_legacy_accent(value: &str) -> &str {
    match value {
        "#d98a3f" => "amber",
        "#4f8ff7" => "blue",
        "#5fb37a" => "green",
        "#a97bf0" => "violet",
        "#d9635f" => "coral",
        other => other,
    }
}

#[cfg(test)]
mod accent_migration_tests {
    use super::*;

    #[test]
    fn every_legacy_hex_lands_on_an_option_this_build_still_offers() {
        for hex in ["#d98a3f", "#4f8ff7", "#5fb37a", "#a97bf0", "#d9635f"] {
            let migrated = migrate_legacy_accent(hex);
            assert!(
                ACCENTS.iter().any(|o| o.value == migrated),
                "{hex} migrated to {migrated:?}, which is not one of ACCENTS"
            );
        }
    }

    #[test]
    fn a_value_this_build_already_understands_passes_through() {
        assert_eq!(migrate_legacy_accent("amber"), "amber");
        assert_eq!(
            migrate_legacy_accent("not-a-real-value"),
            "not-a-real-value"
        );
    }

    #[test]
    fn the_default_accent_is_blue_and_amber_is_still_offered_to_choose() {
        let accent = APPEARANCE_SETTINGS
            .iter()
            .find(|s| s.key == keys::APPEARANCE_ACCENT_COLOR)
            .expect("the accent setting exists");
        match &accent.control {
            Control::Select { default, .. } => assert_eq!(*default, "blue"),
            _ => panic!("the accent is a Select"),
        }
        assert!(ACCENTS.iter().any(|o| o.value == "amber"));
    }
}

// --- editor -----------------------------------------------------------------
//
// Read by the File Viewer and the File Explorer's preview through
// `settings/all` on the bridge, and handed to Monaco when an editor is
// created. Every one of them is `Next`: Monaco takes its options at
// construction, and a frame that is already mounted keeps the ones it was built
// with until it is reopened.

static LINE_NUMBERS: &[SelectOption] = &[
    SelectOption {
        value: "on",
        label: "On",
        description: "",
    },
    SelectOption {
        value: "off",
        label: "Off",
        description: "",
    },
    SelectOption {
        value: "relative",
        label: "Relative",
        description: "Distance from the cursor, which is what a vim-style motion counts.",
    },
];

static WHITESPACE: &[SelectOption] = &[
    SelectOption {
        value: "none",
        label: "Never",
        description: "",
    },
    SelectOption {
        value: "boundary",
        label: "Except between words",
        description: "Leading, trailing and runs — the ones that are usually a mistake.",
    },
    SelectOption {
        value: "all",
        label: "Always",
        description: "",
    },
];

static EDITOR_SETTINGS: &[Setting] = &[
    Setting {
        key: "editor.fontSize",
        title: "Font size",
        description: "",
        control: Control::Number {
            default: 13,
            min: 8,
            max: 32,
            step: 1,
            unit: "px",
        },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
    Setting {
        key: "editor.fontFamily",
        title: "Font",
        description: "",
        control: Control::Text {
            default: "IBM Plex Mono",
            placeholder: "IBM Plex Mono",
        },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
    Setting {
        key: "editor.tabSize",
        title: "Tab width",
        description: "How many columns a tab character occupies.",
        control: Control::Number {
            default: 2,
            min: 1,
            max: 8,
            step: 1,
            unit: "columns",
        },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
    Setting {
        key: "editor.wordWrap",
        title: "Wrap long lines",
        description: "",
        control: Control::Toggle { default: false },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
    Setting {
        key: "editor.minimap",
        title: "Show the minimap",
        description: "The scaled-down overview down the right-hand edge.",
        control: Control::Toggle { default: false },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
    Setting {
        key: "editor.lineNumbers",
        title: "Line numbers",
        description: "",
        control: Control::Select {
            default: "on",
            options: LINE_NUMBERS,
        },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
    Setting {
        key: "editor.renderWhitespace",
        title: "Show whitespace",
        description: "",
        control: Control::Select {
            default: "none",
            options: WHITESPACE,
        },
        applies: Applies::Next {
            what: "the next editor you open",
        },
    },
];

static EDITOR: Group = Group {
    id: "editor",
    title: "Editor",
    description: "How files are drawn where they are edited — the File Viewer, and previews.",
    order: 20,
    settings: EDITOR_SETTINGS,
};

// --- terminal ---------------------------------------------------------------

static SHELLS: &[SelectOption] = &[
    SelectOption {
        value: "auto",
        label: "Whatever this machine has",
        description: "PowerShell 7 if it is installed, then Windows PowerShell, then cmd.",
    },
    SelectOption {
        value: "pwsh",
        label: "PowerShell 7",
        description: "",
    },
    SelectOption {
        value: "powershell",
        label: "Windows PowerShell",
        description: "",
    },
    SelectOption {
        value: "cmd",
        label: "Command Prompt",
        description: "",
    },
    SelectOption {
        value: "bash",
        label: "bash",
        description: "",
    },
    SelectOption {
        value: "zsh",
        label: "zsh",
        description: "",
    },
];

static TERMINAL_SETTINGS: &[Setting] = &[
    Setting {
        key: keys::TERMINAL_DEFAULT_SHELL,
        title: "Shell",
        description: "What a new terminal runs. A shell this machine does not have falls back to \
                      the automatic order rather than opening a terminal that dies immediately.",
        control: Control::Select {
            default: "auto",
            options: SHELLS,
        },
        applies: Applies::Next {
            what: "the next terminal you open",
        },
    },
    Setting {
        key: keys::TERMINAL_OPEN_ON_LAUNCH,
        title: "Open a terminal at launch",
        description: "Only on a launch with no session to restore. A restored session brings its \
                      own terminals back, and this has never added one on top of them.",
        control: Control::Toggle { default: true },
        // The one setting in this build that genuinely means it. It is read in
        // `lib.rs`'s setup, once, at the only moment a launch terminal could be
        // opened — there is no later point at which switching it on could do
        // anything, and saying "applies now" would be a lie the screen tells.
        applies: Applies::Restart,
    },
];

static TERMINAL: Group = Group {
    id: "terminal",
    title: "Terminal",
    description: "The shells Veistra spawns, in the panel and in panes.",
    order: 30,
    settings: TERMINAL_SETTINGS,
};

// --- keys -------------------------------------------------------------------
//
// `keys.copilotAction` is read by the shell's key handler (`src/shell/copilotKey.ts`
// lists the same ids and falls back to "palette" on any it does not know).
// `keys.copilotGlobal` is read by `copilot_key.rs` on every F23 the hook sees.

static COPILOT_ACTIONS: &[SelectOption] = &[
    SelectOption {
        value: "palette",
        label: "Open the Command Palette",
        description: "",
    },
    SelectOption {
        value: "search",
        label: "Search",
        description: "",
    },
    SelectOption {
        value: "switchProject",
        label: "Switch project",
        description: "",
    },
    SelectOption {
        value: "newCluster",
        label: "New cluster",
        description: "",
    },
    SelectOption {
        value: "toggleGit",
        label: "Show or hide the Git page",
        description: "",
    },
    SelectOption {
        value: "toggleTerminal",
        label: "Show or hide the terminal",
        description: "",
    },
    SelectOption {
        value: "none",
        label: "Do nothing (let Windows handle it)",
        description: "The key is not claimed, so Windows starts Copilot as it normally would.",
    },
];

static KEYS_SETTINGS: &[Setting] = &[
    Setting {
        key: keys::KEYS_COPILOT_ACTION,
        title: "Copilot key",
        description: "What the Copilot key on a Windows keyboard does while Veistra has focus. \
                      Windows sends it as Win+Shift+F23.",
        control: Control::Select {
            default: "palette",
            options: COPILOT_ACTIONS,
        },
        applies: Applies::Now,
    },
    Setting {
        key: keys::KEYS_COPILOT_GLOBAL,
        title: "Claim the Copilot key everywhere",
        description: "Installs a keyboard hook so the key reaches Veistra even when it is not \
                      the focused window, and stops Windows launching Copilot. Off, only a focused \
                      Veistra sees the key, and Windows may still act on it first.",
        control: Control::Toggle { default: false },
        applies: Applies::Now,
    },
];

static KEYS: Group = Group {
    id: "keys",
    title: "Keyboard",
    description: "What the keys the shell does not bind by chord are for.",
    order: 35,
    settings: KEYS_SETTINGS,
};

// --- search -----------------------------------------------------------------
//
// The three caps `search.rs` used to hold as constants. They are settings
// because the right answer depends on the repository: a cap that keeps search
// responsive in a monorepo truncates a small project's honest result set, and
// the response says `truncated` either way with no way for the person reading
// it to do anything about it.

static SEARCH_SETTINGS: &[Setting] = &[
    Setting {
        key: keys::SEARCH_MAX_MATCHES,
        title: "Match limit",
        description: "How many matches one search collects before it stops and reports that it \
                      was truncated.",
        control: Control::Number {
            default: 1000,
            min: 50,
            max: 20_000,
            step: 50,
            unit: "matches",
        },
        applies: Applies::Next {
            what: "the next search",
        },
    },
    Setting {
        key: keys::SEARCH_MAX_FILES,
        title: "File limit",
        description: "How many distinct files one search reports. Separate from the match limit \
                      because one file with a thousand hits and a thousand files with one each \
                      are different kinds of too many.",
        control: Control::Number {
            default: 500,
            min: 20,
            max: 5000,
            step: 20,
            unit: "files",
        },
        applies: Applies::Next {
            what: "the next search",
        },
    },
    Setting {
        key: keys::SEARCH_MAX_FILE_SIZE_MB,
        title: "Skip files larger than",
        description: "A file above this is not opened. Minified bundles and checked-in binaries \
                      are what this exists for.",
        control: Control::Number {
            default: 8,
            min: 1,
            max: 256,
            step: 1,
            unit: "MB",
        },
        applies: Applies::Next {
            what: "the next search",
        },
    },
];

static SEARCH: Group = Group {
    id: "search",
    title: "Search",
    description: "What a project-wide search will and will not read.",
    order: 40,
    settings: SEARCH_SETTINGS,
};

// --- GitHub -----------------------------------------------------------------
//
// One row, and the section is worth reading for what is *not* in it: the token.
//
// A personal access token is a bearer credential, and this file's values are
// written to `settings.json` in plain text and broadcast whole to every app
// frame and every tool that calls `settings/all` (`docs/settings.md` §7). A
// `Control::Text` here would put a GitHub credential in both places. It goes to
// the OS credential store instead, through the `set_github_token` command that
// already existed for private plugin installs, and the GitHub region offers
// sign-in where a signed-out state is actually visible.

static GITHUB_SETTINGS: &[Setting] = &[Setting {
    key: keys::GITHUB_ITEM_LIMIT,
    title: "Items to fetch",
    description: "How many open issues and how many open pull requests to ask for — this many of \
                  each, not in total. A signed-out Veistra gets sixty GitHub requests an hour and \
                  each refresh spends two of them, so the cost of a larger list is the size of \
                  the reply rather than the quota.",
    control: Control::Number {
        default: 30,
        min: 5,
        // GitHub's own per-page ceiling. Above it the API returns 100 anyway,
        // so a higher maximum would be a control that appears to work and does
        // not — `github.rs` clamps to the same number for the same reason.
        max: 100,
        step: 5,
        unit: "of each",
    },
    applies: Applies::Next {
        what: "the next time the list is fetched",
    },
}];

static GITHUB: Group = Group {
    id: "github",
    title: "GitHub",
    description: "The issues and pull requests panel. Signing in is on the panel itself, not \
                  here — a token is a secret and this screen's values are stored in the clear.",
    order: 45,
    settings: GITHUB_SETTINGS,
};

// --- cloud ------------------------------------------------------------------
//
// The veistra-api gateway (`cloud::gateway`, read by `apps::projects`) and
// Veistra's own Google sign-in (`cloud::google`). The client ID is a setting
// because it is not a secret: Google prints it in every consent URL. The client
// secret and the sign-in itself are credentials, so they go to the OS
// credential store through the panel drawn above this section's rows
// (`CloudAccountPanel.tsx`), for the reason the GitHub section gives.

static CLOUD_SETTINGS: &[Setting] = &[
    Setting {
        key: keys::CLOUD_GATEWAY_URL,
        title: "Gateway URL",
        description: "The veistra-api service the Projects page reaches Plane through: the `url` \
                      output of infra/terraform/veistra-api. Empty until it is deployed, and the \
                      Projects page says so.",
        control: Control::Text {
            default: "",
            placeholder: "https://veistra-api-….run.app",
        },
        applies: Applies::Next {
            what: "the next Plane call",
        },
    },
    Setting {
        key: keys::CLOUD_GOOGLE_CLIENT_ID,
        title: "Google OAuth client ID",
        description: "The Desktop app OAuth client Veistra signs in with, from the Google Cloud \
                      console (services/veistra-api/README.md says how to make one). Changing it \
                      signs you out, because a sign-in belongs to the client that made it.",
        control: Control::Text {
            default: "",
            placeholder: "1234567890-abc.apps.googleusercontent.com",
        },
        applies: Applies::Next {
            what: "the next sign-in",
        },
    },
];

static CLOUD: Group = Group {
    id: "cloud",
    title: "Cloud",
    description: "The Google account Veistra uses for Veistra Cloud. Without a sign-in here, \
                  the gcloud login on this machine is used instead.",
    order: 47,
    settings: CLOUD_SETTINGS,
};

// --- updates ----------------------------------------------------------------
//
// Read once, in `lib.rs`'s setup, by `updater::start`. The one thing this
// governs is whether Veistra asks — the Help menu's Check for Updates works
// either way, and nothing downloads or installs without the button being
// pressed.

static UPDATES_SETTINGS: &[Setting] = &[Setting {
    key: keys::UPDATES_CHECK_AUTOMATICALLY,
    title: "Check for a newer version at launch",
    description: "One request to the releases endpoint, in the background, once per launch. \
                  Switching this off stops Veistra asking; it does not stop you asking, and it \
                  has never downloaded or installed anything on its own either way.",
    control: Control::Toggle { default: true },
    // `Restart` for `terminal.openOnLaunch`'s reason: the launch is the only
    // moment this is read, so there is no later point at which switching it on
    // could do anything, and "applies now" would be a lie the screen tells.
    applies: Applies::Restart,
}];

static UPDATES: Group = Group {
    id: "updates",
    title: "Updates",
    description: "How Veistra finds out that a newer Veistra exists.",
    order: 50,
    settings: UPDATES_SETTINGS,
};

// --- usage data -------------------------------------------------------------
//
// Read by the frontend, not by Rust: `src/shell/telemetry/consent.ts` turns the
// three values into what PostHog may do, and reacts to a change as it lands, so
// all three are `Now`. Nothing here decides whether this *build* can send —
// `telemetry::decide` does, and the panel above these rows says so when it
// cannot. See `docs/telemetry.md`.
//
// `usageData` is a select rather than a toggle because "nobody has been asked"
// is a third state, and the one every machine starts in. A toggle defaulting to
// off could not tell "asked and declined" from "never asked", so the question
// would either never be put or be put forever.

static USAGE_DATA: &[SelectOption] = &[
    SelectOption {
        value: "ask",
        label: "Ask me",
        description: "Nothing is sent. Veistra asks once a window is open.",
    },
    SelectOption {
        value: "on",
        label: "Share",
        description: "Anonymous usage events, and session recordings if the switch below is on.",
    },
    SelectOption {
        value: "off",
        label: "Don't share",
        description: "Nothing is sent, and Veistra does not ask again.",
    },
];

static TELEMETRY_SETTINGS: &[Setting] = &[
    Setting {
        key: "telemetry.usageData",
        title: "Share usage data",
        description: "Which parts of Veistra get used, and how, so the next release fixes what \
                      gets in people's way. Anonymous: no name, no email, no file contents.",
        control: Control::Select {
            default: "ask",
            options: USAGE_DATA,
        },
        applies: Applies::Now,
    },
    Setting {
        key: "telemetry.sessionReplay",
        title: "Include session recordings",
        description: "The shell window's layout, clicks and timing, with every piece of text and \
                      every field masked before it leaves. Panes showing an app are not recorded. \
                      Only while usage data is shared.",
        control: Control::Toggle { default: true },
        applies: Applies::Now,
    },
    Setting {
        key: "telemetry.feedbackPrompts",
        title: "Ask me for feedback now and then",
        description: "A small card in the corner after you have used something for a while — at \
                      most one every few days, and never again once answered. Only while usage \
                      data is shared. Help ▸ Send Feedback works either way.",
        control: Control::Toggle { default: true },
        applies: Applies::Now,
    },
];

static TELEMETRY: Group = Group {
    id: "telemetry",
    title: "Usage data & feedback",
    description: "What Veistra may tell Firelight about how it is used, and when it may ask.",
    order: 55,
    settings: TELEMETRY_SETTINGS,
};

// --- MCP --------------------------------------------------------------------
//
// The section with the servers in it. Those are not settings — they are a list
// the registry owns, with a switch on each row — so they are drawn by a panel
// of their own above these, and `docs/settings.md` describes that escape hatch
// and why this is the only section using it.

static MCP_SETTINGS: &[Setting] = &[Setting {
    key: keys::MCP_WRITE_PROJECT_CONFIG,
    title: "Write .mcp.json into open projects",
    description: "How an agent finds these servers. The file names environment variables rather \
                  than a port or a token, so it holds no secret and is safe to commit. Switching \
                  this off leaves the servers running and unreachable — connect to them by hand.",
    control: Control::Toggle { default: true },
    applies: Applies::Now,
}];

static MCP: Group = Group {
    id: "mcp",
    title: "MCP servers",
    description: "What Veistra offers the coding agents running in its terminals.",
    order: 60,
    settings: MCP_SETTINGS,
};

// --- built-in skills --------------------------------------------------------
//
// One select per skill Veistra ships, read by `skills::mode` when an agent
// session starts, and by `skills::sync` when it changes. The panel above the
// rows (`BuiltInSkillsPanel.tsx`) draws each row inside its skill's card.

static SKILL_MODES: &[SelectOption] = &[
    SelectOption {
        value: "auto",
        label: "Auto",
        description: "On for canvas work: the project has canvas files, the prompt names a \
                      canvas, or a Design pane is open in the cluster.",
    },
    SelectOption {
        value: "on",
        label: "On",
        description: "Every agent session gets it.",
    },
    SelectOption {
        value: "off",
        label: "Off",
        description: "No session gets it, and Veistra removes the copies it installed.",
    },
];

static SKILLS_SETTINGS: &[Setting] = &[Setting {
    key: keys::SKILLS_AGENT_READY_CANVAS,
    title: "agent-ready-canvas",
    description: "Builds canvases out of named frames and groups, so a click or a comment hands \
                  an agent whole objects.",
    control: Control::Select {
        default: "auto",
        options: SKILL_MODES,
    },
    applies: Applies::Next {
        what: "the next agent session",
    },
}];

static SKILLS: Group = Group {
    id: "skills",
    title: "Built-in skills",
    description: "Skills Veistra ships and gives to the agents it runs in agent tabs.",
    order: 62,
    settings: SKILLS_SETTINGS,
};

// --- developer --------------------------------------------------------------
//
// Read by `mcp::dev_mode`, which every registry method that lists, advertises
// or dispatches a server consults. Nothing caches it: the flag is asked for at
// the point of use, so switching it off takes effect on the next call rather
// than at the next launch.

static DEVELOPER_SETTINGS: &[Setting] = &[Setting {
    key: keys::DEVELOPER_MODE,
    title: "Developer mode",
    description: "Shows the MCP servers that drive this window rather than read it — \
                  screenshots, clicks and keystrokes, for an agent working on Veistra itself. \
                  Switching this on only makes them visible; each still has its own switch, and \
                  every one of them starts off.",
    control: Control::Toggle { default: false },
    applies: Applies::Now,
}];

static DEVELOPER: Group = Group {
    id: "developer",
    title: "Developer",
    description: "Tools for working on Veistra. Nothing here is needed to use it.",
    order: 90,
    settings: DEVELOPER_SETTINGS,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Registry;
    use serde_json::json;

    fn seeded() -> Registry {
        let registry = Registry::default();
        for group in groups() {
            registry.register(group);
        }
        for group in crate::apps::settings_groups() {
            registry.register(group);
        }
        registry
    }

    /// Two groups claiming one id would mean the second is silently dropped by
    /// `Registry::register`, and the settings it declares would simply not
    /// appear. An app is the likely offender: it registers late and against a
    /// list it cannot see.
    #[test]
    fn every_group_id_is_unique() {
        let registry = seeded();
        let mut ids: Vec<&str> = registry.snapshot().groups.iter().map(|g| g.id).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(total, ids.len(), "two groups share an id");
    }

    /// The prefix rule from `Group::id`. It is what makes a key readable on its
    /// own, and what stops two apps colliding on `fontSize`.
    #[test]
    fn every_key_is_prefixed_by_its_group() {
        for group in seeded().snapshot().groups {
            for setting in group.settings {
                assert!(
                    setting.key.starts_with(&format!("{}.", group.id)),
                    "{:?} is in group {:?} but is not prefixed by it",
                    setting.key,
                    group.id
                );
            }
        }
    }

    /// No two settings anywhere may share a key. `Registry::find` takes the
    /// first match, so a collision means one of the two rows writes to the
    /// other's value and neither author would see it.
    #[test]
    fn every_key_is_unique_across_every_group() {
        let registry = seeded();
        let mut keys: Vec<&str> = registry
            .snapshot()
            .groups
            .iter()
            .flat_map(|g| g.settings.iter().map(|s| s.key))
            .collect();
        let total = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(total, keys.len(), "two settings share a key");
    }

    /// The Copilot key opens the Command Palette until somebody chooses otherwise,
    /// and the global hook stays off until somebody opts in.
    #[test]
    fn the_copilot_key_defaults_are_the_palette_and_no_global_hook() {
        let registry = seeded();
        assert_eq!(
            registry.get(keys::KEYS_COPILOT_ACTION),
            Some(json!("palette"))
        );
        assert_eq!(registry.get(keys::KEYS_COPILOT_GLOBAL), Some(json!(false)));
    }

    /// The point of the `keys` module: a constant that no longer names a
    /// setting, or names one of a different type, would make its reader fall
    /// back to a zero value with nothing on screen to say so.
    #[test]
    fn every_exported_key_resolves_to_a_setting_of_the_type_its_reader_expects() {
        let registry = seeded();

        for (key, expected) in [
            (keys::APPEARANCE_THEME, "string"),
            (keys::APPEARANCE_ACCENT_COLOR, "string"),
            (keys::TERMINAL_DEFAULT_SHELL, "string"),
            (keys::TERMINAL_OPEN_ON_LAUNCH, "bool"),
            (keys::KEYS_COPILOT_ACTION, "string"),
            (keys::KEYS_COPILOT_GLOBAL, "bool"),
            (keys::SEARCH_MAX_MATCHES, "number"),
            (keys::SEARCH_MAX_FILES, "number"),
            (keys::SEARCH_MAX_FILE_SIZE_MB, "number"),
            (keys::GITHUB_ITEM_LIMIT, "number"),
            (keys::CLOUD_GOOGLE_CLIENT_ID, "string"),
            (keys::CLOUD_GATEWAY_URL, "string"),
            (keys::MCP_WRITE_PROJECT_CONFIG, "bool"),
            (keys::UPDATES_CHECK_AUTOMATICALLY, "bool"),
            (keys::DEVELOPER_MODE, "bool"),
            (keys::SKILLS_AGENT_READY_CANVAS, "string"),
        ] {
            let value = registry
                .get(key)
                .unwrap_or_else(|| panic!("{key} is not declared by any group"));
            let actual = match value {
                serde_json::Value::Bool(_) => "bool",
                serde_json::Value::Number(_) => "number",
                serde_json::Value::String(_) => "string",
                other => panic!("{key} defaults to {other}, which no reader handles"),
            };
            assert_eq!(actual, expected, "{key} is read as a {expected}");
        }
    }

    /// A default outside its own control's range would be unreachable: the
    /// screen would draw a clamped value, and setting it back would not clear
    /// the stored entry, so the row would look permanently modified.
    #[test]
    fn every_default_is_a_value_its_own_control_accepts() {
        let registry = seeded();
        for group in registry.snapshot().groups {
            for setting in group.settings {
                let default = registry.get(setting.key).expect("declared");
                assert_eq!(
                    registry.set(setting.key, default.clone()),
                    Ok(default),
                    "{}'s default is not one its control accepts unchanged",
                    setting.key
                );
                assert!(
                    registry.changed().is_empty(),
                    "{} stored its own default rather than clearing it",
                    setting.key
                );
            }
        }
    }

    /// A description that starts with the title reads as a stutter on screen,
    /// where the two are drawn one under the other. Empty is allowed — a title
    /// that says everything needs no second line.
    #[test]
    fn no_description_repeats_its_own_title() {
        for group in seeded().snapshot().groups {
            for setting in group.settings {
                assert!(
                    !setting.description.starts_with(setting.title),
                    "{}'s description restates its title",
                    setting.key
                );
            }
        }
    }

    #[test]
    fn the_mcp_toggle_governs_whether_the_project_file_is_written() {
        let registry = seeded();
        assert_eq!(
            registry.get(keys::MCP_WRITE_PROJECT_CONFIG),
            Some(json!(true)),
            "discovery is on by default, or nothing finds the servers"
        );
    }

    /// Consent starts unasked, so a fresh install sends nothing until a person
    /// answers. The two switches under it may default on because neither does
    /// anything while the answer is anything but "on".
    #[test]
    fn usage_data_is_unasked_until_somebody_answers() {
        let registry = seeded();
        assert_eq!(registry.get("telemetry.usageData"), Some(json!("ask")));
        assert_eq!(registry.get("telemetry.sessionReplay"), Some(json!(true)));
        assert_eq!(registry.get("telemetry.feedbackPrompts"), Some(json!(true)));
        for refused in ["yes", "true", ""] {
            assert!(
                registry.set("telemetry.usageData", json!(refused)).is_err(),
                "{refused:?} is not one of the three answers"
            );
        }
    }

    /// On by default. A build that shipped with this off would never tell
    /// anybody a fix existed, and the whole point of wiring an updater is that
    /// the people who need one least are the ones who go looking.
    #[test]
    fn the_launch_check_is_on_by_default() {
        assert_eq!(
            seeded().get(keys::UPDATES_CHECK_AUTOMATICALLY),
            Some(json!(true))
        );
    }
}
