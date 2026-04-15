use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use super::{build_commands, PlatformAdapter, SessionDetail, SessionListItem, SessionListResult, TimelineBlock};

pub struct CodexPlatform {
    sessions_root: PathBuf,
}

#[derive(Clone)]
struct SummaryData {
    session_id: String,
    cwd: String,
    preview: String,
}

impl CodexPlatform {
    pub fn new(codex_home: PathBuf) -> Self {
        Self {
            sessions_root: codex_home.join("sessions"),
        }
    }

    fn read_jsonl(&self, path: &Path) -> Vec<Value> {
        let raw = fs::read_to_string(path).unwrap_or_default();
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
    }

    fn scan_summary(&self, path: &Path) -> SummaryData {
        let mut session_id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("unknown")
            .to_string();
        let mut cwd = String::new();
        let mut preview = String::new();

        let Ok(file) = File::open(path) else {
            return SummaryData { session_id, cwd, preview };
        };
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else { continue };

            let Some(payload) = parsed.get("payload") else { continue };

            if let Some(id) = payload.get("id").and_then(Value::as_str) {
                session_id = id.to_string();
            }
            if cwd.is_empty() {
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            if preview.is_empty()
                && matches!(
                    payload.get("type").and_then(Value::as_str),
                    Some("user_message") | Some("agent_message")
                )
            {
                preview = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect();
            }

            if !cwd.is_empty() && !preview.is_empty() {
                break;
            }
        }

        SummaryData {
            session_id,
            cwd,
            preview,
        }
    }

    fn thread_id(&self, lines: &[Value], path: &Path) -> String {
        for line in lines {
            if let Some(id) = line
                .get("payload")
                .and_then(|payload| payload.get("id"))
                .and_then(Value::as_str)
            {
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
            if let Some(cwd) = line
                .get("payload")
                .and_then(|payload| payload.get("cwd"))
                .and_then(Value::as_str)
            {
                return cwd.to_string();
            }
        }
        String::new()
    }

    fn blocks(&self, lines: &[Value], file_key: &str) -> Vec<TimelineBlock> {
        let mut blocks = Vec::new();

        for (line_index, line) in lines.iter().enumerate() {
            let Some(payload) = line.get("payload") else {
                continue;
            };

            match payload.get("type").and_then(Value::as_str).unwrap_or_default() {
                "user_message" => blocks.push(TimelineBlock {
                    id: format!("{line_index}:user"),
                    role: "user".to_string(),
                    content: payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    editable: true,
                    edit_target: format!("{file_key}::{line_index}"),
                    source_meta: json!({ "lineIndex": line_index }),
                }),
                "agent_message" => blocks.push(TimelineBlock {
                    id: format!("{line_index}:assistant"),
                    role: "assistant".to_string(),
                    content: payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    editable: true,
                    edit_target: format!("{file_key}::{line_index}"),
                    source_meta: json!({ "lineIndex": line_index }),
                }),
                _ => {}
            }
        }

        blocks
    }
}

impl PlatformAdapter for CodexPlatform {
    fn list_sessions(&self, alias_map: &HashMap<String, String>, limit: Option<usize>, offset: usize) -> SessionListResult {
        if !self.sessions_root.exists() {
            return SessionListResult { total: 0, items: Vec::new() };
        }

        let mut entries = Vec::new();
        collect_jsonl_recursive(&self.sessions_root, &mut entries);
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
                platform: "codex".to_string(),
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
        let thread_id = self.thread_id(&lines, path);
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();

        Ok(SessionDetail {
            platform: "codex".to_string(),
            session_key: session_key.to_string(),
            session_id: thread_id.clone(),
            title: if alias.is_empty() {
                thread_id.clone()
            } else {
                alias.clone()
            },
            alias_title: alias,
            cwd: self.cwd(&lines),
            commands: build_commands("codex", &thread_id),
            blocks: self.blocks(&lines, session_key),
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        if parts.len() != 2 {
            return Err(format!("Invalid edit target: {edit_target}"));
        }

        let path = Path::new(parts[0]);
        let line_index: usize = parts[1]
            .parse()
            .map_err(|error| format!("Invalid line index: {error}"))?;
        let mut rows = self.read_jsonl(path);

        let Some(row) = rows.get_mut(line_index) else {
            return Err("Line index out of range".to_string());
        };
        let Some(payload) = row.get_mut("payload") else {
            return Err("Missing payload".to_string());
        };

        let old_content = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        payload["message"] = Value::String(new_content.to_string());

        let serialized = rows
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Serialize error: {error}"))?;

        fs::write(path, format!("{}\n", serialized.join("\n")))
            .map_err(|error| format!("Write error: {error}"))?;

        Ok(old_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return true;
        }

        let lines = self.read_jsonl(Path::new(session_key));
        lines.iter().any(|line| {
            line.get("payload")
                .and_then(|payload| payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase()
                .contains(&needle)
        })
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
