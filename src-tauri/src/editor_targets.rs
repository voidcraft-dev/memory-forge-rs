use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTarget {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy)]
struct EditorTargetDefinition {
    id: &'static str,
    label: &'static str,
    command: &'static str,
    platform: TargetPlatform,
}

#[derive(Debug, Clone, Copy)]
enum TargetPlatform {
    Any,
    Macos,
    Windows,
    UnixFileManager,
}

const EDITOR_TARGETS: &[EditorTargetDefinition] = &[
    EditorTargetDefinition {
        id: "cursor",
        label: "Cursor",
        command: "cursor",
        platform: TargetPlatform::Any,
    },
    EditorTargetDefinition {
        id: "vscode",
        label: "VS Code",
        command: "code",
        platform: TargetPlatform::Any,
    },
    EditorTargetDefinition {
        id: "zed",
        label: "Zed",
        command: "zed",
        platform: TargetPlatform::Any,
    },
    EditorTargetDefinition {
        id: "finder",
        label: "Finder",
        command: "open",
        platform: TargetPlatform::Macos,
    },
    EditorTargetDefinition {
        id: "explorer",
        label: "Explorer",
        command: "explorer",
        platform: TargetPlatform::Windows,
    },
    EditorTargetDefinition {
        id: "file-manager",
        label: "File Manager",
        command: "xdg-open",
        platform: TargetPlatform::UnixFileManager,
    },
];

pub fn list_available_editor_targets() -> Vec<EditorTarget> {
    EDITOR_TARGETS
        .iter()
        .filter(|target| target_supported_on_current_platform(target.platform))
        .filter(|target| find_command(target.command).is_some())
        .map(|target| EditorTarget {
            id: target.id.to_string(),
            label: target.label.to_string(),
        })
        .collect()
}

pub fn open_path_in_editor(editor_id: &str, path: &str) -> Result<(), String> {
    let target = EDITOR_TARGETS
        .iter()
        .find(|target| target.id == editor_id)
        .ok_or_else(|| format!("Unknown editor target: {editor_id}"))?;

    if !target_supported_on_current_platform(target.platform) {
        return Err(format!("Editor target unavailable: {}", target.label));
    }

    let path = path.trim();
    if path.is_empty() {
        return Err("Path is empty".to_string());
    }

    let path_ref = Path::new(path);
    if !path_ref.is_absolute() {
        return Err("Editor target path must be an absolute local path".to_string());
    }
    if !path_ref.exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    let Some(command) = find_command(target.command) else {
        return Err(format!("Editor target unavailable: {}", target.label));
    };

    spawn_detached(&command, path)
}

fn target_supported_on_current_platform(platform: TargetPlatform) -> bool {
    match platform {
        TargetPlatform::Any => true,
        TargetPlatform::Macos => cfg!(target_os = "macos"),
        TargetPlatform::Windows => cfg!(target_os = "windows"),
        TargetPlatform::UnixFileManager => cfg!(all(unix, not(target_os = "macos"))),
    }
}

fn find_command(command: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if command == "explorer" {
            return Some(command.to_string());
        }

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = Command::new("where")
            .arg(command)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(ToString::to_string)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("which").arg(command).output().ok()?;

        if !output.status.success() {
            return None;
        }

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(ToString::to_string)
    }
}

#[cfg(target_os = "windows")]
fn spawn_detached(command: &str, path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut child = if is_windows_command_script(command) {
        let mut cmd = Command::new("cmd");
        let command_line = format!(
            "\"{}\" \"{}\"",
            escape_windows_command_arg(command),
            escape_windows_command_arg(path)
        );
        cmd.args(["/D", "/S", "/C", &command_line]);
        cmd
    } else {
        let mut cmd = Command::new(command);
        cmd.arg(path);
        cmd
    };

    child
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {command}: {e}"))
}

#[cfg(target_os = "windows")]
fn is_windows_command_script(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

#[cfg(target_os = "windows")]
fn escape_windows_command_arg(value: &str) -> String {
    value.replace('"', "\\\"")
}

#[cfg(not(target_os = "windows"))]
fn spawn_detached(command: &str, path: &str) -> Result<(), String> {
    Command::new(command)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {command}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_platforms_match_current_os() {
        assert!(target_supported_on_current_platform(TargetPlatform::Any));
        assert_eq!(
            target_supported_on_current_platform(TargetPlatform::Windows),
            cfg!(target_os = "windows")
        );
        assert_eq!(
            target_supported_on_current_platform(TargetPlatform::Macos),
            cfg!(target_os = "macos")
        );
        assert_eq!(
            target_supported_on_current_platform(TargetPlatform::UnixFileManager),
            cfg!(all(unix, not(target_os = "macos")))
        );
    }
}
