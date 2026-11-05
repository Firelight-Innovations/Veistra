//! The context store: images, files and snippets that a person (or an app)
//! wants an agent to have, kept as plain files inside the environment.
//!
//! Design: `docs/design/VEISTRA-AGENT-CONTEXT.md`. Every harness can read a file
//! by path, so a file under `.veistra/context/` is the transport; `@` mentions and
//! thumbnails are conveniences on top.
//!
//! Layout, per environment:
//! ```text
//! .veistra/context/.gitignore          `*` — context never enters a commit
//! .veistra/context/<key-slug>.png      the bytes (an "owned" item)
//! .veistra/context/<id>.json           the sidecar: one [`ContextItem`]
//! ```
//!
//! A sidecar per item, as in `comments.rs`: a lost one leaves the file usable.
//!
//! **Writes are allowed in a main cluster.** `.veistra/context/` is Veistra's own
//! state, not the checkout, and the nested `.gitignore` keeps it out of `git
//! status`. `apps::write_refusal` therefore does not list any `context/*`
//! method, and the shell commands here never call `guard_cluster_write`.

use crate::refs::policy;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};

/// Stored-image ceiling. Not downscaled here: there is no image codec in the
/// tree, and the honest answer to "too big" is a refusal the user can act on.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Text beyond this is cut at a line boundary and marked truncated.
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
/// The copy limit for a file dropped in from outside the environment.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Per-environment retention, a backstop now that a key overwrites rather than
/// accumulates. Whichever limit is hit first, the oldest owned item goes first.
pub const MAX_ITEMS: usize = 200;
pub const MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
/// A key longer than this is refused; the file name is cut well before it.
const MAX_KEY_CHARS: usize = 240;
/// How long a rename over a file a reader has open is retried before the write
/// falls back to a new name.
const RENAME_ATTEMPTS: u32 = 12;
const RENAME_DELAY_MS: u64 = 40;
/// Prefix of the in-flight file of an atomic write. A leftover older than
/// [`STALE_TMP_SECS`] (a crash between write and rename) is swept by `prune`.
const TMP_PREFIX: &str = ".tmp-";
const STALE_TMP_SECS: u64 = 600;

/// The event Rust emits after any change to a store. The payload is
/// `{ "root": "<environment root>" }`; a listener refetches if that root is
/// the one it is showing.
pub const CHANGED_EVENT: &str = "context:changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Image,
    File,
    /// A snippet of text: a log tail, a selection, a note.
    Text,
    /// Structured data an agent reads as JSON (a markup export). Stored as a
    /// `.json` file, never truncated: a cut document would not parse.
    Json,
    /// A capture of a whole panel. Stored exactly like an image; the kind is
    /// there so a strip can say where it came from.
    Panel,
}

impl Kind {
    fn is_image_like(self) -> bool {
        matches!(self, Kind::Image | Kind::Panel)
    }
}

/// How the item arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// An app pushed it through `context/put`.
    Put,
    Drop,
    Clipboard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// Stamped by the shell from the calling frame, never taken from params.
    pub app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInfo {
    pub chars: usize,
    pub lines: usize,
    pub truncated: bool,
}

/// One sidecar file. The subset of the spec's `ContextItem` this build can
/// keep honest: no video, no derivatives, no expiry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    /// `ctx_` + 16 hex digits of the key's hash (see [`id_for_key`]). Records
    /// from before keys existed carry `ctx_` + time and randomness instead.
    pub id: String,
    /// The stable source key the id and file name derive from. Empty on a
    /// record written before keys existed.
    #[serde(default)]
    pub key: String,
    pub v: u8,
    pub kind: Kind,
    /// Sniffed from the bytes for images, from the extension otherwise.
    pub mime: String,
    pub title: String,
    pub source: Source,
    pub method: Method,
    /// Epoch milliseconds, when the key was first sent.
    pub created_at: u64,
    /// Epoch milliseconds of the latest send; the strip orders by this and
    /// shows "updated" when it is later than `created_at`. 0 on an old record.
    #[serde(default)]
    pub updated_at: u64,
    /// Hex SHA-256 of the stored bytes, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// The file's modification time (epoch ms) when it was last written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
    /// Set when the write could not overwrite the usual file (a reader held it)
    /// and this item lives under a different name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    pub size: u64,
    /// Absolute, native separators.
    pub path: String,
    /// Relative to the environment root, forward slashes. Empty when the file
    /// is outside the root.
    pub rel_path: String,
    /// True when Veistra wrote the file into the store, so removing the item
    /// deletes it. False for a file referenced where it already lives.
    pub owned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextInfo>,
    /// First characters of a text item, for a chip that has no thumbnail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// What the agent is asked to do with this item ("Read the notes in this
    /// packet, fix each one, then call resolve_play_note"). An app's Send puts
    /// only a chip on the prompt; this travels inside it, ahead of the item's
    /// content, so the person sees one chip and never a sentence typed for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Computed on every read, never stored: the file has been deleted or moved
    /// since. The strip greys the chip rather than hiding it.
    #[serde(default, skip_deserializing)]
    pub missing: bool,
}

/// Where the content of a put comes from.
#[derive(Debug, Clone)]
pub enum Payload {
    Bytes(Vec<u8>),
    Text(String),
    /// A file that already exists on disk.
    Path(PathBuf),
}

#[derive(Debug, Clone)]
pub struct PutRequest {
    /// The stable source key. `None` derives one: `paste/<hash>` for bytes and
    /// text, `file/<path>` for a file.
    pub key: Option<String>,
    /// `None` infers: an image by its bytes, a file otherwise, text for
    /// [`Payload::Text`].
    pub kind: Option<Kind>,
    pub title: Option<String>,
    pub payload: Payload,
    pub app_id: String,
    pub label: Option<String>,
    pub method: Method,
    /// For [`Payload::Path`]: when the file is already inside the environment,
    /// reference it there instead of copying. Off for callers that want a
    /// stable snapshot.
    pub reference_in_place: bool,
}

// --- storage ----------------------------------------------------------------

/// `<root>/.veistra/context`.
pub fn store_dir(root: &Path) -> PathBuf {
    root.join(".veistra").join("context")
}

fn sidecar(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Ids are minted here, so anything else is either a bug or a traversal
/// attempt from a caller, and is refused before it reaches a path join.
fn valid_id(id: &str) -> bool {
    id.strip_prefix("ctx_").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 32 && rest.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

pub fn ensure_dir(root: &Path) -> Result<PathBuf, RpcError> {
    let dir = store_dir(root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| internal(format!("could not create {}: {e}", dir.display())))?;
    // Written once and never rewritten: a user who edits it keeps their edit.
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "*\n");
    }
    Ok(dir)
}

fn internal(message: String) -> RpcError {
    RpcError::new(INTERNAL_ERROR, message)
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(INVALID_PARAMS, message.into())
}

// --- the operations ----------------------------------------------------------

/// Every item, newest first. A directory that does not exist is an empty list.
pub fn list(root: &Path) -> Vec<ContextItem> {
    let dir = store_dir(root);
    let Ok(reader) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items: Vec<ContextItem> = reader
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        // Only sidecars: a JSON item's own bytes, `<key-slug>.json`, sit beside them.
        .filter(|e| {
            e.path()
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(valid_id)
        })
        .filter_map(|e| {
            let raw = std::fs::read_to_string(e.path()).ok()?;
            match serde_json::from_str::<ContextItem>(&raw) {
                Ok(mut item) => {
                    item.missing = !Path::new(&item.path).exists();
                    Some(item)
                }
                Err(err) => {
                    crate::veistra_log!(
                        "skipping unreadable context item {}: {err}",
                        e.path().display()
                    );
                    None
                }
            }
        })
        .collect();
    items.sort_by(|a, b| b.recency().cmp(&a.recency()).then_with(|| b.id.cmp(&a.id)));
    items
}

