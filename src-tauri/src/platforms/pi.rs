use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::DateTime;
use serde_json::{json, Value};

use crate::database::{CachedSessionSummary, SessionContentEntry, SessionContentIndex, SessionSummaryCache};

use super::{
    build_commands, content_entries_to_matches, tool_text_from_str, tool_text_from_value,
    ContentMatch, PlatformAdapter, SessionDetail, SessionListItem, SessionListResult,
    TimelineBlock, ToolCallBlock,
};

pub struct PiPlatform {
    sessions_root: PathBuf,
}

#[derive(Default)]
struct QuickScan {
    session_id: String,
    cwd: String,
    preview: String,
    title: String,
    updated_at: String,
}

impl PiPlatform {
    pub fn new(pi_home: PathBuf, sessions_root: Option<PathBuf>) -> Self {
        let sessions_root = sessions_root.unwrap_or_else(|| pi_home.join("sessions"));
        Self { sessions_root }
    }

    fn collect_session_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if !self.sessions_root.exists() {
            return files;
        }
        collect_jsonl_files(&self.sessions_root, &mut files, 0);
        files
    }

    fn key_for_path(path: &Path) -> Option<String> {
        let project_key = path.parent()?.file_name()?.to_str()?;
        let stem = path.file_stem()?.to_str()?;
        Some(format!("{project_key}::{stem}"))
    }

    fn path_for_key(&self, session_key: &str) -> Option<PathBuf> {
        let mut parts = session_key.splitn(2, "::");
        let project_key = parts.next()?;
        let stem = parts.next()?;
        let path = self
            .sessions_root
            .join(project_key)
            .join(format!("{stem}.jsonl"));
        path.exists().then_some(path)
    }

    fn quick_scan(path: &Path) -> Option<QuickScan> {
        let file = File::open(path).ok()?;
        let reader = BufReader::new(file);
        let mut scan = QuickScan::default();

        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };

            let entry_type = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if entry_type == "session" {
                scan.session_id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                scan.cwd = value
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }

            if entry_type == "session_info" {
                if let Some(name) = value.get("name").and_then(Value::as_str) {
                    if !name.trim().is_empty() {
                        scan.title = name.trim().to_string();
                    }
                }
            }

            if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                if let Some(ms) = timestamp_to_millis_string(timestamp) {
                    scan.updated_at = ms;
                }
            }

            if scan.preview.is_empty() && entry_type == "message" {
                scan.preview = value
                    .get("message")
                    .and_then(message_preview)
                    .unwrap_or_default();
            }
        }

        if scan.session_id.is_empty() {
            scan.session_id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("unknown")
                .to_string();
        }
        if scan.updated_at.is_empty() {
            scan.updated_at = file_modified_millis(path).unwrap_or_default();
        }
        Some(scan)
    }

    fn cached_quick_scan(
        path: &Path,
        session_key: &str,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> Option<QuickScan> {
        let Some(cache) = cache else {
            return Self::quick_scan(path);
        };
        let Some(fingerprint) = SessionSummaryCache::fingerprint(path) else {
            return Self::quick_scan(path);
        };

        if let Some(cached) = cache.get("pi", session_key, &fingerprint) {
            return Some(QuickScan {
                session_id: cached.session_id,
                cwd: cached.cwd,
                preview: cached.preview,
                title: cached.title,
                updated_at: cached.updated_at,
            });
        }

        let scan = Self::quick_scan(path)?;
        let cached = CachedSessionSummary {
            session_id: scan.session_id.clone(),
            title: scan.title.clone(),
            preview: scan.preview.clone(),
            updated_at: scan.updated_at.clone(),
            cwd: scan.cwd.clone(),
        };
        let _ = cache.upsert("pi", session_key, &fingerprint, &cached);
        Some(scan)
    }

    fn read_jsonl(path: &Path) -> Result<Vec<Value>, String> {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("cannot read Pi session '{}': {e}", path.display()))?;
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str::<Value>(line)
                    .map_err(|e| format!("cannot parse Pi session line: {e}"))
            })
            .collect()
    }

    fn current_chain_indices(entries: &[Value]) -> Vec<usize> {
        let mut by_id = HashMap::new();
        for (idx, entry) in entries.iter().enumerate() {
            if entry.get("type").and_then(Value::as_str) == Some("session") {
                continue;
            }
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                by_id.insert(id.to_string(), idx);
            }
        }

        let Some(mut current_id) = entries.iter().rev().find_map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }) else {
            return (0..entries.len()).collect();
        };

        let mut seen = HashSet::new();
        let mut chain = Vec::new();
        while seen.insert(current_id.clone()) {
            let Some(idx) = by_id.get(&current_id).copied() else {
                break;
            };
            chain.push(idx);
            let parent = entries[idx].get("parentId").and_then(Value::as_str);
            let Some(parent_id) = parent else {
                break;
            };
            current_id = parent_id.to_string();
        }

        if chain.is_empty() {
            return (0..entries.len()).collect();
        }
        chain.reverse();
        chain
    }

    fn blocks_for_entries(
        entries: &[Value],
        chain: &[usize],
        session_key: &str,
    ) -> Vec<TimelineBlock> {
        let mut blocks = Vec::new();
        let mut tool_locations: HashMap<String, (usize, usize)> = HashMap::new();

        for &idx in chain {
            let Some(entry) = entries.get(idx) else {
                continue;
            };
            let entry_type = entry
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let entry_id = entry
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| idx.to_string());

            match entry_type {
                "message" => {
                    if let Some(message) = entry.get("message") {
                        append_message_blocks(
                            &mut blocks,
                            &mut tool_locations,
                            message,
                            session_key,
                            &entry_id,
                        );
                    }
                }
                "compaction" => {
                    if let Some(summary) = entry.get("summary").and_then(Value::as_str) {
                        push_readonly_thinking(&mut blocks, &entry_id, "compaction", summary);
                    }
                }
                "branch_summary" => {
                    if let Some(summary) = entry.get("summary").and_then(Value::as_str) {
                        push_readonly_thinking(&mut blocks, &entry_id, "branch_summary", summary);
                    }
                }
                "custom_message" => {
                    if entry
                        .get("display")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                    {
                        let text =
                            content_value_to_text(entry.get("content").unwrap_or(&Value::Null));
                        if !text.trim().is_empty() {
                            push_readonly_thinking(&mut blocks, &entry_id, "custom_message", &text);
                        }
                    }
                }
                _ => {}
            }
        }

        blocks
    }

    fn searchable_content_entries(&self, session_key: &str) -> Vec<SessionContentEntry> {
        let Some(path) = self.path_for_key(session_key) else {
            return Vec::new();
        };
        let Ok(entries) = Self::read_jsonl(&path) else {
            return Vec::new();
        };
        let chain = Self::current_chain_indices(&entries);
        let blocks = Self::blocks_for_entries(&entries, &chain, session_key);
        let mut entries = Vec::new();

        for (idx, block) in blocks.iter().enumerate() {
            if !block.content.trim().is_empty() {
                entries.push(SessionContentEntry::any_text(
                    idx,
                    block.role.clone(),
                    vec![block.content.clone()],
                ));
            }

            for tool_call in block.tool_calls.iter() {
                for text in [&tool_call.input, &tool_call.output, &tool_call.error]
                    .into_iter()
                    .flatten()
                {
                    entries.push(SessionContentEntry::any_text(
                        idx,
                        "assistant",
                        vec![text.clone()],
                    ));
                }
            }
        }

        entries
    }

    fn session_title(session_key: &str, scan: &QuickScan, alias: &str) -> String {
        if !alias.is_empty() {
            return alias.to_string();
        }
        if !scan.title.is_empty() {
            return scan.title.clone();
        }
        if !scan.preview.is_empty() {
            return scan.preview.chars().take(60).collect();
        }
        scan.session_id
            .get(..8)
            .map(|prefix| format!("Pi {prefix}"))
            .unwrap_or_else(|| session_key.to_string())
    }
}

