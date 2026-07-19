use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::DateTime;
use serde_json::{json, Value};

use crate::atomic_file::replace_existing_file_atomic;
use crate::database::{SessionContentEntry, SessionContentIndex, SessionSummaryCache};

use super::{
    build_commands, content_entries_to_matches, tool_text_from_value, ContentMatch,
    PlatformAdapter, SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock,
    ToolCallBlock,
};

pub struct GrokPlatform {
    sessions_root: PathBuf,
}

#[derive(Default)]
struct GrokSummary {
    session_id: String,
    cwd: String,
    title: String,
    preview: String,
    updated_at: String,
}

impl GrokPlatform {
    pub fn new(grok_home: PathBuf) -> Self {
        Self {
            sessions_root: grok_home.join("sessions"),
        }
    }

    fn collect_session_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        let Ok(workspaces) = fs::read_dir(&self.sessions_root) else {
            return dirs;
        };

        for workspace in workspaces.flatten() {
            let workspace_path = workspace.path();
            if !workspace_path.is_dir() {
                continue;
            }
            let Ok(sessions) = fs::read_dir(workspace_path) else {
                continue;
            };
            for session in sessions.flatten() {
                let session_path = session.path();
                if session_path.is_dir() && session_path.join("summary.json").is_file() {
                    dirs.push(session_path);
                }
            }
        }
        dirs
    }

    fn key_for_dir(&self, path: &Path) -> Option<String> {
        let session_id = path.file_name()?.to_str()?;
        let workspace = path.parent()?.file_name()?.to_str()?;
        Some(format!("{workspace}::{session_id}"))
    }

    fn dir_for_key(&self, session_key: &str) -> Option<PathBuf> {
        let (workspace, session_id) = session_key.split_once("::")?;
        if !valid_component(workspace) || !valid_component(session_id) {
            return None;
        }
        let path = self.sessions_root.join(workspace).join(session_id);
        path.join("summary.json").is_file().then_some(path)
    }

    fn read_summary(session_dir: &Path, include_preview: bool) -> Option<GrokSummary> {
        let summary_path = session_dir.join("summary.json");
        let raw = fs::read_to_string(&summary_path).ok()?;
        let value: Value = serde_json::from_str(&raw).ok()?;
        let info = value.get("info").unwrap_or(&Value::Null);
        let session_id = info
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| session_dir.file_name().and_then(|name| name.to_str()))
            .unwrap_or("unknown")
            .to_string();
        let cwd = info
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let title = value
            .get("generated_title")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_default()
            .to_string();
        let updated_at = ["last_active_at", "updated_at", "created_at"]
            .into_iter()
            .find_map(|field| value.get(field).and_then(Value::as_str))
            .and_then(timestamp_millis)
            .or_else(|| file_modified_millis(&summary_path))
            .unwrap_or_default();
        let mut preview = if include_preview {
            first_user_text(&session_dir.join("chat_history.jsonl"))
        } else {
            String::new()
        };
        if preview.is_empty() {
            preview = value
                .get("session_summary")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .chars()
                .take(200)
                .collect();
        }

        Some(GrokSummary {
            session_id,
            cwd,
            title,
            preview,
            updated_at,
        })
    }

    fn session_title(summary: &GrokSummary, alias: &str) -> String {
        if !alias.is_empty() {
            return alias.to_string();
        }
        if !summary.title.is_empty() {
            return summary.title.clone();
        }
        if !summary.preview.is_empty() {
            return summary.preview.chars().take(60).collect();
        }
        let prefix: String = summary.session_id.chars().take(8).collect();
        format!("Grok {prefix}")
    }

    fn list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Option<SessionListItem> {
        let session_dir = self.dir_for_key(session_key)?;
        let summary = Self::read_summary(&session_dir, true)?;
        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let display_title = Self::session_title(&summary, &alias_title);
        Some(SessionListItem {
            platform: "grok".to_string(),
            session_key: session_key.to_string(),
            session_id: summary.session_id,
            display_title,
            alias_title,
            preview: summary.preview,
            updated_at: summary.updated_at,
            cwd: summary.cwd,
            editable: true,
            content_matches: Vec::new(),
            total_content_matches: 0,
            favorite: false,
        })
    }

    fn read_chat_history(path: &Path) -> Result<Vec<(usize, Value)>, String> {
        let raw = fs::read_to_string(path).map_err(|error| {
            format!(
                "cannot read Grok chat history '{}': {error}",
                path.display()
            )
        })?;
        Ok(raw
            .lines()
            .enumerate()
            .filter_map(|(line_index, line)| {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return None;
                }
                serde_json::from_str::<Value>(trimmed)
                    .ok()
                    .map(|value| (line_index, value))
            })
            .collect())
    }

    fn blocks_for_entries(entries: &[(usize, Value)], session_key: &str) -> Vec<TimelineBlock> {
        let mut blocks: Vec<TimelineBlock> = Vec::new();
        let mut tool_locations: HashMap<String, (usize, usize)> = HashMap::new();

        for (line_index, entry) in entries {
            let entry_type = entry
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match entry_type {
                "user" | "assistant" => {
                    let raw_content = entry.get("content").unwrap_or(&Value::Null);
                    let content = if entry_type == "user" {
                        let Some(content) = display_user_entry(entry) else {
                            continue;
                        };
                        content
                    } else {
                        value_to_text(raw_content)
                    };
                    let editable = editable_content(entry.get("content"));
                    let tool_calls = if entry_type == "assistant" {
                        parse_tool_calls(
                            entry.get("tool_calls"),
                            *line_index,
                            &mut tool_locations,
                            blocks.len(),
                        )
                    } else {
                        Vec::new()
                    };
                    if content.trim().is_empty() && tool_calls.is_empty() {
                        continue;
                    }
                    blocks.push(TimelineBlock {
                        id: entry
                            .get("id")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .unwrap_or_else(|| format!("line-{line_index}")),
                        role: entry_type.to_string(),
                        content,
                        editable,
                        edit_target: if editable {
                            format!("{session_key}::{line_index}::content")
                        } else {
                            String::new()
                        },
                        source_meta: json!({
                            "lineIndex": line_index,
                            "type": entry_type,
                            "modelId": entry.get("model_id")
                        }),
                        tool_calls,
                    });
                }
                "reasoning" => {
                    let content = value_to_text(entry.get("summary").unwrap_or(&Value::Null));
                    if content.trim().is_empty() {
                        continue;
                    }
                    blocks.push(TimelineBlock {
                        id: entry
                            .get("id")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .unwrap_or_else(|| format!("reasoning-{line_index}")),
                        role: "thinking".to_string(),
                        content,
                        editable: false,
                        edit_target: String::new(),
                        source_meta: json!({ "lineIndex": line_index, "type": "reasoning" }),
                        tool_calls: Vec::new(),
                    });
                }
                "tool_result" => {
                    let call_id = entry
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let output =
                        tool_text_from_value(entry.get("content").unwrap_or(&Value::Null), 120_000);
                    if let Some((block_index, tool_index)) = tool_locations.get(call_id).copied() {
                        if let Some(tool_call) = blocks
                            .get_mut(block_index)
                            .and_then(|block| block.tool_calls.get_mut(tool_index))
                        {
                            tool_call.output = output;
                            tool_call.status = "completed".to_string();
                            tool_call.ended_at = Some(line_index.to_string());
                        }
                    } else if !call_id.is_empty() {
                        blocks.push(TimelineBlock {
                            id: format!("tool-result-{line_index}"),
                            role: "assistant".to_string(),
                            content: String::new(),
                            editable: false,
                            edit_target: String::new(),
                            source_meta: json!({ "lineIndex": line_index, "type": "tool_result" }),
                            tool_calls: vec![ToolCallBlock {
                                id: call_id.to_string(),
                                name: "tool".to_string(),
                                kind: "tool".to_string(),
                                status: "completed".to_string(),
                                input: None,
                                output,
                                error: None,
                                started_at: None,
                                ended_at: Some(line_index.to_string()),
                                source_meta: entry.clone(),
                            }],
                        });
                    }
                }
                "backend_tool_call" => {
                    let kind = entry.get("kind").unwrap_or(&Value::Null);
                    let id = kind
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("backend-{line_index}"));
                    let name = kind
                        .get("tool_type")
                        .and_then(Value::as_str)
                        .unwrap_or("backend_tool")
                        .to_string();
                    blocks.push(TimelineBlock {
                        id: id.clone(),
                        role: "assistant".to_string(),
                        content: String::new(),
                        editable: false,
                        edit_target: String::new(),
                        source_meta: json!({ "lineIndex": line_index, "type": "backend_tool_call" }),
                        tool_calls: vec![ToolCallBlock {
                            id,
                            name,
                            kind: "backend_tool".to_string(),
                            status: kind
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("completed")
                                .to_string(),
                            input: tool_text_from_value(
                                kind.get("action").unwrap_or(&Value::Null),
                                32_000,
                            ),
                            output: None,
                            error: None,
                            started_at: Some(line_index.to_string()),
                            ended_at: None,
                            source_meta: entry.clone(),
                        }],
                    });
                }
                _ => {}
            }
        }
        blocks
    }

    fn searchable_content_entries(&self, session_key: &str) -> Vec<SessionContentEntry> {
        let Some(session_dir) = self.dir_for_key(session_key) else {
            return Vec::new();
        };
        let Ok(entries) = Self::read_chat_history(&session_dir.join("chat_history.jsonl")) else {
            return Vec::new();
        };
        let blocks = Self::blocks_for_entries(&entries, session_key);
        let mut searchable = Vec::new();
        for (index, block) in blocks.iter().enumerate() {
            if !block.content.trim().is_empty() {
                searchable.push(SessionContentEntry::any_text(
                    index,
                    block.role.clone(),
                    vec![block.content.clone()],
                ));
            }
            for tool_call in &block.tool_calls {
                for text in [&tool_call.input, &tool_call.output, &tool_call.error]
                    .into_iter()
                    .flatten()
                {
                    searchable.push(SessionContentEntry::any_text(
                        index,
                        "assistant",
                        vec![text.clone()],
                    ));
                }
            }
        }
        searchable
    }
}

