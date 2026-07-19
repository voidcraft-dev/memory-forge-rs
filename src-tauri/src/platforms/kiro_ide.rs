use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::atomic_file::replace_existing_file_atomic;

use super::{
    build_commands, extract_snippet, ContentMatch, PlatformAdapter, SessionDetail, SessionListItem,
    SessionListResult, TimelineBlock,
};

const EXECUTION_LOG_SCAN_MAX_BYTES: u64 = 8 * 1024 * 1024;
const EXECUTION_LOG_DEEP_SCAN_MAX_BYTES: u64 = 64 * 1024 * 1024;
const EXECUTION_LOG_SCAN_MAX_MILLIS: u128 = 1_500;
const EXECUTION_LOG_DEEP_SCAN_MAX_MILLIS: u128 = 20_000;
const EXECUTION_LOG_SCAN_FALLBACK_MAX_FILES: usize = 256;

pub struct KiroIdePlatform {
    agent_home: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KiroIdeSessionIndex {
    session_id: String,
    title: String,
    date_created: String,
    workspace_directory: String,
}

impl KiroIdePlatform {
    pub fn new(agent_home: PathBuf) -> Self {
        Self { agent_home }
    }

    fn workspace_sessions_dir(&self) -> PathBuf {
        self.agent_home.join("workspace-sessions")
    }

    fn session_path(&self, workspace_key: &str, session_id: &str) -> PathBuf {
        self.workspace_sessions_dir()
            .join(workspace_key)
            .join(format!("{session_id}.json"))
    }

    fn index_path(&self, workspace_key: &str) -> PathBuf {
        self.workspace_sessions_dir()
            .join(workspace_key)
            .join("sessions.json")
    }

    fn read_index(&self, workspace_key: &str) -> Vec<KiroIdeSessionIndex> {
        let raw = fs::read_to_string(self.index_path(workspace_key)).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    }

    fn collect_workspace_keys(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.workspace_sessions_dir()) else {
            return Vec::new();
        };

        entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_dir() {
                    return None;
                }
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
            })
            .collect()
    }

    fn read_session_json(&self, workspace_key: &str, session_id: &str) -> Result<Value, String> {
        let path = self.session_path(workspace_key, session_id);
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read Kiro IDE session '{}': {e}", path.display()))?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse Kiro IDE session '{}': {e}", path.display()))
    }

    fn execution_log_files(&self, workspace_dir: Option<&str>) -> Vec<PathBuf> {
        let mut files = Vec::new();

        if let Some(root) = workspace_dir.and_then(|cwd| self.workspace_execution_root(cwd)) {
            collect_workspace_log_files(&root, &mut files);
            if !files.is_empty() {
                return files;
            }
        }

        collect_possible_log_files(
            &self.agent_home,
            &mut files,
            0,
            EXECUTION_LOG_SCAN_FALLBACK_MAX_FILES,
        );
        files
    }

    fn workspace_execution_root(&self, workspace_dir: &str) -> Option<PathBuf> {
        let normalized = workspace_dir.replace('/', "\\").to_ascii_lowercase();
        if normalized.trim().is_empty() {
            return None;
        }

        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        let root = self.agent_home.join(&digest[..32]);
        if root.is_dir() {
            Some(root)
        } else {
            None
        }
    }

    fn with_deep_fallback_log_files(&self, mut files: Vec<PathBuf>) -> Vec<PathBuf> {
        let mut seen: HashSet<PathBuf> = files.iter().cloned().collect();
        let mut fallback = Vec::new();
        collect_possible_log_files(&self.agent_home, &mut fallback, 0, usize::MAX);
        for path in fallback {
            if seen.insert(path.clone()) {
                files.push(path);
            }
        }
        files
    }

    fn execution_outputs(
        &self,
        workspace_dir: Option<&str>,
        session_id: &str,
        execution_ids: &HashSet<String>,
    ) -> HashMap<String, String> {
        self.execution_outputs_with_budget(
            workspace_dir,
            session_id,
            execution_ids,
            EXECUTION_LOG_SCAN_MAX_MILLIS,
        )
    }

    fn execution_outputs_with_budget(
        &self,
        workspace_dir: Option<&str>,
        session_id: &str,
        execution_ids: &HashSet<String>,
        max_millis: u128,
    ) -> HashMap<String, String> {
        if execution_ids.is_empty() {
            return HashMap::new();
        }

        let t0 = Instant::now();
        let mut raw_outputs = HashMap::new();
        let mut alias_outputs: HashMap<String, String> = HashMap::new();
        let mut target_ids = execution_ids.clone();
        let files = self.execution_log_files(workspace_dir);
        let file_count = files.len();
        let scan_count = file_count;
        let max_bytes = if max_millis > EXECUTION_LOG_SCAN_MAX_MILLIS {
            EXECUTION_LOG_DEEP_SCAN_MAX_BYTES
        } else {
            EXECUTION_LOG_SCAN_MAX_BYTES
        };

        eprintln!(
            "[perf] kiro-ide execution_outputs start session={session_id} files={file_count} scanning={scan_count} requested={}",
            execution_ids.len()
        );

        let mut scanned = 0usize;
        let mut timed_out = false;
        for path in &files {
            if t0.elapsed().as_millis() > max_millis {
                timed_out = true;
                break;
            }
            if final_output_count(execution_ids, &raw_outputs, &alias_outputs)
                == execution_ids.len()
            {
                break;
            }

            let Ok(meta) = path.metadata() else {
                continue;
            };
            if meta.len() > max_bytes {
                continue;
            }

            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            scanned += 1;
            if !raw.contains(session_id) && !contains_any_execution_id(&raw, &target_ids) {
                continue;
            }

            let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }

            collect_execution_aliases(&parsed, execution_ids, &mut alias_outputs, &mut target_ids);

            for (execution_id, output) in extract_execution_outputs_from_log(&parsed, &target_ids) {
                insert_longer_owned_output(&mut raw_outputs, execution_id, output);
            }
        }

        if final_output_count(execution_ids, &raw_outputs, &alias_outputs) < execution_ids.len()
            && !alias_outputs.is_empty()
        {
            for path in &files {
                if t0.elapsed().as_millis() > max_millis {
                    timed_out = true;
                    break;
                }
                if final_output_count(execution_ids, &raw_outputs, &alias_outputs)
                    == execution_ids.len()
                {
                    break;
                }

                let Ok(meta) = path.metadata() else {
                    continue;
                };
                if meta.len() > max_bytes {
                    continue;
                }

                let Ok(raw) = fs::read_to_string(path) else {
                    continue;
                };
                scanned += 1;
                if !raw.contains(session_id) && !contains_any_execution_id(&raw, &target_ids) {
                    continue;
                }

                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                    continue;
                }

                for (execution_id, output) in
                    extract_execution_outputs_from_log(&parsed, &target_ids)
                {
                    insert_longer_owned_output(&mut raw_outputs, execution_id, output);
                }
            }
        }

        if final_output_count(execution_ids, &raw_outputs, &alias_outputs) < execution_ids.len()
            && max_millis > EXECUTION_LOG_SCAN_MAX_MILLIS
        {
            let mut fallback_files = self.with_deep_fallback_log_files(files.clone());
            fallback_files.retain(|path| !files.contains(path));
            for path in &fallback_files {
                if t0.elapsed().as_millis() > max_millis {
                    timed_out = true;
                    break;
                }
                if final_output_count(execution_ids, &raw_outputs, &alias_outputs)
                    == execution_ids.len()
                {
                    break;
                }

                let Ok(meta) = path.metadata() else {
                    continue;
                };
                if meta.len() > max_bytes {
                    continue;
                }

                let Ok(raw) = fs::read_to_string(path) else {
                    continue;
                };
                scanned += 1;
                if !raw.contains(session_id) && !contains_any_execution_id(&raw, &target_ids) {
                    continue;
                }

                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                    continue;
                }

                collect_execution_aliases(
                    &parsed,
                    execution_ids,
                    &mut alias_outputs,
                    &mut target_ids,
                );
                for (execution_id, output) in
                    extract_execution_outputs_from_log(&parsed, &target_ids)
                {
                    insert_longer_owned_output(&mut raw_outputs, execution_id, output);
                }
            }
        }

        let outputs = finalize_execution_outputs(execution_ids, raw_outputs, alias_outputs);

        eprintln!(
            "[perf] kiro-ide execution_outputs session={session_id} files={file_count} scanned={scanned}/{scan_count} requested={} found={} timed_out={timed_out}: {:?}",
            execution_ids.len(),
            outputs.len(),
            t0.elapsed()
        );
        outputs
    }

    fn resolve_execution_output_inner(
        &self,
        session_key: &str,
        edit_target: &str,
    ) -> Result<String, String> {
        let (target_session_key, _message_id, execution_id) =
            parse_execution_edit_target(edit_target)
                .ok_or_else(|| format!("Invalid Kiro IDE execution target: {edit_target}"))?;
        if target_session_key != session_key {
            return Err("Execution target does not belong to this session".to_string());
        }

        let (workspace_key, session_id) = Self::parse_session_key(session_key)
            .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
        let workspace_dir = self
            .read_index(workspace_key)
            .into_iter()
            .find(|entry| entry.session_id == session_id)
            .map(|entry| entry.workspace_directory);

        let mut ids = HashSet::new();
        ids.insert(execution_id.to_string());
        let outputs = self.execution_outputs_with_budget(
            workspace_dir.as_deref(),
            session_id,
            &ids,
            EXECUTION_LOG_DEEP_SCAN_MAX_MILLIS,
        );

        outputs
            .get(execution_id)
            .cloned()
            .ok_or_else(|| format!("Execution output not found: {execution_id}"))
    }

    fn resolve_execution_outputs_inner(
        &self,
        session_key: &str,
        edit_targets: &[String],
    ) -> Result<HashMap<String, String>, String> {
        let (workspace_key, session_id) = Self::parse_session_key(session_key)
            .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
        let workspace_dir = self
            .read_index(workspace_key)
            .into_iter()
            .find(|entry| entry.session_id == session_id)
            .map(|entry| entry.workspace_directory);

        let mut execution_to_targets: HashMap<String, Vec<String>> = HashMap::new();
        for edit_target in edit_targets {
            let Some((target_session_key, _message_id, execution_id)) =
                parse_execution_edit_target(edit_target)
            else {
                continue;
            };
            if target_session_key != session_key {
                continue;
            }
            execution_to_targets
                .entry(execution_id.to_string())
                .or_default()
                .push(edit_target.clone());
        }

        let execution_ids: HashSet<String> = execution_to_targets.keys().cloned().collect();
        let execution_outputs = self.execution_outputs_with_budget(
            workspace_dir.as_deref(),
            session_id,
            &execution_ids,
            EXECUTION_LOG_DEEP_SCAN_MAX_MILLIS,
        );

        let mut outputs = HashMap::new();
        for (execution_id, output) in execution_outputs {
            if let Some(targets) = execution_to_targets.get(&execution_id) {
                for target in targets {
                    outputs.insert(target.clone(), output.clone());
                }
            }
        }
        Ok(outputs)
    }

    fn update_execution_output(
        &self,
        workspace_dir: Option<&str>,
        session_id: &str,
        execution_id: &str,
        new_content: &str,
    ) -> Result<String, String> {
        let t0 = Instant::now();
        let files = self.execution_log_files(workspace_dir);
        let file_count = files.len();
        let mut old_content = None;
        let mut updated_files = 0usize;
        let mut context_replacements = 0usize;

        let mut timed_out = false;
        for path in &files {
            if t0.elapsed().as_millis() > EXECUTION_LOG_SCAN_MAX_MILLIS {
                timed_out = true;
                break;
            }
            let Ok(meta) = path.metadata() else {
                continue;
            };
            if meta.len() > EXECUTION_LOG_SCAN_MAX_BYTES {
                continue;
            }

            let raw = match fs::read_to_string(path) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            if !raw.contains(session_id) || !raw.contains(execution_id) {
                continue;
            }
            let mut parsed: Value = match serde_json::from_str(&raw) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            let old = replace_execution_say_output(&mut parsed, execution_id, new_content)?;
            context_replacements += replace_bot_text_occurrences(&mut parsed, &old, new_content);
            let serialized = serde_json::to_string_pretty(&parsed)
                .map_err(|e| format!("Serialize execution log error: {e}"))?;
            replace_existing_file_atomic(path, format!("{serialized}\n").as_bytes())
                .map_err(|e| format!("Write execution log error: {e}"))?;
            old_content = Some(old);
            updated_files += 1;
            break;
        }

        let old_content = old_content.ok_or_else(|| {
            if timed_out {
                format!("Execution log scan timed out before finding: {execution_id}")
            } else {
                format!("Execution log not found: {execution_id}")
            }
        })?;

        for path in &files {
            if t0.elapsed().as_millis() > EXECUTION_LOG_SCAN_MAX_MILLIS {
                timed_out = true;
                break;
            }
            let Ok(meta) = path.metadata() else {
                continue;
            };
            if meta.len() > EXECUTION_LOG_SCAN_MAX_BYTES {
                continue;
            }

            let raw = match fs::read_to_string(path) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            if !raw.contains(session_id) || !raw.contains(&old_content) {
                continue;
            }
            let mut parsed: Value = match serde_json::from_str(&raw) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            if parsed.get("chatSessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            let count = replace_bot_text_occurrences(&mut parsed, &old_content, new_content);
            if count == 0 {
                continue;
            }
            let serialized = serde_json::to_string_pretty(&parsed)
                .map_err(|e| format!("Serialize context log error: {e}"))?;
            replace_existing_file_atomic(path, format!("{serialized}\n").as_bytes())
                .map_err(|e| format!("Write context log error: {e}"))?;
            context_replacements += count;
            updated_files += 1;
        }

        eprintln!(
            "[perf] kiro-ide update_execution_output session={session_id} execution={execution_id} files={file_count} scanned<={} updated_files={updated_files} context_replacements={context_replacements} timed_out={timed_out}: {:?}",
            files.len(),
            t0.elapsed()
        );
        Ok(old_content)
    }
    fn preview(&self, workspace_key: &str, session_id: &str) -> String {
        let Ok(session) = self.read_session_json(workspace_key, session_id) else {
            return String::new();
        };

        session
            .get("history")
            .and_then(Value::as_array)
            .and_then(|history| {
                history.iter().find_map(|entry| {
                    let content = entry.get("message")?.get("content")?;
                    let text = extract_message_text(content);
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(truncate(&text, 120))
                    }
                })
            })
            .unwrap_or_default()
    }

    fn parse_session_key(session_key: &str) -> Option<(&str, &str)> {
        let mut parts = session_key.splitn(2, "::");
        let workspace_key = parts.next()?;
        let session_id = parts.next()?;
        if workspace_key.is_empty() || session_id.is_empty() {
            return None;
        }
        Some((workspace_key, session_id))
    }
}

