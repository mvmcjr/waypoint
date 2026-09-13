use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::{canonical_path, RepoState};

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WorktreeInfo {
    pub path: String,
    pub name: String,
    pub is_main: bool,
    pub is_current: bool,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_detached: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    pub is_missing: bool,
    pub branch_merged: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WorktreeStatus {
    pub changed: usize,
    pub conflicted: bool,
}

struct HeadState {
    branch: Option<String>,
    oid: Option<git2::Oid>,
    detached: bool,
}

fn head_state(r: &git2::Repository) -> HeadState {
    let oid = r.head().ok().and_then(|h| h.target());
    match r.find_reference("HEAD") {
        Ok(h) => match h.symbolic_target() {
            Some(t) => HeadState {
                branch: Some(t.strip_prefix("refs/heads/").unwrap_or(t).to_owned()),
                oid,
                detached: false,
            },
            None => HeadState { branch: None, oid, detached: true },
        },
        Err(_) => HeadState { branch: None, oid: None, detached: false },
    }
}

fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// Branch tip reachable from `current_head` (equal counts): safe to delete after removal.
fn is_merged(repo: &git2::Repository, current_head: Option<git2::Oid>, tip: Option<git2::Oid>) -> bool {
    match (current_head, tip) {
        (Some(h), Some(t)) => h == t || repo.graph_descendant_of(h, t).unwrap_or(false),
        _ => false,
    }
}

pub(crate) fn list_worktrees_impl(repo: &git2::Repository) -> Result<Vec<WorktreeInfo>> {
    let current_workdir = repo.workdir().map(canonical_path);
    let current_head = repo.head().ok().and_then(|h| h.target());
    let mut out: Vec<WorktreeInfo> = Vec::new();

    // Main worktree: `repo` itself, or the repo at commondir when `repo` is linked.
    let main_owned;
    let main: Option<&git2::Repository> = if repo.is_worktree() {
        main_owned = git2::Repository::open(repo.commondir()).ok();
        main_owned.as_ref()
    } else {
        Some(repo)
    };
    if let Some(m) = main.filter(|m| !m.is_bare()) {
        if let Some(wd) = m.workdir() {
            let path = canonical_path(wd);
            let h = head_state(m);
            let is_current = current_workdir.as_ref() == Some(&path);
            out.push(WorktreeInfo {
                name: folder_name(&path),
                path: path.to_string_lossy().into_owned(),
                is_main: true,
                is_current,
                branch_merged: !is_current && h.branch.is_some() && is_merged(repo, current_head, h.oid),
                branch: h.branch,
                head_oid: h.oid.map(|o| o.to_string()),
                is_detached: h.detached,
                is_locked: false,
                lock_reason: None,
                is_missing: false,
            });
        }
    }

    let mut linked: Vec<WorktreeInfo> = Vec::new();
    for name in repo.worktrees()?.iter().flatten() {
        let Ok(wt) = repo.find_worktree(name) else { continue };
        let path = canonical_path(wt.path());
        let (is_locked, lock_reason) = match wt.is_locked() {
            Ok(git2::WorktreeLockStatus::Locked(reason)) => {
                // The git CLI (`git worktree lock --reason "..."`) writes the reason
                // with a trailing newline; trim it, and treat an empty reason as none.
                let reason = reason.map(|r| r.trim().to_owned()).filter(|r| !r.is_empty());
                (true, reason)
            }
            _ => (false, None),
        };
        let is_missing = wt.validate().is_err();
        let h = if is_missing {
            HeadState { branch: None, oid: None, detached: false }
        } else {
            git2::Repository::open_from_worktree(&wt)
                .map(|r| head_state(&r))
                .unwrap_or(HeadState { branch: None, oid: None, detached: false })
        };
        let is_current = current_workdir.as_ref() == Some(&path);
        linked.push(WorktreeInfo {
            name: folder_name(&path),
            path: path.to_string_lossy().into_owned(),
            is_main: false,
            is_current,
            branch_merged: !is_current && h.branch.is_some() && is_merged(repo, current_head, h.oid),
            branch: h.branch,
            head_oid: h.oid.map(|o| o.to_string()),
            is_detached: h.detached,
            is_locked,
            lock_reason,
            is_missing,
        });
    }
    linked.sort_by_key(|w| w.name.to_lowercase());
    out.extend(linked);
    Ok(out)
}

#[tauri::command]
pub fn list_worktrees(repo_id: String, state: State<RepoState>) -> Result<Vec<WorktreeInfo>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    list_worktrees_impl(repo)
}

