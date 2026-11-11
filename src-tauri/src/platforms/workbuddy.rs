use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::{
    build_commands, extract_snippet, tool_text_from_str, tool_text_from_value, ContentMatch,
    SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock, ToolCallBlock,
};

/// WorkBuddy (Tencent CodeBuddy desktop) keeps session metadata in a plain
/// SQLite database and local transcripts as Claude-Code-style JSONL files.
/// Cloud sessions (`transport = 'cloud'`) only have metadata on disk.
pub struct WorkBuddyPlatform {
    home: PathBuf,
}

impl WorkBuddyPlatform {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn db_path(&self) -> PathBuf {
        self.home.join("workbuddy.db")
    }

    fn projects_root(&self) -> PathBuf {
        self.home.join("projects")
    }

    fn connect(&self) -> Result<rusqlite::Connection, String> {
        rusqlite::Connection::open(self.db_path())
            .map_err(|e| format!("Failed to open workbuddy db: {e}"))
    }

    /// Map `<sessionId>.jsonl` file stems to their paths. The directory name is
    /// an encoded cwd, so we deliberately don't try to derive it.
    fn transcript_index(&self) -> HashMap<String, PathBuf> {
        let mut index = HashMap::new();
        let Ok(dirs) = fs::read_dir(self.projects_root()) else {
            return index;
        };
        for dir in dirs.flatten() {
            let Ok(files) = fs::read_dir(dir.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                index.entry(stem.to_string()).or_insert(path);
            }
        }
        index
    }

    fn transcript_for(&self, session_key: &str) -> Option<PathBuf> {
        self.transcript_index().remove(session_key)
    }
}

const SESSION_COLUMNS: &str = "id, \
     COALESCE(NULLIF(custom_title, ''), NULLIF(title, ''), id), \
     COALESCE(cwd, ''), \
     COALESCE(last_activity_at, updated_at), \
     COALESCE(transport, 'local')";

struct SessionRow {
    id: String,
    title: String,
    cwd: String,
    updated_at: i64,
    transport: String,
}

impl SessionRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            title: row.get(1)?,
            cwd: row.get(2)?,
            updated_at: row.get(3)?,
            transport: row.get(4)?,
        })
    }

    fn editable(&self, transcripts: &HashMap<String, PathBuf>) -> bool {
        self.transport == "local" && transcripts.contains_key(&self.id)
    }
}

