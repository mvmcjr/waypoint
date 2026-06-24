use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::error::{Error, Result};
use crate::repo::{RepoState, WatcherState};

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
pub fn open_repo(
    path: String,
    app: tauri::AppHandle,
    state: State<RepoState>,
    watchers: State<WatcherState>,
) -> Result<String> {
    let repo = git2::Repository::open(&path)
        .map_err(|_| Error::NotARepo(path.clone()))?;

    let id = path.clone();
    state.0.lock().unwrap().insert(id.clone(), repo);

    // Watch .git/ for external changes (commits, branch moves, fetches, etc.).
    // Skip .lock files (transient during any git op) and the index file
    // (updated on every stage/unstage — handled by the frontend's own polling).
    let git_dir = std::path::Path::new(&path).join(".git");
    let repo_id = id.clone();
    let app_handle = app.clone();

    match new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let relevant = events.iter().any(|e| {
            e.path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.ends_with(".lock") && n != "index")
                .unwrap_or(false)
        });
        if relevant {
            let _ = app_handle.emit("repo-changed", &repo_id);
        }
    }) {
        Ok(mut debouncer) => {
            let _ = debouncer.watcher().watch(&git_dir, RecursiveMode::Recursive);
            watchers.0.lock().unwrap().insert(id.clone(), debouncer);
        }
        Err(e) => eprintln!("FS watcher failed to start for {path}: {e}"),
    }

    Ok(id)
}

#[tauri::command]
pub fn list_refs(repo_id: String, state: State<RepoState>) -> Result<Vec<RefInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let head_oid = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
    let head_ref = repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_owned()));

    // Single pass: build RefInfo structs AND seed the BFS from remote tips.
    // Remote tracking refs are always direct commit refs, so their target_oid
    // seeds the BFS without calling peel_to_commit(). Local branches also use
    // target_oid directly (they point to commits). Only tags/other refs need
    // peel_to_commit() since annotated tags point to tag objects, not commits.
    let mut refs: Vec<RefInfo> = Vec::new();
    // Parallel to refs: the commit OID to check for reachability after BFS.
    // None means is_pushed is already resolved (remote refs = always true).
    let mut push_oids: Vec<Option<git2::Oid>> = Vec::new();
    let mut reachable_from_remote: HashSet<git2::Oid> = HashSet::new();
    let mut queue: VecDeque<git2::Oid> = VecDeque::new();

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

        let is_remote = name.starts_with("refs/remotes/");
        let kind = if name.starts_with("refs/heads/") {
            RefKind::LocalBranch
        } else if is_remote {
            if let Some(ref s) = target_oid {
                if let Ok(oid) = git2::Oid::from_str(s) {
                    if reachable_from_remote.insert(oid) {
                        queue.push_back(oid);
                    }
                }
            }
            RefKind::RemoteBranch
        } else if name.starts_with("refs/tags/") {
            RefKind::Tag
        } else {
            RefKind::Other
        };

        let is_head = head_ref.as_deref() == Some(&shorthand)
            || target_oid.as_deref() == head_oid.as_deref();

        // Collect the commit OID for the post-BFS reachability check.
        // Remote refs are always pushed; local branches use target_oid directly
        // (same as peel_to_commit for direct refs). Tags/Other may be annotated
        // so we peel to the commit now while the reference object is in scope.
        let push_oid = if is_remote {
            None
        } else if name.starts_with("refs/heads/") {
            target_oid.as_ref().and_then(|s| git2::Oid::from_str(s).ok())
        } else {
            reference.peel_to_commit().ok().map(|c| c.id())
        };

        refs.push(RefInfo { name, shorthand, kind, target_oid, is_head, is_pushed: is_remote });
        push_oids.push(push_oid);
    }

    while let Some(oid) = queue.pop_front() {
        if let Ok(commit) = repo.find_commit(oid) {
            for parent_id in commit.parent_ids() {
                if reachable_from_remote.insert(parent_id) {
                    queue.push_back(parent_id);
                }
            }
        }
    }

    for (r, oid) in refs.iter_mut().zip(push_oids.iter()) {
        if let Some(oid) = oid {
            r.is_pushed = reachable_from_remote.contains(oid);
        }
    }

    Ok(refs)
}