impl PlatformAdapter for GrokPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let mut items: Vec<_> = self
            .collect_session_dirs()
            .into_iter()
            .filter_map(|dir| self.key_for_dir(&dir))
            .filter_map(|key| self.list_item(&key, alias_map))
            .collect();
        items.sort_by_key(|item| std::cmp::Reverse(timestamp_sort_key(&item.updated_at)));
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
            self.collect_session_dirs()
                .into_iter()
                .filter_map(|dir| {
                    let key = self.key_for_dir(&dir)?;
                    let summary = Self::read_summary(&dir, false)?;
                    Some(SessionKey {
                        key,
                        sort_key: timestamp_sort_key(&summary.updated_at),
                    })
                })
                .collect(),
        )
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        _cache: Option<&SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        self.list_item(session_key, alias_map)
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let session_dir = self
            .dir_for_key(session_key)
            .ok_or_else(|| format!("Grok session not found: {session_key}"))?;
        let summary = Self::read_summary(&session_dir, true)
            .ok_or_else(|| format!("cannot read Grok summary for {session_key}"))?;
        let entries = Self::read_chat_history(&session_dir.join("chat_history.jsonl"))?;
        let blocks = Self::blocks_for_entries(&entries, session_key);
        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = Self::session_title(&summary, &alias_title);
        Ok(SessionDetail {
            platform: "grok".to_string(),
            session_key: session_key.to_string(),
            session_id: summary.session_id.clone(),
            title,
            alias_title,
            cwd: summary.cwd,
            commands: build_commands("grok", &summary.session_id),
            revision: String::new(),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let mut parts = edit_target.rsplitn(3, "::");
        let field = parts
            .next()
            .ok_or_else(|| format!("invalid Grok edit target: {edit_target}"))?;
        let line_index = parts
            .next()
            .ok_or_else(|| format!("invalid Grok edit target: {edit_target}"))?
            .parse::<usize>()
            .map_err(|_| format!("invalid Grok line index: {edit_target}"))?;
        let session_key = parts
            .next()
            .ok_or_else(|| format!("invalid Grok edit target: {edit_target}"))?;
        if field != "content" {
            return Err(format!("unsupported Grok edit field: {field}"));
        }

        let session_dir = self
            .dir_for_key(session_key)
            .ok_or_else(|| format!("Grok session not found: {session_key}"))?;
        let path = session_dir.join("chat_history.jsonl");
        let raw = fs::read_to_string(&path).map_err(|error| {
            format!(
                "cannot read Grok chat history '{}': {error}",
                path.display()
            )
        })?;
        let mut old_content = None;
        let mut output_lines = Vec::new();
        for (index, line) in raw.lines().enumerate() {
            if index != line_index {
                output_lines.push(line.to_string());
                continue;
            }
            let mut value: Value = serde_json::from_str(line)
                .map_err(|error| format!("cannot parse Grok chat line {line_index}: {error}"))?;
            let entry_type = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(entry_type, "user" | "assistant") {
                return Err(format!("Grok entry type is not editable: {entry_type}"));
            }
            let is_user = entry_type == "user";
            let content = value
                .get_mut("content")
                .ok_or_else(|| "Grok message has no content".to_string())?;
            old_content = Some(replace_editable_content(content, new_content, is_user)?);
            output_lines.push(
                serde_json::to_string(&value)
                    .map_err(|error| format!("cannot serialize Grok chat line: {error}"))?,
            );
        }
        let old_content =
            old_content.ok_or_else(|| format!("Grok chat line not found: {line_index}"))?;
        replace_existing_file_atomic(&path, format!("{}\n", output_lines.join("\n")).as_bytes())
            .map_err(|error| {
                format!(
                    "cannot write Grok chat history '{}': {error}",
                    path.display()
                )
            })?;
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
        let Some(session_dir) = self.dir_for_key(session_key) else {
            return false;
        };
        let chat_path = session_dir.join("chat_history.jsonl");
        let Some(fingerprint) = SessionSummaryCache::fingerprint(&chat_path) else {
            return false;
        };
        if index.is_current("grok", session_key, &fingerprint) {
            return true;
        }
        let entries = self.searchable_content_entries(session_key);
        index
            .replace("grok", session_key, &fingerprint, &entries)
            .is_ok()
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
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
            return Vec::new();
        }
        let Some(index) = index else {
            return self.content_search(session_key, &needle);
        };
        let Some(session_dir) = self.dir_for_key(session_key) else {
            return Vec::new();
        };
        let chat_path = session_dir.join("chat_history.jsonl");
        let Some(fingerprint) = SessionSummaryCache::fingerprint(&chat_path) else {
            return self.content_search(session_key, &needle);
        };
        if let Some(entries) = index.get_matches("grok", session_key, &fingerprint, &needle) {
            return content_entries_to_matches(entries, &needle);
        }
        let entries = self.searchable_content_entries(session_key);
        let matches = content_entries_to_matches(entries.clone(), &needle);
        let _ = index.replace("grok", session_key, &fingerprint, &entries);
        matches
    }
}

