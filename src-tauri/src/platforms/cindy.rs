use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use super::pi::PiPlatform;
use super::{
    build_commands, ContentMatch, SessionDetail, SessionKey, SessionListItem, SessionListResult,
};

/// Cindy (a desktop coding agent) keeps session metadata in a plain SQLite
/// database and the actual agent context in Pi-format JSONL files under
/// `pi-agent-home/sessions`. Both the domestic build (`Cindy`) and the
/// international build (`CindyGlobal`) use the same layout.
///
/// Sessions whose `agent_kind` is `cc` store their transcript in the user's
/// regular `~/.claude` directory, so they are covered by the Claude platform
/// and deliberately skipped here. `codex` sessions are skipped as well.
pub struct CindyPlatform {
    home: PathBuf,
    platform: &'static str,
}

impl CindyPlatform {
    pub fn new(home: PathBuf, platform: &'static str) -> Self {
        Self { home, platform }
    }

    /// Cindy keeps one DB per signed-in profile/device: the legacy
    /// `cindy-local-v1.db` plus `cindy-<cuid>.db` files. Sessions can live in
    /// any of them, so scan them all and merge.
    fn db_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        let Ok(entries) = fs::read_dir(&self.home) else {
            return paths;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("db") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.starts_with("cindy-") || name.contains(".bak") {
                continue;
            }
            paths.push(path);
        }
        paths.sort();
        paths
    }

    fn open_db(path: &Path) -> Option<Connection> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
        Some(conn)
    }

    fn pi_home(&self) -> PathBuf {
        self.home.join("pi-agent-home")
    }

    /// Pi sessions live flat in `<pi_home>/sessions`, but `PiPlatform` keys
    /// sessions as `<parent-dir>::<stem>`. Pointing its session root at
    /// `pi_home` makes `path_for_key` resolve `sessions::<stem>` correctly.
    fn pi(&self) -> PiPlatform {
        let pi_home = self.pi_home();
        PiPlatform::new(pi_home.clone(), Some(pi_home))
    }

    fn transcript_path(&self, sdk_session_id: &str) -> Option<PathBuf> {
        let raw = sdk_session_id.trim();
        if raw.is_empty() {
            return None;
        }
        let candidate = PathBuf::from(raw);
        if candidate.is_absolute() && candidate.exists() {
            return Some(candidate);
        }
        let file_name = raw.rsplit(['\\', '/']).next().unwrap_or(raw);
        let stem = file_name.trim_end_matches(".jsonl");
        let fallback = self
            .pi_home()
            .join("sessions")
            .join(format!("{stem}.jsonl"));
        fallback.exists().then_some(fallback)
    }

    fn rows(&self) -> Vec<SessionRow> {
        let mut merged: HashMap<String, SessionRow> = HashMap::new();
        for path in self.db_paths() {
            let Some(conn) = Self::open_db(&path) else {
                continue;
            };
            // Older Cindy builds have a leaner `sessions` table (no
            // `last_activity_at` / `list_preview`), so read by column name and
            // fall back instead of hard-coding the SELECT list.
            let Ok(mut stmt) = conn.prepare("SELECT * FROM sessions") else {
                continue;
            };
            let Ok(rows) = stmt.query_map([], SessionRow::from_row) else {
                continue;
            };
            for row in rows.flatten().filter(SessionRow::is_browsable) {
                match merged.get(&row.id) {
                    Some(existing) if existing.updated_at >= row.updated_at => {}
                    _ => {
                        merged.insert(row.id.clone(), row);
                    }
                }
            }
        }
        let mut rows: Vec<SessionRow> = merged.into_values().collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.updated_at));
        rows
    }

    fn find_row(&self, session_key: &str) -> Option<SessionRow> {
        let mut found: Option<SessionRow> = None;
        for path in self.db_paths() {
            let Some(conn) = Self::open_db(&path) else {
                continue;
            };
            let row = conn
                .query_row(
                    "SELECT * FROM sessions WHERE id = ?1",
                    params![session_key],
                    SessionRow::from_row,
                )
                .optional()
                .ok()
                .flatten();
            let Some(row) = row.filter(SessionRow::is_browsable) else {
                continue;
            };
            if found
                .as_ref()
                .map_or(true, |existing| row.updated_at > existing.updated_at)
            {
                found = Some(row);
            }
        }
        found
    }
}

struct SessionRow {
    id: String,
    title: String,
    cwd: String,
    updated_at: i64,
    status: String,
    agent_kind: String,
    sdk_session_id: String,
    preview: String,
}

