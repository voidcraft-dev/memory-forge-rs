use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const TERMINAL_EVENT_NAME: &str = "embedded-terminal-event";
const OUTPUT_INTERVAL: Duration = Duration::from_millis(5);
const MAX_COMMAND_LENGTH: usize = 32_768;
const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 2;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 300;
const MAX_REMOTE_TERMINALS: usize = 8;
const MAX_REMOTE_TERMINALS_PER_DEVICE: usize = 3;
const MAX_REMOTE_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_REMOTE_OUTPUT_CHUNKS: usize = 2048;
const MAX_REMOTE_INPUT_BYTES: usize = 64 * 1024;
const REMOTE_TERMINAL_RETENTION: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartEmbeddedTerminalRequest {
    pub terminal_id: String,
    pub session_key: String,
    pub command: String,
    pub command_kind: String,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub owner_device_id: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub session_title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTerminalStarted {
    pub terminal_id: String,
    pub cwd: String,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminalSnapshot {
    pub terminal_id: String,
    pub session_key: String,
    pub platform: String,
    pub command_kind: String,
    pub title: String,
    pub cwd: String,
    pub status: String,
    pub process_id: Option<u32>,
    pub exit_code: Option<u32>,
    pub error_message: Option<String>,
    pub created_at: u64,
    pub next_cursor: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminalOutputChunk {
    pub cursor: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminalOutput {
    pub terminal: RemoteTerminalSnapshot,
    pub chunks: Vec<RemoteTerminalOutputChunk>,
    pub next_cursor: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum EmbeddedTerminalEvent {
    Output {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        data: String,
    },
    Exit {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<u32>,
    },
    Error {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        message: String,
    },
}

struct EmbeddedTerminalProcess {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    process_id: Option<u32>,
}

#[derive(Debug, Clone)]
struct RemoteTerminalMetadata {
    terminal_id: String,
    owner_device_id: String,
    session_key: String,
    platform: String,
    command_kind: String,
    title: String,
    cwd: String,
    created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteTerminalStatus {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}

impl RemoteTerminalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Exited => "exited",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug)]
struct RemoteOutputBuffer {
    chunks: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    next_cursor: u64,
    status: RemoteTerminalStatus,
    exit_code: Option<u32>,
    error_message: Option<String>,
    finished_at: Option<Instant>,
}

impl Default for RemoteOutputBuffer {
    fn default() -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            next_cursor: 0,
            status: RemoteTerminalStatus::Starting,
            exit_code: None,
            error_message: None,
            finished_at: None,
        }
    }
}

struct RemoteTerminalRecord {
    metadata: RemoteTerminalMetadata,
    process: Arc<EmbeddedTerminalProcess>,
    output: Mutex<RemoteOutputBuffer>,
}

#[derive(Clone, Default)]
pub struct RemoteTerminalRegistry {
    records: Arc<Mutex<HashMap<String, Arc<RemoteTerminalRecord>>>>,
}

impl EmbeddedTerminalProcess {
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| "terminal writer lock poisoned".to_string())?;
        let writer = guard
            .as_mut()
            .ok_or_else(|| "terminal input is closed".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write terminal input: {error}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self
            .master
            .lock()
            .map_err(|_| "terminal master lock poisoned".to_string())?;
        let master = guard
            .as_ref()
            .ok_or_else(|| "terminal is closed".to_string())?;
        master
            .resize(PtySize {
                rows: rows.clamp(MIN_ROWS, MAX_ROWS),
                cols: cols.clamp(MIN_COLS, MAX_COLS),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("failed to resize terminal: {error}"))
    }

    fn close_io(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
    }

    fn kill(&self) {
        self.close_io();

        #[cfg(target_os = "windows")]
        if let Some(process_id) = self.process_id {
            terminate_windows_process_tree(process_id);
        }

        if let Ok(mut killer) = self.killer.lock() {
            if let Some(mut killer) = killer.take() {
                let _ = killer.kill();
            }
        }
    }
}

impl RemoteTerminalRegistry {
    fn prune_locked(records: &mut HashMap<String, Arc<RemoteTerminalRecord>>) {
        let now = Instant::now();
        records.retain(|_, record| {
            record
                .output
                .lock()
                .ok()
                .and_then(|output| output.finished_at)
                .is_none_or(|finished_at| {
                    now.duration_since(finished_at) < REMOTE_TERMINAL_RETENTION
                })
        });

        if records.len() <= MAX_REMOTE_TERMINALS {
            return;
        }

        let mut finished = records
            .iter()
            .filter_map(|(id, record)| {
                record
                    .output
                    .lock()
                    .ok()
                    .and_then(|output| output.finished_at)
                    .map(|finished_at| (id.clone(), finished_at))
            })
            .collect::<Vec<_>>();
        finished.sort_by_key(|(_, finished_at)| *finished_at);
        for (id, _) in finished
            .into_iter()
            .take(records.len() - MAX_REMOTE_TERMINALS)
        {
            records.remove(&id);
        }
    }

    fn evict_oldest_finished_locked(
        records: &mut HashMap<String, Arc<RemoteTerminalRecord>>,
    ) -> bool {
        let oldest_id = records
            .iter()
            .filter_map(|(id, record)| {
                record
                    .output
                    .lock()
                    .ok()
                    .and_then(|output| output.finished_at)
                    .map(|finished_at| (id.clone(), finished_at))
            })
            .min_by_key(|(_, finished_at)| *finished_at)
            .map(|(id, _)| id);
        oldest_id.and_then(|id| records.remove(&id)).is_some()
    }

    fn insert(
        &self,
        metadata: RemoteTerminalMetadata,
        process: Arc<EmbeddedTerminalProcess>,
    ) -> Result<Arc<RemoteTerminalRecord>, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "remote terminal registry lock poisoned".to_string())?;
        Self::prune_locked(&mut records);
        if let Some(existing) = records.get(&metadata.terminal_id) {
            return if existing.metadata.owner_device_id == metadata.owner_device_id {
                Err("remote terminal id already exists".to_string())
            } else {
                Err("remote terminal id is already owned by another device".to_string())
            };
        }

        let active_count = records
            .values()
            .filter(|record| {
                record.metadata.owner_device_id == metadata.owner_device_id
                    && record
                        .output
                        .lock()
                        .map(|output| {
                            matches!(
                                output.status,
                                RemoteTerminalStatus::Starting
                                    | RemoteTerminalStatus::Running
                                    | RemoteTerminalStatus::Stopping
                            )
                        })
                        .unwrap_or(false)
            })
            .count();
        if active_count >= MAX_REMOTE_TERMINALS_PER_DEVICE {
            return Err("remote terminal limit reached for this device".to_string());
        }
        if records.len() >= MAX_REMOTE_TERMINALS
            && !Self::evict_oldest_finished_locked(&mut records)
        {
            return Err("remote terminal limit reached on host".to_string());
        }

        let record = Arc::new(RemoteTerminalRecord {
            metadata,
            process,
            output: Mutex::new(RemoteOutputBuffer::default()),
        });
        records.insert(record.metadata.terminal_id.clone(), record.clone());
        Ok(record)
    }

    fn get_owned(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
    ) -> Result<Arc<RemoteTerminalRecord>, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "remote terminal registry lock poisoned".to_string())?;
        Self::prune_locked(&mut records);
        let record = records
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| "remote terminal session not found".to_string())?;
        if record.metadata.owner_device_id != owner_device_id {
            return Err("remote terminal session not found".to_string());
        }
        Ok(record)
    }

    fn list_owned(&self, owner_device_id: &str) -> Result<Vec<RemoteTerminalSnapshot>, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "remote terminal registry lock poisoned".to_string())?;
        Self::prune_locked(&mut records);
        let mut owned = records
            .values()
            .filter(|record| record.metadata.owner_device_id == owner_device_id)
            .map(|record| snapshot_for_record(record.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        owned.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.terminal_id.cmp(&left.terminal_id))
        });
        Ok(owned)
    }

    fn append_output(&self, terminal_id: &str, data: &[u8]) {
        let Ok(records) = self.records.lock() else {
            return;
        };
        let Some(record) = records.get(terminal_id).cloned() else {
            return;
        };
        drop(records);
        let Ok(mut output) = record.output.lock() else {
            return;
        };
        if data.is_empty() {
            return;
        }
        output.next_cursor = output.next_cursor.saturating_add(1);
        let cursor = output.next_cursor;
        output.chunks.push_back((cursor, data.to_vec()));
        output.bytes = output.bytes.saturating_add(data.len());
        while (output.bytes > MAX_REMOTE_OUTPUT_BYTES
            || output.chunks.len() > MAX_REMOTE_OUTPUT_CHUNKS)
            && output.chunks.len() > 1
        {
            if let Some((_, chunk)) = output.chunks.pop_front() {
                output.bytes = output.bytes.saturating_sub(chunk.len());
            }
        }
    }

    fn mark_running(&self, terminal_id: &str) {
        let Ok(records) = self.records.lock() else {
            return;
        };
        let Some(record) = records.get(terminal_id).cloned() else {
            return;
        };
        drop(records);
        let output_guard = record.output.lock();
        if let Ok(mut output) = output_guard {
            output.status = RemoteTerminalStatus::Running;
        };
    }

    fn mark_stopping(&self, terminal_id: &str) {
        let Ok(records) = self.records.lock() else {
            return;
        };
        let Some(record) = records.get(terminal_id).cloned() else {
            return;
        };
        drop(records);
        let output_guard = record.output.lock();
        if let Ok(mut output) = output_guard {
            if matches!(
                output.status,
                RemoteTerminalStatus::Starting | RemoteTerminalStatus::Running
            ) {
                output.status = RemoteTerminalStatus::Stopping;
            }
        };
    }

    fn mark_error(&self, terminal_id: &str, message: String) {
        let Ok(records) = self.records.lock() else {
            return;
        };
        let Some(record) = records.get(terminal_id).cloned() else {
            return;
        };
        drop(records);
        let output_guard = record.output.lock();
        if let Ok(mut output) = output_guard {
            output.status = RemoteTerminalStatus::Failed;
            output.error_message = Some(message);
            output.finished_at = Some(Instant::now());
        };
    }

    fn mark_exit(&self, terminal_id: &str, exit_code: Option<u32>) {
        let Ok(records) = self.records.lock() else {
            return;
        };
        let Some(record) = records.get(terminal_id).cloned() else {
            return;
        };
        drop(records);
        let output_guard = record.output.lock();
        if let Ok(mut output) = output_guard {
            if output.status != RemoteTerminalStatus::Failed {
                output.status = RemoteTerminalStatus::Exited;
                output.exit_code = exit_code;
            }
            output.finished_at = Some(Instant::now());
        };
    }

    fn output(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
        after_cursor: u64,
        max_chunks: usize,
    ) -> Result<RemoteTerminalOutput, String> {
        let record = self.get_owned(terminal_id, owner_device_id)?;
        let Ok(output) = record.output.lock() else {
            return Err("remote terminal output lock poisoned".to_string());
        };
        let first_cursor = output.chunks.front().map(|(cursor, _)| *cursor);
        let truncated = first_cursor.is_some_and(|cursor| after_cursor.saturating_add(1) < cursor);
        let limit = max_chunks.clamp(1, 256);
        let chunks = output
            .chunks
            .iter()
            .filter(|(cursor, _)| *cursor > after_cursor)
            .take(limit)
            .map(|(cursor, data)| RemoteTerminalOutputChunk {
                cursor: *cursor,
                data: BASE64_STANDARD.encode(data),
            })
            .collect::<Vec<_>>();
        let next_cursor = chunks
            .last()
            .map(|chunk| chunk.cursor)
            .unwrap_or(after_cursor.min(output.next_cursor));
        Ok(RemoteTerminalOutput {
            terminal: snapshot_from_locked(&record.metadata, &record.process, &output),
            chunks,
            next_cursor,
            truncated,
        })
    }

    fn snapshot(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
    ) -> Result<RemoteTerminalSnapshot, String> {
        let record = self.get_owned(terminal_id, owner_device_id)?;
        snapshot_for_record(&record)
    }

    fn remove(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
    ) -> Result<Arc<RemoteTerminalRecord>, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "remote terminal registry lock poisoned".to_string())?;
        let Some(record) = records.get(terminal_id).cloned() else {
            return Err("remote terminal session not found".to_string());
        };
        if record.metadata.owner_device_id != owner_device_id {
            return Err("remote terminal session not found".to_string());
        }
        records.remove(terminal_id);
        Ok(record)
    }

    fn clear(&self) {
        if let Ok(mut records) = self.records.lock() {
            records.clear();
        }
    }
}

