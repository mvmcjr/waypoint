use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct PullResult {
    /// "up_to_date" | "fast_forward" | "merged" | "conflicts"
    pub kind: String,
    pub conflicted: Vec<String>,
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(std::path::PathBuf::from)
}

fn make_callbacks<'a>() -> git2::RemoteCallbacks<'a> {
    let mut tried_agent = false;
    let mut tried_ssh_key = false;
    let mut tried_helper = false;

    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.credentials(move |url, username_from_url, allowed| {
        if allowed.contains(git2::CredentialType::SSH_KEY) && !tried_agent {
            tried_agent = true;
            if let Some(username) = username_from_url {
                if let Ok(cred) = git2::Cred::ssh_key_from_agent(username) {
                    return Ok(cred);
                }
            }
        }

        if allowed.contains(git2::CredentialType::SSH_KEY) && !tried_ssh_key {
            tried_ssh_key = true;
            if let Some(username) = username_from_url {
                if let Some(home) = home_dir() {
                    for key_name in &["id_ed25519", "id_rsa", "id_ecdsa"] {
                        let path = home.join(".ssh").join(key_name);
                        if path.exists() {
                            if let Ok(cred) = git2::Cred::ssh_key(username, None, &path, None) {
                                return Ok(cred);
                            }
                        }
                    }
                }
            }
        }

        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) && !tried_helper {
            tried_helper = true;
            if let Ok(cfg) = git2::Config::open_default() {
                if let Ok(cred) = git2::Cred::credential_helper(&cfg, url, username_from_url) {
                    return Ok(cred);
                }
            }
        }

        Err(git2::Error::from_str(
            "authentication failed: no credentials available (tried SSH agent, key files, and credential helper)",
        ))
    });
    callbacks
}

#[tauri::command]
pub fn list_remotes(repo_id: String, state: State<RepoState>) -> Result<Vec<RemoteInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let names = repo.remotes()?;
    let mut result = Vec::new();
    for name_opt in names.iter() {
        if let Some(name) = name_opt {
            let remote = repo.find_remote(name)?;
            result.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().unwrap_or("").to_string(),
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn fetch_remote(
    repo_id: String,
    remote_name: String,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|_| Error::InvalidArg(format!("remote '{}' not found", remote_name)))?;

    let callbacks = make_callbacks();
    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(callbacks);
    opts.download_tags(git2::AutotagOption::Unspecified);

    remote.fetch(&[] as &[&str], Some(&mut opts), None)?;
    Ok(())
}

#[tauri::command]
pub fn push_branch(
    repo_id: String,
    remote_name: String,
    branch_name: String,
    force: bool,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|_| Error::InvalidArg(format!("remote '{}' not found", remote_name)))?;

    let prefix = if force { "+" } else { "" };
    let refspec = format!("{}refs/heads/{}:refs/heads/{}", prefix, branch_name, branch_name);

    let mut callbacks = make_callbacks();
    callbacks.push_update_reference(|_refname, status| {
        if let Some(msg) = status {
            return Err(git2::Error::from_str(msg));
        }
        Ok(())
    });

    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(callbacks);

    remote.push(&[refspec.as_str()], Some(&mut opts))?;
    Ok(())
}

/// Push a local tag to a remote.
#[tauri::command]
pub fn push_tag(
    repo_id: String,
    remote_name: String,
    tag_name: String,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|_| Error::InvalidArg(format!("remote '{}' not found", remote_name)))?;

    let refspec = format!("refs/tags/{}:refs/tags/{}", tag_name, tag_name);

    let mut callbacks = make_callbacks();
    callbacks.push_update_reference(|_refname, status| {
        if let Some(msg) = status {
            return Err(git2::Error::from_str(msg));
        }
        Ok(())
    });

    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(callbacks);
    remote.push(&[refspec.as_str()], Some(&mut opts))?;
    Ok(())
}

