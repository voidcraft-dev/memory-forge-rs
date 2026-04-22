use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{
    extract_snippet, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem,
    SessionListResult, TimelineBlock,
};

pub struct GeminiPlatform {
    gemini_home: PathBuf,
}

impl GeminiPlatform {
    pub fn new(gemini_home: PathBuf) -> Self {
        Self { gemini_home }
    }

    fn read_project_root(&self, source: &str, project_name: &str) -> Option<String> {
        let root = self.gemini_home
            .join(source)
            .join(project_name)
            .join(".project_root");
        fs::read_to_string(&root).ok().map(|s| s.trim().to_string())
    }

    fn collect_session_files(&self) -> Vec<(String, String, PathBuf)> {
        // (project_name, source, file_path)
        let mut result = Vec::new();
        for source in &["tmp", "history"] {
            let source_dir = self.gemini_home.join(source);
            if !source_dir.exists() {
                continue;
            }
            let Ok(entries) = fs::read_dir(&source_dir) else { continue };
            for entry in entries.flatten() {
                let project_dir = entry.path();
                if !project_dir.is_dir() {
                    continue;
                }
                let project_name = match project_dir.file_name().and_then(|n| n.to_str()) {
                    Some(n) if !n.is_empty() => n.to_string(),
                    _ => continue,
                };
                let chats_dir = project_dir.join("chats");
                if !chats_dir.exists() {
                    continue;
                }
                let Ok(chats) = fs::read_dir(&chats_dir) else { continue };
                for chat in chats.flatten() {
                    let p = chat.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("json") {
                        result.push((project_name.clone(), source.to_string(), p));
                    }
                }
            }
        }
        result
    }

    fn build_key(project_name: &str, source: &str, stem: &str) -> String {
        format!("{project_name}::{source}::{stem}")
    }

    // session_key = "{project}::{source}::{stem}"
    fn parse_key(key: &str) -> Option<(&str, &str, &str)> {
        let mut parts = key.splitn(3, "::");
        let project = parts.next()?;
        let source = parts.next()?;
        let stem = parts.next()?;
        Some((project, source, stem))
    }

    fn key_to_path(&self, session_key: &str) -> Option<PathBuf> {
        let (project, source, stem) = Self::parse_key(session_key)?;
        let p = self.gemini_home
            .join(source)
            .join(project)
            .join("chats")
            .join(format!("{stem}.json"));
        if p.exists() { Some(p) } else { None }
    }

    fn quick_scan(path: &Path) -> Option<QuickScan> {
        let raw = fs::read_to_string(path).ok()?;
        let file: GeminiSessionFile = serde_json::from_str(&raw).ok()?;
        let preview = file.messages.iter().find_map(extract_message_text);
        Some(QuickScan {
            session_id: file.session_id,
            start_time: file.start_time.unwrap_or_default(),
            last_updated: file.last_updated.unwrap_or_default(),
            preview: preview.unwrap_or_default(),
        })
    }
}

struct QuickScan {
    session_id: String,
    start_time: String,
    last_updated: String,
    preview: String,
}

fn extract_message_text(msg: &GeminiMessage) -> Option<String> {
    match &msg.content {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.chars().take(200).collect()) }
        }
        serde_json::Value::Array(arr) => {
            arr.iter().find_map(|item| {
                let text = item.get("text")?.as_str()?.trim();
                if text.is_empty() { None } else { Some(text.chars().take(200).collect()) }
            })
        }
        _ => None,
    }
}

fn message_text(msg: &GeminiMessage) -> String {
    extract_message_text(msg).unwrap_or_default()
}


#[derive(Deserialize)]
struct GeminiSessionFile {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "startTime")]
    start_time: Option<String>,
    #[serde(rename = "lastUpdated")]
    last_updated: Option<String>,
    messages: Vec<GeminiMessage>,
}

#[derive(Deserialize)]
struct GeminiMessage {
    id: String,
    #[serde(rename = "type")]
    msg_type: String,
    content: serde_json::Value,
    #[serde(default)]
    thoughts: Vec<GeminiThought>,
}

#[derive(Deserialize, Default)]
struct GeminiThought {
    #[serde(default)]
    subject: String,
    #[serde(default)]
    description: String,
}

