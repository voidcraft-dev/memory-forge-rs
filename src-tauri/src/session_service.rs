use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

use chrono::{Duration, Local, TimeZone};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::database::{self, DbState};
use crate::platforms::{self, SessionDetail, SessionListItem, SessionListResult, TimelineBlock};
use crate::settings::AppSettings;

pub const SESSION_REVISION_CONFLICT: &str = "SESSION_REVISION_CONFLICT";
pub const SESSION_AUDIT_WRITE_FAILED: &str = "SESSION_AUDIT_WRITE_FAILED";
pub const SESSION_AUDIT_ROLLBACK_FAILED: &str = "SESSION_AUDIT_ROLLBACK_FAILED";
pub const SESSION_EDIT_TARGET_MISMATCH: &str = "SESSION_EDIT_TARGET_MISMATCH";

static SESSION_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSummary {
    pub platform: String,
    pub count: usize,
    pub latest: String,
    pub items: Vec<SessionListItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub day: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub platforms: Vec<PlatformSummary>,
    pub trend: Vec<TrendPoint>,
    pub recent_sessions: Vec<SessionListItem>,
}

const DASHBOARD_PLATFORM_NAMES: [&str; 9] = [
    "claude", "codex", "opencode", "grok", "pi", "cursor", "kiro", "kiro-ide", "gemini",
];

pub fn dashboard_summary(db: &DbState, settings: &AppSettings) -> Result<DashboardSummary, String> {
    let t0 = Instant::now();
    let mut platforms_summary = Vec::new();
    let mut recent_sessions = Vec::new();
    let mut trend_map: HashMap<String, usize> = HashMap::new();

    let platform_names = dashboard_platform_names(settings);
    eprintln!(
        "[perf] dashboard_summary visible_platforms={:?}",
        platform_names
    );
    let db_path = db.db_path.clone();
    let settings = settings.clone();
    let platform_results = thread::scope(|scope| {
        let handles: Vec<_> = platform_names
            .iter()
            .map(|platform_name| {
                let db_path = db_path.clone();
                let settings = settings.clone();
                scope.spawn(move || dashboard_platform_summary(&db_path, &settings, platform_name))
            })
            .collect();

        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("dashboard worker panicked".to_string()))
            })
            .collect::<Vec<_>>()
    });

    for result in platform_results {
        let (summary, items) = result?;
        for item in items.iter().take(20) {
            let day = format_timestamp(&item.updated_at);
            if !day.is_empty() {
                *trend_map.entry(day).or_insert(0) += 1;
            }
        }

        recent_sessions.extend(items.iter().take(10).cloned());
        platforms_summary.push(summary);
    }

    recent_sessions.sort_by_key(|item| std::cmp::Reverse(timestamp_sort_key(&item.updated_at)));
    recent_sessions.truncate(10);

    let today = Local::now().date_naive();
    let mut trend = Vec::new();
    for offset in (0..7).rev() {
        let day = today - Duration::days(offset);
        let key = day.format("%Y-%m-%d").to_string();
        trend.push(TrendPoint {
            day: key.clone(),
            count: trend_map.get(&key).copied().unwrap_or(0),
        });
    }

    eprintln!("[perf] dashboard_summary: {:?}", t0.elapsed());
    Ok(DashboardSummary {
        platforms: platforms_summary,
        trend,
        recent_sessions,
    })
}

fn dashboard_platform_names(settings: &AppSettings) -> Vec<&'static str> {
    let visible: HashSet<&str> = settings
        .visible_platforms
        .iter()
        .map(String::as_str)
        .collect();

    DASHBOARD_PLATFORM_NAMES
        .into_iter()
        .filter(|platform_name| visible.contains(platform_name))
        .collect()
}