impl PlatformAdapter for KiroIdePlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        if !self.workspace_sessions_dir().exists() {
            return SessionListResult {
                total: 0,
                items: Vec::new(),
            };
        }

        let mut items = Vec::new();
        for workspace_key in self.collect_workspace_keys() {
            for entry in self.read_index(&workspace_key) {
                let session_key = format!("{workspace_key}::{}", entry.session_id);
                let alias = alias_map.get(&session_key).cloned().unwrap_or_default();
                let display_title = if alias.is_empty() {
                    if entry.title.trim().is_empty() {
                        entry.session_id.clone()
                    } else {
                        entry.title.clone()
                    }
                } else {
                    alias.clone()
                };

                items.push(SessionListItem {
                    platform: "kiro-ide".to_string(),
                    session_key,
                    session_id: entry.session_id.clone(),
                    display_title,
                    alias_title: alias,
                    preview: self.preview(&workspace_key, &entry.session_id),
                    updated_at: entry.date_created,
                    cwd: entry.workspace_directory,
                    editable: true,
                    content_matches: vec![],
                    total_content_matches: 0,
                    favorite: false,
                });
            }
        }

        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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
        let t0 = Instant::now();
        let (workspace_key, session_id) = Self::parse_session_key(session_key)
            .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
        let session = self.read_session_json(workspace_key, session_id)?;
        let index = self
            .read_index(workspace_key)
            .into_iter()
            .find(|entry| entry.session_id == session_id);
        let alias = alias_map.get(session_key).cloned().unwrap_or_default();
        let title_raw = index
            .as_ref()
            .map(|entry| entry.title.as_str())
            .unwrap_or(session_id);
        let title = if alias.is_empty() {
            if title_raw.trim().is_empty() {
                session_id.to_string()
            } else {
                title_raw.to_string()
            }
        } else {
            alias.clone()
        };
        let cwd = index
            .as_ref()
            .map(|entry| entry.workspace_directory.clone())
            .unwrap_or_default();

        let history = session.get("history").and_then(Value::as_array);
        let execution_ids: HashSet<String> = history
            .map(|history| {
                history
                    .iter()
                    .filter_map(|entry| {
                        let message = entry.get("message")?;
                        let role = message.get("role").and_then(Value::as_str)?;
                        if role != "assistant" {
                            return None;
                        }
                        let content = extract_message_text(message.get("content")?);
                        if content.trim() != "On it." {
                            return None;
                        }
                        entry
                            .get("executionId")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let execution_outputs = self.execution_outputs(Some(&cwd), session_id, &execution_ids);

        let blocks: Vec<TimelineBlock> = history
            .map(|history| {
                history
                    .iter()
                    .enumerate()
                    .filter_map(|(index, entry)| {
                        let message = entry.get("message")?;
                        let role = message.get("role").and_then(Value::as_str)?;
                        if role != "user" && role != "assistant" {
                            return None;
                        }
                        let message_id = message.get("id").and_then(Value::as_str).unwrap_or("");
                        if message_id.is_empty() {
                            return None;
                        }
                        let mut content = extract_message_text(message.get("content")?);
                        let execution_id = entry.get("executionId").and_then(Value::as_str);
                        if role == "assistant" && content.trim() == "On it." {
                            if let Some(execution_id) = execution_id {
                                if let Some(output) = execution_outputs.get(execution_id) {
                                    content = output.clone();
                                }
                            }
                        }
                        Some(TimelineBlock {
                            id: message_id.to_string(),
                            role: role.to_string(),
                            content,
                            editable: true,
                            edit_target: if role == "assistant" {
                                if let Some(execution_id) = execution_id {
                                    format!(
                                        "{session_key}::{message_id}::execution::{execution_id}"
                                    )
                                } else {
                                    format!("{session_key}::{message_id}")
                                }
                            } else {
                                format!("{session_key}::{message_id}")
                            },
                            source_meta: json!({
                                "historyIndex": index,
                                "messageId": message_id,
                                "executionId": execution_id,
                            }),
                            tool_calls: Vec::new(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        eprintln!(
            "[perf] kiro-ide get_session_detail build session={session_id} blocks={}: {:?}",
            blocks.len(),
            t0.elapsed()
        );

        Ok(SessionDetail {
            platform: "kiro-ide".to_string(),
            session_key: session_key.to_string(),
            session_id: session_id.to_string(),
            title,
            alias_title: alias,
            cwd,
            commands: build_commands("kiro-ide", session_id),
            revision: String::new(),
            blocks,
        })
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        if let Some((session_key, _message_id, execution_id)) =
            parse_execution_edit_target(edit_target)
        {
            let (workspace_key, session_id) = Self::parse_session_key(session_key)
                .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
            let workspace_dir = self
                .read_index(workspace_key)
                .into_iter()
                .find(|entry| entry.session_id == session_id)
                .map(|entry| entry.workspace_directory);
            return self.update_execution_output(
                workspace_dir.as_deref(),
                session_id,
                execution_id,
                new_content,
            );
        }

        let mut parts = edit_target.rsplitn(2, "::");
        let message_id = parts
            .next()
            .ok_or_else(|| format!("Invalid edit target: {edit_target}"))?;
        let session_key = parts
            .next()
            .ok_or_else(|| format!("Invalid edit target: {edit_target}"))?;
        let (workspace_key, session_id) = Self::parse_session_key(session_key)
            .ok_or_else(|| format!("Invalid Kiro IDE session key: {session_key}"))?;
        let path = self.session_path(workspace_key, session_id);
        let mut session = self.read_session_json(workspace_key, session_id)?;
        let history = session
            .get_mut("history")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Missing history".to_string())?;

        for entry in history {
            let Some(message) = entry.get_mut("message") else {
                continue;
            };
            if message.get("id").and_then(Value::as_str) != Some(message_id) {
                continue;
            }
            let content = message
                .get_mut("content")
                .ok_or_else(|| "Missing message content".to_string())?;
            let old = replace_message_text(content, new_content)?;
            let serialized = serde_json::to_string_pretty(&session)
                .map_err(|e| format!("Serialize error: {e}"))?;
            replace_existing_file_atomic(&path, format!("{serialized}\n").as_bytes())
                .map_err(|e| format!("Write error: {e}"))?;
            return Ok(old);
        }

        Err(format!("Message not found: {message_id}"))
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        !self.content_search(session_key, query).is_empty()
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return vec![];
        }
        let Some((workspace_key, session_id)) = Self::parse_session_key(session_key) else {
            return vec![];
        };
        let Ok(session) = self.read_session_json(workspace_key, session_id) else {
            return vec![];
        };

        let mut matches = Vec::new();
        let Some(history) = session.get("history").and_then(Value::as_array) else {
            return matches;
        };
        let mut match_index = 0usize;
        for entry in history {
            let Some(message) = entry.get("message") else {
                continue;
            };
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let text = message
                .get("content")
                .map(extract_message_text)
                .unwrap_or_default();
            if text.to_lowercase().contains(&needle) {
                matches.push(ContentMatch {
                    snippet: extract_snippet(&text, &needle),
                    match_index,
                    role: role.to_string(),
                });
            }
            match_index += 1;
        }
        matches
    }

    fn resolve_execution_output(
        &self,
        session_key: &str,
        edit_target: &str,
    ) -> Result<String, String> {
        self.resolve_execution_output_inner(session_key, edit_target)
    }

    fn resolve_execution_outputs(
        &self,
        session_key: &str,
        edit_targets: &[String],
    ) -> Result<HashMap<String, String>, String> {
        self.resolve_execution_outputs_inner(session_key, edit_targets)
    }
}

fn extract_message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn replace_message_text(content: &mut Value, new_content: &str) -> Result<String, String> {
    let old_content = extract_message_text(content);
    if content.is_string() {
        *content = Value::String(new_content.to_string());
        return Ok(old_content);
    }

    if content.is_array() {
        *content = json!([{ "type": "text", "text": new_content }]);
        return Ok(old_content);
    }

    Err("Unsupported Kiro IDE message content shape".to_string())
}

fn replace_execution_say_output(
    execution_log: &mut Value,
    execution_id: &str,
    new_content: &str,
) -> Result<String, String> {
    let actions = execution_log
        .get_mut("actions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Missing execution actions".to_string())?;

    for action in actions.iter_mut().rev() {
        if action.get("executionId").and_then(Value::as_str) != Some(execution_id) {
            continue;
        }
        let action_type = action
            .get("actionType")
            .and_then(Value::as_str)
            .unwrap_or("");
        if action_type != "say" {
            continue;
        }
        let output = action
            .get_mut("output")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Missing say output".to_string())?;
        let old = output
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        output.insert(
            "message".to_string(),
            Value::String(new_content.to_string()),
        );
        return Ok(old);
    }

    Err(format!("Execution output not found: {execution_id}"))
}

fn extract_execution_outputs_from_log(
    execution_log: &Value,
    execution_ids: &HashSet<String>,
) -> HashMap<String, String> {
    let mut outputs = HashMap::new();
    collect_action_say_outputs(execution_log, execution_ids, &mut outputs);
    collect_action_error_outputs(execution_log, execution_ids, &mut outputs);
    collect_execution_log_reference_outputs(execution_log, execution_ids, &mut outputs);
    collect_current_context_output(execution_log, execution_ids, &mut outputs);
    outputs
}

fn contains_any_execution_id(raw: &str, execution_ids: &HashSet<String>) -> bool {
    execution_ids
        .iter()
        .any(|execution_id| raw.contains(execution_id))
}

fn collect_execution_aliases(
    execution_log: &Value,
    requested_ids: &HashSet<String>,
    alias_outputs: &mut HashMap<String, String>,
    target_ids: &mut HashSet<String>,
) {
    let Some(actions) = execution_log.get("actions").and_then(Value::as_array) else {
        return;
    };

    for action in actions {
        let Some(parent_id) = action.get("executionId").and_then(Value::as_str) else {
            continue;
        };
        if !requested_ids.contains(parent_id) {
            continue;
        }
        let Some(child_id) = action
            .get("output")
            .and_then(|output| output.get("executionId"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if child_id.is_empty() {
            continue;
        }
        alias_outputs.insert(parent_id.to_string(), child_id.to_string());
        target_ids.insert(child_id.to_string());
    }
}

fn final_output_count(
    requested_ids: &HashSet<String>,
    raw_outputs: &HashMap<String, String>,
    alias_outputs: &HashMap<String, String>,
) -> usize {
    requested_ids
        .iter()
        .filter(|execution_id| {
            raw_outputs.contains_key(*execution_id)
                || alias_outputs
                    .get(*execution_id)
                    .is_some_and(|child_id| raw_outputs.contains_key(child_id))
        })
        .count()
}

fn finalize_execution_outputs(
    requested_ids: &HashSet<String>,
    raw_outputs: HashMap<String, String>,
    alias_outputs: HashMap<String, String>,
) -> HashMap<String, String> {
    let mut outputs = HashMap::new();
    for execution_id in requested_ids {
        if let Some(output) = raw_outputs.get(execution_id) {
            outputs.insert(execution_id.clone(), output.clone());
            continue;
        }
        if let Some(child_id) = alias_outputs.get(execution_id) {
            if let Some(output) = raw_outputs.get(child_id) {
                outputs.insert(execution_id.clone(), output.clone());
            }
        }
    }
    outputs
}

fn collect_action_say_outputs(
    execution_log: &Value,
    execution_ids: &HashSet<String>,
    outputs: &mut HashMap<String, String>,
) {
    let Some(actions) = execution_log.get("actions").and_then(Value::as_array) else {
        return;
    };

    for action in actions.iter().rev() {
        let Some(execution_id) = action.get("executionId").and_then(Value::as_str) else {
            continue;
        };
        if !execution_ids.contains(execution_id) {
            continue;
        }
        if action.get("actionType").and_then(Value::as_str) != Some("say") {
            continue;
        }
        let Some(message) = action
            .get("output")
            .and_then(|output| output.get("message"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        insert_longer_output(outputs, execution_id, message);
    }
}

fn collect_action_error_outputs(
    execution_log: &Value,
    execution_ids: &HashSet<String>,
    outputs: &mut HashMap<String, String>,
) {
    let Some(actions) = execution_log.get("actions").and_then(Value::as_array) else {
        return;
    };

    for action in actions.iter().rev() {
        let Some(execution_id) = action.get("executionId").and_then(Value::as_str) else {
            continue;
        };
        if !execution_ids.contains(execution_id) {
            continue;
        }
        if action.get("actionType").and_then(Value::as_str) != Some("displayError") {
            continue;
        }
        let message = action
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or("An unexpected error occurred, please retry.");
        insert_longer_output(outputs, execution_id, message);
    }
}

fn collect_execution_log_reference_outputs(
    execution_log: &Value,
    execution_ids: &HashSet<String>,
    outputs: &mut HashMap<String, String>,
) {
    let execution_order: Vec<String> = execution_log
        .pointer("/input/data/messages")
        .and_then(Value::as_array)
        .map(|messages| collect_execution_log_ids_from_messages(messages))
        .unwrap_or_default();
    if execution_order.is_empty() {
        return;
    }

    let Some(messages) = execution_log
        .pointer("/input/data/messagesFromExecutionId")
        .and_then(Value::as_array)
    else {
        return;
    };

    let mut current_index = 0usize;
    let mut current_texts: Vec<String> = Vec::new();

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "human" {
            if !current_texts.is_empty() {
                insert_execution_chunk(
                    outputs,
                    execution_ids,
                    &execution_order,
                    current_index,
                    &current_texts,
                );
                current_index += 1;
                current_texts.clear();
            }
            continue;
        }

        if role != "bot" {
            continue;
        }

        let text = extract_bot_entry_text(message);
        if !text.trim().is_empty() && !is_kiro_boilerplate_text(&text) {
            current_texts.push(text);
        }
    }

    if !current_texts.is_empty() {
        insert_execution_chunk(
            outputs,
            execution_ids,
            &execution_order,
            current_index,
            &current_texts,
        );
    }
}

fn collect_current_context_output(
    execution_log: &Value,
    execution_ids: &HashSet<String>,
    outputs: &mut HashMap<String, String>,
) {
    let Some(execution_id) = execution_log.get("executionId").and_then(Value::as_str) else {
        return;
    };
    if !execution_ids.contains(execution_id) {
        return;
    }
    let Some(messages) = execution_log
        .pointer("/context/messages")
        .and_then(Value::as_array)
    else {
        return;
    };

    let mut current_texts = Vec::new();
    for message in messages.iter().rev() {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "human" {
            break;
        }
        if role != "bot" {
            continue;
        }

        let text = extract_bot_entry_text(message);
        if !text.trim().is_empty() && !is_kiro_boilerplate_text(&text) {
            current_texts.push(text);
        }
    }

    current_texts.reverse();
    if !current_texts.is_empty() {
        insert_longer_output(outputs, execution_id, &current_texts.join("\n\n"));
    }
}

fn collect_execution_log_ids_from_messages(messages: &[Value]) -> Vec<String> {
    let mut ids = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        for item in content {
            if item.get("type").and_then(Value::as_str) != Some("executionLog") {
                continue;
            }
            if let Some(execution_id) = item.get("text").and_then(Value::as_str) {
                ids.push(execution_id.to_string());
            }
        }
    }
    ids
}

fn insert_execution_chunk(
    outputs: &mut HashMap<String, String>,
    execution_ids: &HashSet<String>,
    execution_order: &[String],
    current_index: usize,
    texts: &[String],
) {
    let Some(execution_id) = execution_order.get(current_index) else {
        return;
    };
    if !execution_ids.contains(execution_id) {
        return;
    }
    insert_longer_output(outputs, execution_id, &texts.join("\n\n"));
}

fn extract_bot_entry_text(message: &Value) -> String {
    message
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|entry| entry.get("text").and_then(Value::as_str))
                .filter(|text| !text.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn insert_longer_output(outputs: &mut HashMap<String, String>, execution_id: &str, output: &str) {
    let output = output.trim();
    if output.is_empty() {
        return;
    }
    outputs
        .entry(execution_id.to_string())
        .and_modify(|existing| {
            if output.chars().count() > existing.chars().count() {
                *existing = output.to_string();
            }
        })
        .or_insert_with(|| output.to_string());
}

fn insert_longer_owned_output(
    outputs: &mut HashMap<String, String>,
    execution_id: String,
    output: String,
) {
    outputs
        .entry(execution_id)
        .and_modify(|existing| {
            if output.chars().count() > existing.chars().count() {
                *existing = output.clone();
            }
        })
        .or_insert(output);
}

fn is_kiro_boilerplate_text(text: &str) -> bool {
    matches!(
        text.trim(),
        "Understood." | "I will follow these instructions."
    )
}

fn parse_execution_edit_target(edit_target: &str) -> Option<(&str, &str, &str)> {
    let marker = "::execution::";
    let (prefix, execution_id) = edit_target.rsplit_once(marker)?;
    let (session_key, message_id) = prefix.rsplit_once("::")?;
    if session_key.is_empty() || message_id.is_empty() || execution_id.is_empty() {
        return None;
    }
    Some((session_key, message_id, execution_id))
}

fn replace_bot_text_occurrences(value: &mut Value, old_content: &str, new_content: &str) -> usize {
    if old_content.trim().is_empty() || old_content == new_content {
        return 0;
    }

    let mut count = 0usize;
    count += replace_bot_texts_at_path(value, &["context", "messages"], old_content, new_content);
    count += replace_bot_texts_at_path(
        value,
        &["input", "data", "messagesFromExecutionId"],
        old_content,
        new_content,
    );
    count
}

fn replace_bot_texts_at_path(
    value: &mut Value,
    path: &[&str],
    old_content: &str,
    new_content: &str,
) -> usize {
    let mut current = value;
    for segment in path {
        let Some(next) = current.get_mut(*segment) else {
            return 0;
        };
        current = next;
    }

    let Some(messages) = current.as_array_mut() else {
        return 0;
    };

    let mut count = 0usize;
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("bot") {
            continue;
        }
        let Some(entries) = message.get_mut("entries").and_then(Value::as_array_mut) else {
            continue;
        };
        for entry in entries {
            if entry.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let Some(text) = entry.get_mut("text") else {
                continue;
            };
            if text.as_str() == Some(old_content) {
                *text = Value::String(new_content.to_string());
                count += 1;
            }
        }
    }

    count
}

fn collect_workspace_log_files(root: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if !file_name.starts_with('.') {
                dirs.push(path);
            }
        } else if is_possible_log_file(&path) {
            out.push(path);
        }
    }

    dirs.sort_by_key(|path| {
        std::cmp::Reverse(
            path.metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        )
    });

    for dir in dirs {
        collect_possible_log_files(&dir, out, 0, usize::MAX);
    }
}

fn collect_possible_log_files(root: &PathBuf, out: &mut Vec<PathBuf>, depth: usize, limit: usize) {
    if depth > 4 || out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if file_name == "workspace-sessions" || file_name.starts_with('.') {
                continue;
            }
            collect_possible_log_files(&path, out, depth + 1, limit);
            continue;
        }

        if is_possible_log_file(&path) {
            out.push(path);
        }
    }
}

fn is_possible_log_file(path: &PathBuf) -> bool {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    extension.is_empty() || extension == "json"
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut result: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        result.push('…');
    }
    result
}

pub fn default_agent_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from).map(|path| {
            path.join("Kiro")
                .join("User")
                .join("globalStorage")
                .join("kiro.kiroagent")
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().map(|home| {
            home.join(".config")
                .join("Kiro")
                .join("User")
                .join("globalStorage")
                .join("kiro.kiroagent")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_text_from_string_and_array_content() {
        let string_content = json!("On it.");
        let array_content = json!([
            { "type": "text", "text": "first" },
            { "type": "tool_use", "name": "ignored" },
            { "type": "text", "text": "second" }
        ]);

        assert_eq!(extract_message_text(&string_content), "On it.");
        assert_eq!(extract_message_text(&array_content), "first\nsecond");
    }

    #[test]
    fn replaces_string_and_array_content() {
        let mut string_content = json!("On it.");
        let mut array_content = json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" }
        ]);

        assert_eq!(
            replace_message_text(&mut string_content, "updated").unwrap(),
            "On it."
        );
        assert_eq!(string_content, json!("updated"));

        assert_eq!(
            replace_message_text(&mut array_content, "merged").unwrap(),
            "first\nsecond"
        );
        assert_eq!(array_content, json!([{ "type": "text", "text": "merged" }]));
    }

    #[test]
    fn replaces_real_assistant_output_in_execution_actions() {
        let mut execution_log = json!({
            "actions": [
                {
                    "executionId": "exec-1",
                    "actionType": "say",
                    "output": { "message": "旧回复" }
                }
            ]
        });

        assert_eq!(
            replace_execution_say_output(&mut execution_log, "exec-1", "新回复").unwrap(),
            "旧回复"
        );
        assert_eq!(
            execution_log["actions"][0]["output"]["message"].as_str(),
            Some("新回复")
        );
    }

    #[test]
    fn replaces_bot_context_entries_but_not_human_or_tool_entries() {
        let mut execution_log = json!({
            "context": {
                "messages": [
                    {
                        "role": "bot",
                        "entries": [{ "type": "text", "text": "旧回复" }]
                    },
                    {
                        "role": "human",
                        "entries": [{ "type": "text", "text": "旧回复" }]
                    },
                    {
                        "role": "tool",
                        "entries": [{ "type": "toolUseResponse", "message": "旧回复" }]
                    }
                ]
            },
            "input": {
                "data": {
                    "messagesFromExecutionId": [
                        {
                            "role": "bot",
                            "entries": [{ "type": "text", "text": "旧回复" }]
                        }
                    ]
                }
            }
        });

        assert_eq!(
            replace_bot_text_occurrences(&mut execution_log, "旧回复", "新回复"),
            2
        );
        assert_eq!(
            execution_log["context"]["messages"][0]["entries"][0]["text"].as_str(),
            Some("新回复")
        );
        assert_eq!(
            execution_log["input"]["data"]["messagesFromExecutionId"][0]["entries"][0]["text"]
                .as_str(),
            Some("新回复")
        );
        assert_eq!(
            execution_log["context"]["messages"][1]["entries"][0]["text"].as_str(),
            Some("旧回复")
        );
        assert_eq!(
            execution_log["context"]["messages"][2]["entries"][0]["message"].as_str(),
            Some("旧回复")
        );
    }

    #[test]
    fn extracts_outputs_from_kiro_execution_log_references() {
        let execution_log = json!({
            "input": {
                "data": {
                    "messages": [
                        { "role": "user", "content": [{ "type": "text", "text": "first" }] },
                        { "role": "assistant", "content": [{ "type": "executionLog", "text": "exec-1" }] },
                        { "role": "user", "content": [{ "type": "text", "text": "continue" }] },
                        { "role": "assistant", "content": [{ "type": "executionLog", "text": "exec-2" }] },
                        { "role": "user", "content": [{ "type": "text", "text": "continue" }] }
                    ],
                    "messagesFromExecutionId": [
                        { "role": "human", "entries": [{ "type": "text", "text": "first" }] },
                        { "role": "bot", "entries": [{ "type": "text", "text": "Understood." }] },
                        { "role": "human", "entries": [{ "type": "text", "text": "first" }] },
                        { "role": "bot", "entries": [{ "type": "text", "text": "first answer" }] },
                        { "role": "bot", "entries": [{ "type": "text", "text": "first final" }] },
                        { "role": "human", "entries": [{ "type": "text", "text": "continue" }] },
                        { "role": "bot", "entries": [{ "type": "text", "text": "Understood." }] },
                        { "role": "human", "entries": [{ "type": "text", "text": "continue" }] },
                        { "role": "bot", "entries": [{ "type": "text", "text": "second answer" }] }
                    ]
                }
            }
        });
        let execution_ids = HashSet::from(["exec-1".to_string(), "exec-2".to_string()]);
        let outputs = extract_execution_outputs_from_log(&execution_log, &execution_ids);

        assert_eq!(
            outputs.get("exec-1").map(String::as_str),
            Some("first answer\n\nfirst final")
        );
        assert_eq!(
            outputs.get("exec-2").map(String::as_str),
            Some("second answer")
        );
    }

    #[test]
    fn maps_spec_agent_child_execution_output_to_parent_execution() {
        let mut requested_ids = HashSet::new();
        requested_ids.insert("parent-exec".to_string());
        let mut target_ids = requested_ids.clone();
        let mut aliases = HashMap::new();

        let parent_log = json!({
            "actions": [
                {
                    "executionId": "parent-exec",
                    "actionType": "specAgent",
                    "output": { "executionId": "child-exec" }
                }
            ]
        });
        collect_execution_aliases(&parent_log, &requested_ids, &mut aliases, &mut target_ids);

        let child_log = json!({
            "executionId": "child-exec",
            "actions": [
                {
                    "executionId": "child-exec",
                    "actionType": "say",
                    "output": { "message": "child output" }
                }
            ]
        });
        let raw_outputs = extract_execution_outputs_from_log(&child_log, &target_ids);
        let outputs = finalize_execution_outputs(&requested_ids, raw_outputs, aliases);

        assert_eq!(
            outputs.get("parent-exec").map(String::as_str),
            Some("child output")
        );
    }

    #[test]
    fn extracts_display_error_as_execution_output() {
        let execution_log = json!({
            "actions": [
                {
                    "executionId": "exec-1",
                    "actionType": "displayError",
                    "errorMessage": "An unexpected error occurred, please retry."
                }
            ]
        });
        let execution_ids = HashSet::from(["exec-1".to_string()]);
        let outputs = extract_execution_outputs_from_log(&execution_log, &execution_ids);

        assert_eq!(
            outputs.get("exec-1").map(String::as_str),
            Some("An unexpected error occurred, please retry.")
        );
    }
}
