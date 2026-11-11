use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use super::{
    extract_snippet, tool_text_from_value, ContentMatch, PlatformAdapter, SessionDetail,
    SessionListItem, SessionListResult, TimelineBlock, ToolCallBlock,
};

/// Cline 4.x stores sessions under `<home>/data/sessions/<session-id>/`:
/// `<id>.json` holds the session metadata and `<id>.messages.json` holds the
/// conversation (`messages[].content[]` with text / reasoning / tool-call /
/// tool-result blocks).
pub struct ClinePlatform {
    cline_home: PathBuf,
}

struct ClineFile {
    session_id: String,
    meta_path: PathBuf,
    messages_path: PathBuf,
}

impl ClinePlatform {
    pub fn new(cline_home: PathBuf) -> Self {
        Self { cline_home }
    }

    fn sessions_root(&self) -> PathBuf {
        self.cline_home.join("data").join("sessions")
    }

    fn collect_session_files(&self) -> Vec<ClineFile> {
        let mut result = Vec::new();
        let Ok(entries) = fs::read_dir(self.sessions_root()) else {
            return result;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(session_id) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let meta_path = dir.join(format!("{session_id}.json"));
            let messages_path = dir.join(format!("{session_id}.messages.json"));
            if !meta_path.exists() || !messages_path.exists() {
                continue;
            }
            result.push(ClineFile {
                session_id: session_id.to_string(),
                meta_path,
                messages_path,
            });
        }
        result
    }

    fn scan_item(&self, file: &ClineFile, alias_map: &HashMap<String, String>) -> Option<SessionListItem> {
        let meta = read_json(&file.meta_path)?;
        let messages = read_json(&file.messages_path);
        let preview = messages
            .as_ref()
            .and_then(|messages| messages.get("messages"))
            .and_then(Value::as_array)
            .and_then(|messages| messages.iter().find_map(user_text))
            .unwrap_or_else(|| {
                meta.get("prompt")
                    .and_then(Value::as_str)
                    .map(strip_user_input)
                    .unwrap_or_default()
            });
        let title = meta
            .get("metadata")
            .and_then(|metadata| metadata.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                meta.get("prompt")
                    .and_then(Value::as_str)
                    .map(strip_user_input)
                    .filter(|prompt| !prompt.trim().is_empty())
            })
            .unwrap_or_else(|| file.session_id.clone());
        let alias_title = alias_map.get(&file.session_id).cloned().unwrap_or_default();
        let display_title = if alias_title.is_empty() {
            title.chars().take(60).collect()
        } else {
            alias_title.clone()
        };
        let cwd = meta
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let updated_at = messages
            .as_ref()
            .and_then(|messages| messages.get("updated_at"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| file_mtime_iso(&file.messages_path))
            .unwrap_or_default();

        Some(SessionListItem {
            platform: "cline".to_string(),
            session_key: file.session_id.clone(),
            session_id: file.session_id.clone(),
            display_title,
            alias_title,
            preview: preview.chars().take(200).collect(),
            updated_at,
            cwd,
            editable: true,
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
            agent_group: None,
        })
    }