fn dashboard_platform_summary(
    db_path: &str,
    settings: &AppSettings,
    platform_name: &str,
) -> Result<(PlatformSummary, Vec<SessionListItem>), String> {
    let tp = Instant::now();
    let db = DbState::new(db_path)?;
    let adapter = platforms::get_adapter(platform_name, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform_name)?;
    let archived =
        database::get_flagged_keys(&db.conn, platform_name, "archived").unwrap_or_default();
    let favorites =
        database::get_flagged_keys(&db.conn, platform_name, "favorite").unwrap_or_default();
    let summary_cache = database::SessionSummaryCache::new(&db.conn);
    let result = list_sessions_page(
        adapter.as_ref(),
        &aliases,
        Some(50),
        0,
        &archived,
        &favorites,
        false,
        Some(&summary_cache),
    );
    let total = result.total;
    let items = result.items;
    eprintln!(
        "[perf] dashboard({platform_name}) list ({total} active): {:?}",
        tp.elapsed()
    );

    let summary = PlatformSummary {
        platform: platform_name.to_string(),
        count: total,
        latest: items
            .first()
            .map(|item| format_timestamp(&item.updated_at))
            .unwrap_or_default(),
        items: items.iter().take(5).cloned().collect(),
    };

    Ok((summary, items))
}

pub fn session_list(
    db: &DbState,
    settings: &AppSettings,
    platform: &str,
    query: Option<&str>,
    limit: Option<usize>,
    offset: usize,
    show_archived: bool,
) -> Result<SessionListResult, String> {
    let t0 = Instant::now();
    let adapter = platforms::get_adapter(platform, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform)?;
    let archived = database::get_flagged_keys(&db.conn, platform, "archived").unwrap_or_default();
    let favorites = database::get_flagged_keys(&db.conn, platform, "favorite").unwrap_or_default();
    eprintln!("[perf] session_list({platform}) init: {:?}", t0.elapsed());

    let has_query = query.map(|q| !q.trim().is_empty()).unwrap_or(false);

    // Helper: filter by archive status and annotate favorites
    let apply_flags = |items: Vec<SessionListItem>,
                       archived: &HashSet<String>,
                       favorites: &HashSet<String>,
                       show_archived: bool|
     -> Vec<SessionListItem> {
        items
            .into_iter()
            .filter(|item| {
                let is_archived = archived.contains(&item.session_key);
                if show_archived {
                    is_archived
                } else {
                    !is_archived
                }
            })
            .map(|mut item| {
                item.favorite = favorites.contains(&item.session_key);
                item
            })
            .collect()
    };

    if has_query {
        let t1 = Instant::now();
        let summary_cache = database::SessionSummaryCache::new(&db.conn);
        let content_index = database::SessionContentIndex::new(&db.conn);
        let result = adapter.list_sessions_with_cache(&aliases, None, 0, Some(&summary_cache));
        eprintln!(
            "[perf] session_list({platform}) list_all {} sessions: {:?}",
            result.items.len(),
            t1.elapsed()
        );

        let needle = query.unwrap().trim().to_lowercase();
        let t2 = Instant::now();
        let mut search_count = 0usize;
        let filtered: Vec<SessionListItem> = result
            .items
            .into_iter()
            .filter_map(|item| {
                let title_match = [
                    item.display_title.as_str(),
                    item.preview.as_str(),
                    item.cwd.as_str(),
                    item.session_id.as_str(),
                ]
                .join(" ")
                .to_lowercase()
                .contains(&needle);

                // Skip expensive content_search when title already matches
                if title_match {
                    Some(item)
                } else {
                    search_count += 1;
                    let content_matches = adapter.content_search_with_index(
                        &item.session_key,
                        &needle,
                        Some(&content_index),
                    );
                    if !content_matches.is_empty() {
                        let mut item = item;
                        item.total_content_matches = content_matches.len();
                        item.content_matches = content_matches;
                        Some(item)
                    } else {
                        None
                    }
                }
            })
            .collect();
        let mut filtered = apply_flags(filtered, &archived, &favorites, show_archived);
        eprintln!(
            "[perf] session_list({platform}) content_search x{search_count} -> {} hits: {:?}",
            filtered.len(),
            t2.elapsed()
        );

        let total = filtered.len();
        let start = offset.min(total);
        let end = limit.map(|l| (start + l).min(total)).unwrap_or(total);
        let items = filtered.drain(start..end).collect();

        eprintln!("[perf] session_list({platform}) total: {:?}", t0.elapsed());
        Ok(SessionListResult { total, items })
    } else {
        let t1 = Instant::now();
        // For non-search: load enough to fill the page after filtering
        let summary_cache = database::SessionSummaryCache::new(&db.conn);
        let page_result = list_sessions_page(
            adapter.as_ref(),
            &aliases,
            limit,
            offset,
            &archived,
            &favorites,
            show_archived,
            Some(&summary_cache),
        );
        eprintln!(
            "[perf] session_list({platform}) paginated {} items: {:?}",
            page_result.total,
            t1.elapsed()
        );
        eprintln!("[perf] session_list({platform}) total: {:?}", t0.elapsed());
        schedule_content_index_warmup(
            settings,
            platform,
            &db.db_path,
            page_result
                .items
                .iter()
                .map(|item| item.session_key.clone())
                .collect(),
        );
        Ok(page_result)
    }
}

