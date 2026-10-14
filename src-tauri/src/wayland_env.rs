use std::ffi::OsString;
use std::sync::OnceLock;

// Workarounds applied under Wayland, before GTK/EGL initialize:
//
// __NV_DISABLE_EXPLICIT_SYNC: NVIDIA's EGL Wayland driver opts the window
// surface into explicit sync (wp_linux_drm_syncobj_surface_v1), but
// GTK/WebKitGTK then commits buffers without an acquire point. Compositors that
// enforce the protocol (Hyprland does) kill the connection with "Missing
// acquire timeline", surfacing as "Error 71 (Protocol error) dispatching to
// Wayland display". Opting the driver out keeps WebKit's GPU DMA-BUF renderer
// working; other drivers ignore the variable.
//
// GTK_USE_PORTAL: rfd's GtkFileChooserNative otherwise falls back to an
// in-process dialog that it can only parent on X11, so tiling compositors tile
// it as an unrelated window. Through xdg-desktop-portal the picker is parented
// to our window, floats, and is the desktop's own chooser. GTK falls back to the
// in-process dialog if no portal provides FileChooser.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const WAYLAND_OVERRIDES: [(&str, &str); 2] =
    [("__NV_DISABLE_EXPLICIT_SYNC", "1"), ("GTK_USE_PORTAL", "1")];

/// Environment variables to set at startup for the given environment lookup.
/// Values the user already set win.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn overrides(get: impl Fn(&str) -> Option<OsString>) -> Vec<(&'static str, &'static str)> {
    if get("WAYLAND_DISPLAY").is_none_or(|d| d.is_empty()) {
        return Vec::new();
    }
    WAYLAND_OVERRIDES.into_iter().filter(|(key, _)| get(key).is_none()).collect()
}

/// Something whose environment can have variables removed: the std and tokio
/// `Command`s we spawn children with.
pub(crate) trait RemoveEnv {
    fn remove_env(&mut self, key: &str);
}

impl RemoveEnv for std::process::Command {
    fn remove_env(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl RemoveEnv for tokio::process::Command {
    fn remove_env(&mut self, key: &str) {
        self.env_remove(key);
    }
}

/// Variables `apply` set, so children we spawn don't inherit our workarounds.
static INJECTED: OnceLock<Vec<&'static str>> = OnceLock::new();

/// Sets the Wayland workarounds in our own environment. Must run before GTK/EGL
/// initialize, while the process is still single-threaded.
#[cfg(target_os = "linux")]
pub(crate) fn apply() {
    let set = overrides(|key| std::env::var_os(key));
    for (key, value) in &set {
        std::env::set_var(key, value);
    }
    let _ = INJECTED.set(set.into_iter().map(|(key, _)| key).collect());
}

/// Removes the variables `apply` injected from a child's environment. WebKit's
/// own helper processes need them; git, xdg-open and the browser it launches
/// must not inherit them (the browser would lose NVIDIA explicit sync).
pub(crate) fn scrub(cmd: &mut impl RemoveEnv) {
    scrub_vars(cmd, injected());
}

/// The variables `apply` set (empty before it runs, and off Linux).
pub(crate) fn injected() -> &'static [&'static str] {
    INJECTED.get().map_or(&[], Vec::as_slice)
}

/// Lets tests exercise `scrub` without touching the process environment.
#[cfg(test)]
pub(crate) fn inject_for_tests(vars: &[&'static str]) {
    let _ = INJECTED.set(vars.to_vec());
}

pub(crate) fn scrub_vars(cmd: &mut impl RemoveEnv, vars: &[&str]) {
    for key in vars {
        cmd.remove_env(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> =
            vars.iter().map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn nothing_outside_wayland() {
        assert!(overrides(env(&[])).is_empty());
    }

    #[test]
    fn empty_wayland_display_is_not_wayland() {
        assert!(overrides(env(&[("WAYLAND_DISPLAY", "")])).is_empty());
    }

    #[test]
    fn wayland_disables_nvidia_explicit_sync_and_routes_dialogs_through_portal() {
        assert_eq!(
            overrides(env(&[("WAYLAND_DISPLAY", "wayland-1")])),
            vec![("__NV_DISABLE_EXPLICIT_SYNC", "1"), ("GTK_USE_PORTAL", "1")]
        );
    }

    #[test]
    fn values_the_user_set_are_left_alone() {
        assert_eq!(
            overrides(env(&[("WAYLAND_DISPLAY", "wayland-1"), ("__NV_DISABLE_EXPLICIT_SYNC", "0")])),
            vec![("GTK_USE_PORTAL", "1")]
        );
        assert_eq!(
            overrides(env(&[("WAYLAND_DISPLAY", "wayland-1"), ("GTK_USE_PORTAL", "0")])),
            vec![("__NV_DISABLE_EXPLICIT_SYNC", "1")]
        );
    }

    fn removed(cmd: &std::process::Command) -> Vec<String> {
        cmd.get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn scrub_removes_the_given_vars_from_a_std_command() {
        let mut cmd = std::process::Command::new("git");
        scrub_vars(&mut cmd, &["GTK_USE_PORTAL", "__NV_DISABLE_EXPLICIT_SYNC"]);
        let mut got = removed(&cmd);
        got.sort();
        assert_eq!(got, ["GTK_USE_PORTAL", "__NV_DISABLE_EXPLICIT_SYNC"]);
    }

    #[test]
    fn scrub_removes_the_given_vars_from_a_tokio_command() {
        let mut cmd = tokio::process::Command::new("git");
        scrub_vars(&mut cmd, &["GTK_USE_PORTAL"]);
        assert_eq!(removed(cmd.as_std()), ["GTK_USE_PORTAL"]);
    }

    #[test]
    fn scrub_with_nothing_injected_leaves_the_command_alone() {
        let mut cmd = std::process::Command::new("git");
        scrub_vars(&mut cmd, &[]);
        assert_eq!(cmd.get_envs().count(), 0);
    }
}
