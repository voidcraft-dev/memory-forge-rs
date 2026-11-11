use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    build_commands, tool_text_from_str, tool_text_from_value, ContentMatch, SessionDetail,
    SessionKey, SessionListItem, SessionListResult, TimelineBlock, ToolCallBlock,
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

/// Restore record for a tool item embedded in an OpenCode v2 `session_message.data`
/// `content` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct V2ToolRecord {
    message_id: String,
    index: usize,
    item: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Schema {
    V1,
    V2,
}

const V2_EDIT_PREFIX: &str = "opencode-v2:";

fn detect_schema(conn: &rusqlite::Connection) -> Schema {
    let has_v2: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_v2 > 0 {
        Schema::V2
    } else {
        Schema::V1
    }
}

fn session_table(schema: Schema) -> &'static str {
    match schema {
        Schema::V1 => "session",
        Schema::V2 => "session_v2",
    }
}

fn v2_message_edit_target(message_id: &str) -> String {
    format!("{V2_EDIT_PREFIX}{message_id}:text")
}

fn v2_content_edit_target(message_id: &str, index: usize) -> String {
    format!("{V2_EDIT_PREFIX}{message_id}:{index}")
}

fn parse_v2_edit_target(edit_target: &str) -> Result<(&str, &str), String> {
    let rest = edit_target
        .strip_prefix(V2_EDIT_PREFIX)
        .ok_or_else(|| "Invalid OpenCode v2 edit target".to_string())?;
    rest.rsplit_once(':')
        .ok_or_else(|| "Invalid OpenCode v2 edit target".to_string())
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

        let table = session_table(detect_schema(&conn));

        // Get total count
        let total: usize = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE parent_id IS NULL OR parent_id = ''"),
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let sql = match limit {
            Some(l) => format!(
                "SELECT id, title, directory, time_updated FROM {table} WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated DESC LIMIT {} OFFSET {}",
                l, offset
            ),
            None => format!(
                "SELECT id, title, directory, time_updated FROM {table} WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated DESC LIMIT -1 OFFSET {}",
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
            let display_title = if alias.is_empty() {
                if title.is_empty() {
                    id.clone()
                } else {
                    title.clone()
                }
            } else {
                alias.clone()
            };

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
                source_label: String::new(),
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
        let table = session_table(detect_schema(&conn));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, time_updated
                 FROM {table}
                 WHERE parent_id IS NULL OR parent_id = ''
                 ORDER BY time_updated DESC"
            ))
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
        let table = session_table(detect_schema(&conn));
        let (title, directory, time_updated): (String, String, i64) = conn
            .query_row(
                &format!("SELECT title, directory, time_updated FROM {table} WHERE id = ?1"),
                params![session_key],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        row.get(2)?,
                    ))
                },
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
            source_label: String::new(),
            agent_group: None,
        })
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let conn = self.connect()?;
        let schema = detect_schema(&conn);
        let table = session_table(schema);

        let session_row: Option<(String, String)> = conn
            .query_row(
                &format!("SELECT title, directory FROM {table} WHERE id = ?1"),
                params![session_key],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                },
            )
            .ok();

        let (session_title, session_cwd) = session_row.unwrap_or_default();

        let blocks = match schema {
            Schema::V1 => collect_v1_blocks(&conn, session_key)?,
            Schema::V2 => collect_v2_blocks(&conn, session_key)?,
        };

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if alias.is_empty() {
            if session_title.is_empty() {
                session_key.to_string()
            } else {
                session_title
            }
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

        if detect_schema(&conn) == Schema::V2 {
            return update_v2_message(&conn, edit_target, new_content);
        }

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

        if detect_schema(&conn) == Schema::V2 {
            let tx = conn
                .transaction()
                .map_err(|e| format!("Cannot start OpenCode transaction: {e}"))?;
            let result = match record {
                None => erase_v2_tool(&tx, session_key, tool_call_id).map(Some),
                Some(serialized) => restore_v2_tool(&tx, session_key, serialized).map(|()| None),
            };
            tx.commit()
                .map_err(|e| format!("Cannot commit OpenCode tool change: {e}"))?;
            return result;
        }

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

        let schema = detect_schema(&conn);
        let table = session_table(schema);

        if let Ok(row) = conn.query_row(
            &format!("SELECT title, directory FROM {table} WHERE id = ?1"),
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

        if schema == Schema::V2 {
            if let Ok(mut stmt) =
                conn.prepare("SELECT type, data FROM session_message WHERE session_id = ?1")
            {
                if let Ok(mut rows) = stmt.query(params![session_key]) {
                    while let Ok(Some(row)) = rows.next() {
                        let msg_type: String = row.get(0).unwrap_or_default();
                        let data_str: String = row.get(1).unwrap_or_default();
                        let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
                        if v2_searchable_texts(&data, &msg_type)
                            .iter()
                            .any(|text| text.to_lowercase().contains(&needle))
                        {
                            return true;
                        }
                    }
                }
            }
            return false;
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

        if detect_schema(&conn) == Schema::V2 {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT type, data FROM session_message WHERE session_id = ?1 ORDER BY seq ASC",
            ) {
                if let Ok(mut rows) = stmt.query(params![session_key]) {
                    let mut msg_index = 0usize;
                    while let Ok(Some(row)) = rows.next() {
                        let msg_type: String = row.get(0).unwrap_or_default();
                        let data_str: String = row.get(1).unwrap_or_default();
                        let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
                        let searchable = v2_searchable_texts(&data, &msg_type);
                        let combined = searchable.join(" ").to_lowercase();
                        if combined.contains(&needle) {
                            let best = searchable
                                .iter()
                                .find(|text| text.to_lowercase().contains(&needle))
                                .cloned()
                                .unwrap_or_default();
                            if !best.is_empty() {
                                matches.push(ContentMatch {
                                    snippet: super::extract_snippet(&best, &needle),
                                    match_index: msg_index,
                                    role: v2_search_role(&msg_type).to_string(),
                                });
                            }
                        }
                        msg_index += 1;
                    }
                }
            }
            return matches;
        }

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

fn collect_v1_blocks(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<Vec<TimelineBlock>, String> {
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

    Ok(blocks)
}

fn collect_v2_blocks(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<Vec<TimelineBlock>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ?1 ORDER BY seq ASC, time_created ASC, id ASC",
        )
        .map_err(|e| format!("Prepare error: {e}"))?;

    let mut rows = stmt
        .query(params![session_key])
        .map_err(|e| format!("Query error: {e}"))?;

    let mut blocks: Vec<TimelineBlock> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        let msg_id: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
        let msg_type: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
        let time_created: i64 = row.get(3).map_err(|e| format!("Row column error: {e}"))?;
        let data_str: String = row.get(4).map_err(|e| format!("Row column error: {e}"))?;
        let data: Value = serde_json::from_str(&data_str).unwrap_or_default();

        match msg_type.as_str() {
            "user" | "synthetic" | "system" => {
                let text = data.get("text").and_then(Value::as_str).unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                let (role, editable) = match msg_type.as_str() {
                    "user" => ("user", true),
                    "synthetic" => ("user", false),
                    _ => ("assistant", false),
                };
                blocks.push(TimelineBlock {
                    id: msg_id.clone(),
                    role: role.to_string(),
                    content: text.to_string(),
                    editable,
                    edit_target: if editable {
                        v2_message_edit_target(&msg_id)
                    } else {
                        String::new()
                    },
                    source_meta: json!({"messageType": msg_type, "createdAt": time_created}),
                    tool_calls: Vec::new(),
                });
            }
            "assistant" => {
                let Some(content) = data.get("content").and_then(Value::as_array) else {
                    continue;
                };
                let first_block = blocks.len();
                let mut pending: Vec<ToolCallBlock> = Vec::new();
                for (index, item) in content.iter().enumerate() {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let mut block = TimelineBlock {
                                id: format!("{msg_id}:{index}"),
                                role: "assistant".to_string(),
                                content: item
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                editable: true,
                                edit_target: v2_content_edit_target(&msg_id, index),
                                source_meta: json!({
                                    "messageType": "assistant",
                                    "contentType": "text",
                                    "createdAt": time_created
                                }),
                                tool_calls: Vec::new(),
                            };
                            block.tool_calls.append(&mut pending);
                            blocks.push(block);
                        }
                        Some("reasoning") => {
                            let mut block = TimelineBlock {
                                id: format!("{msg_id}:{index}"),
                                role: "thinking".to_string(),
                                content: item
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                editable: true,
                                edit_target: v2_content_edit_target(&msg_id, index),
                                source_meta: json!({
                                    "messageType": "assistant",
                                    "contentType": "reasoning",
                                    "createdAt": time_created
                                }),
                                tool_calls: Vec::new(),
                            };
                            block.tool_calls.append(&mut pending);
                            blocks.push(block);
                        }
                        Some("tool") => {
                            if let Some(tool_call) =
                                v2_tool_block(item, &format!("{msg_id}:{index}"), time_created)
                            {
                                pending.push(tool_call);
                            }
                        }
                        _ => {}
                    }
                }
                if !pending.is_empty() {
                    if blocks.len() > first_block {
                        if let Some(last) = blocks.last_mut() {
                            last.tool_calls.append(&mut pending);
                        }
                    } else {
                        blocks.push(TimelineBlock {
                            id: msg_id.clone(),
                            role: "assistant".to_string(),
                            content: String::new(),
                            editable: false,
                            edit_target: String::new(),
                            source_meta: json!({
                                "messageType": "assistant",
                                "createdAt": time_created
                            }),
                            tool_calls: pending,
                        });
                    }
                }
            }
            "compaction" => {
                let summary = data.get("summary").and_then(Value::as_str).unwrap_or("");
                if summary.is_empty() {
                    continue;
                }
                let mut source_meta = json!({
                    "messageType": "compaction",
                    "createdAt": time_created
                });
                if let Some(reason) = data.get("reason") {
                    source_meta["reason"] = reason.clone();
                }
                blocks.push(TimelineBlock {
                    id: msg_id.clone(),
                    role: "assistant".to_string(),
                    content: summary.to_string(),
                    editable: false,
                    edit_target: String::new(),
                    source_meta,
                    tool_calls: Vec::new(),
                });
            }
            _ => {}
        }
    }

    Ok(blocks)
}

