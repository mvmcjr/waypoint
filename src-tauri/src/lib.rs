mod commands;
mod error;
mod graph;
mod repo;

use repo::RepoState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RepoState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::list_refs,
            commands::history::walk_commits,
            commands::history::get_commit,
            commands::diff::get_commit_diff,
            commands::diff::get_workdir_diff,
            commands::actions::get_head_info,
            commands::actions::checkout_branch,
            commands::actions::checkout_commit,
            commands::actions::create_branch_at,
            commands::actions::reset_head,
            commands::actions::rebase_onto,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running waypoint");
}
