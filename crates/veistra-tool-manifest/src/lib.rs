//! Loading and validating `veistra-tool.toml`, the per-tool run manifest.
//!
//! See `docs/tool-protocol.md` section 1 for the spec this implements. The
//! short version: every tool checkout carries one of these files, and it says
//! how to run the tool — its id, its frontend bundle, its core binary, and the
//! surfaces it can put on screen. Unknown keys are a hard error rather than a
//! warning, because a typo'd key that's silently ignored is a bug that only
//! shows up at runtime, and three of the fields (`dist`, `bin`, a surface's
//! `path`) are load-bearing for path safety: a tool is third-party code, and
//! nothing here should let its manifest point outside its own checkout.
//!
//! A package used to be exactly one surface, and the file said so — `[frontend]`
//! and `[core]` were both required and there was one of each. It carries several
//! now, because a repository worth installing is usually several related views
//! over one domain rather than a single window. See [`ToolManifest`] for the
//! shape that came out of that and what each combination means.

// Published contract — see the note in crates/veistra-rpc/src/lib.rs.
#![warn(missing_docs)]
#![warn(unreachable_pub)]

use semver::Version;
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

/// A parsed and validated `veistra-tool.toml`.
///
/// One file describes a **package**: an identity, at most one core process, and
/// zero or more **surfaces** — the things a person can put in a pane. The two
/// counts are independent, and every combination is a real tool.
///
/// | Surfaces | Core | What it is |
/// |---|---|---|
/// | one | yes | the ordinary tool; `examples/echo-tool` |
/// | many | yes | several views over one domain, one process behind them |
/// | none | yes | a backend with no UI — a package that only registers MCP tools |
/// | some | no | a frontend needing nothing from Rust of its own |
///
/// The bottom two rows are why `frontend` and `core` are `Option`. Requiring
/// both, as this file did when a package could only ever be one surface, would
/// make the no-UI case express itself with a `dist` pointing at a directory
/// nobody serves — a lie in the manifest written to satisfy a parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolManifest {
    /// Who the tool is. The only section with a second source of truth: the
    /// `[[tool]]` entry in `veistra.toml` has to agree with it.
    pub tool: ToolSection,
    /// Where the tool window points its iframes, for every surface at once.
    /// `None` when the package ships no UI.
    pub frontend: Option<FrontendSection>,
    /// How to start the tool's core process. `None` when the package is
    /// frontend-only.
    pub core: Option<CoreSection>,
    /// What the package can put on screen, in declaration order — which is the
    /// order the switcher offers them in, so it is the author's to choose.
    ///
    /// Empty only when there is no `[frontend]` either: a manifest with a
    /// frontend and no `[[surface]]` blocks gets one synthesised, so the
    /// single-surface tool this format started as needs no new keys. See
    /// [`DEFAULT_SURFACE_ID`].
    pub surfaces: Vec<Surface>,
}

/// `[tool]` — required. Identity, independent of how the tool runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSection {
    /// Must match `^[a-z][a-z0-9-]*$`, and must equal both the `[[tool]]` id
    /// in `veistra.toml` and the id the core returns from `veistra/hello` — the
    /// host rejects the tool if the three disagree.
    pub id: String,
    /// Semver; anything else fails the parse. Nothing compares it against the
    /// version `veistra.toml` pins. The pin decides what gets checked out, this
    /// is only what the checkout claims to be.
    pub version: Version,
    /// What to call the package where a person reads it.
    ///
    /// `Option` rather than defaulted to `id` at parse time, because the host
    /// has a use for the difference: an install list can say "this author named
    /// it" or fall back on its own terms.
    pub name: Option<String>,
    /// One line, shown beside the name. Empty rather than `Option` — there is
    /// no difference worth preserving between no description and an empty one.
    pub description: String,
}

/// `[frontend]` — optional. Both keys describe the same UI, one built and one
/// live; which is used depends on the build of the shell, not on the manifest.
///
/// **Package-level, not per-surface, and that is the load-bearing choice.** A
/// `dev-url` on every surface would mean a Vite server per surface — four of
/// them for a package with four views. One server with several HTML entry
/// points is what this repository's own `vite.config.ts` does for Home, Files,
/// Viewer and Docs, so a plugin repo is laid out the way the orchestrator
/// already is. Each surface picks its document out of the one bundle with
/// [`Surface::path`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendSection {
    /// Built bundle, relative to the checkout root.
    pub dist: PathBuf,
    /// The tool's own dev server, consulted only by a dev build of the shell.
    pub dev_url: Option<String>,
}

