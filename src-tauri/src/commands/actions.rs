use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

#[derive(Debug, Serialize)]
pub struct StatusInfo {
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub merge_in_progress: bool,
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

    let git_dir = repo.path();
    let merge_in_progress = git_dir.join("MERGE_HEAD").exists()
        || git_dir.join("CHERRY_PICK_HEAD").exists()
        || git_dir.join("REVERT_HEAD").exists();
    Ok(StatusInfo { staged_count, unstaged_count, merge_in_progress })
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

#[derive(Debug, Serialize)]
pub struct SquashPreview {
    /// Number of commits that will be combined.
    pub count: usize,
    /// Suggested subject line — the oldest selected commit's summary.
    pub default_subject: String,
    /// Suggested body — the oldest commit's body plus each later commit's full
    /// message, oldest first.
    pub default_body: String,
}

/// A validated, contiguous squash selection: the commits ordered newest-first,
/// plus the commit that will become the squashed commit's parent.
struct SquashRange<'r> {
    /// Selected commits, newest (tip) first, oldest (base) last.
    chain: Vec<git2::Commit<'r>>,
    /// Parent of the oldest selected commit — the squashed commit sits on top.
    new_parent: git2::Commit<'r>,
}

/// Validate that `oids` form a contiguous linear chain on the current branch and
/// return them newest-first. The selection may be interior (have descendants up
/// to HEAD); those descendants are replayed by the caller.
///
/// Rules: ≥2 commits, no merge commits within the range, the oldest commit has a
/// single parent, and every selected commit lies on one unbroken first-parent
/// chain (no gaps, no extras).
fn resolve_squash_range<'r>(
    repo: &'r git2::Repository,
    head_oid: git2::Oid,
    oids: &[String],
) -> Result<SquashRange<'r>> {
    use std::collections::HashSet;

    let mut wanted: HashSet<git2::Oid> = HashSet::new();
    for o in oids {
        let oid = git2::Oid::from_str(o).map_err(|_| Error::CommitNotFound(o.clone()))?;
        wanted.insert(oid);
    }
    if wanted.len() < 2 {
        return Err(Error::InvalidArg("Select at least two commits to squash.".into()));
    }

    // The tip is the only selected commit that is not an ancestor of another
    // selected commit. Find it so we can walk parents downward from there.
    let mut tip: Option<git2::Oid> = None;
    for &candidate in &wanted {
        let is_ancestor_of_other = wanted.iter().any(|&other| {
            other != candidate && repo.graph_descendant_of(other, candidate).unwrap_or(false)
        });
        if !is_ancestor_of_other {
            if tip.is_some() {
                // Two unrelated tips ⇒ the selection spans diverging branches.
                return Err(Error::InvalidArg(
                    "Selected commits are not contiguous. Pick a single unbroken range.".into(),
                ));
            }
            tip = Some(candidate);
        }
    }
    let tip = tip.ok_or_else(|| {
        Error::InvalidArg("Selected commits are not contiguous. Pick a single unbroken range.".into())
    })?;

    // The range must live on the current branch so its descendants can be replayed.
    if tip != head_oid && !repo.graph_descendant_of(head_oid, tip)? {
        return Err(Error::InvalidArg(
            "Selected commits are not on the current branch.".into(),
        ));
    }

    // Walk first-parent links from the tip, consuming the selection as we go.
    let mut remaining = wanted.clone();
    let mut chain = Vec::with_capacity(wanted.len());
    let mut current = repo.find_commit(tip)?;
    loop {
        if !remaining.remove(&current.id()) {
            // Reached a commit outside the selection before consuming it all ⇒ gap.
            return Err(Error::InvalidArg(
                "Selected commits are not contiguous. Pick a single unbroken range.".into(),
            ));
        }
        if current.parent_count() > 1 {
            return Err(Error::InvalidArg(
                "Cannot squash across a merge commit. Select a linear range.".into(),
            ));
        }
        chain.push(current.clone());

        if remaining.is_empty() {
            break; // current is the oldest (base) commit
        }
        if current.parent_count() == 0 {
            return Err(Error::InvalidArg(
                "Selected commits are not contiguous. Pick a single unbroken range.".into(),
            ));
        }
        current = current.parent(0)?;
    }

    let base = chain.last().expect("range is non-empty");
    if base.parent_count() != 1 {
        return Err(Error::InvalidArg(
            "Cannot squash: the oldest selected commit must have exactly one parent.".into(),
        ));
    }
    let new_parent = base.parent(0)?;

    Ok(SquashRange { chain, new_parent })
}

