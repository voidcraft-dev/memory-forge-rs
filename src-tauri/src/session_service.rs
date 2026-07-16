use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::thread;
use std::time::Instant;

use chrono::{Duration, Local, TimeZone};
use serde::Serialize;

use crate::database::{self, DbState};
use crate::platforms::{self, SessionDetail, SessionListItem, SessionListResult};
use crate::settings::AppSettings;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawJsonlExportResult {
    pub platform: String,
    pub session_key: String,
    pub source_path: String,
    pub output_path: String,
    pub bytes: u64,
}

const DASHBOARD_PLATFORM_NAMES: [&str; 8] = [
    "claude", "codex", "opencode", "pi", "cursor", "kiro", "kiro-ide", "gemini",
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
    if session_keys.is_empty() || !matches!(platform, "claude" | "codex" | "pi") {
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
    let detail = adapter.get_session_detail(session_key, &aliases)?;
    eprintln!(
        "[perf] session_detail({platform}) {} blocks: {:?}",
        detail.blocks.len(),
        t0.elapsed()
    );
    Ok(detail)
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

pub fn session_export_raw_jsonl(
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
    output_path: &str,
) -> Result<RawJsonlExportResult, String> {
    let t0 = Instant::now();
    if !matches!(platform, "claude" | "codex" | "pi") {
        return Err(format!(
            "Raw JSONL export is not supported for platform: {platform}"
        ));
    }

    let output = Path::new(output_path);
    if output.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err("Raw JSONL export output must use a .jsonl extension".to_string());
    }

    let adapter = platforms::get_adapter(platform, settings)?;
    let source = adapter.raw_jsonl_path(session_key)?;
    let bytes = std::fs::copy(&source, output)
        .map_err(|error| format!("Failed to export raw JSONL: {error}"))?;

    eprintln!(
        "[perf] session_export_raw_jsonl({platform}) {bytes} bytes: {:?}",
        t0.elapsed()
    );
    Ok(RawJsonlExportResult {
        platform: platform.to_string(),
        session_key: session_key.to_string(),
        source_path: source.display().to_string(),
        output_path: output.display().to_string(),
        bytes,
    })
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
) -> Result<(), String> {
    let adapter = platforms::get_adapter(platform, settings)?;
    let old_content = adapter.update_message(edit_target, content)?;
    database::insert_edit_log(
        &db.conn,
        platform,
        session_key,
        edit_target,
        &old_content,
        content,
    )
}

pub fn session_edit_log(
    db: &DbState,
    platform: &str,
    session_key: &str,
) -> Result<Vec<database::EditLog>, String> {
    database::get_edit_log(&db.conn, platform, session_key)
}

pub fn session_restore_message(
    db: &DbState,
    settings: &AppSettings,
    platform: &str,
    edit_log_id: i64,
    session_key: &str,
) -> Result<(), String> {
    let log = database::get_edit_log_by_id(&db.conn, edit_log_id)?;
    session_edit_message(
        db,
        settings,
        platform,
        &log.edit_target,
        &log.old_content,
        session_key,
    )
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "memory-forge-export-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn write_session(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, content).expect("write session");
    }

    #[test]
    fn raw_jsonl_export_copies_supported_platform_files_without_rewriting() {
        let root = temp_root("supported");
        let claude_home = root.join("claude");
        let codex_home = root.join("codex");
        let pi_home = root.join("pi");

        let claude_session = claude_home
            .join("projects")
            .join("proj")
            .join("claude-session.jsonl");
        let codex_session = codex_home
            .join("sessions")
            .join("2026")
            .join("06")
            .join("06")
            .join("codex-session.jsonl");
        let pi_session = pi_home
            .join("sessions")
            .join("proj")
            .join("2026-06-06T01-02-03-004Z_pi-session.jsonl");

        let claude_raw =
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
        let codex_raw = "{\"payload\":{\"type\":\"user_message\",\"message\":\"hello codex\"}}\n";
        let pi_raw =
            "{\"type\":\"session\",\"id\":\"pi-session\"}\n{\"type\":\"message\",\"id\":\"m1\",\"message\":{\"role\":\"user\",\"content\":\"hello pi\"}}\n";
        write_session(&claude_session, claude_raw);
        write_session(&codex_session, codex_raw);
        write_session(&pi_session, pi_raw);

        let previous_pi_sessions = std::env::var_os("PI_CODING_AGENT_SESSION_DIR");
        std::env::remove_var("PI_CODING_AGENT_SESSION_DIR");

        let settings = AppSettings {
            claude_home: Some(claude_home.display().to_string()),
            codex_home: Some(codex_home.display().to_string()),
            pi_home: Some(pi_home.display().to_string()),
            ..AppSettings::default()
        };

        let claude_out = root.join("claude-export.jsonl");
        let codex_out = root.join("codex-export.jsonl");
        let pi_out = root.join("pi-export.jsonl");

        let claude_result = session_export_raw_jsonl(
            &settings,
            "claude",
            claude_session.to_str().expect("utf8 path"),
            claude_out.to_str().expect("utf8 path"),
        )
        .expect("export claude");
        let codex_result = session_export_raw_jsonl(
            &settings,
            "codex",
            codex_session.to_str().expect("utf8 path"),
            codex_out.to_str().expect("utf8 path"),
        )
        .expect("export codex");
        let pi_result = session_export_raw_jsonl(
            &settings,
            "pi",
            "proj::2026-06-06T01-02-03-004Z_pi-session",
            pi_out.to_str().expect("utf8 path"),
        )
        .expect("export pi");

        assert_eq!(
            fs::read_to_string(&claude_out).expect("read claude"),
            claude_raw
        );
        assert_eq!(
            fs::read_to_string(&codex_out).expect("read codex"),
            codex_raw
        );
        assert_eq!(fs::read_to_string(&pi_out).expect("read pi"), pi_raw);
        assert_eq!(claude_result.bytes, claude_raw.len() as u64);
        assert_eq!(codex_result.bytes, codex_raw.len() as u64);
        assert_eq!(pi_result.bytes, pi_raw.len() as u64);

        if let Some(value) = previous_pi_sessions {
            std::env::set_var("PI_CODING_AGENT_SESSION_DIR", value);
        } else {
            std::env::remove_var("PI_CODING_AGENT_SESSION_DIR");
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn raw_jsonl_export_rejects_unsupported_platform_and_non_jsonl_output() {
        let root = temp_root("rejects");
        fs::create_dir_all(&root).expect("create root");
        let settings = AppSettings::default();

        let unsupported = session_export_raw_jsonl(
            &settings,
            "opencode",
            "session",
            root.join("out.jsonl").to_str().expect("utf8 path"),
        )
        .expect_err("unsupported platform");
        assert!(unsupported.contains("not supported"));

        let wrong_extension = session_export_raw_jsonl(
            &settings,
            "claude",
            "session.jsonl",
            root.join("out.md").to_str().expect("utf8 path"),
        )
        .expect_err("wrong extension");
        assert!(wrong_extension.contains(".jsonl"));

        let _ = fs::remove_dir_all(root);
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
}
