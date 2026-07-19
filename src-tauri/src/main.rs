// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod atomic_file;
mod database;
mod editor_targets;
mod embedded_terminal;
mod platforms;
mod remote_protocol;
mod remote_server;
mod session_service;
mod session_transfer;
mod settings;
mod shell;
mod terminal;
mod update_checker;

use database::{DbState, PromptCreate, PromptUpdate};
use session_service::DashboardSummary;
use settings::{AppSettings, AppSettingsPatch, SharedSettingsState};
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

// ─── Desktop Commands ───

#[tauri::command]
fn app_bootstrap(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSettingsState>,
) -> Result<settings::DesktopSnapshot, String> {
    settings::bootstrap(&app, state.inner())
}

#[tauri::command]
fn app_settings_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSettingsState>,
    patch: AppSettingsPatch,
) -> Result<settings::DesktopSnapshot, String> {
    settings::update_settings(&app, state.inner(), patch)
}

#[tauri::command]
fn app_show_main_window(app: tauri::AppHandle) {
    shell::show_main_window(&app);
}

#[tauri::command]
fn remote_server_status(
    state: tauri::State<'_, remote_server::RemoteServerState>,
) -> remote_server::RemoteServerStatus {
    state.status()
}

#[tauri::command]
fn remote_server_restart(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    settings_state: tauri::State<'_, SharedSettingsState>,
    remote_state: tauri::State<'_, remote_server::RemoteServerState>,
) -> Result<remote_server::RemoteServerStatus, String> {
    remote_state.stop()?;
    let data_dir = settings::ensure_data_dir(&app)?;
    let remote_settings = settings_state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings state".to_string())?
        .clone();
    let config = remote_server_config(&remote_settings, &data_dir)?;
    let context = remote_server::RemoteServerContext {
        db_path: db.db_path.clone(),
        settings: settings_state.settings.clone(),
        server_id: remote_server::load_or_create_server_id(&data_dir)?,
        server_name: remote_server::local_server_name(),
        server_version: app.package_info().version.to_string(),
        web_root: remote_web_root(&app),
        mutation_enabled: config.enable_mutations,
        mutation_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
        auth_required: config.require_auth,
        access_token: config.access_token.clone(),
    };
    remote_state.start(config, context)
}

fn remote_server_config(
    settings: &AppSettings,
    data_dir: &std::path::Path,
) -> Result<remote_server::RemoteServerConfig, String> {
    let lan_mode = settings.remote_bind_mode == "lan";
    let access_token = if lan_mode {
        Some(remote_server::load_or_create_access_token(data_dir)?)
    } else {
        None
    };
    let mut config = remote_server::RemoteServerConfig::loopback_default();
    config.bind_address = if lan_mode {
        std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
    } else {
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    };
    config.port = settings.remote_port;
    config.enable_mutations = settings.remote_mutations_enabled;
    config.require_auth = lan_mode;
    config.access_token = access_token;
    Ok(config)
}

fn remote_web_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let packaged = app.path().resource_dir().ok().map(|root| root.join("web"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("dist"));
    packaged
        .into_iter()
        .chain(development)
        .find(|root| root.join("index.html").is_file())
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<update_checker::UpdateInfo, String> {
    let version = app.config().version.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || update_checker::check_update(&version))
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn dashboard_summary(
    db: tauri::State<'_, DbState>,
    settings_state: tauri::State<'_, SharedSettingsState>,
) -> Result<DashboardSummary, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?
        .clone();
    let db_path = db.db_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let db = DbState::new(&db_path)?;
        session_service::dashboard_summary(&db, &settings)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
fn session_list(
    db: tauri::State<'_, DbState>,
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    query: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    show_archived: Option<bool>,
) -> Result<platforms::SessionListResult, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_service::session_list(
        &db,
        &settings,
        &platform,
        query.as_deref(),
        limit,
        offset.unwrap_or(0),
        show_archived.unwrap_or(false),
    )
}

#[tauri::command]
fn session_detail(
    db: tauri::State<'_, DbState>,
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    session_key: String,
) -> Result<platforms::SessionDetail, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_service::session_detail(&db, &settings, &platform, &session_key)
}

