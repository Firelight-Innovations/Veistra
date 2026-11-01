//! Usage data: whether this build may send any, who it says it is when it does,
//! and the ledger the feedback prompts are scheduled from.
//!
//! **The capture itself is not here.** Events and recordings leave from the
//! webview through `posthog-js` (`src/shell/telemetry/`); `docs/telemetry.md`
//! §9 says why, and is the contract for the whole system.
//!
//! What *is* here is everything a person's consent does not decide:
//!
//! - **Whether this build can send at all** ([`decide`]). No project key, a
//!   development build and an agent's build send nothing.
//! - **The install id.** One anonymous id per machine, so every window reports
//!   as the same person and a cleared webview profile does not mint a new one.
//! - **The ledger.** Counts and prompt history. In Rust rather than in
//!   `localStorage` because two windows count at once, and a read-modify-write
//!   in two webviews loses increments that one mutex here does not.
//!
//! Nothing in `telemetry.json` leaves the machine by itself. The install id is
//! sent only once usage data is switched on; the counts never are.

use crate::error::{AppError, Result};
use crate::sync::MutexExt;
use crate::userdata::store::Keep;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// The PostHog project key, read at run time and then baked in at build time.
///
/// A project key is write-only and is printed into every page that uses one,
/// so it is not a secret — but it is still not committed, because a fork of
/// this repository built by somebody else must not report into Firelight's
/// project. The release workflow sets it; `build.rs` makes cargo notice.
pub const KEY_ENV: &str = "VEISTRA_POSTHOG_KEY";

/// Where events go. Unset means PostHog's US cloud.
pub const HOST_ENV: &str = "VEISTRA_POSTHOG_HOST";

/// `0` stops a build that could send; `1` lets a development or agent build
/// send. Unset leaves [`decide`]'s defaults alone.
pub const SWITCH_ENV: &str = "VEISTRA_TELEMETRY";

pub const DEFAULT_HOST: &str = "https://us.i.posthog.com";

const FILE: &str = "telemetry.json";

/// Losing the file costs a new anonymous id and a prompt that may be asked a
/// second time. Annoying, never destructive.
const KEEP: Keep = Keep::Nothing;

/// How many distinct counters the ledger holds before it refuses a new one.
///
/// A counter is named by the frontend, so a bug that put an id or a path in
/// the name would otherwise grow the file without bound.
const MAX_COUNTERS: usize = 512;

/// Whether anything can be sent from this process, and where to.
///
/// Internally tagged so the frontend narrows on `state` and the key only
/// exists on the arm that can use it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Sink {
    #[serde(rename_all = "camelCase")]
    Ready { api_key: String, host: String },
    /// `reason` is a sentence for the settings screen, which shows it in place
    /// of a switch that could not do anything.
    Off { reason: String },
}

/// What the shell needs to start PostHog. Mirrored by `TelemetryConfig` in
/// `src/bindings.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub sink: Sink,
    pub install_id: String,
    pub app_version: String,
    pub os: &'static str,
    pub arch: &'static str,
    /// `"release"` or `"debug"`, so a forced development build is told apart.
    pub build: &'static str,
}

/// One prompt's history. Mirrored by `PromptRecord` in `src/bindings.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptRecord {
    /// How many times it has been put on screen.
    pub shown: u32,
    pub last_shown_ms: Option<u64>,
    /// Set once, by an answer. A prompt that has been answered is never shown
    /// again; one that was only dismissed may be, after its cooldown.
    pub answered_ms: Option<u64>,
}

/// What is on disk, and what the frontend schedules from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ledger {
    /// Empty until the first [`config`] call mints one.
    pub install_id: String,
    pub first_seen_ms: u64,
    pub launches: u32,
    /// Keyed `"<feature>:<event>"`. Only events a prompt waits on are counted
    /// — see `countedEvents` in `src/shell/telemetry/prompts.ts`.
    pub counts: BTreeMap<String, u32>,
    pub prompts: BTreeMap<String, PromptRecord>,
}

/// What happened to a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptOutcome {
    Shown,
    Answered,
}

