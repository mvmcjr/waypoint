use serde::Serialize;
use crate::git_text::CommitDecoder;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

/// Replay the commits in `upstream..old_tip` (oldest first) on top of `onto`
/// and move `branch_ref` to the result. Shared by every command that rewrites
/// history (plain rebase, squash, reword) so they abort/report identically.
///
/// This is deliberately NOT libgit2's `git_rebase`: it builds each replayed
/// commit itself, carrying the original's `encoding` header and round-tripping
/// the author through `git_signature` (the parent is whatever HEAD is
/// mid-rebase; the only hook is a C-only `commit_create_cb`), and it returns
/// `Applied` for originally-empty commits, which silently dropped them.
/// Instead each commit is cherry-picked in memory and written by
/// [`crate::git_text::write_commit`] the way git writes a rewrite: author and
/// message transcoded to UTF-8 from the declared `encoding`, no `encoding`
/// header, committer = `sig`.
///
/// Like `git rebase`: commits that start out empty are kept, commits that
/// BECOME empty (their change is already in `onto`) are dropped, and merge
/// commits in the range are skipped (no `--rebase-merges`).
///
/// Nothing is touched until the whole replay succeeded: a conflict (or any
/// error) returns before the working tree or any ref changes, and no
/// `.git/rebase-merge` state is ever created. A dirty index or working tree is
/// refused up front, as `git rebase` does.
fn replay_onto(
    repo: &git2::Repository,
    branch_ref: &str,
    old_tip: git2::Oid,
    upstream: git2::Oid,
    onto: git2::Oid,
    sig: &git2::Signature,
    conflict_msg: &str,
) -> Result<()> {
    ensure_clean_for_rewrite(repo)?;

    let mut walk = repo.revwalk()?;
    walk.push(old_tip)?;
    walk.hide(upstream)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;
    let oids: Vec<git2::Oid> = walk.collect::<std::result::Result<_, _>>()?;

    let mut last = repo.find_commit(onto)?;
    for oid in oids {
        let commit = repo.find_commit(oid)?;
        if commit.parent_count() > 1 {
            continue;
        }
        // Already sitting on the current base: git's sequencer fast-forwards
        // over it (same oid, signature and encoding intact) instead of
        // replaying. Once a commit has been rewritten `last` differs from every
        // original parent, so the rest is replayed.
        if commit.parent_ids().next() == Some(last.id()) {
            last = commit;
            continue;
        }
        let mut index = repo.cherrypick_commit(&commit, &last, 0, None)?;
        if index.has_conflicts() {
            return Err(Error::RebaseConflict(conflict_msg.into()));
        }
        let tree = index.write_tree_to(repo)?;
        let originally_empty = match commit.parent(0) {
            Ok(parent) => parent.tree_id() == commit.tree_id(),
            Err(_) => commit.tree()?.is_empty(),
        };
        if tree == last.tree_id() && !originally_empty {
            continue; // already in `onto` — git's default `--empty=drop`
        }
        let text = crate::git_text::transcode_for_rewrite(&commit);
        let new_oid =
            crate::git_text::write_commit(repo, tree, &[last.id()], &text.author, sig, &text.message)?;
        last = repo.find_commit(new_oid)?;
    }

    let new_tip = last.id();
    if new_tip == old_tip {
        return Ok(());
    }
    // 1. Detach HEAD at the old tip, so while the branch moves HEAD never
    //    resolves to the new tip over old files, and the checkout below has
    //    HEAD (= old tip) as its baseline: collisions with untracked files are
    //    refused. HEAD is written directly with `rebase (...)` reflog messages
    //    (as git rebase does): libgit2's `set_head*` would log
    //    `checkout: moving from X to Y`, which `git checkout -` / `@{-N}` read.
    repo.reference("HEAD", old_tip, true, &format!("rebase (start): detach at {old_tip}"))?;
    let reattach = || {
        repo.reference_symbolic("HEAD", branch_ref, true, &format!("rebase (finish): returning to {branch_ref}"))
    };
    // 2. Move the ref (guarded): if the branch moved meanwhile this fails having
    //    touched nothing, so index and working tree still match the branch.
    let reflog = format!("rebase (finish): {branch_ref} onto {onto}");
    let prior_orig_head = match move_branch_recording_orig_head(repo, branch_ref, new_tip, old_tip, &reflog) {
        Ok(prior) => prior,
        Err(e) => {
            return Err(match reattach() {
                Ok(_) => Error::Git(e),
                Err(r) => Error::Git(git2::Error::from_str(&format!("{e}; HEAD could not be re-attached to {branch_ref}: {r}"))),
            });
        }
    };
    // 3. Bring index and working tree to the new tip (the tree was verified
    //    clean above); if that refuses, undo everything.
    let checkout = repo.checkout_tree(last.as_object(), Some(git2::build::CheckoutBuilder::new().safe()));
    if let Err(e) = checkout {
        let mut failures = match rollback_replay(repo, branch_ref, old_tip, new_tip, prior_orig_head) {
            Ok(()) => Vec::new(),
            Err(f) => vec![f],
        };
        if let Err(r) = reattach() {
            failures.push(format!("HEAD could not be re-attached to {branch_ref}: {r}"));
        }
        if failures.is_empty() {
            return Err(Error::Git(e));
        }
        return Err(Error::Git(git2::Error::from_str(&format!(
            "{e}; the rewrite could not be fully rolled back ({}); {branch_ref} may still point at {new_tip}",
            failures.join("; ")
        ))));
    }
    // 4. Re-attach HEAD to the (already moved) branch.
    reattach()?;
    Ok(())
}

/// Moves `branch_ref` from `old_tip` to `new_tip`, guarded against the branch
/// having moved meanwhile, and only then records `old_tip` as ORIG_HEAD (what
/// `reset ORIG_HEAD` expects after a rewrite). A refused update must not
/// clobber the user's ORIG_HEAD; failing to write it never blocks the rewrite.
/// Returns ORIG_HEAD's previous value (`None` if it didn't exist) so a rollback
/// can restore it.
fn move_branch_recording_orig_head(
    repo: &git2::Repository,
    branch_ref: &str,
    new_tip: git2::Oid,
    old_tip: git2::Oid,
    reflog: &str,
) -> std::result::Result<Option<git2::Oid>, git2::Error> {
    let prior = repo.refname_to_id("ORIG_HEAD").ok();
    repo.reference_matching(branch_ref, new_tip, true, old_tip, reflog)?;
    let _ = repo.reference("ORIG_HEAD", old_tip, true, "rewrite: updating ORIG_HEAD");
    Ok(prior)
}

/// Undoes a replay whose checkout failed: puts index and working tree back to
/// `old_tip` (HEAD is detached there; a hard reset only touches tracked files,
/// untracked ones are kept), moves `branch_ref` back from `new_tip`, and
/// restores ORIG_HEAD to `prior_orig_head` (removing it if it didn't exist).
/// Every step is attempted; the `Err` lists the ones that failed.
fn rollback_replay(
    repo: &git2::Repository,
    branch_ref: &str,
    old_tip: git2::Oid,
    new_tip: git2::Oid,
    prior_orig_head: Option<git2::Oid>,
) -> std::result::Result<(), String> {
    let mut failures = Vec::new();
    let restored = repo
        .find_object(old_tip, None)
        .and_then(|old| repo.reset(&old, git2::ResetType::Hard, None));
    if let Err(e) = restored {
        failures.push(format!("index and working tree were not restored: {e}"));
    }
    if let Err(e) = repo.reference_matching(branch_ref, old_tip, true, new_tip, "rebase (abort): checkout refused") {
        failures.push(format!("{branch_ref} was not moved back: {e}"));
    }
    let orig = match prior_orig_head {
        Some(oid) => repo.reference("ORIG_HEAD", oid, true, "rebase (abort): restoring ORIG_HEAD").map(|_| ()),
        None => match repo.find_reference("ORIG_HEAD") {
            Ok(mut r) => r.delete(),
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(()),
            Err(e) => Err(e),
        },
    };
    if let Err(e) = orig {
        failures.push(format!("ORIG_HEAD was not restored: {e}"));
    }
    if failures.is_empty() { Ok(()) } else { Err(failures.join("; ")) }
}

