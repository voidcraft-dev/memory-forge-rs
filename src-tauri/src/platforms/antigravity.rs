use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use super::{
    extract_snippet, file_mtime_millis_string, tool_text_from_str, tool_text_from_value, ContentMatch,
    PlatformAdapter, SessionDetail, SessionListItem, SessionListResult, TimelineBlock,
    ToolCallBlock,
};

/// Antigravity keeps an index of conversations in
/// `<home>/conversation_summaries.db` and the readable transcript of each
/// conversation in `<home>/brain/<id>/.system_generated/logs/transcript*.jsonl`.
///
/// The per-conversation SQLite databases (`<home>/conversations/<id>.db`) store
/// every step as protobuf blobs, so this adapter is intentionally read-only.
pub struct AntigravityPlatform {
    home: PathBuf,
}

struct SummaryRow {
    conversation_id: String,
    title: String,
    preview: String,
    updated_at: String,
    cwd: String,
}

impl AntigravityPlatform {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn db_path(&self) -> PathBuf {
        self.home.join("conversation_summaries.db")
    }

    fn transcript_path(&self, conversation_id: &str) -> Option<PathBuf> {
        self.transcript_origin(conversation_id)
            .map(|(path, _)| path)
    }

    /// Returns the transcript path and whether it lives in the sibling
    /// `antigravity-cli` store. Both apps share one conversation index, but a
    /// conversation started from the CLI keeps its transcript there.
    fn transcript_origin(&self, conversation_id: &str) -> Option<(PathBuf, bool)> {
        if let Some(path) = transcript_in(&self.home, conversation_id) {
            return Some((path, false));
        }
        let cli_home = self.home.parent()?.join("antigravity-cli");
        transcript_in(&cli_home, conversation_id).map(|path| (path, true))
    }

    fn connect(&self) -> Result<Connection, String> {
        let conn = Connection::open_with_flags(
            self.db_path(),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| format!("Failed to open Antigravity summaries db: {error}"))?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
        Ok(conn)
    }

