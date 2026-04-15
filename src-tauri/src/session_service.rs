use std::collections::HashMap;
use std::path::Path;

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
    let mut platforms_summary = Vec::new();
    let mut recent_sessions = Vec::new();
    let mut trend_map: HashMap<String, usize> = HashMap::new();

    for platform_name in ["claude", "codex", "opencode"] {
        let adapter = platforms::get_adapter(platform_name, settings)?;
        let aliases = database::get_alias_map(&db.conn, platform_name)?;
        let result = adapter.list_sessions(&aliases, Some(20), 0);

        for item in result.items.iter().take(20) {
            let day = format_timestamp(&item.updated_at);
            if !day.is_empty() {
                *trend_map.entry(day).or_insert(0) += 1;
            }
        }

        recent_sessions.extend(result.items.iter().take(10).cloned());

        platforms_summary.push(PlatformSummary {
            platform: platform_name.to_string(),
            count: result.total,
            latest: result.items
                .first()
                .map(|item| format_timestamp(&item.updated_at))
                .unwrap_or_default(),
            items: result.items.into_iter().take(5).collect(),
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
) -> Result<SessionListResult, String> {
    let adapter = platforms::get_adapter(platform, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform)?;

    let has_query = query.map(|q| !q.trim().is_empty()).unwrap_or(false);

    if has_query {
        // Search: load all, filter, then paginate
        let result = adapter.list_sessions(&aliases, None, 0);
        let needle = query.unwrap().trim().to_lowercase();
        let mut filtered: Vec<SessionListItem> = result.items.into_iter().filter(|item| {
            [
                item.display_title.as_str(),
                item.preview.as_str(),
                item.cwd.as_str(),
                item.session_id.as_str(),
            ]
            .join(" ")
            .to_lowercase()
            .contains(&needle)
                || adapter.matches_query(&item.session_key, &needle)
        }).collect();

        let total = filtered.len();
        let start = offset.min(total);
        let end = limit.map(|l| (start + l).min(total)).unwrap_or(total);
        let items = filtered.drain(start..end).collect();

        Ok(SessionListResult { total, items })
    } else {
        // No search: use backend pagination directly
        Ok(adapter.list_sessions(&aliases, limit, offset))
    }
}

pub fn session_detail(db: &DbState, settings: &AppSettings, platform: &str, session_key: &str) -> Result<SessionDetail, String> {
    let adapter = platforms::get_adapter(platform, settings)?;
    let aliases = database::get_alias_map(&db.conn, platform)?;
    adapter.get_session_detail(session_key, &aliases)
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
