use std::path::Path;

const MAX_DEPTH: usize = 3;
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "vendor", ".cache", "__pycache__",
];

#[tauri::command]
pub async fn scan_for_git_repos(path: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut repos = Vec::new();
        scan_recursive(Path::new(&path), &mut repos, 0);
        repos
    })
    .await
    .unwrap_or_default()
}

fn scan_recursive(dir: &Path, repos: &mut Vec<String>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }

    if dir.join(".git").exists() {
        if let Some(p) = dir.to_str() {
            repos.push(p.to_string());
        }
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || SKIP_DIRS.iter().any(|&s| s == name_str.as_ref()) {
            continue;
        }
        scan_recursive(&entry.path(), repos, depth + 1);
    }
}
