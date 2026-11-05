use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::params;
use serde_json::{json, Value};

use super::{
    build_commands, derive_session_title, first_conversation_text, tool_text_from_value,
    ContentMatch, SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock,
    ToolCallBlock,
};

const ZCODE_TOOL_INPUT_MAX_CHARS: usize = 8192;
const ZCODE_TOOL_OUTPUT_MAX_CHARS: usize = 32768;

pub struct ZcodePlatform {
    db_path: PathBuf,
}

impl ZcodePlatform {
    pub fn new(zcode_home: PathBuf) -> Self {
        Self {
            db_path: zcode_home.join("cli").join("db").join("db.sqlite"),
        }
    }

    fn connect(&self) -> Result<rusqlite::Connection, String> {
        let conn = rusqlite::Connection::open(&self.db_path)
            .map_err(|e| format!("Failed to open zcode db: {e}"))?;
        Ok(conn)
    }
}

impl super::PlatformAdapter for ZcodePlatform {
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
            let display_title = derive_session_title(&alias, &title, "", &directory, &id, "ZCode");

            items.push(SessionListItem {
                platform: "zcode".into(),
                session_key: id.clone(),
                session_id: id,
                display_title,
                alias_title: alias,
                preview: title,
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
            platform: "zcode".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            display_title,
            alias_title: alias,
            preview: title,
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

        // part.sequence is scoped to its message, so ordering must go through
        // the parent message first and fall back to time/id within it.
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.data, m.data as message_data
                 FROM part p JOIN message m ON m.id = p.message_id
                 WHERE p.session_id = ?1
                 ORDER BY m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC",
            )
            .map_err(|e| format!("Prepare error: {e}"))?;

        let mut rows = stmt
            .query(params![session_key])
            .map_err(|e| format!("Query error: {e}"))?;

        let mut blocks: Vec<TimelineBlock> = Vec::new();
        let mut pending_tool_calls: Vec<ToolCallBlock> = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
            let part_id: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
            let data_str: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
            let message_data_str: String = row.get::<_, String>(2).unwrap_or_default();

            let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
            let message_data: Value = serde_json::from_str(&message_data_str).unwrap_or_default();

            // Skip synthetic user-role injections (todo reminders, background
            // notifications); only real prompts and pre-semantic rows stay.
            let message_role = message_data
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            if message_role == "user" {
                let semantics_kind = message_data
                    .pointer("/semantics/kind")
                    .and_then(Value::as_str);
                if semantics_kind.is_some_and(|kind| kind != "user_prompt") {
                    continue;
                }
            }

            match data.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    let mut block = text_part_to_block(&part_id, &data, message_role);
                    block.tool_calls.append(&mut pending_tool_calls);
                    blocks.push(block);
                }
                "reasoning" => {
                    if message_role == "assistant" {
                        blocks.push(reasoning_part_to_block(&part_id, &data));
                    }
                }
                "tool" => {
                    if let Some(tool_call) = tool_part_to_tool_call(&part_id, &data) {
                        pending_tool_calls.push(tool_call);
                    }
                }
                _ => {}
            }
        }

        if !pending_tool_calls.is_empty() {
            flush_pending_tool_calls(&mut blocks, &mut pending_tool_calls);
        }

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = derive_session_title(
            &alias,
            &session_title,
            &first_conversation_text(&blocks),
            &session_cwd,
            session_key,
            "ZCode",
        );

        Ok(SessionDetail {
            platform: "zcode".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd: session_cwd,
            commands: build_commands("zcode", session_key),
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
            "SELECT p.data, m.data as message_data
             FROM part p JOIN message m ON p.message_id = m.id
             WHERE p.session_id = ?1
             ORDER BY p.time_created ASC, p.id ASC",
        ) {
            if let Ok(mut rows) = stmt.query(params![session_key]) {
                let mut msg_index = 0usize;
                while let Ok(Some(row)) = rows.next() {
                    let data_str: String = row.get(0).unwrap_or_default();
                    let message_data_str: String = row.get(1).unwrap_or_default();
                    let data: Value = serde_json::from_str(&data_str).unwrap_or_default();
                    let message_data: Value =
                        serde_json::from_str(&message_data_str).unwrap_or_default();
                    let role = message_data
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("user");

                    let mut searchable: Vec<String> = Vec::new();
                    match data.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" | "reasoning" => {
                            if let Some(text) = data.get("text").and_then(Value::as_str) {
                                searchable.push(text.to_string());
                            }
                        }
                        "tool" => {
                            if let Some(name) = data.get("tool").and_then(Value::as_str) {
                                searchable.push(name.to_string());
                            }
                            if let Some(state) = data.get("state") {
                                if let Some(output) = state.get("output").and_then(Value::as_str)
                                {
                                    searchable.push(output.to_string());
                                }
                                if let Some(input) = state.get("input") {
                                    searchable.push(input.to_string());
                                }
                            }
                        }
                        _ => {}
                    }

                    let combined = searchable.join(" ").to_lowercase();
                    if combined.contains(&needle) {
                        let best = searchable
                            .iter()
                            .find(|text| text.to_lowercase().contains(&needle))
                            .cloned()
                            .unwrap_or_default();
                        matches.push(ContentMatch {
                            snippet: super::extract_snippet(&best, &needle),
                            match_index: msg_index,
                            role: role.to_string(),
                        });
                    }
                    msg_index += 1;
                }
            }
        }

        matches
    }
}