/// The ledger, loaded on first use and written through on every change.
#[derive(Default)]
pub struct Telemetry {
    ledger: Mutex<Option<Ledger>>,
}

/// Whether a build with this key, identifier and environment may send.
///
/// Pure, so every branch is a unit test rather than a launch. The order is the
/// precedence: the kill switch beats everything, a missing key cannot be
/// forced past, and only then does `1` override the two "this is not a person
/// using the product" defaults.
pub fn decide(
    key: Option<&str>,
    host: Option<&str>,
    identifier: &str,
    debug: bool,
    switch: Option<&str>,
) -> Sink {
    let off = |reason: &str| Sink::Off {
        reason: reason.to_string(),
    };
    let switch = switch.map(str::trim).map(str::to_ascii_lowercase);
    if matches!(switch.as_deref(), Some("0" | "off" | "false")) {
        return off("VEISTRA_TELEMETRY is off in this environment, so nothing is sent.");
    }
    let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) else {
        return off(
            "This build was made without a PostHog project key, so it has nowhere to send.",
        );
    };
    let forced = matches!(switch.as_deref(), Some("1" | "on" | "true"));
    if debug && !forced {
        return off("A development build sends nothing unless VEISTRA_TELEMETRY=1 is set.");
    }
    if identifier != crate::userdata::identity::IDENTIFIER && !forced {
        return Sink::Off {
            reason: format!(
                "This build runs as {identifier}, an agent's instance, and its clicks are not a \
                 person's. VEISTRA_TELEMETRY=1 sends anyway."
            ),
        };
    }
    let host = host
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or(DEFAULT_HOST)
        .trim_end_matches('/');
    // https only: the key rides in every request, and a plain-http host is far
    // more likely a typo in an environment variable than a real collector.
    if !host.starts_with("https://") {
        return Sink::Off {
            reason: format!("{HOST_ENV} is {host:?}, which is not an https address."),
        };
    }
    Sink::Ready {
        api_key: key.to_string(),
        host: host.to_string(),
    }
}

/// The run-time variable if set, else whatever the build baked in.
///
/// Read per call, like `cloud::Source::from_env`, so pointing a running
/// development build somewhere needs nothing but the variable.
fn setting(name: &str, baked: Option<&'static str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| baked.map(str::to_string))
}

/// Everything the shell needs to start PostHog, minting the install id the
/// first time it is asked. Safe to call from every window, any number of times.
pub fn config(app: &AppHandle) -> TelemetryConfig {
    let sink = decide(
        setting(KEY_ENV, option_env!("VEISTRA_POSTHOG_KEY")).as_deref(),
        setting(HOST_ENV, option_env!("VEISTRA_POSTHOG_HOST")).as_deref(),
        &app.config().identifier,
        cfg!(debug_assertions),
        std::env::var(SWITCH_ENV).ok().as_deref(),
    );
    let install_id = app
        .state::<Telemetry>()
        .with(app, |ledger| ensure_identity(ledger, now_ms()))
        .install_id;
    TelemetryConfig {
        sink,
        install_id,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        build: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
    }
}

/// Count this launch. Called once, from `lib.rs`'s setup.
pub fn note_launch(app: &AppHandle) {
    app.state::<Telemetry>().with(app, |ledger| {
        ensure_identity(ledger, now_ms());
        ledger.launches = ledger.launches.saturating_add(1);
    });
}

/// The ledger as it stands.
pub fn ledger(app: &AppHandle) -> Ledger {
    app.state::<Telemetry>().with(app, |_| {})
}

/// Add one to a counter and answer with the whole ledger, so the caller can
/// decide on a prompt without a second round trip.
pub fn count(app: &AppHandle, key: &str) -> Result<Ledger> {
    check_name(key)?;
    let mut refused = false;
    let ledger = app.state::<Telemetry>().with(app, |ledger| {
        refused = !bump(ledger, key);
    });
    if refused {
        return Err(AppError::Telemetry(format!(
            "the usage ledger already holds {MAX_COUNTERS} counters, so {key:?} was not added"
        )));
    }
    Ok(ledger)
}

