//! Shared write-back path for file-based session stores.
//!
//! Editing a message must change the bytes of that message and nothing else.
//! Everything here exists to keep that promise:
//!
//! * lines the edit does not touch are written back byte for byte, including
//!   lines that are not valid JSON;
//! * inside a touched line only the string values that changed are replaced,
//!   so key order and number formatting survive;
//! * the file is rewritten in place, starting at the first byte that
//!   differs, after checking that nobody else wrote to it since it was read;
//! * the previous contents are kept as a backup before every rewrite.
//!
//! The file is deliberately not swapped for a new one (temp file + rename).
//! A CLI that keeps its session file open would go on appending to the old,
//! now unreachable file, and everything it wrote afterwards would be lost.
//! The backup is what covers a write that is interrupted half way.

use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

static BACKUP_ROOT: OnceLock<PathBuf> = OnceLock::new();
const MAX_BACKUPS_PER_FILE: usize = 3;

/// Where pre-edit copies of session files are kept. Set once at startup;
/// backups are skipped while it is unset.
pub fn set_backup_root(path: PathBuf) {
    let _ = BACKUP_ROOT.set(path);
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

fn fingerprint(path: &Path) -> std::io::Result<Fingerprint> {
    let meta = fs::metadata(path)?;
    Ok(Fingerprint {
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// The contents of a file together with what is needed to replace it safely.
pub struct SourceSnapshot {
    path: PathBuf,
    fingerprint: Fingerprint,
    bytes: Vec<u8>,
}

impl SourceSnapshot {
    pub fn read(path: &Path) -> Result<Self, String> {
        // Resolve symlinks so backups are keyed by the real file.
        let path = fs::canonicalize(path)
            .map_err(|error| format!("cannot open '{}': {error}", path.display()))?;
        let before = fingerprint(&path)
            .map_err(|error| format!("cannot stat '{}': {error}", path.display()))?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("cannot read '{}': {error}", path.display()))?;
        if bytes.len() as u64 != before.len {
            return Err(busy_error(&path));
        }
        Ok(Self {
            path,
            fingerprint: before,
            bytes,
        })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_text(self) -> Result<(Self, String), String> {
        let text = String::from_utf8(self.bytes.clone())
            .map_err(|_| format!("'{}' is not valid UTF-8", self.path.display()))?;
        Ok((self, text))
    }

    pub fn replace(self, new_bytes: &[u8]) -> Result<(), String> {
        self.replace_with_backup_root(new_bytes, BACKUP_ROOT.get().map(PathBuf::as_path))
    }

    fn replace_with_backup_root(
        self,
        new_bytes: &[u8],
        backup_root: Option<&Path>,
    ) -> Result<(), String> {
        if new_bytes == self.bytes.as_slice() {
            return Ok(());
        }
        match fingerprint(&self.path) {
            Ok(current) if current == self.fingerprint => {}
            _ => return Err(busy_error(&self.path)),
        }
        if let Some(root) = backup_root {
            write_backup(root, &self.path, &self.bytes)?;
        }
        write_in_place(&self.path, &self.bytes, new_bytes)
    }
}

fn busy_error(path: &Path) -> String {
    format!(
        "'{}' was changed by another program while it was being edited. Reload the session and try again.",
        path.display()
    )
}

fn write_in_place(path: &Path, old_bytes: &[u8], new_bytes: &[u8]) -> Result<(), String> {
    let unchanged = old_bytes
        .iter()
        .zip(new_bytes)
        .take_while(|(old, new)| old == new)
        .count();
    (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).open(path)?;
        file.seek(SeekFrom::Start(unchanged as u64))?;
        file.write_all(&new_bytes[unchanged..])?;
        file.set_len(new_bytes.len() as u64)?;
        file.sync_all()
    })()
    .map_err(|error| format!("cannot write '{}': {error}", path.display()))
}

fn write_backup(root: &Path, source: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("cannot create backup folder '{}': {error}", root.display()))?;

    let digest = Sha256::digest(source.to_string_lossy().as_bytes());
    let prefix: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "session".to_string());
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();

    let backup = root.join(format!("{prefix}-{name}.{millis:013}.bak"));
    fs::write(&backup, bytes)
        .map_err(|error| format!("cannot write backup '{}': {error}", backup.display()))?;

    let own_prefix = format!("{prefix}-{name}.");
    let mut existing: Vec<PathBuf> = fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(&own_prefix) && name.ends_with(".bak"))
                })
                .collect()
        })
        .unwrap_or_default();
    existing.sort();
    let excess = existing.len().saturating_sub(MAX_BACKUPS_PER_FILE);
    for stale in existing.into_iter().take(excess) {
        let _ = fs::remove_file(stale);
    }
    Ok(())
}

