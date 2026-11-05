//! Turning a reference into something to show a person and something an agent
//! can read: the same [`Resolved`] serves both, as parts (text, image, JSON, a
//! note) plus the metadata a chip needs.
//!
//! Everything here is bounded. An excerpt stops at [`MAX_EXCERPT_LINES`] or
//! [`MAX_EXCERPT_BYTES`], and so does any prose an app holds, such as a
//! comment's text. A file is never scanned past [`MAX_SCAN_BYTES`]. An image
//! over [`MAX_IMAGE_BYTES`], or a JSON part over [`MAX_JSON_BYTES`] once
//! written out, is described rather than sent.

use super::assets::{self, Kind};
use super::fault::{Fault, Reason};
use super::policy;
use super::uri::{Lines, Ref};
use crate::context::ContextItem;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

/// Most lines one excerpt carries.
pub const MAX_EXCERPT_LINES: u32 = 1000;
/// Most bytes one excerpt carries.
pub const MAX_EXCERPT_BYTES: usize = 64 * 1024;
/// A file is read no further than this looking for a line range.
pub const MAX_SCAN_BYTES: u64 = 16 * 1024 * 1024;
/// Largest image sent inline. Base64 makes it about 4.7 MB, under the 5 MB a
/// model provider accepts per image.
pub const MAX_IMAGE_BYTES: u64 = 3_500_000;
/// Largest JSON part sent, written out.
pub const MAX_JSON_BYTES: usize = 64 * 1024;
/// How much of a model file is read for its header facts.
const MAX_MODEL_HEAD: u64 = 4 * 1024 * 1024;
/// How much of any file is read to decide what it is.
const HEAD_BYTES: u64 = 64 * 1024;
/// Most entries a folder reference lists.
const MAX_FOLDER_ENTRIES: usize = 200;
/// Most entries a folder reference looks at. Past this its counts are partial.
const MAX_FOLDER_SCAN: usize = 5_000;
/// Largest viewer comment record read. A real one is a few hundred bytes.
const MAX_COMMENT_BYTES: u64 = 1024 * 1024;

/// A reference, resolved.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// The canonical form of the reference that was resolved.
    pub uri: String,
    /// `text`, `image`, `model`, `scene`, `audio`, `video`, `binary`, `folder`,
    /// `canvas`, `frame`, `comment`, `design-comment`, `context` or `selection`.
    pub kind: String,
    /// A short label: a file name, a frame name, a comment's first line.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub meta: Map<String, Value>,
    pub parts: Vec<Part>,
    /// Why nothing (or less) was read. Set for secrets, gitignored files and
    /// anything over a cap; `parts` then carries no content from the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub withheld: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Part {
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        language: Option<String>,
        /// The file line `text` starts at, 1-based.
        start_line: u32,
        truncated: bool,
    },
    /// Always sized, so the tab can hold its place before it decodes.
    #[serde(rename_all = "camelCase")]
    Image {
        mime: String,
        data_base64: String,
        width: u32,
        height: u32,
    },
    Json {
        #[cfg_attr(test, ts(type = "unknown"))]
        value: Value,
    },
    Note {
        text: String,
    },
}

impl Resolved {
    /// A result with no parts yet.
    pub(super) fn empty(r: &Ref, kind: &str, title: impl Into<String>) -> Self {
        Self {
            uri: r.to_string(),
            kind: kind.into(),
            title: title.into(),
            detail: None,
            meta: Map::new(),
            parts: Vec::new(),
            withheld: None,
        }
    }

    pub(super) fn withhold(mut self, why: impl Into<String>) -> Self {
        self.parts.clear();
        self.withheld = Some(why.into());
        self
    }
}

/// Resolve a file or folder reference inside `root`.
pub fn file(root: &Path, r: &Ref) -> Result<Resolved, Fault> {
    let Ref::File { path, lines } = r else {
        return Err(Fault::new(Reason::BadUri, "not a file reference"));
    };
    let found = policy::contain(root, path)?;
    let name = path.rsplit('/').next().unwrap_or(path);
    let mut out = Resolved::empty(r, "binary", name);
    out.detail = Some(detail_for(path, *lines));
    if let Some(rule) = secret_name(path, &found) {
        return Ok(out.withhold(secret_withheld(rule)));
    }
    if policy::ignored(&found.root, &found.abs) {
        return Ok(out.withhold(
            "withheld: this file is gitignored, so Veistra names it but does not read it",
        ));
    }
    if found.abs.is_dir() {
        return Ok(folder(out, &found.root, &found.abs)?);
    }
    describe(out, &found.abs, *lines)
}

pub(super) fn secret_withheld(rule: &str) -> String {
    format!("withheld: {rule} are never read or shown through a reference")
}

/// Which secrets rule a file falls under: by the name it was asked for, the
/// name it has once links are followed, or what its first bytes hold.
pub(super) fn secret_file(asked: &str, found: &policy::Contained) -> Option<&'static str> {
    secret_name(asked, found).or_else(|| secret_head(&found.abs))
}

/// [`secret_file`] by name alone. A link inside the project that lands on a
/// secret is still a secret.
fn secret_name(asked: &str, found: &policy::Contained) -> Option<&'static str> {
    policy::secret_rule(asked).or_else(|| policy::secret_rule(&found.rel))
}

/// Which secrets rule a file's first bytes fall under. A folder, or a file
/// that cannot be opened, has none: reading it fails on its own.
pub(super) fn secret_head(abs: &Path) -> Option<&'static str> {
    if abs.is_dir() {
        return None;
    }
    let head = read_prefix(abs, HEAD_BYTES).ok()?;
    policy::secret_content(&head)
}

/// Whether a context item stands for a project file rather than a copy that
/// Veistra keeps in its store.
fn stands_for_file(item: &ContextItem) -> bool {
    !item.owned && !item.rel_path.is_empty()
}

/// Which secrets rule a copy in the store falls under by name. The file it was
/// copied from and the copy's own name say what it is. The title is free text,
/// and counts only when it is spelt as a file name.
fn copy_secret(item: &ContextItem) -> Option<&'static str> {
    let names = [item.key.strip_prefix("file/"), Some(item.rel_path.as_str())];
    let rule = names.into_iter().flatten().find_map(policy::secret_rule);
    rule.or_else(|| policy::title_rule(&item.title))
}

