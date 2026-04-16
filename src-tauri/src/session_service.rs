use std::collections::{HashMap, HashSet};
use std::path::Path;
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

pub fn dashboard_summary(db: &DbState, settings: &AppSettings) -> Result<DashboardSummary, String> {
    let t0 = Instant::now();
    let mut platforms_summary = Vec::new();
    let mut recent_sessions = Vec::new();
    let mut trend_map: HashMap<String, usize> = HashMap::new();

    for platform_name in ["claude", "codex", "opencode", "kiro"] {
        let tp = Instant::now();
        let adapter = platforms::get_adapter(platform_name, settings)?;
        let aliases = database::get_alias_map(&db.conn, platform_name)?;
        let archived = database::get_flagged_keys(&db.conn, platform_name, "archived").unwrap_or_default();
        let favorites = database::get_flagged_keys(&db.conn, platform_name, "favorite").unwrap_or_default();
        let result = adapter.list_sessions(&aliases, Some(50), 0);
        // Filter out archived, annotate favorites, take top 20
        let items: Vec<SessionListItem> = result.items.into_iter()
            .filter(|item| !archived.contains(&item.session_key))
            .map(|mut item| { item.favorite = favorites.contains(&item.session_key); item })
            .collect();
        let total = result.total.saturating_sub(archived.len());
        eprintln!("[perf] dashboard({platform_name}) list ({total} active): {:?}", tp.elapsed());

        for item in items.iter().take(20) {
            let day = format_timestamp(&item.updated_at);
            if !day.is_empty() {
                *trend_map.entry(day).or_insert(0) += 1;
            }
        }

        recent_sessions.extend(items.iter().take(10).cloned());

        platforms_summary.push(PlatformSummary {
            platform: platform_name.to_string(),
            count: total,
            latest: items
                .first()
                .map(|item| format_timestamp(&item.updated_at))
                .unwrap_or_default(),
            items: items.into_iter().take(5).collect(),
        });
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
    let apply_flags = |items: Vec<SessionListItem>, archived: &HashSet<String>, favorites: &HashSet<String>, show_archived: bool| -> Vec<SessionListItem> {
        items.into_iter()
            .filter(|item| {
                let is_archived = archived.contains(&item.session_key);
                if show_archived { is_archived } else { !is_archived }
            })
            .map(|mut item| {
                item.favorite = favorites.contains(&item.session_key);
                item
            })
            .collect()
    };

    if has_query {
        let t1 = Instant::now();
        let result = adapter.list_sessions(&aliases, None, 0);
        eprintln!("[perf] session_list({platform}) list_all {} sessions: {:?}", result.items.len(), t1.elapsed());

        let needle = query.unwrap().trim().to_lowercase();
        let t2 = Instant::now();
        let mut search_count = 0usize;
        let mut filtered: Vec<SessionListItem> = result.items.into_iter().filter_map(|item| {
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
                let content_matches = adapter.content_search(&item.session_key, &needle);
                if !content_matches.is_empty() {
                    let mut item = item;
                    item.total_content_matches = content_matches.len();
                    item.content_matches = content_matches.into_iter().take(3).collect();
                    Some(item)
                } else {
                    None
                }
            }
        }).collect();
        let mut filtered = apply_flags(filtered, &archived, &favorites, show_archived);
        eprintln!("[perf] session_list({platform}) content_search x{search_count} -> {} hits: {:?}", filtered.len(), t2.elapsed());

        let total = filtered.len();
        let start = offset.min(total);
        let end = limit.map(|l| (start + l).min(total)).unwrap_or(total);
        let items = filtered.drain(start..end).collect();

        eprintln!("[perf] session_list({platform}) total: {:?}", t0.elapsed());
        Ok(SessionListResult { total, items })
    } else {
        let t1 = Instant::now();
        // For non-search: load enough to fill the page after filtering
        let result = adapter.list_sessions(&aliases, None, 0);
        let mut items = apply_flags(result.items, &archived, &favorites, show_archived);
        // Sort: favorites first
        items.sort_by(|a, b| b.favorite.cmp(&a.favorite));
        let total = items.len();
        let start = offset.min(total);
        let end = limit.map(|l| (start + l).min(total)).unwrap_or(total);
        let page = items[start..end].to_vec();
        eprintln!("[perf] session_list({platform}) paginated {total} items: {:?}", t1.elapsed());
        eprintln!("[perf] session_list({platform}) total: {:?}", t0.elapsed());
        Ok(SessionListResult { total, items: page })
    }
}

pub fn session_toggle_flag(
    db: &DbState,
    platform: &str,
    session_key: &str,
    flag: &str,
) -> Result<bool, String> {
    database::toggle_session_flag(&db.conn, platform, session_key, flag)
}

pub fn session_detail(db: &DbState, settings: &AppSettings, platform: &str, session_key: &str) -> Result<SessionDetail, String> {
    let t0 = Instant::now();
    let adapter = platforms::get_adapter(platform, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform)?;
    let detail = adapter.get_session_detail(session_key, &aliases)?;
    eprintln!("[perf] session_detail({platform}) {} blocks: {:?}", detail.blocks.len(), t0.elapsed());
    Ok(detail)
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
    database::insert_edit_log(&db.conn, platform, session_key, edit_target, &old_content, content)
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
    session_edit_message(db, settings, platform, &log.edit_target, &log.old_content, session_key)
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