fn v2_tool_block(item: &Value, fallback_id: &str, message_created: i64) -> Option<ToolCallBlock> {
    if item.get("type").and_then(Value::as_str) != Some("tool") {
        return None;
    }
    let state = item.get("state");
    let status = state
        .and_then(|value| value.get("status"))
        .or_else(|| item.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("completed")
        .to_string();

    let mut source_meta = json!({"partType": "tool", "createdAt": message_created});
    if let Some(time) = state.and_then(|value| value.get("time")) {
        source_meta["time"] = time.clone();
    }

    Some(ToolCallBlock {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or(fallback_id)
            .to_string(),
        name: item
            .get("name")
            .or_else(|| item.get("tool"))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool".to_string(),
        status,
        input: state
            .and_then(|value| value.get("input"))
            .or_else(|| item.get("input"))
            .and_then(|value| tool_text_from_value(value, 8192)),
        output: v2_tool_output(state),
        error: state
            .and_then(|value| value.get("error"))
            .or_else(|| item.get("error"))
            .and_then(|value| tool_text_from_value(value, 8192)),
        started_at: state
            .and_then(|value| value.get("time"))
            .and_then(|time| time.get("created"))
            .and_then(Value::as_i64)
            .map(|value| value.to_string()),
        ended_at: state
            .and_then(|value| value.get("time"))
            .and_then(|time| time.get("completed"))
            .and_then(Value::as_i64)
            .map(|value| value.to_string()),
        source_meta,
    })
}

fn v2_tool_output(state: Option<&Value>) -> Option<String> {
    let state = state?;

    if let Some(content) = state.get("content").and_then(Value::as_array) {
        let mut parts: Vec<String> = Vec::new();
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            parts.push(text.to_string());
                        }
                    }
                }
                Some("file") => {
                    if let Some(path) = item.get("path").and_then(Value::as_str) {
                        parts.push(path.to_string());
                    } else if let Some(url) = item.get("url").and_then(Value::as_str) {
                        parts.push(url.to_string());
                    }
                }
                _ => {}
            }
        }
        if !parts.is_empty() {
            return tool_text_from_str(&parts.join("\n"), 32768);
        }
    }

    if let Some(output) = state
        .get("metadata")
        .and_then(|metadata| metadata.get("output"))
    {
        if let Some(text) = tool_text_from_value(output, 32768) {
            return Some(text);
        }
    }

    state
        .get("output")
        .and_then(|value| tool_text_from_value(value, 32768))
}