/// Record that a prompt was shown or answered.
pub fn record_prompt(app: &AppHandle, id: &str, outcome: PromptOutcome) -> Result<Ledger> {
    check_name(id)?;
    Ok(app
        .state::<Telemetry>()
        .with(app, |ledger| apply_outcome(ledger, id, outcome, now_ms())))
}

impl Telemetry {
    /// Load if needed, apply `change`, write if anything moved, and answer with
    /// a copy. The write happens under the lock, so two windows counting at
    /// once land in order on disk as well as in memory.
    fn with(&self, app: &AppHandle, change: impl FnOnce(&mut Ledger)) -> Ledger {
        let mut slot = self.ledger.lock_or_panic();
        let ledger = slot.get_or_insert_with(|| load(app));
        let before = ledger.clone();
        change(ledger);
        if *ledger != before {
            save(app, ledger);
        }
        ledger.clone()
    }
}

fn ensure_identity(ledger: &mut Ledger, now: u64) {
    if ledger.install_id.is_empty() {
        ledger.install_id = new_install_id();
    }
    if ledger.first_seen_ms == 0 {
        ledger.first_seen_ms = now;
    }
}

/// Add one, unless that would mean a counter past [`MAX_COUNTERS`]. Answers
/// whether it counted.
fn bump(ledger: &mut Ledger, key: &str) -> bool {
    if !ledger.counts.contains_key(key) && ledger.counts.len() >= MAX_COUNTERS {
        return false;
    }
    let n = ledger.counts.entry(key.to_string()).or_default();
    *n = n.saturating_add(1);
    true
}

fn apply_outcome(ledger: &mut Ledger, id: &str, outcome: PromptOutcome, now: u64) {
    let record = ledger.prompts.entry(id.to_string()).or_default();
    match outcome {
        PromptOutcome::Shown => {
            record.shown = record.shown.saturating_add(1);
            record.last_shown_ms = Some(now);
        }
        // The first answer is the one kept. A second would mean the same
        // prompt was on screen twice, and the earlier date is the true one.
        PromptOutcome::Answered => {
            record.answered_ms.get_or_insert(now);
        }
    }
}

/// Counter and prompt names: `^[a-z0-9][a-z0-9_:/.-]{0,95}$`.
///
/// Checked here because they become keys in a file and nothing else would
/// stop a path or a sentence becoming one.
fn check_name(name: &str) -> Result<()> {
    let ok = name.len() <= 96
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | ':' | '/' | '.' | '-')
        });
    if ok {
        Ok(())
    } else {
        Err(AppError::Telemetry(format!(
            "{name:?} is not a usage counter name: lower-case letters, digits and _:/.- only"
        )))
    }
}

/// A random version-4 UUID, which is the shape PostHog expects a distinct id
/// to have when it is not an email or a database key.
fn new_install_id() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load(app: &AppHandle) -> Ledger {
    file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default()
}

fn save(app: &AppHandle, ledger: &Ledger) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, ledger, "the usage ledger");
    }
}

