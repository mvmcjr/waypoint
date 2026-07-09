use std::path::Path;
use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct FileStatus {
    pub path: String,
    /// Status in the index relative to HEAD: "added" | "modified" | "deleted" | "renamed"
    pub staged: Option<String>,
    /// Status in the working tree relative to index: "modified" | "deleted" | "untracked"
    pub unstaged: Option<String>,
}

#[tauri::command]
pub fn list_status(repo_id: String, state: State<RepoState>) -> Result<Vec<FileStatus>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;
    let mut files: Vec<FileStatus> = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        let staged = if s.contains(git2::Status::INDEX_NEW) {
            Some("added".into())
        } else if s.contains(git2::Status::INDEX_MODIFIED) {
            Some("modified".into())
        } else if s.contains(git2::Status::INDEX_DELETED) {
            Some("deleted".into())
        } else if s.contains(git2::Status::INDEX_RENAMED) {
            Some("renamed".into())
        } else if s.contains(git2::Status::INDEX_TYPECHANGE) {
            Some("modified".into())
        } else {
            None
        };

        let unstaged = if s.contains(git2::Status::WT_NEW) {
            Some("untracked".into())
        } else if s.contains(git2::Status::WT_MODIFIED) {
            Some("modified".into())
        } else if s.contains(git2::Status::WT_DELETED) {
            Some("deleted".into())
        } else if s.contains(git2::Status::WT_RENAMED) {
            Some("renamed".into())
        } else if s.contains(git2::Status::WT_TYPECHANGE) {
            Some("modified".into())
        } else {
            None
        };

        if staged.is_some() || unstaged.is_some() {
            files.push(FileStatus { path, staged, unstaged });
        }
    }

    Ok(files)
}

/// Add a single file to the index (stage it).
#[tauri::command]
pub fn stage_file(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let workdir = crate::repo::workdir(repo)?;
    let mut index = repo.index()?;

    if workdir.join(&path).exists() {
        index.add_path(Path::new(&path))?;
    } else {
        // File was deleted in the working tree — stage the deletion.
        index.remove_path(Path::new(&path))?;
    }
    index.write()?;
    Ok(())
}

/// Remove a single file from the index (unstage it), restoring HEAD's version.
#[tauri::command]
pub fn unstage_file(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut index = repo.index()?;

    match repo.head() {
        Ok(head) => {
            let head_commit = head.peel_to_commit()?;
            let head_tree = head_commit.tree()?;

            match head_tree.get_path(Path::new(&path)) {
                Ok(tree_entry) => {
                    // Restore the index entry to the HEAD version.
                    let entry = git2::IndexEntry {
                        ctime: git2::IndexTime::new(0, 0),
                        mtime: git2::IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode: tree_entry.filemode() as u32,
                        uid: 0,
                        gid: 0,
                        file_size: 0,
                        id: tree_entry.id(),
                        flags: 0,
                        flags_extended: 0,
                        path: path.into_bytes(),
                    };
                    index.add(&entry)?;
                }
                Err(_) => {
                    // File not in HEAD (it was newly staged) — remove from index.
                    index.remove_path(Path::new(&path))?;
                }
            }
        }
        Err(_) => {
            // No HEAD yet (empty repo) — remove from index.
            index.remove_path(Path::new(&path))?;
        }
    }

    index.write()?;
    Ok(())
}

/// Stage every change in the working tree (equivalent to `git add -A`).
#[tauri::command]
pub fn stage_all(repo_id: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut index = repo.index()?;
    // add_all handles new + modified files; update_all handles modifications + deletions.
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.update_all(["*"].iter(), None)?;
    index.write()?;
    Ok(())
}

/// Stage multiple files at once.
#[tauri::command]
pub fn stage_paths(repo_id: String, paths: Vec<String>, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let workdir = crate::repo::workdir(repo)?;
    let mut index = repo.index()?;
    for path in &paths {
        if workdir.join(path).exists() {
            index.add_path(Path::new(path))?;
        } else {
            index.remove_path(Path::new(path))?;
        }
    }
    index.write()?;
    Ok(())
}

/// Unstage multiple files at once, restoring HEAD versions.
#[tauri::command]
pub fn unstage_paths(repo_id: String, paths: Vec<String>, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut index = repo.index()?;

    let head_tree: Option<git2::Tree> = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?.tree()?),
        Err(_) => None,
    };

    for path in &paths {
        match &head_tree {
            Some(tree) => match tree.get_path(Path::new(path)) {
                Ok(tree_entry) => {
                    let entry = git2::IndexEntry {
                        ctime: git2::IndexTime::new(0, 0),
                        mtime: git2::IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode: tree_entry.filemode() as u32,
                        uid: 0,
                        gid: 0,
                        file_size: 0,
                        id: tree_entry.id(),
                        flags: 0,
                        flags_extended: 0,
                        path: path.as_bytes().to_vec(),
                    };
                    index.add(&entry)?;
                }
                Err(_) => {
                    index.remove_path(Path::new(path))?;
                }
            },
            None => {
                index.remove_path(Path::new(path))?;
            }
        }
    }

    index.write()?;
    Ok(())
}

