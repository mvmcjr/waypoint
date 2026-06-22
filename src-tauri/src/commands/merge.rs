use std::path::Path;
use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct MergeResult {
    /// "fast_forward" | "merged" | "up_to_date" | "conflicts"
    pub kind: String,
    pub conflicted: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MergeStatus {
    pub in_progress: bool,
    /// "merge" | "cherry_pick" | ""
    pub kind: String,
    pub conflicted_paths: Vec<String>,
    pub merge_head_oid: Option<String>,
    /// Default commit message pre-filled in the UI.
    pub default_message: String,
}

#[derive(Debug, Serialize)]
pub struct CherryPickResult {
    /// "staged" | "conflicts"
    pub kind: String,
    /// Pre-filled commit message (populated for both kinds).
    pub message: String,
    pub conflicted: Vec<String>,
}

fn io_err(e: std::io::Error) -> Error {
    Error::InvalidArg(e.to_string())
}

pub(crate) fn cleanup_merge_state(repo: &git2::Repository) {
    let git_dir = repo.path();
    for name in &["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE",
                  "CHERRY_PICK_HEAD", "CHERRY_PICK_MSG",
                  "REVERT_HEAD", "REVERT_MSG"] {
        let _ = std::fs::remove_file(git_dir.join(name));
    }
}

pub(crate) fn collect_conflict_paths(index: &git2::Index) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    for entry in index.conflicts()? {
        let c = entry?;
        let path = c.our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .unwrap_or_default();
        if !path.is_empty() {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Stash any tracked uncommitted changes so a merge/cherry-pick starts on a clean tree.
/// Writes `WAYPOINT_AUTOSTASH` to the git dir to mark that we need to pop on completion.
/// Returns `true` if a stash was created.
fn auto_stash(repo: &mut git2::Repository) -> Result<bool> {
    let is_dirty = {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(false).include_ignored(false);
        // Use a block so `statuses` (which borrows repo) is dropped before stash_save.
        let statuses = repo.statuses(Some(&mut opts))?;
        statuses.iter().any(|e| {
            e.status().intersects(
                git2::Status::INDEX_NEW
                    | git2::Status::INDEX_MODIFIED
                    | git2::Status::INDEX_DELETED
                    | git2::Status::INDEX_RENAMED
                    | git2::Status::INDEX_TYPECHANGE
                    | git2::Status::WT_MODIFIED
                    | git2::Status::WT_DELETED
                    | git2::Status::WT_RENAMED
                    | git2::Status::WT_TYPECHANGE,
            )
        })
    };

    if !is_dirty {
        return Ok(false);
    }

    let sig = repo.signature()?;
    repo.stash_save(&sig, "waypoint-autostash", None)?;
    std::fs::write(repo.path().join("WAYPOINT_AUTOSTASH"), b"1").map_err(io_err)?;
    Ok(true)
}

/// Re-apply the autostash created by `auto_stash`, if any.
/// Best-effort: if the apply fails (e.g. conflicts with the merge result) the
/// stash is left in place so the user can pop it manually.
fn auto_pop(repo: &mut git2::Repository) {
    let autostash_path = repo.path().join("WAYPOINT_AUTOSTASH");
    if !autostash_path.exists() {
        return;
    }
    let mut opts = git2::StashApplyOptions::new();
    if repo.stash_apply(0, Some(&mut opts)).is_ok() {
        let _ = repo.stash_drop(0);
        let _ = std::fs::remove_file(&autostash_path);
    }
    // On failure: leave the stash in place; user will see it in the stash list.
}

/// Merge the given commit OID into HEAD.
/// `label` is the branch name shown in the auto-generated commit message;
/// pass an empty string if the target is not a branch tip.
#[tauri::command]
pub fn merge_commit(
    repo_id: String,
    oid: String,
    label: String,
    state: State<RepoState>,
) -> Result<MergeResult> {
    let mut repos = state.0.lock().unwrap();

    // Phase 1 — auto-stash dirty working tree (needs &mut repo).
    let autostashed = {
        let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        auto_stash(repo)?
    };

    // Phase 2 — perform the merge (only needs &repo; annotated must be dropped before phase 3).
    let result: MergeResult = {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

        let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
        let annotated = repo.find_annotated_commit(git_oid)?;
        let (analysis, _) = repo.merge_analysis(&[&annotated])?;

        if analysis.is_up_to_date() {
            MergeResult { kind: "up_to_date".into(), conflicted: vec![] }
        } else {
            // Normal merge.
            repo.merge(&[&annotated], None, None)?;
            let mut index = repo.index()?;
            index.write()?;

            let merge_msg = if label.is_empty() {
                format!("Merge commit '{}'", &oid[..8.min(oid.len())])
            } else if label.contains('/') {
                format!("Merge remote-tracking branch '{}'", label)
            } else {
                format!("Merge branch '{}'", label)
            };

            if index.has_conflicts() {
                let conflicted = collect_conflict_paths(&index)?;
                let git_dir = repo.path();
                std::fs::write(git_dir.join("MERGE_HEAD"), format!("{}\n", git_oid)).map_err(io_err)?;
                std::fs::write(git_dir.join("MERGE_MSG"), &merge_msg).map_err(io_err)?;
                MergeResult { kind: "conflicts".into(), conflicted }
            } else {
                let sig = repo.signature()?;
                let head_commit = repo.head()?.peel_to_commit()?;
                let other_commit = repo.find_commit(git_oid)?;
                let tree_oid = index.write_tree()?;
                let tree = repo.find_tree(tree_oid)?;
                repo.commit(Some("HEAD"), &sig, &sig, &merge_msg, &tree, &[&head_commit, &other_commit])?;
                cleanup_merge_state(repo);
                MergeResult { kind: "merged".into(), conflicted: vec![] }
            }
        }
        // `annotated` (and any other repo-lifetime borrows) dropped at end of this block.
    };

    // Phase 3 — pop autostash if the operation completed without conflicts.
    if autostashed && result.kind != "conflicts" {
        let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        auto_pop(repo);
    }

    Ok(result)
}

/// Return the current merge/cherry-pick state including any remaining conflicted paths.
#[tauri::command]
pub fn get_merge_status(repo_id: String, state: State<RepoState>) -> Result<MergeStatus> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_dir = repo.path();
    let merge_head_path = git_dir.join("MERGE_HEAD");
    let cherry_pick_head_path = git_dir.join("CHERRY_PICK_HEAD");
    let revert_head_path = git_dir.join("REVERT_HEAD");

    let (kind, head_path, msg_file) = if merge_head_path.exists() {
        ("merge", merge_head_path, "MERGE_MSG")
    } else if cherry_pick_head_path.exists() {
        ("cherry_pick", cherry_pick_head_path, "CHERRY_PICK_MSG")
    } else if revert_head_path.exists() {
        ("revert", revert_head_path, "REVERT_MSG")
    } else {
        return Ok(MergeStatus {
            in_progress: false,
            kind: String::new(),
            conflicted_paths: vec![],
            merge_head_oid: None,
            default_message: String::new(),
        });
    };

    let head_oid = std::fs::read_to_string(&head_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let index = repo.index()?;
    let conflicted_paths = collect_conflict_paths(&index)?;

    let default_message = std::fs::read_to_string(git_dir.join(msg_file))
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    Ok(MergeStatus {
        in_progress: true,
        kind: kind.to_string(),
        conflicted_paths,
        merge_head_oid: Some(head_oid),
        default_message,
    })
}

fn resolve_with_side(repo: &git2::Repository, path: &str, use_ours: bool) -> Result<()> {
    let mut index = repo.index()?;

    // Collect conflict entries before mutably borrowing the index.
    let chosen_entry: Option<git2::IndexEntry> = {
        let mut found = None;
        for entry in index.conflicts()? {
            let c = entry?;
            let cpath = c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path).into_owned())
                .unwrap_or_default();
            if cpath == path {
                found = if use_ours { c.our } else { c.their };
                break;
            }
        }
        found
    };

    let entry = chosen_entry.ok_or_else(|| {
        let side = if use_ours { "ours" } else { "theirs" };
        Error::InvalidArg(format!("No {} version found for: {}", side, path))
    })?;

    let blob = repo.find_blob(entry.id)?;
    let workdir = crate::repo::workdir(repo)?;
    let full_path = workdir.join(path);

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    std::fs::write(&full_path, blob.content()).map_err(io_err)?;

    index.add_path(Path::new(path))?;
    index.write()?;
    Ok(())
}

/// Stage "our" version of a conflicted file (pre-merge).
#[tauri::command]
pub fn resolve_ours(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    resolve_with_side(repo, &path, true)
}

/// Stage "their" version of a conflicted file (from the merged commit).
#[tauri::command]
pub fn resolve_theirs(repo_id: String, path: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    resolve_with_side(repo, &path, false)
}

/// Create the merge commit after all conflicts are resolved.
#[tauri::command]
pub fn finish_merge(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();

    // Commit phase (only needs &repo — drop all borrows at end of block).
    {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

        let merge_head_path = repo.path().join("MERGE_HEAD");
        let merge_oid_str = std::fs::read_to_string(&merge_head_path)
            .map_err(|_| Error::InvalidArg("No merge in progress".into()))?;
        let merge_oid = git2::Oid::from_str(merge_oid_str.trim())?;

        let mut index = repo.index()?;
        if index.has_conflicts() {
            return Err(Error::InvalidArg("Cannot commit: there are unresolved conflicts.".into()));
        }

        let sig = repo.signature()?;
        let head_commit = repo.head()?.peel_to_commit()?;
        let other_commit = repo.find_commit(merge_oid)?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;

        repo.commit(Some("HEAD"), &sig, &sig, message.trim(), &tree, &[&head_commit, &other_commit])?;
        cleanup_merge_state(repo);
    }

    // Pop autostash (needs &mut repo).
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    auto_pop(repo);
    Ok(())
}

/// Abort the in-progress merge or cherry-pick: hard-reset to HEAD and clean up state files.
#[tauri::command]
pub fn abort_merge(repo_id: String, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();

    // Reset to HEAD (drop head_commit before auto_pop needs &mut).
    {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let head_commit = repo.head()?.peel_to_commit()?;
        repo.reset(head_commit.as_object(), git2::ResetType::Hard, None)?;
        cleanup_merge_state(repo);
    }

    // Pop autostash (needs &mut repo).
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    auto_pop(repo);
    Ok(())
}

fn cherry_pick_impl(repo: &git2::Repository, oid_str: &str) -> Result<CherryPickResult> {
    let git_oid = git2::Oid::from_str(oid_str).map_err(|_| Error::CommitNotFound(oid_str.to_string()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid_str.to_string()))?;

    repo.cherrypick(&commit, None)?;

    let mut index = repo.index()?;
    index.write()?;

    let msg = commit.message().unwrap_or("").to_string();

    if index.has_conflicts() {
        // libgit2 wrote CHERRY_PICK_HEAD but NOT CHERRY_PICK_MSG; write it so get_merge_status
        // can return the default commit message for the MergeCommitPanel textarea.
        let conflicted = collect_conflict_paths(&index)?;
        std::fs::write(repo.path().join("CHERRY_PICK_MSG"), &msg).map_err(io_err)?;
        Ok(CherryPickResult { kind: "conflicts".into(), conflicted, message: msg })
    } else {
        // Clean apply: libgit2 wrote CHERRY_PICK_HEAD but we don't want merge state.
        // Remove it so the staging panel shows normally.
        cleanup_merge_state(repo);
        Ok(CherryPickResult { kind: "staged".into(), conflicted: vec![], message: msg })
    }
}

/// Apply the given commit onto HEAD (cherry-pick).
/// Returns `kind = "applied"` on success or `kind = "conflicts"` with the conflicted paths.
#[tauri::command]
pub fn cherry_pick(repo_id: String, oid: String, state: State<RepoState>) -> Result<CherryPickResult> {
    let mut repos = state.0.lock().unwrap();

    let autostashed = {
        let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        auto_stash(repo)?
    };

    let result = {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        cherry_pick_impl(repo, &oid)?
    };

    // For a clean apply ("staged"), pop immediately — no merge state to preserve.
    // For conflicts, the stash is popped in finish_cherry_pick after resolving.
    if autostashed && result.kind == "staged" {
        let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        auto_pop(repo);
    }

    Ok(result)
}

/// Read the raw working-directory content of a conflicted file, including conflict markers.
#[tauri::command]
pub fn get_conflict_content(repo_id: String, path: String, state: State<RepoState>) -> Result<String> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let full_path = crate::repo::workdir(repo)?.join(&path);
    std::fs::read_to_string(&full_path).map_err(io_err)
}