/// Refuse to rewrite history under uncommitted tracked changes (what
/// `git rebase` and libgit2's rebase both do): the replay ends by checking out
/// the new tip.
///
/// Untracked files inside a submodule don't count (git rebase and libgit2's
/// `rebase_ensure_not_dirty` use `ignore=untracked` for submodules). git2's
/// `DiffOptions` only exposes an all-or-nothing `ignore_submodules`, so the
/// index-to-workdir diff skips submodules and each gitlink in the index is
/// checked by path with [`submodule_path_is_dirty`]. The tree-to-index diff
/// compares object ids only, so staged gitlink changes are seen there.
fn ensure_clean_for_rewrite(repo: &git2::Repository) -> Result<()> {
    let head_tree = repo.head()?.peel_to_tree()?;
    // Index vs HEAD only compares object ids (no submodule inspection), so a
    // staged gitlink change is always seen here, whatever `.gitmodules` says.
    if repo.diff_tree_to_index(Some(&head_tree), None, None)?.deltas().len() > 0 {
        return Err(Error::Git(git2::Error::from_str("uncommitted changes exist in index")));
    }
    let mut opts = git2::DiffOptions::new();
    opts.ignore_submodules(true);
    if repo.diff_index_to_workdir(None, Some(&mut opts))?.deltas().len() > 0 {
        return Err(Error::Git(git2::Error::from_str("unstaged changes exist in workdir")));
    }
    // Check each gitlink in the index by path, independent of `.gitmodules`
    // (a malformed listing must not hide a dirty submodule). A gitlink whose
    // status can't be read (no entry, no checkout...) holds no edits we would
    // lose and is skipped.
    let index = repo.index()?;
    for entry in index.iter().filter(|e| e.mode == 0o160000) {
        let path = String::from_utf8_lossy(&entry.path).into_owned();
        if submodule_path_is_dirty(repo, &path) {
            return Err(Error::Git(git2::Error::from_str("uncommitted changes exist in submodule")));
        }
    }
    Ok(())
}

/// Whether the submodule at `path` has anything but untracked files to commit:
/// a new HEAD or staged/unstaged change inside it, or a gitlink that differs
/// from the index/HEAD.
fn submodule_path_is_dirty(repo: &git2::Repository, path: &str) -> bool {
    use git2::SubmoduleStatus as S;
    let Ok(status) = repo.submodule_status(path, git2::SubmoduleIgnore::Untracked) else { return false };
    status.intersects(
        S::INDEX_ADDED
            | S::INDEX_DELETED
            | S::INDEX_MODIFIED
            | S::WD_ADDED
            | S::WD_DELETED
            | S::WD_MODIFIED
            | S::WD_INDEX_MODIFIED
            | S::WD_WD_MODIFIED,
    )
}

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
    repo_status_impl(repo)
}

fn repo_status_impl(repo: &git2::Repository) -> Result<StatusInfo> {
    crate::repo::ensure_present(repo)?;

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
    /// HEAD commit, or None in a fresh repository where HEAD is still unborn.
    pub oid: Option<String>,
    /// Local branch name, or None when HEAD is detached.
    pub branch: Option<String>,
}

#[tauri::command]
pub fn get_head_info(repo_id: String, state: State<RepoState>) -> Result<HeadInfo> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    head_info(repo)
}

fn head_info(repo: &git2::Repository) -> Result<HeadInfo> {
    let head = match repo.head() {
        Ok(head) => head,
        // A repository with no commits yet has an unborn HEAD: it still names the
        // branch the first commit will create, but resolves to nothing. Report that
        // instead of erroring, so the UI can show the staging view.
        Err(e) if matches!(e.code(), git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound) => {
            let branch = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().ok().flatten().map(|t| {
                    t.strip_prefix("refs/heads/").unwrap_or(t).to_owned()
                }));
            return Ok(HeadInfo { oid: None, branch });
        }
        Err(e) => return Err(e.into()),
    };

    let oid = Some(
        head.target()
            .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?
            .to_string(),
    );

    let branch = if head.is_branch() {
        head.shorthand().ok().map(|s| s.to_owned())
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

    // Refuse BEFORE any mutation if this resolves to a local branch checked out in
    // another worktree. `checkout_tree` runs before `set_head` below, so checking
    // only there would leave the working tree half-switched; and from a detached
    // HEAD libgit2's own `set_head` guard doesn't fire at all, so this precheck is
    // required in both cases.
    if let Some(gref) = &reference {
        if gref.is_branch() {
            if let Ok(refname) = gref.name() {
                if let Some(path) = crate::repo::checked_out_elsewhere(repo, refname) {
                    let short = gref.shorthand().unwrap_or(refname);
                    if !path.exists() {
                        // Deleted-but-unpruned: the worktree's folder is gone, but
                        // git still counts the branch as checked out there. Name
                        // the next step instead of pointing at a path that no
                        // longer exists.
                        let wt_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        return Err(Error::InvalidArg(format!(
                            "'{}' is checked out in worktree '{}', whose folder no longer exists. Prune missing worktrees first.",
                            short, wt_name
                        )));
                    }
                    return Err(Error::InvalidArg(format!(
                        "'{}' is already checked out in another worktree at {}",
                        short,
                        path.display()
                    )));
                }
            }
        }
    }

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
    rebase_onto_impl(repo, &onto_oid)
}

fn rebase_onto_impl(repo: &git2::Repository, onto_oid: &str) -> Result<()> {
    // Must be on a branch (not detached HEAD) to rebase.
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot rebase: HEAD is detached. Checkout a branch first.".into(),
        ));
    }

    let oid = git2::Oid::from_str(onto_oid).map_err(|_| Error::CommitNotFound(onto_oid.to_owned()))?;
    repo.find_commit(oid).map_err(|_| Error::CommitNotFound(onto_oid.to_owned()))?;
    let head_oid = head
        .target()
        .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?;
    let branch_ref = head.name()?.to_owned();

    let sig = repo.signature()?;
    replay_onto(
        repo,
        &branch_ref,
        head_oid,
        oid,
        oid,
        &sig,
        "Rebase has conflicts and was aborted. Please resolve them manually in a terminal.",
    )
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
    let oldest_dec = CommitDecoder::new(oldest);
    let default_subject = oldest_dec.text(oldest.summary_bytes()).trim().to_owned();

    let mut body_parts: Vec<String> = Vec::new();
    let oldest_body = oldest_dec.text(oldest.body_bytes());
    let oldest_body = oldest_body.trim();
    if !oldest_body.is_empty() {
        body_parts.push(oldest_body.to_owned());
    }
    for c in oldest_first {
        let msg = CommitDecoder::new(c).text(c.message_bytes());
        let msg = msg.trim();
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
    squash_in(repo, &oids, &message)
}

