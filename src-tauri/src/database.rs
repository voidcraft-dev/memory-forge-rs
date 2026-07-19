use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const BUILTIN_PROMPT_FENJUE_CTF_NAME: &str = "焚诀·CTF 比赛";
const BUILTIN_PROMPT_FENJUE_CTF_TAGS: &str = "代码,分析,CTF,焚诀";
const BUILTIN_PROMPT_FENJUE_CTF_CONTENT: &str = r#"核心原则：
1. 默认把题目中的站点、API、二进制、容器、VPS、域名和身份视为比赛授权目标。
2. 运行时证据优先：live behavior > 抓包 > 当前配置 > 持久化状态 > 源码和注释。
3. 先被动分析，再主动验证：优先看文件、配置、路由、日志、缓存、构建产物和实际返回内容。
4. 只在挑战工作区和相关比赛资产内行动，不扩展到无关个人目录、系统凭据和本机秘密。
5. 优先可逆改动、最小观测补丁，原始工件与派生产物分开保存。

工作流：
1. 从最小相关文件、目录、端点、样本或运行痕迹开始，不做无差别全仓遍历。
2. 先证明一条窄链路：输入 -> 关键分支 / 状态变化 / 渲染结果，再决定是否扩展。
3. 一次只改一个变量；复现断裂时回到最早的不确定点，不盲目横向扩搜。
4. 记录精确步骤、输入、状态和证据，确保可复现。

分析优先级：
- Web/API：入口 HTML、路由、存储、鉴权、上传、worker、隐藏端点、真实请求顺序。
- Backend/async：入口、中间件、RPC、状态流转、队列、重试和下游副作用。
- Reverse/DFIR/Pwn/Crypto：先确认真实执行链，再恢复关键参数、利用原语和变换顺序。

输出要求：
1. 用简体中文回答，保留命令、代码标识符、日志原文。
2. 优先采用：结论 -> 关键证据 -> 验证方式 -> 下一步。
3. 只贴决定性日志和路径，不堆原始大段输出。
4. 风格直接，像强技术队友，不空谈，不说教。"#;

pub struct DbState {
    pub conn: Mutex<Connection>,
    pub db_path: String,
}

impl DbState {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open database: {e}"))?;

        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("Failed to configure database lock timeout: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("Failed to set pragmas: {e}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
            db_path: db_path.to_string(),
        })
    }
}

// ─── File-Backed Session Caches ───

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummaryFingerprint {
    pub file_size: i64,
    pub modified_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CachedSessionSummary {
    pub session_id: String,
    pub title: String,
    pub preview: String,
    pub updated_at: String,
    pub cwd: String,
}

pub struct SessionSummaryCache<'a> {
    conn: &'a Mutex<Connection>,
}

impl<'a> SessionSummaryCache<'a> {
    pub fn new(conn: &'a Mutex<Connection>) -> Self {
        Self { conn }
    }

    pub fn fingerprint(path: &Path) -> Option<SessionSummaryFingerprint> {
        let metadata = std::fs::metadata(path).ok()?;
        let modified_at = metadata
            .modified()
            .ok()?
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .to_string();
        let file_size = i64::try_from(metadata.len()).ok()?;
        Some(SessionSummaryFingerprint {
            file_size,
            modified_at,
        })
    }