    fn load_summaries(&self) -> Vec<SummaryRow> {
        let Ok(conn) = self.connect() else {
            return Vec::new();
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT conversation_id, title, preview, last_modified_time, workspace_uris
             FROM conversation_summaries
             WHERE COALESCE(parent_conversation_id, '') = ''
               AND COALESCE(nesting_depth, 0) = 0",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = statement.query_map([], |row| {
            let conversation_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let preview: String = row.get(2)?;
            let updated_at: String = row.get(3)?;
            let workspace: String = row.get(4)?;
            Ok(SummaryRow {
                conversation_id,
                title,
                preview,
                updated_at: normalize_time(&updated_at),
                cwd: workspace_cwd(&workspace),
            })
        }) else {
            return Vec::new();
        };
        rows.flatten().collect()
    }

    fn first_user_text(&self, conversation_id: &str) -> String {
        let Some(path) = self.transcript_path(conversation_id) else {
            return String::new();
        };
        let Ok(file) = fs::File::open(path) else {
            return String::new();
        };
        for line in BufReader::new(file).lines().take(8).map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(text) = user_text(&value) {
                return text;
            }
        }
        String::new()
    }

    fn item(&self, row: &SummaryRow, alias_map: &HashMap<String, String>) -> Option<SessionListItem> {
        let (transcript, from_cli) = self.transcript_origin(&row.conversation_id)?;
        let updated_at = if row.updated_at.is_empty() {
            file_mtime_millis_string(&transcript).unwrap_or_default()
        } else {
            row.updated_at.clone()
        };
        let first_user = || self.first_user_text(&row.conversation_id);
        let title = if !row.title.trim().is_empty() {
            row.title.trim().to_string()
        } else if is_useful_preview(&row.preview) {
            row.preview.trim().to_string()
        } else {
            let text = first_user();
            if text.is_empty() {
                row.conversation_id.clone()
            } else {
                text.chars().take(60).collect()
            }
        };
        let preview = if is_useful_preview(&row.preview) {
            row.preview.trim().chars().take(200).collect()
        } else {
            let text = first_user();
            text.chars().take(200).collect()
        };
        let alias_title = alias_map
            .get(&row.conversation_id)
            .cloned()
            .unwrap_or_default();
        let display_title = if alias_title.is_empty() {
            title
        } else {
            alias_title.clone()
        };

        Some(SessionListItem {
            platform: "antigravity".to_string(),
            session_key: row.conversation_id.clone(),
            session_id: row.conversation_id.clone(),
            display_title,
            alias_title,
            preview,
            updated_at,
            cwd: row.cwd.clone(),
            editable: false,
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
            source_label: if from_cli { "CLI".to_string() } else { String::new() },
            agent_group: None,
        })
    }

    fn read_transcript(&self, conversation_id: &str) -> Result<Vec<Value>, String> {
        let path = self
            .transcript_path(conversation_id)
            .ok_or_else(|| format!("Antigravity transcript not found: {conversation_id}"))?;
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read Antigravity transcript: {error}"))?;
        Ok(raw
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                (!line.is_empty())
                    .then(|| serde_json::from_str::<Value>(line).ok())
                    .flatten()
            })
            .collect())
    }

    fn blocks(&self, steps: &[Value]) -> Vec<TimelineBlock> {
        let mut blocks: Vec<TimelineBlock> = Vec::new();

        for (position, step) in steps.iter().enumerate() {
            let source = step.get("source").and_then(Value::as_str).unwrap_or_default();
            let step_type = step.get("type").and_then(Value::as_str).unwrap_or_default();
            let step_index = step
                .get("step_index")
                .and_then(Value::as_u64)
                .unwrap_or(position as u64);
            let created_at = step.get("created_at").and_then(Value::as_str);

            match (source, step_type) {
                ("USER_EXPLICIT", "USER_INPUT") => {
                    let text = user_text(step).unwrap_or_default();
                    if text.trim().is_empty() {
                        continue;
                    }
                    blocks.push(TimelineBlock {
                        id: format!("{step_index}:user"),
                        role: "user".to_string(),
                        content: text,
                        editable: false,
                        edit_target: String::new(),
                        source_meta: json!({
                            "stepIndex": step_index,
                            "createdAt": created_at,
                        }),
                        tool_calls: Vec::new(),
                    });
                }
                ("MODEL", "PLANNER_RESPONSE") => {
                    if let Some(thinking) = step.get("thinking").and_then(Value::as_str) {
                        if !thinking.trim().is_empty() {
                            blocks.push(TimelineBlock {
                                id: format!("{step_index}:thinking"),
                                role: "thinking".to_string(),
                                content: thinking.to_string(),
                                editable: false,
                                edit_target: String::new(),
                                source_meta: json!({
                                    "stepIndex": step_index,
                                    "createdAt": created_at,
                                }),
                                tool_calls: Vec::new(),
                            });
                        }
                    }

                    let content = step
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let tool_calls = step
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    let next_output = next_tool_output(steps, position, tool_calls.len());

                    let mut calls: Vec<ToolCallBlock> = Vec::new();
                    for (call_index, call) in tool_calls.iter().enumerate() {
                        let output = if tool_calls.len() == 1 {
                            next_output.clone()
                        } else {
                            None
                        };
                        calls.push(antigravity_tool_call(
                            call,
                            step_index,
                            call_index,
                            output,
                        ));
                    }

                    if !content.trim().is_empty() {
                        blocks.push(TimelineBlock {
                            id: format!("{step_index}:assistant"),
                            role: "assistant".to_string(),
                            content: content.to_string(),
                            editable: false,
                            edit_target: String::new(),
                            source_meta: json!({
                                "stepIndex": step_index,
                                "createdAt": created_at,
                            }),
                            tool_calls: calls,
                        });
                    } else if !calls.is_empty() {
                        blocks.push(TimelineBlock {
                            id: format!("{step_index}:tool-calls:assistant"),
                            role: "assistant".to_string(),
                            content: String::new(),
                            editable: false,
                            edit_target: String::new(),
                            source_meta: json!({
                                "stepIndex": step_index,
                                "itemType": "tool_calls",
                                "createdAt": created_at,
                            }),
                            tool_calls: calls,
                        });
                    }
                }
                _ => {}
            }
        }

        blocks
    }
}

fn transcript_in(root: &Path, conversation_id: &str) -> Option<PathBuf> {
    let logs = root
        .join("brain")
        .join(conversation_id)
        .join(".system_generated")
        .join("logs");
    let full = logs.join("transcript_full.jsonl");
    if full.exists() {
        return Some(full);
    }
    let plain = logs.join("transcript.jsonl");
    plain.exists().then_some(plain)
}

/// Antigravity writes timestamps like `2026-08-21 08:00:53.1234567+00:00`.
/// The rest of the app expects epoch milliseconds as a string, so convert here
/// and treat the protobuf zero value (`0001-01-01`) as unknown.
fn normalize_time(value: &str) -> String {
    chrono::DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f%:z")
        .ok()
        .map(|date| date.timestamp_millis())
        .filter(|millis| *millis > 0)
        .map(|millis| millis.to_string())
        .unwrap_or_default()
}

