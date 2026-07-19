use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    build_commands, extract_snippet, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem,
    SessionListResult, TimelineBlock,
};

const COMPOSER_HEADERS_KEY: &str = "composer.composerHeaders";

pub struct CursorPlatform {
    cursor_home: PathBuf,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorComposerHeaders {
    #[serde(default)]
    all_composers: Vec<CursorComposerHeader>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorComposerHeader {
    #[serde(default)]
    composer_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    subtitle: String,
    created_at: Option<i64>,
    last_updated_at: Option<i64>,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    is_archived: bool,
    #[serde(default)]
    subagent_info: Option<CursorSubagentInfo>,
    workspace_identifier: Option<Value>,
    agent_location: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorSubagentInfo {
    #[serde(default)]
    parent_composer_id: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorComposerData {
    #[serde(default)]
    composer_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    workspace_identifier: Option<Value>,
    #[serde(default)]
    full_conversation_headers_only: Vec<CursorConversationHeader>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorConversationHeader {
    #[serde(default)]
    bubble_id: String,
    #[serde(rename = "type")]
    bubble_type: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorBubble {
    #[serde(default)]
    bubble_id: String,
    #[serde(rename = "type")]
    bubble_type: Option<i64>,
    #[serde(default)]
    text: String,
    created_at: Option<Value>,
}

impl CursorPlatform {
    pub fn new(cursor_home: PathBuf) -> Self {
        Self { cursor_home }
    }

    fn db_path(&self) -> PathBuf {
        self.cursor_home.join("globalStorage").join("state.vscdb")
    }

    fn connect_readonly(&self) -> Result<Connection, String> {
        let db_path = self.db_path();
        let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Failed to open Cursor db '{}': {e}", db_path.display()))?;
        conn.busy_timeout(Duration::from_millis(800)).ok();
        Ok(conn)
    }

    fn connect_write(&self) -> Result<Connection, String> {
        let db_path = self.db_path();
        let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| format!("Failed to open Cursor db for writing '{}': {e}. Close Cursor and try again if the database is locked.", db_path.display()))?;
        conn.busy_timeout(Duration::from_millis(800)).ok();
        Ok(conn)
    }

    fn read_headers(&self, conn: &Connection) -> Result<Vec<CursorComposerHeader>, String> {
        let raw = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?1",
                params![COMPOSER_HEADERS_KEY],
                |row| row_text(row, 0),
            )
            .optional()
            .map_err(|e| format!("Failed to read Cursor composer headers: {e}"))?
            .unwrap_or_default();

        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }

        let mut headers: CursorComposerHeaders = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse Cursor composer headers: {e}"))?;
        headers
            .all_composers
            .retain(CursorComposerHeader::is_listable_index_entry);
        headers
            .all_composers
            .sort_by_key(|header| std::cmp::Reverse(header.updated_at_value()));
        Ok(headers.all_composers)
    }

    fn read_composer_data(
        &self,
        conn: &Connection,
        composer_id: &str,
    ) -> Result<CursorComposerData, String> {
        let key = format!("composerData:{composer_id}");
        let raw = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                params![key],
                |row| row_text(row, 0),
            )
            .optional()
            .map_err(|e| format!("Failed to read Cursor composer data: {e}"))?
            .ok_or_else(|| format!("Cursor composer data not found: {composer_id}"))?;

        serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse Cursor composer data '{composer_id}': {e}"))
    }

    fn read_bubbles(
        &self,
        conn: &Connection,
        composer_id: &str,
    ) -> Result<HashMap<String, CursorBubble>, String> {
        let (start, end) = bubble_key_bounds(composer_id);
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY key",
            )
            .map_err(|e| format!("Failed to prepare Cursor bubble query: {e}"))?;
        let rows = stmt
            .query_map(params![start, end], |row| {
                Ok((row_text(row, 0)?, row_text(row, 1)?))
            })
            .map_err(|e| format!("Failed to query Cursor bubbles: {e}"))?;

        let prefix = format!("bubbleId:{composer_id}:");
        let mut bubbles = HashMap::new();
        for row in rows {
            let Ok((key, raw)) = row else { continue };
            let bubble_id = key.strip_prefix(&prefix).unwrap_or("").to_string();
            if bubble_id.is_empty() {
                continue;
            }
            let Ok(mut bubble) = serde_json::from_str::<CursorBubble>(&raw) else {
                continue;
            };
            if bubble.bubble_id.is_empty() {
                bubble.bubble_id = bubble_id.clone();
            }
            bubbles.insert(bubble_id, bubble);
        }
        Ok(bubbles)
    }

    fn header_for<'a>(
        &self,
        headers: &'a [CursorComposerHeader],
        composer_id: &str,
    ) -> Option<&'a CursorComposerHeader> {
        headers
            .iter()
            .find(|header| header.composer_id == composer_id)
    }

    fn should_show_list_item(&self, conn: &Connection, header: &CursorComposerHeader) -> bool {
        if header.has_human_label() {
            return true;
        }

        let Ok(data) = self.read_composer_data(conn, &header.composer_id) else {
            return false;
        };
        if !data.name.trim().is_empty() {
            return true;
        }

        let Ok(bubbles) = self.read_bubbles(conn, &header.composer_id) else {
            return false;
        };
        data.full_conversation_headers_only.iter().any(|item| {
            let Some(bubble) = bubbles.get(&item.bubble_id) else {
                return false;
            };
            let bubble_type = bubble.bubble_type.or(item.bubble_type);
            bubble_role(bubble_type).is_some() && !bubble.text.trim().is_empty()
        })
    }
}