fn snapshot_for_record(record: &RemoteTerminalRecord) -> Result<RemoteTerminalSnapshot, String> {
    let output = record
        .output
        .lock()
        .map_err(|_| "remote terminal output lock poisoned".to_string())?;
    Ok(snapshot_from_locked(
        &record.metadata,
        &record.process,
        &output,
    ))
}

fn snapshot_from_locked(
    metadata: &RemoteTerminalMetadata,
    process: &EmbeddedTerminalProcess,
    output: &RemoteOutputBuffer,
) -> RemoteTerminalSnapshot {
    RemoteTerminalSnapshot {
        terminal_id: metadata.terminal_id.clone(),
        session_key: metadata.session_key.clone(),
        platform: metadata.platform.clone(),
        command_kind: metadata.command_kind.clone(),
        title: metadata.title.clone(),
        cwd: metadata.cwd.clone(),
        status: output.status.as_str().to_string(),
        process_id: process.process_id,
        exit_code: output.exit_code,
        error_message: output.error_message.clone(),
        created_at: metadata.created_at,
        next_cursor: output.next_cursor,
    }
}

fn unix_millis_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

struct EmbeddedTerminalManager {
    sessions: Mutex<HashMap<String, Arc<EmbeddedTerminalProcess>>>,
}

impl Default for EmbeddedTerminalManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl EmbeddedTerminalManager {
    fn insert(
        &self,
        terminal_id: String,
        process: Arc<EmbeddedTerminalProcess>,
    ) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal manager lock poisoned".to_string())?;
        if sessions.contains_key(&terminal_id) {
            return Err("terminal id already exists".to_string());
        }
        sessions.insert(terminal_id, process);
        Ok(())
    }

    fn get(&self, terminal_id: &str) -> Result<Arc<EmbeddedTerminalProcess>, String> {
        self.sessions
            .lock()
            .map_err(|_| "terminal manager lock poisoned".to_string())?
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| "terminal session not found".to_string())
    }

    fn contains(&self, terminal_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(terminal_id))
            .unwrap_or(false)
    }

    fn remove(&self, terminal_id: &str) -> Option<Arc<EmbeddedTerminalProcess>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(terminal_id))
    }

    fn stop_all(&self) {
        let processes = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, process)| process)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for process in processes {
            process.kill();
        }
    }
}

