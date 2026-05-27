use std::collections::{HashMap, HashSet};
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
        let response_message_signatures = collect_response_message_signatures(lines);

        for (line_index, line) in lines.iter().enumerate() {
            let Some(payload) = line.get("payload") else {
                continue;
            };

            match payload.get("type").and_then(Value::as_str).unwrap_or_default() {
                "message" => {
                    if let Some(role) = codex_message_role(payload) {
                        for part in codex_message_text_parts(payload) {
                            if !should_include_response_message(role, &part.text) {
                                continue;
                            }

                            let mut block = TimelineBlock {
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
                            block.tool_calls.append(&mut pending_tool_calls);
                            blocks.push(block);
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
                    if response_message_signatures.contains(&("user".to_string(), content.clone())) {
                        continue;
                    }

                    let mut block = TimelineBlock {
                        id: format!("{line_index}:user"),
                        role: "user".to_string(),
                        content,
                        editable: true,
                        edit_target: format!("{file_key}::{line_index}"),
                        source_meta: json!({ "lineIndex": line_index }),
                        tool_calls: Vec::new(),
                    };
                    block.tool_calls.append(&mut pending_tool_calls);
                    blocks.push(block);
                }
                "agent_message" => {
                    let content = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if response_message_signatures.contains(&("assistant".to_string(), content.clone())) {
                        continue;
                    }

                    let mut block = TimelineBlock {
                        id: format!("{line_index}:assistant"),
                        role: "assistant".to_string(),
                        content,
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
        if parts.len() != 2 && parts.len() != 4 {
            return Err(format!("Invalid edit target: {edit_target}"));
        }

        let path = Path::new(parts[0]);
        let line_index: usize = parts[1]
            .parse()
            .map_err(|error| format!("Invalid line index: {error}"))?;
        let mut rows = self.read_jsonl(path);

        let (old_content, role) = if parts.len() == 2 {
            let Some(row) = rows.get_mut(line_index) else {
                return Err("Line index out of range".to_string());
            };
            let Some(payload) = row.get_mut("payload") else {
                return Err("Missing payload".to_string());
            };
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
            (old_content, role)
        } else {
            let content_index: usize = parts[2]
                .parse()
                .map_err(|error| format!("Invalid content index: {error}"))?;
            let field_name = parts[3];

            let Some(row) = rows.get_mut(line_index) else {
                return Err("Line index out of range".to_string());
            };
            let Some(payload) = row.get_mut("payload") else {
                return Err("Missing payload".to_string());
            };

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

            (old_content, role)
        };

        sync_mirrored_message(&mut rows, line_index, &role, &old_content, new_content);

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
        let response_message_signatures = collect_response_message_signatures(&lines);

        for line in &lines {
            let Some(payload) = line.get("payload") else { continue };
            let msg_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            let role = match msg_type {
                "message" => match codex_message_role(payload) {
                    Some(role) => role,
                    None => continue,
                },
                "reasoning" => "thinking",
                "user_message" => "user",
                "agent_message" => "assistant",
                "function_call" | "function_call_output" | "custom_tool_call" | "custom_tool_call_output" | "web_search_call" | "web_search_end" | "patch_apply_end" => "assistant",
                _ => continue,
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
                let signature = (role.to_string(), text.to_string());
                if !response_message_signatures.contains(&signature) {
                    texts.push(text.to_string());
                }
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
        || trimmed.starts_with("The following is the Codex agent history whose request action you are assessing.")
        || trimmed.starts_with("The following is the Codex agent history added since your last approval assessment.")
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

fn sync_mirrored_message(
    rows: &mut [Value],
    changed_line_index: usize,
    role: &str,
    old_content: &str,
    new_content: &str,
) {
    if role.is_empty() || old_content.is_empty() {
        return;
    }

    for (line_index, row) in rows.iter_mut().enumerate() {
        if line_index == changed_line_index {
            continue;
        }
        if line_index.abs_diff(changed_line_index) > 2 {
            continue;
        }

        let Some(payload) = row.get_mut("payload") else {
            continue;
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
                    continue;
                }
                if let Some(content) = payload.get_mut("content") {
                    update_mirrored_response_content(content, old_content, new_content);
                }
            }
            _ => {}
        }
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