impl ContextItem {
    /// When this item was last sent: a re-send bumps it to the top.
    fn recency(&self) -> u64 {
        self.updated_at.max(self.created_at)
    }
}

pub fn get(root: &Path, id: &str) -> Result<ContextItem, RpcError> {
    if !valid_id(id) {
        return Err(invalid(format!("`{id}` is not a context item id")));
    }
    let raw = std::fs::read_to_string(sidecar(&store_dir(root), id))
        .map_err(|_| invalid(format!("no context item `{id}` in this environment")))?;
    let mut item: ContextItem = serde_json::from_str(&raw)
        .map_err(|e| internal(format!("context item `{id}` is unreadable: {e}")))?;
    item.missing = !Path::new(&item.path).exists();
    Ok(item)
}

/// Forget an item. Deletes the file only when Veistra wrote it; a file that was
/// referenced in place is the user's and is never touched.
pub fn remove(root: &Path, id: &str) -> Result<(), RpcError> {
    let item = get(root, id)?;
    let dir = store_dir(root);
    if item.owned {
        // Only ever a file inside the store: refuse to follow a hand-edited
        // sidecar out of it.
        let path = PathBuf::from(&item.path);
        if path.starts_with(&dir) {
            let _ = std::fs::remove_file(&path);
        }
    }
    let _ = std::fs::remove_file(sidecar(&dir, id));
    Ok(())
}

/// The bytes of an owned or referenced image, base64, for the strip's
/// thumbnail. Images only, and only the 8 MB the store allows, so this cannot
/// be turned into a general file reader.
pub fn read_image(root: &Path, id: &str) -> Result<(String, String), RpcError> {
    let item = get(root, id)?;
    if !item.kind.is_image_like() {
        return Err(invalid("only image items have a thumbnail"));
    }
    let bytes = std::fs::read(&item.path)
        .map_err(|e| internal(format!("could not read {}: {e}", item.path)))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(invalid("that image is larger than the store allows"));
    }
    Ok((item.mime, BASE64.encode(bytes)))
}

/// Materialise something into the store and return its record.
///
/// Every item has a stable key (`blender/<blend>/<view>`, `godot/<scene>/frame`,
/// `file/<relpath>`, `paste/<content hash>`). The id and the file name both
/// derive from it, so sending the same source again overwrites the file and the
/// sidecar and bumps the one record, instead of adding a copy. Overwrites are
/// atomic, and identical bytes arriving under a different key are stored once.
pub fn put(root: &Path, request: PutRequest) -> Result<ContextItem, RpcError> {
    put_with(root, request, &|from, to| std::fs::rename(from, to))
}

/// Most characters an item's [`ContextItem::prompt`] keeps: instructions, not a document.
pub const MAX_PROMPT_CHARS: usize = 4000;

/// Sets or clears item `id`'s prompt. `context/put` sets it on every put, so a
/// send that says nothing never carries an older send's instructions.
pub fn set_prompt(root: &Path, id: &str, prompt: Option<&str>) -> Result<ContextItem, RpcError> {
    let mut item = get(root, id)?;
    item.prompt = prompt
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.chars().take(MAX_PROMPT_CHARS).collect());
    write_sidecar(&store_dir(root), &item, &|from, to| {
        std::fs::rename(from, to)
    })?;
    Ok(item)
}