impl Drop for EmbeddedTerminalManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[derive(Clone, Default)]
pub struct EmbeddedTerminalState {
    manager: Arc<EmbeddedTerminalManager>,
    remote: RemoteTerminalRegistry,
}

impl EmbeddedTerminalState {
    pub fn stop_all(&self) {
        self.manager.stop_all();
        self.remote.clear();
    }

    pub fn start_remote(
        &self,
        app: &AppHandle,
        request: StartEmbeddedTerminalRequest,
    ) -> Result<RemoteTerminalSnapshot, String> {
        let owner = request
            .owner_device_id
            .clone()
            .ok_or_else(|| "remote terminal owner is required".to_string())?;
        validate_device_id(&owner)?;
        validate_remote_terminal_id(&request.terminal_id)?;
        let terminal_id = request.terminal_id.clone();
        if let Ok(existing) = self.remote.snapshot(&terminal_id, &owner) {
            return Ok(existing);
        }
        start_terminal_internal(app.clone(), self, request, Some(self.remote.clone()))?;
        self.remote.snapshot(&terminal_id, &owner)
    }

    pub fn remote_list(
        &self,
        owner_device_id: &str,
    ) -> Result<Vec<RemoteTerminalSnapshot>, String> {
        validate_device_id(owner_device_id)?;
        self.remote.list_owned(owner_device_id)
    }