/// Preview a squash of the given commits: how many and a suggested combined
/// message. Validates the selection without mutating anything.
#[tauri::command]
pub fn get_squash_preview(repo_id: String, oids: Vec<String>, state: State<RepoState>) -> Result<SquashPreview> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot squash: HEAD is detached. Checkout a branch first.".into(),
        ));
    }
    let head_oid = head
        .target()
        .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?;

    let range = resolve_squash_range(repo, head_oid, &oids)?;

    // Oldest first: the oldest commit's summary becomes the subject; its body and
    // every later commit's full message become the body.
    let mut oldest_first = range.chain.iter().rev();
    let oldest = oldest_first.next().expect("range is non-empty");
    let default_subject = oldest.summary().unwrap_or("").trim().to_owned();

    let mut body_parts: Vec<String> = Vec::new();
    let oldest_body = oldest.body().unwrap_or("").trim();
    if !oldest_body.is_empty() {
        body_parts.push(oldest_body.to_owned());
    }
    for c in oldest_first {
        let msg = c.message().unwrap_or("").trim();
        if !msg.is_empty() {
            body_parts.push(msg.to_owned());
        }
    }
    let default_body = body_parts.join("\n\n");

    Ok(SquashPreview { count: range.chain.len(), default_subject, default_body })
}

/// Squash the given contiguous commits into a single commit using `message`,
/// then replay any descendants up to HEAD. Rewrites history on the current
/// branch. Aborts and errors on conflict.
#[tauri::command]
pub fn squash_commits(repo_id: String, oids: Vec<String>, message: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot squash: HEAD is detached. Checkout a branch first.".into(),
        ));
    }
    let head_oid = head
        .target()
        .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?;

    let msg = message.trim();
    if msg.is_empty() {
        return Err(Error::InvalidArg("Commit message cannot be empty.".into()));
    }

    let range = resolve_squash_range(repo, head_oid, &oids)?;
    let tip = range.chain.first().expect("range is non-empty");
    let tip_oid = tip.id();

    // The squashed commit carries the tip's tree (the cumulative content of the
    // whole range) on top of the oldest commit's parent.
    let sig = repo.signature()?;
    let tree = tip.tree()?;
    let squashed_oid = repo.commit(None, &sig, &sig, msg, &tree, &[&range.new_parent])?;

    let branch_ref = head
        .name()
        .ok_or_else(|| Error::InvalidArg("HEAD reference has no name".into()))?
        .to_owned();

    // No descendants beyond the range — just point the branch at the squash.
    // Working dir/index already match (squash tree == old HEAD tree == tip tree).
    if tip_oid == head_oid {
        repo.reference(&branch_ref, squashed_oid, true, "squash commits")?;
        repo.set_head(&branch_ref)?;
        return Ok(());
    }

    // Interior squash: replay tip..HEAD onto the squashed commit.
    let branch_ann = repo.reference_to_annotated_commit(&head)?;
    let upstream_ann = repo.find_annotated_commit(tip_oid)?;
    let onto_ann = repo.find_annotated_commit(squashed_oid)?;

    let mut rebase = repo.rebase(Some(&branch_ann), Some(&upstream_ann), Some(&onto_ann), None)?;
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
                        "Squash hit a conflict while replaying later commits and was aborted.".into(),
                    ));
                }
                rebase.commit(None, &sig, None)?;
            }
        }
    }
    rebase.finish(None)?;
    Ok(())
}

/// Outcome of `checkout_remote_branch`, so the frontend can explain what
/// happened (and offer a hard reset when the local branch was left behind).
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckoutRemoteResult {
    /// No local branch existed; created one at the remote tip and checked it out.
    Created,
    /// Local branch already pointed at the remote tip.
    UpToDate,
    /// Local branch was behind; fast-forwarded it to the remote tip.
    FastForward,
    /// Local branch had diverged; checked out the remote tip detached and left
    /// the local branch (and its unique commits) untouched.
    Detached,
}

