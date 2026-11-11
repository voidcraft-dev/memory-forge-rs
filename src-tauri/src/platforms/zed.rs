use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use super::{
    build_commands, extract_snippet, tool_text_from_str, tool_text_from_value, ContentMatch,
    SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock, ToolCallBlock,
};

/// Zed stores Agent panel threads in a plain SQLite database. Each row's
/// `data` column is a zstd-compressed JSON document with the full thread
/// (`messages`, `title`, `model`, ...).
pub struct ZedPlatform {
    home: PathBuf,
}

impl ZedPlatform {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn db_path(&self) -> PathBuf {
        self.home.join("threads").join("threads.db")
    }

    fn connect(&self, write: bool) -> Result<Connection, String> {
        let flags = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let conn = Connection::open_with_flags(self.db_path(), flags)
            .map_err(|error| format!("Failed to open Zed threads db: {error}"))?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
        Ok(conn)
    }

    fn read_thread(&self, thread_id: &str) -> Result<Value, String> {
        let conn = self.connect(false)?;
        let (data_type, data): (String, Vec<u8>) = conn
            .query_row(
                "SELECT data_type, data FROM threads WHERE id = ?1",
                params![thread_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("Failed to read Zed thread: {error}"))?
            .ok_or_else(|| format!("Zed thread not found: {thread_id}"))?;
        decode_thread(&data_type, &data)
    }

    fn update_thread(
        &self,
        thread_id: &str,
        mutate: impl FnOnce(&mut Value) -> Result<String, String>,
    ) -> Result<String, String> {
        let mut thread = self.read_thread(thread_id)?;
        let old = mutate(&mut thread)?;
        let encoded = zstd::stream::encode_all(
            serde_json::to_vec(&thread)
                .map_err(|error| format!("Serialize error: {error}"))?
                .as_slice(),
            3,
        )
        .map_err(|error| format!("Compress error: {error}"))?;
        let conn = self.connect(true)?;
        conn.execute(
            "UPDATE threads SET data_type = 'zstd', data = ?2 WHERE id = ?1",
            params![thread_id, encoded],
        )
        .map_err(|error| format!("Failed to write Zed thread: {error}"))?;
        Ok(old)
    }
}

fn decode_thread(data_type: &str, data: &[u8]) -> Result<Value, String> {
    let raw = if data_type == "zstd" {
        zstd::stream::decode_all(data).map_err(|error| format!("Decompress error: {error}"))?
    } else {
        data.to_vec()
    };
    serde_json::from_slice(&raw).map_err(|error| format!("Parse error: {error}"))
}

fn iso_to_millis(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .unwrap_or(0)
}

/// Zed tool results carry a `content` array of typed fragments. Flatten the
/// text fragments instead of dumping the raw JSON array.
fn tool_result_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(items) = content.as_array() {
        let texts: Vec<&str> = items
            .iter()
            .filter_map(|item| item.get("Text").and_then(Value::as_str))
            .collect();
        if !texts.is_empty() {
            return tool_text_from_str(&texts.join("\n"), 32768);
        }
    }
    tool_text_from_value(content, 32768)
}