    pub fn remote_snapshot(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
    ) -> Result<RemoteTerminalSnapshot, String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        self.remote.snapshot(terminal_id, owner_device_id)
    }

    pub fn remote_output(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
        after_cursor: u64,
        max_chunks: usize,
    ) -> Result<RemoteTerminalOutput, String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        self.remote
            .output(terminal_id, owner_device_id, after_cursor, max_chunks)
    }

    pub fn remote_write(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
        data: &[u8],
    ) -> Result<(), String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        if data.len() > MAX_REMOTE_INPUT_BYTES {
            return Err("remote terminal input is too large".to_string());
        }
        let record = self.remote.get_owned(terminal_id, owner_device_id)?;
        record.process.write(data)
    }

    pub fn remote_resize(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        let record = self.remote.get_owned(terminal_id, owner_device_id)?;
        record.process.resize(cols, rows)
    }

    pub fn remote_stop(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
        force: bool,
    ) -> Result<(), String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        let record = self.remote.get_owned(terminal_id, owner_device_id)?;
        self.remote.mark_stopping(terminal_id);
        if force {
            record.process.kill();
            return Ok(());
        }
        let _ = record.process.write(&[0x03]);
        let manager = self.manager.clone();
        let remote = self.remote.clone();
        let id = terminal_id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1_500));
            if manager.contains(&id) {
                if let Ok(process) = manager.get(&id) {
                    remote.mark_stopping(&id);
                    process.kill();
                }
            }
        });
        Ok(())
    }

    pub fn remote_close(&self, terminal_id: &str, owner_device_id: &str) -> Result<(), String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        let record = self.remote.remove(terminal_id, owner_device_id)?;
        if self.manager.contains(terminal_id) {
            record.process.kill();
            let _ = self.manager.remove(terminal_id);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn seed_remote_for_test(
        &self,
        terminal_id: &str,
        owner_device_id: &str,
    ) -> Result<(), String> {
        validate_remote_terminal_id(terminal_id)?;
        validate_device_id(owner_device_id)?;
        self.remote.insert(
            RemoteTerminalMetadata {
                terminal_id: terminal_id.to_string(),
                owner_device_id: owner_device_id.to_string(),
                session_key: "claude:test-session".to_string(),
                platform: "claude".to_string(),
                command_kind: "resume".to_string(),
                title: "Remote HTTP test".to_string(),
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                created_at: unix_millis_now(),
            },
            Arc::new(EmbeddedTerminalProcess {
                writer: Mutex::new(None),
                master: Mutex::new(None),
                killer: Mutex::new(None),
                process_id: None,
            }),
        )?;
        self.remote.mark_running(terminal_id);
        self.remote
            .append_output(terminal_id, b"seeded remote output");
        Ok(())
    }
}

#[tauri::command]
pub fn start_embedded_terminal(
    app: AppHandle,
    state: tauri::State<'_, EmbeddedTerminalState>,
    request: StartEmbeddedTerminalRequest,
) -> Result<EmbeddedTerminalStarted, String> {
    start_terminal_internal(app, state.inner(), request, None)
}

