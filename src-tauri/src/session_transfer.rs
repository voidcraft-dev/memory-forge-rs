use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::atomic_file::write_file_atomic;
use crate::platforms;
use crate::settings::AppSettings;

const SUPPORTED_PLATFORMS: [&str; 3] = ["claude", "codex", "pi"];
const MAX_MARKDOWN_EXPORT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawJsonlImportPreview {
    pub platform: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub preview: String,
    pub detected_at: String,
    pub source_path: String,
    pub target_path: String,
    pub conflict: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawJsonlImportResult {
    pub platform: String,
    pub session_key: String,
    pub session_id: String,
    pub target_path: String,
    pub already_exists: bool,
    pub renamed: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawJsonlExportResult {
    pub platform: String,
    pub source_path: String,
    pub output_path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportConflictPolicy {
    Rename,
    SkipIfSame,
}

pub fn export_markdown(output_path: &str, content: &str) -> Result<(), String> {
    let output = PathBuf::from(output_path);
    let is_markdown = output
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("md"));
    if !is_markdown {
        return Err("Markdown exports must use the .md extension".to_string());
    }
    if content.len() > MAX_MARKDOWN_EXPORT_BYTES {
        return Err(format!(
            "Markdown export exceeds the {MAX_MARKDOWN_EXPORT_BYTES} byte limit"
        ));
    }
    write_file_atomic(&output, content.as_bytes()).map_err(|error| {
        format!(
            "failed to export Markdown to '{}': {error}",
            output.display()
        )
    })
}

#[derive(Default)]
struct ProbeData {
    claude_score: usize,
    codex_score: usize,
    pi_score: usize,
    valid_lines: usize,
    invalid_lines: usize,
    session_id: String,
    cwd: String,
    title: String,
    preview: String,
    timestamp: String,
}

pub fn export_raw_jsonl(
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
    output_path: &str,
) -> Result<RawJsonlExportResult, String> {
    ensure_supported(platform)?;
    let root = platform_root(settings, platform)?;
    let source = source_path(&root, platform, session_key)?;
    ensure_existing_path_within(&source, &root)?;
    if source.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("The selected session is not backed by a JSONL file".to_string());
    }

    let output = PathBuf::from(output_path);
    if output.as_os_str().is_empty() {
        return Err("Output path is empty".to_string());
    }
    let bytes = fs::copy(&source, &output).map_err(|error| {
        format!(
            "failed to export '{}' to '{}': {error}",
            source.display(),
            output.display()
        )
    })?;

    Ok(RawJsonlExportResult {
        platform: platform.to_string(),
        source_path: source.to_string_lossy().to_string(),
        output_path: output.to_string_lossy().to_string(),
        bytes,
    })
}

pub fn probe_jsonl_import(
    settings: &AppSettings,
    platform: &str,
    input_path: &str,
) -> Result<RawJsonlImportPreview, String> {
    ensure_supported(platform)?;
    let input = PathBuf::from(input_path);
    if !input.is_file() {
        return Err(format!("JSONL file not found: {}", input.display()));
    }

    let mut data = probe_file(&input, platform)?;
    if data.session_id.is_empty() {
        data.session_id = input
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("imported-session")
            .to_string();
    }

    let root = platform_root(settings, platform)?;
    let target = target_path(&root, platform, &input, &data)?;
    let mut warnings = Vec::new();
    if data.cwd.is_empty() {
        warnings.push("Session does not contain a working directory".to_string());
    } else if !Path::new(&data.cwd).exists() {
        warnings.push(format!(
            "The original working directory does not exist on this machine: {}",
            data.cwd
        ));
    }
    if data.timestamp.is_empty() {
        warnings.push("Session timestamp is missing; the local file time will be used".to_string());
    }
    if data.invalid_lines > 0 {
        warnings.push(format!(
            "{} non-empty line(s) are not valid JSON and will be preserved unchanged",
            data.invalid_lines
        ));
    }
    if platform == "claude" {
        warnings.push(
            "Claude sessions are imported into projects/imported; Memory Forge can browse them, but CLI resume depends on Claude's project lookup"
                .to_string(),
        );
    }

    let conflict = if target.exists() {
        if files_equal(&input, &target)? {
            Some("same".to_string())
        } else {
            Some("different".to_string())
        }
    } else {
        None
    };

    Ok(RawJsonlImportPreview {
        platform: platform.to_string(),
        session_id: data.session_id,
        cwd: data.cwd,
        title: data.title,
        preview: data.preview,
        detected_at: data.timestamp,
        source_path: input.to_string_lossy().to_string(),
        target_path: target.to_string_lossy().to_string(),
        conflict,
        warnings,
    })
}

pub fn import_raw_jsonl(
    settings: &AppSettings,
    platform: &str,
    input_path: &str,
    conflict_policy: ImportConflictPolicy,
) -> Result<RawJsonlImportResult, String> {
    let preview = probe_jsonl_import(settings, platform, input_path)?;
    let root = platform_root(settings, platform)?;
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "failed to create session root '{}': {error}",
            root.display()
        )
    })?;

    let input = PathBuf::from(input_path);
    let mut target = PathBuf::from(&preview.target_path);
    let mut already_exists = false;
    let mut renamed = false;

    if target.exists() {
        if files_equal(&input, &target)? {
            already_exists = true;
        } else {
            match conflict_policy {
                ImportConflictPolicy::Rename | ImportConflictPolicy::SkipIfSame => {
                    target = renamed_target(&target);
                    renamed = true;
                }
            }
        }
    }

    if !already_exists {
        let parent = target
            .parent()
            .ok_or_else(|| "Import target has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create import directory '{}': {error}",
                parent.display()
            )
        })?;
        ensure_target_within(&target, &root)?;
        fs::copy(&input, &target).map_err(|error| {
            format!(
                "failed to import '{}' to '{}': {error}",
                input.display(),
                target.display()
            )
        })?;
    }

    let session_key = if platform == "pi" {
        let project_key = target
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or("imported");
        let stem = target
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&preview.session_id);
        format!("{project_key}::{stem}")
    } else {
        target.to_string_lossy().to_string()
    };

    Ok(RawJsonlImportResult {
        platform: platform.to_string(),
        session_key,
        session_id: preview.session_id,
        target_path: target.to_string_lossy().to_string(),
        already_exists,
        renamed,
        warnings: preview.warnings,
    })
}

