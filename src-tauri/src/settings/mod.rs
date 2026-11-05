//! Settings — what Veistra lets you change, and what the change is worth.
//!
//! The rules for adding one, and the interface an app registers a section
//! through, are in `docs/settings.md`. This module is the vocabulary they are
//! written in.

pub mod commands;

pub mod markup;
mod schema;
mod store;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Read by `account::tests`; the app reads it through the setting's default.
#[cfg(test)]
pub use schema::DEFAULT_ACCOUNT_API;
pub use schema::{keys, DEFAULT_ACCOUNT_WEB};

/// The event every window and every app frontend listens on, so a setting
/// changed in one window reaches the others without either of them asking.
///
/// The payload is the whole value map rather than the one key that moved. It is
/// small — only what has been changed away from its default is in it — and a
/// window that mounted late could never have heard the deltas it missed, since
/// Tauri events have no replay. Same shape and same reasoning as
/// `presets:changed`.
pub const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

/// One option in a [`Control::Select`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    pub value: &'static str,
    pub label: &'static str,
    /// A sentence under the label, or empty for an option whose label is the
    /// whole story. Empty rather than `Option` because the frontend draws a
    /// row either way and an absent string and an empty one render the same.
    pub description: &'static str,
}

/// What a setting is edited with, and what it holds when nobody has edited it.
///
/// The default is *inside* the control rather than beside it, because the two
/// are one decision: a default has to be a value its own control can produce,
/// and a `Number` defaulting to `"large"` is not a mistake anybody should be
/// able to write. Splitting them would make that pair checkable only at
/// runtime, and only on the first launch that read the file.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Control {
    Toggle {
        default: bool,
    },
    #[serde(rename_all = "camelCase")]
    Number {
        default: i64,
        min: i64,
        max: i64,
        step: i64,
        /// `px`, `ms`, `results`. Drawn after the field; empty for a bare
        /// count.
        unit: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        default: &'static str,
        placeholder: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    Select {
        default: &'static str,
        options: &'static [SelectOption],
    },
}

/// When a change takes effect.
///
/// Carried in the descriptor and drawn under the control, because most of these
/// settings are read at the moment something is *created* — a pty is spawned, a
/// search is started, an editor is mounted — and a toggle that silently does
/// nothing to what is already on screen is the single most common way a
/// settings screen loses the user's trust. Saying so costs one line and is the
/// difference between a limitation and a bug.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "when", rename_all = "camelCase")]
pub enum Applies {
    /// Visible without anything being reopened.
    Now,
    /// Read when the next one of something is made. The string names it —
    /// "the next terminal you open" — and is shown verbatim.
    Next { what: &'static str },
    /// Read once, at launch.
    Restart,
}

/// One setting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    /// `search.maxResults`. Dotted, and the part before the first dot is the
    /// group it belongs to — see [`Group::id`].
    pub key: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub control: Control,
    pub applies: Applies,
}

/// A section of the settings screen, and everything in it.
///
/// Registered whole rather than one setting at a time. A section is the unit
/// the screen navigates by, so an app that could add a row to somebody else's
/// section would be able to make a section nobody owns — and the registry would
/// have to invent an order for the rows in it. A group arrives with its title,
/// its blurb and its rows already in the order its author chose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// `search`. Every key in `settings` must start with `<id>.`, which
    /// [`Registry::register`] checks — the prefix is what makes a key readable
    /// on its own and what stops two apps colliding on `fontSize`.
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// Lower sorts earlier. The shell's own groups take 0–99 and an app's take
    /// 100+, so apps land under the shell however many of them there are.
    pub order: i32,
    pub settings: &'static [Setting],
}

/// Why a write was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingError {
    #[error("no setting named {0:?}")]
    UnknownKey(String),
    #[error("{key} is a {expected}")]
    WrongType { key: String, expected: &'static str },
    #[error("{value} is not one of the options for {key}")]
    NotAnOption { key: String, value: String },
}

