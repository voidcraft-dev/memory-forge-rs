use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use super::{
    build_commands, tool_text_from_str, tool_text_from_value, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem,
    SessionListResult, TimelineBlock, ToolCallBlock,
};

pub struct CodexPlatform {
    sessions_root: PathBuf,
    project_root: Option<PathBuf>,
}

#[derive(Clone)]
struct SummaryData {
    session_id: String,
    cwd: String,
    preview: String,
}

impl CodexPlatform {
    pub fn new(codex_home: PathBuf, project_root: Option<PathBuf>) -> Self {
        Self {
            sessions_root: codex_home.join("sessions"),
            project_root,
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
        let mut pending_tool_calls = Vec::new();

        for (line_index, line) in lines.iter().enumerate() {
            let Some(payload) = line.get("payload") else {
                continue;
            };

            match payload.get("type").and_then(Value::as_str).unwrap_or_default() {
                "user_message" => {
                    let mut block = TimelineBlock {
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
                        tool_calls: Vec::new(),
                    };
                    block.tool_calls.append(&mut pending_tool_calls);
                    blocks.push(block);
                }
                "agent_message" => {
                    let mut block = TimelineBlock {
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
                        tool_calls: Vec::new(),
                    };
                    block.tool_calls.append(&mut pending_tool_calls);
                    blocks.push(block);
                }
                "function_call" => {
                    let tool_call = codex_function_call_to_block(payload, line_index);
                    pending_tool_calls.push(tool_call);
                }
                "function_call_output" => {
                    let tool_call = codex_function_output_to_block(payload, line_index);
                    pending_tool_calls.push(tool_call);
                }
                _ => {}
            }
        }

        if !pending_tool_calls.is_empty() {
            if let Some(last) = blocks.last_mut() {
                last.tool_calls.append(&mut pending_tool_calls);
            }
        }

        blocks
    }

    fn includes_project_cwd(&self, cwd: &str) -> bool {
        let Some(project_root) = &self.project_root else {
            return true;
        };
        path_is_within_root(cwd, project_root)
    }
}

fn codex_function_call_to_block(payload: &Value, line_index: usize) -> ToolCallBlock {
    ToolCallBlock {
        id: payload
            .get("call_id")
            .or_else(|| payload.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:function_call")),
        name: payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("function_call")
            .to_string(),
        kind: "function_call".to_string(),
        status: "requested".to_string(),
        input: payload
            .get("arguments")
            .or_else(|| payload.get("input"))
            .and_then(|value| tool_text_from_value(value, 8192)),
        output: None,
        error: None,
        started_at: payload.get("timestamp").and_then(Value::as_str).map(ToString::to_string),
        ended_at: None,
        source_meta: json!({
            "lineIndex": line_index,
            "payloadType": "function_call",
        }),
    }
}

fn codex_function_output_to_block(payload: &Value, line_index: usize) -> ToolCallBlock {
    ToolCallBlock {
        id: payload
            .get("call_id")
            .or_else(|| payload.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:function_call_output")),
        name: payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("function_call_output")
            .to_string(),
        kind: "function_call_output".to_string(),
        status: "completed".to_string(),
        input: None,
        output: payload
            .get("output")
            .and_then(|value| {
                value
                    .as_str()
                    .and_then(|text| tool_text_from_str(text, 32768))
                    .or_else(|| tool_text_from_value(value, 32768))
            }),
        error: payload.get("error").and_then(|value| tool_text_from_value(value, 8192)),
        started_at: None,
        ended_at: payload.get("timestamp").and_then(Value::as_str).map(ToString::to_string),
        source_meta: json!({
            "lineIndex": line_index,
            "payloadType": "function_call_output",
        }),
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

        if self.project_root.is_none() {
            let total = entries.len();
            let page = if offset < total {
                let end = limit.map(|l| (offset + l).min(total)).unwrap_or(total);
                &entries[offset..end]
            } else {
                &[]
            };

            let items = page
                .iter()
                .map(|path| self.session_item(path, alias_map))
                .collect();
            return SessionListResult { total, items };
        }

        let items: Vec<SessionListItem> = entries
            .iter()
            .filter_map(|path| {
                let item = self.session_item(path, alias_map);
                if self.includes_project_cwd(&item.cwd) {
                    Some(item)
                } else {
                    None
                }
            })
            .collect();
        let total = items.len();
        let items = items
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .collect();

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
            let Some(payload) = line.get("payload") else { continue };
            let msg_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            let role = match msg_type {
                "user_message" => "user",
                "agent_message" => "assistant",
                "function_call" | "function_call_output" => "assistant",
                _ => continue,
            };
            let mut texts = Vec::new();
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
            if let Some(name) = payload.get("name").and_then(Value::as_str) {
                texts.push(name.to_string());
            }
            if let Some(output) = payload.get("output").and_then(Value::as_str) {
                texts.push(output.to_string());
            }
            if let Some(args) = payload.get("arguments") {
                texts.push(args.to_string());
            }
            let combined = texts.join(" ").to_lowercase();
            if combined.contains(&needle) {
                let best_text = texts.iter().find(|t| t.to_lowercase().contains(&needle)).cloned().unwrap_or_default();
                matches.push(ContentMatch {
                    snippet: super::extract_snippet(&best_text, &needle),
                    match_index: msg_index,
                    role: role.into(),
                });
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

impl CodexPlatform {
    fn session_item(&self, path: &Path, alias_map: &HashMap<String, String>) -> SessionListItem {
        let session_key = encode_path_key(path);
        let summary = self.scan_summary(path);
        let alias = alias_map.get(&session_key).cloned().unwrap_or_default();

        SessionListItem {
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
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
        }
    }
}

fn path_is_within_root(path: &str, root: &Path) -> bool {
    let path = normalize_path_for_prefix(path);
    let root = normalize_path_for_prefix(&root.to_string_lossy());

    if path.is_empty() || root.is_empty() {
        return false;
    }

    path == root || path.starts_with(&format!("{root}/"))
}

fn normalize_path_for_prefix(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/");
    while value.ends_with('/') {
        value.pop();
    }
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_attach_function_calls_to_following_agent_message() {
        let platform = CodexPlatform::new(PathBuf::from("unused"), None);
        let lines = vec![
            json!({ "payload": { "type": "user_message", "message": "run tests" } }),
            json!({ "payload": { "type": "function_call", "call_id": "call_1", "name": "shell", "arguments": { "command": "cargo test" } } }),
            json!({ "payload": { "type": "function_call_output", "call_id": "call_1", "output": "ok" } }),
            json!({ "payload": { "type": "agent_message", "message": "Tests passed." } }),
        ];

        let blocks = platform.blocks(&lines, "session.jsonl");

        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].tool_calls.is_empty());
        assert_eq!(blocks[1].role, "assistant");
        assert_eq!(blocks[1].tool_calls.len(), 2);
        assert_eq!(blocks[1].tool_calls[0].name, "shell");
        assert_eq!(blocks[1].tool_calls[0].input.as_deref(), Some("{\n  \"command\": \"cargo test\"\n}"));
        assert_eq!(blocks[1].tool_calls[1].output.as_deref(), Some("ok"));
    }

    #[test]
    fn path_filter_matches_project_root_boundaries() {
        assert!(path_is_within_root(
            r"F:\workspacevk\project-a",
            Path::new(r"F:\workspacevk")
        ));
        assert!(path_is_within_root(
            r"F:\workspacevk",
            Path::new(r"F:\workspacevk")
        ));
        assert!(!path_is_within_root(
            r"F:\workspacevk-other\project-a",
            Path::new(r"F:\workspacevk")
        ));
    }

    #[test]
    fn list_sessions_filters_by_configured_project_root() {
        let root = std::env::temp_dir().join(format!(
            "memory-forge-codex-root-test-{}",
            std::process::id()
        ));
        let codex_home = root.join("codex-home");
        let sessions_dir = codex_home.join("sessions").join("2026");
        let project_root = root.join("workspace");
        let project_a = project_root.join("project-a");
        let other_project = root.join("other").join("project-b");
        fs::create_dir_all(&sessions_dir).expect("create sessions dir");

        fs::write(
            sessions_dir.join("inside.jsonl"),
            serde_json::to_string(&json!({
                "payload": {
                    "type": "user_message",
                    "id": "inside",
                    "cwd": project_a.display().to_string(),
                    "message": "inside"
                }
            })).expect("serialize inside session"),
        )
        .expect("write inside session");
        fs::write(
            sessions_dir.join("outside.jsonl"),
            serde_json::to_string(&json!({
                "payload": {
                    "type": "user_message",
                    "id": "outside",
                    "cwd": other_project.display().to_string(),
                    "message": "outside"
                }
            })).expect("serialize outside session"),
        )
        .expect("write outside session");

        let platform = CodexPlatform::new(codex_home, Some(project_root));
        let result = platform.list_sessions(&HashMap::new(), None, 0);

        fs::remove_dir_all(root).ok();

        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].session_id, "inside");
        assert_eq!(result.items[0].preview, "inside");
    }
}
