use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct CliShimInfo {
    pub shim_path: String,
    /// True when we modified the user's PATH (registry on Windows,
    /// shell-config file on Unix) — caller should prompt a terminal restart.
    pub path_was_updated: bool,
}

// ---------------------------------------------------------------------------
// Helpers: paths
// ---------------------------------------------------------------------------

fn get_exe_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

/// The directory where the shim script lives.
/// Windows : %LOCALAPPDATA%\Programs\waypoint-cli\
/// Unix    : ~/.local/bin/
#[cfg(target_os = "windows")]
fn shim_dir() -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(local).join("Programs").join("waypoint-cli"))
}

#[cfg(not(target_os = "windows"))]
fn shim_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(".local").join("bin"))
}

/// The shim script file path.
fn shim_path() -> Result<PathBuf, String> {
    let dir = shim_dir()?;
    if cfg!(target_os = "windows") {
        Ok(dir.join("waypoint.cmd"))
    } else {
        Ok(dir.join("waypoint"))
    }
}

// ---------------------------------------------------------------------------
// Helpers: shim content
// ---------------------------------------------------------------------------

/// Windows CMD shim.
/// Resolves the first argument to an absolute directory path (or uses %CD%
/// when called with no arguments) then launches the Waypoint binary detached.
///
/// We intentionally do NOT use `setlocal enabledelayedexpansion` because the
/// hardcoded exe path is baked into the script at install time: if the path
/// contains `!` characters (legal on Windows, e.g. a username like "John!Doe"),
/// delayed-expansion would consume them and corrupt the path at every invocation.
/// `%_WP_DIR%` on the `start` line is outside the if/else block, so it is
/// expanded at execution time — the normal CMD phase-2 expansion is enough.
#[cfg(target_os = "windows")]
fn build_shim_content(exe_str: &str) -> String {
    // Escape double-quotes that might appear inside the path (rare but legal).
    let exe = exe_str.replace('"', "\"\"");
    format!(
        "@echo off\r\n\
         setlocal\r\n\
         if \"%~1\"==\"\" (\r\n\
             set \"_WP_DIR=%CD%\"\r\n\
         ) else (\r\n\
             pushd \"%~1\" 2>nul\r\n\
             if not errorlevel 1 (\r\n\
                 set \"_WP_DIR=%CD%\"\r\n\
                 popd\r\n\
             ) else (\r\n\
                 set \"_WP_DIR=%~f1\"\r\n\
             )\r\n\
         )\r\n\
         start \"\" \"{exe}\" \"%_WP_DIR%\"\r\n\
         endlocal\r\n",
        exe = exe
    )
}

/// POSIX shell shim.
/// Resolves the first argument to an absolute path, then launches Waypoint in
/// the background so the terminal is immediately reusable.
///
/// We use `nohup … > /dev/null 2>&1 &` instead of `… & disown $!` because
/// `disown` is a bash/zsh builtin and is not defined by POSIX sh.  On systems
/// where /bin/sh is dash (Debian, Ubuntu, most CI images), `disown` would
/// print "not found" and the process would remain in the job table, causing
/// SIGHUP to kill Waypoint when the terminal window is closed.  `nohup` is
/// POSIX-standard and handles signal detachment portably.
#[cfg(not(target_os = "windows"))]
fn build_shim_content(exe_str: &str) -> String {
    // Escape any embedded double-quotes (unlikely for a binary path, but safe).
    let exe = exe_str.replace('"', "\\\"");
    format!(
        "#!/bin/sh\n\
         if [ -z \"$1\" ]; then\n\
             _wp_dir=\"$PWD\"\n\
         else\n\
             _wp_dir=\"$(cd \"$1\" 2>/dev/null && pwd)\" || _wp_dir=\"$1\"\n\
         fi\n\
         nohup \"{exe}\" \"$_wp_dir\" > /dev/null 2>&1 &\n",
        exe = exe
    )
}

// ---------------------------------------------------------------------------
// Helpers: make the shim executable on Unix
// ---------------------------------------------------------------------------

