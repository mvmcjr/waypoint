use serde::{Deserialize, Serialize};
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
    /// The remote the pull used (chosen by the backend when the caller named none).
    pub remote: String,
    /// The branch on `remote` that was pulled.
    pub branch: String,
}

/// Result of `push_branch`. A rejected push (remote has commits we lack) is a
/// normal outcome the UI offers to force, not an error.
#[derive(Debug, Serialize)]
pub struct PushOutcome {
    /// "pushed" | "rejected"
    pub kind: String,
    pub remote: String,
    /// Destination branch name on `remote`.
    pub branch: String,
    /// git's message for a rejected push.
    pub detail: Option<String>,
    /// The push asked git to record an upstream (`--set-upstream`); a force push
    /// retrying a rejected one must keep doing so.
    pub set_upstream: bool,
}

/// Shell out to the system `git` binary so that GCM / credential helpers work
/// exactly as they do in the terminal — no re-auth prompts.
///
/// Uses `tokio::process::Command` so the wait is non-blocking: the Tauri async
/// runtime can keep the UI responsive while git is running over the network.
async fn run_git(workdir: &std::path::Path, args: &[&str]) -> Result<()> {
    run_git_env(workdir, args, &[]).await
}

/// Environment that keeps a background git from ever prompting (terminal or
/// Git Credential Manager) — it fails instead. Empty for interactive commands.
fn git_env(background: bool) -> Vec<(&'static str, &'static str)> {
    if background {
        vec![("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "Never")]
    } else {
        Vec::new()
    }
}

async fn git_output(
    workdir: &std::path::Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<std::process::Output> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(workdir).args(args).envs(env.iter().copied());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.output().await.map_err(|e| Error::InvalidArg(format!("failed to run git: {}", e)))
}

async fn run_git_env(workdir: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Result<()> {
    let output = git_output(workdir, args, env).await?;
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
    upstream_on(repo, &local_ref, remote.as_str().ok()?)
}

/// `local_ref`'s upstream branch given its already-read upstream `remote`.
fn upstream_on(repo: &git2::Repository, local_ref: &str, remote: &str) -> Option<Upstream> {
    let merge = repo.branch_upstream_merge(local_ref).ok()?;
    let branch = merge.as_str().ok()?.strip_prefix("refs/heads/")?;
    Some(Upstream { remote: remote.to_owned(), branch: branch.to_owned() })
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
    /// Whether the branch has an upstream configured on an existing remote (even
    /// one that isn't a `refs/heads/*` branch, which `upstream` reads as `None`).
    /// An upstream naming a removed remote counts as none, so a push re-binds it.
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
        let upstream_remote = repo
            .branch_upstream_remote(&local_ref)
            .ok()
            .and_then(|r| r.as_str().ok().map(str::to_owned));
        BranchCtx {
            upstream: upstream_remote.as_deref().and_then(|r| upstream_on(repo, &local_ref, r)),
            tracks_something: upstream_remote.as_ref().is_some_and(|r| remotes.contains(r)),
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
    default_remote(&ctx.remotes)
}

/// "origin" if present, else the first remote.
fn default_remote(remotes: &[String]) -> Option<String> {
    remotes.iter().find(|n| *n == "origin").or(remotes.first()).cloned()
}

/// The remote a push uses, following git: `branch.<name>.pushRemote`, else
/// `remote.pushDefault`, else the pull remote (upstream remote / origin /
/// first). Configured names of missing remotes are ignored.
fn choose_push_remote(ctx: &BranchCtx) -> Option<String> {
    ctx.push_remote.clone().or_else(|| ctx.push_default_remote.clone()).or_else(|| choose_remote(ctx))
}

/// Where a push of a local branch goes. `branch` is the destination name.
struct PushTarget {
    remote: String,
    branch: String,
    /// First push of a branch with no upstream: record one (`--set-upstream`).
    set_upstream: bool,
    /// Plugin API: the caller's argument goes to git exactly as given (`HEAD`,
    /// `a:b`, a tag...) instead of a `refs/heads/` refspec built from the branch.
    passthrough: bool,
}

/// Mirrors git's `push.default`: with `upstream`/`tracking` and the upstream on
/// the push remote the push goes to the upstream branch; otherwise (unset,
/// `simple`, `current`, ...) to the SAME-named branch — never onto a
/// differently-named upstream, so a `feature` made from `origin/main` can't
/// overwrite `main`. A first push (branch tracks nothing) records an upstream
/// only on the normal pull-side remote: with `pushRemote`/`pushDefault` pointing
/// elsewhere (triangular workflow) git records none, and pull must keep
/// following the main remote.
fn resolve_push_target(ctx: &BranchCtx, branch_name: &str) -> Option<PushTarget> {
    let remote = choose_push_remote(ctx)?;
    let branch = match &ctx.upstream {
        Some(up) if ctx.push_follows_upstream && up.remote == remote => up.branch.clone(),
        _ => branch_name.to_owned(),
    };
    let set_upstream = !ctx.tracks_something && choose_remote(ctx).as_deref() == Some(remote.as_str());
    Some(PushTarget { remote, branch, set_upstream, passthrough: false })
}

/// An explicitly requested remote (plugin API): exactly `git push <remote>
/// <arg>` — the argument is passed as-is, no push.default mapping, no upstream change.
fn explicit_push_target(remote: &str, arg: &str) -> PushTarget {
    PushTarget { remote: remote.to_owned(), branch: arg.to_owned(), set_upstream: false, passthrough: true }
}

/// Remotes a fetch should hit: the default remote (origin / first), the branch's
/// pull remote and its push remote, deduplicated in that order. The push remote
/// matters in a triangular workflow: a stale `refs/remotes/<fork>/*` hides what
/// a push would overwrite. Without a branch (detached HEAD) or for a background
/// fetch (which must not wake credential prompts for forks) just the default.
fn fetch_remote_names(repo: &git2::Repository, branch_name: Option<&str>, background: bool) -> Vec<String> {
    let ctx = BranchCtx::load(repo, branch_name.unwrap_or(""));
    let mut names: Vec<String> = default_remote(&ctx.remotes).into_iter().collect();
    if branch_name.is_some() && !background {
        for r in [choose_remote(&ctx), choose_push_remote(&ctx)].into_iter().flatten() {
            if !names.contains(&r) {
                names.push(r);
            }
        }
    }
    names
}

/// Outcome of fetching one remote in `fetch_all`.
#[derive(Debug, Serialize)]
pub struct FetchResult {
    pub remote: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Fetches each remote independently, one after another: a failing remote (say
/// an unreachable fork) must not stop the others or hide that they succeeded.
/// Sequential on purpose: concurrent `git fetch`es in one repo contend on
/// FETCH_HEAD and ref locks.
async fn fetch_remotes(workdir: &std::path::Path, names: &[String], background: bool) -> Vec<FetchResult> {
    let env = git_env(background);
    let mut results = Vec::with_capacity(names.len());
    for name in names {
        let outcome = run_git_env(workdir, &["fetch", name], &env).await;
        results.push(match outcome {
            Ok(()) => FetchResult { remote: name.clone(), ok: true, error: None },
            Err(e) => FetchResult { remote: name.clone(), ok: false, error: Some(e.to_string()) },
        });
    }
    results
}

/// Fetch the default, pull and push remotes of `branch_name` (see
/// `fetch_remote_names`) and report each remote's result. Empty when the repo
/// has no remotes. `background` (auto-fetch) hits only the default remote and
/// never prompts for credentials.
#[tauri::command]
pub async fn fetch_all(
    repo_id: String,
    branch_name: Option<String>,
    background: Option<bool>,
    state: State<'_, RepoState>,
) -> Result<Vec<FetchResult>> {
    let background = background.unwrap_or(false);
    let (names, workdir) = {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        (fetch_remote_names(repo, branch_name.as_deref(), background), crate::repo::workdir(repo)?)
    };
    Ok(fetch_remotes(&workdir, &names, background).await)
}

/// Arguments for `git push` of `branch_name` to `target`. Full ref names on both
/// sides: a bare name could resolve to a same-named tag.
fn push_args(target: &PushTarget, branch_name: &str, force: bool) -> Vec<String> {
    // --porcelain: stable per-ref status lines on stdout (see `classify_push`).
    let mut args = vec!["push".to_owned(), "--porcelain".to_owned()];
    if force {
        args.push("--force".into());
    }
    if target.set_upstream {
        args.push("--set-upstream".into());
    }
    args.push(target.remote.clone());
    if target.passthrough {
        args.push(branch_name.to_owned());
    } else {
        args.push(format!("refs/heads/{}:refs/heads/{}", branch_name, target.branch));
    }
    args
}

/// Classifies a finished `git push --porcelain`. `Ok(None)` is success;
/// `Ok(Some(detail))` is a rejection the user can override with a force push
/// (the remote has work we lack: `[rejected]` with `non-fast-forward` / `fetch
/// first`); anything else — auth/network failures, `[remote rejected]` (server
/// policy or hooks, which a force push can't fix) — is an error carrying git's
/// message. Porcelain lines are `<flag>\t<from>:<to>\t<summary> (<reason>)`.
fn classify_push(success: bool, stdout: &str, stderr: &str) -> Result<Option<String>> {
    if success {
        return Ok(None);
    }
    let failed: Vec<&str> = stdout
        .lines()
        .filter(|l| l.starts_with('!') && l.split('\t').count() >= 3)
        .collect();
    let message = |fallback: &str| {
        let e = stderr.trim();
        if e.is_empty() { fallback.trim().to_owned() } else { e.to_owned() }
    };
    let overridable = |line: &str| {
        let summary = line.split('\t').nth(2).unwrap_or("");
        summary.starts_with("[rejected]") && (summary.contains("(non-fast-forward)") || summary.contains("(fetch first)"))
    };
    if !failed.is_empty() && failed.iter().all(|l| overridable(l)) {
        return Ok(Some(message(&failed.join("\n"))));
    }
    // Keep the per-ref status in the message: stderr alone may be empty or vague.
    let detail = if failed.is_empty() { message("push failed") } else { format!("{}\n{}", message(""), failed.join("\n")).trim().to_owned() };
    Err(Error::InvalidArg(detail))
}

/// An exact push destination, as shown to the user by the push-rejected dialog.
#[derive(Debug, Deserialize)]
pub struct PushDest {
    pub remote: String,
    pub branch: String,
    /// Keep `--set-upstream` (the rejected push was a first push).
    #[serde(default)]
    pub set_upstream: bool,
}

/// The target of a push: an exact `dest` verbatim (no config, no upstream
/// change) wins, then an explicit `remote_name`, else the resolved one.
fn plan_push(
    repo: &git2::Repository,
    remote_name: Option<&str>,
    dest: Option<&PushDest>,
    branch_name: &str,
) -> Result<PushTarget> {
    if let Some(d) = dest {
        return Ok(PushTarget { remote: d.remote.clone(), branch: d.branch.clone(), set_upstream: d.set_upstream, passthrough: false });
    }
    match remote_name {
        Some(remote) => Ok(explicit_push_target(remote, branch_name)),
        None => resolve_push_target(&BranchCtx::load(repo, branch_name), branch_name)
            .ok_or_else(|| Error::InvalidArg("no remote to push to".into())),
    }
}

/// Push `branch_name`. With an exact `target` it goes there verbatim (used to
/// force-push precisely what a rejection reported). With no `remote_name` the target is resolved here
/// (pushRemote / pushDefault / push.default / upstream) and reported in the
/// outcome; an explicit remote (plugin API) gets `branch_name` passed to git as-is.
#[tauri::command]
pub async fn push_branch(
    repo_id: String,
    remote_name: Option<String>,
    branch_name: String,
    force: bool,
    target: Option<PushDest>,
    state: State<'_, RepoState>,
) -> Result<PushOutcome> {
    // Compute args and release the lock before the async network call.
    let (target, args, workdir) = {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let target = plan_push(repo, remote_name.as_deref(), target.as_ref(), &branch_name)?;
        let args = push_args(&target, &branch_name, force);
        (target, args, crate::repo::workdir(repo)?)
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = git_output(&workdir, &args, &[]).await?;
    let detail = classify_push(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )?;
    let kind = if detail.is_some() { "rejected" } else { "pushed" };
    Ok(PushOutcome {
        kind: kind.into(),
        remote: target.remote,
        branch: target.branch,
        detail,
        set_upstream: target.set_upstream,
    })
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

/// What `pull_branch` will do, resolved under the lock.
struct PullPlan {
    branch_name: String,
    remote: String,
    remote_branch: String,
    tracking_ref: String,
}

impl PullPlan {
    fn result(&self, kind: &str, conflicted: Vec<String>) -> PullResult {
        PullResult { kind: kind.into(), conflicted, remote: self.remote.clone(), branch: self.remote_branch.clone() }
    }
}

/// Pull plan for local `branch_name`: from `requested` if given, else the
/// backend's choice (`choose_remote`: upstream remote, origin, first).
fn plan_pull(repo: &git2::Repository, requested: Option<&str>, branch_name: &str) -> Result<PullPlan> {
    let remote = match requested {
        Some(r) => r.to_owned(),
        None => choose_remote(&BranchCtx::load(repo, branch_name))
            .ok_or_else(|| Error::InvalidArg("no remote to pull from".into()))?,
    };
    let (remote_branch, tracking_ref) = resolve_pull_source(repo, &remote, branch_name)?;
    Ok(PullPlan { branch_name: branch_name.to_owned(), remote, remote_branch, tracking_ref })
}

#[tauri::command]
pub async fn pull_branch(
    repo_id: String,
    remote_name: Option<String>,
    state: State<'_, RepoState>,
) -> Result<PullResult> {
    // Get branch name and workdir, then release the lock before the async network call.
    // git2::Repository is not Sync, so we must not hold the MutexGuard across .await.
    let (plan, workdir) = {
        let repos = state.0.lock().unwrap();
        let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
        let head = repo.head()?;
        if !head.is_branch() {
            return Err(Error::InvalidArg(
                "Cannot pull: HEAD is detached. Checkout a branch first.".into(),
            ));
        }
        let branch_name = head.shorthand()?.to_string();
        (plan_pull(repo, remote_name.as_deref(), &branch_name)?, crate::repo::workdir(repo)?)
    }; // MutexGuard dropped here — safe to .await below
    let (branch_name, remote_name, remote_branch, tracking_ref_name) =
        (plan.branch_name.as_str(), plan.remote.as_str(), plan.remote_branch.as_str(), plan.tracking_ref.as_str());

    // Full ref name: a bare branch name lets git DWIM it to a same-named tag.
    let fetch_ref = format!("refs/heads/{}", remote_branch);
    run_git(&workdir, &["fetch", remote_name, &fetch_ref]).await?;

    // Re-acquire the lock for the merge logic (no more .await points after this).
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    // Guard against a concurrent checkout that happened while we were fetching.
    let current_head = repo.head()?;
    if !current_head.is_branch() || current_head.shorthand().ok() != Some(branch_name) {
        return Err(Error::InvalidArg(
            "HEAD changed during fetch; checkout the intended branch and try again.".into(),
        ));
    }

    let tracking_oid = repo
        .find_reference(tracking_ref_name)
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
        return Ok(plan.result("up_to_date", vec![]));
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
        return Ok(plan.result("fast_forward", vec![]));
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
        return Ok(plan.result("conflicts", conflicted));
    }

    let sig = repo.signature()?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let other_commit = repo.find_commit(tracking_oid)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    repo.commit(Some("HEAD"), &sig, &sig, &merge_msg, &tree, &[&head_commit, &other_commit])?;
    crate::commands::merge::cleanup_merge_state(repo);

    Ok(plan.result("merged", vec![]))
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

    /// Resolve the push target and build its args.
    fn push(repo: &Repository, branch: &str, force: bool) -> (PushTarget, Vec<String>) {
        let target = resolve_push_target(&BranchCtx::load(repo, branch), branch).unwrap();
        let a = push_args(&target, branch, force);
        (target, a)
    }

    /// `git switch -c feature origin/main`: tracks main, but must NOT push onto it.
    #[test]
    fn push_never_targets_a_differently_named_upstream_by_default() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/main");
        let (t, a) = push(&repo, "feature", false);
        assert_eq!(t.branch, "feature");
        assert_eq!(t.remote, "origin");
        assert!(!t.set_upstream);
        assert_eq!(a, args(&["push", "--porcelain", "origin", "refs/heads/feature:refs/heads/feature"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_default_upstream_follows_the_upstream_branch_name() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/main");
        set_push_default(&repo, "upstream");
        let (t, a) = push(&repo, "feature", false);
        assert_eq!(t.branch, "main");
        assert_eq!(a, args(&["push", "--porcelain", "origin", "refs/heads/feature:refs/heads/main"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_default_simple_and_current_use_the_same_name_tracking_uses_upstream() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/master");
        for (value, want) in [("simple", "main"), ("current", "main"), ("matching", "main"), ("tracking", "master"), ("UPSTREAM", "master")] {
            set_push_default(&repo, value);
            assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), "main").unwrap().branch, want, "push.default={value}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_without_upstream_sets_it_with_the_same_name() {
        let (dir, repo) = make_repo();
        let (t, a) = push(&repo, "main", false);
        assert!(t.set_upstream);
        assert_eq!(a, args(&["push", "--porcelain", "--set-upstream", "origin", "refs/heads/main:refs/heads/main"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_force_flag_is_kept() {
        let (dir, repo) = make_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/main");
        let (_, a) = push(&repo, "main", true);
        assert_eq!(a, args(&["push", "--porcelain", "--force", "origin", "refs/heads/main:refs/heads/main"]));
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
        let t = resolve_push_target(&BranchCtx::load(&repo, "main"), "main").unwrap();
        // Upstream is on origin, push goes to fork: upstream name does not apply.
        assert_eq!((t.remote.as_str(), t.branch.as_str()), ("fork", "main"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remote_push_default_is_used_when_no_push_remote() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "main", "origin", "refs/heads/main");
        set_cfg(&repo, "remote.pushDefault", "fork");
        let t = resolve_push_target(&BranchCtx::load(&repo, "main"), "main").unwrap();
        assert_eq!(t.remote, "fork");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_remote_beats_remote_push_default() {
        let (dir, repo) = two_remote_repo();
        repo.remote("third", "https://example.invalid/t.git").unwrap();
        set_cfg(&repo, "remote.pushDefault", "fork");
        set_cfg(&repo, "branch.main.pushRemote", "third");
        assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), "main").unwrap().remote, "third");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_remote_naming_a_missing_remote_is_ignored() {
        let (dir, repo) = make_repo();
        set_cfg(&repo, "branch.main.pushRemote", "gone");
        set_cfg(&repo, "remote.pushDefault", "gone");
        assert_eq!(resolve_push_target(&BranchCtx::load(&repo, "main"), "main").unwrap().remote, "origin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_remote_is_a_plain_same_name_push_ignoring_config() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "feature", "origin", "refs/heads/other");
        set_push_default(&repo, "upstream");
        set_cfg(&repo, "branch.feature.pushRemote", "origin");
        let t = explicit_push_target("fork", "feature");
        assert_eq!((t.remote.as_str(), t.branch.as_str(), t.set_upstream), ("fork", "feature", false));
        assert_eq!(push_args(&t, "feature", false), args(&["push", "--porcelain", "fork", "feature"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Plugin API: whatever the plugin passed reaches git unchanged.
    #[test]
    fn explicit_remote_passes_non_branch_arguments_through() {
        let (dir, repo) = two_remote_repo();
        for arg in ["HEAD", "a:b", "v1.0", "refs/heads/x:refs/heads/y"] {
            let t = plan_push(&repo, Some("fork"), None, arg).unwrap();
            assert_eq!(push_args(&t, arg, true), args(&["push", "--porcelain", "--force", "fork", arg]));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A rejected first push keeps its --set-upstream for the dialog's force push.
    #[test]
    fn explicit_target_can_carry_set_upstream() {
        let (dir, repo) = two_remote_repo();
        let dest = PushDest { remote: "origin".into(), branch: "feature".into(), set_upstream: true };
        let t = plan_push(&repo, None, Some(&dest), "feature").unwrap();
        assert!(t.set_upstream);
        assert_eq!(
            push_args(&t, "feature", true),
            args(&["push", "--porcelain", "--force", "--set-upstream", "origin", "refs/heads/feature:refs/heads/feature"])
        );
        // And the dest is deserialised with set_upstream defaulting to false.
        let d: PushDest = serde_json::from_str(r#"{"remote":"a","branch":"b"}"#).unwrap();
        assert!(!d.set_upstream);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn outcome_of(success: bool, stdout: &str, stderr: &str) -> Result<Option<String>> {
        classify_push(success, stdout, stderr)
    }

    const NON_FF: &str = "To https://example.invalid/r.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)\nDone\n";
    const FETCH_FIRST: &str = "To https://example.invalid/r.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n";
    const HOOK: &str = "To https://example.invalid/r.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined: fetch first, non-fast-forward)\nDone\n";
    const DENY_NFF: &str = "To https://example.invalid/r.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (non-fast-forward)\nDone\n";

    #[test]
    fn porcelain_non_fast_forward_and_fetch_first_are_force_pushable() {
        for out in [NON_FF, FETCH_FIRST] {
            let got = outcome_of(false, out, "error: failed to push some refs\nhint: Updates were rejected").unwrap();
            assert!(got.is_some_and(|d| d.contains("Updates were rejected")));
        }
        // Falls back to the status line when stderr is empty.
        assert!(outcome_of(false, NON_FF, "").unwrap().is_some_and(|d| d.contains("non-fast-forward")));
    }

    #[test]
    fn porcelain_remote_rejected_is_an_error_not_force_pushable() {
        for out in [HOOK, DENY_NFF] {
            let err = outcome_of(false, out, " ! [remote rejected] main -> main (hook)").unwrap_err();
            assert!(err.to_string().contains("remote rejected"), "{err}");
        }
    }

    #[test]
    fn porcelain_success_flags_are_pushed() {
        for flag in [" ", "*", "+", "=", "-"] {
            let out = format!("To u\n{flag}\trefs/heads/main:refs/heads/main\t[new branch]\nDone\n");
            assert_eq!(outcome_of(true, &out, "").unwrap(), None, "flag {flag:?}");
        }
        assert_eq!(outcome_of(true, "To u\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\n", "").unwrap(), None);
    }

    #[test]
    fn push_failure_without_a_status_line_is_an_error() {
        let err = outcome_of(false, "", "fatal: Authentication failed for 'https://example.invalid/'").unwrap_err();
        assert!(err.to_string().contains("Authentication failed"));
        // A bare "non-fast-forward" in stderr alone no longer means rejection.
        assert!(outcome_of(false, "", "remote: hook said non-fast-forward, fetch first").is_err());
    }

    #[test]
    fn other_rejected_reasons_are_errors() {
        let out = "To u\n!\trefs/tags/v1:refs/tags/v1\t[rejected] (already exists)\nDone\n";
        assert!(outcome_of(false, out, "error: failed to push").is_err());
    }

    #[test]
    fn background_git_never_prompts() {
        let env = git_env(true);
        assert!(env.contains(&("GIT_TERMINAL_PROMPT", "0")));
        assert!(env.contains(&("GCM_INTERACTIVE", "Never")));
        assert!(git_env(false).is_empty());
    }

    #[test]
    fn background_fetch_targets_only_the_default_remote() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "main", "fork", "refs/heads/main");
        set_cfg(&repo, "branch.main.pushRemote", "fork");
        assert_eq!(fetch_remote_names(&repo, Some("main"), true), vec!["origin"]);
        assert_eq!(fetch_remote_names(&repo, Some("main"), false), vec!["origin", "fork"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_target_is_pushed_verbatim_ignoring_config() {
        let (dir, repo) = two_remote_repo();
        // Config that would redirect a resolved push elsewhere.
        set_upstream(&repo, "feature", "origin", "refs/heads/other");
        set_push_default(&repo, "upstream");
        set_cfg(&repo, "branch.feature.pushRemote", "origin");
        let dest = PushDest { remote: "fork".into(), branch: "release".into(), set_upstream: false };
        let t = plan_push(&repo, None, Some(&dest), "feature").unwrap();
        assert_eq!((t.remote.as_str(), t.branch.as_str(), t.set_upstream), ("fork", "release", false));
        assert_eq!(
            push_args(&t, "feature", true),
            args(&["push", "--porcelain", "--force", "fork", "refs/heads/feature:refs/heads/release"])
        );
        // Without a target the same config resolves differently.
        let resolved = plan_push(&repo, None, None, "feature").unwrap();
        assert_eq!(resolved.remote, "origin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn upstream_on_a_missing_remote_counts_as_tracking_nothing() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "feature", "gone", "refs/heads/feature");
        let t = resolve_push_target(&BranchCtx::load(&repo, "feature"), "feature").unwrap();
        assert_eq!((t.remote.as_str(), t.set_upstream), ("origin", true));
        // A live upstream still suppresses set-upstream.
        set_upstream(&repo, "feature2", "origin", "refs/heads/feature2");
        assert!(!resolve_push_target(&BranchCtx::load(&repo, "feature2"), "feature2").unwrap().set_upstream);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fetch_all_aggregates_per_remote_results() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        let good = make_temp_dir("remote-good");
        Repository::init_bare(&good).unwrap();
        repo.remote("origin", good.to_str().unwrap()).unwrap();
        repo.remote("broken", dir.join("does-not-exist").to_str().unwrap()).unwrap();
        let names = vec!["origin".to_owned(), "broken".to_owned()];
        let results = tauri::async_runtime::block_on(fetch_remotes(&dir, &names, false));
        assert_eq!(results.len(), 2);
        assert_eq!((results[0].remote.as_str(), results[0].ok), ("origin", true));
        assert!(results[0].error.is_none());
        assert_eq!((results[1].remote.as_str(), results[1].ok), ("broken", false));
        assert!(results[1].error.as_deref().is_some_and(|e| !e.is_empty()));
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(good);
    }

    #[test]
    fn triangular_first_push_does_not_set_upstream() {
        let (dir, repo) = two_remote_repo();
        set_cfg(&repo, "remote.pushDefault", "fork");
        let (t, a) = push(&repo, "feature", false);
        assert_eq!((t.remote.as_str(), t.set_upstream), ("fork", false));
        assert_eq!(a, args(&["push", "--porcelain", "fork", "refs/heads/feature:refs/heads/feature"]));
        set_cfg(&repo, "branch.feature2.pushRemote", "fork");
        assert!(!push(&repo, "feature2", false).0.set_upstream);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn normal_first_push_sets_upstream() {
        let (dir, repo) = two_remote_repo();
        let t = resolve_push_target(&BranchCtx::load(&repo, "feature"), "feature").unwrap();
        assert_eq!((t.remote.as_str(), t.set_upstream), ("origin", true));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn no_remotes_resolves_no_push_target() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        assert!(resolve_push_target(&BranchCtx::load(&repo, "main"), "main").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_without_a_requested_remote_uses_the_upstream_remote() {
        let (dir, repo) = two_remote_repo();
        set_upstream(&repo, "main", "fork", "refs/heads/dev");
        let plan = plan_pull(&repo, None, "main").unwrap();
        assert_eq!(plan.remote, "fork");
        assert_eq!(plan.remote_branch, "dev");
        assert_eq!(plan.tracking_ref, "refs/remotes/fork/dev");
        // An explicit remote wins over the upstream.
        assert_eq!(plan_pull(&repo, Some("origin"), "main").unwrap().remote, "origin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_without_remotes_is_an_error() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        assert!(plan_pull(&repo, None, "main").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pull_result_reports_the_remote_and_branch_used() {
        let (dir, repo) = make_repo();
        let r = plan_pull(&repo, None, "main").unwrap().result("merged", vec![]);
        assert_eq!((r.kind.as_str(), r.remote.as_str(), r.branch.as_str()), ("merged", "origin", "main"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fetch_remotes_are_default_pull_and_push_deduplicated() {
        let (dir, repo) = two_remote_repo();
        repo.remote("zeta", "https://example.invalid/z.git").unwrap();
        assert_eq!(fetch_remote_names(&repo, Some("main"), false), vec!["origin"]);
        set_upstream(&repo, "main", "fork", "refs/heads/main");
        set_cfg(&repo, "branch.main.pushRemote", "zeta");
        assert_eq!(fetch_remote_names(&repo, Some("main"), false), vec!["origin", "fork", "zeta"]);
        // Detached HEAD: just the default.
        assert_eq!(fetch_remote_names(&repo, None, false), vec!["origin"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fetch_remotes_default_is_first_without_origin() {
        let dir = make_temp_dir("remote");
        let repo = Repository::init(&dir).unwrap();
        repo.remote("zeta", "https://example.invalid/z.git").unwrap();
        assert_eq!(fetch_remote_names(&repo, None, false), vec!["zeta"]);
        let empty = make_temp_dir("remote");
        let r2 = Repository::init(&empty).unwrap();
        assert!(fetch_remote_names(&r2, Some("main"), false).is_empty());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(empty);
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
