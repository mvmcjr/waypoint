use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct StatusInfo {
    pub staged_count: usize,
    pub unstaged_count: usize,
}

/// Return counts of staged and unstaged (including untracked) changes.
#[tauri::command]
pub fn get_repo_status(repo_id: String, state: State<RepoState>) -> Result<StatusInfo> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts))?;

    let staged_count = statuses.iter().filter(|e| {
        e.status().intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        )
    }).count();

    let unstaged_count = statuses.iter().filter(|e| {
        e.status().intersects(
            git2::Status::WT_NEW
                | git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        )
    }).count();

    Ok(StatusInfo { staged_count, unstaged_count })
}

#[derive(Debug, Serialize)]
pub struct HeadInfo {
    pub oid: String,
    /// Local branch name, or None when HEAD is detached.
    pub branch: Option<String>,
}

#[tauri::command]
pub fn get_head_info(repo_id: String, state: State<RepoState>) -> Result<HeadInfo> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head = repo.head()?;
    let oid = head
        .target()
        .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?
        .to_string();

    let branch = if head.is_branch() {
        head.shorthand().map(|s| s.to_owned())
    } else {
        None
    };

    Ok(HeadInfo { oid, branch })
}

/// Checkout a local branch by short name (e.g. "main").
#[tauri::command]
pub fn checkout_branch(repo_id: String, branch_name: String, force: bool, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let refspec = format!("refs/heads/{}", branch_name);
    do_checkout(repo, &refspec, force)
}

/// Checkout a specific commit by OID (creates detached HEAD).
#[tauri::command]
pub fn checkout_commit(repo_id: String, oid: String, force: bool, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    do_checkout(repo, &oid, force)
}

fn do_checkout(repo: &git2::Repository, refspec: &str, force: bool) -> Result<()> {
    let (obj, reference) = repo.revparse_ext(refspec)?;

    let mut opts = git2::build::CheckoutBuilder::new();
    if force {
        opts.force();
    } else {
        opts.safe();
    }

    repo.checkout_tree(&obj, Some(&mut opts))?;

    match reference {
        Some(gref) => repo.set_head(gref.name().unwrap_or(refspec))?,
        None => {
            let commit_oid = obj.peel_to_commit()?.id();
            repo.set_head_detached(commit_oid)?;
        }
    }

    Ok(())
}

/// Create a new branch pointing at the given commit OID.
#[tauri::command]
pub fn create_branch_at(
    repo_id: String,
    name: String,
    oid: String,
    checkout: bool,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;

    repo.branch(&name, &commit, false)?;

    if checkout {
        do_checkout(repo, &format!("refs/heads/{}", name), false)?;
    }

    Ok(())
}

/// Reset the current HEAD to the given commit OID.
/// kind: "soft" | "mixed" | "hard"
#[tauri::command]
pub fn reset_head(repo_id: String, oid: String, kind: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let obj = repo.find_object(git_oid, None)?;

    let reset_type = match kind.as_str() {
        "soft" => git2::ResetType::Soft,
        "hard" => git2::ResetType::Hard,
        _ => git2::ResetType::Mixed,
    };

    repo.reset(&obj, reset_type, None)?;
    Ok(())
}

/// Rebase the current branch onto the given commit.
/// Aborts and returns an error if there are merge conflicts.
#[tauri::command]
pub fn rebase_onto(repo_id: String, onto_oid: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    // Must be on a branch (not detached HEAD) to rebase.
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot rebase: HEAD is detached. Checkout a branch first.".into(),
        ));
    }

    let oid = git2::Oid::from_str(&onto_oid).map_err(|_| Error::CommitNotFound(onto_oid.clone()))?;
    let onto = repo.find_annotated_commit(oid)?;

    let sig = repo.signature()?;
    let mut rebase = repo.rebase(None, Some(&onto), None, None)?;

    loop {
        match rebase.next() {
            None => break,
            Some(Err(e)) => {
                let _ = rebase.abort();
                return Err(Error::Git(e));
            }
            Some(Ok(_op)) => {
                if repo.index()?.has_conflicts() {
                    let _ = rebase.abort();
                    return Err(Error::RebaseConflict(
                        "Rebase has conflicts and was aborted. Please resolve them manually in a terminal.".into(),
                    ));
                }
                rebase.commit(None, &sig, None)?;
            }
        }
    }

    rebase.finish(None)?;
    Ok(())
}
