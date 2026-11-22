use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use super::{
    build_commands, extract_snippet, timestamp_millis_string, tool_text_from_str,
    tool_text_from_value, ContentMatch, SessionDetail, SessionKey, SessionListItem,
    SessionListResult, TimelineBlock, ToolCallBlock,
};

/// Devin CLI and Devin Desktop share one SQLite store (`sessions.db`). Each
/// session is a forest of `message_nodes`; `sessions.main_chain_id` is the tip
/// of the active conversation, which we walk back through `parent_node_id`.
pub struct DevinPlatform {
    home: PathBuf,
}

const CHAIN_SQL: &str = "WITH RECURSIVE chain(nid, depth) AS (
       SELECT main_chain_id, 0 FROM sessions WHERE id = ?1 AND main_chain_id IS NOT NULL
       UNION ALL
       SELECT m.parent_node_id, c.depth + 1 FROM message_nodes m
         JOIN chain c ON m.session_id = ?1 AND m.node_id = c.nid
        WHERE m.parent_node_id IS NOT NULL
     )
     SELECT m.node_id, m.chat_message FROM chain c
       JOIN message_nodes m ON m.session_id = ?1 AND m.node_id = c.nid
      ORDER BY c.depth DESC";

const FIRST_INPUT_SQL: &str = "SELECT json_extract(chat_message, '$.content') FROM message_nodes
      WHERE session_id = ?1
        AND json_extract(chat_message, '$.role') = 'user'
        AND json_extract(chat_message, '$.metadata.is_user_input') = 1
      ORDER BY node_id LIMIT 1";

struct SessionRow {
    id: String,
    cwd: String,
    title: String,
    last_activity_at: i64,
}

pub fn default_devin_home() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("devin").join("cli"))
}

impl DevinPlatform {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn db_path(&self) -> PathBuf {
        self.home.join("sessions.db")
    }

    fn connect(&self, write: bool) -> Result<Connection, String> {
        let flags = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let conn = Connection::open_with_flags(self.db_path(), flags)
            .map_err(|error| format!("Failed to open Devin sessions db: {error}"))?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
        Ok(conn)
    }