/// Every group this build has, and every value changed away from its default.
///
/// The one thing the frontend fetches. Sent whole because the screen draws all
/// of it at once, and because a settings screen holding a few dozen rows is
/// smaller than the request that would fetch them a section at a time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub groups: Vec<Group>,
    pub values: BTreeMap<String, Value>,
}

/// What is registered, and what has been changed.
///
/// **No method returns a guard.** Every one copies what it needs and drops the
/// lock before returning, so a `std::sync::Mutex` guard can never be held across
/// an `.await` in a command. The same invariant `mcp::Registry` holds, for the
/// same reason.
#[derive(Default)]
pub struct Registry {
    groups: Mutex<Vec<&'static Group>>,
    /// Sparse, on purpose: only what has been changed is in here. A key at its
    /// default is *absent* rather than stored, which is what lets a later build
    /// change a default and have the new one reach everybody who never touched
    /// it. A file full of every key at its shipped value would freeze this
    /// build's opinions into every machine that ever opened the screen.
    values: Mutex<BTreeMap<String, Value>>,
}

impl Registry {
    /// Add a group. A second registration of the same id is ignored, so seeding
    /// twice is safe.
    ///
    /// A setting whose key does not carry the group's prefix is dropped with a
    /// line on stderr rather than taking the group down with it. The schema test
    /// below catches it before anything ships; this is what happens if one ever
    /// gets past that.
    pub fn register(&self, group: &'static Group) {
        let Ok(mut groups) = self.groups.lock() else {
            return;
        };
        if groups.iter().any(|g| g.id == group.id) {
            return;
        }
        for setting in group.settings {
            if !setting.key.starts_with(&format!("{}.", group.id)) {
                crate::veistra_log!(
                    "setting {:?} is in group {:?} but is not prefixed by it",
                    setting.key,
                    group.id
                );
            }
        }
        groups.push(group);
        groups.sort_by_key(|g| (g.order, g.id));
    }

    /// Take what was read off disk, keeping only what this build still declares
    /// and still accepts.
    ///
    /// Both filters matter and they fail differently. A key no group declares is
    /// a setting a later build added or an earlier one removed, and keeping it
    /// would make the screen unable to show or clear it. A value the control
    /// refuses is a hand-edited file, and taking it would put the UI in a state
    /// its own controls cannot represent.
    pub fn hydrate(&self, stored: BTreeMap<String, Value>) {
        let mut kept = BTreeMap::new();
        for (key, value) in stored {
            match self.coerce(&key, value) {
                Ok(coerced) => {
                    kept.insert(key, coerced);
                }
                Err(e) => crate::veistra_log!("ignoring a stored setting: {e}"),
            }
        }
        if let Ok(mut values) = self.values.lock() {
            *values = kept;
        }
    }

