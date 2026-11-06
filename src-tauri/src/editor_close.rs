//! Closing a cluster that has Blender or the Godot editor in it.
//!
//! An editor used to be handed back as a window of its own when its cluster
//! closed, the same as when its pane closes, and was left floating over
//! Veistra with nothing that said where it came from. Now the shell asks
//! first (`CloseEditorsDialog`), and the answer comes here:
//!
//! - **Save & close** saves each editor's work, then asks it to quit the way
//!   its own close button does. With everything saved that quits at once;
//!   anything the save did not cover (an edited script, a changed image) is
//!   asked about rather than lost.
//! - **Close** quits each one without its prompt: Veistra already asked.
//!
//! The editors are taken out of the embed registry before the cluster closes
//! ([`Hosts::take`]), hidden, and ended on threads of their own. When an editor
//! cannot be saved, will not quit, or is still open after [`WAIT`] (asking
//! something, in a window nobody can see), it is handed back as a normal
//! window, as before, so nothing is ever lost to a close that went wrong.

use crate::embed::host::{Hosts, Taken};
use crate::embed::Kind;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How long a quitting editor has before it is handed back instead.
const WAIT: Duration = Duration::from_secs(10);
/// How long a save may take: a large `.blend` or many scenes.
const SAVE_WAIT: Duration = Duration::from_secs(60);
/// How long a quit command may take to be answered.
const QUIT_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(200);

/// What the person chose for the editors of a cluster they are closing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnClose {
    Save,
    Discard,
}

/// An editor in a cluster, as the close dialog lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEditor {
    pub instance: String,
    /// `"blender"` or `"godot"`.
    pub kind: &'static str,
    /// The file Blender has open, or the Godot project's folder; `None` for
    /// an untitled Blender scene.
    pub name: Option<String>,
    /// Whether it has unsaved changes, when the editor says.
    pub dirty: Option<bool>,
}

/// One editor being closed with its cluster. Implemented for Blender and the
/// Godot editor below, and by a fake in the tests.
pub trait Closing: Send {
    fn save(&self) -> Result<(), String>;
    /// `discard`: quit without the editor's own prompt.
    fn quit(&self, discard: bool) -> Result<(), String>;
    fn ended(&self) -> bool;
    /// Back to a normal window, as a pane closing does.
    fn hand_back(&self);
    /// The editor's own close, which asks about anything unsaved.
    fn ask_to_close(&self);
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Closed,
    HandedBack(String),
}

/// Save if asked, quit, and wait for it to end; hand it back on any failure.
pub fn finish(editor: &dyn Closing, on: OnClose, wait: Duration, poll: Duration) -> Outcome {
    let back = |why: String, ask: bool| {
        editor.hand_back();
        if ask {
            editor.ask_to_close();
        }
        Outcome::HandedBack(why)
    };
    if on == OnClose::Save {
        if let Err(e) = editor.save() {
            return back(format!("could not save: {e}"), true);
        }
    }
    if let Err(e) = editor.quit(on == OnClose::Discard) {
        return back(format!("could not quit: {e}"), true);
    }
    let until = Instant::now() + wait;
    while !editor.ended() {
        if Instant::now() >= until {
            // Its own prompt may be up: showing the window is enough.
            return back("still open after asking it to quit".to_string(), false);
        }
        std::thread::sleep(poll);
    }
    Outcome::Closed
}

/// The cluster's tab ids, which the editors' panes are among.
fn tabs_of(app: &AppHandle, cluster_id: &str) -> Vec<String> {
    let shell = app.state::<crate::shell_state::ShellState>();
    let snapshot = shell.snapshot();
    snapshot
        .windows
        .iter()
        .flat_map(|w| w.clusters.iter())
        .find(|c| c.id == cluster_id)
        .map(|c| c.tree.tabs().iter().map(|t| t.to_string()).collect())
        .unwrap_or_default()
}

enum Found {
    Blender(Arc<crate::blender::editor::Editor>),
    Godot(Arc<crate::godot::editor::Editor>),
}

