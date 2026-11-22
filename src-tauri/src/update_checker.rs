use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;

const GITHUB_API_URL: &str =
    "https://api.github.com/repos/voidcraft-dev/memory-forge-rs/releases/latest";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub release_notes: String,
    pub published_at: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
}

/// Compare two semver-ish version strings (e.g. "3.0.8" vs "3.1.0").
/// Returns true if `latest` is newer than `current`.
fn is_newer(current: &str, latest: &str) -> bool {
    compare_versions(latest, current) == Ordering::Greater
}

fn compare_versions(a: &str, b: &str) -> Ordering {
    let split = |v: &str| -> (Vec<u64>, Option<String>) {
        let (core, pre) = match v.split_once('-') {
            Some((core, pre)) => (core, Some(pre.to_string())),
            None => (v, None),
        };
        let numbers = core.split('.').filter_map(|s| s.parse::<u64>().ok()).collect();
        (numbers, pre)
    };
    let (a_core, a_pre) = split(a);
    let (b_core, b_pre) = split(b);
    for i in 0..a_core.len().max(b_core.len()) {
        let ordering = a_core
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&b_core.get(i).copied().unwrap_or(0));
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => compare_prerelease(&a, &b),
    }
}

fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let a_parts: Vec<&str> = a.split('.').collect();
    let b_parts: Vec<&str> = b.split('.').collect();
    for (x, y) in a_parts.iter().zip(b_parts.iter()) {
        let ordering = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    a_parts.len().cmp(&b_parts.len())
}

pub fn check_update(current_version: &str) -> Result<UpdateInfo, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("memory-forge-update-checker")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let release: GitHubRelease = client
        .get(GITHUB_API_URL)
        .send()
        .map_err(|e| format!("Network error: {e}"))?
        .json()
        .map_err(|e| format!("Parse error: {e}"))?;

    let latest = release.tag_name.trim_start_matches('v');
    let has_update = is_newer(current_version, latest);

    Ok(UpdateInfo {
        has_update,
        current_version: current_version.to_string(),
        latest_version: latest.to_string(),
        release_url: release.html_url,
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_newer() {
        assert!(is_newer("3.0.8", "3.0.9"));
        assert!(is_newer("3.0.8", "3.1.0"));
        assert!(is_newer("3.0.8", "4.0.0"));
        assert!(!is_newer("3.0.8", "3.0.8"));
        assert!(!is_newer("3.0.9", "3.0.8"));
        assert!(!is_newer("4.0.0", "3.9.9"));
        assert!(is_newer("4.0.0-beta.1", "4.0.0"));
        assert!(is_newer("4.0.0-beta.1", "4.0.0-beta.2"));
        assert!(is_newer("4.0.0-beta.9", "4.0.0-beta.10"));
        assert!(!is_newer("4.0.0", "4.0.0-beta.1"));
        assert!(!is_newer("4.0.0-beta.1", "3.9.0"));
        assert!(!is_newer("4.0.0-beta.1", "4.0.0-beta.1"));
    }
}
