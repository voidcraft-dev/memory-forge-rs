use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use super::{build_commands, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem, SessionListResult, TimelineBlock};

pub struct ClaudePlatform {
    projects_root: PathBuf,
}

#[derive(Clone)]
struct ScanSummary {
    session_id: String,
    cwd: String,
    preview: String,
}

impl ClaudePlatform {
    pub fn new(claude_home: PathBuf) -> Self {
        Self {
            projects_root: claude_home.join("projects"),
        }
    }

    fn read_jsonl(&self, path: &Path) -> Vec<Value> {
        let raw = fs::read_to_string(path).unwrap_or_default();
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
    }

    /// Fast single-pass scan: reads line-by-line, breaks early once we have session_id + cwd + preview.
    fn scan_summary(&self, path: &Path) -> ScanSummary {
        let default_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let mut session_id = String::new();
        let mut cwd = String::new();
        let mut preview = String::new();

        let Ok(file) = File::open(path) else {
            return ScanSummary { session_id: default_id, cwd, preview };
        };
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else { continue };

            if session_id.is_empty() {
                if let Some(id) = parsed.get("sessionId").and_then(Value::as_str) {
                    session_id = id.to_string();
                }
            }

            if cwd.is_empty() {
                if let Some(c) = parsed.get("cwd").and_then(Value::as_str) {
                    cwd = c.to_string();
                }
            }

            if preview.is_empty() {
                if let Some(message) = parsed.get("message") {
                    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
                    if role == "user" || role == "assistant" {
                        // string content
                        if let Some(text) = message.get("content").and_then(Value::as_str) {
                            let cleaned = clean_preview_text(text);
                            if !cleaned.is_empty() {
                                preview = truncate(&cleaned, 120);
                            }
                        }
                        // array content
                        if preview.is_empty() {
                            if let Some(items) = message.get("content").and_then(Value::as_array) {
                                for item in items {
                                    if item.get("type").and_then(Value::as_str) == Some("text") {
                                        let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                                        let cleaned = clean_preview_text(text);
                                        if !cleaned.is_empty() {
                                            preview = truncate(&cleaned, 120);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if !session_id.is_empty() && !cwd.is_empty() && !preview.is_empty() {
                break;
            }
        }

        if session_id.is_empty() {
            session_id = default_id;
        }

        ScanSummary { session_id, cwd, preview }
    }

    fn session_id(&self, lines: &[Value], path: &Path) -> String {
        for line in lines {
            if let Some(id) = line.get("sessionId").and_then(Value::as_str) {
                return id.to_string();
            }
        }
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("unknown")
            .to_string()
    }

    fn cwd(&self, lines: &[Value]) -> String {
        for line in lines {
            if let Some(cwd) = line.get("cwd").and_then(Value::as_str) {
                return cwd.to_string();
            }
        }
        String::new()
    }

    fn blocks(&self, lines: &[Value], file_key: &str) -> Vec<TimelineBlock> {
        let mut blocks = Vec::new();

        for (line_index, line) in lines.iter().enumerate() {
            let Some(message) = line.get("message") else {
                continue;
            };

            let Some(role) = message.get("role").and_then(Value::as_str) else {
                continue;
            };

            if let Some(text) = message.get("content").and_then(Value::as_str) {
                if role == "user" || role == "assistant" {
                    blocks.push(TimelineBlock {
                        id: format!("{line_index}:0:{role}"),
                        role: role.to_string(),
                        content: text.to_string(),
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}::0::content"),
                        source_meta: json!({
                            "lineIndex": line_index,
                            "contentIndex": 0,
                        }),
                    });
                }
                continue;
            }

            let Some(items) = message.get("content").and_then(Value::as_array) else {
                continue;
            };

            for (content_index, item) in items.iter().enumerate() {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();

                match (role, item_type) {
                    ("user", "text") => blocks.push(TimelineBlock {
                        id: format!("{line_index}:{content_index}:user"),
                        role: "user".to_string(),
                        content: item
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}::{content_index}::text"),
                        source_meta: json!({
                            "lineIndex": line_index,
                            "contentIndex": content_index,
                        }),
                    }),
                    ("assistant", "text") => blocks.push(TimelineBlock {
                        id: format!("{line_index}:{content_index}:assistant"),
                        role: "assistant".to_string(),
                        content: item
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}::{content_index}::text"),
                        source_meta: json!({
                            "lineIndex": line_index,
                            "contentIndex": content_index,
                        }),
                    }),
                    ("assistant", "thinking") | ("assistant", "reasoning") => {
                        let field_name = if item.get("thinking").is_some() {
                            "thinking"
                        } else {
                            "text"
                        };
                        blocks.push(TimelineBlock {
                            id: format!("{line_index}:{content_index}:thinking"),
                            role: "thinking".to_string(),
                            content: item
                                .get(field_name)
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            editable: true,
                            edit_target: format!(
                                "{file_key}::{line_index}::{content_index}::{field_name}"
                            ),
                            source_meta: json!({
                                "lineIndex": line_index,
                                "contentIndex": content_index,
                            }),
                        });
                    }
                    _ => {}
                }
            }
        }

        blocks
    }
}

impl PlatformAdapter for ClaudePlatform {
    fn list_sessions(&self, alias_map: &HashMap<String, String>, limit: Option<usize>, offset: usize) -> SessionListResult {
        if !self.projects_root.exists() {
            return SessionListResult { total: 0, items: Vec::new() };
        }

        let mut entries = Vec::new();
        collect_jsonl_recursive(&self.projects_root, &mut entries);
        entries.sort_by(|a, b| modified_nanos(b).cmp(&modified_nanos(a)));

        let total = entries.len();
        let page = if offset < total {
            let end = limit.map(|l| (offset + l).min(total)).unwrap_or(total);
            &entries[offset..end]
        } else {
            &[]
        };

        let mut items = Vec::new();
        for path in page {
            let session_key = encode_path_key(path);
            let summary = self.scan_summary(path);
            let alias = alias_map.get(&session_key).cloned().unwrap_or_default();

            items.push(SessionListItem {
                platform: "claude".to_string(),
                session_key,
                session_id: summary.session_id.clone(),
                display_title: if alias.is_empty() {
                    summary.session_id
                } else {
                    alias.clone()
                },
                alias_title: alias,
                preview: summary.preview,
                updated_at: modified_nanos(path).to_string(),
                cwd: summary.cwd,
                editable: true,
                content_matches: vec![],
                total_content_matches: 0,
                favorite: false,
            });
        }

        SessionListResult { total, items }
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let path = Path::new(session_key);
        let lines = self.read_jsonl(path);
        let session_id = self.session_id(&lines, path);
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();

        Ok(SessionDetail {
            platform: "claude".to_string(),
            session_key: session_key.to_string(),
            session_id: session_id.clone(),
            title: if alias.is_empty() {
                session_id.clone()
            } else {
                alias.clone()
            },
            alias_title: alias,
            cwd: self.cwd(&lines),
            commands: build_commands("claude", &session_id),
            blocks: self.blocks(&lines, session_key),
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        if parts.len() != 4 {
            return Err(format!("Invalid edit target: {edit_target}"));
        }

        let file_path = Path::new(parts[0]);
        let line_index: usize = parts[1]
            .parse()
            .map_err(|error| format!("Invalid line index: {error}"))?;
        let content_index: usize = parts[2]
            .parse()
            .map_err(|error| format!("Invalid content index: {error}"))?;
        let field_name = parts[3];

        let mut rows = self.read_jsonl(file_path);
        if line_index >= rows.len() {
            return Err("Line index out of range".to_string());
        }

        let Some(message) = rows[line_index].get_mut("message") else {
            return Err("Missing message payload".to_string());
        };

        let old_content = if field_name == "content" {
            let old = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            message["content"] = Value::String(new_content.to_string());
            old
        } else {
            let Some(items) = message.get_mut("content").and_then(Value::as_array_mut) else {
                return Err("Message content is not an array".to_string());
            };
            let Some(item) = items.get_mut(content_index) else {
                return Err("Content index out of range".to_string());
            };
            let old = item
                .get(field_name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            item[field_name] = Value::String(new_content.to_string());
            old
        };

        let serialized = rows
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Serialize error: {error}"))?;

        fs::write(file_path, format!("{}\n", serialized.join("\n")))
            .map_err(|error| format!("Write error: {error}"))?;

        Ok(old_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        !self.content_search(session_key, query).is_empty()
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return vec![];
        }

        let lines = self.read_jsonl(Path::new(session_key));
        let mut matches = Vec::new();
        let mut msg_index = 0usize;

        for line in &lines {
            let Some(message) = line.get("message") else { continue };
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }

            // Collect all text from this message
            let mut texts = Vec::new();
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
            if let Some(items) = message.get("content").and_then(Value::as_array) {
                for item in items {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                    if item_type == "text" {
                        if let Some(t) = item.get("text").and_then(Value::as_str) {
                            texts.push(t.to_string());
                        }
                    } else if item_type == "thinking" || item_type == "reasoning" {
                        let t = item.get("thinking").or_else(|| item.get("text")).and_then(Value::as_str).unwrap_or("");
                        texts.push(t.to_string());
                    }
                }
            }

            for text in &texts {
                if text.to_lowercase().contains(&needle) {
                    matches.push(ContentMatch {
                        snippet: super::extract_snippet(text, &needle),
                        match_index: msg_index,
                        role: role.to_string(),
                    });
                    break; // one match per message
                }
            }

            msg_index += 1;
        }

        matches
    }
}

fn encode_path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn modified_nanos(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|time| {
            time.duration_since(SystemTime::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn collect_jsonl_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_recursive(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn clean_preview_text(text: &str) -> String {
    let mut cleaned = text.trim().to_string();
    let start_tag = "<local-command-caveat>";
    let end_tag = "</local-command-caveat>";

    if cleaned.contains(start_tag) && cleaned.contains(end_tag) {
        if let Some(position) = cleaned.find(end_tag) {
            cleaned = cleaned[position + end_tag.len()..].trim().to_string();
        }
    }

    if cleaned.starts_with("<command-name>") || cleaned.starts_with("<local-command-stdout>") {
        return String::new();
    }

    cleaned
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