/// `[core]` — optional. The child process the shell speaks JSON-RPC to over
/// standard streams.
///
/// One process per **package**, shared by every surface in it — not one per
/// surface. The same reasoning that has File Explorer and File Viewer dispatch
/// into a single `files::call` in the orchestrator: the surfaces are views over
/// one domain, and a second process would be a second copy of that domain's
/// state with no way to keep the two honest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreSection {
    /// Relative to the checkout root. Never includes a platform extension —
    /// see `resolve_bin`.
    pub bin: PathBuf,
    /// Passed to the binary verbatim on spawn. Defaults to `["--veistra-rpc"]`
    /// when the key is absent, which is the flag the protocol expects; set it
    /// only if the binary enters RPC mode some other way.
    pub args: Vec<String>,
}

/// The surface id given to the one surface synthesised for a manifest that
/// declares a `[frontend]` and no `[[surface]]` blocks.
///
/// A fixed name rather than the package's own id, so a surface's address is
/// `<package>.<surface>` with no exceptions — `echo.main`, never a bare `echo`
/// for the one-surface case and a dotted pair for every other. An address
/// format with a special case is one every consumer has to remember, and these
/// strings are persisted in the shell's saved layout.
pub const DEFAULT_SURFACE_ID: &str = "main";

/// One `[[surface]]` — a thing the shell can put in a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Surface {
    /// Matches `^[a-z][a-z0-9-]*$`, and is unique within the package. The
    /// shell addresses this surface as `<package id>.<this id>`.
    pub id: String,
    /// What the switcher tab and the Apps menu row say. Falls back to the
    /// surface id when absent, for the same reason [`ToolSection::name`] does.
    pub name: Option<String>,
    /// One line under the name in the Apps menu.
    pub description: String,
    /// Where this surface's `index.html` sits inside the package's one bundle,
    /// relative to `frontend.dist` — and, in a dev build, appended to
    /// `frontend.dev-url` instead.
    ///
    /// `None` is the bundle root, which is what a single-surface package wants
    /// and what the synthesised default surface uses.
    pub path: Option<PathBuf>,
    /// Whether the surface is offered in the menus or only reachable when
    /// another frame asks for it.
    pub present: Presentation,
}

/// How a surface is offered — the `present` key.
///
/// Deliberately without a third variant for "has no frontend at all". A package
/// with no UI declares **no surfaces**, which is a different fact and is read by
/// different code: "there is nothing to show" and "there is something the menus
/// do not list" would, sharing one spelling, leave every consumer re-deriving
/// which of the two it was holding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Presentation {
    /// Listed in the Apps menu and the `+`; opens into a pane. The default.
    #[default]
    Pane,
    /// Covers its cluster and is absent from both menus, reachable only when
    /// something calls `veistra/open` for it. Home and Docs are the
    /// first-party precedent.
    Cover,
}

/// Why a `veistra-tool.toml` was rejected.
///
/// Every variant names the offending key and its value: the manifest is
/// written by a tool author who is not looking at this code, so the `Display`
/// text is meant to be surfaced as-is.
#[derive(Debug, Error)]
pub enum ManifestError {
    /// The file could not be read at all. A checkout with no manifest is not
    /// a tool, so this is an error rather than an empty default.
    #[error("could not read {path}: {source}")]
    Io {
        /// The full path tried, so the message names a file rather than a
        /// checkout whose layout the reader then has to guess.
        path: PathBuf,
        /// Separates "not cloned yet" from a permission or I/O failure the
        /// author has to go and fix.
        #[source]
        source: std::io::Error,
    },

    /// Malformed TOML, a missing required key, or an unknown one — the schema
    /// is `deny_unknown_fields`, so a typo'd key arrives here instead of being
    /// dropped.
    // Boxed because `toml::de::Error` carries a copy of the offending
    // document for its span-highlighting `Display` impl, which makes it much
    // larger than the other variants; boxing keeps `ManifestError` itself
    // cheap to move regardless of which variant it is.
    #[error("invalid veistra-tool.toml: {0}")]
    Toml(Box<toml::de::Error>),

    /// `tool.id` is not `^[a-z][a-z0-9-]*$`. Ids end up as directory names and
    /// URL authorities, so the shape is checked before anything consumes one.
    #[error("invalid tool id {id:?}: must match ^[a-z][a-z0-9-]*$")]
    InvalidId {
        /// The id exactly as written, so the author can see the character.
        id: String,
    },