fn parse_tool_calls(
    value: Option<&Value>,
    line_index: usize,
    locations: &mut HashMap<String, (usize, usize)>,
    block_index: usize,
) -> Vec<ToolCallBlock> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .map(|(tool_index, item)| {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("tool-{line_index}-{tool_index}"));
            locations.insert(id.clone(), (block_index, tool_index));
            ToolCallBlock {
                id,
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                kind: "tool".to_string(),
                status: "pending".to_string(),
                input: tool_text_from_value(item.get("arguments").unwrap_or(&Value::Null), 32_000),
                output: None,
                error: None,
                started_at: Some(line_index.to_string()),
                ended_at: None,
                source_meta: item.clone(),
            }
        })
        .collect()
}

fn first_user_text(path: &Path) -> String {
    let Ok(file) = File::open(path) else {
        return String::new();
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if let Some(text) = display_user_entry(&value) {
            return text.trim().chars().take(200).collect();
        }
    }
    String::new()
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(value_to_text)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => ["text", "content", "summary"]
            .into_iter()
            .find_map(|field| map.get(field))
            .map(value_to_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn display_user_entry(entry: &Value) -> Option<String> {
    if entry.get("synthetic_reason").is_some() {
        return None;
    }
    let text = value_to_text(entry.get("content").unwrap_or(&Value::Null));
    display_user_text(&text)
}

fn display_user_text(text: &str) -> Option<String> {
    const USER_QUERY_OPEN: &str = "<user_query>";
    const USER_QUERY_CLOSE: &str = "</user_query>";
    const SYSTEM_REMINDER_OPEN: &str = "<system-reminder>";
    const SYSTEM_REMINDER_CLOSE: &str = "</system-reminder>";

    if let Some(start) = text.find(USER_QUERY_OPEN) {
        let content_start = start + USER_QUERY_OPEN.len();
        let after = &text[content_start..];
        let end = after.find(USER_QUERY_CLOSE).unwrap_or(after.len());
        let query = after[..end].trim();
        return (!query.is_empty()).then(|| query.to_string());
    }

    let trimmed = text.trim_start();
    if trimmed.starts_with(SYSTEM_REMINDER_OPEN) {
        let close = trimmed.find(SYSTEM_REMINDER_CLOSE)?;
        let header = &trimmed[..close];
        if header
            .to_ascii_lowercase()
            .contains("scheduled task execution")
        {
            let body = trimmed[close + SYSTEM_REMINDER_CLOSE.len()..].trim();
            return (!body.is_empty()).then(|| body.to_string());
        }
        return None;
    }

    if trimmed.starts_with("<user_info>")
        || trimmed.starts_with("<monitor-event")
        || trimmed == "---"
        || trimmed.lines().next().is_some_and(|first| {
            first.starts_with(|character: char| character.is_ascii_digit())
                && first.contains(" monitor events from ")
                && first.contains(" (use ")
        })
    {
        return None;
    }

    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn editable_content(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(_)) => true,
        Some(Value::Array(items)) => {
            items
                .iter()
                .filter(|item| item.get("text").and_then(Value::as_str).is_some())
                .count()
                == 1
        }
        _ => false,
    }
}

fn replace_editable_content(
    content: &mut Value,
    new_content: &str,
    is_user: bool,
) -> Result<String, String> {
    match content {
        Value::String(text) => replace_editable_text(text, new_content, is_user),
        Value::Array(items) => {
            let text_indices: Vec<usize> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| item.get("text").and_then(Value::as_str).map(|_| index))
                .collect();
            if text_indices.len() != 1 {
                return Err(
                    "Grok message has multiple text parts and cannot be edited safely".to_string(),
                );
            }
            let text = items[text_indices[0]]
                .get_mut("text")
                .ok_or_else(|| "Grok text part is invalid".to_string())?;
            let Value::String(text) = text else {
                return Err("Grok text part is invalid".to_string());
            };
            replace_editable_text(text, new_content, is_user)
        }
        _ => Err("Grok message content is not editable text".to_string()),
    }
}

