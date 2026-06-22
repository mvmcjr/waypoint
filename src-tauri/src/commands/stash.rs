use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

/// Save staged + unstaged changes as a new stash entry.
/// If `message` is blank an automatic message is generated from the branch and HEAD commit.
#[tauri::command]
pub fn stash_push(repo_id: String, message: String, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let sig = repo.signature()?;

    let msg = if message.trim().is_empty() {
        // Mirror the git CLI format: "WIP on <branch>: <short-oid> <summary>"
        let head = repo.head()?;
        let branch = head.shorthand().unwrap_or("HEAD").to_string();
        let commit = head.peel_to_commit()?;
        let short = &commit.id().to_string()[..7];
        let summary = commit.summary().unwrap_or("").chars().take(50).collect::<String>();
        format!("WIP on {}: {} {}", branch, short, summary)
    } else {
        message
    };

    repo.stash_save(&sig, &msg, Some(git2::StashFlags::DEFAULT))?;
    Ok(())
}

/// Return all stash entries, newest first (index 0 = most recent).
#[tauri::command]
pub fn list_stashes(repo_id: String, state: State<RepoState>) -> Result<Vec<StashEntry>> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut stashes: Vec<StashEntry> = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        stashes.push(StashEntry {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })?;
    Ok(stashes)
}

/// Apply the stash at `index` and remove it from the stash list.
#[tauri::command]
pub fn pop_stash(repo_id: String, index: usize, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    repo.stash_apply(index, None)?;
    repo.stash_drop(index)?;
    Ok(())
}

/// Apply the stash at `index` but keep it in the stash list.
#[tauri::command]
pub fn apply_stash(repo_id: String, index: usize, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    repo.stash_apply(index, None)?;
    Ok(())
}

/// Remove the stash at `index` without applying it.
#[tauri::command]
pub fn drop_stash(repo_id: String, index: usize, state: State<RepoState>) -> Result<()> {
    let mut repos = state.0.lock().unwrap();
    let repo = repos.get_mut(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    repo.stash_drop(index)?;
    Ok(())
}

/// Rename the stash at `index` by rewriting its message in the refs/stash reflog.
/// Git has no native stash-rename, so we edit the reflog entry's message in place
/// (preserving the stash's oids, order, and index).
#[tauri::command]
pub fn rename_stash(repo_id: String, index: usize, message: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let new_message = message.trim();
    if new_message.is_empty() {
        return Err(Error::InvalidArg("Stash name cannot be empty.".into()));
    }
    if new_message.contains('\n') {
        return Err(Error::InvalidArg("Stash name cannot contain newlines.".into()));
    }

    // The reflog file is chronological (oldest first); stash@{0} is the last line.
    // Use the common dir (not repo.path()) so this also works in linked worktrees,
    // where refs/stash lives in the shared git directory.
    let path = repo.commondir().join("logs").join("refs").join("stash");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| Error::InvalidArg(format!("Cannot read stash reflog: {}", e)))?;

    let mut lines: Vec<String> = content.lines().map(|l| l.to_owned()).collect();
    let target = lines
        .len()
        .checked_sub(index + 1)
        .ok_or_else(|| Error::InvalidArg(format!("No stash at index {}", index)))?;

    // Each line is "<old> <new> <name> <email> <time> <tz>\t<message>".
    let tab = lines[target]
        .find('\t')
        .ok_or_else(|| Error::InvalidArg("Malformed stash reflog entry.".into()))?;
    lines[target] = format!("{}\t{}", &lines[target][..tab], new_message);

    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(&path, out)
        .map_err(|e| Error::InvalidArg(format!("Cannot write stash reflog: {}", e)))?;
    Ok(())
}