    /// `tool.version` is not semver. Checked at load rather than at first use,
    /// while the file that has to change is still the obvious thing to blame.
    #[error("invalid version {version:?}: {source}")]
    InvalidVersion {
        /// The string as written; there is no parsed value to report.
        version: String,
        /// What `semver` objected to, which is more use than "not semver".
        #[source]
        source: semver::Error,
    },

    /// A path key is rooted. Joined onto the checkout root such a path would
    /// discard the root entirely, which is the escape this crate exists for.
    #[error("{field} must be a relative path, but {path:?} is rooted")]
    PathNotRelative {
        /// The dotted key: `frontend.dist` or `core.bin`. `&'static str`
        /// because the validator only ever names keys it knows at compile time.
        field: &'static str,
        /// The value as the manifest wrote it, not as resolved.
        path: String,
    },

    /// A path key contains a `..` component anywhere in it. Rejected outright
    /// rather than normalized: a path that tried to leave is not one to guess at.
    #[error("{field} escapes the checkout root via a '..' component: {path:?}")]
    PathEscapesRoot {
        /// The dotted key that held the escaping path.
        field: &'static str,
        /// The value as written, `..` included, so the escape is visible.
        path: String,
    },

    /// A path key resolves to the checkout root itself. Legal as a path, but a
    /// `dist` of `""` would serve the whole checkout, `.git` and sources included.
    #[error("{field} must name something inside the checkout, but {path:?} is the checkout root")]
    PathIsRoot {
        /// The dotted key that named nothing.
        field: &'static str,
        /// The value as written — in practice `""`, `"."` or `"./"`.
        path: String,
    },

    /// Two `[[surface]]` blocks share an `id`. The shell addresses a surface as
    /// `<package>.<surface>`, so a duplicate is two rows naming one thing.
    #[error("duplicate surface id {id:?}: each [[surface]] needs its own")]
    DuplicateSurfaceId {
        /// The id declared twice.
        id: String,
    },

    /// A `[[surface]]` without a `[frontend]` to resolve it against. A surface
    /// is a document in the package's bundle; declaring one while declaring no
    /// bundle names a file with nowhere to live.
    #[error("surface {id:?} needs a [frontend] section — there is no bundle to serve it from")]
    SurfaceWithoutFrontend {
        /// The first surface found without a bundle behind it.
        id: String,
    },

    /// `resolve_bin` on a package that declares no `[core]`. Not a malformed
    /// manifest — a question with no answer for this one.
    #[error("this package declares no [core]; there is no binary to resolve")]
    NoCore,

    /// Nothing exists at `core.bin`. Raised by `resolve_bin` against a real
    /// checkout, not by parsing; the usual cause is a tool that isn't built yet.
    #[error("core binary not found at {bin} or {bin_exe}")]
    BinNotFound {
        /// The absolute path from `core.bin`, tried first.
        bin: PathBuf,
        /// The same path with `.exe` appended, tried second. Both are named so
        /// the message doesn't look wrong on the platform that needs a suffix.
        bin_exe: PathBuf,
    },
}

impl ToolManifest {
    /// Read and validate the manifest at `<checkout_root>/veistra-tool.toml`.
    pub fn load(checkout_root: &Path) -> Result<Self, ManifestError> {
        let path = checkout_root.join("veistra-tool.toml");
        let raw = std::fs::read_to_string(&path).map_err(|source| ManifestError::Io {
            path: path.clone(),
            source,
        })?;
        Self::parse(&raw)
    }

    /// Parse and validate a manifest already in memory — the path taken by
    /// tests, and by any caller that already has the bytes (e.g. read as
    /// part of a bundle rather than off a standalone file).
    pub fn parse(source: &str) -> Result<Self, ManifestError> {
        let raw: RawManifest =
            toml::from_str(source).map_err(|err| ManifestError::Toml(Box::new(err)))?;

        validate_id(&raw.tool.id)?;
        let version =
            Version::parse(&raw.tool.version).map_err(|source| ManifestError::InvalidVersion {
                version: raw.tool.version.clone(),
                source,
            })?;

        let frontend = raw
            .frontend
            .map(|f| {
                Ok::<_, ManifestError>(FrontendSection {
                    dist: validate_relative_path("frontend.dist", &f.dist)?,
                    dev_url: f.dev_url,
                })
            })
            .transpose()?;

        let core = raw
            .core
            .map(|c| {
                Ok::<_, ManifestError>(CoreSection {
                    bin: validate_relative_path("core.bin", &c.bin)?,
                    args: c.args,
                })
            })
            .transpose()?;

        let surfaces = build_surfaces(raw.surfaces, frontend.is_some())?;

        Ok(ToolManifest {
            tool: ToolSection {
                id: raw.tool.id,
                version,
                name: raw.tool.name,
                description: raw.tool.description,
            },
            frontend,
            core,
            surfaces,
        })
    }

