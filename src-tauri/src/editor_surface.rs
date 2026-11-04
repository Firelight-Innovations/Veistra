//! Where a Godot or Blender editor shows for a cluster (spec §11.4, DECISIONS
//! X4): placed in the pane, in its own window beside Veistra, or not at all,
//! in which case the pane shows the read-only viewer and says why.
//!
//! One answer, computed here and sent with `godot/status` and
//! `blender-viewer/state` as `editor`, so the apps never work it out from
//! `readOnly` and `found` themselves and every surface words a case the same
//! way. The frontend half is `apps/shared/editorSurface.ts`.
//!
//! The order is the order of what can be fixed least from inside the pane: a
//! cloud session has no local files at all, the main checkout has files that
//! may not be written, and a missing editor is a setting away. Only when all
//! three pass does the platform matter: with an embedder (Windows today) the
//! editor goes in the pane, and anywhere else in its own window. The rule is
//! "no embedder here", not a list of systems, so Linux X11 pops out as well as
//! Wayland and macOS; the platform only changes the sentence.

use crate::environments::Environment;
use serde::Serialize;

/// Which editor the answer is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Godot,
    Blender,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Tool::Godot => "Godot",
            Tool::Blender => "Blender",
        }
    }

    /// The editor as the not-found sentence names it: Veistra drives Godot 4.
    fn wanted(self) -> &'static str {
        match self {
            Tool::Godot => "Godot 4",
            Tool::Blender => "Blender",
        }
    }
}

/// What the machine is, for the Pop out sentence only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    LinuxWayland,
    LinuxX11,
    Other,
}

impl Platform {
    fn name(self) -> &'static str {
        match self {
            Platform::Windows => "Windows",
            Platform::MacOs => "macOS",
            Platform::LinuxWayland => "Linux with Wayland",
            Platform::LinuxX11 => "Linux with X11",
            Platform::Other => "this system",
        }
    }
}

/// The platform from `std::env::consts::OS` and the two variables a Linux
/// desktop session sets. `WAYLAND_DISPLAY` is the surer sign; a session that
/// sets neither is taken for X11, the older default.
pub fn platform_from(
    os: &str,
    wayland_display: Option<&str>,
    session_type: Option<&str>,
) -> Platform {
    match os {
        "windows" => Platform::Windows,
        "macos" => Platform::MacOs,
        "linux" => {
            let wayland = wayland_display.is_some_and(|d| !d.is_empty())
                || session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland"));
            if wayland {
                Platform::LinuxWayland
            } else {
                Platform::LinuxX11
            }
        }
        _ => Platform::Other,
    }
}

/// This machine's platform.
pub fn current() -> Platform {
    let var = |name: &str| std::env::var(name).ok();
    platform_from(
        std::env::consts::OS,
        var("WAYLAND_DISPLAY").as_deref(),
        var("XDG_SESSION_TYPE").as_deref(),
    )
}

/// The three surfaces, as the wire spells them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Embedded,
    PopOut,
    Viewer,
}

/// Why the editor is not in the pane, as a short code the page and telemetry
/// can switch on; the sentence beside it is what the pane shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    Cloud,
    Main,
    NoEditor,
    NoEmbedder,
}

/// `{ surface, reason, code }`: `reason` and `code` are `null` when embedded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surface {
    pub surface: Kind,
    pub reason: Option<String>,
    pub code: Option<Code>,
}

impl Surface {
    fn not_here(surface: Kind, code: Code, reason: String) -> Self {
        Self {
            surface,
            reason: Some(reason),
            code: Some(code),
        }
    }
}

/// What the cluster and the machine say, gathered by the caller.
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    /// The cluster's write environment; `None` for a plain folder, which is writable.
    pub environment: Option<&'a Environment>,
    pub editor_found: bool,
    /// The first reason the search gave, when the editor was not found.
    pub editor_problem: Option<&'a str>,
    pub platform: Platform,
    /// Whether this build can place a window in a pane (`embed::SUPPORTED`).
    pub embedder: bool,
}