    /// Everything the settings screen draws.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            groups: self
                .groups
                .lock()
                .map(|g| g.iter().map(|group| (*group).clone()).collect())
                .unwrap_or_default(),
            values: self.values.lock().map(|v| v.clone()).unwrap_or_default(),
        }
    }

    /// Only what has been changed away from its default. What the store writes.
    pub fn changed(&self) -> BTreeMap<String, Value> {
        self.values.lock().map(|v| v.clone()).unwrap_or_default()
    }

    /// One setting's current value: what was stored, or what it ships with.
    ///
    /// `None` only for a key no group declares, which is a typo rather than a
    /// state — see the schema test.
    pub fn get(&self, key: &str) -> Option<Value> {
        if let Ok(values) = self.values.lock() {
            if let Some(value) = values.get(key) {
                return Some(value.clone());
            }
        }
        self.find(key).map(|s| default_of(&s.control))
    }

    /// Change one, returning the value that was actually stored.
    ///
    /// Not necessarily the one passed in: a `Number` is clamped to its range
    /// rather than refused, so a stepper held at the edge and a hand-edited
    /// file both land somewhere the UI can draw. The caller is told what it got.
    ///
    /// Setting a value back to its default *removes* it, which is what keeps
    /// `values` sparse — see the field's own note.
    pub fn set(&self, key: &str, value: Value) -> Result<Value, SettingError> {
        let coerced = self.coerce(key, value)?;
        let is_default = self
            .find(key)
            .map(|s| default_of(&s.control) == coerced)
            .unwrap_or(false);

        if let Ok(mut values) = self.values.lock() {
            if is_default {
                values.remove(key);
            } else {
                values.insert(key.to_string(), coerced.clone());
            }
        }
        Ok(coerced)
    }

    /// Put one back to what it ships with.
    pub fn reset(&self, key: &str) -> Result<Value, SettingError> {
        let setting = self
            .find(key)
            .ok_or_else(|| SettingError::UnknownKey(key.to_string()))?;
        if let Ok(mut values) = self.values.lock() {
            values.remove(key);
        }
        Ok(default_of(&setting.control))
    }

    /// Put every setting in one group back. Returns how many actually moved.
    pub fn reset_group(&self, id: &str) -> usize {
        let keys: Vec<&'static str> = self
            .groups
            .lock()
            .map(|groups| {
                groups
                    .iter()
                    .filter(|g| g.id == id)
                    .flat_map(|g| g.settings.iter().map(|s| s.key))
                    .collect()
            })
            .unwrap_or_default();

        let Ok(mut values) = self.values.lock() else {
            return 0;
        };
        keys.iter()
            .filter(|key| values.remove(**key).is_some())
            .count()
    }

    /// The descriptor for a key, cloned out so the lock is not held.
    fn find(&self, key: &str) -> Option<Setting> {
        let groups = self.groups.lock().ok()?;
        groups
            .iter()
            .flat_map(|g| g.settings.iter())
            .find(|s| s.key == key)
            .cloned()
    }

    /// Check a value against its control, and bring it into range.
    fn coerce(&self, key: &str, value: Value) -> Result<Value, SettingError> {
        let setting = self
            .find(key)
            .ok_or_else(|| SettingError::UnknownKey(key.to_string()))?;
        coerce_against(key, &setting.control, value)
    }
}

/// The value a control holds when nothing has been stored for it.
fn default_of(control: &Control) -> Value {
    match control {
        Control::Toggle { default } => json!(default),
        Control::Number { default, .. } => json!(default),
        Control::Text { default, .. } => json!(default),
        Control::Select { default, .. } => json!(default),
    }
}

/// Validation, split out from [`Registry`] so it can be tested without one.
fn coerce_against(key: &str, control: &Control, value: Value) -> Result<Value, SettingError> {
    let wrong = |expected| SettingError::WrongType {
        key: key.to_string(),
        expected,
    };

    match control {
        Control::Toggle { .. } => value
            .as_bool()
            .map(|b| json!(b))
            .ok_or_else(|| wrong("toggle")),

        Control::Number { min, max, .. } => {
            // `as_i64` rather than `as_f64().round()`: a fractional font size is
            // a different setting than the one declared, and rounding it would
            // accept a document that was meant to be rejected.
            let n = value.as_i64().ok_or_else(|| wrong("whole number"))?;
            Ok(json!(n.clamp(*min, *max)))
        }

        Control::Text { .. } => value
            .as_str()
            .map(|s| json!(s))
            .ok_or_else(|| wrong("piece of text")),

        Control::Select { options, .. } => {
            let s = value.as_str().ok_or_else(|| wrong("choice"))?;
            if options.iter().any(|o| o.value == s) {
                Ok(json!(s))
            } else {
                Err(SettingError::NotAnOption {
                    key: key.to_string(),
                    value: s.to_string(),
                })
            }
        }
    }
}

