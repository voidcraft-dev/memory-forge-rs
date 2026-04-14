use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_MAIN: &str = "tray_show_main";
const TRAY_QUIT: &str = "tray_quit";

static CLOSE_TO_TRAY_ON_CLOSE: AtomicBool = AtomicBool::new(true);
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);
static APP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn sync_close_to_tray_flag(enabled: bool) {
    CLOSE_TO_TRAY_ON_CLOSE.store(enabled, Ordering::Relaxed);
}

pub fn tray_available() -> bool {
    TRAY_AVAILABLE.load(Ordering::Relaxed)
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    TRAY_AVAILABLE.store(false, Ordering::Relaxed);

    let show_main = MenuItem::with_id(app, TRAY_SHOW_MAIN, "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_main, &quit])?;

    let mut tray = TrayIconBuilder::with_id("vk-starter-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_MAIN => show_main_window(app),
            TRAY_QUIT => {
                APP_EXIT_REQUESTED.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    TRAY_AVAILABLE.store(true, Ordering::Relaxed);
    Ok(())
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        if APP_EXIT_REQUESTED.load(Ordering::Relaxed) {
            return;
        }

        let should_hide_to_tray = CLOSE_TO_TRAY_ON_CLOSE.load(Ordering::Relaxed)
            && TRAY_AVAILABLE.load(Ordering::Relaxed);

        if should_hide_to_tray {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}