fn start_terminal_internal(
    app: AppHandle,
    state: &EmbeddedTerminalState,
    request: StartEmbeddedTerminalRequest,
    remote_registry: Option<RemoteTerminalRegistry>,
) -> Result<EmbeddedTerminalStarted, String> {
    validate_request(&request)?;
    if let Some(owner) = request.owner_device_id.as_deref() {
        validate_device_id(owner)?;
    }
    let cwd = validate_cwd(request.cwd.as_deref())?;
    let size = PtySize {
        rows: request.rows.clamp(MIN_ROWS, MAX_ROWS),
        cols: request.cols.clamp(MIN_COLS, MAX_COLS),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("failed to create pseudo terminal: {error}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to open terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open terminal input: {error}"))?;

    let (mut command, launcher_path) =
        prepare_shell_command(&request.command, &cwd, &request.terminal_id)?;
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "MemoryForge");

    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            cleanup_launcher(launcher_path.as_deref());
            return Err(format!("failed to start terminal command: {error}"));
        }
    };
    drop(pair.slave);

    let process_id = child.process_id();
    let killer = child.clone_killer();

    let process = Arc::new(EmbeddedTerminalProcess {
        writer: Mutex::new(Some(writer)),
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(Some(killer)),
        process_id,
    });
    if let Err(error) = state
        .manager
        .insert(request.terminal_id.clone(), process.clone())
    {
        process.kill();
        cleanup_launcher(launcher_path.as_deref());
        return Err(error);
    }

    if let Some(remote) = remote_registry.as_ref() {
        let owner = request
            .owner_device_id
            .clone()
            .ok_or_else(|| "remote terminal owner is required".to_string())?;
        let metadata = RemoteTerminalMetadata {
            terminal_id: request.terminal_id.clone(),
            owner_device_id: owner,
            session_key: request.session_key.clone(),
            platform: request.platform.clone().unwrap_or_default(),
            command_kind: request.command_kind.clone(),
            title: request
                .session_title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| request.session_key.clone()),
            cwd: cwd.to_string_lossy().into_owned(),
            created_at: unix_millis_now(),
        };
        if let Err(error) = remote.insert(metadata, process.clone()) {
            let _ = state.manager.remove(&request.terminal_id);
            process.kill();
            cleanup_launcher(launcher_path.as_deref());
            return Err(error);
        }
    }

    let terminal_id = request.terminal_id.clone();
    let reader_app = app.clone();
    let reader_terminal_id = terminal_id.clone();
    let reader_manager = state.manager.clone();
    let reader_remote = remote_registry.clone();
    let reader_thread = thread::spawn(move || {
        stream_terminal_output(
            reader,
            &reader_app,
            &reader_manager,
            &reader_terminal_id,
            reader_remote.as_ref(),
        );
    });

    let waiter_app = app;
    let waiter_terminal_id = terminal_id.clone();
    let waiter_manager = state.manager.clone();
    if let Some(remote) = remote_registry.as_ref() {
        remote.mark_running(&terminal_id);
    }
    let waiter_remote = remote_registry;
    thread::spawn(move || {
        let exit_result = child.wait();
        if let Some(process) = waiter_manager.remove(&waiter_terminal_id) {
            process.close_io();
        }
        let _ = reader_thread.join();
        cleanup_launcher(launcher_path.as_deref());

        match exit_result {
            Ok(status) => {
                if let Some(remote) = waiter_remote.as_ref() {
                    remote.mark_exit(&waiter_terminal_id, Some(status.exit_code()));
                }
                emit_event(
                    &waiter_app,
                    EmbeddedTerminalEvent::Exit {
                        terminal_id: waiter_terminal_id,
                        exit_code: Some(status.exit_code()),
                    },
                );
            }
            Err(error) => {
                let message = format!("failed to wait for terminal process: {error}");
                if let Some(remote) = waiter_remote.as_ref() {
                    remote.mark_error(&waiter_terminal_id, message.clone());
                }
                emit_event(
                    &waiter_app,
                    EmbeddedTerminalEvent::Error {
                        terminal_id: waiter_terminal_id,
                        message,
                    },
                );
            }
        }
    });

    Ok(EmbeddedTerminalStarted {
        terminal_id,
        cwd: cwd.to_string_lossy().into_owned(),
        process_id,
    })
}

#[tauri::command]
pub fn write_embedded_terminal(
    state: tauri::State<'_, EmbeddedTerminalState>,
    terminal_id: String,
    data: String,
    binary: bool,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let bytes = if binary {
        BASE64_STANDARD
            .decode(data)
            .map_err(|error| format!("failed to decode terminal input: {error}"))?
    } else {
        data.into_bytes()
    };
    state.manager.get(&terminal_id)?.write(&bytes)
}

#[tauri::command]
pub fn resize_embedded_terminal(
    state: tauri::State<'_, EmbeddedTerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    state.manager.get(&terminal_id)?.resize(cols, rows)
}

