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
    pub conflicted_paths: Vec<String>,
    pub merge_head_oid: Option<String>,
    /// Default commit message pre-filled in the UI (from MERGE_MSG).
    pub default_message: String,
}

fn io_err(e: std::io::Error) -> Error {
    Error::InvalidArg(e.to_string())
}

fn cleanup_merge_state(repo: &git2::Repository) {
    let git_dir = repo.path();
    for name in &["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
        let _ = std::fs::remove_file(git_dir.join(name));
    }
}

fn collect_conflict_paths(index: &git2::Index) -> Result<Vec<String>> {
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
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let annotated = repo.find_annotated_commit(git_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeResult { kind: "up_to_date".into(), conflicted: vec![] });
    }

    if analysis.is_fast_forward() {
        let head = repo.head()?;
        if head.is_branch() {
            let refname = head.name().unwrap_or("HEAD").to_string();
            repo.find_reference(&refname)?.set_target(git_oid, "merge: Fast-forward")?;
            repo.set_head(&refname)?;
        } else {
            repo.set_head_detached(git_oid)?;
        }
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
        return Ok(MergeResult { kind: "fast_forward".into(), conflicted: vec![] });
    }

    // Normal merge.
    repo.merge(&[&annotated], None, None)?;

    let mut index = repo.index()?;
    index.write()?;

    let merge_label = if label.is_empty() { &oid[..8.min(oid.len())] } else { &label };
    let merge_msg = format!("Merge branch '{}'", merge_label);

    if index.has_conflicts() {
        let conflicted = collect_conflict_paths(&index)?;

        // Write merge state files so get_merge_status can read them.
        let git_dir = repo.path();
        std::fs::write(git_dir.join("MERGE_HEAD"), format!("{}\n", git_oid)).map_err(io_err)?;
        std::fs::write(git_dir.join("MERGE_MSG"), &merge_msg).map_err(io_err)?;

        return Ok(MergeResult { kind: "conflicts".into(), conflicted });
    }

    // Clean merge — commit immediately.
    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let other_commit = repo.find_commit(git_oid)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    repo.commit(Some("HEAD"), &sig, &sig, &merge_msg, &tree, &[&head_commit, &other_commit])?;
    cleanup_merge_state(repo);

    Ok(MergeResult { kind: "merged".into(), conflicted: vec![] })
}

/// Return the current merge state including any remaining conflicted paths.
#[tauri::command]
pub fn get_merge_status(repo_id: String, state: State<RepoState>) -> Result<MergeStatus> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let merge_head_path = repo.path().join("MERGE_HEAD");
    if !merge_head_path.exists() {
        return Ok(MergeStatus {
            in_progress: false,
            conflicted_paths: vec![],
            merge_head_oid: None,
            default_message: String::new(),
        });
    }

    let merge_head_oid = std::fs::read_to_string(&merge_head_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let index = repo.index()?;
    let conflicted_paths = collect_conflict_paths(&index)?;

    let default_message = {
        let p = repo.path().join("MERGE_MSG");
        std::fs::read_to_string(p)
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or("")
            .to_string()
    };

    Ok(MergeStatus {
        in_progress: true,
        conflicted_paths,
        merge_head_oid: Some(merge_head_oid),
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
    let workdir = repo.workdir().ok_or_else(|| Error::InvalidArg("Bare repository".into()))?;
    let full_path = workdir.join(path);

    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    std::fs::write(&full_path, blob.content()).map_err(io_err)?;

    // Staging the file removes the conflict entry.
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
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let merge_head_path = repo.path().join("MERGE_HEAD");
    let merge_oid_str = std::fs::read_to_string(&merge_head_path)
        .map_err(|_| Error::InvalidArg("No merge in progress".into()))?;
    let merge_oid = git2::Oid::from_str(merge_oid_str.trim())?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(Error::InvalidArg(
            "Cannot commit: there are unresolved conflicts.".into(),
        ));
    }

    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let other_commit = repo.find_commit(merge_oid)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    repo.commit(
        Some("HEAD"),
        &sig, &sig,
        message.trim(),
        &tree,
        &[&head_commit, &other_commit],
    )?;

    cleanup_merge_state(repo);
    Ok(())
}

/// Abort the in-progress merge: hard-reset to HEAD and clean up state files.
#[tauri::command]
pub fn abort_merge(repo_id: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head_commit = repo.head()?.peel_to_commit()?;
    repo.reset(head_commit.as_object(), git2::ResetType::Hard, None)?;
    cleanup_merge_state(repo);
    Ok(())
}
