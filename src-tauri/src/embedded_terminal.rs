use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const TERMINAL_EVENT_NAME: &str = "embedded-terminal-event";
const OUTPUT_INTERVAL: Duration = Duration::from_millis(5);
const MAX_COMMAND_LENGTH: usize = 32_768;
const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 2;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 300;

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTerminalStarted {
    pub terminal_id: String,
    pub cwd: String,
    pub process_id: Option<u32>,
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
}

impl EmbeddedTerminalState {
    pub fn stop_all(&self) {
        self.manager.stop_all();
    }
}

#[tauri::command]
pub fn start_embedded_terminal(
    app: AppHandle,
    state: tauri::State<'_, EmbeddedTerminalState>,
    request: StartEmbeddedTerminalRequest,
) -> Result<EmbeddedTerminalStarted, String> {
    validate_request(&request)?;
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

    let terminal_id = request.terminal_id.clone();
    let reader_app = app.clone();
    let reader_terminal_id = terminal_id.clone();
    let reader_manager = state.manager.clone();
    let reader_thread = thread::spawn(move || {
        stream_terminal_output(reader, &reader_app, &reader_manager, &reader_terminal_id);
    });

    let waiter_app = app;
    let waiter_terminal_id = terminal_id.clone();
    let waiter_manager = state.manager.clone();
    thread::spawn(move || {
        let exit_result = child.wait();
        if let Some(process) = waiter_manager.remove(&waiter_terminal_id) {
            process.close_io();
        }
        let _ = reader_thread.join();
        cleanup_launcher(launcher_path.as_deref());

        match exit_result {
            Ok(status) => emit_event(
                &waiter_app,
                EmbeddedTerminalEvent::Exit {
                    terminal_id: waiter_terminal_id,
                    exit_code: Some(status.exit_code()),
                },
            ),
            Err(error) => emit_event(
                &waiter_app,
                EmbeddedTerminalEvent::Error {
                    terminal_id: waiter_terminal_id,
                    message: format!("failed to wait for terminal process: {error}"),
                },
            ),
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
    Ok(())
}

fn validate_terminal_id(terminal_id: &str) -> Result<(), String> {
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
                    emit_event(
                        app,
                        EmbeddedTerminalEvent::Error {
                            terminal_id: terminal_id.to_string(),
                            message: format!("terminal output stream failed: {error}"),
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

    fn request() -> StartEmbeddedTerminalRequest {
        StartEmbeddedTerminalRequest {
            terminal_id: "terminal_123".to_string(),
            session_key: "session".to_string(),
            command: "codex resume abc".to_string(),
            command_kind: "resume".to_string(),
            cwd: None,
            cols: 120,
            rows: 40,
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