fn list_sessions_page(
    adapter: &dyn platforms::PlatformAdapter,
    aliases: &HashMap<String, String>,
    limit: Option<usize>,
    offset: usize,
    archived: &HashSet<String>,
    favorites: &HashSet<String>,
    show_archived: bool,
    summary_cache: Option<&database::SessionSummaryCache<'_>>,
) -> SessionListResult {
    if let Some(mut keys) = adapter.list_session_keys() {
        keys.retain(|item| {
            let is_archived = archived.contains(&item.key);
            if show_archived {
                is_archived
            } else {
                !is_archived
            }
        });
        keys.sort_by(|a, b| {
            favorites
                .contains(&b.key)
                .cmp(&favorites.contains(&a.key))
                .then_with(|| b.sort_key.cmp(&a.sort_key))
        });

        let total = keys.len();
        let page_keys: Vec<String> = keys
            .into_iter()
            .skip(offset.min(total))
            .take(limit.unwrap_or(usize::MAX))
            .map(|item| item.key)
            .collect();

        let items = page_keys
            .into_iter()
            .filter_map(|key| adapter.session_list_item(&key, aliases, summary_cache))
            .map(|mut item| {
                item.favorite = favorites.contains(&item.session_key);
                item
            })
            .collect();

        return SessionListResult { total, items };
    }

    let mut items = adapter
        .list_sessions_with_cache(aliases, None, 0, summary_cache)
        .items;
    items = items
        .into_iter()
        .filter(|item| {
            let is_archived = archived.contains(&item.session_key);
            if show_archived {
                is_archived
            } else {
                !is_archived
            }
        })
        .map(|mut item| {
            item.favorite = favorites.contains(&item.session_key);
            item
        })
        .collect();
    items.sort_by(|a, b| b.favorite.cmp(&a.favorite));

    let total = items.len();
    let start = offset.min(total);
    let end = limit.map(|l| (start + l).min(total)).unwrap_or(total);
    let page = items[start..end].to_vec();

    SessionListResult { total, items: page }
}

fn schedule_content_index_warmup(
    settings: &AppSettings,
    platform: &str,
    db_path: &str,
    session_keys: Vec<String>,
) {
    if session_keys.is_empty() || !matches!(platform, "claude" | "codex" | "pi" | "grok") {
        return;
    }

    let settings = settings.clone();
    let platform = platform.to_string();
    let db_path = db_path.to_string();
    thread::spawn(move || {
        let Ok(adapter) = platforms::get_adapter(&platform, &settings) else {
            return;
        };
        let Ok(db) = database::DbState::new(&db_path) else {
            return;
        };
        let index = database::SessionContentIndex::new(&db.conn);
        for session_key in session_keys.into_iter().take(20) {
            let _ = adapter.warm_content_index(&session_key, Some(&index));
        }
    });
}

pub fn session_toggle_flag(
    db: &DbState,
    platform: &str,
    session_key: &str,
    flag: &str,
) -> Result<bool, String> {
    database::toggle_session_flag(&db.conn, platform, session_key, flag)
}

pub fn session_batch_set_flag(
    db: &DbState,
    platform: &str,
    session_keys: &[String],
    flag: &str,
    set: bool,
) -> Result<usize, String> {
    let t0 = Instant::now();
    let affected = database::batch_set_session_flag(&db.conn, platform, session_keys, flag, set)?;
    eprintln!(
        "[perf] session_batch_set_flag({platform}, {flag}, set={set}) {} keys -> {} affected: {:?}",
        session_keys.len(),
        affected,
        t0.elapsed()
    );
    Ok(affected)
}

pub fn session_detail(
    db: &DbState,
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
) -> Result<SessionDetail, String> {
    let t0 = Instant::now();
    let adapter = platforms::get_adapter(platform, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform)?;
    let mut detail = adapter.get_session_detail(session_key, &aliases)?;
    detail.revision = session_revision(&detail.blocks)?;
    eprintln!(
        "[perf] session_detail({platform}) {} blocks: {:?}",
        detail.blocks.len(),
        t0.elapsed()
    );
    Ok(detail)
}

