use tauri::State;

use crate::error::{Error, Result};
use crate::graph::lanes::{assign_lanes, CommitNode};
use crate::graph::PositionedCommit;
use crate::repo::RepoState;

/// Walk the commit graph and return positioned commits for the timeline.
#[tauri::command]
pub fn walk_commits(
    repo_id: String,
    limit: Option<usize>,
    state: State<RepoState>,
) -> Result<Vec<PositionedCommit>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

    // Single pass: push refs to walk and build oid→refs maps.
    let mut ref_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut local_branch_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut remote_branch_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for reference in repo.references()? {
        if let Ok(r) = reference {
            let shorthand = r.shorthand().unwrap_or("").to_owned();
            let target = match r.kind() {
                Some(git2::ReferenceType::Direct) => r.target(),
                Some(git2::ReferenceType::Symbolic) => r.resolve().ok().and_then(|res| res.target()),
                None => None,
            };
            if let Some(oid) = target {
                let _ = walk.push(oid);
                let oid_s = oid.to_string();
                ref_map.entry(oid_s.clone()).or_default().push(shorthand.clone());
                if r.is_branch() {
                    local_branch_map.entry(oid_s.clone()).or_default().push(shorthand);
                } else if r.is_remote() {
                    remote_branch_map.entry(oid_s).or_default().push(shorthand);
                }
            }
        }
    }
    // Also push HEAD (covers detached HEAD) and tag it in ref_map so the frontend
    // can identify the current commit without a separate useHeadInfo call.
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            let _ = walk.push(oid);
            ref_map.entry(oid.to_string()).or_default().push("HEAD".to_owned());
        }
    }
    // A stash is not a single commit: its tip W has parents [base, index, untracked].
    // We want the timeline to show only the stash tip (as one "stash" node) — the
    // index/untracked helper commits are git plumbing and must not appear as rows
    // (otherwise the user could cherry-pick/merge them and corrupt the repo).
    //
    // So: push each stash tip, hide its helper parents, and remember each tip's
    // first parent so we can collapse its displayed parents to just the base.
    let mut hidden_stash_commits: std::collections::HashSet<git2::Oid> = std::collections::HashSet::new();
    let mut stash_tip_base: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(reflog) = repo.reflog("refs/stash") {
        for entry in reflog.iter() {
            let tip = entry.id_new();
            let _ = walk.push(tip);
            if let Ok(commit) = repo.find_commit(tip) {
                // Hide every parent except the first (the base commit).
                for i in 1..commit.parent_count() {
                    if let Ok(parent) = commit.parent_id(i) {
                        hidden_stash_commits.insert(parent);
                    }
                }
                if let Ok(base) = commit.parent_id(0) {
                    stash_tip_base.insert(tip.to_string(), base.to_string());
                }
            }
        }
    }

    // No limit = walk the entire graph. The timeline is virtualized and the graph
    // layout is O(commits), so loading everything is fine; the per-commit payload is
    // kept lean (body is fetched lazily via get_commit) to keep IPC transfer small.
    let cap = limit.unwrap_or(usize::MAX);
    let mut nodes: Vec<CommitNode> = Vec::new();

    for (i, oid) in walk.enumerate() {
        if i >= cap {
            break;
        }
        let oid = oid?;
        // Skip stash helper commits (the index/untracked parents) — plumbing only.
        if hidden_stash_commits.contains(&oid) {
            continue;
        }
        let commit = repo.find_commit(oid)?;
        let oid_s = oid.to_string();

        // For a stash tip, collapse its parents to just the base so the graph
        // doesn't draw edges to the now-hidden helper commits.
        let parent_oids: Vec<String> = if let Some(base) = stash_tip_base.get(&oid_s) {
            vec![base.clone()]
        } else {
            (0..commit.parent_count())
                .map(|i| commit.parent_id(i).map(|o| o.to_string()))
                .collect::<std::result::Result<_, _>>()?
        };

        let author = commit.author();
        let timestamp = commit.time().seconds();
        let summary = commit.summary().unwrap_or("").to_owned();
        // Body is intentionally omitted from the list payload (fetched lazily via
        // get_commit when a commit is selected) — keeps the walk light for big repos.
        let refs = ref_map.get(&oid_s).cloned().unwrap_or_default();
        let local_branches = local_branch_map.get(&oid_s).cloned().unwrap_or_default();
        let remote_branches = remote_branch_map.get(&oid_s).cloned().unwrap_or_default();

        nodes.push(CommitNode {
            oid: oid_s,
            parent_oids,
            summary,
            body: String::new(),
            author_name: author.name().unwrap_or("").to_owned(),
            author_email: author.email().unwrap_or("").to_owned(),
            timestamp,
            refs,
            local_branches,
            remote_branches,
        });
    }

    Ok(assign_lanes(nodes))
}