fn set_executable(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(_path).map_err(|e| e.to_string())?;
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(_path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers: PATH management
// ---------------------------------------------------------------------------

/// Windows: append the shim directory to the user's PATH in the registry
/// (HKCU\Environment\Path). Returns true when a change was made.
#[cfg(target_os = "windows")]
fn path_add(dir: &str) -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| e.to_string())?;

    let current: String = env.get_value("Path").unwrap_or_default();

    // Case-insensitive check — avoid duplicates.
    if current.split(';').any(|p| p.trim().eq_ignore_ascii_case(dir)) {
        return Ok(false);
    }

    let new_path = if current.is_empty() {
        dir.to_string()
    } else {
        format!("{};{}", current.trim_end_matches(';'), dir)
    };

    env.set_value("Path", &new_path)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Windows: remove the shim directory from the user's PATH.
#[cfg(target_os = "windows")]
fn path_remove(dir: &str) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| e.to_string())?;

    let current: String = env.get_value("Path").unwrap_or_default();
    let filtered: Vec<&str> = current
        .split(';')
        .filter(|p| !p.trim().eq_ignore_ascii_case(dir))
        .collect();

    env.set_value("Path", &filtered.join(";"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Unix: add `$HOME/.local/bin` to the user's shell init file when it is not
/// already on $PATH. Returns true when a config file was modified.
#[cfg(not(target_os = "windows"))]
fn path_add_unix() -> Result<bool, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let local_bin = format!("{}/.local/bin", home);

    // Check the live PATH first — if the dir is already there, nothing to do.
    let live_path = std::env::var("PATH").unwrap_or_default();
    if live_path
        .split(':')
        .any(|p| p == local_bin || p == "$HOME/.local/bin")
    {
        return Ok(false);
    }

    let export_line = "\n# Added by Waypoint CLI\nexport PATH=\"$HOME/.local/bin:$PATH\"\n";

    // Prefer the default shell's rc/profile.  On macOS the default shell is
    // zsh (login profile is .zprofile); on Linux it is usually bash (.bashrc).
    let rel_candidates: &[&str] = if cfg!(target_os = "macos") {
        &[".zprofile", ".zshrc", ".bash_profile", ".profile"]
    } else {
        &[".bashrc", ".bash_profile", ".zshrc", ".profile"]
    };

    for rel in rel_candidates {
        let file_path = format!("{}/{}", home, rel);
        let p = Path::new(&file_path);
        if p.exists() {
            let contents = std::fs::read_to_string(p).unwrap_or_default();
            // Check only for the marker comment we write, or for the specific
            // export line we produce.  A broad ".local/bin" substring match
            // would fire on unrelated comments (e.g. "# pipx uses ~/.local/bin")
            // and silently skip writing the export, leaving `waypoint` off PATH
            // with no feedback to the user.
            if contents.contains("# Added by Waypoint CLI")
                || contents.contains("$HOME/.local/bin:$PATH")
            {
                return Ok(false);
            }
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(p)
                .map_err(|e| e.to_string())?;
            f.write_all(export_line.as_bytes())
                .map_err(|e| e.to_string())?;
            return Ok(true);
        }
    }

    // Nothing exists yet — create ~/.profile as a last resort.
    let profile = format!("{}/.profile", home);
    std::fs::write(&profile, export_line).map_err(|e| e.to_string())?;
    Ok(true)
}

// A single dispatcher so `register_cli_shim` doesn't need cfg blocks inline.
fn ensure_in_path(dir: &Path) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let dir_str = dir.to_str().ok_or("Invalid shim directory")?;
        return path_add(dir_str);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        return path_add_unix();
    }
}

fn remove_from_path(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let dir_str = dir.to_str().ok_or("Invalid shim directory")?;
        return path_remove(dir_str);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On Unix we intentionally leave shell configs alone — ~/.local/bin
        // may contain other tools the user relies on.
        let _ = dir;
        return Ok(());
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Write the platform-appropriate shim script and update the user's PATH so
/// `waypoint [path]` works in any new terminal session.
#[tauri::command]
pub fn register_cli_shim() -> Result<CliShimInfo, String> {
    let exe_path = get_exe_path()?;
    let exe_str = exe_path.to_str().ok_or("Executable path is not valid UTF-8")?;

    let dir = shim_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = shim_path()?;
    let content = build_shim_content(exe_str);
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    set_executable(&path)?;

    let path_was_updated = ensure_in_path(&dir)?;

    Ok(CliShimInfo {
        shim_path: path.to_string_lossy().into_owned(),
        path_was_updated,
    })
}

/// Remove the shim script (and on Windows, remove the directory from PATH).
#[tauri::command]
pub fn unregister_cli_shim() -> Result<(), String> {
    let path = shim_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let dir = shim_dir()?;
    remove_from_path(&dir)?;
    Ok(())
}

/// Returns true when the shim script file is present on disk.
#[tauri::command]
pub fn check_cli_shim() -> Result<bool, String> {
    Ok(shim_path()?.exists())
}
