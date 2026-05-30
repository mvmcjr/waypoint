mod commands;
mod error;
mod graph;
mod repo;

use repo::{RepoState, WatcherState};
use std::sync::Mutex;

pub struct StartupPath(Mutex<Option<String>>);

#[tauri::command]
fn get_startup_path(state: tauri::State<StartupPath>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg(target_os = "windows")]
fn register_context_menu_impl() -> std::io::Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_str) = exe_path.to_str() {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            
            // 1. Right-click on a folder
            let (key, _) = hkcu.create_subkey(r"Software\Classes\Directory\shell\Waypoint")?;
            key.set_value("", &"Open in Waypoint")?;
            key.set_value("Icon", &format!("{},0", exe_str))?;
            
            let (cmd_key, _) = hkcu.create_subkey(r"Software\Classes\Directory\shell\Waypoint\command")?;
            cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe_str))?;

            // 2. Right-click on the folder background
            let (bg_key, _) = hkcu.create_subkey(r"Software\Classes\Directory\Background\shell\Waypoint")?;
            bg_key.set_value("", &"Open in Waypoint")?;
            bg_key.set_value("Icon", &format!("{},0", exe_str))?;
            
            let (bg_cmd_key, _) = hkcu.create_subkey(r"Software\Classes\Directory\Background\shell\Waypoint\command")?;
            bg_cmd_key.set_value("", &format!("\"{}\" \"%V\"", exe_str))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_context_menu_impl() -> std::io::Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let _ = hkcu.delete_subkey(r"Software\Classes\Directory\shell\Waypoint\command");
    let _ = hkcu.delete_subkey(r"Software\Classes\Directory\shell\Waypoint");
    let _ = hkcu.delete_subkey(r"Software\Classes\Directory\Background\shell\Waypoint\command");
    let _ = hkcu.delete_subkey(r"Software\Classes\Directory\Background\shell\Waypoint");
    Ok(())
}

#[tauri::command]
fn is_windows() -> bool {
    cfg!(target_os = "windows")
}

#[tauri::command]
fn register_explorer_context_menu(register: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if register {
            register_context_menu_impl().map_err(|e| e.to_string())?;
        } else {
            unregister_context_menu_impl().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_path = std::env::args()
        .nth(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir());

    tauri::Builder::default()
        .manage(StartupPath(Mutex::new(startup_path)))
        .manage(RepoState::default())
        .manage(WatcherState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_startup_path,
            is_windows,
            register_explorer_context_menu,
            commands::repo::open_repo,
            commands::repo::list_refs,
            commands::history::walk_commits,
            commands::history::get_commit,
            commands::diff::get_commit_diff,
            commands::diff::get_workdir_diff,
            commands::actions::get_head_info,
            commands::actions::checkout_branch,
            commands::actions::checkout_remote_branch,
            commands::actions::checkout_commit,
            commands::actions::create_branch_at,
            commands::actions::reset_head,
            commands::actions::rebase_onto,
            commands::actions::delete_branch,
            commands::actions::get_repo_status,
            commands::staging::list_status,
            commands::staging::stage_file,
            commands::staging::unstage_file,
            commands::staging::stage_all,
            commands::staging::stage_paths,
            commands::staging::unstage_paths,
            commands::staging::do_commit,
            commands::staging::amend_commit,
            commands::merge::merge_commit,
            commands::merge::get_merge_status,
            commands::merge::resolve_ours,
            commands::merge::resolve_theirs,
            commands::merge::finish_merge,
            commands::merge::abort_merge,
            commands::merge::cherry_pick,
            commands::merge::finish_cherry_pick,
            commands::merge::get_conflict_content,
            commands::merge::resolve_with_content,
            commands::staging::discard_file,
            commands::staging::discard_paths,
            commands::staging::discard_all,
            commands::stash::stash_push,
            commands::stash::list_stashes,
            commands::stash::pop_stash,
            commands::stash::apply_stash,
            commands::stash::drop_stash,
            commands::remote::list_remotes,
            commands::remote::fetch_remote,
            commands::remote::push_branch,
            commands::remote::pull_branch,
            commands::remote::push_tag,
            commands::remote::delete_remote_tag,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::fs::scan_for_git_repos,
            commands::cli::register_cli_shim,
            commands::cli::unregister_cli_shim,
            commands::cli::check_cli_shim,
        ])
        .run(tauri::generate_context!())
        .expect("error while running waypoint");
}