impl super::PlatformAdapter for WorkBuddyPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        if !self.db_path().exists() {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        }

        let conn = match self.connect() {
            Ok(conn) => conn,
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };

        let sql = format!(
            "SELECT {SESSION_COLUMNS} FROM sessions \
             WHERE deleted_at IS NULL OR deleted_at = -1 \
             ORDER BY COALESCE(last_activity_at, updated_at) DESC"
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(stmt) => stmt,
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };
        let rows: Vec<SessionRow> = match stmt.query_map([], SessionRow::from_row) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };

        // Cloud sessions only keep metadata locally, so there is nothing to
        // browse or edit. Hide them (and any local row whose transcript is
        // missing) instead of showing empty conversations.
        let transcripts = self.transcript_index();
        let rows: Vec<SessionRow> = rows
            .into_iter()
            .filter(|row| transcripts.contains_key(&row.id))
            .collect();
        let total = rows.len();
        let items = rows
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .map(|row| {
                let alias = alias_map.get(&row.id).cloned().unwrap_or_default();
                let display_title = if alias.is_empty() {
                    row.title.clone()
                } else {
                    alias.clone()
                };
                let editable = row.editable(&transcripts);
                SessionListItem {
                    platform: "workbuddy".into(),
                    session_key: row.id.clone(),
                    session_id: row.id.clone(),
                    display_title,
                    alias_title: alias,
                    preview: row.title,
                    updated_at: row.updated_at.to_string(),
                    cwd: row.cwd,
                    editable,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                    source_label: String::new(),
                    agent_group: None,
                }
            })
            .collect();

        SessionListResult { total, items }
    }

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        if !self.db_path().exists() {
            return None;
        }
        let conn = self.connect().ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, COALESCE(last_activity_at, updated_at) FROM sessions \
                 WHERE deleted_at IS NULL OR deleted_at = -1 \
                 ORDER BY COALESCE(last_activity_at, updated_at) DESC",
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let updated_at: i64 = row.get(1)?;
                Ok(SessionKey::standalone(id, updated_at as i128))
            })
            .ok()?;
        let transcripts = self.transcript_index();
        Some(
            rows.flatten()
                .filter(|key| transcripts.contains_key(&key.key))
                .collect(),
        )
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        _cache: Option<&crate::database::SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        let conn = self.connect().ok()?;
        let row: SessionRow = conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
                params![session_key],
                SessionRow::from_row,
            )
            .ok()?;
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let display_title = if alias.is_empty() {
            row.title.clone()
        } else {
            alias.clone()
        };
        let editable = row.editable(&self.transcript_index());

        Some(SessionListItem {
            platform: "workbuddy".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            display_title,
            alias_title: alias,
            preview: row.title,
            updated_at: row.updated_at.to_string(),
            cwd: row.cwd,
            editable,
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
        let conn = self.connect()?;
        let row: Option<SessionRow> = conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
                params![session_key],
                SessionRow::from_row,
            )
            .optional()
            .map_err(|e| format!("Failed to read WorkBuddy session: {e}"))?;
        let row = row.ok_or_else(|| format!("WorkBuddy session not found: {session_key}"))?;

        let blocks = match self.transcript_for(session_key) {
            Some(path) => parse_transcript(&path),
            None => Vec::new(),
        };

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if alias.is_empty() {
            row.title
        } else {
            alias.clone()
        };

        Ok(SessionDetail {
            platform: "workbuddy".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd: row.cwd,
            commands: build_commands("workbuddy", session_key),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        if parts.len() != 4 {
            return Err(format!("Invalid WorkBuddy edit target: {edit_target}"));
        }

        let path = Path::new(parts[0]);
        let line_index: usize = parts[1]
            .parse()
            .map_err(|error| format!("Invalid line index: {error}"))?;
        let content_index: usize = parts[2]
            .parse()
            .map_err(|error| format!("Invalid content index: {error}"))?;
        let field = parts[3];

        let mut lines = read_jsonl(path);
        if line_index >= lines.len() {
            return Err("Line index out of range".to_string());
        }

        let old = match field {
            "reasoning" => {
                let item = lines[line_index]
                    .get_mut("rawContent")
                    .and_then(Value::as_array_mut)
                    .and_then(|items| items.get_mut(content_index))
                    .ok_or_else(|| "Reasoning content index out of range".to_string())?;
                let old = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                item["text"] = Value::String(new_content.to_string());
                old
            }
            "user_query" => {
                let item = lines[line_index]
                    .get_mut("content")
                    .and_then(Value::as_array_mut)
                    .and_then(|items| items.get_mut(content_index))
                    .ok_or_else(|| "Content index out of range".to_string())?;
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let (updated, old) = replace_user_query(&text, new_content);
                item["text"] = Value::String(updated);
                old
            }
            _ => {
                let item = lines[line_index]
                    .get_mut("content")
                    .and_then(Value::as_array_mut)
                    .and_then(|items| items.get_mut(content_index))
                    .ok_or_else(|| "Content index out of range".to_string())?;
                let old = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                item["text"] = Value::String(new_content.to_string());
                old
            }
        };

        let serialized = lines
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Serialize error: {error}"))?;
        write_jsonl(path, &serialized)?;

        Ok(old)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return true;
        }

        if self
            .session_list_item(session_key, &HashMap::new(), None)
            .is_some_and(|item| {
                item.display_title.to_lowercase().contains(&needle)
                    || item.cwd.to_lowercase().contains(&needle)
            })
        {
            return true;
        }

        self.transcript_for(session_key).is_some_and(|path| {
            transcript_texts(&path)
                .iter()
                .any(|text| text.contains(&needle))
        })
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return vec![];
        }

        let Some(path) = self.transcript_for(session_key) else {
            return vec![];
        };
        let lines = read_jsonl(&path);
        let mut matches = Vec::new();
        let mut block_index = 0usize;

        for line in &lines {
            match line.get("type").and_then(Value::as_str).unwrap_or("") {
                "message" => {
                    let role = line.get("role").and_then(Value::as_str).unwrap_or("user");
                    let Some(items) = line.get("content").and_then(Value::as_array) else {
                        continue;
                    };
                    for item in items {
                        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                        let mut texts = Vec::new();
                        match item_type {
                            "input_text" | "output_text" | "text" => {
                                let raw = item.get("text").and_then(Value::as_str).unwrap_or("");
                                if role == "user" {
                                    texts.push(user_query_text(raw));
                                } else {
                                    texts.push(raw.to_string());
                                }
                            }
                            "tool_use" | "function_call" => {
                                if let Some(name) = item.get("name").and_then(Value::as_str) {
                                    texts.push(name.to_string());
                                }
                                if let Some(input) = item.get("input") {
                                    if let Some(text) = tool_text_from_value(input, 8192) {
                                        texts.push(text);
                                    }
                                }
                            }
                            "tool_result" | "function_call_output" => {
                                if let Some(output) = tool_result_content(item) {
                                    texts.push(output);
                                }
                            }
                            _ => {}
                        }
                        for text in &texts {
                            if text.to_lowercase().contains(&needle) {
                                matches.push(ContentMatch {
                                    snippet: extract_snippet(text, &needle),
                                    match_index: block_index,
                                    role: role.to_string(),
                                });
                            }
                        }
                        block_index += 1;
                    }
                }
                "reasoning" => {
                    if let Some(items) = line.get("rawContent").and_then(Value::as_array) {
                        for item in items {
                            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                            if text.to_lowercase().contains(&needle) {
                                matches.push(ContentMatch {
                                    snippet: extract_snippet(text, &needle),
                                    match_index: block_index,
                                    role: "thinking".to_string(),
                                });
                            }
                            block_index += 1;
                        }
                    }
                }
                _ => {}
            }
        }

        matches
    }
}