impl CursorComposerHeader {
    fn is_listable_index_entry(&self) -> bool {
        !self.composer_id.trim().is_empty()
            && self.composer_id != "empty-state-draft"
            && !self.is_draft
            && !self.is_archived
            && self
                .subagent_info
                .as_ref()
                .map(|info| info.parent_composer_id.trim().is_empty())
                .unwrap_or(true)
    }

    fn has_human_label(&self) -> bool {
        !self.name.trim().is_empty() || !self.subtitle.trim().is_empty()
    }

    fn updated_at_value(&self) -> i64 {
        self.last_updated_at.or(self.created_at).unwrap_or(0)
    }

    fn title(&self) -> String {
        if self.name.trim().is_empty() {
            self.composer_id.clone()
        } else {
            self.name.clone()
        }
    }

    fn cwd(&self) -> String {
        workspace_path(self.workspace_identifier.as_ref())
            .or_else(|| agent_location_path(self.agent_location.as_ref()))
            .unwrap_or_default()
    }
}

impl CursorComposerData {
    fn title(&self, fallback_id: &str) -> String {
        if !self.name.trim().is_empty() {
            return self.name.clone();
        }
        if !self.composer_id.trim().is_empty() {
            return self.composer_id.clone();
        }
        fallback_id.to_string()
    }

    fn cwd(&self) -> String {
        workspace_path(self.workspace_identifier.as_ref()).unwrap_or_default()
    }
}

impl PlatformAdapter for CursorPlatform {
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

        let conn = match self.connect_readonly() {
            Ok(conn) => conn,
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };
        let headers = match self.read_headers(&conn) {
            Ok(headers) => headers,
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };

        let headers: Vec<_> = headers
            .into_iter()
            .filter(|header| self.should_show_list_item(&conn, header))
            .collect();
        let total = headers.len();
        let items = headers
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .map(|header| {
                let alias = alias_map
                    .get(&header.composer_id)
                    .cloned()
                    .unwrap_or_default();
                let display_title = if alias.is_empty() {
                    header.title()
                } else {
                    alias.clone()
                };
                let updated_at = header.updated_at_value().to_string();
                let cwd = header.cwd();
                SessionListItem {
                    platform: "cursor".to_string(),
                    session_key: header.composer_id.clone(),
                    session_id: header.composer_id.clone(),
                    display_title,
                    alias_title: alias,
                    preview: header.subtitle,
                    updated_at,
                    cwd,
                    editable: true,
                    content_matches: Vec::new(),
                    total_content_matches: 0,
                    favorite: false,
                }
            })
            .collect();

        SessionListResult { total, items }
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let conn = self.connect_readonly()?;
        let headers = self.read_headers(&conn).unwrap_or_default();
        let header = self.header_for(&headers, session_key).cloned();
        let data = self.read_composer_data(&conn, session_key)?;
        let bubbles = self.read_bubbles(&conn, session_key)?;

