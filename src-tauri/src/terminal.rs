#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::Path;

pub fn launch_session_terminal(
    command: &str,
    cwd: Option<&str>,
    preferred_terminal: Option<&str>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("command is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        return launch_windows_terminal(command, cwd, preferred_terminal);
    }

    #[cfg(target_os = "macos")]
    {
        return launch_macos_terminal(command, cwd, preferred_terminal);
    }

    #[cfg(target_os = "linux")]
    {
        return launch_linux_terminal(command, cwd, preferred_terminal);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (command, cwd, preferred_terminal);
        Err("unsupported operating system".to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn write_shell_launcher(command: &str, cwd: Option<&str>) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let script_file = std::env::temp_dir().join(format!(
        "memory_forge_session_{}.sh",
        launcher_suffix()
    ));
    let cd_command = build_shell_cd_command(cwd);
    let script_content = format!(
        r#"#!/usr/bin/env bash
trap 'rm -f "{script_path}"' EXIT
{cd_command}
{command}
status=$?
echo
echo "[Memory Forge] Command exited with status $status. Press Enter to close."
read -r _
"#,
        script_path = script_file.display(),
        cd_command = cd_command,
        command = command,
    );

    std::fs::write(&script_file, script_content)
        .map_err(|e| format!("failed to write launch script: {e}"))?;
    std::fs::set_permissions(&script_file, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("failed to make launch script executable: {e}"))?;

    Ok(script_file)
}

#[cfg(target_os = "macos")]
fn launch_macos_terminal(
    command: &str,
    cwd: Option<&str>,
    preferred_terminal: Option<&str>,
) -> Result<(), String> {
    let script_file = write_shell_launcher(command, cwd)?;
    let terminal = preferred_terminal.unwrap_or("terminal");

    let result = match terminal {
        "iterm2" => launch_macos_iterm2(&script_file),
        "alacritty" => launch_macos_open_app("Alacritty", &script_file, true),
        "kitty" => launch_macos_open_app("kitty", &script_file, false),
        "ghostty" => launch_macos_ghostty(&script_file),
        "wezterm" => launch_macos_open_app("WezTerm", &script_file, true),
        "kaku" => launch_macos_open_app("Kaku", &script_file, true),
        _ => launch_macos_terminal_app(&script_file),
    };

    if result.is_err() && terminal != "terminal" {
        return launch_macos_terminal_app(&script_file);
    }

    result
}

#[cfg(target_os = "macos")]
fn launch_macos_terminal_app(script_file: &Path) -> Result<(), String> {
    use std::process::Command;

    let invocation = format!("bash {}", shell_single_quote(&script_file.to_string_lossy()));
    let script = format!(
        r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
        escape_osascript(&invocation)
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_macos_iterm2(script_file: &Path) -> Result<(), String> {
    use std::process::Command;

    let invocation = format!("bash {}", shell_single_quote(&script_file.to_string_lossy()));
    let script = format!(
        r#"set launcher_script to "{}"
set was_running to application "iTerm" is running
tell application "iTerm"
    if was_running then
        activate
        if (count of windows) = 0 then
            create window with default profile
        else
            tell current window
                create tab with default profile
            end tell
        end if
    else
        activate
        set waited to 0
        repeat while (count of windows) = 0
            delay 0.1
            set waited to waited + 1
            if waited >= 30 then exit repeat
        end repeat
        if (count of windows) = 0 then
            create window with default profile
        end if
    end if
    tell current session of current window
        write text launcher_script
    end tell
end tell"#,
        escape_osascript(&invocation)
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_macos_ghostty(script_file: &Path) -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("open")
        .args([
            "-na",
            "Ghostty",
            "--args",
            "--quit-after-last-window-closed=true",
            "-e",
            "bash",
        ])
        .arg(script_file)
        .output()
        .map_err(|e| format!("failed to launch Ghostty: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_macos_open_app(
    app_name: &str,
    script_file: &Path,
    use_e_flag: bool,
) -> Result<(), String> {
    use std::process::Command;

    let mut cmd = Command::new("open");
    cmd.arg("-na").arg(app_name).arg("--args");
    if use_e_flag {
        cmd.arg("-e");
    }
    cmd.arg("bash").arg(script_file);

    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch {app_name}: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(target_os = "linux")]
fn launch_linux_terminal(
    command: &str,
    cwd: Option<&str>,
    preferred_terminal: Option<&str>,
) -> Result<(), String> {
    use std::process::Command;

    let script_file = write_shell_launcher(command, cwd)?;
    let default_terminals = [
        ("gnome-terminal", vec!["--"]),
        ("konsole", vec!["-e"]),
        ("xfce4-terminal", vec!["-e"]),
        ("mate-terminal", vec!["--"]),
        ("lxterminal", vec!["-e"]),
        ("alacritty", vec!["-e"]),
        ("kitty", vec!["-e"]),
        ("ghostty", vec!["-e"]),
    ];
    let terminals_to_try = preferred_first_terminals(preferred_terminal, &default_terminals);
    let mut last_error = "no available terminal found".to_string();

    for (terminal, args) in terminals_to_try {
        if !which_command(terminal)
            && !["/usr/bin", "/bin", "/usr/local/bin"]
                .iter()
                .any(|dir| Path::new(&format!("{dir}/{terminal}")).exists())
        {
            continue;
        }

        match Command::new(terminal)
            .args(&args)
            .arg("bash")
            .arg(script_file.to_string_lossy().as_ref())
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(error) => last_error = format!("failed to launch {terminal}: {error}"),
        }
    }

    let _ = std::fs::remove_file(&script_file);
    Err(last_error)
}

#[cfg(target_os = "linux")]
fn preferred_first_terminals<'a>(
    preferred_terminal: Option<&'a str>,
    defaults: &'a [(&'a str, Vec<&'a str>)],
) -> Vec<(&'a str, Vec<&'a str>)> {
    if let Some(preferred) = preferred_terminal {
        let mut list = vec![(
            preferred,
            defaults
                .iter()
                .find(|(name, _)| *name == preferred)
                .map(|(_, args)| args.clone())
                .unwrap_or_else(|| vec!["-e"]),
        )];
        for (name, args) in defaults {
            if *name != preferred {
                list.push((*name, args.clone()));
            }
        }
        list
    } else {
        defaults
            .iter()
            .map(|(name, args)| (*name, args.clone()))
            .collect()
    }
}

#[cfg(target_os = "linux")]
fn which_command(command: &str) -> bool {
    std::process::Command::new("which")
        .arg(command)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn launch_windows_terminal(
    command: &str,
    cwd: Option<&str>,
    preferred_terminal: Option<&str>,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let bat_file = temp_dir.join(format!(
        "memory_forge_session_{}.bat",
        launcher_suffix()
    ));
    let cwd_command = cwd.map(build_windows_cwd_command_str).unwrap_or_default();
    let script_content = format!(
        "@echo off\r\n{cwd_command}{command}\r\ndel \"%~f0\" >nul 2>&1\r\n",
        cwd_command = cwd_command,
        command = command,
    );

    std::fs::write(&bat_file, script_content)
        .map_err(|e| format!("failed to write launch script: {e}"))?;

    let terminal = preferred_terminal.unwrap_or("cmd");
    let bat_path = bat_file.to_string_lossy();
    let powershell_command = format!("& '{}'", escape_powershell_single_quoted(&bat_path));

    let result = match terminal {
        "powershell" => run_windows_start_command(
            &["powershell", "-NoExit", "-Command", &powershell_command],
            "PowerShell",
        ),
        "wt" => run_windows_start_command(&["wt", "cmd", "/K", &bat_path], "Windows Terminal"),
        _ => run_windows_start_command(&["cmd", "/K", &bat_path], "Command Prompt"),
    };

    if result.is_err() && terminal != "cmd" {
        return run_windows_start_command(&["cmd", "/K", &bat_path], "Command Prompt");
    }

    if result.is_err() {
        let _ = std::fs::remove_file(&bat_file);
    }

    result
}

#[cfg(target_os = "windows")]
fn run_windows_start_command(args: &[&str], terminal_name: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut full_args = vec!["/C", "start", ""];
    full_args.extend(args);

    let output = Command::new("cmd")
        .args(full_args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to launch {terminal_name}: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn build_shell_cd_command(cwd: Option<&str>) -> String {
    cwd.map(|dir| format!("cd {} || exit 1\n", shell_single_quote(dir)))
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "macos")]
fn escape_osascript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_windows_unc_path(path: &str) -> bool {
    path.starts_with(r"\\")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn build_windows_cwd_command_str(path: &str) -> String {
    let escaped = escape_windows_batch_value(path);

    if is_windows_unc_path(path) {
        format!("pushd \"{escaped}\" || exit /b 1\r\n")
    } else {
        format!("cd /d \"{escaped}\" || exit /b 1\r\n")
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn escape_windows_batch_value(value: &str) -> String {
    value
        .replace('^', "^^")
        .replace('%', "%%")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('(', "^(")
        .replace(')', "^)")
}

fn launcher_suffix() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{}_{}", std::process::id(), millis)
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cwd_command_uses_cd_for_drive_paths() {
        let command = build_windows_cwd_command_str(r"C:\work\repo");

        assert_eq!(command, "cd /d \"C:\\work\\repo\" || exit /b 1\r\n");
    }

    #[test]
    fn windows_cwd_command_uses_pushd_for_unc_paths() {
        let command = build_windows_cwd_command_str(r"\\wsl$\Ubuntu\home\coder\repo");

        assert_eq!(
            command,
            "pushd \"\\\\wsl$\\Ubuntu\\home\\coder\\repo\" || exit /b 1\r\n"
        );
    }

    #[test]
    fn windows_cwd_command_escapes_batch_metacharacters() {
        let command = build_windows_cwd_command_str(r"\\server\share\100%&(test)");

        assert_eq!(
            command,
            "pushd \"\\\\server\\share\\100%%^&^(test^)\" || exit /b 1\r\n"
        );
    }
}