impl PlatformAdapter for GeminiPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let mut items: Vec<SessionListItem> = self
            .collect_session_files()
            .into_iter()
            .filter_map(|(project_name, source, path)| {
                let stem = path.file_stem()?.to_str()?.to_string();
                let session_key = Self::build_key(&project_name, &source, &stem);
                let cwd = self
                    .read_project_root(&source, &project_name)
                    .unwrap_or_else(|| project_name.clone());
                let scan = Self::quick_scan(&path)?;
                let alias_title = alias_map.get(&session_key).cloned().unwrap_or_default();
                let display_title = if alias_title.is_empty() {
                    let date = scan.start_time.get(..10).unwrap_or(scan.start_time.as_str());
                    format!("{project_name} · {date}")
                } else {
                    alias_title.clone()
                };
                Some(SessionListItem {
                    platform: "gemini".to_string(),
                    session_key,
                    session_id: scan.session_id,
                    display_title,
                    alias_title,
                    preview: scan.preview,
                    updated_at: scan.last_updated,
                    cwd,
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                })
            })
            .collect();

        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

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
        let (project_name, source, stem) = Self::parse_key(session_key)
            .ok_or_else(|| format!("invalid session key: {session_key}"))?;

        let path = self.gemini_home
            .join(source)
            .join(project_name)
            .join("chats")
            .join(format!("{stem}.json"));

        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("cannot read session file: {e}"))?;
        let session: GeminiSessionFile = serde_json::from_str(&raw)
            .map_err(|e| format!("cannot parse session: {e}"))?;

        let cwd = self
            .read_project_root(source, project_name)
            .unwrap_or_else(|| project_name.to_string());

        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let date = session.start_time.as_deref()
            .and_then(|s| s.get(..10))
            .unwrap_or(project_name);
        let title = if alias_title.is_empty() {
            format!("{project_name} · {date}")
        } else {
            alias_title.clone()
        };

        let mut blocks: Vec<TimelineBlock> = Vec::new();

        for msg in &session.messages {
            let text = message_text(msg);

            // Insert thinking block before gemini response when thoughts are present
            if msg.msg_type == "gemini" && !msg.thoughts.is_empty() {
                let thought_text = msg
                    .thoughts
                    .iter()
                    .filter_map(|t| {
                        let s = t.subject.trim();
                        let d = t.description.trim();
                        if s.is_empty() && d.is_empty() {
                            return None;
                        }
                        Some(if s.is_empty() {
                            d.to_string()
                        } else {
                            format!("**{s}**\n{d}")
                        })
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");

                if !thought_text.is_empty() {
                    blocks.push(TimelineBlock {
                        id: format!("{}_thinking", msg.id),
                        role: "thinking".to_string(),
                        content: thought_text,
                        editable: false,
                        edit_target: String::new(),
                        source_meta: serde_json::json!({
                            "messageId": msg.id,
                            "type": "thinking"
                        }),
                    });
                }
            }

            let (role, field) = match msg.msg_type.as_str() {
                "user" => ("user", "text"),
                "gemini" => ("assistant", "content"),
                _ => continue,
            };

            // edit_target: project::source::stem::msg_id::field (5 parts)
            let edit_target = format!("{session_key}::{}::{field}", msg.id);

            blocks.push(TimelineBlock {
                id: msg.id.clone(),
                role: role.to_string(),
                content: text,
                editable: true,
                edit_target,
                source_meta: serde_json::json!({
                    "messageId": msg.id,
                    "type": msg.msg_type
                }),
            });
        }

        let mut commands = HashMap::new();
        commands.insert(
            "resume".to_string(),
            format!("gemini --resume '{}'", session.session_id),
        );

        Ok(SessionDetail {
            platform: "gemini".to_string(),
            session_key: session_key.to_string(),
            session_id: session.session_id,
            title,
            alias_title,
            cwd,
            commands,
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        // edit_target: {project}::{source}::{stem}::{msg_id}::{field}
        let parts: Vec<&str> = edit_target.splitn(5, "::").collect();
        if parts.len() != 5 {
            return Err(format!("invalid edit_target: {edit_target}"));
        }
        let (project_name, source, stem, message_id, field) =
            (parts[0], parts[1], parts[2], parts[3], parts[4]);

        let session_key = Self::build_key(project_name, source, stem);
        let path = self.gemini_home
            .join(source)
            .join(project_name)
            .join("chats")
            .join(format!("{stem}.json"));

        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("cannot read session file: {e}"))?;
        let mut json: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("cannot parse session: {e}"))?;

        let messages = json["messages"]
            .as_array_mut()
            .ok_or("messages field is not an array")?;

        let msg = messages
            .iter_mut()
            .find(|m| m["id"].as_str() == Some(message_id))
            .ok_or_else(|| format!("message {message_id} not found"))?;

        match field {
            "text" => {
                // user: content is [{text: "..."}]
                if let Some(arr) = msg["content"].as_array_mut() {
                    if let Some(first) = arr.first_mut() {
                        first["text"] = serde_json::Value::String(new_content.to_string());
                    }
                }
            }
            "content" => {
                // gemini: content is a plain string
                msg["content"] = serde_json::Value::String(new_content.to_string());
            }
            _ => return Err(format!("unknown field: {field}")),
        }

        json["lastUpdated"] =
            serde_json::Value::String(chrono::Utc::now().to_rfc3339());

        let updated = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("cannot serialize session: {e}"))?;
        fs::write(&path, updated)
            .map_err(|e| format!("cannot write session file: {e}"))?;

        Ok(session_key)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let lower = query.to_lowercase();
        if session_key.to_lowercase().contains(&lower) {
            return true;
        }
        let Some(path) = self.key_to_path(session_key) else { return false };
        let Ok(raw) = fs::read_to_string(&path) else { return false };
        raw.to_lowercase().contains(&lower)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let Some(path) = self.key_to_path(session_key) else { return vec![] };
        let Ok(raw) = fs::read_to_string(&path) else { return vec![] };
        let Ok(session) = serde_json::from_str::<GeminiSessionFile>(&raw) else { return vec![] };

        let lower = query.to_lowercase();
        session
            .messages
            .iter()
            .enumerate()
            .filter_map(|(idx, msg)| {
                let text = message_text(msg);
                if !text.to_lowercase().contains(&lower) {
                    return None;
                }
                let role = match msg.msg_type.as_str() {
                    "user" => "user",
                    "gemini" => "assistant",
                    _ => return None,
                };
                Some(ContentMatch {
                    snippet: extract_snippet(&text, &lower),
                    match_index: idx,
                    role: role.to_string(),
                })
            })
            .collect()
    }
}