fn v2_searchable_texts(data: &Value, msg_type: &str) -> Vec<String> {
    let mut texts = Vec::new();
    match msg_type {
        "user" | "synthetic" | "system" => {
            if let Some(text) = data.get("text").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
        }
        "assistant" => {
            if let Some(content) = data.get("content").and_then(Value::as_array) {
                for item in content {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") | Some("reasoning") => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                texts.push(text.to_string());
                            }
                        }
                        Some("tool") => {
                            if let Some(name) = item.get("name").and_then(Value::as_str) {
                                texts.push(name.to_string());
                            }
                            if let Some(input) =
                                item.get("state").and_then(|state| state.get("input"))
                            {
                                if let Some(text) = tool_text_from_value(input, 8192) {
                                    texts.push(text);
                                }
                            }
                            if let Some(output) = v2_tool_output(item.get("state")) {
                                texts.push(output);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        "compaction" => {
            if let Some(summary) = data.get("summary").and_then(Value::as_str) {
                texts.push(summary.to_string());
            }
        }
        _ => {}
    }
    texts
}

fn v2_search_role(msg_type: &str) -> &'static str {
    match msg_type {
        "user" | "synthetic" => "user",
        _ => "assistant",
    }
}

fn update_v2_message(
    conn: &rusqlite::Connection,
    edit_target: &str,
    new_content: &str,
) -> Result<String, String> {
    let (message_id, field) = parse_v2_edit_target(edit_target)?;

    let data_str: String = conn
        .query_row(
            "SELECT data FROM session_message WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Message not found: {e}"))?;

    let mut data: Value =
        serde_json::from_str(&data_str).map_err(|e| format!("Parse error: {e}"))?;
    if !data.is_object() {
        return Err("OpenCode v2 message data is not an object".to_string());
    }

    let old = if field == "text" {
        let old = data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        data["text"] = Value::String(new_content.to_string());
        old
    } else {
        let index: usize = field
            .parse()
            .map_err(|_| "Invalid OpenCode v2 edit target".to_string())?;
        let item = data
            .get_mut("content")
            .and_then(Value::as_array_mut)
            .and_then(|content| content.get_mut(index))
            .ok_or_else(|| "The selected OpenCode message was not found".to_string())?;
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "text" && kind != "reasoning" {
            return Err("The selected OpenCode message is not editable".to_string());
        }
        let old = item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        item["text"] = Value::String(new_content.to_string());
        old
    };

    let new_data = serde_json::to_string(&data).map_err(|e| format!("Serialize error: {e}"))?;
    conn.execute(
        "UPDATE session_message SET data = ?1 WHERE id = ?2",
        params![new_data, message_id],
    )
    .map_err(|e| format!("Update error: {e}"))?;

    Ok(old)
}

fn erase_v2_tool(
    conn: &rusqlite::Connection,
    session_key: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT id, data FROM session_message WHERE session_id = ?1 ORDER BY seq ASC")
        .map_err(|e| format!("Prepare error: {e}"))?;
    let mut rows = stmt
        .query(params![session_key])
        .map_err(|e| format!("Query error: {e}"))?;

    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        let message_id: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
        let data_str: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
        let mut data: Value =
            serde_json::from_str(&data_str).map_err(|e| format!("Parse error: {e}"))?;

        let removed = {
            let Some(content) = data.get_mut("content").and_then(Value::as_array_mut) else {
                continue;
            };
            let Some(index) = content.iter().position(|item| {
                item.get("type").and_then(Value::as_str) == Some("tool")
                    && item.get("id").and_then(Value::as_str) == Some(tool_call_id)
            }) else {
                continue;
            };
            (index, content.remove(index))
        };

        let (index, item) = removed;
        let new_data = serde_json::to_string(&data).map_err(|e| format!("Serialize error: {e}"))?;
        conn.execute(
            "UPDATE session_message SET data = ?1 WHERE id = ?2",
            params![new_data, message_id],
        )
        .map_err(|e| format!("Update error: {e}"))?;

        return serde_json::to_string(&V2ToolRecord {
            message_id,
            index,
            item,
        })
        .map_err(|e| e.to_string());
    }

    Err("OpenCode tool part was not found in this session".to_string())
}