/// [`put`] with the rename injected, so a test can stand in for a reader that
/// holds the destination open.
fn put_with(
    root: &Path,
    request: PutRequest,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<ContextItem, RpcError> {
    let PutRequest {
        key,
        kind,
        title,
        payload,
        app_id,
        label,
        method,
        reference_in_place,
    } = request;
    let dir = ensure_dir(root)?;
    // A file's own name is its title until the caller says otherwise.
    let title = title.or_else(|| match &payload {
        Payload::Path(p) => p.file_name().map(|n| n.to_string_lossy().into_owned()),
        _ => None,
    });
    let now = crate::comments::monotonic_ms();
    let source_path = match &payload {
        Payload::Path(p) => Some(p.clone()),
        _ => None,
    };

    // What the content is, and the bytes to write (or the file to reference).
    enum Body {
        Write(Vec<u8>),
        InPlace(PathBuf),
    }
    let (kind, body, sniffed, ext_hint, text_meta, preview) = match payload {
        Payload::Bytes(bytes) => {
            let sniffed = sniff(&bytes);
            let kind = kind.unwrap_or(if sniffed.is_some() {
                Kind::Image
            } else {
                Kind::File
            });
            (kind, Body::Write(bytes), sniffed, None, None, None)
        }
        Payload::Text(text) => {
            let kind = kind.unwrap_or(Kind::Text);
            let json = kind == Kind::Json;
            if json && text.len() > MAX_TEXT_BYTES {
                return Err(invalid(format!(
                    "that JSON is {} KB; the limit is {} KB and a cut document would not parse",
                    text.len() / 1024,
                    MAX_TEXT_BYTES / 1024
                )));
            }
            let (text, meta) = clamp_text(text);
            let preview: String = text.chars().take(240).collect();
            let bytes = text.into_bytes();
            (
                kind,
                Body::Write(bytes),
                None,
                Some(if json { "json" } else { "txt" }.to_string()),
                Some(meta),
                Some(preview),
            )
        }
        Payload::Path(path) => {
            let meta = std::fs::metadata(&path)
                .map_err(|e| invalid(format!("cannot read {}: {e}", path.display())))?;
            if !meta.is_file() {
                return Err(invalid(format!("{} is not a file", path.display())));
            }
            let head = read_head(&path);
            let sniffed = sniff(&head);
            let kind = kind.unwrap_or(if sniffed.is_some() {
                Kind::Image
            } else {
                Kind::File
            });
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase);
            if reference_in_place && inside(root, &path) {
                (kind, Body::InPlace(path), sniffed, ext, None, None)
            } else {
                if meta.len() > MAX_FILE_BYTES {
                    return Err(invalid(format!(
                        "{} is over the {} MB copy limit",
                        path.display(),
                        MAX_FILE_BYTES / 1024 / 1024
                    )));
                }
                let bytes = std::fs::read(&path)
                    .map_err(|e| internal(format!("could not read {}: {e}", path.display())))?;
                (kind, Body::Write(bytes), sniffed, ext, None, None)
            }
        }
    };

    if kind.is_image_like() && sniffed.is_none() {
        return Err(invalid("the bytes are not a PNG, JPEG, GIF or WebP image"));
    }
    if let Body::Write(bytes) = &body {
        if kind.is_image_like() && bytes.len() > MAX_IMAGE_BYTES {
            return Err(invalid(format!(
                "that image is {:.1} MB; the limit is {} MB",
                bytes.len() as f64 / 1_048_576.0,
                MAX_IMAGE_BYTES / 1024 / 1024
            )));
        }
        // Executable-looking content is never copied into a place an agent is
        // told to open. Referencing one in place is the user's own doing.
        if looks_executable(bytes) {
            return Err(invalid(
                "that looks like an executable, which the context store refuses",
            ));
        }
        if let Some(rule) = secret_in(source_path.as_deref(), title.as_deref(), bytes) {
            return Err(invalid(format!(
                "not copied into the context store: it matches the secrets rule for {rule}. \
                 Remove the secrets, or share the file by another route"
            )));
        }
    }

    let sha = match &body {
        Body::Write(bytes) => Some(sha_hex(bytes)),
        Body::InPlace(path) => hash_file(path),
    };
    let key = match key {
        Some(k) => normalize_key(&k)?,
        None => default_key(root, source_path.as_deref(), sha.as_deref()),
    };
    let id = id_for_key(&key);
    let previous = get(root, &id).ok();
    let created_at = previous.as_ref().map_or(now, |p| p.created_at);

    // The same bytes under a key nobody has used: store them once, and hand back
    // the record that already holds them, bumped to the top.
    if let (None, Body::Write(_), Some(sha)) = (&previous, &body, &sha) {
        let twin = list(root).into_iter().find(|i| {
            i.owned && !i.missing && i.kind == kind && i.sha256.as_deref() == Some(sha.as_str())
        });
        if let Some(mut twin) = twin {
            twin.updated_at = now;
            write_sidecar(&dir, &twin, rename)?;
            return Ok(twin);
        }
    }

    let (path, size, mime, owned, notice, mtime) = match body {
        Body::Write(bytes) => {
            let ext = match &sniffed {
                Some(s) => s.ext.to_string(),
                None => sanitize_ext(ext_hint.as_deref().unwrap_or("bin")),
            };
            let mime = sniffed
                .as_ref()
                .map(|s| s.mime.to_string())
                .unwrap_or_else(|| mime_for_ext(&ext).to_string());
            // Identical bytes already in place: nothing to write, only a bump.
            let current = previous.as_ref().filter(|p| {
                p.owned && !p.missing && p.sha256 == sha && p.size == bytes.len() as u64
            });
            if let Some(p) = current {
                (
                    PathBuf::from(&p.path),
                    p.size,
                    mime,
                    true,
                    p.notice.clone(),
                    p.mtime,
                )
            } else {
                let target = stable_path(&dir, previous.as_ref(), &key, &id, &ext);
                let (path, notice) = write_owned(&target, &bytes, rename)?;
                let mtime = file_mtime_ms(&path);
                (path, bytes.len() as u64, mime, true, notice, mtime)
            }
        }
        Body::InPlace(path) => {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let ext = ext_hint.clone().unwrap_or_default();
            let mime = sniffed
                .as_ref()
                .map(|s| s.mime.to_string())
                .unwrap_or_else(|| mime_for_ext(&ext).to_string());
            let mtime = file_mtime_ms(&path);
            (path, size, mime, false, None, mtime)
        }
    };

    let title = title
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().chars().take(120).collect::<String>())
        .unwrap_or_else(|| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "context".into())
        });

    let item = ContextItem {
        id: id.clone(),
        key,
        v: 1,
        kind,
        mime,
        title,
        source: Source { app_id, label },
        method,
        created_at,
        updated_at: now,
        sha256: sha,
        mtime,
        notice,
        size,
        rel_path: relative_to(root, &path).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        owned,
        image: sniffed
            .and_then(|s| s.dims)
            .map(|(width, height)| ImageInfo { width, height }),
        text: text_meta,
        preview,
        prompt: None,
        missing: false,
    };

    write_sidecar(&dir, &item, rename)?;

    // A copy Veistra wrote under another name (the extension changed, or the
    // last send fell back to a new name) is now stale: the record moved on.
    // The exception is the canonical file a reader is holding: it stays, stale,
    // and the next send over it succeeds once the reader lets go.
    let held_canonical = |p: &ContextItem| item.notice.is_some() && p.notice.is_none();
    if let Some(old) = previous
        .as_ref()
        .filter(|p| p.owned && p.path != item.path && !held_canonical(p))
    {
        let old = PathBuf::from(&old.path);
        if old.starts_with(&dir) {
            let _ = std::fs::remove_file(old);
        }
    }

    prune(root);
    Ok(item)
}

// --- keys, and writing over them ---------------------------------------------

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hash_file(path: &Path) -> Option<String> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read(path).ok().map(|b| sha_hex(&b))
}

/// Lower-case, forward slashes, no empty segments, so `Blender/Room//Top` and
/// `blender/room/top` are one key.
fn normalize_key(raw: &str) -> Result<String, RpcError> {
    let joined = raw
        .trim()
        .replace('\\', "/")
        .to_lowercase()
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return Err(invalid("a context key cannot be empty"));
    }
    if joined.chars().count() > MAX_KEY_CHARS {
        return Err(invalid(format!(
            "a context key is at most {MAX_KEY_CHARS} characters"
        )));
    }
    Ok(joined)
}

/// The key for a put whose caller did not name one: a file is its path, anything
/// else is its content.
fn default_key(root: &Path, path: Option<&Path>, sha: Option<&str>) -> String {
    let normalized = match path {
        Some(p) => {
            let shown = relative_to(root, p).unwrap_or_else(|| p.to_string_lossy().into_owned());
            format!("file/{shown}")
        }
        None => {
            let short: String = sha.unwrap_or("none").chars().take(16).collect();
            format!("paste/{short}")
        }
    };
    normalize_key(&normalized).unwrap_or_else(|_| "paste/unknown".into())
}

/// `ctx_` + 16 hex digits of the key's SHA-256. Valid by [`valid_id`], and the
/// same every time, which is what makes a re-send land on the same record.
fn id_for_key(key: &str) -> String {
    let full = sha_hex(key.as_bytes());
    format!("ctx_{}", &full[..16])
}

/// The readable part of a file name, from the key: `blender/room/three-quarter`
/// becomes `blender-room-three-quarter`. A long key keeps its first and last
/// segment and the id's tail, so the name stays short and stays unique.
fn key_stem(key: &str, id: &str) -> String {
    let segments: Vec<String> = key
        .split('/')
        .map(slugify)
        .filter(|s| !s.is_empty())
        .collect();
    let tail = &id[id.len().saturating_sub(4)..];
    let joined = segments.join("-");
    if joined.is_empty() {
        return format!("item-{tail}");
    }
    if joined.len() <= 40 {
        return joined;
    }
    let first = segments.first().cloned().unwrap_or_default();
    let last: String = segments
        .last()
        .map(|s| s.chars().take(28).collect())
        .unwrap_or_default();
    format!("{first}-{last}-{tail}")
        .trim_matches('-')
        .to_string()
}

/// Where the file for `key` goes. A record that already owns the canonical name
/// keeps it. A name held by a different key (or an old timestamped file) is not
/// touched: the id's tail is added.
fn stable_path(
    dir: &Path,
    previous: Option<&ContextItem>,
    key: &str,
    id: &str,
    ext: &str,
) -> PathBuf {
    let stem = key_stem(key, id);
    let want = dir.join(format!("{stem}.{ext}"));
    let ours = previous.is_some_and(|p| {
        Path::new(&p.path) == want.as_path()
            // The last send could not take this name, so it is ours and locked.
            || p.notice.is_some()
    });
    if ours || !want.exists() {
        return want;
    }
    let tail = &id[id.len().saturating_sub(4)..];
    dir.join(format!("{stem}-{tail}.{ext}"))
}