    fn path_for(&self, session_id: &str) -> Option<(PathBuf, PathBuf)> {
        let dir = self.sessions_root().join(session_id);
        let messages = dir.join(format!("{session_id}.messages.json"));
        let meta = dir.join(format!("{session_id}.json"));
        if messages.exists() {
            Some((meta, messages))
        } else {
            None
        }
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn strip_user_input(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(start) = trimmed.find("<user_input") {
        if let Some(open_end) = trimmed[start..].find('>') {
            let inner_start = start + open_end + 1;
            if let Some(close_start) = trimmed.rfind("</user_input>") {
                if close_start >= inner_start {
                    return trimmed[inner_start..close_start].trim().to_string();
                }
            }
        }
    }
    trimmed.to_string()
}

fn wrap_user_input(original: &str, new_content: &str) -> String {
    if let Some(start) = original.find("<user_input") {
        if let Some(open_end) = original[start..].find('>') {
            let inner_start = start + open_end + 1;
            if let Some(close_start) = original.rfind("</user_input>") {
                if close_start >= inner_start {
                    let mut value = String::new();
                    value.push_str(&original[..inner_start]);
                    value.push_str(new_content);
                    value.push_str(&original[close_start..]);
                    return value;
                }
            }
        }
    }
    new_content.to_string()
}

fn message_ts(message: &Value) -> Option<String> {
    let ts = message.get("ts").and_then(Value::as_i64)?;
    chrono::DateTime::from_timestamp_millis(ts).map(|dt| dt.to_rfc3339())
}

fn user_text(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    message
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            let text = strip_user_input(item.get("text").and_then(Value::as_str)?);
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        })
}

fn cline_tool_call(item: &Value, message_index: usize, content_index: usize) -> ToolCallBlock {
    ToolCallBlock {
        id: item
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{message_index}:{content_index}:tool_call")),
        name: item
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_use".to_string(),
        status: "requested".to_string(),
        input: item.get("input").and_then(|input| tool_text_from_value(input, 8192)),
        output: None,
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "messageIndex": message_index,
            "contentIndex": content_index,
            "itemType": "tool-call",
        }),
    }
}

fn cline_tool_result(item: &Value, message_index: usize, content_index: usize) -> ToolCallBlock {
    let is_error = item
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ToolCallBlock {
        id: item
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{message_index}:{content_index}:tool_result")),
        name: item
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_result".to_string(),
        status: if is_error { "error" } else { "completed" }.to_string(),
        input: None,
        output: item.get("output").and_then(|output| tool_text_from_value(output, 32768)),
        error: is_error
            .then(|| {
                item.get("output")
                    .and_then(|output| tool_text_from_value(output, 4096))
            })
            .flatten(),
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "messageIndex": message_index,
            "contentIndex": content_index,
            "itemType": "tool-result",
        }),
    }
}

fn merge_result(blocks: &mut [TimelineBlock], result: &ToolCallBlock) -> bool {
    for block in blocks.iter_mut().rev() {
        if let Some(existing) = block
            .tool_calls
            .iter_mut()
            .find(|call| call.id == result.id)
        {
            existing.status = result.status.clone();
            existing.output = result.output.clone();
            existing.error = result.error.clone();
            return true;
        }
    }
    false
}

fn file_mtime_iso(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    chrono::DateTime::from_timestamp_millis(millis).map(|dt| dt.to_rfc3339())
}

