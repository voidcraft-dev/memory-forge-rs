use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    build_commands, derive_session_title, first_conversation_text, tool_text_from_value,
    ContentMatch, SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock,
    ToolCallBlock,
};

pub struct OpenCodePlatform {
    db_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct StoredPart {
    id: String,
    message_id: String,
    session_id: String,
    time_created: i64,
    time_updated: i64,
    data: String,
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
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        if !self.db_path.exists() {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        }

        let conn = match self.connect() {
            Ok(c) => c,
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };

        // Get total count
        let total: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM session WHERE parent_id IS NULL OR parent_id = ''",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let sql = match limit {
            Some(l) => format!(
                "SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated DESC LIMIT {} OFFSET {}",
                l, offset
            ),
            None => format!(
                "SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated DESC LIMIT -1 OFFSET {}",
                offset
            ),
        };

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => {
                return SessionListResult {
                    total,
                    items: Vec::new(),
                }
            }
        };

        let mut rows = match stmt.query([]) {
            Ok(r) => r,
            Err(_) => {
                return SessionListResult {
                    total,
                    items: Vec::new(),
                }
            }
        };

        let mut items = Vec::new();
        while let Ok(Some(row)) = rows.next() {
            let id: String = row.get(0).unwrap_or_default();
            let title: String = row.get(1).unwrap_or_default();
            let directory: String = row.get(2).unwrap_or_default();
            let time_updated: i64 = row.get(3).unwrap_or(0);

            let alias = alias_map.get(&id).cloned().unwrap_or_default();
            let display_title =
                derive_session_title(&alias, &title, "", &directory, &id, "OpenCode");

            items.push(SessionListItem {
                platform: "opencode".into(),
                session_key: id.clone(),
                session_id: id,
                display_title,
                alias_title: alias,
                preview: if title.is_empty() {
                    String::new()
                } else {
                    title
                },
                updated_at: time_updated.to_string(),
                cwd: directory,
                editable: true,
                content_matches: vec![],
                total_content_matches: 0,
                favorite: false,
                agent_group: None,
            });
        }
        SessionListResult { total, items }
    }

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        if !self.db_path.exists() {
            return None;
        }
        let conn = self.connect().ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, time_updated
                 FROM session
                 WHERE parent_id IS NULL OR parent_id = ''
                 ORDER BY time_updated DESC",
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                let key: String = row.get(0)?;
                Ok(SessionKey::standalone(key, row.get::<_, i64>(1)? as i128))
            })
            .ok()?;

        Some(rows.flatten().collect())
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        _cache: Option<&crate::database::SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        let conn = self.connect().ok()?;
        let (title, directory, time_updated): (String, String, i64) = conn
            .query_row(
                "SELECT title, directory, time_updated FROM session WHERE id = ?1",
                params![session_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok()?;
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let display_title = if alias.is_empty() {
            if title.is_empty() {
                session_key.to_string()
            } else {
                title.clone()
            }
        } else {
            alias.clone()
        };

        Some(SessionListItem {
            platform: "opencode".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            display_title,
            alias_title: alias,
            preview: if title.is_empty() {
                String::new()
            } else {
                title
            },
            updated_at: time_updated.to_string(),
            cwd: directory,
            editable: true,
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
            agent_group: None,
        })
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let conn = self.connect()?;

        let session_row: Option<(String, String)> = conn
            .query_row(
                "SELECT title, directory FROM session WHERE id = ?1",
                params![session_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        let (session_title, session_cwd) = session_row.unwrap_or_default();

        let mut stmt = conn.prepare(
            "SELECT part.id, part.data, message.data as message_data FROM part JOIN message ON message.id = part.message_id WHERE part.session_id = ?1 ORDER BY part.time_created ASC, part.id ASC"
        ).map_err(|e| format!("Prepare error: {e}"))?;

        let mut rows = stmt
            .query(params![session_key])
            .map_err(|e| format!("Query error: {e}"))?;

        let mut blocks: Vec<TimelineBlock> = Vec::new();
        let mut pending_tool_calls = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
            let part_id: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
            let data_str: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
            let message_data_str: String = row.get::<_, String>(2).unwrap_or_default();

            let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
            let message_data: Value = serde_json::from_str(&message_data_str).unwrap_or_default();

            if let Some(mut block) = part_to_block(&part_id, &data, &message_data) {
                block.tool_calls.append(&mut pending_tool_calls);
                blocks.push(block);
            } else if let Some(tool_call) = tool_part_to_block(&part_id, &data) {
                if let Some(last) = blocks.last_mut() {
                    last.tool_calls.push(tool_call);
                } else {
                    pending_tool_calls.push(tool_call);
                }
            }
        }

        if !pending_tool_calls.is_empty() {
            if let Some(last) = blocks.last_mut() {
                last.tool_calls.append(&mut pending_tool_calls);
            }
        }

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = derive_session_title(
            &alias,
            &session_title,
            &first_conversation_text(&blocks),
            &session_cwd,
            session_key,
            "OpenCode",
        );

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

        let data_str: String = conn
            .query_row(
                "SELECT data FROM part WHERE id = ?1",
                params![edit_target],
                |row| row.get(0),
            )
            .map_err(|e| format!("Part not found: {e}"))?;

        let mut payload: Value =
            serde_json::from_str(&data_str).map_err(|e| format!("Parse error: {e}"))?;

        let kind = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let old_content = match kind {
            "text" | "reasoning" => {
                let old = payload
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                payload["text"] = Value::String(new_content.to_string());
                old
            }
            "tool" => {
                let old = payload
                    .get("state")
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

        let new_data =
            serde_json::to_string(&payload).map_err(|e| format!("Serialize error: {e}"))?;
        conn.execute(
            "UPDATE part SET data = ?1 WHERE id = ?2",
            params![new_data, edit_target],
        )
        .map_err(|e| format!("Update error: {e}"))?;

        Ok(old_content)
    }

    fn replace_tool_call(
        &self,
        session_key: &str,
        tool_call_id: &str,
        record: Option<&str>,
    ) -> Result<Option<String>, String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Cannot start OpenCode transaction: {e}"))?;

        let current = tx
            .query_row(
                "SELECT id, message_id, session_id, time_created, time_updated, data
                 FROM part WHERE id = ?1 AND session_id = ?2",
                params![tool_call_id, session_key],
                |row| {
                    Ok(StoredPart {
                        id: row.get(0)?,
                        message_id: row.get(1)?,
                        session_id: row.get(2)?,
                        time_created: row.get(3)?,
                        time_updated: row.get(4)?,
                        data: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("Cannot read OpenCode tool part: {e}"))?;

        if let Some(part) = &current {
            ensure_tool_part(&part.data)?;
        }

        match record {
            None => {
                let Some(_) = current.as_ref() else {
                    return Err("OpenCode tool part was not found in this session".to_string());
                };
                tx.execute(
                    "DELETE FROM part WHERE id = ?1 AND session_id = ?2",
                    params![tool_call_id, session_key],
                )
                .map_err(|e| format!("Cannot erase OpenCode tool part: {e}"))?;
            }
            Some(serialized) => {
                let stored: StoredPart = serde_json::from_str(serialized)
                    .map_err(|e| format!("Invalid OpenCode tool restore record: {e}"))?;
                if stored.id != tool_call_id || stored.session_id != session_key {
                    return Err(
                        "OpenCode tool restore record does not belong to this session".to_string(),
                    );
                }
                ensure_tool_part(&stored.data)?;
                let existing_owner: Option<String> = tx
                    .query_row(
                        "SELECT session_id FROM part WHERE id = ?1",
                        params![tool_call_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("Cannot validate OpenCode tool owner: {e}"))?;
                if existing_owner
                    .as_deref()
                    .is_some_and(|owner| owner != session_key)
                {
                    return Err(
                        "An OpenCode part with this ID belongs to another session".to_string()
                    );
                }
                let message_belongs_to_session: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM message WHERE id = ?1 AND session_id = ?2)",
                        params![stored.message_id, session_key],
                        |row| row.get(0),
                    )
                    .map_err(|e| format!("Cannot validate OpenCode tool message: {e}"))?;
                if !message_belongs_to_session {
                    return Err("The original OpenCode message no longer exists".to_string());
                }
                tx.execute(
                    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                       message_id = excluded.message_id,
                       session_id = excluded.session_id,
                       time_created = excluded.time_created,
                       time_updated = excluded.time_updated,
                       data = excluded.data",
                    params![
                        stored.id,
                        stored.message_id,
                        stored.session_id,
                        stored.time_created,
                        stored.time_updated,
                        stored.data,
                    ],
                )
                .map_err(|e| format!("Cannot restore OpenCode tool part: {e}"))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("Cannot commit OpenCode tool change: {e}"))?;
        current
            .map(|part| serde_json::to_string(&part).map_err(|e| e.to_string()))
            .transpose()
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
            |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                ))
            },
        ) {
            if row.0.to_lowercase().contains(&needle) || row.1.to_lowercase().contains(&needle) {
                return true;
            }
        }

        if let Ok(mut stmt) = conn.prepare("SELECT data FROM part WHERE session_id = ?1") {
            if let Ok(mut rows) = stmt.query(params![session_key]) {
                while let Ok(Some(row)) = rows.next() {
                    let data_str: String = row.get(0).unwrap_or_default();
                    if data_str.to_lowercase().contains(&needle) {
                        return true;
                    }
                }
            }
        }

        false
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return vec![];
        }

        let conn = match self.connect() {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        let mut matches = Vec::new();

        if let Ok(mut stmt) = conn.prepare(
            "SELECT p.data, m.role FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = ?1 ORDER BY p.id"
        ) {
            if let Ok(mut rows) = stmt.query(params![session_key]) {
                let mut msg_index = 0usize;
                while let Ok(Some(row)) = rows.next() {
                    let data_str: String = row.get(0).unwrap_or_default();
                    let role: String = row.get(1).unwrap_or_default();
                    let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
                    let kind = data.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let mut searchable = Vec::new();
                    if let Some(t) = data.get("text").and_then(|v| v.as_str()) {
                        searchable.push(t.to_string());
                    }
                    if kind == "tool" {
                        if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
                            searchable.push(name.to_string());
                        }
                        if let Some(state) = data.get("state") {
                            if let Some(output) = state.get("output").and_then(|v| v.as_str()) {
                                searchable.push(output.to_string());
                            }
                            if let Some(input) = state.get("input") {
                                searchable.push(input.to_string());
                            }
                        }
                    }
                    let combined = searchable.join(" ").to_lowercase();
                    if combined.contains(&needle) {
                        let best = searchable.iter().find(|t| t.to_lowercase().contains(&needle)).cloned().unwrap_or_default();
                        matches.push(ContentMatch {
                            snippet: super::extract_snippet(&best, &needle),
                            match_index: msg_index,
                            role: role.clone(),
                        });
                    }
                    msg_index += 1;
                }
            }
        }

        matches
    }
}