#[tauri::command]
pub fn stop_embedded_terminal(
    state: tauri::State<'_, EmbeddedTerminalState>,
    terminal_id: String,
    force: bool,
) -> Result<(), String> {
    validate_terminal_id(&terminal_id)?;
    let process = state.manager.get(&terminal_id)?;

    if force {
        process.kill();
        return Ok(());
    }

    // Give interactive CLIs a chance to handle Ctrl+C before terminating the PTY.
    let _ = process.write(&[0x03]);
    let manager = state.manager.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1_500));
        if manager.contains(&terminal_id) {
            if let Ok(process) = manager.get(&terminal_id) {
                process.kill();
            }
        }
    });
    Ok(())
}

fn validate_request(request: &StartEmbeddedTerminalRequest) -> Result<(), String> {
    validate_terminal_id(&request.terminal_id)?;
    if request.session_key.trim().is_empty() {
        return Err("session key is empty".to_string());
    }
    let command = request.command.trim();
    if command.is_empty() {
        return Err("terminal command is empty".to_string());
    }
    if command.len() > MAX_COMMAND_LENGTH {
        return Err("terminal command is too long".to_string());
    }
    if command.contains('\0') {
        return Err("terminal command contains a null byte".to_string());
    }
    if !matches!(request.command_kind.as_str(), "resume" | "fork" | "shell") {
        return Err("unsupported terminal command kind".to_string());
    }
    if request
        .session_title
        .as_deref()
        .is_some_and(|title| title.len() > 512)
    {
        return Err("terminal session title is too long".to_string());
    }
    Ok(())
}

pub fn validate_terminal_id(terminal_id: &str) -> Result<(), String> {
    if terminal_id.is_empty()
        || terminal_id.len() > 128
        || !terminal_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid terminal id".to_string());
    }
    Ok(())
}

pub fn validate_remote_terminal_id(terminal_id: &str) -> Result<(), String> {
    validate_terminal_id(terminal_id)?;
    if !terminal_id.starts_with("remote_") {
        return Err("remote terminal id must start with remote_".to_string());
    }
    Ok(())
}

pub fn validate_device_id(device_id: &str) -> Result<(), String> {
    if device_id.is_empty()
        || device_id.len() > 128
        || !device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("invalid remote device id".to_string());
    }
    Ok(())
}

fn validate_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Path::new(value).to_path_buf(),
        None => std::env::current_dir().map_err(|error| format!("failed to read cwd: {error}"))?,
    };
    if !path.is_dir() {
        return Err("terminal working directory does not exist".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve terminal working directory: {error}"))?;

    #[cfg(target_os = "windows")]
    return Ok(normalize_windows_canonical_path(canonical));

    #[cfg(not(target_os = "windows"))]
    Ok(canonical)
}

#[cfg(target_os = "windows")]
fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(target_os = "windows")]
fn prepare_shell_command(
    command: &str,
    cwd: &Path,
    terminal_id: &str,
) -> Result<(CommandBuilder, Option<PathBuf>), String> {
    let launcher_path = std::env::temp_dir().join(format!("memory_forge_{terminal_id}.cmd"));
    let cwd_command = build_windows_cwd_command(cwd);
    let script_content = format!("@echo off\r\n{cwd_command}{command}\r\n");
    std::fs::write(&launcher_path, script_content)
        .map_err(|error| format!("failed to write terminal launcher: {error}"))?;

    let builder = build_windows_shell_command(&launcher_path, true);
    Ok((builder, Some(launcher_path)))
}

#[cfg(target_os = "windows")]
fn build_windows_shell_command(launcher_path: &Path, keep_open: bool) -> CommandBuilder {
    let shell = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
    let mut builder = CommandBuilder::new(shell);
    builder.args(["/D", if keep_open { "/K" } else { "/C" }]);
    builder.arg("call");
    builder.arg(launcher_path);
    builder
}

#[cfg(not(target_os = "windows"))]
fn prepare_shell_command(
    command: &str,
    _cwd: &Path,
    _terminal_id: &str,
) -> Result<(CommandBuilder, Option<PathBuf>), String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
    let mut builder = CommandBuilder::new(shell);
    builder.args(["-lc", command]);
    Ok((builder, None))
}

#[cfg(target_os = "windows")]
fn build_windows_cwd_command(cwd: &Path) -> String {
    let value = cwd.to_string_lossy();
    let escaped = escape_windows_batch_value(&value);
    if value.starts_with(r"\\") {
        format!("pushd \"{escaped}\" || exit /b 1\r\n")
    } else {
        format!("cd /d \"{escaped}\" || exit /b 1\r\n")
    }
}

#[cfg(target_os = "windows")]
fn escape_windows_batch_value(value: &str) -> String {
    // The path is already inside double quotes, so cmd metacharacters are literal.
    // Percent signs still need doubling because batch variable expansion happens in quotes.
    value.replace('%', "%%")
}