fn ensure_supported(platform: &str) -> Result<(), String> {
    if SUPPORTED_PLATFORMS.contains(&platform) {
        Ok(())
    } else {
        Err(format!(
            "Raw JSONL transfer is not supported for {platform}"
        ))
    }
}

fn platform_root(settings: &AppSettings, platform: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    match platform {
        "claude" => Ok(settings
            .claude_home
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"))
            .join("projects")),
        "codex" => Ok(settings
            .codex_home
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
            .unwrap_or_else(|| home.join(".codex"))
            .join("sessions")),
        "pi" => {
            let pi_home = settings
                .pi_home
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".pi").join("agent"));
            Ok(platforms::pi::default_pi_sessions_root(&pi_home)
                .unwrap_or_else(|| pi_home.join("sessions")))
        }
        _ => Err(format!("Unknown platform: {platform}")),
    }
}

fn source_path(root: &Path, platform: &str, session_key: &str) -> Result<PathBuf, String> {
    if platform != "pi" {
        return Ok(PathBuf::from(session_key));
    }
    let mut parts = session_key.splitn(2, "::");
    let project_key = validated_existing_component(parts.next().unwrap_or_default())?;
    let stem = validated_existing_component(parts.next().unwrap_or_default())?;
    Ok(root.join(project_key).join(format!("{stem}.jsonl")))
}

fn probe_file(input: &Path, platform: &str) -> Result<ProbeData, String> {
    let file = File::open(input)
        .map_err(|error| format!("failed to open '{}': {error}", input.display()))?;
    let mut data = ProbeData::default();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| format!("failed to read JSONL: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            data.invalid_lines += 1;
            continue;
        };
        data.valid_lines += 1;
        score_platforms(&value, &mut data);
        collect_metadata(platform, &value, &mut data);
    }

    if data.valid_lines == 0 {
        return Err("The file does not contain any valid JSONL object".to_string());
    }
    let selected_score = match platform {
        "claude" => data.claude_score,
        "codex" => data.codex_score,
        "pi" => data.pi_score,
        _ => 0,
    };
    if selected_score == 0 {
        return Err(format!("The file does not look like a {platform} session"));
    }
    Ok(data)
}

fn score_platforms(value: &Value, data: &mut ProbeData) {
    if value
        .get("payload")
        .and_then(|item| item.get("type"))
        .is_some()
    {
        data.codex_score += 2;
    }
    if value.get("sessionId").is_some()
        || (value.get("message").is_some()
            && value.get("payload").is_none()
            && value.get("type").is_none())
    {
        data.claude_score += 1;
    }
    if matches!(
        value.get("type").and_then(Value::as_str),
        Some("session" | "session_info" | "message" | "compaction" | "branch_summary")
    ) && value.get("payload").is_none()
    {
        data.pi_score += 1;
    }
}