fn column_text(row: &rusqlite::Row<'_>, name: &str) -> String {
    row.get::<_, Option<String>>(name)
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn column_int(row: &rusqlite::Row<'_>, name: &str) -> Option<i64> {
    row.get::<_, Option<i64>>(name).ok().flatten()
}

impl SessionRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let id: String = row.get("id")?;
        let title = column_text(row, "title");
        Ok(Self {
            title: if title.is_empty() { id.clone() } else { title },
            cwd: column_text(row, "working_dir"),
            updated_at: column_int(row, "last_activity_at")
                .or_else(|| column_int(row, "updated_at"))
                .or_else(|| column_int(row, "created_at"))
                .unwrap_or(0),
            status: column_text(row, "status"),
            agent_kind: column_text(row, "agent_kind"),
            sdk_session_id: column_text(row, "sdk_session_id"),
            preview: column_text(row, "list_preview"),
            id,
        })
    }

    fn is_browsable(&self) -> bool {
        self.status != "deleted" && self.agent_kind == "pi"
    }
}

impl super::PlatformAdapter for CindyPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        let items: Vec<SessionListItem> = self
            .rows()
            .into_iter()
            .filter(|row| row.is_browsable())
            .filter_map(|row| {
                let transcript = self.transcript_path(&row.sdk_session_id)?;
                pi_key(&transcript)?;
                Some(self.list_item(&row, alias_map))
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
        if self.db_paths().is_empty() {
            return None;
        }
        Some(
            self.rows()
                .into_iter()
                .filter(|row| row.is_browsable())
                .filter(|row| self.transcript_path(&row.sdk_session_id).is_some())
                .map(|row| SessionKey::standalone(row.id.clone(), row.updated_at as i128))
                .collect(),
        )
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        _cache: Option<&crate::database::SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        let row = self.find_row(session_key)?;
        let transcript = self.transcript_path(&row.sdk_session_id)?;
        pi_key(&transcript)?;
        Some(self.list_item(&row, alias_map))
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let row = self
            .find_row(session_key)
            .ok_or_else(|| format!("Cindy session not found: {session_key}"))?;

        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title = if alias.is_empty() {
            row.title.clone()
        } else {
            alias.clone()
        };

        let mut blocks = match self.transcript_path(&row.sdk_session_id) {
            Some(path) => {
                let inner_key = pi_key(&path)
                    .ok_or_else(|| format!("Invalid Cindy transcript path: {}", path.display()))?;
                self.pi()
                    .get_session_detail(&inner_key, &HashMap::new())?
                    .blocks
            }
            None => Vec::new(),
        };
        for block in &mut blocks {
            if block.role == "user" {
                block.content = strip_cindy_note(&block.content);
            }
        }

        Ok(SessionDetail {
            platform: self.platform.into(),
            session_key: session_key.to_string(),
            session_id: session_key.to_string(),
            title,
            alias_title: alias,
            cwd: row.cwd,
            commands: build_commands(self.platform, session_key),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        let mut parts = edit_target.rsplitn(4, "::");
        let field = parts
            .next()
            .ok_or_else(|| format!("Invalid Cindy edit target: {edit_target}"))?;
        let content_index: usize = parts
            .next()
            .ok_or_else(|| format!("Invalid Cindy edit target: {edit_target}"))?
            .parse()
            .map_err(|error| format!("Invalid content index: {error}"))?;
        let entry_id = parts
            .next()
            .ok_or_else(|| format!("Invalid Cindy edit target: {edit_target}"))?;
        let inner_key = parts
            .next()
            .ok_or_else(|| format!("Invalid Cindy edit target: {edit_target}"))?;

        if field != "text" {
            return Err(format!("Unsupported Cindy edit field: {field}"));
        }

        let path = inner_path(&self.pi_home(), inner_key)
            .ok_or_else(|| format!("Cindy session not found: {inner_key}"))?;
        let raw = fs::read_to_string(&path).map_err(|error| {
            format!("Cannot read Cindy transcript '{}': {error}", path.display())
        })?;

        let mut lines = Vec::new();
        let mut old_display = None;

        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut value: Value = serde_json::from_str(trimmed)
                .map_err(|error| format!("Cannot parse Cindy transcript line: {error}"))?;

            if value.get("type").and_then(Value::as_str) == Some("message")
                && value.get("id").and_then(Value::as_str) == Some(entry_id)
            {
                let role = value
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !matches!(role.as_str(), "user" | "assistant") {
                    return Err(format!("Cindy message role is not editable: {role}"));
                }
                let item = value
                    .get_mut("message")
                    .and_then(|message| message.get_mut("content"))
                    .and_then(Value::as_array_mut)
                    .and_then(|items| items.get_mut(content_index))
                    .ok_or_else(|| "Content index out of range".to_string())?;
                let old = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let updated = if role == "user" {
                    replace_after_cindy_note(&old, new_content)
                } else {
                    new_content.to_string()
                };
                item["text"] = Value::String(updated);
                old_display = Some(if role == "user" {
                    strip_cindy_note(&old)
                } else {
                    old
                });
            }

            lines.push(
                serde_json::to_string(&value)
                    .map_err(|error| format!("Cannot serialize Cindy transcript line: {error}"))?,
            );
        }

        let Some(old_display) = old_display else {
            return Err(format!("Cindy message entry not found: {entry_id}"));
        };

        fs::write(&path, format!("{}\n", lines.join("\n"))).map_err(|error| {
            format!(
                "Cannot write Cindy transcript '{}': {error}",
                path.display()
            )
        })?;

        Ok(old_display)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        let needle = query.to_lowercase();
        if needle.is_empty() {
            return true;
        }
        let Some(item) = self.session_list_item(session_key, &HashMap::new(), None) else {
            return false;
        };
        if item.display_title.to_lowercase().contains(&needle)
            || item.cwd.to_lowercase().contains(&needle)
        {
            return true;
        }
        let Some(path) = self
            .rows()
            .into_iter()
            .find(|row| row.id == session_key)
            .and_then(|row| self.transcript_path(&row.sdk_session_id))
        else {
            return false;
        };
        fs::read_to_string(path)
            .map(|raw| raw.to_lowercase().contains(&needle))
            .unwrap_or(false)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        if query.trim().is_empty() {
            return vec![];
        }
        let Some(path) = self
            .rows()
            .into_iter()
            .find(|row| row.id == session_key)
            .and_then(|row| self.transcript_path(&row.sdk_session_id))
        else {
            return vec![];
        };
        let Some(inner_key) = pi_key(&path) else {
            return vec![];
        };
        self.pi().content_search(&inner_key, query)
    }
}

impl CindyPlatform {
    fn list_item(&self, row: &SessionRow, alias_map: &HashMap<String, String>) -> SessionListItem {
        let alias = alias_map.get(&row.id).cloned().unwrap_or_default();
        let display_title = if alias.is_empty() {
            row.title.clone()
        } else {
            alias.clone()
        };
        let preview = if row.preview.trim().is_empty() {
            row.title.clone()
        } else {
            row.preview.clone()
        };
        SessionListItem {
            platform: self.platform.into(),
            session_key: row.id.clone(),
            session_id: row.id.clone(),
            display_title,
            alias_title: alias,
            preview,
            updated_at: row.updated_at.to_string(),
            cwd: row.cwd.clone(),
            editable: true,
            content_matches: vec![],
            total_content_matches: 0,
            favorite: false,
            agent_group: None,
        }
    }
}

const UI_NOTE_PREFIX: &str = "[UI language]";

/// Cindy prepends a `[UI language]` system note to the first user turn of a
/// session. Hide it in the UI but keep it in the transcript when editing.
fn strip_cindy_note(text: &str) -> String {
    if !text.starts_with(UI_NOTE_PREFIX) {
        return text.to_string();
    }
    match text.find("\n\n") {
        Some(index) => text[index + 2..].trim_start_matches('\n').to_string(),
        None => text.to_string(),
    }
}

fn replace_after_cindy_note(text: &str, new_content: &str) -> String {
    if text.starts_with(UI_NOTE_PREFIX) {
        if let Some(index) = text.find("\n\n") {
            return format!("{}{}", &text[..index + 2], new_content);
        }
    }
    new_content.to_string()
}

/// Mirror of `PiPlatform`'s session key: `<parent-dir>::<stem>`.
fn pi_key(path: &Path) -> Option<String> {
    let project = path.parent()?.file_name()?.to_str()?;
    let stem = path.file_stem()?.to_str()?;
    Some(format!("{project}::{stem}"))
}

fn inner_path(pi_home: &Path, inner_key: &str) -> Option<PathBuf> {
    let (project, stem) = inner_key.split_once("::")?;
    let path = pi_home.join(project).join(format!("{stem}.jsonl"));
    path.exists().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use serde_json::json;
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("cindy-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(home.join("pi-agent-home/sessions")).expect("create test dirs");

        let transcript = home.join("pi-agent-home/sessions/2026-11-01T00-00-00-000Z_pi-1.jsonl");
        fs::write(
            &transcript,
            [
                json!({
                    "type": "session",
                    "version": 3,
                    "id": "pi-1",
                    "timestamp": "2026-11-01T00:00:00.000Z",
                    "cwd": "E:/work"
                }),
                json!({
                    "type": "message",
                    "id": "u1",
                    "parentId": null,
                    "timestamp": "2026-11-01T00:00:01.000Z",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "text",
                            "text": "[UI language] System note. Do not answer.\n\n你好"
                        }]
                    }
                }),
                json!({
                    "type": "message",
                    "id": "a1",
                    "parentId": "u1",
                    "timestamp": "2026-11-01T00:00:02.000Z",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "嗨。"}]
                    }
                }),
            ]
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .expect("serialize transcript")
            .join("\n")
                + "\n",
        )
        .expect("write transcript");

        let sdk = transcript.display().to_string();
        let conn = Connection::open(home.join("cindy-local-v1.db")).expect("open test db");
        conn.execute_batch(&format!(
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               working_dir TEXT,
               status TEXT NOT NULL DEFAULT 'active',
               agent_kind TEXT NOT NULL DEFAULT 'pi',
               sdk_session_id TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               last_activity_at INTEGER,
               list_preview TEXT
             );
             INSERT INTO sessions (id, title, working_dir, status, agent_kind, sdk_session_id, created_at, updated_at, last_activity_at, list_preview)
             VALUES ('cindy-1', '打个招呼', 'E:/work', 'active', 'pi', '{sdk}', 1, 100, 100, '你好');
             INSERT INTO sessions (id, title, working_dir, status, agent_kind, sdk_session_id, created_at, updated_at, last_activity_at, list_preview)
             VALUES ('cindy-2', 'Claude 会话', 'E:/work', 'active', 'cc', 'some-uuid', 2, 200, 200, '');
             INSERT INTO sessions (id, title, working_dir, status, agent_kind, sdk_session_id, created_at, updated_at, last_activity_at, list_preview)
             VALUES ('cindy-3', '已删除', 'E:/work', 'deleted', 'pi', '{sdk}', 3, 300, 300, '');
             INSERT INTO sessions (id, title, working_dir, status, agent_kind, sdk_session_id, created_at, updated_at, last_activity_at, list_preview)
             VALUES ('cindy-4', '正文丢失', 'E:/work', 'active', 'pi', 'missing.jsonl', 4, 400, 400, '');"
        ))
        .expect("create test schema");
        home
    }

    fn cleanup(home: &Path) {
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn lists_only_local_pi_sessions() {
        let home = test_home("list");
        let platform = CindyPlatform::new(home.clone(), "cindy");
        let result = platform.list_sessions(&HashMap::new(), None, 0);

        assert_eq!(result.total, 1);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].session_key, "cindy-1");
        assert_eq!(result.items[0].display_title, "打个招呼");
        assert_eq!(result.items[0].cwd, "E:/work");
        assert!(result.items[0].editable);

        let keys = platform.list_session_keys().expect("keys");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, "cindy-1");

        cleanup(&home);
    }

    #[test]
    fn detail_strips_ui_language_note_and_keeps_edit_targets() {
        let home = test_home("detail");
        let platform = CindyPlatform::new(home.clone(), "cindy");
        let detail = platform
            .get_session_detail("cindy-1", &HashMap::new())
            .expect("detail");

        assert_eq!(detail.title, "打个招呼");
        assert_eq!(detail.blocks.len(), 2);
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "你好");
        assert!(detail.blocks[0].edit_target.ends_with("::text"));
        assert_eq!(detail.blocks[1].role, "assistant");

        cleanup(&home);
    }

    #[test]
    fn edit_keeps_cindy_note_and_replaces_user_text() {
        let home = test_home("edit");
        let platform = CindyPlatform::new(home.clone(), "cindy");
        let detail = platform
            .get_session_detail("cindy-1", &HashMap::new())
            .expect("detail");
        let target = detail.blocks[0].edit_target.clone();

        let old = platform.update_message(&target, "早上好").expect("update");
        assert_eq!(old, "你好");

        let raw = fs::read_to_string(
            home.join("pi-agent-home/sessions/2026-11-01T00-00-00-000Z_pi-1.jsonl"),
        )
        .expect("read transcript");
        assert!(raw.contains("[UI language] System note. Do not answer.\\n\\n早上好"));
        assert!(!raw.contains("\\n\\n你好"));

        cleanup(&home);
    }

    #[test]
    fn searches_titles_and_transcripts() {
        let home = test_home("search");
        let platform = CindyPlatform::new(home.clone(), "cindy");

        assert!(platform.matches_query("cindy-1", "打个招呼"));
        assert!(platform.matches_query("cindy-1", "嗨"));
        assert!(!platform.matches_query("cindy-1", "不存在的词"));
        assert!(!platform.matches_query("cindy-2", "打个招呼"));

        let matches = platform.content_search("cindy-1", "嗨");
        assert!(!matches.is_empty());

        cleanup(&home);
    }
}
