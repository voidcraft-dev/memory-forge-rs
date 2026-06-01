use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::database::{CachedSessionSummary, SessionSummaryCache};

use super::{
    build_commands, tool_text_from_str, tool_text_from_value, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem,
    SessionListResult, TimelineBlock, ToolCallBlock,
};

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

    fn cached_scan_summary(
        &self,
        path: &Path,
        session_key: &str,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> ScanSummary {
        let Some(cache) = cache else {
            return self.scan_summary(path);
        };
        let Some(fingerprint) = SessionSummaryCache::fingerprint(path) else {
            return self.scan_summary(path);
        };

        if let Some(cached) = cache.get("claude", session_key, &fingerprint) {
            return ScanSummary {
                session_id: cached.session_id,
                cwd: cached.cwd,
                preview: cached.preview,
            };
        }

        let summary = self.scan_summary(path);
        let cached = CachedSessionSummary {
            session_id: summary.session_id.clone(),
            title: String::new(),
            preview: summary.preview.clone(),
            updated_at: modified_nanos(path).to_string(),
            cwd: summary.cwd.clone(),
        };
        let _ = cache.upsert("claude", session_key, &fingerprint, &cached);
        summary
    }

    fn list_sessions_inner(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListResult {
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
            let summary = self.cached_scan_summary(path, &session_key, cache);
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
        let mut pending_tool_calls = Vec::new();

        for (line_index, line) in lines.iter().enumerate() {
            let Some(message) = line.get("message") else {
                continue;
            };

            let Some(role) = message.get("role").and_then(Value::as_str) else {
                continue;
            };

            if let Some(text) = message.get("content").and_then(Value::as_str) {
                if role == "user" || role == "assistant" {
                    let block = TimelineBlock {
                        id: format!("{line_index}:0:{role}"),
                        role: role.to_string(),
                        content: text.to_string(),
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}::0::content"),
                        source_meta: json!({
                            "lineIndex": line_index,
                            "contentIndex": 0,
                        }),
                        tool_calls: Vec::new(),
                    };
                    push_claude_block(&mut blocks, &mut pending_tool_calls, block);
                }
                continue;
            }

            let Some(items) = message.get("content").and_then(Value::as_array) else {
                continue;
            };

            for (content_index, item) in items.iter().enumerate() {
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();

                match (role, item_type) {
                    ("user", "text") => {
                        let block = TimelineBlock {
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
                            tool_calls: Vec::new(),
                        };
                        push_claude_block(&mut blocks, &mut pending_tool_calls, block);
                    }
                    ("assistant", "text") => {
                        let block = TimelineBlock {
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
                            tool_calls: Vec::new(),
                        };
                        push_claude_block(&mut blocks, &mut pending_tool_calls, block);
                    }
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
                            tool_calls: Vec::new(),
                        });
                    }
                    ("assistant", "tool_use") => {
                        let tool_call = claude_tool_use_to_block(item, line_index, content_index);
                        push_claude_tool_call(&mut blocks, &mut pending_tool_calls, tool_call);
                    }
                    (_, "tool_result") => {
                        let tool_call = claude_tool_result_to_block(item, line_index, content_index);
                        push_claude_tool_result(&mut blocks, &mut pending_tool_calls, tool_call);
                    }
                    _ => {}
                }
            }
        }

        if !pending_tool_calls.is_empty() {
            flush_claude_tool_calls(&mut blocks, &mut pending_tool_calls);
        }

        blocks
    }
}

fn push_claude_block(
    blocks: &mut Vec<TimelineBlock>,
    pending_tool_calls: &mut Vec<ToolCallBlock>,
    mut block: TimelineBlock,
) {
    if block.role == "assistant" {
        append_or_merge_tool_calls(&mut block.tool_calls, pending_tool_calls);
    } else {
        flush_claude_tool_calls(blocks, pending_tool_calls);
    }
    blocks.push(block);
}

