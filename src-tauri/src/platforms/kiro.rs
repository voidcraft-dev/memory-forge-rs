use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use super::{
    build_commands, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem,
    SessionListResult, TimelineBlock,
};

pub struct KiroPlatform {
    sessions_dir: PathBuf,
}

#[derive(Clone)]
struct ScanSummary {
    session_id: String,
    title: String,
    cwd: String,
    preview: String,
    updated_at: String,
}

impl KiroPlatform {
    pub fn new(kiro_home: PathBuf) -> Self {
        Self {
            sessions_dir: kiro_home.join("sessions").join("cli"),
        }
    }

    /// Fast scan of the metadata JSON file.
    fn scan_meta(&self, meta_path: &Path) -> Option<ScanSummary> {
        let raw = fs::read_to_string(meta_path).ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;

        let session_id = parsed
            .get("session_id")
            .and_then(Value::as_str)?
            .to_string();
        let title = parsed
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let cwd = parsed
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let updated_at = parsed
            .get("updated_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // Get preview from first few lines of the jsonl file
        let jsonl_path = meta_path.with_extension("jsonl");
        let preview = self.first_message_preview(&jsonl_path);

        Some(ScanSummary {
            session_id,
            title,
            cwd,
            preview,
            updated_at,
        })
    }

    fn first_message_preview(&self, jsonl_path: &Path) -> String {
        let Ok(file) = File::open(jsonl_path) else {
            return String::new();
        };
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };

            let kind = parsed.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind == "Prompt" || kind == "AssistantMessage" {
                if let Some(text) = extract_content_text(&parsed) {
                    let cleaned = clean_hook_context(&text);
                    if !cleaned.is_empty() {
                        return truncate(&cleaned, 120);
                    }
                }
            }
        }

        String::new()
    }

    fn read_jsonl(&self, path: &Path) -> Vec<Value> {
        let raw = fs::read_to_string(path).unwrap_or_default();
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
    }

    fn blocks(&self, lines: &[Value], session_key: &str) -> Vec<TimelineBlock> {
        let mut blocks = Vec::new();

        for (line_index, line) in lines.iter().enumerate() {
            let kind = line.get("kind").and_then(Value::as_str).unwrap_or("");
            let Some(data) = line.get("data") else {
                continue;
            };

            let role = match kind {
                "Prompt" => "user",
                "AssistantMessage" => "assistant",
                _ => continue,
            };

            let Some(text) = extract_content_text(line) else {
                continue;
            };
            let cleaned = if role == "user" {
                clean_hook_context(&text)
            } else {
                text
            };
            if cleaned.is_empty() {
                continue;
            }

            let message_id = data
                .get("message_id")
                .and_then(Value::as_str)
                .unwrap_or("");

            blocks.push(TimelineBlock {
                id: format!("{line_index}:{role}"),
                role: role.to_string(),
                content: cleaned,
                editable: true,
                edit_target: format!("{session_key}::{line_index}"),
                source_meta: json!({
                    "lineIndex": line_index,
                    "messageId": message_id,
                }),
            });
        }

        blocks
    }
}

