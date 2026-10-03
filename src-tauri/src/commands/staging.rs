use std::path::Path;
use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::lock_retry;
use crate::repo::{with_repo, RepoState};

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
    with_repo(&state, &repo_id, |repo| list_status_in(repo))
}

fn list_status_in(repo: &git2::Repository) -> Result<Vec<FileStatus>> {
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

/// Entry restoring `path` to the version in `tree_entry` (HEAD).
fn head_entry(tree_entry: &git2::TreeEntry<'_>, path: &str) -> git2::IndexEntry {
    git2::IndexEntry {
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
    }
}

/// Add a single file to the index (stage it).
#[tauri::command]
pub fn stage_file(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| stage_paths_in(repo, &[path]))
}

/// Remove a single file from the index (unstage it), restoring HEAD's version.
#[tauri::command]
pub fn unstage_file(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| unstage_paths_in(repo, &[path]))
}

/// Stage every change in the working tree (equivalent to `git add -A`).
#[tauri::command]
pub fn stage_all(repo_id: String, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| {
        let mut index = repo.index()?;
        // add_all handles new + modified files; update_all handles modifications + deletions.
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        index.update_all(["*"].iter(), None)?;
        lock_retry::write_index(&mut index)
    })
}

/// Stage multiple files at once.
#[tauri::command]
pub fn stage_paths(repo_id: String, paths: Vec<String>, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| stage_paths_in(repo, &paths))
}

fn stage_paths_in(repo: &git2::Repository, paths: &[String]) -> Result<()> {
    let workdir = crate::repo::workdir(repo)?;
    let mut index = repo.index()?;
    for path in paths {
        if workdir.join(path).exists() {
            index.add_path(Path::new(path))?;
        } else {
            // File was deleted in the working tree: stage the deletion.
            index.remove_path(Path::new(path))?;
        }
    }
    lock_retry::write_index(&mut index)
}

/// Unstage multiple files at once, restoring HEAD versions.
#[tauri::command]
pub fn unstage_paths(repo_id: String, paths: Vec<String>, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| unstage_paths_in(repo, &paths))
}

fn unstage_paths_in(repo: &git2::Repository, paths: &[String]) -> Result<()> {
    let mut index = repo.index()?;

    // No HEAD yet (empty repo): everything staged is new, so unstaging removes it.
    let head_tree: Option<git2::Tree> = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?.tree()?),
        Err(_) => None,
    };

    for path in paths {
        match head_tree.as_ref().and_then(|t| t.get_path(Path::new(path)).ok()) {
            // Restore the index entry to the HEAD version.
            Some(tree_entry) => index.add(&head_entry(&tree_entry, path))?,
            // Not in HEAD (it was newly staged): remove from index.
            None => index.remove_path(Path::new(path))?,
        }
    }

    lock_retry::write_index(&mut index)
}

/// Discard all changes (staged and unstaged) for a single file.
///
/// - Tracked file (exists in HEAD): restores index entry and working-tree file to HEAD.
/// - New/untracked file (not in HEAD): removes the file from disk and from the index.
#[tauri::command]
pub fn discard_file(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| discard_paths_in(repo, &[path]))
}

/// Discard all changes for a set of paths at once (e.g. a whole directory).
/// Same rules as `discard_file` applied per-path in one index write.
#[tauri::command]
pub fn discard_paths(repo_id: String, paths: Vec<String>, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| discard_paths_in(repo, &paths))
}