fn push_claude_tool_call(
    blocks: &mut [TimelineBlock],
    pending: &mut Vec<ToolCallBlock>,
    tool_call: ToolCallBlock,
) {
    let tool_line_index = source_line_index(&tool_call.source_meta);
    if let Some(last_assistant) = blocks.iter_mut().rev().find(|block| {
        block.role == "assistant" && source_line_index(&block.source_meta) == tool_line_index
    }) {
        push_or_merge_tool_call(&mut last_assistant.tool_calls, tool_call);
    } else {
        push_or_merge_tool_call(pending, tool_call);
    }
}

fn push_claude_tool_result(
    blocks: &mut [TimelineBlock],
    pending: &mut Vec<ToolCallBlock>,
    tool_call: ToolCallBlock,
) {
    if merge_tool_call_in_blocks(blocks, &tool_call) {
        return;
    }
    push_or_merge_tool_call(pending, tool_call);
}

fn merge_tool_call_in_blocks(blocks: &mut [TimelineBlock], tool_call: &ToolCallBlock) -> bool {
    for block in blocks.iter_mut().rev().filter(|block| block.role == "assistant") {
        if let Some(existing) = block
            .tool_calls
            .iter_mut()
            .find(|existing| existing.id == tool_call.id)
        {
            merge_tool_call(existing, tool_call.clone());
            return true;
        }
    }
    false
}

fn source_line_index(source_meta: &Value) -> Option<u64> {
    source_meta.get("lineIndex").and_then(Value::as_u64)
}

fn flush_claude_tool_calls(
    blocks: &mut Vec<TimelineBlock>,
    pending: &mut Vec<ToolCallBlock>,
) {
    if pending.is_empty() {
        return;
    }

    if let Some(last) = blocks.last_mut() {
        if last.role == "assistant" {
            append_or_merge_tool_calls(&mut last.tool_calls, pending);
            return;
        }
    }

    let line_indices = collect_tool_line_indices(pending);
    let first_line_index = line_indices.first().copied().unwrap_or(blocks.len() as u64);
    let mut block = TimelineBlock {
        id: format!("{first_line_index}:tool-calls:assistant"),
        role: "assistant".to_string(),
        content: String::new(),
        editable: false,
        edit_target: String::new(),
        source_meta: json!({
            "lineIndex": first_line_index,
            "lineIndices": line_indices,
            "itemType": "tool_calls",
        }),
        tool_calls: Vec::new(),
    };
    append_or_merge_tool_calls(&mut block.tool_calls, pending);
    blocks.push(block);
}

fn collect_tool_line_indices(tool_calls: &[ToolCallBlock]) -> Vec<u64> {
    let mut line_indices = Vec::new();
    for tool_call in tool_calls {
        if let Some(line_index) = source_line_index(&tool_call.source_meta) {
            line_indices.push(line_index);
        }
        if let Some(items) = tool_call
            .source_meta
            .get("lineIndices")
            .and_then(Value::as_array)
        {
            for item in items {
                if let Some(line_index) = item.as_u64() {
                    line_indices.push(line_index);
                }
            }
        }
    }
    line_indices.sort_unstable();
    line_indices.dedup();
    line_indices
}

fn append_or_merge_tool_calls(target: &mut Vec<ToolCallBlock>, pending: &mut Vec<ToolCallBlock>) {
    for tool_call in pending.drain(..) {
        push_or_merge_tool_call(target, tool_call);
    }
}

fn push_or_merge_tool_call(target: &mut Vec<ToolCallBlock>, tool_call: ToolCallBlock) {
    if let Some(existing) = target.iter_mut().find(|existing| existing.id == tool_call.id) {
        merge_tool_call(existing, tool_call);
    } else {
        target.push(tool_call);
    }
}

fn merge_tool_call(existing: &mut ToolCallBlock, incoming: ToolCallBlock) {
    if existing.name == "tool_result" && incoming.name != "tool_result" {
        existing.name = incoming.name;
    }

    if existing.kind == "tool_result" && incoming.kind != "tool_result" {
        existing.kind = incoming.kind;
    }

    if incoming.input.is_some() {
        existing.input = incoming.input;
    }
    if incoming.output.is_some() {
        existing.output = incoming.output;
    }
    if incoming.error.is_some() {
        existing.error = incoming.error;
    }
    if incoming.started_at.is_some() {
        existing.started_at = incoming.started_at;
    }
    if incoming.ended_at.is_some() {
        existing.ended_at = incoming.ended_at;
    }

    existing.status = if existing.error.is_some() || incoming.status == "error" {
        "error".to_string()
    } else if existing.output.is_some() {
        "completed".to_string()
    } else {
        "requested".to_string()
    };

    existing.source_meta = merge_tool_source_meta(&existing.source_meta, &incoming.source_meta);
}