/// The editor behind a hosted window, by the embed they share.
fn editor_for(app: &AppHandle, kind: Kind, embed: &Arc<crate::embed::Embed>) -> Option<Found> {
    match kind {
        Kind::Blender => app
            .state::<crate::blender::editor::Editors>()
            .all()
            .into_iter()
            .find(|e| Arc::ptr_eq(&e.embed, embed) && e.is_running())
            .map(Found::Blender),
        Kind::GodotEditor => app
            .state::<crate::godot::Godot>()
            .editors
            .all()
            .into_iter()
            .find(|e| Arc::ptr_eq(&e.embed, embed) && e.is_running())
            .map(Found::Godot),
        Kind::Game => None,
    }
}

/// The editors open in `cluster_id`'s panes, for the shell to ask about.
pub fn open_in(app: &AppHandle, cluster_id: &str) -> Vec<OpenEditor> {
    let tabs = tabs_of(app, cluster_id);
    let hosts = app.state::<Hosts>();
    hosts
        .editors_in(&tabs)
        .into_iter()
        .filter_map(|h| {
            let instance = h.instance()?;
            Some(match editor_for(app, h.kind, &h.embed)? {
                Found::Blender(e) => OpenEditor {
                    instance,
                    kind: "blender",
                    name: e.file(),
                    dirty: e.view()["dirty"].as_bool(),
                },
                Found::Godot(e) => OpenEditor {
                    instance,
                    kind: "godot",
                    name: e
                        .project
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned()),
                    dirty: None,
                },
            })
        })
        .collect()
}

struct BlenderClose {
    app: AppHandle,
    editor: Arc<crate::blender::editor::Editor>,
    taken: Taken,
}

impl BlenderClose {
    fn send(&self, action: &str, extra: serde_json::Value, wait: Duration) -> Result<(), String> {
        let editors = self.app.state::<crate::blender::editor::Editors>();
        crate::blender::editor::send(&editors, &self.editor, action, extra, wait).map(|_| ())
    }
}

impl Closing for BlenderClose {
    fn save(&self) -> Result<(), String> {
        self.send("save", json!({}), SAVE_WAIT)
    }
    fn quit(&self, discard: bool) -> Result<(), String> {
        self.send("quit", json!({ "discard": discard }), QUIT_WAIT)
    }
    fn ended(&self) -> bool {
        self.editor.ended().is_some()
    }
    fn hand_back(&self) {
        self.taken.hand_back();
    }
    fn ask_to_close(&self) {
        if self.taken.embed().request_close() != Ok(true) {
            let _ = self.quit(false);
        }
    }
}

struct GodotClose {
    app: AppHandle,
    editor: Arc<crate::godot::editor::Editor>,
    taken: Taken,
}

impl GodotClose {
    fn send(&self, action: &str, wait: Duration) -> Result<(), String> {
        let godot = self.app.state::<crate::godot::Godot>();
        crate::godot::editor::send(&godot, &self.editor, action, wait)
    }
}

impl Closing for GodotClose {
    fn save(&self) -> Result<(), String> {
        self.send("save", SAVE_WAIT)
    }
    fn quit(&self, discard: bool) -> Result<(), String> {
        // `close` is what the window's close button does; `quit` skips the prompt.
        self.send(if discard { "quit" } else { "close" }, QUIT_WAIT)
    }
    fn ended(&self) -> bool {
        self.editor.ended().is_some()
    }
    fn hand_back(&self) {
        self.taken.hand_back();
    }
    fn ask_to_close(&self) {
        if self.taken.embed().request_close() != Ok(true) {
            let _ = self.send("close", QUIT_WAIT);
        }
    }
}