#[tauri::command]
async fn session_execution_output(
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    session_key: String,
    edit_target: String,
) -> Result<String, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_service::session_execution_output(&settings, &platform, &session_key, &edit_target)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn session_execution_outputs(
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    session_key: String,
    edit_targets: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_service::session_execution_outputs(
            &settings,
            &platform,
            &session_key,
            &edit_targets,
        )
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn launch_session_terminal(
    settings_state: tauri::State<'_, SharedSettingsState>,
    command: String,
    cwd: Option<String>,
) -> Result<bool, String> {
    let preferred_terminal = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?
        .preferred_terminal
        .clone();

    tauri::async_runtime::spawn_blocking(move || {
        terminal::launch_session_terminal(&command, cwd.as_deref(), preferred_terminal.as_deref())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))??;

    Ok(true)
}

#[tauri::command]
fn list_editor_targets() -> Result<Vec<editor_targets::EditorTarget>, String> {
    Ok(editor_targets::list_available_editor_targets())
}

#[tauri::command]
async fn open_path_in_editor(editor_id: String, path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        editor_targets::open_path_in_editor(&editor_id, &path)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))??;

    Ok(true)
}

#[tauri::command]
fn session_set_alias(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
    title: String,
) -> Result<database::SessionAlias, String> {
    session_service::session_set_alias(&db, &platform, &session_key, &title)
}

#[tauri::command]
fn session_toggle_flag(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
    flag: String,
) -> Result<bool, String> {
    session_service::session_toggle_flag(&db, &platform, &session_key, &flag)
}

#[tauri::command]
fn session_batch_set_flag(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_keys: Vec<String>,
    flag: String,
    set: bool,
) -> Result<usize, String> {
    session_service::session_batch_set_flag(&db, &platform, &session_keys, &flag, set)
}

#[tauri::command]
fn session_edit_message(
    db: tauri::State<'_, DbState>,
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    message_id: String,
    content: String,
    session_key: String,
    expected_revision: String,
) -> Result<(), String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_service::session_edit_message(
        &db,
        &settings,
        &platform,
        &message_id,
        &content,
        &session_key,
        &expected_revision,
    )
}

#[tauri::command]
fn session_edit_log(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
) -> Result<Vec<database::EditLog>, String> {
    session_service::session_edit_log(&db, &platform, &session_key)
}

#[tauri::command]
fn session_delete_edit_log(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
    edit_log_id: i64,
) -> Result<bool, String> {
    session_service::session_delete_edit_log(&db, &platform, &session_key, edit_log_id)
}

#[tauri::command]
fn session_clear_edit_logs(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
) -> Result<usize, String> {
    session_service::session_clear_edit_logs(&db, &platform, &session_key)
}

#[tauri::command]
fn session_restore_message(
    db: tauri::State<'_, DbState>,
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    edit_log_id: i64,
    session_key: String,
    expected_revision: String,
) -> Result<(), String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_service::session_restore_message(
        &db,
        &settings,
        &platform,
        edit_log_id,
        &session_key,
        &expected_revision,
    )
}

#[tauri::command]
fn session_export_raw_jsonl(
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    session_key: String,
    output_path: String,
) -> Result<session_transfer::RawJsonlExportResult, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_transfer::export_raw_jsonl(&settings, &platform, &session_key, &output_path)
}

#[tauri::command]
fn session_probe_jsonl_import(
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    input_path: String,
) -> Result<session_transfer::RawJsonlImportPreview, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_transfer::probe_jsonl_import(&settings, &platform, &input_path)
}

#[tauri::command]
fn session_import_raw_jsonl(
    settings_state: tauri::State<'_, SharedSettingsState>,
    platform: String,
    input_path: String,
    conflict_policy: session_transfer::ImportConflictPolicy,
) -> Result<session_transfer::RawJsonlImportResult, String> {
    let settings = settings_state
        .settings
        .lock()
        .map_err(|_| "lock error".to_string())?;
    session_transfer::import_raw_jsonl(&settings, &platform, &input_path, conflict_policy)
}

#[tauri::command]
fn session_export_markdown(output_path: String, content: String) -> Result<(), String> {
    session_transfer::export_markdown(&output_path, &content)
}

// ─── Prompt Commands ───

#[tauri::command]
fn prompt_list(
    db: tauri::State<'_, DbState>,
    search: Option<&str>,
    tag: Option<&str>,
) -> Result<Vec<database::Prompt>, String> {
    database::list_prompts(&db.conn, search, tag)
}