fn parse_transcript(path: &Path) -> Vec<TimelineBlock> {
    let lines = read_jsonl(path);
    let mut blocks: Vec<TimelineBlock> = Vec::new();
    let mut pending_tools: Vec<ToolCallBlock> = Vec::new();
    let edit_prefix = path.display().to_string();

    for (line_index, line) in lines.iter().enumerate() {
        let created_at = line.get("timestamp").and_then(Value::as_i64);
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                let role = line.get("role").and_then(Value::as_str).unwrap_or("");
                let Some(items) = line.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for (content_index, item) in items.iter().enumerate() {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                    match item_type {
                        "input_text" | "output_text" | "text" => {
                            let raw = item.get("text").and_then(Value::as_str).unwrap_or("");
                            let (text, edit_field) = if role == "user" {
                                (user_query_text(raw), "user_query")
                            } else {
                                (raw.to_string(), "text")
                            };
                            if text.trim().is_empty() {
                                continue;
                            }
                            let block = TimelineBlock {
                                id: format!("{line_index}:{content_index}:{role}"),
                                role: if role == "assistant" {
                                    "assistant".to_string()
                                } else {
                                    "user".to_string()
                                },
                                content: text,
                                editable: true,
                                edit_target: format!(
                                    "{edit_prefix}::{line_index}::{content_index}::{edit_field}"
                                ),
                                source_meta: json!({
                                    "lineIndex": line_index,
                                    "contentIndex": content_index,
                                    "createdAt": created_at,
                                    "transport": "local",
                                }),
                                tool_calls: Vec::new(),
                            };
                            push_block(&mut blocks, &mut pending_tools, block);
                        }
                        "tool_use" | "function_call" => {
                            let tool = tool_use_block(item, line_index, content_index);
                            match blocks.last_mut() {
                                Some(last) if last.role == "assistant" => {
                                    last.tool_calls.push(tool);
                                }
                                _ => pending_tools.push(tool),
                            }
                        }
                        "tool_result" | "function_call_output" => {
                            let result = tool_result_block(item, line_index, content_index);
                            if !merge_tool_result(&mut blocks, &result) {
                                pending_tools.push(result);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "reasoning" => {
                let Some(items) = line.get("rawContent").and_then(Value::as_array) else {
                    continue;
                };
                for (content_index, item) in items.iter().enumerate() {
                    let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() {
                        continue;
                    }
                    let mut block = TimelineBlock {
                        id: format!("{line_index}:{content_index}:thinking"),
                        role: "thinking".to_string(),
                        content: text.to_string(),
                        editable: true,
                        edit_target: format!(
                            "{edit_prefix}::{line_index}::{content_index}::reasoning"
                        ),
                        source_meta: json!({
                            "lineIndex": line_index,
                            "contentIndex": content_index,
                            "createdAt": created_at,
                            "transport": "local",
                        }),
                        tool_calls: Vec::new(),
                    };
                    block.tool_calls.append(&mut pending_tools);
                    blocks.push(block);
                }
            }
            _ => {}
        }
    }

    if !pending_tools.is_empty() {
        if let Some(last) = blocks.last_mut() {
            if last.role == "assistant" {
                last.tool_calls.append(&mut pending_tools);
            }
        }
        if !pending_tools.is_empty() {
            blocks.push(TimelineBlock {
                id: "tools".to_string(),
                role: "assistant".to_string(),
                content: String::new(),
                editable: false,
                edit_target: String::new(),
                source_meta: json!({"itemType": "tool_calls", "transport": "local"}),
                tool_calls: std::mem::take(&mut pending_tools),
            });
        }
    }

    blocks
}

fn push_block(
    blocks: &mut Vec<TimelineBlock>,
    pending_tools: &mut Vec<ToolCallBlock>,
    mut block: TimelineBlock,
) {
    if block.role == "assistant" {
        block.tool_calls.append(pending_tools);
    } else if !pending_tools.is_empty() {
        if let Some(last) = blocks.last_mut() {
            if last.role == "assistant" {
                last.tool_calls.append(pending_tools);
            }
        }
    }
    blocks.push(block);
}

fn tool_use_block(item: &Value, line_index: usize, content_index: usize) -> ToolCallBlock {
    ToolCallBlock {
        id: item
            .get("id")
            .or_else(|| item.get("call_id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:{content_index}:tool_use")),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_use".to_string(),
        status: "requested".to_string(),
        input: item
            .get("input")
            .or_else(|| item.get("arguments"))
            .and_then(|value| tool_text_from_value(value, 8192)),
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

fn tool_result_block(item: &Value, line_index: usize, content_index: usize) -> ToolCallBlock {
    let is_error = item
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ToolCallBlock {
        id: item
            .get("tool_use_id")
            .or_else(|| item.get("call_id"))
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:{content_index}:tool_result")),
        name: item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_result".to_string(),
        status: if is_error { "error" } else { "completed" }.to_string(),
        input: None,
        output: tool_result_content(item),
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

fn tool_result_content(item: &Value) -> Option<String> {
    let content = item.get("content").or_else(|| item.get("output"))?;
    if let Some(text) = content.as_str() {
        return tool_text_from_str(text, 32768);
    }
    tool_text_from_value(content, 32768)
}

fn merge_tool_result(blocks: &mut [TimelineBlock], result: &ToolCallBlock) -> bool {
    for block in blocks.iter_mut().rev() {
        if let Some(existing) = block
            .tool_calls
            .iter_mut()
            .find(|tool| tool.id == result.id)
        {
            existing.status = result.status.clone();
            existing.output = result.output.clone();
            existing.error = result.error.clone();
            return true;
        }
    }
    false
}

/// Pull the real user input out of WorkBuddy's enriched message text.
fn user_query_text(text: &str) -> String {
    if let Some(start) = text.find("<user_query>") {
        let rest = &text[start + "<user_query>".len()..];
        if let Some(end) = rest.find("</user_query>") {
            return rest[..end].trim().to_string();
        }
    }
    strip_system_reminders(text)
}

fn strip_system_reminders(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let Some(start) = rest.find("<system-reminder") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find("</system-reminder>") else {
            break;
        };
        rest = &rest[start + end + "</system-reminder>".len()..];
    }
    out.trim().to_string()
}

fn replace_user_query(text: &str, new_content: &str) -> (String, String) {
    if let Some(start) = text.find("<user_query>") {
        let open_end = start + "<user_query>".len();
        if let Some(end_rel) = text[open_end..].find("</user_query>") {
            let end = open_end + end_rel;
            let old = text[open_end..end].to_string();
            let updated = format!("{}{}{}", &text[..open_end], new_content, &text[end..]);
            return (updated, old);
        }
    }
    (new_content.to_string(), text.to_string())
}

fn transcript_texts(path: &Path) -> Vec<String> {
    let mut texts = Vec::new();
    for line in read_jsonl(path) {
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                let role = line.get("role").and_then(Value::as_str).unwrap_or("user");
                if let Some(items) = line.get("content").and_then(Value::as_array) {
                    for item in items {
                        match item.get("type").and_then(Value::as_str).unwrap_or("") {
                            "input_text" | "output_text" | "text" => {
                                let raw = item.get("text").and_then(Value::as_str).unwrap_or("");
                                let text = if role == "user" {
                                    user_query_text(raw)
                                } else {
                                    raw.to_string()
                                };
                                texts.push(text.to_lowercase());
                            }
                            "tool_use" | "function_call" => {
                                if let Some(name) = item.get("name").and_then(Value::as_str) {
                                    texts.push(name.to_lowercase());
                                }
                                if let Some(input) = item.get("input") {
                                    if let Some(text) = tool_text_from_value(input, 8192) {
                                        texts.push(text.to_lowercase());
                                    }
                                }
                            }
                            "tool_result" | "function_call_output" => {
                                if let Some(output) = tool_result_content(item) {
                                    texts.push(output.to_lowercase());
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            "reasoning" => {
                if let Some(items) = line.get("rawContent").and_then(Value::as_array) {
                    for item in items {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            texts.push(text.to_lowercase());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    texts
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn write_jsonl(path: &Path, lines: &[String]) -> Result<(), String> {
    let content = format!("{}\n", lines.join("\n"));
    let temp = path.with_extension("jsonl.tmp");
    fs::write(&temp, content).map_err(|error| format!("Write error: {error}"))?;
    fs::rename(&temp, path).map_err(|error| format!("Write error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("workbuddy-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join("projects/hash")).expect("create test directory");
        let home = dir;

        let conn = rusqlite::Connection::open(home.join("workbuddy.db")).expect("open test db");
        conn.execute_batch(
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY,
               cwd TEXT,
               title TEXT,
               custom_title TEXT,
               status TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               last_activity_at INTEGER,
               deleted_at INTEGER NOT NULL DEFAULT -1,
               transport TEXT NOT NULL DEFAULT 'local'
             );
             INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, last_activity_at, transport)
             VALUES ('local-1', 'F:/work', '你好', NULL, 'completed', 1, 100, 100, 'local');
             INSERT INTO sessions (id, title, status, created_at, updated_at, last_activity_at, transport)
             VALUES ('cloud-1', '云端会话', 'completed', 2, 200, 200, 'cloud');",
        )
        .expect("create test schema");

        let transcript = home.join("projects/hash/local-1.jsonl");
        fs::write(
            &transcript,
            [
                json!({
                    "type": "message",
                    "role": "user",
                    "timestamp": 10,
                    "content": [{
                        "type": "input_text",
                        "text": "<system-reminder>ctx</system-reminder>\n<user_query>你好</user_query>"
                    }]
                }),
                json!({
                    "type": "reasoning",
                    "timestamp": 11,
                    "rawContent": [{"type": "reasoning_text", "text": "用户在打招呼"}]
                }),
                json!({
                    "type": "message",
                    "role": "assistant",
                    "timestamp": 12,
                    "content": [
                        {"type": "output_text", "text": "嗨。"},
                        {"type": "tool_use", "id": "call-1", "name": "bash", "input": {"command": "echo hi"}}
                    ]
                }),
                json!({
                    "type": "message",
                    "role": "user",
                    "timestamp": 13,
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "call-1",
                        "content": "hi"
                    }]
                }),
            ]
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .expect("serialize transcript")
            .join("\n")
                + "\n",
        )
        .expect("write transcript");

        home
    }

    fn cleanup(home: &Path) {
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn lists_local_sessions_only() {
        let home = test_home("list");
        let platform = WorkBuddyPlatform::new(home.clone());
        let result = platform.list_sessions(&HashMap::new(), None, 0);

        assert_eq!(result.total, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].session_id, "local-1");
        assert!(result.items[0].editable);
        assert_eq!(result.items[0].display_title, "你好");
        assert_eq!(result.items[0].cwd, "F:/work");

        let keys = platform.list_session_keys().expect("keys");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, "local-1");

        cleanup(&home);
    }

    #[test]
    fn builds_blocks_and_merges_tool_output() {
        let home = test_home("detail");
        let platform = WorkBuddyPlatform::new(home.clone());
        let detail = platform
            .get_session_detail("local-1", &HashMap::new())
            .expect("detail");

        assert_eq!(detail.blocks.len(), 3);
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "你好");
        assert!(detail.blocks[0].edit_target.ends_with("::user_query"));
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(detail.blocks[2].tool_calls[0].name, "bash");
        assert_eq!(detail.blocks[2].tool_calls[0].output.as_deref(), Some("hi"));
        assert_eq!(detail.blocks[2].tool_calls[0].status, "completed");

        let cloud = platform
            .get_session_detail("cloud-1", &HashMap::new())
            .expect("cloud detail");
        assert!(cloud.blocks.is_empty());

        cleanup(&home);
    }

    #[test]
    fn edits_user_query_without_losing_context() {
        let home = test_home("edit");
        let platform = WorkBuddyPlatform::new(home.clone());
        let detail = platform
            .get_session_detail("local-1", &HashMap::new())
            .expect("detail");
        let target = detail.blocks[0].edit_target.clone();

        let old = platform.update_message(&target, "早上好").expect("update");
        assert_eq!(old, "你好");

        let raw = fs::read_to_string(home.join("projects/hash/local-1.jsonl")).unwrap();
        assert!(raw.contains("<system-reminder>ctx</system-reminder>"));
        assert!(raw.contains("<user_query>早上好</user_query>"));

        let reasoning_target = detail.blocks[1].edit_target.clone();
        platform
            .update_message(&reasoning_target, "新的思考")
            .expect("update reasoning");
        let raw = fs::read_to_string(home.join("projects/hash/local-1.jsonl")).unwrap();
        assert!(raw.contains("新的思考"));

        cleanup(&home);
    }

    #[test]
    fn searches_transcript_and_titles() {
        let home = test_home("search");
        let platform = WorkBuddyPlatform::new(home.clone());

        assert!(!platform.matches_query("local-1", "早上好"));
        assert!(platform.matches_query("local-1", "打招呼"));
        assert!(platform.matches_query("local-1", "echo hi"));

        let matches = platform.content_search("local-1", "hi");
        assert!(!matches.is_empty());
        assert!(matches.iter().any(|item| item.role == "assistant"));

        cleanup(&home);
    }
}