fn is_busy(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Temp file in the destination's own directory, then a rename over the target.
/// The rename is atomic on one volume and replaces an existing file on Windows
/// too. A reader with the target open makes it fail there; that is retried for
/// a moment before the error is returned. A failure leaves no temp file behind.
fn write_atomic(
    path: &Path,
    bytes: &[u8],
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("a context file needs a directory"))?;
    let tmp = dir.join(format!("{TMP_PREFIX}{:08x}", rand::rng().next_u32()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let mut attempt = 1;
    loop {
        match rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < RENAME_ATTEMPTS && is_busy(&e) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(RENAME_DELAY_MS));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

/// [`write_atomic`] to the stable name; only if that stays impossible, a new
/// name, reported in the returned notice.
fn write_owned(
    target: &Path,
    bytes: &[u8],
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(PathBuf, Option<String>), RpcError> {
    let first = match write_atomic(target, bytes, rename) {
        Ok(()) => return Ok((target.to_path_buf(), None)),
        Err(e) => e,
    };
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = target
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let alt = target.with_file_name(format!(
        "{stem}-{}-{:04x}.{ext}",
        stamp(crate::comments::monotonic_ms()),
        rand::rng().next_u32() & 0xFFFF
    ));
    write_atomic(&alt, bytes, rename).map_err(|e| {
        internal(format!(
            "could not write {} ({first}) or {} ({e})",
            target.display(),
            alt.display()
        ))
    })?;
    let shown = |p: &Path| {
        p.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let note = format!(
        "{} was in use ({first}), so this was saved as {}",
        shown(target),
        shown(&alt)
    );
    crate::veistra_log!("context: {note}");
    Ok((alt, Some(note)))
}

fn write_sidecar(
    dir: &Path,
    item: &ContextItem,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), RpcError> {
    let json = serde_json::to_string_pretty(item).map_err(|e| internal(e.to_string()))?;
    write_atomic(&sidecar(dir, &item.id), json.as_bytes(), rename)
        .map_err(|e| internal(format!("could not write the context record: {e}")))
}

fn file_mtime_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    u64::try_from(ms).ok()
}

/// Keep the store inside its retention limits, oldest owned item first.
/// Referenced-in-place records cost nothing and are only dropped by count.
pub fn prune(root: &Path) {
    prune_to(root, MAX_ITEMS, MAX_TOTAL_BYTES);
}

fn sweep_stale_temp(dir: &Path) {
    let Ok(reader) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in reader.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(TMP_PREFIX) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > STALE_TMP_SECS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn prune_to(root: &Path, max_items: usize, max_bytes: u64) {
    sweep_stale_temp(&store_dir(root));
    let mut items = list(root);
    items.reverse(); // oldest first
    let mut count = items.len();
    let mut total: u64 = items.iter().filter(|i| i.owned).map(|i| i.size).sum();
    for item in items {
        if count <= max_items && total <= max_bytes {
            break;
        }
        if remove(root, &item.id).is_ok() {
            count -= 1;
            if item.owned {
                total = total.saturating_sub(item.size);
            }
        }
    }
}

// --- content sniffing --------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct Sniffed {
    pub(crate) mime: &'static str,
    ext: &'static str,
    pub(crate) dims: Option<(u32, u32)>,
}

/// What image, if any, these bytes are. Trusts the bytes and nothing else: a
/// declared mime or a file extension never decides this. `refs` uses it too,
/// so a referenced image is judged the same way as a stored one.
pub(crate) fn sniff(bytes: &[u8]) -> Option<Sniffed> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        let dims = (bytes.len() >= 24).then(|| (be32(&bytes[16..20]), be32(&bytes[20..24])));
        return Some(Sniffed {
            mime: "image/png",
            ext: "png",
            dims,
        });
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(Sniffed {
            mime: "image/jpeg",
            ext: "jpg",
            dims: jpeg_dims(bytes),
        });
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        let dims = (bytes.len() >= 10).then(|| {
            (
                u32::from(u16::from_le_bytes([bytes[6], bytes[7]])),
                u32::from(u16::from_le_bytes([bytes[8], bytes[9]])),
            )
        });
        return Some(Sniffed {
            mime: "image/gif",
            ext: "gif",
            dims,
        });
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(Sniffed {
            mime: "image/webp",
            ext: "webp",
            dims: webp_dims(bytes),
        });
    }
    None
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// A WebP's size, from whichever of its three headers it opens with.
fn webp_dims(bytes: &[u8]) -> Option<(u32, u32)> {
    let le24 = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], 0]);
    match bytes.get(12..16)? {
        b"VP8X" if bytes.len() >= 30 => Some((1 + le24(24), 1 + le24(27))),
        // Lossy: after the start code, 14-bit sizes with two scaling bits above.
        b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9D, 0x01, 0x2A] => {
            let size =
                |at: usize| u32::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]) & 0x3FFF);
            Some((size(26), size(28)))
        }
        // Lossless: after the signature byte, each size less one in 14 bits.
        b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2F => {
            let bits = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
            Some((1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)))
        }
        _ => None,
    }
}

/// Walk JPEG segments to the first start-of-frame marker.
fn jpeg_dims(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 9 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        let len = usize::from(u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]));
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let h = u32::from(u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]));
            let w = u32::from(u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]));
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// The secrets rule a copy would break, by the same lists the `veistra://`
/// resolver withholds a stored copy with: the source path, the title and the
/// first 64 KB. Screened here too so the bytes never reach the store. The
/// title is free text, so it counts only when it is spelt as a file name.
fn secret_in(source: Option<&Path>, title: Option<&str>, bytes: &[u8]) -> Option<&'static str> {
    let by_name = source
        .and_then(|p| policy::secret_rule(&p.to_string_lossy()))
        .or_else(|| title.and_then(policy::title_rule));
    by_name.or_else(|| policy::secret_content(&bytes[..bytes.len().min(64 * 1024)]))
}

fn looks_executable(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
        || bytes.starts_with(&[0x7F, b'E', b'L', b'F'])
        || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
        || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
        || bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
}

fn read_head(path: &Path) -> Vec<u8> {
    use std::io::Read;
    let mut buf = vec![0u8; 64 * 1024];
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let n = file.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    buf
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "gd" | "rs" | "ts" | "tsx" | "js" | "py" | "cs" | "toml" | "yaml" | "yml" | "gdshader" => {
            "text/plain"
        }
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn clamp_text(text: String) -> (String, TextInfo) {
    let truncated = text.len() > MAX_TEXT_BYTES;
    let mut out = if truncated {
        // Cut at a char boundary, then back to the last line break.
        let mut end = MAX_TEXT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let cut = &text[..end];
        let cut = cut.rfind('\n').map_or(cut, |n| &cut[..n]);
        format!("{cut}\n[truncated by Veistra at 256 KB]\n")
    } else {
        text
    };
    let chars = out.chars().count();
    let lines = out.lines().count();
    if out.is_empty() {
        out.push('\n');
    }
    (
        out,
        TextInfo {
            chars,
            lines,
            truncated,
        },
    )
}

// --- names and paths ---------------------------------------------------------

/// File names are `[a-z0-9-]` only (see [`key_stem`]), so no harness adapter
/// ever has to quote a name Veistra chose.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    trimmed
        .chars()
        .take(32)
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn sanitize_ext(ext: &str) -> String {
    let e: String = ext
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if e.is_empty() {
        "bin".into()
    } else {
        e
    }
}

/// `yyyymmdd-hhmmss` in UTC from epoch milliseconds (Howard Hinnant's
/// civil-from-days, which needs no date crate).
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Lexical containment, with `.` and `..` folded. Not `canonicalize`: the path
/// may be on a drive that has since gone, and Windows verbatim prefixes make a
/// canonical path compare unequal to the one the user typed.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn inside(root: &Path, path: &Path) -> bool {
    let (root, path) = (normalize(root), normalize(path));
    if cfg!(windows) {
        let lower = |p: &Path| p.to_string_lossy().to_ascii_lowercase().replace('\\', "/");
        let mut r = lower(&root);
        if !r.ends_with('/') {
            r.push('/');
        }
        lower(&path).starts_with(&r)
    } else {
        path.starts_with(&root)
    }
}