fn replace_editable_text(
    text: &mut String,
    new_content: &str,
    is_user: bool,
) -> Result<String, String> {
    if !is_user {
        return Ok(std::mem::replace(text, new_content.to_string()));
    }

    const USER_QUERY_OPEN: &str = "<user_query>";
    const USER_QUERY_CLOSE: &str = "</user_query>";
    if let Some(start) = text.find(USER_QUERY_OPEN) {
        let content_start = start + USER_QUERY_OPEN.len();
        let relative_end = text[content_start..]
            .find(USER_QUERY_CLOSE)
            .ok_or_else(|| "Grok user_query closing tag is missing".to_string())?;
        let content_end = content_start + relative_end;
        let inner = &text[content_start..content_end];
        let old_content = inner.trim().to_string();
        let leading = &inner[..inner.len() - inner.trim_start().len()];
        let trailing = &inner[inner.trim_end().len()..];
        *text = format!(
            "{}{}{}{}{}",
            &text[..content_start],
            leading,
            new_content,
            trailing,
            &text[content_end..]
        );
        return Ok(old_content);
    }

    if let Some(close) = text.find("</system-reminder>") {
        let prefix_end = close + "</system-reminder>".len();
        if text[..close]
            .to_ascii_lowercase()
            .contains("scheduled task execution")
        {
            let old_content = text[prefix_end..].trim().to_string();
            *text = format!("{}\n\n{}", &text[..prefix_end], new_content);
            return Ok(old_content);
        }
    }

    Ok(std::mem::replace(text, new_content.to_string()))
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value).components().all(|component| {
            matches!(component, Component::Normal(_))
                && !value.contains('/')
                && !value.contains('\\')
        })
}