/// Opens its OWN handle: never touches RepoState, so a slow scan can't stall other commands.
pub(crate) fn worktree_status_impl(path: &Path) -> Result<WorktreeStatus> {
    if !path.exists() {
        return Err(Error::RepoGone(path.display().to_string()));
    }
    let repo = git2::Repository::open(path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let changed = statuses.iter().filter(|e| e.status() != git2::Status::CURRENT).count();
    let conflicted = statuses.iter().any(|e| e.status().contains(git2::Status::CONFLICTED));
    Ok(WorktreeStatus { changed, conflicted })
}

#[tauri::command]
pub async fn worktree_status(path: String) -> Result<WorktreeStatus> {
    tauri::async_runtime::spawn_blocking(move || worktree_status_impl(&PathBuf::from(path)))
        .await
        .map_err(|e| Error::InvalidArg(e.to_string()))?
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RemoveResult {
    pub branch_deleted: bool,
    pub branch_kept_reason: Option<String>,
}

/// Blocking git CLI call (same credential/safety behaviour as the terminal).
pub(crate) fn run_git_blocking(dir: &Path, args: &[&str]) -> Result<()> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir).args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| Error::InvalidArg(format!("failed to run git: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr };
    Err(Error::InvalidArg(msg.trim().to_string()))
}

struct RemovalPlan {
    run_dir: PathBuf,
    target: String,
    branch: Option<String>,
}

fn plan_removal(repo: &git2::Repository, path: &str, force: bool) -> Result<RemovalPlan> {
    let wanted = canonical_path(Path::new(path));
    let list = list_worktrees_impl(repo)?;
    let entry = list
        .iter()
        .find(|w| Path::new(&w.path) == wanted.as_path())
        .or_else(|| {
            // A missing folder can't be canonicalized; fall back to the folder name.
            let name = wanted.file_name()?.to_string_lossy().into_owned();
            list.iter().find(|w| w.is_missing && w.name == name)
        })
        .ok_or_else(|| Error::InvalidArg(format!("Not a worktree of this repository: {path}")))?;

    if entry.is_main {
        return Err(Error::InvalidArg("The main worktree can't be removed.".into()));
    }
    if entry.is_current {
        return Err(Error::InvalidArg(format!(
            "This tab has '{}' open. Remove it from another worktree's tab.", entry.name
        )));
    }
    if entry.is_missing {
        return Err(Error::InvalidArg(format!(
            "'{}' no longer exists on disk. Use Prune missing instead.", entry.name
        )));
    }
    if entry.is_locked {
        let why = entry.lock_reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default();
        return Err(Error::InvalidArg(format!(
            "'{}' is locked{why}. Unlock it in a terminal: git worktree unlock {}", entry.name, entry.path
        )));
    }
    if !force {
        let st = worktree_status_impl(Path::new(&entry.path))?;
        if st.changed > 0 {
            return Err(Error::InvalidArg(format!(
                "'{}' has {} uncommitted change(s). Remove anyway to discard them.", entry.name, st.changed
            )));
        }
    }
    Ok(RemovalPlan {
        run_dir: crate::repo::workdir(repo)?,
        target: entry.path.clone(),
        branch: entry.branch.clone(),
    })
}

/// The `git worktree remove` call already succeeded by the time this runs, so the
/// worktree is gone either way. Never returns `Err`: any failure inspecting or
/// deleting the branch (e.g. it was deleted externally between planning and this
/// step) is reported as a kept branch, not a failed removal.
fn delete_branch_if_merged(repo: &git2::Repository, branch: &str) -> Result<RemoveResult> {
    let kept = |reason: String| RemoveResult { branch_deleted: false, branch_kept_reason: Some(reason) };
    let mut b = match repo.find_branch(branch, git2::BranchType::Local) {
        Ok(b) => b,
        Err(e) => return Ok(kept(format!("Kept '{branch}': {e}"))),
    };
    let tip = b.get().target();
    let head = repo.head().ok().and_then(|h| h.target());
    if is_merged(repo, head, tip) {
        if let Err(e) = b.delete() {
            return Ok(kept(format!("Kept '{branch}': {e}")));
        }
        Ok(RemoveResult { branch_deleted: true, branch_kept_reason: None })
    } else {
        Ok(kept(format!("Kept '{branch}': not merged into the current branch.")))
    }
}

/// Re-acquires the lock (dropped after the git call in `remove_worktree_blocking`)
/// to run the branch-delete step. Also never returns `Err`: if the tab was closed
/// mid-removal, the repo id may no longer be in `repos` even though the worktree
/// was removed successfully — that must still be reported as a kept branch.
fn finish_branch_delete(
    repos: &std::sync::Mutex<std::collections::HashMap<String, git2::Repository>>,
    repo_id: &str,
    branch: &str,
) -> Result<RemoveResult> {
    let guard = repos.lock().unwrap();
    match guard.get(repo_id) {
        Some(repo) => delete_branch_if_merged(repo, branch),
        None => {
            let e = Error::RepoNotFound(repo_id.to_owned());
            Ok(RemoveResult { branch_deleted: false, branch_kept_reason: Some(format!("Kept '{branch}': {e}")) })
        }
    }
}

/// Lock → plan → UNLOCK → `git worktree remove` → lock → optional branch delete.
/// The shared lock is never held while git deletes files (can take seconds).
pub(crate) fn remove_worktree_blocking(
    repos: &std::sync::Mutex<std::collections::HashMap<String, git2::Repository>>,
    repo_id: &str,
    path: &str,
    force: bool,
    delete_branch: bool,
) -> Result<RemoveResult> {
    let plan = {
        let guard = repos.lock().unwrap();
        let repo = guard.get(repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.to_owned()))?;
        plan_removal(repo, path, force)?
    };
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&plan.target);
    run_git_blocking(&plan.run_dir, &args)?;

    if let (true, Some(branch)) = (delete_branch, plan.branch.as_deref()) {
        return finish_branch_delete(repos, repo_id, branch);
    }
    Ok(RemoveResult { branch_deleted: false, branch_kept_reason: None })
}