fn ensure_tool_part(data: &str) -> Result<(), String> {
    let payload: Value =
        serde_json::from_str(data).map_err(|e| format!("Invalid OpenCode part data: {e}"))?;
    if payload.get("type").and_then(Value::as_str) != Some("tool") {
        return Err("The selected OpenCode part is not a tool call".to_string());
    }
    Ok(())
}

fn part_to_block(part_id: &str, data: &Value, message_data: &Value) -> Option<TimelineBlock> {
    let kind = data.get("type").and_then(|v| v.as_str())?;
    let message_role = message_data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("user");

    match kind {
        "text" => Some(TimelineBlock {
            id: part_id.to_string(),
            role: message_role.to_string(),
            content: data
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            editable: true,
            edit_target: part_id.to_string(),
            source_meta: serde_json::json!({"partType": kind, "messageRole": message_role}),
            tool_calls: Vec::new(),
        }),
        "reasoning" => Some(TimelineBlock {
            id: part_id.to_string(),
            role: "thinking".into(),
            content: data
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            editable: true,
            edit_target: part_id.to_string(),
            source_meta: serde_json::json!({"partType": kind}),
            tool_calls: Vec::new(),
        }),
        _ => None,
    }
}

fn tool_part_to_block(part_id: &str, data: &Value) -> Option<ToolCallBlock> {
    let kind = data.get("type").and_then(|v| v.as_str())?;
    if kind != "tool" {
        return None;
    }

    let state = data.get("state");
    let status = state
        .and_then(|value| value.get("status"))
        .or_else(|| data.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed")
        .to_string();

    Some(ToolCallBlock {
        id: part_id.to_string(),
        name: data
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool".to_string(),
        status,
        input: state
            .and_then(|value| value.get("input"))
            .or_else(|| data.get("input"))
            .and_then(|value| tool_text_from_value(value, 8192)),
        output: state
            .and_then(|value| value.get("output"))
            .or_else(|| data.get("output"))
            .and_then(|value| tool_text_from_value(value, 32768)),
        error: state
            .and_then(|value| value.get("error"))
            .or_else(|| data.get("error"))
            .and_then(|value| tool_text_from_value(value, 8192)),
        started_at: state
            .and_then(|value| value.get("time_start"))
            .or_else(|| data.get("time_start"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        ended_at: state
            .and_then(|value| value.get("time_end"))
            .or_else(|| data.get("time_end"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        source_meta: serde_json::json!({"partType": kind}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    fn test_db(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("opencode-tool-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test directory");
        let path = dir.join("opencode.db");
        let conn = rusqlite::Connection::open(&path).expect("create test database");
        conn.execute_batch(
            "CREATE TABLE session (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL DEFAULT '',
               directory TEXT NOT NULL DEFAULT '',
               parent_id TEXT,
               time_updated INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE message (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL,
               data TEXT NOT NULL
             );
             CREATE TABLE part (
               id TEXT PRIMARY KEY,
               message_id TEXT NOT NULL,
               session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL,
               time_updated INTEGER NOT NULL,
               data TEXT NOT NULL
             );",
        )
        .expect("create OpenCode schema");
        conn.execute(
            "INSERT INTO session (id, title, directory, time_updated) VALUES ('s1', 'test', 'F:\\work', 1)",
            [],
        )
        .expect("insert session");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES ('m1', 's1', 1, '{\"role\":\"assistant\"}')",
            [],
        )
        .expect("insert message");
        path
    }

    fn insert_part(path: &Path, id: &str, data: &Value) {
        let conn = rusqlite::Connection::open(path).expect("open test database");
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES (?1, 'm1', 's1', 10, 20, ?2)",
            params![id, data.to_string()],
        )
        .expect("insert part");
    }

    #[test]
    fn tool_part_to_block_extracts_name_input_output_and_status() {
        let data = json!({
            "type": "tool",
            "name": "bash",
            "state": {
                "status": "completed",
                "input": { "command": "npm test" },
                "output": "ok"
            }
        });

        let tool_call = tool_part_to_block("part_1", &data).expect("tool call");

        assert_eq!(tool_call.id, "part_1");
        assert_eq!(tool_call.name, "bash");
        assert_eq!(tool_call.status, "completed");
        assert_eq!(
            tool_call.input.as_deref(),
            Some("{\n  \"command\": \"npm test\"\n}")
        );
        assert_eq!(tool_call.output.as_deref(), Some("ok"));
    }

    #[test]
    fn erases_rejected_tool_part_and_restores_complete_payload() {
        let path = test_db("erase-restore");
        let payload = json!({
            "type": "tool",
            "callID": "call-1",
            "tool": "bash",
            "state": {
                "status": "error",
                "input": { "command": "Remove-Item important.txt" },
                "output": "partial output",
                "error": "Permission rejected by user",
                "time": { "start": 10, "end": 11 }
            },
            "metadata": { "provider": "test" }
        });
        insert_part(&path, "p-tool", &payload);
        let platform = OpenCodePlatform::new(path.clone());

        let record = platform
            .replace_tool_call("s1", "p-tool", None)
            .expect("erase tool")
            .expect("stored record");
        let conn = rusqlite::Connection::open(&path).expect("open after erase");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM part WHERE id = 'p-tool'", [], |row| {
                row.get(0)
            })
            .expect("count erased part");
        assert_eq!(remaining, 0);
        drop(conn);

        assert_eq!(
            platform
                .replace_tool_call("s1", "p-tool", Some(&record))
                .expect("restore tool"),
            None
        );
        let conn = rusqlite::Connection::open(&path).expect("open after restore");
        let restored: (String, i64, i64) = conn
            .query_row(
                "SELECT data, time_created, time_updated FROM part WHERE id = 'p-tool'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read restored part");
        assert_eq!(serde_json::from_str::<Value>(&restored.0).unwrap(), payload);
        assert_eq!((restored.1, restored.2), (10, 20));
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn refuses_to_erase_non_tool_or_part_from_another_session() {
        let path = test_db("validation");
        insert_part(
            &path,
            "p-text",
            &json!({ "type": "text", "text": "keep me" }),
        );
        let platform = OpenCodePlatform::new(path.clone());

        assert!(platform
            .replace_tool_call("s1", "p-text", None)
            .expect_err("text part must be rejected")
            .contains("not a tool call"));
        assert!(platform
            .replace_tool_call("another-session", "p-text", None)
            .expect_err("cross-session erase must be rejected")
            .contains("not found"));
        let conn = rusqlite::Connection::open(&path).expect("open after rejection");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM part WHERE id = 'p-text'", [], |row| {
                row.get(0)
            })
            .expect("count preserved part");
        assert_eq!(remaining, 1);
        drop(conn);
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