fn merge_tool_source_meta(left: &Value, right: &Value) -> Value {
    let mut line_indices = Vec::new();
    for value in [left, right] {
        if let Some(line_index) = value.get("lineIndex").and_then(Value::as_u64) {
            line_indices.push(line_index);
        }
        if let Some(items) = value.get("lineIndices").and_then(Value::as_array) {
            for item in items {
                if let Some(line_index) = item.as_u64() {
                    line_indices.push(line_index);
                }
            }
        }
    }
    line_indices.sort_unstable();
    line_indices.dedup();

    json!({
        "itemType": "tool_use",
        "lineIndices": line_indices,
    })
}

fn claude_tool_use_to_block(item: &Value, line_index: usize, content_index: usize) -> ToolCallBlock {
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool_use")
        .to_string();
    ToolCallBlock {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:{content_index}:tool_use")),
        name,
        kind: "tool_use".to_string(),
        status: "requested".to_string(),
        input: item.get("input").and_then(|value| tool_text_from_value(value, 8192)),
        output: None,
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "lineIndex": line_index,
            "contentIndex": content_index,
            "itemType": "tool_use",
        }),
    }
}

fn claude_tool_result_to_block(item: &Value, line_index: usize, content_index: usize) -> ToolCallBlock {
    ToolCallBlock {
        id: item
            .get("tool_use_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:{content_index}:tool_result")),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool_result")
            .to_string(),
        kind: "tool_result".to_string(),
        status: if item.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
            "error".to_string()
        } else {
            "completed".to_string()
        },
        input: None,
        output: claude_tool_result_content(item),
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "lineIndex": line_index,
            "contentIndex": content_index,
            "itemType": "tool_result",
        }),
    }
}

fn claude_tool_result_content(item: &Value) -> Option<String> {
    let content = item.get("content")?;
    if let Some(text) = content.as_str() {
        return tool_text_from_str(text, 32768);
    }
    tool_text_from_value(content, 32768)
}

impl PlatformAdapter for ClaudePlatform {
    fn list_sessions(&self, alias_map: &HashMap<String, String>, limit: Option<usize>, offset: usize) -> SessionListResult {
        self.list_sessions_inner(alias_map, limit, offset, None)
    }