    /// The tool binary's absolute path inside a checkout, `.exe` resolved.
    ///
    /// Tries `bin` as written first, then `bin` with `.exe` appended. Both
    /// are tried on every platform, not just Windows: a cross-compiled
    /// artifact (building a Windows tool's binary on a Linux CI box, say) is
    /// a real case, and the cost of the extra check is one `exists()` call.
    ///
    /// [`ManifestError::NoCore`] when the package declares no `[core]` — the
    /// caller asked where a process is that the author said does not exist,
    /// and answering with "not found at ''" would blame the wrong thing.
    pub fn resolve_bin(&self, checkout_root: &Path) -> Result<PathBuf, ManifestError> {
        let core = self.core.as_ref().ok_or(ManifestError::NoCore)?;
        let bin = checkout_root.join(&core.bin);
        if bin.is_file() {
            return Ok(bin);
        }

        // `set_extension` would *replace* an existing extension rather than
        // append one (`foo.bin` -> `foo.exe`), which is wrong here — `bin` is
        // conventionally extensionless, but appending onto the raw
        // `OsString` is correct either way.
        let mut exe_name = bin.clone().into_os_string();
        exe_name.push(".exe");
        let bin_exe = PathBuf::from(exe_name);
        if bin_exe.is_file() {
            return Ok(bin_exe);
        }

        Err(ManifestError::BinNotFound { bin, bin_exe })
    }

    /// The built frontend's absolute path inside a checkout.
    ///
    /// `None` for a package with no `[frontend]`, which has no bundle to point
    /// at. Callers serving assets treat that as "nothing to serve" rather than
    /// falling back to the checkout root — serving the root is precisely what
    /// [`validate_relative_path`] exists to prevent.
    pub fn resolve_dist(&self, checkout_root: &Path) -> Option<PathBuf> {
        self.frontend.as_ref().map(|f| checkout_root.join(&f.dist))
    }

    /// The surface with this id, if the package declares one.
    pub fn surface(&self, id: &str) -> Option<&Surface> {
        self.surfaces.iter().find(|s| s.id == id)
    }
}

/// Turn the declared `[[surface]]` blocks into the resolved list, synthesising
/// the default one where a manifest declares a frontend and no surfaces.
///
/// The `has_frontend` flag is what decides between "synthesise one" and "leave
/// it empty": a package with neither surfaces nor a frontend is the backend-only
/// case and must not be given a surface pointing at a bundle it does not have.
fn build_surfaces(raw: Vec<RawSurface>, has_frontend: bool) -> Result<Vec<Surface>, ManifestError> {
    if raw.is_empty() {
        if !has_frontend {
            return Ok(Vec::new());
        }
        return Ok(vec![Surface {
            id: DEFAULT_SURFACE_ID.to_string(),
            name: None,
            description: String::new(),
            path: None,
            present: Presentation::Pane,
        }]);
    }

    let mut surfaces: Vec<Surface> = Vec::with_capacity(raw.len());
    for one in raw {
        validate_id(&one.id)?;

        // Checked here rather than left to the shell, because the shell's own
        // id space is `<package>.<surface>` — two surfaces sharing an id are
        // two rows that address the same thing, and whichever the lookup found
        // first would silently win. A duplicate is an authoring mistake with a
        // one-word fix, so it is worth failing the parse for.
        if surfaces.iter().any(|s| s.id == one.id) {
            return Err(ManifestError::DuplicateSurfaceId { id: one.id });
        }

        if !has_frontend {
            return Err(ManifestError::SurfaceWithoutFrontend { id: one.id });
        }

        let path = one
            .path
            .as_deref()
            .map(|p| validate_relative_path("surface.path", p))
            .transpose()?;

        surfaces.push(Surface {
            id: one.id,
            name: one.name,
            description: one.description,
            path,
            present: one.present,
        });
    }

    Ok(surfaces)
}

