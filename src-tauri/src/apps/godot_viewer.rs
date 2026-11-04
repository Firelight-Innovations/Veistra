//! The Godot app's Rust half, for both of its modes (DECISIONS X3).
//!
//! **Editor** is the Godot editor, launched `--editor --single-window` and
//! placed over the pane ([`crate::godot::editor`], #316), or the scene view
//! where `godot/status`'s `editor` ([`crate::editor_surface`]) says it cannot
//! open (main, a cloud session, no Godot): a headless run's dumped tree and
//! one rendered frame, cached under `.veistra/` with their age. **Play** runs
//! the project with its window placed in the pane, streams its log, records
//! takes and captures frames (`docs/design-notes/godot-play.md`).
//!
//! The work lives in [`crate::godot`]; this module only routes
//! `godot-viewer/*`, `play/*` and `godot/*` there, and hands comments anchored
//! to a node, or to a scene, a time and a screenshot
//! (`docs/VEISTRA-UX-REWORK.md` §3.4), to [`crate::comments`], shared with
//! every other viewer.
//!
//! The app id stays `godot-viewer`, and `play` is a second registry row that
//! opens this frontend in Play mode with this same dispatch, so a saved layout
//! or an agent's `veistra/open` naming either id lands on one app.

use crate::apps::CallContext;
use serde_json::Value;
use tauri::AppHandle;
use veistra_rpc::{RpcError, METHOD_NOT_FOUND};

pub fn call(
    app: &AppHandle,
    context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    call_for(app, context, None, method, params)
}

/// [`call`] from a pane instance: the game's box and window are the pane's
/// (`crate::embed::host`), so `play/embed-rect` needs to know which.
pub fn call_for(
    app: &AppHandle,
    context: &CallContext,
    instance: Option<&str>,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    if let Some(result) = crate::comments::call(context, method, params.as_ref()) {
        return result;
    }
    crate::godot::rpc::with_live_for(app, context, instance, |ctx| {
        crate::godot::rpc::godot(ctx, method, params.as_ref())
    })
    .unwrap_or_else(|| {
        Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn context(root: &std::path::Path) -> CallContext {
        CallContext {
            cluster_id: Some("c1".to_string()),
            project: Some(root.to_path_buf()),
        }
    }

    /// Comments need no `AppHandle`, so they are testable here; the Godot
    /// methods are tested in `godot::rpc` against a fake executable.
    #[test]
    fn comment_methods_are_answered_by_the_shared_comments_store() {
        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "node", "path": "Player/Flashlight" },
            "body": "brighten this",
        });
        let created = crate::comments::call(&context(env.path()), "comments/create", Some(&params))
            .expect("handled")
            .expect("create");
        assert_eq!(created["anchor"]["kind"], "node");

        let listed = crate::comments::call(&context(env.path()), "comments/list", None)
            .expect("handled")
            .expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }

    /// Play mode's comments are anchored to a scene and a time, and land in the
    /// same store as Editor mode's node comments.
    #[test]
    fn a_scene_comment_from_play_mode_shares_the_store() {
        let env = TempDir::new().expect("tempdir");
        let params = json!({
            "anchor": { "kind": "scene", "scene": "hospital_wing", "time": 42.8 },
            "body": "why is the light flickering here?",
        });
        let created = crate::comments::call(&context(env.path()), "comments/create", Some(&params))
            .expect("handled")
            .expect("create");
        assert_eq!(created["anchor"]["kind"], "scene");
        assert_eq!(created["anchor"]["screenshot"], false);

        let listed = crate::comments::call(&context(env.path()), "comments/list", None)
            .expect("handled")
            .expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
    }
}