fn is_useful_preview(preview: &str) -> bool {
    let preview = preview.trim();
    !preview.is_empty() && !preview.eq_ignore_ascii_case("New Conversation Greeting")
}

fn user_text(step: &Value) -> Option<String> {
    let content = step.get("content")?.as_str()?;
    Some(extract_user_request(content))
}

fn extract_user_request(content: &str) -> String {
    let start_tag = "<USER_REQUEST>";
    let end_tag = "</USER_REQUEST>";
    if let Some(start) = content.find(start_tag) {
        let inner_start = start + start_tag.len();
        let end = content[inner_start..]
            .find(end_tag)
            .map(|offset| inner_start + offset)
            .or_else(|| content.rfind(end_tag))
            .unwrap_or(content.len());
        return content[inner_start..end].trim().to_string();
    }
    content.trim().to_string()
}

fn workspace_cwd(workspace_uris: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(workspace_uris) else {
        return String::new();
    };
    let Some(uri) = value
        .as_array()
        .and_then(|items| items.first())
        .and_then(Value::as_str)
    else {
        return String::new();
    };
    decode_file_uri(uri)
}

fn decode_file_uri(uri: &str) -> String {
    let raw = uri
        .strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))
        .unwrap_or(uri);
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    let mut text = String::from_utf8_lossy(&decoded).into_owned();
    if text.as_bytes().get(1) == Some(&b':') {
        text = text.replace('/', "\\");
    }
    text
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn next_tool_output(steps: &[Value], position: usize, call_count: usize) -> Option<String> {
    if call_count != 1 {
        return None;
    }
    let current = steps.get(position)?;
    let current_index = current.get("step_index").and_then(Value::as_u64)?;
    let next = steps.get(position + 1)?;
    let next_index = next.get("step_index").and_then(Value::as_u64)?;
    if next_index != current_index + 1 {
        return None;
    }
    if next.get("source").and_then(Value::as_str) != Some("MODEL")
        || next.get("type").and_then(Value::as_str) != Some("GENERIC")
    {
        return None;
    }
    next.get("content")
        .and_then(Value::as_str)
        .and_then(|content| tool_text_from_str(content, 32768))
}

fn antigravity_tool_call(
    call: &Value,
    step_index: u64,
    call_index: usize,
    output: Option<String>,
) -> ToolCallBlock {
    ToolCallBlock {
        id: format!("{step_index}:{call_index}:tool"),
        name: call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        kind: "tool_use".to_string(),
        status: if output.is_some() {
            "completed"
        } else {
            "requested"
        }
        .to_string(),
        input: call.get("args").and_then(|args| tool_text_from_value(args, 8192)),
        output,
        error: None,
        started_at: None,
        ended_at: None,
        source_meta: json!({
            "stepIndex": step_index,
            "callIndex": call_index,
            "itemType": "tool_call",
        }),
    }
}

fn searchable_entries(steps: &[Value]) -> Vec<(usize, String, Vec<String>)> {
    let mut entries = Vec::new();
    for (idx, step) in steps.iter().enumerate() {
        let source = step.get("source").and_then(Value::as_str).unwrap_or_default();
        let step_type = step.get("type").and_then(Value::as_str).unwrap_or_default();
        let role = match (source, step_type) {
            ("USER_EXPLICIT", "USER_INPUT") => "user",
            ("MODEL", "PLANNER_RESPONSE") => "assistant",
            _ => continue,
        };
        let mut texts = Vec::new();
        if let Some(content) = step.get("content").and_then(Value::as_str) {
            texts.push(content.to_string());
        }
        if let Some(thinking) = step.get("thinking").and_then(Value::as_str) {
            texts.push(thinking.to_string());
        }
        for call in step
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if let Some(name) = call.get("name").and_then(Value::as_str) {
                texts.push(name.to_string());
            }
            if let Some(args) = call.get("args") {
                texts.push(args.to_string());
            }
        }
        if texts.is_empty() {
            continue;
        }
        entries.push((idx, role.to_string(), texts));
    }
    // Tool outputs are separate GENERIC steps and never carry a role.
    for (idx, step) in steps.iter().enumerate() {
        if step.get("source").and_then(Value::as_str) == Some("MODEL")
            && step.get("type").and_then(Value::as_str) == Some("GENERIC")
        {
            if let Some(content) = step.get("content").and_then(Value::as_str) {
                entries.push((idx, "assistant".to_string(), vec![content.to_string()]));
            }
        }
    }
    entries
}