/// Pure logic behind `is_commit_in_ref`, taking a `&Repository` directly so it's
/// unit-testable without going through Tauri state.
///
/// `ref_name = None` checks against HEAD (including detached HEAD); `Some(name)`
/// resolves a local branch, a remote-tracking branch, or anything else
/// `revparse_single` accepts. An unborn HEAD (no commits yet) reports `false`
/// rather than erroring, matching `head_info`'s treatment of fresh repos.
fn commit_in_ref(repo: &git2::Repository, oid: &str, ref_name: Option<&str>) -> Result<bool> {
    let commit_oid = git2::Oid::from_str(oid).map_err(|_| Error::CommitNotFound(oid.to_owned()))?;

    let tip = match ref_name {
        None => match repo.head() {
            Ok(head) => match head.target() {
                Some(t) => t,
                None => return Ok(false),
            },
            Err(e) if matches!(e.code(), git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound) => {
                return Ok(false);
            }
            Err(e) => return Err(e.into()),
        },
        Some(name) => resolve_branch_name(repo, name)
            .ok_or_else(|| Error::InvalidArg(format!("branch not found: {name}")))?,
    };

    Ok(tip == commit_oid || repo.graph_descendant_of(tip, commit_oid)?)
}

/// Resolve `name` to a commit oid, preferring an actual branch over anything
/// `revparse_single` might otherwise guess it means. A branch name that happens
/// to look like a short hex oid (e.g. `cafe`) or that collides with a tag of the
/// same name must still resolve to the branch, not to the lookalike object —
/// so local, then remote-tracking branches are tried explicitly before falling
/// back to a general revparse.
fn resolve_branch_name(repo: &git2::Repository, name: &str) -> Option<git2::Oid> {
    for full_ref in [format!("refs/heads/{name}"), format!("refs/remotes/{name}")] {
        if let Some(oid) = repo
            .find_reference(&full_ref)
            .ok()
            .and_then(|r| r.peel_to_commit().ok())
            .map(|c| c.id())
        {
            return Some(oid);
        }
    }
    repo.revparse_single(name)
        .ok()
        .and_then(|obj| obj.peel_to_commit().ok())
        .map(|c| c.id())
}

/// True if `oid` is in the history of `ref_name` (or HEAD, when `ref_name` is
/// `None`) — i.e. it is the tip itself or one of its ancestors.
#[tauri::command]
pub fn is_commit_in_ref(
    repo_id: String,
    oid: String,
    ref_name: Option<String>,
    state: State<RepoState>,
) -> Result<bool> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    commit_in_ref(repo, &oid, ref_name.as_deref())
}