/// Register the shell's groups and every app's, then load what is on disk.
///
/// Called once, in `lib.rs`'s setup, before the first window paints. Ordering
/// is load-bearing in one direction only: [`Registry::hydrate`] drops keys no
/// group declares, so every group has to be registered before the file is read.
pub fn seed(app: &AppHandle) {
    let registry = app.state::<Registry>();
    for group in schema::groups() {
        registry.register(group);
    }
    for group in crate::apps::settings_groups() {
        registry.register(group);
    }

    let mut stored = store::load(app).values;
    // A pre-rework file's accent is a hex the current `Select` no longer
    // offers (see `schema::migrate_legacy_accent`); `hydrate` would otherwise
    // drop it and reset the accent to the default for every existing install.
    if let Some(Value::String(hex)) = stored.get(schema::keys::APPEARANCE_ACCENT_COLOR) {
        let migrated = schema::migrate_legacy_accent(hex).to_string();
        stored.insert(
            schema::keys::APPEARANCE_ACCENT_COLOR.to_string(),
            json!(migrated),
        );
    }
    markup::migrate_legacy(&mut stored);
    registry.hydrate(stored);
}

/// Persist and broadcast. Every write goes through here.
fn commit(app: &AppHandle) {
    let registry = app.state::<Registry>();
    let values = registry.changed();
    store::save(
        app,
        &store::Stored {
            values: values.clone(),
        },
    );
    if let Err(e) = app.emit(SETTINGS_CHANGED_EVENT, &values) {
        crate::veistra_log!("could not announce the settings change: {e}");
    }
}

/// Do whatever a changed setting needs done outside the settings store.
///
/// Almost nothing belongs here. A setting is read at the point it is used, so
/// the overwhelming majority of them need no reaction at all — the next pty, the
/// next editor, the next paint simply picks the new value up.
///
/// The exception is a setting whose reader is **a file on disk**. `.mcp.json` is
/// written, not consulted, so a change that only moved a value in memory would
/// leave that file describing a Veistra that no longer exists until something else
/// happened to rewrite it. Both keys below decide what goes in it.
///
/// Matching on the key rather than syncing after every write, because that file
/// belongs to the user's project and rewriting it on an accent-colour change is
/// a diff they did not ask for.
fn react(app: &AppHandle, key: &str) {
    if matches!(key, keys::MCP_WRITE_PROJECT_CONFIG | keys::DEVELOPER_MODE) {
        crate::mcp::sync_all(app);
    }
    if key == keys::KEYS_COPILOT_GLOBAL {
        crate::copilot_key::sync(app);
    }
    if key.starts_with("skills.") {
        crate::skills::sync(app);
    }
}

/// The same, for a whole section going back to its defaults.
///
/// By group id, because `reset_group` reports how many settings moved and not
/// which — and the answer only has to be "did anything in this section need a
/// reaction", which the id already tells us.
fn react_group(app: &AppHandle, id: &str) {
    if matches!(id, "mcp" | "developer") {
        crate::mcp::sync_all(app);
    }
    if id == "keys" {
        crate::copilot_key::sync(app);
    }
    if id == "skills" {
        crate::skills::sync(app);
    }
}

/// The method an app frame calls to change one of its own settings.
pub const APP_SET_METHOD: &str = "settings/set";

/// The only keys an app frame may write. Every other setting is the person's to
/// change on the settings screen: an app that could write any key could turn on
/// developer mode or move the MCP servers. These two are the shared Markup
/// section, flipped from a viewer's own "make this automatic" prompt.
pub const APP_WRITABLE: &[&str] = &[markup::AUTO_SEND, markup::TIP];

/// Validates a `settings/set` call without touching the registry, so the refusal
/// is testable without an app handle.
pub fn parse_app_set(params: Option<&Value>) -> Result<(String, Value), veistra_rpc::RpcError> {
    let bad = |m: String| veistra_rpc::RpcError::new(veistra_rpc::INVALID_PARAMS, m);
    let key = params
        .and_then(|p| p.get("key"))
        .and_then(Value::as_str)
        .ok_or_else(|| bad("settings/set needs a string `key`".into()))?;
    let value = params
        .and_then(|p| p.get("value"))
        .cloned()
        .ok_or_else(|| bad("settings/set needs a `value`".into()))?;
    if !APP_WRITABLE.contains(&key) {
        return Err(bad(format!("an app may not change the setting `{key}`")));
    }
    Ok((key.to_string(), value))
}