    fn list_sessions_with_cache(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListResult {
        self.list_sessions_inner(alias_map, limit, offset, cache)
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

            // Collect all searchable text from this message
            let mut texts = Vec::new();
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
            if let Some(items) = message.get("content").and_then(Value::as_array) {
                for item in items {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                    match item_type {
                        "text" => {
                            if let Some(t) = item.get("text").and_then(Value::as_str) {
                                texts.push(t.to_string());
                            }
                        }
                        "thinking" | "reasoning" => {
                            let t = item.get("thinking").or_else(|| item.get("text")).and_then(Value::as_str).unwrap_or("");
                            texts.push(t.to_string());
                        }
                        "tool_use" => {
                            if let Some(name) = item.get("name").and_then(Value::as_str) {
                                texts.push(name.to_string());
                            }
                            if let Some(input) = item.get("input") {
                                texts.push(input.to_string());
                            }
                        }
                        "tool_result" => {
                            if let Some(content) = item.get("content").and_then(Value::as_str) {
                                texts.push(content.to_string());
                            }
                            if let Some(arr) = item.get("content").and_then(Value::as_array) {
                                for sub in arr {
                                    if let Some(t) = sub.get("text").and_then(Value::as_str) {
                                        texts.push(t.to_string());
                                    }
                                }
                            }
                        }
                        _ => {}
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
            if path.file_name().and_then(|name| name.to_str()) == Some("subagents") {
                continue;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_attach_tool_use_and_result_to_conversation_block() {
        let platform = ClaudePlatform::new(PathBuf::from("unused"));
        let lines = vec![
            json!({
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "I will inspect the files." },
                        { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": { "file_path": "src/main.rs" } }
                    ]
                }
            }),
            json!({
                "message": {
                    "role": "user",
                    "content": [
                        { "type": "tool_result", "tool_use_id": "toolu_1", "content": "file contents" },
                        { "type": "text", "text": "continue" }
                    ]
                }
            }),
        ];

        let blocks = platform.blocks(&lines, "session.jsonl");

        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].role, "assistant");
        assert_eq!(blocks[0].tool_calls.len(), 1);
        assert_eq!(blocks[0].tool_calls[0].name, "Read");
        assert_eq!(blocks[0].tool_calls[0].kind, "tool_use");
        assert_eq!(blocks[0].tool_calls[0].status, "completed");
        assert_eq!(blocks[0].tool_calls[0].input.as_deref(), Some("{\n  \"file_path\": \"src/main.rs\"\n}"));
        assert_eq!(blocks[0].tool_calls[0].output.as_deref(), Some("file contents"));
        assert!(blocks[1].tool_calls.is_empty());
    }

    #[test]
    fn blocks_do_not_attach_tool_results_to_user_text() {
        let platform = ClaudePlatform::new(PathBuf::from("unused"));
        let lines = vec![
            json!({
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "I will search the repo." },
                        { "type": "tool_use", "id": "toolu_2", "name": "Grep", "input": { "pattern": "TODO" } }
                    ]
                }
            }),
            json!({
                "message": {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "continue" },
                        { "type": "tool_result", "tool_use_id": "toolu_2", "content": "src/main.rs: TODO" }
                    ]
                }
            }),
        ];

        let blocks = platform.blocks(&lines, "session.jsonl");

        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].role, "assistant");
        assert_eq!(blocks[0].tool_calls.len(), 1);
        assert_eq!(blocks[0].tool_calls[0].name, "Grep");
        assert_eq!(blocks[0].tool_calls[0].status, "completed");
        assert_eq!(blocks[0].tool_calls[0].input.as_deref(), Some("{\n  \"pattern\": \"TODO\"\n}"));
        assert_eq!(blocks[0].tool_calls[0].output.as_deref(), Some("src/main.rs: TODO"));
        assert_eq!(blocks[1].role, "user");
        assert!(blocks[1].tool_calls.is_empty());
    }

    #[test]
    fn blocks_keep_tool_only_assistant_messages_before_user_text() {
        let platform = ClaudePlatform::new(PathBuf::from("unused"));
        let lines = vec![
            json!({
                "message": {
                    "role": "user",
                    "content": "format this document"
                }
            }),
            json!({
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "tool_use", "id": "toolu_3", "name": "Read", "input": { "file_path": "doc.md" } }
                    ]
                }
            }),
            json!({
                "message": {
                    "role": "user",
                    "content": [
                        { "type": "tool_result", "tool_use_id": "toolu_3", "content": "doc contents" }
                    ]
                }
            }),
            json!({
                "message": {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "[Request interrupted by user]" }
                    ]
                }
            }),
            json!({
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "Now I can continue." }
                    ]
                }
            }),
        ];

        let blocks = platform.blocks(&lines, "session.jsonl");

        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].role, "user");
        assert_eq!(blocks[0].content, "format this document");
        assert!(blocks[0].tool_calls.is_empty());
        assert_eq!(blocks[1].role, "assistant");
        assert!(blocks[1].content.is_empty());
        assert_eq!(blocks[1].tool_calls.len(), 1);
        assert_eq!(blocks[1].tool_calls[0].name, "Read");
        assert_eq!(blocks[1].tool_calls[0].status, "completed");
        assert_eq!(blocks[1].tool_calls[0].output.as_deref(), Some("doc contents"));
        assert_eq!(blocks[2].role, "user");
        assert_eq!(blocks[2].content, "[Request interrupted by user]");
        assert!(blocks[2].tool_calls.is_empty());
        assert_eq!(blocks[3].role, "assistant");
        assert_eq!(blocks[3].content, "Now I can continue.");
        assert!(blocks[3].tool_calls.is_empty());
    }
}
