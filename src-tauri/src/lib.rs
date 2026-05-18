mod commands;
mod error;
mod graph;
mod repo;

use repo::RepoState;
use std::sync::Mutex;

pub struct StartupPath(Mutex<Option<String>>);

#[tauri::command]
fn get_startup_path(state: tauri::State<StartupPath>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_path = std::env::args()
        .nth(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir());

    tauri::Builder::default()
        .manage(StartupPath(Mutex::new(startup_path)))
        .manage(RepoState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_startup_path,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running waypoint");
}