/// The one answer. See the module doc for the order.
pub fn decide(tool: Tool, facts: Facts) -> Surface {
    let name = tool.name();
    match facts.environment {
        Some(Environment::Cloud { .. }) => {
            return Surface::not_here(
                Kind::Viewer,
                Code::Cloud,
                format!(
                    "This is a cloud session: its files are on the VM, not on this computer, so \
                     {name} cannot open them here. Open a local worktree to edit."
                ),
            )
        }
        Some(Environment::Main) => {
            return Surface::not_here(
                Kind::Viewer,
                Code::Main,
                format!(
                    "This is the main checkout, which is read-only here, so {name} does not open \
                     on it. Open a worktree to edit."
                ),
            )
        }
        _ => {}
    }
    if !facts.editor_found {
        let why = facts
            .editor_problem
            .map(|p| format!(" {}.", p.trim_end_matches('.')))
            .unwrap_or_default();
        return Surface::not_here(
            Kind::Viewer,
            Code::NoEditor,
            format!(
                "{} was not found on this computer.{why} Set its path under Settings, {name}.",
                tool.wanted()
            ),
        );
    }
    if !facts.embedder {
        return Surface::not_here(
            Kind::PopOut,
            Code::NoEmbedder,
            format!(
                "{name} opens in its own window: Veistra cannot place it in the pane on {} yet.",
                facts.platform.name()
            ),
        );
    }
    Surface {
        surface: Kind::Embedded,
        reason: None,
        code: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn worktree() -> Environment {
        Environment::LocalWorktree {
            name: "feat".into(),
            path: "/repo/.veistra/worktrees/feat".into(),
            branch: "wt/feat".into(),
            base: "main".into(),
        }
    }

    fn cloud() -> Environment {
        Environment::Cloud {
            session_id: "s1".into(),
            vm: "vm-1".into(),
            branch: None,
        }
    }

    fn facts(environment: Option<&Environment>) -> Facts<'_> {
        Facts {
            environment,
            editor_found: true,
            editor_problem: None,
            platform: Platform::Windows,
            embedder: true,
        }
    }

    fn code(tool: Tool, f: Facts) -> (Kind, Option<Code>) {
        let s = decide(tool, f);
        (s.surface, s.code)
    }

    #[test]
    fn a_worktree_with_the_editor_and_an_embedder_is_embedded() {
        let env = worktree();
        let s = decide(Tool::Godot, facts(Some(&env)));
        assert_eq!(s.surface, Kind::Embedded);
        assert_eq!((s.reason, s.code), (None, None));
        // A plain folder (no environment recorded) is writable, so the same.
        assert_eq!(decide(Tool::Blender, facts(None)).surface, Kind::Embedded);
    }

    #[test]
    fn cloud_wins_over_main_and_a_missing_editor() {
        let env = cloud();
        let f = Facts {
            editor_found: false,
            embedder: false,
            ..facts(Some(&env))
        };
        assert_eq!(code(Tool::Godot, f), (Kind::Viewer, Some(Code::Cloud)));
        let s = decide(Tool::Blender, f);
        assert!(s.reason.unwrap().contains("cloud session"));
    }

    #[test]
    fn main_wins_over_a_missing_editor_and_names_the_tool() {
        let f = Facts {
            editor_found: false,
            ..facts(Some(&Environment::Main))
        };
        let s = decide(Tool::Blender, f);
        assert_eq!((s.surface, s.code), (Kind::Viewer, Some(Code::Main)));
        let reason = s.reason.unwrap();
        assert!(reason.starts_with("This is the main checkout"), "{reason}");
        assert!(reason.contains("Blender"), "{reason}");
    }

    #[test]
    fn a_missing_editor_is_the_viewer_with_the_search_reason_and_the_setting() {
        let env = worktree();
        let f = Facts {
            editor_found: false,
            editor_problem: Some("/opt/godot does not exist"),
            ..facts(Some(&env))
        };
        let s = decide(Tool::Godot, f);
        assert_eq!((s.surface, s.code), (Kind::Viewer, Some(Code::NoEditor)));
        assert_eq!(
            s.reason.as_deref(),
            Some(
                "Godot 4 was not found on this computer. /opt/godot does not exist. Set its path \
                 under Settings, Godot."
            )
        );
        let bare = decide(
            Tool::Blender,
            Facts {
                editor_found: false,
                ..facts(None)
            },
        );
        assert_eq!(
            bare.reason.as_deref(),
            Some("Blender was not found on this computer. Set its path under Settings, Blender.")
        );
    }

    #[test]
    fn no_embedder_pops_out_on_every_platform_and_only_the_wording_changes() {
        for (platform, words) in [
            (Platform::MacOs, "macOS"),
            (Platform::LinuxWayland, "Linux with Wayland"),
            (Platform::LinuxX11, "Linux with X11"),
            (Platform::Other, "this system"),
        ] {
            let f = Facts {
                platform,
                embedder: false,
                ..facts(None)
            };
            let s = decide(Tool::Godot, f);
            assert_eq!(
                (s.surface, s.code),
                (Kind::PopOut, Some(Code::NoEmbedder)),
                "{platform:?}"
            );
            let reason = s.reason.unwrap();
            assert!(reason.starts_with("Godot opens in its own window"));
            assert!(reason.contains(words), "{reason}");
        }
    }

    #[test]
    fn the_platform_is_read_from_the_os_and_the_session() {
        assert_eq!(platform_from("windows", None, None), Platform::Windows);
        assert_eq!(platform_from("macos", None, None), Platform::MacOs);
        assert_eq!(
            platform_from("linux", Some("wayland-0"), None),
            Platform::LinuxWayland
        );
        assert_eq!(
            platform_from("linux", None, Some("Wayland")),
            Platform::LinuxWayland
        );
        assert_eq!(
            platform_from("linux", Some(""), Some("x11")),
            Platform::LinuxX11
        );
        assert_eq!(platform_from("linux", None, None), Platform::LinuxX11);
        assert_eq!(platform_from("freebsd", None, None), Platform::Other);
    }

    #[test]
    fn the_wire_shape_is_surface_reason_code() {
        let main = decide(Tool::Godot, facts(Some(&Environment::Main)));
        let v = serde_json::to_value(&main).unwrap();
        assert_eq!(v["surface"], "viewer");
        assert_eq!(v["code"], "main");
        assert!(v["reason"].is_string());
        let embedded = serde_json::to_value(decide(Tool::Godot, facts(None))).unwrap();
        assert_eq!(
            embedded,
            json!({ "surface": "embedded", "reason": null, "code": null })
        );
        let pop = Facts {
            embedder: false,
            ..facts(None)
        };
        let v = serde_json::to_value(decide(Tool::Blender, pop)).unwrap();
        assert_eq!(
            (v["surface"].clone(), v["code"].clone()),
            (json!("popOut"), json!("noEmbedder"))
        );
    }
}