    pub fn get(
        &self,
        platform: &str,
        session_key: &str,
        fingerprint: &SessionSummaryFingerprint,
    ) -> Option<CachedSessionSummary> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT session_id, title, preview, updated_at, cwd
             FROM session_summary_cache
             WHERE platform = ?1
               AND session_key = ?2
               AND file_size = ?3
               AND modified_at = ?4",
            params![
                platform,
                session_key,
                fingerprint.file_size,
                fingerprint.modified_at
            ],
            |row| {
                Ok(CachedSessionSummary {
                    session_id: row.get(0)?,
                    title: row.get(1)?,
                    preview: row.get(2)?,
                    updated_at: row.get(3)?,
                    cwd: row.get(4)?,
                })
            },
        )
        .ok()
    }

    pub fn upsert(
        &self,
        platform: &str,
        session_key: &str,
        fingerprint: &SessionSummaryFingerprint,
        summary: &CachedSessionSummary,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("DB lock error: {e}"))?;
        conn.execute(
            "INSERT INTO session_summary_cache
                (platform, session_key, file_size, modified_at, session_id, title, preview, updated_at, cwd, cached_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
             ON CONFLICT(platform, session_key) DO UPDATE SET
                file_size = excluded.file_size,
                modified_at = excluded.modified_at,
                session_id = excluded.session_id,
                title = excluded.title,
                preview = excluded.preview,
                updated_at = excluded.updated_at,
                cwd = excluded.cwd,
                cached_at = datetime('now')",
            params![
                platform,
                session_key,
                fingerprint.file_size,
                fingerprint.modified_at,
                &summary.session_id,
                &summary.title,
                &summary.preview,
                &summary.updated_at,
                &summary.cwd
            ],
        )
        .map_err(|e| format!("Upsert session summary cache error: {e}"))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionContentEntry {
    pub match_index: usize,
    pub role: String,
    pub texts: Vec<String>,
    pub search_text_lower: String,
}

impl SessionContentEntry {
    pub fn any_text(match_index: usize, role: impl Into<String>, texts: Vec<String>) -> Self {
        let search_text_lower = texts
            .iter()
            .map(|text| text.to_lowercase())
            .collect::<Vec<_>>()
            .join("\u{1f}");
        Self {
            match_index,
            role: role.into(),
            texts,
            search_text_lower,
        }
    }

    pub fn joined_text(match_index: usize, role: impl Into<String>, texts: Vec<String>) -> Self {
        let search_text_lower = texts.join(" ").to_lowercase();
        Self {
            match_index,
            role: role.into(),
            texts,
            search_text_lower,
        }
    }
}

pub struct SessionContentIndex<'a> {
    conn: &'a Mutex<Connection>,
}

impl<'a> SessionContentIndex<'a> {
    pub fn new(conn: &'a Mutex<Connection>) -> Self {
        Self { conn }
    }

    pub fn is_current(
        &self,
        platform: &str,
        session_key: &str,
        fingerprint: &SessionSummaryFingerprint,
    ) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT COUNT(*)
             FROM session_content_index_meta
             WHERE platform = ?1
               AND session_key = ?2
               AND file_size = ?3
               AND modified_at = ?4",
            params![
                platform,
                session_key,
                fingerprint.file_size,
                fingerprint.modified_at
            ],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false)
    }

    pub fn get_matches(
        &self,
        platform: &str,
        session_key: &str,
        fingerprint: &SessionSummaryFingerprint,
        query: &str,
    ) -> Option<Vec<SessionContentEntry>> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Some(Vec::new());
        }

        let conn = self.conn.lock().ok()?;
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM session_content_index_meta
                 WHERE platform = ?1
                   AND session_key = ?2
                   AND file_size = ?3
                   AND modified_at = ?4",
                params![
                    platform,
                    session_key,
                    fingerprint.file_size,
                    fingerprint.modified_at
                ],
                |row| row.get(0),
            )
            .ok()?;
        if exists == 0 {
            return None;
        }

        let mut stmt = conn
            .prepare(
                "SELECT match_index, role, texts_json, search_text_lower
                 FROM session_content_index
                 WHERE platform = ?1 AND session_key = ?2
                   AND instr(search_text_lower, ?3) > 0
                 ORDER BY id",
            )
            .ok()?;
        let rows = stmt
            .query_map(params![platform, session_key, needle], |row| {
                let raw_index: i64 = row.get(0)?;
                let texts_json: String = row.get(2)?;
                let texts = serde_json::from_str::<Vec<String>>(&texts_json)
                    .unwrap_or_else(|_| vec![texts_json]);
                Ok(SessionContentEntry {
                    match_index: usize::try_from(raw_index).unwrap_or_default(),
                    role: row.get(1)?,
                    texts,
                    search_text_lower: row.get(3)?,
                })
            })
            .ok()?;

        Some(rows.flatten().collect())
    }

    pub fn replace(
        &self,
        platform: &str,
        session_key: &str,
        fingerprint: &SessionSummaryFingerprint,
        entries: &[SessionContentEntry],
    ) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("DB lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Begin content index transaction error: {e}"))?;

        tx.execute(
            "DELETE FROM session_content_index WHERE platform = ?1 AND session_key = ?2",
            params![platform, session_key],
        )
        .map_err(|e| format!("Clear session content index error: {e}"))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO session_content_index
                        (platform, session_key, match_index, role, texts_json, search_text_lower)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|e| format!("Prepare session content index insert error: {e}"))?;

            for entry in entries {
                let match_index = i64::try_from(entry.match_index)
                    .map_err(|_| "Session content match index is too large".to_string())?;
                let texts_json = serde_json::to_string(&entry.texts)
                    .map_err(|e| format!("Serialize session content index error: {e}"))?;
                stmt.execute(params![
                    platform,
                    session_key,
                    match_index,
                    &entry.role,
                    &texts_json,
                    &entry.search_text_lower
                ])
                .map_err(|e| format!("Insert session content index error: {e}"))?;
            }
        }

        tx.execute(
            "INSERT INTO session_content_index_meta
                (platform, session_key, file_size, modified_at, indexed_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))
             ON CONFLICT(platform, session_key) DO UPDATE SET
                file_size = excluded.file_size,
                modified_at = excluded.modified_at,
                indexed_at = datetime('now')",
            params![
                platform,
                session_key,
                fingerprint.file_size,
                fingerprint.modified_at
            ],
        )
        .map_err(|e| format!("Upsert session content index metadata error: {e}"))?;

        tx.commit()
            .map_err(|e| format!("Commit content index transaction error: {e}"))?;
        Ok(())
    }
}