fn timestamp_millis(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis().to_string())
        .or_else(|| value.parse::<i128>().ok().map(|number| number.to_string()))
}

fn timestamp_sort_key(value: &str) -> i128 {
    value.trim().parse().unwrap_or(0)
}

fn file_modified_millis(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_root() -> PathBuf {
        std::env::temp_dir().join(format!("memory-forge-grok-test-{}", std::process::id()))
    }

    #[test]
    fn lists_parses_and_edits_grok_sessions() {
        let root = sample_root();
        let session_dir = root
            .join("sessions")
            .join("C%3A%5Cwork%5Cproject")
            .join("019f-test-session");
        fs::create_dir_all(&session_dir).expect("create session dir");
        fs::write(
            session_dir.join("summary.json"),
            r#"{
              "info":{"id":"019f-test-session","cwd":"C:\\work\\project"},
              "created_at":"2026-07-17T01:00:00Z",
              "updated_at":"2026-07-17T02:00:00Z",
              "generated_title":"Fix the parser"
            }"#,
        )
        .expect("write summary");
        fs::write(
            session_dir.join("chat_history.jsonl"),
            concat!(
                r#"{"type":"user","content":[{"type":"text","text":"<user_info>\nOS Version: windows\n</user_info>"}]}"#,
                "\n",
                r#"{"type":"user","content":"<system-reminder>\nInternal reminder\n</system-reminder>"}"#,
                "\n",
                r#"{"type":"user","content":[{"type":"text","text":"<user_query>\nPlease fix it\n</user_query>\n<system-reminder>hidden context</system-reminder>"}],"prompt_index":0}"#,
                "\n",
                r#"{"type":"assistant","content":"Working","tool_calls":[{"id":"call-1","name":"terminal","arguments":{"command":"cargo test"}}]}"#,
                "\n",
                r#"{"type":"tool_result","tool_call_id":"call-1","content":"ok"}"#,
                "\n",
                r#"{"type":"reasoning","id":"r1","summary":["Checked the parser"]}"#,
                "\n"
            ),
        )
        .expect("write chat");

        let adapter = GrokPlatform::new(root.clone());
        let result = adapter.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].display_title, "Fix the parser");
        assert_eq!(result.items[0].preview, "Please fix it");
        assert_eq!(result.items[0].cwd, r"C:\work\project");

        let key = result.items[0].session_key.clone();
        let detail = adapter
            .get_session_detail(&key, &HashMap::new())
            .expect("session detail");
        assert_eq!(detail.blocks.len(), 3);
        assert_eq!(detail.blocks[0].content, "Please fix it");
        assert!(!detail.blocks[0].content.contains("user_query"));
        assert!(detail
            .blocks
            .iter()
            .all(|block| !block.content.contains("user_info")
                && !block.content.contains("system-reminder")));
        assert_eq!(detail.blocks[1].tool_calls[0].output.as_deref(), Some("ok"));
        assert_eq!(
            detail.commands.get("resume").map(String::as_str),
            Some("grok --resume 019f-test-session")
        );

        let old = adapter
            .update_message(&format!("{key}::2::content"), "Please fix it now")
            .expect("edit user message");
        assert_eq!(old, "Please fix it");
        let updated =
            fs::read_to_string(session_dir.join("chat_history.jsonl")).expect("read updated chat");
        assert!(updated.contains("Please fix it now"));
        assert!(updated.contains("<user_query>"));
        assert!(updated.contains("</user_query>"));
        assert!(updated.contains("<system-reminder>hidden context</system-reminder>"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsafe_session_keys() {
        let adapter = GrokPlatform::new(sample_root());
        assert!(adapter.dir_for_key("..::session").is_none());
        assert!(adapter.dir_for_key("workspace::../session").is_none());
        assert!(adapter.dir_for_key("workspace/other::session").is_none());
    }

    #[test]
    fn user_display_matches_grok_pager_rules() {
        assert_eq!(
            display_user_text(
                "<user_query>\nhello\n</user_query>\n<system-reminder>x</system-reminder>"
            )
            .as_deref(),
            Some("hello")
        );
        assert!(display_user_text("<user_info>\nOS: windows\n</user_info>").is_none());
        assert!(display_user_text("<system-reminder>\nbackground\n</system-reminder>").is_none());
        assert_eq!(
            display_user_text(
                "<system-reminder>\nThis is a scheduled task execution.\n</system-reminder>\n\nrun report"
            )
            .as_deref(),
            Some("run report")
        );
    }
}
