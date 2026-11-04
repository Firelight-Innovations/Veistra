//! Play's Rust half: run the environment's Godot project as a child process,
//! stream its log, pause, restart and stop it, and capture a frame.
//!
//! `docs/VEISTRA-UX-REWORK.md` §9.2 is resolved as a native run - see
//! `docs/design-notes/godot-play.md` for why - and the work lives in
//! [`crate::godot`]. This module only routes: `play/*` and `godot/*` go there,
//! and comments anchored to a scene, a time and a screenshot
//! (`docs/VEISTRA-UX-REWORK.md` §3.4) go through [`crate::comments`], shared with
//! every other viewer.

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
        crate::godot::rpc::play(ctx, method, params.as_ref())
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
