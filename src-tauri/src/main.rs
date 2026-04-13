// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod database;
mod platforms;
mod session_service;
mod settings;
mod shell;

use database::{DbState, PromptCreate, PromptUpdate};
use session_service::DashboardSummary;
use settings::{AppSettingsPatch, SharedSettingsState};
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
fn dashboard_summary(db: tauri::State<'_, DbState>) -> Result<DashboardSummary, String> {
    session_service::dashboard_summary(&db)
}

#[tauri::command]
fn session_list(
    db: tauri::State<'_, DbState>,
    platform: String,
    query: Option<String>,
) -> Result<Vec<platforms::SessionListItem>, String> {
    session_service::session_list(&db, &platform, query.as_deref())
}

#[tauri::command]
fn session_detail(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
) -> Result<platforms::SessionDetail, String> {
    session_service::session_detail(&db, &platform, &session_key)
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
fn session_edit_message(
    db: tauri::State<'_, DbState>,
    platform: String,
    message_id: String,
    content: String,
    session_key: String,
) -> Result<(), String> {
    session_service::session_edit_message(&db, &platform, &message_id, &content, &session_key)
}

#[tauri::command]
fn session_edit_log(
    db: tauri::State<'_, DbState>,
    platform: String,
    session_key: String,
) -> Result<Vec<database::EditLog>, String> {
    session_service::session_edit_log(&db, &platform, &session_key)
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
        .manage(SharedSettingsState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            shell::show_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            let db_state = DbState::new(db_path.to_string_lossy().as_ref())?;
            {
                let conn = db_state.conn.lock().unwrap();
                database::init_tables(&conn)?;
            }
            app.manage(db_state);

            Ok(())
        })
        .on_window_event(|window, event| {
            shell::handle_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            // Desktop
            app_bootstrap,
            app_settings_set,
            app_show_main_window,
            dashboard_summary,
            session_list,
            session_detail,
            session_set_alias,
            session_edit_message,
            session_edit_log,
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