#[tauri::command]
fn prompt_create(
    db: tauri::State<'_, DbState>,
    input: PromptCreate,
) -> Result<database::Prompt, String> {
    database::create_prompt(&db.conn, &input)
}

#[tauri::command]
fn prompt_update(
    db: tauri::State<'_, DbState>,
    id: i64,
    input: PromptUpdate,
) -> Result<database::Prompt, String> {
    database::update_prompt(&db.conn, id, &input)
}

#[tauri::command]
fn prompt_delete(db: tauri::State<'_, DbState>, id: i64) -> Result<(), String> {
    database::delete_prompt(&db.conn, id)
}

#[tauri::command]
fn prompt_use(db: tauri::State<'_, DbState>, id: i64) -> Result<database::Prompt, String> {
    database::increment_prompt_use(&db.conn, id)
}

#[tauri::command]
fn prompt_export(db: tauri::State<'_, DbState>) -> Result<Vec<database::Prompt>, String> {
    database::export_prompts(&db.conn)
}

#[tauri::command]
fn prompt_import(
    db: tauri::State<'_, DbState>,
    prompts: Vec<PromptCreate>,
) -> Result<usize, String> {
    database::import_prompts(&db.conn, &prompts)
}

// ─── Main ───

fn main() {
    tauri::Builder::default()
        .manage(embedded_terminal::EmbeddedTerminalState::default())
        .manage(remote_server::RemoteServerState::default())
        .manage(SharedSettingsState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            shell::show_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .setup(|app| {
            // Settings
            let state = app.state::<SharedSettingsState>();
            settings::initialize(app.handle(), state.inner())?;
            shell::sync_close_to_tray_flag(settings::close_to_tray_enabled(state.inner()));
            shell::setup_tray(app.handle())?;

            // Database
            let data_dir = settings::ensure_data_dir(app.handle())?;
            let db_path = data_dir.join("memory-forge.db");
            let db_path_string = db_path.to_string_lossy().into_owned();
            let db_state = DbState::new(&db_path_string)?;
            {
                let conn = db_state.conn.lock().unwrap();
                database::init_tables(&conn)?;
            }
            app.manage(db_state);

            // Loopback/read-only are defaults; saved settings may opt into authenticated LAN access.
            let settings_state = app.state::<SharedSettingsState>();
            let remote_state = app.state::<remote_server::RemoteServerState>();
            let remote_settings = settings_state
                .settings
                .lock()
                .map_err(|_| "failed to lock settings state".to_string())?
                .clone();
            let remote_config = remote_server_config(&remote_settings, &data_dir)?;
            let remote_context = remote_server::RemoteServerContext {
                db_path: db_path_string,
                settings: settings_state.settings.clone(),
                server_id: remote_server::load_or_create_server_id(&data_dir)?,
                server_name: remote_server::local_server_name(),
                server_version: app.package_info().version.to_string(),
                web_root: remote_web_root(app.handle()),
                mutation_enabled: remote_config.enable_mutations,
                mutation_lock: std::sync::Arc::new(std::sync::Mutex::new(())),
                auth_required: remote_config.require_auth,
                access_token: remote_config.access_token.clone(),
            };
            if let Err(error) = remote_state.start(remote_config, remote_context) {
                eprintln!("[remote] daemon did not start: {error}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<embedded_terminal::EmbeddedTerminalState>()
                    .stop_all();
            }
            shell::handle_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            // Desktop
            app_bootstrap,
            app_settings_set,
            app_show_main_window,
            remote_server_status,
            remote_server_restart,
            check_update,
            session_export_markdown,
            dashboard_summary,
            session_list,
            session_detail,
            session_execution_output,
            session_execution_outputs,
            launch_session_terminal,
            embedded_terminal::start_embedded_terminal,
            embedded_terminal::write_embedded_terminal,
            embedded_terminal::resize_embedded_terminal,
            embedded_terminal::stop_embedded_terminal,
            list_editor_targets,
            open_path_in_editor,
            session_set_alias,
            session_toggle_flag,
            session_batch_set_flag,
            session_edit_message,
            session_edit_log,
            session_delete_edit_log,
            session_clear_edit_logs,
            session_restore_message,
            session_export_raw_jsonl,
            session_probe_jsonl_import,
            session_import_raw_jsonl,
            // Prompts
            prompt_list,
            prompt_create,
            prompt_update,
            prompt_delete,
            prompt_use,
            prompt_export,
            prompt_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
