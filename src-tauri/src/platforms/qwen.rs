use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use super::{
    extract_snippet, tool_text_from_value, ContentMatch, PlatformAdapter,
    SessionDetail, SessionListItem, SessionListResult, TimelineBlock, ToolCallBlock,
};

/// Qwen Code (a Gemini CLI fork) persists each chat as JSONL under
/// `<home>/projects/<encoded-cwd>/chats/<session-id>.jsonl`, together with a
/// `<session-id>.title.json` and a `<session-id>.runtime.json` sidecar.
pub struct QwenPlatform {
    qwen_home: PathBuf,
}

struct QwenFile {
    project: String,
    stem: String,
    path: PathBuf,
}

impl QwenPlatform {
    pub fn new(qwen_home: PathBuf) -> Self {
        Self { qwen_home }
    }

    fn sessions_root(&self) -> PathBuf {
        self.qwen_home.join("projects")
    }

    fn collect_session_files(&self) -> Vec<QwenFile> {
        let mut result = Vec::new();
        let Ok(projects) = fs::read_dir(self.sessions_root()) else {
            return result;
        };
        for project in projects.flatten() {
            let project_dir = project.path();
            if !project_dir.is_dir() {
                continue;
            }
            let Some(project_name) = project_dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let chats_dir = project_dir.join("chats");
            let Ok(chats) = fs::read_dir(&chats_dir) else {
                continue;
            };
            for chat in chats.flatten() {
                let path = chat.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                result.push(QwenFile {
                    project: project_name.to_string(),
                    stem: stem.to_string(),
                    path,
                });
            }
        }
        result
    }

    fn key(project: &str, stem: &str) -> String {
        format!("{project}::{stem}")
    }

    fn path_for(&self, project: &str, stem: &str) -> PathBuf {
        self.sessions_root()
            .join(project)
            .join("chats")
            .join(format!("{stem}.jsonl"))
    }

    fn sidecar_path(&self, project: &str, stem: &str, suffix: &str) -> PathBuf {
        self.sessions_root()
            .join(project)
            .join("chats")
            .join(format!("{stem}.{suffix}.json"))
    }

    fn read_title(&self, project: &str, stem: &str) -> Option<String> {
        let raw = fs::read_to_string(self.sidecar_path(project, stem, "title")).ok()?;
        let value: Value = serde_json::from_str(&raw).ok()?;
        value
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(ToString::to_string)
    }

    fn read_runtime_cwd(&self, project: &str, stem: &str) -> Option<String> {
        let raw = fs::read_to_string(self.sidecar_path(project, stem, "runtime")).ok()?;
        let value: Value = serde_json::from_str(&raw).ok()?;
        value
            .get("work_dir")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    }

    fn read_records(path: &Path) -> Vec<(usize, Value)> {
        let Ok(raw) = fs::read_to_string(path) else {
            return Vec::new();
        };
        raw.lines()
            .enumerate()
            .filter_map(|(line_index, line)| {
                let line = line.trim();
                if line.is_empty() {
                    return None;
                }
                serde_json::from_str::<Value>(line)
                    .ok()
                    .map(|value| (line_index, value))
            })
            .collect()
    }

    fn first_user_text(&self, path: &Path) -> String {
        let records = Self::read_records(path);
        records
            .iter()
            .find_map(|(_, record)| user_text(record))
            .unwrap_or_default()
    }

