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
    /// For a local branch checked out in ANOTHER worktree, that worktree's
    /// working-directory path; `null` otherwise (including for this repo's own
    /// current branch, and for non-local-branch refs).
    pub worktree_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    Other,
}

/// Directories to watch for external repo changes (commits, branch moves,
/// fetches, etc.). In a normal repo that's just `<repo>/.git`. In a linked
/// worktree, `<wt>/.git` is a FILE (a "gitdir: ..." pointer) with no useful
/// content to watch, and the per-worktree state (HEAD, index, MERGE_HEAD...)
/// actually lives under `commondir()/worktrees/<name>/` — i.e. `repo.path()`
/// itself — while shared state (refs, objects, logs/refs/stash) lives in
/// `commondir()`. So watch `commondir()` always, plus `repo.path()` too
/// unless it's already nested inside `commondir()` (which is the common case
/// for a normal, non-worktree repo, and also covers `--separate-git-dir`).
pub(crate) fn watch_roots(repo: &git2::Repository) -> Vec<std::path::PathBuf> {
    let commondir = repo.commondir().to_path_buf();
    let repo_path = repo.path();

    let commondir_canon = std::fs::canonicalize(&commondir).unwrap_or_else(|_| commondir.clone());
    let repo_path_canon = std::fs::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());

    let mut roots = vec![commondir];
    if !repo_path_canon.starts_with(&commondir_canon) {
        roots.push(repo_path.to_path_buf());
    }
    roots
}

#[derive(Debug, Serialize)]
pub struct OpenedRepo {
    /// Canonical working-directory path; also the tab id and RepoState key.
    pub id: String,
    /// Set when the opened folder is a linked worktree (non-bare main repo).
    pub main_worktree_path: Option<String>,
}

#[tauri::command]
pub fn open_repo(
    path: String,
    app: tauri::AppHandle,
    state: State<RepoState>,
    watchers: State<WatcherState>,
) -> Result<OpenedRepo> {
    // Distinguish "folder is gone/unreadable" from "folder exists but isn't a repo":
    // only the latter should lead the UI to offer `git init` here.
    if !std::path::Path::new(&path).is_dir() {
        return Err(Error::InvalidArg(format!("folder does not exist: {path}")));
    }

    let canon = crate::repo::canonical_string(std::path::Path::new(&path));
    let repo = git2::Repository::open(&canon)
        .map_err(|_| Error::NotARepo(path.clone()))?;

    let main_worktree_path = crate::repo::main_worktree_path(&repo);

    // Compute the watch roots before `repo` is moved into the state map below.
    let roots = watch_roots(&repo);

    let id = canon.clone();
    state.0.lock().unwrap().insert(id.clone(), repo);

    // Watch the git dir(s) for external changes (commits, branch moves, fetches,
    // etc.). Skip .lock files (transient during any git op) and the index file
    // (updated on every stage/unstage — handled by the frontend's own polling).
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
            for root in &roots {
                if let Err(e) = debouncer.watcher().watch(root, RecursiveMode::Recursive) {
                    eprintln!("FS watcher failed to watch {} for {path}: {e}", root.display());
                }
            }
            watchers.0.lock().unwrap().insert(id.clone(), debouncer);
        }
        Err(e) => eprintln!("FS watcher failed to start for {path}: {e}"),
    }

    Ok(OpenedRepo { id, main_worktree_path })
}

#[derive(Debug, Serialize)]
pub struct InitTarget {
    /// Working-tree root of the repository this folder already sits inside, if any.
    /// `open_repo` uses `Repository::open` (not `discover`), so a subdirectory of a
    /// repo reports as "not a repository" — without this the init prompt would be a
    /// one-click way to bury a nested repo in someone's working tree.
    pub enclosing_repo: Option<String>,
}

/// Inspect a folder before offering to initialize a repository in it.
#[tauri::command]
pub fn check_init_target(path: String) -> Result<InitTarget> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(Error::InvalidArg(format!("folder does not exist: {path}")));
    }

    let enclosing_repo = git2::Repository::discover(dir).ok().map(|existing| {
        existing
            .workdir()
            .unwrap_or_else(|| existing.path())
            .display()
            .to_string()
    });

    Ok(InitTarget { enclosing_repo })
}