/// Beside `settings.json`, never inside a project.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::userdata::identity::IDENTIFIER;

    const KEY: Option<&str> = Some("phc_test");

    fn reason(sink: Sink) -> String {
        match sink {
            Sink::Off { reason } => reason,
            Sink::Ready { .. } => panic!("expected Off, got Ready"),
        }
    }

    #[test]
    fn a_release_build_of_the_product_with_a_key_is_ready_on_the_default_host() {
        assert_eq!(
            decide(KEY, None, IDENTIFIER, false, None),
            Sink::Ready {
                api_key: "phc_test".into(),
                host: DEFAULT_HOST.into()
            }
        );
    }

    #[test]
    fn no_key_is_off_and_cannot_be_forced() {
        assert!(reason(decide(None, None, IDENTIFIER, false, Some("1"))).contains("key"));
        assert!(reason(decide(Some("  "), None, IDENTIFIER, false, None)).contains("key"));
    }

    #[test]
    fn the_kill_switch_beats_everything() {
        for off in ["0", "off", "FALSE", " 0 "] {
            assert!(
                reason(decide(KEY, None, IDENTIFIER, false, Some(off)))
                    .contains("VEISTRA_TELEMETRY"),
                "{off:?}"
            );
        }
    }

    /// `pnpm app` and `pnpm ui launch` are a developer and an agent, and
    /// neither belongs in the numbers a product decision is made from.
    #[test]
    fn debug_and_agent_builds_are_off_unless_forced() {
        assert!(matches!(
            decide(KEY, None, IDENTIFIER, true, None),
            Sink::Off { .. }
        ));
        let agent = format!("{IDENTIFIER}.agent");
        assert!(reason(decide(KEY, None, &agent, false, None)).contains(&agent));
        assert!(matches!(
            decide(KEY, None, &agent, true, Some("1")),
            Sink::Ready { .. }
        ));
    }

    #[test]
    fn a_host_is_trimmed_and_must_be_https() {
        assert_eq!(
            decide(
                KEY,
                Some("https://eu.i.posthog.com/"),
                IDENTIFIER,
                false,
                None
            ),
            Sink::Ready {
                api_key: "phc_test".into(),
                host: "https://eu.i.posthog.com".into()
            }
        );
        assert!(reason(decide(
            KEY,
            Some("http://eu.i.posthog.com"),
            IDENTIFIER,
            false,
            None
        ))
        .contains("https"));
    }

    #[test]
    fn an_install_id_is_a_v4_uuid_and_is_minted_once() {
        let id = new_install_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4", "{id}");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");

        let mut ledger = Ledger::default();
        ensure_identity(&mut ledger, 10);
        let first = ledger.clone();
        ensure_identity(&mut ledger, 20);
        assert_eq!(ledger, first, "a second call changes nothing");
        assert_eq!(ledger.first_seen_ms, 10);
    }

    #[test]
    fn counting_adds_one_and_refuses_a_counter_past_the_cap() {
        let mut ledger = Ledger::default();
        assert!(bump(&mut ledger, "canvas:opened"));
        assert!(bump(&mut ledger, "canvas:opened"));
        assert_eq!(ledger.counts["canvas:opened"], 2);

        for i in ledger.counts.len()..MAX_COUNTERS {
            assert!(bump(&mut ledger, &format!("filler:{i}")));
        }
        assert!(!bump(&mut ledger, "one:too-many"));
        assert!(
            bump(&mut ledger, "canvas:opened"),
            "an existing counter still counts at the cap"
        );
    }

    #[test]
    fn a_prompt_keeps_its_first_answer() {
        let mut ledger = Ledger::default();
        apply_outcome(&mut ledger, "general", PromptOutcome::Shown, 5);
        apply_outcome(&mut ledger, "general", PromptOutcome::Shown, 9);
        apply_outcome(&mut ledger, "general", PromptOutcome::Answered, 10);
        apply_outcome(&mut ledger, "general", PromptOutcome::Answered, 11);
        assert_eq!(
            ledger.prompts["general"],
            PromptRecord {
                shown: 2,
                last_shown_ms: Some(9),
                answered_ms: Some(10)
            }
        );
    }

    #[test]
    fn names_are_lower_case_and_bounded() {
        for good in ["canvas:opened", "agent-tab:prompt_sent", "general/nps.v1"] {
            assert!(check_name(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "Canvas:opened",
            ":x",
            "C:\\Users\\me",
            "has space",
            &"a".repeat(97),
        ] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
    }

    /// The store's degradation promise, for this file: an older build's file
    /// and a newer build's both load.
    #[test]
    fn a_ledger_from_another_build_still_loads() {
        let older: Ledger = serde_json::from_str(r#"{"installId":"x"}"#).expect("parses");
        assert_eq!(older.install_id, "x");
        assert!(older.counts.is_empty());
        let newer: Ledger =
            serde_json::from_str(r#"{"installId":"x","launches":3,"cohort":"beta"}"#)
                .expect("parses");
        assert_eq!(newer.launches, 3);
    }
}