impl PlatformAdapter for KiroPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        if !self.sessions_dir.exists() {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        }

        // Collect all .json metadata files
        let mut entries: Vec<PathBuf> = fs::read_dir(&self.sessions_dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        entries.sort_by(|a, b| modified_nanos(b).cmp(&modified_nanos(a)));

        let total = entries.len();
        let page = if offset < total {
            let end = limit.map(|l| (offset + l).min(total)).unwrap_or(total);
            &entries[offset..end]
        } else {
            &[]
        };

        let mut items = Vec::new();
        for meta_path in page {
            let Some(summary) = self.scan_meta(meta_path) else {
                continue;
            };
            let session_key = summary.session_id.clone();
            let alias = alias_map.get(&session_key).cloned().unwrap_or_default();

            items.push(SessionListItem {
                platform: "kiro".to_string(),
                session_key: session_key.clone(),
                session_id: session_key,
                display_title: if !alias.is_empty() {
                    alias.clone()
                } else if !summary.title.is_empty() {
                    summary.title
                } else {
                    summary.session_id.chars().take(8).collect()
                },
                alias_title: alias,
                preview: summary.preview,
                updated_at: modified_nanos(meta_path).to_string(),
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
        let meta_path = self.sessions_dir.join(format!("{session_key}.json"));
        let jsonl_path = self.sessions_dir.join(format!("{session_key}.jsonl"));

        let raw = fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read kiro meta: {e}"))?;
        let meta: Value =
            serde_json::from_str(&raw).map_err(|e| format!("Failed to parse kiro meta: {e}"))?;

        let title_raw = meta
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let cwd = meta
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if !alias.is_empty() {
            alias.clone()
        } else if !title_raw.is_empty() {
            title_raw
        } else {
            session_key.to_string()
        };

        let lines = self.read_jsonl(&jsonl_path);
        let blocks = self.blocks(&lines, session_key);

        Ok(SessionDetail {
            platform: "kiro".to_string(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd,
            commands: build_commands("kiro", session_key),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        if parts.len() != 2 {
            return Err(format!("Invalid edit target: {edit_target}"));
        }

        let session_key = parts[0];
        let line_index: usize = parts[1]
            .parse()
            .map_err(|e| format!("Invalid line index: {e}"))?;

        let jsonl_path = self.sessions_dir.join(format!("{session_key}.jsonl"));
        let mut rows = self.read_jsonl(&jsonl_path);

        let Some(row) = rows.get_mut(line_index) else {
            return Err("Line index out of range".to_string());
        };

        // Extract old content
        let old_content = extract_content_text(row).unwrap_or_default();

        // Update content
        if let Some(data) = row.get_mut("data") {
            if let Some(content) = data.get_mut("content") {
                if let Some(arr) = content.as_array_mut() {
                    if let Some(first) = arr.first_mut() {
                        first["data"] = Value::String(new_content.to_string());
                    }
                }
            }
        }

        let serialized = rows
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Serialize error: {e}"))?;

        fs::write(&jsonl_path, format!("{}\n", serialized.join("\n")))
            .map_err(|e| format!("Write error: {e}"))?;

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

        let jsonl_path = self.sessions_dir.join(format!("{session_key}.jsonl"));
        let lines = self.read_jsonl(&jsonl_path);
        let mut matches = Vec::new();
        let mut msg_index = 0usize;

        for line in &lines {
            let kind = line.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind != "Prompt" && kind != "AssistantMessage" {
                continue;
            }

            let role = if kind == "Prompt" {
                "user"
            } else {
                "assistant"
            };

            if let Some(text) = extract_content_text(line) {
                let cleaned = if role == "user" {
                    clean_hook_context(&text)
                } else {
                    text.clone()
                };
                if cleaned.to_lowercase().contains(&needle) {
                    matches.push(ContentMatch {
                        snippet: super::extract_snippet(&cleaned, &needle),
                        match_index: msg_index,
                        role: role.to_string(),
                    });
                }
            }
            msg_index += 1;
        }

        matches
    }
}

/// Extract text from Kiro content array: data.content[*].data joined
fn extract_content_text(line: &Value) -> Option<String> {
    let data = line.get("data")?;
    let content = data.get("content")?.as_array()?;
    let mut texts = Vec::new();
    for item in content {
        if item.get("kind").and_then(Value::as_str) == Some("text") {
            if let Some(t) = item.get("data").and_then(Value::as_str) {
                texts.push(t.to_string());
            }
        }
    }
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

/// Strip Kiro hook-injected context blocks from user prompts
fn clean_hook_context(text: &str) -> String {
    // Remove everything between CONTEXT ENTRY markers in meta.additionalContext
    // These show up embedded in the prompt data sometimes
    text.trim().to_string()
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn modified_nanos(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .and_then(|t| {
            t.duration_since(SystemTime::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