/// Create a new git repository at `path`. The caller is expected to follow up
/// with `open_repo` — this only lays down `.git/` so the open can succeed.
///
/// Refuses to create the folder itself, and refuses to nest inside an existing
/// repository unless `allow_nested` is set — the UI only sets it after showing the
/// user which repository they would be nesting inside.
#[tauri::command]
pub fn init_repo(path: String, allow_nested: bool) -> Result<()> {
    let target = check_init_target(path.clone())?;
    let dir = std::path::Path::new(&path);

    if let Some(root) = target.enclosing_repo {
        if !allow_nested {
            return Err(Error::InvalidArg(format!(
                "this folder is already inside the Git repository at {root}"
            )));
        }
    }

    git2::Repository::init(dir)?;
    Ok(())
}

#[tauri::command]
pub fn list_refs(repo_id: String, state: State<RepoState>) -> Result<Vec<RefInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    list_refs_impl(repo)
}

fn list_refs_impl(repo: &git2::Repository) -> Result<Vec<RefInfo>> {
    // Computed once per call (not per ref) since it walks every worktree.
    let other_heads = crate::repo::other_worktree_heads(repo);

    // The symbolic target of THIS tab's HEAD (e.g. "refs/heads/main"), so
    // `is_head` below matches by ref identity, not by "happens to point at the
    // same commit" — a `None` here (detached HEAD) means no local branch is
    // ever `is_head`.
    let head_symbolic_target = repo
        .find_reference("HEAD")
        .ok()
        .and_then(|h| h.symbolic_target().map(|t| t.to_owned()));

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

        // Only THIS tab's actual checked-out local branch is `is_head` — not any
        // ref (including a remote-tracking branch) that merely happens to share
        // HEAD's commit, and never true when HEAD is detached (no symbolic
        // target). A branch whose tip commit equals HEAD's commit right after
        // `git worktree add ../x -b feat` must not read as "current" here.
        let is_head = matches!(kind, RefKind::LocalBranch)
            && head_symbolic_target.as_deref() == Some(name.as_str());

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

        let worktree_path = if matches!(kind, RefKind::LocalBranch) {
            other_heads.get(&name).map(|p| p.display().to_string())
        } else {
            None
        };

        refs.push(RefInfo { name, shorthand, kind, target_oid, is_head, is_pushed: is_remote, worktree_path });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wpt_{}_{}", prefix, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn check_init_target_reports_no_enclosing_repo_for_plain_folder() {
        let dir = temp_dir("plain");
        let target = check_init_target(dir.display().to_string()).unwrap();
        assert_eq!(target.enclosing_repo, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn check_init_target_detects_enclosing_repo() {
        let dir = temp_dir("outer");
        git2::Repository::init(&dir).unwrap();
        let nested = dir.join("sub");
        std::fs::create_dir_all(&nested).unwrap();

        let target = check_init_target(nested.display().to_string()).unwrap();
        assert!(target.enclosing_repo.is_some(), "subdirectory must report its parent repo");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Nesting a repo inside another is only allowed after the UI has shown the user
    /// which repository they would be nesting inside.
    #[test]
    fn init_repo_requires_opt_in_to_nest() {
        let dir = temp_dir("nest");
        git2::Repository::init(&dir).unwrap();
        let nested = dir.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        let path = nested.display().to_string();

        assert!(init_repo(path.clone(), false).is_err(), "must refuse by default");
        assert!(!nested.join(".git").exists());

        init_repo(path, true).unwrap();
        assert!(nested.join(".git").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn init_repo_refuses_missing_folder() {
        let missing = std::env::temp_dir().join(format!("wpt_missing_{}", uuid::Uuid::new_v4()));
        assert!(init_repo(missing.display().to_string(), false).is_err());
        assert!(!missing.exists(), "must not create the folder");
    }

    #[test]
    fn watch_roots_for_normal_repo_is_just_dot_git() {
        let dir = temp_dir("plainrepo");
        let repo = git2::Repository::init(&dir).unwrap();

        let roots = watch_roots(&repo);

        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0], dir.join(".git"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn watch_roots_for_linked_worktree_is_commondir_only() {
        use crate::repo::test_support::{add_worktree, make_repo_with_commit};

        let (main_dir, main_repo) = make_repo_with_commit();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        let roots = watch_roots(&wt_repo);

        let commondir = std::fs::canonicalize(wt_repo.commondir()).unwrap();
        assert_eq!(roots.len(), 1, "expected exactly one watch root: {:?}", roots);
        assert_eq!(std::fs::canonicalize(&roots[0]).unwrap(), commondir);

        // repo.path() (the per-worktree state dir) must lie under commondir.
        let repo_path = std::fs::canonicalize(wt_repo.path()).unwrap();
        assert!(repo_path.starts_with(&commondir));

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn list_refs_reports_worktree_path_only_for_the_other_worktrees_branch() {
        use crate::repo::test_support::{add_worktree, make_repo_with_commit};

        let (main_dir, main_repo) = make_repo_with_commit();
        let main_branch = main_repo.head().unwrap().shorthand().unwrap().to_string();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");
        let expected_wt_path = crate::repo::canonical_string(wt_repo.workdir().unwrap());

        let refs = list_refs_impl(&main_repo).unwrap();

        let feat_ref = refs.iter().find(|r| r.name == "refs/heads/feat")
            .expect("feat branch must be listed");
        assert_eq!(feat_ref.worktree_path.as_deref(), Some(expected_wt_path.as_str()));

        let main_ref = refs.iter().find(|r| r.name == format!("refs/heads/{}", main_branch))
            .expect("main branch must be listed");
        assert_eq!(main_ref.worktree_path, None, "own current branch must not report a worktree_path");

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    /// `is_head` must mean "this tab's checked-out branch" only — not any ref
    /// (local, remote, or otherwise) that merely shares HEAD's commit oid. A
    /// branch other than HEAD whose tip happens to equal HEAD's commit (the
    /// state right after `git worktree add ../x -b other` at the current tip)
    /// must read as NOT current; a remote ref at the same commit must never be
    /// painted as current either; and a detached HEAD must give no `is_head`.
    #[test]
    fn is_head_matches_only_this_tabs_checked_out_branch() {
        use crate::repo::test_support::make_repo_with_commit;

        let (dir, repo) = make_repo_with_commit();
        let head_branch = repo.head().unwrap().shorthand().unwrap().to_string();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();

        // Another local branch at the exact same commit as HEAD.
        repo.branch("other", &head_commit, false).unwrap();
        // A remote-tracking ref at the same commit.
        repo.reference("refs/remotes/origin/main", head_commit.id(), true, "test").unwrap();

        let refs = list_refs_impl(&repo).unwrap();
        let head_ref = refs.iter().find(|r| r.name == format!("refs/heads/{head_branch}")).unwrap();
        assert!(head_ref.is_head, "the actually checked-out branch must be is_head");

        let other_ref = refs.iter().find(|r| r.name == "refs/heads/other").unwrap();
        assert!(!other_ref.is_head, "a branch merely sharing HEAD's commit must not be is_head");

        let remote_ref = refs.iter().find(|r| r.name == "refs/remotes/origin/main").unwrap();
        assert!(!remote_ref.is_head, "a remote ref must never be is_head");

        // Detached HEAD: no local branch is is_head, including the one HEAD used to be on.
        repo.set_head_detached(head_commit.id()).unwrap();
        let refs_detached = list_refs_impl(&repo).unwrap();
        assert!(refs_detached.iter().all(|r| !r.is_head), "detached HEAD must give no is_head at all");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_refs_worktree_path_is_none_for_remotes_and_tags() {
        use crate::repo::test_support::make_repo_with_commit;

        let (dir, repo) = make_repo_with_commit();
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.tag_lightweight("v1", &repo.find_object(head_oid, None).unwrap(), false).unwrap();
        repo.reference("refs/remotes/origin/main", head_oid, true, "test remote ref").unwrap();

        let refs = list_refs_impl(&repo).unwrap();
        for r in &refs {
            if !matches!(r.kind, RefKind::LocalBranch) {
                assert_eq!(r.worktree_path, None, "{} must not report a worktree_path", r.name);
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