/// Which secrets rule a context item falls under by name. One that stands for
/// a project file goes by that file's names, as resolving it does.
pub(super) fn item_secret_name(root: &Path, item: &ContextItem) -> Option<&'static str> {
    if !stands_for_file(item) {
        return copy_secret(item);
    }
    let found = policy::contain(root, &item.rel_path).ok();
    policy::secret_rule(&item.rel_path).or_else(|| found.and_then(|f| policy::secret_rule(&f.rel)))
}

/// Which secrets rule a context item falls under, by name or by what the file
/// it reads holds.
pub(super) fn item_secret(root: &Path, item: &ContextItem) -> Option<&'static str> {
    item_secret_name(root, item).or_else(|| {
        let found = policy::contain(root, &item.rel_path).ok()?;
        secret_head(&found.abs)
    })
}

fn detail_for(path: &str, lines: Option<Lines>) -> String {
    match lines {
        Some(Lines {
            start,
            end: Some(end),
        }) => format!("{path} · lines {start}–{end}"),
        Some(Lines { start, end: None }) => format!("{path} · line {start}"),
        None => path.to_string(),
    }
}

/// Fill in a file's kind, metadata and parts. Shared by file references and by
/// context items Veistra stored itself, which skip the gitignore screen.
pub(super) fn describe(
    mut out: Resolved,
    abs: &Path,
    lines: Option<Lines>,
) -> Result<Resolved, Fault> {
    let meta = std::fs::metadata(abs).map_err(|e| format!("cannot read that file: {e}"))?;
    let size = meta.len();
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let head = read_prefix(abs, HEAD_BYTES)?;
    let mut class = assets::classify(&name);
    let textual = assets::looks_textual(&head);
    if class.kind == Kind::Binary && textual {
        class = assets::classify("plain.txt");
    }
    out.kind = class.kind.name().into();
    out.meta.insert("size".into(), json!(size));
    out.meta.insert("mime".into(), json!(class.mime));
    if let Some(ms) = modified_ms(&meta) {
        out.meta.insert("modified".into(), json!(ms));
    }
    if let Some(rule) = policy::secret_content(&head) {
        return Ok(out.withhold(secret_withheld(rule)));
    }

    if class.kind == Kind::Image {
        out = image(out, abs, size, &head, &class)?;
        // An SVG is also text, but one withheld as too big stays withheld.
        if !class.textual || out.withheld.is_some() {
            return Ok(out);
        }
    }
    match class.kind {
        Kind::Model => {
            let bytes = read_prefix(abs, MAX_MODEL_HEAD)?;
            out.meta.extend(assets::model_facts(&ext, &bytes));
        }
        Kind::Audio if ext == "wav" => out.meta.extend(assets::wav_facts(&head, size)),
        _ => {}
    }
    if class.textual && textual {
        let ex = excerpt(abs, lines)?;
        // A line range reaches past the head checked above. A key opened
        // anywhere before its last line withholds it, as one in the head
        // withholds the file: a range can start on the key's body.
        if ex.past_key {
            return Ok(out.withhold(secret_withheld(policy::KEYS)));
        }
        if let Some(total) = ex.total_lines {
            out.meta.insert("lines".into(), json!(total));
        }
        out.parts.push(Part::Text {
            text: ex.text,
            language: class.language.map(str::to_owned),
            start_line: ex.start,
            truncated: ex.truncated,
        });
    } else if out.parts.is_empty() {
        out.parts.push(Part::Note {
            text: format!("{} file, {}; no preview", out.kind, human_size(size)),
        });
    }
    Ok(out)
}

/// An image part when the bytes are a raster format a model accepts and the
/// file is under the cap; anything else is a note. An SVG under the cap gets no
/// part here: it is text, which [`describe`] sends once as an excerpt, and no
/// model provider takes one as an image.
fn image(
    mut out: Resolved,
    abs: &Path,
    size: u64,
    head: &[u8],
    class: &assets::Class,
) -> Result<Resolved, String> {
    let sniffed = crate::context::sniff(head);
    let svg = class.mime == "image/svg+xml";
    let dims = match &sniffed {
        Some(s) => s.dims,
        None if svg => assets::svg_size(head),
        None => None,
    };
    if let Some((w, h)) = dims {
        out.meta.insert("width".into(), json!(w));
        out.meta.insert("height".into(), json!(h));
    }
    if sniffed.is_none() && !svg {
        out.parts.push(Part::Note {
            text: format!("image, {}; this format has no preview", human_size(size)),
        });
        return Ok(out);
    }
    if size > MAX_IMAGE_BYTES {
        return Ok(out.withhold(format!(
            "withheld: the image is {}, over the {} that is sent inline",
            human_size(size),
            human_size(MAX_IMAGE_BYTES)
        )));
    }
    let Some(mime) = sniffed.as_ref().map(|s| s.mime) else {
        return Ok(out);
    };
    let bytes = read_prefix(abs, MAX_IMAGE_BYTES)?;
    out.parts.push(image_part(mime, &bytes));
    Ok(out)
}

/// The size a picture takes when its header does not say: the CSS default for
/// a replaced element.
const UNSIZED: (u32, u32) = (300, 150);

/// An image part, sized from the picture's header. Only rasters are sent as
/// pictures; an SVG's own size goes in its `meta`.
pub(super) fn image_part(mime: &str, bytes: &[u8]) -> Part {
    let (width, height) = crate::context::sniff(bytes)
        .and_then(|s| s.dims)
        .unwrap_or(UNSIZED);
    Part::Image {
        mime: mime.into(),
        data_base64: BASE64.encode(bytes),
        width,
        height,
    }
}

/// A folder's entries, folders first, secrets and gitignored entries left out.
fn folder(out: Resolved, root: &Path, abs: &Path) -> Result<Resolved, String> {
    folder_within(out, root, abs, MAX_FOLDER_SCAN)
}

