use std::cell::RefCell;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::repo::RepoState;

// Shared helper: walk a git2::Diff and collect FileDiff structs.
fn collect_diff(diff: git2::Diff) -> Result<Vec<FileDiff>> {
    let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .and_then(|p| p.to_str())
                .unwrap_or("")
                .to_owned();

            let old_path = delta
                .old_file()
                .path()
                .and_then(|p| p.to_str())
                .filter(|p| *p != path)
                .map(|p| p.to_owned());

            let status = match delta.status() {
                git2::Delta::Added | git2::Delta::Untracked => DiffStatus::Added,
                git2::Delta::Deleted => DiffStatus::Deleted,
                git2::Delta::Modified => DiffStatus::Modified,
                git2::Delta::Renamed => DiffStatus::Renamed,
                git2::Delta::Copied => DiffStatus::Copied,
                _ => DiffStatus::Other,
            };

            files.borrow_mut().push(FileDiff { path, old_path, status, hunks: Vec::new() });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            let header = String::from_utf8_lossy(hunk.header()).to_string();
            if let Some(file) = files.borrow_mut().last_mut() {
                file.hunks.push(Hunk { header, lines: Vec::new() });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let content = String::from_utf8_lossy(line.content()).to_string();
            let kind = match line.origin() {
                '+' => LineKind::Addition,
                '-' => LineKind::Deletion,
                _ => LineKind::Context,
            };
            let mut files_mut = files.borrow_mut();
            if let Some(file) = files_mut.last_mut() {
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine { kind, content });
                }
            }
            true
        }),
    )?;

    Ok(files.into_inner())
}

#[derive(Debug, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    Other,
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub kind: LineKind,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Context,
    Addition,
    Deletion,
}

#[tauri::command]
pub fn get_commit_diff(
    repo_id: String,
    oid: String,
    state: State<RepoState>,
) -> Result<Vec<FileDiff>> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let git_oid = git2::Oid::from_str(&oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;
    let commit = repo.find_commit(git_oid).map_err(|_| Error::CommitNotFound(oid.clone()))?;

    let commit_tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };

    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;
    collect_diff(diff)
}

/// Return the diff for a single file in the working directory.
/// `staged = true`  → index vs HEAD  (what's been staged)
/// `staged = false` → workdir vs index (what's unstaged / not yet staged)
#[tauri::command]
pub fn get_workdir_diff(
    repo_id: String,
    path: String,
    staged: bool,
    state: State<RepoState>,
) -> Result<FileDiff> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;

    let mut opts = git2::DiffOptions::new();
    // include_untracked lists untracked files as deltas, but their line content is
    // only emitted with show_untracked_content — without it the diff view for an
    // untracked file comes back with no hunks. recurse_untracked_dirs is needed too:
    // without it, a new file inside a brand-new (wholly untracked) directory is
    // collapsed into a single delta for the directory itself, which never matches
    // the file's own pathspec, so the diff for that file comes back empty.
    opts.pathspec(&path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let index = repo.index()?;

    let diff = if staged {
        let head_tree: Option<git2::Tree> = match repo.head() {
            Ok(head) => Some(head.peel_to_tree()?),
            Err(_) => None,
        };
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?
    };

    let files = collect_diff(diff)?;
    files.into_iter().next().ok_or_else(|| Error::InvalidArg(format!("no diff for {path}")))
}

/// Stage a single hunk (by its index within the file's unstaged diff) —
/// applies just that hunk from workdir-vs-index onto the index.
#[tauri::command]
pub fn stage_hunk(
    repo_id: String,
    path: String,
    hunk_index: usize,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    stage_hunk_impl(repo, &path, hunk_index)
}

/// Unstage a single hunk (by its index within the file's staged diff) —
/// reverse-applies just that hunk from HEAD-vs-index onto the index.
#[tauri::command]
pub fn unstage_hunk(
    repo_id: String,
    path: String,
    hunk_index: usize,
    state: State<RepoState>,
) -> Result<()> {
    let repos = state.0.lock().unwrap();
    let repo = repos.get(&repo_id).ok_or_else(|| Error::RepoNotFound(repo_id.clone()))?;
    unstage_hunk_impl(repo, &path, hunk_index)
}