pub fn session_key_exists(
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
) -> Result<bool, String> {
    let adapter = platforms::get_adapter(platform, settings)?;
    if let Some(keys) = adapter.list_session_keys() {
        return Ok(keys.into_iter().any(|item| item.key == session_key));
    }

    let aliases = HashMap::new();
    Ok(adapter
        .list_sessions(&aliases, None, 0)
        .items
        .into_iter()
        .any(|item| item.session_key == session_key))
}

pub fn session_execution_output(
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
    edit_target: &str,
) -> Result<String, String> {
    let t0 = Instant::now();
    let adapter = platforms::get_adapter(platform, settings)?;
    let output = adapter.resolve_execution_output(session_key, edit_target)?;
    eprintln!(
        "[perf] session_execution_output({platform}) chars={}: {:?}",
        output.chars().count(),
        t0.elapsed()
    );
    Ok(output)
}

pub fn session_execution_outputs(
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
    edit_targets: &[String],
) -> Result<std::collections::HashMap<String, String>, String> {
    let t0 = Instant::now();
    let adapter = platforms::get_adapter(platform, settings)?;
    let outputs = adapter.resolve_execution_outputs(session_key, edit_targets)?;
    eprintln!(
        "[perf] session_execution_outputs({platform}) requested={} found={}: {:?}",
        edit_targets.len(),
        outputs.len(),
        t0.elapsed()
    );
    Ok(outputs)
}

pub fn session_set_alias(
    db: &DbState,
    platform: &str,
    session_key: &str,
    title: &str,
) -> Result<database::SessionAlias, String> {
    database::save_alias(&db.conn, platform, session_key, title.trim())
}

pub fn session_edit_message(
    db: &DbState,
    settings: &AppSettings,
    platform: &str,
    edit_target: &str,
    content: &str,
    session_key: &str,
    expected_revision: &str,
) -> Result<(), String> {
    let _mutation_guard = SESSION_MUTATION_LOCK
        .lock()
        .map_err(|_| "Session mutation lock is poisoned".to_string())?;
    let adapter = platforms::get_adapter(platform, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform)?;
    let detail = adapter.get_session_detail(session_key, &aliases)?;
    ensure_expected_revision(&detail.blocks, expected_revision)?;
    let target_belongs_to_session = detail.blocks.iter().any(|block| {
        block.editable
            && (block.edit_target == edit_target
                || (block.edit_target.is_empty() && block.id == edit_target))
    });
    if !target_belongs_to_session {
        return Err(SESSION_EDIT_TARGET_MISMATCH.to_string());
    }
    let old_content = adapter.update_message(edit_target, content)?;
    if let Err(audit_error) = database::insert_edit_log(
        &db.conn,
        platform,
        session_key,
        edit_target,
        &old_content,
        content,
    ) {
        return match adapter.update_message(edit_target, &old_content) {
            Ok(_) => Err(format!("{SESSION_AUDIT_WRITE_FAILED}: {audit_error}")),
            Err(rollback_error) => Err(format!(
                "{SESSION_AUDIT_WRITE_FAILED}: {audit_error}; {SESSION_AUDIT_ROLLBACK_FAILED}: {rollback_error}"
            )),
        };
    }
    Ok(())
}

pub fn session_edit_log(
    db: &DbState,
    platform: &str,
    session_key: &str,
) -> Result<Vec<database::EditLog>, String> {
    database::get_edit_log(&db.conn, platform, session_key)
}

pub fn session_delete_edit_log(
    db: &DbState,
    platform: &str,
    session_key: &str,
    edit_log_id: i64,
) -> Result<bool, String> {
    database::delete_edit_log(&db.conn, edit_log_id, platform, session_key)
}

pub fn session_clear_edit_logs(
    db: &DbState,
    platform: &str,
    session_key: &str,
) -> Result<usize, String> {
    database::clear_edit_logs(&db.conn, platform, session_key)
}

