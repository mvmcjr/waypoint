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

/// A branch's configured upstream: the remote and the branch name on it.
struct Upstream {
    remote: String,
    branch: String,
}

/// The configured upstream of local `branch_name`, if it tracks a branch
/// (`refs/heads/*`) on a remote. Anything else reads as "no upstream".
fn branch_upstream(repo: &git2::Repository, branch_name: &str) -> Option<Upstream> {
    let local_ref = format!("refs/heads/{}", branch_name);
    let remote = repo.branch_upstream_remote(&local_ref).ok()?;
    let merge = repo.branch_upstream_merge(&local_ref).ok()?;
    let branch = merge.as_str().ok()?.strip_prefix("refs/heads/")?;
    Some(Upstream { remote: remote.as_str().ok()?.to_owned(), branch: branch.to_owned() })
}

fn remote_names(repo: &git2::Repository) -> Vec<String> {
    repo.remotes()
        .map(|r| r.iter().flatten().flatten().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Repo state one branch's pull/push resolution reads, gathered once so the
/// pure chooser functions below don't each re-enumerate remotes, re-snapshot
/// config or re-look-up the upstream.
struct BranchCtx {
    remotes: Vec<String>,
    upstream: Option<Upstream>,
    /// Whether the branch has any upstream configured at all (even one that
    /// isn't a `refs/heads/*` branch, which `upstream` reads as `None`).
    tracks_something: bool,
    /// `branch.<name>.pushRemote`, if set to an existing remote.
    push_remote: Option<String>,
    /// `remote.pushDefault`, if set to an existing remote.
    push_default_remote: Option<String>,
    /// `push.default` is `upstream`/`tracking`.
    push_follows_upstream: bool,
}

impl BranchCtx {
    fn load(repo: &git2::Repository, branch_name: &str) -> Self {
        let remotes = remote_names(repo);
        let cfg = repo.config().ok();
        let get = |key: String| cfg.as_ref().and_then(|c| c.get_string(&key).ok()).map(|v| v.trim().to_owned());
        let existing = |key: String| get(key).filter(|v| remotes.contains(v));
        let local_ref = format!("refs/heads/{}", branch_name);
        BranchCtx {
            upstream: branch_upstream(repo, branch_name),
            tracks_something: repo.branch_upstream_remote(&local_ref).is_ok(),
            push_remote: existing(format!("branch.{}.pushRemote", branch_name)),
            push_default_remote: existing("remote.pushDefault".to_owned()),
            push_follows_upstream: get("push.default".to_owned())
                .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "upstream" | "tracking")),
            remotes,
        }
    }
}

/// The remote a pull uses: the branch's upstream remote when it still exists,
/// else "origin", else the first remote. `None` when the repo has no remotes.
fn choose_remote(ctx: &BranchCtx) -> Option<String> {
    if let Some(up) = &ctx.upstream {
        if ctx.remotes.contains(&up.remote) {
            return Some(up.remote.clone());
        }
    }
    if ctx.remotes.iter().any(|n| n == "origin") {
        return Some("origin".to_owned());
    }
    ctx.remotes.first().cloned()
}

/// The remote a push uses, following git: `requested`, else
/// `branch.<name>.pushRemote`, else `remote.pushDefault`, else the pull remote
/// (upstream remote / origin / first). Configured names of missing remotes are
/// ignored.
fn choose_push_remote(ctx: &BranchCtx, requested: Option<&str>) -> Option<String> {
    if let Some(r) = requested {
        return Some(r.to_owned());
    }
    ctx.push_remote.clone().or_else(|| ctx.push_default_remote.clone()).or_else(|| choose_remote(ctx))
}

/// The pull source shown in the UI. `branch` is `None` when the branch's
/// configured upstream on `remote` can't be pulled (the pull itself reports why).
#[derive(Debug, Serialize)]
pub struct SyncTarget {
    pub remote: String,
    pub branch: Option<String>,
}

/// Where a push of a local branch goes. `branch` is the destination name.
#[derive(Debug, Serialize)]
pub struct PushTarget {
    pub remote: String,
    pub branch: String,
    /// First push of a branch with no upstream: record one (`--set-upstream`).
    pub set_upstream: bool,
}

/// Everything the UI needs to label pull/push for a branch. Either side is
/// `None` when the repo has no remote to use.
#[derive(Debug, Serialize)]
pub struct SyncTargets {
    pub pull: Option<SyncTarget>,
    pub push: Option<PushTarget>,
}

