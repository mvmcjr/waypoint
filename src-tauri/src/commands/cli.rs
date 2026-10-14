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

/// Where the Arch package (packaging/arch) installs the binary. It also ships
/// /usr/bin/waypoint, a launcher that does what our shim does, so the shim
/// would only shadow it and outlive the package.
const PACKAGE_EXE: &str = "/usr/lib/waypoint/waypoint";
const PACKAGE_LAUNCHER: &str = "/usr/bin/waypoint";

/// True when the package's launcher already provides the `waypoint` command.
/// .deb/.rpm installs aren't covered: their /usr/bin/waypoint is the raw
/// binary, which neither detaches nor defaults to the current directory.
fn cli_from_package(exe: &Path, exists: impl Fn(&Path) -> bool) -> bool {
    cfg!(target_os = "linux") && exe == Path::new(PACKAGE_EXE) && exists(Path::new(PACKAGE_LAUNCHER))
}

fn ensure_shim_allowed(exe: &Path, exists: impl Fn(&Path) -> bool) -> Result<(), String> {
    if cli_from_package(exe, exists) {
        return Err("Waypoint was installed by your package manager, which already provides the `waypoint` command".into());
    }
    Ok(())
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
        path_add(dir_str)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        path_add_unix()
    }
}

fn remove_from_path(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let dir_str = dir.to_str().ok_or("Invalid shim directory")?;
        path_remove(dir_str)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On Unix we intentionally leave shell configs alone — ~/.local/bin
        // may contain other tools the user relies on.
        let _ = dir;
        Ok(())
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
    ensure_shim_allowed(&exe_path, Path::exists)?;
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

/// True when the package manager provides the `waypoint` command, so the
/// settings toggle is hidden.
#[tauri::command]
pub fn cli_provided_by_package() -> Result<bool, String> {
    Ok(cli_from_package(&get_exe_path()?, Path::exists))
}

/// Returns true when the shim script file is present on disk.
#[tauri::command]
pub fn check_cli_shim() -> Result<bool, String> {
    Ok(shim_path()?.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launcher_present(p: &Path) -> bool {
        p == Path::new("/usr/bin/waypoint")
    }

    fn launcher_missing(_: &Path) -> bool {
        false
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_arch_package_layout_provides_the_command() {
        assert!(cli_from_package(Path::new("/usr/lib/waypoint/waypoint"), launcher_present));
    }

    #[test]
    fn the_package_binary_without_its_launcher_does_not() {
        assert!(!cli_from_package(Path::new("/usr/lib/waypoint/waypoint"), launcher_missing));
    }

    #[test]
    fn other_install_locations_do_not() {
        for exe in [
            // .deb / .rpm put the raw binary here; the shim still adds detaching.
            "/usr/bin/waypoint",
            "/usr/local/lib/waypoint/waypoint",
            "/usr/local/bin/waypoint",
            "/home/me/.local/lib/waypoint/waypoint",
            "/home/me/src/waypoint/src-tauri/target/release/waypoint",
            // An AppImage runs from its own mount, which contains usr/lib.
            "/tmp/.mount_WaypoXYZ/usr/lib/waypoint/waypoint",
        ] {
            assert!(!cli_from_package(Path::new(exe), launcher_present), "{exe}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_package_install_refuses_to_write_a_shim() {
        let err = ensure_shim_allowed(Path::new("/usr/lib/waypoint/waypoint"), launcher_present).unwrap_err();
        assert!(err.contains("package"), "{err}");
    }

    #[test]
    fn other_installs_may_write_a_shim() {
        assert!(ensure_shim_allowed(Path::new("/usr/bin/waypoint"), launcher_present).is_ok());
    }
}