impl PlatformAdapter for ClinePlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let mut items: Vec<SessionListItem> = self
            .collect_session_files()
            .iter()
            .filter_map(|file| self.scan_item(file, alias_map))
            .collect();

        items.sort_by(|a, b| {
            let left = chrono::DateTime::parse_from_rfc3339(&a.updated_at)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_default();
            let right = chrono::DateTime::parse_from_rfc3339(&b.updated_at)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_default();
            right.cmp(&left)
        });

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
        let (meta_path, messages_path) = self
            .path_for(session_key)
            .ok_or_else(|| format!("session not found: {session_key}"))?;
        let meta = read_json(&meta_path).unwrap_or_else(|| json!({}));
        let file = read_json(&messages_path)
            .ok_or_else(|| format!("cannot parse messages: {}", messages_path.display()))?;
        let messages = file
            .get("messages")
            .and_then(Value::as_array)
            .ok_or("messages field is not an array")?;

        let mut blocks: Vec<TimelineBlock> = Vec::new();
        let mut deferred_results: Vec<ToolCallBlock> = Vec::new();

        for (message_index, message) in messages.iter().enumerate() {
            let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
            if role != "user" && role != "assistant" {
                continue;
            }
            let timestamp = message_ts(message);
            let Some(content) = message.get("content").and_then(Value::as_array) else {
                continue;
            };

            let block_start = blocks.len();
            let mut calls: Vec<ToolCallBlock> = Vec::new();

            for (content_index, item) in content.iter().enumerate() {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                match item_type {
                    "text" => {
                        let raw = item.get("text").and_then(Value::as_str).unwrap_or_default();
                        let text = if role == "user" {
                            strip_user_input(raw)
                        } else {
                            raw.to_string()
                        };
                        if text.trim().is_empty() {
                            continue;
                        }
                        blocks.push(TimelineBlock {
                            id: format!("{message_index}:{content_index}:{role}"),
                            role: role.to_string(),
                            content: text,
                            editable: true,
                            edit_target: format!(
                                "{session_key}::{message_index}::{content_index}::text"
                            ),
                            source_meta: json!({
                                "messageIndex": message_index,
                                "contentIndex": content_index,
                                "createdAt": timestamp,
                            }),
                            tool_calls: Vec::new(),
                        });
                    }
                    "reasoning" | "thinking" => {
                        let text = item
                            .get("text")
                            .or_else(|| item.get("reasoning"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if text.trim().is_empty() {
                            continue;
                        }
                        blocks.push(TimelineBlock {
                            id: format!("{message_index}:{content_index}:thinking"),
                            role: "thinking".to_string(),
                            content: text.to_string(),
                            editable: true,
                            edit_target: format!(
                                "{session_key}::{message_index}::{content_index}::reasoning"
                            ),
                            source_meta: json!({
                                "messageIndex": message_index,
                                "contentIndex": content_index,
                                "createdAt": timestamp,
                            }),
                            tool_calls: Vec::new(),
                        });
                    }
                    "tool-call" => {
                        calls.push(cline_tool_call(item, message_index, content_index));
                    }
                    "tool-result" => {
                        let result = cline_tool_result(item, message_index, content_index);
                        if !merge_result(&mut blocks, &result) {
                            deferred_results.push(result);
                        }
                    }
                    _ => {}
                }
            }

            if !calls.is_empty() {
                if let Some(last) = blocks[block_start..]
                    .iter_mut()
                    .rev()
                    .find(|block| block.role == "assistant")
                {
                    last.tool_calls.append(&mut calls);
                } else {
                    blocks.push(TimelineBlock {
                        id: format!("{message_index}:tool-calls:assistant"),
                        role: "assistant".to_string(),
                        content: String::new(),
                        editable: false,
                        edit_target: String::new(),
                        source_meta: json!({
                            "messageIndex": message_index,
                            "itemType": "tool_calls",
                            "createdAt": timestamp,
                        }),
                        tool_calls: calls,
                    });
                }
            }
        }

        for result in deferred_results {
            if !merge_result(&mut blocks, &result) {
                blocks.push(TimelineBlock {
                    id: format!("tool-result:{}", result.id),
                    role: "assistant".to_string(),
                    content: String::new(),
                    editable: false,
                    edit_target: String::new(),
                    source_meta: json!({ "itemType": "tool_result" }),
                    tool_calls: vec![result],
                });
            }
        }

        let preview = messages.iter().find_map(user_text);
        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if !alias_title.is_empty() {
            alias_title.clone()
        } else {
            meta.get("metadata")
                .and_then(|metadata| metadata.get("title"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    meta.get("prompt")
                        .and_then(Value::as_str)
                        .map(strip_user_input)
                        .filter(|prompt| !prompt.trim().is_empty())
                })
                .or(preview)
                .unwrap_or_else(|| session_key.to_string())
                .chars()
                .take(60)
                .collect()
        };
        let cwd = meta
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        Ok(SessionDetail {
            platform: "cline".to_string(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title,
            cwd,
            commands: HashMap::new(),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        // {session_id}::{message_index}::{content_index}::{text|reasoning}
        let parts: Vec<&str> = edit_target.splitn(4, "::").collect();
        if parts.len() != 4 {
            return Err(format!("invalid edit_target: {edit_target}"));
        }
        let session_id = parts[0];
        let message_index = parts[1]
            .parse::<usize>()
            .map_err(|_| "invalid message index")?;
        let content_index = parts[2]
            .parse::<usize>()
            .map_err(|_| "invalid content index")?;
        let field = parts[3];
        if field != "text" && field != "reasoning" {
            return Err(format!("unknown field: {field}"));
        }

        let (_, messages_path) = self
            .path_for(session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        let raw = fs::read_to_string(&messages_path)
            .map_err(|e| format!("cannot read messages: {e}"))?;
        let mut file: Value =
            serde_json::from_str(&raw).map_err(|e| format!("cannot parse messages: {e}"))?;

        let item = file
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .and_then(|messages| messages.get_mut(message_index))
            .and_then(|message| message.get_mut("content"))
            .and_then(Value::as_array_mut)
            .and_then(|content| content.get_mut(content_index))
            .ok_or_else(|| format!("message {message_index}/{content_index} not found"))?;

        let text_key = if item.get("text").is_some() {
            "text"
        } else {
            "reasoning"
        };
        let old = item
            .get(text_key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let content = if field == "text" && old.contains("<user_input") {
            wrap_user_input(&old, new_content)
        } else {
            new_content.to_string()
        };
        item[text_key] = Value::String(content);

        file["updated_at"] = Value::String(chrono::Utc::now().to_rfc3339());
        let updated =
            serde_json::to_string(&file).map_err(|e| format!("cannot serialize messages: {e}"))?;
        fs::write(&messages_path, updated).map_err(|e| format!("cannot write messages: {e}"))?;

        Ok(if field == "text" {
            strip_user_input(&old)
        } else {
            old
        })
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let lower = query.to_lowercase();
        if session_key.to_lowercase().contains(&lower) {
            return true;
        }
        let Some((_, messages_path)) = self.path_for(session_key) else {
            return false;
        };
        let Ok(raw) = fs::read_to_string(messages_path) else {
            return false;
        };
        raw.to_lowercase().contains(&lower)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let Some((_, messages_path)) = self.path_for(session_key) else {
            return vec![];
        };
        let Some(file) = read_json(&messages_path) else {
            return vec![];
        };
        let Some(messages) = file.get("messages").and_then(Value::as_array) else {
            return vec![];
        };
        let lower = query.to_lowercase();

        messages
            .iter()
            .enumerate()
            .filter_map(|(idx, message)| {
                let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
                if role != "user" && role != "assistant" {
                    return None;
                }
                let mut texts = Vec::new();
                for item in message
                    .get("content")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    match item_type {
                        "text" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                texts.push(text.to_string());
                            }
                        }
                        "reasoning" | "thinking" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                texts.push(text.to_string());
                            }
                        }
                        "tool-call" => {
                            if let Some(name) = item.get("toolName").and_then(Value::as_str) {
                                texts.push(name.to_string());
                            }
                            if let Some(input) = item.get("input") {
                                texts.push(input.to_string());
                            }
                        }
                        "tool-result" => {
                            if let Some(name) = item.get("toolName").and_then(Value::as_str) {
                                texts.push(name.to_string());
                            }
                            if let Some(output) = item.get("output") {
                                texts.push(output.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                let best = texts
                    .iter()
                    .find(|text| text.to_lowercase().contains(&lower))?;
                if best.is_empty() {
                    return None;
                }
                Some(ContentMatch {
                    snippet: extract_snippet(best, &lower),
                    match_index: idx,
                    role: role.to_string(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("cline-{label}-{}", Uuid::new_v4()));
        let dir = home
            .join("data")
            .join("sessions")
            .join("1794368156948_gj2bx");
        fs::create_dir_all(&dir).expect("create session dir");

        let meta = json!({
            "version": 1,
            "session_id": "1794368156948_gj2bx",
            "source": "vscode",
            "cwd": "f:\\workspace\\akt20261012",
            "prompt": "你好",
            "metadata": {"title": "你好", "modelId": "cline-free/solar-mini4"}
        });
        let messages = json!({
            "version": 1,
            "updated_at": "2026-11-11T03:36:05.087Z",
            "messages": [
                {"id":"m1","role":"user","ts":1794368159522i64,"content":[
                    {"type":"text","text":"<user_input mode=\"act\">你好</user_input>"}
                ]},
                {"id":"m2","role":"assistant","ts":1794368164851i64,"content":[
                    {"type":"reasoning","text":"先读一下文件"},
                    {"type":"text","text":"你好，需要我做什么？"},
                    {"type":"tool-call","toolCallId":"call-1","toolName":"read_file","input":{"path":"a.md"}}
                ]},
                {"id":"m3","role":"user","ts":1794368165000i64,"content":[
                    {"type":"tool-result","toolCallId":"call-1","toolName":"read_file","output":"file body","isError":false}
                ]}
            ]
        });
        fs::write(
            dir.join("1794368156948_gj2bx.json"),
            serde_json::to_string(&meta).unwrap(),
        )
        .expect("write meta");
        fs::write(
            dir.join("1794368156948_gj2bx.messages.json"),
            serde_json::to_string(&messages).unwrap(),
        )
        .expect("write messages");
        home
    }

    #[test]
    fn lists_and_parses_cline_sessions() {
        let home = test_home("list");
        let platform = ClinePlatform::new(home.clone());

        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(listed.items[0].platform, "cline");
        assert_eq!(listed.items[0].display_title, "你好");
        assert_eq!(listed.items[0].preview, "你好");
        assert_eq!(listed.items[0].cwd, "f:\\workspace\\akt20261012");

        let detail = platform
            .get_session_detail(&listed.items[0].session_key, &HashMap::new())
            .expect("detail");
        assert_eq!(detail.platform, "cline");
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "你好");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(
            detail.blocks[2].tool_calls[0].output.as_deref(),
            Some("file body")
        );

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn edits_messages_and_preserves_user_input_wrapper() {
        let home = test_home("edit");
        let platform = ClinePlatform::new(home.clone());
        let detail = platform
            .get_session_detail("1794368156948_gj2bx", &HashMap::new())
            .expect("detail");

        let user_target = detail.blocks[0].edit_target.clone();
        assert_eq!(
            platform.update_message(&user_target, "换个问题").expect("edit user"),
            "你好"
        );
        let reasoning_target = detail.blocks[1].edit_target.clone();
        assert_eq!(
            platform
                .update_message(&reasoning_target, "重新想")
                .expect("edit reasoning"),
            "先读一下文件"
        );

        let detail = platform
            .get_session_detail("1794368156948_gj2bx", &HashMap::new())
            .expect("reread");
        assert_eq!(detail.blocks[0].content, "换个问题");
        assert_eq!(detail.blocks[1].content, "重新想");

        let meta = read_json(
            &home
                .join("data")
                .join("sessions")
                .join("1794368156948_gj2bx")
                .join("1794368156948_gj2bx.messages.json"),
        )
        .expect("reread raw");
        assert!(meta["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<user_input mode=\"act\">换个问题</user_input>"));

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn searches_cline_sessions() {
        let home = test_home("search");
        let platform = ClinePlatform::new(home.clone());

        assert!(platform.matches_query("1794368156948_gj2bx", "file body"));
        assert!(platform.matches_query("1794368156948_gj2bx", "你好"));
        assert!(!platform.matches_query("1794368156948_gj2bx", "不存在的词"));
        assert_eq!(
            platform.content_search("1794368156948_gj2bx", "file body").len(),
            1
        );
        assert!(platform
            .content_search("1794368156948_gj2bx", "不存在的词")
            .is_empty());

        fs::remove_dir_all(&home).ok();
    }
}