fn collect_metadata(platform: &str, value: &Value, data: &mut ProbeData) {
    match platform {
        "claude" => {
            set_first(
                &mut data.session_id,
                value.get("sessionId").and_then(Value::as_str),
            );
            set_first(&mut data.cwd, value.get("cwd").and_then(Value::as_str));
            set_first(
                &mut data.timestamp,
                value.get("timestamp").and_then(Value::as_str),
            );
            if let Some(message) = value.get("message") {
                collect_message_preview(message, data);
            }
        }
        "codex" => {
            let Some(payload) = value.get("payload") else {
                return;
            };
            set_first(
                &mut data.session_id,
                payload.get("id").and_then(Value::as_str),
            );
            set_first(&mut data.cwd, payload.get("cwd").and_then(Value::as_str));
            set_first(
                &mut data.timestamp,
                value
                    .get("timestamp")
                    .or_else(|| payload.get("timestamp"))
                    .and_then(Value::as_str),
            );
            if data.preview.is_empty() {
                if let Some(message) = payload.get("message").and_then(Value::as_str) {
                    data.preview = truncate(message, 160);
                    data.title = truncate(message, 80);
                } else if let Some(content) = payload.get("content") {
                    let text = content_text(content);
                    if !text.is_empty() {
                        data.preview = truncate(&text, 160);
                        data.title = truncate(&text, 80);
                    }
                }
            }
        }
        "pi" => match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                set_first(
                    &mut data.session_id,
                    value.get("id").and_then(Value::as_str),
                );
                set_first(&mut data.cwd, value.get("cwd").and_then(Value::as_str));
                set_first(
                    &mut data.timestamp,
                    value.get("timestamp").and_then(Value::as_str),
                );
            }
            Some("session_info") => {
                set_first(&mut data.title, value.get("name").and_then(Value::as_str));
            }
            Some("message") => {
                if let Some(message) = value.get("message") {
                    collect_message_preview(message, data);
                }
                set_first(
                    &mut data.timestamp,
                    value.get("timestamp").and_then(Value::as_str),
                );
            }
            _ => {}
        },
        _ => {}
    }
}

fn collect_message_preview(message: &Value, data: &mut ProbeData) {
    if !data.preview.is_empty() {
        return;
    }
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if role != "user" && role != "assistant" {
        return;
    }
    let text = content_text(message.get("content").unwrap_or(&Value::Null));
    if !text.is_empty() {
        data.preview = truncate(&text, 160);
        if data.title.is_empty() {
            data.title = truncate(&text, 80);
        }
    }
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.trim().to_string();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn target_path(
    root: &Path,
    platform: &str,
    input: &Path,
    data: &ProbeData,
) -> Result<PathBuf, String> {
    let session_id = safe_component(&data.session_id);
    if session_id.is_empty() {
        return Err("Cannot derive a safe session id".to_string());
    }
    let path = match platform {
        "claude" => root.join("imported").join(format!("{session_id}.jsonl")),
        "codex" => {
            let date = parse_date(&data.timestamp)
                .unwrap_or_else(|| Local::now().format("%Y/%m/%d").to_string());
            root.join(date).join(format!("{session_id}.jsonl"))
        }
        "pi" => {
            let timestamp = parse_file_timestamp(&data.timestamp)
                .unwrap_or_else(|| Local::now().format("%Y-%m-%dT%H-%M-%S-000Z").to_string());
            root.join("imported")
                .join(format!("{timestamp}_{session_id}.jsonl"))
        }
        _ => return Err(format!("Unknown platform: {platform}")),
    };
    let _ = input;
    Ok(path)
}

fn parse_date(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.format("%Y/%m/%d").to_string())
}

fn parse_file_timestamp(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string())
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(['.', '-', '_'])
        .chars()
        .take(180)
        .collect()
}

fn validated_existing_component(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
    {
        return Err("Invalid session key path component".to_string());
    }
    Ok(value)
}

fn ensure_existing_path_within(path: &Path, root: &Path) -> Result<(), String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve session path '{}': {error}", path.display()))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve session root '{}': {error}", root.display()))?;
    if path.starts_with(&root) {
        Ok(())
    } else {
        Err("Session path escapes the configured platform root".to_string())
    }
}

fn ensure_target_within(target: &Path, root: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve session root '{}': {error}", root.display()))?;
    let parent = target
        .parent()
        .ok_or_else(|| "Import target has no parent directory".to_string())?
        .canonicalize()
        .map_err(|error| format!("cannot resolve import directory: {error}"))?;
    if parent.starts_with(&root) {
        Ok(())
    } else {
        Err("Import target escapes the configured platform root".to_string())
    }
}