    fn scan_item(&self, file: &QwenFile, alias_map: &HashMap<String, String>) -> Option<SessionListItem> {
        let session_key = Self::key(&file.project, &file.stem);
        let title = self.read_title(&file.project, &file.stem);
        let preview = self.first_user_text(&file.path);
        let first_line = Self::read_records(&file.path).into_iter().next();
        let cwd = self
            .read_runtime_cwd(&file.project, &file.stem)
            .or_else(|| {
                first_line
                    .as_ref()
                    .and_then(|(_, record)| record.get("cwd"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| file.project.clone());
        let updated_at = self
            .read_sidecar_updated_at(&file.project, &file.stem)
            .or_else(|| file_mtime_iso(&file.path))
            .unwrap_or_default();
        let alias_title = alias_map.get(&session_key).cloned().unwrap_or_default();
        let display_title = if !alias_title.is_empty() {
            alias_title.clone()
        } else if let Some(title) = title {
            title
        } else if !preview.is_empty() {
            preview.lines().next().unwrap_or_default().chars().take(60).collect()
        } else {
            file.stem.clone()
        };

        Some(SessionListItem {
            platform: "qwen".to_string(),
            session_key,
            session_id: file.stem.clone(),
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

    fn read_sidecar_updated_at(&self, project: &str, stem: &str) -> Option<String> {
        let candidates = [
            self.sidecar_path(project, stem, "title"),
            self.sidecar_path(project, stem, "runtime"),
        ];
        for path in candidates {
            let Ok(raw) = fs::read_to_string(path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if let Some(updated) = value.get("updatedAt").and_then(Value::as_str) {
                return Some(updated.to_string());
            }
        }
        None
    }

    fn blocks(&self, records: &[(usize, Value)]) -> Vec<TimelineBlock> {
        let mut blocks: Vec<TimelineBlock> = Vec::new();
        let mut pending_calls: Vec<ToolCallBlock> = Vec::new();

        for (line_index, record) in records {
            let record_type = record.get("type").and_then(Value::as_str).unwrap_or_default();
            let timestamp = record.get("timestamp").and_then(Value::as_str);

            match record_type {
                "user" if is_real_user(record) => {
                    flush_pending(&mut blocks, &mut pending_calls, *line_index);
                    let Some(parts) = record
                        .get("message")
                        .and_then(|message| message.get("parts"))
                        .and_then(Value::as_array)
                    else {
                        continue;
                    };
                    for (part_index, part) in parts.iter().enumerate() {
                        let Some(text) = part.get("text").and_then(Value::as_str) else {
                            continue;
                        };
                        if text.trim().is_empty() {
                            continue;
                        }
                        blocks.push(TimelineBlock {
                            id: format!("{line_index}:{part_index}:user"),
                            role: "user".to_string(),
                            content: text.to_string(),
                            editable: true,
                            edit_target: format!(
                                "{line_index}::{part_index}::text"
                            ),
                            source_meta: json!({
                                "lineIndex": line_index,
                                "partIndex": part_index,
                                "createdAt": timestamp,
                            }),
                            tool_calls: Vec::new(),
                        });
                    }
                }
                "assistant" => {
                    let Some(parts) = record
                        .get("message")
                        .and_then(|message| message.get("parts"))
                        .and_then(Value::as_array)
                    else {
                        continue;
                    };
                    let mut text_blocks: Vec<TimelineBlock> = Vec::new();
                    let mut thought_blocks: Vec<TimelineBlock> = Vec::new();
                    let mut calls: Vec<ToolCallBlock> = Vec::new();

                    for (part_index, part) in parts.iter().enumerate() {
                        if let Some(call) = part.get("functionCall") {
                            calls.push(qwen_tool_call(call, *line_index, part_index));
                            continue;
                        }
                        let Some(text) = part.get("text").and_then(Value::as_str) else {
                            continue;
                        };
                        if text.trim().is_empty() {
                            continue;
                        }
                        let is_thought = part
                            .get("thought")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let field = if is_thought { "thought" } else { "text" };
                        let block = TimelineBlock {
                            id: format!(
                                "{line_index}:{part_index}:{}",
                                if is_thought { "thinking" } else { "assistant" }
                            ),
                            role: if is_thought { "thinking" } else { "assistant" }.to_string(),
                            content: text.to_string(),
                            editable: true,
                            edit_target: format!("{line_index}::{part_index}::{field}"),
                            source_meta: json!({
                                "lineIndex": line_index,
                                "partIndex": part_index,
                                "createdAt": timestamp,
                            }),
                            tool_calls: Vec::new(),
                        };
                        if is_thought {
                            thought_blocks.push(block);
                        } else {
                            text_blocks.push(block);
                        }
                    }

                    let had_blocks = !text_blocks.is_empty() || !thought_blocks.is_empty();
                    let had_calls = !calls.is_empty();
                    blocks.extend(thought_blocks);
                    if let Some(last) = text_blocks.last_mut() {
                        last.tool_calls.append(&mut calls);
                    }
                    blocks.extend(text_blocks);

                    if !had_blocks && had_calls {
                        blocks.push(TimelineBlock {
                            id: format!("{line_index}:tool-calls:assistant"),
                            role: "assistant".to_string(),
                            content: String::new(),
                            editable: false,
                            edit_target: String::new(),
                            source_meta: json!({
                                "lineIndex": line_index,
                                "itemType": "tool_calls",
                                "createdAt": timestamp,
                            }),
                            tool_calls: calls,
                        });
                    } else {
                        pending_calls.append(&mut calls);
                    }
                }
                "tool_result" => {
                    for (part_index, part) in record
                        .get("message")
                        .and_then(|message| message.get("parts"))
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_default()
                        .iter()
                        .enumerate()
                    {
                        if let Some(response) = part.get("functionResponse") {
                            let tool_call =
                                qwen_tool_result(response, *line_index, part_index);
                            if !merge_tool_result(&mut blocks, &mut pending_calls, tool_call.clone())
                            {
                                pending_calls.push(tool_call);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        flush_pending(&mut blocks, &mut pending_calls, records.len());
        blocks
    }

    fn searchable_entries(&self, records: &[(usize, Value)]) -> Vec<(usize, String, Vec<String>)> {
        let mut entries = Vec::new();
        for (idx, (_, record)) in records.iter().enumerate() {
            let record_type = record.get("type").and_then(Value::as_str).unwrap_or_default();
            let role = match record_type {
                "user" if is_real_user(record) => "user",
                "assistant" => "assistant",
                "tool_result" => "tool",
                _ => continue,
            };
            let mut texts = Vec::new();
            if let Some(parts) = record
                .get("message")
                .and_then(|message| message.get("parts"))
                .and_then(Value::as_array)
            {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        texts.push(text.to_string());
                    }
                    if let Some(call) = part.get("functionCall") {
                        if let Some(name) = call.get("name").and_then(Value::as_str) {
                            texts.push(name.to_string());
                        }
                        if let Some(args) = call.get("args") {
                            texts.push(args.to_string());
                        }
                    }
                    if let Some(response) = part.get("functionResponse") {
                        if let Some(name) = response.get("name").and_then(Value::as_str) {
                            texts.push(name.to_string());
                        }
                        if let Some(value) = response.get("response") {
                            texts.push(value.to_string());
                        }
                    }
                }
            }
            if texts.is_empty() {
                continue;
            }
            entries.push((idx, role.to_string(), texts));
        }
        entries
    }
}

fn is_real_user(record: &Value) -> bool {
    if let Some(provenance) = record.get("provenance").and_then(Value::as_str) {
        if provenance != "real_user" {
            return false;
        }
    }
    matches!(
        record.get("subtype").and_then(Value::as_str),
        None | Some("mid_turn_user_message") | Some("realtime_message")
    )
}

fn user_text(record: &Value) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("user") || !is_real_user(record) {
        return None;
    }
    record
        .get("message")
        .and_then(|message| message.get("parts"))
        .and_then(Value::as_array)?
        .iter()
        .find_map(|part| {
            let text = part.get("text").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        })
}

fn qwen_tool_call(call: &Value, line_index: usize, part_index: usize) -> ToolCallBlock {
    ToolCallBlock {
        id: call
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:{part_index}:tool_call")),
        name: call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_use".to_string(),
        status: "requested".to_string(),
        input: call.get("args").and_then(|args| tool_text_from_value(args, 8192)),
        output: None,
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "lineIndex": line_index,
            "partIndex": part_index,
            "itemType": "tool_call",
        }),
    }
}

fn qwen_tool_result(response: &Value, line_index: usize, part_index: usize) -> ToolCallBlock {
    let is_error = response
        .get("response")
        .and_then(|value| value.get("error"))
        .map(|value| !value.is_null())
        .unwrap_or(false);
    ToolCallBlock {
        id: response
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{line_index}:{part_index}:tool_result")),
        name: response
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_result".to_string(),
        status: if is_error { "error" } else { "completed" }.to_string(),
        input: None,
        output: response
            .get("response")
            .and_then(|value| tool_text_from_value(value, 32768)),
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "lineIndex": line_index,
            "partIndex": part_index,
            "itemType": "tool_result",
        }),
    }
}

fn merge_tool_result(
    blocks: &mut [TimelineBlock],
    pending: &mut [ToolCallBlock],
    result: ToolCallBlock,
) -> bool {
    for block in blocks.iter_mut().rev() {
        if let Some(existing) = block
            .tool_calls
            .iter_mut()
            .find(|call| call.id == result.id)
        {
            existing.status = result.status;
            existing.output = result.output;
            return true;
        }
    }
    for existing in pending.iter_mut().rev() {
        if existing.id == result.id {
            existing.status = result.status;
            existing.output = result.output;
            return true;
        }
    }
    false
}

fn flush_pending(blocks: &mut Vec<TimelineBlock>, pending: &mut Vec<ToolCallBlock>, line_index: usize) {
    if pending.is_empty() {
        return;
    }
    if let Some(last) = blocks.last_mut() {
        if last.role == "assistant" {
            last.tool_calls.append(pending);
            return;
        }
    }
    blocks.push(TimelineBlock {
        id: format!("{line_index}:tool-calls:assistant"),
        role: "assistant".to_string(),
        content: String::new(),
        editable: false,
        edit_target: String::new(),
        source_meta: json!({ "lineIndex": line_index, "itemType": "tool_calls" }),
        tool_calls: std::mem::take(pending),
    });
}

fn file_mtime_iso(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    chrono::DateTime::from_timestamp_millis(millis).map(|dt| dt.to_rfc3339())
}

fn iso_to_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

impl PlatformAdapter for QwenPlatform {
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
            let left = iso_to_millis(&a.updated_at).unwrap_or_default();
            let right = iso_to_millis(&b.updated_at).unwrap_or_default();
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
        let (project, stem) = session_key
            .split_once("::")
            .ok_or_else(|| format!("invalid session key: {session_key}"))?;
        let path = self.path_for(project, stem);
        if !path.exists() {
            return Err(format!("session file not found: {}", path.display()));
        }

        let records = Self::read_records(&path);
        let mut blocks = self.blocks(&records);
        let prefix = format!("{session_key}::");
        for block in &mut blocks {
            if block.editable && !block.edit_target.starts_with(&prefix) {
                block.edit_target = format!("{session_key}::{}", block.edit_target);
            }
        }

        let first_record = records.first().map(|(_, record)| record);
        let cwd = self
            .read_runtime_cwd(project, stem)
            .or_else(|| {
                first_record
                    .and_then(|record| record.get("cwd"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| project.to_string());
        let preview = records.iter().find_map(|(_, record)| user_text(record));
        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if !alias_title.is_empty() {
            alias_title.clone()
        } else {
            self.read_title(project, stem).unwrap_or_else(|| {
                preview
                    .as_deref()
                    .and_then(|preview| preview.lines().next())
                    .unwrap_or_default()
                    .chars()
                    .take(60)
                    .collect()
            })
        };

        Ok(SessionDetail {
            platform: "qwen".to_string(),
            session_key: session_key.to_string(),
            session_id: stem.to_string(),
            title,
            alias_title,
            cwd,
            commands: HashMap::new(),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        // {project}::{stem}::{line_index}::{part_index}::{field}
        let parts: Vec<&str> = edit_target.splitn(5, "::").collect();
        if parts.len() != 5 {
            return Err(format!("invalid edit_target: {edit_target}"));
        }
        let (project, stem, line_index, part_index, field) = (
            parts[0],
            parts[1],
            parts[2].parse::<usize>().map_err(|_| "invalid line index")?,
            parts[3].parse::<usize>().map_err(|_| "invalid part index")?,
            parts[4],
        );
        if field != "text" && field != "thought" {
            return Err(format!("unknown field: {field}"));
        }

        let path = self.path_for(project, stem);
        let raw = fs::read_to_string(&path).map_err(|e| format!("cannot read session: {e}"))?;
        let mut lines: Vec<String> = raw.lines().map(ToString::to_string).collect();
        let line = lines
            .get_mut(line_index)
            .ok_or_else(|| format!("line {line_index} not found"))?;
        let mut record: Value =
            serde_json::from_str(line).map_err(|e| format!("cannot parse line: {e}"))?;
        let part = record
            .get_mut("message")
            .and_then(|message| message.get_mut("parts"))
            .and_then(Value::as_array_mut)
            .and_then(|parts| parts.get_mut(part_index))
            .ok_or_else(|| format!("part {part_index} not found"))?;
        let old = part
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        part["text"] = Value::String(new_content.to_string());

        *line = serde_json::to_string(&record).map_err(|e| format!("cannot serialize line: {e}"))?;
        fs::write(&path, format!("{}\n", lines.join("\n")))
            .map_err(|e| format!("cannot write session: {e}"))?;
        Ok(old)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let lower = query.to_lowercase();
        if session_key.to_lowercase().contains(&lower) {
            return true;
        }
        let Some((project, stem)) = session_key.split_once("::") else {
            return false;
        };
        let Ok(raw) = fs::read_to_string(self.path_for(project, stem)) else {
            return false;
        };
        raw.to_lowercase().contains(&lower)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let Some((project, stem)) = session_key.split_once("::") else {
            return vec![];
        };
        let path = self.path_for(project, stem);
        if !path.exists() {
            return vec![];
        }
        let lower = query.to_lowercase();
        let records = Self::read_records(&path);
        self.searchable_entries(&records)
            .into_iter()
            .filter_map(|(idx, role, texts)| {
                if !texts
                    .iter()
                    .any(|text| text.to_lowercase().contains(&lower))
                {
                    return None;
                }
                let best = texts
                    .iter()
                    .find(|text| text.to_lowercase().contains(&lower))
                    .cloned()
                    .unwrap_or_default();
                if best.is_empty() {
                    return None;
                }
                Some(ContentMatch {
                    snippet: extract_snippet(&best, &lower),
                    match_index: idx,
                    role,
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
        let home = base.join(format!("qwen-{label}-{}", Uuid::new_v4()));
        let dir = home.join("projects").join("e--workspace-20260402").join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");

        let lines = vec![
            json!({"uuid":"u1","sessionId":"session-1","timestamp":"2026-11-11T03:33:00.787Z",
                "type":"user","provenance":"real_user","cwd":"E:\\workspace\\20260402",
                "message":{"role":"user","parts":[{"text":"你好"}]}}),
            json!({"uuid":"s1","sessionId":"session-1","timestamp":"2026-11-11T03:33:00.853Z",
                "type":"system","subtype":"memory_catalog_snapshot",
                "message":{"role":"user","parts":[{"text":"internal catalog"}]}}),
            json!({"uuid":"a1","sessionId":"session-1","timestamp":"2026-11-11T03:33:07.003Z",
                "type":"assistant","message":{"role":"model","parts":[
                    {"text":"先想想","thought":true},
                    {"text":"我来读文件"},
                    {"functionCall":{"id":"call-1","name":"read_file","args":{"path":"a.md"}}}
                ]}}),
            json!({"uuid":"t1","sessionId":"session-1","timestamp":"2026-11-11T03:33:08.000Z",
                "type":"tool_result",
                "message":{"role":"user","parts":[
                    {"functionResponse":{"id":"call-1","name":"read_file","response":{"output":"file body"}}}
                ]}}),
        ];
        let mut text = String::new();
        for line in lines {
            text.push_str(&serde_json::to_string(&line).unwrap());
            text.push('\n');
        }
        fs::write(dir.join("session-1.jsonl"), text).expect("write session");
        fs::write(
            dir.join("session-1.title.json"),
            r#"{"version":1,"displayName":"你好","source":"prompt","updatedAt":"2026-11-11T03:33:00.848Z"}"#,
        )
        .expect("write title");
        fs::write(
            dir.join("session-1.runtime.json"),
            r#"{"session_id":"session-1","work_dir":"E:\\workspace\\20260402","qwen_version":"0.27.2"}"#,
        )
        .expect("write runtime");
        home
    }

    #[test]
    fn lists_and_parses_qwen_sessions() {
        let home = test_home("list");
        let platform = QwenPlatform::new(home.clone());

        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(listed.items[0].platform, "qwen");
        assert_eq!(listed.items[0].display_title, "你好");
        assert_eq!(listed.items[0].cwd, "E:\\workspace\\20260402");
        assert_eq!(listed.items[0].preview, "你好");

        let detail = platform
            .get_session_detail(&listed.items[0].session_key, &HashMap::new())
            .expect("detail");
        assert_eq!(detail.platform, "qwen");
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(
            detail.blocks[2].tool_calls[0].output.as_deref(),
            Some("{\n  \"output\": \"file body\"\n}")
        );

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn edits_user_and_thinking_messages() {
        let home = test_home("edit");
        let platform = QwenPlatform::new(home.clone());
        let key = platform.list_sessions(&HashMap::new(), None, 0).items[0]
            .session_key
            .clone();
        let detail = platform.get_session_detail(&key, &HashMap::new()).expect("detail");

        let user_target = detail.blocks[0].edit_target.clone();
        assert_eq!(
            platform.update_message(&user_target, "换个问题").expect("edit user"),
            "你好"
        );
        let think_target = detail.blocks[1].edit_target.clone();
        assert_eq!(
            platform.update_message(&think_target, "重新想").expect("edit thought"),
            "先想想"
        );

        let detail = platform.get_session_detail(&key, &HashMap::new()).expect("reread");
        assert!(detail.blocks.iter().any(|block| block.content == "换个问题"));
        assert!(detail.blocks.iter().any(|block| block.content == "重新想"));

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn searches_qwen_sessions() {
        let home = test_home("search");
        let platform = QwenPlatform::new(home.clone());
        let key = platform.list_sessions(&HashMap::new(), None, 0).items[0]
            .session_key
            .clone();

        assert!(platform.matches_query(&key, "file body"));
        assert!(platform.matches_query(&key, "你好"));
        assert!(!platform.matches_query(&key, "不存在的词"));
        assert!(platform.content_search(&key, "file body").len() == 1);
        assert!(platform.content_search(&key, "不存在的词").is_empty());

        fs::remove_dir_all(&home).ok();
    }
}