pub fn session_restore_message(
    db: &DbState,
    settings: &AppSettings,
    platform: &str,
    edit_log_id: i64,
    session_key: &str,
    expected_revision: &str,
) -> Result<(), String> {
    let log =
        database::get_edit_log_by_id_for_session(&db.conn, edit_log_id, platform, session_key)?;
    session_edit_message(
        db,
        settings,
        platform,
        &log.edit_target,
        &log.old_content,
        session_key,
        expected_revision,
    )
}

pub fn session_revision(blocks: &[TimelineBlock]) -> Result<String, String> {
    let serialized = serde_json::to_vec(blocks)
        .map_err(|error| format!("Failed to serialize session revision: {error}"))?;
    let digest = Sha256::digest(serialized);
    Ok(format!("{digest:x}"))
}

fn ensure_expected_revision(
    blocks: &[TimelineBlock],
    expected_revision: &str,
) -> Result<(), String> {
    let current_revision = session_revision(blocks)?;
    if current_revision != expected_revision {
        return Err(SESSION_REVISION_CONFLICT.to_string());
    }
    Ok(())
}

fn format_timestamp(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }

    let Ok(mut number) = text.parse::<i128>() else {
        return text.to_string();
    };

    if number > 100_000_000_000_000_000 {
        number /= 1_000_000_000;
    } else if number > 1_000_000_000_000_000 {
        number /= 1_000_000;
    } else if number > 1_000_000_000_000 {
        number /= 1_000;
    }

    let Some(date_time) = Local.timestamp_opt(number as i64, 0).single() else {
        return String::new();
    };

    date_time.format("%Y-%m-%d").to_string()
}

fn timestamp_sort_key(value: &str) -> i128 {
    let text = value.trim();
    if text.is_empty() {
        return 0;
    }

    let Ok(mut number) = text.parse::<i128>() else {
        return 0;
    };

    if number > 100_000_000_000_000_000 {
        number /= 1_000_000_000;
    } else if number > 1_000_000_000_000_000 {
        number /= 1_000_000;
    } else if number > 1_000_000_000_000 {
        number /= 1_000;
    }

    number
}