/// [`folder`], looking at no more than `scan` entries.
fn folder_within(
    mut out: Resolved,
    root: &Path,
    abs: &Path,
    scan: usize,
) -> Result<Resolved, String> {
    out.kind = "folder".into();
    let reader = std::fs::read_dir(abs).map_err(|e| format!("cannot list that folder: {e}"))?;
    let mut entries: Vec<(bool, String)> = Vec::new();
    let mut hidden = 0usize;
    let mut partial = false;
    let rules = policy::Ignores::for_folder(root, abs);
    for (seen, entry) in reader.flatten().enumerate() {
        if seen == scan {
            partial = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        // The entry's own type costs no stat; only a link is followed to see.
        let is_dir = match entry.file_type() {
            Ok(t) if !t.is_symlink() => t.is_dir(),
            _ => path.is_dir(),
        };
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if policy::secret_rule(&rel).is_some() || rules.ignored(&path, is_dir) {
            hidden += 1;
            continue;
        }
        entries.push((is_dir, name));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = entries.len();
    let names: Vec<String> = entries
        .into_iter()
        .take(MAX_FOLDER_ENTRIES)
        .map(|(dir, name)| if dir { format!("{name}/") } else { name })
        .collect();
    out.meta.insert("entries".into(), json!(total));
    if hidden > 0 {
        out.meta.insert("hidden".into(), json!(hidden));
    }
    out.parts.push(Part::Text {
        text: names.join("\n"),
        language: None,
        start_line: 1,
        truncated: partial || total > MAX_FOLDER_ENTRIES,
    });
    if partial {
        out.meta.insert("partial".into(), json!(true));
        out.parts.push(Part::Note {
            text: format!(
                "Only the first {scan} entries were looked at, so the counts are partial."
            ),
        });
    }
    Ok(out)
}

struct Excerpt {
    text: String,
    start: u32,
    truncated: bool,
    /// Known only when the whole file was read.
    total_lines: Option<u32>,
    /// Whether a line read, skipped or kept, opens a private key.
    past_key: bool,
}

/// Lines `lines` of a text file (or its start), within the caps.
fn excerpt(abs: &Path, lines: Option<Lines>) -> Result<Excerpt, Fault> {
    excerpt_within(abs, lines, MAX_SCAN_BYTES)
}

/// [`excerpt`], reading at most `scan` bytes of the file.
fn excerpt_within(abs: &Path, lines: Option<Lines>, scan: u64) -> Result<Excerpt, Fault> {
    let file = open(abs)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = BufReader::new(file).take(scan);
    let start = lines.map_or(1, |l| l.start);
    let last = lines.map(Lines::last);
    let (mut text, mut buf) = (String::new(), Vec::new());
    let (mut line_no, mut taken) = (0u32, 0u32);
    let (mut truncated, mut eof, mut past_key) = (false, false, false);
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("cannot read that file: {e}"))?;
        if n == 0 {
            eof = true;
            break;
        }
        line_no += 1;
        if last.is_some_and(|last| line_no > last) {
            break;
        }
        let line = String::from_utf8_lossy(&buf);
        past_key = past_key || policy::key_line(&line);
        if line_no < start {
            continue;
        }
        if taken >= MAX_EXCERPT_LINES || text.len() + line.len() > MAX_EXCERPT_BYTES {
            if text.is_empty() {
                text.push_str(cut(&line, MAX_EXCERPT_BYTES));
            }
            truncated = true;
            break;
        }
        text.push_str(&line);
        taken += 1;
    }
    // The scan limit looks like the end of the file to the reader, so it is
    // told apart here: a file longer than the limit was cut, not finished.
    let capped = eof && reader.limit() == 0 && size > scan;
    if lines.is_some() && line_no < start && eof {
        return Err(if capped {
            let why = format!(
                "line {start} is past the first {} of the file, which is as far as a reference reads",
                human_size(scan)
            );
            Fault::new(Reason::Unreadable, why)
        } else {
            let why = format!("the file has {line_no} lines, so line {start} does not exist");
            Fault::new(Reason::Missing, why)
        });
    }
    let complete = eof && !capped;
    if capped || (!complete && last.is_none()) {
        truncated = true;
    }
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    Ok(Excerpt {
        text,
        start,
        truncated,
        total_lines: complete.then_some(line_no),
        past_key,
    })
}

/// The longest prefix of `s` within `max` bytes that ends on a character boundary.
fn cut(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A regular file, opened to read. Anything else is refused before opening:
/// opening a named pipe waits for a writer that may never come.
fn open(abs: &Path) -> Result<std::fs::File, String> {
    let meta = std::fs::metadata(abs).map_err(|e| format!("cannot open that file: {e}"))?;
    if !meta.is_file() {
        return Err("that is not a regular file, so it is not read".into());
    }
    std::fs::File::open(abs).map_err(|e| format!("cannot open that file: {e}"))
}

fn read_prefix(abs: &Path, max: u64) -> Result<Vec<u8>, String> {
    let file = open(abs)?;
    let mut bytes = Vec::new();
    file.take(max)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read that file: {e}"))?;
    Ok(bytes)
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    let since = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// `512 B`, `12.3 KB`, `4.6 MB`.
pub fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let kb = bytes as f64 / KB;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if (kb * 10.0).round() < KB * 10.0 {
        format!("{kb:.1} KB")
    } else {
        // Chosen after rounding, so 1,048,575 bytes reads 1.0 MB, not 1024.0 KB.
        format!("{:.1} MB", kb / KB)
    }
}

/// The first line of some prose, cut to 80 characters, for a title.
pub fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut out: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        out.push('…');
    }
    out
}

/// Prose an app holds, such as a comment's text, as a text part. It is cut at
/// [`MAX_EXCERPT_BYTES`], on a character boundary, as a file excerpt is.
pub fn prose_part(text: &str, language: Option<&str>) -> Part {
    let mut end = text.len().min(MAX_EXCERPT_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Part::Text {
        text: text[..end].to_string(),
        language: language.map(str::to_owned),
        start_line: 1,
        truncated: end < text.len(),
    }
}

/// `value` as a JSON part, or a note giving its size when it is over
/// [`MAX_JSON_BYTES`] written out.
pub fn json_part(value: Value) -> Part {
    let size = serde_json::to_vec(&value).map_or(0, |b| b.len());
    if size > MAX_JSON_BYTES {
        return Part::Note {
            text: format!(
                "The structured detail is {}, over the {} cap, so it is not sent.",
                human_size(size as u64),
                human_size(MAX_JSON_BYTES as u64)
            ),
        };
    }
    Part::Json { value }
}

/// A PNG (or other sniffed raster) on disk as an image part, under the inline cap.
pub fn png_part(path: &Path) -> Result<Part, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("cannot read the picture: {e}"))?
        .len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "the picture is {}, over the {} sent inline",
            human_size(size),
            human_size(MAX_IMAGE_BYTES)
        ));
    }
    let bytes = read_prefix(path, MAX_IMAGE_BYTES)?;
    let sniffed = crate::context::sniff(&bytes).ok_or("the picture is not an image")?;
    Ok(image_part(sniffed.mime, &bytes))
}