// ─── JSON text splicing ───

/// Rewrite `raw` (JSON text that parses to `old`) so that it parses to `new`,
/// replacing only the string values that differ. Returns `None` when the two
/// values differ in anything but string contents.
pub fn splice_changed_strings(raw: &str, old: &Value, new: &Value) -> Option<String> {
    if old == new {
        return Some(raw.to_string());
    }
    let mut splicer = Splicer {
        src: raw.as_bytes(),
        pos: 0,
        edits: Vec::new(),
    };
    splicer.skip_whitespace();
    splicer.value(old, new)?;
    splicer.skip_whitespace();
    if splicer.pos != raw.len() {
        return None;
    }

    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0;
    for (start, end, replacement) in &splicer.edits {
        out.push_str(raw.get(cursor..*start)?);
        out.push_str(replacement);
        cursor = *end;
    }
    out.push_str(raw.get(cursor..)?);

    // The scanner is hand written; never trust it over the parser.
    match serde_json::from_str::<Value>(&out) {
        Ok(parsed) if &parsed == new => Some(out),
        _ => None,
    }
}

struct Splicer<'a> {
    src: &'a [u8],
    pos: usize,
    edits: Vec<(usize, usize, String)>,
}

impl Splicer<'_> {
    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    /// Advance past the string token starting at `pos`, returning its span.
    fn string_token(&mut self) -> Option<(usize, usize)> {
        let start = self.pos;
        if self.peek()? != b'"' {
            return None;
        }
        self.pos += 1;
        loop {
            match self.peek()? {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    return Some((start, self.pos));
                }
                _ => self.pos += 1,
            }
        }
    }

    fn value(&mut self, old: &Value, new: &Value) -> Option<()> {
        match self.peek()? {
            b'{' => {
                let (Value::Object(old_map), Value::Object(new_map)) = (old, new) else {
                    return None;
                };
                if old_map.len() != new_map.len() {
                    return None;
                }
                self.pos += 1;
                self.skip_whitespace();
                if self.peek()? == b'}' {
                    self.pos += 1;
                    return old_map.is_empty().then_some(());
                }
                let mut seen = 0usize;
                loop {
                    self.skip_whitespace();
                    let (start, end) = self.string_token()?;
                    let key: String =
                        serde_json::from_slice(self.src.get(start..end)?).ok()?;
                    self.skip_whitespace();
                    if self.peek()? != b':' {
                        return None;
                    }
                    self.pos += 1;
                    self.skip_whitespace();
                    self.value(old_map.get(&key)?, new_map.get(&key)?)?;
                    seen += 1;
                    self.skip_whitespace();
                    match self.peek()? {
                        b',' => self.pos += 1,
                        b'}' => {
                            self.pos += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
                // Fewer map entries than keys seen means duplicate keys.
                (seen == old_map.len()).then_some(())
            }
            b'[' => {
                let (Value::Array(old_items), Value::Array(new_items)) = (old, new) else {
                    return None;
                };
                if old_items.len() != new_items.len() {
                    return None;
                }
                self.pos += 1;
                self.skip_whitespace();
                if self.peek()? == b']' {
                    self.pos += 1;
                    return old_items.is_empty().then_some(());
                }
                let mut index = 0usize;
                loop {
                    self.skip_whitespace();
                    self.value(old_items.get(index)?, new_items.get(index)?)?;
                    index += 1;
                    self.skip_whitespace();
                    match self.peek()? {
                        b',' => self.pos += 1,
                        b']' => {
                            self.pos += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
                (index == old_items.len()).then_some(())
            }
            b'"' => {
                let (start, end) = self.string_token()?;
                if old != new {
                    let (Value::String(_), Value::String(text)) = (old, new) else {
                        return None;
                    };
                    self.edits
                        .push((start, end, serde_json::to_string(text).ok()?));
                }
                Some(())
            }
            _ => {
                while !matches!(
                    self.peek(),
                    None | Some(b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
                ) {
                    self.pos += 1;
                }
                (old == new).then_some(())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonStyle {
    Compact,
    Pretty,
    PrettyWithNewline,
}

fn rewrite_json_text(raw: &str, old: &Value, new: &Value, style: JsonStyle) -> Result<String, String> {
    if let Some(spliced) = splice_changed_strings(raw, old, new) {
        return Ok(spliced);
    }
    let serialized = match style {
        JsonStyle::Compact => serde_json::to_string(new),
        JsonStyle::Pretty | JsonStyle::PrettyWithNewline => serde_json::to_string_pretty(new),
    }
    .map_err(|error| format!("Serialize error: {error}"))?;
    Ok(if style == JsonStyle::PrettyWithNewline {
        format!("{serialized}\n")
    } else {
        serialized
    })
}

/// Edit a file that holds a single JSON document.
///
/// `style` is only used when the edit changes more than string contents and
/// the document has to be serialized from scratch.
pub fn edit_json_file<T>(
    path: &Path,
    style: JsonStyle,
    edit: impl FnOnce(&mut Value) -> Result<T, String>,
) -> Result<T, String> {
    let (snapshot, raw) = SourceSnapshot::read(path)?.into_text()?;
    let old: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("cannot parse '{}': {error}", path.display()))?;
    let mut new = old.clone();
    let outcome = edit(&mut new)?;
    let updated = rewrite_json_text(&raw, &old, &new, style)?;
    snapshot.replace(updated.as_bytes())?;
    Ok(outcome)
}

/// Replace a JSON document that was read as `raw` with `new`. Fails without
/// writing when the file no longer holds `raw`.
pub fn replace_json_file(
    path: &Path,
    raw: &str,
    new: &Value,
    style: JsonStyle,
) -> Result<(), String> {
    let snapshot = SourceSnapshot::read(path)?;
    if snapshot.bytes() != raw.as_bytes() {
        return Err(busy_error(path));
    }
    let old: Value = serde_json::from_str(raw)
        .map_err(|error| format!("cannot parse '{}': {error}", path.display()))?;
    let updated = rewrite_json_text(raw, &old, new, style)?;
    snapshot.replace(updated.as_bytes())
}

// ─── JSONL editing ───

struct Line {
    /// Byte range of the line's content, without its terminator.
    start: usize,
    end: usize,
    /// Start of the next line; `end..next` is the terminator.
    next: usize,
    replacement: Option<String>,
}

/// A line whose length changed, described in the coordinates of the original
/// file. Stores that index a session by byte offset use this to follow along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineChange {
    /// Byte offset just past the original line and its terminator.
    pub old_end: usize,
    pub delta: i64,
}

/// Line-level editor for JSONL text. Lines that are never edited keep their
/// exact bytes, whatever they contain.
pub struct JsonlEditor {
    snapshot: Option<SourceSnapshot>,
    text: String,
    lines: Vec<Line>,
    appended: Vec<String>,
    parsed_to_raw: Option<Vec<usize>>,
}

impl JsonlEditor {
    pub fn open(path: &Path) -> Result<Self, String> {
        let (snapshot, text) = SourceSnapshot::read(path)?.into_text()?;
        let mut editor = Self::from_text(text);
        editor.snapshot = Some(snapshot);
        Ok(editor)
    }

    pub fn from_text(text: String) -> Self {
        let bytes = text.as_bytes();
        let mut lines = Vec::new();
        let mut start = 0;
        while start < bytes.len() {
            let newline = bytes[start..].iter().position(|byte| *byte == b'\n');
            let (mut end, next) = match newline {
                Some(offset) => (start + offset, start + offset + 1),
                None => (bytes.len(), bytes.len()),
            };
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            lines.push(Line {
                start,
                end,
                next,
                replacement: None,
            });
            start = next;
        }
        Self {
            snapshot: None,
            text,
            lines,
            appended: Vec::new(),
            parsed_to_raw: None,
        }
    }

    /// Number of lines, counted the way `str::lines` counts them.
    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Current text of a line, edits included.
    pub fn line(&self, raw_index: usize) -> Option<&str> {
        let line = self.lines.get(raw_index)?;
        Some(match &line.replacement {
            Some(replacement) => replacement,
            None => &self.text[line.start..line.end],
        })
    }

    /// Map an index into "non-blank lines that parse as JSON" (how several
    /// adapters number their rows) to the underlying line.
    pub fn raw_index_of_parsed(&mut self, parsed_index: usize) -> Option<usize> {
        self.parsed_line_indices().get(parsed_index).copied()
    }

    /// Underlying line index of every non-blank line that parses as JSON.
    pub fn parsed_line_indices(&mut self) -> &[usize] {
        if self.parsed_to_raw.is_none() {
            let text = &self.text;
            let mapping = self
                .lines
                .iter()
                .enumerate()
                .filter(|(_, line)| {
                    let content = &text[line.start..line.end];
                    !content.trim().is_empty() && serde_json::from_str::<Value>(content).is_ok()
                })
                .map(|(index, _)| index)
                .collect();
            self.parsed_to_raw = Some(mapping);
        }
        self.parsed_to_raw.as_deref().unwrap_or_default()
    }

    /// Lines that can hold a record with the given id. Ids made of plain
    /// characters are found by substring; anything else falls back to every
    /// line, since JSON may escape it in more than one way.
    pub fn lines_mentioning(&self, id: &str) -> Vec<usize> {
        let plain = !id.is_empty()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'));
        (0..self.lines.len())
            .filter(|index| {
                self.line(*index)
                    .is_some_and(|line| !line.trim().is_empty() && (!plain || line.contains(id)))
            })
            .collect()
    }

    /// Parse one line, let `edit` change it, and stage the result.
    pub fn edit_line<T>(
        &mut self,
        raw_index: usize,
        edit: impl FnOnce(&mut Value) -> Result<T, String>,
    ) -> Result<T, String> {
        let current = self
            .line(raw_index)
            .ok_or_else(|| "Line index out of range".to_string())?
            .to_string();
        let old: Value = serde_json::from_str(&current)
            .map_err(|error| format!("cannot parse line {raw_index}: {error}"))?;
        let mut new = old.clone();
        let outcome = edit(&mut new)?;
        if new != old {
            let updated = rewrite_json_text(&current, &old, &new, JsonStyle::Compact)?;
            self.lines[raw_index].replacement = Some(updated);
        }
        Ok(outcome)
    }

    /// Like `edit_line`, but a line that is not JSON yields `Ok(None)`
    /// instead of an error, as does an edit that declines the line.
    pub fn try_edit_line<T>(
        &mut self,
        raw_index: usize,
        edit: impl FnOnce(&mut Value) -> Result<Option<T>, String>,
    ) -> Result<Option<T>, String> {
        let parses = self
            .line(raw_index)
            .is_some_and(|line| serde_json::from_str::<Value>(line).is_ok());
        if !parses {
            return Ok(None);
        }
        self.edit_line(raw_index, edit)
    }

    pub fn append_line(&mut self, text: String) {
        self.appended.push(text);
    }

    pub fn changes(&self) -> Vec<LineChange> {
        self.lines
            .iter()
            .filter_map(|line| {
                let replacement = line.replacement.as_ref()?;
                let delta = replacement.len() as i64 - (line.end - line.start) as i64;
                (delta != 0).then_some(LineChange {
                    old_end: line.next,
                    delta,
                })
            })
            .collect()
    }

    pub fn render(&self) -> String {
        let mut out = String::with_capacity(self.text.len());
        for line in &self.lines {
            match &line.replacement {
                Some(replacement) => out.push_str(replacement),
                None => out.push_str(&self.text[line.start..line.end]),
            }
            out.push_str(&self.text[line.end..line.next]);
        }
        if !self.appended.is_empty() {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            for line in &self.appended {
                out.push_str(line);
                out.push('\n');
            }
        }
        out
    }

    pub fn commit(mut self) -> Result<(), String> {
        let rendered = self.render();
        let snapshot = self
            .snapshot
            .take()
            .ok_or_else(|| "JSONL editor is not backed by a file".to_string())?;
        snapshot.replace(rendered.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let root = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("memory-forge-safe-write-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp dir");
        root
    }

    #[test]
    fn splice_keeps_key_order_and_number_text() {
        let raw = r#"{"z":1795068955.5778801,"text":"old \"quoted\"","a":[{"text":"keep"},1e3],"n":null}"#;
        let old: Value = serde_json::from_str(raw).unwrap();
        let mut new = old.clone();
        new["text"] = json!("new\nvalue");

        let spliced = splice_changed_strings(raw, &old, &new).expect("splice");

        assert_eq!(
            spliced,
            r#"{"z":1795068955.5778801,"text":"new\nvalue","a":[{"text":"keep"},1e3],"n":null}"#
        );
    }

    #[test]
    fn splice_refuses_structural_changes() {
        let raw = r#"{"a":"x","b":1}"#;
        let old: Value = serde_json::from_str(raw).unwrap();

        let mut added = old.clone();
        added["c"] = json!("y");
        assert!(splice_changed_strings(raw, &old, &added).is_none());

        let mut retyped = old.clone();
        retyped["b"] = json!(2);
        assert!(splice_changed_strings(raw, &old, &retyped).is_none());

        let duplicate = r#"{"a":"x","a":"y"}"#;
        let old: Value = serde_json::from_str(duplicate).unwrap();
        let new = json!({ "a": "z" });
        assert!(splice_changed_strings(duplicate, &old, &new).is_none());
    }

    #[test]
    fn editor_preserves_untouched_lines_byte_for_byte() {
        let text = concat!(
            "{\"b\":2,\"a\":1.50}\r\n",
            "this line is not json\n",
            "\n",
            "{\"msg\":\"old\",\"t\":1.0}\n",
            "{\"tail\":true}"
        )
        .to_string();
        let mut editor = JsonlEditor::from_text(text);

        assert_eq!(editor.line_count(), 5);
        // Parsed rows skip the broken line and the blank one.
        assert_eq!(editor.raw_index_of_parsed(1), Some(3));
        editor
            .edit_line(3, |row| {
                row["msg"] = json!("new");
                Ok(())
            })
            .expect("edit");

        assert_eq!(
            editor.render(),
            concat!(
                "{\"b\":2,\"a\":1.50}\r\n",
                "this line is not json\n",
                "\n",
                "{\"msg\":\"new\",\"t\":1.0}\n",
                "{\"tail\":true}"
            )
        );
    }

    #[test]
    fn editor_reports_length_changes_in_original_offsets() {
        let mut editor = JsonlEditor::from_text("{\"m\":\"ab\"}\n{\"m\":\"cd\"}\n".to_string());
        editor
            .edit_line(0, |row| {
                row["m"] = json!("abcde");
                Ok(())
            })
            .expect("edit");

        assert_eq!(editor.changes(), vec![LineChange { old_end: 11, delta: 3 }]);
    }

    #[test]
    fn replace_backs_up_and_prunes_old_backups() {
        let root = temp_dir("backup");
        let file = root.join("session.jsonl");
        let backups = root.join("backups");

        for round in 0..5 {
            fs::write(&file, format!("v{round}")).expect("seed");
            SourceSnapshot::read(&file)
                .expect("read")
                .replace_with_backup_root(format!("v{round}-edited").as_bytes(), Some(&backups))
                .expect("replace");
            std::thread::sleep(std::time::Duration::from_millis(3));
        }

        assert_eq!(fs::read_to_string(&file).unwrap(), "v4-edited");
        let mut kept: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|entry| fs::read_to_string(entry.path()).unwrap())
            .collect();
        kept.sort();
        assert_eq!(kept, vec!["v2", "v3", "v4"]);
        // Nothing but the session and the backup folder is left behind.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn replace_refuses_when_file_changed_after_read() {
        let root = temp_dir("stale");
        let file = root.join("session.jsonl");
        fs::write(&file, "{\"a\":1}\n").expect("seed");

        let snapshot = SourceSnapshot::read(&file).expect("read");
        // Another program appends between our read and our write.
        fs::write(&file, "{\"a\":1}\n{\"b\":2}\n").expect("append");
        let result = snapshot.replace_with_backup_root(b"{\"a\":9}\n", None);

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
        fs::remove_dir_all(&root).ok();
    }
}