/// `path` relative to `root`, forward slashes, or `None` when it is outside.
pub fn relative_to(root: &Path, path: &Path) -> Option<String> {
    if !inside(root, path) {
        return None;
    }
    let (root, path) = (normalize(root), normalize(path));
    let rel = if cfg!(windows) {
        let r = root.to_string_lossy().replace('\\', "/");
        let p = path.to_string_lossy().replace('\\', "/");
        p.get(r.trim_end_matches('/').len()..)?
            .trim_start_matches('/')
            .to_string()
    } else {
        path.strip_prefix(&root)
            .ok()?
            .to_string_lossy()
            .into_owned()
    };
    Some(rel)
}

// --- the RPC surface for apps ---------------------------------------------------

/// Answered by the host before any app is looked up, so every app (and a
/// plugin surface) reaches one store the same way. See `apps::call`.
pub fn is_method(method: &str) -> bool {
    method.starts_with("context/")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutParams {
    /// Names the source, e.g. `blender/<blend>/<view>`; sending it again
    /// replaces the earlier item instead of adding one.
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    kind: Option<Kind>,
    #[serde(default)]
    title: Option<String>,
    /// Standard base64, no data-URI prefix — the convention `comments/create`
    /// and `files::readBytes` already use.
    #[serde(default)]
    bytes_base64: Option<String>,
    #[serde(default)]
    text: Option<String>,
    /// An absolute path to a file the app already wrote.
    #[serde(default)]
    path: Option<String>,
    /// A line for the strip ("Play - scene hospital_wing.tscn").
    #[serde(default)]
    label: Option<String>,
    /// What the agent is asked to do with the item; see [`ContextItem::prompt`].
    #[serde(default)]
    prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IdParams {
    id: String,
}

/// `context/put`, `context/list`, `context/get`, `context/remove`. `app_id` is
/// the calling surface's id as the shell resolved it, and is what a put is
/// stamped with.
pub fn call(
    root: Option<&Path>,
    app_id: &str,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let root = root.ok_or_else(|| {
        internal("this cluster has no environment to keep context in — open a project first".into())
    })?;
    let params = params.unwrap_or(Value::Null);
    match method {
        "context/list" => to_value(list(root)),
        "context/get" => {
            let p: IdParams = parse(params)?;
            to_value(get(root, &p.id)?)
        }
        "context/remove" => {
            let p: IdParams = parse(params)?;
            remove(root, &p.id)?;
            Ok(Value::Null)
        }
        "context/put" => {
            let p: PutParams = parse(params)?;
            let payload = match (p.bytes_base64, p.text, p.path) {
                (Some(b64), None, None) => Payload::Bytes(
                    BASE64
                        .decode(b64)
                        .map_err(|e| invalid(format!("bytesBase64 is not valid base64: {e}")))?,
                ),
                (None, Some(text), None) => Payload::Text(text),
                (None, None, Some(path)) => Payload::Path(PathBuf::from(path)),
                _ => {
                    return Err(invalid(
                        "put needs exactly one of bytesBase64, text or path",
                    ))
                }
            };
            let item = put(
                root,
                PutRequest {
                    key: p.key,
                    kind: p.kind,
                    title: p.title,
                    payload,
                    app_id: app_id.to_string(),
                    label: p.label,
                    method: Method::Put,
                    reference_in_place: true,
                },
            )?;
            // A twin's record comes back as it was, prompt and all: this send's wins.
            if p.prompt.is_some() || item.prompt.is_some() {
                return to_value(set_prompt(root, &item.id, p.prompt.as_deref())?);
            }
            to_value(item)
        }
        other => Err(RpcError::new(
            veistra_rpc::METHOD_NOT_FOUND,
            format!("no method `{other}`"),
        )),
    }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|e| invalid(format!("bad params: {e}")))
}

fn to_value<T: Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| internal(format!("could not serialize response: {e}")))
}