/// An item in the context store. One Veistra stored itself is read where it
/// lies; one that references a project file goes through every file rule.
pub fn context_item(root: &Path, r: &Ref) -> Result<Resolved, Fault> {
    let Ref::Context { id } = r else {
        return Err(Fault::new(Reason::BadUri, "not a context reference"));
    };
    let item = stored_item(root, id)?;
    // What the app that sent the item asked of the agent leads it: the chip is
    // all the person sees, so this is the one place the instruction can live.
    let asked = |mut out: Resolved| {
        if let Some(prompt) = &item.prompt {
            out.parts.insert(
                0,
                Part::Note {
                    text: prompt.clone(),
                },
            );
        }
        out
    };
    if stands_for_file(&item) {
        let inner = Ref::File {
            path: item.rel_path.clone(),
            lines: None,
        };
        let mut out = file(root, &inner)?;
        out.uri = r.to_string();
        out.title = item.title.clone();
        out.meta.insert("file".into(), json!(inner.to_string()));
        return Ok(asked(out));
    }
    let out = Resolved::empty(r, "context", item.title.clone());
    if item.missing {
        return Ok(out.withhold("the stored file has been deleted or moved"));
    }
    if let Some(rule) = copy_secret(&item) {
        return Ok(out.withhold(secret_withheld(rule)));
    }
    // A hand-edited sidecar could point anywhere: only a file that really is
    // inside this project's store is read.
    let found = policy::contain(root, &item.rel_path)
        .ok()
        .filter(|f| policy::inside_store(&f.rel))
        .ok_or_else(|| {
            Fault::new(
                Reason::Outside,
                "that context item's file is not in this project's context store",
            )
        })?;
    let mut out = describe(out, &found.abs, None)?;
    out.detail = item
        .source
        .label
        .clone()
        .or(Some(item.source.app_id.clone()));
    out.meta.insert("context".into(), json!(item.id));
    Ok(asked(out))
}

/// A viewer comment, `.veistra/comments/<id>.json`, and its screenshot.
pub fn viewer_comment(root: &Path, r: &Ref) -> Result<Resolved, Fault> {
    let Ref::Comment { id } = r else {
        return Err(Fault::new(Reason::BadUri, "not a comment reference"));
    };
    let comment = viewer_record(root, id)?;
    let mut out = Resolved::empty(r, "comment", first_line(&comment.body));
    out.detail = Some(anchor_line(&comment.anchor));
    out.meta.insert("status".into(), json!(comment.status));
    out.meta.insert("author".into(), json!(comment.author));
    out.parts.push(prose_part(&comment.body, Some("markdown")));
    out.parts.push(json_part(
        serde_json::to_value(&comment).unwrap_or(Value::Null),
    ));
    if let Ok(shot) = policy::contain(root, &format!(".veistra/comments/{id}.png")) {
        out.parts
            .push(png_part(&shot.abs).unwrap_or_else(|why| Part::Note {
                text: format!("No screenshot: {why}"),
            }));
    }
    Ok(out)
}

/// A viewer comment's record, read from inside the project and under the cap.
pub(super) fn viewer_record(root: &Path, id: &str) -> Result<crate::comments::Comment, Fault> {
    let record = viewer_record_at(root, id)?;
    let raw = read_prefix(&record.abs, MAX_COMMENT_BYTES + 1)?;
    if raw.len() as u64 > MAX_COMMENT_BYTES {
        return Err(Fault::from(format!(
            "comment `{id}` is over {}, which is more than a comment holds",
            human_size(MAX_COMMENT_BYTES)
        )));
    }
    serde_json::from_slice(&raw)
        .map_err(|e| Fault::from(format!("comment `{id}` is unreadable: {e}")))
}

/// Where a viewer comment's record is, unread: inside the project, or why not.
pub(super) fn viewer_record_at(root: &Path, id: &str) -> Result<policy::Contained, Fault> {
    policy::contain(root, &format!(".veistra/comments/{id}.json")).map_err(|f| {
        let missing = format!("there is no comment `{id}` in this project");
        match f.reason {
            Reason::Missing => Fault::new(Reason::Missing, missing),
            _ => f,
        }
    })
}

/// A context item's record. The store refuses an unknown id and a sidecar it
/// could not open alike, as invalid params, so whether the sidecar is there
/// tells the two apart.
pub(super) fn stored_item(root: &Path, id: &str) -> Result<ContextItem, Fault> {
    crate::context::get(root, id).map_err(|e| {
        let sidecar = format!(".veistra/context/{id}.json");
        match e.code {
            veistra_rpc::INVALID_PARAMS if policy::contain(root, &sidecar).is_err() => {
                Fault::new(Reason::Missing, e.message)
            }
            _ => Fault::from(e.message),
        }
    })
}