fn discard_paths_in(repo: &git2::Repository, paths: &[String]) -> Result<()> {
    let workdir = crate::repo::workdir(repo)?;
    let mut index = repo.index()?;

    let head_tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(_) => None,
    };

    let mut tracked: Vec<&str> = Vec::new();
    let mut to_delete: Vec<(&str, std::path::PathBuf)> = Vec::new();

    for path in paths {
        match head_tree.as_ref().and_then(|t| t.get_path(Path::new(path)).ok()) {
            Some(tree_entry) => {
                index.add(&head_entry(&tree_entry, path))?;
                tracked.push(path);
            }
            None => {
                // New file with no HEAD version: drop it from the index and, once
                // that is persisted, from disk.
                let _ = index.remove_path(Path::new(path));
                to_delete.push((path, workdir.join(path)));
            }
        }
    }

    lock_retry::write_index(&mut index)?;

    if !tracked.is_empty() {
        // Restore working-tree files from the now-updated index. `update_index(false)`
        // means libgit2 never writes the index here, so there is no lock to retry.
        let mut co = git2::build::CheckoutBuilder::new();
        for p in &tracked { co.path(*p); }
        co.force().update_index(false);
        repo.checkout_index(Some(&mut index), Some(&mut co))?;
    }

    // Deleting from disk is irreversible, so it happens last: only after the index
    // write succeeded (a failed write leaves the files in place), and after the
    // tracked files are restored, so a removal failure never leaves index and working
    // tree disagreeing about them. Every removal is attempted; failures are reported.
    let mut failed: Vec<String> = Vec::new();
    for (path, full) in &to_delete {
        if full.exists() {
            if let Err(e) = std::fs::remove_file(full) {
                failed.push(format!("{path} ({e})"));
            }
        }
    }
    if !failed.is_empty() {
        return Err(Error::InvalidArg(format!(
            "could not remove untracked file(s): {}",
            failed.join(", ")
        )));
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
    discard_all_with(&state, repo_id)
}

fn discard_all_with(state: &RepoState, repo_id: String) -> Result<()> {
    let result = with_repo(state, &repo_id, |repo| discard_all_in(repo));
    reopen_cached(state, repo_id, result)
}

