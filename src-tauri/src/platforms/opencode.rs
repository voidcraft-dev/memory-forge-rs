use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::params;
use serde_json::{json, Value};

use super::{SessionDetail, SessionListItem, SessionListResult, TimelineBlock, build_commands};

pub struct OpenCodePlatform {
    db_path: PathBuf,
}

impl OpenCodePlatform {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    fn connect(&self) -> Result<rusqlite::Connection, String> {
        let conn = rusqlite::Connection::open(&self.db_path)
            .map_err(|e| format!("Failed to open opencode db: {e}"))?;
        Ok(conn)
    }
}

impl super::PlatformAdapter for OpenCodePlatform {
    fn list_sessions(&self, alias_map: &HashMap<String, String>, limit: Option<usize>, offset: usize) -> SessionListResult {
        if !self.db_path.exists() {
            return SessionListResult { total: 0, items: Vec::new() };
        }

        let conn = match self.connect() {
            Ok(c) => c,
            Err(_) => return SessionListResult { total: 0, items: Vec::new() },
        };

        // Get total count
        let total: usize = conn.query_row(
            "SELECT COUNT(*) FROM session",
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        let sql = match limit {
            Some(l) => format!(
                "SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT {} OFFSET {}",
                l, offset
            ),
            None => format!(
                "SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC OFFSET {}",
                offset
            ),
        };

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return SessionListResult { total, items: Vec::new() },
        };

        let mut rows = match stmt.query([]) {
            Ok(r) => r,
            Err(_) => return SessionListResult { total, items: Vec::new() },
        };

        let mut items = Vec::new();
        while let Ok(Some(row)) = rows.next() {
            let id: String = row.get(0).unwrap_or_default();
            let title: String = row.get(1).unwrap_or_default();
            let directory: String = row.get(2).unwrap_or_default();
            let time_updated: i64 = row.get(3).unwrap_or(0);

            let alias = alias_map.get(&id).cloned().unwrap_or_default();
            let display_title = if alias.is_empty() {
                if title.is_empty() { id.clone() } else { title.clone() }
            } else {
                alias.clone()
            };

            items.push(SessionListItem {
                platform: "opencode".into(),
                session_key: id.clone(),
                session_id: id,
                display_title,
                alias_title: alias,
                preview: if title.is_empty() { String::new() } else { title },
                updated_at: time_updated.to_string(),
                cwd: directory,
                editable: true,
            });
        }
        SessionListResult { total, items }
    }

    fn get_session_detail(&self, session_key: &str, alias_map: &HashMap<String, String>) -> Result<SessionDetail, String> {
        let conn = self.connect()?;

        let session_row: Option<(String, String)> = conn.query_row(
            "SELECT title, directory FROM session WHERE id = ?1",
            params![session_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok();

        let (session_title, session_cwd) = session_row.unwrap_or_default();

        let mut stmt = conn.prepare(
            "SELECT part.id, part.data, message.data as message_data FROM part JOIN message ON message.id = part.message_id WHERE part.session_id = ?1 ORDER BY part.time_created ASC, part.id ASC"
        ).map_err(|e| format!("Prepare error: {e}"))?;

        let mut rows = stmt.query(params![session_key]).map_err(|e| format!("Query error: {e}"))?;

        let mut blocks = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
            let part_id: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
            let data_str: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
            let message_data_str: String = row.get::<_, String>(2).unwrap_or_default();

            let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
            let message_data: Value = serde_json::from_str(&message_data_str).unwrap_or_default();

            if let Some(block) = part_to_block(&part_id, &data, &message_data) {
                blocks.push(block);
            }
        }

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if alias.is_empty() {
            if session_title.is_empty() { session_key.to_string() } else { session_title }
        } else {
            alias.clone()
        };

        Ok(SessionDetail {
            platform: "opencode".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd: session_cwd,
            commands: build_commands("opencode", session_key),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let conn = self.connect()?;

        let data_str: String = conn.query_row(
            "SELECT data FROM part WHERE id = ?1",
            params![edit_target],
            |row| row.get(0),
        ).map_err(|e| format!("Part not found: {e}"))?;

        let mut payload: Value = serde_json::from_str(&data_str).map_err(|e| format!("Parse error: {e}"))?;

        let kind = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let old_content = match kind {
            "text" | "reasoning" => {
                let old = payload.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                payload["text"] = Value::String(new_content.to_string());
                old
            }
            "tool" => {
                let old = payload.get("state")
                    .and_then(|s| s.get("output"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if payload.get("state").is_none() {
                    payload["state"] = json!({});
                }
                payload["state"]["output"] = Value::String(new_content.to_string());
                old
            }
            _ => String::new(),
        };

        let new_data = serde_json::to_string(&payload).map_err(|e| format!("Serialize error: {e}"))?;
        conn.execute(
            "UPDATE part SET data = ?1 WHERE id = ?2",
            params![new_data, edit_target],
        ).map_err(|e| format!("Update error: {e}"))?;

        Ok(old_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return true;
        }

        let conn = match self.connect() {
            Ok(c) => c,
            Err(_) => return false,
        };

        if let Ok(row) = conn.query_row(
            "SELECT title, directory FROM session WHERE id = ?1",
            params![session_key],
            |row| Ok((row.get::<_, String>(0).unwrap_or_default(), row.get::<_, String>(1).unwrap_or_default())),
        ) {
            if row.0.to_lowercase().contains(&needle) || row.1.to_lowercase().contains(&needle) {
                return true;
            }
        }

        if let Ok(mut stmt) = conn.prepare("SELECT data FROM part WHERE session_id = ?1") {
            if let Ok(mut rows) = stmt.query(params![session_key]) {
                while let Ok(Some(row)) = rows.next() {
                    let data_str: String = row.get(0).unwrap_or_default();
                    let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
                    let text = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if text.to_lowercase().contains(&needle) {
                        return true;
                    }
                }
            }
        }

        false
    }
}

fn part_to_block(part_id: &str, data: &Value, message_data: &Value) -> Option<TimelineBlock> {
    let kind = data.get("type").and_then(|v| v.as_str())?;
    let message_role = message_data.get("role").and_then(|v| v.as_str()).unwrap_or("user");

    match kind {
        "text" => Some(TimelineBlock {
            id: part_id.to_string(),
            role: message_role.to_string(),
            content: data.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            editable: true,
            edit_target: part_id.to_string(),
            source_meta: serde_json::json!({"partType": kind, "messageRole": message_role}),
        }),
        "reasoning" => Some(TimelineBlock {
            id: part_id.to_string(),
            role: "thinking".into(),
            content: data.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            editable: true,
            edit_target: part_id.to_string(),
            source_meta: serde_json::json!({"partType": kind}),
        }),
        _ => None,
    }
}