fn anchor_line(anchor: &crate::comments::Anchor) -> String {
    use crate::comments::Anchor;
    match anchor {
        Anchor::Node { path, .. } => format!("Godot node {path}"),
        Anchor::Mesh { part, material, .. } => format!("Blender mesh {part} · {material}"),
        Anchor::Scene { scene, time, .. } => format!("Play · {scene} at {time:.1}s"),
        Anchor::Take {
            take, n, node_path, ..
        } => match node_path {
            Some(node) => format!("Play · take {take}, note {n} on {node}"),
            None => format!("Play · take {take}, note {n}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::uri::parse;
    use tempfile::TempDir;

    fn project() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    fn put(dir: &TempDir, rel: &str, bytes: &[u8]) {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn resolve(dir: &TempDir, uri: &str) -> Result<Resolved, Fault> {
        let r = parse(uri)?;
        match r {
            Ref::Context { .. } => context_item(dir.path(), &r),
            Ref::Comment { .. } => viewer_comment(dir.path(), &r),
            _ => file(dir.path(), &r),
        }
    }

    fn text_of(r: &Resolved) -> (&str, u32, bool) {
        match r.parts.first() {
            Some(Part::Text {
                text,
                start_line,
                truncated,
                ..
            }) => (text.as_str(), *start_line, *truncated),
            other => panic!("expected a text part, got {other:?}"),
        }
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn a_line_range_comes_back_as_exactly_those_lines() {
        let dir = project();
        let body: String = (1..=50).map(|n| format!("line {n}\n")).collect();
        put(&dir, "scripts/player.gd", body.as_bytes());
        let r = resolve(&dir, "veistra://file/scripts/player.gd#L10-L12").unwrap();
        assert_eq!(r.kind, "text");
        assert_eq!(r.title, "player.gd");
        assert_eq!(text_of(&r), ("line 10\nline 11\nline 12", 10, false));
        assert_eq!(r.detail.as_deref(), Some("scripts/player.gd · lines 10–12"));
        let whole = resolve(&dir, "veistra://file/scripts/player.gd").unwrap();
        assert_eq!(whole.meta["lines"], 50);
        assert!(resolve(&dir, "veistra://file/scripts/player.gd#L51")
            .unwrap_err()
            .message
            .contains("50 lines"));
    }

    #[test]
    fn an_empty_file_is_an_empty_excerpt_not_an_error() {
        let dir = project();
        put(&dir, "empty.txt", b"");
        let r = resolve(&dir, "veistra://file/empty.txt").unwrap();
        assert_eq!(text_of(&r), ("", 1, false));
    }

    #[test]
    fn excerpts_stop_at_the_line_and_byte_caps() {
        let dir = project();
        let many: String = (0..MAX_EXCERPT_LINES + 50)
            .map(|n| format!("{n}\n"))
            .collect();
        put(&dir, "many.txt", many.as_bytes());
        let r = resolve(&dir, "veistra://file/many.txt").unwrap();
        let (text, _, truncated) = text_of(&r);
        assert!(truncated);
        assert_eq!(text.lines().count(), MAX_EXCERPT_LINES as usize);

        let wide = "é".repeat(MAX_EXCERPT_BYTES);
        put(&dir, "wide.txt", wide.as_bytes());
        let r = resolve(&dir, "veistra://file/wide.txt").unwrap();
        let (text, _, truncated) = text_of(&r);
        assert!(truncated);
        assert!(text.len() <= MAX_EXCERPT_BYTES && !text.is_empty());
    }

    /// The scan limit is not the end of the file: a range it cuts is flagged,
    /// and a line beyond it is not reported as missing.
    #[test]
    fn the_scan_limit_cuts_a_range_rather_than_ending_the_file() {
        let dir = project();
        let body: String = (1..=100).map(|n| format!("{n:03}\n")).collect();
        put(&dir, "big.csv", body.as_bytes());
        let abs = dir.path().join("big.csv");
        let range = |start, end| {
            Some(Lines {
                start,
                end: Some(end),
            })
        };

        let cut = excerpt_within(&abs, range(5, 30), 80).unwrap();
        assert!(cut.truncated, "lines 21-30 lie past the limit");
        assert_eq!(cut.total_lines, None);
        let err = excerpt_within(&abs, range(50, 50), 80).err().unwrap();
        assert!(err.message.contains("past the first"), "{err}");
        assert_eq!(err.reason, Reason::Unreadable);
        let past = excerpt_within(&abs, range(101, 101), 4096).err().unwrap();
        assert!(past.message.contains("has 100 lines"), "{past}");
        assert_eq!(past.reason, Reason::Missing);
        let whole = excerpt_within(&abs, None, body.len() as u64).unwrap();
        assert!(!whole.truncated);
        assert_eq!(whole.total_lines, Some(100));
    }

    #[test]
    fn secrets_are_withheld_and_say_which_rule() {
        let dir = project();
        put(&dir, ".env", b"API_KEY=hunter2\n");
        put(&dir, "config/.env.example", b"API_KEY=\n");
        put(&dir, "android/release.keystore", b"\x00\x01");
        let env = resolve(&dir, "veistra://file/.env").unwrap();
        assert!(env.parts.is_empty());
        assert!(env.withheld.unwrap().contains(".env files"));
        let template = resolve(&dir, "veistra://file/config/.env.example").unwrap();
        assert!(template.withheld.is_none());
        let key = resolve(&dir, "veistra://file/android/release.keystore").unwrap();
        assert!(key.withheld.unwrap().contains("key stores"));
    }

    #[test]
    fn gitignored_files_are_named_but_not_read() {
        let dir = project();
        put(&dir, ".gitignore", b"build/\n*.log\n!keep.log\n");
        put(&dir, "build/out.txt", b"built\n");
        put(&dir, "debug.log", b"noise\n");
        put(&dir, "keep.log", b"kept\n");
        put(&dir, "nested/.gitignore", b"local.txt\n");
        put(&dir, "nested/local.txt", b"mine\n");
        for uri in [
            "veistra://file/build/out.txt",
            "veistra://file/debug.log",
            "veistra://file/nested/local.txt",
        ] {
            let r = resolve(&dir, uri).unwrap();
            assert!(r.withheld.unwrap().contains("gitignored"), "{uri}");
            assert!(r.parts.is_empty());
        }
        assert!(resolve(&dir, "veistra://file/keep.log")
            .unwrap()
            .withheld
            .is_none());
    }

    #[test]
    fn a_missing_file_is_an_error_that_names_it() {
        let dir = project();
        let err = resolve(&dir, "veistra://file/nope.gd").unwrap_err();
        assert_eq!(err.reason, Reason::Missing);
        assert!(err.message.contains("nope.gd"), "{err}");
    }

    #[test]
    fn a_link_out_of_the_project_or_onto_a_secret_is_not_followed() {
        use crate::refs::links;
        let outside = project();
        put(&outside, "private.txt", b"not yours\n");
        let dir = project();
        put(&dir, ".env", b"TOKEN=1\n");
        put(&dir, ".ssh/config", b"Host x\n");

        links::folder(outside.path(), &dir.path().join("linkdir"));
        let err = resolve(&dir, "veistra://file/linkdir/private.txt").unwrap_err();
        assert_eq!(err.reason, Reason::Outside, "through a folder: {err}");
        let err = resolve(&dir, "veistra://file/linkdir").unwrap_err();
        assert_eq!(err.reason, Reason::Outside, "the folder: {err}");
        links::folder(&dir.path().join(".ssh"), &dir.path().join("sshdir"));
        let r = resolve(&dir, "veistra://file/sshdir/config").unwrap();
        assert!(r.withheld.unwrap().contains(".ssh"), "named by its target");

        if !links::file(
            &outside.path().join("private.txt"),
            &dir.path().join("away.txt"),
        ) {
            return;
        }
        let err = resolve(&dir, "veistra://file/away.txt").unwrap_err();
        assert_eq!(err.reason, Reason::Outside);
        assert!(err.message.contains("outside the project"), "{err}");
        assert!(links::file(
            &dir.path().join(".env"),
            &dir.path().join("notes.txt")
        ));
        let r = resolve(&dir, "veistra://file/notes.txt").unwrap();
        assert!(r.withheld.unwrap().contains(".env"));
    }

    #[test]
    fn an_image_comes_back_inline_with_its_size_until_the_cap() {
        let dir = project();
        put(&dir, "art/hero.png", &png(64, 32));
        let r = resolve(&dir, "veistra://file/art/hero.png").unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.meta["width"], 64);
        match &r.parts[0] {
            Part::Image { mime, height, .. } => {
                assert_eq!(mime, "image/png");
                assert_eq!(*height, 32);
            }
            other => panic!("{other:?}"),
        }
        let mut big = png(4000, 4000);
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        put(&dir, "art/huge.png", &big);
        let huge = resolve(&dir, "veistra://file/art/huge.png").unwrap();
        assert!(huge.withheld.unwrap().contains("over the"));
        assert!(huge.parts.is_empty());
        assert_eq!(huge.meta["width"], 4000);
    }

    #[cfg(unix)]
    #[test]
    fn a_named_pipe_is_refused_without_waiting_for_a_writer() {
        let dir = project();
        let pipe = dir.path().join("pipe");
        let made = std::process::Command::new("mkfifo").arg(&pipe).status();
        if !made.is_ok_and(|s| s.success()) {
            return;
        }
        let err = resolve(&dir, "veistra://file/pipe").unwrap_err();
        assert!(
            err.message.contains("not a regular file"),
            "{}",
            err.message
        );
    }

    #[test]
    fn every_picture_is_sized_and_an_svg_says_its_own_size() {
        let dir = project();
        // A WebP that opens with none of the three chunks it is sized from.
        put(&dir, "art/odd.webp", b"RIFF\0\0\0\0WEBPXYZW\0\0\0\0");
        match &resolve(&dir, "veistra://file/art/odd.webp").unwrap().parts[0] {
            Part::Image { width, height, .. } => assert_eq!((*width, *height), UNSIZED),
            other => panic!("{other:?}"),
        }
        // An SVG is sent as its text, not as a picture, so its size is meta.
        let svg = |size: &str| format!("<svg xmlns=\"http://www.w3.org/2000/svg\" {size}></svg>");
        put(&dir, "art/box.svg", svg("viewBox=\"0 0 40 20\"").as_bytes());
        put(&dir, "art/bare.svg", svg("").as_bytes());
        let boxed = resolve(&dir, "veistra://file/art/box.svg").unwrap();
        assert_eq!(
            (&boxed.meta["width"], &boxed.meta["height"]),
            (&json!(40), &json!(20))
        );
        let bare = resolve(&dir, "veistra://file/art/bare.svg").unwrap();
        assert!(bare.meta.get("width").is_none(), "{:?}", bare.meta);
    }

    #[test]
    fn an_apps_prose_and_json_stop_at_their_caps() {
        let small = json!({ "status": "open" });
        assert_eq!(json_part(small.clone()), Part::Json { value: small });
        let big = json!({ "props": "x".repeat(MAX_JSON_BYTES) });
        assert!(
            matches!(json_part(big), Part::Note { text } if text.contains("over the 64.0 KB cap"))
        );

        let whole = prose_part("Move the door", Some("markdown"));
        assert!(matches!(
            whole,
            Part::Text {
                truncated: false,
                ..
            }
        ));
        let long = format!("{}\u{e9}", "a".repeat(MAX_EXCERPT_BYTES - 1));
        match prose_part(&long, None) {
            Part::Text {
                text, truncated, ..
            } => {
                assert_eq!(
                    text.len(),
                    MAX_EXCERPT_BYTES - 1,
                    "cut before the two-byte é"
                );
                assert!(truncated);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_size_reads_in_the_unit_its_rounded_value_fits() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(1_048_575), "1.0 MB");
        assert_eq!(human_size(3_500_000), "3.3 MB");
    }

    /// A screenshot a comment keeps: a viewer comment's and a Design Mode one's.
    #[test]
    fn a_comment_screenshot_says_why_it_is_not_sent() {
        let dir = project();
        put(&dir, "shots/ok.png", &png(8, 8));
        assert!(matches!(
            png_part(&dir.path().join("shots/ok.png")),
            Ok(Part::Image { .. })
        ));
        let mut big = png(4000, 4000);
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        put(&dir, "shots/big.png", &big);
        let err = png_part(&dir.path().join("shots/big.png")).unwrap_err();
        assert!(err.contains("over the 3.3 MB sent inline"), "{err}");
        put(&dir, "shots/torn.png", b"not a picture");
        let err = png_part(&dir.path().join("shots/torn.png")).unwrap_err();
        assert_eq!(err, "the picture is not an image");
    }

    #[test]
    fn an_svg_is_sent_once_as_its_text() {
        let dir = project();
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>\n";
        put(&dir, "art/dot.svg", svg.as_bytes());
        let r = resolve(&dir, "veistra://file/art/dot.svg").unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.meta["mime"], "image/svg+xml");
        match r.parts.as_slice() {
            [Part::Text { text, language, .. }] => {
                assert_eq!(text, svg.trim_end());
                assert_eq!(language.as_deref(), Some("xml"));
            }
            other => panic!("one text part, not {other:?}"),
        }
    }

    #[test]
    fn an_svg_over_the_cap_is_withheld_and_not_sent_as_text() {
        let dir = project();
        let mut svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\">".to_vec();
        svg.resize(MAX_IMAGE_BYTES as usize + 1, b' ');
        put(&dir, "art/huge.svg", &svg);
        let huge = resolve(&dir, "veistra://file/art/huge.svg").unwrap();
        assert!(huge.withheld.unwrap().contains("over the"));
        assert!(huge.parts.is_empty(), "{:?}", huge.parts);
    }

    #[test]
    fn an_svg_holding_a_key_past_the_first_bytes_is_screened_as_text_is() {
        let dir = project();
        let mut svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><desc>".to_vec();
        svg.resize(HEAD_BYTES as usize + 100, b' ');
        svg.extend_from_slice(b"\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n</desc></svg>\n");
        put(&dir, "art/logo.svg", &svg);
        // Sent as its text, so only the excerpt goes, and it stops short of
        // the key; a range that reaches the key is withheld.
        let logo = resolve(&dir, "veistra://file/art/logo.svg").unwrap();
        let (text, _, cut) = text_of(&logo);
        assert!(cut && !text.contains("PRIVATE KEY"), "{text:.80}");
        let ranged = resolve(&dir, "veistra://file/art/logo.svg#L2-L3").unwrap();
        assert!(ranged.parts.is_empty(), "{:?}", ranged.parts);
        assert!(ranged.withheld.unwrap().contains("private keys"));
    }

    #[test]
    fn a_model_reports_its_header_and_an_unknown_binary_a_note() {
        let dir = project();
        let json = br#"{"asset":{"version":"2.0"},"meshes":[{}],"animations":[{},{}]}  "#;
        let mut glb = b"glTF".to_vec();
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&((20 + json.len()) as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(b"JSON");
        glb.extend_from_slice(json);
        put(&dir, "models/hero.glb", &glb);
        let r = resolve(&dir, "veistra://file/models/hero.glb").unwrap();
        assert_eq!(r.kind, "model");
        assert_eq!(r.meta["meshes"], 1);
        assert_eq!(r.meta["animations"], 2);
        assert!(matches!(r.parts[0], Part::Note { .. }));
        put(&dir, "blob.dat", &[0u8, 1, 2, 3]);
        let blob = resolve(&dir, "veistra://file/blob.dat").unwrap();
        assert_eq!(blob.kind, "binary");
    }

    #[test]
    fn a_folder_lists_its_entries_but_not_its_secrets() {
        let dir = project();
        put(&dir, ".gitignore", b"*.tmp\n");
        put(&dir, "level/a.tscn", b"[gd_scene]\n");
        put(&dir, "level/props/b.glb", b"glTF");
        put(&dir, "level/.env", b"X=1\n");
        put(&dir, "level/scratch.tmp", b"tmp\n");
        let r = resolve(&dir, "veistra://file/level").unwrap();
        assert_eq!(r.kind, "folder");
        assert_eq!(text_of(&r).0, "props/\na.tscn");
        assert_eq!(r.meta["hidden"], 2);
        assert!(r.meta.get("partial").is_none());
    }

    #[test]
    fn a_folder_scan_stops_at_its_cap_and_says_the_counts_are_partial() {
        let dir = project();
        for n in 0..5 {
            put(&dir, &format!("dump/{n}.bin"), b"x");
        }
        let r = Resolved::empty(&parse("veistra://file/dump").unwrap(), "folder", "dump");
        let r = folder_within(r, dir.path(), &dir.path().join("dump"), 3).unwrap();
        assert_eq!(r.meta["entries"], 3);
        assert_eq!(r.meta["partial"], true);
        assert!(matches!(
            &r.parts[0],
            Part::Text {
                truncated: true,
                ..
            }
        ));
        assert!(matches!(&r.parts[1], Part::Note { text } if text.contains("first 3 entries")));
        let whole = Resolved::empty(&parse("veistra://file/dump").unwrap(), "folder", "dump");
        let whole = folder_within(whole, dir.path(), &dir.path().join("dump"), 5).unwrap();
        assert_eq!(whole.meta["entries"], 5);
        assert!(whole.meta.get("partial").is_none(), "exactly at the cap");
    }

    #[test]
    fn a_stored_context_image_resolves_and_a_referenced_file_obeys_the_file_rules() {
        let dir = project();
        let shot = crate::context::put(
            dir.path(),
            crate::context::PutRequest {
                key: Some("play/frame".into()),
                kind: None,
                title: Some("Play frame".into()),
                payload: crate::context::Payload::Bytes(png(8, 8)),
                app_id: "play".into(),
                label: None,
                method: crate::context::Method::Put,
                reference_in_place: true,
            },
        )
        .unwrap();
        let r = resolve(&dir, &format!("veistra://context/{}", shot.id)).unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.title, "Play frame");
        assert!(matches!(r.parts[0], Part::Image { .. }));

        put(&dir, ".env", b"A=1\n");
        let env = crate::context::put(
            dir.path(),
            crate::context::PutRequest {
                key: None,
                kind: None,
                title: None,
                payload: crate::context::Payload::Path(dir.path().join(".env")),
                app_id: "terminal".into(),
                label: None,
                method: crate::context::Method::Drop,
                reference_in_place: true,
            },
        )
        .unwrap();
        let r = resolve(&dir, &format!("veistra://context/{}", env.id)).unwrap();
        assert!(r.withheld.unwrap().contains(".env"));
        assert!(item_secret(dir.path(), &env).is_some());
        assert_eq!(item_secret(dir.path(), &shot), None);
    }

    #[test]
    fn a_context_items_prompt_leads_what_it_resolves_to_and_a_later_put_clears_it() {
        let dir = project();
        let put_log = |prompt: Option<&str>| {
            let mut params = json!({ "key": "play/log", "kind": "text", "text": "[error] boom" });
            if let Some(p) = prompt {
                params["prompt"] = json!(p);
            }
            let item = crate::context::call(Some(dir.path()), "play", "context/put", Some(params));
            item.unwrap()["id"].as_str().unwrap().to_string()
        };
        let id = put_log(Some("  Find what threw this error and fix it.  "));
        let r = resolve(&dir, &format!("veistra://context/{id}")).unwrap();
        assert!(
            matches!(&r.parts[0], Part::Note { text } if text == "Find what threw this error and fix it.")
        );
        assert!(
            r.parts.len() > 1,
            "the log itself still follows: {:?}",
            r.parts
        );

        // The same button sent again with nothing to ask carries no stale instruction.
        let again = put_log(None);
        assert_eq!(again, id);
        let r = resolve(&dir, &format!("veistra://context/{id}")).unwrap();
        assert!(!matches!(&r.parts[0], Part::Note { text } if text.contains("Find what threw")));
    }

    #[test]
    fn a_context_record_that_cannot_be_read_is_unreadable_not_missing() {
        let dir = project();
        let gone = resolve(&dir, "veistra://context/ctx_0a1b").unwrap_err();
        assert_eq!(gone.reason, Reason::Missing);
        put(
            &dir,
            ".veistra/context/ctx_0a1b.json",
            b"{\"title\":\"\xff\"}",
        );
        let broken = resolve(&dir, "veistra://context/ctx_0a1b").unwrap_err();
        assert_eq!(broken.reason, Reason::Unreadable, "{broken}");
    }

    #[test]
    fn a_file_is_a_secret_by_its_name_its_target_or_its_first_bytes() {
        let dir = project();
        let key = b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n";
        put(&dir, "notes/deploy.txt", key);
        put(&dir, "notes/plain.txt", b"hello\n");
        put(&dir, "config/.env", b"A=1\n");
        let secret = |rel: &str| secret_file(rel, &policy::contain(dir.path(), rel).unwrap());
        assert_eq!(
            secret("notes/deploy.txt"),
            Some("private keys and key stores")
        );
        assert_eq!(secret("notes/plain.txt"), None);
        assert!(secret("config/.env").is_some());
        assert_eq!(secret("notes"), None, "a folder has no first bytes");
    }

    #[test]
    fn a_key_past_the_first_bytes_is_withheld_from_a_range_that_reaches_it() {
        let dir = project();
        let mut text = format!("{}\n", "x".repeat(40)).repeat(2000);
        text.push_str(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        assert!(text.len() as u64 > HEAD_BYTES);
        put(&dir, "notes/long.txt", text.as_bytes());
        let early = resolve(&dir, "veistra://file/notes/long.txt#L1-L2").unwrap();
        assert_eq!(early.withheld, None);
        let late = resolve(&dir, "veistra://file/notes/long.txt#L2000-L2002").unwrap();
        assert!(late.parts.is_empty());
        assert!(late.withheld.unwrap().contains("private keys"));
        // The header is not in this range, only the key's body.
        let body = resolve(&dir, "veistra://file/notes/long.txt#L2002-L2003").unwrap();
        assert!(body.parts.is_empty());
        assert!(body.withheld.unwrap().contains("private keys"));
    }

    #[test]
    fn a_copied_secret_is_withheld_by_where_it_came_from_or_what_it_holds() {
        // Ingest now refuses these, so the stores this guards are ones written
        // before it did: a clean copy made under a secret's key, and one whose
        // stored bytes were swapped for a private key.
        let (dir, outside) = (project(), project());
        put(&outside, "notes.txt", b"just notes\n");
        let copy = |key: &str| {
            crate::context::put(
                dir.path(),
                crate::context::PutRequest {
                    key: Some(key.into()),
                    kind: None,
                    title: Some("deploy notes".into()),
                    payload: crate::context::Payload::Path(outside.path().join("notes.txt")),
                    app_id: "terminal".into(),
                    label: None,
                    method: crate::context::Method::Drop,
                    reference_in_place: true,
                },
            )
            .unwrap()
        };
        let by_name = copy("file/deploy.pem");
        let by_content = copy("notes/handoff");
        std::fs::write(
            &by_content.path,
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        for item in [by_name, by_content] {
            assert!(item.owned, "a file from outside is copied in");
            let r = resolve(&dir, &format!("veistra://context/{}", item.id)).unwrap();
            assert!(r.withheld.unwrap().contains("private keys"), "{}", item.key);
            assert!(r.parts.is_empty());
            assert!(item_secret(dir.path(), &item).is_some(), "{}", item.key);
        }
    }

    #[test]
    fn a_context_title_is_screened_only_when_it_is_spelt_as_a_file_name() {
        let dir = project();
        let store = |title: &str, key: &str| {
            crate::context::put(
                dir.path(),
                crate::context::PutRequest {
                    key: Some(key.into()),
                    kind: None,
                    title: Some(title.into()),
                    // Each its own text: the store keeps one item per content.
                    payload: crate::context::Payload::Text(format!("{title}: on Monday.")),
                    app_id: "terminal".into(),
                    label: None,
                    method: crate::context::Method::Put,
                    reference_in_place: true,
                },
            )
            .unwrap()
        };
        let read = |id: &str| resolve(&dir, &format!("veistra://context/{id}")).unwrap();
        for prose in [
            "Credentials rotation plan",
            "id_card layout",
            "secrets.md review",
        ] {
            let r = read(&store(prose, "notes/plan").id);
            assert_eq!(r.title, prose);
            assert_eq!(r.withheld, None, "{prose}");
            assert_eq!(text_of(&r).0, format!("{prose}: on Monday."));
        }
        // Ingest now refuses this title, so the item is one stored before it
        // did: its sidecar given the title afterwards.
        let item = store("handoff notes", "notes/handoff");
        let sidecar = crate::context::store_dir(dir.path()).join(format!("{}.json", item.id));
        let mut record: Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        record["title"] = json!("id_rsa");
        std::fs::write(&sidecar, record.to_string()).unwrap();
        let r = read(&item.id);
        assert!(r.withheld.unwrap().contains("SSH private keys"));
    }

    #[test]
    fn a_viewer_comment_brings_its_text_and_screenshot() {
        let dir = project();
        let ctx = crate::apps::CallContext {
            cluster_id: None,
            project: Some(dir.path().to_path_buf()),
        };
        let c = crate::comments::create(
            &ctx,
            crate::comments::Draft {
                anchor: crate::comments::Anchor::Scene {
                    scene: "hospital.tscn".into(),
                    time: 12.5,
                    screenshot: false,
                },
                body: "The door clips through the wall\nsee frame".into(),
                screenshot_png: Some(png(4, 4)),
            },
        )
        .unwrap();
        let r = resolve(&dir, &format!("veistra://comment/{}", c.id)).unwrap();
        assert_eq!(r.title, "The door clips through the wall");
        assert_eq!(r.detail.as_deref(), Some("Play · hospital.tscn at 12.5s"));
        assert!(r.parts.iter().any(|p| matches!(p, Part::Image { .. })));
        let err = resolve(&dir, "veistra://comment/nope").unwrap_err();
        assert_eq!(err.reason, Reason::Missing);
    }

    #[test]
    fn an_oversized_comment_record_is_refused_unread() {
        let dir = project();
        let mut big = br#"{"body":""#.to_vec();
        big.resize(MAX_COMMENT_BYTES as usize + 1, b'x');
        put(&dir, ".veistra/comments/c-big.json", &big);
        let err = resolve(&dir, "veistra://comment/c-big").unwrap_err();
        assert_eq!(err.reason, Reason::Unreadable);
        assert!(err.message.contains("more than a comment holds"), "{err}");
    }
}