fn message_blocks(thread: &Value, thread_id: &str) -> Vec<TimelineBlock> {
    let mut blocks: Vec<TimelineBlock> = Vec::new();
    let mut pending_tools: Vec<ToolCallBlock> = Vec::new();
    let Some(messages) = thread.get("messages").and_then(Value::as_array) else {
        return blocks;
    };

    for (message_index, message) in messages.iter().enumerate() {
        let Some((role, body)) = message.as_object().and_then(|map| map.iter().next()) else {
            continue;
        };
        if role == "User" {
            let Some(items) = body.get("content").and_then(Value::as_array) else {
                continue;
            };
            for (content_index, item) in items.iter().enumerate() {
                if let Some(text) = item.get("Text").and_then(Value::as_str) {
                    if text.trim().is_empty() {
                        continue;
                    }
                    let block = TimelineBlock {
                        id: format!("{message_index}:{content_index}:user"),
                        role: "user".into(),
                        content: text.to_string(),
                        editable: true,
                        edit_target: format!("{thread_id}::{message_index}::{content_index}::text"),
                        source_meta: json!({
                            "messageIndex": message_index,
                            "contentIndex": content_index,
                        }),
                        tool_calls: Vec::new(),
                    };
                    blocks.push(block);
                } else if item.get("Image").is_some() {
                    blocks.push(TimelineBlock {
                        id: format!("{message_index}:{content_index}:image"),
                        role: "user".into(),
                        content: "[图片]".into(),
                        editable: false,
                        edit_target: String::new(),
                        source_meta: json!({
                            "messageIndex": message_index,
                            "contentIndex": content_index,
                            "itemType": "image",
                        }),
                        tool_calls: Vec::new(),
                    });
                }
            }
            continue;
        }
        if role != "Agent" {
            continue;
        }

        let tool_results = body.get("tool_results").and_then(Value::as_object);
        let Some(items) = body.get("content").and_then(Value::as_array) else {
            continue;
        };
        for (content_index, item) in items.iter().enumerate() {
            if let Some(text) = item.get("Text").and_then(Value::as_str) {
                if text.trim().is_empty() {
                    continue;
                }
                let mut block = TimelineBlock {
                    id: format!("{message_index}:{content_index}:assistant"),
                    role: "assistant".into(),
                    content: text.to_string(),
                    editable: true,
                    edit_target: format!("{thread_id}::{message_index}::{content_index}::text"),
                    source_meta: json!({
                        "messageIndex": message_index,
                        "contentIndex": content_index,
                    }),
                    tool_calls: Vec::new(),
                };
                block.tool_calls.append(&mut pending_tools);
                blocks.push(block);
            } else if let Some(thinking) = item.get("Thinking") {
                let text = thinking
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                blocks.push(TimelineBlock {
                    id: format!("{message_index}:{content_index}:thinking"),
                    role: "thinking".into(),
                    content: text.to_string(),
                    editable: true,
                    edit_target: format!("{thread_id}::{message_index}::{content_index}::thinking"),
                    source_meta: json!({
                        "messageIndex": message_index,
                        "contentIndex": content_index,
                    }),
                    tool_calls: Vec::new(),
                });
            } else if let Some(tool) = item.get("ToolUse") {
                let call_id = tool
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let result = tool_results.and_then(|results| results.get(&call_id));
                let output = result.and_then(|result| tool_result_text(result.get("content")));
                let is_error = result
                    .and_then(|result| result.get("is_error"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let tool_block = ToolCallBlock {
                    id: call_id.clone(),
                    name: tool
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    kind: "tool_use".into(),
                    status: if result.is_some() {
                        if is_error { "error" } else { "completed" }.to_string()
                    } else {
                        "requested".to_string()
                    },
                    input: tool
                        .get("raw_input")
                        .and_then(Value::as_str)
                        .and_then(|raw| tool_text_from_str(raw, 8192))
                        .or_else(|| {
                            tool.get("input")
                                .and_then(|input| tool_text_from_value(input, 8192))
                        }),
                    output,
                    error: None,
                    started_at: None,
                    ended_at: None,
                    source_meta: json!({
                        "messageIndex": message_index,
                        "contentIndex": content_index,
                        "itemType": "tool_use",
                    }),
                };
                match blocks.last_mut() {
                    Some(last) if last.role == "assistant" => last.tool_calls.push(tool_block),
                    _ => pending_tools.push(tool_block),
                }
            }
        }
        if !pending_tools.is_empty() {
            if let Some(last) = blocks.last_mut() {
                if last.role == "assistant" {
                    last.tool_calls.append(&mut pending_tools);
                }
            }
        }
    }

    if !pending_tools.is_empty() {
        blocks.push(TimelineBlock {
            id: "tools".into(),
            role: "assistant".into(),
            content: String::new(),
            editable: false,
            edit_target: String::new(),
            source_meta: json!({"itemType": "tool_calls"}),
            tool_calls: pending_tools,
        });
    }

    blocks
}

fn thread_texts(thread: &Value) -> Vec<(String, String)> {
    let mut texts = Vec::new();
    let Some(messages) = thread.get("messages").and_then(Value::as_array) else {
        return texts;
    };
    for message in messages {
        let Some((role, body)) = message.as_object().and_then(|map| map.iter().next()) else {
            continue;
        };
        if let Some(items) = body.get("content").and_then(Value::as_array) {
            for item in items {
                if let Some(text) = item.get("Text").and_then(Value::as_str) {
                    texts.push((role.to_lowercase(), text.to_string()));
                } else if let Some(thinking) = item.get("Thinking") {
                    if let Some(text) = thinking.get("text").and_then(Value::as_str) {
                        texts.push(("thinking".to_string(), text.to_string()));
                    }
                } else if let Some(tool) = item.get("ToolUse") {
                    if let Some(name) = tool.get("name").and_then(Value::as_str) {
                        texts.push(("tool".to_string(), name.to_string()));
                    }
                    if let Some(input) = tool.get("raw_input").and_then(Value::as_str) {
                        texts.push(("tool".to_string(), input.to_string()));
                    }
                }
            }
        }
        if let Some(results) = body.get("tool_results").and_then(Value::as_object) {
            for result in results.values() {
                if let Some(text) = tool_result_text(result.get("content")) {
                    texts.push(("tool".to_string(), text));
                }
            }
        }
    }
    texts
}

impl super::PlatformAdapter for ZedPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let conn = match self.connect(false) {
            Ok(conn) => conn,
            Err(_) => {
                return SessionListResult {
                    total: 0,
                    items: Vec::new(),
                }
            }
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, summary, updated_at, folder_paths FROM threads \
             ORDER BY updated_at DESC",
        ) else {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        }) else {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        };

        let items: Vec<SessionListItem> = rows
            .flatten()
            .map(|(id, summary, updated_at, folders)| {
                let alias = alias_map.get(&id).cloned().unwrap_or_default();
                let display_title = if alias.is_empty() {
                    summary.clone()
                } else {
                    alias.clone()
                };
                SessionListItem {
                    platform: "zed".into(),
                    session_key: id.clone(),
                    session_id: id,
                    display_title,
                    alias_title: alias,
                    preview: summary,
                    updated_at: iso_to_millis(&updated_at).to_string(),
                    cwd: folders.unwrap_or_default(),
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                    source_label: String::new(),
                    agent_group: None,
                }
            })
            .collect();

        let total = items.len();
        let items = items
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .collect();
        SessionListResult { total, items }
    }

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        let conn = self.connect(false).ok()?;
        let mut stmt = conn.prepare("SELECT id, updated_at FROM threads").ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok()?;
        Some(
            rows.flatten()
                .map(|(id, updated_at)| {
                    SessionKey::standalone(id, iso_to_millis(&updated_at) as i128)
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
        let row: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT summary, updated_at, folder_paths FROM threads WHERE id = ?1",
                params![session_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .ok()?;
        let (summary, updated_at, folders) = row?;
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let display_title = if alias.is_empty() {
            summary.clone()
        } else {
            alias.clone()
        };
        Some(SessionListItem {
            platform: "zed".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            display_title,
            alias_title: alias,
            preview: summary,
            updated_at: iso_to_millis(&updated_at).to_string(),
            cwd: folders.unwrap_or_default(),
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
        let thread = self.read_thread(session_key)?;
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = thread
            .get("title")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| session_key.to_string());
        let title = if alias.is_empty() {
            title
        } else {
            alias.clone()
        };
        let cwd = thread
            .get("initial_project_snapshot")
            .and_then(|snapshot| snapshot.get("worktree_snapshots"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("worktree_path"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        Ok(SessionDetail {
            platform: "zed".into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd,
            commands: build_commands("zed", session_key),
            blocks: message_blocks(&thread, session_key),
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let parts: Vec<&str> = edit_target.split("::").collect();
        if parts.len() != 4 {
            return Err(format!("Invalid Zed edit target: {edit_target}"));
        }
        let thread_id = parts[0];
        let message_index: usize = parts[1]
            .parse()
            .map_err(|error| format!("Invalid message index: {error}"))?;
        let content_index: usize = parts[2]
            .parse()
            .map_err(|error| format!("Invalid content index: {error}"))?;
        let field = parts[3];

        self.update_thread(thread_id, |thread| {
            let message = thread
                .get_mut("messages")
                .and_then(Value::as_array_mut)
                .and_then(|messages| messages.get_mut(message_index))
                .ok_or_else(|| "Message index out of range".to_string())?;
            let Some((role, body)) = message
                .as_object_mut()
                .and_then(|map| map.iter_mut().next())
            else {
                return Err("Invalid Zed message".to_string());
            };
            let item = body
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .and_then(|items| items.get_mut(content_index))
                .ok_or_else(|| "Content index out of range".to_string())?;

            match (role.as_str(), field) {
                ("User", "text") => {
                    let old = item
                        .get("Text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    item["Text"] = Value::String(new_content.to_string());
                    Ok(old)
                }
                ("Agent", "text") => {
                    let old = item
                        .get("Text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    item["Text"] = Value::String(new_content.to_string());
                    Ok(old)
                }
                ("Agent", "thinking") => {
                    let old = item
                        .get("Thinking")
                        .and_then(|thinking| thinking.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    item["Thinking"]["text"] = Value::String(new_content.to_string());
                    Ok(old)
                }
                _ => Err(format!("Unsupported Zed edit target: {edit_target}")),
            }
        })
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return true;
        }
        let conn = match self.connect(false) {
            Ok(conn) => conn,
            Err(_) => return false,
        };
        if let Ok(Some((summary, folders))) = conn
            .query_row(
                "SELECT summary, folder_paths FROM threads WHERE id = ?1",
                params![session_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                },
            )
            .optional()
        {
            if summary.to_lowercase().contains(&needle) || folders.to_lowercase().contains(&needle)
            {
                return true;
            }
        }
        self.read_thread(session_key)
            .map(|thread| {
                thread_texts(&thread)
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
        let Ok(thread) = self.read_thread(session_key) else {
            return vec![];
        };
        thread_texts(&thread)
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
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("zed-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(home.join("threads")).expect("create threads dir");

        let thread = json!({
            "title": "项目结构了解需求",
            "model": {"provider": "zed.dev", "model": "claude-opus-5"},
            "updated_at": "2026-11-09T00:57:33.655381600Z",
            "initial_project_snapshot": {
                "worktree_snapshots": [{"worktree_path": "E:\\work"}]
            },
            "messages": [
                {"User": {"id": "u1", "content": [{"Text": "你好"}]}},
                {"Agent": {
                    "content": [
                        {"Thinking": {"text": "打招呼", "signature": null}},
                        {"Text": "嗨。"},
                        {"ToolUse": {
                            "id": "call-1",
                            "name": "read",
                            "raw_input": "{\"path\":\"a.md\"}",
                            "input": {"type": "json", "value": {"path": "a.md"}},
                            "is_input_complete": true,
                            "thought_signature": null
                        }}
                    ],
                    "tool_results": {
                        "call-1": {
                            "tool_use_id": "call-1",
                            "tool_name": "read",
                            "is_error": false,
                            "content": [{"Text": "file body"}],
                            "output": null
                        }
                    },
                    "reasoning_details": null
                }},
                {"User": {"id": "u2", "content": [{"Text": "继续"}]}}
            ]
        });
        let encoded =
            zstd::stream::encode_all(serde_json::to_vec(&thread).unwrap().as_slice(), 3).unwrap();

        let conn = Connection::open(home.join("threads/threads.db")).expect("open test db");
        conn.execute_batch(
            "CREATE TABLE threads (
               id TEXT PRIMARY KEY,
               summary TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               data_type TEXT NOT NULL,
               data BLOB NOT NULL,
               parent_id TEXT,
               worktree_branch TEXT,
               folder_paths TEXT,
               folder_paths_order TEXT,
               created_at TEXT
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, summary, updated_at, data_type, data, folder_paths, created_at)
             VALUES ('thread-1', '项目结构了解需求', '2026-11-09T00:57:33.655381600+00:00', 'zstd', ?1, 'E:\\work', '2026-10-29T00:39:07Z')",
            params![encoded],
        )
        .unwrap();
        home
    }

    fn cleanup(home: &PathBuf) {
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn lists_and_parses_zed_threads() {
        let home = test_home("list");
        let platform = ZedPlatform::new(home.clone());
        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(listed.items[0].session_key, "thread-1");
        assert_eq!(listed.items[0].display_title, "项目结构了解需求");
        assert_eq!(listed.items[0].cwd, "E:\\work");

        let detail = platform
            .get_session_detail("thread-1", &HashMap::new())
            .expect("detail");
        assert_eq!(detail.title, "项目结构了解需求");
        assert_eq!(detail.blocks.len(), 4);
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(
            detail.blocks[2].tool_calls[0].output.as_deref(),
            Some("file body")
        );
        assert_eq!(detail.blocks[3].role, "user");

        cleanup(&home);
    }

    #[test]
    fn edits_user_message_and_keeps_zstd() {
        let home = test_home("edit");
        let platform = ZedPlatform::new(home.clone());
        let detail = platform
            .get_session_detail("thread-1", &HashMap::new())
            .expect("detail");
        let target = detail.blocks[0].edit_target.clone();

        let old = platform.update_message(&target, "早上好").expect("update");
        assert_eq!(old, "你好");

        let thread = platform.read_thread("thread-1").expect("reread");
        assert_eq!(
            thread["messages"][0]["User"]["content"][0]["Text"],
            "早上好"
        );

        cleanup(&home);
    }

    #[test]
    fn searches_threads() {
        let home = test_home("search");
        let platform = ZedPlatform::new(home.clone());

        assert!(platform.matches_query("thread-1", "项目结构"));
        assert!(platform.matches_query("thread-1", "file body"));
        assert!(!platform.matches_query("thread-1", "不存在的词"));

        let matches = platform.content_search("thread-1", "file body");
        assert!(!matches.is_empty());

        cleanup(&home);
    }
}