#[allow(dead_code)]
fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "memory-forge-session-service-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_block(content: &str) -> TimelineBlock {
        TimelineBlock {
            id: "message-1".to_string(),
            role: "user".to_string(),
            content: content.to_string(),
            editable: true,
            edit_target: "session::message-1".to_string(),
            source_meta: serde_json::json!({ "index": 1 }),
            tool_calls: Vec::new(),
        }
    }

    #[test]
    fn dashboard_platform_names_only_include_visible_supported_platforms() {
        let settings = AppSettings {
            visible_platforms: vec![
                "gemini".to_string(),
                "unknown".to_string(),
                "claude".to_string(),
                "pi".to_string(),
            ],
            ..AppSettings::default()
        };

        assert_eq!(
            dashboard_platform_names(&settings),
            vec!["claude", "pi", "gemini"]
        );
    }

    #[test]
    fn dashboard_platform_names_can_be_empty_when_all_platforms_are_hidden() {
        let settings = AppSettings {
            visible_platforms: Vec::new(),
            ..AppSettings::default()
        };

        assert!(dashboard_platform_names(&settings).is_empty());
    }

    #[test]
    fn session_revision_is_stable_and_content_sensitive() {
        let original = vec![test_block("before")];
        let same = vec![test_block("before")];
        let changed = vec![test_block("after")];

        let original_revision = session_revision(&original).expect("original revision");
        let same_revision = session_revision(&same).expect("same revision");
        let changed_revision = session_revision(&changed).expect("changed revision");

        assert_eq!(original_revision, same_revision);
        assert_ne!(original_revision, changed_revision);
        assert_eq!(original_revision.len(), 64);
        assert!(original_revision
            .chars()
            .all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn stale_session_revision_is_rejected() {
        let blocks = vec![test_block("current")];
        let current_revision = session_revision(&blocks).expect("current revision");

        assert!(ensure_expected_revision(&blocks, &current_revision).is_ok());
        assert_eq!(
            ensure_expected_revision(&blocks, "stale").expect_err("stale revision must fail"),
            SESSION_REVISION_CONFLICT
        );
    }

    #[test]
    fn stale_edit_does_not_overwrite_session_or_add_audit_log() {
        let dir = TestDir::new();
        let session_path = dir.path().join("session.jsonl");
        let session_key = session_path.to_string_lossy().into_owned();
        let row = serde_json::json!({
            "sessionId": "session-1",
            "cwd": dir.path(),
            "message": {
                "role": "user",
                "content": "before"
            }
        });
        fs::write(&session_path, format!("{row}\n")).expect("write test session");

        let db = DbState::new(":memory:").expect("create in-memory database");
        {
            let conn = db.conn.lock().expect("lock database");
            database::init_tables(&conn).expect("initialize database");
        }
        let settings = AppSettings {
            claude_home: Some(dir.path().to_string_lossy().into_owned()),
            ..AppSettings::default()
        };

        let original =
            session_detail(&db, &settings, "claude", &session_key).expect("load original detail");
        assert_eq!(original.blocks.len(), 1);
        let edit_target = original.blocks[0].edit_target.clone();

        session_edit_message(
            &db,
            &settings,
            "claude",
            &edit_target,
            "first edit",
            &session_key,
            &original.revision,
        )
        .expect("apply first edit");

        let updated =
            session_detail(&db, &settings, "claude", &session_key).expect("load updated detail");
        assert_eq!(updated.blocks[0].content, "first edit");
        assert_ne!(updated.revision, original.revision);

        let error = session_edit_message(
            &db,
            &settings,
            "claude",
            &edit_target,
            "stale overwrite",
            &session_key,
            &original.revision,
        )
        .expect_err("stale edit must fail");
        assert_eq!(error, SESSION_REVISION_CONFLICT);

        let final_detail =
            session_detail(&db, &settings, "claude", &session_key).expect("load final detail");
        assert_eq!(final_detail.blocks[0].content, "first edit");

        let outside_path = dir.path().join("outside.jsonl");
        let outside_key = outside_path.to_string_lossy().into_owned();
        let outside_row = serde_json::json!({
            "sessionId": "outside-session",
            "cwd": dir.path(),
            "message": {
                "role": "user",
                "content": "outside before"
            }
        });
        fs::write(&outside_path, format!("{outside_row}\n")).expect("write outside session");
        let outside =
            session_detail(&db, &settings, "claude", &outside_key).expect("load outside detail");
        let mismatched_target = session_edit_message(
            &db,
            &settings,
            "claude",
            &outside.blocks[0].edit_target,
            "must not cross sessions",
            &session_key,
            &final_detail.revision,
        )
        .expect_err("cross-session target must fail");
        assert_eq!(mismatched_target, SESSION_EDIT_TARGET_MISMATCH);
        let outside_after =
            session_detail(&db, &settings, "claude", &outside_key).expect("reload outside detail");
        assert_eq!(outside_after.blocks[0].content, "outside before");

        let logs = session_edit_log(&db, "claude", &session_key).expect("load edit log");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].new_content, "first edit");
    }

    #[test]
    fn audit_failure_rolls_back_session_content() {
        let dir = TestDir::new();
        let session_path = dir.path().join("session.jsonl");
        let session_key = session_path.to_string_lossy().into_owned();
        let row = serde_json::json!({
            "sessionId": "session-1",
            "cwd": dir.path(),
            "message": {
                "role": "user",
                "content": "before"
            }
        });
        fs::write(&session_path, format!("{row}\n")).expect("write test session");

        let db = DbState::new(":memory:").expect("create in-memory database");
        {
            let conn = db.conn.lock().expect("lock database");
            database::init_tables(&conn).expect("initialize database");
        }
        let settings = AppSettings {
            claude_home: Some(dir.path().to_string_lossy().into_owned()),
            ..AppSettings::default()
        };
        let original =
            session_detail(&db, &settings, "claude", &session_key).expect("load original detail");
        let edit_target = original.blocks[0].edit_target.clone();
        {
            let conn = db.conn.lock().expect("lock database");
            conn.execute("DROP TABLE edit_log", [])
                .expect("disable audit table");
        }

        let error = session_edit_message(
            &db,
            &settings,
            "claude",
            &edit_target,
            "must be rolled back",
            &session_key,
            &original.revision,
        )
        .expect_err("audit failure must fail the edit");

        assert!(error.starts_with(SESSION_AUDIT_WRITE_FAILED));
        assert!(!error.contains(SESSION_AUDIT_ROLLBACK_FAILED));
        let final_detail =
            session_detail(&db, &settings, "claude", &session_key).expect("load final detail");
        assert_eq!(final_detail.blocks[0].content, "before");
        assert_eq!(final_detail.revision, original.revision);
    }
}