/// Write per-hunk-resolved content to a conflicted file and stage it.
/// The caller must supply content with no remaining conflict markers.
#[tauri::command]
pub fn resolve_with_content(
    repo_id: String,
    path: String,
    content: String,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    let full_path = crate::repo::workdir(repo)?.join(&path);
    std::fs::write(&full_path, content.as_bytes()).map_err(io_err)?;
    let mut index = repo.index()?;
    index.add_path(Path::new(&path))?;
    index.write()?;
    Ok(())
}

fn finish_cherry_pick_impl(repo: &git2::Repository, message: &str) -> Result<()> {
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(Error::InvalidArg("Cannot commit: there are unresolved conflicts.".into()));
    }

    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    repo.commit(Some("HEAD"), &sig, &sig, message.trim(), &tree, &[&head_commit])?;
    Ok(())
}

/// Create the cherry-pick commit after all conflicts are resolved (single-parent).
#[tauri::command]
pub fn finish_cherry_pick(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();

    {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let result = finish_cherry_pick_impl(repo, &message);
        cleanup_merge_state(repo);
        result?;
    }

    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    auto_pop(repo);
    Ok(())
}

fn revert_impl(repo: &git2::Repository, oid_str: &str) -> Result<CherryPickResult> {
    let git_oid = git2::Oid::from_str(oid_str).map_err(|_| Error::CommitNotFound(oid_str.to_string()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid_str.to_string()))?;

    repo.revert(&commit, None)?;

    let mut index = repo.index()?;
    index.write()?;

    let summary = commit.summary().unwrap_or("");
    let msg = format!("revert: {}\n\nThis reverts commit {}.", summary, oid_str);

    if index.has_conflicts() {
        let conflicted = collect_conflict_paths(&index)?;
        std::fs::write(repo.path().join("REVERT_MSG"), &msg).map_err(io_err)?;
        Ok(CherryPickResult { kind: "conflicts".into(), conflicted, message: msg })
    } else {
        cleanup_merge_state(repo);
        Ok(CherryPickResult { kind: "staged".into(), conflicted: vec![], message: msg })
    }
}