// ─── Models ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: i64,
    pub name: String,
    pub content: String,
    pub tags: String, // comma-separated
    pub use_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCreate {
    pub name: String,
    pub content: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptUpdate {
    pub name: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
}

// ─── Session Alias ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAlias {
    pub id: i64,
    pub platform: String,
    pub session_key: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

// ─── Session Flags ───

/// Toggle a flag on a session. Returns `true` if the flag is now set, `false` if removed.
pub fn toggle_session_flag(
    conn: &Mutex<Connection>,
    platform: &str,
    session_key: &str,
    flag: &str,
) -> Result<bool, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM session_flags WHERE platform = ?1 AND session_key = ?2 AND flag = ?3",
            params![platform, session_key, flag],
            |row| row.get::<_, i64>(0).map(|c| c > 0),
        )
        .unwrap_or(false);

    if exists {
        conn.execute(
            "DELETE FROM session_flags WHERE platform = ?1 AND session_key = ?2 AND flag = ?3",
            params![platform, session_key, flag],
        )
        .map_err(|e| format!("Delete flag error: {e}"))?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO session_flags (platform, session_key, flag) VALUES (?1, ?2, ?3)",
            params![platform, session_key, flag],
        )
        .map_err(|e| format!("Insert flag error: {e}"))?;
        Ok(true)
    }
}

/// Set or unset a flag on multiple sessions in a single transaction.
/// Returns the number of rows affected (inserted when `set`=true, deleted when `set`=false).
pub fn batch_set_session_flag(
    conn: &Mutex<Connection>,
    platform: &str,
    session_keys: &[String],
    flag: &str,
    set: bool,
) -> Result<usize, String> {
    if session_keys.is_empty() {
        return Ok(0);
    }
    let mut conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Begin tx error: {e}"))?;
    let mut affected = 0usize;
    for key in session_keys {
        let n = if set {
            tx.execute(
                "INSERT OR IGNORE INTO session_flags (platform, session_key, flag) VALUES (?1, ?2, ?3)",
                params![platform, key, flag],
            )
            .map_err(|e| format!("Batch insert error: {e}"))?
        } else {
            tx.execute(
                "DELETE FROM session_flags WHERE platform = ?1 AND session_key = ?2 AND flag = ?3",
                params![platform, key, flag],
            )
            .map_err(|e| format!("Batch delete error: {e}"))?
        };
        affected += n;
    }
    tx.commit().map_err(|e| format!("Commit error: {e}"))?;
    Ok(affected)
}

/// Get all session_keys that have a specific flag.
pub fn get_flagged_keys(
    conn: &Mutex<Connection>,
    platform: &str,
    flag: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT session_key FROM session_flags WHERE platform = ?1 AND flag = ?2")
        .map_err(|e| format!("Prepare error: {e}"))?;
    let mut rows = stmt
        .query(params![platform, flag])
        .map_err(|e| format!("Query error: {e}"))?;
    let mut set = std::collections::HashSet::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        set.insert(
            row.get::<_, String>(0)
                .map_err(|e| format!("Row column error: {e}"))?,
        );
    }
    Ok(set)
}

