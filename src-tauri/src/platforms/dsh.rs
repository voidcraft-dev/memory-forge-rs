use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use super::{
    build_commands, extract_snippet, tool_text_from_str, tool_text_from_value, ContentMatch,
    SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock, ToolCallBlock,
};

/// DeepSeek Harness keeps one append-only event log per session:
/// `<home>/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`.
/// Events are newline-delimited JSON, compressed with zstd.
pub struct DshPlatform {
    home: PathBuf,
}

struct SessionFile {
    key: String,
    session_id: String,
    file: PathBuf,
    updated_ms: i64,
}

impl DshPlatform {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn sessions_root(&self) -> PathBuf {
        self.home.join("sessions")
    }

    fn scan_sessions(&self) -> Vec<SessionFile> {
        let mut sessions = Vec::new();
        let Ok(workspaces) = fs::read_dir(self.sessions_root()) else {
            return sessions;
        };
        for workspace in workspaces.flatten() {
            let workspace_path = workspace.path();
            if !workspace_path.is_dir() {
                continue;
            }
            let workspace_name = workspace.file_name().to_string_lossy().to_string();
            let Ok(dirs) = fs::read_dir(&workspace_path) else {
                continue;
            };
            for entry in dirs.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let Some(file) = session_log_path(&dir) else {
                    continue;
                };
                let session_id = entry.file_name().to_string_lossy().to_string();
                let updated_ms = fs::metadata(&file)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0);
                sessions.push(SessionFile {
                    key: format!("{workspace_name}/{session_id}"),
                    session_id,
                    file,
                    updated_ms,
                });
            }
        }
        sessions
    }

    fn path_for_key(&self, session_key: &str) -> Option<PathBuf> {
        let (workspace, session_id) = session_key.split_once('/')?;
        if workspace.contains("..") || session_id.contains("..") {
            return None;
        }
        self.scan_sessions()
            .into_iter()
            .find(|session| session.key == session_key)
            .map(|session| session.file)
    }

    fn read_events(&self, session_key: &str) -> Result<Vec<Value>, String> {
        let path = self
            .path_for_key(session_key)
            .ok_or_else(|| format!("DSH session not found: {session_key}"))?;
        decode_events(&path)
    }

    fn read_prefix_events(&self, path: &Path, max_bytes: usize) -> Vec<Value> {
        let Ok(file) = File::open(path) else {
            return Vec::new();
        };
        let Ok(mut decoder) = zstd::stream::read::Decoder::new(file) else {
            return Vec::new();
        };
        let mut data = Vec::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        while data.len() < max_bytes {
            match decoder.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => data.extend_from_slice(&buffer[..read]),
                Err(_) => break,
            }
        }
        parse_complete_lines(&data)
    }

    fn session_meta(&self, session: &SessionFile) -> SessionMeta {
        let events = self.read_prefix_events(&session.file, 512 * 1024);
        let mut meta = SessionMeta {
            title: String::new(),
            cwd: String::new(),
            preview: String::new(),
        };
        for event in &events {
            match event.get("type").and_then(Value::as_str) {
                Some("session") => {
                    if let Some(cwd) = event.get("cwd").and_then(Value::as_str) {
                        meta.cwd = cwd.to_string();
                    }
                }
                Some("session/title") => {
                    if let Some(title) = event
                        .get("data")
                        .and_then(|data| data.get("title"))
                        .and_then(Value::as_str)
                    {
                        if !title.trim().is_empty() {
                            meta.title = title.to_string();
                        }
                    }
                }
                Some("user/message") => {
                    if meta.preview.is_empty() {
                        if let Some(message) = event.get("data") {
                            if is_real_user_message(message) {
                                meta.preview = message_text(message);
                            }
                        }
                    }
                }
                Some("agent/inbox/spliced") => {
                    if meta.preview.is_empty() {
                        if let Some(items) = event
                            .get("data")
                            .and_then(|data| data.get("inserted"))
                            .and_then(Value::as_array)
                        {
                            if let Some(message) =
                                items.iter().find(|message| is_real_user_message(message))
                            {
                                meta.preview = message_text(message);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if meta.preview.chars().count() > 160 {
            meta.preview = meta.preview.chars().take(160).collect::<String>() + "...";
        }
        if meta.title.is_empty() {
            meta.title = if meta.preview.is_empty() {
                session.session_id.clone()
            } else {
                meta.preview.chars().take(60).collect()
            };
        }
        meta
    }
}

struct SessionMeta {
    title: String,
    cwd: String,
    preview: String,
}

fn session_log_path(dir: &Path) -> Option<PathBuf> {
    for name in ["session.v4.jsonl.zstd", "session.jsonl.zstd"] {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn decode_events(path: &Path) -> Result<Vec<Value>, String> {
    let compressed =
        fs::read(path).map_err(|error| format!("Failed to read DSH session: {error}"))?;
    let raw = zstd::stream::decode_all(compressed.as_slice())
        .map_err(|error| format!("Failed to decompress DSH session: {error}"))?;
    Ok(parse_complete_lines(&raw))
}

fn parse_complete_lines(data: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(data);
    let mut events = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            events.push(event);
        }
    }
    events
}

fn is_real_user_message(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("user")
        && message
            .get("source")
            .and_then(|source| source.get("kind"))
            .and_then(Value::as_str)
            == Some("user")
}

fn content_text(message: &Value) -> String {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .filter(|text| !text.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn message_text(message: &Value) -> String {
    content_text(message)
}

fn message_id(message: &Value) -> Option<String> {
    message
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn tool_results(events: &[Value]) -> HashMap<String, Value> {
    let mut results = HashMap::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("tool/result") {
            continue;
        }
        let Some(message) = event.get("data").and_then(|data| data.get("message")) else {
            continue;
        };
        let Some(call_id) = message.get("toolCallId").and_then(Value::as_str) else {
            continue;
        };
        results.insert(call_id.to_string(), message.clone());
    }
    results
}

fn tool_block(call: &Value, result: Option<&Value>) -> ToolCallBlock {
    let call_id = call
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let is_error = result
        .and_then(|result| result.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output = result.map(content_text).filter(|text| !text.is_empty());
    ToolCallBlock {
        id: call_id,
        name: call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_call".into(),
        status: if result.is_some() {
            if is_error { "error" } else { "completed" }.to_string()
        } else {
            "requested".to_string()
        },
        input: call
            .get("arguments")
            .and_then(Value::as_str)
            .and_then(|arguments| tool_text_from_str(arguments, 8192))
            .or_else(|| {
                call.get("arguments")
                    .and_then(|arguments| tool_text_from_value(arguments, 8192))
            }),
        output,
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({"callId": call.get("id").cloned().unwrap_or(Value::Null)}),
    }
}

fn push_user_message(
    message: &Value,
    session_key: &str,
    seen: &mut HashSet<String>,
    blocks: &mut Vec<TimelineBlock>,
) {
    let Some(id) = message_id(message) else {
        return;
    };
    if !seen.insert(id.clone()) {
        return;
    }
    let Some(items) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    for (index, item) in items.iter().enumerate() {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                blocks.push(TimelineBlock {
                    id: format!("{id}:{index}"),
                    role: "user".into(),
                    content: text.to_string(),
                    editable: true,
                    edit_target: format!("{session_key}::{id}::{index}::text"),
                    source_meta: json!({"messageId": id, "contentIndex": index}),
                    tool_calls: Vec::new(),
                });
            }
            Some("image") => {
                blocks.push(TimelineBlock {
                    id: format!("{id}:{index}"),
                    role: "user".into(),
                    content: "[图片]".into(),
                    editable: false,
                    edit_target: String::new(),
                    source_meta: json!({
                        "messageId": id,
                        "contentIndex": index,
                        "itemType": "image",
                    }),
                    tool_calls: Vec::new(),
                });
            }
            _ => {}
        }
    }
}

fn build_blocks(events: &[Value], session_key: &str) -> Vec<TimelineBlock> {
    let results = tool_results(events);
    let mut blocks: Vec<TimelineBlock> = Vec::new();
    let mut seen_users: HashSet<String> = HashSet::new();
    let mut pending_tools: Vec<ToolCallBlock> = Vec::new();

    for event in events {
        match event.get("type").and_then(Value::as_str) {
            Some("user/message") => {
                if let Some(message) = event.get("data") {
                    if is_real_user_message(message) {
                        push_user_message(message, session_key, &mut seen_users, &mut blocks);
                    }
                }
            }
            Some("agent/inbox/spliced") => {
                if let Some(items) = event
                    .get("data")
                    .and_then(|data| data.get("inserted"))
                    .and_then(Value::as_array)
                {
                    for message in items {
                        if is_real_user_message(message) {
                            push_user_message(message, session_key, &mut seen_users, &mut blocks);
                        }
                    }
                }
            }
            Some("assistant/message") => {
                let Some(message) = event.get("data").and_then(|data| data.get("message")) else {
                    continue;
                };
                let Some(id) = message_id(message) else {
                    continue;
                };
                let Some(items) = message.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for (index, item) in items.iter().enumerate() {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            let mut block = TimelineBlock {
                                id: format!("{id}:{index}"),
                                role: "assistant".into(),
                                content: text.to_string(),
                                editable: true,
                                edit_target: format!("{session_key}::{id}::{index}::text"),
                                source_meta: json!({
                                    "messageId": id,
                                    "contentIndex": index,
                                }),
                                tool_calls: Vec::new(),
                            };
                            block.tool_calls.append(&mut pending_tools);
                            blocks.push(block);
                        }
                        Some("reasoning") => {
                            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            blocks.push(TimelineBlock {
                                id: format!("{id}:{index}"),
                                role: "thinking".into(),
                                content: text.to_string(),
                                editable: true,
                                edit_target: format!("{session_key}::{id}::{index}::thinking"),
                                source_meta: json!({
                                    "messageId": id,
                                    "contentIndex": index,
                                }),
                                tool_calls: Vec::new(),
                            });
                        }
                        Some("tool-call") => {
                            let call_id = item
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let tool = tool_block(item, results.get(&call_id));
                            match blocks.last_mut() {
                                Some(last)
                                    if last.role == "assistant"
                                        && last.source_meta.get("messageId")
                                            == Some(&Value::String(id.clone())) =>
                                {
                                    last.tool_calls.push(tool);
                                }
                                _ => pending_tools.push(tool),
                            }
                        }
                        _ => {}
                    }
                }
                if !pending_tools.is_empty() {
                    if let Some(last) = blocks.last_mut() {
                        if last.role == "assistant"
                            && last.source_meta.get("messageId") == Some(&Value::String(id.clone()))
                        {
                            last.tool_calls.append(&mut pending_tools);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if !pending_tools.is_empty() {
        blocks.push(TimelineBlock {
            id: "tool-calls".into(),
            role: "assistant".into(),
            content: String::new(),
            editable: false,
            edit_target: String::new(),
            source_meta: json!({"itemType": "tool_calls"}),
            tool_calls: pending_tools,
        });
    }

    blocks
}

impl super::PlatformAdapter for DshPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let mut sessions = self.scan_sessions();
        sessions.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));

        let items: Vec<SessionListItem> = sessions
            .iter()
            .map(|session| {
                let meta = self.session_meta(session);
                let alias = alias_map.get(&session.key).cloned().unwrap_or_default();
                let display_title = if alias.is_empty() {
                    meta.title.clone()
                } else {
                    alias.clone()
                };
                SessionListItem {
                    platform: "dsh".into(),
                    session_key: session.key.clone(),
                    session_id: session.session_id.clone(),
                    display_title,
                    alias_title: alias,
                    preview: meta.preview,
                    updated_at: session.updated_ms.to_string(),
                    cwd: meta.cwd,
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                    source_label: String::new(),
                    agent_group: None,
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

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        Some(
            self.scan_sessions()
                .into_iter()
                .map(|session| SessionKey::standalone(session.key, session.updated_ms as i128))
                .collect(),
        )
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        _cache: Option<&crate::database::SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        let session = self
            .scan_sessions()
            .into_iter()
            .find(|session| session.key == session_key)?;
        let meta = self.session_meta(&session);
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let display_title = if alias.is_empty() {
            meta.title.clone()
        } else {
            alias.clone()
        };
        Some(SessionListItem {
            platform: "dsh".into(),
            session_key: session.key,
            session_id: session.session_id,
            display_title,
            alias_title: alias,
            preview: meta.preview,
            updated_at: session.updated_ms.to_string(),
            cwd: meta.cwd,
            editable: true,
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
            source_label: String::new(),
            agent_group: None,
        })
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let events = self.read_events(session_key)?;
        let session = self
            .scan_sessions()
            .into_iter()
            .find(|session| session.key == session_key);
        let meta = session.as_ref().map(|session| self.session_meta(session));
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = meta
            .as_ref()
            .map(|meta| meta.title.clone())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| session_key.to_string());
        let title = if alias.is_empty() {
            title
        } else {
            alias.clone()
        };
        let cwd = meta.map(|meta| meta.cwd).unwrap_or_default();

        Ok(SessionDetail {
            platform: "dsh".into(),
            session_key: session_key.to_string(),
            session_id: session_key
                .split_once('/')
                .map(|(_, id)| id.to_string())
                .unwrap_or_else(|| session_key.to_string()),
            title,
            alias_title: alias,
            cwd,
            commands: build_commands("dsh", session_key),
            blocks: build_blocks(&events, session_key),
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        if parts.len() != 4 {
            return Err(format!("Invalid DSH edit target: {edit_target}"));
        }
        let session_key = parts[0];
        let message_id = parts[1];
        let content_index: usize = parts[2]
            .parse()
            .map_err(|error| format!("Invalid content index: {error}"))?;
        let field = parts[3];

        let path = self
            .path_for_key(session_key)
            .ok_or_else(|| format!("DSH session not found: {session_key}"))?;
        let mut events = decode_events(&path)?;
        let mut old: Option<String> = None;

        for event in events.iter_mut() {
            match event.get("type").and_then(Value::as_str) {
                Some("user/message") => {
                    if let Some(data) = event.get_mut("data") {
                        if data.get("id").and_then(Value::as_str) == Some(message_id) {
                            old = mutate_content(data, content_index, field, new_content).or(old);
                        }
                    }
                }
                Some("agent/inbox/spliced") => {
                    if let Some(items) = event
                        .get_mut("data")
                        .and_then(|data| data.get_mut("inserted"))
                        .and_then(Value::as_array_mut)
                    {
                        for message in items.iter_mut() {
                            if message.get("id").and_then(Value::as_str) == Some(message_id) {
                                old = mutate_content(message, content_index, field, new_content)
                                    .or(old);
                            }
                        }
                    }
                }
                Some("assistant/message") => {
                    if let Some(message) = event
                        .get_mut("data")
                        .and_then(|data| data.get_mut("message"))
                    {
                        if message.get("id").and_then(Value::as_str) == Some(message_id) {
                            old =
                                mutate_content(message, content_index, field, new_content).or(old);
                        }
                    }
                }
                _ => {}
            }
        }

        let old = old.ok_or_else(|| format!("DSH message not found: {edit_target}"))?;
        let mut output = String::new();
        for event in &events {
            let line = serde_json::to_string(event)
                .map_err(|error| format!("Serialize error: {error}"))?;
            output.push_str(&line);
            output.push('\n');
        }
        let compressed = zstd::stream::encode_all(output.as_bytes(), 3)
            .map_err(|error| format!("Compress error: {error}"))?;
        fs::write(&path, compressed)
            .map_err(|error| format!("Failed to write DSH session: {error}"))?;
        Ok(old)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return true;
        }
        let Ok(events) = self.read_events(session_key) else {
            return false;
        };
        let meta = self
            .scan_sessions()
            .into_iter()
            .find(|session| session.key == session_key)
            .map(|session| self.session_meta(&session));
        if let Some(meta) = &meta {
            if meta.title.to_lowercase().contains(&needle)
                || meta.cwd.to_lowercase().contains(&needle)
                || meta.preview.to_lowercase().contains(&needle)
            {
                return true;
            }
        }
        build_blocks(&events, session_key).iter().any(|block| {
            block.content.to_lowercase().contains(&needle)
                || block.tool_calls.iter().any(|tool| {
                    tool.output
                        .as_deref()
                        .map(|text| text.to_lowercase().contains(&needle))
                        .unwrap_or(false)
                        || tool
                            .input
                            .as_deref()
                            .map(|text| text.to_lowercase().contains(&needle))
                            .unwrap_or(false)
                })
        })
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return vec![];
        }
        let Ok(events) = self.read_events(session_key) else {
            return vec![];
        };
        let mut matches = Vec::new();
        for (index, block) in build_blocks(&events, session_key).into_iter().enumerate() {
            if block.content.to_lowercase().contains(&needle) {
                matches.push(ContentMatch {
                    snippet: extract_snippet(&block.content, &needle),
                    match_index: index,
                    role: block.role.clone(),
                });
            }
            for tool in &block.tool_calls {
                let texts = [tool.output.as_deref(), tool.input.as_deref()];
                if let Some(text) = texts
                    .into_iter()
                    .flatten()
                    .find(|text| text.to_lowercase().contains(&needle))
                {
                    matches.push(ContentMatch {
                        snippet: extract_snippet(text, &needle),
                        match_index: index,
                        role: "tool".into(),
                    });
                }
            }
        }
        matches
    }
}

fn mutate_content(
    message: &mut Value,
    content_index: usize,
    field: &str,
    new_content: &str,
) -> Option<String> {
    let item = message
        .get_mut("content")
        .and_then(Value::as_array_mut)?
        .get_mut(content_index)?;
    match (item.get("type").and_then(Value::as_str), field) {
        (Some("text"), "text") => {
            let old = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            item["text"] = Value::String(new_content.to_string());
            Some(old)
        }
        (Some("reasoning"), "thinking") => {
            let old = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            item["text"] = Value::String(new_content.to_string());
            Some(old)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use uuid::Uuid;

    const TITLE: &str = "测试 DSH 会话";

    fn write_session(home: &Path, title: &str) {
        let dir = home
            .join("sessions")
            .join("--E-workspace--")
            .join("session-test-1");
        fs::create_dir_all(&dir).expect("create session dir");
        let events = vec![
            json!({"type":"session","version":4,"id":"session-test-1","createdAt":1700000000000_i64,"cwd":"E:\\workspace"}),
            json!({"type":"agent/inbox/spliced","seq":1,"time":1700000001000_i64,"data":{
                "target":"next-step","start":0,"inserted":[{
                    "role":"user","id":"user-1",
                    "source":{"kind":"user"},
                    "content":[{"type":"text","text":"帮我看看这个项目"}]
                }]
            }}),
            json!({"type":"user/message","seq":1,"time":1700000001000_i64,"data":{
                "role":"user","id":"user-1",
                "source":{"kind":"user"},
                "content":[{"type":"text","text":"帮我看看这个项目"}]
            }}),
            json!({"type":"assistant/message","seq":2,"time":1700000002000_i64,"data":{
                "turn":1,"step":1,
                "message":{
                    "role":"assistant","id":"assistant-1",
                    "source":{"kind":"model"},
                    "content":[
                        {"type":"reasoning","text":"先读文件"},
                        {"type":"text","text":"好的，我先看看。"},
                        {"type":"tool-call","id":"call-1","name":"read","arguments":"{\"file_path\":\"a.md\"}"}
                    ]
                }
            }}),
            json!({"type":"tool/result","seq":3,"time":1700000003000_i64,"data":{
                "turn":1,"step":1,
                "message":{
                    "role":"tool","id":"result-1","toolCallId":"call-1","isError":false,
                    "source":{"kind":"tool","callId":"call-1"},
                    "content":[{"type":"text","text":"file body"}]
                }
            }}),
            json!({"type":"session/title","seq":4,"time":1700000004000_i64,"data":{
                "title":title,"messageSeqs":[1],"source":{"kind":"fallback"}
            }}),
        ];
        let mut text = String::new();
        for event in events {
            text.push_str(&serde_json::to_string(&event).unwrap());
            text.push('\n');
        }
        let compressed = zstd::stream::encode_all(text.as_bytes(), 3).unwrap();
        fs::write(dir.join("session.v4.jsonl.zstd"), compressed).expect("write session");
    }

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("dsh-{label}-{}", Uuid::new_v4()));
        write_session(&home, TITLE);
        home
    }

    #[test]
    fn lists_and_parses_dsh_sessions() {
        let home = test_home("list");
        let platform = DshPlatform::new(home.clone());

        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(
            listed.items[0].session_key,
            "--E-workspace--/session-test-1"
        );
        assert_eq!(listed.items[0].display_title, TITLE);
        assert_eq!(listed.items[0].cwd, "E:\\workspace");
        assert_eq!(listed.items[0].preview, "帮我看看这个项目");

        let detail = platform
            .get_session_detail("--E-workspace--/session-test-1", &HashMap::new())
            .expect("detail");
        assert_eq!(detail.title, TITLE);
        assert_eq!(detail.blocks.len(), 3);
        assert_eq!(detail.blocks[0].role, "user");
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
    fn edits_user_message_in_all_copies() {
        let home = test_home("edit");
        let platform = DshPlatform::new(home.clone());

        let old = platform
            .update_message(
                "--E-workspace--/session-test-1::user-1::0::text",
                "换个问题",
            )
            .expect("update");
        assert_eq!(old, "帮我看看这个项目");

        let events = platform
            .read_events("--E-workspace--/session-test-1")
            .expect("reread");
        let spliced = events
            .iter()
            .find(|event| event["type"] == "agent/inbox/spliced")
            .expect("spliced");
        assert_eq!(
            spliced["data"]["inserted"][0]["content"][0]["text"],
            "换个问题"
        );
        let direct = events
            .iter()
            .find(|event| event["type"] == "user/message")
            .expect("user message");
        assert_eq!(direct["data"]["content"][0]["text"], "换个问题");

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn edits_assistant_reasoning() {
        let home = test_home("thinking");
        let platform = DshPlatform::new(home.clone());

        let old = platform
            .update_message(
                "--E-workspace--/session-test-1::assistant-1::0::thinking",
                "直接打开",
            )
            .expect("update");
        assert_eq!(old, "先读文件");

        let detail = platform
            .get_session_detail("--E-workspace--/session-test-1", &HashMap::new())
            .expect("detail");
        assert_eq!(detail.blocks[1].content, "直接打开");

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn searches_titles_and_messages() {
        let home = test_home("search");
        let platform = DshPlatform::new(home.clone());

        assert!(platform.matches_query("--E-workspace--/session-test-1", "测试"));
        assert!(platform.matches_query("--E-workspace--/session-test-1", "file body"));
        assert!(!platform.matches_query("--E-workspace--/session-test-1", "不存在的词"));
        assert!(platform
            .content_search("--E-workspace--/session-test-1", "不存在的词")
            .is_empty());

        fs::remove_dir_all(&home).ok();
    }
}