/// `id` matches `^[a-z][a-z0-9-]*$`. Hand-rolled rather than pulling in a
/// regex crate for one five-line check.
fn validate_id(id: &str) -> Result<(), ManifestError> {
    let mut chars = id.chars();
    let starts_ok = matches!(chars.next(), Some(c) if c.is_ascii_lowercase());
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');

    if starts_ok && rest_ok {
        Ok(())
    } else {
        Err(ManifestError::InvalidId { id: id.to_string() })
    }
}

/// Reject anything that could put a resolved path outside the checkout root:
/// an absolute path, or a path containing a `..` component anywhere in it.
///
/// This is a security boundary rather than a style rule — `veistra-tool.toml`
/// is authored by third-party tool code, and `dist`/`bin` end up joined onto
/// a trusted root and then read or executed.
fn validate_relative_path(field: &'static str, raw: &str) -> Result<PathBuf, ManifestError> {
    let path = Path::new(raw);

    // `Path::is_absolute` is platform-relative in a way that's a trap for a
    // security check: on Windows, `/etc/passwd` is `has_root() == true` but
    // `is_absolute() == false` (it's rooted but has no drive letter), so a
    // manifest built with forward slashes could sneak past an `is_absolute`
    // check on this platform. Looking at the first component directly treats
    // both a Unix-style root and a Windows drive prefix as rooted, regardless
    // of which platform we're running on.
    let is_rooted = matches!(
        path.components().next(),
        Some(Component::RootDir) | Some(Component::Prefix(_))
    );
    if is_rooted {
        return Err(ManifestError::PathNotRelative {
            field,
            path: raw.to_string(),
        });
    }

    if path.components().any(|c| c == Component::ParentDir) {
        return Err(ManifestError::PathEscapesRoot {
            field,
            path: raw.to_string(),
        });
    }

    // `""`, `"."` and `"./"` all stay inside the checkout, so the two checks
    // above pass them — but they resolve to the checkout root *itself*, which
    // is its own problem. A `dist` of `""` would point the scheme handler at
    // the whole checkout and serve `.git`, the tool's source, and anything
    // else sitting there. Requiring at least one real path segment closes
    // that without affecting any legitimate value.
    if !path.components().any(|c| matches!(c, Component::Normal(_))) {
        return Err(ManifestError::PathIsRoot {
            field,
            path: raw.to_string(),
        });
    }

    Ok(path.to_path_buf())
}