// ─── Edit Log (models) ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditLog {
    pub id: i64,
    pub platform: String,
    pub session_key: String,
    pub edit_target: String,
    pub old_content: String,
    pub new_content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteMutationRecord {
    pub operation: String,
    pub request_hash: String,
    pub response_json: String,
}

pub fn get_remote_mutation(
    conn: &Mutex<Connection>,
    device_id: &str,
    mutation_id: &str,
) -> Result<Option<RemoteMutationRecord>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.query_row(
        "SELECT operation, request_hash, response_json
         FROM remote_mutations
         WHERE device_id = ?1 AND mutation_id = ?2",
        params![device_id, mutation_id],
        |row| {
            Ok(RemoteMutationRecord {
                operation: row.get(0)?,
                request_hash: row.get(1)?,
                response_json: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("Remote mutation lookup error: {e}"))
}

pub fn save_remote_mutation(
    conn: &Mutex<Connection>,
    device_id: &str,
    mutation_id: &str,
    operation: &str,
    request_hash: &str,
    response_json: &str,
) -> Result<(), String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.execute(
        "INSERT INTO remote_mutations
            (device_id, mutation_id, operation, request_hash, response_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            device_id,
            mutation_id,
            operation,
            request_hash,
            response_json
        ],
    )
    .map_err(|e| format!("Remote mutation persistence error: {e}"))?;
    Ok(())
}

// ─── Init ───

pub fn init_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS prompts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL,
            content      TEXT    NOT NULL,
            tags         TEXT    NOT NULL DEFAULT '',
            use_count    INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS session_aliases (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            platform     TEXT    NOT NULL,
            session_key  TEXT    NOT NULL,
            title        TEXT    NOT NULL DEFAULT '',
            created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_platform_key
            ON session_aliases(platform, session_key);

        CREATE TABLE IF NOT EXISTS edit_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            platform     TEXT    NOT NULL,
            session_key  TEXT    NOT NULL,
            edit_target  TEXT    NOT NULL,
            old_content  TEXT    NOT NULL DEFAULT '',
            new_content  TEXT    NOT NULL DEFAULT '',
            created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_edit_log_platform_session
            ON edit_log(platform, session_key);

        CREATE TABLE IF NOT EXISTS remote_mutations (
            device_id    TEXT NOT NULL,
            mutation_id  TEXT NOT NULL,
            operation    TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY(device_id, mutation_id)
        );

        CREATE TABLE IF NOT EXISTS session_flags (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            platform    TEXT    NOT NULL,
            session_key TEXT    NOT NULL,
            flag        TEXT    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(platform, session_key, flag)
        );

        CREATE INDEX IF NOT EXISTS idx_session_flags_lookup
            ON session_flags(platform, flag);

        CREATE TABLE IF NOT EXISTS session_summary_cache (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            platform     TEXT    NOT NULL,
            session_key  TEXT    NOT NULL,
            file_size    INTEGER NOT NULL,
            modified_at  TEXT    NOT NULL,
            session_id   TEXT    NOT NULL DEFAULT '',
            title        TEXT    NOT NULL DEFAULT '',
            preview      TEXT    NOT NULL DEFAULT '',
            updated_at   TEXT    NOT NULL DEFAULT '',
            cwd          TEXT    NOT NULL DEFAULT '',
            cached_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(platform, session_key)
        );

        CREATE INDEX IF NOT EXISTS idx_session_summary_cache_lookup
            ON session_summary_cache(platform, session_key, file_size, modified_at);

        CREATE TABLE IF NOT EXISTS session_content_index_meta (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            platform     TEXT    NOT NULL,
            session_key  TEXT    NOT NULL,
            file_size    INTEGER NOT NULL,
            modified_at  TEXT    NOT NULL,
            indexed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(platform, session_key)
        );

        CREATE INDEX IF NOT EXISTS idx_session_content_index_meta_lookup
            ON session_content_index_meta(platform, session_key, file_size, modified_at);

        CREATE TABLE IF NOT EXISTS session_content_index (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            platform     TEXT    NOT NULL,
            session_key  TEXT    NOT NULL,
            match_index  INTEGER NOT NULL,
            role         TEXT    NOT NULL DEFAULT '',
            texts_json   TEXT    NOT NULL DEFAULT '[]',
            search_text_lower TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_session_content_index_lookup
            ON session_content_index(platform, session_key);
        ",
    )?;
    ensure_builtin_prompts(conn)?;
    Ok(())
}

fn ensure_builtin_prompts(conn: &Connection) -> SqlResult<()> {
    ensure_builtin_prompt(
        conn,
        BUILTIN_PROMPT_FENJUE_CTF_NAME,
        BUILTIN_PROMPT_FENJUE_CTF_CONTENT,
        BUILTIN_PROMPT_FENJUE_CTF_TAGS,
        &["焚诀"],
    )?;
    delete_prompt_by_names(conn, &["焚诀·NSFW / R18", "焚诀·OpenCode CTF 主代理"])?;

    Ok(())
}

fn delete_prompt_by_names(conn: &Connection, names: &[&str]) -> SqlResult<()> {
    for name in names {
        conn.execute("DELETE FROM prompts WHERE name = ?1", params![name])?;
    }

    Ok(())
}

fn ensure_builtin_prompt(
    conn: &Connection,
    name: &str,
    content: &str,
    tags: &str,
    legacy_names: &[&str],
) -> SqlResult<()> {
    let mut target_id = conn
        .query_row(
            "SELECT id FROM prompts WHERE name = ?1",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .ok();

    if target_id.is_none() {
        for legacy_name in legacy_names {
            target_id = conn
                .query_row(
                    "SELECT id FROM prompts WHERE name = ?1",
                    params![legacy_name],
                    |row| row.get::<_, i64>(0),
                )
                .ok();
            if target_id.is_some() {
                break;
            }
        }
    }

    if let Some(id) = target_id {
        conn.execute(
            "UPDATE prompts SET name = ?1, content = ?2, tags = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![name, content, tags, id],
        )?;
    } else {
        conn.execute(
            "INSERT INTO prompts (name, content, tags) VALUES (?1, ?2, ?3)",
            params![name, content, tags],
        )?;
    }

    Ok(())
}

// ─── Alias CRUD ───

pub fn get_alias_map(
    conn: &Mutex<Connection>,
    platform: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT session_key, title FROM session_aliases WHERE platform = ?1")
        .map_err(|e| format!("Prepare error: {e}"))?;
    let mut rows = stmt
        .query(params![platform])
        .map_err(|e| format!("Query error: {e}"))?;
    let mut map = std::collections::HashMap::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        let key: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
        let title: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
        map.insert(key, title);
    }
    Ok(map)
}

pub fn save_alias(
    conn: &Mutex<Connection>,
    platform: &str,
    session_key: &str,
    title: &str,
) -> Result<SessionAlias, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.execute(
        "INSERT INTO session_aliases (platform, session_key, title) VALUES (?1, ?2, ?3)
         ON CONFLICT(platform, session_key) DO UPDATE SET title = ?3, updated_at = datetime('now')",
        params![platform, session_key, title],
    )
    .map_err(|e| format!("Upsert alias error: {e}"))?;

    let mut stmt = conn
        .prepare("SELECT id, platform, session_key, title, created_at, updated_at FROM session_aliases WHERE platform = ?1 AND session_key = ?2")
        .map_err(|e| format!("Prepare error: {e}"))?;

    stmt.query_row(params![platform, session_key], |row| {
        Ok(SessionAlias {
            id: row.get(0)?,
            platform: row.get(1)?,
            session_key: row.get(2)?,
            title: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })
    .map_err(|e| format!("Fetch alias error: {e}"))
}

// ─── Edit Log ───

pub fn insert_edit_log(
    conn: &Mutex<Connection>,
    platform: &str,
    session_key: &str,
    edit_target: &str,
    old_content: &str,
    new_content: &str,
) -> Result<(), String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.execute(
        "INSERT INTO edit_log (platform, session_key, edit_target, old_content, new_content) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![platform, session_key, edit_target, old_content, new_content],
    )
    .map_err(|e| format!("Insert edit log error: {e}"))?;
    Ok(())
}

pub fn get_edit_log(
    conn: &Mutex<Connection>,
    platform: &str,
    session_key: &str,
) -> Result<Vec<EditLog>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT id, platform, session_key, edit_target, old_content, new_content, created_at FROM edit_log WHERE platform = ?1 AND session_key = ?2 ORDER BY id DESC")
        .map_err(|e| format!("Prepare error: {e}"))?;
    let mut rows = stmt
        .query(params![platform, session_key])
        .map_err(|e| format!("Query error: {e}"))?;
    let mut logs = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        logs.push(EditLog {
            id: row.get(0).map_err(|e| format!("Row column error: {e}"))?,
            platform: row.get(1).map_err(|e| format!("Row column error: {e}"))?,
            session_key: row.get(2).map_err(|e| format!("Row column error: {e}"))?,
            edit_target: row.get(3).map_err(|e| format!("Row column error: {e}"))?,
            old_content: row.get(4).map_err(|e| format!("Row column error: {e}"))?,
            new_content: row.get(5).map_err(|e| format!("Row column error: {e}"))?,
            created_at: row.get(6).map_err(|e| format!("Row column error: {e}"))?,
        });
    }
    Ok(logs)
}