/// Tell every listener a store changed.
pub fn notify(app: &tauri::AppHandle, root: &Path) {
    use tauri::Emitter;
    let _ = app.emit(
        CHANGED_EVENT,
        serde_json::json!({ "root": root.to_string_lossy() }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    fn req(payload: Payload) -> PutRequest {
        PutRequest {
            key: None,
            kind: None,
            title: None,
            payload,
            app_id: "play".into(),
            label: Some("Play - scene".into()),
            method: Method::Put,
            reference_in_place: true,
        }
    }

    #[test]
    fn a_put_image_is_written_with_a_sidecar_and_a_gitignore() {
        let dir = TempDir::new().unwrap();
        let item = put(dir.path(), req(Payload::Bytes(png(640, 480)))).unwrap();
        assert_eq!(item.kind, Kind::Image);
        assert_eq!(item.mime, "image/png");
        assert_eq!(
            item.image,
            Some(ImageInfo {
                width: 640,
                height: 480
            })
        );
        assert!(item.owned);
        assert!(Path::new(&item.path).is_file());
        assert!(item.rel_path.starts_with(".veistra/context/"));
        assert!(item.rel_path.ends_with(".png"));
        assert!(
            !item.rel_path.contains(' '),
            "names Veistra chooses never need quoting"
        );
        let ignore = std::fs::read_to_string(store_dir(dir.path()).join(".gitignore")).unwrap();
        assert_eq!(ignore, "*\n");
        assert_eq!(get(dir.path(), &item.id).unwrap().id, item.id);
    }

    #[test]
    fn list_is_newest_first_and_empty_without_a_directory() {
        let dir = TempDir::new().unwrap();
        assert!(list(dir.path()).is_empty());
        let a = put(dir.path(), req(Payload::Text("one".into()))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = put(dir.path(), req(Payload::Text("two".into()))).unwrap();
        let ids: Vec<_> = list(dir.path()).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![b.id, a.id]);
    }

    // A keyed JSON item's bytes are `<key-slug>.json` in the same folder; list
    // once read them as a sidecar and logged each as unreadable.
    #[test]
    fn list_reads_only_sidecars_and_not_a_json_item_s_own_file() {
        let dir = TempDir::new().unwrap();
        let mut r = req(Payload::Text("{\"a\": 1}".into()));
        r.key = Some("blender/crate.blend/mention/crate".into());
        r.kind = Some(Kind::Json);
        let item = put(dir.path(), r).unwrap();
        assert!(item.path.ends_with(".json"), "{}", item.path);
        assert_ne!(
            Path::new(&item.path),
            sidecar(&store_dir(dir.path()), &item.id)
        );
        let ids: Vec<_> = list(dir.path()).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![item.id]);
    }

    #[test]
    fn bytes_that_are_not_an_image_are_refused_as_an_image() {
        let dir = TempDir::new().unwrap();
        let mut r = req(Payload::Bytes(b"not a picture".to_vec()));
        r.kind = Some(Kind::Image);
        let err = put(dir.path(), r).unwrap_err();
        assert!(err.message.contains("not a PNG"));
        assert!(
            list(dir.path()).is_empty(),
            "a refusal leaves nothing behind"
        );
    }

    #[test]
    fn an_executable_is_never_copied_in() {
        let dir = TempDir::new().unwrap();
        let mut bytes = b"MZ".to_vec();
        bytes.extend_from_slice(&[0; 64]);
        let err = put(dir.path(), req(Payload::Bytes(bytes))).unwrap_err();
        assert!(err.message.contains("executable"));
    }

    #[test]
    fn an_oversized_image_is_refused_with_its_size() {
        let dir = TempDir::new().unwrap();
        let mut bytes = png(10, 10);
        bytes.resize(MAX_IMAGE_BYTES + 1, 0);
        let err = put(dir.path(), req(Payload::Bytes(bytes))).unwrap_err();
        assert!(err.message.contains("limit is 8 MB"), "{}", err.message);
    }

    #[test]
    fn text_is_truncated_at_a_line_and_marked() {
        let dir = TempDir::new().unwrap();
        let line = "x".repeat(99) + "\n";
        let big = line.repeat(MAX_TEXT_BYTES / 100 + 50);
        let item = put(dir.path(), req(Payload::Text(big))).unwrap();
        assert!(item.text.unwrap().truncated);
        let stored = std::fs::read_to_string(&item.path).unwrap();
        assert!(stored.len() <= MAX_TEXT_BYTES + 64);
        assert!(stored
            .trim_end()
            .ends_with("[truncated by Veistra at 256 KB]"));
        assert!(item.preview.unwrap().len() <= 240);
    }

    #[test]
    fn a_file_inside_the_environment_is_referenced_in_place_and_not_deleted_on_remove() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "# hi").unwrap();
        let item = put(dir.path(), req(Payload::Path(file.clone()))).unwrap();
        assert!(!item.owned);
        assert_eq!(item.rel_path, "notes.md");
        assert_eq!(item.kind, Kind::File);
        remove(dir.path(), &item.id).unwrap();
        assert!(file.exists(), "the user's file is never deleted");
        assert!(list(dir.path()).is_empty());
    }

    #[test]
    fn a_file_outside_the_environment_is_copied_in_and_removal_deletes_the_copy() {
        let env = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let shot = elsewhere.path().join("My Shot.png");
        std::fs::write(&shot, png(4, 4)).unwrap();
        let item = put(env.path(), req(Payload::Path(shot.clone()))).unwrap();
        assert!(item.owned);
        assert_eq!(item.kind, Kind::Image);
        assert!(inside(env.path(), Path::new(&item.path)));
        assert!(item.rel_path.contains("my-shot"));
        assert!(shot.exists(), "the original is never moved");
        remove(env.path(), &item.id).unwrap();
        assert!(!Path::new(&item.path).exists());
    }

    #[test]
    fn secret_files_are_refused_by_name_and_by_content_and_templates_pass() {
        let env = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let write = |name: &str, body: &str| {
            let p = elsewhere.path().join(name);
            std::fs::write(&p, body).unwrap();
            p
        };
        for (name, body, rule) in [
            (".env", "TOKEN=abc", ".env files"),
            ("id_rsa", "not even a key", "SSH private keys"),
            (
                "notes.txt",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n",
                "private keys and key stores",
            ),
        ] {
            let err = put(env.path(), req(Payload::Path(write(name, body)))).unwrap_err();
            assert!(err.message.contains(rule), "{name}: {}", err.message);
        }
        assert!(list(env.path()).is_empty());
        assert!(
            std::fs::read_dir(store_dir(env.path()))
                .map(|d| d.count())
                .unwrap_or(0)
                <= 1,
            "no secret bytes reach the store, only its own bookkeeping"
        );
        put(
            env.path(),
            req(Payload::Path(write(".env.example", "TOKEN="))),
        )
        .unwrap();
    }

    #[test]
    fn a_title_is_screened_only_when_it_is_spelt_as_a_file_name() {
        let env = TempDir::new().unwrap();
        let titled = |title: &str| PutRequest {
            title: Some(title.into()),
            ..req(Payload::Text(format!("{title}: on Monday.")))
        };
        for prose in ["Credentials rotation plan", "secrets.md review"] {
            put(env.path(), titled(prose)).unwrap();
        }
        let err = put(env.path(), titled("id_rsa")).unwrap_err();
        assert!(err.message.contains("SSH private keys"), "{}", err.message);
    }

    #[test]
    fn a_missing_file_marks_the_item_rather_than_hiding_it() {
        let dir = TempDir::new().unwrap();
        let item = put(dir.path(), req(Payload::Text("x".into()))).unwrap();
        std::fs::remove_file(&item.path).unwrap();
        let listed = list(dir.path());
        assert_eq!(listed.len(), 1);
        assert!(listed[0].missing);
    }

    #[test]
    fn ids_that_are_not_ours_never_reach_a_path() {
        let dir = TempDir::new().unwrap();
        for bad in ["../x", "ctx_../x", "ctx_", "x", "ctx_zz"] {
            assert!(get(dir.path(), bad).is_err(), "{bad}");
            assert!(remove(dir.path(), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn read_image_serves_images_only() {
        let dir = TempDir::new().unwrap();
        let img = put(dir.path(), req(Payload::Bytes(png(2, 2)))).unwrap();
        let (mime, b64) = read_image(dir.path(), &img.id).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(BASE64.decode(b64).unwrap(), png(2, 2));
        let text = put(dir.path(), req(Payload::Text("t".into()))).unwrap();
        assert!(read_image(dir.path(), &text.id).is_err());
    }

    #[test]
    fn slugs_are_lowercase_alnum_and_dash() {
        assert_eq!(slugify("Play frame 00:12!"), "play-frame-00-12");
        assert_eq!(slugify("  ../..\\évil  "), "vil");
        assert_eq!(slugify("***"), "");
    }

    #[test]
    fn the_stamp_is_utc_civil_time() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_782_820_800_000), "20260630-120000");
        assert_eq!(stamp(951_782_400_000 + 86_399_000), "20000229-235959");
    }

    #[test]
    fn inside_and_relative_agree_and_fold_dot_dot() {
        let root = Path::new(if cfg!(windows) { "C:/proj" } else { "/proj" });
        let under = root.join("a/b.png");
        assert_eq!(relative_to(root, &under).as_deref(), Some("a/b.png"));
        assert!(!inside(root, &root.join("../other/x.png")));
        assert!(!inside(root, &root.join("a/../../x")));
        let sibling = Path::new(if cfg!(windows) {
            "C:/proj-two/x"
        } else {
            "/proj-two/x"
        });
        assert!(!inside(root, sibling), "a shared prefix is not containment");
    }

    #[test]
    fn dimensions_come_from_jpeg_gif_and_webp_headers() {
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0];
        jpg.extend_from_slice(&[
            0xFF, 0xC0, 0x00, 0x0B, 8, 0x01, 0xE0, 0x02, 0x80, 1, 0, 0, 0, 0,
        ]);
        assert_eq!(sniff(&jpg).unwrap().dims, Some((640, 480)));
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0x20, 0x00, 0x10, 0x00]);
        assert_eq!(sniff(&gif).unwrap().dims, Some((32, 16)));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend_from_slice(&[0x1F, 0x00, 0x00, 0x0F, 0x00, 0x00]);
        assert_eq!(sniff(&webp).unwrap().dims, Some((32, 16)));
        // The simple forms most encoders write: lossy, with its scaling bits
        // set, and lossless.
        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0".to_vec();
        lossy.extend_from_slice(&[0x9D, 0x01, 0x2A, 0x20, 0x40, 0x10, 0x00]);
        assert_eq!(sniff(&lossy).unwrap().dims, Some((32, 16)));
        let mut lossless = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0".to_vec();
        lossless.extend_from_slice(&[0x2F, 0x1F, 0xC0, 0x03, 0x00]);
        assert_eq!(sniff(&lossless).unwrap().dims, Some((32, 16)));
    }

    #[test]
    fn the_host_methods_round_trip_and_stamp_the_caller() {
        let dir = TempDir::new().unwrap();
        let b64 = BASE64.encode(png(3, 3));
        let put_result = call(
            Some(dir.path()),
            "godot-viewer",
            "context/put",
            Some(serde_json::json!({ "kind": "panel", "title": "Viewport", "bytesBase64": b64, "label": "Godot" })),
        )
        .unwrap();
        assert_eq!(put_result["source"]["appId"], "godot-viewer");
        assert_eq!(put_result["kind"], "panel");
        let id = put_result["id"].as_str().unwrap().to_string();
        let listed = call(Some(dir.path()), "x", "context/list", None).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        call(
            Some(dir.path()),
            "x",
            "context/remove",
            Some(serde_json::json!({ "id": id })),
        )
        .unwrap();
        let listed = call(Some(dir.path()), "x", "context/list", None).unwrap();
        assert!(listed.as_array().unwrap().is_empty());
    }

    #[test]
    fn put_needs_exactly_one_payload_and_a_root() {
        let dir = TempDir::new().unwrap();
        let both = serde_json::json!({ "text": "a", "path": "b" });
        assert!(call(Some(dir.path()), "x", "context/put", Some(both)).is_err());
        assert!(call(
            Some(dir.path()),
            "x",
            "context/put",
            Some(serde_json::json!({}))
        )
        .is_err());
        assert!(call(None, "x", "context/list", None).is_err());
    }

    #[test]
    fn retention_drops_the_oldest_owned_items_first() {
        let dir = TempDir::new().unwrap();
        let mut ids = Vec::new();
        for n in 0..4 {
            ids.push(
                put(dir.path(), req(Payload::Text(format!("item {n}"))))
                    .unwrap()
                    .id,
            );
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        prune_to(dir.path(), 2, u64::MAX);
        let kept: Vec<_> = list(dir.path()).into_iter().map(|i| i.id).collect();
        assert_eq!(kept, vec![ids[3].clone(), ids[2].clone()]);
        assert_eq!(
            std::fs::read_dir(store_dir(dir.path()))
                .unwrap()
                .flatten()
                .count(),
            5,
            "2 files + 2 sidecars + .gitignore"
        );
    }

    fn keyed(key: &str, payload: Payload) -> PutRequest {
        PutRequest {
            key: Some(key.into()),
            ..req(payload)
        }
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(store_dir(dir))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != ".gitignore")
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_same_key_overwrites_one_file_however_many_times_it_is_sent() {
        let dir = TempDir::new().unwrap();
        let key = "blender/room/three-quarter";
        let mut last = None;
        for n in 1..=6u32 {
            last = Some(put(dir.path(), keyed(key, Payload::Bytes(png(10 + n, 10)))).unwrap());
        }
        let last = last.unwrap();
        assert_eq!(
            files_in(dir.path()),
            vec![
                "blender-room-three-quarter.png".to_string(),
                format!("{}.json", last.id)
            ]
        );
        assert_eq!(std::fs::read(&last.path).unwrap(), png(16, 10));
        assert_eq!(list(dir.path()).len(), 1);
        assert_eq!(last.sha256.as_deref(), Some(sha_hex(&png(16, 10)).as_str()));
        assert!(last.mtime.is_some());
        assert!(last.updated_at >= last.created_at);
    }

    #[test]
    fn json_is_stored_as_a_json_file_whole_and_overwritten_in_place() {
        let dir = TempDir::new().unwrap();
        let key = "godot/main/markup-json";
        let one = r#"{"v":1,"pins":[]}"#;
        let mut first = req(Payload::Text(one.into()));
        first.key = Some(key.into());
        first.kind = Some(Kind::Json);
        let a = put(dir.path(), first).unwrap();
        assert_eq!(a.kind, Kind::Json);
        assert_eq!(a.mime, "application/json");
        assert!(a.path.ends_with(".json"), "{}", a.path);

        let two = r#"{"v":1,"pins":[1,2,3]}"#;
        let mut second = req(Payload::Text(two.into()));
        second.key = Some(key.into());
        second.kind = Some(Kind::Json);
        let b = put(dir.path(), second).unwrap();
        assert_eq!(b.id, a.id);
        assert_eq!(std::fs::read_to_string(&b.path).unwrap(), two);
        assert_eq!(files_in(dir.path()).len(), 2, "one body and one sidecar");
        assert_eq!(list(dir.path()).len(), 1);
    }

    #[test]
    fn json_over_the_text_limit_is_refused_rather_than_cut() {
        let dir = TempDir::new().unwrap();
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_TEXT_BYTES));
        let mut r = req(Payload::Text(big));
        r.kind = Some(Kind::Json);
        let err = put(dir.path(), r).unwrap_err();
        assert!(err.message.contains("would not parse"), "{}", err.message);
    }

    #[test]
    fn a_resend_keeps_the_id_and_moves_the_item_to_the_top() {
        let dir = TempDir::new().unwrap();
        let a = put(
            dir.path(),
            keyed("godot/main/frame", Payload::Bytes(png(4, 4))),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        put(
            dir.path(),
            keyed("godot/main/tree", Payload::Text("tree".into())),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        let again = put(
            dir.path(),
            keyed("godot/main/frame", Payload::Bytes(png(5, 5))),
        )
        .unwrap();
        assert_eq!(again.id, a.id);
        assert_eq!(again.created_at, a.created_at, "first-sent time is kept");
        assert!(again.updated_at > a.updated_at);
        let listed = list(dir.path());
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, a.id, "the re-sent item is first");
    }

    #[test]
    fn keys_are_case_and_separator_insensitive() {
        let dir = TempDir::new().unwrap();
        let a = put(
            dir.path(),
            keyed("Blender/Room\\Top", Payload::Bytes(png(3, 3))),
        )
        .unwrap();
        let b = put(
            dir.path(),
            keyed("blender//room/top", Payload::Bytes(png(4, 4))),
        )
        .unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.key, "blender/room/top");
    }

    #[test]
    fn different_views_of_one_source_are_different_files() {
        let dir = TempDir::new().unwrap();
        let a = put(
            dir.path(),
            keyed("blender/room/front", Payload::Bytes(png(3, 3))),
        )
        .unwrap();
        let b = put(
            dir.path(),
            keyed("blender/room/top", Payload::Bytes(png(4, 4))),
        )
        .unwrap();
        assert_ne!(a.path, b.path);
        assert_ne!(a.id, b.id);
        assert_eq!(list(dir.path()).len(), 2);
        assert!(a.rel_path.ends_with("blender-room-front.png"));
        assert!(b.rel_path.ends_with("blender-room-top.png"));
    }

    #[test]
    fn identical_bytes_under_two_keys_are_stored_once() {
        let dir = TempDir::new().unwrap();
        let a = put(
            dir.path(),
            keyed("blender/room/top", Payload::Bytes(png(8, 8))),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        let b = put(
            dir.path(),
            keyed("play/hospital/shot", Payload::Bytes(png(8, 8))),
        )
        .unwrap();
        assert_eq!(a.id, b.id, "the second send resolves to the stored copy");
        assert_eq!(a.path, b.path);
        assert_eq!(list(dir.path()).len(), 1);
        assert_eq!(files_in(dir.path()).len(), 2, "one file and its sidecar");
        assert!(b.updated_at > a.updated_at);
    }

    #[test]
    fn a_paste_is_keyed_by_its_content_hash() {
        let dir = TempDir::new().unwrap();
        let a = put(dir.path(), req(Payload::Text("same log".into()))).unwrap();
        let b = put(dir.path(), req(Payload::Text("same log".into()))).unwrap();
        let c = put(dir.path(), req(Payload::Text("other log".into()))).unwrap();
        assert_eq!(a.id, b.id);
        assert_ne!(a.id, c.id);
        assert!(a.key.starts_with("paste/"), "{}", a.key);
        assert_eq!(list(dir.path()).len(), 2);
    }

    #[test]
    fn a_file_is_keyed_by_its_path_so_sending_it_again_replaces_the_copy() {
        let env = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let shot = elsewhere.path().join("shot.png");
        std::fs::write(&shot, png(4, 4)).unwrap();
        let a = put(env.path(), req(Payload::Path(shot.clone()))).unwrap();
        std::fs::write(&shot, png(6, 6)).unwrap();
        let b = put(env.path(), req(Payload::Path(shot))).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(std::fs::read(&b.path).unwrap(), png(6, 6));
        assert_eq!(list(env.path()).len(), 1);
    }

    #[test]
    fn a_key_whose_extension_changes_leaves_no_stale_file() {
        let dir = TempDir::new().unwrap();
        let first = put(dir.path(), keyed("x/y", Payload::Text("t".into()))).unwrap();
        let second = put(dir.path(), keyed("x/y", Payload::Bytes(png(2, 2)))).unwrap();
        assert!(!Path::new(&first.path).exists());
        assert!(Path::new(&second.path).exists());
        assert_eq!(files_in(dir.path()).len(), 2);
    }

    #[test]
    fn a_long_key_gets_a_short_name_and_stays_unique() {
        let dir = TempDir::new().unwrap();
        let long = format!("file/{}/deep/report.md", "very-long-folder-name/".repeat(8));
        let other = format!(
            "file/{}/deep/report.md",
            "another-long-folder-name/".repeat(8)
        );
        let a = put(dir.path(), keyed(&long, Payload::Text("a".into()))).unwrap();
        let b = put(dir.path(), keyed(&other, Payload::Text("b".into()))).unwrap();
        let name = |i: &ContextItem| {
            Path::new(&i.path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert!(name(&a).len() < 60, "{}", name(&a));
        assert_ne!(name(&a), name(&b));
    }

    #[test]
    fn a_write_leaves_no_temp_file_and_a_failed_one_cleans_up() {
        let dir = TempDir::new().unwrap();
        put(dir.path(), keyed("a/b", Payload::Text("one".into()))).unwrap();
        put(dir.path(), keyed("a/b", Payload::Text("two".into()))).unwrap();
        assert!(files_in(dir.path())
            .iter()
            .all(|n| !n.starts_with(TMP_PREFIX)));

        let target = store_dir(dir.path()).join("never.bin");
        let denied = |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(write_atomic(&target, b"x", &denied).is_err());
        assert!(!target.exists());
        assert!(files_in(dir.path())
            .iter()
            .all(|n| !n.starts_with(TMP_PREFIX)));
    }

    #[test]
    fn a_target_a_reader_holds_falls_back_to_a_new_name_and_says_so() {
        let dir = TempDir::new().unwrap();
        let key = "blender/room/top";
        let first = put(dir.path(), keyed(key, Payload::Bytes(png(3, 3)))).unwrap();
        let held = PathBuf::from(&first.path);
        let locked = |from: &Path, to: &Path| {
            if to == held {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                std::fs::rename(from, to)
            }
        };
        let second = put_with(dir.path(), keyed(key, Payload::Bytes(png(9, 9))), &locked).unwrap();
        assert_ne!(second.path, first.path);
        assert!(second.notice.as_deref().unwrap().contains("was in use"));
        assert_eq!(
            std::fs::read(&first.path).unwrap(),
            png(3, 3),
            "the held file is untouched"
        );
        assert!(files_in(dir.path())
            .iter()
            .all(|n| !n.starts_with(TMP_PREFIX)));

        // Once the reader lets go, the next send takes the usual name back and
        // drops the stand-in.
        let third = put(dir.path(), keyed(key, Payload::Bytes(png(11, 11)))).unwrap();
        assert_eq!(third.path, first.path);
        assert!(third.notice.is_none());
        assert!(!Path::new(&second.path).exists());
        assert_eq!(list(dir.path()).len(), 1);
    }

    #[test]
    fn the_cap_evicts_the_oldest_first_by_size_as_well_as_count() {
        let dir = TempDir::new().unwrap();
        let mut ids = Vec::new();
        for n in 0..4u32 {
            let mut bytes = png(10 + n, 10);
            bytes.resize(1000, 0);
            ids.push(
                put(dir.path(), keyed(&format!("k/{n}"), Payload::Bytes(bytes)))
                    .unwrap()
                    .id,
            );
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        prune_to(dir.path(), usize::MAX, 2500);
        let kept: Vec<_> = list(dir.path()).into_iter().map(|i| i.id).collect();
        assert_eq!(kept, vec![ids[3].clone(), ids[2].clone()]);
    }

    #[test]
    fn a_resend_protects_an_old_item_from_eviction() {
        let dir = TempDir::new().unwrap();
        let old = put(dir.path(), keyed("k/old", Payload::Text("old".into()))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        put(dir.path(), keyed("k/mid", Payload::Text("mid".into()))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        put(
            dir.path(),
            keyed("k/old", Payload::Text("old, updated".into())),
        )
        .unwrap();
        prune_to(dir.path(), 1, u64::MAX);
        let kept: Vec<_> = list(dir.path()).into_iter().map(|i| i.id).collect();
        assert_eq!(kept, vec![old.id]);
    }

    #[test]
    fn old_timestamped_records_still_load_and_are_the_first_to_go() {
        let dir = TempDir::new().unwrap();
        let store = ensure_dir(dir.path()).unwrap();
        let legacy = store.join("20260930-135016-main-f3c3.png");
        std::fs::write(&legacy, png(2, 2)).unwrap();
        let record = serde_json::json!({
            "id": "ctx_0199a1b2c3d4e5f6a7", "v": 1, "kind": "image", "mime": "image/png",
            "title": "main", "source": { "appId": "godot-viewer" }, "method": "put",
            "createdAt": 1, "size": 2, "path": legacy.to_string_lossy(),
            "relPath": ".veistra/context/x.png", "owned": true
        });
        std::fs::write(
            store.join("ctx_0199a1b2c3d4e5f6a7.json"),
            record.to_string(),
        )
        .unwrap();
        assert_eq!(
            list(dir.path()).len(),
            1,
            "an old record without a key still loads"
        );
        put(dir.path(), keyed("k/new", Payload::Text("n".into()))).unwrap();
        prune_to(dir.path(), 1, u64::MAX);
        assert!(!legacy.exists());
        assert_eq!(list(dir.path()).len(), 1);
    }

    #[test]
    fn the_host_put_takes_a_key() {
        let dir = TempDir::new().unwrap();
        let b64 = BASE64.encode(png(3, 3));
        for _ in 0..3 {
            call(
                Some(dir.path()),
                "godot-viewer",
                "context/put",
                Some(serde_json::json!({ "key": "godot/main/frame", "kind": "image", "bytesBase64": b64 })),
            )
            .unwrap();
        }
        assert_eq!(list(dir.path()).len(), 1);
    }
}