/// Take `cluster_id`'s editors out of the registry, before the cluster
/// closes, and end each on a thread of its own as `on` says.
pub fn close_with(app: &AppHandle, cluster_id: &str, on: OnClose) {
    let tabs = tabs_of(app, cluster_id);
    let hosts = app.state::<Hosts>();
    let owner_of = crate::embed::host::owner_fn(app);
    for hosted in hosts.editors_in(&tabs) {
        let Some(found) = editor_for(app, hosted.kind, &hosted.embed) else {
            continue;
        };
        let Some(taken) = hosts.take(&hosted, &owner_of) else {
            continue;
        };
        let closing: Box<dyn Closing> = match found {
            Found::Blender(editor) => Box::new(BlenderClose {
                app: app.clone(),
                editor,
                taken,
            }),
            Found::Godot(editor) => Box::new(GodotClose {
                app: app.clone(),
                editor,
                taken,
            }),
        };
        let what = hosted.kind.what();
        std::thread::spawn(move || {
            if let Outcome::HandedBack(why) = finish(closing.as_ref(), on, WAIT, POLL) {
                crate::veistra_log!("closing a cluster: {what} {why}; handed it back");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// An editor that records what it was asked, and answers as told.
    #[derive(Default)]
    struct Fake {
        save_fails: bool,
        quit_fails: bool,
        /// Whether a quit with this `discard` ends it.
        quits: Option<fn(bool) -> bool>,
        log: Mutex<Vec<String>>,
        ended: Mutex<bool>,
    }

    impl Fake {
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
        fn note(&self, what: impl Into<String>) {
            self.log.lock().unwrap().push(what.into());
        }
    }

    impl Closing for Fake {
        fn save(&self) -> Result<(), String> {
            self.note("save");
            if self.save_fails {
                Err("no file".into())
            } else {
                Ok(())
            }
        }
        fn quit(&self, discard: bool) -> Result<(), String> {
            self.note(format!("quit discard={discard}"));
            if self.quit_fails {
                return Err("no plugin".into());
            }
            *self.ended.lock().unwrap() = self.quits.is_none_or(|q| q(discard));
            Ok(())
        }
        fn ended(&self) -> bool {
            *self.ended.lock().unwrap()
        }
        fn hand_back(&self) {
            self.note("hand back");
        }
        fn ask_to_close(&self) {
            self.note("ask");
        }
    }

    const QUICK: Duration = Duration::from_millis(30);
    const TICK: Duration = Duration::from_millis(5);

    #[test]
    fn save_and_close_saves_then_quits_with_the_editors_own_prompt() {
        let fake = Fake::default();
        assert_eq!(finish(&fake, OnClose::Save, QUICK, TICK), Outcome::Closed);
        assert_eq!(fake.log(), ["save", "quit discard=false"]);
    }

    #[test]
    fn close_quits_without_saving_or_asking() {
        let fake = Fake::default();
        assert_eq!(
            finish(&fake, OnClose::Discard, QUICK, TICK),
            Outcome::Closed
        );
        assert_eq!(fake.log(), ["quit discard=true"]);
    }

    // An untitled Blender scene, say: nothing is lost, the person gets the
    // window back with the editor's own "save changes?" in front of them.
    #[test]
    fn a_save_that_fails_hands_the_editor_back_asking_and_never_quits_it() {
        let fake = Fake {
            save_fails: true,
            ..Fake::default()
        };
        let out = finish(&fake, OnClose::Save, QUICK, TICK);
        assert!(matches!(out, Outcome::HandedBack(ref why) if why.contains("no file")));
        assert_eq!(fake.log(), ["save", "hand back", "ask"]);
    }

    // A Godot editor without the Veistra plugin cannot be told to quit.
    #[test]
    fn a_quit_that_cannot_be_sent_hands_the_editor_back_asking() {
        let fake = Fake {
            quit_fails: true,
            ..Fake::default()
        };
        assert!(matches!(
            finish(&fake, OnClose::Discard, QUICK, TICK),
            Outcome::HandedBack(_)
        ));
        assert_eq!(fake.log(), ["quit discard=true", "hand back", "ask"]);
    }

    // Its own prompt is up in a hidden window (an unsaved script the save
    // did not cover): the window comes back, and is not asked a second time.
    #[test]
    fn an_editor_still_open_after_the_wait_is_handed_back_without_asking_again() {
        let fake = Fake {
            quits: Some(|_| false),
            ..Fake::default()
        };
        assert!(matches!(
            finish(&fake, OnClose::Save, QUICK, TICK),
            Outcome::HandedBack(_)
        ));
        assert_eq!(fake.log(), ["save", "quit discard=false", "hand back"]);
    }

    #[test]
    fn the_choice_reads_as_the_shell_sends_it() {
        let save: OnClose = serde_json::from_str("\"save\"").unwrap();
        let discard: OnClose = serde_json::from_str("\"discard\"").unwrap();
        assert_eq!((save, discard), (OnClose::Save, OnClose::Discard));
    }
}