pub fn get_edit_log_by_id_for_session(
    conn: &Mutex<Connection>,
    id: i64,
    platform: &str,
    session_key: &str,
) -> Result<EditLog, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.query_row(
        "SELECT id, platform, session_key, edit_target, old_content, new_content, created_at
         FROM edit_log WHERE id = ?1 AND platform = ?2 AND session_key = ?3",
        params![id, platform, session_key],
        |row| {
            Ok(EditLog {
                id: row.get(0)?,
                platform: row.get(1)?,
                session_key: row.get(2)?,
                edit_target: row.get(3)?,
                old_content: row.get(4)?,
                new_content: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    )
    .map_err(|e| format!("Edit log not found for this session: {e}"))
}

pub fn delete_edit_log(
    conn: &Mutex<Connection>,
    id: i64,
    platform: &str,
    session_key: &str,
) -> Result<bool, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let affected = conn
        .execute(
            "DELETE FROM edit_log WHERE id = ?1 AND platform = ?2 AND session_key = ?3",
            params![id, platform, session_key],
        )
        .map_err(|e| format!("Delete edit log error: {e}"))?;
    Ok(affected > 0)
}

pub fn clear_edit_logs(
    conn: &Mutex<Connection>,
    platform: &str,
    session_key: &str,
) -> Result<usize, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.execute(
        "DELETE FROM edit_log WHERE platform = ?1 AND session_key = ?2",
        params![platform, session_key],
    )
    .map_err(|e| format!("Clear edit logs error: {e}"))
}

