use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};

use crate::database::{
    CachedSessionSummary, SessionContentEntry, SessionContentIndex, SessionSummaryCache,
};

use super::safe_write::{splice_changed_strings, JsonlEditor, LineChange};
use super::{
    build_commands, content_entries_to_matches, push_bounded_index_entry, tool_text_from_str,
    tool_text_from_value, visit_bounded_jsonl_lines, ContentMatch, PlatformAdapter,
    SessionAgentGroup, SessionDetail, SessionKey, SessionListItem, SessionListResult,
    TimelineBlock, ToolCallBlock, MAX_INDEX_SOURCE_LINE_BYTES,
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
    agent: Option<CodexAgentMetadata>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CodexAgentMetadata {
    parent_session_id: Option<String>,
    depth: Option<i32>,
    nickname: Option<String>,
    role: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Clone)]
struct CodexTextPart {
    content_index: usize,
    field_name: String,
    content_type: String,
    text: String,
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
        let mut agent = None;
        let mut saw_session_meta = false;
        let mut parsed_lines = 0usize;
        let mut found_session_id = false;

        let Ok(file) = File::open(path) else {
            return SummaryData {
                session_id,
                cwd,
                preview,
                agent,
            };
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
            parsed_lines += 1;

            let Some(payload) = parsed.get("payload") else {
                continue;
            };

            saw_session_meta |= parsed.get("type").and_then(Value::as_str) == Some("session_meta")
                || payload.get("type").and_then(Value::as_str) == Some("session_meta");
            if agent.is_none() {
                agent = codex_agent_metadata(payload);
            }

            if !found_session_id {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    session_id = id.to_string();
                    found_session_id = true;
                }
            }
            if cwd.is_empty() {
                cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            if preview.is_empty() {
                match payload.get("type").and_then(Value::as_str) {
                    Some("user_message") | Some("agent_message") => {
                        preview = payload
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .chars()
                            .take(120)
                            .collect();
                    }
                    Some("message") => {
                        if let Some(role) = codex_message_role(payload) {
                            for part in codex_message_text_parts(payload) {
                                if should_include_response_message(role, &part.text) {
                                    preview = part.text.chars().take(120).collect();
                                    break;
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }

            if !cwd.is_empty()
                && !preview.is_empty()
                && (saw_session_meta || agent.is_some() || parsed_lines >= 256)
            {
                break;
            }
        }

        SummaryData {
            session_id,
            cwd,
            preview,
            agent,
        }
    }

    fn cached_scan_summary(
        &self,
        path: &Path,
        session_key: &str,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SummaryData {
        let Some(cache) = cache else {
            return self.scan_summary(path);
        };
        let Some(fingerprint) = SessionSummaryCache::fingerprint(path) else {
            return self.scan_summary(path);
        };

        if let Some(cached) = cache.get("codex", session_key, &fingerprint) {
            return SummaryData {
                session_id: cached.session_id,
                cwd: cached.cwd,
                preview: cached.preview,
                agent: self.scan_agent_metadata(path),
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
        let _ = cache.upsert("codex", session_key, &fingerprint, &cached);
        summary
    }

    fn scan_agent_metadata(&self, path: &Path) -> Option<CodexAgentMetadata> {
        let file = File::open(path).ok()?;
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(parsed) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let payload = parsed.get("payload");
            if let Some(metadata) = payload.and_then(codex_agent_metadata) {
                return Some(metadata);
            }
            if parsed.get("type").and_then(Value::as_str) == Some("session_meta")
                || payload
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    == Some("session_meta")
            {
                return None;
            }
        }
        None
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
        let response_message_signatures = collect_response_message_signatures(lines);

        for (line_index, line) in lines.iter().enumerate() {
            let Some(payload) = line.get("payload") else {
                continue;
            };
            let block_start = blocks.len();
            let timestamp = line
                .get("timestamp")
                .or_else(|| payload.get("timestamp"))
                .and_then(Value::as_str)
                .map(ToString::to_string);

            match payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "message" => {
                    if let Some(role) = codex_message_role(payload) {
                        for part in codex_message_text_parts(payload) {
                            if !should_include_response_message(role, &part.text) {
                                continue;
                            }

                            let block = TimelineBlock {
                                id: format!("{line_index}:{}:{role}", part.content_index),
                                role: role.to_string(),
                                content: part.text,
                                editable: true,
                                edit_target: format!(
                                    "{file_key}::{line_index}::{}::{}",
                                    part.content_index, part.field_name
                                ),
                                source_meta: json!({
                                    "lineIndex": line_index,
                                    "contentIndex": part.content_index,
                                    "payloadType": "message",
                                    "contentType": part.content_type,
                                }),
                                tool_calls: Vec::new(),
                            };
                            push_codex_block(&mut blocks, &mut pending_tool_calls, block);
                        }
                    }
                }
                "reasoning" => {
                    if let Some(block) = codex_reasoning_to_block(payload, line_index) {
                        blocks.push(block);
                    }
                }
                "user_message" => {
                    let content = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if response_message_signatures.contains(&("user".to_string(), content.clone()))
                    {
                        continue;
                    }

                    let block = TimelineBlock {
                        id: format!("{line_index}:user"),
                        role: "user".to_string(),
                        content,
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}"),
                        source_meta: json!({ "lineIndex": line_index }),
                        tool_calls: Vec::new(),
                    };
                    push_codex_block(&mut blocks, &mut pending_tool_calls, block);
                }
                "agent_message" => {
                    let content = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if response_message_signatures
                        .contains(&("assistant".to_string(), content.clone()))
                    {
                        continue;
                    }

                    let block = TimelineBlock {
                        id: format!("{line_index}:assistant"),
                        role: "assistant".to_string(),
                        content,
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}"),
                        source_meta: json!({ "lineIndex": line_index }),
                        tool_calls: Vec::new(),
                    };
                    push_codex_block(&mut blocks, &mut pending_tool_calls, block);
                }
                "function_call" => {
                    let tool_call = codex_function_call_to_block(payload, line_index);
                    push_codex_tool_call(&mut pending_tool_calls, tool_call);
                }
                "function_call_output" => {
                    let tool_call = codex_function_output_to_block(payload, line_index);
                    push_codex_tool_call(&mut pending_tool_calls, tool_call);
                }
                _ => {}
            }

            if let Some(timestamp) = &timestamp {
                for block in &mut blocks[block_start..] {
                    if let Some(meta) = block.source_meta.as_object_mut() {
                        meta.insert("createdAt".to_string(), json!(timestamp));
                    }
                }
            }
        }

        if !pending_tool_calls.is_empty() {
            if let Some(last_assistant) = blocks
                .iter_mut()
                .rev()
                .find(|block| block.role == "assistant")
            {
                last_assistant.tool_calls.append(&mut pending_tool_calls);
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

    fn searchable_content_entries(&self, session_key: &str) -> Vec<SessionContentEntry> {
        let mut entries = Vec::new();
        let mut indexed_bytes = 0usize;
        let mut msg_index = 0usize;

        let _ = visit_bounded_jsonl_lines(
            Path::new(session_key),
            MAX_INDEX_SOURCE_LINE_BYTES,
            |raw_line| {
                let Ok(line) = serde_json::from_slice::<Value>(raw_line) else {
                    return true;
                };
                let Some(payload) = line.get("payload") else {
                    return true;
                };
                let msg_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
                let role = match msg_type {
                    "message" => match codex_message_role(payload) {
                        Some(role) => role,
                        None => return true,
                    },
                    "reasoning" => "thinking",
                    "user_message" => "user",
                    "agent_message" => "assistant",
                    "function_call"
                    | "function_call_output"
                    | "custom_tool_call"
                    | "custom_tool_call_output"
                    | "web_search_call"
                    | "web_search_end"
                    | "patch_apply_end" => "assistant",
                    _ => return true,
                };
                let mut texts = Vec::new();

                if msg_type == "message" {
                    for part in codex_message_text_parts(payload) {
                        if should_include_response_message(role, &part.text) {
                            texts.push(part.text);
                        }
                    }
                } else if msg_type == "reasoning" {
                    if let Some(text) = codex_reasoning_text(payload) {
                        texts.push(text);
                    }
                } else if let Some(text) = payload.get("message").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
                if let Some(name) = payload.get("name").and_then(Value::as_str) {
                    texts.push(name.to_string());
                }
                if let Some(output) = payload.get("output").and_then(Value::as_str) {
                    texts.push(output.to_string());
                }
                if let Some(stdout) = payload.get("stdout").and_then(Value::as_str) {
                    texts.push(stdout.to_string());
                }
                if let Some(stderr) = payload.get("stderr").and_then(Value::as_str) {
                    texts.push(stderr.to_string());
                }
                if let Some(args) = payload.get("arguments") {
                    texts.push(args.to_string());
                }
                if let Some(input) = payload.get("input") {
                    texts.push(input.to_string());
                }

                let entry = SessionContentEntry::joined_text(msg_index, role, texts);
                msg_index += 1;
                push_bounded_index_entry(&mut entries, &mut indexed_bytes, entry)
            },
        );

        entries
    }
}

fn push_codex_block(
    blocks: &mut Vec<TimelineBlock>,
    pending_tool_calls: &mut Vec<ToolCallBlock>,
    mut block: TimelineBlock,
) {
    if block.role == "assistant" {
        block.tool_calls.append(pending_tool_calls);
    } else if !pending_tool_calls.is_empty() {
        if let Some(last_assistant) = blocks
            .iter_mut()
            .rev()
            .find(|block| block.role == "assistant")
        {
            last_assistant.tool_calls.append(pending_tool_calls);
        }
    }
    blocks.push(block);
}

fn push_codex_tool_call(pending_tool_calls: &mut Vec<ToolCallBlock>, tool_call: ToolCallBlock) {
    if let Some(existing) = pending_tool_calls
        .iter_mut()
        .find(|pending| pending.id == tool_call.id)
    {
        merge_codex_tool_call(existing, tool_call);
    } else {
        pending_tool_calls.push(tool_call);
    }
}

fn merge_codex_tool_call(existing: &mut ToolCallBlock, incoming: ToolCallBlock) {
    if existing.name == "function_call_output" && incoming.name != "function_call_output" {
        existing.name = incoming.name;
    }

    if existing.kind == "function_call_output" && incoming.kind != "function_call_output" {
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

    existing.status = if existing.error.is_some() {
        "error".to_string()
    } else if existing.output.is_some() {
        "completed".to_string()
    } else {
        "requested".to_string()
    };

    existing.source_meta =
        merge_codex_tool_source_meta(&existing.source_meta, &incoming.source_meta);
}

fn merge_codex_tool_source_meta(left: &Value, right: &Value) -> Value {
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
        "payloadType": "function_call",
        "lineIndices": line_indices,
    })
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
        started_at: payload
            .get("timestamp")
            .and_then(Value::as_str)
            .map(ToString::to_string),
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
        output: payload.get("output").and_then(|value| {
            value
                .as_str()
                .and_then(|text| tool_text_from_str(text, 32768))
                .or_else(|| tool_text_from_value(value, 32768))
        }),
        error: payload
            .get("error")
            .and_then(|value| tool_text_from_value(value, 8192)),
        started_at: None,
        ended_at: payload
            .get("timestamp")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        source_meta: json!({
            "lineIndex": line_index,
            "payloadType": "function_call_output",
        }),
    }
}

impl PlatformAdapter for CodexPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        if !self.sessions_root.exists() {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
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
                .map(|path| self.session_item(path, alias_map, None))
                .collect();
            return SessionListResult { total, items };
        }

        let items: Vec<SessionListItem> = entries
            .iter()
            .filter_map(|path| {
                let item = self.session_item(path, alias_map, None);
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

    fn list_sessions_with_cache(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListResult {
        if !self.sessions_root.exists() {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
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
                .map(|path| self.session_item(path, alias_map, cache))
                .collect();
            return SessionListResult { total, items };
        }

        let items: Vec<SessionListItem> = entries
            .iter()
            .filter_map(|path| {
                let item = self.session_item(path, alias_map, cache);
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

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        if !self.sessions_root.exists() || self.project_root.is_some() {
            return None;
        }

        let mut entries = Vec::new();
        collect_jsonl_recursive(&self.sessions_root, &mut entries);
        Some(
            entries
                .into_iter()
                .map(|path| {
                    let summary = self.scan_summary(&path);
                    SessionKey {
                        key: encode_path_key(&path),
                        sort_key: modified_nanos(&path) as i128,
                        session_id: summary.session_id,
                        parent_session_id: summary
                            .agent
                            .and_then(|metadata| metadata.parent_session_id),
                    }
                })
                .collect(),
        )
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        let path = Path::new(session_key);
        if !path.exists() {
            return None;
        }
        let item = self.session_item(path, alias_map, cache);
        if self.project_root.is_some() && !self.includes_project_cwd(&item.cwd) {
            return None;
        }
        Some(item)
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
        if parts.len() != 2 && parts.len() != 4 {
            return Err(format!("Invalid edit target: {edit_target}"));
        }

        let path = Path::new(parts[0]);
        let line_index: usize = parts[1]
            .parse()
            .map_err(|error| format!("Invalid line index: {error}"))?;
        // Block line indices count the rows `read_jsonl` yields, which skips
        // blank and unparsable lines.
        let mut editor = JsonlEditor::open(path)?;
        let parsed_lines = editor.parsed_line_indices().to_vec();
        let Some(&raw_index) = parsed_lines.get(line_index) else {
            return Err("Line index out of range".to_string());
        };
        let direct_event = parts.len() == 2;
        let content_index: usize = if direct_event {
            0
        } else {
            parts[2]
                .parse()
                .map_err(|error| format!("Invalid content index: {error}"))?
        };
        let field_name = if direct_event { "" } else { parts[3] };

        let (old_content, role, ordinal) = editor.edit_line(raw_index, |row| {
            let ordinal = row.get("ordinal").and_then(Value::as_i64);
            let Some(payload) = row.get_mut("payload") else {
                return Err("Missing payload".to_string());
            };

            if direct_event {
                let role = match payload.get("type").and_then(Value::as_str) {
                    Some("user_message") => "user",
                    Some("agent_message") => "assistant",
                    _ => "",
                }
                .to_string();
                let old_content = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                payload["message"] = Value::String(new_content.to_string());
                return Ok((old_content, role, ordinal));
            }

            if payload.get("type").and_then(Value::as_str) != Some("message") {
                return Err("Edit target does not point to a Codex message".to_string());
            }
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            let old_content = if field_name == "content" {
                let Some(content) = payload.get_mut("content") else {
                    return Err("Missing message content".to_string());
                };
                let old = content.as_str().unwrap_or_default().to_string();
                *content = Value::String(new_content.to_string());
                old
            } else {
                let Some(items) = payload.get_mut("content").and_then(Value::as_array_mut) else {
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

            Ok((old_content, role, ordinal))
        })?;

        sync_mirrored_messages(
            &mut editor,
            &parsed_lines,
            line_index,
            &role,
            &old_content,
            new_content,
        )?;

        let thread_id = parsed_lines
            .first()
            .and_then(|first| editor.line(*first))
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .and_then(|meta| {
                meta.pointer("/payload/id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            });
        let changes = editor.changes();
        let history_edit = thread_id.as_deref().map(|thread_id| CodexHistoryEdit {
            thread_id,
            ordinal,
            role: &role,
            old_content: &old_content,
            new_content,
            changes: &changes,
        });

        match (self.sessions_root.parent(), history_edit) {
            (Some(codex_home), Some(history_edit)) => {
                commit_with_codex_history(codex_home, &history_edit, || editor.commit())?;
            }
            _ => editor.commit()?,
        }

        Ok(old_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        !self.content_search(session_key, query).is_empty()
    }

    fn warm_content_index(
        &self,
        session_key: &str,
        index: Option<&SessionContentIndex<'_>>,
    ) -> bool {
        let Some(index) = index else {
            return false;
        };
        let path = Path::new(session_key);
        let Some(fingerprint) = SessionSummaryCache::fingerprint(path) else {
            return false;
        };
        if index.is_current("codex", session_key, &fingerprint) {
            return true;
        }
        let entries = self.searchable_content_entries(session_key);
        index
            .replace("codex", session_key, &fingerprint, &entries)
            .is_ok()
    }

    fn has_current_content_index(
        &self,
        session_key: &str,
        index: Option<&SessionContentIndex<'_>>,
    ) -> bool {
        let (Some(index), Some(fingerprint)) = (
            index,
            SessionSummaryCache::fingerprint(Path::new(session_key)),
        ) else {
            return false;
        };
        index.is_current("codex", session_key, &fingerprint)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return vec![];
        }

        content_entries_to_matches(self.searchable_content_entries(session_key), &needle)
    }

    fn content_search_with_index(
        &self,
        session_key: &str,
        query: &str,
        index: Option<&SessionContentIndex<'_>>,
    ) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return vec![];
        }

        let Some(index) = index else {
            return self.content_search(session_key, &needle);
        };
        let path = Path::new(session_key);
        let Some(fingerprint) = SessionSummaryCache::fingerprint(path) else {
            return self.content_search(session_key, &needle);
        };

        if let Some(entries) = index.get_matches("codex", session_key, &fingerprint, &needle) {
            return content_entries_to_matches(entries, &needle);
        }

        let entries = self.searchable_content_entries(session_key);
        let matches = content_entries_to_matches(entries.clone(), &needle);
        let _ = index.replace("codex", session_key, &fingerprint, &entries);
        matches
    }
}

fn collect_response_message_signatures(lines: &[Value]) -> HashSet<(String, String)> {
    let mut signatures = HashSet::new();

    for line in lines {
        let Some(payload) = line.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(role) = codex_message_role(payload) else {
            continue;
        };
        for part in codex_message_text_parts(payload) {
            if should_include_response_message(role, &part.text) {
                signatures.insert((role.to_string(), part.text));
            }
        }
    }

    signatures
}

fn codex_message_role(payload: &Value) -> Option<&str> {
    match payload.get("role").and_then(Value::as_str) {
        Some("user") => Some("user"),
        Some("assistant") => Some("assistant"),
        _ => None,
    }
}

fn codex_message_text_parts(payload: &Value) -> Vec<CodexTextPart> {
    let Some(content) = payload.get("content") else {
        return Vec::new();
    };

    if let Some(text) = content.as_str() {
        return vec![CodexTextPart {
            content_index: 0,
            field_name: "content".to_string(),
            content_type: "text".to_string(),
            text: text.to_string(),
        }];
    }

    let Some(items) = content.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .enumerate()
        .filter_map(|(content_index, item)| {
            let text = item.get("text").and_then(Value::as_str)?;
            Some(CodexTextPart {
                content_index,
                field_name: "text".to_string(),
                content_type: item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("text")
                    .to_string(),
                text: text.to_string(),
            })
        })
        .collect()
}

fn should_include_response_message(role: &str, text: &str) -> bool {
    role != "user" || !is_internal_codex_user_message(text)
}

fn is_internal_codex_user_message(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<environment_context>")
        || trimmed.starts_with(
            "The following is the Codex agent history whose request action you are assessing.",
        )
        || trimmed.starts_with(
            "The following is the Codex agent history added since your last approval assessment.",
        )
}

fn codex_reasoning_to_block(payload: &Value, line_index: usize) -> Option<TimelineBlock> {
    let content = codex_reasoning_text(payload)?;

    Some(TimelineBlock {
        id: format!("{line_index}:reasoning"),
        role: "thinking".to_string(),
        content,
        editable: false,
        edit_target: String::new(),
        source_meta: json!({
            "lineIndex": line_index,
            "payloadType": "reasoning",
            "encrypted": payload.get("encrypted_content").and_then(Value::as_str).is_some(),
        }),
        tool_calls: Vec::new(),
    })
}

fn codex_reasoning_text(payload: &Value) -> Option<String> {
    let mut pieces = Vec::new();

    if let Some(content) = payload.get("content") {
        collect_codex_text(content, &mut pieces);
    }

    if let Some(summary) = payload.get("summary") {
        collect_codex_text(summary, &mut pieces);
    }

    let text = pieces
        .into_iter()
        .map(|piece| piece.trim().to_string())
        .filter(|piece| !piece.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn collect_codex_text(value: &Value, out: &mut Vec<String>) {
    if let Some(text) = value.as_str() {
        out.push(text.to_string());
        return;
    }

    if let Some(items) = value.as_array() {
        for item in items {
            collect_codex_text(item, out);
        }
        return;
    }

    if let Some(object) = value.as_object() {
        for key in ["text", "summary", "content"] {
            if let Some(nested) = object.get(key) {
                collect_codex_text(nested, out);
            }
        }
    }
}

/// How far from an edited message its mirrored copies are looked for.
const CODEX_MIRROR_WINDOW: usize = 3;

/// Codex writes the same message more than once: the model-facing
/// `response_item` plus an event the UI replays (`user_message` /
/// `agent_message` in older rollouts, `item_completed` in newer ones). Keep
/// those copies in step with the edit.
fn sync_mirrored_messages(
    editor: &mut JsonlEditor,
    parsed_lines: &[usize],
    changed_line_index: usize,
    role: &str,
    old_content: &str,
    new_content: &str,
) -> Result<(), String> {
    if role.is_empty() || old_content.is_empty() {
        return Ok(());
    }

    let first = changed_line_index.saturating_sub(CODEX_MIRROR_WINDOW);
    let last = (changed_line_index + CODEX_MIRROR_WINDOW).min(parsed_lines.len().saturating_sub(1));
    for line_index in first..=last {
        if line_index == changed_line_index {
            continue;
        }
        editor.try_edit_line(parsed_lines[line_index], |row| {
            sync_mirrored_row(row, role, old_content, new_content);
            Ok(Some(()))
        })?;
    }

    if role != "assistant" {
        return Ok(());
    }
    // The turn summary repeats the final answer.
    for &raw_index in parsed_lines.iter().skip(changed_line_index + 1) {
        let is_summary = editor
            .line(raw_index)
            .is_some_and(|line| line.contains("\"task_complete\""));
        if !is_summary {
            continue;
        }
        let reached_summary = editor.try_edit_line(raw_index, |row| {
            let Some(payload) = row.get_mut("payload") else {
                return Ok(None);
            };
            if payload.get("type").and_then(Value::as_str) != Some("task_complete") {
                return Ok(None);
            }
            if payload.get("last_agent_message").and_then(Value::as_str) == Some(old_content) {
                payload["last_agent_message"] = Value::String(new_content.to_string());
            }
            Ok(Some(()))
        })?;
        if reached_summary.is_some() {
            break;
        }
    }
    Ok(())
}

fn sync_mirrored_row(row: &mut Value, role: &str, old_content: &str, new_content: &str) {
    let Some(payload) = row.get_mut("payload") else {
        return;
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("user_message") if role == "user" => {
            if payload.get("message").and_then(Value::as_str) == Some(old_content) {
                payload["message"] = Value::String(new_content.to_string());
            }
        }
        Some("agent_message") if role == "assistant" => {
            if payload.get("message").and_then(Value::as_str) == Some(old_content) {
                payload["message"] = Value::String(new_content.to_string());
            }
        }
        Some("message") => {
            if payload.get("role").and_then(Value::as_str) != Some(role) {
                return;
            }
            if let Some(content) = payload.get_mut("content") {
                update_mirrored_response_content(content, old_content, new_content);
            }
        }
        Some("item_completed") => {
            let Some(item) = payload.get_mut("item") else {
                return;
            };
            let item_role = match item.get("type").and_then(Value::as_str) {
                Some("UserMessage") => "user",
                Some("AgentMessage") => "assistant",
                _ => return,
            };
            if item_role != role {
                return;
            }
            if let Some(content) = item.get_mut("content") {
                update_mirrored_response_content(content, old_content, new_content);
            }
        }
        _ => {}
    }
}

// ─── Codex history index ───

/// What changed in a rollout, for the stores Codex derives from it.
struct CodexHistoryEdit<'a> {
    thread_id: &'a str,
    /// `ordinal` of the edited rollout line, when the rollout records one.
    ordinal: Option<i64>,
    role: &'a str,
    old_content: &'a str,
    new_content: &'a str,
    changes: &'a [LineChange],
}

/// Newest `<prefix>_<n>.sqlite` in the Codex home, e.g. `state_5.sqlite`.
fn newest_codex_database(codex_home: &Path, prefix: &str) -> Option<PathBuf> {
    fs::read_dir(codex_home)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version: u32 = name
                .strip_prefix(prefix)?
                .strip_prefix('_')?
                .strip_suffix(".sqlite")?
                .parse()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

fn open_codex_database(path: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(Duration::from_secs(2)).ok()?;
    Some(conn)
}

/// Write the rollout through `commit`, keeping Codex's derived stores in step.
///
/// The Codex app does not render a thread from the rollout file. It reads a
/// projection (`thread_history_*.sqlite`) that stores a copy of each message
/// and byte offsets into the rollout, so an edit that only touches the
/// rollout reaches the model but never the app. The projection belongs to
/// Codex and its schema moves between versions, so syncing it is best
/// effort: a projection that cannot be updated never blocks the edit.
fn commit_with_codex_history(
    codex_home: &Path,
    edit: &CodexHistoryEdit<'_>,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut history = newest_codex_database(codex_home, "thread_history")
        .and_then(|path| open_codex_database(&path));
    let staged = history.as_mut().and_then(|conn| {
        let tx = conn.transaction().ok()?;
        stage_codex_history(&tx, edit).ok()?;
        Some(tx)
    });

    // An uncommitted transaction rolls back when dropped, so a failed rollout
    // write leaves the projection untouched.
    commit()?;

    if let Some(tx) = staged {
        if let Err(error) = tx.commit() {
            eprintln!("codex history index not updated: {error}");
        }
    }
    sync_codex_thread_summary(codex_home, edit);
    Ok(())
}

fn stage_codex_history(
    tx: &rusqlite::Transaction<'_>,
    edit: &CodexHistoryEdit<'_>,
) -> rusqlite::Result<()> {
    let item_type = match edit.role {
        "user" => Some("userMessage"),
        "assistant" => Some("agentMessage"),
        _ => None,
    };
    if let (Some(item_type), Some(ordinal), false) =
        (item_type, edit.ordinal, edit.old_content.is_empty())
    {
        let window = CODEX_MIRROR_WINDOW as i64;
        let rows: Vec<(String, String, String)> = tx
            .prepare(
                "SELECT turn_id, item_id, item_json FROM thread_items
                 WHERE thread_id = ?1 AND item_type = ?2 AND rollout_ordinal BETWEEN ?3 AND ?4",
            )?
            .query_map(
                params![edit.thread_id, item_type, ordinal - window, ordinal + window],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
            .collect::<rusqlite::Result<_>>()?;

        for (turn_id, item_id, item_json) in rows {
            let Ok(old_item) = serde_json::from_str::<Value>(&item_json) else {
                continue;
            };
            let mut new_item = old_item.clone();
            if new_item.get("text").and_then(Value::as_str) == Some(edit.old_content) {
                new_item["text"] = Value::String(edit.new_content.to_string());
            }
            if let Some(content) = new_item.get_mut("content") {
                update_mirrored_response_content(content, edit.old_content, edit.new_content);
            }
            if new_item == old_item {
                continue;
            }
            let updated = splice_changed_strings(&item_json, &old_item, &new_item)
                .unwrap_or_else(|| new_item.to_string());
            tx.execute(
                "UPDATE thread_items SET item_json = ?1
                 WHERE thread_id = ?2 AND turn_id = ?3 AND item_id = ?4",
                params![updated, edit.thread_id, turn_id, item_id],
            )?;
        }
    }

    // Offsets are in pre-edit coordinates; shifting from the end of the file
    // backwards keeps every comparison valid.
    let mut changes = edit.changes.to_vec();
    changes.sort_by(|left, right| right.old_end.cmp(&left.old_end));
    for change in changes {
        let old_end = change.old_end as i64;
        for (table, column) in [
            ("thread_turns", "rollout_byte_offset"),
            ("thread_turns", "rollout_end_byte_offset"),
            ("thread_history_projection_state", "next_rollout_byte_offset"),
        ] {
            tx.execute(
                &format!(
                    "UPDATE {table} SET {column} = {column} + ?1
                     WHERE thread_id = ?2 AND {column} >= ?3"
                ),
                params![change.delta, edit.thread_id, old_end],
            )?;
        }
    }
    Ok(())
}

/// The thread list shows text copied from the first user message.
fn sync_codex_thread_summary(codex_home: &Path, edit: &CodexHistoryEdit<'_>) {
    if edit.role != "user" || edit.old_content.is_empty() || edit.new_content.is_empty() {
        return;
    }
    let Some(conn) =
        newest_codex_database(codex_home, "state").and_then(|path| open_codex_database(&path))
    else {
        return;
    };
    for column in ["title", "first_user_message", "preview"] {
        let _ = conn.execute(
            &format!("UPDATE threads SET {column} = ?1 WHERE id = ?2 AND {column} = ?3"),
            params![edit.new_content, edit.thread_id, edit.old_content],
        );
    }
}

fn update_mirrored_response_content(content: &mut Value, old_content: &str, new_content: &str) {
    if content.as_str() == Some(old_content) {
        *content = Value::String(new_content.to_string());
        return;
    }

    let Some(items) = content.as_array_mut() else {
        return;
    };

    for item in items {
        if item.get("text").and_then(Value::as_str) == Some(old_content) {
            item["text"] = Value::String(new_content.to_string());
            return;
        }
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
    fn session_item(
        &self,
        path: &Path,
        alias_map: &HashMap<String, String>,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListItem {
        let session_key = encode_path_key(path);
        let summary = self.cached_scan_summary(path, &session_key, cache);
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
            source_label: String::new(),
            agent_group: summary.agent.map(|agent| SessionAgentGroup {
                parent_session_id: agent.parent_session_id,
                depth: agent.depth,
                nickname: agent.nickname,
                role: agent.role,
                path: agent.path,
                orphaned: false,
                children: Vec::new(),
            }),
        }
    }
}

fn codex_agent_metadata(payload: &Value) -> Option<CodexAgentMetadata> {
    let source_spawn = payload
        .get("source")
        .and_then(|source| source.get("subagent"))
        .and_then(|subagent| subagent.get("thread_spawn"));
    let is_subagent = source_spawn.is_some()
        || payload
            .get("parent_thread_id")
            .and_then(Value::as_str)
            .is_some()
        || payload.get("thread_source").and_then(Value::as_str) == Some("subagent");
    if !is_subagent {
        return None;
    }

    let text = |name: &str| {
        payload
            .get(name)
            .and_then(Value::as_str)
            .or_else(|| {
                source_spawn
                    .and_then(|spawn| spawn.get(name))
                    .and_then(Value::as_str)
            })
            .map(ToString::to_string)
    };
    let depth = source_spawn
        .and_then(|spawn| spawn.get("depth"))
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());

    Some(CodexAgentMetadata {
        parent_session_id: text("parent_thread_id"),
        depth,
        nickname: text("agent_nickname"),
        role: text("agent_role").or_else(|| text("agent_type")),
        path: text("agent_path"),
    })
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
    fn parses_top_level_subagent_metadata_and_legacy_role_alias() {
        let metadata = codex_agent_metadata(&json!({
            "parent_thread_id": "parent",
            "agent_nickname": "Scout",
            "agent_type": "explorer",
            "agent_path": "root/scout",
            "thread_source": "subagent"
        }))
        .unwrap();

        assert_eq!(metadata.parent_session_id.as_deref(), Some("parent"));
        assert_eq!(metadata.nickname.as_deref(), Some("Scout"));
        assert_eq!(metadata.role.as_deref(), Some("explorer"));
        assert_eq!(metadata.path.as_deref(), Some("root/scout"));
    }

    #[test]
    fn parses_nested_thread_spawn_metadata() {
        let metadata = codex_agent_metadata(&json!({
            "source": { "subagent": { "thread_spawn": {
                "parent_thread_id": "parent",
                "depth": 2,
                "agent_nickname": "Builder",
                "agent_role": "worker",
                "agent_path": "root/builder"
            } } }
        }))
        .unwrap();

        assert_eq!(metadata.parent_session_id.as_deref(), Some("parent"));
        assert_eq!(metadata.depth, Some(2));
        assert_eq!(metadata.nickname.as_deref(), Some("Builder"));
        assert_eq!(metadata.role.as_deref(), Some("worker"));
    }

    #[test]
    fn agent_metadata_scan_skips_malformed_jsonl_rows() {
        let root = std::env::var("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(format!("codex-agent-scan-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create test dir");
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            "not json\n{\"payload\":{\"parent_thread_id\":\"parent\",\"thread_source\":\"subagent\"}}\n",
        )
        .expect("write session");

        let platform = CodexPlatform::new(root.clone(), None);
        let metadata = platform.scan_agent_metadata(&path).unwrap();
        fs::remove_dir_all(root).ok();

        assert_eq!(metadata.parent_session_id.as_deref(), Some("parent"));
    }

    #[test]
    fn blocks_merge_function_call_and_output_on_following_agent_message() {
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
        assert_eq!(blocks[1].tool_calls.len(), 1);
        assert_eq!(blocks[1].tool_calls[0].name, "shell");
        assert_eq!(blocks[1].tool_calls[0].kind, "function_call");
        assert_eq!(blocks[1].tool_calls[0].status, "completed");
        assert_eq!(
            blocks[1].tool_calls[0].input.as_deref(),
            Some("{\n  \"command\": \"cargo test\"\n}")
        );
        assert_eq!(blocks[1].tool_calls[0].output.as_deref(), Some("ok"));
    }

    #[test]
    fn blocks_attach_pending_function_calls_to_previous_agent_before_user_message() {
        let platform = CodexPlatform::new(PathBuf::from("unused"), None);
        let lines = vec![
            json!({ "payload": { "type": "agent_message", "message": "I will inspect it." } }),
            json!({ "payload": { "type": "function_call", "call_id": "call_1", "name": "shell", "arguments": { "command": "rg TODO" } } }),
            json!({ "payload": { "type": "function_call_output", "call_id": "call_1", "output": "todo found" } }),
            json!({ "payload": { "type": "user_message", "message": "continue" } }),
        ];

        let blocks = platform.blocks(&lines, "session.jsonl");

        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].role, "assistant");
        assert_eq!(blocks[0].tool_calls.len(), 1);
        assert_eq!(blocks[0].tool_calls[0].name, "shell");
        assert_eq!(blocks[0].tool_calls[0].status, "completed");
        assert_eq!(
            blocks[0].tool_calls[0].input.as_deref(),
            Some("{\n  \"command\": \"rg TODO\"\n}")
        );
        assert_eq!(
            blocks[0].tool_calls[0].output.as_deref(),
            Some("todo found")
        );
        assert_eq!(blocks[1].role, "user");
        assert!(blocks[1].tool_calls.is_empty());
    }

    #[test]
    fn blocks_parse_response_messages_reasoning_and_skip_mirrored_events() {
        let platform = CodexPlatform::new(PathBuf::from("unused"), None);
        let lines = vec![
            json!({ "payload": { "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "developer" }] } }),
            json!({ "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<environment_context>\nignored" }] } }),
            json!({ "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "fix it" }] } }),
            json!({ "payload": { "type": "user_message", "message": "fix it" } }),
            json!({ "payload": { "type": "reasoning", "content": null, "summary": [{ "text": "checking the shape" }], "encrypted_content": "secret" } }),
            json!({ "payload": { "type": "agent_message", "message": "done" } }),
            json!({ "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "done" }] } }),
        ];

        let blocks = platform.blocks(&lines, "session.jsonl");

        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].role, "user");
        assert_eq!(blocks[0].content, "fix it");
        assert_eq!(blocks[0].edit_target, "session.jsonl::2::0::text");
        assert_eq!(blocks[1].role, "thinking");
        assert_eq!(blocks[1].content, "checking the shape");
        assert!(!blocks[1].editable);
        assert_eq!(blocks[2].role, "assistant");
        assert_eq!(blocks[2].content, "done");
    }

    #[test]
    fn update_message_syncs_response_item_with_mirrored_event_message() {
        let root = std::env::temp_dir().join(format!(
            "memory-forge-codex-update-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp dir");
        let path = root.join("session.jsonl");
        let rows = vec![
            json!({ "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "old request" }] } }),
            json!({ "payload": { "type": "user_message", "message": "old request" } }),
        ];
        fs::write(
            &path,
            format!(
                "{}\n",
                rows.iter()
                    .map(serde_json::to_string)
                    .collect::<Result<Vec<_>, _>>()
                    .expect("serialize rows")
                    .join("\n")
            ),
        )
        .expect("write session");

        let platform = CodexPlatform::new(PathBuf::from("unused"), None);
        let edit_target = format!("{}::0::0::text", path.to_string_lossy());
        let old = platform
            .update_message(&edit_target, "new request")
            .expect("update response item");
        let updated = platform.read_jsonl(&path);

        fs::remove_dir_all(root).ok();

        assert_eq!(old, "old request");
        assert_eq!(
            updated[0]["payload"]["content"][0]["text"].as_str(),
            Some("new request")
        );
        assert_eq!(
            updated[1]["payload"]["message"].as_str(),
            Some("new request")
        );
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
            }))
            .expect("serialize inside session"),
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
            }))
            .expect("serialize outside session"),
        )
        .expect("write outside session");

        let platform = CodexPlatform::new(codex_home, Some(project_root));
        let result = platform.list_sessions(&HashMap::new(), None, 0);

        fs::remove_dir_all(root).ok();

        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].session_id, "inside");
        assert_eq!(result.items[0].preview, "inside");
    }

    #[test]
    fn update_message_keeps_other_lines_and_syncs_codex_history_index() {
        let home = std::env::temp_dir().join(format!(
            "memory-forge-codex-history-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).expect("create temp dir");
        let path = sessions.join("rollout-test.jsonl");

        // Raw text on purpose: key order, number formatting and the line
        // that is not JSON must all survive the edit.
        let lines = [
            r#"{"timestamp":"t0","ordinal":0,"type":"session_meta","payload":{"id":"thread-1","create_time":1795068955.5778801}}"#,
            r#"{"timestamp":"t1","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"old request"}]}}"#,
            r#"{"timestamp":"t2","ordinal":2,"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread-1","item":{"type":"UserMessage","id":"item-user","content":[{"type":"text","text":"old request","text_elements":[]}]}}}"#,
            "this line is not json",
            r#"{"timestamp":"t3","ordinal":3,"type":"event_msg","payload":{"type":"task_started","started_at":1795068953}}"#,
        ];
        let original = format!("{}\n", lines.join("\n"));
        fs::write(&path, &original).expect("write rollout");
        let offset_of =
            |index: usize| lines[..index].iter().map(|line| line.len() + 1).sum::<usize>() as i64;
        let file_len = original.len() as i64;

        let item_json = r#"{"type":"userMessage","id":"item-user","clientId":null,"content":[{"type":"text","text":"old request","text_elements":[]}]}"#;
        let history = Connection::open(home.join("thread_history_1.sqlite")).expect("history db");
        history
            .execute_batch(
                "CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', PRIMARY KEY (thread_id, turn_id, item_id));
                 CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_byte_offset INTEGER, rollout_end_byte_offset INTEGER, PRIMARY KEY (thread_id, turn_id));
                 CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);",
            )
            .expect("history schema");
        history
            .execute(
                "INSERT INTO thread_items VALUES ('thread-1', 'turn-1', 'item-user', 2, ?1, 'userMessage')",
                params![item_json],
            )
            .expect("insert item");
        history
            .execute(
                "INSERT INTO thread_turns VALUES ('thread-1', 'turn-1', ?1, ?2), ('thread-1', 'turn-2', ?3, ?4)",
                params![offset_of(1), offset_of(3), offset_of(4), file_len],
            )
            .expect("insert turns");
        history
            .execute(
                "INSERT INTO thread_history_projection_state VALUES ('thread-1', ?1, 4)",
                params![file_len],
            )
            .expect("insert projection state");
        drop(history);

        let state = Connection::open(home.join("state_5.sqlite")).expect("state db");
        state
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL, preview TEXT NOT NULL);
                 INSERT INTO threads VALUES ('thread-1', 'old request', 'old request', 'old request');",
            )
            .expect("state schema");
        drop(state);

        let platform = CodexPlatform::new(home.clone(), None);
        let edit_target = format!("{}::1::0::text", path.to_string_lossy());
        let old = platform
            .update_message(&edit_target, "new and longer request")
            .expect("update message");
        assert_eq!(old, "old request");

        // Two lines grew: the model-facing message and its UI mirror.
        let delta = 2 * ("new and longer request".len() - "old request".len()) as i64;
        let updated = fs::read_to_string(&path).expect("read rollout");
        assert_eq!(
            updated,
            original.replace("old request", "new and longer request")
        );

        let history = Connection::open(home.join("thread_history_1.sqlite")).expect("history db");
        let stored_item: String = history
            .query_row("SELECT item_json FROM thread_items", [], |row| row.get(0))
            .expect("read item");
        assert_eq!(
            stored_item,
            item_json.replace("old request", "new and longer request")
        );
        let turns: Vec<(i64, i64)> = history
            .prepare(
                "SELECT rollout_byte_offset, rollout_end_byte_offset FROM thread_turns ORDER BY turn_id",
            )
            .expect("prepare turns")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query turns")
            .collect::<rusqlite::Result<_>>()
            .expect("read turns");
        assert_eq!(
            turns,
            vec![
                (offset_of(1), offset_of(3) + delta),
                (offset_of(4) + delta, file_len + delta),
            ]
        );
        let next_offset: i64 = history
            .query_row(
                "SELECT next_rollout_byte_offset FROM thread_history_projection_state",
                [],
                |row| row.get(0),
            )
            .expect("read projection state");
        assert_eq!(next_offset, file_len + delta);
        assert_eq!(next_offset as u64, fs::metadata(&path).expect("stat").len());
        drop(history);

        let state = Connection::open(home.join("state_5.sqlite")).expect("state db");
        let summary: (String, String, String) = state
            .query_row(
                "SELECT title, first_user_message, preview FROM threads",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read thread summary");
        drop(state);
        fs::remove_dir_all(&home).ok();

        assert_eq!(summary.0, "new and longer request");
        assert_eq!(summary.1, "new and longer request");
        assert_eq!(summary.2, "new and longer request");
    }
}
