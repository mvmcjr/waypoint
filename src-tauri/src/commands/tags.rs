use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

/// Create a lightweight or annotated tag at the given commit OID.
/// Passing a blank `message` produces a lightweight tag; a non-blank message
/// produces an annotated tag signed with the repo's default signature.
#[tauri::command]
pub fn create_tag(
    repo_id: String,
    name: String,
    oid: String,
    message: String,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let obj = repo.find_object(git_oid, None)?;

    if message.trim().is_empty() {
        repo.tag_lightweight(&name, &obj, false)?;
    } else {
        let sig = repo.signature()?;
        repo.tag(&name, &obj, &sig, message.trim(), false)?;
    }
    Ok(())
}

/// Delete a local tag by its short name (e.g. "v1.0.0").
#[tauri::command]
pub fn delete_tag(repo_id: String, name: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    repo.tag_delete(&name)?;
    Ok(())
}
