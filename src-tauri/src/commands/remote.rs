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

/// Shell out to the system `git` binary so that GCM / credential helpers work
/// exactly as they do in the terminal — no re-auth prompts.
///
/// Uses `tokio::process::Command` so the wait is non-blocking: the Tauri async
/// runtime can keep the UI responsive while git is running over the network.
async fn run_git(workdir: &std::path::Path, args: &[&str]) -> Result<()> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(workdir)
        .args(args);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output()
        .await
        .map_err(|e| Error::InvalidArg(format!("failed to run git: {}", e)))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let msg = if !stderr.trim().is_empty() {
        stderr
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    Err(Error::InvalidArg(msg.trim().to_string()))
}

fn get_workdir(state: &State<'_, RepoState>, repo_id: &str) -> Result<std::path::PathBuf> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.to_string()))?;
    crate::repo::workdir(repo)
}

#[tauri::command]
pub fn list_remotes(repo_id: String, state: State<'_, RepoState>) -> Result<Vec<RemoteInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let names = repo.remotes()?;
    let mut result = Vec::new();
    for name_opt in names.iter() {
        if let Ok(Some(name)) = name_opt {
            // Skip a remote whose config can't be read rather than failing the whole
            // list — one broken entry shouldn't hide Fetch/Pull/Push for the others.
            let Ok(remote) = repo.find_remote(name) else { continue };
            result.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().unwrap_or("").to_string(),
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn fetch_remote(
    repo_id: String,
    remote_name: String,
    state: State<'_, RepoState>,
) -> Result<()> {
    run_git(&get_workdir(&state, &repo_id)?, &["fetch", &remote_name]).await
}

#[tauri::command]
pub async fn push_branch(
    repo_id: String,
    remote_name: String,
    branch_name: String,
    force: bool,
    state: State<'_, RepoState>,
) -> Result<()> {
    let workdir = get_workdir(&state, &repo_id)?;
    let mut args: Vec<&str> = vec!["push"];
    if force {
        args.push("--force");
    }
    args.push(&remote_name);
    args.push(&branch_name);
    run_git(&workdir, &args).await
}

/// Push a local tag to a remote.
#[tauri::command]
pub async fn push_tag(
    repo_id: String,
    remote_name: String,
    tag_name: String,
    state: State<'_, RepoState>,
) -> Result<()> {
    let refspec = format!("refs/tags/{}:refs/tags/{}", tag_name, tag_name);
    run_git(&get_workdir(&state, &repo_id)?, &["push", &remote_name, &refspec]).await
}

/// Delete a tag from a remote (empty-source refspec).
#[tauri::command]
pub async fn delete_remote_tag(
    repo_id: String,
    remote_name: String,
    tag_name: String,
    state: State<'_, RepoState>,
) -> Result<()> {
    let refspec = format!(":refs/tags/{}", tag_name);
    run_git(&get_workdir(&state, &repo_id)?, &["push", &remote_name, &refspec]).await
}

/// Rename a branch on a remote. Assumes the local branch was already renamed to
/// `new_name`. Creates the new branch on the remote (setting upstream), then
/// deletes the old one. New-then-delete order keeps the old branch intact if the
/// push of the new name fails.
#[tauri::command]
pub async fn rename_remote_branch(
    repo_id: String,
    remote_name: String,
    old_name: String,
    new_name: String,
    state: State<'_, RepoState>,
) -> Result<()> {
    let workdir = get_workdir(&state, &repo_id)?;
    run_git(&workdir, &["push", "-u", &remote_name, &new_name]).await?;
    run_git(&workdir, &["push", &remote_name, "--delete", &old_name]).await?;
    Ok(())
}

/// Which remote branch to fetch for a pull of local `branch_name` from
/// `remote_name`, and the remote-tracking ref to merge afterwards. Honours the
/// branch's configured upstream (e.g. local `main` tracking `origin/master`);
/// without one — or when pulling from a different remote — falls back to the
/// same-named branch on `remote_name`.
fn resolve_pull_source(repo: &git2::Repository, remote_name: &str, branch_name: &str) -> (String, String) {
    configured_upstream(repo, remote_name, branch_name).unwrap_or_else(|| {
        (branch_name.to_owned(), format!("refs/remotes/{}/{}", remote_name, branch_name))
    })
}

fn configured_upstream(repo: &git2::Repository, remote_name: &str, branch_name: &str) -> Option<(String, String)> {
    let local_ref = format!("refs/heads/{}", branch_name);
    if repo.branch_upstream_remote(&local_ref).ok()?.as_str().ok()? != remote_name {
        return None;
    }
    let merge = repo.branch_upstream_merge(&local_ref).ok()?;
    let remote_branch = merge.as_str().ok()?.strip_prefix("refs/heads/")?.to_owned();
    let tracking_ref = repo.branch_upstream_name(&local_ref).ok()?.as_str().ok()?.to_owned();
    Some((remote_branch, tracking_ref))
}

#[tauri::command]
pub async fn pull_branch(
    repo_id: String,
    remote_name: String,
    state: State<'_, RepoState>,
) -> Result<PullResult> {
    // Get branch name and workdir, then release the lock before the async network call.
    // git2::Repository is not Sync, so we must not hold the MutexGuard across .await.
    let (branch_name, remote_branch, tracking_ref_name, workdir) = {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let head = repo.head()?;
        if !head.is_branch() {
            return Err(Error::InvalidArg(
                "Cannot pull: HEAD is detached. Checkout a branch first.".into(),
            ));
        }
        let branch_name = head.shorthand()?.to_string();
        let (remote_branch, tracking_ref_name) = resolve_pull_source(repo, &remote_name, &branch_name);
        (branch_name, remote_branch, tracking_ref_name, crate::repo::workdir(repo)?)
    }; // MutexGuard dropped here — safe to .await below

    run_git(&workdir, &["fetch", &remote_name, &remote_branch]).await?;

    // Re-acquire the lock for the merge logic (no more .await points after this).
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    // Guard against a concurrent checkout that happened while we were fetching.
    let current_head = repo.head()?;
    if !current_head.is_branch() || current_head.shorthand().ok() != Some(branch_name.as_str()) {
        return Err(Error::InvalidArg(
            "HEAD changed during fetch; checkout the intended branch and try again.".into(),
        ));
    }

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

        // Guard: refuse to fast-forward over staged changes.  checkout_head
        // with .force() would silently discard them, so we check first and
        // return a clear error instead of losing work.
        {
            let head_tree = repo.head()?.peel_to_commit()?.tree()?;
            let index = repo.index()?;
            let staged = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;
            if staged.deltas().count() > 0 {
                return Err(Error::InvalidArg(
                    "Cannot fast-forward: you have staged changes. \
                     Commit or stash them first.".into(),
                ));
            }
        }

        repo.find_reference(&refname)?
            .set_target(tracking_oid, "pull: Fast-forward")?;
        repo.set_head(&refname)?;
        // No .force() — libgit2 will protect unstaged working-tree changes
        // that would be overwritten by the fast-forward.
        repo.checkout_head(Some(&mut git2::build::CheckoutBuilder::new()))?;
        return Ok(PullResult { kind: "fast_forward".into(), conflicted: vec![] });
    }

    // Normal merge.
    repo.merge(&[&annotated], None, None)?;
    let mut index = repo.index()?;
    index.write()?;

    let merge_msg = format!("Merge remote-tracking branch '{}/{}'", remote_name, remote_branch);

    if index.has_conflicts() {
        let conflicted = crate::commands::merge::collect_conflict_paths(&index)?;
        let git_dir = repo.path();
        std::fs::write(git_dir.join("MERGE_HEAD"), format!("{}\n", tracking_oid))
            .map_err(|e| Error::InvalidArg(e.to_string()))?;
        std::fs::write(git_dir.join("MERGE_MSG"), &merge_msg)
            .map_err(|e| Error::InvalidArg(e.to_string()))?;
        return Ok(PullResult { kind: "conflicts".into(), conflicted });
    }

    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let other_commit = repo.find_commit(tracking_oid)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    repo.commit(Some("HEAD"), &sig, &sig, &merge_msg, &tree, &[&head_commit, &other_commit])?;
    crate::commands::merge::cleanup_merge_state(repo);

    Ok(PullResult { kind: "merged".into(), conflicted: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::PathBuf;

    fn make_repo() -> (PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("wpt_remote_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        // Default fetch refspec: +refs/heads/*:refs/remotes/origin/*
        repo.remote("origin", "https://example.invalid/repo.git").unwrap();
        (dir, repo)
    }

    fn set_upstream(repo: &Repository, branch: &str, remote: &str, merge: &str) {
        let mut cfg = repo.config().unwrap();
        cfg.set_str(&format!("branch.{branch}.remote"), remote).unwrap();
        cfg.set_str(&format!("branch.{branch}.merge"), merge).unwrap();
    }

    /// Local `main` tracking `origin/master`: pull must fetch `master` and
    /// merge `refs/remotes/origin/master`, not look for an `origin/main`.
    #[test]
    fn pull_uses_the_configured_upstream_when_names_differ() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        let src = resolve_pull_source(&repo, "origin", "main");
        assert_eq!(src, ("master".to_owned(), "refs/remotes/origin/master".to_owned()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_keeps_nested_upstream_branch_names() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feat", "origin", "refs/heads/feature/x");
        let src = resolve_pull_source(&repo, "origin", "feat");
        assert_eq!(src, ("feature/x".to_owned(), "refs/remotes/origin/feature/x".to_owned()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_falls_back_to_same_name_without_upstream() {
        let (dir, repo) = make_repo();
        let src = resolve_pull_source(&repo, "origin", "main");
        assert_eq!(src, ("main".to_owned(), "refs/remotes/origin/main".to_owned()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Pulling from a remote other than the branch's upstream remote: the
    /// upstream config doesn't apply, so use the same-named branch there.
    #[test]
    fn pull_from_another_remote_ignores_the_upstream() {
        let (dir, repo) = make_repo();
        repo.remote("fork", "https://example.invalid/fork.git").unwrap();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        let src = resolve_pull_source(&repo, "fork", "main");
        assert_eq!(src, ("main".to_owned(), "refs/remotes/fork/main".to_owned()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