fn squash_in(repo: &git2::Repository, oids: &[String], message: &str) -> Result<()> {
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot squash: HEAD is detached. Checkout a branch first.".into(),
        ));
    }
    let head_oid = head
        .target()
        .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?;
    // Resolve before writing any objects, so a bad ref name fails cleanly.
    let branch_ref = head.name()?.to_owned();

    let msg = message.trim();
    if msg.is_empty() {
        return Err(Error::InvalidArg("Commit message cannot be empty.".into()));
    }

    let range = resolve_squash_range(repo, head_oid, oids)?;
    let tip = range.chain.first().expect("range is non-empty");
    let tip_oid = tip.id();

    // The squashed commit carries the tip's tree (the cumulative content of the
    // whole range) on top of the oldest commit's parent.
    let sig = repo.signature()?;
    let tree = tip.tree()?;
    let squashed_oid = repo.commit(None, &sig, &sig, msg, &tree, &[&range.new_parent])?;

    // No descendants beyond the range — just point the branch at the squash.
    // Working dir/index already match (squash tree == old HEAD tree == tip tree).
    if tip_oid == head_oid {
        move_branch_recording_orig_head(repo, &branch_ref, squashed_oid, head_oid, "squash commits")?;
        repo.set_head(&branch_ref)?;
        return Ok(());
    }

    // Interior squash: replay tip..HEAD onto the squashed commit.
    replay_onto(
        repo,
        &branch_ref,
        head_oid,
        tip_oid,
        squashed_oid,
        &sig,
        "Squash hit a conflict while replaying later commits and was aborted.",
    )
}

/// True if `oid` is reachable from the tip of any remote-tracking branch —
/// i.e. it (or a descendant) has already been pushed, so rewriting it would
/// require a force-push. A single BFS shared across all remote tips (rather
/// than one `graph_descendant_of` walk per branch) so overlapping history
/// between remotes is only walked once, and it stops as soon as `oid` turns up.
fn is_reachable_from_any_remote(repo: &git2::Repository, oid: git2::Oid) -> Result<bool> {
    use std::collections::{HashSet, VecDeque};

    let mut queue: VecDeque<git2::Oid> = VecDeque::new();
    let mut visited: HashSet<git2::Oid> = HashSet::new();

    for branch in repo.branches(Some(git2::BranchType::Remote))? {
        let (branch, _) = branch?;
        if let Some(target) = branch.get().target() {
            if visited.insert(target) {
                queue.push_back(target);
            }
        }
    }

    while let Some(cur) = queue.pop_front() {
        if cur == oid {
            return Ok(true);
        }
        if let Ok(commit) = repo.find_commit(cur) {
            for parent_id in commit.parent_ids() {
                if visited.insert(parent_id) {
                    queue.push_back(parent_id);
                }
            }
        }
    }
    Ok(false)
}

/// Confirm every commit on `tip_oid`'s first-parent chain down to (and
/// including) `base_oid` has exactly one parent — i.e. replaying that range
/// won't cross a merge commit, whose other parents wouldn't be replayed
/// correctly. Mirrors the per-commit check in `resolve_squash_range`, which
/// additionally validates contiguity against a specific commit selection.
fn assert_first_parent_chain_is_linear(
    repo: &git2::Repository,
    tip_oid: git2::Oid,
    base_oid: git2::Oid,
    err_msg: &str,
) -> Result<()> {
    let mut cur = repo.find_commit(tip_oid)?;
    while cur.id() != base_oid {
        if cur.parent_count() != 1 {
            return Err(Error::InvalidArg(err_msg.into()));
        }
        cur = cur.parent(0)?;
    }
    Ok(())
}

/// Edit the message of `oid`, a commit on the current branch's first-parent
/// chain up to HEAD, then replay any descendants on top. Refuses commits
/// already reachable from a remote-tracking branch (rewriting those would
/// need a force-push) and commits behind a merge in the replay range.
#[tauri::command]
pub fn reword_commit(repo_id: String, oid: String, message: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    reword_in(repo, &oid, &message)
}

fn reword_in(repo: &git2::Repository, oid: &str, message: &str) -> Result<()> {
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(Error::InvalidArg(
            "Cannot edit message: HEAD is detached. Checkout a branch first.".into(),
        ));
    }
    let head_oid = head
        .target()
        .ok_or_else(|| Error::InvalidArg("HEAD has no target".into()))?;
    // Resolve before writing any objects, so a bad ref name fails cleanly.
    let branch_ref = head.name()?.to_owned();

    let msg = message.trim();
    if msg.is_empty() {
        return Err(Error::InvalidArg("Commit message cannot be empty.".into()));
    }

    let target_oid = git2::Oid::from_str(oid).map_err(|_| Error::CommitNotFound(oid.to_owned()))?;
    let target = repo.find_commit(target_oid).map_err(|_| Error::CommitNotFound(oid.to_owned()))?;

    if target_oid != head_oid && !repo.graph_descendant_of(head_oid, target_oid)? {
        return Err(Error::InvalidArg("Commit is not on the current branch.".into()));
    }

    if is_reachable_from_any_remote(repo, target_oid)? {
        return Err(Error::InvalidArg(
            "Cannot edit message: this commit has already been pushed to a remote.".into(),
        ));
    }

    assert_first_parent_chain_is_linear(
        repo,
        head_oid,
        target_oid,
        "Cannot edit message: a merge commit sits between this commit and HEAD.",
    )?;

    // Rebuild the commit with the same tree and parents — only the message
    // (and committer identity/time, to reflect the edit) changes. Like git,
    // the message is UTF-8 with no `encoding` header and the author line is
    // the original's, transcoded from its declared encoding.
    let sig = repo.signature()?;
    let parents: Vec<git2::Oid> = target.parent_ids().collect();
    let author = crate::git_text::transcode_for_rewrite(&target).author;
    let new_oid = crate::git_text::write_commit(repo, target.tree_id(), &parents, &author, &sig, msg.as_bytes())?;

    // Target was HEAD — no descendants to replay, just move the branch tip.
    if target_oid == head_oid {
        repo.reference_matching(&branch_ref, new_oid, true, head_oid, "reword commit")?;
        repo.set_head(&branch_ref)?;
        return Ok(());
    }

    // Interior reword: replay target..HEAD onto the reworded commit.
    replay_onto(
        repo,
        &branch_ref,
        head_oid,
        target_oid,
        new_oid,
        &sig,
        "Editing this commit's message hit a conflict while replaying later commits and was aborted.",
    )
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
    checkout_remote_branch_impl(repo, &remote_branch, force)
}

fn checkout_remote_branch_impl(repo: &git2::Repository, remote_branch: &str, force: bool) -> Result<CheckoutRemoteResult> {
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
            let _ = b.set_upstream(Some(remote_branch));
            do_checkout(repo, &local_ref, force)?;
            Ok(CheckoutRemoteResult::Created)
        }
        // Up to date, or behind the remote (local is an ancestor of the tip).
        Some(local_oid) if local_oid == remote_oid || repo.graph_descendant_of(remote_oid, local_oid)? => {
            if local_oid == remote_oid {
                do_checkout(repo, &local_ref, force)?;
                return Ok(CheckoutRemoteResult::UpToDate);
            }
            // Behind: fast-forward the local ref forward to the remote tip. Refuse
            // BEFORE moving the ref if another worktree has this branch checked out.
            if let Some(path) = crate::repo::checked_out_elsewhere(repo, &local_ref) {
                return Err(Error::InvalidArg(format!(
                    "'{}' is already checked out in another worktree at {}",
                    local_name,
                    path.display()
                )));
            }
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
    reset_branch_to_remote_impl(repo, &remote_branch)
}

fn reset_branch_to_remote_impl(repo: &git2::Repository, remote_branch: &str) -> Result<()> {
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

    // Refuse BEFORE moving the ref if another worktree has this branch checked out.
    if let Some(path) = crate::repo::checked_out_elsewhere(repo, &local_ref) {
        return Err(Error::InvalidArg(format!(
            "'{}' is already checked out in another worktree at {}",
            local_name,
            path.display()
        )));
    }

    // Force-move the local branch onto the remote tip, then force-checkout so the
    // working tree matches — equivalent to `reset --hard` to the remote.
    repo.reference(&local_ref, remote_oid, true, "reset to remote")?;
    do_checkout(repo, &local_ref, true)?;

    if let Ok(mut b) = repo.find_branch(local_name, git2::BranchType::Local) {
        let _ = b.set_upstream(Some(remote_branch));
    }
    Ok(())
}

