pub mod claude;
pub mod codex;
pub mod opencode;

use serde::Serialize;
use std::collections::HashMap;

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

pub trait PlatformAdapter: Send + Sync {
    fn list_sessions(&self, alias_map: &HashMap<String, String>) -> Vec<SessionListItem>;
    fn get_session_detail(&self, session_key: &str, alias_map: &HashMap<String, String>) -> Result<SessionDetail, String>;
    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String>;
    fn matches_query(&self, session_key: &str, query: &str) -> bool;
}

pub fn get_adapter(platform: &str) -> Result<Box<dyn PlatformAdapter>, String> {
    match platform {
        "claude" => {
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            Ok(Box::new(claude::ClaudePlatform::new(home.join(".claude"))))
        }
        "codex" => {
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            Ok(Box::new(codex::CodexPlatform::new(home.join(".codex"))))
        }
        "opencode" => {
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            Ok(Box::new(opencode::OpenCodePlatform::new(
                home.join(".local/share/opencode/opencode.db"),
            )))
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
        _ => {
            let mut m = HashMap::new();
            m.insert("session".into(), session_id.into());
            m
        }
    }
}
