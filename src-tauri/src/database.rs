use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

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
}

impl DbState {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open database: {e}"))?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("Failed to set pragmas: {e}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
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

// ─── Edit Log ───

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
        "
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
        .query_row("SELECT id FROM prompts WHERE name = ?1", params![name], |row| row.get::<_, i64>(0))
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

pub fn get_alias_map(conn: &Mutex<Connection>, platform: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT session_key, title FROM session_aliases WHERE platform = ?1")
        .map_err(|e| format!("Prepare error: {e}"))?;
    let mut rows = stmt.query(params![platform]).map_err(|e| format!("Query error: {e}"))?;
    let mut map = std::collections::HashMap::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {e}"))? {
        let key: String = row.get(0).map_err(|e| format!("Row column error: {e}"))?;
        let title: String = row.get(1).map_err(|e| format!("Row column error: {e}"))?;
        map.insert(key, title);
    }
    Ok(map)
}

pub fn save_alias(conn: &Mutex<Connection>, platform: &str, session_key: &str, title: &str) -> Result<SessionAlias, String> {
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

pub fn get_edit_log(conn: &Mutex<Connection>, platform: &str, session_key: &str) -> Result<Vec<EditLog>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT id, platform, session_key, edit_target, old_content, new_content, created_at FROM edit_log WHERE platform = ?1 AND session_key = ?2 ORDER BY id DESC")
        .map_err(|e| format!("Prepare error: {e}"))?;
    let mut rows = stmt.query(params![platform, session_key]).map_err(|e| format!("Query error: {e}"))?;
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

// ─── Prompt CRUD ───

pub fn list_prompts(conn: &Mutex<Connection>, search: Option<&str>, tag: Option<&str>) -> Result<Vec<Prompt>, String> {
    let conn = conn.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut sql = String::from("SELECT id, name, content, tags, use_count, created_at, updated_at FROM prompts WHERE 1=1");

    if search.is_some() {
        sql.push_str(" AND (name LIKE ?1 OR content LIKE ?1)");
    }
    if tag.is_some() {
        let idx = if search.is_some() { 2 } else { 1 };
        sql.push_str(&format!(" AND tags LIKE ?{idx}"));
    }
    sql.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Prepare error: {e}"))?;

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

pub fn update_prompt(conn: &Mutex<Connection>, id: i64, input: &PromptUpdate) -> Result<Prompt, String> {
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

    let sql = format!("UPDATE prompts SET {} WHERE id = ?{param_idx}", sets.join(", "));
    param_values.push(Box::new(id));

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
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