fn text_part_to_block(part_id: &str, data: &Value, message_role: &str) -> TimelineBlock {
    TimelineBlock {
        id: part_id.to_string(),
        role: message_role.to_string(),
        content: data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        editable: true,
        edit_target: part_id.to_string(),
        source_meta: json!({"partType": "text", "messageRole": message_role}),
        tool_calls: Vec::new(),
    }
}

/// ZCode reasoning parts render as `thinking` blocks, matching the OpenCode adapter.
fn reasoning_part_to_block(part_id: &str, data: &Value) -> TimelineBlock {
    TimelineBlock {
        id: part_id.to_string(),
        role: "thinking".into(),
        content: data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        editable: true,
        edit_target: part_id.to_string(),
        source_meta: json!({"partType": "reasoning"}),
        tool_calls: Vec::new(),
    }
}

fn tool_part_to_tool_call(part_id: &str, data: &Value) -> Option<ToolCallBlock> {
    if data.get("type").and_then(Value::as_str) != Some("tool") {
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
            .get("tool")
            .and_then(Value::as_str)
            .or_else(|| data.get("name").and_then(Value::as_str))
            .unwrap_or("tool")
            .to_string(),
        kind: "tool".to_string(),
        status,
        input: state
            .and_then(|value| value.get("input"))
            .or_else(|| data.get("input"))
            .and_then(|value| tool_text_from_value(value, ZCODE_TOOL_INPUT_MAX_CHARS)),
        output: state
            .and_then(|value| value.get("output"))
            .or_else(|| data.get("output"))
            .and_then(|value| tool_text_from_value(value, ZCODE_TOOL_OUTPUT_MAX_CHARS)),
        error: state
            .and_then(|value| value.get("error"))
            .or_else(|| data.get("error"))
            .and_then(|value| tool_text_from_value(value, ZCODE_TOOL_INPUT_MAX_CHARS)),
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
        source_meta: json!({
            "partType": "tool",
            "callID": data.get("callID").and_then(Value::as_str),
        }),
    })
}