fn default_args() -> Vec<String> {
    vec!["--veistra-rpc".to_string()]
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct RawManifest {
    tool: RawTool,
    #[serde(default)]
    frontend: Option<RawFrontend>,
    #[serde(default)]
    core: Option<RawCore>,
    // TOML reads better singular in an array-of-tables, Rust reads better
    // plural — the same rename the stack manifest does for `[[tool]]`.
    #[serde(default, rename = "surface")]
    surfaces: Vec<RawSurface>,
    // `[permissions]` is reserved space: legal for the table to be present,
    // legal for it to hold anything, ignored either way. `toml::Value` (not
    // a `deny_unknown_fields` struct like its siblings) is what makes the
    // *contents* permissive while the section still has to parse as a table.
    #[serde(default)]
    #[allow(dead_code)] // kept only so an extra top-level key can't sneak in unnoticed
    permissions: Option<toml::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct RawTool {
    id: String,
    version: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct RawSurface {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    present: Presentation,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct RawFrontend {
    dist: String,
    #[serde(default)]
    dev_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct RawCore {
    bin: String,
    #[serde(default = "default_args")]
    args: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference tool's real manifest. Schema and example must not drift,
    /// so this is checked field by field rather than just "parses OK".
    const REFERENCE: &str = r#"
        [tool]
        id      = "echo"
        version = "0.1.0"

        [frontend]
        dist    = "ui/dist"
        dev-url = "http://localhost:5174"

        [core]
        bin  = "target/debug/veistra-echo-tool"
        args = ["--veistra-rpc"]
    "#;

    #[test]
    fn parses_reference_manifest() {
        let manifest = ToolManifest::parse(REFERENCE).expect("reference manifest should parse");

        assert_eq!(manifest.tool.id, "echo");
        assert_eq!(manifest.tool.version, Version::new(0, 1, 0));

        let frontend = manifest.frontend.as_ref().expect("declares a [frontend]");
        assert_eq!(frontend.dist, PathBuf::from("ui/dist"));
        assert_eq!(frontend.dev_url.as_deref(), Some("http://localhost:5174"));

        let core = manifest.core.as_ref().expect("declares a [core]");
        assert_eq!(core.bin, PathBuf::from("target/debug/veistra-echo-tool"));
        assert_eq!(core.args, vec!["--veistra-rpc".to_string()]);

        // The reference manifest declares no `[[surface]]`, and must keep
        // working untouched — the whole point of synthesising one. Anything
        // that made this file need a new key would have broken every tool
        // written against the format before surfaces existed.
        assert_eq!(manifest.surfaces.len(), 1);
        assert_eq!(manifest.surfaces[0].id, DEFAULT_SURFACE_ID);
        assert_eq!(manifest.surfaces[0].path, None);
        assert_eq!(manifest.surfaces[0].present, Presentation::Pane);
    }

    #[test]
    fn args_default_when_absent() {
        let toml = r#"
            [tool]
            id = "echo"
            version = "0.1.0"

            [frontend]
            dist = "ui/dist"

            [core]
            bin = "target/debug/veistra-echo-tool"
        "#;

        let manifest = ToolManifest::parse(toml).unwrap();
        assert_eq!(
            manifest.core.expect("declares a [core]").args,
            vec!["--veistra-rpc".to_string()]
        );
        assert_eq!(
            manifest.frontend.expect("declares a [frontend]").dev_url,
            None
        );
    }

    #[test]
    fn permissions_section_is_optional_and_permissive() {
        let absent = r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "target/debug/veistra-echo-tool"
        "#;
        assert!(ToolManifest::parse(absent).is_ok());

        let present = r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "target/debug/veistra-echo-tool"
            [permissions]
            some-future-key = true
            another = ["a", "b"]
        "#;
        assert!(ToolManifest::parse(present).is_ok());
    }

    #[test]
    fn rejects_unknown_top_level_key() {
        let toml = r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "target/debug/veistra-echo-tool"
            [nonsense]
            key = 1
        "#;

        assert!(matches!(
            ToolManifest::parse(toml),
            Err(ManifestError::Toml(_))
        ));
    }

    #[test]
    fn rejects_unknown_key_in_known_section() {
        let toml = r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            typo = "oops"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "target/debug/veistra-echo-tool"
        "#;

        assert!(matches!(
            ToolManifest::parse(toml),
            Err(ManifestError::Toml(_))
        ));
    }

    #[test]
    fn rejects_invalid_id() {
        for bad in ["Echo", "1echo", "ec ho", "ec_ho", ""] {
            let toml = format!(
                r#"
                [tool]
                id = "{bad}"
                version = "0.1.0"
                [frontend]
                dist = "ui/dist"
                [core]
                bin = "target/debug/veistra-echo-tool"
                "#
            );

            match ToolManifest::parse(&toml) {
                Err(ManifestError::InvalidId { id }) => assert_eq!(id, bad),
                other => panic!("expected InvalidId for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn rejects_invalid_version() {
        let toml = r#"
            [tool]
            id = "echo"
            version = "not-semver"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "target/debug/veistra-echo-tool"
        "#;

        match ToolManifest::parse(toml) {
            Err(ManifestError::InvalidVersion { version, .. }) => {
                assert_eq!(version, "not-semver")
            }
            other => panic!("expected InvalidVersion, got {other:?}"),
        }
    }

    #[test]
    fn rejects_absolute_dist_path() {
        for absolute in ["/etc/passwd", "C:\\Windows\\System32"] {
            let toml = format!(
                r#"
                [tool]
                id = "echo"
                version = "0.1.0"
                [frontend]
                dist = "{}"
                [core]
                bin = "target/debug/veistra-echo-tool"
                "#,
                absolute.replace('\\', "\\\\")
            );

            match ToolManifest::parse(&toml) {
                Err(ManifestError::PathNotRelative { field, .. }) => {
                    assert_eq!(field, "frontend.dist")
                }
                other => panic!("expected PathNotRelative for {absolute:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn rejects_dotdot_in_bin_path() {
        let toml = r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "../../etc/passwd"
        "#;

        match ToolManifest::parse(toml) {
            Err(ManifestError::PathEscapesRoot { field, .. }) => assert_eq!(field, "core.bin"),
            other => panic!("expected PathEscapesRoot, got {other:?}"),
        }
    }

    #[test]
    fn rejects_dotdot_buried_mid_path() {
        // A leading segment can look innocent while a later `..` still walks
        // back out of the checkout, so every component has to be checked —
        // not just whether the string starts with "..".
        let toml = r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            [frontend]
            dist = "ui/../../secrets"
            [core]
            bin = "target/debug/veistra-echo-tool"
        "#;

        assert!(matches!(
            ToolManifest::parse(toml),
            Err(ManifestError::PathEscapesRoot { .. })
        ));
    }

    #[test]
    fn rejects_paths_that_resolve_to_the_checkout_root() {
        // These don't escape the checkout, so the rooted and `..` checks let
        // them through — but they'd hand out the whole checkout, which is the
        // same class of mistake with a different shape.
        for empty in ["", ".", "./"] {
            let toml = format!(
                r#"
                [tool]
                id = "echo"
                version = "0.1.0"
                [frontend]
                dist = "{empty}"
                [core]
                bin = "target/debug/veistra-echo-tool"
                "#
            );

            match ToolManifest::parse(&toml) {
                Err(ManifestError::PathIsRoot { field, .. }) => {
                    assert_eq!(field, "frontend.dist")
                }
                other => panic!("expected PathIsRoot for {empty:?}, got {other:?}"),
            }
        }
    }

    /// A scratch directory under the OS temp dir, unique per test. `Drop`
    /// cleans it up so a failed assertion doesn't leak files across runs.
    struct TempCheckout(PathBuf);

    impl TempCheckout {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "veistra-tool-manifest-test-{}-{}-{name}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempCheckout(dir)
        }
    }

    impl Drop for TempCheckout {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn manifest_with_bin(bin: &str) -> ToolManifest {
        let toml = format!(
            r#"
            [tool]
            id = "echo"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [core]
            bin = "{bin}"
            "#
        );
        ToolManifest::parse(&toml).unwrap()
    }

    #[test]
    fn resolve_bin_finds_plain_binary() {
        let checkout = TempCheckout::new("plain");
        std::fs::write(checkout.0.join("tool-bin"), b"").unwrap();

        let manifest = manifest_with_bin("tool-bin");
        let resolved = manifest.resolve_bin(&checkout.0).unwrap();

        assert_eq!(resolved, checkout.0.join("tool-bin"));
    }

    #[test]
    fn resolve_bin_falls_back_to_exe_suffix() {
        let checkout = TempCheckout::new("exe-suffix");
        std::fs::write(checkout.0.join("tool-bin.exe"), b"").unwrap();

        let manifest = manifest_with_bin("tool-bin");
        let resolved = manifest.resolve_bin(&checkout.0).unwrap();

        assert_eq!(resolved, checkout.0.join("tool-bin.exe"));
    }

    #[test]
    fn resolve_bin_errors_naming_both_paths_tried() {
        let checkout = TempCheckout::new("missing");

        let manifest = manifest_with_bin("tool-bin");
        match manifest.resolve_bin(&checkout.0) {
            Err(ManifestError::BinNotFound { bin, bin_exe }) => {
                assert_eq!(bin, checkout.0.join("tool-bin"));
                assert_eq!(bin_exe, checkout.0.join("tool-bin.exe"));
            }
            other => panic!("expected BinNotFound, got {other:?}"),
        }
    }

    #[test]
    fn resolve_dist_joins_checkout_root() {
        let manifest = ToolManifest::parse(REFERENCE).unwrap();
        let resolved = manifest.resolve_dist(Path::new("/checkout"));
        assert_eq!(resolved, Some(PathBuf::from("/checkout/ui/dist")));
    }

    // --- surfaces -----------------------------------------------------------

    const MULTI: &str = r#"
        [tool]
        id      = "acme"
        version = "0.1.0"
        name    = "Acme"
        description = "Technical design software."

        [frontend]
        dist    = "ui/dist"
        dev-url = "http://localhost:5174"

        [[surface]]
        id          = "specs"
        name        = "Spec Editor"
        description = "Write and edit technical specs."
        path        = "specs/"

        [[surface]]
        id      = "graph"
        name    = "Boundary Graph"
        path    = "graph/"
        present = "cover"

        [core]
        bin = "target/release/veistra-acme"
    "#;

    #[test]
    fn parses_several_surfaces_in_declaration_order() {
        let manifest = ToolManifest::parse(MULTI).expect("multi-surface manifest should parse");

        assert_eq!(manifest.tool.name.as_deref(), Some("Acme"));
        assert_eq!(manifest.tool.description, "Technical design software.");

        let ids: Vec<&str> = manifest.surfaces.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["specs", "graph"], "order is the author's");

        assert_eq!(manifest.surfaces[0].path, Some(PathBuf::from("specs/")));
        assert_eq!(manifest.surfaces[0].present, Presentation::Pane);
        assert_eq!(manifest.surfaces[1].present, Presentation::Cover);
        assert_eq!(manifest.surfaces[1].description, "");
    }

    #[test]
    fn surface_looks_up_by_id() {
        let manifest = ToolManifest::parse(MULTI).unwrap();
        assert_eq!(
            manifest.surface("graph").map(|s| s.id.as_str()),
            Some("graph")
        );
        assert!(manifest.surface("nope").is_none());
    }

    /// The backend-only package: no UI, no surfaces, and still a valid manifest.
    #[test]
    fn a_package_may_declare_no_frontend_and_no_surfaces() {
        let toml = r#"
            [tool]
            id = "indexer"
            version = "0.1.0"

            [core]
            bin = "target/release/indexer"
        "#;

        let manifest = ToolManifest::parse(toml).expect("backend-only package should parse");
        assert!(manifest.frontend.is_none());
        assert!(manifest.surfaces.is_empty(), "nothing to put in a pane");
        assert!(manifest.core.is_some());
    }

    #[test]
    fn a_package_may_declare_no_core() {
        let toml = r#"
            [tool]
            id = "notes"
            version = "0.1.0"

            [frontend]
            dist = "ui/dist"
        "#;

        let manifest = ToolManifest::parse(toml).expect("frontend-only package should parse");
        assert!(manifest.core.is_none());
        assert_eq!(manifest.surfaces.len(), 1);
        assert!(matches!(
            manifest.resolve_bin(Path::new("/checkout")),
            Err(ManifestError::NoCore)
        ));
        assert_eq!(
            manifest.resolve_dist(Path::new("/checkout")),
            Some(PathBuf::from("/checkout/ui/dist"))
        );
    }

    #[test]
    fn a_package_with_neither_half_still_parses() {
        // Useless, but not malformed — and refusing it would mean inventing a
        // rule the format does not otherwise need. The shell decides there is
        // nothing to offer; the parser only reports what was written.
        let toml = r#"
            [tool]
            id = "empty"
            version = "0.1.0"
        "#;
        let manifest = ToolManifest::parse(toml).expect("parses");
        assert!(manifest.frontend.is_none() && manifest.core.is_none());
        assert!(manifest.surfaces.is_empty());
    }

    #[test]
    fn duplicate_surface_ids_are_rejected() {
        let toml = r#"
            [tool]
            id = "dup"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [[surface]]
            id = "one"
            [[surface]]
            id = "one"
        "#;

        match ToolManifest::parse(toml) {
            Err(ManifestError::DuplicateSurfaceId { id }) => assert_eq!(id, "one"),
            other => panic!("expected DuplicateSurfaceId, got {other:?}"),
        }
    }

    #[test]
    fn a_surface_without_a_frontend_is_rejected() {
        let toml = r#"
            [tool]
            id = "nobundle"
            version = "0.1.0"
            [[surface]]
            id = "one"
        "#;

        match ToolManifest::parse(toml) {
            Err(ManifestError::SurfaceWithoutFrontend { id }) => assert_eq!(id, "one"),
            other => panic!("expected SurfaceWithoutFrontend, got {other:?}"),
        }
    }

    #[test]
    fn a_surface_id_follows_the_same_rule_as_a_tool_id() {
        let toml = r#"
            [tool]
            id = "pkg"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [[surface]]
            id = "Not-Lowercase"
        "#;

        match ToolManifest::parse(toml) {
            Err(ManifestError::InvalidId { id }) => assert_eq!(id, "Not-Lowercase"),
            other => panic!("expected InvalidId, got {other:?}"),
        }
    }

    /// `surface.path` is joined onto a trusted root exactly as `dist` and `bin`
    /// are, so it is held to the same rule — and the error names the key.
    #[test]
    fn a_surface_path_may_not_escape_the_bundle() {
        let toml = r#"
            [tool]
            id = "pkg"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [[surface]]
            id = "sneaky"
            path = "../../etc"
        "#;

        match ToolManifest::parse(toml) {
            Err(ManifestError::PathEscapesRoot { field, .. }) => {
                assert_eq!(field, "surface.path");
            }
            other => panic!("expected PathEscapesRoot, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_surface_key_is_an_error() {
        let toml = r#"
            [tool]
            id = "pkg"
            version = "0.1.0"
            [frontend]
            dist = "ui/dist"
            [[surface]]
            id = "one"
            titel = "typo"
        "#;
        assert!(matches!(
            ToolManifest::parse(toml),
            Err(ManifestError::Toml(_))
        ));
    }
}
