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
        ])
        .run(tauri::generate_context!())
        .expect("error while running waypoint");
}