/// `settings/set` from an app frame: validated, stored, persisted and announced
/// the same way the settings screen's own write is.
pub fn app_set(app: &AppHandle, params: Option<&Value>) -> Result<Value, veistra_rpc::RpcError> {
    let (key, value) = parse_app_set(params)?;
    let stored = app
        .state::<Registry>()
        .set(&key, value)
        .map_err(|e| veistra_rpc::RpcError::new(veistra_rpc::INVALID_PARAMS, e.to_string()))?;
    commit(app);
    react(app, &key);
    Ok(stored)
}

/// The ids of the shell's own sections, for anything that names a section.
pub fn shell_group_ids() -> impl Iterator<Item = &'static str> {
    schema::groups().iter().map(|g| g.id)
}

/// A toggle's current value, for the Rust that acts on it.
pub fn flag(app: &AppHandle, key: &str) -> bool {
    app.state::<Registry>()
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| {
            crate::veistra_log!("{key:?} is not a toggle any build declares");
            false
        })
}

/// A number's current value.
pub fn number(app: &AppHandle, key: &str) -> i64 {
    app.state::<Registry>()
        .get(key)
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            crate::veistra_log!("{key:?} is not a number any build declares");
            0
        })
}

/// A text or select setting's current value.
pub fn text(app: &AppHandle, key: &str) -> String {
    app.state::<Registry>()
        .get(key)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| {
            crate::veistra_log!("{key:?} is not a string any build declares");
            String::new()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    static OPTIONS: &[SelectOption] = &[
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
    ];

    static SETTINGS: &[Setting] = &[
        Setting {
            key: "demo.flag",
            title: "A flag",
            description: "",
            control: Control::Toggle { default: true },
            applies: Applies::Now,
        },
        Setting {
            key: "demo.size",
            title: "A size",
            description: "",
            control: Control::Number {
                default: 13,
                min: 8,
                max: 24,
                step: 1,
                unit: "px",
            },
            applies: Applies::Now,
        },
        Setting {
            key: "demo.mode",
            title: "A mode",
            description: "",
            control: Control::Select {
                default: "on",
                options: OPTIONS,
            },
            applies: Applies::Restart,
        },
    ];

    static GROUP: Group = Group {
        id: "demo",
        title: "Demo",
        description: "",
        order: 0,
        settings: SETTINGS,
    };

    fn registry() -> Registry {
        let registry = Registry::default();
        registry.register(&GROUP);
        registry
    }

    #[test]
    fn an_untouched_setting_reads_as_its_declared_default() {
        let registry = registry();
        assert_eq!(registry.get("demo.flag"), Some(json!(true)));
        assert_eq!(registry.get("demo.size"), Some(json!(13)));
        assert_eq!(registry.get("demo.mode"), Some(json!("on")));
    }

    /// The sparseness rule, which is what lets a later build change a default.
    /// Storing every key at its shipped value would freeze this build's
    /// opinions onto every machine that opened the screen once.
    #[test]
    fn only_what_was_changed_is_stored() {
        let registry = registry();

        registry.set("demo.size", json!(16)).expect("in range");
        assert_eq!(registry.changed().len(), 1);

        registry.set("demo.size", json!(13)).expect("the default");
        assert!(
            registry.changed().is_empty(),
            "setting a value back to its default removes it rather than storing it"
        );
    }

    #[test]
    fn a_number_is_clamped_rather_than_refused() {
        let registry = registry();
        assert_eq!(registry.set("demo.size", json!(999)), Ok(json!(24)));
        assert_eq!(registry.set("demo.size", json!(-4)), Ok(json!(8)));
    }

    #[test]
    fn a_value_of_the_wrong_type_is_refused() {
        let registry = registry();
        assert!(matches!(
            registry.set("demo.flag", json!("yes")),
            Err(SettingError::WrongType { .. })
        ));
        assert!(matches!(
            registry.set("demo.size", json!(12.5)),
            Err(SettingError::WrongType { .. })
        ));
    }

    /// A select is the one control that refuses rather than coerces. There is
    /// no nearest valid option to fall back to, and picking one would be
    /// inventing an answer.
    #[test]
    fn a_choice_outside_the_options_is_refused() {
        let registry = registry();
        assert_eq!(
            registry.set("demo.mode", json!("sideways")),
            Err(SettingError::NotAnOption {
                key: "demo.mode".to_string(),
                value: "sideways".to_string(),
            })
        );
    }

    #[test]
    fn an_unknown_key_is_refused_rather_than_stored() {
        let registry = registry();
        assert_eq!(
            registry.set("demo.invented", json!(true)),
            Err(SettingError::UnknownKey("demo.invented".to_string()))
        );
        assert_eq!(registry.get("demo.invented"), None);
    }

    /// The forward- and backward-compatibility promise. A file written by a
    /// build that had more settings, or fewer, still loads — and what survives
    /// is exactly what this build can draw.
    #[test]
    fn hydrating_keeps_only_what_this_build_declares_and_accepts() {
        let registry = registry();
        registry.hydrate(BTreeMap::from([
            ("demo.size".to_string(), json!(20)),
            ("demo.mode".to_string(), json!("sideways")),
            ("demo.removed-in-this-build".to_string(), json!(true)),
        ]));

        assert_eq!(registry.get("demo.size"), Some(json!(20)), "kept");
        assert_eq!(
            registry.get("demo.mode"),
            Some(json!("on")),
            "a value the control refuses falls back to the default"
        );
        assert_eq!(registry.changed().len(), 1, "and nothing else survived");
    }

    #[test]
    fn resetting_a_group_clears_only_that_group() {
        let registry = registry();
        registry.set("demo.size", json!(20)).expect("in range");
        registry.set("demo.flag", json!(false)).expect("a bool");

        assert_eq!(registry.reset_group("demo"), 2);
        assert!(registry.changed().is_empty());
        assert_eq!(registry.reset_group("nothing-registered"), 0);
    }

    #[test]
    fn registering_the_same_group_twice_is_a_no_op() {
        let registry = registry();
        registry.register(&GROUP);
        assert_eq!(registry.snapshot().groups.len(), 1);
    }

    /// Groups sort by `order` and not by registration, which is what lets an
    /// app register late and still land where its author put it.
    #[test]
    fn groups_are_ordered_by_their_declared_order() {
        static LATER: Group = Group {
            id: "zzz",
            title: "Registered second, drawn first",
            description: "",
            order: -1,
            settings: &[],
        };

        let registry = registry();
        registry.register(&LATER);

        let ids: Vec<&str> = registry
            .snapshot()
            .groups
            .iter()
            .map(|g| g.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["zzz", "demo"]);
    }

    #[test]
    fn an_app_may_write_only_its_own_listed_settings() {
        use serde_json::json;
        let ok = parse_app_set(Some(&json!({ "key": "markup.autoSend", "value": true })));
        assert_eq!(ok.unwrap(), ("markup.autoSend".to_string(), json!(true)));
        for key in [
            "developer.mode",
            "mcp.writeProjectConfig",
            "godot.executablePath",
            // The keys the Markup section replaced are no longer settings.
            "godot.markupAutoSend",
            "godot.markupTip",
        ] {
            let refused = parse_app_set(Some(&json!({ "key": key, "value": true })));
            assert!(refused.is_err(), "{key} must not be app-writable");
        }
        assert!(parse_app_set(Some(&json!({ "key": "markup.tip" }))).is_err());
        assert!(parse_app_set(None).is_err());
    }

    #[test]
    fn every_app_writable_key_is_declared_by_a_group() {
        let registry = Registry::default();
        for group in schema::groups() {
            registry.register(group);
        }
        for group in crate::apps::settings_groups() {
            registry.register(group);
        }
        for key in APP_WRITABLE {
            assert!(registry.get(key).is_some(), "{key} is not declared");
        }
    }
}