        let mut blocks = Vec::new();
        for (index, conversation_header) in data.full_conversation_headers_only.iter().enumerate() {
            let Some(bubble) = bubbles.get(&conversation_header.bubble_id) else {
                continue;
            };
            let bubble_type = bubble.bubble_type.or(conversation_header.bubble_type);
            let Some(role) = bubble_role(bubble_type) else {
                continue;
            };
            if bubble.text.trim().is_empty() {
                continue;
            }

            blocks.push(TimelineBlock {
                id: conversation_header.bubble_id.clone(),
                role: role.to_string(),
                content: bubble.text.clone(),
                editable: true,
                edit_target: format!("{session_key}::{}", conversation_header.bubble_id),
                source_meta: json!({
                    "composerId": session_key,
                    "bubbleId": conversation_header.bubble_id,
                    "bubbleType": bubble_type,
                    "createdAt": bubble.created_at,
                    "conversationIndex": index,
                }),
                tool_calls: Vec::new(),
            });
        }

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if alias.is_empty() {
            header
                .as_ref()
                .map(CursorComposerHeader::title)
                .unwrap_or_else(|| data.title(session_key))
        } else {
            alias.clone()
        };
        let cwd = header
            .as_ref()
            .map(CursorComposerHeader::cwd)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| data.cwd());

        Ok(SessionDetail {
            platform: "cursor".to_string(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd,
            commands: build_commands("cursor", session_key),
            revision: String::new(),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let (composer_id, bubble_id) = edit_target
            .split_once("::")
            .ok_or_else(|| format!("Invalid Cursor edit target: {edit_target}"))?;
        if composer_id.is_empty() || bubble_id.is_empty() {
            return Err(format!("Invalid Cursor edit target: {edit_target}"));
        }

        let conn = self.connect_write()?;
        let key = format!("bubbleId:{composer_id}:{bubble_id}");
        let raw = conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                params![key],
                |row| row_text(row, 0),
            )
            .optional()
            .map_err(|e| format!("Failed to read Cursor bubble: {e}"))?
            .ok_or_else(|| format!("Cursor bubble not found: {bubble_id}"))?;

        let mut payload: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse Cursor bubble: {e}"))?;
        let bubble_type = payload
            .get("type")
            .and_then(Value::as_i64)
            .ok_or_else(|| "Cursor bubble is missing type".to_string())?;
        if bubble_role(Some(bubble_type)).is_none() {
            return Err(format!("Cursor bubble type is not editable: {bubble_type}"));
        }

        let old_content = payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        payload["text"] = Value::String(new_content.to_string());
        if bubble_type == 1 {
            payload["richText"] = Value::String(cursor_rich_text(new_content));
        }

        let serialized = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize Cursor bubble: {e}"))?;
        conn.execute(
            "UPDATE cursorDiskKV SET value = ?1 WHERE key = ?2",
            params![serialized, format!("bubbleId:{composer_id}:{bubble_id}")],
        )
        .map_err(|e| format!("Failed to update Cursor bubble. Close Cursor and try again if the database is locked: {e}"))?;

        Ok(old_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        !self.content_search(session_key, query).is_empty()
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }

        let conn = match self.connect_readonly() {
            Ok(conn) => conn,
            Err(_) => return Vec::new(),
        };
        let data = match self.read_composer_data(&conn, session_key) {
            Ok(data) => data,
            Err(_) => return Vec::new(),
        };
        let mut index_by_bubble = HashMap::new();
        for (index, header) in data.full_conversation_headers_only.iter().enumerate() {
            if let Some(role) = bubble_role(header.bubble_type) {
                index_by_bubble.insert(header.bubble_id.clone(), (index, role.to_string()));
            }
        }

        let (start, end) = bubble_key_bounds(session_key);
        let like = format!("%{}%", escape_like(&needle));
        let mut stmt = match conn.prepare(
            "SELECT key, value FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 AND value LIKE ?3 ESCAPE '\\'",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(params![start, end, like], |row| {
            Ok((row_text(row, 0)?, row_text(row, 1)?))
        }) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };

        let prefix = format!("bubbleId:{session_key}:");
        let mut matches = Vec::new();
        for row in rows {
            let Ok((key, raw)) = row else { continue };
            let bubble_id = key.strip_prefix(&prefix).unwrap_or("");
            let Some((match_index, role)) = index_by_bubble.get(bubble_id) else {
                continue;
            };
            let Ok(bubble) = serde_json::from_str::<CursorBubble>(&raw) else {
                continue;
            };
            if bubble.text.to_lowercase().contains(&needle) {
                matches.push(ContentMatch {
                    snippet: extract_snippet(&bubble.text, &needle),
                    match_index: *match_index,
                    role: role.clone(),
                });
            }
        }
        matches.sort_by_key(|item| item.match_index);
        matches
    }
}

pub fn default_cursor_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Cursor").join("User"))
    }

    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
        })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs::home_dir().map(|home| home.join(".config").join("Cursor").join("User"))
    }
}

fn bubble_role(bubble_type: Option<i64>) -> Option<&'static str> {
    match bubble_type {
        Some(1) => Some("user"),
        Some(2) => Some("assistant"),
        _ => None,
    }
}

fn bubble_key_bounds(composer_id: &str) -> (String, String) {
    (
        format!("bubbleId:{composer_id}:"),
        format!("bubbleId:{composer_id};"),
    )
}