/// Delete a tag from a remote (empty-source refspec).
#[tauri::command]
pub fn delete_remote_tag(
    repo_id: String,
    remote_name: String,
    tag_name: String,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|_| Error::InvalidArg(format!("remote '{}' not found", remote_name)))?;

    let refspec = format!(":refs/tags/{}", tag_name);

    let mut callbacks = make_callbacks();
    callbacks.push_update_reference(|_refname, status| {
        if let Some(msg) = status {
            return Err(git2::Error::from_str(msg));
        }
        Ok(())
    });

    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(callbacks);
    remote.push(&[refspec.as_str()], Some(&mut opts))?;
    Ok(())
}

#[tauri::command]
pub fn pull_branch(
    repo_id: String,
    remote_name: String,
    state: State<RepoState>,
) -> Result<PullResult> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    // Require a named branch (not detached HEAD).
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot pull: HEAD is detached. Checkout a branch first.".into(),
        ));
    }
    let branch_name = head
        .shorthand()
        .ok_or_else(|| Error::InvalidArg("Cannot determine current branch name.".into()))?
        .to_string();

    // Fetch the specific branch from the remote.
    {
        let mut remote = repo
            .find_remote(&remote_name)
            .map_err(|_| Error::InvalidArg(format!("remote '{}' not found", remote_name)))?;
        let callbacks = make_callbacks();
        let mut opts = git2::FetchOptions::new();
        opts.remote_callbacks(callbacks);
        remote.fetch(&[branch_name.as_str()], Some(&mut opts), None)?;
    }

    // Locate the tracking ref written by the fetch.
    let tracking_ref_name = format!("refs/remotes/{}/{}", remote_name, branch_name);
    let tracking_oid = repo
        .find_reference(&tracking_ref_name)
        .map_err(|_| {
            Error::InvalidArg(format!(
                "no tracking branch '{}' — push the branch to the remote first",
                tracking_ref_name
            ))
        })?
        .target()
        .ok_or_else(|| Error::InvalidArg("tracking ref has no target".into()))?;

    let annotated = repo.find_annotated_commit(tracking_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(PullResult { kind: "up_to_date".into(), conflicted: vec![] });
    }

    if analysis.is_fast_forward() {
        let refname = format!("refs/heads/{}", branch_name);
        repo.find_reference(&refname)?
            .set_target(tracking_oid, "pull: Fast-forward")?;
        repo.set_head(&refname)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
        return Ok(PullResult { kind: "fast_forward".into(), conflicted: vec![] });
    }

    // Normal merge.
    repo.merge(&[&annotated], None, None)?;
    let mut index = repo.index()?;
    index.write()?;

    if index.has_conflicts() {
        let mut conflicted = Vec::new();
        for entry in index.conflicts()? {
            let c = entry?;
            let path = c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path).into_owned())
                .unwrap_or_default();
            if !path.is_empty() {
                conflicted.push(path);
            }
        }
        let merge_msg =
            format!("Merge remote-tracking branch '{}/{}'", remote_name, branch_name);
        let git_dir = repo.path();
        std::fs::write(git_dir.join("MERGE_HEAD"), format!("{}\n", tracking_oid))
            .map_err(|e| Error::InvalidArg(e.to_string()))?;
        std::fs::write(git_dir.join("MERGE_MSG"), &merge_msg)
            .map_err(|e| Error::InvalidArg(e.to_string()))?;
        return Ok(PullResult { kind: "conflicts".into(), conflicted });
    }

    // Auto-commit the merge.
    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let other_commit = repo.find_commit(tracking_oid)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let merge_msg =
        format!("Merge remote-tracking branch '{}/{}'", remote_name, branch_name);
    repo.commit(Some("HEAD"), &sig, &sig, &merge_msg, &tree, &[&head_commit, &other_commit])?;

    let git_dir = repo.path();
    for name in &["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
        let _ = std::fs::remove_file(git_dir.join(name));
    }

    Ok(PullResult { kind: "merged".into(), conflicted: vec![] })
}