#[tauri::command]
pub fn get_commit(repo_id: String, oid: String, state: State<RepoState>) -> Result<CommitNode> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;

    let parent_oids: Vec<String> = (0..commit.parent_count())
        .map(|i| commit.parent_id(i).map(|o| o.to_string()))
        .collect::<std::result::Result<_, _>>()?;

    let author = commit.author();
    Ok(CommitNode {
        oid: git_oid.to_string(),
        parent_oids,
        summary: commit.summary().unwrap_or("").to_owned(),
        body: commit.body().unwrap_or("").trim().to_owned(),
        author_name: author.name().unwrap_or("").to_owned(),
        author_email: author.email().unwrap_or("").to_owned(),
        timestamp: commit.time().seconds(),
        refs: Vec::new(),
        local_branches: Vec::new(),
        remote_branches: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::PathBuf;

    fn make_temp_dir() -> PathBuf {
        let id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("wpt_history_{}", id));
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

    /// Create a commit object with the given parents (by oid), without moving
    /// any ref or HEAD. Every commit uses the (empty) root tree — content is
    /// irrelevant to ancestry, and the distinct message keeps oids unique.
    fn make_commit(repo: &Repository, message: &str, parents: &[git2::Oid]) -> git2::Oid {
        let sig = repo.signature().unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent_commits: Vec<git2::Commit> =
            parents.iter().map(|p| repo.find_commit(*p).unwrap()).collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        repo.commit(None, &sig, &sig, message, &tree, &parent_refs).unwrap()
    }

    /// Set up a repo with two branches:
    ///   main:    c1 -- c2
    ///   feature: c1 -- c3
    /// HEAD is checked out (non-detached) on `main`.
    struct TwoBranchRepo {
        dir: PathBuf,
        repo: Repository,
        c1: git2::Oid,
        c2: git2::Oid,
        c3: git2::Oid,
    }

    fn make_two_branch_repo() -> TwoBranchRepo {
        let (dir, repo) = make_repo();
        let c1 = make_commit(&repo, "c1", &[]);
        let c2 = make_commit(&repo, "c2", &[c1]);
        let c3 = make_commit(&repo, "c3", &[c1]);

        repo.reference("refs/heads/main", c2, false, "test").unwrap();
        repo.reference("refs/heads/feature", c3, false, "test").unwrap();
        repo.set_head("refs/heads/main").unwrap();

        TwoBranchRepo { dir, repo, c1, c2, c3 }
    }

    impl Drop for TwoBranchRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn ancestor_of_head_branch_is_true() {
        let r = make_two_branch_repo();
        assert!(commit_in_ref(&r.repo, &r.c1.to_string(), None).unwrap());
    }

    #[test]
    fn tip_of_head_branch_is_true() {
        let r = make_two_branch_repo();
        assert!(commit_in_ref(&r.repo, &r.c2.to_string(), None).unwrap());
    }

    #[test]
    fn commit_only_on_another_branch_is_false_against_head() {
        let r = make_two_branch_repo();
        assert!(!commit_in_ref(&r.repo, &r.c3.to_string(), None).unwrap());
    }

    #[test]
    fn named_branch_true_and_false_both_ways() {
        let r = make_two_branch_repo();
        // c3 is on feature, not main.
        assert!(commit_in_ref(&r.repo, &r.c3.to_string(), Some("feature")).unwrap());
        assert!(!commit_in_ref(&r.repo, &r.c2.to_string(), Some("feature")).unwrap());
        // c2 is on main, not feature.
        assert!(commit_in_ref(&r.repo, &r.c2.to_string(), Some("main")).unwrap());
        assert!(!commit_in_ref(&r.repo, &r.c3.to_string(), Some("main")).unwrap());
        // c1 is the shared ancestor — on both.
        assert!(commit_in_ref(&r.repo, &r.c1.to_string(), Some("main")).unwrap());
        assert!(commit_in_ref(&r.repo, &r.c1.to_string(), Some("feature")).unwrap());
    }

    #[test]
    fn ambiguous_name_prefers_branch_over_same_named_tag() {
        let (dir, repo) = make_repo();
        let c1 = make_commit(&repo, "c1", &[]);
        let c2 = make_commit(&repo, "c2", &[c1]);

        // A branch and a tag share the same name but point at different commits.
        repo.reference("refs/heads/ambiguous", c1, false, "test").unwrap();
        let c2_obj = repo.find_object(c2, None).unwrap();
        repo.tag_lightweight("ambiguous", &c2_obj, false).unwrap();

        // The branch (c1) must win over the tag (c2): checking c1 is true...
        assert!(commit_in_ref(&repo, &c1.to_string(), Some("ambiguous")).unwrap());
        // ...and checking c2 is false — c1 (the branch tip) is an ancestor of c2,
        // not the reverse, so this would flip to true if the tag won instead.
        assert!(!commit_in_ref(&repo, &c2.to_string(), Some("ambiguous")).unwrap());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn detached_head_checks_against_the_detached_commit() {
        let r = make_two_branch_repo();
        r.repo.set_head_detached(r.c3).unwrap();
        assert!(commit_in_ref(&r.repo, &r.c3.to_string(), None).unwrap());
        assert!(commit_in_ref(&r.repo, &r.c1.to_string(), None).unwrap());
        assert!(!commit_in_ref(&r.repo, &r.c2.to_string(), None).unwrap());
    }

    #[test]
    fn unborn_head_reports_false() {
        let (dir, repo) = make_repo();
        // No commits yet — HEAD is unborn. Use a well-formed but nonexistent oid;
        // the unborn check short-circuits before it would ever be looked up.
        let result = commit_in_ref(&repo, "0000000000000000000000000000000000000000", None);
        assert_eq!(result.unwrap(), false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unparseable_oid_errors() {
        let r = make_two_branch_repo();
        let err = commit_in_ref(&r.repo, "not-a-real-oid", None).unwrap_err();
        assert!(matches!(err, Error::CommitNotFound(_)));
    }

    #[test]
    fn unknown_branch_name_errors() {
        let r = make_two_branch_repo();
        let err = commit_in_ref(&r.repo, &r.c1.to_string(), Some("nope")).unwrap_err();
        match err {
            Error::InvalidArg(msg) => assert!(msg.contains("branch not found: nope")),
            other => panic!("expected InvalidArg, got {other:?}"),
        }
    }
}
