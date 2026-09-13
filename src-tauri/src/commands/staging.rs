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
///
/// With an unborn HEAD there is nothing to reset to: the index is emptied and only
/// files that were already untracked are deleted, so previously-staged files survive
/// on disk (unstaged) rather than being destroyed.
#[tauri::command]
pub fn discard_all(repo_id: String, state: State<RepoState>) -> Result<()> {
    {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        discard_all_in(repo)?;
    }
    // Re-open with a fresh handle so libgit2's internal cache reflects the reset state.
    let fresh = git2::Repository::open(&repo_id)?;
    state.0.lock().unwrap().insert(repo_id, fresh);
    Ok(())
}

fn discard_all_in(repo: &git2::Repository) -> Result<()> {
    {
        // On an unborn HEAD the sweep below is restricted to the paths that were
        // already untracked before the index was emptied. Without that snapshot,
        // clearing the index makes every indexed file look untracked — on an orphan
        // branch (`git checkout --orphan`, HEAD unborn but the tree fully populated)
        // that would delete the entire working tree.
        let deletable: Option<std::collections::HashSet<String>> = match repo.head() {
            Ok(head) => {
                let commit = head.peel_to_commit()?;
                repo.reset(commit.as_object(), git2::ResetType::Hard, None)?;
                None
            }
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
                let mut opts = git2::StatusOptions::new();
                opts.include_untracked(true)
                    .include_ignored(false)
                    .recurse_untracked_dirs(false);
                let untracked: std::collections::HashSet<String> = repo
                    .statuses(Some(&mut opts))?
                    .iter()
                    .filter(|e| e.status().contains(git2::Status::WT_NEW))
                    .filter_map(|e| e.path().map(|p| p.to_owned()))
                    .collect();

                // Nothing to reset to, so empty the index instead: staged files are
                // unstaged but kept on disk.
                let mut index = repo.index()?;
                index.clear()?;
                index.write()?;
                Some(untracked)
            }
            Err(e) => return Err(e.into()),
        };

        let workdir = repo.workdir().ok_or_else(|| Error::InvalidArg("bare repository has no working directory".into()))?;

        // Registered worktree paths (main excluded — it's never untracked relative
        // to itself), canonicalized once up front. A registered worktree can sit at
        // ANY depth under an untracked folder (e.g. `tmp/a/b/c/wt`), well beyond
        // the depth-3 `.git`-entry walk below, which only catches unregistered
        // nested repos/worktrees an agent created without `git worktree add`.
        let registered_worktrees: Vec<std::path::PathBuf> = repo
            .worktrees()
            .map(|names| {
                names
                    .iter()
                    .flatten()
                    .filter_map(|name| repo.find_worktree(name).ok())
                    .map(|wt| crate::repo::canonical_path(wt.path()))
                    .collect()
            })
            .unwrap_or_default();

        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true)
            .include_ignored(false)
            .recurse_untracked_dirs(false);
        let statuses = repo.statuses(Some(&mut opts))?;
        for entry in statuses.iter() {
            if entry.status().contains(git2::Status::WT_NEW) {
                if let Some(path) = entry.path() {
                    if deletable.as_ref().is_some_and(|set| !set.contains(path)) {
                        continue;
                    }
                    let full = workdir.join(path);
                    // Never delete a registered worktree, at any depth: canonicalize
                    // this candidate and check whether any registered worktree path
                    // equals it or lies underneath it.
                    let full_canon = crate::repo::canonical_path(&full);
                    if registered_worktrees.iter().any(|wt| *wt == full_canon || wt.starts_with(&full_canon)) {
                        continue;
                    }
                    // Never delete a nested repository or worktree (agents create
                    // them inside the repo, e.g. .worktrees/x): its `.git` entry
                    // (dir or file) marks someone else's working tree.
                    if full.join(".git").exists() || contains_git_entry(&full) {
                        continue;
                    }
                    if path.ends_with('/') {
                        let _ = std::fs::remove_dir_all(&full);
                    } else {
                        let _ = std::fs::remove_file(&full);
                    }
                }
            }
        }
    }
    Ok(())
}