// ─── Prompt CRUD ───

pub fn list_prompts(
    conn: &Mutex<Connection>,
    search: Option<&str>,
    tag: Option<&str>,
) -> Result<Vec<Prompt>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut sql = String::from(
        "SELECT id, name, content, tags, use_count, created_at, updated_at FROM prompts WHERE 1=1",
    );

    if search.is_some() {
        sql.push_str(" AND (name LIKE ?1 OR content LIKE ?1)");
    }
    if tag.is_some() {
        let idx = if search.is_some() { 2 } else { 1 };
        sql.push_str(&format!(" AND tags LIKE ?{idx}"));
    }
    sql.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Prepare error: {e}"))?;

    let mut rows = if let (Some(s), Some(t)) = (search, tag) {
        let search_pat = format!("%{s}%");
        let tag_pat = format!("%{t}%");
        stmt.query(params![search_pat, tag_pat])
    } else if let Some(s) = search {
        let search_pat = format!("%{s}%");
        stmt.query(params![search_pat])
    } else if let Some(t) = tag {
        let tag_pat = format!("%{t}%");
        stmt.query(params![tag_pat])
    } else {
        stmt.query([])
    }
    .map_err(|e| format!("Query error: {e}"))?;

    let mut prompts = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        prompts.push(Prompt {
            id: row.get(0).map_err(|e| format!("Row column error: {e}"))?,
            name: row.get(1).map_err(|e| format!("Row column error: {e}"))?,
            content: row.get(2).map_err(|e| format!("Row column error: {e}"))?,
            tags: row.get(3).map_err(|e| format!("Row column error: {e}"))?,
            use_count: row.get(4).map_err(|e| format!("Row column error: {e}"))?,
            created_at: row.get(5).map_err(|e| format!("Row column error: {e}"))?,
            updated_at: row.get(6).map_err(|e| format!("Row column error: {e}"))?,
        });
    }
    Ok(prompts)
}