/// Mirrors git's `push.default`: with `upstream`/`tracking` and the upstream on
/// the push remote the push goes to the upstream branch; otherwise (unset,
/// `simple`, `current`, ...) to the SAME-named branch — never onto a
/// differently-named upstream, so a `feature` made from `origin/main` can't
/// overwrite `main`. A branch with no upstream at all gets `--set-upstream`.
fn resolve_push_target(ctx: &BranchCtx, remote: Option<&str>, branch_name: &str) -> Option<PushTarget> {
    let remote = choose_push_remote(ctx, remote)?;
    let branch = match &ctx.upstream {
        Some(up) if ctx.push_follows_upstream && up.remote == remote => up.branch.clone(),
        _ => branch_name.to_owned(),
    };
    let set_upstream = ctx.upstream.is_none() && !ctx.tracks_something;
    Some(PushTarget { remote, branch, set_upstream })
}

/// Pull label for `branch_name`, derived from the same resolver the pull uses
/// so the two can't disagree.
fn resolve_pull_target(repo: &git2::Repository, ctx: &BranchCtx, branch_name: &str) -> Option<SyncTarget> {
    let remote = choose_remote(ctx)?;
    let branch = resolve_pull_source(repo, &remote, branch_name).ok().map(|(b, _)| b);
    Some(SyncTarget { remote, branch })
}

fn sync_targets(repo: &git2::Repository, branch_name: &str) -> SyncTargets {
    let ctx = BranchCtx::load(repo, branch_name);
    SyncTargets {
        pull: resolve_pull_target(repo, &ctx, branch_name),
        push: resolve_push_target(&ctx, None, branch_name),
    }
}

#[tauri::command]
pub fn get_sync_targets(
    repo_id: String,
    branch_name: String,
    state: State<'_, RepoState>,
) -> Result<SyncTargets> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    Ok(sync_targets(repo, &branch_name))
}

/// Arguments for `git push` of `branch_name` to `target`. Full ref names on both
/// sides: a bare name could resolve to a same-named tag.
fn push_args(target: &PushTarget, branch_name: &str, force: bool) -> Vec<String> {
    let mut args = vec!["push".to_owned()];
    if force {
        args.push("--force".into());
    }
    if target.set_upstream {
        args.push("--set-upstream".into());
    }
    args.push(target.remote.clone());
    args.push(format!("refs/heads/{}:refs/heads/{}", branch_name, target.branch));
    args
}

/// The push target for a `push_branch` call: the caller's already-resolved
/// `destination` used verbatim (what the UI showed is what gets pushed), or,
/// when absent, resolved from config (for `remote` if given, else pushRemote /
/// push.default / the pull remote). A destination without a remote is
/// meaningless and is resolved instead.
fn explicit_or_resolved_push_target(
    repo: &git2::Repository,
    remote: Option<&str>,
    branch_name: &str,
    destination: Option<String>,
    set_upstream: Option<bool>,
) -> Option<PushTarget> {
    match (remote, destination) {
        (Some(remote), Some(branch)) => Some(PushTarget {
            remote: remote.to_owned(),
            branch,
            set_upstream: set_upstream.unwrap_or(false),
        }),
        (remote, _) => resolve_push_target(&BranchCtx::load(repo, branch_name), remote, branch_name),
    }
}

