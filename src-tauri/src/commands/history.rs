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
    // Also push HEAD (covers detached HEAD).
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            let _ = walk.push(oid);
        }
    }
    // Push every stash reflog entry so all stash commits appear in the timeline.
    if let Ok(reflog) = repo.reflog("refs/stash") {
        for entry in reflog.iter() {
            let _ = walk.push(entry.id_new());
        }
    }

    let limit = limit.unwrap_or(2000);
    let mut nodes: Vec<CommitNode> = Vec::with_capacity(limit.min(512));

    for oid in walk.take(limit) {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;

        let parent_oids: Vec<String> = (0..commit.parent_count())
            .map(|i| commit.parent_id(i).map(|o| o.to_string()))
            .collect::<std::result::Result<_, _>>()?;

        let author = commit.author();
        let timestamp = commit.time().seconds();
        let summary = commit.summary().unwrap_or("").to_owned();
        let oid_s = oid.to_string();
        let refs = ref_map.get(&oid_s).cloned().unwrap_or_default();
        let local_branches = local_branch_map.get(&oid_s).cloned().unwrap_or_default();
        let remote_branches = remote_branch_map.get(&oid_s).cloned().unwrap_or_default();

        nodes.push(CommitNode {
            oid: oid_s,
            parent_oids,
            summary,
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
        summary: commit.message().unwrap_or("").to_owned(),
        author_name: author.name().unwrap_or("").to_owned(),
        author_email: author.email().unwrap_or("").to_owned(),
        timestamp: commit.time().seconds(),
        refs: Vec::new(),
        local_branches: Vec::new(),
        remote_branches: Vec::new(),
    })
}
