pub mod claude;
pub mod codex;
pub mod cursor;
pub mod gemini;
pub mod kiro;
pub mod kiro_ide;
pub mod opencode;
pub mod pi;

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::database::{SessionContentEntry, SessionContentIndex, SessionSummaryCache};
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
pub struct ToolCallBlock {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub source_meta: serde_json::Value,
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
    #[serde(default)]
    pub tool_calls: Vec<ToolCallBlock>,
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

#[derive(Debug, Clone)]
pub struct SessionKey {
    pub key: String,
    pub sort_key: i128,
}

pub trait PlatformAdapter: Send + Sync {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult;
    fn list_sessions_with_cache(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
        _cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListResult {
        self.list_sessions(alias_map, limit, offset)
    }
    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        None
    }
    fn session_list_item(
        &self,
        _session_key: &str,
        _alias_map: &HashMap<String, String>,
        _cache: Option<&SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        None
    }
    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String>;
    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String>;
    fn raw_jsonl_path(&self, _session_key: &str) -> Result<PathBuf, String> {
        Err("Raw JSONL export is not supported for this platform".to_string())
    }
    fn matches_query(&self, session_key: &str, query: &str) -> bool;
    fn warm_content_index(
        &self,
        _session_key: &str,
        _index: Option<&SessionContentIndex<'_>>,
    ) -> bool {
        false
    }
    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch>;
    fn content_search_with_index(
        &self,
        session_key: &str,
        query: &str,
        _index: Option<&SessionContentIndex<'_>>,
    ) -> Vec<ContentMatch> {
        self.content_search(session_key, query)
    }
    fn resolve_execution_output(
        &self,
        _session_key: &str,
        _edit_target: &str,
    ) -> Result<String, String> {
        Err("Execution output loading is not supported for this platform".to_string())
    }
    fn resolve_execution_outputs(
        &self,
        session_key: &str,
        edit_targets: &[String],
    ) -> Result<HashMap<String, String>, String> {
        let mut outputs = HashMap::new();
        for edit_target in edit_targets {
            if let Ok(output) = self.resolve_execution_output(session_key, edit_target) {
                outputs.insert(edit_target.clone(), output);
            }
        }
        Ok(outputs)
    }
}

pub fn resolve_existing_jsonl_path_within_root(
    root: &Path,
    path: &Path,
    platform: &str,
) -> Result<PathBuf, String> {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err(format!("{platform} session is not a JSONL file"));
    }

    if !path.is_file() {
        return Err(format!(
            "{platform} session JSONL not found: {}",
            path.display()
        ));
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {platform} session root: {error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {platform} session path: {error}"))?;

    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!(
            "{platform} session path is outside the configured session root"
        ));
    }

    Ok(canonical_path)
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

pub fn content_entries_to_matches(
    entries: Vec<SessionContentEntry>,
    needle: &str,
) -> Vec<ContentMatch> {
    entries
        .into_iter()
        .filter_map(|entry| {
            if !entry.search_text_lower.contains(needle) {
                return None;
            }
            let best_text = entry
                .texts
                .iter()
                .find(|text| text.to_lowercase().contains(needle))
                .cloned()
                .unwrap_or_else(|| entry.texts.join(" "));
            if best_text.is_empty() {
                return None;
            }
            Some(ContentMatch {
                snippet: extract_snippet(&best_text, needle),
                match_index: entry.match_index,
                role: entry.role,
            })
        })
        .collect()
}

pub fn read_head_tail_lines(
    path: &std::path::Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();

    if file_len < 16_384 {
        let reader = BufReader::new(file);
        let all: Vec<String> = reader.lines().map_while(Result::ok).collect();
        let head = all.iter().take(head_n).cloned().collect();
        let skip = all.len().saturating_sub(tail_n);
        let tail = all.into_iter().skip(skip).collect();
        return Ok((head, tail));
    }

    let reader = BufReader::new(file);
    let head: Vec<String> = reader.lines().take(head_n).map_while(Result::ok).collect();

    let seek_pos = file_len.saturating_sub(16_384);
    let mut tail_file = File::open(path)?;
    tail_file.seek(SeekFrom::Start(seek_pos))?;
    let tail_reader = BufReader::new(tail_file);
    let all_tail: Vec<String> = tail_reader.lines().map_while(Result::ok).collect();

    let skip_first = if seek_pos > 0 { 1 } else { 0 };
    let usable: Vec<String> = all_tail.into_iter().skip(skip_first).collect();
    let skip = usable.len().saturating_sub(tail_n);
    let tail = usable.into_iter().skip(skip).collect();

    Ok((head, tail))
}

pub fn tool_text_from_value(value: &serde_json::Value, max_chars: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }

    let raw = value.as_str().map(ToString::to_string).unwrap_or_else(|| {
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    });

    tool_text_from_str(&raw, max_chars)
}

pub fn tool_text_from_str(value: &str, max_chars: usize) -> Option<String> {
    if value.is_empty() {
        return None;
    }

    let char_count = value.chars().count();
    if char_count <= max_chars {
        return Some(value.to_string());
    }

    let truncated: String = value.chars().take(max_chars).collect();
    Some(format!(
        "{truncated}\n\n[truncated: showing first {max_chars} chars of {char_count}]"
    ))
}

pub fn get_adapter(
    platform: &str,
    settings: &AppSettings,
) -> Result<Box<dyn PlatformAdapter>, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    match platform {
        "claude" => {
            let path = settings
                .claude_home
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude"));
            Ok(Box::new(claude::ClaudePlatform::new(path)))
        }
        "codex" => {
            let path = settings
                .codex_home
                .as_ref()
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
                .unwrap_or_else(|| home.join(".codex"));
            let project_root = settings.codex_project_root.as_ref().map(PathBuf::from);
            Ok(Box::new(codex::CodexPlatform::new(path, project_root)))
        }
        "cursor" => {
            let path = settings
                .cursor_home
                .as_ref()
                .map(PathBuf::from)
                .or_else(cursor::default_cursor_home)
                .unwrap_or_else(|| home.join(".config/Cursor/User"));
            Ok(Box::new(cursor::CursorPlatform::new(path)))
        }
        "opencode" => {
            let path = settings
                .opencode_path
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share/opencode/opencode.db"));
            Ok(Box::new(opencode::OpenCodePlatform::new(path)))
        }
        "kiro" => {
            let path = settings
                .kiro_home
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".kiro"));
            Ok(Box::new(kiro::KiroPlatform::new(path)))
        }
        "kiro-ide" => {
            let path = settings
                .kiro_ide_home
                .as_ref()
                .map(PathBuf::from)
                .or_else(kiro_ide::default_agent_home)
                .unwrap_or_else(|| home.join(".config/Kiro/User/globalStorage/kiro.kiroagent"));
            Ok(Box::new(kiro_ide::KiroIdePlatform::new(path)))
        }
        "gemini" => {
            let path = settings
                .gemini_home
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".gemini"));
            Ok(Box::new(gemini::GeminiPlatform::new(path)))
        }
        "pi" => {
            let path = settings
                .pi_home
                .as_ref()
                .map(PathBuf::from)
                .or_else(pi::default_pi_home)
                .unwrap_or_else(|| home.join(".pi").join("agent"));
            let sessions_root = pi::default_pi_sessions_root(&path);
            Ok(Box::new(pi::PiPlatform::new(path, sessions_root)))
        }
        _ => Err(format!("Unknown platform: {platform}")),
    }
}

pub fn build_commands(platform: &str, session_id: &str) -> HashMap<String, String> {
    match platform {
        "claude" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("claude --resume {session_id}"));
            m.insert(
                "fork".into(),
                format!("claude --resume {session_id} --fork-session"),
            );
            m
        }
        "codex" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("codex resume {session_id}"));
            m
        }
        "cursor" => HashMap::new(),
        "opencode" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("opencode -s {session_id}"));
            m.insert("fork".into(), format!("opencode -s {session_id} --fork"));
            m
        }
        "kiro" => {
            let mut m = HashMap::new();
            m.insert(
                "resume".into(),
                format!("kiro-cli chat --resume-id {session_id}"),
            );
            m
        }
        "kiro-ide" => HashMap::new(),
        "gemini" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("gemini --resume '{session_id}'"));
            m
        }
        "pi" => {
            let mut m = HashMap::new();
            m.insert("resume".into(), format!("pi --session {session_id}"));
            m
        }
        _ => {
            let mut m = HashMap::new();
            m.insert("session".into(), session_id.into());
            m
        }
    }
}
