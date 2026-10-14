use crate::error::{Error, Result};

/// Only web pages: the frontend opens remote/PR links, never local files.
/// The URL as the parser normalized it, if it's an http(s) page.
fn check_web_url(url: &str) -> Result<String> {
    match url::Url::parse(url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()) => Ok(u.into()),
        _ => Err(Error::InvalidArg(format!("not a web URL: {url}"))),
    }
}

/// Asks the desktop portal to open `url`, falling back to launching a browser
/// ourselves when no portal is running (e.g. a bare window manager).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn open_with(
    url: &str,
    portal: impl FnOnce(&str) -> std::result::Result<(), String>,
    launcher: impl FnOnce(&str) -> std::result::Result<(), String>,
) -> Result<()> {
    let portal_err = match portal(url) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    launcher(url).map_err(|launcher_err| {
        Error::InvalidArg(format!(
            "couldn't open {url}: desktop portal: {portal_err}; launcher: {launcher_err}"
        ))
    })
}

/// org.freedesktop.portal.OpenURI: the portal launches the browser itself, so
/// it never inherits our environment and we have no child process to reap.
#[cfg(target_os = "linux")]
fn open_via_portal(url: &str) -> std::result::Result<(), String> {
    use std::collections::HashMap;
    use zbus::zvariant::Value;

    let conn = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let options: HashMap<&str, Value> = HashMap::new();
    conn.call_method(
        Some("org.freedesktop.portal.Desktop"),
        "/org/freedesktop/portal/desktop",
        Some("org.freedesktop.portal.OpenURI"),
        "OpenURI",
        &("", url, options),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Fallback when no portal is running: the first launcher that starts wins.
#[cfg(target_os = "linux")]
fn open_via_launcher(url: &str) -> std::result::Result<(), String> {
    let mut last_err = String::from("no launcher found");
    for mut cmd in browser_commands(url, crate::wayland_env::injected()) {
        match cmd.spawn() {
            Ok(mut child) => {
                // xdg-open can block until the browser exits; reap it off-thread.
                std::thread::spawn(move || child.wait());
                return Ok(());
            }
            Err(e) => last_err = format!("{:?}: {e}", cmd.get_program()),
        }
    }
    Err(last_err)
}

/// Launchers to try in order (xdg-open, gio, …), detached from us and without
/// the Wayland workarounds we injected into our own environment.
#[cfg(target_os = "linux")]
fn browser_commands(url: &str, injected: &[&str]) -> Vec<std::process::Command> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let mut cmds = open::commands(url);
    for cmd in &mut cmds {
        crate::wayland_env::scrub_vars(cmd, injected);
        // Own process group, so closing the terminal Waypoint was started from
        // doesn't take the browser down with it.
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
    }
    cmds
}

/// Opens an http(s) URL in the default browser. On Linux we go through the
/// desktop portal rather than tauri-plugin-opener, whose `xdg-open` child would
/// hand the browser our Wayland workarounds (see `wayland_env`).
#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<()> {
    let url = check_web_url(&url)?;

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        // D-Bus activation of the portal can take a moment; keep it off the main thread.
        tauri::async_runtime::spawn_blocking(move || open_with(&url, open_via_portal, open_via_launcher))
            .await
            .map_err(|e| Error::InvalidArg(e.to_string()))?
    }

    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(|e| Error::InvalidArg(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(check_web_url("https://github.com/me/repo/tree/feat/x").is_ok());
        assert!(check_web_url("http://gitlab.local/me/repo").is_ok());
        assert!(check_web_url("HTTPS://github.com/me/repo").is_ok());
    }

    #[test]
    fn hands_back_the_normalized_url() {
        assert_eq!(check_web_url(" HTTPS://GitHub.com/me/repo").unwrap(), "https://github.com/me/repo");
    }

    #[test]
    fn rejects_anything_that_is_not_a_web_page() {
        for url in [
            "file:///etc/passwd",
            "/home/me/evil.desktop",
            "javascript:alert(1)",
            "ssh://git@github.com/me/repo",
            "--help",
            "https:",
            "https://?x",
            "http://#",
            "https:// \nfoo",
            "",
        ] {
            assert!(check_web_url(url).is_err(), "{url:?} should be rejected");
        }
    }

    #[test]
    fn portal_success_skips_the_launcher() {
        let mut launched = false;
        let result = open_with("https://x.dev", |_| Ok(()), |_| {
            launched = true;
            Ok(())
        });
        assert!(result.is_ok());
        assert!(!launched);
    }

    #[test]
    fn falls_back_to_the_launcher_without_a_portal() {
        let mut launched_with = None;
        let result = open_with("https://x.dev", |_| Err("no portal".into()), |u| {
            launched_with = Some(u.to_string());
            Ok(())
        });
        assert!(result.is_ok());
        assert_eq!(launched_with.as_deref(), Some("https://x.dev"));
    }

    #[test]
    fn reports_both_failures() {
        let err = open_with("https://x.dev", |_| Err("no portal".into()), |_| Err("no xdg-open".into()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("no portal") && err.contains("no xdg-open"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launchers_get_the_url_without_our_injected_env() {
        let url = "https://github.com/me/repo";
        let cmds = browser_commands(url, &["__NV_DISABLE_EXPLICIT_SYNC"]);
        // Under WSL, open::commands puts wslview first.
        assert!(cmds.iter().any(|c| c.get_program() == "xdg-open"), "{cmds:?} has no xdg-open");
        for cmd in &cmds {
            assert!(cmd.get_args().any(|a| a == url), "{cmd:?} is missing the url");
            assert!(
                cmd.get_envs().any(|(k, v)| k == "__NV_DISABLE_EXPLICIT_SYNC" && v.is_none()),
                "{cmd:?} still inherits the injected env"
            );
        }
    }
}