/// Delete a local branch by short name.
/// Refuses to delete the currently checked-out branch.
#[tauri::command]
pub fn delete_branch(repo_id: String, name: String, state: State<RepoState>) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    delete_branch_impl(repo, &name)
}

fn delete_branch_impl(repo: &git2::Repository, name: &str) -> Result<()> {
    if let Ok(head) = repo.head() {
        if head.is_branch() && head.shorthand().ok() == Some(name) {
            return Err(Error::InvalidArg(format!(
                "Cannot delete '{}': it is the currently checked-out branch", name
            )));
        }
    }

    let refname = format!("refs/heads/{}", name);
    if let Some(path) = crate::repo::checked_out_elsewhere(repo, &refname) {
        return Err(Error::InvalidArg(format!(
            "Cannot delete '{}': it is checked out in another worktree at {}",
            name,
            path.display()
        )));
    }

    let mut branch = repo
        .find_branch(name, git2::BranchType::Local)
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
    rename_branch_impl(repo, &old_name, &new_name)
}

fn rename_branch_impl(repo: &git2::Repository, old_name: &str, new_name: &str) -> Result<()> {
    let new = new_name.trim();
    if new.is_empty() {
        return Err(Error::InvalidArg("New branch name cannot be empty.".into()));
    }

    let mut branch = repo
        .find_branch(old_name, git2::BranchType::Local)
        .map_err(|_| Error::InvalidArg(format!("Branch '{}' not found", old_name)))?;
    branch.rename(new, false).map_err(Error::Git)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    /// The reworded commit is plain UTF-8 (no `encoding` header) and its
    /// author line is the original's, transcoded from Latin-1 to UTF-8.
    fn assert_reworded_like_git(repo: &Repository, oid: git2::Oid, msg: &str) {
        let c = repo.find_commit(oid).unwrap();
        assert_eq!(c.message().unwrap().trim(), msg);
        let raw = String::from_utf8(crate::repo::test_support::raw_object(repo, oid)).unwrap();
        assert!(!raw.contains("\nencoding "), "{raw}");
        assert!(raw.contains("\nauthor André <a@example.com> 1000000000 +0000\n"), "{raw}");
    }

    /// Commit `file` = `content` on top of HEAD (no encoding games), move the
    /// branch there and sync the working tree.
    fn commit_file(repo: &Repository, file: &str, content: &str, msg: &str) -> git2::Oid {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let mut tb = repo.treebuilder(Some(&head.tree().unwrap())).unwrap();
        tb.insert(file, repo.blob(content.as_bytes()).unwrap(), 0o100644).unwrap();
        let tree = repo.find_tree(tb.write().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let oid = repo.commit(None, &sig, &sig, msg, &tree, &[&head]).unwrap();
        let name = repo.head().unwrap().name().unwrap().to_owned();
        repo.reference(&name, oid, true, "test").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        oid
    }

    fn move_branch(repo: &Repository, oid: git2::Oid) {
        let name = repo.head().unwrap().name().unwrap().to_owned();
        repo.reference(&name, oid, true, "test").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
    }

    #[test]
    fn reword_head_commit_transcodes_author_to_utf8() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let target = crate::repo::test_support::push_latin1_commit(&repo);
        reword_in(&repo, &target.to_string(), "Fixé le bug").unwrap();
        let new = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(new.id(), target);
        assert_reworded_like_git(&repo, new.id(), "Fixé le bug");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reword_interior_commit_transcodes_author_through_replay() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let target = crate::repo::test_support::push_latin1_commit(&repo);
        // A child commit on top so the reworded one is replayed under.
        crate::repo::test_support::push_raw_commit(&repo, "b.txt", T, T, b"", b"child
");
        reword_in(&repo, &target.to_string(), "Fixé le bug").unwrap();
        let child = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(child.summary(), Ok(Some("child")));
        assert_reworded_like_git(&repo, child.parent_id(0).unwrap(), "Fixé le bug");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reword_keeps_empty_name_and_email_author() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let target = push_raw_commit(&repo, "b.txt", b" <> 1600000000 +0000", b" <> 1600000000 +0000", b"", b"msg\n");
        reword_in(&repo, &target.to_string(), "new msg").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        let raw = String::from_utf8(raw_object(&repo, c.id())).unwrap();
        assert!(raw.contains("\nauthor  <> 1600000000 +0000\n"), "{raw}");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn assert_clean_on_branch(repo: &git2::Repository, branch_ref: &str) {
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert!(!repo.path().join("rebase-merge").exists());
        assert_eq!(repo.head().unwrap().name(), Ok(branch_ref));
    }

    #[test]
    fn interior_reword_over_empty_signature_descendant_succeeds() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let t = b"T <t@example.com> 1600000000 +0000";
        let target = push_raw_commit(&repo, "b.txt", t, t, b"", b"target\n");
        let e = b" <> 1000000000 +0000";
        let desc = push_raw_commit(&repo, "c.txt", e, e, b"encoding ISO-8859-1\n", b"Corrig\xe9\n");
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        assert_clean_on_branch(&repo, &branch_ref);
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(c.id(), desc);
        let raw = String::from_utf8_lossy(&raw_object(&repo, c.id())).into_owned();
        assert!(raw.contains("\nauthor  <> 1000000000 +0000\n"), "{raw}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// git keeps commits that start out empty (tree equals parent's) when it
    /// replays history, so an interior reword must too.
    #[test]
    fn interior_reword_keeps_an_originally_empty_descendant() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let t = b"T <t@example.com> 1600000000 +0000";
        let target = push_raw_commit(&repo, "b.txt", t, t, b"", b"target\n");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let sig = repo.signature().unwrap();
        let empty = repo.commit(None, &sig, &sig, "empty", &head.tree().unwrap(), &[&head]).unwrap();
        let name = repo.head().unwrap().name().unwrap().to_owned();
        repo.reference(&name, empty, true, "test").unwrap();
        let top = push_raw_commit(&repo, "c.txt", t, t, b"", b"top\n");
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        assert_clean_on_branch(&repo, &name);
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(tip.id(), top);
        assert_eq!(tip.summary(), Ok(Some("top")));
        let kept_empty = tip.parent(0).unwrap();
        assert_eq!(kept_empty.summary(), Ok(Some("empty")));
        assert_eq!(kept_empty.tree_id(), kept_empty.parent(0).unwrap().tree_id());
        let mid = kept_empty.parent(0).unwrap();
        assert_eq!(mid.summary(), Ok(Some("reworded")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rebase_onto_drops_a_commit_that_becomes_empty() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let mine = commit_file(&repo, "b.txt", "same", "mine");
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "b.txt", "same", "theirs");
        move_branch(&repo, mine);
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        rebase_onto_impl(&repo, &theirs.to_string()).unwrap();
        assert_clean_on_branch(&repo, &branch_ref);
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), theirs);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rebase_onto_replays_commits_and_updates_the_working_tree() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let mine = commit_file(&repo, "m.txt", "m", "mine");
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "t.txt", "t", "theirs");
        move_branch(&repo, mine);
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        rebase_onto_impl(&repo, &theirs.to_string()).unwrap();
        assert_clean_on_branch(&repo, &branch_ref);
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(tip.summary(), Ok(Some("mine")));
        assert_eq!(tip.parent_id(0).unwrap(), theirs);
        assert_eq!(std::fs::read_to_string(dir.join("m.txt")).unwrap(), "m");
        assert_eq!(std::fs::read_to_string(dir.join("t.txt")).unwrap(), "t");
        assert!(repo.statuses(None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rebase_onto_conflict_leaves_the_repo_untouched() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let mine = commit_file(&repo, "a.txt", "mine", "mine");
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "a.txt", "theirs", "theirs");
        move_branch(&repo, mine);
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        let err = rebase_onto_impl(&repo, &theirs.to_string());
        assert!(matches!(err, Err(Error::RebaseConflict(_))), "{err:?}");
        assert_clean_on_branch(&repo, &branch_ref);
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), mine);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "mine");
        assert!(repo.statuses(None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interior_reword_refuses_a_dirty_working_tree() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let t = b"T <t@example.com> 1600000000 +0000";
        let target = push_raw_commit(&repo, "b.txt", t, t, b"", b"target\n");
        let tip = push_raw_commit(&repo, "c.txt", t, t, b"", b"tip\n");
        std::fs::write(dir.join("a.txt"), "dirty").unwrap();
        assert!(reword_in(&repo, &target.to_string(), "reworded").is_err());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), tip);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "dirty");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interior_reword_replays_latin1_descendant_like_git() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let t = b"T <t@example.com> 1600000000 +0000";
        let target = push_raw_commit(&repo, "b.txt", t, t, b"", b"target\n");
        let l = b"Andr\xe9 <a@example.com> 1000000000 +0000";
        push_raw_commit(&repo, "c.txt", l, l, b"encoding ISO-8859-1\n", b"Corrig\xe9 le bug\n");
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        let c = repo.head().unwrap().peel_to_commit().unwrap();
        let raw = String::from_utf8(raw_object(&repo, c.id())).unwrap();
        assert!(!raw.contains("\nencoding "), "{raw}");
        assert!(raw.contains("\nauthor André <a@example.com> 1000000000 +0000\n"), "{raw}");
        assert_eq!(c.committer().name(), Ok("Test User"));
        assert_eq!(c.message_bytes(), "Corrigé le bug\n".as_bytes());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn orig_head(repo: &Repository) -> Option<git2::Oid> {
        repo.refname_to_id("ORIG_HEAD").ok()
    }

    const T: &[u8] = b"T <t@example.com> 1600000000 +0000";

    /// git's sequencer fast-forwards over commits whose parent is already the
    /// current base: rebasing onto a commit the branch already sits on must not
    /// rewrite anything (no new committer/timestamps, no transcoding).
    #[test]
    fn rebase_onto_current_base_leaves_the_branch_untouched() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let l = b"Andr\xe9 <a@example.com> 1000000000 +0000";
        push_raw_commit(&repo, "b.txt", l, l, b"encoding ISO-8859-1\n", b"Corrig\xe9\n");
        let tip = push_raw_commit(&repo, "c.txt", l, l, b"encoding ISO-8859-1\n", b"Autre\xe9\n");
        rebase_onto_impl(&repo, &base.to_string()).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), tip);
        assert_eq!(orig_head(&repo), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Reuse stops at the first commit that has to change; everything above it
    /// is rewritten.
    #[test]
    fn rebase_onto_reuses_leading_commits_then_rewrites_the_rest() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let first = push_raw_commit(&repo, "b.txt", T, T, b"", b"first\n");
        let second = push_raw_commit(&repo, "c.txt", T, T, b"", b"second\n");
        // Rebase onto `first`: only `second` is in range and already sits on it.
        rebase_onto_impl(&repo, &first.to_string()).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), second);
        // A diverged base rewrites every replayed commit.
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "t.txt", "t", "theirs");
        move_branch(&repo, second);
        rebase_onto_impl(&repo, &theirs.to_string()).unwrap();
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(tip.id(), second);
        assert_eq!(tip.summary(), Ok(Some("second")));
        let mid = tip.parent(0).unwrap();
        assert_ne!(mid.id(), first);
        assert_eq!(mid.summary(), Ok(Some("first")));
        assert_eq!(mid.parent_id(0).unwrap(), theirs);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interior_reword_keeps_commits_below_and_rewrites_descendants() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let below = push_raw_commit(&repo, "b.txt", T, T, b"", b"below\n");
        let target = push_raw_commit(&repo, "c.txt", T, T, b"", b"target\n");
        let desc = push_raw_commit(&repo, "d.txt", T, T, b"", b"desc\n");
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(tip.id(), desc);
        let mid = tip.parent(0).unwrap();
        assert_eq!(mid.summary(), Ok(Some("reworded")));
        assert_eq!(mid.parent_id(0).unwrap(), below);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interior_reword_records_orig_head() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let target = push_raw_commit(&repo, "b.txt", T, T, b"", b"target\n");
        let tip = push_raw_commit(&repo, "c.txt", T, T, b"", b"tip\n");
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        assert_eq!(orig_head(&repo), Some(tip));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rebase_onto_records_orig_head() {
        let (dir, repo) = crate::repo::test_support::make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let mine = commit_file(&repo, "m.txt", "m", "mine");
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "t.txt", "t", "theirs");
        move_branch(&repo, mine);
        rebase_onto_impl(&repo, &theirs.to_string()).unwrap();
        assert_eq!(orig_head(&repo), Some(mine));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn squash_records_orig_head() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let a = push_raw_commit(&repo, "b.txt", T, T, b"", b"a\n");
        let b = push_raw_commit(&repo, "c.txt", T, T, b"", b"b\n");
        // Squash at the tip.
        squash_in(&repo, &[a.to_string(), b.to_string()], "ab").unwrap();
        assert_eq!(orig_head(&repo), Some(b));
        // Interior squash (replays a descendant).
        let c = push_raw_commit(&repo, "d.txt", T, T, b"", b"c\n");
        let d = push_raw_commit(&repo, "e.txt", T, T, b"", b"d\n");
        let e = push_raw_commit(&repo, "f.txt", T, T, b"", b"e\n");
        squash_in(&repo, &[c.to_string(), d.to_string()], "cd").unwrap();
        assert_eq!(orig_head(&repo), Some(e));
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().summary(), Ok(Some("e")));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `git commit --amend` leaves ORIG_HEAD alone, so rewording HEAD must too.
    #[test]
    fn reword_of_head_does_not_touch_orig_head() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let tip = push_raw_commit(&repo, "b.txt", T, T, b"", b"tip\n");
        reword_in(&repo, &tip.to_string(), "reworded").unwrap();
        assert_eq!(orig_head(&repo), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A failed ref update (branch moved under us) must leave ORIG_HEAD alone.
    #[test]
    fn failed_replay_ref_update_leaves_orig_head_untouched() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let first = push_raw_commit(&repo, "b.txt", T, T, b"", b"first\n");
        let second = push_raw_commit(&repo, "c.txt", T, T, b"", b"second\n");
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "t.txt", "t", "theirs");
        move_branch(&repo, second);
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        let prior = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.reference("ORIG_HEAD", prior, true, "test").unwrap();
        // `first` is stale: the branch is already at `second`, so the guarded update fails.
        let sig = repo.signature().unwrap();
        assert!(replay_onto(&repo, &branch_ref, first, base, theirs, &sig, "conflict").is_err());
        assert_eq!(orig_head(&repo), Some(prior));
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), second);
        // Index and working tree still match the branch's tip: nothing was checked out.
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true);
        assert_eq!(repo.statuses(Some(&mut opts)).unwrap().len(), 0);
        assert!(dir.join("c.txt").exists());
        assert!(!dir.join("t.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `mine` (b.txt) and `theirs` (x.txt, based on the same `base`) with the
    /// branch at `mine` and an UNTRACKED x.txt in the working tree: replaying
    /// `mine` onto `theirs` works in memory, but checking out the new tip must be
    /// refused (it would overwrite the untracked file).
    fn collision_setup() -> (PathBuf, Repository, String, git2::Oid, git2::Oid, git2::Oid) {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        let mine = push_raw_commit(&repo, "b.txt", T, T, b"", b"mine\n");
        move_branch(&repo, base);
        let theirs = commit_file(&repo, "x.txt", "theirs", "theirs");
        move_branch(&repo, mine);
        std::fs::write(dir.join("x.txt"), "precious untracked").unwrap();
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        (dir, repo, branch_ref, mine, base, theirs)
    }

    fn checkout_entries(repo: &Repository) -> usize {
        let log = repo.reflog("HEAD").unwrap();
        log.iter().filter(|e| e.message().ok().flatten().is_some_and(|m| m.starts_with("checkout: moving from"))).count()
    }

    /// `git checkout -` (`@{-1}`) is derived from the HEAD reflog's
    /// "checkout: moving from X to Y" entries: a rewrite must not add any.
    #[test]
    fn rewrite_does_not_pollute_the_checkout_history() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let main_tip = push_raw_commit(&repo, "m.txt", T, T, b"", b"main\n");
        let main_ref = repo.head().unwrap().name().unwrap().to_owned();
        repo.branch("feature", &repo.find_commit(main_tip).unwrap(), false).unwrap();
        // What a checkout of `feature` leaves in the HEAD reflog.
        repo.set_head("refs/heads/feature").unwrap();
        let target = push_raw_commit(&repo, "b.txt", T, T, b"", b"target\n");
        push_raw_commit(&repo, "c.txt", T, T, b"", b"tip\n");
        assert_eq!(repo.revparse_single("@{-1}").unwrap().id(), main_tip, "sanity: {main_ref}");
        let before = checkout_entries(&repo);
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        assert_eq!(checkout_entries(&repo), before);
        assert_eq!(repo.revparse_single("@{-1}").unwrap().id(), main_tip);
        // HEAD is back on the branch, not detached.
        assert!(!repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().name(), Ok("refs/heads/feature"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refused_checkout_rolls_back_the_ref_and_orig_head() {
        let (dir, repo, branch_ref, mine, base, theirs) = collision_setup();
        let sig = repo.signature().unwrap();
        // A known ORIG_HEAD from some earlier operation is left as it was.
        repo.reference("ORIG_HEAD", base, true, "test").unwrap();
        assert!(replay_onto(&repo, &branch_ref, mine, base, theirs, &sig, "conflict").is_err());
        assert_eq!(repo.refname_to_id(&branch_ref).unwrap(), mine);
        assert_eq!(orig_head(&repo), Some(base));
        // No ORIG_HEAD before means none after.
        repo.find_reference("ORIG_HEAD").unwrap().delete().unwrap();
        assert!(replay_onto(&repo, &branch_ref, mine, base, theirs, &sig, "conflict").is_err());
        assert_eq!(repo.refname_to_id(&branch_ref).unwrap(), mine);
        assert_eq!(orig_head(&repo), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refused_checkout_leaves_tree_and_head_as_before() {
        let (dir, repo, branch_ref, mine, base, theirs) = collision_setup();
        let sig = repo.signature().unwrap();
        let before = checkout_entries(&repo);
        let err = replay_onto(&repo, &branch_ref, mine, base, theirs, &sig, "conflict").unwrap_err();
        assert!(!err.to_string().contains("rolled back"), "{err}");
        // Only the user's untracked file differs from the old tip.
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true);
        let statuses = repo.statuses(Some(&mut opts)).unwrap();
        let all: Vec<_> = statuses.iter().map(|s| (s.path().unwrap().to_owned(), s.status())).collect();
        assert_eq!(all, vec![("x.txt".to_owned(), git2::Status::WT_NEW)]);
        assert_eq!(std::fs::read_to_string(dir.join("x.txt")).unwrap(), "precious untracked");
        assert!(dir.join("b.txt").exists());
        assert!(!repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().name(), Ok(branch_ref.as_str()));
        assert_eq!(checkout_entries(&repo), before);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A checkout that died half way leaves new-tip files in the index and
    /// working tree: rolling back puts both back to the old tip (and keeps
    /// untracked files).
    #[test]
    fn rollback_restores_a_half_checked_out_tree() {
        let (dir, repo, branch_ref, mine, base, theirs) = collision_setup();
        std::fs::remove_file(dir.join("x.txt")).unwrap();
        // Half way: x.txt checked out and staged, b.txt (old tip's) gone.
        std::fs::write(dir.join("x.txt"), "theirs").unwrap();
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("x.txt")).unwrap();
        index.remove_path(Path::new("b.txt")).unwrap();
        index.write().unwrap();
        std::fs::write(dir.join("keep.txt"), "untracked").unwrap();
        // The ref was already moved to the new tip.
        repo.reference(&branch_ref, theirs, true, "test").unwrap();
        repo.set_head_detached(mine).unwrap();
        rollback_replay(&repo, &branch_ref, mine, theirs, Some(base)).unwrap();
        repo.set_head(&branch_ref).unwrap();
        assert_eq!(repo.refname_to_id(&branch_ref).unwrap(), mine);
        assert_eq!(orig_head(&repo), Some(base));
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true);
        let statuses = repo.statuses(Some(&mut opts)).unwrap();
        let all: Vec<_> = statuses.iter().map(|s| (s.path().unwrap().to_owned(), s.status())).collect();
        assert_eq!(all, vec![("keep.txt".to_owned(), git2::Status::WT_NEW)]);
        assert!(!dir.join("x.txt").exists());
        assert!(dir.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rollback_that_fails_is_reported_not_swallowed() {
        let (dir, repo, branch_ref, mine, base, theirs) = collision_setup();
        // The branch is not at `new_tip`, so moving it back is refused.
        let err = rollback_replay(&repo, &branch_ref, mine, theirs, Some(base)).unwrap_err();
        assert!(err.contains(&branch_ref), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn move_branch_records_orig_head_only_after_the_update_succeeds() {
        use crate::repo::test_support::*;
        let (dir, repo) = make_repo_with_commit();
        let a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let b = push_raw_commit(&repo, "b.txt", T, T, b"", b"b\n");
        let branch_ref = repo.head().unwrap().name().unwrap().to_owned();
        // Wrong expected value: the update is refused and ORIG_HEAD is not written.
        assert!(move_branch_recording_orig_head(&repo, &branch_ref, a, a, "test").is_err());
        assert_eq!(orig_head(&repo), None);
        move_branch_recording_orig_head(&repo, &branch_ref, a, b, "test").unwrap();
        assert_eq!(orig_head(&repo), Some(b));
        assert_eq!(repo.refname_to_id(&branch_ref).unwrap(), a);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Repo with a submodule `sub` committed on the default branch.
    fn repo_with_submodule() -> (PathBuf, Repository, PathBuf) {
        use crate::repo::test_support::*;
        let (sub_dir, _sub) = make_repo_with_commit();
        let (dir, repo) = make_repo_with_commit();
        let out = std::process::Command::new("git")
            .args(["-c", "protocol.file.allow=always", "submodule", "add"])
            .arg(sub_dir.to_str().unwrap().replace('\\', "/"))
            .arg("sub")
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        {
            let mut index = repo.index().unwrap();
            index.read(true).unwrap();
            index.add_path(Path::new(".gitmodules")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "add sub", &tree, &[&head]).unwrap();
        }
        (dir, repo, sub_dir)
    }

    #[test]
    fn rewrite_ignores_untracked_files_inside_a_submodule() {
        use crate::repo::test_support::*;
        let (dir, repo, sub_dir) = repo_with_submodule();
        let target = push_raw_commit(&repo, "b.txt", T, T, b"", b"target\n");
        push_raw_commit(&repo, "c.txt", T, T, b"", b"tip\n");
        std::fs::write(dir.join("sub").join("untracked.txt"), "scratch").unwrap();
        reword_in(&repo, &target.to_string(), "reworded").unwrap();
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(tip.summary(), Ok(Some("tip")));
        assert_eq!(tip.parent(0).unwrap().summary(), Ok(Some("reworded")));
        assert!(dir.join("sub").join("untracked.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(sub_dir);
    }

    /// Commits `.gitmodules` text (and optionally a gitlink at `ghost`) on HEAD.
    fn commit_gitmodules(repo: &Repository, dir: &Path, text: Option<&str>, gitlink: bool) {
        let mut index = repo.index().unwrap();
        if let Some(text) = text {
            std::fs::write(dir.join(".gitmodules"), text).unwrap();
            index.add_path(Path::new(".gitmodules")).unwrap();
        }
        if gitlink {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o160000,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: head.id(),
                flags: 0,
                flags_extended: 0,
                path: b"ghost".to_vec(),
            };
            index.add(&entry).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "add submodule entry", &tree, &[&head]).unwrap();
    }

    /// A stale/malformed submodule entry (no gitlink, or a gitlink with no
    /// `.gitmodules` entry or no checkout) can't hold user edits: it must not
    /// block rewriting an otherwise clean tree. Real tracked changes still do.
    #[test]
    fn rewrite_ignores_broken_submodule_entries() {
        use crate::repo::test_support::*;
        const GHOST: &str = "[submodule \"ghost\"]\n\tpath = ghost\n\turl = https://example.invalid/ghost.git\n";
        for (text, gitlink) in [(Some(GHOST), false), (Some(GHOST), true), (None, true), (Some("[submodule \"ghost\"]\n\tpath = ghost\n"), true), (Some("[submodule \"a\"]\n\tpath = ghost\n\turl = x\n[submodule \"b\"]\n\tpath = ghost\n"), true)] {
            let (dir, repo) = make_repo_with_commit();
            commit_gitmodules(&repo, &dir, text, gitlink);
            let target = push_raw_commit(&repo, "b.txt", T, T, b"", b"target\n");
            push_raw_commit(&repo, "c.txt", T, T, b"", b"tip\n");
            reword_in(&repo, &target.to_string(), "reworded").unwrap_or_else(|e| panic!("{text:?} {gitlink}: {e}"));
            let tip = repo.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(tip.parent(0).unwrap().summary(), Ok(Some("reworded")));
            std::fs::write(dir.join("a.txt"), "dirty").unwrap();
            assert!(reword_in(&repo, &tip.parent(0).unwrap().id().to_string(), "again").is_err());
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn rewrite_still_refuses_tracked_changes_in_or_around_a_submodule() {
        use crate::repo::test_support::*;
        let (dir, repo, sub_dir) = repo_with_submodule();
        let target = push_raw_commit(&repo, "b.txt", T, T, b"", b"target\n");
        let tip = push_raw_commit(&repo, "c.txt", T, T, b"", b"tip\n");
        // A tracked file edited inside the submodule's own working tree.
        std::fs::write(dir.join("sub").join("a.txt"), "changed").unwrap();
        assert!(reword_in(&repo, &target.to_string(), "reworded").is_err());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), tip);
        std::fs::write(dir.join("sub").join("a.txt"), "hello").unwrap();
        // A tracked change in the main repo.
        std::fs::write(dir.join("a.txt"), "dirty").unwrap();
        assert!(reword_in(&repo, &target.to_string(), "reworded").is_err());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(sub_dir);
    }

    /// A staged gitlink bump must be refused even when a malformed
    /// `.gitmodules` entry (duplicated path) breaks the submodule listing.
    #[test]
    fn rewrite_refuses_staged_gitlink_bump_despite_malformed_gitmodules() {
        use crate::repo::test_support::*;
        let (dir, repo, sub_dir) = repo_with_submodule();
        let git = |cwd: &Path, args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        let mut text = std::fs::read_to_string(dir.join(".gitmodules")).unwrap();
        text.push_str("[submodule \"dup\"]\n\tpath = sub\n\turl = x\n");
        std::fs::write(dir.join(".gitmodules"), text).unwrap();
        git(&dir, &["add", ".gitmodules"]);
        git(&dir, &["commit", "-m", "dup entry"]);
        let target = push_raw_commit(&repo, "b.txt", T, T, b"", b"target\n");
        let tip = push_raw_commit(&repo, "c.txt", T, T, b"", b"tip\n");
        let sub = dir.join("sub");
        git(&sub, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "bump"]);
        git(&dir, &["add", "sub"]);
        assert!(reword_in(&repo, &target.to_string(), "reworded").is_err());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), tip);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(sub_dir);
    }

    fn make_temp_dir() -> PathBuf {
        let id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("wpt_head_{}", id));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_repo() -> (PathBuf, Repository) {
        let dir = make_temp_dir();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        (dir, repo)
    }

    /// A freshly initialized repo has an unborn HEAD; head_info must report the
    /// pending branch name with no oid instead of erroring (which blanked the UI).
    #[test]
    fn head_info_reports_unborn_head() {
        let (dir, repo) = make_repo();
        let info = head_info(&repo).expect("unborn HEAD must not error");
        assert_eq!(info.oid, None);
        // git init writes HEAD as a symbolic ref to whatever init.defaultBranch is,
        // so assert only that the pending branch name came through.
        assert!(info.branch.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Checking out a branch that another worktree has checked out must be refused
    /// BEFORE any mutation — the working tree and HEAD in the checking-out worktree
    /// must be left exactly as they were.
    #[test]
    fn checkout_refuses_branch_checked_out_in_another_worktree() {
        use crate::repo::test_support::{add_worktree, make_repo_with_commit};

        let (main_dir, main_repo) = make_repo_with_commit();
        let main_branch = main_repo.head().unwrap().shorthand().unwrap().to_string();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        let before_head_name = wt_repo.head().unwrap().name().unwrap().to_string();
        let before_content = std::fs::read_to_string(wt_dir.join("a.txt")).unwrap();

        let err = do_checkout(&wt_repo, &format!("refs/heads/{}", main_branch), false)
            .expect_err("must refuse: branch is checked out in the main worktree");
        match err {
            Error::InvalidArg(msg) => {
                assert!(msg.contains(&main_branch), "message should name the branch: {msg}");
                assert!(msg.to_lowercase().contains("worktree"), "message should mention worktree: {msg}");
            }
            other => panic!("expected InvalidArg, got {:?}", other),
        }

        let after_head_name = wt_repo.head().unwrap().name().unwrap().to_string();
        assert_eq!(before_head_name, after_head_name, "HEAD must be unchanged");
        let after_content = std::fs::read_to_string(wt_dir.join("a.txt")).unwrap();
        assert_eq!(before_content, after_content, "working tree must be unchanged");

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    /// The original phantom-changes bug: a worktree's folder is deleted (not
    /// pruned), so `wt.validate()` fails and the old guard silently dropped it
    /// from `other_worktree_heads` — letting `checkout_tree` rewrite files before
    /// `set_head` refused. Checkout must be refused up front and leave the
    /// checking-out worktree's HEAD and files completely unchanged.
    #[test]
    fn checkout_refuses_branch_held_by_a_deleted_but_unpruned_worktree() {
        use crate::repo::test_support::{add_worktree, make_repo_with_commit};

        let (main_dir, main_repo) = make_repo_with_commit();
        let main_branch = main_repo.head().unwrap().shorthand().unwrap().to_string();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");
        drop(wt_repo);
        std::fs::remove_dir_all(&wt_dir).unwrap();

        let before_head_name = main_repo.head().unwrap().name().unwrap().to_string();
        let before_content = std::fs::read_to_string(main_dir.join("a.txt")).unwrap();

        let err = do_checkout(&main_repo, "refs/heads/feat", false)
            .expect_err("must refuse: feat is held by a deleted-but-unpruned worktree");
        match err {
            Error::InvalidArg(msg) => {
                assert!(msg.contains("feat"), "message should name the branch: {msg}");
                assert!(msg.contains("no longer exists"), "message should say the folder is gone: {msg}");
                assert!(msg.to_lowercase().contains("prune"), "message should suggest pruning: {msg}");
            }
            other => panic!("expected InvalidArg, got {:?}", other),
        }

        let after_head_name = main_repo.head().unwrap().name().unwrap().to_string();
        assert_eq!(before_head_name, after_head_name, "HEAD must be unchanged");
        assert_eq!(main_branch, before_head_name.rsplit('/').next().unwrap());
        let after_content = std::fs::read_to_string(main_dir.join("a.txt")).unwrap();
        assert_eq!(before_content, after_content, "working tree must be unchanged");

        let _ = std::fs::remove_dir_all(&main_dir);
    }

    /// Advance a commit chain by one empty commit on top of `parent`, without
    /// moving any ref. Used to simulate "the remote has moved ahead" without a
    /// real remote.
    fn advance_commit(repo: &Repository, parent: git2::Oid, msg: &str) -> git2::Oid {
        let parent_commit = repo.find_commit(parent).unwrap();
        let tree = parent_commit.tree().unwrap();
        let sig = repo.signature().unwrap();
        repo.commit(None, &sig, &sig, msg, &tree, &[&parent_commit]).unwrap()
    }

    /// `checkout_remote_branch`'s fast-forward path must refuse to move the local
    /// branch ref when another worktree has it checked out — otherwise that
    /// worktree's HEAD would silently point past its own working tree contents.
    #[test]
    fn checkout_remote_branch_fast_forward_refuses_when_checked_out_elsewhere() {
        use crate::repo::test_support::add_worktree;

        let (main_dir, main_repo) = make_repo();
        let sig = main_repo.signature().unwrap();
        let tree = main_repo.find_tree(main_repo.index().unwrap().write_tree().unwrap()).unwrap();
        let base_oid = main_repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();

        let (wt_dir, _wt_repo) = add_worktree(&main_repo, "feat", "feat");
        let feat_before = main_repo.find_branch("feat", git2::BranchType::Local).unwrap()
            .get().target().unwrap();
        assert_eq!(feat_before, base_oid);

        // Simulate the remote having moved ahead of local `feat`.
        let remote_oid = advance_commit(&main_repo, base_oid, "remote advance");
        main_repo.reference("refs/remotes/origin/feat", remote_oid, true, "test remote ref").unwrap();

        let err = checkout_remote_branch_impl(&main_repo, "origin/feat", false)
            .expect_err("must refuse: feat is checked out in the linked worktree");
        assert!(matches!(err, Error::InvalidArg(_)));

        let feat_after = main_repo.find_branch("feat", git2::BranchType::Local).unwrap()
            .get().target().unwrap();
        assert_eq!(feat_after, feat_before, "refs/heads/feat must not have moved");

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn reset_branch_to_remote_refuses_when_checked_out_elsewhere() {
        use crate::repo::test_support::add_worktree;

        let (main_dir, main_repo) = make_repo();
        let sig = main_repo.signature().unwrap();
        let tree = main_repo.find_tree(main_repo.index().unwrap().write_tree().unwrap()).unwrap();
        let base_oid = main_repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();

        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");
        let wt_file_before = std::fs::read_to_string(wt_dir.join("a.txt"));

        let remote_oid = advance_commit(&main_repo, base_oid, "remote advance");
        main_repo.reference("refs/remotes/origin/feat", remote_oid, true, "test remote ref").unwrap();

        let err = reset_branch_to_remote_impl(&main_repo, "origin/feat")
            .expect_err("must refuse: feat is checked out in the linked worktree");
        assert!(matches!(err, Error::InvalidArg(_)));

        let feat_after = main_repo.find_branch("feat", git2::BranchType::Local).unwrap()
            .get().target().unwrap();
        assert_eq!(feat_after, base_oid, "refs/heads/feat must not have moved");

        let wt_file_after = std::fs::read_to_string(wt_dir.join("a.txt"));
        assert_eq!(wt_file_before.ok(), wt_file_after.ok(), "other worktree's files must be untouched");

        let _ = wt_repo;
        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn delete_branch_refuses_when_checked_out_in_another_worktree() {
        use crate::repo::test_support::add_worktree;

        let (main_dir, main_repo) = make_repo();
        let sig = main_repo.signature().unwrap();
        let tree = main_repo.find_tree(main_repo.index().unwrap().write_tree().unwrap()).unwrap();
        main_repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();

        let (wt_dir, _wt_repo) = add_worktree(&main_repo, "feat", "feat");

        let err = delete_branch_impl(&main_repo, "feat")
            .expect_err("must refuse: feat is checked out in the linked worktree");
        match err {
            Error::InvalidArg(msg) => {
                assert!(msg.contains(&wt_dir.display().to_string()) || msg.to_lowercase().contains("worktree"),
                    "message should mention the worktree path: {msg}");
            }
            other => panic!("expected InvalidArg, got {:?}", other),
        }

        assert!(main_repo.find_branch("feat", git2::BranchType::Local).is_ok(), "branch must still exist");

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    /// Regression test: renaming a branch checked out in another worktree must
    /// update that worktree's HEAD to follow the new name (libgit2's
    /// `git_reference_rename` does this for us — no code change expected here).
    #[test]
    fn rename_branch_updates_other_worktrees_head() {
        use crate::repo::test_support::add_worktree;

        let (main_dir, main_repo) = make_repo();
        let sig = main_repo.signature().unwrap();
        let tree = main_repo.find_tree(main_repo.index().unwrap().write_tree().unwrap()).unwrap();
        main_repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();

        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        rename_branch_impl(&main_repo, "feat", "feat2").unwrap();

        let head_target = wt_repo.find_reference("HEAD").unwrap().symbolic_target().unwrap().unwrap().to_string();
        assert_eq!(head_target, "refs/heads/feat2");

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    /// Same refusal must apply even when the checking-out worktree currently has a
    /// detached HEAD — libgit2's own `set_head` guard only fires from a symbolic
    /// HEAD, so this path needs our own precheck.
    #[test]
    fn checkout_refuses_branch_checked_out_elsewhere_from_detached_head() {
        use crate::repo::test_support::{add_worktree, make_repo_with_commit};

        let (main_dir, main_repo) = make_repo_with_commit();
        let main_branch = main_repo.head().unwrap().shorthand().unwrap().to_string();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        let head_oid = wt_repo.head().unwrap().target().unwrap();
        wt_repo.set_head_detached(head_oid).unwrap();
        assert!(!wt_repo.head().unwrap().is_branch());

        let err = do_checkout(&wt_repo, &format!("refs/heads/{}", main_branch), false)
            .expect_err("must refuse even from a detached HEAD");
        assert!(matches!(err, Error::InvalidArg(_)));

        let head = wt_repo.head().unwrap();
        assert!(!head.is_branch(), "HEAD must still be detached");
        assert_eq!(head.target(), Some(head_oid));

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn repo_status_reports_repo_gone_when_worktree_deleted() {
        let (main_dir, main) = crate::repo::test_support::make_repo_with_commit();
        let (wt_dir, wt) = crate::repo::test_support::add_worktree(&main, "stgone2", "feat");
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let err = repo_status_impl(&wt).unwrap_err();
        assert!(err.to_string().starts_with("repo gone:"), "{err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn head_info_reports_branch_after_first_commit() {
        let (dir, repo) = make_repo();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let oid = repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();

        let info = head_info(&repo).unwrap();
        assert_eq!(info.oid.as_deref(), Some(oid.to_string().as_str()));
        assert!(info.branch.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }
}
