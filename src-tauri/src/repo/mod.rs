pub mod state;
pub mod watcher_state;

pub use state::RepoState;
pub use watcher_state::WatcherState;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

pub(crate) fn workdir(repo: &git2::Repository) -> Result<std::path::PathBuf> {
    repo.workdir()
        .ok_or_else(|| Error::InvalidArg("bare repositories are not supported".into()))
        .map(|p| p.to_path_buf())
}

/// Stable identity for a folder: canonicalized, Windows verbatim prefix stripped,
/// no trailing separator (a bare root keeps its separator). git2 reports worktree
/// paths as `E:/x/` while the folder picker yields `E:\x` — both map to one value.
pub(crate) fn canonical_path(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy().into_owned();
    let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        s
    };
    let trimmed = s.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed.ends_with(':') {
        PathBuf::from(s) // "/" or "C:\" — keep the root separator
    } else {
        PathBuf::from(trimmed)
    }
}

pub(crate) fn canonical_string(p: &Path) -> String {
    canonical_path(p).to_string_lossy().into_owned()
}

/// For a linked worktree, the main worktree's canonical workdir (None when the
/// main repo is bare, or when `repo` is itself the main worktree).
pub(crate) fn main_worktree_path(repo: &git2::Repository) -> Option<String> {
    if !repo.is_worktree() {
        return None;
    }
    let main = git2::Repository::open(repo.commondir()).ok()?;
    if main.is_bare() {
        return None;
    }
    main.workdir().map(canonical_string)
}

/// `Err(RepoGone)` when this repo's git dir or working directory has been deleted
/// (e.g. an agent removed the worktree while its tab was open).
pub(crate) fn ensure_present(repo: &git2::Repository) -> Result<()> {
    let workdir_gone = repo.workdir().is_some_and(|w| !w.exists());
    if !repo.path().exists() || workdir_gone {
        let shown = repo.workdir().unwrap_or_else(|| repo.path());
        return Err(Error::RepoGone(shown.display().to_string()));
    }
    Ok(())
}

/// Map every full branch refname ("refs/heads/x") to the working-directory path of
/// the OTHER worktree (linked or main) whose HEAD is symbolically that branch.
/// `repo` itself is excluded. Best-effort: any error inspecting a single worktree
/// (missing directory, unreadable HEAD, etc.) just skips that worktree rather than
/// failing the whole call.
fn consider_worktree_head(
    result: &mut HashMap<String, PathBuf>,
    repo_git_dir: &Path,
    candidate: git2::Repository,
) {
    let candidate_dir = std::fs::canonicalize(candidate.path()).unwrap_or_else(|_| candidate.path().to_path_buf());
    if candidate_dir == repo_git_dir {
        return; // that's `repo` itself
    }

    let Ok(head_ref) = candidate.find_reference("HEAD") else { return };
    // A detached HEAD has no symbolic target — nothing checked out to report.
    let Some(target) = head_ref.symbolic_target() else { return };

    // Bare repos (and worktrees whose workdir vanished) have no working-dir path
    // to report; git itself doesn't count a bare repo's HEAD as "checked out".
    if let Some(wd) = candidate.workdir() {
        result.insert(target.to_owned(), canonical_path(wd));
    }
}

pub(crate) fn other_worktree_heads(repo: &git2::Repository) -> HashMap<String, PathBuf> {
    let mut result = HashMap::new();

    let repo_git_dir = std::fs::canonicalize(repo.path()).unwrap_or_else(|_| repo.path().to_path_buf());

    if let Ok(names) = repo.worktrees() {
        for name in names.iter().flatten() {
            let Ok(wt) = repo.find_worktree(name) else { continue };
            if wt.validate().is_err() {
                // Deleted-but-unpruned: the folder is gone (or otherwise invalid),
                // so `Repository::open_from_worktree` can't open it — but git and
                // libgit2 still count its branch as checked out as long as
                // `<commondir>/worktrees/<name>/HEAD` exists. Read that file
                // directly rather than silently dropping this worktree from the
                // map (the original phantom-changes bug: the checkout guard below
                // would otherwise miss it and let `checkout_tree` run before
                // `set_head` refuses).
                let admin_dir = repo.commondir().join("worktrees").join(name);
                if let Ok(contents) = std::fs::read_to_string(admin_dir.join("HEAD")) {
                    if let Some(refname) = contents.trim().strip_prefix("ref: ") {
                        result.insert(refname.to_owned(), canonical_path(wt.path()));
                    }
                }
                continue;
            }
            if let Ok(wt_repo) = git2::Repository::open_from_worktree(&wt) {
                consider_worktree_head(&mut result, &repo_git_dir, wt_repo);
            }
        }
    }

    // `repo` itself may be a linked worktree — in that case the main worktree isn't
    // in the `worktrees()` list (only the linked ones are), so check it separately.
    if repo.is_worktree() {
        if let Ok(main_repo) = git2::Repository::open(repo.commondir()) {
            consider_worktree_head(&mut result, &repo_git_dir, main_repo);
        }
    }

    result
}