/// Checkout a remote tracking branch by creating (or reusing) a local branch.
/// `remote_branch` is the shorthand, e.g. "origin/feature".
///
/// When the local branch already exists, land the user on the remote tip rather
/// than on the (possibly stale) local position:
///   - missing      → create at the remote tip, set tracking, check out
///   - up to date   → check out the local branch as-is
///   - behind       → fast-forward the local branch to the remote tip, check out
///   - diverged     → check out the remote tip detached, leaving local commits intact
#[tauri::command]
pub fn checkout_remote_branch(repo_id: String, remote_branch: String, force: bool, state: State<RepoState>) -> Result<CheckoutRemoteResult> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let slash = remote_branch.find('/').ok_or_else(|| {
        Error::InvalidArg(format!("'{}' is not a valid remote tracking branch", remote_branch))
    })?;
    let local_name = &remote_branch[slash + 1..];
    let remote_ref = format!("refs/remotes/{}", remote_branch);

    let remote_obj = repo.revparse_single(&remote_ref)
        .map_err(|_| Error::InvalidArg(format!("Remote branch '{}' not found", remote_branch)))?;
    let remote_commit = remote_obj.peel_to_commit()?;
    let remote_oid = remote_commit.id();

    let local_ref = format!("refs/heads/{}", local_name);

    // Resolve the existing local branch's tip (if any) in a scope that releases
    // the borrow on `repo` before we check anything out below.
    let local_oid: Option<git2::Oid> = match repo.find_branch(local_name, git2::BranchType::Local) {
        Ok(b) => Some(
            b.get().target()
                .ok_or_else(|| Error::InvalidArg("local branch has no target".into()))?,
        ),
        Err(_) => None,
    };

    match local_oid {
        // No local branch yet — create it at the remote tip and track it.
        None => {
            let mut b = repo.branch(local_name, &remote_commit, false)?;
            let _ = b.set_upstream(Some(&remote_branch));
            do_checkout(repo, &local_ref, force)?;
            Ok(CheckoutRemoteResult::Created)
        }
        // Up to date, or behind the remote (local is an ancestor of the tip).
        Some(local_oid) if local_oid == remote_oid || repo.graph_descendant_of(remote_oid, local_oid)? => {
            if local_oid == remote_oid {
                do_checkout(repo, &local_ref, force)?;
                return Ok(CheckoutRemoteResult::UpToDate);
            }
            // Behind: fast-forward the local ref forward to the remote tip.
            repo.find_reference(&local_ref)?
                .set_target(remote_oid, "checkout: fast-forward to remote")?;
            do_checkout(repo, &local_ref, force)?;
            Ok(CheckoutRemoteResult::FastForward)
        }
        // Ahead or diverged — don't move the local branch over its own commits.
        // Land on the remote tip detached so the user lands where the remote
        // points without losing local work.
        Some(_) => {
            do_checkout(repo, &remote_oid.to_string(), force)?;
            Ok(CheckoutRemoteResult::Detached)
        }
    }
}

/// Hard-reset a local branch onto its remote tip, discarding any local commits
/// and working-tree changes that diverge from the remote, then check it out.
/// Destructive — invoked explicitly by the user (e.g. after a remote force-push).
#[tauri::command]
pub fn reset_branch_to_remote(repo_id: String, remote_branch: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let slash = remote_branch.find('/').ok_or_else(|| {
        Error::InvalidArg(format!("'{}' is not a valid remote tracking branch", remote_branch))
    })?;
    let local_name = &remote_branch[slash + 1..];
    let remote_ref = format!("refs/remotes/{}", remote_branch);

    let remote_commit = repo
        .revparse_single(&remote_ref)
        .map_err(|_| Error::InvalidArg(format!("Remote branch '{}' not found", remote_branch)))?
        .peel_to_commit()?;
    let remote_oid = remote_commit.id();

    let local_ref = format!("refs/heads/{}", local_name);
    // Force-move the local branch onto the remote tip, then force-checkout so the
    // working tree matches — equivalent to `reset --hard` to the remote.
    repo.reference(&local_ref, remote_oid, true, "reset to remote")?;
    do_checkout(repo, &local_ref, true)?;

    if let Ok(mut b) = repo.find_branch(local_name, git2::BranchType::Local) {
        let _ = b.set_upstream(Some(&remote_branch));
    }
    Ok(())
}

/// Delete a local branch by short name.
/// Refuses to delete the currently checked-out branch.
#[tauri::command]
pub fn delete_branch(repo_id: String, name: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    if let Ok(head) = repo.head() {
        if head.is_branch() && head.shorthand() == Some(name.as_str()) {
            return Err(Error::InvalidArg(format!(
                "Cannot delete '{}': it is the currently checked-out branch", name
            )));
        }
    }

    let mut branch = repo
        .find_branch(&name, git2::BranchType::Local)
        .map_err(|_| Error::InvalidArg(format!("Branch '{}' not found", name)))?;
    branch.delete().map_err(Error::Git)?;
    Ok(())
}

/// Rename a local branch. Renaming the currently checked-out branch is fine —
/// libgit2 updates HEAD to follow it. `force` overwrites an existing branch.
#[tauri::command]
pub fn rename_branch(
    repo_id: String,
    old_name: String,
    new_name: String,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let new = new_name.trim();
    if new.is_empty() {
        return Err(Error::InvalidArg("New branch name cannot be empty.".into()));
    }

    let mut branch = repo
        .find_branch(&old_name, git2::BranchType::Local)
        .map_err(|_| Error::InvalidArg(format!("Branch '{}' not found", old_name)))?;
    branch.rename(new, false).map_err(Error::Git)?;
    Ok(())
}