    fn session_rows(&self, conn: &Connection, id: Option<&str>) -> Vec<SessionRow> {
        let sql = "SELECT id, working_directory, COALESCE(title, ''), last_activity_at FROM sessions \
                   WHERE hidden = 0 AND (?1 IS NULL OR id = ?1) ORDER BY last_activity_at DESC";
        let Ok(mut stmt) = conn.prepare(sql) else {
            return Vec::new();
        };
        stmt.query_map(params![id], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                cwd: row.get(1)?,
                title: row.get(2)?,
                last_activity_at: row.get(3)?,
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    fn list_item(
        &self,
        conn: &Connection,
        row: SessionRow,
        alias_map: &HashMap<String, String>,
    ) -> SessionListItem {
        let preview: String = conn
            .query_row(FIRST_INPUT_SQL, params![row.id], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .map(|text| text.chars().take(200).collect())
            .unwrap_or_default();
        let alias = alias_map.get(&row.id).cloned().unwrap_or_default();
        let title = if row.title.trim().is_empty() {
            preview.chars().take(60).collect()
        } else {
            row.title
        };
        SessionListItem {
            platform: "devin".into(),
            session_key: row.id.clone(),
            display_title: if alias.is_empty() { title } else { alias.clone() },
            alias_title: alias,
            preview,
            updated_at: timestamp_millis_string(&row.last_activity_at.to_string())
                .unwrap_or_default(),
            cwd: row.cwd,
            editable: true,
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
            source_label: String::new(),
            agent_group: None,
            session_id: row.id,
        }
    }

    /// Active conversation of a session, root first, as `(node_id, chat_message)`.
    fn main_chain(&self, session_id: &str) -> Result<Vec<(i64, Value)>, String> {
        let conn = self.connect(false)?;
        let mut stmt = conn
            .prepare(CHAIN_SQL)
            .map_err(|error| format!("Failed to query Devin messages: {error}"))?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Failed to query Devin messages: {error}"))?;
        Ok(rows
            .flatten()
            .filter_map(|(node_id, raw)| {
                serde_json::from_str::<Value>(&raw)
                    .ok()
                    .map(|message| (node_id, message))
            })
            .collect())
    }
}

fn role_of(message: &Value) -> &str {
    message.get("role").and_then(Value::as_str).unwrap_or_default()
}

fn content_of(message: &Value) -> &str {
    message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Only messages typed by the user count; Devin also stores injected user
/// turns (e.g. compaction prompts) with `is_user_input` unset.
fn is_user_input(message: &Value) -> bool {
    message
        .pointer("/metadata/is_user_input")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn thinking_of(message: &Value) -> Option<&str> {
    let thinking = message.get("thinking")?;
    thinking
        .get("thinking")
        .and_then(Value::as_str)
        .or_else(|| thinking.as_str())
        .filter(|text| !text.trim().is_empty())
}

fn message_blocks(chain: &[(i64, Value)], session_id: &str) -> Vec<TimelineBlock> {
    let outputs: HashMap<&str, &str> = chain
        .iter()
        .filter(|(_, message)| role_of(message) == "tool")
        .filter_map(|(_, message)| {
            Some((
                message.get("tool_call_id").and_then(Value::as_str)?,
                content_of(message),
            ))
        })
        .collect();

    let mut blocks: Vec<TimelineBlock> = Vec::new();
    for (node_id, message) in chain {
        let meta = json!({ "nodeId": node_id });
        match role_of(message) {
            "user" if is_user_input(message) => blocks.push(TimelineBlock {
                id: format!("{node_id}:user"),
                role: "user".into(),
                content: content_of(message).to_string(),
                editable: true,
                edit_target: format!("{session_id}::{node_id}::content"),
                source_meta: meta,
                tool_calls: Vec::new(),
            }),
            "assistant" => {
                if let Some(thinking) = thinking_of(message) {
                    // Thinking carries a sealed signature, so it stays read-only.
                    blocks.push(TimelineBlock {
                        id: format!("{node_id}:thinking"),
                        role: "thinking".into(),
                        content: thinking.to_string(),
                        editable: false,
                        edit_target: String::new(),
                        source_meta: meta.clone(),
                        tool_calls: Vec::new(),
                    });
                }
                let tool_calls: Vec<ToolCallBlock> = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|call| {
                        let id = call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let output = outputs
                            .get(id.as_str())
                            .and_then(|text| tool_text_from_str(text, 32768));
                        ToolCallBlock {
                            name: call
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            kind: "tool_use".into(),
                            status: if output.is_some() { "completed" } else { "requested" }
                                .to_string(),
                            input: call
                                .get("arguments")
                                .and_then(|args| tool_text_from_value(args, 8192)),
                            output,
                            error: None,
                            started_at: None,
                            ended_at: None,
                            source_meta: json!({ "nodeId": node_id, "itemType": "tool_use" }),
                            id,
                        }
                    })
                    .collect();
                let content = content_of(message);
                if content.trim().is_empty() && tool_calls.is_empty() {
                    continue;
                }
                blocks.push(TimelineBlock {
                    id: format!("{node_id}:assistant"),
                    role: "assistant".into(),
                    content: content.to_string(),
                    editable: !content.trim().is_empty(),
                    edit_target: format!("{session_id}::{node_id}::content"),
                    source_meta: meta,
                    tool_calls,
                });
            }
            _ => {}
        }
    }
    blocks
}

fn chain_texts(chain: &[(i64, Value)]) -> Vec<(String, String)> {
    let mut texts = Vec::new();
    for (_, message) in chain {
        match role_of(message) {
            "user" if is_user_input(message) => {
                texts.push(("user".to_string(), content_of(message).to_string()))
            }
            "assistant" => {
                if let Some(thinking) = thinking_of(message) {
                    texts.push(("thinking".to_string(), thinking.to_string()));
                }
                if !content_of(message).is_empty() {
                    texts.push(("assistant".to_string(), content_of(message).to_string()));
                }
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(name) = call.get("name").and_then(Value::as_str) {
                        texts.push(("tool".to_string(), name.to_string()));
                    }
                    if let Some(args) = call.get("arguments") {
                        texts.push(("tool".to_string(), args.to_string()));
                    }
                }
            }
            "tool" => texts.push(("tool".to_string(), content_of(message).to_string())),
            _ => {}
        }
    }
    texts
}

impl super::PlatformAdapter for DevinPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let Ok(conn) = self.connect(false) else {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        };
        let rows = self.session_rows(&conn, None);
        let total = rows.len();
        let items = rows
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .map(|row| self.list_item(&conn, row, alias_map))
            .collect();
        SessionListResult { total, items }
    }

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        let conn = self.connect(false).ok()?;
        Some(
            self.session_rows(&conn, None)
                .into_iter()
                .map(|row| {
                    let millis = timestamp_millis_string(&row.last_activity_at.to_string())
                        .and_then(|value| value.parse().ok())
                        .unwrap_or_default();
                    SessionKey::standalone(row.id, millis)
                })
                .collect(),
        )
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        _cache: Option<&crate::database::SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        let conn = self.connect(false).ok()?;
        let row = self.session_rows(&conn, Some(session_key)).into_iter().next()?;
        Some(self.list_item(&conn, row, alias_map))
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let conn = self.connect(false)?;
        let row = self
            .session_rows(&conn, Some(session_key))
            .into_iter()
            .next()
            .ok_or_else(|| format!("Devin session not found: {session_key}"))?;
        let chain = self.main_chain(session_key)?;
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if !alias.is_empty() {
            alias.clone()
        } else if !row.title.trim().is_empty() {
            row.title
        } else {
            session_key.to_string()
        };
        Ok(SessionDetail {
            platform: "devin".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd: row.cwd,
            commands: build_commands("devin", session_key),
            blocks: message_blocks(&chain, session_key),
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        let [session_id, node_id, "content"] = parts.as_slice() else {
            return Err(format!("Invalid Devin edit target: {edit_target}"));
        };
        let node_id: i64 = node_id
            .parse()
            .map_err(|error| format!("Invalid node id: {error}"))?;
        let conn = self.connect(true)?;
        let raw: String = conn
            .query_row(
                "SELECT chat_message FROM message_nodes WHERE session_id = ?1 AND node_id = ?2",
                params![session_id, node_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Failed to read Devin message: {error}"))?
            .ok_or_else(|| format!("Devin message not found: {edit_target}"))?;
        let message: Value =
            serde_json::from_str(&raw).map_err(|error| format!("Parse error: {error}"))?;
        if !matches!(role_of(&message), "user" | "assistant") {
            return Err(format!("Unsupported Devin edit target: {edit_target}"));
        }
        let old = content_of(&message).to_string();
        // json_set keeps the original key order and fires the FTS update trigger.
        conn.execute(
            "UPDATE message_nodes SET chat_message = json_set(chat_message, '$.content', ?3) \
             WHERE session_id = ?1 AND node_id = ?2",
            params![session_id, node_id, new_content],
        )
        .map_err(|error| format!("Failed to write Devin message: {error}"))?;
        Ok(old)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return true;
        }
        if let Ok(conn) = self.connect(false) {
            if let Some(row) = self.session_rows(&conn, Some(session_key)).into_iter().next() {
                if row.title.to_lowercase().contains(&needle)
                    || row.cwd.to_lowercase().contains(&needle)
                {
                    return true;
                }
            }
        }
        self.main_chain(session_key)
            .map(|chain| {
                chain_texts(&chain)
                    .iter()
                    .any(|(_, text)| text.to_lowercase().contains(&needle))
            })
            .unwrap_or(false)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return vec![];
        }
        let Ok(chain) = self.main_chain(session_key) else {
            return vec![];
        };
        chain_texts(&chain)
            .into_iter()
            .enumerate()
            .filter(|(_, (_, text))| text.to_lowercase().contains(&needle))
            .map(|(index, (role, text))| ContentMatch {
                snippet: extract_snippet(&text, &needle),
                match_index: index,
                role,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use std::fs;
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("devin-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&home).expect("create devin home");

        let conn = Connection::open(home.join("sessions.db")).expect("open test db");
        conn.execute_batch(
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
               model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
               last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
               hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
             CREATE TABLE message_nodes (
               row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
               node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
               created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));
             CREATE VIRTUAL TABLE message_search USING fts5(
               content, content = '', contentless_delete = 1, tokenize = 'unicode61');
             CREATE TRIGGER message_search_after_update
             AFTER UPDATE OF chat_message ON message_nodes
             BEGIN
               DELETE FROM message_search WHERE rowid = old.row_id;
               INSERT INTO message_search (rowid, content)
               SELECT new.row_id, json_extract(new.chat_message, '$.content');
             END;
             INSERT INTO sessions VALUES
               ('brisk-otter', 'F:\\work', 'windsurf', 'swe', '', 1795263104, 1795266095, '确认是否在线', 5, 0, NULL),
               ('ghost', 'F:\\work', 'windsurf', 'swe', '', 1, 1, 'hidden one', NULL, 1, NULL);",
        )
        .unwrap();

        let nodes = [
            (0, None, json!({"role": "system", "content": "You are Devin"})),
            (1, Some(0), json!({"role": "user", "content": "在吗", "metadata": {"is_user_input": true}})),
            (2, Some(1), json!({
                "role": "assistant", "content": "在的。",
                "thinking": {"thinking": "打招呼", "signature": "sealed.v1.x"},
                "tool_calls": [{"id": "call-1", "name": "exec", "arguments": {"command": "ls"}}]
            })),
            (3, Some(2), json!({"role": "tool", "content": "README.md", "tool_call_id": "call-1"})),
            (4, Some(3), json!({"role": "user", "content": "summarize", "metadata": {"is_user_input": null}})),
            (5, Some(4), json!({"role": "user", "content": "继续", "metadata": {"is_user_input": true}})),
            (6, Some(1), json!({"role": "assistant", "content": "abandoned branch"})),
        ];
        for (node_id, parent, message) in nodes {
            conn.execute(
                "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
                 VALUES ('brisk-otter', ?1, ?2, ?3, 1795263104)",
                params![node_id, parent, message.to_string()],
            )
            .unwrap();
        }
        home
    }

    #[test]
    fn lists_and_parses_main_chain() {
        let home = test_home("list");
        let platform = DevinPlatform::new(home.clone());
        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        let item = &listed.items[0];
        assert_eq!(item.session_key, "brisk-otter");
        assert_eq!(item.display_title, "确认是否在线");
        assert_eq!(item.preview, "在吗");
        assert_eq!(item.updated_at, "1795266095000");

        let detail = platform
            .get_session_detail("brisk-otter", &HashMap::new())
            .expect("detail");
        let roles: Vec<&str> = detail.blocks.iter().map(|b| b.role.as_str()).collect();
        assert_eq!(roles, vec!["user", "thinking", "assistant", "user"]);
        assert!(!detail.blocks[1].editable);
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(detail.blocks[2].tool_calls[0].output.as_deref(), Some("README.md"));
        assert_eq!(detail.blocks[3].content, "继续");
        assert_eq!(detail.commands.get("resume").unwrap(), "devin -r brisk-otter");
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn edits_message_in_place() {
        let home = test_home("edit");
        let platform = DevinPlatform::new(home.clone());
        let detail = platform
            .get_session_detail("brisk-otter", &HashMap::new())
            .expect("detail");
        let old = platform
            .update_message(&detail.blocks[2].edit_target, "改过的回复")
            .expect("update");
        assert_eq!(old, "在的。");

        let chain = platform.main_chain("brisk-otter").expect("chain");
        let (_, message) = chain.iter().find(|(id, _)| *id == 2).unwrap();
        assert_eq!(message["content"], "改过的回复");
        assert_eq!(message["tool_calls"][0]["id"], "call-1");
        assert!(platform.update_message("brisk-otter::0::content", "x").is_err());
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn searches_chain_content() {
        let home = test_home("search");
        let platform = DevinPlatform::new(home.clone());
        assert!(platform.matches_query("brisk-otter", "确认"));
        assert!(platform.matches_query("brisk-otter", "readme"));
        assert!(!platform.matches_query("brisk-otter", "abandoned"));
        assert!(!platform.content_search("brisk-otter", "继续").is_empty());
        fs::remove_dir_all(&home).ok();
    }
}
