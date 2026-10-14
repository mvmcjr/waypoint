//! The one place `git` CLI child processes are built, so every spawn gets the
//! same setup: no console window on Windows, and none of our Wayland
//! workarounds in its environment (git may launch a credential helper's GUI).

use std::path::Path;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(crate) fn std_command(dir: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    crate::wayland_env::scrub(&mut cmd);
    cmd
}

pub(crate) fn tokio_command(dir: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(dir);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    crate::wayland_env::scrub(&mut cmd);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    const INJECTED: &str = "WAYPOINT_TEST_INJECTED";

    fn assert_git_without_injected_env(cmd: &std::process::Command, dir: &Path) {
        assert_eq!(cmd.get_program(), "git");
        assert_eq!(cmd.get_current_dir(), Some(dir));
        assert!(
            cmd.get_envs().any(|(k, v)| k == INJECTED && v.is_none()),
            "{cmd:?} still inherits the injected env"
        );
    }

    #[test]
    fn std_command_drops_injected_env() {
        crate::wayland_env::inject_for_tests(&[INJECTED]);
        let dir = std::env::temp_dir();
        assert_git_without_injected_env(&std_command(&dir), &dir);
    }

    #[test]
    fn tokio_command_drops_injected_env() {
        crate::wayland_env::inject_for_tests(&[INJECTED]);
        let dir = std::env::temp_dir();
        assert_git_without_injected_env(tokio_command(&dir).as_std(), &dir);
    }
}