/// True if `dir` or any directory up to 3 levels below it contains a `.git` entry.
fn contains_git_entry(dir: &std::path::Path) -> bool {
    fn walk(d: &std::path::Path, depth: usize) -> bool {
        if d.join(".git").exists() { return true; }
        if depth == 0 { return false; }
        let Ok(rd) = std::fs::read_dir(d) else { return false };
        rd.flatten().any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && walk(&e.path(), depth - 1))
    }
    dir.is_dir() && walk(dir, 3)
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

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    fn make_repo() -> (PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("wpt_discard_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        (dir, repo)
    }

    fn stage(repo: &Repository, name: &str, content: &str) {
        std::fs::write(repo.workdir().unwrap().join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
    }

    /// On an orphan branch HEAD is unborn while the index and working tree are fully
    /// populated. Discarding must not delete those tracked files.
    #[test]
    fn discard_all_on_orphan_branch_keeps_indexed_files() {
        let (dir, repo) = make_repo();
        stage(&repo, "tracked.txt", "keep me");
        let tree = repo.find_tree(repo.index().unwrap().write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();

        // Orphan branch: HEAD points at a ref that doesn't exist yet.
        repo.set_head("refs/heads/orphan").unwrap();
        assert!(repo.head().is_err(), "HEAD should be unborn");
        std::fs::write(dir.join("untracked.txt"), "delete me").unwrap();

        discard_all_in(&repo).unwrap();

        assert!(dir.join("tracked.txt").exists(), "indexed file must survive");
        assert!(!dir.join("untracked.txt").exists(), "untracked file should be removed");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A repo with no commits at all: untracked files go, staged files are only unstaged.
    #[test]
    fn discard_all_on_unborn_head_unstages_without_deleting() {
        let (dir, repo) = make_repo();
        stage(&repo, "staged.txt", "staged");
        std::fs::write(dir.join("untracked.txt"), "untracked").unwrap();

        discard_all_in(&repo).unwrap();

        assert!(dir.join("staged.txt").exists(), "staged file must survive on disk");
        assert!(!dir.join("untracked.txt").exists(), "untracked file should be removed");
        assert_eq!(repo.index().unwrap().len(), 0, "index should be empty");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_all_with_commits_resets_and_cleans() {
        let (dir, repo) = make_repo();
        stage(&repo, "a.txt", "original");
        let tree = repo.find_tree(repo.index().unwrap().write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();

        std::fs::write(dir.join("a.txt"), "modified").unwrap();
        std::fs::write(dir.join("new.txt"), "new").unwrap();

        discard_all_in(&repo).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "original");
        assert!(!dir.join("new.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A registered worktree can sit at any depth under an untracked folder —
    /// well beyond the depth-3 `.git`-entry walk `contains_git_entry` performs.
    /// `discard_all_in` must still spare it by checking the actual registered
    /// worktree paths (from `repo.worktrees()`), not just probing for `.git`.
    #[test]
    fn discard_all_never_deletes_a_registered_worktree_at_any_depth() {
        let (main_dir, main) = crate::repo::test_support::make_repo_with_commit();
        // 5 levels deep: tmp/a/b/c/wt
        let nested = main_dir.join("tmp").join("a").join("b").join("c").join("wt");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        let head = main.head().unwrap().peel_to_commit().unwrap();
        let branch = main.branch("deepwt", &head, false).unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch.get()));
        main.worktree("deepwt", &nested, Some(&opts)).unwrap();
        std::fs::write(nested.join("agent-wip.txt"), "uncommitted agent work").unwrap();

        discard_all_in(&main).unwrap();

        assert!(nested.join("agent-wip.txt").exists(), "deeply nested registered worktree must survive");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn discard_all_never_deletes_a_nested_worktree() {
        let (main_dir, main) = crate::repo::test_support::make_repo_with_commit();
        // Agent-style nested worktree that is NOT gitignored.
        std::fs::create_dir_all(main_dir.join(".worktrees")).unwrap();
        let nested = main_dir.join(".worktrees").join("agent");
        let head = main.head().unwrap().peel_to_commit().unwrap();
        let branch = main.branch("agent", &head, false).unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch.get()));
        main.worktree("agent", &nested, Some(&opts)).unwrap();
        std::fs::write(nested.join("agent-wip.txt"), "uncommitted agent work").unwrap();
        // Also a plain untracked dir that SHOULD still be cleaned.
        std::fs::create_dir_all(main_dir.join("junk")).unwrap();
        std::fs::write(main_dir.join("junk").join("x.txt"), "x").unwrap();

        discard_all_in(&main).unwrap();

        assert!(nested.join("agent-wip.txt").exists(), "nested worktree must survive");
        assert!(!main_dir.join("junk").exists(), "ordinary untracked dirs are still removed");
        let _ = std::fs::remove_dir_all(main_dir);
    }
}