fn workspace_path(value: Option<&Value>) -> Option<String> {
    let value = value?;
    value
        .pointer("/uri/fsPath")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/uri/path").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn agent_location_path(value: Option<&Value>) -> Option<String> {
    let value = value?;
    value
        .pointer("/environment/uri/fsPath")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/environment/uri/path")
                .and_then(Value::as_str)
        })
        .map(ToString::to_string)
}

fn cursor_rich_text(text: &str) -> String {
    let content: Vec<Value> = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                json!({ "type": "paragraph" })
            } else {
                json!({
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": line }]
                })
            }
        })
        .collect();
    serde_json::to_string(&json!({ "type": "doc", "content": content })).unwrap_or_default()
}

fn escape_like(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn row_text(row: &Row<'_>, index: usize) -> rusqlite::Result<String> {
    match row.get_ref(index)? {
        ValueRef::Null => Ok(String::new()),
        ValueRef::Integer(value) => Ok(value.to_string()),
        ValueRef::Real(value) => Ok(value.to_string()),
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            Ok(String::from_utf8_lossy(bytes).to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_rich_text_keeps_blank_lines_as_paragraphs() {
        let raw = cursor_rich_text("one\n\ntwo");
        let parsed: Value = serde_json::from_str(&raw).expect("rich text json");

        assert_eq!(
            parsed
                .pointer("/content/0/content/0/text")
                .and_then(Value::as_str),
            Some("one")
        );
        assert_eq!(
            parsed.pointer("/content/1/type").and_then(Value::as_str),
            Some("paragraph")
        );
        assert_eq!(
            parsed
                .pointer("/content/2/content/0/text")
                .and_then(Value::as_str),
            Some("two")
        );
    }

    #[test]
    fn bubble_key_bounds_include_only_one_composer_prefix() {
        let (start, end) = bubble_key_bounds("abc");

        assert!("bubbleId:abc:1" >= start.as_str());
        assert!("bubbleId:abc:1" < end.as_str());
        assert!("bubbleId:abd:1" > end.as_str());
    }

    #[test]
    fn archived_and_draft_headers_are_not_listable() {
        let archived = CursorComposerHeader {
            composer_id: "abc".to_string(),
            is_archived: true,
            ..Default::default()
        };
        let draft = CursorComposerHeader {
            composer_id: "abc".to_string(),
            is_draft: true,
            ..Default::default()
        };
        let normal = CursorComposerHeader {
            composer_id: "abc".to_string(),
            ..Default::default()
        };

        assert!(!archived.is_listable_index_entry());
        assert!(!draft.is_listable_index_entry());
        assert!(normal.is_listable_index_entry());
    }

    #[test]
    fn subagent_headers_are_not_listable() {
        let subagent = CursorComposerHeader {
            composer_id: "child".to_string(),
            subagent_info: Some(CursorSubagentInfo {
                parent_composer_id: "parent".to_string(),
            }),
            ..Default::default()
        };
        let missing_parent = CursorComposerHeader {
            composer_id: "normal".to_string(),
            subagent_info: Some(CursorSubagentInfo::default()),
            ..Default::default()
        };

        assert!(!subagent.is_listable_index_entry());
        assert!(missing_parent.is_listable_index_entry());
    }

    #[test]
    fn unlabeled_empty_headers_are_not_shown() {
        let conn = Connection::open_in_memory().expect("sqlite");
        conn.execute_batch("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
            .expect("schema");
        let platform = CursorPlatform::new(PathBuf::new());
        let empty = CursorComposerHeader {
            composer_id: "empty".to_string(),
            ..Default::default()
        };

        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "composerData:empty",
                r#"{"composerId":"empty","fullConversationHeadersOnly":[]}"#
            ],
        )
        .expect("insert composer");

        assert!(!platform.should_show_list_item(&conn, &empty));
    }

    #[test]
    fn unlabeled_headers_with_messages_are_shown() {
        let conn = Connection::open_in_memory().expect("sqlite");
        conn.execute_batch("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
            .expect("schema");
        let platform = CursorPlatform::new(PathBuf::new());
        let header = CursorComposerHeader {
            composer_id: "real".to_string(),
            ..Default::default()
        };

        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "composerData:real",
                r#"{"composerId":"real","fullConversationHeadersOnly":[{"bubbleId":"b1","type":1}]}"#
            ],
        )
        .expect("insert composer");
        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "bubbleId:real:b1",
                r#"{"bubbleId":"b1","type":1,"text":"hello"}"#
            ],
        )
        .expect("insert bubble");

        assert!(platform.should_show_list_item(&conn, &header));
    }
}