fn restore_v2_tool(
    conn: &rusqlite::Connection,
    session_key: &str,
    record: &str,
) -> Result<(), String> {
    let record: V2ToolRecord = serde_json::from_str(record)
        .map_err(|e| format!("Invalid OpenCode tool restore record: {e}"))?;
    if record.item.get("type").and_then(Value::as_str) != Some("tool") {
        return Err("The selected OpenCode part is not a tool call".to_string());
    }

    let data_str: String = conn
        .query_row(
            "SELECT data FROM session_message WHERE id = ?1 AND session_id = ?2",
            params![record.message_id, session_key],
            |row| row.get(0),
        )
        .map_err(|e| format!("Cannot read OpenCode message: {e}"))?;

    let mut data: Value =
        serde_json::from_str(&data_str).map_err(|e| format!("Parse error: {e}"))?;
    let content = data
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "OpenCode message has no content array".to_string())?;

    if let Some(id) = record.item.get("id").and_then(Value::as_str) {
        if content
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(id))
        {
            return Ok(());
        }
    }

    let index = record.index.min(content.len());
    content.insert(index, record.item);

    let new_data = serde_json::to_string(&data).map_err(|e| format!("Serialize error: {e}"))?;
    conn.execute(
        "UPDATE session_message SET data = ?1 WHERE id = ?2",
        params![new_data, record.message_id],
    )
    .map_err(|e| format!("Update error: {e}"))?;

    Ok(())
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

    fn test_v2_db(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("opencode-v2-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test directory");
        let path = dir.join("opencode.db");
        let conn = rusqlite::Connection::open(&path).expect("create test database");
        conn.execute_batch(
            "CREATE TABLE session_v2 (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL DEFAULT 'global',
               parent_id TEXT,
               title TEXT NOT NULL DEFAULT '',
               directory TEXT NOT NULL DEFAULT '',
               time_created INTEGER NOT NULL DEFAULT 0,
               time_updated INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE session_message (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               type TEXT NOT NULL,
               seq INTEGER NOT NULL,
               time_created INTEGER NOT NULL,
               time_updated INTEGER NOT NULL,
               data TEXT NOT NULL
             );",
        )
        .expect("create OpenCode v2 schema");
        conn.execute(
            "INSERT INTO session_v2 (id, title, directory, time_updated) VALUES ('s2', 'v2 test', 'F:\\work', 5)",
            [],
        )
        .expect("insert v2 session");
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES ('m_user', 's2', 'user', 0, 1, 1, ?1)",
            params![json!({"text": "hello", "time": {"created": 1}}).to_string()],
        )
        .expect("insert user message");
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES ('m_assistant', 's2', 'assistant', 1, 2, 2, ?1)",
            params![json!({
                "agent": "build",
                "content": [
                    {"type": "reasoning", "text": "think"},
                    {"type": "text", "text": "answer"},
                    {"type": "tool", "id": "call_1", "name": "bash", "state": {
                        "status": "completed",
                        "input": {"command": "echo hi"},
                        "content": [{"type": "text", "text": "hi"}],
                        "time": {"created": 10, "completed": 11}
                    }}
                ],
                "time": {"created": 2}
            })
            .to_string()],
        )
        .expect("insert assistant message");
        path
    }

    #[test]
    fn v2_lists_sessions_and_builds_blocks() {
        let path = test_v2_db("detail");
        let platform = OpenCodePlatform::new(path.clone());
        let alias_map = HashMap::new();

        let listed = platform.list_sessions(&alias_map, None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(listed.items[0].session_key, "s2");
        assert_eq!(listed.items[0].display_title, "v2 test");

        let detail = platform
            .get_session_detail("s2", &alias_map)
            .expect("v2 session detail");
        assert_eq!(detail.blocks.len(), 3);
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "hello");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[1].content, "think");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].content, "answer");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);

        let tool = &detail.blocks[2].tool_calls[0];
        assert_eq!(tool.id, "call_1");
        assert_eq!(tool.name, "bash");
        assert_eq!(tool.status, "completed");
        assert_eq!(tool.output.as_deref(), Some("hi"));

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn v2_edits_text_and_reasoning_content() {
        let path = test_v2_db("edit");
        let platform = OpenCodePlatform::new(path.clone());
        let alias_map = HashMap::new();
        let detail = platform
            .get_session_detail("s2", &alias_map)
            .expect("v2 session detail");

        let assistant_target = detail.blocks[2].edit_target.clone();
        let old = platform
            .update_message(&assistant_target, "new answer")
            .expect("edit assistant text");
        assert_eq!(old, "answer");

        let reasoning_target = detail.blocks[1].edit_target.clone();
        let old = platform
            .update_message(&reasoning_target, "new thought")
            .expect("edit reasoning");
        assert_eq!(old, "think");

        let detail = platform
            .get_session_detail("s2", &alias_map)
            .expect("v2 session detail");
        assert_eq!(detail.blocks[1].content, "new thought");
        assert_eq!(detail.blocks[2].content, "new answer");

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn v2_erases_and_restores_tool_item() {
        let path = test_v2_db("tool");
        let platform = OpenCodePlatform::new(path.clone());
        let alias_map = HashMap::new();

        let record = platform
            .replace_tool_call("s2", "call_1", None)
            .expect("erase v2 tool")
            .expect("stored record");
        let detail = platform
            .get_session_detail("s2", &alias_map)
            .expect("detail after erase");
        assert!(detail
            .blocks
            .iter()
            .all(|block| block.tool_calls.is_empty()));

        assert_eq!(
            platform
                .replace_tool_call("s2", "call_1", Some(&record))
                .expect("restore v2 tool"),
            None
        );
        let detail = platform
            .get_session_detail("s2", &alias_map)
            .expect("detail after restore");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(detail.blocks[2].tool_calls[0].output.as_deref(), Some("hi"));

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn v2_search_matches_message_and_tool_output() {
        let path = test_v2_db("search");
        let platform = OpenCodePlatform::new(path.clone());

        assert!(platform.matches_query("s2", "answer"));
        assert!(platform.matches_query("s2", "echo hi"));
        assert!(platform.matches_query("s2", "hi"));
        assert!(!platform.matches_query("s2", "missing"));

        let matches = platform.content_search("s2", "hi");
        assert!(!matches.is_empty());
        assert!(matches
            .iter()
            .any(|item| item.role == "user" || item.role == "assistant"));

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
