use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::shell;

const APP_NAME: &str = "Memory Forge";
const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub locale: String,
    pub close_to_tray_on_close: bool,
    pub launch_on_startup: bool,
    pub reduce_motion: bool,
    #[serde(default)]
    pub claude_home: Option<String>,
    #[serde(default)]
    pub codex_home: Option<String>,
    #[serde(default)]
    pub opencode_path: Option<String>,
    #[serde(default)]
    pub kiro_home: Option<String>,
    #[serde(default)]
    pub gemini_home: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "porcelain".to_string(),
            locale: "zh-CN".to_string(),
            close_to_tray_on_close: true,
            launch_on_startup: false,
            reduce_motion: false,
            claude_home: None,
            codex_home: None,
            opencode_path: None,
            kiro_home: None,
            gemini_home: None,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsPatch {
    pub theme: Option<String>,
    pub locale: Option<String>,
    pub close_to_tray_on_close: Option<bool>,
    pub launch_on_startup: Option<bool>,
    pub reduce_motion: Option<bool>,
    pub claude_home: Option<Option<String>>,
    pub codex_home: Option<Option<String>>,
    pub opencode_path: Option<Option<String>>,
    pub kiro_home: Option<Option<String>>,
    pub gemini_home: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub app_name: String,
    pub version: String,
    pub runtime: String,
    pub config_dir: String,
    pub config_file: String,
    pub data_dir: String,
    pub db_path: String,
    pub tray_available: bool,
    pub autostart_supported: bool,
    pub settings: AppSettings,
}

#[derive(Default)]
pub struct SharedSettingsState {
    pub settings: Mutex<AppSettings>,
}

pub fn initialize(app: &AppHandle, state: &SharedSettingsState) -> Result<(), String> {
    let loaded = load_settings(app)?;
    let mut guard = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings state".to_string())?;
    *guard = loaded;
    Ok(())
}

pub fn close_to_tray_enabled(state: &SharedSettingsState) -> bool {
    state
        .settings
        .lock()
        .map(|settings| settings.close_to_tray_on_close)
        .unwrap_or(true)
}

pub fn bootstrap(app: &AppHandle, state: &SharedSettingsState) -> Result<DesktopSnapshot, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings state".to_string())?;

    let autostart_supported = match app.autolaunch().is_enabled() {
        Ok(enabled) => {
            settings.launch_on_startup = enabled;
            true
        }
        Err(_) => false,
    };

    persist_settings(app, &settings)?;

    let db_path = ensure_data_dir(app)?.join("memory-forge.db");

    snapshot_from_settings(app, settings.clone(), autostart_supported, db_path.to_string_lossy().to_string())
}

pub fn update_settings(
    app: &AppHandle,
    state: &SharedSettingsState,
    patch: AppSettingsPatch,
) -> Result<DesktopSnapshot, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "failed to lock settings state".to_string())?;

    if let Some(theme) = patch.theme {
        settings.theme = theme;
    }

    if let Some(locale) = patch.locale {
        settings.locale = locale;
    }

    if let Some(close_to_tray) = patch.close_to_tray_on_close {
        settings.close_to_tray_on_close = close_to_tray;
        shell::sync_close_to_tray_flag(close_to_tray);
    }

    if let Some(reduce_motion) = patch.reduce_motion {
        settings.reduce_motion = reduce_motion;
    }

    if let Some(claude_home) = patch.claude_home {
        settings.claude_home = claude_home.filter(|s| !s.trim().is_empty());
    }

    if let Some(codex_home) = patch.codex_home {
        settings.codex_home = codex_home.filter(|s| !s.trim().is_empty());
    }

    if let Some(opencode_path) = patch.opencode_path {
        settings.opencode_path = opencode_path.filter(|s| !s.trim().is_empty());
    }

    if let Some(kiro_home) = patch.kiro_home {
        settings.kiro_home = kiro_home.filter(|s| !s.trim().is_empty());
    }

    if let Some(gemini_home) = patch.gemini_home {
        settings.gemini_home = gemini_home.filter(|s| !s.trim().is_empty());
    }

    let autostart_supported = if let Some(launch_on_startup) = patch.launch_on_startup {
        set_autostart(app, launch_on_startup)?;
        settings.launch_on_startup = launch_on_startup;
        true
    } else {
        match app.autolaunch().is_enabled() {
            Ok(enabled) => {
                settings.launch_on_startup = enabled;
                true
            }
            Err(_) => false,
        }
    };

    persist_settings(app, &settings)?;

    let db_path = ensure_data_dir(app)?.join("memory-forge.db");
    snapshot_from_settings(app, settings.clone(), autostart_supported, db_path.to_string_lossy().to_string())
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| format!("failed to enable autostart: {error}"))?;
        return Ok(());
    }

    match manager.disable() {
        Ok(_) => Ok(()),
        Err(error) => {
            let message = error.to_string();
            if message.contains("os error 2") {
                Ok(())
            } else {
                Err(format!("failed to disable autostart: {error}"))
            }
        }
    }
}

fn snapshot_from_settings(
    app: &AppHandle,
    settings: AppSettings,
    autostart_supported: bool,
    db_path: String,
) -> Result<DesktopSnapshot, String> {
    let config_dir = ensure_config_dir(app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;

    Ok(DesktopSnapshot {
        app_name: APP_NAME.to_string(),
        version: app.package_info().version.to_string(),
        runtime: "tauri".to_string(),
        config_dir: config_dir.display().to_string(),
        config_file: config_dir.join(SETTINGS_FILE_NAME).display().to_string(),
        data_dir: data_dir.display().to_string(),
        db_path,
        tray_available: shell::tray_available(),
        autostart_supported,
        settings,
    })
}

fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_file_path(app)?;
    if !path.exists() {
        let defaults = AppSettings::default();
        persist_settings(app, &defaults)?;
        return Ok(defaults);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read settings file '{}': {error}", path.display()))?;

    serde_json::from_str::<AppSettings>(&raw).map_err(|error| {
        format!(
            "failed to parse settings file '{}': {error}",
            path.display()
        )
    })
}

fn persist_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_file_path(app)?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("failed to serialize settings: {error}"))?;
    fs::write(&path, json)
        .map_err(|error| format!("failed to write settings file '{}': {error}", path.display()))
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_config_dir(app)?.join(SETTINGS_FILE_NAME))
}

fn ensure_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve config directory: {error}"))?;
    fs::create_dir_all(&config_dir).map_err(|error| {
        format!(
            "failed to create config directory '{}': {error}",
            config_dir.display()
        )
    })?;
    Ok(config_dir)
}

pub fn ensure_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve data directory: {error}"))?;
    fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "failed to create data directory '{}': {error}",
            data_dir.display()
        )
    })?;
    Ok(data_dir)
}