#[tauri::command]
pub async fn remove_worktree(
    app: tauri::AppHandle,
    repo_id: String,
    path: String,
    force: bool,
    delete_branch: bool,
) -> Result<RemoveResult> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RepoState>();
        remove_worktree_blocking(&state.0, &repo_id, &path, force, delete_branch)
    })
    .await
    .map_err(|e| Error::InvalidArg(e.to_string()))?
}

#[tauri::command]
pub async fn prune_worktrees(app: tauri::AppHandle, repo_id: String) -> Result<()> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RepoState>();
        let dir = {
            let guard = state.0.lock().unwrap();
            let repo = guard.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
            crate::repo::workdir(repo)?
        };
        run_git_blocking(&dir, &["worktree", "prune"])
    })
    .await
    .map_err(|e| Error::InvalidArg(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::test_support::{add_worktree, make_repo_with_commit};
    use crate::repo::canonical_string;

    fn by_name<'a>(v: &'a [WorktreeInfo], name_contains: &str) -> &'a WorktreeInfo {
        v.iter().find(|w| w.path.contains(name_contains)).expect("worktree listed")
    }

    #[test]
    fn lists_main_first_then_linked_with_current_flag() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "lw1", "feat");
        let from_main = list_worktrees_impl(&main).unwrap();
        assert_eq!(from_main.len(), 2);
        assert!(from_main[0].is_main && from_main[0].is_current);
        assert_eq!(from_main[0].path, canonical_string(&main_dir));
        let linked = &from_main[1];
        assert!(!linked.is_main && !linked.is_current);
        assert_eq!(linked.path, canonical_string(&wt_dir));
        assert_eq!(linked.branch.as_deref(), Some("feat"));
        assert!(!linked.is_detached && !linked.is_missing && !linked.is_locked);

        let from_wt = list_worktrees_impl(&wt).unwrap();
        assert!(from_wt[0].is_main && !from_wt[0].is_current);
        assert!(by_name(&from_wt, "lw1").is_current);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn detached_worktree_reports_short_state() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "det", "feat");
        let oid = wt.head().unwrap().target().unwrap();
        wt.set_head_detached(oid).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = by_name(&list, "det");
        assert!(w.is_detached);
        assert_eq!(w.branch, None);
        assert_eq!(w.head_oid.as_deref(), Some(oid.to_string().as_str()));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn locked_worktree_reports_reason() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "lck", "feat");
        let name = main.worktrees().unwrap().iter().flatten().next().unwrap().to_owned();
        main.find_worktree(&name).unwrap().lock(Some("agent running")).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = by_name(&list, "lck");
        assert!(w.is_locked);
        assert_eq!(w.lock_reason.as_deref(), Some("agent running"));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn missing_worktree_folder_is_flagged_not_fatal() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "miss", "feat");
        let expected_path = canonical_string(&wt_dir);
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = list.iter().find(|w| !w.is_main).unwrap();
        assert!(w.is_missing);
        assert!(w.path.ends_with(expected_path.rsplit(['/', '\\']).next().unwrap()));
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn bare_main_repo_is_omitted() {
        let (src_dir, _src) = make_repo_with_commit();
        let bare_dir = crate::repo::test_support::make_temp_dir("bare");
        let bare = git2::build::RepoBuilder::new()
            .bare(true)
            .clone(&src_dir.to_string_lossy(), &bare_dir.join("b.git"))
            .unwrap();
        let (wt_dir, wt) = add_worktree(&bare, "frombare", "feat");
        let list = list_worktrees_impl(&wt).unwrap();
        assert!(list.iter().all(|w| !w.is_main), "bare main must not be listed");
        assert_eq!(list.len(), 1);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(bare_dir);
        let _ = std::fs::remove_dir_all(src_dir);
    }

    #[test]
    fn branch_merged_true_only_when_tip_reachable_from_current_head() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "mrg", "feat");
        // feat == main HEAD → merged
        assert!(by_name(&list_worktrees_impl(&main).unwrap(), "mrg").branch_merged);
        // commit on feat in the worktree → not merged into main
        std::fs::write(wt_dir.join("n.txt"), "x").unwrap();
        let mut idx = wt.index().unwrap();
        idx.add_path(std::path::Path::new("n.txt")).unwrap();
        idx.write().unwrap();
        let tree = wt.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = wt.signature().unwrap();
        let parent = wt.head().unwrap().peel_to_commit().unwrap();
        wt.commit(Some("HEAD"), &sig, &sig, "feat work", &tree, &[&parent]).unwrap();
        assert!(!by_name(&list_worktrees_impl(&main).unwrap(), "mrg").branch_merged);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn worktree_status_counts_staged_unstaged_untracked() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "st", "feat");
        assert_eq!(worktree_status_impl(&wt_dir).unwrap(), WorktreeStatus { changed: 0, conflicted: false });
        std::fs::write(wt_dir.join("a.txt"), "changed").unwrap(); // unstaged
        std::fs::write(wt_dir.join("new.txt"), "new").unwrap();   // untracked
        std::fs::write(wt_dir.join("staged.txt"), "s").unwrap();
        let mut idx = wt.index().unwrap();
        idx.add_path(std::path::Path::new("staged.txt")).unwrap();
        idx.write().unwrap();
        assert_eq!(worktree_status_impl(&wt_dir).unwrap().changed, 3);
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn worktree_status_on_missing_folder_is_repo_gone() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "stgone", "feat");
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let err = worktree_status_impl(&wt_dir).unwrap_err();
        assert!(err.to_string().starts_with("repo gone:"), "got {err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    fn state_with(repo_id: &str, repo: git2::Repository)
        -> std::sync::Mutex<std::collections::HashMap<String, git2::Repository>> {
        let mut m = std::collections::HashMap::new();
        m.insert(repo_id.to_owned(), repo);
        std::sync::Mutex::new(m)
    }

    #[test]
    fn remove_refuses_main_and_current() {
        let (main_dir, main) = make_repo_with_commit();
        let main_path = canonical_string(&main_dir);
        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &main_path, false, false).unwrap_err();
        assert!(err.to_string().contains("main worktree"), "{err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_current_worktree() {
        // Ruling R1: put a LINKED worktree's own repo in the state map under an id,
        // and try to remove it via its own canonical path.
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "rmcurrent", "feat");
        let wt_path = canonical_string(&wt_dir);
        let st = state_with("w", wt);
        let err = remove_worktree_blocking(&st, "w", &wt_path, false, false).unwrap_err();
        assert!(err.to_string().contains("This tab has"), "{err}");
        assert!(wt_dir.exists());
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_dirty_without_force_then_force_removes() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmdirty", "feat");
        std::fs::write(wt_dir.join("wip.txt"), "wip").unwrap();
        let st = state_with("m", main);
        let p = canonical_string(&wt_dir);
        let err = remove_worktree_blocking(&st, "m", &p, false, false).unwrap_err();
        assert!(err.to_string().contains("uncommitted"), "{err}");
        assert!(wt_dir.exists());
        remove_worktree_blocking(&st, "m", &p, true, false).unwrap();
        assert!(!wt_dir.exists());
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_locked_with_reason() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmlock", "feat");
        let name = main.worktrees().unwrap().iter().flatten().next().unwrap().to_owned();
        main.find_worktree(&name).unwrap().lock(Some("agent running")).unwrap();
        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &canonical_string(&wt_dir), true, false).unwrap_err();
        assert!(err.to_string().contains("locked (agent running)"), "{err}");
        assert!(wt_dir.exists());
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_with_delete_branch_deletes_only_merged() {
        // merged: feat == main HEAD
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmmerged", "feat");
        let st = state_with("m", main);
        let r = remove_worktree_blocking(&st, "m", &canonical_string(&wt_dir), false, true).unwrap();
        assert!(r.branch_deleted);
        assert!(st.lock().unwrap()["m"].find_branch("feat", git2::BranchType::Local).is_err());
        let _ = std::fs::remove_dir_all(main_dir);

        // unmerged: commit on feat2 first
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "rmunmerged", "feat2");
        std::fs::write(wt_dir.join("n.txt"), "x").unwrap();
        {
            let mut idx = wt.index().unwrap();
            idx.add_path(std::path::Path::new("n.txt")).unwrap();
            idx.write().unwrap();
            let tree = wt.find_tree(idx.write_tree().unwrap()).unwrap();
            let sig = wt.signature().unwrap();
            let parent = wt.head().unwrap().peel_to_commit().unwrap();
            wt.commit(Some("HEAD"), &sig, &sig, "w", &tree, &[&parent]).unwrap();
        }
        drop(wt);
        let st = state_with("m", main);
        let r = remove_worktree_blocking(&st, "m", &canonical_string(&wt_dir), false, true).unwrap();
        assert!(!r.branch_deleted);
        assert!(r.branch_kept_reason.unwrap().contains("not merged"));
        assert!(st.lock().unwrap()["m"].find_branch("feat2", git2::BranchType::Local).is_ok());
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn remove_refuses_missing_folder() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmmiss", "feat");
        let p = canonical_string(&wt_dir);
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &p, false, false).unwrap_err();
        assert!(err.to_string().contains("Prune missing"), "{err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn prune_drops_missing_worktree() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "prunemiss", "feat");
        std::fs::remove_dir_all(&wt_dir).unwrap();
        run_git_blocking(&main_dir, &["worktree", "prune"]).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].is_main);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    // --- Fix round 1 -------------------------------------------------------

    #[test]
    fn delete_branch_if_merged_reports_kept_when_branch_missing() {
        // The git removal already succeeded by the time this runs; a branch that
        // vanished out from under us (deleted externally) must never turn a
        // successful removal into an error.
        let (main_dir, main) = make_repo_with_commit();
        let r = delete_branch_if_merged(&main, "does-not-exist").unwrap();
        assert!(!r.branch_deleted);
        let reason = r.branch_kept_reason.unwrap();
        assert!(reason.starts_with("Kept 'does-not-exist':"), "{reason}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn branch_delete_step_reports_kept_when_repo_missing_from_state() {
        // Simulates the tab having been closed mid-removal: the repo id is gone
        // from the map by the time the branch-delete step runs. Must still be Ok.
        let st: std::sync::Mutex<std::collections::HashMap<String, git2::Repository>> =
            std::sync::Mutex::new(std::collections::HashMap::new());
        let r = finish_branch_delete(&st, "missing-id", "feat").unwrap();
        assert!(!r.branch_deleted);
        let reason = r.branch_kept_reason.unwrap();
        assert!(reason.starts_with("Kept 'feat':"), "{reason}");
    }

    #[test]
    fn locked_via_git_cli_reason_is_trimmed_of_trailing_newline() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "rmlockcli", "feat");
        let wt_path = canonical_string(&wt_dir);
        run_git_blocking(&main_dir, &["worktree", "lock", "--reason", "agent running", &wt_path]).unwrap();
        let list = list_worktrees_impl(&main).unwrap();
        let w = list.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(w.lock_reason.as_deref(), Some("agent running"), "{:?}", w.lock_reason);

        let st = state_with("m", main);
        let err = remove_worktree_blocking(&st, "m", &wt_path, true, false).unwrap_err();
        assert!(err.to_string().contains("locked (agent running)."), "{err}");
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }
}
