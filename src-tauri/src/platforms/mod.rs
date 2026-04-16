pub mod claude;
pub mod codex;
pub mod kiro;
pub mod opencode;

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::settings::AppSettings;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub snippet: String,
    pub match_index: usize,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListItem {
    pub platform: String,
    pub session_key: String,
    pub session_id: String,
    pub display_title: String,
    pub alias_title: String,
    pub preview: String,
    pub updated_at: String,
    pub cwd: String,
    pub editable: bool,
    #[serde(default)]
    pub content_matches: Vec<ContentMatch>,
    #[serde(default)]
    pub total_content_matches: usize,
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBlock {
    pub id: String,
    pub role: String,
    pub content: String,
    pub editable: bool,
    pub edit_target: String,
    pub source_meta: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub platform: String,
    pub session_key: String,
    pub session_id: String,
    pub title: String,
    pub alias_title: String,
    pub cwd: String,
    pub commands: HashMap<String, String>,
    pub blocks: Vec<TimelineBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListResult {
    pub total: usize,
    pub items: Vec<SessionListItem>,
}

pub trait PlatformAdapter: Send + Sync {
    fn list_sessions(&self, alias_map: &HashMap<String, String>, limit: Option<usize>, offset: usize) -> SessionListResult;
    fn get_session_detail(&self, session_key: &str, alias_map: &HashMap<String, String>) -> Result<SessionDetail, String>;
    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String>;
    fn matches_query(&self, session_key: &str, query: &str) -> bool;
    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch>;
}

/// Extract a snippet of ~120 chars around the first occurrence of `needle` in `text`.
pub fn extract_snippet(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let Some(pos) = lower.find(needle) else {
        return text.chars().take(120).collect();
    };
    let char_pos = text[..pos].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = char_pos.saturating_sub(40);
    let end = (char_pos + needle.len() + 80).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet = format!("...{snippet}");
    }
    if end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}

pub fn get_adapter(platform: &str, settings: &AppSettings) -> Result<Box<dyn PlatformAdapter>, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    match platform {
        "claude" => {
            let path = settings.claude_home.as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude"));
            Ok(Box::new(claude::ClaudePlatform::new(path)))
        }
        "codex" => {
            let path = settings.codex_home.as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            Ok(Box::new(codex::CodexPlatform::new(path)))
        }
        "opencode" => {
            let path = settings.opencode_path.as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share/opencode/opencode.db"));
            Ok(Box::new(opencode::OpenCodePlatform::new(path)))
        }
        "kiro" => {
            let path = settings.kiro_home.as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".kiro"));
            Ok(Box::new(kiro::KiroPlatform::new(path)))
        }
        _ => Err(format!("Unknown platform: {platform}")),
    }
}

pub fn build_commands(platform: &str, session_id: &str) -> HashMap<String, String> {
    match platform {
        "claude" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("claude --resume {session_id}"));
            m.insert("fork".into(), format!("claude --resume {session_id} --fork-session"));
            m
        }
        "codex" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("codex resume {session_id}"));
            m
        }
        "opencode" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("opencode -s {session_id}"));
            m.insert("fork".into(), format!("opencode -s {session_id} --fork"));
            m
        }
        "kiro" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("kiro-cli chat --resume-id {session_id}"));
            m
        }
        _ => {
            let mut m = HashMap::new();
            m.insert("session".into(), session_id.into());
            m
        }
    }
}