#[tauri::command]
pub async fn push_branch(
    repo_id: String,
    remote_name: Option<String>,
    branch_name: String,
    force: bool,
    destination: Option<String>,
    set_upstream: Option<bool>,
    state: State<'_, RepoState>,
) -> Result<()> {
    // Compute args and release the lock before the async network call.
    let (args, workdir) = {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let target = explicit_or_resolved_push_target(repo, remote_name.as_deref(), &branch_name, destination, set_upstream)
            .ok_or_else(|| Error::InvalidArg("no remote to push to".into()))?;
        (push_args(&target, &branch_name, force), crate::repo::workdir(repo)?)
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
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
/// same-named branch on `remote_name`. An upstream on `remote_name` that can't
/// be resolved is an error rather than a fallback, which would silently merge
/// a different branch than the one configured.
fn resolve_pull_source(repo: &git2::Repository, remote_name: &str, branch_name: &str) -> Result<(String, String)> {
    let local_ref = format!("refs/heads/{}", branch_name);
    let Some(up) = branch_upstream(repo, branch_name).filter(|u| u.remote == remote_name) else {
        // Tracking something that isn't a branch (e.g. refs/tags/*) on this
        // remote can't be followed — error rather than guess a same-named branch.
        let tracks_here = repo.branch_upstream_remote(&local_ref).ok().is_some_and(|r| r.as_str().ok() == Some(remote_name));
        if tracks_here {
            let merge = repo.branch_upstream_merge(&local_ref)?;
            return Err(Error::InvalidArg(format!(
                "'{}' tracks '{}', which is not a branch on {}.",
                branch_name,
                merge.as_str()?,
                remote_name
            )));
        }
        return Ok((branch_name.to_owned(), format!("refs/remotes/{}/{}", remote_name, branch_name)));
    };
    let tracking_ref = repo.branch_upstream_name(&local_ref).map_err(|_| {
        Error::InvalidArg(format!(
            "'{}' tracks {}/{}, but no fetch refspec maps it to a remote-tracking branch.",
            branch_name, remote_name, up.branch
        ))
    })?;
    Ok((up.branch, tracking_ref.as_str()?.to_owned()))
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
        let (remote_branch, tracking_ref_name) = resolve_pull_source(repo, &remote_name, &branch_name)?;
        (branch_name, remote_branch, tracking_ref_name, crate::repo::workdir(repo)?)
    }; // MutexGuard dropped here — safe to .await below

    // Full ref name: a bare branch name lets git DWIM it to a same-named tag.
    let fetch_ref = format!("refs/heads/{}", remote_branch);
    run_git(&workdir, &["fetch", &remote_name, &fetch_ref]).await?;

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
    use crate::repo::test_support::make_temp_dir;
    use git2::Repository;
    use std::path::PathBuf;

    fn make_repo() -> (PathBuf, Repository) {
        let dir = make_temp_dir("remote");
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

    fn src(branch: &str, tracking: &str) -> (String, String) {
        (branch.to_owned(), tracking.to_owned())
    }

    /// Local `main` tracking `origin/master`: pull must fetch `master` and
    /// merge `refs/remotes/origin/master`, not look for an `origin/main`.
    #[test]
    fn pull_uses_the_configured_upstream_when_names_differ() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        let got = resolve_pull_source(&repo, "origin", "main").unwrap();
        assert_eq!(got, src("master", "refs/remotes/origin/master"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_keeps_nested_upstream_branch_names() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feat", "origin", "refs/heads/feature/x");
        let got = resolve_pull_source(&repo, "origin", "feat").unwrap();
        assert_eq!(got, src("feature/x", "refs/remotes/origin/feature/x"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_falls_back_to_same_name_without_upstream() {
        let (dir, repo) = make_repo();
        let got = resolve_pull_source(&repo, "origin", "main").unwrap();
        assert_eq!(got, src("main", "refs/remotes/origin/main"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Pulling from a remote other than the branch's upstream remote: the
    /// upstream config doesn't apply, so use the same-named branch there.
    #[test]
    fn pull_from_another_remote_ignores_the_upstream() {
        let (dir, repo) = make_repo();
        repo.remote("fork", "https://example.invalid/fork.git").unwrap();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        let got = resolve_pull_source(&repo, "fork", "main").unwrap();
        assert_eq!(got, src("main", "refs/remotes/fork/main"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An upstream on this remote that no fetch refspec maps to a tracking ref
    /// (single-branch clone tracking another branch) must be an error — falling
    /// back to the same-named branch would merge the wrong branch silently.
    #[test]
    fn pull_errors_when_the_configured_upstream_has_no_tracking_ref() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        repo.remote_with_fetch(
            "origin",
            "https://example.invalid/repo.git",
            "+refs/heads/main:refs/remotes/origin/main",
        )
        .unwrap();
        set_upstream(&repo, "main", "origin", "refs/heads/release");
        let err = resolve_pull_source(&repo, "origin", "main").unwrap_err();
        assert!(err.to_string().contains("origin/release"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn set_push_default(repo: &Repository, value: &str) {
        repo.config().unwrap().set_str("push.default", value).unwrap();
    }

    /// Resolve the push target for `remote` (or the default) and build its args.
    fn push(repo: &Repository, remote: Option<&str>, branch: &str, force: bool) -> (PushTarget, Vec<String>) {
        let target = resolve_push_target(&BranchCtx::load(repo, branch), remote, branch).unwrap();
        let a = push_args(&target, branch, force);
        (target, a)
    }

    /// `git switch -c feature origin/main`: tracks main, but must NOT push onto it.
    #[test]
    fn push_never_targets_a_differently_named_upstream_by_default() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/main");
        let (t, a) = push(&repo, None, "feature", false);
        assert_eq!(t.branch, "feature");
        assert_eq!(t.remote, "origin");
        assert!(!t.set_upstream);
        assert_eq!(a, args(&["push", "origin", "refs/heads/feature:refs/heads/feature"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_default_upstream_follows_the_upstream_branch_name() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/main");
        set_push_default(&repo, "upstream");
        let (t, a) = push(&repo, None, "feature", false);
        assert_eq!(t.branch, "main");
        assert_eq!(a, args(&["push", "origin", "refs/heads/feature:refs/heads/main"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_default_simple_and_current_use_the_same_name_tracking_uses_upstream() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        for (value, want) in [("simple", "main"), ("current", "main"), ("matching", "main"), ("tracking", "master"), ("UPSTREAM", "master")] {
            set_push_default(&repo, value);
            assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), None, "main").unwrap().branch, want, "push.default={value}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_default_upstream_ignored_when_upstream_is_on_another_remote() {
        let (dir, repo) = make_repo();
        repo.remote("fork", "https://example.invalid/fork.git").unwrap();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        set_push_default(&repo, "upstream");
        let (t, a) = push(&repo, Some("fork"), "main", false);
        assert_eq!(t.branch, "main");
        assert!(!t.set_upstream);
        assert_eq!(a, args(&["push", "fork", "refs/heads/main:refs/heads/main"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_without_upstream_sets_it_with_the_same_name() {
        let (dir, repo) = make_repo();
        let (t, a) = push(&repo, None, "main", false);
        assert!(t.set_upstream);
        assert_eq!(a, args(&["push", "--set-upstream", "origin", "refs/heads/main:refs/heads/main"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_force_flag_is_kept() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/main");
        let (_, a) = push(&repo, None, "main", true);
        assert_eq!(a, args(&["push", "--force", "origin", "refs/heads/main:refs/heads/main"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remote_choice_prefers_upstream_remote_then_origin_then_first() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        repo.remote("zeta", "https://example.invalid/z.git").unwrap();
        repo.remote("fork", "https://example.invalid/f.git").unwrap();
        // No origin, no upstream: first remote (libgit2 lists them sorted).
        assert_eq!(choose_remote(&BranchCtx::load(&repo, "main")).as_deref(), Some("fork"));
        set_upstream(&repo, "main", "zeta", "refs/heads/main");
        assert_eq!(choose_remote(&BranchCtx::load(&repo, "main")).as_deref(), Some("zeta"));
        // Upstream remote that no longer exists is ignored.
        set_upstream(&repo, "main", "gone", "refs/heads/main");
        assert_eq!(choose_remote(&BranchCtx::load(&repo, "main")).as_deref(), Some("fork"));
        repo.remote("origin", "https://example.invalid/o.git").unwrap();
        assert_eq!(choose_remote(&BranchCtx::load(&repo, "main")).as_deref(), Some("origin"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn set_cfg(repo: &Repository, key: &str, value: &str) {
        repo.config().unwrap().set_str(key, value).unwrap();
    }

    fn two_remote_repo() -> (PathBuf, Repository) {
        let (dir, repo) = make_repo();
        repo.remote("fork", "https://example.invalid/fork.git").unwrap();
        (dir, repo)
    }

    #[test]
    fn push_remote_config_wins_and_keeps_the_same_branch_name() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        set_cfg(&repo, "branch.main.pushRemote", "fork");
        set_push_default(&repo, "upstream");
        let t = resolve_push_target(&BranchCtx::load(&repo, "main"), None, "main").unwrap();
        // Upstream is on origin, push goes to fork: upstream name does not apply.
        assert_eq!((t.remote.as_str(), t.branch.as_str()), ("fork", "main"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remote_push_default_is_used_when_no_push_remote() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/main");
        set_cfg(&repo, "remote.pushDefault", "fork");
        let t = resolve_push_target(&BranchCtx::load(&repo, "main"), None, "main").unwrap();
        assert_eq!(t.remote, "fork");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_remote_beats_remote_push_default() {
        let (dir, repo) = two_remote_repo();
        repo.remote("third", "https://example.invalid/t.git").unwrap();
        set_cfg(&repo, "remote.pushDefault", "fork");
        set_cfg(&repo, "branch.main.pushRemote", "third");
        assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), None, "main").unwrap().remote, "third");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_remote_overrides_push_remote_and_push_default() {
        let (dir, repo) = two_remote_repo();
        set_cfg(&repo, "remote.pushDefault", "fork");
        set_cfg(&repo, "branch.main.pushRemote", "fork");
        assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), Some("origin"), "main").unwrap().remote, "origin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_remote_naming_a_missing_remote_is_ignored() {
        let (dir, repo) = make_repo();
        set_cfg(&repo, "branch.main.pushRemote", "gone");
        set_cfg(&repo, "remote.pushDefault", "gone");
        assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), None, "main").unwrap().remote, "origin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_ignores_push_remote_and_uses_the_upstream_remote() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/main");
        set_cfg(&repo, "branch.main.pushRemote", "fork");
        let t = sync_targets(&repo, "main");
        assert_eq!(t.pull.unwrap().remote, "origin");
        assert_eq!(t.push.unwrap().remote, "fork");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_label_does_not_claim_a_branch_when_upstream_is_not_a_branch() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/tags/v1");
        let pull = sync_targets(&repo, "main").pull.unwrap();
        assert_eq!(pull.remote, "origin");
        assert_eq!(pull.branch, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_destination_is_used_verbatim_ignoring_config() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/other");
        set_push_default(&repo, "upstream");
        let t = explicit_or_resolved_push_target(&repo, Some("fork"), "feature", Some("dest".into()), Some(true)).unwrap();
        assert_eq!((t.remote.as_str(), t.branch.as_str(), t.set_upstream), ("fork", "dest", true));
        assert_eq!(
            push_args(&t, "feature", true),
            args(&["push", "--force", "--set-upstream", "fork", "refs/heads/feature:refs/heads/dest"])
        );
        // No destination: resolve from config like the plugin API does.
        let r = explicit_or_resolved_push_target(&repo, Some("origin"), "feature", None, None).unwrap();
        assert_eq!((r.remote.as_str(), r.branch.as_str()), ("origin", "other"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn no_remote_and_no_destination_resolves_via_push_remote_and_sets_upstream() {
        let (dir, repo) = two_remote_repo();
        set_cfg(&repo, "branch.feature.pushRemote", "fork");
        let t = explicit_or_resolved_push_target(&repo, None, "feature", None, None).unwrap();
        assert_eq!((t.remote.as_str(), t.branch.as_str(), t.set_upstream), ("fork", "feature", true));
        // A destination alone (no remote) is not trusted: resolved like above.
        let t = explicit_or_resolved_push_target(&repo, None, "feature", Some("elsewhere".into()), None).unwrap();
        assert_eq!((t.remote.as_str(), t.branch.as_str()), ("fork", "feature"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_targets_pull_follows_upstream_push_follows_push_default() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/main");
        let t = sync_targets(&repo, "feature");
        let pull = t.pull.unwrap();
        assert_eq!((pull.remote.as_str(), pull.branch.as_deref()), ("origin", Some("main")));
        let push = t.push.unwrap();
        assert_eq!((push.remote.as_str(), push.branch.as_str(), push.set_upstream), ("origin", "feature", false));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_targets_without_remotes_are_none() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        let t = sync_targets(&repo, "main");
        assert!(t.pull.is_none() && t.push.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_targets_without_upstream_use_the_same_name() {
        let (dir, repo) = make_repo();
        let t = sync_targets(&repo, "main");
        let pull = t.pull.unwrap();
        assert_eq!((pull.remote.as_str(), pull.branch.as_deref()), ("origin", Some("main")));
        assert!(t.push.unwrap().set_upstream);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn branch_upstream_configured() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        let got = branch_upstream(&repo, "main").unwrap();
        assert_eq!(got.remote, "origin");
        assert_eq!(got.branch, "master");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn branch_upstream_none_when_unset() {
        let (dir, repo) = make_repo();
        assert!(branch_upstream(&repo, "main").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn branch_upstream_none_for_non_branch_merge_ref() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/tags/v1");
        assert!(branch_upstream(&repo, "main").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
