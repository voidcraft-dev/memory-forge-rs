use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{build_commands, extract_snippet, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem, SessionListResult, TimelineBlock};

pub struct KiroIdePlatform {
    agent_home: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KiroIdeSessionIndex {
    session_id: String,
    title: String,
    date_created: String,
    workspace_directory: String,
}

impl KiroIdePlatform {
    pub fn new(agent_home: PathBuf) -> Self {
        Self { agent_home }
    }

    fn workspace_sessions_dir(&self) -> PathBuf {
        self.agent_home.join("workspace-sessions")
    }

    fn session_path(&self, workspace_key: &str, session_id: &str) -> PathBuf {
        self.workspace_sessions_dir()
            .join(workspace_key)
            .join(format!("{session_id}.json"))
    }

    fn index_path(&self, workspace_key: &str) -> PathBuf {
        self.workspace_sessions_dir().join(workspace_key).join("sessions.json")
    }

    fn read_index(&self, workspace_key: &str) -> Vec<KiroIdeSessionIndex> {
        let raw = fs::read_to_string(self.index_path(workspace_key)).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    }

    fn collect_workspace_keys(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.workspace_sessions_dir()) else {
            return Vec::new();
        };

        entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_dir() {
                    return None;
                }
                path.file_name().and_then(|name| name.to_str()).map(str::to_string)
            })
            .collect()
    }

    fn read_session_json(&self, workspace_key: &str, session_id: &str) -> Result<Value, String> {
        let path = self.session_path(workspace_key, session_id);
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read Kiro IDE session '{}': {e}", path.display()))?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse Kiro IDE session '{}': {e}", path.display()))
    }

    fn execution_log_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        collect_possible_log_files(&self.agent_home, &mut files, 0);
        files
    }

    fn execution_outputs(&self, session_id: &str, execution_ids: &HashSet<String>) -> HashMap<String, String> {
        if execution_ids.is_empty() {
            return HashMap::new();
        }

        let t0 = Instant::now();
        let mut outputs = HashMap::new();
        let files = self.execution_log_files();
        let file_count = files.len();

        for path in files {
            if outputs.len() == execution_ids.len() {
                break;
            }

            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if !raw.contains(session_id) {
                continue;
            }

            let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }

            let Some(actions) = parsed.get("actions").and_then(Value::as_array) else {
                continue;
            };
            for action in actions.iter().rev() {
                let Some(execution_id) = action.get("executionId").and_then(Value::as_str) else {
                    continue;
                };
                if !execution_ids.contains(execution_id) || outputs.contains_key(execution_id) {
                    continue;
                }
                if action.get("actionType").and_then(Value::as_str) != Some("say") {
                    continue;
                }
                let Some(message) = action.get("output").and_then(|output| output.get("message")).and_then(Value::as_str) else {
                    continue;
                };
                let message = message.trim();
                if !message.is_empty() {
                    outputs.insert(execution_id.to_string(), message.to_string());
                }
            }
        }

        eprintln!(
            "[perf] kiro-ide execution_outputs session={session_id} files={file_count} requested={} found={}: {:?}",
            execution_ids.len(),
            outputs.len(),
            t0.elapsed()
        );
        outputs
    }

    fn update_execution_output(&self, session_id: &str, execution_id: &str, new_content: &str) -> Result<String, String> {
        let t0 = Instant::now();
        let files = self.execution_log_files();
        let mut old_content = None;
        let mut updated_files = 0usize;
        let mut context_replacements = 0usize;

        for path in &files {
            let raw = match fs::read_to_string(path) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            if !raw.contains(session_id) || !raw.contains(execution_id) {
                continue;
            }
            let mut parsed: Value = match serde_json::from_str(&raw) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            let old = replace_execution_say_output(&mut parsed, execution_id, new_content)?;
            context_replacements += replace_bot_text_occurrences(&mut parsed, &old, new_content);
            let serialized = serde_json::to_string_pretty(&parsed)
                .map_err(|e| format!("Serialize execution log error: {e}"))?;
            fs::write(path, format!("{serialized}\n"))
                .map_err(|e| format!("Write execution log error: {e}"))?;
            old_content = Some(old);
            updated_files += 1;
            break;
        }

        let old_content = old_content.ok_or_else(|| format!("Execution log not found: {execution_id}"))?;

        for path in &files {
            let raw = match fs::read_to_string(path) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            if !raw.contains(session_id) || !raw.contains(&old_content) {
                continue;
            }
            let mut parsed: Value = match serde_json::from_str(&raw) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            let count = replace_bot_text_occurrences(&mut parsed, &old_content, new_content);
            if count == 0 {
                continue;
            }
            let serialized = serde_json::to_string_pretty(&parsed)
                .map_err(|e| format!("Serialize context log error: {e}"))?;
            fs::write(path, format!("{serialized}\n"))
                .map_err(|e| format!("Write context log error: {e}"))?;
            context_replacements += count;
            updated_files += 1;
        }

        eprintln!(
            "[perf] kiro-ide update_execution_output session={session_id} execution={execution_id} files={} updated_files={updated_files} context_replacements={context_replacements}: {:?}",
            files.len(),
            t0.elapsed()
        );
        Ok(old_content)
    }
    fn preview(&self, workspace_key: &str, session_id: &str) -> String {
        let Ok(session) = self.read_session_json(workspace_key, session_id) else {
            return String::new();
        };

        session
            .get("history")
            .and_then(Value::as_array)
            .and_then(|history| {
                history.iter().find_map(|entry| {
                    let content = entry.get("message")?.get("content")?;
                    let text = extract_message_text(content);
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(truncate(&text, 120))
                    }
                })
            })
            .unwrap_or_default()
    }

    fn parse_session_key(session_key: &str) -> Option<(&str, &str)> {
        let mut parts = session_key.splitn(2, "::");
        let workspace_key = parts.next()?;
        let session_id = parts.next()?;
        if workspace_key.is_empty() || session_id.is_empty() {
            return None;
        }
        Some((workspace_key, session_id))
    }
}