fn file_hash(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("failed to hash '{}': {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash '{}': {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_vec())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_len = left.metadata().map_err(|error| error.to_string())?.len();
    let right_len = right.metadata().map_err(|error| error.to_string())?.len();
    if left_len != right_len {
        return Ok(false);
    }
    Ok(file_hash(left)? == file_hash(right)?)
}

fn renamed_target(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    let suffix = Local::now().format("%Y%m%d%H%M%S");
    let mut candidate = parent.join(format!("{stem}-imported-{suffix}.jsonl"));
    let mut counter = 2usize;
    while candidate.exists() {
        candidate = parent.join(format!("{stem}-imported-{suffix}-{counter}.jsonl"));
        counter += 1;
    }
    candidate
}

fn set_first(target: &mut String, value: Option<&str>) {
    if target.is_empty() {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            *target = value.to_string();
        }
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn probes_three_supported_jsonl_shapes() {
        let claude: Value = serde_json::from_str(
            r#"{"sessionId":"c1","cwd":"C:/work","timestamp":"2026-07-13T01:02:03Z","message":{"role":"user","content":"hello"}}"#,
        )
        .expect("claude json");
        let codex: Value = serde_json::from_str(
            r#"{"timestamp":"2026-07-13T01:02:03Z","payload":{"type":"session_meta","id":"x1","cwd":"C:/work"}}"#,
        )
        .expect("codex json");
        let pi: Value = serde_json::from_str(
            r#"{"type":"session","id":"p1","cwd":"C:/work","timestamp":"2026-07-13T01:02:03Z"}"#,
        )
        .expect("pi json");
        let mut data = ProbeData::default();
        score_platforms(&claude, &mut data);
        score_platforms(&codex, &mut data);
        score_platforms(&pi, &mut data);
        assert!(data.claude_score > 0);
        assert!(data.codex_score > 0);
        assert!(data.pi_score > 0);
    }

    #[test]
    fn safe_component_removes_path_control_characters() {
        assert_eq!(safe_component("../../session:one"), "session-one");
        assert_eq!(safe_component("abc_DEF-123"), "abc_DEF-123");
    }

    #[test]
    fn markdown_export_is_atomic_and_extension_scoped() {
        let temp = std::env::temp_dir().join(format!("memory-forge-markdown-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).expect("create export directory");
        let output = temp.join("session.md");

        export_markdown(output.to_string_lossy().as_ref(), "# First\n")
            .expect("create markdown export");
        export_markdown(output.to_string_lossy().as_ref(), "# Updated\n")
            .expect("replace markdown export");

        assert_eq!(
            fs::read_to_string(&output).expect("read markdown export"),
            "# Updated\n"
        );
        let invalid = temp.join("session.txt");
        assert!(export_markdown(invalid.to_string_lossy().as_ref(), "not markdown").is_err());
        assert!(!invalid.exists());
        fs::remove_dir_all(temp).expect("remove export directory");
    }

    #[test]
    fn claude_import_skips_same_file_and_renames_different_content() {
        let temp = std::env::temp_dir().join(format!("memory-forge-transfer-{}", Uuid::new_v4()));
        let claude_home = temp.join("claude-home");
        fs::create_dir_all(&claude_home).expect("create claude home");
        let input = temp.join("source.jsonl");
        fs::write(
            &input,
            concat!(
                "{\"sessionId\":\"session-1\",\"cwd\":\"C:/missing\",",
                "\"timestamp\":\"2026-07-13T01:02:03Z\",",
                "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n"
            ),
        )
        .expect("write source");

        let mut settings = AppSettings::default();
        settings.claude_home = Some(claude_home.to_string_lossy().to_string());

        let first = import_raw_jsonl(
            &settings,
            "claude",
            input.to_string_lossy().as_ref(),
            ImportConflictPolicy::Rename,
        )
        .expect("first import");
        assert!(!first.already_exists);
        assert!(!first.renamed);
        assert!(Path::new(&first.target_path).is_file());

        let second = import_raw_jsonl(
            &settings,
            "claude",
            input.to_string_lossy().as_ref(),
            ImportConflictPolicy::Rename,
        )
        .expect("same import");
        assert!(second.already_exists);

        fs::write(
            &input,
            concat!(
                "{\"sessionId\":\"session-1\",\"cwd\":\"C:/missing\",",
                "\"timestamp\":\"2026-07-13T01:02:03Z\",",
                "\"message\":{\"role\":\"user\",\"content\":\"changed\"}}\n"
            ),
        )
        .expect("rewrite source");
        let third = import_raw_jsonl(
            &settings,
            "claude",
            input.to_string_lossy().as_ref(),
            ImportConflictPolicy::Rename,
        )
        .expect("conflicting import");
        assert!(third.renamed);
        assert_ne!(third.target_path, first.target_path);
        assert!(Path::new(&third.target_path).is_file());

        fs::remove_dir_all(temp).expect("remove temp dir");
    }
}