impl PlatformAdapter for PiPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let mut items: Vec<SessionListItem> = self
            .collect_session_files()
            .into_iter()
            .filter_map(|path| {
                let session_key = Self::key_for_path(&path)?;
                let scan = Self::quick_scan(&path)?;
                let alias_title = alias_map.get(&session_key).cloned().unwrap_or_default();
                let display_title = Self::session_title(&session_key, &scan, &alias_title);
                Some(SessionListItem {
                    platform: "pi".to_string(),
                    session_key,
                    session_id: scan.session_id,
                    display_title,
                    alias_title,
                    preview: scan.preview,
                    updated_at: scan.updated_at,
                    cwd: scan.cwd,
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                })
            })
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

    fn list_sessions_with_cache(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListResult {
        let mut items: Vec<SessionListItem> = self
            .collect_session_files()
            .into_iter()
            .filter_map(|path| {
                let session_key = Self::key_for_path(&path)?;
                let scan = Self::cached_quick_scan(&path, &session_key, cache)?;
                let alias_title = alias_map.get(&session_key).cloned().unwrap_or_default();
                let display_title = Self::session_title(&session_key, &scan, &alias_title);
                Some(SessionListItem {
                    platform: "pi".to_string(),
                    session_key,
                    session_id: scan.session_id,
                    display_title,
                    alias_title,
                    preview: scan.preview,
                    updated_at: scan.updated_at,
                    cwd: scan.cwd,
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                })
            })
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

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let path = self
            .path_for_key(session_key)
            .ok_or_else(|| format!("Pi session not found: {session_key}"))?;
        let entries = Self::read_jsonl(&path)?;
        let scan = Self::quick_scan(&path).unwrap_or_default();
        let chain = Self::current_chain_indices(&entries);
        let blocks = Self::blocks_for_entries(&entries, &chain, session_key);
        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = Self::session_title(session_key, &scan, &alias_title);
        let mut commands = build_commands("pi", &scan.session_id);
        commands.insert(
            "resumePath".to_string(),
            format!("pi --session \"{}\"", path.display()),
        );

        Ok(SessionDetail {
            platform: "pi".to_string(),
            session_key: session_key.to_string(),
            session_id: scan.session_id,
            title,
            alias_title,
            cwd: scan.cwd,
            commands,
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let mut parts = edit_target.rsplitn(4, "::");
        let field = parts
            .next()
            .ok_or_else(|| format!("invalid Pi edit target: {edit_target}"))?;
        let content_index = parts
            .next()
            .ok_or_else(|| format!("invalid Pi edit target: {edit_target}"))?
            .parse::<usize>()
            .map_err(|_| format!("invalid Pi content index: {edit_target}"))?;
        let entry_id = parts
            .next()
            .ok_or_else(|| format!("invalid Pi edit target: {edit_target}"))?;
        let session_key = parts
            .next()
            .ok_or_else(|| format!("invalid Pi edit target: {edit_target}"))?;

        if field != "text" {
            return Err(format!("unsupported Pi edit field: {field}"));
        }

        let path = self
            .path_for_key(session_key)
            .ok_or_else(|| format!("Pi session not found: {session_key}"))?;
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("cannot read Pi session '{}': {e}", path.display()))?;
        let mut lines = Vec::new();
        let mut old_content = None;

        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut value: Value = serde_json::from_str(trimmed)
                .map_err(|e| format!("cannot parse Pi session line: {e}"))?;

            if value.get("type").and_then(Value::as_str) == Some("message")
                && value.get("id").and_then(Value::as_str) == Some(entry_id)
            {
                let role = value
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !matches!(role.as_str(), "user" | "assistant") {
                    return Err(format!("Pi message role is not editable: {role}"));
                }

                let content = value
                    .get_mut("message")
                    .and_then(|message| message.get_mut("content"))
                    .ok_or_else(|| "Pi message has no content".to_string())?;

                let old = update_text_content(content, content_index, new_content)?;
                old_content = Some(old);
            }

            lines.push(
                serde_json::to_string(&value)
                    .map_err(|e| format!("cannot serialize Pi session line: {e}"))?,
            );
        }

        let Some(old_content) = old_content else {
            return Err(format!("Pi message entry not found: {entry_id}"));
        };

        fs::write(&path, format!("{}\n", lines.join("\n")))
            .map_err(|e| format!("cannot write Pi session '{}': {e}", path.display()))?;

        Ok(old_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if session_key.to_lowercase().contains(&needle) {
            return true;
        }
        let Some(path) = self.path_for_key(session_key) else {
            return false;
        };
        let Ok(raw) = fs::read_to_string(path) else {
            return false;
        };
        raw.to_lowercase().contains(&needle)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.to_lowercase();
        if needle.trim().is_empty() {
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
        let needle = query.to_lowercase();
        if needle.trim().is_empty() {
            return vec![];
        }

        let Some(index) = index else {
            return self.content_search(session_key, &needle);
        };
        let Some(path) = self.path_for_key(session_key) else {
            return self.content_search(session_key, &needle);
        };
        let Some(fingerprint) = SessionSummaryCache::fingerprint(&path) else {
            return self.content_search(session_key, &needle);
        };

        if let Some(entries) = index.get_matches("pi", session_key, &fingerprint, &needle) {
            return content_entries_to_matches(entries, &needle);
        }

        let entries = self.searchable_content_entries(session_key);
        let matches = content_entries_to_matches(entries.clone(), &needle);
        let _ = index.replace("pi", session_key, &fingerprint, &entries);
        matches
    }
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>, depth: usize) {
    if depth > 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files, depth + 1);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn timestamp_to_millis_string(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(number) = text.parse::<i128>() {
        return Some(normalize_timestamp_millis(number).to_string());
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.timestamp_millis().to_string())
}

fn timestamp_sort_key(value: &str) -> i128 {
    value
        .trim()
        .parse::<i128>()
        .map(normalize_timestamp_millis)
        .unwrap_or(0)
}

fn normalize_timestamp_millis(mut number: i128) -> i128 {
    if number > 100_000_000_000_000_000 {
        number /= 1_000_000;
    } else if number > 1_000_000_000_000_000 {
        number /= 1_000;
    } else if number < 10_000_000_000 {
        number *= 1_000;
    }
    number
}

fn file_modified_millis(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis().to_string())
}

fn message_preview(message: &Value) -> Option<String> {
    let role = message.get("role").and_then(Value::as_str)?;
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let text = content_value_to_text(message.get("content").unwrap_or(&Value::Null));
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(200).collect())
    }
}