fn cleanup_launcher(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

fn stream_terminal_output(
    mut reader: Box<dyn std::io::Read + Send>,
    app: &AppHandle,
    manager: &EmbeddedTerminalManager,
    terminal_id: &str,
    remote_registry: Option<&RemoteTerminalRegistry>,
) {
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut last_emit = Instant::now()
        .checked_sub(OUTPUT_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let elapsed = last_emit.elapsed();
                if elapsed < OUTPUT_INTERVAL {
                    thread::sleep(OUTPUT_INTERVAL - elapsed);
                }
                if let Some(remote) = remote_registry {
                    remote.append_output(terminal_id, &buffer[..read]);
                }
                emit_event(
                    app,
                    EmbeddedTerminalEvent::Output {
                        terminal_id: terminal_id.to_string(),
                        data: BASE64_STANDARD.encode(&buffer[..read]),
                    },
                );
                last_emit = Instant::now();
            }
            Err(error) => {
                if manager.contains(terminal_id) {
                    let message = format!("terminal output stream failed: {error}");
                    if let Some(remote) = remote_registry {
                        remote.mark_error(terminal_id, message.clone());
                    }
                    emit_event(
                        app,
                        EmbeddedTerminalEvent::Error {
                            terminal_id: terminal_id.to_string(),
                            message,
                        },
                    );
                }
                break;
            }
        }
    }
}

fn emit_event(app: &AppHandle, event: EmbeddedTerminalEvent) {
    let _ = app.emit(TERMINAL_EVENT_NAME, event);
}