/// Discard all changes (staged and unstaged) for a single file.
///
/// - Tracked file (exists in HEAD): restores index entry and working-tree file to HEAD.
/// - New/untracked file (not in HEAD): removes the file from disk and from the index.
#[tauri::command]
pub fn discard_file(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let workdir = crate::repo::workdir(repo)?;
    let mut index = repo.index()?;

    let head_tree: Option<git2::Tree> = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(_) => None,
    };
    let in_head = head_tree.as_ref()
        .map(|t| t.get_path(Path::new(&path)).is_ok())
        .unwrap_or(false);

    if in_head {
        let tree_entry = head_tree.as_ref().unwrap().get_path(Path::new(&path))?;
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0, ino: 0,
            mode: tree_entry.filemode() as u32,
            uid: 0, gid: 0, file_size: 0,
            id: tree_entry.id(),
            flags: 0, flags_extended: 0,
            path: path.clone().into_bytes(),
        };
        index.add(&entry)?;
        index.write()?;

        // Restore working-tree file from the now-updated index.
        let mut co = git2::build::CheckoutBuilder::new();
        co.path(path.as_str()).force().update_index(false);
        repo.checkout_index(Some(&mut index), Some(&mut co))?;
    } else {
        // New file with no HEAD version: delete from disk and remove from index.
        let _ = index.remove_path(Path::new(&path));
        index.write()?;
        let full = workdir.join(&path);
        if full.exists() {
            std::fs::remove_file(&full)
                .map_err(|e| Error::InvalidArg(e.to_string()))?;
        }
    }

    Ok(())
}

/// Discard all changes for a set of paths at once (e.g. a whole directory).
/// Same rules as `discard_file` applied per-path in one index write.
#[tauri::command]
pub fn discard_paths(repo_id: String, paths: Vec<String>, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let workdir = crate::repo::workdir(repo)?;
    let mut index = repo.index()?;

    let head_tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(_) => None,
    };

    let mut tracked: Vec<String> = Vec::new();

    for path in &paths {
        let in_head = head_tree.as_ref()
            .map(|t| t.get_path(Path::new(path)).is_ok())
            .unwrap_or(false);

        if in_head {
            let tree_entry = head_tree.as_ref().unwrap().get_path(Path::new(path))?;
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0, ino: 0,
                mode: tree_entry.filemode() as u32,
                uid: 0, gid: 0, file_size: 0,
                id: tree_entry.id(),
                flags: 0, flags_extended: 0,
                path: path.clone().into_bytes(),
            };
            index.add(&entry)?;
            tracked.push(path.clone());
        } else {
            let _ = index.remove_path(Path::new(path));
            let full = workdir.join(path);
            if full.exists() {
                std::fs::remove_file(&full).map_err(|e| Error::InvalidArg(e.to_string()))?;
            }
        }
    }

    index.write()?;

    if !tracked.is_empty() {
        let mut co = git2::build::CheckoutBuilder::new();
        for p in &tracked { co.path(p.as_str()); }
        co.force().update_index(false);
        repo.checkout_index(Some(&mut index), Some(&mut co))?;
    }

    Ok(())
}

/// Discard all staged and unstaged changes to tracked files (hard reset to HEAD),
/// and delete all untracked files/directories. Ignored files are left untouched.
#[tauri::command]
pub fn discard_all(repo_id: String, state: State<RepoState>) -> Result<()> {
    {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let head = repo.head()?.peel_to_commit()?;
        repo.reset(head.as_object(), git2::ResetType::Hard, None)?;

        let workdir = repo.workdir().ok_or_else(|| Error::InvalidArg("bare repository has no working directory".into()))?;
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true)
            .include_ignored(false)
            .recurse_untracked_dirs(false);
        let statuses = repo.statuses(Some(&mut opts))?;
        for entry in statuses.iter() {
            if entry.status().contains(git2::Status::WT_NEW) {
                if let Some(path) = entry.path() {
                    let full = workdir.join(path);
                    if path.ends_with('/') {
                        let _ = std::fs::remove_dir_all(&full);
                    } else {
                        let _ = std::fs::remove_file(&full);
                    }
                }
            }
        }
    }
    // Re-open with a fresh handle so libgit2's internal cache reflects the reset state.
    let fresh = git2::Repository::open(&repo_id)?;
    state.0.lock().unwrap().insert(repo_id, fresh);
    Ok(())
}

/// Create a commit from the current index with the given message.
#[tauri::command]
pub fn do_commit(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let sig = repo.signature()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    // Collect parent commits (empty for the very first commit in the repo).
    let parent_commits: Vec<git2::Commit> = match repo.head() {
        Ok(head) => vec![head.peel_to_commit()?],
        Err(_) => vec![],
    };
    let parents: Vec<&git2::Commit> = parent_commits.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;
    Ok(())
}

/// Amend the HEAD commit: replace its tree with the current index and update the message.
#[tauri::command]
pub fn amend_commit(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head_commit = repo.head()?.peel_to_commit()?;

    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    let sig = repo.signature()?;

    head_commit.amend(
        Some("HEAD"),
        None,           // keep original author (name, email, timestamp)
        Some(&sig),     // update committer to current user
        None,           // encoding (keep utf-8)
        Some(&message),
        Some(&tree),
    )?;

    Ok(())
}