fn content_value_to_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(content_item_to_text)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn content_item_to_text(item: &Value) -> Option<String> {
    let content_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match content_type {
        "text" | "input_text" => item
            .get("text")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        "thinking" => item
            .get("thinking")
            .or_else(|| item.get("text"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        "image" => Some("[image]".to_string()),
        _ => None,
    }
}

fn append_message_blocks(
    blocks: &mut Vec<TimelineBlock>,
    tool_locations: &mut HashMap<String, (usize, usize)>,
    message: &Value,
    session_key: &str,
    entry_id: &str,
) {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match role {
        "user" => append_text_message_blocks(blocks, message, session_key, entry_id, "user"),
        "assistant" => {
            append_assistant_blocks(blocks, tool_locations, message, session_key, entry_id)
        }
        "toolResult" => merge_tool_result(blocks, tool_locations, message, entry_id),
        "bashExecution" => append_bash_execution(blocks, message, entry_id),
        "branchSummary" | "compactionSummary" => {
            if let Some(summary) = message
                .get("summary")
                .or_else(|| message.get("content"))
                .and_then(Value::as_str)
            {
                push_readonly_thinking(blocks, entry_id, role, summary);
            }
        }
        "custom" => {
            let text = content_value_to_text(message.get("content").unwrap_or(&Value::Null));
            if !text.trim().is_empty() {
                push_readonly_thinking(blocks, entry_id, role, &text);
            }
        }
        _ => {}
    }
}

fn append_text_message_blocks(
    blocks: &mut Vec<TimelineBlock>,
    message: &Value,
    session_key: &str,
    entry_id: &str,
    role: &str,
) {
    match message.get("content").unwrap_or(&Value::Null) {
        Value::String(text) => {
            if text.trim().is_empty() {
                return;
            }
            blocks.push(TimelineBlock {
                id: format!("{entry_id}:0"),
                role: role.to_string(),
                content: text.clone(),
                editable: true,
                edit_target: format!("{session_key}::{entry_id}::0::text"),
                source_meta: json!({ "entryId": entry_id, "contentIndex": 0, "messageRole": role }),
                tool_calls: Vec::new(),
            });
        }
        Value::Array(items) => {
            for (content_index, item) in items.iter().enumerate() {
                if item.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                blocks.push(TimelineBlock {
                    id: format!("{entry_id}:{content_index}"),
                    role: role.to_string(),
                    content: text.to_string(),
                    editable: true,
                    edit_target: format!("{session_key}::{entry_id}::{content_index}::text"),
                    source_meta: json!({
                        "entryId": entry_id,
                        "contentIndex": content_index,
                        "messageRole": role,
                        "contentType": "text"
                    }),
                    tool_calls: Vec::new(),
                });
            }
        }
        _ => {}
    }
}

fn append_assistant_blocks(
    blocks: &mut Vec<TimelineBlock>,
    tool_locations: &mut HashMap<String, (usize, usize)>,
    message: &Value,
    session_key: &str,
    entry_id: &str,
) {
    let first_block_index = blocks.len();
    let mut local_text_blocks = Vec::new();
    let mut local_tool_calls = Vec::new();

    match message.get("content").unwrap_or(&Value::Null) {
        Value::String(_) => {
            append_text_message_blocks(blocks, message, session_key, entry_id, "assistant")
        }
        Value::Array(items) => {
            for (content_index, item) in items.iter().enumerate() {
                match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "thinking" => {
                        let thinking = item
                            .get("thinking")
                            .or_else(|| item.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !thinking.trim().is_empty() {
                            blocks.push(TimelineBlock {
                                id: format!("{entry_id}:{content_index}:thinking"),
                                role: "thinking".to_string(),
                                content: thinking.to_string(),
                                editable: false,
                                edit_target: String::new(),
                                source_meta: json!({
                                    "entryId": entry_id,
                                    "contentIndex": content_index,
                                    "messageRole": "assistant",
                                    "contentType": "thinking"
                                }),
                                tool_calls: Vec::new(),
                            });
                        }
                    }
                    "text" => {
                        let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                        if !text.trim().is_empty() {
                            blocks.push(TimelineBlock {
                                id: format!("{entry_id}:{content_index}"),
                                role: "assistant".to_string(),
                                content: text.to_string(),
                                editable: true,
                                edit_target: format!(
                                    "{session_key}::{entry_id}::{content_index}::text"
                                ),
                                source_meta: json!({
                                    "entryId": entry_id,
                                    "contentIndex": content_index,
                                    "messageRole": "assistant",
                                    "contentType": "text"
                                }),
                                tool_calls: Vec::new(),
                            });
                            local_text_blocks.push(blocks.len() - 1);
                        }
                    }
                    "toolCall" => {
                        if let Some(tool_call) = tool_call_to_block(item, entry_id, content_index) {
                            local_tool_calls.push(tool_call);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    if local_text_blocks.is_empty() {
        local_text_blocks.extend(
            (first_block_index..blocks.len())
                .filter(|idx| blocks[*idx].role == "assistant" && blocks[*idx].editable),
        );
    }

    if !local_tool_calls.is_empty() {
        let host_idx = local_text_blocks
            .first()
            .copied()
            .unwrap_or_else(|| create_empty_assistant_block(blocks, entry_id));
        for tool_call in local_tool_calls {
            let tool_id = tool_call.id.clone();
            blocks[host_idx].tool_calls.push(tool_call);
            let tool_idx = blocks[host_idx].tool_calls.len() - 1;
            tool_locations.insert(tool_id, (host_idx, tool_idx));
        }
    }
}

fn tool_call_to_block(item: &Value, entry_id: &str, content_index: usize) -> Option<ToolCallBlock> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    Some(ToolCallBlock {
        id,
        name,
        kind: "pi-tool".to_string(),
        status: "pending".to_string(),
        input: item
            .get("arguments")
            .and_then(|value| tool_text_from_value(value, 8192)),
        output: None,
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "entryId": entry_id,
            "contentIndex": content_index,
            "contentType": "toolCall"
        }),
    })
}

fn merge_tool_result(
    blocks: &mut Vec<TimelineBlock>,
    tool_locations: &mut HashMap<String, (usize, usize)>,
    message: &Value,
    entry_id: &str,
) {
    let tool_call_id = message
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or(entry_id)
        .to_string();
    let output = content_value_to_text(message.get("content").unwrap_or(&Value::Null));
    let is_error = message
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = if is_error { "error" } else { "success" }.to_string();

    if let Some((block_idx, tool_idx)) = tool_locations.get(&tool_call_id).copied() {
        if let Some(tool_call) = blocks
            .get_mut(block_idx)
            .and_then(|block| block.tool_calls.get_mut(tool_idx))
        {
            tool_call.status = status;
            if is_error {
                tool_call.error = tool_text_from_str(&output, 8192);
            } else {
                tool_call.output = tool_text_from_str(&output, 32768);
            }
        }
        return;
    }

    let host_idx = find_last_assistant_block(blocks)
        .unwrap_or_else(|| create_empty_assistant_block(blocks, entry_id));
    let name = message
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let tool_call = ToolCallBlock {
        id: tool_call_id.clone(),
        name,
        kind: "pi-tool".to_string(),
        status,
        input: None,
        output: (!is_error)
            .then(|| output.clone())
            .and_then(|text| tool_text_from_str(&text, 32768)),
        error: is_error
            .then(|| output.clone())
            .and_then(|text| tool_text_from_str(&text, 8192)),
        started_at: None,
        ended_at: None,
        source_meta: json!({ "entryId": entry_id, "contentType": "toolResult" }),
    };
    blocks[host_idx].tool_calls.push(tool_call);
    let tool_idx = blocks[host_idx].tool_calls.len() - 1;
    tool_locations.insert(tool_call_id, (host_idx, tool_idx));
}

fn append_bash_execution(blocks: &mut Vec<TimelineBlock>, message: &Value, entry_id: &str) {
    let command = message
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let output = message
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cancelled = message
        .get("cancelled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let exit_code = message.get("exitCode").and_then(Value::as_i64);
    let status = if cancelled {
        "aborted"
    } else if exit_code == Some(0) {
        "success"
    } else {
        "error"
    };
    let host_idx = find_last_assistant_block(blocks)
        .unwrap_or_else(|| create_empty_assistant_block(blocks, entry_id));
    blocks[host_idx].tool_calls.push(ToolCallBlock {
        id: entry_id.to_string(),
        name: "bash".to_string(),
        kind: "pi-bash".to_string(),
        status: status.to_string(),
        input: tool_text_from_str(&command, 8192),
        output: tool_text_from_str(&output, 32768),
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "entryId": entry_id,
            "role": "bashExecution",
            "exitCode": exit_code,
            "cancelled": cancelled
        }),
    });
}

fn push_readonly_thinking(
    blocks: &mut Vec<TimelineBlock>,
    entry_id: &str,
    kind: &str,
    content: &str,
) {
    if content.trim().is_empty() {
        return;
    }
    blocks.push(TimelineBlock {
        id: entry_id.to_string(),
        role: "thinking".to_string(),
        content: content.to_string(),
        editable: false,
        edit_target: String::new(),
        source_meta: json!({ "entryId": entry_id, "entryType": kind }),
        tool_calls: Vec::new(),
    });
}

fn find_last_assistant_block(blocks: &[TimelineBlock]) -> Option<usize> {
    blocks.iter().rposition(|block| block.role == "assistant")
}

fn create_empty_assistant_block(blocks: &mut Vec<TimelineBlock>, entry_id: &str) -> usize {
    blocks.push(TimelineBlock {
        id: format!("{entry_id}:tools"),
        role: "assistant".to_string(),
        content: String::new(),
        editable: false,
        edit_target: String::new(),
        source_meta: json!({ "entryId": entry_id, "generated": "tool-host" }),
        tool_calls: Vec::new(),
    });
    blocks.len() - 1
}

fn update_text_content(
    content: &mut Value,
    content_index: usize,
    new_content: &str,
) -> Result<String, String> {
    match content {
        Value::String(text) => {
            if content_index != 0 {
                return Err("Pi string content only supports index 0".to_string());
            }
            let old = text.clone();
            *text = new_content.to_string();
            Ok(old)
        }
        Value::Array(items) => {
            let item = items
                .get_mut(content_index)
                .ok_or_else(|| format!("Pi content index not found: {content_index}"))?;
            if item.get("type").and_then(Value::as_str) != Some("text") {
                return Err("Only Pi text content is editable".to_string());
            }
            let old = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            item["text"] = Value::String(new_content.to_string());
            Ok(old)
        }
        _ => Err("Unsupported Pi content shape".to_string()),
    }
}

pub fn default_pi_home() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
}

pub fn default_pi_sessions_root(pi_home: &Path) -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .map(PathBuf::from)
        .or_else(|| Some(pi_home.join("sessions")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("memory-forge-pi-{name}-{}", std::process::id()))
    }

    #[test]
    fn list_and_detail_parse_pi_jsonl() {
        let root = temp_root("detail");
        let session_dir = root.join("sessions").join("--F--workspace-demo--");
        fs::create_dir_all(&session_dir).expect("create session dir");
        fs::write(
            session_dir.join("2026-06-01T16-48-15-428Z_s1.jsonl"),
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-06-01T16:48:15.428Z","cwd":"F:\\workspace\\demo"}
{"type":"session_info","id":"n1","parentId":null,"timestamp":"2026-06-01T16:48:16.000Z","name":"Demo Session"}
{"type":"message","id":"u1","parentId":"n1","timestamp":"2026-06-01T16:48:17.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1780332497000}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-01T16:48:18.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"checking"},{"type":"text","text":"hi"}],"api":"openai-responses","provider":"test","model":"gpt","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1780332498000}}"#,
        )
        .expect("write session");

        let platform = PiPlatform::new(root.clone(), None);
        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(listed.items[0].display_title, "Demo Session");
        assert_eq!(listed.items[0].preview, "hello");

        let detail = platform
            .get_session_detail(&listed.items[0].session_key, &HashMap::new())
            .expect("detail");
        assert_eq!(detail.blocks.len(), 3);
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[2].content, "hi");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn merges_tool_call_and_result() {
        let entries = PiPlatform::read_jsonl_from_str(
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-06-01T16:48:15.428Z","cwd":"F:\\workspace\\demo"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-01T16:48:16.000Z","message":{"role":"user","content":[{"type":"text","text":"list"}]}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-01T16:48:17.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"bash","arguments":{"command":"ls"}}],"api":"openai-responses","provider":"test","model":"gpt","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse"}}
{"type":"message","id":"tr1","parentId":"a1","timestamp":"2026-06-01T16:48:18.000Z","message":{"role":"toolResult","toolCallId":"tc1","toolName":"bash","content":[{"type":"text","text":"Cargo.toml"}],"isError":false}}"#,
        );
        let chain = PiPlatform::current_chain_indices(&entries);
        let blocks = PiPlatform::blocks_for_entries(&entries, &chain, "project::session");

        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].tool_calls.len(), 1);
        assert_eq!(blocks[1].tool_calls[0].status, "success");
        assert_eq!(
            blocks[1].tool_calls[0].output.as_deref(),
            Some("Cargo.toml")
        );
    }

    #[test]
    fn update_message_edits_only_text_content() {
        let root = temp_root("edit");
        let session_dir = root.join("sessions").join("--F--workspace-demo--");
        fs::create_dir_all(&session_dir).expect("create session dir");
        let path = session_dir.join("2026-06-01T16-48-15-428Z_s1.jsonl");
        fs::write(
            &path,
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-06-01T16:48:15.428Z","cwd":"F:\\workspace\\demo"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-01T16:48:16.000Z","message":{"role":"user","content":[{"type":"text","text":"old"}],"timestamp":1780332496000}}"#,
        )
        .expect("write session");

        let platform = PiPlatform::new(root.clone(), None);
        let old = platform
            .update_message(
                "--F--workspace-demo--::2026-06-01T16-48-15-428Z_s1::u1::0::text",
                "new",
            )
            .expect("update");
        assert_eq!(old, "old");

        let raw = fs::read_to_string(path).expect("read updated");
        assert!(raw.contains("\"text\":\"new\""));

        fs::remove_dir_all(root).ok();
    }

    impl PiPlatform {
        fn read_jsonl_from_str(raw: &str) -> Vec<Value> {
            raw.lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str::<Value>(line).expect("json line"))
                .collect()
        }
    }
}