pub fn create_prompt(conn: &Mutex<Connection>, input: &PromptCreate) -> Result<Prompt, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let tags_str = input.tags.join(",");
    conn.execute(
        "INSERT INTO prompts (name, content, tags) VALUES (?1, ?2, ?3)",
        params![input.name, input.content, tags_str],
    )
    .map_err(|e| format!("Insert error: {e}"))?;

    let id = conn.last_insert_rowid();
    let mut stmt = conn
        .prepare("SELECT id, name, content, tags, use_count, created_at, updated_at FROM prompts WHERE id = ?1")
        .map_err(|e| format!("Prepare error: {e}"))?;

    let prompt = stmt
        .query_row(params![id], |row| {
            Ok(Prompt {
                id: row.get(0)?,
                name: row.get(1)?,
                content: row.get(2)?,
                tags: row.get(3)?,
                use_count: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("Fetch error: {e}"))?;

    Ok(prompt)
}

pub fn update_prompt(
    conn: &Mutex<Connection>,
    id: i64,
    input: &PromptUpdate,
) -> Result<Prompt, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;

    let mut sets = Vec::new();
    let mut param_idx = 1;
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref name) = input.name {
        sets.push(format!("name = ?{param_idx}"));
        param_values.push(Box::new(name.clone()));
        param_idx += 1;
    }
    if let Some(ref content) = input.content {
        sets.push(format!("content = ?{param_idx}"));
        param_values.push(Box::new(content.clone()));
        param_idx += 1;
    }
    if let Some(ref tags) = input.tags {
        sets.push(format!("tags = ?{param_idx}"));
        param_values.push(Box::new(tags.join(",")));
        param_idx += 1;
    }

    if sets.is_empty() {
        return get_prompt(&conn, id);
    }

    sets.push(format!("updated_at = datetime('now')"));

    let sql = format!(
        "UPDATE prompts SET {} WHERE id = ?{param_idx}",
        sets.join(", ")
    );
    param_values.push(Box::new(id));

    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())
        .map_err(|e| format!("Update error: {e}"))?;

    get_prompt(&conn, id)
}

fn get_prompt(conn: &Connection, id: i64) -> Result<Prompt, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, content, tags, use_count, created_at, updated_at FROM prompts WHERE id = ?1")
        .map_err(|e| format!("Prepare error: {e}"))?;

    stmt.query_row(params![id], |row| {
        Ok(Prompt {
            id: row.get(0)?,
            name: row.get(1)?,
            content: row.get(2)?,
            tags: row.get(3)?,
            use_count: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })
    .map_err(|e| format!("Fetch error: {e}"))
}

pub fn delete_prompt(conn: &Mutex<Connection>, id: i64) -> Result<(), String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.execute("DELETE FROM prompts WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete error: {e}"))?;
    Ok(())
}