/// If `refname` (a full ref like "refs/heads/main") is checked out as HEAD in some
/// worktree other than `repo`, return that worktree's working-directory path.
pub(crate) fn checked_out_elsewhere(repo: &git2::Repository, refname: &str) -> Option<PathBuf> {
    other_worktree_heads(repo).remove(refname)
}

#[cfg(test)]
pub(crate) mod test_support {
    use git2::Repository;
    use std::path::{Path, PathBuf};

    pub(crate) fn make_temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wpt_{}_{}", prefix, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A temp repo with an initial commit on its default branch, with a usable
    /// user.name/user.email so signature() works.
    pub(crate) fn make_repo_with_commit() -> (PathBuf, Repository) {
        let dir = make_temp_dir("repo");
        let repo = Repository::init(&dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
        }
        (dir, repo)
    }

    /// Add a REAL linked worktree (via `git2::Repository::worktree`), checked out on
    /// `branch` (created at `main`'s HEAD if it doesn't already exist). Returns the
    /// worktree's working-directory path and an open `Repository` handle for it.
    pub(crate) fn add_worktree(main: &Repository, wt_name: &str, branch: &str) -> (PathBuf, Repository) {
        let parent = main
            .workdir()
            .unwrap_or_else(|| main.path())
            .parent()
            .unwrap()
            .to_path_buf();
        let wt_path = parent.join(format!("wpt_wt_{}_{}", wt_name, uuid::Uuid::new_v4()));

        let branch_ref = match main.find_branch(branch, git2::BranchType::Local) {
            Ok(b) => b,
            Err(_) => {
                let head_commit = main.head().unwrap().peel_to_commit().unwrap();
                main.branch(branch, &head_commit, false).unwrap()
            }
        };

        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch_ref.get()));

        let wt = main.worktree(wt_name, &wt_path, Some(&opts)).unwrap();
        let wt_repo = Repository::open_from_worktree(&wt).unwrap();
        (wt_path, wt_repo)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn main_sees_linked_worktree_branch() {
        let (main_dir, main_repo) = make_repo_with_commit();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");
        let expected = wt_repo.workdir().unwrap().to_path_buf();

        let heads = other_worktree_heads(&main_repo);
        assert_eq!(heads.get("refs/heads/feat").cloned(), Some(expected));

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn linked_worktree_sees_main_branch() {
        let (main_dir, main_repo) = make_repo_with_commit();
        let main_branch = main_repo.head().unwrap().shorthand().unwrap().to_string();
        let expected = main_repo.workdir().unwrap().to_path_buf();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        let heads = other_worktree_heads(&wt_repo);
        let expected_ref = format!("refs/heads/{}", main_branch);
        assert_eq!(heads.get(&expected_ref).cloned(), Some(expected));

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn neither_worktree_reports_its_own_branch() {
        let (main_dir, main_repo) = make_repo_with_commit();
        let main_branch = main_repo.head().unwrap().shorthand().unwrap().to_string();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        let main_heads = other_worktree_heads(&main_repo);
        assert!(!main_heads.contains_key(&format!("refs/heads/{}", main_branch)));

        let wt_heads = other_worktree_heads(&wt_repo);
        assert!(!wt_heads.contains_key("refs/heads/feat"));

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn detached_worktree_reports_nothing() {
        let (main_dir, main_repo) = make_repo_with_commit();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");

        // Detach the linked worktree's HEAD.
        let head_oid = wt_repo.head().unwrap().target().unwrap();
        wt_repo.set_head_detached(head_oid).unwrap();

        let heads = other_worktree_heads(&main_repo);
        assert!(!heads.values().any(|p| p == &wt_dir), "detached worktree must not appear");

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }

    /// Deleted-but-unpruned worktrees must still be reported: git and libgit2
    /// count the branch as checked out for as long as
    /// `<commondir>/worktrees/<name>/HEAD` exists, regardless of whether the
    /// worktree's own folder is still there. Missing this was the original
    /// phantom-changes bug (`do_checkout`'s pre-check would pass, `checkout_tree`
    /// would rewrite files, and only then would `set_head` refuse).
    #[test]
    fn deleted_but_unpruned_worktree_directory_is_still_reported() {
        let (main_dir, main_repo) = make_repo_with_commit();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");
        let expected = canonical_path(&wt_dir);

        // Simulate the worktree's directory being deleted out from under git
        // (e.g. `rm -rf` in a terminal) without pruning it first.
        drop(wt_repo);
        std::fs::remove_dir_all(&wt_dir).unwrap();

        let heads = other_worktree_heads(&main_repo);
        assert_eq!(heads.get("refs/heads/feat"), Some(&expected));

        let _ = std::fs::remove_dir_all(&main_dir);
    }

    #[test]
    fn checked_out_elsewhere_finds_the_worktree_path() {
        let (main_dir, main_repo) = make_repo_with_commit();
        let (wt_dir, wt_repo) = add_worktree(&main_repo, "feat", "feat");
        let expected = wt_repo.workdir().unwrap().to_path_buf();

        let found = checked_out_elsewhere(&main_repo, "refs/heads/feat");
        assert_eq!(found, Some(expected));
        assert_eq!(checked_out_elsewhere(&main_repo, "refs/heads/does-not-exist"), None);

        let _ = std::fs::remove_dir_all(&wt_dir);
        let _ = std::fs::remove_dir_all(&main_dir);
    }
}

#[cfg(test)]
mod canonical_tests {
    use super::*;
    use super::test_support::{add_worktree, make_repo_with_commit, make_temp_dir};

    #[test]
    fn canonical_path_strips_verbatim_prefix_and_trailing_separator() {
        let dir = make_temp_dir("canon");
        let with_slash = format!("{}/", dir.display());
        let a = canonical_path(std::path::Path::new(&with_slash));
        let b = canonical_path(&dir);
        assert_eq!(a, b, "trailing separator must not change identity");
        let s = a.to_string_lossy();
        assert!(!s.starts_with(r"\\?\"), "verbatim prefix must be stripped: {s}");
        assert!(!s.ends_with('/') && !s.ends_with('\\'), "no trailing separator: {s}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn canonical_path_matches_forward_slash_spelling() {
        let dir = make_temp_dir("canon_fwd");
        let fwd = dir.display().to_string().replace('\\', "/");
        assert_eq!(canonical_path(std::path::Path::new(&fwd)), canonical_path(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn main_worktree_path_is_set_only_for_linked_worktrees() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "mwp", "feat");
        assert_eq!(main_worktree_path(&main), None);
        assert_eq!(main_worktree_path(&wt), Some(canonical_string(&main_dir)));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn ensure_present_reports_repo_gone_after_worktree_folder_deleted() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, wt) = add_worktree(&main, "gone", "feat");
        assert!(ensure_present(&wt).is_ok());
        std::fs::remove_dir_all(&wt_dir).unwrap();
        let err = ensure_present(&wt).unwrap_err();
        assert!(err.to_string().starts_with("repo gone:"), "got: {err}");
        let _ = std::fs::remove_dir_all(main_dir);
    }

    #[test]
    fn other_worktree_heads_values_are_canonical() {
        let (main_dir, main) = make_repo_with_commit();
        let (wt_dir, _wt) = add_worktree(&main, "canonval", "feat");
        let heads = other_worktree_heads(&main);
        assert_eq!(heads.get("refs/heads/feat"), Some(&canonical_path(&wt_dir)));
        let _ = std::fs::remove_dir_all(wt_dir);
        let _ = std::fs::remove_dir_all(main_dir);
    }
}