impl PlatformAdapter for KiroIdePlatform {
    fn list_sessions(&self, alias_map: &HashMap<String, String>, limit: Option<usize>, offset: usize) -> SessionListResult {
        if !self.workspace_sessions_dir().exists() {
            return SessionListResult { total: 0, items: Vec::new() };
        }

        let mut items = Vec::new();
        for workspace_key in self.collect_workspace_keys() {
            for entry in self.read_index(&workspace_key) {
                let session_key = format!("{workspace_key}::{}", entry.session_id);
                let alias = alias_map.get(&session_key).cloned().unwrap_or_default();
                let display_title = if alias.is_empty() {
                    if entry.title.trim().is_empty() {
                        entry.session_id.clone()
                    } else {
                        entry.title.clone()
                    }
                } else {
                    alias.clone()
                };

                items.push(SessionListItem {
                    platform: "kiro-ide".to_string(),
                    session_key,
                    session_id: entry.session_id.clone(),
                    display_title,
                    alias_title: alias,
                    preview: self.preview(&workspace_key, &entry.session_id),
                    updated_at: entry.date_created,
                    cwd: entry.workspace_directory,
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                });
            }
        }

        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let total = items.len();
        let items = items
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .collect();
        SessionListResult { total, items }
    }

    fn get_session_detail(&self, session_key: &str, alias_map: &HashMap<String, String>) -> Result<SessionDetail, String> {
        let t0 = Instant::now();
        let (workspace_key, session_id) = Self::parse_session_key(session_key)
            .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
        let session = self.read_session_json(workspace_key, session_id)?;
        let index = self
            .read_index(workspace_key)
            .into_iter()
            .find(|entry| entry.session_id == session_id);
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title_raw = index.as_ref().map(|entry| entry.title.as_str()).unwrap_or(session_id);
        let title = if alias.is_empty() {
            if title_raw.trim().is_empty() { session_id.to_string() } else { title_raw.to_string() }
        } else {
            alias.clone()
        };
        let cwd = index
            .as_ref()
            .map(|entry| entry.workspace_directory.clone())
            .unwrap_or_default();

        let history = session
            .get("history")
            .and_then(Value::as_array);
        let execution_ids: HashSet<String> = history
            .map(|history| {
                history
                    .iter()
                    .filter_map(|entry| {
                        let message = entry.get("message")?;
                        let role = message.get("role").and_then(Value::as_str)?;
                        if role != "assistant" {
                            return None;
                        }
                        let content = extract_message_text(message.get("content")?);
                        if content.trim() != "On it." {
                            return None;
                        }
                        entry.get("executionId").and_then(Value::as_str).map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let execution_outputs = self.execution_outputs(session_id, &execution_ids);

        let blocks: Vec<TimelineBlock> = history
            .map(|history| {
                history
                    .iter()
                    .enumerate()
                    .filter_map(|(index, entry)| {
                        let message = entry.get("message")?;
                        let role = message.get("role").and_then(Value::as_str)?;
                        if role != "user" && role != "assistant" {
                            return None;
                        }
                        let message_id = message.get("id").and_then(Value::as_str).unwrap_or("");
                        if message_id.is_empty() {
                            return None;
                        }
                        let mut content = extract_message_text(message.get("content")?);
                        let execution_id = entry.get("executionId").and_then(Value::as_str);
                        if role == "assistant" && content.trim() == "On it." {
                            if let Some(execution_id) = execution_id {
                                if let Some(output) = execution_outputs.get(execution_id) {
                                    content = output.clone();
                                }
                            }
                        }
                        Some(TimelineBlock {
                            id: message_id.to_string(),
                            role: role.to_string(),
                            content,
                            editable: true,
                            edit_target: if role == "assistant" {
                                if let Some(execution_id) = execution_id {
                                    format!("{session_key}::{message_id}::execution::{execution_id}")
                                } else {
                                    format!("{session_key}::{message_id}")
                                }
                            } else {
                                format!("{session_key}::{message_id}")
                            },
                            source_meta: json!({
                                "historyIndex": index,
                                "messageId": message_id,
                                "executionId": execution_id,
                            }),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        eprintln!(
            "[perf] kiro-ide get_session_detail build session={session_id} blocks={}: {:?}",
            blocks.len(),
            t0.elapsed()
        );

        Ok(SessionDetail {
            platform: "kiro-ide".to_string(),
            session_key: session_key.to_string(),
            session_id: session_id.to_string(),
            title,
            alias_title: alias,
            cwd,
            commands: build_commands("kiro-ide", session_id),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        if let Some((session_key, _message_id, execution_id)) = parse_execution_edit_target(edit_target) {
            let (_workspace_key, session_id) = Self::parse_session_key(session_key)
                .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
            return self.update_execution_output(session_id, execution_id, new_content);
        }

        let mut parts = edit_target.rsplitn(2, "::");
        let message_id = parts.next().ok_or_else(|| format!("Invalid edit target: {edit_target}"))?;
        let session_key = parts.next().ok_or_else(|| format!("Invalid edit target: {edit_target}"))?;
        let (workspace_key, session_id) = Self::parse_session_key(session_key)
            .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
        let path = self.session_path(workspace_key, session_id);
        let mut session = self.read_session_json(workspace_key, session_id)?;
        let history = session
            .get_mut("history")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Missing history".to_string())?;

        for entry in history {
            let Some(message) = entry.get_mut("message") else { continue };
            if message.get("id").and_then(Value::as_str) != Some(message_id) {
                continue;
            }
            let content = message
                .get_mut("content")
                .ok_or_else(|| "Missing message content".to_string())?;
            let old = replace_message_text(content, new_content)?;
            let serialized = serde_json::to_string_pretty(&session)
                .map_err(|e| format!("Serialize error: {e}"))?;
            fs::write(&path, format!("{serialized}\n"))
                .map_err(|e| format!("Write error: {e}"))?;
            return Ok(old);
        }

        Err(format!("Message not found: {message_id}"))
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        !self.content_search(session_key, query).is_empty()
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return vec![];
        }
        let Some((workspace_key, session_id)) = Self::parse_session_key(session_key) else {
            return vec![];
        };
        let Ok(session) = self.read_session_json(workspace_key, session_id) else {
            return vec![];
        };

        let mut matches = Vec::new();
        let Some(history) = session.get("history").and_then(Value::as_array) else {
            return matches;
        };
        let mut match_index = 0usize;
        for entry in history {
            let Some(message) = entry.get("message") else { continue };
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let text = message
                .get("content")
                .map(extract_message_text)
                .unwrap_or_default();
            if text.to_lowercase().contains(&needle) {
                matches.push(ContentMatch {
                    snippet: extract_snippet(&text, &needle),
                    match_index,
                    role: role.to_string(),
                });
            }
            match_index += 1;
        }
        matches
    }
}

fn extract_message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn replace_message_text(content: &mut Value, new_content: &str) -> Result<String, String> {
    let old_content = extract_message_text(content);
    if content.is_string() {
        *content = Value::String(new_content.to_string());
        return Ok(old_content);
    }

    if content.is_array() {
        *content = json!([{ "type": "text", "text": new_content }]);
        return Ok(old_content);
    }

    Err("Unsupported Kiro IDE message content shape".to_string())
}

fn replace_execution_say_output(execution_log: &mut Value, execution_id: &str, new_content: &str) -> Result<String, String> {
    let actions = execution_log
        .get_mut("actions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Missing execution actions".to_string())?;

    for action in actions.iter_mut().rev() {
        if action.get("executionId").and_then(Value::as_str) != Some(execution_id) {
            continue;
        }
        let action_type = action.get("actionType").and_then(Value::as_str).unwrap_or("");
        if action_type != "say" {
            continue;
        }
        let output = action
            .get_mut("output")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Missing say output".to_string())?;
        let old = output
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        output.insert("message".to_string(), Value::String(new_content.to_string()));
        return Ok(old);
    }

    Err(format!("Execution output not found: {execution_id}"))
}

fn parse_execution_edit_target(edit_target: &str) -> Option<(&str, &str, &str)> {
    let marker = "::execution::";
    let (prefix, execution_id) = edit_target.rsplit_once(marker)?;
    let (session_key, message_id) = prefix.rsplit_once("::")?;
    if session_key.is_empty() || message_id.is_empty() || execution_id.is_empty() {
        return None;
    }
    Some((session_key, message_id, execution_id))
}

fn replace_bot_text_occurrences(value: &mut Value, old_content: &str, new_content: &str) -> usize {
    if old_content.trim().is_empty() || old_content == new_content {
        return 0;
    }

    let mut count = 0usize;
    count += replace_bot_texts_at_path(value, &["context", "messages"], old_content, new_content);
    count += replace_bot_texts_at_path(value, &["input", "data", "messagesFromExecutionId"], old_content, new_content);
    count
}

fn replace_bot_texts_at_path(value: &mut Value, path: &[&str], old_content: &str, new_content: &str) -> usize {
    let mut current = value;
    for segment in path {
        let Some(next) = current.get_mut(*segment) else {
            return 0;
        };
        current = next;
    }

    let Some(messages) = current.as_array_mut() else {
        return 0;
    };

    let mut count = 0usize;
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("bot") {
            continue;
        }
        let Some(entries) = message.get_mut("entries").and_then(Value::as_array_mut) else {
            continue;
        };
        for entry in entries {
            if entry.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let Some(text) = entry.get_mut("text") else {
                continue;
            };
            if text.as_str() == Some(old_content) {
                *text = Value::String(new_content.to_string());
                count += 1;
            }
        }
    }

    count
}

fn collect_possible_log_files(root: &PathBuf, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
            if file_name == "workspace-sessions" || file_name.starts_with('.') {
                continue;
            }
            collect_possible_log_files(&path, out, depth + 1);
            continue;
        }

        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if extension.is_empty() || extension == "json" {
            out.push(path);
        }
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut result: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        result.push('…');
    }
    result
}

pub fn default_agent_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Kiro").join("User").join("globalStorage").join("kiro.kiroagent"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir()
            .map(|home| home.join(".config").join("Kiro").join("User").join("globalStorage").join("kiro.kiroagent"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_text_from_string_and_array_content() {
        let string_content = json!("On it.");
        let array_content = json!([
            { "type": "text", "text": "first" },
            { "type": "tool_use", "name": "ignored" },
            { "type": "text", "text": "second" }
        ]);

        assert_eq!(extract_message_text(&string_content), "On it.");
        assert_eq!(extract_message_text(&array_content), "first\nsecond");
    }

    #[test]
    fn replaces_string_and_array_content() {
        let mut string_content = json!("On it.");
        let mut array_content = json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" }
        ]);

        assert_eq!(replace_message_text(&mut string_content, "updated").unwrap(), "On it.");
        assert_eq!(string_content, json!("updated"));

        assert_eq!(replace_message_text(&mut array_content, "merged").unwrap(), "first\nsecond");
        assert_eq!(array_content, json!([{ "type": "text", "text": "merged" }]));
    }

    #[test]
    fn replaces_real_assistant_output_in_execution_actions() {
        let mut execution_log = json!({
            "actions": [
                {
                    "executionId": "exec-1",
                    "actionType": "say",
                    "output": { "message": "旧回复" }
                }
            ]
        });

        assert_eq!(replace_execution_say_output(&mut execution_log, "exec-1", "新回复").unwrap(), "旧回复");
        assert_eq!(
            execution_log["actions"][0]["output"]["message"].as_str(),
            Some("新回复")
        );
    }

    #[test]
    fn replaces_bot_context_entries_but_not_human_or_tool_entries() {
        let mut execution_log = json!({
            "context": {
                "messages": [
                    {
                        "role": "bot",
                        "entries": [{ "type": "text", "text": "旧回复" }]
                    },
                    {
                        "role": "human",
                        "entries": [{ "type": "text", "text": "旧回复" }]
                    },
                    {
                        "role": "tool",
                        "entries": [{ "type": "toolUseResponse", "message": "旧回复" }]
                    }
                ]
            },
            "input": {
                "data": {
                    "messagesFromExecutionId": [
                        {
                            "role": "bot",
                            "entries": [{ "type": "text", "text": "旧回复" }]
                        }
                    ]
                }
            }
        });

        assert_eq!(replace_bot_text_occurrences(&mut execution_log, "旧回复", "新回复"), 2);
        assert_eq!(execution_log["context"]["messages"][0]["entries"][0]["text"].as_str(), Some("新回复"));
        assert_eq!(execution_log["input"]["data"]["messagesFromExecutionId"][0]["entries"][0]["text"].as_str(), Some("新回复"));
        assert_eq!(execution_log["context"]["messages"][1]["entries"][0]["text"].as_str(), Some("旧回复"));
        assert_eq!(execution_log["context"]["messages"][2]["entries"][0]["message"].as_str(), Some("旧回复"));
    }
}