fn stage_hunk_impl(repo: &git2::Repository, path: &str, hunk_index: usize) -> Result<()> {
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(path).include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);

    let index = repo.index()?;
    let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?;
    apply_single_hunk(repo, diff, hunk_index, path)
}

fn unstage_hunk_impl(repo: &git2::Repository, path: &str, hunk_index: usize) -> Result<()> {
    let mut opts = git2::DiffOptions::new();
    // reverse(true) flips the polarity of every hunk so applying the result to
    // the index moves it back toward HEAD for just that hunk, instead of
    // needing a separate "unapply" path.
    opts.pathspec(path).reverse(true);

    let head_tree: Option<git2::Tree> = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(_) => None,
    };
    let index = repo.index()?;
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?;
    apply_single_hunk(repo, diff, hunk_index, path)
}

/// Apply only the hunk at `hunk_index` (in file order) from `diff` to the index.
fn apply_single_hunk(
    repo: &git2::Repository,
    diff: git2::Diff,
    hunk_index: usize,
    path: &str,
) -> Result<()> {
    let mut seen = 0usize;
    let mut applied = false;
    let mut apply_opts = git2::ApplyOptions::new();
    apply_opts.hunk_callback(|_hunk| {
        let is_target = seen == hunk_index;
        seen += 1;
        if is_target {
            applied = true;
        }
        is_target
    });
    repo.apply(&diff, git2::ApplyLocation::Index, Some(&mut apply_opts))?;
    drop(apply_opts);

    if !applied {
        return Err(Error::InvalidArg(format!("hunk {hunk_index} not found for {path}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    fn make_temp_dir() -> PathBuf {
        let id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("wpt_diff_test_{}", id));
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

    fn write_commit(repo: &Repository, filename: &str, content: &str, msg: &str) -> git2::Oid {
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(workdir.join(filename), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(filename)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(head) => vec![head.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs).unwrap()
    }

    fn read_index_content(repo: &Repository, filename: &str) -> String {
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new(filename), 0).unwrap();
        let blob = repo.find_blob(entry.id).unwrap();
        String::from_utf8_lossy(blob.content()).to_string()
    }

    #[test]
    fn stage_hunk_applies_only_target_hunk_to_index() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nten\n", "initial");

        // Two separate, non-adjacent edits — two hunks.
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(
            &workdir.join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nTEN\n",
        )
        .unwrap();

        let mut opts = git2::DiffOptions::new();
        opts.pathspec("file.txt");
        let index = repo.index().unwrap();
        let diff = repo.diff_index_to_workdir(Some(&index), Some(&mut opts)).unwrap();
        let files = collect_diff(diff).unwrap();
        assert_eq!(files[0].hunks.len(), 2, "expected two separate hunks from two non-adjacent edits");

        // Stage only the first hunk (the "ONE" edit).
        stage_hunk_impl(&repo, "file.txt", 0).unwrap();

        let staged = read_index_content(&repo, "file.txt");
        assert!(staged.starts_with("ONE\n"), "first hunk should be staged: {staged}");
        assert!(staged.ends_with("nine\nten\n"), "second hunk should NOT be staged: {staged}");
    }

    #[test]
    fn unstage_hunk_reverses_only_target_hunk_in_index() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nten\n", "initial");

        // Stage both edits fully (simulate "stage all").
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(
            &workdir.join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nTEN\n",
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();

        unstage_hunk_impl(&repo, "file.txt", 0).unwrap();

        let content = read_index_content(&repo, "file.txt");
        assert!(content.starts_with("one\n"), "first hunk should be unstaged back to HEAD: {content}");
        assert!(content.ends_with("nine\nTEN\n"), "second hunk should remain staged: {content}");
    }

    #[test]
    fn stage_hunk_out_of_range_errors() {
        let (_dir, repo) = make_repo();
        write_commit(&repo, "file.txt", "one\n", "initial");
        std::fs::write(repo.workdir().unwrap().join("file.txt"), "one\ntwo\n").unwrap();

        let result = stage_hunk_impl(&repo, "file.txt", 5);
        assert!(result.is_err());
    }
}