#[cfg(target_os = "windows")]
fn terminate_windows_process_tree(process_id: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_remote_process() -> Arc<EmbeddedTerminalProcess> {
        Arc::new(EmbeddedTerminalProcess {
            writer: Mutex::new(None),
            master: Mutex::new(None),
            killer: Mutex::new(None),
            process_id: None,
        })
    }

    fn remote_metadata(
        terminal_id: impl Into<String>,
        owner_device_id: impl Into<String>,
        created_at: u64,
    ) -> RemoteTerminalMetadata {
        RemoteTerminalMetadata {
            terminal_id: terminal_id.into(),
            owner_device_id: owner_device_id.into(),
            session_key: "codex:session".to_string(),
            platform: "codex".to_string(),
            command_kind: "resume".to_string(),
            title: "Remote test".to_string(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            created_at,
        }
    }

    fn request() -> StartEmbeddedTerminalRequest {
        StartEmbeddedTerminalRequest {
            terminal_id: "terminal_123".to_string(),
            session_key: "session".to_string(),
            command: "codex resume abc".to_string(),
            command_kind: "resume".to_string(),
            cwd: None,
            cols: 120,
            rows: 40,
            owner_device_id: None,
            platform: Some("codex".to_string()),
            session_title: Some("Test session".to_string()),
        }
    }

    #[test]
    fn validates_terminal_request() {
        assert!(validate_request(&request()).is_ok());
    }

    #[test]
    fn rejects_unsafe_terminal_id() {
        let mut input = request();
        input.terminal_id = "../../terminal".to_string();
        assert!(validate_request(&input).is_err());
    }

    #[test]
    fn rejects_empty_or_null_commands() {
        let mut empty = request();
        empty.command = "   ".to_string();
        assert!(validate_request(&empty).is_err());

        let mut null = request();
        null.command = "codex\0resume".to_string();
        assert!(validate_request(&null).is_err());
    }

    #[test]
    fn validates_remote_terminal_and_device_ids() {
        assert!(validate_remote_terminal_id("remote_123-abc").is_ok());
        assert!(validate_remote_terminal_id("terminal_123").is_err());
        assert!(validate_remote_terminal_id("remote_../../escape").is_err());
        assert!(validate_device_id("phone.2026-07_test").is_ok());
        assert!(validate_device_id("phone/other").is_err());
    }

    #[test]
    fn remote_registry_enforces_owner_and_cursor_reads() {
        let registry = RemoteTerminalRegistry::default();
        registry
            .insert(
                remote_metadata("remote_cursor", "phone_a", 10),
                dummy_remote_process(),
            )
            .expect("remote record should be inserted");
        registry.mark_running("remote_cursor");
        registry.append_output("remote_cursor", b"first");
        registry.append_output("remote_cursor", b"second");

        let initial = registry
            .output("remote_cursor", "phone_a", 0, 128)
            .expect("owner should read output");
        assert_eq!(initial.chunks.len(), 2);
        assert_eq!(initial.chunks[0].cursor, 1);
        assert_eq!(initial.next_cursor, 2);
        assert_eq!(
            BASE64_STANDARD
                .decode(&initial.chunks[1].data)
                .expect("output should be base64"),
            b"second"
        );

        let resumed = registry
            .output("remote_cursor", "phone_a", 1, 128)
            .expect("cursor read should succeed");
        assert_eq!(resumed.chunks.len(), 1);
        assert_eq!(resumed.chunks[0].cursor, 2);
        assert!(registry
            .output("remote_cursor", "phone_b", 0, 128)
            .expect_err("another device must not read the record")
            .contains("not found"));
    }

    #[test]
    fn remote_output_history_reports_truncation() {
        let registry = RemoteTerminalRegistry::default();
        registry
            .insert(
                remote_metadata("remote_history", "phone_a", 10),
                dummy_remote_process(),
            )
            .expect("remote record should be inserted");
        for _ in 0..=MAX_REMOTE_OUTPUT_CHUNKS {
            registry.append_output("remote_history", b"x");
        }

        let output = registry
            .output("remote_history", "phone_a", 0, 256)
            .expect("bounded history should remain readable");
        assert!(output.truncated);
        assert_eq!(output.chunks.first().map(|chunk| chunk.cursor), Some(2));
        assert_eq!(output.chunks.len(), 256);
        assert_eq!(
            output.terminal.next_cursor,
            (MAX_REMOTE_OUTPUT_CHUNKS + 1) as u64
        );
    }

    #[test]
    fn remote_registry_limits_active_terminals_per_device() {
        let registry = RemoteTerminalRegistry::default();
        for index in 0..MAX_REMOTE_TERMINALS_PER_DEVICE {
            registry
                .insert(
                    remote_metadata(format!("remote_active_{index}"), "phone_a", index as u64),
                    dummy_remote_process(),
                )
                .expect("active record within the device limit should be inserted");
        }
        let error = match registry.insert(
            remote_metadata("remote_active_overflow", "phone_a", 99),
            dummy_remote_process(),
        ) {
            Ok(_) => panic!("the per-device active limit should be enforced"),
            Err(error) => error,
        };
        assert!(error.contains("this device"));
    }

    #[test]
    fn remote_registry_evicts_finished_history_when_host_is_full() {
        let registry = RemoteTerminalRegistry::default();
        for index in 0..MAX_REMOTE_TERMINALS {
            let terminal_id = format!("remote_finished_{index}");
            registry
                .insert(
                    remote_metadata(&terminal_id, "phone_a", index as u64),
                    dummy_remote_process(),
                )
                .expect("finished history should fit up to the host limit");
            registry.mark_exit(&terminal_id, Some(0));
        }

        registry
            .insert(
                remote_metadata("remote_new", "phone_a", 100),
                dummy_remote_process(),
            )
            .expect("a finished record should be evicted to admit a new terminal");
        let owned = registry
            .list_owned("phone_a")
            .expect("remaining records should be listed");
        assert_eq!(owned.len(), MAX_REMOTE_TERMINALS);
        assert_eq!(
            owned.first().map(|item| item.terminal_id.as_str()),
            Some("remote_new")
        );
    }

    #[test]
    fn remote_registry_returns_an_error_for_a_poisoned_output_lock() {
        let registry = RemoteTerminalRegistry::default();
        let record = registry
            .insert(
                remote_metadata("remote_poison", "phone_a", 10),
                dummy_remote_process(),
            )
            .expect("remote record should be inserted");
        let panic_result = std::panic::catch_unwind(|| {
            let _guard = record
                .output
                .lock()
                .expect("output lock should start healthy");
            panic!("poison the output lock for the test");
        });
        assert!(panic_result.is_err());

        let error = registry
            .list_owned("phone_a")
            .expect_err("poisoning must be reported instead of panicking the service");
        assert!(error.contains("output lock poisoned"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_windows_verbatim_path_prefixes() {
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\C:\work\repo")),
            PathBuf::from(r"C:\work\repo")
        );
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_launcher_escapes_cwd_metacharacters() {
        assert_eq!(
            build_windows_cwd_command(Path::new(r"C:\work\100%&(test)")),
            "cd /d \"C:\\work\\100%%&(test)\" || exit /b 1\r\n"
        );
        assert_eq!(
            build_windows_cwd_command(Path::new(r"\\server\share\repo")),
            "pushd \"\\\\server\\share\\repo\" || exit /b 1\r\n"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_launcher_executes_special_cwd() {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let terminal_id = format!("launcher_test_{suffix}");
        let cwd = std::env::temp_dir().join(format!("memory forge 100% & (test) ^ {suffix}"));
        std::fs::create_dir_all(&cwd).expect("test cwd should be created");

        let (_, launcher_path) =
            prepare_shell_command("echo MF_LAUNCHER_OK\r\nexit 0", &cwd, &terminal_id)
                .expect("launcher should be prepared");
        let launcher_path = launcher_path.expect("windows launcher path");
        let output = std::process::Command::new(
            std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
        )
        .args(["/D", "/C", "call"])
        .arg(&launcher_path)
        .current_dir(&cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("launcher should execute");
        cleanup_launcher(Some(&launcher_path));
        std::fs::remove_dir_all(&cwd).expect("test cwd should be removed");

        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("MF_LAUNCHER_OK"));
    }
}