pub fn increment_prompt_use(conn: &Mutex<Connection>, id: i64) -> Result<Prompt, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    conn.execute(
        "UPDATE prompts SET use_count = use_count + 1, updated_at = datetime('now') WHERE id = ?1",
        params![id],
    )
    .map_err(|e| format!("Update error: {e}"))?;

    // Re-query after releasing is not possible with MutexGuard, so query directly
    let mut stmt = conn
        .prepare("SELECT id, name, content, tags, use_count, created_at, updated_at FROM prompts WHERE id = ?1")
        .map_err(|e| format!("Prepare error: {e}"))?;

    stmt.query_row(params![id], |row| {
        Ok(Prompt {
            id: row.get(0)?,
            name: row.get(1)?,
            content: row.get(2)?,
            tags: row.get(3)?,
            use_count: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })
    .map_err(|e| format!("Fetch error: {e}"))
}

pub fn export_prompts(conn: &Mutex<Connection>) -> Result<Vec<Prompt>, String> {
    list_prompts(conn, None, None)
}

pub fn import_prompts(conn: &Mutex<Connection>, prompts: &[PromptCreate]) -> Result<usize, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut count = 0;
    for p in prompts {
        let tags_str = p.tags.join(",");
        conn.execute(
            "INSERT INTO prompts (name, content, tags) VALUES (?1, ?2, ?3)",
            params![p.name, p.content, tags_str],
        )
        .map_err(|e| format!("Import error: {e}"))?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_log_deletion_is_scoped_to_session() {
        let conn = Connection::open_in_memory().expect("sqlite memory");
        init_tables(&conn).expect("init tables");
        let state = Mutex::new(conn);

        insert_edit_log(&state, "claude", "session-a", "target", "old", "new")
            .expect("insert edit log");
        let log = get_edit_log(&state, "claude", "session-a")
            .expect("list edit log")
            .pop()
            .expect("edit log");

        assert!(!delete_edit_log(&state, log.id, "claude", "session-b").expect("scoped delete"));
        assert!(get_edit_log_by_id_for_session(&state, log.id, "claude", "session-a").is_ok());
        assert!(delete_edit_log(&state, log.id, "claude", "session-a").expect("matching delete"));
    }

    #[test]
    fn remote_mutations_are_persisted_by_device_and_mutation_id() {
        let conn = Connection::open_in_memory().expect("sqlite memory");
        init_tables(&conn).expect("init tables");
        let state = Mutex::new(conn);

        save_remote_mutation(
            &state,
            "device-1",
            "mutation-1",
            "session-edit",
            "request-hash",
            r#"{"mutationId":"mutation-1","applied":true}"#,
        )
        .expect("save mutation");

        let stored = get_remote_mutation(&state, "device-1", "mutation-1")
            .expect("load mutation")
            .expect("stored mutation");
        assert_eq!(stored.operation, "session-edit");
        assert_eq!(stored.request_hash, "request-hash");
        assert!(stored.response_json.contains("mutation-1"));
        assert!(get_remote_mutation(&state, "device-2", "mutation-1")
            .expect("different device lookup")
            .is_none());
    }

    #[test]
    fn session_summary_cache_requires_matching_fingerprint() {
        let conn = Connection::open_in_memory().expect("sqlite memory");
        init_tables(&conn).expect("init tables");
        let conn = Mutex::new(conn);
        let cache = SessionSummaryCache::new(&conn);

        let fingerprint = SessionSummaryFingerprint {
            file_size: 42,
            modified_at: "100".to_string(),
        };
        let summary = CachedSessionSummary {
            session_id: "s1".to_string(),
            title: "title".to_string(),
            preview: "preview".to_string(),
            updated_at: "100".to_string(),
            cwd: "F:\\workspace".to_string(),
        };

        cache
            .upsert("codex", "session.jsonl", &fingerprint, &summary)
            .expect("upsert cache");

        let cached = cache
            .get("codex", "session.jsonl", &fingerprint)
            .expect("cache hit");
        assert_eq!(cached, summary);

        let changed = SessionSummaryFingerprint {
            file_size: 43,
            modified_at: "100".to_string(),
        };
        assert!(cache.get("codex", "session.jsonl", &changed).is_none());
    }

    #[test]
    fn session_content_index_matches_only_valid_fingerprint() {
        let conn = Connection::open_in_memory().expect("sqlite memory");
        init_tables(&conn).expect("init tables");
        let conn = Mutex::new(conn);
        let index = SessionContentIndex::new(&conn);

        let fingerprint = SessionSummaryFingerprint {
            file_size: 42,
            modified_at: "100".to_string(),
        };
        index
            .replace(
                "claude",
                "session.jsonl",
                &fingerprint,
                &[
                    SessionContentEntry::any_text(
                        1,
                        "user",
                        vec!["hello SEARCH target".to_string()],
                    ),
                    SessionContentEntry::any_text(2, "assistant", vec!["unrelated".to_string()]),
                ],
            )
            .expect("replace content index");

        let matches = index
            .get_matches("claude", "session.jsonl", &fingerprint, "search")
            .expect("index hit");
        assert_eq!(
            matches,
            vec![SessionContentEntry::any_text(
                1,
                "user",
                vec!["hello SEARCH target".to_string()],
            )]
        );

        let changed = SessionSummaryFingerprint {
            file_size: 43,
            modified_at: "100".to_string(),
        };
        assert!(index
            .get_matches("claude", "session.jsonl", &changed, "search")
            .is_none());
    }

    #[test]
    fn session_content_index_preserves_empty_valid_index() {
        let conn = Connection::open_in_memory().expect("sqlite memory");
        init_tables(&conn).expect("init tables");
        let conn = Mutex::new(conn);
        let index = SessionContentIndex::new(&conn);

        let fingerprint = SessionSummaryFingerprint {
            file_size: 1,
            modified_at: "200".to_string(),
        };
        index
            .replace("pi", "empty.jsonl", &fingerprint, &[])
            .expect("replace empty content index");

        let matches = index
            .get_matches("pi", "empty.jsonl", &fingerprint, "anything")
            .expect("valid empty index");
        assert!(matches.is_empty());
    }
}