/// Re-open with a fresh handle so libgit2's internal cache reflects the on-disk state.
/// This also runs after a failed discard, whose half-applied work may have left the
/// cached handle out of step with disk. The original error wins over a reopen failure.
/// An unknown or vanished repo is never (re)registered: reopening it would resurrect a
/// handle for a repo the user already closed.
fn reopen_cached(state: &RepoState, repo_id: String, result: Result<()>) -> Result<()> {
    if matches!(result, Err(Error::RepoNotFound(_) | Error::RepoGone(_))) {
        return result;
    }
    match git2::Repository::open(&repo_id) {
        Ok(fresh) => {
            // Replace only a handle that is still registered (it may have been closed
            // since `with_repo` released the lock).
            if let Some(slot) = state.0.lock().unwrap().get_mut(&repo_id) {
                *slot = fresh;
            }
        }
        Err(e) if result.is_ok() => return Err(e.into()),
        Err(_) => {}
    }
    result
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
                // Hard reset is idempotent, so it is safe to retry if index.lock is held.
                lock_retry::reset_hard(repo, commit.as_object())?;
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
                    .filter_map(|e| e.path().ok().map(|p| p.to_owned()))
                    .collect();

                // Nothing to reset to, so empty the index instead: staged files are
                // unstaged but kept on disk.
                let mut index = repo.index()?;
                index.clear()?;
                // Only the write is retried: the untracked snapshot above must not
                // be retaken once the in-memory index has been cleared.
                lock_retry::write_index(&mut index)?;
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
                    .flatten().flatten()
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
                if let Ok(path) = entry.path() {
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
    with_repo(&state, &repo_id, |repo| commit_in(repo, &message))
}

fn commit_in(repo: &git2::Repository, message: &str) -> Result<()> {
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

    lock_retry::commit(repo, Some("HEAD"), &sig, message, &tree, &parents)?;
    Ok(())
}

/// Amend the HEAD commit: replace its tree with the current index and update the message.
#[tauri::command]
pub fn amend_commit(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    with_repo(&state, &repo_id, |repo| amend_in(repo, &message))
}

/// Core of `amend_commit`, matching `git commit --amend`: the new message is
/// written as UTF-8 with no `encoding` header, and the original author line is
/// transcoded from the original's declared encoding (empty names survive).
/// libgit2's `Commit::amend` would inherit or write an `encoding` header, so
/// the commit is written by hand over the original's parents.
fn amend_in(repo: &git2::Repository, message: &str) -> Result<()> {
    let head = repo.head()?;
    let head_commit = head.peel_to_commit()?;
    let branch_ref = head.is_branch().then(|| head.name().map(str::to_owned)).transpose()?;
    amend_from(repo, &head_commit, branch_ref.as_deref(), message)
}

/// Replace `old` (HEAD as it was read) with an amended commit. Like git, the
/// author line is transcoded to UTF-8 from the original's declared encoding
/// (see `git_text::transcode_for_rewrite`) and the committer is the current
/// user. The branch (or detached HEAD) only moves if it still points at `old`,
/// so a concurrent change is refused instead of overwritten.
fn amend_from(repo: &git2::Repository, old: &git2::Commit, branch_ref: Option<&str>, message: &str) -> Result<()> {
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;

    let sig = repo.signature()?;
    let parents: Vec<git2::Oid> = old.parent_ids().collect();
    let author = crate::git_text::transcode_for_rewrite(old).author;
    let new_oid = crate::git_text::write_commit(repo, tree_oid, &parents, &author, &sig, message.as_bytes())?;

    let subject = message.lines().next().unwrap_or("");
    let reflog = format!("commit (amend): {subject}");
    let moved = || Error::InvalidArg("The branch changed while amending. Nothing was amended; try again.".into());
    match branch_ref {
        Some(name) => {
            repo.reference_matching(name, new_oid, true, old.id(), &reflog).map_err(|e| {
                if e.code() == git2::ErrorCode::Modified { moved() } else { Error::Git(e) }
            })?;
        }
        None => {
            if repo.head()?.target() != Some(old.id()) {
                return Err(moved());
            }
            repo.set_head_detached(new_oid)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::lock_retry::with_budget;
    use crate::repo::test_support::state_for;
    use git2::Repository;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    #[test]
    fn amend_over_latin1_commit_transcodes_author_like_git() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let old = crate::repo::test_support::push_latin1_commit(&repo);
        amend_in(&repo, "Fixé le bug").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(c.id(), old);
        let raw = crate::repo::test_support::raw_object(&repo, c.id());
        let text = String::from_utf8(raw).unwrap();
        assert!(!text.contains("\nencoding "), "{text}");
        assert!(text.contains("\nauthor André <a@example.com> 1000000000 +0000\n"), "{text}");
        assert!(text.ends_with("\n\nFixé le bug"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_transcodes_empty_identity_with_encoding_header() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        push_raw_commit(&repo, "b.txt", b" <> 1600000000 +0000", b" <> 1600000000 +0000", b"encoding ISO-8859-1\n", b"msg\n");
        amend_in(&repo, "new msg").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        let raw = String::from_utf8(raw_object(&repo, c.id())).unwrap();
        assert!(raw.contains("\nauthor  <> 1600000000 +0000\n"), "{raw}");
        assert!(!raw.contains("\nencoding "), "{raw}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_byte_0x80_in_latin1_author_becomes_u0080() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        push_raw_commit(&repo, "b.txt", b"A\x80 <a@x> 1600000000 +0000", b"A <a@x> 1600000000 +0000", b"encoding ISO-8859-1\n", b"msg\n");
        amend_in(&repo, "m").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(c.author().name_bytes(), "A\u{80}".as_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_refuses_when_branch_moved_since_head_was_read() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let old = repo.head().unwrap().peel_to_commit().unwrap();
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        // Someone else moves the branch after HEAD was read.
        let other = push_raw_commit(&repo, "b.txt", b"T <t@x> 1 +0000", b"T <t@x> 1 +0000", b"", b"other\n");
        let err = amend_from(&repo, &old, Some(&branch_ref), "amended");
        assert!(err.is_err());
        assert_eq!(repo.find_reference(&branch_ref).unwrap().target(), Some(other));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_refuses_when_detached_head_moved() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let old = repo.head().unwrap().peel_to_commit().unwrap();
        let other = push_raw_commit(&repo, "b.txt", b"T <t@x> 1 +0000", b"T <t@x> 1 +0000", b"", b"other\n");
        repo.set_head_detached(other).unwrap();
        assert!(amend_from(&repo, &old, None, "amended").is_err());
        assert_eq!(repo.head().unwrap().target(), Some(other));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_reflog_message_follows_git() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        amend_in(&repo, "subject line\n\nbody").unwrap();
        let name = repo.head().unwrap().name().unwrap().to_owned();
        let log = repo.reflog(&name).unwrap();
        assert_eq!(log.get(0).unwrap().message(), Ok(Some("commit (amend): subject line")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_moves_the_branch_and_detached_head() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        amend_in(&repo, "one").unwrap();
        assert_eq!(repo.head().unwrap().name(), Ok(branch_ref.as_str()));
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(tip.message(), Ok("one"));
        assert_eq!(repo.find_reference(&branch_ref).unwrap().target(), Some(tip.id()));
        repo.set_head_detached(tip.id()).unwrap();
        amend_in(&repo, "two").unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().message(), Ok("two"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_keeps_empty_name_and_email_author() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        push_raw_commit(&repo, "b.txt", b" <> 1600000000 +0000", b" <> 1600000000 +0000", b"", b"msg\n");
        amend_in(&repo, "new msg").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        let raw = String::from_utf8(raw_object(&repo, c.id())).unwrap();
        assert!(raw.contains("\nauthor  <> 1600000000 +0000\n"), "{raw}");
        assert_eq!(c.message(), Ok("new msg"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_of_utf8_commit_writes_no_encoding_header() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        amend_in(&repo, "new msg").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        let raw = String::from_utf8(raw_object(&repo, c.id())).unwrap();
        assert!(!raw.contains("\nencoding "), "{raw}");
        let _ = std::fs::remove_dir_all(dir);
    }

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

    /// libgit2 does not wait for `.git/index.lock`; it fails at once with ELOCKED.
    /// The retry helper is bypassed here by holding the lock for longer than its budget.
    #[test]
    fn discard_all_reports_a_lock_held_past_the_retry_budget() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let lock = dir.join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let err = with_budget(Duration::from_millis(30), || discard_all_in(&repo)).expect_err("must fail while locked");
        match err {
            Error::Git(e) => {
                assert_eq!(e.code(), git2::ErrorCode::Locked);
                assert_eq!(e.class(), git2::ErrorClass::Index);
            }
            other => panic!("expected a git lock error, got {other:?}"),
        }
        let _ = std::fs::remove_file(&lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_all_succeeds_when_lock_released_shortly() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        // Different length from "hello", so the change is visible from stat data alone.
        std::fs::write(dir.join("a.txt"), "dirty and longer").unwrap();
        std::fs::write(dir.join("junk.txt"), "x").unwrap();
        let lock = dir.join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let l2 = lock.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            std::fs::remove_file(l2).unwrap();
        });
        with_budget(Duration::from_millis(500), || discard_all_in(&repo)).expect("should retry until the lock is released");
        h.join().unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "hello");
        assert!(!dir.join("junk.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn staged_paths(repo: &Repository) -> Vec<String> {
        let idx = repo.index().unwrap();
        idx.iter().map(|e| String::from_utf8(e.path).unwrap()).collect()
    }

    /// A failed discard on an unborn HEAD clears the cached handle's in-memory index
    /// before the write fails. The accessor reloads after the failure, so the stale
    /// (empty) state is never persisted by the next command.
    #[test]
    fn failed_discard_on_unborn_head_does_not_poison_the_next_command() {
        let (dir, repo) = make_repo();
        stage(&repo, "one.txt", "1");
        stage(&repo, "two.txt", "2");
        let (state, id) = state_for(repo);
        let lock = dir.join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();

        with_budget(Duration::from_millis(30), || with_repo(&state, &id, |repo| discard_all_in(repo)))
            .expect_err("lock outlasts the budget");
        std::fs::remove_file(&lock).unwrap();

        std::fs::write(dir.join("three.txt"), "3").unwrap();
        with_repo(&state, &id, |r| stage_paths_in(r, &["three.txt".to_string()])).unwrap();
        let fresh = Repository::open(&dir).unwrap();
        assert_eq!(staged_paths(&fresh), ["one.txt", "three.txt", "two.txt"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A command that fails after mutating the shared in-memory index must not leak
    /// the partial change into a later reader or writer.
    #[test]
    fn failed_stage_paths_does_not_leak_into_readers_or_the_next_writer() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        std::fs::write(dir.join("a_new.txt"), "x").unwrap();
        std::fs::write(dir.join("b_new.txt"), "y").unwrap();
        std::fs::create_dir(dir.join("adir")).unwrap();
        let (state, id) = state_for(repo);

        // 2nd path is a directory: add_path fails mid-command, after a_new.txt was added.
        let r = with_repo(&state, &id, |r| stage_paths_in(r, &["a_new.txt".to_string(), "adir".to_string()]));
        assert!(r.is_err());

        // A reader must not see the half-applied change. Read the cached handle
        // directly (not through `with_repo`, whose own up-front reload would mask a
        // missing reload-on-error), as any code outside the accessor would.
        {
            let repos = state.0.lock().unwrap();
            let files = list_status_in(repos.get(&id).unwrap()).unwrap();
            let a_new = files.iter().find(|f| f.path == "a_new.txt").expect("untracked file listed");
            assert_eq!(a_new.staged, None, "reader saw a half-applied stage");
        }

        // ...and the next writer must not persist it.
        with_repo(&state, &id, |r| stage_paths_in(r, &["b_new.txt".to_string()])).unwrap();
        let fresh = Repository::open(&dir).unwrap();
        assert_eq!(staged_paths(&fresh), ["a.txt", "b_new.txt"], "a_new.txt must not be persisted");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A failed unstage leaves paths missing from the cached in-memory index. A later
    /// `discard_all` on an unborn HEAD would treat them as untracked and delete files
    /// that are still staged on disk.
    #[test]
    fn discard_all_after_a_failed_unstage_keeps_files_staged_on_disk() {
        let (dir, repo) = make_repo();
        stage(&repo, "one.txt", "1");
        stage(&repo, "two.txt", "2");
        std::fs::write(dir.join("loose.txt"), "l").unwrap();
        let (state, id) = state_for(repo);

        // Both paths are dropped from the in-memory index, then the write fails on a
        // held index.lock.
        let lock = dir.join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let r = with_budget(Duration::from_millis(30), || {
            with_repo(&state, &id, |r| unstage_paths_in(r, &["one.txt".to_string(), "two.txt".to_string()]))
        });
        std::fs::remove_file(&lock).unwrap();
        assert!(r.is_err());

        with_repo(&state, &id, |repo| discard_all_in(repo)).unwrap();

        assert!(dir.join("one.txt").exists(), "file staged on disk must survive");
        assert!(dir.join("two.txt").exists(), "file staged on disk must survive");
        assert!(!dir.join("loose.txt").exists(), "untracked file is still swept");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Staged state that only exists in the cached handle's memory (left by an
    /// earlier failed command) must not end up in a commit.
    #[test]
    fn commit_ignores_stale_in_memory_index() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        std::fs::write(dir.join("ghost.txt"), "boo").unwrap();
        let (state, id) = state_for(repo);
        with_repo(&state, &id, |r| {
            r.index()?.add_path(Path::new("ghost.txt"))?; // in memory only, never written
            Err::<(), _>(Error::InvalidArg("boom".into()))
        })
        .unwrap_err();

        with_repo(&state, &id, |r| commit_in(r, "second")).unwrap();

        let repo = Repository::open(&dir).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_name("ghost.txt").is_none(), "stale in-memory entry leaked into the commit");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_paths_keeps_untracked_files_when_the_index_write_fails() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        std::fs::write(dir.join("new.txt"), "keep me").unwrap();
        stage_paths_in(&repo, &["new.txt".to_string()]).unwrap();
        std::fs::write(dir.join("loose.txt"), "untracked").unwrap();
        let lock = dir.join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();

        let r = with_budget(Duration::from_millis(30), || {
            discard_paths_in(&repo, &["new.txt".to_string(), "loose.txt".to_string()])
        });
        std::fs::remove_file(&lock).unwrap();

        assert!(matches!(r, Err(Error::Git(ref e)) if e.code() == git2::ErrorCode::Locked), "{r:?}");
        assert!(dir.join("new.txt").exists(), "staged-new file must not be deleted");
        assert!(dir.join("loose.txt").exists(), "untracked file must not be deleted");
        let fresh = Repository::open(&dir).unwrap();
        assert_eq!(staged_paths(&fresh), ["a.txt", "new.txt"], "staged entry survives on disk");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_paths_deletes_files_once_the_lock_is_released() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        stage_paths_in(&repo, &["new.txt".to_string()]).unwrap();
        std::fs::write(dir.join("a.txt"), "changed and longer").unwrap();
        let lock = dir.join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let l2 = lock.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            std::fs::remove_file(l2).unwrap();
        });
        with_budget(Duration::from_millis(500), || {
            discard_paths_in(&repo, &["new.txt".to_string(), "a.txt".to_string()])
        })
        .unwrap();
        h.join().unwrap();
        assert!(!dir.join("new.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_retries_a_held_branch_ref_lock() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        stage_paths_in(&repo, &["b.txt".to_string()]).unwrap();
        let branch = repo.head().unwrap().name().unwrap().to_owned();
        let lock = dir.join(".git").join(format!("{branch}.lock"));
        std::fs::write(&lock, "").unwrap();

        // Held past the budget: reported as a lock error, nothing committed.
        let r = with_budget(Duration::from_millis(30), || commit_in(&repo, "two"));
        assert!(matches!(r, Err(Error::Git(ref e)) if e.code() == git2::ErrorCode::Locked), "{r:?}");

        // Released shortly: the retry succeeds.
        let l2 = lock.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            std::fs::remove_file(l2).unwrap();
        });
        with_budget(Duration::from_millis(500), || commit_in(&repo, "two")).unwrap();
        h.join().unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().summary(), Ok(Some("two")));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A repo the user closed (or never opened) must not come back to life just
    /// because `discard_all` re-opens by path after the lookup failed.
    #[test]
    fn discard_all_on_an_unknown_id_does_not_register_a_handle() {
        let (dir, _repo) = crate::repo::test_support::make_repo_with_commit();
        // The id is a real repo path that is not (or no longer) in the state map.
        let id = dir.to_string_lossy().to_string();
        let state = RepoState::default();

        let r = discard_all_with(&state, id.clone());
        assert!(matches!(r, Err(Error::RepoNotFound(_))), "{r:?}");
        assert!(!state.0.lock().unwrap().contains_key(&id), "closed repo was resurrected");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// If removing an untracked file fails, the tracked files named in the same call
    /// are already restored in both the index and the working tree, and the error
    /// names what could not be removed.
    #[test]
    fn discard_paths_restores_tracked_files_even_when_an_untracked_removal_fails() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        std::fs::write(dir.join("a.txt"), "changed and longer").unwrap();
        // `remove_file` cannot remove a directory: a deterministic removal failure.
        std::fs::create_dir(dir.join("stuck")).unwrap();
        std::fs::write(dir.join("stuck").join("f.txt"), "x").unwrap();

        let r = discard_paths_in(&repo, &["stuck".to_string(), "a.txt".to_string()]);

        let msg = r.expect_err("removal of a directory must fail").to_string();
        assert!(msg.contains("stuck"), "{msg}");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "hello", "worktree restored");
        let fresh = Repository::open(&dir).unwrap();
        let head = fresh.head().unwrap().peel_to_tree().unwrap();
        let entry = fresh.index().unwrap().get_path(Path::new("a.txt"), 0).unwrap();
        assert_eq!(entry.id, head.get_name("a.txt").unwrap().id(), "index restored");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `discard_all` swaps in a fresh handle even when the discard failed, and still
    /// reports the discard's error.
    #[test]
    fn reopen_cached_replaces_the_handle_and_keeps_the_original_error() {
        let (dir, repo) = make_repo();
        stage(&repo, "one.txt", "1");
        // In-memory-only change: visible through the old handle, gone from any new one.
        std::fs::write(dir.join("ghost.txt"), "g").unwrap();
        repo.index().unwrap().add_path(Path::new("ghost.txt")).unwrap();
        assert_eq!(staged_paths(&repo), ["ghost.txt", "one.txt"]);
        let id = dir.to_string_lossy().to_string();
        let state = RepoState(std::sync::Mutex::new(std::collections::HashMap::new()));
        state.0.lock().unwrap().insert(id.clone(), repo);

        let failed: Result<()> = Err(Error::InvalidArg("discard failed".into()));
        let r = reopen_cached(&state, id.clone(), failed);
        assert!(matches!(r, Err(Error::InvalidArg(_))));
        {
            let repos = state.0.lock().unwrap();
            assert_eq!(staged_paths(repos.get(&id).unwrap()), ["one.txt"], "handle must have been replaced");
        }

        // Reopen failure after a successful discard is surfaced...
        assert!(reopen_cached(&state, dir.join("nope").to_string_lossy().to_string(), Ok(())).is_err());
        // ...but never masks the discard's own error.
        let r = reopen_cached(
            &state,
            dir.join("nope").to_string_lossy().to_string(),
            Err(Error::InvalidArg("discard failed".into())),
        );
        assert!(matches!(r, Err(Error::InvalidArg(_))));
        let _ = std::fs::remove_dir_all(dir);
    }
}