impl PlatformAdapter for AntigravityPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let mut items: Vec<SessionListItem> = self
            .load_summaries()
            .iter()
            .filter_map(|row| self.item(row, alias_map))
            .collect();
        items.sort_by(|left, right| {
            let left = left.updated_at.parse::<i64>().unwrap_or_default();
            let right = right.updated_at.parse::<i64>().unwrap_or_default();
            right.cmp(&left)
        });

        let total = items.len();
        let items = items
            .into_iter()
            .skip(offset)
            .take(limit.unwrap_or(usize::MAX))
            .collect();
        SessionListResult { total, items }
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let steps = self.read_transcript(session_key)?;
        let blocks = self.blocks(&steps);

        let summary = self
            .load_summaries()
            .into_iter()
            .find(|row| row.conversation_id == session_key);
        let first_user = steps.iter().find_map(user_text).unwrap_or_default();
        let alias_title = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if !alias_title.is_empty() {
            alias_title.clone()
        } else if let Some(summary) = summary.as_ref() {
            if !summary.title.trim().is_empty() {
                summary.title.trim().to_string()
            } else if is_useful_preview(&summary.preview) {
                summary.preview.trim().to_string()
            } else if !first_user.is_empty() {
                first_user.chars().take(60).collect()
            } else {
                session_key.to_string()
            }
        } else if !first_user.is_empty() {
            first_user.chars().take(60).collect()
        } else {
            session_key.to_string()
        };
        let cwd = summary.map(|row| row.cwd).unwrap_or_default();

        Ok(SessionDetail {
            platform: "antigravity".to_string(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title,
            cwd,
            commands: HashMap::new(),
            blocks,
        })
    }

    fn update_message(&self, _edit_target: &str, _new_content: &str) -> Result<String, String> {
        Err("Antigravity sessions are read-only".to_string())
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let lower = query.to_lowercase();
        if session_key.to_lowercase().contains(&lower) {
            return true;
        }
        self.transcript_path(session_key)
            .and_then(|path| fs::read_to_string(path).ok())
            .map(|raw| raw.to_lowercase().contains(&lower))
            .unwrap_or(false)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let Ok(steps) = self.read_transcript(session_key) else {
            return vec![];
        };
        let lower = query.to_lowercase();
        searchable_entries(&steps)
            .into_iter()
            .filter_map(|(idx, role, texts)| {
                let best = texts
                    .iter()
                    .find(|text| text.to_lowercase().contains(&lower))?;
                if best.is_empty() {
                    return None;
                }
                Some(ContentMatch {
                    snippet: extract_snippet(best, &lower),
                    match_index: idx,
                    role,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("antigravity-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&home).expect("create home");

        let conn = Connection::open(home.join("conversation_summaries.db")).expect("open db");
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id TEXT,
                title TEXT NOT NULL DEFAULT '',
                preview TEXT NOT NULL DEFAULT '',
                step_count INTEGER NOT NULL DEFAULT 0,
                last_modified_time DATETIME NOT NULL,
                workspace_uris TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                project_id TEXT NOT NULL DEFAULT '',
                agent_name TEXT NOT NULL DEFAULT '',
                parent_conversation_id TEXT NOT NULL DEFAULT '',
                nesting_depth INTEGER NOT NULL DEFAULT 0,
                last_user_input_time DATETIME NOT NULL,
                killed NUMERIC NOT NULL DEFAULT false
            );",
        )
        .expect("create schema");
        conn.execute(
            "INSERT INTO conversation_summaries
             (conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
              last_user_input_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)",
            params![
                "conv-1",
                "UWB 可视化",
                "UWB 可视化",
                5,
                "2026-08-21 08:00:53.1234567+00:00",
                r#"["file:///e%3A%5Cworkspace%5C20260402"]"#
            ],
        )
        .expect("insert summary");
        conn.execute(
            "INSERT INTO conversation_summaries
             (conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
              last_user_input_time, parent_conversation_id, nesting_depth)
             VALUES ('sub-1', 'sub', 'sub', 1, '2026-08-21 08:00:53+00:00', '[]',
                     '2026-08-21 08:00:53+00:00', 'conv-1', 1)",
            [],
        )
        .expect("insert subagent");
        drop(conn);

        let logs = home
            .join("brain")
            .join("conv-1")
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&logs).expect("create logs");
        let steps = vec![
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-08-21T08:00:53Z",
                "content":"<USER_REQUEST>\n帮我看看这个项目\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignored\n</ADDITIONAL_METADATA>"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-08-21T08:01:02Z",
                "thinking":"先读文件","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"a.md"}}]}),
            json!({"step_index":2,"source":"MODEL","type":"GENERIC","created_at":"2026-08-21T08:01:03Z",
                "content":"file body"}),
            json!({"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-08-21T08:01:10Z",
                "content":"我已经看完了。"}),
            json!({"step_index":4,"source":"SYSTEM","type":"CHECKPOINT","created_at":"2026-08-21T08:01:11Z",
                "content":"summary"}),
        ];
        let mut text = String::new();
        for step in steps {
            text.push_str(&serde_json::to_string(&step).unwrap());
            text.push('\n');
        }
        fs::write(logs.join("transcript_full.jsonl"), text).expect("write transcript");
        home
    }

    #[test]
    fn lists_and_parses_antigravity_conversations() {
        let home = test_home("list");
        let platform = AntigravityPlatform::new(home.clone());

        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1, "subagent should be filtered out");
        assert_eq!(listed.items[0].platform, "antigravity");
        assert_eq!(listed.items[0].display_title, "UWB 可视化");
        assert_eq!(listed.items[0].cwd, "e:\\workspace\\20260402");
        assert_eq!(listed.items[0].updated_at, "1787299253123");
        assert_eq!(listed.items[0].source_label, "");
        assert!(!listed.items[0].editable);

        let detail = platform
            .get_session_detail("conv-1", &HashMap::new())
            .expect("detail");
        assert_eq!(detail.platform, "antigravity");
        assert_eq!(detail.cwd, "e:\\workspace\\20260402");
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "帮我看看这个项目");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(detail.blocks[2].tool_calls[0].output.as_deref(), Some("file body"));
        assert_eq!(detail.blocks[2].tool_calls[0].status, "completed");
        assert_eq!(detail.blocks[3].role, "assistant");
        assert_eq!(detail.blocks[3].content, "我已经看完了。");

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn normalizes_antigravity_timestamps_to_epoch_millis() {
        assert_eq!(
            normalize_time("2026-08-21 08:00:53.1234567+00:00"),
            "1787299253123"
        );
        assert_eq!(normalize_time("0001-01-01 00:00:00+00:00"), "");
        assert_eq!(normalize_time(""), "");
    }

    #[test]
    fn lists_cli_transcript_with_badge() {
        let base = std::env::temp_dir().join(format!("antigravity-cli-{}", Uuid::new_v4()));
        let home = base.join("antigravity");
        let cli_home = base.join("antigravity-cli");
        fs::create_dir_all(&home).expect("create home");

        let conn = Connection::open(home.join("conversation_summaries.db")).expect("open db");
        conn.execute_batch(
            "CREATE TABLE conversation_summaries (
                conversation_id TEXT,
                title TEXT NOT NULL DEFAULT '',
                preview TEXT NOT NULL DEFAULT '',
                last_modified_time TEXT NOT NULL DEFAULT '',
                workspace_uris TEXT NOT NULL DEFAULT '[]',
                parent_conversation_id TEXT,
                nesting_depth NUMERIC NOT NULL DEFAULT 0
            );",
        )
        .expect("create schema");
        conn.execute(
            "INSERT INTO conversation_summaries
             (conversation_id, title, preview, last_modified_time, workspace_uris)
             VALUES ('cli-1', '', '', '0001-01-01 00:00:00+00:00', '[]')",
            [],
        )
        .expect("insert summary");
        drop(conn);

        let logs = cli_home
            .join("brain")
            .join("cli-1")
            .join(".system_generated")
            .join("logs");
        fs::create_dir_all(&logs).expect("create logs");
        let step = json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT",
            "content":"<USER_REQUEST>\n来自 CLI 的会话\n</USER_REQUEST>"});
        fs::write(
            logs.join("transcript.jsonl"),
            format!("{}\n", serde_json::to_string(&step).unwrap()),
        )
        .expect("write transcript");

        let platform = AntigravityPlatform::new(home);
        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1, "CLI transcript should be listed");
        assert_eq!(listed.items[0].source_label, "CLI");
        assert_eq!(listed.items[0].display_title, "来自 CLI 的会话");
        assert!(!listed.items[0].updated_at.is_empty(), "falls back to file mtime");

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn antigravity_search_covers_transcript_and_tool_output() {
        let home = test_home("search");
        let platform = AntigravityPlatform::new(home.clone());

        assert!(platform.matches_query("conv-1", "项目"));
        assert!(platform.matches_query("conv-1", "file body"));
        assert!(!platform.matches_query("conv-1", "不存在的词"));
        assert_eq!(platform.content_search("conv-1", "file body").len(), 1);
        assert!(platform.content_search("conv-1", "不存在的词").is_empty());
        assert!(platform.update_message("conv-1::0", "x").is_err());

        fs::remove_dir_all(&home).ok();
    }
}