/// Tool calls left over at the end of a session render as a dedicated
/// assistant block, the same way the Claude and Kiro IDE adapters flush them.
fn flush_pending_tool_calls(blocks: &mut Vec<TimelineBlock>, pending: &mut Vec<ToolCallBlock>) {
    if pending.is_empty() {
        return;
    }

    let mut block = TimelineBlock {
        id: format!("zcode-tools-{}", blocks.len()),
        role: "assistant".to_string(),
        content: String::new(),
        editable: false,
        edit_target: String::new(),
        source_meta: json!({"itemType": "tool_calls"}),
        tool_calls: Vec::new(),
    };
    block.tool_calls.append(pending);
    blocks.push(block);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    fn test_db(label: &str) -> (PathBuf, PathBuf) {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("zcode-{label}-{}", Uuid::new_v4()));
        // The adapter resolves `<home>/cli/db/db.sqlite`, so build that layout.
        let db_dir = dir.join("cli").join("db");
        fs::create_dir_all(&db_dir).expect("create test directory");
        let path = db_dir.join("db.sqlite");
        let conn = rusqlite::Connection::open(&path).expect("create test database");
        conn.execute_batch(
            "CREATE TABLE session (
               id TEXT PRIMARY KEY,
               directory TEXT,
               parent_id TEXT,
               title TEXT,
               time_created INTEGER NOT NULL DEFAULT 0,
               time_updated INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE message (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL,
               time_updated INTEGER NOT NULL DEFAULT 0,
               data TEXT NOT NULL,
               sequence INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE part (
               id TEXT PRIMARY KEY,
               message_id TEXT NOT NULL,
               session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL,
               time_updated INTEGER NOT NULL DEFAULT 0,
               data TEXT NOT NULL,
               sequence INTEGER NOT NULL DEFAULT 0
             );",
        )
        .expect("create zcode schema");
        conn.execute(
            "INSERT INTO session (id, directory, title, time_created, time_updated)
             VALUES ('sess_1', 'E:\\work', 'test session', 10, 20)",
            [],
        )
        .expect("insert session");
        (dir, path)
    }

    fn insert_message(path: &Path, id: &str, time_created: i64, data: &Value) {
        let conn = rusqlite::Connection::open(path).expect("open test database");
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data, sequence)
             VALUES (?1, 'sess_1', ?2, ?3, ?2)",
            params![id, time_created, data.to_string()],
        )
        .expect("insert message");
    }

    fn insert_part(path: &Path, id: &str, message_id: &str, time_created: i64, data: &Value) {
        let conn = rusqlite::Connection::open(path).expect("open test database");
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data, sequence)
             VALUES (?1, ?2, 'sess_1', ?3, ?4, 0)",
            params![id, message_id, time_created, data.to_string()],
        )
        .expect("insert part");
    }

    #[test]
    fn tool_part_to_tool_call_extracts_fields() {
        let data = json!({
            "type": "tool",
            "callID": "call_1",
            "tool": "WebSearch",
            "state": {
                "status": "completed",
                "input": { "query": "zcode" },
                "output": "results"
            }
        });

        let tool_call = tool_part_to_tool_call("part_1", &data).expect("tool call");

        assert_eq!(tool_call.id, "part_1");
        assert_eq!(tool_call.name, "WebSearch");
        assert_eq!(tool_call.status, "completed");
        assert_eq!(
            tool_call.input.as_deref(),
            Some("{\n  \"query\": \"zcode\"\n}")
        );
        assert_eq!(tool_call.output.as_deref(), Some("results"));
        assert_eq!(
            tool_call.source_meta.get("callID").and_then(Value::as_str),
            Some("call_1")
        );
    }

    #[test]
    fn detail_skips_synthetic_user_messages_and_attaches_tools_to_answer() {
        let (dir, path) = test_db("detail");

        // Real user prompt.
        insert_message(
            &path,
            "m1",
            1,
            &json!({
                "role": "user",
                "semantics": { "kind": "user_prompt" }
            }),
        );
        insert_part(&path, "p-user", "m1", 1, &json!({ "type": "text", "text": "你好" }));

        // Assistant turn: reasoning, tool call, then the answer text.
        insert_message(
            &path,
            "m2",
            2,
            &json!({ "role": "assistant" }),
        );
        insert_part(
            &path,
            "p-think",
            "m2",
            2,
            &json!({ "type": "reasoning", "text": "thinking" }),
        );
        insert_part(
            &path,
            "p-tool",
            "m2",
            3,
            &json!({
                "type": "tool",
                "callID": "call_1",
                "tool": "WebSearch",
                "state": { "status": "completed", "input": { "query": "zcode" }, "output": "results" }
            }),
        );
        insert_part(
            &path,
            "p-answer",
            "m2",
            4,
            &json!({ "type": "text", "text": "回答" }),
        );

        // Synthetic user-role injections must be filtered out.
        insert_message(
            &path,
            "m3",
            5,
            &json!({
                "role": "user",
                "semantics": { "kind": "todo_reminder" }
            }),
        );
        insert_part(
            &path,
            "p-todo",
            "m3",
            5,
            &json!({ "type": "text", "text": "todo reminder noise" }),
        );
        insert_message(
            &path,
            "m4",
            6,
            &json!({
                "role": "user",
                "semantics": { "kind": "background_notification" }
            }),
        );
        insert_part(
            &path,
            "p-notify",
            "m4",
            6,
            &json!({ "type": "text", "text": "background noise" }),
        );

        let platform = ZcodePlatform::new(dir.clone());
        let detail = platform.get_session_detail("sess_1", &HashMap::new()).unwrap();
        fs::remove_dir_all(&dir).ok();

        assert_eq!(detail.blocks.len(), 3, "blocks: {:?}", detail.blocks);
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "你好");
        assert_eq!(detail.blocks[0].edit_target, "p-user");

        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[1].content, "thinking");

        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].content, "回答");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(detail.blocks[2].tool_calls[0].name, "WebSearch");
        assert_eq!(detail.blocks[2].tool_calls[0].output.as_deref(), Some("results"));
    }

    #[test]
    fn detail_flushes_unclaimed_tool_calls_into_synthetic_block() {
        let (dir, path) = test_db("flush");

        insert_message(&path, "m1", 1, &json!({ "role": "user", "semantics": { "kind": "user_prompt" } }));
        insert_part(&path, "p-user", "m1", 1, &json!({ "type": "text", "text": "hi" }));
        insert_message(&path, "m2", 2, &json!({ "role": "assistant" }));
        insert_part(
            &path,
            "p-tool",
            "m2",
            2,
            &json!({
                "type": "tool",
                "tool": "Bash",
                "state": { "status": "error", "input": { "command": "ls" }, "error": "boom" }
            }),
        );

        let platform = ZcodePlatform::new(dir.clone());
        let detail = platform.get_session_detail("sess_1", &HashMap::new()).unwrap();
        fs::remove_dir_all(&dir).ok();

        assert_eq!(detail.blocks.len(), 2, "blocks: {:?}", detail.blocks);
        assert_eq!(detail.blocks[1].role, "assistant");
        assert!(!detail.blocks[1].editable);
        assert_eq!(detail.blocks[1].tool_calls.len(), 1);
        assert_eq!(detail.blocks[1].tool_calls[0].name, "Bash");
        assert_eq!(detail.blocks[1].tool_calls[0].status, "error");
        assert_eq!(detail.blocks[1].tool_calls[0].error.as_deref(), Some("boom"));
    }

    #[test]
    fn update_message_replaces_text_part_content() {
        let (dir, path) = test_db("update");
        insert_message(&path, "m1", 1, &json!({ "role": "assistant" }));
        insert_part(
            &path,
            "p-answer",
            "m1",
            1,
            &json!({ "type": "text", "text": "旧回答" }),
        );

        let platform = ZcodePlatform::new(dir.clone());
        let old = platform
            .update_message("p-answer", "新回答")
            .expect("update part");
        let conn = rusqlite::Connection::open(&path).expect("open after update");
        let data: String = conn
            .query_row("SELECT data FROM part WHERE id = 'p-answer'", [], |row| {
                row.get(0)
            })
            .expect("read updated part");
        drop(conn);
        fs::remove_dir_all(&dir).ok();

        assert_eq!(old, "旧回答");
        let payload: Value = serde_json::from_str(&data).unwrap();
        assert_eq!(payload["text"], json!("新回答"));
    }

    #[test]
    fn list_sessions_filters_subagent_sessions() {
        let (dir, path) = test_db("list");
        let conn = rusqlite::Connection::open(&path).expect("open test database");
        conn.execute(
            "INSERT INTO session (id, directory, title, time_created, time_updated, parent_id)
             VALUES ('sess_child', 'E:\\work', 'child', 30, 40, 'sess_1')",
            [],
        )
        .expect("insert child session");
        drop(conn);

        let platform = ZcodePlatform::new(dir.clone());
        let result = platform.list_sessions(&HashMap::new(), None, 0);
        fs::remove_dir_all(&dir).ok();

        assert_eq!(result.total, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].session_id, "sess_1");
        assert_eq!(result.items[0].cwd, "E:\\work");
    }
}
