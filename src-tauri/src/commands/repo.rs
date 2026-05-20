use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct RefInfo {
    pub name: String,
    pub shorthand: String,
    pub kind: RefKind,
    pub target_oid: Option<String>,
    pub is_head: bool,
    pub is_pushed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    Other,
}

#[tauri::command]
pub fn open_repo(path: String, state: State<RepoState>) -> Result<String> {
    let repo = git2::Repository::open(&path)
        .map_err(|_| Error::NotARepo(path.clone()))?;

    let id = path.clone();
    state.0.lock().unwrap().insert(id.clone(), repo);
    Ok(id)
}

#[tauri::command]
pub fn list_refs(repo_id: String, state: State<RepoState>) -> Result<Vec<RefInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head_oid = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
    let head_ref = repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_owned()));

    // Collect all remote branch targets to check reachability offline
    let mut remote_oids = Vec::new();
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            if let Some(name) = reference.name() {
                if name.starts_with("refs/remotes/") {
                    if let Ok(commit) = reference.peel_to_commit() {
                        remote_oids.push(commit.id());
                    }
                }
            }
        }
    }

    let mut refs: Vec<RefInfo> = Vec::new();

    for reference in repo.references()? {
        let reference = reference?;
        let name = reference.name().unwrap_or("").to_owned();
        let shorthand = reference.shorthand().unwrap_or("").to_owned();

        let target_oid = match reference.kind() {
            Some(git2::ReferenceType::Direct) => reference.target().map(|o| o.to_string()),
            Some(git2::ReferenceType::Symbolic) => {
                reference.resolve().ok().and_then(|r| r.target()).map(|o| o.to_string())
            }
            None => None,
        };

        let kind = if name.starts_with("refs/heads/") {
            RefKind::LocalBranch
        } else if name.starts_with("refs/remotes/") {
            RefKind::RemoteBranch
        } else if name.starts_with("refs/tags/") {
            RefKind::Tag
        } else {
            RefKind::Other
        };

        let is_head = head_ref.as_deref() == Some(&shorthand)
            || target_oid.as_deref() == head_oid.as_deref();

        // Determine if reference commit has been pushed to a remote
        let mut is_pushed = false;
        if let Ok(commit) = reference.peel_to_commit() {
            let commit_oid = commit.id();
            if name.starts_with("refs/remotes/") {
                is_pushed = true;
            } else {
                for remote_oid in &remote_oids {
                    if let Ok(is_descendant) = repo.graph_descendant_of(*remote_oid, commit_oid) {
                        if is_descendant {
                            is_pushed = true;
                            break;
                        }
                    }
                }
            }
        }

        refs.push(RefInfo { name, shorthand, kind, target_oid, is_head, is_pushed });
    }

    Ok(refs)
}