/// Revert the given commit.
/// Returns `kind = "staged"` on success or `kind = "conflicts"` with the conflicted paths.
#[tauri::command]
pub fn revert_commit(repo_id: String, oid: String, state: State<RepoState>) -> Result<CherryPickResult> {
    let mut repos = state.0.lock().unwrap();

    let autostashed = {
        let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        auto_stash(repo)?
    };

    let result = {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        revert_impl(repo, &oid)?
    };

    if autostashed && result.kind == "staged" {
        let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        auto_pop(repo);
    }

    Ok(result)
}

/// Create the revert commit after all conflicts are resolved (single-parent).
#[tauri::command]
pub fn finish_revert(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();

    {
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let result = finish_cherry_pick_impl(repo, &message);
        cleanup_merge_state(repo);
        result?;
    }

    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    auto_pop(repo);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, build::CheckoutBuilder};
    use std::path::{Path, PathBuf};

    fn make_temp_dir() -> PathBuf {
        let id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("wpt_test_{}", id));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_repo() -> (PathBuf, Repository) {
        let dir = make_temp_dir();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        (dir, repo)
    }

    fn write_commit(repo: &Repository, filename: &str, content: &str, msg: &str) -> git2::Oid {
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(workdir.join(filename), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(filename)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(head) => vec![head.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs).unwrap()
    }

    fn checkout(repo: &Repository, branch_ref: &str) {
        repo.set_head(branch_ref).unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
    }

    #[test]
    fn cherry_pick_applies_clean_commit() {
        let (_dir, repo) = make_repo();
        let root = write_commit(&repo, "base.txt", "base\n", "initial");
        let root_commit = repo.find_commit(root).unwrap();
        let main_ref = repo.head().unwrap().name().unwrap().to_string();

        repo.branch("feat", &root_commit, false).unwrap();
        checkout(&repo, "refs/heads/feat");
        let feat_oid = write_commit(&repo, "new_feature.txt", "feature\n", "feat: add feature");

        checkout(&repo, &main_ref);

        let result = cherry_pick_impl(&repo, &feat_oid.to_string()).unwrap();

        assert_eq!(result.kind, "staged");
        assert!(result.conflicted.is_empty());
        assert_eq!(result.message, "feat: add feature");
        // No merge-state files — staging panel shows normally.
        assert!(!repo.path().join("CHERRY_PICK_HEAD").exists());
        // HEAD must NOT have advanced — user commits via the dialog.
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "initial");
    }

    #[test]
    fn cherry_pick_detects_conflicts() {
        let (_dir, repo) = make_repo();
        let root = write_commit(&repo, "shared.txt", "original\n", "initial");
        let root_commit = repo.find_commit(root).unwrap();
        let main_ref = repo.head().unwrap().name().unwrap().to_string();

        repo.branch("feat", &root_commit, false).unwrap();
        checkout(&repo, "refs/heads/feat");
        let feat_oid = write_commit(&repo, "shared.txt", "feat change\n", "feat: modify shared");

        checkout(&repo, &main_ref);
        let _ = write_commit(&repo, "shared.txt", "main change\n", "main: modify shared");

        let result = cherry_pick_impl(&repo, &feat_oid.to_string()).unwrap();

        assert_eq!(result.kind, "conflicts");
        assert!(result.conflicted.iter().any(|p| p == "shared.txt"));
        assert!(repo.path().join("CHERRY_PICK_HEAD").exists());
        assert!(repo.path().join("CHERRY_PICK_MSG").exists());
    }

    #[test]
    fn cherry_pick_unknown_oid_errors() {
        let (_dir, repo) = make_repo();
        let _ = write_commit(&repo, "f.txt", "content\n", "initial");

        let err = cherry_pick_impl(&repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap_err();
        assert!(matches!(err, Error::CommitNotFound(_)));
    }

    #[test]
    fn finish_cherry_pick_rejects_unresolved_conflicts() {
        let (_dir, repo) = make_repo();
        let root = write_commit(&repo, "shared.txt", "original\n", "initial");
        let root_commit = repo.find_commit(root).unwrap();
        let main_ref = repo.head().unwrap().name().unwrap().to_string();

        repo.branch("feat", &root_commit, false).unwrap();
        checkout(&repo, "refs/heads/feat");
        let feat_oid = write_commit(&repo, "shared.txt", "feat change\n", "feat commit");

        checkout(&repo, &main_ref);
        let _ = write_commit(&repo, "shared.txt", "main change\n", "main commit");

        let cp = cherry_pick_impl(&repo, &feat_oid.to_string()).unwrap();
        assert_eq!(cp.kind, "conflicts");

        let err = finish_cherry_pick_impl(&repo, "resolved").unwrap_err();
        match err {
            Error::InvalidArg(msg) => assert!(msg.contains("unresolved conflicts")),
            other => panic!("expected InvalidArg, got {:?}", other),
        }
    }

    #[test]
    fn finish_cherry_pick_commits_after_resolve() {
        let (_dir, repo) = make_repo();
        let root = write_commit(&repo, "shared.txt", "original\n", "initial");
        let root_commit = repo.find_commit(root).unwrap();
        let main_ref = repo.head().unwrap().name().unwrap().to_string();

        repo.branch("feat", &root_commit, false).unwrap();
        checkout(&repo, "refs/heads/feat");
        let feat_oid = write_commit(&repo, "shared.txt", "feat change\n", "feat commit");

        checkout(&repo, &main_ref);
        let _ = write_commit(&repo, "shared.txt", "main change\n", "main commit");

        cherry_pick_impl(&repo, &feat_oid.to_string()).unwrap();

        // Resolve: write clean content and stage
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(workdir.join("shared.txt"), "resolved content\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("shared.txt")).unwrap();
        index.write().unwrap();

        finish_cherry_pick_impl(&repo, "cherry-pick: resolved").unwrap();

        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "cherry-pick: resolved");
        assert_eq!(head.parent_count(), 1);
    }

    #[test]
    fn revert_applies_clean_commit() {
        let (_dir, repo) = make_repo();
        let _root = write_commit(&repo, "shared.txt", "line 1\n", "initial");

        let feat_oid = write_commit(&repo, "shared.txt", "line 1\nline 2\n", "feat: add line 2");

        let result = revert_impl(&repo, &feat_oid.to_string()).unwrap();

        assert_eq!(result.kind, "staged");
        assert!(result.conflicted.is_empty());
        assert!(result.message.contains("revert: feat: add line 2"));
        assert!(!repo.path().join("REVERT_HEAD").exists());
    }

    #[test]
    fn revert_detects_conflicts() {
        let (_dir, repo) = make_repo();
        let root = write_commit(&repo, "shared.txt", "original\n", "initial");
        let root_commit = repo.find_commit(root).unwrap();
        let main_ref = repo.head().unwrap().name().unwrap().to_string();

        repo.branch("feat", &root_commit, false).unwrap();
        checkout(&repo, "refs/heads/feat");
        let feat_oid = write_commit(&repo, "shared.txt", "feat change\n", "feat commit");

        checkout(&repo, &main_ref);
        let _ = write_commit(&repo, "shared.txt", "main change\n", "main commit");

        let result = revert_impl(&repo, &feat_oid.to_string()).unwrap();

        assert_eq!(result.kind, "conflicts");
        assert!(result.conflicted.iter().any(|p| p == "shared.txt"));
        assert!(repo.path().join("REVERT_HEAD").exists());
        assert!(repo.path().join("REVERT_MSG").exists());
    }
}
